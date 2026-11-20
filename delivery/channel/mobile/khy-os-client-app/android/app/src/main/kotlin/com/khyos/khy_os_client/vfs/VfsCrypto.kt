package com.khyos.khy_os_client.vfs

import android.content.Context
import io.flutter.plugin.common.MethodCall
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * 归档加密 / 解密：把一个 ZIP 字节流装进一个带口令的容器。
 *
 * **容器格式（字节布局）写在 [KhyEncContainer] 里**——那段是纯逻辑（不碰任何
 * Android API），可以直接在 JVM 单元测试里跑，判据由 `KhyEncContainerTest` 钉住。
 * 本文件只负责「编排」：权限判定、护栏、失败时的错误码映射。
 *
 * 一句话概括格式：魔数 8 字节（`"KHYENC1" + 0x00`）+ 盐 16 + iv 16 + 密文；
 * 密文 = AES-256-CBC + PKCS5Padding，密钥 = PBKDF2-HMAC-SHA256（65536 轮，256 位）。
 *
 * **只有 Kotlin 这一份实现**：Dart 侧不自己实现容器格式，它只通过通道调
 * `archiveEncrypt` / `archiveDecrypt`。所以「另一侧照此实现」这句话在本仓是不
 * 成立的——写下来是为了让下一个人不要去找那份不存在的 Dart 实现。
 *
 * 为什么明文是「一个完整的 ZIP 字节流」而不是某种私有格式：解密出来的东西
 * 能直接喂给 [VfsArchive] 已有的 zip 浏览 / 提取逻辑，不需要第二套解析器，
 * 也让「加密」对用户就是「把包锁起来」，不是「换一种格式」。
 *
 * **口令的字节表示**：PBKDF2 的口令按 **UTF-8** 编码（平台实现与手写回退实现
 * 都这么做），所以非 ASCII 口令（中文）也能正常开合。
 *
 * 三道约束：
 *  1. **原子写入**：先写 `<目标>.tmp`，写完才改名。写一半失败时磁盘上不会
 *     留下一个「看着像加密包、其实不完整」的文件——那种文件比没有文件更难解释；
 *  2. **口令不出现在任何日志或异常消息里**：口令只经由密钥派生进入密文，
 *     失败时抛出的消息一律是固定文案；
 *  3. **护栏只有一份**：路径判定照 [VfsBridge] 的规则走
 *     （`requirePath` / `guardDestructive` / `requireStoragePermission`），
 *     本文件不另写一份。
 *
 * 大文件一律流式处理：明文 ZIP 可能有几百 MB，整份读进内存会直接吃掉设备的
 * 可用内存。
 *
 * 阻塞 IO 由调用方（[VfsBridge]）的 IO 线程池承担，本类不自己起线程。
 */
object VfsCrypto {

    /** 容器魔数的可读形式：ASCII "KHYENC1"。 */
    const val MAGIC = KhyEncContainer.MAGIC

    /**
     * 魔数字段的 8 个字节：`4B 48 59 45 4E 43 31 00`。
     *
     * 为什么是 8 字节而不是 7 字节：格式规定魔数占 8 字节，而 "KHYENC1" 只有
     * 7 个字符。第 8 个字节固定补 0x00（而不是空格），这样这个字段同时是一个
     * 合法的 C 风格字符串，其它语言复刻时按 `"KHYENC1" + 0x00` 写即可，
     * 不会在「补什么」上产生歧义。比较时按 8 字节逐字节比对。
     *
     * 字节布局本体在 [KhyEncContainer]（纯逻辑，可在 JVM 单测里跑），这里只转出
     * 一份别名，免得调用方跟着搬。
     */
    val MAGIC_BYTES = KhyEncContainer.MAGIC_BYTES

    /** 临时 zip 的存放目录名（放在 App 私有 cache 下，不进 VFS 空间）。 */
    private const val TEMP_DIR_NAME = "khy-vfs-crypto"

    /**
     * 同一目标路径的写操作串行化。
     *
     * 为什么需要：临时文件名是固定的 `<目标>.tmp`（原子改名要求临时文件与目标
     * 同目录），两个并发写同一目标就会往同一个临时文件里写，结果是两边都拿到
     * 一个坏包。按目标路径分桶加锁即可，同一个 App 内的并发是唯一的竞争来源。
     */
    private val targetLocks = ConcurrentHashMap<String, Any>()

    // ------------------------------------------------------------------
    // 入口：archiveEncrypt
    // ------------------------------------------------------------------

    /**
     * 加密一个归档。
     *
     * args: `{sourcePath, targetPath, password}`（路径都是虚拟路径）
     * 返回: `{ok, path}`，`path` 是输出文件的**虚拟路径**。
     *
     * 源可以是已存在的 ZIP 文件；也可以是一个目录——目录先由 [VfsArchive] 已有的
     * 写 zip 能力打成临时 zip，再加密那个 zip（本文件不另写一套 zip 写入）。
     */
    fun encrypt(context: Context, call: MethodCall): Map<String, Any> {
        val sourceV = VfsBridge.requirePath(call, "sourcePath")
        val targetV = VfsBridge.requirePath(call, "targetPath")
        val password = call.argument<String>("password") ?: ""

        val sourceReal = VfsBridge.toReal(context, sourceV)
        val targetReal = VfsBridge.toReal(context, targetV)
        // 读侧与写侧都要过权限判定：共享存储没有「所有文件访问」时，
        // 「不存在」与「没权限看」必须区分开，否则界面会显示一个灰掉的条目，
        // 而真正的原因是权限没给。
        VfsBridge.requireStoragePermission(context, sourceReal)
        VfsBridge.requireStoragePermission(context, targetReal)

        val source = File(sourceReal)
        val target = File(targetReal)
        // 前置校验（源在不在 / 口令空不空 / 目标在不在）照 [VfsCryptoGuard] 的
        // 判据走——那一层是纯逻辑，可以在 JVM 单测里钉住错误码语义。
        VfsCryptoGuard.requireReady(
            source = source,
            target = target,
            password = password,
            sourceLabel = sourceV,
            targetLabel = targetV,
            action = VfsCryptoGuard.ACTION_ENCRYPT,
        )
        // 写操作护栏：真源在 VfsBridge，这里不另写一份。
        // 按 shell 档走是为了保留「系统分区只读」那道判定——用普通 API 写系统
        // 分区本来也会失败，但报「只读」比报一个 IO 错误清楚得多。
        VfsBridge.guardDestructive(context, targetV, targetReal, VfsBridge.VIA_SHELL)

        synchronized(targetLocks.getOrPut(targetReal) { Any() }) {
            var tempZip: File? = null
            try {
                val plaintext = if (source.isDirectory) {
                    tempZip = createTempZip(context, sourceV)
                    tempZip
                } else {
                    source
                }
                writeContainer(plaintext, target, targetV, password)
            } catch (e: VfsError) {
                throw e
            } catch (e: Throwable) {
                // 失败消息里不含口令，也不带底层异常文本（异常文本可能带参数）。
                throw VfsError(VfsBridge.ERR_UNKNOWN, "加密失败：${target.name}")
            } finally {
                tempZip?.delete()
            }
        }

        return mapOf("ok" to true, "path" to VfsBridge.toVirtual(context, target.absolutePath))
    }

    // ------------------------------------------------------------------
    // 入口：archiveDecrypt
    // ------------------------------------------------------------------

    /**
     * 解密一个加密归档。
     *
     * args: `{sourcePath, targetPath, password}`（路径都是虚拟路径）
     * 返回: `{ok, path}`，`path` 是解出来的文件的**虚拟路径**。
     *
     * 两种失败要分开报，别混成一个码：
     *  - 魔数不匹配 → `not_found`「这不是加密归档」（用户多半是把普通文件当成了
     *    加密包，或者根本不是本工具产出的容器）；
     *  - 口令错误 → `denied`「密码不正确，或文件已损坏」（PKCS5 填充校验不过；
     *    同一个码也覆盖「文件被截断/损坏」，因为这两种情况在密码正确时也会走到
     *    同一条失败路径）。
     */
    fun decrypt(context: Context, call: MethodCall): Map<String, Any> {
        val sourceV = VfsBridge.requirePath(call, "sourcePath")
        val targetV = VfsBridge.requirePath(call, "targetPath")
        val password = call.argument<String>("password") ?: ""

        val sourceReal = VfsBridge.toReal(context, sourceV)
        val targetReal = VfsBridge.toReal(context, targetV)
        VfsBridge.requireStoragePermission(context, sourceReal)
        VfsBridge.requireStoragePermission(context, targetReal)

        val source = File(sourceReal)
        val target = File(targetReal)
        VfsCryptoGuard.requireReady(
            source = source,
            target = target,
            password = password,
            sourceLabel = sourceV,
            targetLabel = targetV,
            action = VfsCryptoGuard.ACTION_DECRYPT,
        )
        VfsBridge.guardDestructive(context, targetV, targetReal, VfsBridge.VIA_SHELL)

        synchronized(targetLocks.getOrPut(targetReal) { Any() }) {
            try {
                readContainer(source, target, targetV, password)
            } catch (e: VfsError) {
                throw e
            } catch (e: Throwable) {
                // 同 encrypt：失败消息里不带底层异常文本，也不带口令。
                throw VfsError(VfsBridge.ERR_UNKNOWN, "解密失败：${source.name}")
            }
        }

        return mapOf("ok" to true, "path" to VfsBridge.toVirtual(context, target.absolutePath))
    }

    // ------------------------------------------------------------------
    // 容器写入
    // ------------------------------------------------------------------

    /**
     * 写一个容器文件：魔数 + 盐 + 初始向量 + 密文。
     *
     * 原子性靠「先写 `<目标>.tmp`，写完再改名」实现：改名在同一个目录内完成，
     * 是原子的；中途失败则临时文件被删掉，目标路径上不会出现半个容器。
     */
    private fun writeContainer(plaintext: File, target: File, targetLabel: String, password: String) {
        // 容器格式的字节布局与密码学都在 [KhyEncContainer] 里——那段是纯逻辑，
        // 可以直接在 JVM 单测里跑（这里要 Context 与 MethodCall，跑不了）。
        // 本文件只负责「编排」：权限判定、护栏、失败时的错误码。
        KhyEncContainer.write(
            plaintext = plaintext,
            target = target,
            password = password,
            targetLabel = targetLabel,
            conflictCode = VfsBridge.ERR_CONFLICT,
            unknownCode = VfsBridge.ERR_UNKNOWN,
        )
    }

    // ------------------------------------------------------------------
    // 容器读取
    // ------------------------------------------------------------------

    /**
     * 读一个容器文件并解出明文。
     *
     * 口令错误与文件损坏走同一个出口（`denied`）：两者都会让 PKCS5 填充校验
     * 不过，或让解密出的长度对不上，语义上也无法进一步区分。
     */
    private fun readContainer(source: File, target: File, targetLabel: String, password: String) {
        KhyEncContainer.read(
            source = source,
            target = target,
            password = password,
            targetLabel = targetLabel,
            deniedCode = VfsBridge.ERR_DENIED,
            notFoundCode = VfsBridge.ERR_NOT_FOUND,
            conflictCode = VfsBridge.ERR_CONFLICT,
            unknownCode = VfsBridge.ERR_UNKNOWN,
        )
    }

    // ------------------------------------------------------------------
    // 杂项
    // ------------------------------------------------------------------


    /**
     * 把一个目录打成临时 zip。
     *
     * 复用 [VfsArchive] 已有的写 zip 能力，而不是在这里另写一套：[VfsArchive.create]
     * 是那个 zip 写入逻辑唯一的公开入口，而它的入参是 [MethodCall]，所以这里造一个
     * 合成调用。临时 zip 放在 App 私有 cache 下，不进 VFS 空间，也不污染用户的目录。
     */
    private fun createTempZip(context: Context, sourceV: String): File {
        val dir = File(context.cacheDir, TEMP_DIR_NAME)
        if (!dir.exists() && !dir.mkdirs()) {
            throw VfsError(VfsBridge.ERR_UNKNOWN, "无法创建临时目录")
        }
        val tmp = File(dir, "src-${UUID.randomUUID()}.zip")
        VfsArchive.create(
            context,
            MethodCall(
                "archiveCreate",
                mapOf(
                    "targetPath" to tmp.absolutePath,
                    "sourcePaths" to listOf(sourceV),
                    "format" to VfsArchive.FORMAT_ZIP,
                ),
            ),
        )
        return tmp
    }


}
