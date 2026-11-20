package com.khyos.khy_os_client.vfs

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile

/**
 * 字节级拷贝 + 断点续传（**纯 JVM 逻辑，无 Android 依赖**）。
 *
 * ## 为什么要抽出来
 *
 * 目标 §二 明写「多线程复制/移动，支持断点续传」。此前这件事只有
 * [CopyResumeDecision] 那几行**判据**被测过——「能不能续」是对的，但
 * 「续上去之后的文件是不是**逐字节等于**源」**一行测试都没有**。
 *
 * 判据与真正的 IO 写混在 [VfsCopier.copyOne] 里，那函数要 `Context`、线程池、
 * 进度通道一起在场，JVM 单测拖不动；真机能验，但真机随时被锁屏打断。
 *
 * 抽出来之后，**字节这件事本身**可以在 JVM 上用临时目录验：写源 → 造半成品 part
 * + meta → 续 → 断言结果与源**逐字节相同**。这是「测不了的承诺等于没有」的补法。
 *
 * ## 协议不变
 *
 * 搬迁前后的行为逐条对应，改动只在这里发生：
 *  - part：`<目标>.khy-part`；meta：`<目标>.khy-part.meta`，记源文件的 size/mtime；
 *  - 续不上时：删掉旧 part 与 meta，**先写 meta 再写字节**（meta 必须在字节之前
 *    落盘，否则中断后 part 在、meta 不在，下次判定「不能续」，白传一遍）；
 *  - 完成时：part 改名为正式目标名，**然后**才删 meta（顺序反了，这次失败就把
 *    续传的机会一起弄没了）；
 *  - 改名失败（跨设备 / 某些 FUSE 挂载）：先让位，再退回复制一遍。
 */
internal object ResumeCopy {

    /** 单次读写缓冲。 */
    private const val COPY_BUFFER = 64 * 1024

    /** 一次拷贝的结果。 */
    data class Outcome(
        /** 落位后的正式目标文件。 */
        val dest: File,
        /** 续传起点（0 = 从头来）。 */
        val resumedFrom: Long,
        /** 本次实际写入的字节数。 */
        val bytesWritten: Long,
    )

    /**
     * 拷一个文件，带断点续传。
     *
     * @param src 源文件。
     * @param dest 正式目标文件（part 与 meta 落在它旁边）。
     * @param resume 是否允许续传。
     * @param cancelled 取消判定：**每个块之间**问一次（文件 IO 本身不响应中断标志）。
     * @param onPrepared 落盘准备就绪（父目录已建、meta 已写）时回调一次。
     * @param onResume 续传起点：> 0 时在**写第一个字节之前**回调。
     * @param onBytes 每写完一块回调一次（这块的字节数）。
     * @throws InterruptedException 被取消：part 与 meta **留着**，下次能接着来。
     * @throws IOException 目标位置是目录、或者改名兜底也失败。
     */
    fun copy(
        src: File,
        dest: File,
        resume: Boolean = true,
        cancelled: () -> Boolean = { false },
        onPrepared: () -> Unit = {},
        onResume: (Long) -> Unit = {},
        onBytes: (Long) -> Unit = {},
    ): Outcome {
        val part = File(dest.absolutePath + CopyResumeDecision.PART_SUFFIX)
        val meta = File(dest.absolutePath + CopyResumeDecision.META_SUFFIX)
        val srcSize = src.length()
        val srcMtime = src.lastModified()

        // 断点续传判定：三条都要满足才续，否则从头来。
        //  1. part 文件存在；
        //  2. 旁边的 meta 文件存在，且记的 size/mtime 与**当前**源文件一致
        //     （源变了就不能续，否则拼出来的是个坏文件）；
        //  3. part 不比源文件长（源被截短过也不能续）。
        // 判据在 [CopyResumeDecision] 里——纯逻辑，可以在 JVM 单测里钉住。
        var offset = 0L
        if (resume) {
            offset = CopyResumeDecision.resumeOffset(part, meta, srcSize, srcMtime)
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

        onPrepared()

        // 已经落盘的那一段算作已完成，进度条才是连续的。
        if (offset > 0L) onResume(offset)

        var written = 0L
        try {
            RandomAccessFile(src, "r").use { input ->
                input.seek(offset)
                FileOutputStream(part, offset > 0L).use { out ->
                    val buffer = ByteArray(COPY_BUFFER)
                    while (true) {
                        // 取消要在每个块之间看一眼：文件 IO 本身不响应中断标志，
                        // 不检查就会把整个文件传完才停。
                        if (cancelled()) {
                            throw InterruptedException("复制已取消")
                        }
                        val n = input.read(buffer)
                        if (n <= 0) break
                        out.write(buffer, 0, n)
                        written += n.toLong()
                        onBytes(n.toLong())
                    }
                    out.flush()
                }
            }
        } catch (e: InterruptedException) {
            // 取消：已写的 part 与 meta 都留着，下次能续。
            Thread.currentThread().interrupt()
            throw e
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
        return Outcome(dest = dest, resumedFrom = offset, bytesWritten = written)
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

    /** 写 meta。写不进去也不致命：只是下次不能续传而已。 */
    private fun writeMeta(meta: File, size: Long, mtime: Long) {
        try {
            meta.writeText(CopyResumeDecision.metaText(size, mtime))
        } catch (e: Throwable) {
            // 写不进去也不致命：只是下次不能续传而已。
        }
    }
}
