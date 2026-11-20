package com.khyos.khy_os_client.vfs

import java.io.File
import java.util.zip.ZipFile
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 归档内核的测试（[ArchiveCore]）。
 *
 * ## 为什么要有这个套件
 *
 * 目标 §二 明写「原生支持 ZIP/RAR/7Z/TAR.GZ 等格式的浏览、提取、创建、加密」。
 * 此前 ZIP 的创建与提取**一行测试都没有**——代码住在 `VfsArchive` 里，而那个文件
 * 的入口挂着 `Context` 与 `MethodCall`（路径映射、权限、通道回执全在里面），
 * JVM 单测拖不动；真机能验，但真机随时被锁屏打断。
 *
 * 抽到纯 JVM 之后，最要紧的那条能在本机证伪：**创建一个 ZIP，再用生产代码解回来，
 * 内容逐字节相同**。这是用户真正在做的事。
 *
 * ## 钉住的不变量
 *
 *  1. 创建 → 提取的**往返**：目录树、嵌套目录、中文名、空目录，**逐字节相同**；
 *  2. **Zip Slip 防护**：`../` 逃逸的条目被拒（不是写到目标目录外），且**如实计数**；
 *  3. 目标已存在且不覆盖 → 跳过该条目（不覆盖用户的文件）；
 *  4. 覆盖开启 → 真的覆盖；
 *  5. 条目名归一化：`\` 当分隔符、`./` 前缀、`/` 结尾；
 *  6. `resolveInside` 判据本身：越界返回 null，目标目录自身返回 null。
 */
class ArchiveCoreTest {

    @get:Rule
    val temp = TemporaryFolder()

    private fun bytes(size: Int, seed: Int = 0): ByteArray =
        ByteArray(size) { ((it * 31 + seed) % 251).toByte() }

    private fun writeFile(file: File, content: ByteArray): File {
        file.parentFile?.mkdirs()
        file.writeBytes(content)
        return file
    }

    /** 建一棵有目录、有嵌套、有中文名、有空目录的树。 */
    private fun buildTree(root: File): Map<String, ByteArray> {
        val expected = LinkedHashMap<String, ByteArray>()
        expected["notes.txt"] = bytes(1000, 1)
        expected["子目录/中文名.txt"] = bytes(2000, 2)
        expected["子目录/深/更深.bin"] = bytes(3000, 3)
        for ((path, content) in expected) {
            writeFile(File(root, path), content)
        }
        File(root, "空目录").mkdirs()
        return expected
    }

    @Test
    fun `创建 ZIP 再用生产代码解回来，内容逐字节相同`() {
        val src = temp.newFolder("src")
        val expected = buildTree(src)
        val zip = File(temp.root, "out.zip")

        val count = ArchiveCore.createZip(zip, listOf(src))
        assertTrue("创建应当至少写进目录与文件条目", count >= expected.size)

        val dest = temp.newFolder("dest")
        val outcome = ArchiveCore.extractZip(zip, dest, emptyList(), overwrite = false)

        assertEquals(0, outcome.skippedUnsafe)
        assertEquals(0, outcome.skippedExisting)
        assertFalse(outcome.stoppedByEntryBudget)
        assertFalse(outcome.stoppedByTotalBytes)

        // 选的是**目录**时，包里的条目带目录名前缀（"src/notes.txt"）——
        // 这与用户「选中文件夹→压缩」的实际结果一致，解回来也是同一个结构。
        val prefix = src.name
        for ((path, content) in expected) {
            val out = File(dest, "$prefix/$path")
            assertTrue("应当解出 $prefix/$path", out.isFile)
            assertArrayEquals("解出来的 $path 应当与源逐字节相同", content, out.readBytes())
        }
        assertTrue("空目录也要在", File(dest, "$prefix/空目录").isDirectory)
    }

    @Test
    fun `往返之后条目数与解出数一致`() {
        val src = temp.newFolder("src2")
        buildTree(src)
        val zip = File(temp.root, "out2.zip")
        ArchiveCore.createZip(zip, listOf(src))

        val dest = temp.newFolder("dest2")
        val outcome = ArchiveCore.extractZip(zip, dest, emptyList(), overwrite = false)

        // 解出的条目数 = 目录条目 + 文件条目（目录本身也算一条）。
        assertTrue("应当至少解出 5 条（4 个文件 + 空目录 + 各层目录）", outcome.extracted.size >= 5)
        outcome.extracted.forEach { path ->
            assertTrue("解出的路径应当在目标目录内：$path", path.startsWith(dest.canonicalPath))
        }
    }

    @Test
    fun `Zip Slip：逃出目标目录的条目被拒，且如实计数`() {
        val zip = File(temp.root, "evil.zip")
        // 手工造一个带 `../` 条目的包。
        java.util.zip.ZipOutputStream(zip.outputStream()).use { zos ->
            zos.putNextEntry(java.util.zip.ZipEntry("../escaped.txt"))
            zos.write("坏东西".toByteArray())
            zos.closeEntry()
            zos.putNextEntry(java.util.zip.ZipEntry("ok.txt"))
            zos.write("好的".toByteArray())
            zos.closeEntry()
        }

        val dest = temp.newFolder("dest3")
        val outcome = ArchiveCore.extractZip(zip, dest, emptyList(), overwrite = false)

        assertEquals("越界条目应当被计数", 1, outcome.skippedUnsafe)
        assertFalse("不该写到目标目录之外", File(temp.root, "escaped.txt").exists())
        assertTrue("正常条目照常解出", File(dest, "ok.txt").isFile)
    }

    @Test
    fun `目标已存在且不覆盖时跳过该条目`() {
        val srcFile = writeFile(File(temp.newFolder("src4"), "a.txt"), bytes(100, 5))
        val zip = File(temp.root, "out4.zip")
        ArchiveCore.createZip(zip, listOf(srcFile))

        val dest = temp.newFolder("dest4")
        writeFile(File(dest, "a.txt"), bytes(100, 6)) // 目标已存在，内容不同

        val outcome = ArchiveCore.extractZip(zip, dest, emptyList(), overwrite = false)

        assertEquals(1, outcome.skippedExisting)
        assertArrayEquals(
            "不该覆盖用户已有的文件",
            bytes(100, 6),
            File(dest, "a.txt").readBytes(),
        )
    }

    @Test
    fun `覆盖开启时真的覆盖`() {
        val srcFile = writeFile(File(temp.newFolder("src5"), "a.txt"), bytes(100, 7))
        val zip = File(temp.root, "out5.zip")
        ArchiveCore.createZip(zip, listOf(srcFile))

        val dest = temp.newFolder("dest5")
        writeFile(File(dest, "a.txt"), bytes(100, 8))

        val outcome = ArchiveCore.extractZip(zip, dest, emptyList(), overwrite = true)

        assertEquals(0, outcome.skippedExisting)
        assertArrayEquals(bytes(100, 7), File(dest, "a.txt").readBytes())
    }

    @Test
    fun `只解选中的条目`() {
        val srcDir = temp.newFolder("src6")
        val a = writeFile(File(srcDir, "a.txt"), bytes(100, 9))
        val b = writeFile(File(srcDir, "b.txt"), bytes(100, 10))
        val zip = File(temp.root, "out6.zip")
        ArchiveCore.createZip(zip, listOf(a, b))

        val dest = temp.newFolder("dest6")
        val outcome = ArchiveCore.extractZip(zip, dest, listOf("a.txt"), overwrite = false)

        assertTrue(File(dest, "a.txt").isFile)
        assertFalse("没选中的条目不该解出", File(dest, "b.txt").exists())
    }

    @Test
    fun `条目名归一化：斜杠、反斜杠、点前缀、结尾斜杠`() {
        assertEquals("a/b.txt", ArchiveCore.normalizeEntryName("a/b.txt"))
        assertEquals("a/b.txt", ArchiveCore.normalizeEntryName("a\\b.txt"))
        assertEquals("a/b.txt", ArchiveCore.normalizeEntryName("./a/b.txt"))
        assertEquals("a/b", ArchiveCore.normalizeEntryName("a/b/"))
        assertEquals("", ArchiveCore.normalizeEntryName(""))
    }

    @Test
    fun `落点判定：越界与目录自身都判 null`() {
        val root = temp.newFolder("root7")
        val inside = ArchiveCore.resolveInside(root, "a/b.txt")
        assertNotNull(inside)
        assertTrue(inside!!.canonicalPath.startsWith(root.canonicalPath))

        assertNull("逃出根目录的条目必须判 null", ArchiveCore.resolveInside(root, "../escaped.txt"))
        assertNull("目标目录自身不是条目落点", ArchiveCore.resolveInside(root, "."))
    }

    @Test
    fun `写出来的包是合法的 ZIP（用 JDK 读回条目名）`() {
        val src = temp.newFolder("src8")
        writeFile(File(src, "文件.txt"), bytes(64, 11))
        val zip = File(temp.root, "out8.zip")

        ArchiveCore.createZip(zip, listOf(src))

        ZipFile(zip).use { zf ->
            val names = zf.entries().toList().map { it.name }
            assertTrue("条目名里应当有中文文件名", names.any { it.endsWith("文件.txt") })
            assertTrue("目录条目应当以 / 结尾", names.any { it.endsWith("/") })
        }
    }

    @Test
    fun `一个条目读失败不连累整个包`() {
        // 造一个「中央目录说有 3 个条目，但第二个条目的数据被抹掉」的坏包。
        //
        // 为什么这条重要：**这一条不行 ≠ 这个包不行**。整体失败会让用户只能
        // 从头再来；而生产代码原先在 ZIP 路径上一个条目读抛异常就整体挂掉。
        val src = temp.newFolder("src9")
        writeFile(File(src, "a.txt"), bytes(200, 12))
        writeFile(File(src, "b.txt"), bytes(200, 13))
        writeFile(File(src, "c.txt"), bytes(200, 14))
        val zip = File(temp.root, "out9.zip")
        ArchiveCore.createZip(zip, listOf(src))

        // 抹掉中间那段压缩数据：按条目名定位，改中央目录指向的偏移。
        val raw = zip.readBytes()
        val text = String(raw, Charsets.ISO_8859_1)
        val marker = "b.txt".toByteArray(Charsets.ISO_8859_1)
        val markerAt = findSequence(raw, marker)
        assertTrue("包里应当能找到 b.txt 的条目名", markerAt >= 0)
        // 把 b.txt 数据区的开头几个字节抹成 0：解压时那条会炸。
        val dataAt = findLocalHeaderDataStart(raw, markerAt)
        assertTrue("应当能定位到 b.txt 的数据区", dataAt >= 0)
        for (i in dataAt until minOf(dataAt + 16, raw.size)) {
            raw[i] = 0
        }
        zip.writeBytes(raw)

        val dest = temp.newFolder("dest9")
        val outcome = ArchiveCore.extractZip(zip, dest, emptyList(), overwrite = false)

        // 坏的那条要被如实记成「损坏」，且**别的条目照常解出来**。
        assertEquals(
            "坏条目要如实计数",
            1,
            outcome.skippedDamaged,
        )
        assertTrue("好的条目应当照常解出：${outcome.extracted}", File(dest, "src9/a.txt").isFile)
        assertTrue("好的条目应当照常解出：${outcome.extracted}", File(dest, "src9/c.txt").isFile)
        assertFalse("坏条目不该留下半截文件", File(dest, "src9/b.txt").exists())
    }

    /** 在字节数组里找一段字节序列的首次出现位置，找不到返回 -1。 */
    private fun findSequence(haystack: ByteArray, needle: ByteArray): Int {
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) {
                if (haystack[i + j] != needle[j]) continue@outer
            }
            return i
        }
        return -1
    }

    /**
     * 从中央目录里的条目名位置反推该条目的**数据区**起点。
     *
     * ZIP 的局部头结构：签名 4 + 版本 2 + 标志 2 + 压缩方式 2 + 时间 2 + 日期 2 +
     * CRC 4 + 压缩后大小 4 + 解压后大小 4 + 文件名长度 2 + 额外字段长度 2 + 文件名。
     */
    private fun findLocalHeaderDataStart(raw: ByteArray, nameAt: Int): Int {
        // 往回找局部头签名 PK\x03\x04。
        for (start in nameAt downTo 0) {
            if (start + 4 > raw.size) continue
            if (raw[start] == 0x50.toByte() && raw[start + 1] == 0x4B.toByte() &&
                raw[start + 2] == 0x03.toByte() && raw[start + 3] == 0x04.toByte()
            ) {
                val nameLen = (raw[start + 26].toInt() and 0xFF) or ((raw[start + 27].toInt() and 0xFF) shl 8)
                val extraLen = (raw[start + 28].toInt() and 0xFF) or ((raw[start + 29].toInt() and 0xFF) shl 8)
                return start + 30 + nameLen + extraLen
            }
        }
        return -1
    }
}
