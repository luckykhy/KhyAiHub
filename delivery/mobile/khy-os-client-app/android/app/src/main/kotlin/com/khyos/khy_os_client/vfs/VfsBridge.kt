package com.khyos.khy_os_client.vfs

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.system.ErrnoException
import android.system.Os
import android.util.Base64
import com.khyos.khy_os_client.ShizukuServiceManager
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.regex.Pattern

/**
 * VFS 原生桥：MethodChannel("com.khyos.khy_os_client/vfs") 的唯一实现。
 *
 * 这个类的存在理由是**判定只有一处**。Dart 侧有 [VfsRouter] 判路径该走哪条通道，
 * 但 Dart 不认识设备真实路径（容器根在 filesDir 下，Dart 拿不到），所以「虚拟路径 →
 * 真实路径」的映射必须落在原生侧；反过来，原生侧也不能自己另判一套权限，否则
 * 「界面不让点、原生却能做」的裂缝就出现了。
 *
 * 三条边界：
 *  - 路径映射（虚拟 ↔ 真实）只在这里做，shell 侧拿到的永远是真实路径；
 *  - 权限降级由原生侧**独立**判定一遍（Dart 的判定只是第一道），因为 Dart 侧被
 *    篡改/绕过时，护栏必须还在；
 *  - 所有阻塞 IO 都在 [io] 线程池上跑，结果回主线程——MethodChannel 的 handler
 *    跑在主线程上，主线程上做 stat/ls 就是 ANR。
 *
 * 错误码是机器可读的（Dart 侧 [VfsException] 直接透传），message 是给人看的。
 * 十个码见各常量，用别的码会让 Dart 侧的分支判断落空。
 *
 * 方法清单（与 Dart 侧 VfsService 的调用一一对应）：
 *  - status：环境状态（存储权限、Shizuku、容器根）。
 *  - list / stat：列目录 / 取单个条目属性。
 *  - read / write：读文件 / 写文件（binary=true 时 content 是 base64）。
 *  - mkdir / delete：建目录 / 删条目（删除的条目数在 deleted 里）。
 *  - rename / copy / move：改名 / 复制 / 移动（copy 与 move 带冲突策略）。
 *  - search：按名称通配 + 内容关键词搜索。
 *  - hash：md5 / sha256 摘要。
 *  - space / mounts / packages：磁盘空间 / 挂载点 / 已安装应用。
 *  - apkInfo：解析一个 .apk 的清单（包名、版本、权限）。
 */
object VfsBridge {

    /** 通道名。Dart 侧 lib/core/vfs/vfs_channel.dart 把这个字符串写死了。 */
    const val CHANNEL = "com.khyos.khy_os_client/vfs"

    /** 容器空间的虚拟前缀。真实根在 filesDir 下，Dart 不认识它。 */
    const val CONTAINER_PREFIX = "/khyos/container"

    // --- 错误码（与 Dart 侧 VfsException 的词表一一对应）---

    const val ERR_NOT_FOUND = "not_found"
    const val ERR_DENIED = "denied"
    const val ERR_READ_ONLY = "read_only"
    const val ERR_SHIZUKU_UNAVAILABLE = "shizuku_unavailable"
    const val ERR_SHELL_FAILED = "shell_failed"
    const val ERR_STORAGE_DENIED = "storage_denied"
    const val ERR_CONFLICT = "conflict"
    const val ERR_INVALID_PATH = "invalid_path"
    const val ERR_BUSY = "busy"
    const val ERR_UNKNOWN = "unknown"

    /**
     * 通道名对应的两条访问通道。
     *
     * internal 而不是 private：同包的归档与目录监听在调护栏时要显式说明
     * 「走哪一档」，写死字符串会让两处的口径悄悄漂移。
     */
    internal const val VIA_STORAGE = "storage"
    internal const val VIA_SHELL = "shell"

    /**
     * 已绑定的通道：原生往 Dart 推事件（vfsEvent）时用它。
     *
     * 为什么单独绑一次：Dart → 原生走 setMethodCallHandler，反方向原生 → Dart
     * 走 invokeMethod，需要同一个通道的句柄。通道对象在 MainActivity 里创建，
     * VfsWatcher 拿不到那个局部变量，所以在这里存一份。
     *
     * @Volatile：写入发生在主线程（MainActivity），读取发生在 IO 线程与
     * FileObserver 线程，跨线程可见性要保证。
     */
    @Volatile
    private var eventChannel: MethodChannel? = null

    /** 绑定通道。原生侧推事件的唯一入口。 */
    fun bindChannel(channel: MethodChannel) {
        eventChannel = channel
    }

    /** 取已绑定的通道；未绑定时返回 null（推事件时跳过，不抛）。 */
    internal fun boundChannel(): MethodChannel? = eventChannel

    /** 读文件默认上限 1MB、硬上限 8MB。 */
    private const val READ_DEFAULT_MAX = 1024 * 1024
    private const val READ_HARD_MAX = 8 * 1024 * 1024

    /** 搜索默认返回条数与硬上限。 */
    private const val SEARCH_DEFAULT_MAX = 50
    private const val SEARCH_HARD_MAX = 200

    /** 内容搜索最多参与扫描的文件数。 */
    private const val SEARCH_CONTENT_SCAN_MAX = 200

    /** APK 清单里返回的权限条数上限。 */
    private const val APK_PERMISSION_MAX = 50

    /**
     * 允许读取 APK 清单的根目录。
     *
     * 为什么要限根：解析 APK 清单是一次「读取」动作，但它能确认设备上装了哪些包、
     * 各自要什么权限——这本身就是敏感信息。只放开用户真正会放 APK 的地方
     * （公共存储、下载目录、临时目录）与容器，其余一律拒绝。
     */
    private val APK_READABLE_ROOTS = listOf(
        "/storage/emulated/0",
        "/storage/self/primary",
        "/sdcard",
        "/data/local/tmp",
        "/data/tmp",
    )

    /**
     * IO 线程池。
     *
     * 固定 4 条而不是 newCachedThreadPool()：固定池让「排队」成为天然背压，
     * 而缓存池在慢命令叠加时会无限增生线程（每条线程各带一个子进程与两条管道缓冲），
     * 把 App 推进内存压力/ANR 且没有任何背压。与 MainActivity 的 exec 池同一条理由。
     */
    private val io = Executors.newFixedThreadPool(4)

    /** MethodChannel 的结果必须回主线程。 */
    private val main = Handler(Looper.getMainLooper())

    /**
     * 受保护路径：这些路径本身不允许被写/删/改名。
     *
     * 为什么原生侧要再挡一道：Dart 侧的 [VfsPath.normalize] 会吃掉 `..`，但护栏不能
     * 只建在「调用方守规矩」这个假设上——一次 `rm -rf /storage` 就够把用户的卡导没了。
     */
    private val PROTECTED_PATHS = setOf(
        "/",
        "/system",
        "/vendor",
        "/product",
        "/apex",
        "/odm",
        "/data",
        "/data/data",
        "/data/user",
        "/storage",
        "/storage/emulated",
        "/storage/emulated/0",
        "/proc",
        "/sys",
        "/dev",
    )

    /** 系统分区：其下的一切写操作都是只读。 */
    private val SYSTEM_PARTITIONS = listOf("/system", "/vendor", "/product", "/apex", "/odm")

    /** VFS 支持的方法名。device 通道上不认识的方法会落到这里，再落到 notImplemented。 */
    private val VFS_METHODS = setOf(
        "status", "list", "stat", "read", "write", "mkdir", "delete", "rename",
        "copy", "move", "search", "hash", "space", "mounts", "packages", "apkInfo",
        "archiveList", "archiveExtract", "archiveCreate", "analyze",
        "archiveEncrypt", "archiveDecrypt",
        "watchStart", "watchStop", "watchList",
        "copyStart", "copyCancel", "copyStatus",
    )

    /**
     * 通道入口。
     *
     * 立即把活丢到 IO 线程池，主线程只负责「收结果」。识别方法名也在 IO 线程上做，
     * 因为 status 要探 Shizuku binder——那是一次 IPC，阻塞主线程就是掉帧。
     */
    fun dispatch(context: Context, call: MethodCall, result: MethodChannel.Result) {
        if (!VFS_METHODS.contains(call.method)) {
            // 不是 VFS 的方法：保持 device 通道原有的 notImplemented 语义，
            // 不要让 VFS 抢走 device 通道的未知方法。
            result.notImplemented()
            return
        }
        try {
            io.execute {
                val payload = try {
                    handle(context, call)
                } catch (e: VfsError) {
                    errorMap(e.code, e.message)
                } catch (e: Throwable) {
                    errorMap(ERR_UNKNOWN, e.message ?: e.javaClass.simpleName)
                }
                main.post { result.success(payload) }
            }
        } catch (e: Throwable) {
            // 线程池已关闭（进程正在退出）：至少要让 Dart 侧有个答复，不要悬挂。
            main.post { result.success(errorMap(ERR_BUSY, "IO 队列不可用，请稍后重试")) }
        }
    }

    /** 方法分发。参数名严格对齐 Dart 侧的调用。 */
    private fun handle(context: Context, call: MethodCall): Map<String, Any> {
        return when (call.method) {
            "status" -> status(context)
            "list" -> listOp(context, call)
            "stat" -> statOp(context, call)
            "read" -> readOp(context, call)
            "write" -> writeOp(context, call)
            "mkdir" -> mkdirOp(context, call)
            "delete" -> deleteOp(context, call)
            "rename" -> renameOp(context, call)
            "copy" -> copyOp(context, call)
            "move" -> moveOp(context, call)
            "search" -> searchOp(context, call)
            "hash" -> hashOp(context, call)
            "space" -> spaceOp(context, call)
            "mounts" -> mountsOp(context)
            "packages" -> packagesOp(context)
            "apkInfo" -> apkInfoOp(context, call)
            "archiveList" -> VfsArchive.list(context, call)
            "archiveExtract" -> VfsArchive.extract(context, call)
            "archiveCreate" -> VfsArchive.create(context, call)
            "archiveEncrypt" -> VfsCrypto.encrypt(context, call)
            "archiveDecrypt" -> VfsCrypto.decrypt(context, call)
            "analyze" -> VfsAnalyze.analyze(context, call)
            "watchStart" -> VfsWatcher.start(context, call)
            "watchStop" -> VfsWatcher.stop(call)
            "watchList" -> VfsWatcher.list()
            "copyStart" -> VfsCopier.start(context, call)
            "copyCancel" -> VfsCopier.cancel(call)
            "copyStatus" -> VfsCopier.status(call)
            else -> throw VfsError(ERR_UNKNOWN, "未知的 VFS 方法：${call.method}")
        }
    }

    // ------------------------------------------------------------------
    // 环境状态
    // ------------------------------------------------------------------

    /**
     * 运行环境状态。
     *
     * safeMode 的真源在 Dart 侧的策略存储（flutter_secure_storage），原生侧读不到
     * 它的加密内容，只能给一份**镜像**读数；Dart 的 [VfsStatus.fromMap] 也不消费这个
     * 字段（它用的是自己的 policy.safeMode），所以这里返回的是一个诊断用的镜像值，
     * 不参与任何判定——真正的安全模式判定在 Dart 侧。
     */
    private fun status(context: Context): Map<String, Any> {
        val shizuku = ShizukuServiceManager.ensureConnected(context)
        val root = containerRoot(context)
        return mapOf(
            "ok" to true,
            "storageGranted" to storageGranted(context),
            "safeMode" to safeModeMirror(context),
            "shizuku" to mapOf(
                "installed" to shizuku.installed,
                "running" to shizuku.connected,
                "version" to shizuku.version,
                "available" to shizuku.available,
            ),
            "containerRoot" to root,
            "containerInstalled" to containerInstalled(root),
        )
    }

    /**
     * 存储权限是否具备。
     *
     * 与 MainActivity.bridgeStatus 的口径保持一致：Android 10 及以下不需要
     * MANAGE_EXTERNAL_STORAGE，11 及以上要看它。
     */
    private fun storageGranted(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 30) return true
        return try {
            Environment.isExternalStorageManager()
        } catch (e: Throwable) {
            false
        }
    }

    /** 安全模式的原生镜像读数。真源在 Dart 侧，这里只是让诊断面板有东西可显示。 */
    private fun safeModeMirror(context: Context): Boolean {
        return try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_SAFE_MODE, false)
        } catch (e: Throwable) {
            false
        }
    }

    /** 容器运行时是否已安装：容器根存在且非空。 */
    private fun containerInstalled(root: String): Boolean {
        return try {
            val dir = File(root)
            dir.isDirectory && (dir.list()?.isNotEmpty() == true)
        } catch (e: Throwable) {
            false
        }
    }

    // ------------------------------------------------------------------
    // 路径映射与护栏
    // ------------------------------------------------------------------

    /** 容器根的真实路径。宿主内目录，不与宿主共享挂载点。 */
    fun containerRoot(context: Context): String =
        File(context.filesDir, "khy-os/container").absolutePath

    /** 是否落在容器虚拟前缀之下。 */
    fun isContainerPath(vpath: String): Boolean =
        vpath == CONTAINER_PREFIX || vpath.startsWith("$CONTAINER_PREFIX/")

    /**
     * 虚拟路径 → 真实路径。
     *
     * 只有容器需要映射：它在宿主文件系统内部（filesDir 下），Dart 不认识这个位置。
     * 其它路径（/storage/emulated/0、/data/data/…）在设备上就是它们自己。
     */
    fun toReal(context: Context, vpath: String): String {
        if (vpath == CONTAINER_PREFIX) return containerRoot(context)
        if (isContainerPath(vpath)) {
            return containerRoot(context) + vpath.substring(CONTAINER_PREFIX.length)
        }
        return vpath
    }

    /**
     * 真实路径 → 虚拟路径。
     *
     * 节点里的 path 必须回到虚拟空间，否则界面点一下容器里的文件，就会把
     * /data/user/0/<pkg>/files/… 这种真路径交给 Dart，而 Dart 的路由器不认识它。
     */
    fun toVirtual(context: Context, real: String): String {
        val root = containerRoot(context)
        if (real == root) return CONTAINER_PREFIX
        if (real.startsWith("$root/")) return CONTAINER_PREFIX + real.substring(root.length)
        return real
    }

    /**
     * 解析通道。
     *
     * via 只有两个合法值，别的（或者缺失）一律 invalid_path——这不是「猜一个默认值」的
     * 场合：猜错的后果是「用普通 API 去读本该提权读的路径」，失败原因会被伪装成
     * 「文件不存在」。
     *
     * 容器是例外：它强制走 storage。容器在宿主文件系统内部，用普通 API 就够，
     * 提权既没意义又多余一次 IPC。
     */
    private fun resolveVia(call: MethodCall, vpath: String): String {
        val via = call.argument<String>("via")
        val normalized = when (via) {
            VIA_STORAGE -> VIA_STORAGE
            VIA_SHELL -> VIA_SHELL
            else -> throw VfsError(ERR_INVALID_PATH, "非法的 via：$via（只能是 storage 或 shell）")
        }
        return if (isContainerPath(vpath)) VIA_STORAGE else normalized
    }

    /** 取路径参数。缺失或空串都是 invalid_path。 */
    internal fun requirePath(call: MethodCall, key: String = "path"): String {
        val value = call.argument<String>(key)
        if (value.isNullOrEmpty()) throw VfsError(ERR_INVALID_PATH, "缺少路径参数 $key")
        return value
    }

    /**
     * 破坏性操作（写/删/改名/移动的目标）前的护栏。
     *
     * 三道：
     *  1. 空路径与含 `..` 段的路径——路径逃逸；
     *  2. 受保护路径本身（/、/data、/storage/emulated/0 …）——不许把根目录干掉；
     *  3. 系统分区之下的一切（shell 通道）——只读分区，写了也白写，还会弄脏系统。
     *
     * 注意第 2 条只挡**这些路径本身**，它们的子目录不受影响：/storage/emulated/0
     * 不许被整个删掉，但 /storage/emulated/0/Download 当然可以删。
     */
    internal fun guardDestructive(context: Context, vpath: String, real: String, via: String) {
        guardPathEscape(vpath)
        val normalized = if (vpath.length > 1 && vpath.endsWith("/")) {
            vpath.trimEnd('/')
        } else {
            vpath
        }
        if (PROTECTED_PATHS.contains(normalized)) {
            throw VfsError(ERR_DENIED, "拒绝修改受保护路径：$vpath")
        }
        if (via == VIA_SHELL) {
            guardSystemPartition(vpath, real)
        }
        if (real == containerRoot(context)) {
            throw VfsError(ERR_DENIED, "容器根目录不可删除：$vpath")
        }
    }

    /**
     * 目录监听（watchStart）前的护栏。
     *
     * 与 [guardDestructive] 分开，是因为两者拒的东西不一样：
     *  - 监听是**只读**的：它不写不删，所以「受保护路径」「容器根目录不可删」
     *    那两条不成立——听一下 /storage/emulated/0 或容器根本身没有危害，
     *    拿「拒绝修改受保护路径」去回一条只读请求，文不对题；
     *  - 但路径逃逸（空路径、`..`）与系统分区照样要挡：前者会让监听跑到
     *    目录外面去，后者普通 uid 本来就监听不到。
     *
     * 判据与 [guardDestructive] 共用同一批小工具（[guardPathEscape]、
     * [guardSystemPartition]），规则本身仍只有一处。
     */
    internal fun guardWatchPath(vpath: String, real: String) {
        guardPathEscape(vpath)
        guardSystemPartition(vpath, real)
    }

    /**
     * 路径逃逸：空路径与含 `..` 段的路径。
     *
     * 写侧与监听侧共用这一段：两边的风险是同一种——路径跑到目录外面去。
     */
    private fun guardPathEscape(vpath: String) {
        if (vpath.isEmpty()) throw VfsError(ERR_DENIED, "拒绝操作空路径")
        if (vpath.split("/").any { it == ".." }) {
            throw VfsError(ERR_DENIED, "拒绝操作含 .. 的路径：$vpath")
        }
    }

    /** 系统分区（及其子目录）只读。 */
    private fun guardSystemPartition(vpath: String, real: String) {
        if (SYSTEM_PARTITIONS.any { real == it || real.startsWith("$it/") }) {
            throw VfsError(ERR_READ_ONLY, "系统分区是只读的：$vpath")
        }
    }

    /**
     * 共享存储需要「所有文件访问」权限，没有它就别假装路径不存在。
     *
     * 报 storage_denied 而不是 denied：Dart 侧要能区分「权限没给」与「系统不让你看」。
     */
    internal fun requireStoragePermission(context: Context, real: String) {
        if (real.startsWith("/storage/") && !storageGranted(context)) {
            throw VfsError(
                ERR_STORAGE_DENIED,
                "缺少「所有文件访问」权限，无法访问共享存储",
            )
        }
    }

    // ------------------------------------------------------------------
    // list / stat
    // ------------------------------------------------------------------

    private fun listOp(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = requirePath(call)
        val via = resolveVia(call, vpath)
        return if (via == VIA_SHELL) {
            VfsShell.list(context, vpath, toReal(context, vpath))
        } else {
            listStorage(context, vpath)
        }
    }

    private fun statOp(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = requirePath(call)
        val via = resolveVia(call, vpath)
        return if (via == VIA_SHELL) {
            VfsShell.stat(context, vpath, toReal(context, vpath))
        } else {
            val real = toReal(context, vpath)
            requireStoragePermission(context, real)
            // 存在性先判：把「文件没了」和「没权限读属性」混成一个不可访问节点，
            // 界面会一直显示一个灰掉的条目，而真正的原因是文件已经被删了。
            if (!File(real).exists()) {
                throw VfsError(ERR_NOT_FOUND, "路径不存在：$vpath")
            }
            mapOf("ok" to true, "node" to storageNode(context, real).toMap())
        }
    }

    /**
     * storage 通道的列目录。
     *
     * 单个条目取不到属性**不能让整次 list 失败**：目录里一个读不到的文件不该让
     * 整个目录打不开。那种条目降级成 accessible=false 的占位节点，其余照常返回。
     */
    private fun listStorage(context: Context, vpath: String): Map<String, Any> {
        val real = toReal(context, vpath)
        requireStoragePermission(context, real)
        val dir = File(real)
        if (!dir.exists()) throw VfsError(ERR_NOT_FOUND, "目录不存在：$vpath")
        if (!dir.isDirectory) throw VfsError(ERR_INVALID_PATH, "不是目录：$vpath")
        var children = dir.listFiles()
        if (children == null) {
            // FUSE 层偶尔会对刚被媒体扫描碰过的目录瞬时返回 null：真机上偶发过一次
            // 「无权限读取目录：/storage/emulated/0/Android/obb」，冷启动与手动重进
            // 都正常，且代码里没有任何路径能把 obb 拼出来——查无实据的偶发，
            // 唯一可能的产生点就是这里的 null。重试一次把这种瞬时抖动吸收掉；
            // 仍为 null 才是真的读不动，那时报 denied 才是诚实的。
            Thread.sleep(120)
            children = dir.listFiles()
        }
        val nodes = (children ?: throw VfsError(ERR_DENIED, "无权限读取目录：$vpath"))
            .map { storageNode(context, it.absolutePath) }
            .sortedWith(compareBy({ !it.isDirectory }, { it.name }))
        return mapOf("ok" to true, "nodes" to nodes.map { it.toMap() })
    }

    // ------------------------------------------------------------------
    // read / write
    // ------------------------------------------------------------------

    private fun readOp(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = requirePath(call)
        val via = resolveVia(call, vpath)
        val maxBytes = clampReadMax(call.argument<Int>("maxBytes"))
        return if (via == VIA_SHELL) {
            VfsShell.read(context, vpath, toReal(context, vpath), maxBytes)
        } else {
            readStorage(context, vpath, maxBytes)
        }
    }

    /** maxBytes 缺省 1MB，硬上限 8MB。 */
    private fun clampReadMax(requested: Int?): Int {
        if (requested == null || requested <= 0) return READ_DEFAULT_MAX
        return if (requested > READ_HARD_MAX) READ_HARD_MAX else requested
    }

    private fun readStorage(context: Context, vpath: String, maxBytes: Int): Map<String, Any> {
        val real = toReal(context, vpath)
        requireStoragePermission(context, real)
        val file = File(real)
        if (!file.exists()) throw VfsError(ERR_NOT_FOUND, "文件不存在：$vpath")
        if (file.isDirectory) throw VfsError(ERR_INVALID_PATH, "目标是目录：$vpath")
        val bytes = try {
            file.inputStream().use { input ->
                val buffer = ByteArray(maxBytes)
                var total = 0
                while (total < maxBytes) {
                    val n = input.read(buffer, total, maxBytes - total)
                    if (n <= 0) break
                    total += n
                }
                if (total == maxBytes) buffer else buffer.copyOf(total)
            }
        } catch (e: SecurityException) {
            throw VfsError(ERR_DENIED, "无权限读取：$vpath")
        } catch (e: java.io.FileNotFoundException) {
            throw VfsError(ERR_NOT_FOUND, "文件不存在：$vpath")
        }
        val truncated = file.length() > bytes.size
        return payloadOf(bytes, truncated)
    }

    /**
     * 把字节数组变成通道的读结果。
     *
     * 二进制判定：含 NUL 字节，或者不是合法 UTF-8。二进制时 content 是 base64，
     * 否则是 UTF-8 文本。为什么不用「看起来像不像文本」——那套启发式会把 UTF-16
     * 文本判成二进制，而 NUL + 严格 UTF-8 解码这两条是确定的。
     */
    private fun payloadOf(bytes: ByteArray, truncated: Boolean): Map<String, Any> {
        val binary = looksBinary(bytes)
        val content = if (binary) {
            Base64.encodeToString(bytes, Base64.NO_WRAP)
        } else {
            String(bytes, StandardCharsets.UTF_8)
        }
        return mapOf(
            "ok" to true,
            "content" to content,
            "binary" to binary,
            "truncated" to truncated,
        )
    }

    /** 是否二进制：含 NUL，或无法按严格 UTF-8 解码。 */
    fun looksBinary(bytes: ByteArray): Boolean {
        for (b in bytes) {
            if (b == 0.toByte()) return true
        }
        if (bytes.isEmpty()) return false
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            decoder.decode(ByteBuffer.wrap(bytes))
            false
        } catch (e: CharacterCodingException) {
            true
        }
    }

    private fun writeOp(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = requirePath(call)
        val via = resolveVia(call, vpath)
        val content = call.argument<String>("content") ?: ""
        val binary = call.argument<Boolean>("binary") == true
        val real = toReal(context, vpath)
        guardDestructive(context, vpath, real, via)
        return if (via == VIA_SHELL) {
            VfsShell.write(context, vpath, real, content, binary)
        } else {
            writeStorage(context, vpath, real, content, binary)
        }
    }

    private fun writeStorage(
        context: Context,
        vpath: String,
        real: String,
        content: String,
        binary: Boolean,
    ): Map<String, Any> {
        requireStoragePermission(context, real)
        val bytes = if (binary) decodeBase64(content) else content.toByteArray(StandardCharsets.UTF_8)
        try {
            FileOutputStream(File(real)).use { it.write(bytes) }
        } catch (e: SecurityException) {
            throw VfsError(ERR_DENIED, "无权限写入：$vpath")
        } catch (e: java.io.FileNotFoundException) {
            throw VfsError(ERR_NOT_FOUND, "父目录不存在或不可写：$vpath")
        }
        return mapOf("ok" to true, "message" to "已写入 ${bytes.size} 字节")
    }

    /** base64 → 字节。解不开是参数问题，不是 IO 问题。 */
    fun decodeBase64(content: String): ByteArray {
        return try {
            Base64.decode(content, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            throw VfsError(ERR_INVALID_PATH, "base64 内容无法解码")
        }
    }

    // ------------------------------------------------------------------
    // mkdir / delete / rename / copy / move
    // ------------------------------------------------------------------

    private fun mkdirOp(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = requirePath(call)
        val via = resolveVia(call, vpath)
        val parents = call.argument<Boolean>("parents") ?: true
        val real = toReal(context, vpath)
        guardDestructive(context, vpath, real, via)
        return if (via == VIA_SHELL) {
            VfsShell.mkdir(context, vpath, real, parents)
        } else {
            mkdirStorage(context, vpath, real, parents)
        }
    }

    private fun mkdirStorage(
        context: Context,
        vpath: String,
        real: String,
        parents: Boolean,
    ): Map<String, Any> {
        requireStoragePermission(context, real)
        val dir = File(real)
        if (dir.isDirectory) throw VfsError(ERR_CONFLICT, "目录已存在：$vpath")
        val ok = try {
            if (parents) dir.mkdirs() else dir.mkdir()
        } catch (e: SecurityException) {
            throw VfsError(ERR_DENIED, "无权限创建目录：$vpath")
        }
        if (!ok) throw VfsError(ERR_CONFLICT, "创建目录失败（父目录可能不存在）：$vpath")
        return mapOf("ok" to true, "message" to "已创建目录：$vpath")
    }

    private fun deleteOp(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = requirePath(call)
        val via = resolveVia(call, vpath)
        val recursive = call.argument<Boolean>("recursive") == true
        val real = toReal(context, vpath)
        guardDestructive(context, vpath, real, via)
        return if (via == VIA_SHELL) {
            VfsShell.delete(context, vpath, real, recursive)
        } else {
            deleteStorage(context, vpath, real, recursive)
        }
    }

    /**
     * storage 通道的删除。
     *
     * recursive=false 遇到非空目录返回 busy，**不递归删**：用户勾了「删除文件夹」
     * 但没勾「包含子项」，此时替他递归就是把不可逆的操作做在了没授权的范围内。
     */
    private fun deleteStorage(
        context: Context,
        vpath: String,
        real: String,
        recursive: Boolean,
    ): Map<String, Any> {
        requireStoragePermission(context, real)
        val target = File(real)
        if (!target.exists()) throw VfsError(ERR_NOT_FOUND, "路径不存在：$vpath")
        if (target.isDirectory && !recursive) {
            val kids = target.listFiles()
            if (kids != null && kids.isNotEmpty()) {
                throw VfsError(ERR_BUSY, "目录非空，需要递归删除：$vpath")
            }
            if (!target.delete()) throw VfsError(ERR_UNKNOWN, "删除失败：$vpath")
            return mapOf("ok" to true, "deleted" to 1)
        }
        val deleted = if (target.isDirectory) deleteTree(target) else {
            if (target.delete()) 1 else 0
        }
        if (deleted == 0) throw VfsError(ERR_UNKNOWN, "删除失败：$vpath")
        return mapOf("ok" to true, "deleted" to deleted)
    }

    /** 递归删除，返回被移除的条目数（含目录自身）。 */
    private fun deleteTree(dir: File): Int {
        var count = 0
        val kids = dir.listFiles()
        if (kids != null) {
            for (kid in kids) {
                count += if (kid.isDirectory) deleteTree(kid) else if (kid.delete()) 1 else 0
            }
        }
        if (dir.delete()) count += 1
        return count
    }

    private fun renameOp(context: Context, call: MethodCall): Map<String, Any> {
        val from = requirePath(call)
        val to = requirePath(call, "to")
        val via = resolveVia(call, from)
        val overwrite = call.argument<Boolean>("overwrite") == true
        val fromReal = toReal(context, from)
        val toReal = toReal(context, to)
        guardDestructive(context, from, fromReal, via)
        guardDestructive(context, to, toReal, via)
        return if (via == VIA_SHELL) {
            VfsShell.rename(context, from, fromReal, to, toReal, overwrite)
        } else {
            renameStorage(context, from, fromReal, to, toReal, overwrite)
        }
    }

    private fun renameStorage(
        context: Context,
        from: String,
        fromReal: String,
        to: String,
        toReal: String,
        overwrite: Boolean,
    ): Map<String, Any> {
        requireStoragePermission(context, fromReal)
        requireStoragePermission(context, toReal)
        val src = File(fromReal)
        if (!src.exists()) throw VfsError(ERR_NOT_FOUND, "路径不存在：$from")
        val dst = File(toReal)
        if (dst.exists()) {
            if (!overwrite) throw VfsError(ERR_CONFLICT, "目标已存在：$to")
            deleteTree(dst)
        }
        if (!src.renameTo(dst)) {
            // 跨挂载点时 renameTo 会失败（EXDEV），退回「复制 + 删除」。
            copyTree(src, dst)
            if (!deleteTree(src).let { it > 0 }) {
                throw VfsError(ERR_UNKNOWN, "改名失败（源已复制但删除失败）：$from")
            }
        }
        return mapOf("ok" to true, "message" to "已重命名为：$to")
    }

    /** 递归复制。目录会连同结构一起复制。 */
    private fun copyTree(src: File, dst: File) {
        if (src.isDirectory) {
            dst.mkdirs()
            val kids = src.listFiles() ?: return
            for (kid in kids) copyTree(kid, File(dst, kid.name))
        } else {
            src.copyTo(dst, overwrite = true)
        }
    }

    private fun copyOp(context: Context, call: MethodCall): Map<String, Any> {
        val src = requirePath(call, "src")
        val dst = requirePath(call, "dst")
        val via = resolveVia(call, src)
        val conflict = call.argument<String>("conflict") ?: "skip"
        val srcReal = toReal(context, src)
        val dstReal = toReal(context, dst)
        guardDestructive(context, dst, dstReal, via)
        return if (via == VIA_SHELL) {
            VfsShell.copy(context, src, srcReal, dst, dstReal, conflict)
        } else {
            copyStorage(context, src, srcReal, dst, dstReal, conflict)
        }
    }

    private fun moveOp(context: Context, call: MethodCall): Map<String, Any> {
        val src = requirePath(call, "src")
        val dst = requirePath(call, "dst")
        val via = resolveVia(call, src)
        val conflict = call.argument<String>("conflict") ?: "skip"
        val srcReal = toReal(context, src)
        val dstReal = toReal(context, dst)
        // 移动会删掉源，所以源也要过护栏。
        guardDestructive(context, src, srcReal, via)
        guardDestructive(context, dst, dstReal, via)
        return if (via == VIA_SHELL) {
            VfsShell.move(context, src, srcReal, dst, dstReal, conflict)
        } else {
            moveStorage(context, src, srcReal, dst, dstReal, conflict)
        }
    }

    /**
     * storage 通道的复制 + 冲突策略。
     *
     * 四种策略的语义（与 Dart 侧 VfsConflict 一一对应）：
     *  - skip：目标已存在就什么都不做，返回 skipped=true；
     *  - overwrite：先删目标再复制；
     *  - rename：自动改名成「name (1).ext」；
     *  - merge：目标是已存在目录时，把源目录内容并进目标，同名文件按 overwrite 处理。
     */
    private fun copyStorage(
        context: Context,
        srcV: String,
        srcReal: String,
        dstV: String,
        dstReal: String,
        conflict: String,
    ): Map<String, Any> {
        requireStoragePermission(context, srcReal)
        requireStoragePermission(context, dstReal)
        val src = File(srcReal)
        if (!src.exists()) throw VfsError(ERR_NOT_FOUND, "源不存在：$srcV")
        var target = File(dstReal)
        if (target.isDirectory && !src.isDirectory) {
            // 目标是目录、源是文件：按「放进目录」处理，避免 overwrite 把整个目录删掉。
            target = File(target, src.name)
        }
        if (target.exists()) {
            when (conflict) {
                "skip" -> return mapOf("ok" to true, "skipped" to true, "message" to "目标已存在，已跳过")
                "overwrite" -> deleteTree(target)
                "rename" -> target = uniqueTarget(target)
                "merge" -> {
                    if (src.isDirectory && target.isDirectory) {
                        mergeInto(src, target)
                        return mapOf("ok" to true, "skipped" to false, "message" to "已合并到：$dstV")
                    }
                    deleteTree(target)
                }
                else -> throw VfsError(ERR_INVALID_PATH, "未知的冲突策略：$conflict")
            }
        }
        copyTree(src, target)
        return mapOf(
            "ok" to true,
            "skipped" to false,
            "message" to "已复制到：${toVirtual(context, target.absolutePath)}",
        )
    }

    /** 把源目录内容并进目标目录；同名文件按 overwrite 处理。 */
    private fun mergeInto(src: File, dst: File) {
        val kids = src.listFiles() ?: return
        for (kid in kids) {
            val target = File(dst, kid.name)
            if (target.exists()) deleteTree(target)
            copyTree(kid, target)
        }
    }

    /** 找一个不存在的目标名：name (1).ext、name (2).ext… */
    private fun uniqueTarget(target: File): File {
        val parent = target.parentFile
        val name = target.name
        val dot = name.lastIndexOf('.')
        val hasExt = dot > 0 && dot < name.length - 1
        val stem = if (hasExt) name.substring(0, dot) else name
        val ext = if (hasExt) name.substring(dot) else ""
        for (i in 1..999) {
            val candidate = File(parent, "$stem ($i)$ext")
            if (!candidate.exists()) return candidate
        }
        throw VfsError(ERR_BUSY, "无法生成可用文件名：$name")
    }

    /**
     * storage 通道的移动。
     *
     * 同一分区优先 renameTo（原子、快），失败再退回复制 + 删除。
     */
    private fun moveStorage(
        context: Context,
        srcV: String,
        srcReal: String,
        dstV: String,
        dstReal: String,
        conflict: String,
    ): Map<String, Any> {
        requireStoragePermission(context, srcReal)
        requireStoragePermission(context, dstReal)
        val src = File(srcReal)
        if (!src.exists()) throw VfsError(ERR_NOT_FOUND, "源不存在：$srcV")
        var target = File(dstReal)
        if (target.isDirectory && !src.isDirectory) {
            target = File(target, src.name)
        }
        if (target.exists()) {
            when (conflict) {
                "skip" -> return mapOf("ok" to true, "skipped" to true, "message" to "目标已存在，已跳过")
                "overwrite" -> deleteTree(target)
                "rename" -> target = uniqueTarget(target)
                "merge" -> {
                    if (src.isDirectory && target.isDirectory) {
                        mergeInto(src, target)
                        deleteTree(src)
                        return mapOf("ok" to true, "skipped" to false, "message" to "已合并到：$dstV")
                    }
                    deleteTree(target)
                }
                else -> throw VfsError(ERR_INVALID_PATH, "未知的冲突策略：$conflict")
            }
        }
        if (!src.renameTo(target)) {
            copyTree(src, target)
            if (deleteTree(src) == 0) {
                throw VfsError(ERR_UNKNOWN, "移动失败（已复制但源删除失败）：$srcV")
            }
        }
        return mapOf(
            "ok" to true,
            "skipped" to false,
            "message" to "已移动到：${toVirtual(context, target.absolutePath)}",
        )
    }

    // ------------------------------------------------------------------
    // search / hash
    // ------------------------------------------------------------------

    private fun searchOp(context: Context, call: MethodCall): Map<String, Any> {
        val dir = requirePath(call, "dir")
        val via = resolveVia(call, dir)
        val query = call.argument<String>("query") ?: ""
        val namePattern = call.argument<String>("namePattern") ?: "*"
        val maxResults = clampSearchMax(call.argument<Int>("maxResults"))
        val recursive = call.argument<Boolean>("recursive") ?: true
        return if (via == VIA_SHELL) {
            VfsShell.search(context, dir, toReal(context, dir), query, namePattern, maxResults, recursive)
        } else {
            searchStorage(context, dir, toReal(context, dir), query, namePattern, maxResults, recursive)
        }
    }

    /** maxResults 缺省 50，硬上限 200。 */
    private fun clampSearchMax(requested: Int?): Int {
        if (requested == null || requested <= 0) return SEARCH_DEFAULT_MAX
        return if (requested > SEARCH_HARD_MAX) SEARCH_HARD_MAX else requested
    }

    /**
     * storage 通道的搜索。
     *
     * namePattern 是通配（`*` / `?`），自己转成正则——**不能**把它交给 shell 的
     * find -name：一是两条通道必须给出同样的结果，二是通配符里的 `[` 等字符交给
     * shell 会被当成 glob 语法。
     *
     * query 是内容关键词：只扫文本文件，且最多扫 200 个文件——扫全盘会把一次
     * 搜索变成几分钟的 IO，用户看到的是「卡住了」而不是「搜到一半」。
     */
    private fun searchStorage(
        context: Context,
        dirV: String,
        dirReal: String,
        query: String,
        namePattern: String,
        maxResults: Int,
        recursive: Boolean,
    ): Map<String, Any> {
        requireStoragePermission(context, dirReal)
        val root = File(dirReal)
        if (!root.exists()) throw VfsError(ERR_NOT_FOUND, "目录不存在：$dirV")
        if (!root.isDirectory) throw VfsError(ERR_INVALID_PATH, "不是目录：$dirV")
        val regex = globToRegex(namePattern)
        val results = ArrayList<VfsNode>()
        var scanned = 0
        val queue = ArrayDeque<File>()
        queue.add(root)
        outer@ while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            val kids = current.listFiles() ?: continue
            for (kid in kids) {
                if (results.size >= maxResults) break@outer
                val nameHit = regex.matcher(kid.name).matches()
                if (query.isEmpty()) {
                    if (nameHit) results.add(storageNode(context, kid.absolutePath))
                } else {
                    // 只有名字匹配的才值得读内容——读文件是有成本的，
                    // 不匹配的名字读了也是白读。
                    if (nameHit && kid.isFile) {
                        if (scanned >= SEARCH_CONTENT_SCAN_MAX) break@outer
                        scanned += 1
                        if (fileContains(kid, query)) {
                            results.add(storageNode(context, kid.absolutePath))
                        }
                    }
                }
                if (recursive && kid.isDirectory) queue.add(kid)
            }
        }
        return mapOf("ok" to true, "nodes" to results.map { it.toMap() })
    }

    /** 通配转正则。只有 `*` 与 `?` 是通配，其余字符按字面量处理。 */
    fun globToRegex(glob: String): Pattern {
        val sb = StringBuilder()
        for (ch in glob) {
            when (ch) {
                '*' -> sb.append(".*")
                '?' -> sb.append('.')
                '.', '(', ')', '[', ']', '{', '}', '+', '^', '$', '|', '\\' -> sb.append('\\').append(ch)
                else -> sb.append(ch)
            }
        }
        return Pattern.compile(sb.toString())
    }

    /** 文件内容是否包含关键词（只看前 64KB，且跳过二进制）。 */
    private fun fileContains(file: File, query: String): Boolean {
        return try {
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                val n = input.read(buffer)
                if (n <= 0) return false
                val slice = if (n == buffer.size) buffer else buffer.copyOf(n)
                if (looksBinary(slice)) return false
                String(slice, StandardCharsets.UTF_8).contains(query)
            }
        } catch (e: Throwable) {
            false
        }
    }

    private fun hashOp(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = requirePath(call)
        val via = resolveVia(call, vpath)
        val algorithm = (call.argument<String>("algorithm") ?: "sha256").lowercase()
        if (algorithm != "md5" && algorithm != "sha256") {
            throw VfsError(ERR_INVALID_PATH, "不支持的哈希算法：$algorithm")
        }
        val real = toReal(context, vpath)
        return if (via == VIA_SHELL) {
            VfsShell.hash(context, vpath, real, algorithm)
        } else {
            hashStorage(context, vpath, real, algorithm)
        }
    }

    /** 流式计算摘要：大文件不能一次性读进内存。 */
    private fun hashStorage(context: Context, vpath: String, real: String, algorithm: String): Map<String, Any> {
        requireStoragePermission(context, real)
        val file = File(real)
        if (!file.exists()) throw VfsError(ERR_NOT_FOUND, "文件不存在：$vpath")
        if (file.isDirectory) throw VfsError(ERR_INVALID_PATH, "目标是目录：$vpath")
        val digest = try {
            val md = MessageDigest.getInstance(if (algorithm == "md5") "MD5" else "SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n <= 0) break
                    md.update(buffer, 0, n)
                }
            }
            md.digest()
        } catch (e: SecurityException) {
            throw VfsError(ERR_DENIED, "无权限读取：$vpath")
        } catch (e: java.io.FileNotFoundException) {
            throw VfsError(ERR_NOT_FOUND, "文件不存在：$vpath")
        }
        return mapOf(
            "ok" to true,
            "algorithm" to algorithm,
            // 显式按无符号字节格式化：负字节直接交给 %02x 在不同 JDK 上表现不一致，
            // 摘要错了是那种「看起来正常、但对不上」的故障，最难查。
            "digest" to digest.joinToString("") { "%02x".format(it.toInt() and 0xFF) },
        )
    }

    // ------------------------------------------------------------------
    // space / mounts / packages
    // ------------------------------------------------------------------

    /**
     * 磁盘空间。
     *
     * 容器与共享存储用普通 API（statvfs）；/data 这类普通 API 读不到的路径退回
     * shell 的 df -k——两条通道给出的都是字节。
     */
    private fun spaceOp(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = requirePath(call)
        val real = toReal(context, vpath)
        val file = File(real)
        val total = try {
            file.totalSpace
        } catch (e: Throwable) {
            0L
        }
        if (total > 0L) {
            val free = try {
                file.freeSpace
            } catch (e: Throwable) {
                0L
            }
            return mapOf(
                "ok" to true,
                "total" to total,
                "free" to free,
                "used" to (total - free),
            )
        }
        return VfsShell.space(context, vpath, real)
    }

    /**
     * 挂载点。
     *
     * 读 /proc/mounts，解析挂载点、文件系统类型与只读标记（options 里有 ro 即只读）。
     */
    private fun mountsOp(context: Context): Map<String, Any> {
        val list = ArrayList<Map<String, Any>>()
        try {
            File("/proc/mounts").forEachLine { line ->
                val parts = line.split(" ").filter { it.isNotEmpty() }
                if (parts.size < 4) return@forEachLine
                val mountPoint = parts[1].replace("\\040", " ").replace("\\011", "\t")
                val type = parts[2]
                val options = parts[3].split(",")
                val readOnly = options.contains("ro")
                val dir = File(mountPoint)
                list.add(
                    mapOf(
                        "path" to mountPoint,
                        "type" to type,
                        "readOnly" to readOnly,
                        "available" to (dir.exists() && dir.canRead()),
                    )
                )
            }
        } catch (e: Throwable) {
            // /proc 读不到就返回空列表：挂载点是「信息」，不是「操作」，不该因此报错。
        }
        return mapOf("ok" to true, "mounts" to list)
    }

    /**
     * 已安装应用。
     *
     * label 要用 packageManager 取，getApplicationLabel 在正确的 Context 下才不出错；
     * 我们在 IO 线程上做这件事，不占主线程。
     */
    private fun packagesOp(context: Context): Map<String, Any> {
        val pm = context.packageManager
        val list = ArrayList<Map<String, Any>>()
        try {
            val packages = pm.getInstalledPackages(0)
            for (info in packages) {
                val app = info.applicationInfo ?: continue
                val label = try {
                    pm.getApplicationLabel(app).toString()
                } catch (e: Throwable) {
                    info.packageName
                }
                list.add(
                    mapOf(
                        "pkg" to info.packageName,
                        "label" to label,
                        "system" to ((app.flags and ApplicationInfo.FLAG_SYSTEM) != 0),
                    )
                )
            }
        } catch (e: Throwable) {
            throw VfsError(ERR_UNKNOWN, "读取已安装应用失败：${e.message}")
        }
        return mapOf("ok" to true, "packages" to list)
    }

    /**
     * 解析一个 APK 归档的清单。
     *
     * 为什么必须原生做：包名、版本、权限都写在 APK 里的 AndroidManifest.xml 里，
     * 它是编译过的二进制 XML。Dart 侧没有任何合法途径去读它——所以「长按一个 .apk
     * 想知道它是哪个包」这件事，只能由 PackageManager 来做。
     *
     * 走 storage 通道：APK 通常躺在公共存储里，App 自己就能读。解析清单是**读**
     * 操作，不涉及任何修改，所以不走 shell、不需要 Shizuku。
     *
     * 路径仍然要过护栏：虽然这里只读，但「读取任意路径的 APK 清单」是一把钥匙
     * （能确认设备上装了哪些包、各自要什么权限），所以路径必须限制在合理根目录内，
     * 并禁掉 `..` 段。
     */
    @Suppress("DEPRECATION")
    private fun apkInfoOp(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = requirePath(call)
        val real = toReal(context, vpath)
        guardReadable(context, vpath, real)
        requireStoragePermission(context, real)

        val file = File(real)
        if (!file.exists() || !file.isFile) {
            throw VfsError(ERR_NOT_FOUND, "无法解析 APK：文件不存在")
        }
        // 先按扩展名挡一道：不是 .apk 的东西丢给 PackageManager 只会得到一个
        // 含义不明的 null，错误信息因此变得没法读。
        if (!file.name.lowercase().endsWith(".apk")) {
            throw VfsError(ERR_NOT_FOUND, "无法解析 APK：不是 .apk 文件")
        }

        val pm = context.packageManager
        val info = try {
            // GET_PERMISSIONS：requestedPermissions 只有带这个标志才会被填。
            pm.getPackageArchiveInfo(real, PackageManager.GET_PERMISSIONS)
        } catch (e: Throwable) {
            null
        } ?: throw VfsError(ERR_NOT_FOUND, "无法解析 APK：清单解析失败")

        val app = info.applicationInfo
        val label = try {
            app?.loadLabel(pm)?.toString()?.takeIf { it.isNotEmpty() } ?: info.packageName
        } catch (e: Throwable) {
            info.packageName
        }
        val permissions = ArrayList<String>()
        val seen = HashSet<String>()
        for (perm in info.requestedPermissions ?: emptyArray<String?>()) {
            val name = perm ?: continue
            if (name.isEmpty()) continue
            if (!seen.add(name)) continue
            permissions.add(name)
            if (permissions.size >= APK_PERMISSION_MAX) break
        }
        return mapOf(
            "ok" to true,
            "info" to mapOf(
                "package" to info.packageName,
                "label" to label,
                "versionName" to (info.versionName ?: ""),
                // versionCode 在新 API 上已废弃（会被当成 Int 截断），
                // longVersionCode 才是全量值。两者都要给。
                "versionCode" to (if (Build.VERSION.SDK_INT >= 28) {
                    info.longVersionCode
                } else {
                    info.versionCode.toLong()
                }),
                "sizeBytes" to file.length(),
                "minSdk" to (app?.minSdkVersion ?: 0),
                "targetSdk" to (app?.targetSdkVersion ?: 0),
                "permissions" to permissions,
            ),
        )
    }

    /**
     * 只读路径的护栏。
     *
     * 与 [guardDestructive] 分开，是因为两者拒的东西不一样：写操作要挡「不许改的
     * 地方」，读操作要挡「不该被读的地方」。这里挡的是路径逃逸（`..`）与越界
     * （不在允许的根目录内）。
     *
     * 拒的语义与写侧一致（denied）：越界不是「路径写错了」，是「这个操作不被允许」。
     */
    private fun guardReadable(context: Context, vpath: String, real: String) {
        if (vpath.isEmpty()) throw VfsError(ERR_DENIED, "拒绝操作空路径")
        if (vpath.split("/").any { it == ".." }) {
            throw VfsError(ERR_DENIED, "拒绝操作含 .. 的路径：$vpath")
        }
        val allowed = APK_READABLE_ROOTS + containerRoot(context)
        if (allowed.none { real == it || real.startsWith("$it/") }) {
            throw VfsError(ERR_DENIED, "不允许读取该路径的 APK：$vpath")
        }
    }

    // ------------------------------------------------------------------
    // 节点构造
    // ------------------------------------------------------------------

    /**
     * 构造一个节点。
     *
     * 属性取不到时**不抛**：那一条降级成 accessible=false + reason 写清原因，
     * 其余条目照常返回。一个目录里有一个读不到的文件，不该让整个目录打不开。
     */
    fun storageNode(context: Context, real: String): VfsNode {
        val vpath = toVirtual(context, real)
        val name = File(real).name
        // 用 lstat 而不是 stat：stat 会跟随符号链接，那样就永远看不出这是个链接。
        // 链接本身的属性（mode/uid/gid）是链接自己的，size 用目标的大小更有意义。
        val lst = try {
            Os.lstat(real)
        } catch (e: ErrnoException) {
            // 区分「不存在」与「没权限」：前者是 not_found，后者是权限问题。
            // 混成一句「取不到属性」的话，界面无法区分「文件没了」与「该授权了」。
            null
        } catch (e: Throwable) {
            null
        }
        if (lst == null) {
            // 退化路径：只能确认「存在吗」，属性一概给默认值。
            val file = File(real)
            val isDir = try {
                file.isDirectory
            } catch (e: Throwable) {
                false
            }
            val size = if (isDir) 0L else try {
                file.length()
            } catch (e: Throwable) {
                0L
            }
            return VfsNode(
                name = name,
                path = vpath,
                isDirectory = isDir,
                size = size,
                modifiedMs = try {
                    file.lastModified()
                } catch (e: Throwable) {
                    0L
                },
                mode = "",
                owner = "?",
                group = "?",
                selinux = "",
                mime = mimeOf(name, isDir),
                readOnly = true,
                accessible = false,
                reason = "无权限读取属性",
                linkTarget = "",
            )
        }
        val isLink = isSymlinkMode(lst.st_mode)
        val isDir = isDirectoryMode(lst.st_mode)
        val linkTarget = if (isLink) {
            try {
                Os.readlink(real)
            } catch (e: Throwable) {
                ""
            }
        } else {
            ""
        }
        // 链接的大小取目标的大小：用户看到的是「这个链接占多大」，
        // 而不是链接字符串本身那几十字节。
        val size = if (isLink) {
            try {
                Os.stat(real).st_size
            } catch (e: Throwable) {
                lst.st_size
            }
        } else if (isDir) {
            dirSize(File(real))
        } else {
            lst.st_size
        }
        return VfsNode(
            name = name,
            path = vpath,
            isDirectory = isDir,
            size = size,
            modifiedMs = lst.st_mtime * 1000L,
            mode = modeString(lst.st_mode),
            owner = uidName(lst.st_uid),
            group = uidName(lst.st_gid),
            selinux = "",
            mime = mimeOf(name, isDir),
            readOnly = (lst.st_mode and WRITE_BITS) == 0,
            accessible = true,
            reason = "",
            linkTarget = linkTarget,
        )
    }

    /** 目录的递归占用。读不到就当 0。 */
    private fun dirSize(dir: File): Long {
        var total = 0L
        var guard = 0
        val stack = ArrayDeque<File>()
        stack.add(dir)
        while (stack.isNotEmpty() && guard < 50_000) {
            guard += 1
            val current = stack.removeLast()
            val kids = current.listFiles() ?: continue
            for (kid in kids) {
                if (kid.isDirectory) stack.add(kid) else total += kid.length()
            }
        }
        return total
    }

    // --- mode / uid / mime 的小工具 ---

    private const val WRITE_BITS = 0x092 // 0222：owner/group/other 的写位
    private const val TYPE_BITS = 0xF000
    private const val TYPE_DIR = 0x4000
    private const val TYPE_LINK = 0xA000

    /** 是否目录（按 st_mode 的类型位判断，跟随符号链接）。 */
    fun isDirectoryMode(mode: Int): Boolean = (mode and TYPE_BITS) == TYPE_DIR

    /** 是否符号链接。 */
    fun isSymlinkMode(mode: Int): Boolean = (mode and TYPE_BITS) == TYPE_LINK

    /**
     * st_mode → `rwxr-xr-x` 形式。
     *
     * 三组各 rwx，再补 setuid/setgid/sticky 位（s/S/t/T）。拿不到模式时给空串，
     * 而不是编一个假的 rwxr-xr-x 出来——界面上的只读标识是拿这个字段判的。
     */
    fun modeString(mode: Int): String {
        val perm = mode and 0xFFF
        val sb = StringBuilder()
        // owner
        sb.append(if (perm and 0x100 != 0) 'r' else '-')
        sb.append(if (perm and 0x080 != 0) 'w' else '-')
        val ownerExec = perm and 0x040 != 0
        val setuid = mode and 0x800 != 0
        sb.append(
            when {
                setuid && ownerExec -> 's'
                setuid -> 'S'
                ownerExec -> 'x'
                else -> '-'
            }
        )
        // group
        sb.append(if (perm and 0x020 != 0) 'r' else '-')
        sb.append(if (perm and 0x010 != 0) 'w' else '-')
        val groupExec = perm and 0x008 != 0
        val setgid = mode and 0x400 != 0
        sb.append(
            when {
                setgid && groupExec -> 's'
                setgid -> 'S'
                groupExec -> 'x'
                else -> '-'
            }
        )
        // other
        sb.append(if (perm and 0x004 != 0) 'r' else '-')
        sb.append(if (perm and 0x002 != 0) 'w' else '-')
        val otherExec = perm and 0x001 != 0
        val sticky = mode and 0x200 != 0
        sb.append(
            when {
                sticky && otherExec -> 't'
                sticky -> 'T'
                otherExec -> 'x'
                else -> '-'
            }
        )
        return sb.toString()
    }

    /**
     * uid → 可读的名字。
     *
     * Android 的 uid 是数字：0 是 root，1000 是 system，应用是 10000+（u0_aN）。
     * 拿不到名字时给 "?"——界面用 "?" 表示「未知属主」比显示裸数字诚实。
     */
    fun uidName(uid: Int): String {
        SYSTEM_UIDS[uid]?.let { return it }
        if (uid in 10000..19999) return "u0_a${uid - 10000}"
        return "?"
    }

    private val SYSTEM_UIDS = mapOf(
        0 to "root",
        1000 to "system",
        1001 to "radio",
        1002 to "bluetooth",
        1003 to "graphics",
        1004 to "input",
        1005 to "audio",
        1006 to "camera",
        1007 to "log",
        1009 to "mount",
        1010 to "wifi",
        1011 to "adb",
        1012 to "install",
        1013 to "media",
        1014 to "dhcp",
        1015 to "vpn",
        1016 to "keystore",
        1017 to "usb",
        1021 to "config",
        1023 to "media_rw",
        1024 to "mdm",
        1026 to "nfc",
        1027 to "sdcard_rw",
        1029 to "drm",
        2000 to "shell",
        2001 to "cache",
        2002 to "diag",
        3001 to "net_bt_admin",
        3002 to "inet",
        3003 to "net_bt",
        3004 to "inet_raw",
        3006 to "net_admin",
        3007 to "net_bw_stats",
    )

    /** 按扩展名粗判 MIME。认不出就 octet-stream。 */
    fun mimeOf(name: String, isDirectory: Boolean): String {
        if (isDirectory) return "inode/directory"
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return "application/octet-stream"
        val ext = name.substring(dot + 1).lowercase()
        return MIME_BY_EXT[ext] ?: "application/octet-stream"
    }

    private val MIME_BY_EXT = mapOf(
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "gif" to "image/gif",
        "webp" to "image/webp",
        "bmp" to "image/bmp",
        "svg" to "image/svg+xml",
        "heic" to "image/heic",
        "pdf" to "application/pdf",
        "zip" to "application/zip",
        "gz" to "application/gzip",
        "tar" to "application/x-tar",
        "rar" to "application/vnd.rar",
        "7z" to "application/x-7z-compressed",
        "txt" to "text/plain",
        "log" to "text/plain",
        "md" to "text/markdown",
        "csv" to "text/csv",
        "html" to "text/html",
        "htm" to "text/html",
        "css" to "text/css",
        "js" to "text/javascript",
        "json" to "application/json",
        "xml" to "application/xml",
        "yml" to "application/yaml",
        "yaml" to "application/yaml",
        "mp4" to "video/mp4",
        "mkv" to "video/x-matroska",
        "mov" to "video/quicktime",
        "webm" to "video/webm",
        "avi" to "video/x-msvideo",
        "mp3" to "audio/mpeg",
        "wav" to "audio/wav",
        "ogg" to "audio/ogg",
        "flac" to "audio/flac",
        "m4a" to "audio/mp4",
        "aac" to "audio/aac",
        "apk" to "application/vnd.android.package-archive",
        "doc" to "application/msword",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" to "application/vnd.ms-excel",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" to "application/vnd.ms-powerpoint",
        "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "epub" to "application/epub+zip",
        "sh" to "application/x-sh",
        "so" to "application/octet-stream",
        "db" to "application/vnd.sqlite3",
        "sqlite" to "application/vnd.sqlite3",
    )

    // ------------------------------------------------------------------
    // 错误封装
    // ------------------------------------------------------------------

    /** 统一失败出口。ok=false + 机器码 + 中文说明。 */
    fun errorMap(code: String, message: String): Map<String, Any> =
        mapOf("ok" to false, "error" to code, "message" to message)

    private const val PREFS = "khy_os_vfs"
    private const val KEY_SAFE_MODE = "safe_mode"
}

/**
 * 一个目录条目。
 *
 * 字段与 Dart 侧 VfsNode 一一对应。取不到的属性一律给**默认值**而不是省略：
 * 少一个字段，Dart 侧的 fromMap 会补默认值，但那条路径没有原生侧的语义，
 * 补出来的值与原生侧自己算出来的值可能不一致（比如 size）。统一在原生侧定死，
 * 两边才不会漂。
 */
data class VfsNode(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val size: Long,
    val modifiedMs: Long,
    val mode: String,
    val owner: String,
    val group: String,
    val selinux: String,
    val mime: String,
    val readOnly: Boolean,
    val accessible: Boolean,
    val reason: String,
    val linkTarget: String,
) {
    /** 送进 MethodChannel 的形状。字段名与 Dart 侧 fromMap 严格一致。 */
    fun toMap(): Map<String, Any> = mapOf(
        "name" to name,
        "path" to path,
        "isDirectory" to isDirectory,
        "size" to size,
        "modifiedMs" to modifiedMs,
        "mode" to mode,
        "owner" to owner,
        "group" to group,
        "selinux" to selinux,
        "mime" to mime,
        "readOnly" to readOnly,
        "accessible" to accessible,
        "reason" to reason,
        "linkTarget" to linkTarget,
    )
}

/**
 * VFS 内部错误。
 *
 * 带上机器码，是为了让「失败」也能被程序处理，而不只是给人看一句话。
 * Dart 侧把它还原成 VfsException(error, message)，机器码原样透传。
 */
class VfsError(
    val code: String,
    override val message: String,
) : Exception(message)

