package com.khyos.khy_os_client.vfs

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 移动收尾（删搬空了的源目录）的回归测试。
 *
 * 为什么这条语义要测：移动是「搬走 + 删源」两件事。删源删过头就是丢用户数据，
 * 删不到位就是「移动完源还在原地，用户以为没移动」。
 *
 * 关键边界是**只删空目录**：
 *  - 被冲突策略跳过的源文件（目标已存在）没有被搬走，它还在目录里，
 *    那个目录就不是空的 → 不能删 → 源文件安全地留在原地；
 *  - 搬空了的目录留着是垃圾 → 该删。
 *
 * 这两种情况在界面上长得几乎一样（都是「移动完成」），只有文件系统里的
 * 结果不同。所以判据必须被测，不能靠人记。
 */
class MoveCleanupTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `搬空了的目录被删掉`() {
        val src = temp.newFolder("src")
        File(src, "a.txt").writeText("x")
        File(src, "a.txt").delete()
        MoveCleanup.pruneEmptyDirs(src)
        assertFalse(src.exists())
    }

    @Test
    fun `还有文件的目录留着`() {
        val src = temp.newFolder("src")
        File(src, "a.txt").writeText("x")
        MoveCleanup.pruneEmptyDirs(src)
        assertTrue("没被搬走的文件不能被删掉", src.exists())
        assertTrue(File(src, "a.txt").exists())
    }

    @Test
    fun `空的子目录连同上级一起清掉`() {
        val src = temp.newFolder("src")
        File(src, "sub").mkdirs()
        MoveCleanup.pruneEmptyDirs(src)
        assertFalse(src.exists())
    }

    @Test
    fun `子目录里还有东西时整条链都留着`() {
        val src = temp.newFolder("src")
        val sub = File(src, "sub")
        sub.mkdirs()
        File(sub, "keep.txt").writeText("keep")
        MoveCleanup.pruneEmptyDirs(src)
        assertTrue(src.exists())
        assertTrue(sub.exists())
        assertTrue(File(sub, "keep.txt").exists())
    }

    @Test
    fun `文件不是目录时原样不动`() {
        val file = temp.newFile("plain.txt")
        MoveCleanup.pruneEmptyDirs(file)
        assertTrue(file.exists())
    }
}
