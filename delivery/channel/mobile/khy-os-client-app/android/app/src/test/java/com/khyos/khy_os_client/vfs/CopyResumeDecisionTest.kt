package com.khyos.khy_os_client.vfs

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 断点续传判定判据的测试（[CopyResumeDecision]）。
 *
 * 为什么要有这个套件：目标 §二 明写「多线程复制/移动，支持断点续传」，而这条
 * 能力此前**一行测试都没有**——判据和真正的 IO 写混在一个要 `Context` 的函数里，
 * 只能靠真机点菜单验，而真机随时被锁屏打断。
 *
 * 钉住的不变量：
 *  1. 源文件变了（size 或 mtime 变了）就**不能续**；
 *  2. part 比源文件还长就**不能续**；
 *  3. meta 读不出来（坏了 / 格式不对）就**不能续**；
 *  4. 三条都满足时，续传偏移**等于 part 的长度**（不是 0，也不是别的）。
 */
class CopyResumeDecisionTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val srcSize = 1000L
    private val srcMtime = 1_700_000_000_000L

    private fun partFile(bytes: Int): File {
        val part = temp.newFile("dst.khy-part")
        part.writeBytes(ByteArray(bytes) { (it % 251).toByte() })
        return part
    }

    private fun metaFile(size: Long = srcSize, mtime: Long = srcMtime): File {
        val meta = temp.newFile("dst.khy-part.meta")
        meta.writeText(CopyResumeDecision.metaText(size, mtime))
        return meta
    }

    @Test
    fun `一切吻合时从 part 的长度接着传`() {
        val part = partFile(400)
        val meta = metaFile()
        val offset = CopyResumeDecision.resumeOffset(part, meta, srcSize, srcMtime)
        assertEquals(400L, offset)
    }

    @Test
    fun `part 不存在时不续`() {
        val meta = metaFile()
        val part = File(temp.root, "missing.khy-part")
        assertEquals(0L, CopyResumeDecision.resumeOffset(part, meta, srcSize, srcMtime))
    }

    @Test
    fun `meta 不存在时不续`() {
        val part = partFile(400)
        val meta = File(temp.root, "missing.khy-part.meta")
        assertEquals(0L, CopyResumeDecision.resumeOffset(part, meta, srcSize, srcMtime))
    }

    @Test
    fun `源文件大小变了就不续`() {
        // 源变了还续，续出来的是个坏文件——这条比「续传能省时间」重要得多。
        val part = partFile(400)
        val meta = metaFile(size = srcSize)
        assertEquals(0L, CopyResumeDecision.resumeOffset(part, meta, 999L, srcMtime))
    }

    @Test
    fun `源文件修改时间变了就不续`() {
        // 大小一样但内容换了（改了个字节），照样不能续。
        val part = partFile(400)
        val meta = metaFile()
        assertEquals(0L, CopyResumeDecision.resumeOffset(part, meta, srcSize, srcMtime + 1))
    }

    @Test
    fun `part 比源文件还长时不续`() {
        // 源被截短过了：part 里的后半截是旧内容，续上去是错的。
        val part = partFile(2000)
        val meta = metaFile(size = srcSize)
        assertEquals(0L, CopyResumeDecision.resumeOffset(part, meta, srcSize, srcMtime))
    }

    @Test
    fun `meta 内容坏了时不续`() {
        val part = partFile(400)
        val meta = temp.newFile("broken.khy-part.meta")
        meta.writeText("这不是 meta\n")
        assertEquals(0L, CopyResumeDecision.resumeOffset(part, meta, srcSize, srcMtime))
    }

    @Test
    fun `meta 缺字段时不续`() {
        val part = partFile(400)
        val meta = temp.newFile("partial.khy-part.meta")
        meta.writeText("size=$srcSize\n")  // 少了 mtime
        assertEquals(0L, CopyResumeDecision.resumeOffset(part, meta, srcSize, srcMtime))
    }

    @Test
    fun `meta 里的数字不是数字时不续`() {
        val part = partFile(400)
        val meta = temp.newFile("garbage.khy-part.meta")
        meta.writeText("size=abc\nmtime=def\n")
        assertEquals(0L, CopyResumeDecision.resumeOffset(part, meta, srcSize, srcMtime))
    }

    @Test
    fun `空 part 续传偏移是零（等于从头传，但不算「不能续」）`() {
        // 空 part 是合法的「刚开始就断了」：偏移 0，语义上从头来。
        val part = partFile(0)
        val meta = metaFile()
        assertEquals(0L, CopyResumeDecision.resumeOffset(part, meta, srcSize, srcMtime))
    }

    @Test
    fun `读 meta 拿到 size 与 mtime`() {
        val meta = metaFile(size = 123L, mtime = 456L)
        val recorded = CopyResumeDecision.readMeta(meta)
        assertEquals(123L, recorded!![0])
        assertEquals(456L, recorded[1])
    }

    @Test
    fun `读不存在的 meta 返回 null`() {
        assertNull(CopyResumeDecision.readMeta(File(temp.root, "nope.meta")))
    }

    @Test
    fun `metaMatches 看的是 meta 而不是 part 本身`() {
        // 注意 part 的文件名：meta 的路径是「part 的路径 + META_SUFFIX」，
        // 所以这里 part 叫 `dst`（不是 `dst.khy-part`），meta 才落在
        // `dst.khy-part.meta` 上——与 [resumeOffset] 那几例的落法一致。
        val part = temp.newFile("dst")
        part.writeBytes(ByteArray(400))
        val meta = temp.newFile("dst${CopyResumeDecision.META_SUFFIX}")
        meta.writeText(CopyResumeDecision.metaText(srcSize, srcMtime))
        // meta 记的与源一致 → 匹配。
        assertTrue(CopyResumeDecision.metaMatches(part, srcSize, srcMtime))
        // 源变了 → 不匹配。
        assertFalse(CopyResumeDecision.metaMatches(part, srcSize, srcMtime + 1))
        assertFalse(CopyResumeDecision.metaMatches(part, srcSize + 1, srcMtime))
    }

    @Test
    fun `写出来的 meta 读得回来`() {
        // 「写出来的格式」与「读得出来的格式」只有一处定义：metaText / readMeta。
        val meta = temp.newFile("roundtrip.meta")
        meta.writeText(CopyResumeDecision.metaText(999L, 888L))
        val recorded = CopyResumeDecision.readMeta(meta)
        assertEquals(999L, recorded!![0])
        assertEquals(888L, recorded[1])
    }
}
