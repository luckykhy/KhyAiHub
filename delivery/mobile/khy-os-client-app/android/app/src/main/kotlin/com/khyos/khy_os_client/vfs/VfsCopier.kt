package com.khyos.khy_os_client.vfs

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * 异步多线程复制：copyStart / copyCancel / copyStatus + `vfsProgress` 进度事件。
 *
 * 为什么另起一个实现，而不是把 copyStorage 改成异步：
 *  - copyStorage 是**同步一次调用**的语义（复制完才返回），Dart 侧拿不到中间态；
 *  - 它没有断点续传：中途失败时目标文件是个「看起来完整其实不完整」的文件，
 *    下次没法区分它是不是残缺，只能整个重来；
 *  - 它没有进度：几 GB 的文件复制时界面只能转圈。
 *
 * 三条边界：
 *
 * 1. **护栏不在这里复刻。** 路径校验（空路径、`..`、受保护路径、系统分区）与存储
 *    权限判定全部走 [VfsBridge] 的同一份实现（[VfsBridge.requirePath]、
 *    [VfsBridge.guardDestructive]、[VfsBridge.requireStoragePermission]）。
 *    「界面不让点、原生却能做」的裂缝正是这里要避免的东西。
 * 2. **路径映射只在 [VfsBridge] 做。** 对外（`current`、状态）一律是虚拟路径，
 *    容器里的东西要回到 `/khyos/container/...`，Dart 侧不认识宿主真实路径。
 * 3. **冲突判定按文件粒度。** skip=跳过该文件、overwrite=覆盖该文件、
 *    rename=该文件换个名字、merge=并进已有目录且同名文件按 overwrite 处理。
 *
 * 冲突语义与 copyStorage 的差别（有意为之，写在这里免得后来人当成 bug）：
 *  - copyStorage 的 overwrite 在目标是目录时会**整棵删掉**目标目录；这里改成
 *    逐文件覆盖。整棵删除会把待续传的 `.khy-part` 一起删掉，断点续传就无从
 *    谈起；而且「删掉目标目录里用户自己的其它文件」不是复制该干的事。
 *  - copyStorage 的 rename 在目标是目录时给**整个目录**改名；这里改成逐文件
 *    改名（`name (1).ext`），与「目录递归：逐文件走上面的流程」一致。
 *  - merge 与 overwrite 在文件层面口径相同（同名文件都按 overwrite 处理），
 *    差别在目录层面：merge 保留目标目录并把内容并进去，overwrite 也不删目录，
 *    只是逐个覆盖同名文件。两者都不会整棵删除目标目录——这是与 copyStorage
 *    的实质差异，为的是保住断点续传用的 part 文件。
 *
 * 断点续传为什么用 `.part` 而不是直接写目标名：直接写目标名的话，中断后目标文件
 * 是个「看起来完整其实不完整」的文件，下次续传没法区分它是不是残缺；而 part 文件
 * 的存在本身就是「未完成」的标记，语义干净。
 */
object VfsCopier {

    private const val TAG = "KhyVfsCopier"

    /** 推给 Dart 的进度事件名。Dart 侧在同一通道上注册 handler 接。 */
    const val EVENT_METHOD = "vfsProgress"

    /** 半成品文件后缀。part 文件存在 = 这个文件还没复制完。 */
    private const val PART_SUFFIX = ".khy-part"

    /** 半成品的元信息后缀：记源文件的 size 与 mtime，用来判断能不能续。 */
    private const val META_SUFFIX = ".khy-part.meta"

    /**
     * 进度事件最小间隔。
     *
     * 100ms：再密就是纯粹浪费通道带宽（大文件复制每秒能产生上百次进度），
     * 而 UI 上 10 帧/秒已经看不出差别了。
     */
    private const val PROGRESS_INTERVAL_MS = 100L

    /** 默认线程数。 */
    private const val DEFAULT_THREADS = 3

    /** 线程数下限。 */
    private const val MIN_THREADS = 1

    /** 线程数上限：再多只是抢 IO 带宽，收益递减。 */
    private const val MAX_THREADS = 8

    /** 单次读写缓冲。 */
    private const val COPY_BUFFER = 64 * 1024

    /** 保留的历史任务上限：状态查询要看刚结束的任务，但不能无限涨。 */
    private const val MAX_KEPT_TASKS = 64

    /** 目录递归深度上限：软链接成环时兜底。 */
    private const val MAX_DEPTH = 64

    /** 合法的冲突策略。 */
    private val CONFLICTS = setOf("skip", "overwrite", "rename", "merge")

    /** MethodChannel 的调用必须在平台线程（主线程）上做。 */
    private val main = Handler(Looper.getMainLooper())

    /** taskId → 任务。保留已结束的任务，好让 Dart 侧还能查最终状态。 */
    private val tasks = ConcurrentHashMap<String, CopyTask>()

    /** 「源+目标」→ taskId。同一个键已经在跑时不许起第二个任务（幂等）。 */
    private val runningByPair = ConcurrentHashMap<String, String>()

    /** 幂等键的登记锁：查与登记要在同一把锁里，否则并发调用会各起一个任务。 */
    private val pairLock = Any()

    /**
     * 监督线程池：每个复制任务一个监督者，等所有文件复制完再收尾。
     *
     * 为什么不让监督者占用文件复制的线程池：线程池的槽位是按「同时复制几个文件」
     * 定的，让监督者占一个槽等于少复制一个文件。
     */
    private val supervisors = Executors.newCachedThreadPool()

    // ------------------------------------------------------------------
    // 对外入口：copyStart / copyCancel / copyStatus
    // ------------------------------------------------------------------

    /**
     * 开始复制。
     *
     * args: `{src, dst, conflict, resume, threads}`
     *  - `src` / `dst` 是**虚拟路径**（如 /storage/emulated/0/Download/a.zip）；
     *  - `conflict` ∈ skip / overwrite / rename / merge；
     *  - `resume` 为 true 时启用断点续传；
     *  - `threads` 缺省 3，上限 8，下限 1。
     *
     * 返回: `{ok: true, taskId}`；失败时是 `{ok: false, error, message}`。
     *
     * 幂等：同一对源/目标已经在跑时返回**已有**的 taskId，不会起第二个任务。
     */
    fun start(context: Context, call: MethodCall): Map<String, Any> {
        val srcV = VfsBridge.requirePath(call, "src")
        val dstV = VfsBridge.requirePath(call, "dst")
        val conflict = call.argument<String>("conflict") ?: "skip"
        if (conflict !in CONFLICTS) {
            throw VfsError(VfsBridge.ERR_INVALID_PATH, "未知的冲突策略：$conflict")
        }
        val resume = call.argument<Boolean>("resume") == true
        // 用 Number 接：Dart 的 int 在标准编解码器里可能是 Int 也可能是 Long。
        val threads = (call.argument<Number>("threads")?.toInt() ?: DEFAULT_THREADS)
            .coerceIn(MIN_THREADS, MAX_THREADS)

        val srcReal = VfsBridge.toReal(context, srcV)
        val dstReal = VfsBridge.toReal(context, dstV)
        // 分隔符用 NUL：路径里可能有空格，用空格分隔会撞键
        // （"/a b" + "/c" 与 "/a" + "b /c" 会撞成同一个键）。
        val pairKey = "$srcReal\u0000$dstReal"

        // 幂等：同一个源+目标已经在跑就直接复用那个任务。
        runningByPair[pairKey]?.let { existingId ->
            tasks[existingId]?.let { return mapOf("ok" to true, "taskId" to existingId) }
        }

        // 护栏：目标是要写的地方，用 VfsBridge 的同一份判定，不在这里另写一份。
        // 按 shell 档传，是为了让「系统分区只读」这道判定照旧生效——按 storage 档
        // 会把它漏掉（与 VfsArchive 的做法一致）。
        VfsBridge.guardDestructive(context, dstV, dstReal, VfsBridge.VIA_SHELL)
        VfsBridge.requireStoragePermission(context, srcReal)
        VfsBridge.requireStoragePermission(context, dstReal)

        val srcFile = File(srcReal)
        if (!srcFile.exists()) {
            throw VfsError(VfsBridge.ERR_NOT_FOUND, "源不存在：$srcV")
        }

        // 源是文件时：目标的父目录必须已经在。不替用户凭空造目录——造错了
        // 用户根本不会知道文件被放到了哪儿。
        if (srcFile.isFile) {
            val dstFile = File(dstReal)
            val parent = if (dstFile.isDirectory) dstFile else dstFile.parentFile
            if (parent == null || !parent.isDirectory) {
                throw VfsError(
                    VfsBridge.ERR_NOT_FOUND,
                    "目标目录不存在：${parent?.let { VfsBridge.toVirtual(context, it.absolutePath) } ?: dstV}",
                )
            }
            // 源和目标是同一个路径：part 文件会盖住源自己，边读边写把源写坏。
            // 目标本身是个已存在的目录时，真正落地的文件名是「目录/源文件名」。
            val resolved = if (dstFile.isDirectory) File(dstFile, srcFile.name) else dstFile
            if (resolved.absolutePath == srcFile.absolutePath) {
                throw VfsError(VfsBridge.ERR_INVALID_PATH, "源与目标是同一个文件：$srcV")
            }
        }

        // 目标在源目录里面：复制目录会把刚写进去的东西再复制一遍，越滚越大。
        // 这条拦下来比让它跑一小时再失败好。
        if (srcFile.isDirectory) {
            val srcCanon = canonical(srcFile)
            val dstCanon = canonical(File(dstReal))
            if (dstCanon != srcCanon && dstCanon.startsWith("$srcCanon/")) {
                throw VfsError(
                    VfsBridge.ERR_INVALID_PATH,
                    "目标在源目录之内，无法复制：$srcV → $dstV",
                )
            }
        }

        val task = CopyTask(
            taskId = UUID.randomUUID().toString(),
            srcReal = srcReal,
            dstReal = dstReal,
            conflict = conflict,
            resume = resume,
            threads = threads,
            pairKey = pairKey,
        )
        // 登记要在锁里做，且要**再查一次**：上面那次查与这里这次登记之间有窗口，
        // 两个并发的 copyStart 都可能通过上面的查，然后各起一个任务。
        // 在锁里重查 + 登记，这个窗口就没了。
        synchronized(pairLock) {
            runningByPair[pairKey]?.let { existingId ->
                tasks[existingId]?.let { return mapOf("ok" to true, "taskId" to existingId) }
            }
            tasks[task.taskId] = task
            runningByPair[pairKey] = task.taskId
        }
        pruneTasks()

        // 复制本身在后台跑：这里只把任务起起来就返回，Dart 侧靠进度事件与
        // copyStatus 跟进。规划（遍历目录树）也放在后台，别占住通道的 IO 线程。
        supervisors.execute { runTask(task, context) }
        return mapOf("ok" to true, "taskId" to task.taskId)
    }

    /**
     * 取消复制。
     *
     * args: `{taskId}`。返回 `{ok: true}`；taskId 不存在也返回 ok——
     * 「停一个没在跑的东西」不是错误，是幂等。
     *
     * 取消后已落盘的 part 文件**留着**：这样下次可以用同一对源/目标重开，
     * 直接从断点接着来，而不是整个文件重传。
     */
    fun cancel(call: MethodCall): Map<String, Any> {
        val taskId = call.argument<String>("taskId") ?: ""
        tasks[taskId]?.let { task ->
            if (!task.terminal.get()) {
                task.cancelled.set(true)
                // 打断正在跑的复制：中断后已写的 part 与 meta 都留着（可续）。
                task.cancelFutures()
                task.pool?.shutdownNow()
            }
        }
        return mapOf("ok" to true)
    }

    /**
     * 查任务状态。
     *
     * args: `{taskId}`。返回 `{ok: true, state, done, total, files, error}`：
     *  - `state` ∈ running / done / cancelled / error；
     *  - `done` / `total` 是**字节数**（与进度事件同一口径）；
     *  - `files` 是已复制完成的文件数（跳过的文件不算）。
     *
     * taskId 不存在时也返回 ok，state 记成 error 并带上原因：状态查询本身
     * 不该变成一次异常（Dart 侧轮询时会立刻拿到可读的失败原因）。
     */
    fun status(call: MethodCall): Map<String, Any> {
        val taskId = call.argument<String>("taskId") ?: ""
        val task = tasks[taskId] ?: return mapOf(
            "ok" to true,
            "state" to "error",
            "done" to 0L,
            "total" to 0L,
            "files" to 0,
            "error" to "未知的复制任务：$taskId",
        )
        return mapOf(
            "ok" to true,
            "state" to task.state,
            "done" to task.done.get(),
            "total" to task.total.get(),
            "files" to task.files.get(),
            "error" to task.errorMessage,
        )
    }

    // ------------------------------------------------------------------
    // 任务执行
    // ------------------------------------------------------------------

    /**
     * 复制任务的主体：规划 → 并行复制 → 收尾。
     *
     * 规划（遍历目录树、算总字节数）与复制分开：规划必须先跑完才知道总大小，
     * 否则进度条的分母会一路往上涨；规划完就把文件一件件丢进线程池并行复制。
     */
    private fun runTask(task: CopyTask, context: Context) {
        try {
            val plan = buildPlan(task)
            task.total.set(plan.total)

            val pool = Executors.newFixedThreadPool(task.threads)
            task.pool = pool

            val futures = ArrayList<Future<*>>(plan.jobs.size)
            for (job in plan.jobs) {
                if (task.cancelled.get()) break
                val future = pool.submit { copyOne(task, context, job) }
                futures.add(future)
                task.addFuture(future)
            }

            var failure: String? = null
            for (future in futures) {
                try {
                    future.get()
                } catch (e: CancellationException) {
                    // 取消导致的正常结束，不算失败。
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                } catch (e: ExecutionException) {
                    if (failure == null) {
                        failure = e.cause?.message ?: e.cause?.javaClass?.simpleName ?: "复制失败"
                    }
                }
            }

            pool.shutdown()

            // 取消时等一下工作线程真的退出来：终态事件必须推在「不再有写入」之后，
            // 否则 Dart 侧看到的 done 还会在终态之后继续涨。
            if (task.cancelled.get()) {
                try {
                    pool.awaitTermination(2, TimeUnit.SECONDS)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }

            when {
                task.cancelled.get() -> finish(task, "cancelled", "")
                failure != null -> finish(task, "error", failure)
                else -> finish(task, "done", "")
            }
        } catch (e: Throwable) {
            finish(task, "error", e.message ?: "复制失败")
        }
    }

    /**
     * 规划：把源树摊平成「一个源文件 → 一个目标文件」的清单，并算出总字节数。
     *
     * 冲突策略在这一层就能定的（skip 跳过已存在的文件）先定掉；rename 要等到
     * 真正复制那一刻才知道该用哪个名字（那时要避开已存在与可续的 part）。
     */
    private fun buildPlan(task: CopyTask): Plan {
        val src = File(task.srcReal)
        val dst = File(task.dstReal)
        val jobs = ArrayList<FileJob>()

        if (src.isFile) {
            // 目标已经是目录时，文件放进去（与 copyStorage 同一口径：避免
            // overwrite 把整个目录删掉）。
            val dest = if (dst.isDirectory) File(dst, src.name) else dst
            if (task.conflict == "skip" && dest.exists()) {
                return Plan(jobs, 0L)
            }
            jobs.add(FileJob(src, dest))
            return Plan(jobs, src.length())
        }

        // 源是目录：目标根目录就是 dst。
        var root = dst
        if (dst.exists() && !dst.isDirectory) {
            // 目标位置上已经是个文件：放不进目录树，得先处理掉。
            when (task.conflict) {
                "overwrite", "merge" -> dst.delete()
                "skip" -> return Plan(jobs, 0L)
                "rename" -> root = uniqueRoot(dst)
                else -> return Plan(jobs, 0L)
            }
        }
        if (!root.exists() && !root.mkdirs() && !root.isDirectory) {
            throw IOException("无法创建目标目录：${root.absolutePath}")
        }

        val seen = HashSet<String>()
        collect(src, root, task.conflict, 0, seen, jobs)
        var total = 0L
        for (job in jobs) {
            total += job.src.length()
        }
        return Plan(jobs, total)
    }

    /**
     * 递归摊平源目录。
     *
     * `seen` 记真实路径（canonicalPath）：软链接成环时同一个真实目录只走一次，
     * 否则会无限递归把栈打爆。
     */
    private fun collect(
        srcDir: File,
        destDir: File,
        conflict: String,
        depth: Int,
        seen: MutableSet<String>,
        out: MutableList<FileJob>,
    ) {
        if (depth > MAX_DEPTH) return
        val key = try {
            srcDir.canonicalPath
        } catch (e: Throwable) {
            srcDir.absolutePath
        }
        if (!seen.add(key)) return

        val kids = srcDir.listFiles() ?: return
        for (kid in kids) {
            if (kid.isDirectory) {
                collect(kid, File(destDir, kid.name), conflict, depth + 1, seen, out)
            } else {
                val dest = File(destDir, kid.name)
                if (conflict == "skip" && dest.exists()) continue
                out.add(FileJob(kid, dest))
            }
        }
    }

    /**
     * 复制一个文件。
     *
     * 流程：定目标名 → 判能不能续 → 写 part → 改名为正式目标名。
     * 中断（取消/出错）时 part 与 meta 都留着，下次可以接着来。
     */
    private fun copyOne(task: CopyTask, context: Context, job: FileJob) {
        if (task.cancelled.get() || Thread.currentThread().isInterrupted) return

        val src = job.src
        val dest = resolveDest(task, job)
        val part = File(dest.absolutePath + PART_SUFFIX)
        val meta = File(dest.absolutePath + META_SUFFIX)
        val srcSize = src.length()
        val srcMtime = src.lastModified()

        // 断点续传判定：三条都要满足才续，否则从头来。
        //  1. part 文件存在；
        //  2. 旁边的 meta 文件存在，且记的 size/mtime 与**当前**源文件一致
        //     （源变了就不能续，否则拼出来的是个坏文件）。
        var offset = 0L
        if (task.resume && part.isFile && meta.isFile) {
            val recorded = readMeta(meta)
            if (recorded != null &&
                recorded[0] == srcSize &&
                recorded[1] == srcMtime &&
                part.length() <= srcSize
            ) {
                offset = part.length()
            }
        }
        if (offset <= 0L) {
            // 续不上（或没开续传）：删掉旧的 part 与 meta，从 0 开始。
            part.delete()
            meta.delete()
            // meta 先写：它必须在字节落盘之前就在，否则中断后 part 存在而 meta
            // 不在，下次就判定「不能续」，白传一遍。
            writeMeta(meta, srcSize, srcMtime)
        }

        // 目录树是边复制边建的：目标文件的父目录可能还不存在。
        dest.parentFile?.let { parent ->
            if (!parent.isDirectory) {
                parent.mkdirs()
                if (!parent.isDirectory) {
                    throw IOException("无法创建目录：${parent.absolutePath}")
                }
            }
        }

        task.current.set(VfsBridge.toVirtual(context, src.absolutePath))
        if (offset > 0L) {
            // 已经落盘的那一段算作已完成，进度条才是连续的。
            task.done.addAndGet(offset)
        }

        try {
            RandomAccessFile(src, "r").use { input ->
                input.seek(offset)
                FileOutputStream(part, offset > 0L).use { out ->
                    val buffer = ByteArray(COPY_BUFFER)
                    while (true) {
                        // 取消要在每个块之间看一眼：文件 IO 本身不响应中断标志，
                        // 不检查就会把整个文件传完才停。
                        if (task.cancelled.get() || Thread.currentThread().isInterrupted) {
                            throw InterruptedException("复制已取消")
                        }
                        val n = input.read(buffer)
                        if (n <= 0) break
                        out.write(buffer, 0, n)
                        task.done.addAndGet(n.toLong())
                        pushProgress(task, "copying", false)
                    }
                    out.flush()
                }
            }
        } catch (e: InterruptedException) {
            // 取消：已写的 part 与 meta 都留着，下次能续。
            Thread.currentThread().interrupt()
            return
        }

        // 完成：把 part 改名成正式目标名，**然后**才删 meta。
        // 顺序不能反：改名失败时 meta 还在，下次还能从 part 续上；先删 meta
        // 的话，这次失败就把续传的机会一起弄没了。
        if (dest.exists() && dest.isDirectory) {
            // 目标位置上是个目录：改名一定失败。直接报错，不去删用户的目录树
            // ——「复制」不该顺手删掉一个目录。
            throw IOException("目标已存在且是目录：${dest.absolutePath}")
        }
        // rename(2) 在 Linux 上是原子替换：旧目标一直都在，改名成功才换人。
        // 中途失败不会留下「目标没了、新的也没成」的空窗。
        if (!part.renameTo(dest)) {
            // 改名失败（跨设备 / 某些 FUSE 挂载）：先让位，再退回复制一遍。
            if (dest.exists()) dest.delete()
            if (!moveByCopy(part, dest)) {
                throw IOException("无法完成重命名：${part.name} → ${dest.name}")
            }
        }
        meta.delete()
        task.files.incrementAndGet()
        pushProgress(task, "copying", false)
    }

    /**
     * 改名兜底：某些文件系统上 rename 会失败（共享存储的 FUSE 挂载偶发），
     * 这时退回复制一遍再删源，功能不打折。
     */
    private fun moveByCopy(part: File, dest: File): Boolean {
        return try {
            RandomAccessFile(part, "r").use { input ->
                FileOutputStream(dest).use { out ->
                    val buffer = ByteArray(COPY_BUFFER)
                    while (true) {
                        val n = input.read(buffer)
                        if (n <= 0) break
                        out.write(buffer, 0, n)
                    }
                    out.flush()
                }
            }
            part.delete()
            true
        } catch (e: Throwable) {
            false
        }
    }

    /**
     * 定目标文件名。
     *
     * rename 时目标已存在就换个名字（name (1).ext）。挑名字时**优先挑带 part 的
     * 候选**：中断后重来要接同一个 part，否则每次都换新名，续传就断了。
     *
     * 加锁：多个工作线程同时挑名字时要串行，否则两个线程会挑到同一个名字，
     * 互相覆盖对方的 part。
     */
    private fun resolveDest(task: CopyTask, job: FileJob): File {
        if (task.conflict != "rename") return job.dest
        if (!job.dest.exists()) return job.dest
        return synchronized(task.nameLock) { uniqueName(job.dest, job.src) }
    }

    /** 找一个可用的目标名：name (1).ext、name (2).ext… */
    private fun uniqueName(base: File, src: File): File {
        val parent = base.parentFile
        val name = base.name
        val dot = name.lastIndexOf('.')
        val hasExt = dot > 0 && dot < name.length - 1
        val stem = if (hasExt) name.substring(0, dot) else name
        val ext = if (hasExt) name.substring(dot) else ""
        for (i in 1..999) {
            val candidate = File(parent, "$stem ($i)$ext")
            if (candidate.exists()) continue
            val part = File(candidate.absolutePath + PART_SUFFIX)
            if (part.isFile && metaMatches(part, src)) return candidate
            return candidate
        }
        throw VfsError(VfsBridge.ERR_BUSY, "无法生成可用文件名：$name")
    }

    /** 目标位置上已经是个文件时，rename 档把整棵目录换个名字。 */
    private fun uniqueRoot(base: File): File {
        val parent = base.parentFile
        val name = base.name
        for (i in 1..999) {
            val candidate = File(parent, "$name ($i)")
            if (!candidate.exists()) return candidate
        }
        throw VfsError(VfsBridge.ERR_BUSY, "无法生成可用文件名：$name")
    }

    /** 真实路径（解掉软链接与 ..）。取不到就退回绝对路径。 */
    private fun canonical(file: File): String {
        return try {
            file.canonicalPath
        } catch (e: Throwable) {
            file.absolutePath
        }
    }

    // ------------------------------------------------------------------
    // part / meta
    // ------------------------------------------------------------------

    /**
     * 读 meta：记着源文件的 size 与 mtime。
     *
     * 格式：`size=<n>\nmtime=<n>\n`。读不出来（文件坏了/格式不对）就当没有，
     * 宁可整个重传也不拿一个坏文件续上去。
     */
    private fun readMeta(meta: File): LongArray? {
        return try {
            if (!meta.isFile) return null
            var size = -1L
            var mtime = -1L
            for (line in meta.readText().split("\n")) {
                val trimmed = line.trim()
                if (trimmed.startsWith("size=")) {
                    size = trimmed.substring(5).trim().toLongOrNull() ?: -1L
                } else if (trimmed.startsWith("mtime=")) {
                    mtime = trimmed.substring(6).trim().toLongOrNull() ?: -1L
                }
            }
            if (size < 0L || mtime < 0L) null else longArrayOf(size, mtime)
        } catch (e: Throwable) {
            null
        }
    }

    /** 写 meta。写不进去也不致命：只是下次不能续传而已。 */
    private fun writeMeta(meta: File, size: Long, mtime: Long) {
        try {
            meta.writeText("size=$size\nmtime=$mtime\n")
        } catch (e: Throwable) {
            Log.w(TAG, "写续传元信息失败：${e.message}")
        }
    }

    /** part 的 meta 是否与当前源文件一致（决定能不能续）。 */
    private fun metaMatches(part: File, src: File): Boolean {
        val meta = File(part.absolutePath + META_SUFFIX)
        val recorded = readMeta(meta) ?: return false
        return recorded[0] == src.length() && recorded[1] == src.lastModified()
    }

    // ------------------------------------------------------------------
    // 进度事件
    // ------------------------------------------------------------------

    /**
     * 推一次进度。
     *
     * 非终态最多每 [PROGRESS_INTERVAL_MS] 推一次，否则大文件复制会把通道刷爆。
     * 终态（done / cancelled / error）必须推一次，Dart 侧靠它收尾。
     */
    private fun pushProgress(task: CopyTask, phase: String, force: Boolean) {
        val now = SystemClock.elapsedRealtime()
        val payload: Map<String, Any>
        synchronized(task.pushLock) {
            if (!force && task.pushed && now - task.lastPushMs < PROGRESS_INTERVAL_MS) return
            task.pushed = true
            task.lastPushMs = now
            payload = mapOf(
                "taskId" to task.taskId,
                "phase" to phase,
                "done" to task.done.get(),
                "total" to task.total.get(),
                "files" to task.files.get(),
                "current" to task.current.get(),
            )
        }
        main.post {
            val channel = VfsBridge.boundChannel() ?: return@post
            channel.invokeMethod(EVENT_METHOD, payload, pushResult)
        }
    }

    /** 通道没绑 / Dart 侧没注册时的兜底：只记日志，不打断复制。 */
    private val pushResult = object : MethodChannel.Result {
        override fun success(result: Any?) {
            // Dart 侧收到即认为送达，没有需要回传的东西。
        }

        override fun error(code: String, message: String?, details: Any?) {
            Log.w(TAG, "进度推送失败：$code ${message ?: ""}")
        }

        override fun notImplemented() {
            Log.w(TAG, "Dart 侧没有注册 $EVENT_METHOD 的处理方法")
        }
    }

    /** 任务收尾：定状态、推终态事件、摘掉幂等键。 */
    private fun finish(task: CopyTask, state: String, error: String) {
        if (!task.terminal.compareAndSet(false, true)) return
        task.state = state
        task.errorMessage = error
        task.finishedAt = SystemClock.elapsedRealtime()
        // 摘幂等键要和登记用同一把锁：否则「登记新任务」与「摘旧键」交叉时，
        // 旧键会把刚登记的新键抹掉，幂等就漏了。
        synchronized(pairLock) {
            if (runningByPair[task.pairKey] == task.taskId) {
                runningByPair.remove(task.pairKey)
            }
        }
        pushProgress(task, phaseOf(state), true)
    }

    /** 状态 → 进度事件的 phase。 */
    private fun phaseOf(state: String): String = when (state) {
        "done" -> "done"
        "cancelled" -> "cancelled"
        else -> "error"
    }

    /** 只保留最近的若干个任务，防止状态表无限涨。 */
    private fun pruneTasks() {
        if (tasks.size <= MAX_KEPT_TASKS) return
        // 超出的条数先算出来：边删边看 tasks.size 的话，size 一直在变，
        // 终止条件跟着漂移，会多删或少删。
        val excess = tasks.size - MAX_KEPT_TASKS
        val finished = tasks.values
            .filter { it.terminal.get() }
            .sortedBy { it.finishedAt }
        var removed = 0
        for (task in finished) {
            if (removed >= excess) break
            // 还是某个幂等键的持有者就别摘：摘了会让「同一对源目标」重复起任务。
            if (runningByPair[task.pairKey] == task.taskId) continue
            tasks.remove(task.taskId)
            removed++
        }
    }

    // ------------------------------------------------------------------
    // 内部数据
    // ------------------------------------------------------------------

    /** 一个待复制文件。 */
    private class FileJob(val src: File, val dest: File)

    /** 一次复制的规划结果。 */
    private class Plan(val jobs: List<FileJob>, val total: Long)

    /**
     * 一个复制任务。
     *
     * 状态字段用 volatile / 原子类：写的是 IO 线程与工作线程，读的是通道线程，
     * 跨线程可见性必须有保证。
     */
    private class CopyTask(
        val taskId: String,
        val srcReal: String,
        val dstReal: String,
        val conflict: String,
        val resume: Boolean,
        val threads: Int,
        val pairKey: String,
    ) {
        /** running / done / cancelled / error。 */
        @Volatile
        var state: String = "running"

        /** 失败原因。成功时是空串。 */
        @Volatile
        var errorMessage: String = ""

        /** 收尾时刻，用来淘汰老任务。 */
        @Volatile
        var finishedAt: Long = 0L

        /** 取消标记：各线程在每个读写块之间检查它。 */
        val cancelled = AtomicBoolean(false)

        /** 终态只推一次、只定一次。 */
        val terminal = AtomicBoolean(false)

        /** 已复制的字节数。 */
        val done = AtomicLong(0)

        /** 总字节数。 */
        val total = AtomicLong(0)

        /** 已复制完成的文件数。 */
        val files = AtomicInteger(0)

        /** 当前正在复制的文件（虚拟路径）。 */
        val current = AtomicReference("")

        /** 进度节流的锁。 */
        val pushLock = Any()

        /** 挑目标文件名时的锁。 */
        val nameLock = Any()

        /** 上一次推事件的时刻。 */
        @Volatile
        var lastPushMs: Long = 0L

        /** 是否已经推过一次（第一次不节流）。 */
        @Volatile
        var pushed: Boolean = false

        /** 文件复制用的线程池。 */
        @Volatile
        var pool: ExecutorService? = null

        private val futureLock = Any()
        private val futures = ArrayList<Future<*>>()

        fun addFuture(future: Future<*>) {
            synchronized(futureLock) { futures.add(future) }
        }

        /** 取消所有在跑/排队的复制任务：cancel(true) 会中断工作线程。 */
        fun cancelFutures() {
            val snapshot = synchronized(futureLock) { ArrayList(futures) }
            for (future in snapshot) {
                try {
                    future.cancel(true)
                } catch (e: Throwable) {
                    // 取消失败不影响别的任务。
                }
            }
        }
    }
}
