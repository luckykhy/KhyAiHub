package com.khyos.khy_os_client.vfs

import java.io.File
import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 字节级拷贝 + 断点续传的测试（[ResumeCopy]）。
 *
 * ## 为什么要有这个套件
 *
 * 目标 §二 明写「多线程复制/移动，支持断点续传」。此前这条能力**只有判据被测过**
 * （[CopyResumeDecisionTest]：「能不能续」），但「续上去之后的文件是不是**逐字节
 * 等于**源」**一行测试都没有**。判据对而字节错，是最坏的一种状态：界面显示「已续传」，
 * 文件是坏的。
 *
 * 抽到纯 JVM 之后，字节这件事本身可以在临时目录里验——**不需要设备**。
 *
 * ## 钉住的不变量
 *
 *  1. 完整拷贝后，目标与源**逐字节相同**；
 *  2. 续传后，目标与源**逐字节相同**（且只补写剩下的那段）；
 *  3. 中断时 part 与 meta **留着**，下一次能接着来，最终仍然逐字节相同；
 *  4. 源变了 / part 比源长 → **不续**，从头来，结果仍是**源的**字节（不是拼出来的）；
 *  5. 目标是已存在的目录 → **报错**，且**不删**用户的目录树；
 *  6. 续传标记用完即清：part 与 meta 都不该留在目标旁边。
 */
class ResumeCopyTest {

    @get:Rule
    val temp = TemporaryFolder()

    /** 源文件内容：用不重复的字节，能看出「哪一段被写错了」。 */
    private fun sourceBytes(size: Int): ByteArray =
        ByteArray(size) { ((it * 31 + 7) % 251).toByte() }

    private fun sourceFile(name: String = "src.bin", size: Int = 4096): File {
        val src = temp.newFile(name)
        src.writeBytes(sourceBytes(size))
        return src
    }

    private fun destFile(name: String = "dst.bin"): File = File(temp.root, name)

    private fun partOf(dest: File): File =
        File(dest.absolutePath + CopyResumeDecision.PART_SUFFIX)

    private fun metaOf(dest: File): File =
        File(dest.absolutePath + CopyResumeDecision.META_SUFFIX)

    /** 造一个「上次传到一半」的现场：part 是源的前 n 字节，meta 记着源的样子。 */
    private fun preparePartial(dest: File, src: File, n: Int) {
        partOf(dest).writeBytes(src.readBytes().copyOf(n))
        metaOf(dest).writeText(
            CopyResumeDecision.metaText(src.length(), src.lastModified()),
        )
    }

    @Test
    fun `完整拷贝后目标与源逐字节相同`() {
        val src = sourceFile(size = 5000)
        val dest = destFile()

        val outcome = ResumeCopy.copy(src, dest)

        assertArrayEquals(src.readBytes(), dest.readBytes())
        assertEquals(0L, outcome.resumedFrom)
        assertEquals(5000L, outcome.bytesWritten)
    }

    @Test
    fun `续传后目标与源逐字节相同，且只补写剩下的那段`() {
        val src = sourceFile(size = 5000)
        val dest = destFile()
        preparePartial(dest, src, 2000)

        var resumedFrom = -1L
        var written = 0L
        val outcome = ResumeCopy.copy(
            src = src,
            dest = dest,
            onResume = { resumedFrom = it },
            onBytes = { written += it },
        )

        assertArrayEquals(src.readBytes(), dest.readBytes())
        assertEquals(2000L, resumedFrom)
        assertEquals(2000L, outcome.resumedFrom)
        assertEquals(3000L, outcome.bytesWritten)
        assertEquals(3000L, written)
    }

    @Test
    fun `中断时 part 与 meta 留着，下次接着来，最终逐字节相同`() {
        // 源要**比单次读写缓冲大**，否则一次就读完了，中断时 part 会是整份——
        // 那样测的就不是「半成品续传」，而是「拿完整 part 改名」。
        val src = sourceFile(size = 200_000)
        val dest = destFile()

        // 第一次：写到一块就取消。
        var calls = 0
        try {
            ResumeCopy.copy(
                src = src,
                dest = dest,
                cancelled = {
                    calls++
                    // 第一块写完就取消：模拟「传了一会儿被用户按停」。
                    calls > 1
                },
            )
            fail("被取消时应当抛出 InterruptedException")
        } catch (e: InterruptedException) {
            // 预期：取消是正常的，不是错误。
        }
        // 线程的中断标志是 InterruptedException 的约定，测试线程里要清掉，
        // 否则后面的断言会带着中断状态跑。
        Thread.interrupted()

        assertTrue("中断后 part 必须留着——下次要靠它接着来", partOf(dest).isFile)
        assertTrue("中断后 meta 必须留着——没有它就判定「不能续」", metaOf(dest).isFile)
        assertTrue(
            "part 必须是**残缺**的：传完了就不叫断点续传了",
            partOf(dest).length() < src.length(),
        )
        assertFalse("中断时正式目标还不该出现", dest.exists())

        // 第二次：接着来。
        val outcome = ResumeCopy.copy(src, dest)

        assertArrayEquals(src.readBytes(), dest.readBytes())
        assertTrue("第二次应当是续传，不是从头来", outcome.resumedFrom > 0)
        assertEquals(src.length() - outcome.resumedFrom, outcome.bytesWritten)
    }

    @Test
    fun `源变了就不续，从头来，结果仍是源当前的字节`() {
        val src = sourceFile(name = "src.bin", size = 4000)
        val dest = destFile()
        // 上次的半成品记的是**另一个**源的样子（大小对不上）。
        partOf(dest).writeBytes(ByteArray(1000) { 0x7F })
        metaOf(dest).writeText(CopyResumeDecision.metaText(9999L, src.lastModified()))

        var resumedFrom = -1L
        val outcome = ResumeCopy.copy(src = src, dest = dest, onResume = { resumedFrom = it })

        assertArrayEquals(
            "不能续时必须从头拷，否则拼出来的是个坏文件",
            src.readBytes(),
            dest.readBytes(),
        )
        assertEquals("源变了就不该有续传起点", -1L, resumedFrom)
        assertEquals(0L, outcome.resumedFrom)
    }

    @Test
    fun `part 比源还长就不续`() {
        val src = sourceFile(size = 1000)
        val dest = destFile()
        // part 比源长：源被截短过了，续上去是错的。
        partOf(dest).writeBytes(ByteArray(5000) { 0x11 })
        metaOf(dest).writeText(
            CopyResumeDecision.metaText(src.length(), src.lastModified()),
        )

        val outcome = ResumeCopy.copy(src, dest)

        assertArrayEquals(src.readBytes(), dest.readBytes())
        assertEquals(0L, outcome.resumedFrom)
    }

    @Test
    fun `目标是已存在的目录时报错，且不删用户的目录树`() {
        val src = sourceFile()
        val destDir = temp.newFolder("target-dir")

        try {
            ResumeCopy.copy(src, destDir)
            fail("目标是目录时应当报错")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("目录"))
        }
        assertTrue("复制不该顺手删掉用户的一个目录", destDir.isDirectory)
    }

    @Test
    fun `目标父目录不存在时自动建出来`() {
        val src = sourceFile()
        val dest = File(temp.root, "a/b/c/dst.bin")

        ResumeCopy.copy(src, dest)

        assertArrayEquals(src.readBytes(), dest.readBytes())
    }

    @Test
    fun `关掉续传时即使有 part 也从头来`() {
        val src = sourceFile(size = 3000)
        val dest = destFile()
        preparePartial(dest, src, 1000)

        val outcome = ResumeCopy.copy(src, dest, resume = false)

        assertArrayEquals(src.readBytes(), dest.readBytes())
        assertEquals(0L, outcome.resumedFrom)
    }

    @Test
    fun `传完不留 part 与 meta`() {
        val src = sourceFile()
        val dest = destFile()

        ResumeCopy.copy(src, dest)

        assertFalse("part 是「未完成」的标记，传完就该没有", partOf(dest).exists())
        assertFalse("meta 传完就该删——留着会让下次误判", metaOf(dest).exists())
    }
}
