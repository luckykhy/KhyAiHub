package com.khyos.khy_os_client.vfs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 解压总量闸门（[ArchiveExtractBudget]）的判据测试。
 *
 * 为什么要有这个套件：解压侧原先只有**单条目**上限（512MB），没有整包上限。
 * 一个含 5000 个 400MB 条目的 zip，每一条单独看都过闸，合起来是 2TB——
 * 手机存储被写满，用户丢数据、App 被系统清缓存。条目数也没有上限。
 *
 * 判据抽成纯计数逻辑后，这一层可以在 JVM 上跑，不必再靠真机点菜单。
 *
 * 钉住的不变量：
 *  1. 条目数到上限后不再接受新条目；
 *  2. 累计字节到上限后不再接受新字节；
 *  3. **计数只增不减**——拒绝后来的条目不会把已经花掉的额度退回来，
 *     否则「先写满再把额度改回去」等于闸门失效；
 *  4. 恰好用满上限不算超限（边界是「超过」不是「达到」）。
 */
class ArchiveExtractBudgetTest {

    @Test
    fun `条目数在上限内逐条放行`() {
        val tracker = ArchiveExtractBudget.Tracker(maxEntries = 3, maxTotalBytes = 1_000_000L)
        assertTrue(tracker.acceptEntry())
        assertTrue(tracker.acceptEntry())
        assertTrue(tracker.acceptEntry())
        assertEquals(3, tracker.entries)
        assertEquals(0, tracker.remainingEntries())
        assertFalse(tracker.entriesExceeded)
    }

    @Test
    fun `条目数超过上限后拒绝新条目`() {
        val tracker = ArchiveExtractBudget.Tracker(maxEntries = 2, maxTotalBytes = 1_000_000L)
        assertTrue(tracker.acceptEntry())
        assertTrue(tracker.acceptEntry())
        assertFalse(tracker.acceptEntry())
        assertTrue(tracker.entriesExceeded)
        // 拒绝之后计数不再增长——否则可以靠反复调用把上限撑大。
        assertEquals(2, tracker.entries)
    }

    @Test
    fun `字节累计在上限内逐块放行`() {
        val tracker = ArchiveExtractBudget.Tracker(maxEntries = 10, maxTotalBytes = 1000L)
        assertTrue(tracker.acceptBytes(400L))
        assertTrue(tracker.acceptBytes(600L))
        assertEquals(1000L, tracker.bytes)
        assertEquals(0L, tracker.remainingBytes())
        assertFalse(tracker.bytesExceeded)
    }

    @Test
    fun `字节累计超过上限后拒绝新字节`() {
        val tracker = ArchiveExtractBudget.Tracker(maxEntries = 10, maxTotalBytes = 1000L)
        assertTrue(tracker.acceptBytes(900L))
        assertFalse(tracker.acceptBytes(200L))
        assertTrue(tracker.bytesExceeded)
        assertEquals(900L, tracker.bytes)
    }

    @Test
    fun `恰好用满字节上限不算超限`() {
        val tracker = ArchiveExtractBudget.Tracker(maxEntries = 10, maxTotalBytes = 1000L)
        assertTrue(tracker.acceptBytes(1000L))
        assertFalse(tracker.bytesExceeded)
        assertFalse(tracker.acceptBytes(1L))
        assertTrue(tracker.bytesExceeded)
    }

    @Test
    fun `负数字节被拒且不改变计数`() {
        val tracker = ArchiveExtractBudget.Tracker(maxEntries = 10, maxTotalBytes = 1000L)
        assertFalse(tracker.acceptBytes(-1L))
        assertEquals(0L, tracker.bytes)
    }

    @Test
    fun `拒绝新条目不会退回已经花掉的字节额度`() {
        // 这是最要紧的一条：如果额度能退回去，攻击者可以先写满、
        // 再靠拒绝后续条目把计数改小，闸门就等于没有。
        val tracker = ArchiveExtractBudget.Tracker(maxEntries = 1, maxTotalBytes = 1000L)
        assertTrue(tracker.acceptEntry())
        assertTrue(tracker.acceptBytes(900L))
        assertFalse(tracker.acceptEntry())
        assertEquals(900L, tracker.bytes)
        assertEquals(100L, tracker.remainingBytes())
    }

    @Test
    fun `默认上限是有限值而不是无限`() {
        // 无限就等于没有闸门。这条钉住「上限存在」这个事实本身。
        assertTrue(ArchiveExtractBudget.MAX_ENTRIES in 1..1_000_000)
        assertTrue(ArchiveExtractBudget.MAX_TOTAL_BYTES in 1..(64L * 1024L * 1024L * 1024L))
    }

    @Test
    fun `默认 Tracker 用的就是那两个上限`() {
        val tracker = ArchiveExtractBudget.Tracker()
        assertEquals(ArchiveExtractBudget.MAX_ENTRIES, tracker.remainingEntries())
        assertEquals(ArchiveExtractBudget.MAX_TOTAL_BYTES, tracker.remainingBytes())
    }

    @Test
    fun `超出上限的判断不会因为负剩余量而误放行`() {
        // maxTotalBytes - n 在 n 极大时会为负；这里要保证这种情况下是拒绝，
        // 不是「负数小于上限所以放行」。
        val tracker = ArchiveExtractBudget.Tracker(maxEntries = 10, maxTotalBytes = 1000L)
        assertFalse(tracker.acceptBytes(Long.MAX_VALUE))
        assertTrue(tracker.bytesExceeded)
        assertEquals(0L, tracker.bytes)
    }
}
