package com.khyos.khy_os_client.vfs

/**
 * 解压总量闸门（一个归档包能往磁盘上写多少东西）。
 *
 * **为什么已经有单条目上限还不够**：[VfsArchive] 里每条目有 512MB 的闸
 * （`MAX_ENTRY_BYTES`），但「每条都合规」不等于「整个包合规」：
 * 一个含 5000 个 400MB 条目的 zip，每一条都过单条目闸，合起来却是 2TB——
 * 手机存储直接写满，用户丢数据、App 被系统清缓存。条目数也没有上限，
 * 一个几 MB 的包塞 10 万个空目录能拖垮解压循环本身。
 *
 * 所以这里补的是**总量**这一维：条目数上限 + 累计解压字节上限。
 *
 * 为什么单独成 object 而不是塞在 [VfsArchive] 里：这一段是**纯计数**，
 * 不碰任何 Android API，可以直接在 JVM 单元测试里跑（[VfsArchive] 整体
 * 依赖 `Context` 与 `MethodCall`，拖进单测得 stub 一堆东西）。
 * 判据抽成纯逻辑，才能被测——测不了的安全承诺等于没有。
 *
 * 三条不变量（单测钉住）：
 *  1. 条目数超过上限后不再接受新条目（`acceptEntry` 返回 false）；
 *  2. 累计字节超过上限后不再接受新字节（`acceptBytes` 返回 false）；
 *  3. **计数只增不减**：已经写出去的钱不能因为后来的条目被拒而「退回来」，
 *     否则一个包可以先写满再把额度改回去，等于闸门失效。
 */
internal object ArchiveExtractBudget {

    /**
     * 一个归档包内条目数上限：20000 条。
     *
     * 为什么是 2 万：正常包里一个条目平均几十字节到几 MB，2 万条对应
     * 几十 GB 的内容，已经超出手机上任何一个归档包的正常规模。而 10 万条
     * 空条目那种包，除了拖慢解压没有任何别的意义。
     */
    const val MAX_ENTRIES = 20_000

    /**
     * 一个归档包解压后总字节上限：8GB。
     *
     * 为什么是 8GB 而不是更小：这台设备可能有几百 GB 存储，用户解压一个
     * 「里面装着几个大视频的合集」是合理诉求，闸门不该把这种正常包拦掉。
     * 8GB 已远大于绝大多数归档包的实际内容，同时又保证「一个包写不爆存储」。
     *
     * 为什么不是无限：无限就等于没有闸门——攻击者只需要构造一个包就能写满
     * 用户存储，这正是压缩炸弹攻击的目的。
     */
    const val MAX_TOTAL_BYTES = 8L * 1024L * 1024L * 1024L

    /**
     * 逐条目记账的闸门。
     *
     * 用法：解包循环里每遇到一个条目先 `acceptEntry()`，每写下一批字节先
     * `acceptBytes(n)`；任一返回 false 就跳过该条目（并在 message 里如实
     * 报告跳过了几个），而不是让整个解包崩掉。
     */
    class Tracker(
        /** 条目数上限。测试可传更小的值来触发边界。 */
        private val maxEntries: Int = MAX_ENTRIES,
        /** 总字节上限。测试可传更小的值来触发边界。 */
        private val maxTotalBytes: Long = MAX_TOTAL_BYTES,
    ) {
        /** 已接受的条目数。 */
        var entries: Int = 0
            private set

        /** 已接受的累计字节数。 */
        var bytes: Long = 0L
            private set

        /** 是否已经因为条目数超限而拒绝过新条目。 */
        var entriesExceeded: Boolean = false
            private set

        /** 是否已经因为总字节超限而拒绝过新字节。 */
        var bytesExceeded: Boolean = false
            private set

        /**
         * 问能不能再接受一个条目。
         *
         * @return true 表示可以（并已计数）；false 表示条目数已超上限。
         */
        fun acceptEntry(): Boolean {
            if (entries >= maxEntries) {
                entriesExceeded = true
                return false
            }
            entries += 1
            return true
        }

        /**
         * 问能不能再接受这么多字节。
         *
         * @param n 本次要写入的字节数（必须 >= 0）。
         * @return true 表示可以（并已计数）；false 表示累计会超上限。
         */
        fun acceptBytes(n: Long): Boolean {
            if (n < 0) return false
            if (bytes > maxTotalBytes - n) {
                bytesExceeded = true
                return false
            }
            bytes += n
            return true
        }

        /** 剩余可用字节。 */
        fun remainingBytes(): Long = maxTotalBytes - bytes

        /** 剩余可用条目数。 */
        fun remainingEntries(): Int = maxEntries - entries
    }
}
