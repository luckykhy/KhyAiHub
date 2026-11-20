package com.khyos.khy_os_client.vfs

import java.io.File

/**
 * 断点续传的判定判据。
 *
 * **为什么要抽出来**：[VfsCopier.copyOne] 里那段「能不能接着上次传」的判断
 * 是**纯文件系统 + 纯数值**的事（看 part 与 meta 在不在、meta 记的 size/mtime
 * 与当前源文件一不一致、part 是不是比源文件长），却和真正的 IO 写在一个函数里，
 * 拖进 JVM 单测得连 `Context`、线程池、进度通道一起 stub。
 *
 * 目标 §二 明写「多线程复制/移动，支持断点续传」，而这条能力此前**一行测试都没有**
 * ——只能靠真机点菜单验，而真机随时被锁屏打断。判据抽成纯逻辑，才能被测：
 * **测不了的承诺等于没有**。
 *
 * **三条不变量（单测钉住）**：
 *  1. 源文件变了（size 或 mtime 变了）就**不能续**——续上去会拼出一个坏文件；
 *  2. part 比源文件还长（源被截短了）就**不能续**；
 *  3. meta 读不出来（文件坏了 / 格式不对）就**不能续**——宁可整个重传，
 *     也不拿一个坏文件续上去。
 */
internal object CopyResumeDecision {

    /** part 文件后缀。part 存在 = 这次复制还没完成。 */
    const val PART_SUFFIX = ".khy-part"

    /** part 的元信息后缀：记源文件的 size 与 mtime。 */
    const val META_SUFFIX = ".khy-part.meta"

    /**
     * 判定能不能从 part 接着传。
     *
     * @param part 半成品文件（可能不存在）。
     * @param meta 半成品的元信息文件（可能不存在）。
     * @param srcSize 当前源文件的大小。
     * @param srcMtime 当前源文件的修改时间。
     * @return 可以接着传的字节偏移；不能续时返回 0。
     */
    fun resumeOffset(part: File, meta: File, srcSize: Long, srcMtime: Long): Long {
        if (!part.isFile || !meta.isFile) return 0L
        val recorded = readMeta(meta) ?: return 0L
        // 源变了就不能续：meta 记的是**上一次**那个源的样子。
        if (recorded[0] != srcSize || recorded[1] != srcMtime) return 0L
        val partSize = part.length()
        // part 比源还长：源被截短过了，续上去是错的。
        if (partSize > srcSize) return 0L
        return partSize
    }

    /**
     * 判定一个 part 是否与当前源文件匹配（rename 冲突档用它挑「续哪个」）。
     *
     * 与 [resumeOffset] 的区别：这里**只看 meta**，不看 part 本身——
     * 问的是「这个半成品是不是这个源的那一份」。
     */
    fun metaMatches(part: File, srcSize: Long, srcMtime: Long): Boolean {
        val meta = File(part.absolutePath + META_SUFFIX)
        val recorded = readMeta(meta) ?: return false
        return recorded[0] == srcSize && recorded[1] == srcMtime
    }

    /**
     * 读 meta：记着源文件的 size 与 mtime。
     *
     * 格式：`size=<n>\nmtime=<n>\n`。读不出来（文件坏了 / 格式不对）就当没有。
     *
     * @return `[size, mtime]`；读不出来时返回 null。
     */
    fun readMeta(meta: File): LongArray? {
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

    /**
     * meta 的文本内容（写侧用）。
     *
     * 抽成函数是为了让「写出来的格式」与「读得出来的格式」只有一处定义——
     * 分成两处的话，改了一边就会读不出来，而那种 bug 只在断点续传时才显形。
     */
    fun metaText(size: Long, mtime: Long): String = "size=$size\nmtime=$mtime\n"
}
