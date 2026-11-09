package com.khyos.khy_os_client.vfs

import android.content.Context
import io.flutter.plugin.common.MethodCall
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.security.NoSuchAlgorithmException
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.IllegalBlockSizeException
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * 归档加密 / 解密：把一个 ZIP 字节流装进一个带口令的容器。
 *
 * **容器格式（字节布局，Dart 侧照此实现）**：
 * ```
 * 偏移 0   长度 8   魔数 4B 48 59 45 4E 43 31 00（ASCII "KHYENC1" + 1 个 0x00）
 * 偏移 8   长度 16  盐 salt（随机）
 * 偏移 24  长度 16  初始向量 iv（随机）
 * 偏移 40  长度不定 密文 ciphertext
 * ```
 * 密文 = `AES-256-CBC(明文, key) + PKCS5Padding`，其中
 * `key = PBKDF2WithHmacSHA256(password, salt, 65536 次迭代, 256 位)`。
 *
 * 为什么明文是「一个完整的 ZIP 字节流」而不是某种私有格式：解密出来的东西
 * 能直接喂给 [VfsArchive] 已有的 zip 浏览 / 提取逻辑，不需要第二套解析器，
 * 也让「加密」对用户就是「把包锁起来」，不是「换一种格式」。
 *
 * **口令的字节表示**：PBKDF2 的口令按 **UTF-8** 编码（平台实现与本文件的
 * 手写回退实现都这么做），所以 Dart 侧必须同样用 UTF-8 编码口令字符串，
 * 否则两边派生出的密钥不同，解不开。
 *
 * 三道约束：
 *  1. **原子写入**：先写 `<目标>.tmp`，写完才改名。写一半失败时磁盘上不会
 *     留下一个「看着像加密包、其实不完整」的文件——那种文件比没有文件更难解释；
 *  2. **口令不出现在任何日志或异常消息里**：口令只经由 [PBEKeySpec] / [Mac]
 *     进入密钥派生，失败时抛出的消息一律是固定文案；
 *  3. **护栏只有一份**：路径判定照 [VfsBridge] 的规则走
 *     （`requirePath` / `guardDestructive` / `requireStoragePermission`），
 *     本文件不另写一份。
 *
 * 大文件一律流式处理（[CipherOutputStream] / [CipherInputStream]）：
 * 明文 ZIP 可能有几百 MB，整份读进内存会直接吃掉设备的可用内存。
 *
 * 阻塞 IO 由调用方（[VfsBridge]）的 IO 线程池承担，本类不自己起线程。
 */
object VfsCrypto {

    /** 容器魔数的可读形式：ASCII "KHYENC1"。 */
    const val MAGIC = "KHYENC1"

    /**
     * 魔数字段的 8 个字节：`4B 48 59 45 4E 43 31 00`。
     *
     * 为什么是 8 字节而不是 7 字节：格式规定魔数占 8 字节，而 "KHYENC1" 只有
     * 7 个字符。第 8 个字节固定补 0x00（而不是空格），这样这个字段同时是一个
     * 合法的 C 风格字符串，其它语言复刻时按 `"KHYENC1" + 0x00` 写即可，
     * 不会在「补什么」上产生歧义。比较时按 8 字节逐字节比对。
     */
    val MAGIC_BYTES = byteArrayOf(
        0x4B, 0x48, 0x59, 0x45, 0x4E, 0x43, 0x31, 0x00,
    )

    /** 盐长度：16 字节。 */
    private const val SALT_SIZE = 16

    /** 初始向量长度：16 字节（AES 块大小）。 */
    private const val IV_SIZE = 16

    /** 头部总长：魔数 8 + 盐 16 + 初始向量 16 = 40 字节。 */
    private const val HEADER_SIZE = 8 + SALT_SIZE + IV_SIZE

    /** PBKDF2 迭代次数。 */
    private const val PBKDF2_ITERATIONS = 65536

    /** 派生密钥长度（位）：AES-256。 */
    private const val KEY_BITS = 256

    /** 流式复制的缓冲区大小。 */
    private const val BUFFER_SIZE = 64 * 1024

    /** 临时 zip 的存放目录名（放在 App 私有 cache 下，不进 VFS 空间）。 */
    private const val TEMP_DIR_NAME = "khy-vfs-crypto"

    /** 随机源。盐与初始向量都由它产生，绝不用时间戳之类的弱随机。 */
    private val random = SecureRandom()

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
        if (!source.exists()) {
            throw VfsError(VfsBridge.ERR_NOT_FOUND, "待加密的文件不存在：$sourceV")
        }
        if (password.isEmpty()) {
            throw VfsError(VfsBridge.ERR_INVALID_PATH, "密码不能为空")
        }
        val target = File(targetReal)
        if (target.exists()) {
            throw VfsError(VfsBridge.ERR_CONFLICT, "目标已存在：$targetV")
        }
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
        if (!source.exists()) {
            throw VfsError(VfsBridge.ERR_NOT_FOUND, "待解密的文件不存在：$sourceV")
        }
        if (password.isEmpty()) {
            throw VfsError(VfsBridge.ERR_INVALID_PATH, "密码不能为空")
        }
        val target = File(targetReal)
        if (target.exists()) {
            throw VfsError(VfsBridge.ERR_CONFLICT, "目标已存在：$targetV")
        }
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
        val salt = ByteArray(SALT_SIZE).also { random.nextBytes(it) }
        val iv = ByteArray(IV_SIZE).also { random.nextBytes(it) }
        val key = deriveKey(password, salt)
        val cipher = newCipher(Cipher.ENCRYPT_MODE, key, iv)

        val tmp = File(target.absolutePath + ".tmp")
        tmp.parentFile?.mkdirs()
        var committed = false
        try {
            FileOutputStream(tmp).use { fos ->
                // 头部直接写进文件，不经过 cipher：它必须是明文前缀。
                fos.write(MAGIC_BYTES)
                fos.write(salt)
                fos.write(iv)
                // 密文走 cipher 流，整个明文 ZIP 不进内存。
                CipherOutputStream(fos, cipher).use { cos ->
                    FileInputStream(plaintext).use { input ->
                        input.copyTo(cos, BUFFER_SIZE)
                    }
                }
            }
            // 改名之前再确认一次目标不存在：并发时宁可失败，也不要悄悄覆盖用户的旧文件。
            if (target.exists()) {
                throw VfsError(VfsBridge.ERR_CONFLICT, "目标已存在：$targetLabel")
            }
            if (!tmp.renameTo(target)) {
                throw VfsError(VfsBridge.ERR_UNKNOWN, "写入失败：${target.name}")
            }
            committed = true
        } finally {
            if (!committed) tmp.delete()
        }
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
        val tmp = File(target.absolutePath + ".tmp")
        tmp.parentFile?.mkdirs()
        var committed = false
        try {
            FileInputStream(source).use { fis ->
                val magic = ByteArray(MAGIC_BYTES.size)
                if (!readFully(fis, magic) || !magic.contentEquals(MAGIC_BYTES)) {
                    throw VfsError(VfsBridge.ERR_NOT_FOUND, "这不是加密归档")
                }
                val salt = ByteArray(SALT_SIZE)
                val iv = ByteArray(IV_SIZE)
                if (!readFully(fis, salt) || !readFully(fis, iv)) {
                    // 魔数对上了但头都读不全：容器被截断，落在「已损坏」这一侧。
                    throw VfsError(VfsBridge.ERR_DENIED, "密码不正确，或文件已损坏")
                }
                val key = deriveKey(password, salt)
                val cipher = newCipher(Cipher.DECRYPT_MODE, key, iv)
                try {
                    CipherInputStream(fis, cipher).use { cin ->
                        FileOutputStream(tmp).use { fos ->
                            cin.copyTo(fos, BUFFER_SIZE)
                        }
                    }
                } catch (e: IOException) {
                    if (isPaddingFailure(e)) {
                        throw VfsError(VfsBridge.ERR_DENIED, "密码不正确，或文件已损坏")
                    }
                    throw VfsError(VfsBridge.ERR_UNKNOWN, "解密失败：${source.name}")
                }
                // 长度自检：密文长度必须是 16 的倍数（否则块不对齐，必坏），
                // 明文长度必须落在 [密文长 - 16, 密文长 - 1]（填充 1..16 字节）。
                // 这一道是为了兜住「解密流提前结束但没有抛异常」的实现差异：
                // 口令错误时有些平台的 CipherInputStream 只是少给几个字节。
                val cipherLength = source.length() - HEADER_SIZE
                val plainLength = tmp.length()
                if (cipherLength <= 0L || cipherLength % 16L != 0L ||
                    plainLength < cipherLength - 16L || plainLength > cipherLength - 1L
                ) {
                    throw VfsError(VfsBridge.ERR_DENIED, "密码不正确，或文件已损坏")
                }
            }
            if (target.exists()) {
                throw VfsError(VfsBridge.ERR_CONFLICT, "目标已存在：$targetLabel")
            }
            if (!tmp.renameTo(target)) {
                throw VfsError(VfsBridge.ERR_UNKNOWN, "写入失败：${target.name}")
            }
            committed = true
        } finally {
            if (!committed) tmp.delete()
        }
    }

    // ------------------------------------------------------------------
    // 密钥派生
    // ------------------------------------------------------------------

    /**
     * 派生 AES-256 密钥。
     *
     * 首选平台的 `PBKDF2WithHmacSHA256`。Android 8.0（API 26）以下没有这个
     * 算法，而本 App 的 minSdk 是 24，所以低版本退回用 [Mac] 手写同一套
     * PBKDF2（RFC 8018）——两条路派生出的密钥字节完全一致，容器格式不变。
     *
     * 口令以 char[] 交给 [PBEKeySpec]（平台按 UTF-8 编码），以 UTF-8 字节交给
     * 手写实现，两边一致，所以容器在低版本设备上解出来的结果也一样。
     */
    private fun deriveKey(password: String, salt: ByteArray): SecretKeySpec {
        val factory = try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        } catch (e: NoSuchAlgorithmException) {
            null
        }
        val bytes = if (factory != null) {
            val spec = PBEKeySpec(password.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_BITS)
            try {
                factory.generateSecret(spec).encoded
            } finally {
                spec.clearPassword()
            }
        } else {
            pbkdf2HmacSha256(
                password.toByteArray(StandardCharsets.UTF_8),
                salt,
                PBKDF2_ITERATIONS,
                KEY_BITS / 8,
            )
        }
        return SecretKeySpec(bytes, "AES")
    }

    /**
     * PBKDF2-HMAC-SHA256 的手写实现（RFC 8018）。
     *
     * 只在平台没有 PBKDF2WithHmacSHA256 时用（API 24/25）。它与平台实现
     * 输出逐字节相同，所以容器可以在新旧设备之间互通。
     */
    private fun pbkdf2HmacSha256(
        password: ByteArray,
        salt: ByteArray,
        iterations: Int,
        keyLength: Int,
    ): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(password, "HmacSHA256"))
        val hashLength = mac.macLength
        val blocks = (keyLength + hashLength - 1) / hashLength
        val output = ByteArray(keyLength)
        val blockIndex = ByteArray(4)
        for (block in 1..blocks) {
            blockIndex[0] = (block ushr 24).toByte()
            blockIndex[1] = (block ushr 16).toByte()
            blockIndex[2] = (block ushr 8).toByte()
            blockIndex[3] = block.toByte()
            // U1 = PRF(P, S || INT(i))
            mac.update(salt)
            mac.update(blockIndex)
            var u = mac.doFinal()
            val acc = u.copyOf()
            for (round in 2..iterations) {
                u = mac.doFinal(u)
                for (i in 0 until hashLength) {
                    acc[i] = (acc[i].toInt() xor u[i].toInt()).toByte()
                }
            }
            val offset = (block - 1) * hashLength
            val length = minOf(hashLength, keyLength - offset)
            acc.copyInto(output, offset, 0, length)
        }
        return output
    }

    // ------------------------------------------------------------------
    // 杂项
    // ------------------------------------------------------------------

    /** 新建一把 AES-256-CBC + PKCS5Padding 的 cipher。 */
    private fun newCipher(mode: Int, key: SecretKeySpec, iv: ByteArray): Cipher {
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(mode, key, IvParameterSpec(iv))
        return cipher
    }

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

    /** 读满整个缓冲区；中途 EOF 返回 false（文件比要求的短）。 */
    private fun readFully(input: InputStream, buffer: ByteArray): Boolean {
        var offset = 0
        while (offset < buffer.size) {
            val read = input.read(buffer, offset, buffer.size - offset)
            if (read < 0) return false
            offset += read
        }
        return true
    }

    /**
     * 判断异常链里有没有填充 / 块长错误。
     *
     * CipherInputStream 会把 [BadPaddingException] 包进 [IOException]，
     * 所以不能只看最外层异常的类型。
     */
    private fun isPaddingFailure(error: Throwable): Boolean {
        var cause: Throwable? = error
        while (cause != null) {
            if (cause is BadPaddingException || cause is IllegalBlockSizeException) return true
            cause = cause.cause
        }
        return false
    }
}
