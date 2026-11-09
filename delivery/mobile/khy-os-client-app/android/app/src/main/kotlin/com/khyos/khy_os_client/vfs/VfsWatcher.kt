package com.khyos.khy_os_client.vfs

import android.content.Context
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.UUID

/**
 * 目录事件监听：原生侧 [FileObserver] → Dart 侧 `vfsEvent`。
 *
 * 为什么放在原生侧：事件源是内核的 inotify，只有原生进程能收到；Dart 侧
 * 拿不到 inotify fd，也就没有「什么时候文件变了」这个信息源。
 *
 * 三条边界（都是能力边界，不藏）：
 *
 * 1. **只监听一层，不递归。** 子目录里的变化不推事件。要递归就得自己维护
 *    一棵目录树（每层一个 observer），代价与出错面都大得多。
 * 2. **observer 随 App 进程存活。** 进程被系统杀掉，监听就没了——这里
 *    **没有**后台常驻能力，也不假装有。要常驻得另起前台服务，那是另一件事。
 * 3. **只支持普通 uid 读得到的目录**（公共存储、App 自己的目录）。
 *    `/data` 下需要 Shizuku 的目录普通 uid 收不到 inotify 事件，硬挂一个
 *    永远不响的监听器只会让人以为功能坏了，所以直接拒绝并说明原因。
 *
 * 另有一条平台限制，不在这里粉饰：事件能不能送达，取决于该路径所在的
 * 文件系统是否把 inotify 事件透给 App。部分 ROM 的 FUSE 挂载（共享存储）
 * 就不透，届时监听已建立但收不到回调——这是平台行为，不是这里能修的。
 *
 * 去抖：一次写入会连着来 `ENTRY_CREATE` + `ENTRY_MODIFY` + `ENTRY_DELETE`
 * 三四个事件，原样推给 Dart 会让脚本连跑好几次。同一个路径的事件在
 * [DEBOUNCE_MS] 窗口内合并成一个；窗口里 create 与 delete 都出现过时，
 * 只推最终的 `deleted`（文件最终没了就是没了，中间过程不是事实）。
 *
 * 护栏不在这里复刻：路径校验（空路径、`..`、受保护路径、系统分区）走
 * [VfsBridge] 的同一份实现，见 [VfsBridge.requirePath] 与
 * [VfsBridge.guardDestructive]。
 */
object VfsWatcher {

    private const val TAG = "KhyVfsWatcher"

    /** 推给 Dart 的方法名。Dart 侧在同一通道上注册 handler 接。 */
    const val EVENT_METHOD = "vfsEvent"

    /**
     * 合并窗口：同一路径在这个窗口内的多个事件合并成一个。
     *
     * 800ms 是「一次写入 + 落盘」的经验值：短于此窗口，一次写入产生的
     * create/modify/delete 会被合并成一个事件；长于此窗口，同一个文件
     * 连续两次写入就会被拆成两次推送，脚本多跑一次。
     */
    private const val DEBOUNCE_MS = 800L

    /**
     * 连续事件下的最长等待。
     *
     * 为什么要有上限：合并窗口是尾沿续期式（每来一个事件就往后推一次），
     * 如果一个文件被持续写入（日志、数据库），事件永远不会停，纯续期就
     * 永远推不出去。到上限就按当前状态推一次，保证「有变化就一定有一次通知」。
     */
    private const val MAX_WAIT_MS = DEBOUNCE_MS * 4

    /** 事件类型。名字与 Dart 侧的字面量一一对应。 */
    private const val TYPE_CREATED = "created"
    private const val TYPE_MODIFIED = "modified"
    private const val TYPE_DELETED = "deleted"

    /**
     * 监听哪些事件。
     *
     * ATTRIB（属性变化，如权限/时间戳）算 modified：它同样是「这个条目变了」，
     * 对 Dart 侧的意义跟内容变化一样——该刷新了。
     */
    private const val WATCH_MASK =
        FileObserver.CREATE or
            FileObserver.DELETE or
            FileObserver.MODIFY or
            FileObserver.MOVED_FROM or
            FileObserver.MOVED_TO or
            FileObserver.CLOSE_WRITE or
            FileObserver.ATTRIB or
            FileObserver.DELETE_SELF or
            FileObserver.MOVE_SELF

    /** MethodChannel 的调用必须在平台线程（主线程）上做。 */
    private val main = Handler(Looper.getMainLooper())

    /** 保护 watches / pending。方法入口跑在 IO 线程池，事件回调跑在 observer 线程。 */
    private val lock = Any()

    /** watchId → 监听项。 */
    private val watches = LinkedHashMap<String, WatchEntry>()

    /** 真实目录 → watchId。同一目录重复 watch 时靠它做到幂等。 */
    private val watchIdByRealDir = HashMap<String, String>()

    /** 待推送事件：条目键 → 合并窗口内的状态。 */
    private val pending = HashMap<String, PendingEvent>()

    // ------------------------------------------------------------------
    // 对外入口：watchStart / watchStop / watchList
    // ------------------------------------------------------------------

    /**
     * 开始监听一个目录。
     *
     * args: `{dir, scriptId}`——`dir` 是**虚拟路径**（如 /storage/emulated/0/Download），
     * `scriptId` 为空串表示只监听、不触发脚本。
     * 返回: `{ok, watchId}`；失败时是 `{ok: false, error, message}`。
     *
     * 幂等：同一目录重复 watch 返回**已有**的 watchId，不会起第二个 observer。
     */
    fun start(context: Context, call: MethodCall): Map<String, Any> {
        val vdir = VfsBridge.requirePath(call, "dir")
        val scriptId = call.argument<String>("scriptId") ?: ""

        val real = VfsBridge.toReal(context, vdir)

        // 路径护栏复用 VfsBridge 的那份（空路径、`..`、系统分区）。
        // 监听是只读的，所以不用破坏性操作那条（它还挡「受保护路径」与
        // 「容器根目录不可删」，那两条对只读请求不成立）。
        VfsBridge.guardWatchPath(vdir, real)

        // /data 下的目录（除 App 自己那份）普通 uid 读不到 inotify 事件，
        // 先说清楚比事后让用户对着「不动的界面」发愣好。
        if (needsShizuku(context, real)) {
            throw VfsError(
                VfsBridge.ERR_DENIED,
                "该目录需 Shizuku，当前只支持公共存储目录的事件监听",
            )
        }

        // 公共存储要「所有文件访问」权限，没有它 inotify 同样收不到事件。
        VfsBridge.requireStoragePermission(context, storageProbe(real))

        val dir = File(real)
        if (!dir.exists()) {
            throw VfsError(VfsBridge.ERR_NOT_FOUND, "目录不存在：$vdir")
        }
        if (!dir.isDirectory) {
            throw VfsError(VfsBridge.ERR_INVALID_PATH, "不是目录：$vdir")
        }

        val key = real.trimEnd('/').ifEmpty { real }
        synchronized(lock) {
            val existingId = watchIdByRealDir[key]
            if (existingId != null) {
                val existing = watches[existingId]
                if (existing != null) {
                    // 幂等命中：复用同一个 observer。scriptId 以最近一次为准——
                    // 用户重新挂一次通常就是想换掉绑定关系。
                    existing.scriptId = scriptId
                    return mapOf("ok" to true, "watchId" to existing.watchId)
                }
                watchIdByRealDir.remove(key)
            }

            val watchId = UUID.randomUUID().toString()
            val entry = WatchEntry(watchId, vdir, real, scriptId)
            val observer = createObserver(entry)
            // 先把 observer 挂上再登记：挂不上就抛错，不能留下一个「登记了
            // 但没在监听」的条目——watchList 会把它报出来，界面看着在监听，
            // 实际永远收不到事件。
            try {
                observer.startWatching()
            } catch (e: Throwable) {
                throw VfsError(
                    VfsBridge.ERR_DENIED,
                    "无法监听该目录：$vdir（${e.message ?: "未知错误"}）",
                )
            }
            entry.observer = observer
            watches[watchId] = entry
            watchIdByRealDir[key] = watchId
            return mapOf("ok" to true, "watchId" to watchId)
        }
    }

    /**
     * 停止监听。
     *
     * args: `{watchId}`。返回 `{ok: true}`；watchId 不存在也返回 ok——
     * 「停一个没在跑的东西」不是错误，是幂等。
     */
    fun stop(call: MethodCall): Map<String, Any> {
        val watchId = call.argument<String>("watchId") ?: ""
        stopWatch(watchId)
        return mapOf("ok" to true)
    }

    /**
     * 列出当前所有监听。
     *
     * 返回: `{ok, watches: [{watchId, dir, scriptId}]}`，`dir` 是虚拟路径。
     */
    fun list(): Map<String, Any> {
        val rows = synchronized(lock) {
            watches.values.map {
                mapOf(
                    "watchId" to it.watchId,
                    "dir" to it.vdir,
                    "scriptId" to it.scriptId,
                )
            }
        }
        return mapOf("ok" to true, "watches" to rows)
    }

    // ------------------------------------------------------------------
    // 内部：observer 与事件合并
    // ------------------------------------------------------------------

    /**
     * 建 observer。
     *
     * API 29 起有 [FileObserver] 的 File 构造器，老系统只有 String 构造器
     * （已被标记废弃）。两条路都留着，只是为了兼容 minSdk。
     */
    @Suppress("DEPRECATION")
    private fun createObserver(entry: WatchEntry): FileObserver {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            object : FileObserver(File(entry.realDir), WATCH_MASK) {
                override fun onEvent(event: Int, path: String?) {
                    onFsEvent(entry, event, path)
                }
            }
        } else {
            object : FileObserver(entry.realDir, WATCH_MASK) {
                override fun onEvent(event: Int, path: String?) {
                    onFsEvent(entry, event, path)
                }
            }
        }
    }

    /**
     * 收到内核事件。
     *
     * 事件跑在 observer 自己的线程上，而 MethodChannel 的调用必须在主线程，
     * 所以这里只做「换算 + 投递」，真正的合并与推送都回主线程。
     */
    private fun onFsEvent(entry: WatchEntry, event: Int, path: String?) {
        main.post { merge(entry, event, path) }
    }

    /**
     * 把一个内核事件并进合并窗口。
     *
     * 窗口是**尾沿续期式**的：每来一个事件就把推的时刻往后推 [DEBOUNCE_MS]，
     * 窗口内只改状态、不推。这么定有两个理由：
     *
     * 1. 一次写入的 create / modify / delete 是连着来的，尾沿能把它们收进
     *    **同一个**窗口——哪怕这一串跨越了窗口边界（写在 799ms、改在 810ms、
     *    删在 820ms，固定窗口会把它劈成两次推送，脚本多跑一次）。
     * 2. 「窗口内 create 与 delete 混合只推 deleted」这条规则才成立：
     *    同一串事件必须落在同一个窗口里才有「混合」可言。
     *
     * 尾沿的代价是「事件一直不停就永远推不出去」，所以有 [MAX_WAIT_MS] 兜底：
     * 从窗口第一个事件起算，超过上限就按当前状态推一次，保证「有变化就有通知」。
     */
    private fun merge(entry: WatchEntry, event: Int, rawPath: String?) {
        if (event == FileObserver.DELETE_SELF || event == FileObserver.MOVE_SELF) {
            // 被监听的目录自己没了：监听已经没有意义，摘掉。
            stopWatch(entry.watchId)
            return
        }
        val type = typeOf(event) ?: return
        val name = entryName(rawPath) ?: return
        // 条目键用「监听目录 + 条目名」，不直接用内核给的路径：inotify 给的
        // 可能是绝对路径、也可能只是目录下的名字，两种形态要归一到同一个键，
        // 否则同一个文件的两次事件会落进两个窗口，白白推两遍。
        val itemKey = "${entry.realDir.trimEnd('/')}/$name"
        val vpath = if (entry.vdir.endsWith("/")) "${entry.vdir}$name" else "${entry.vdir}/$name"
        val now = SystemClock.elapsedRealtime()

        val task: Runnable
        val delay: Long
        synchronized(lock) {
            val p = pending[itemKey] ?: PendingEvent(
                entry.watchId, entry.vdir, vpath, name, now,
            ).also { pending[itemKey] = it }
            when (type) {
                TYPE_CREATED -> p.created = true
                TYPE_DELETED -> p.deleted = true
                else -> p.modified = true
            }
            // 续期：撤掉上一次排定的推，改成新的。
            p.first?.let { main.removeCallbacks(it) }
            val elapsed = now - p.firstAt
            delay = if (elapsed >= MAX_WAIT_MS) 0L else DEBOUNCE_MS
            task = Runnable { flush(itemKey) }
            p.first = task
        }
        main.postDelayed(task, delay)
    }

    /**
     * 窗口结束，推一次。
     *
     * 合并规则：create 与 delete 混在一起时只推最终的 deleted；
     * 只有 create（可能夹着 modify）时推 created；其余推 modified。
     */
    private fun flush(itemKey: String) {
        val payload: Map<String, Any>
        synchronized(lock) {
            val p = pending.remove(itemKey) ?: return
            val type = when {
                p.deleted -> TYPE_DELETED
                p.created -> TYPE_CREATED
                else -> TYPE_MODIFIED
            }
            payload = mapOf(
                "type" to type,
                "dir" to p.vdir,
                "path" to p.vpath,
                "name" to p.name,
            )
        }
        push(payload)
    }

    /** 推给 Dart。通道没绑（App 刚起来还没接上）时静默丢弃，不抛。 */
    private fun push(payload: Map<String, Any>) {
        val channel = VfsBridge.boundChannel() ?: return
        channel.invokeMethod(EVENT_METHOD, payload, object : MethodChannel.Result {
            override fun success(result: Any?) {
                // Dart 侧收到即认为送达，没有需要回传的东西。
            }

            override fun error(code: String, message: String?, details: Any?) {
                Log.w(TAG, "事件推送失败：$code ${message ?: ""}")
            }

            override fun notImplemented() {
                Log.w(TAG, "Dart 侧没有注册 $EVENT_METHOD 的处理方法")
            }
        })
    }

    /** 停掉一个监听，并清掉它还没推出去的窗口。 */
    private fun stopWatch(watchId: String) {
        synchronized(lock) {
            val entry = watches.remove(watchId) ?: return
            try {
                entry.observer?.stopWatching()
            } catch (e: Throwable) {
                Log.w(TAG, "停止监听失败：${e.message}")
            }
            val key = entry.realDir.trimEnd('/').ifEmpty { entry.realDir }
            if (watchIdByRealDir[key] == watchId) {
                watchIdByRealDir.remove(key)
            }
            val stale = pending.entries.filter { it.value.watchId == watchId }
            for (item in stale) {
                item.value.first?.let { main.removeCallbacks(it) }
                pending.remove(item.key)
            }
        }
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    /** 内核事件 → 事件类型。不关心的直接丢掉。 */
    private fun typeOf(event: Int): String? = when (event) {
        FileObserver.CREATE, FileObserver.MOVED_TO -> TYPE_CREATED
        FileObserver.DELETE, FileObserver.MOVED_FROM -> TYPE_DELETED
        FileObserver.MODIFY, FileObserver.CLOSE_WRITE, FileObserver.ATTRIB -> TYPE_MODIFIED
        else -> null
    }

    /**
     * 条目名。
     *
     * inotify 给的可能是绝对路径、也可能只是目录下的名字，两种都取最后一段
     * 当条目名——对外报的 name 与 path 必须自洽（path = dir + "/" + name）。
     */
    private fun entryName(raw: String?): String? {
        if (raw.isNullOrEmpty()) return null
        val trimmed = raw.trimEnd('/')
        if (trimmed.isEmpty()) return null
        return File(trimmed).name
    }

    /**
     * 是否是需要 Shizuku 的目录。
     *
     * App 自己的 filesDir 不算：那是 App 自己的家，普通 uid 本来就能读。
     */
    private fun needsShizuku(context: Context, real: String): Boolean {
        val files = context.filesDir.absolutePath
        if (real == files || real.startsWith("$files/")) return false
        return real == "/data" || real.startsWith("/data/")
    }

    /**
     * 权限探测用的路径。
     *
     * `/sdcard` 是 `/storage/emulated/0` 的别名，而「所有文件访问」权限的
     * 判定看的是 `/storage/` 前缀，所以先把别名换成真身再问权限。
     */
    private fun storageProbe(real: String): String {
        if (real == "/sdcard") return "/storage/emulated/0"
        if (real.startsWith("/sdcard/")) return "/storage/emulated/0" + real.substring("/sdcard".length)
        return real
    }

    /** 一个监听项。 */
    private class WatchEntry(
        val watchId: String,
        /** 虚拟路径，回给 Dart 的 dir 用它。 */
        val vdir: String,
        /** 真实路径，observer 挂在它上面。 */
        val realDir: String,
        /** 绑定脚本 id；空串表示只监听不触发脚本。 */
        var scriptId: String,
    ) {
        var observer: FileObserver? = null
    }

    /** 一个待推送事件（合并窗口内的状态）。 */
    private class PendingEvent(
        val watchId: String,
        val vdir: String,
        /** 受影响条目的虚拟路径。 */
        val vpath: String,
        val name: String,
        /** 窗口起点（elapsedRealtime）。 */
        val firstAt: Long,
    ) {
        var created = false
        var modified = false
        var deleted = false

        /** 已排定的 flush 任务；停监听时撤掉它。 */
        var first: Runnable? = null
    }
}
