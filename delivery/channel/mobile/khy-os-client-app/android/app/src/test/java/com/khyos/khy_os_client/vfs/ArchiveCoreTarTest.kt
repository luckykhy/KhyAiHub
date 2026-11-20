package com.khyos.khy_os_client.vfs

import java.io.File
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.util.zip.GZIPOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * TAR.GZ 格式层的测试（[ArchiveCore] 的 tar 部分）。
 *
 * ## 为什么要有这个套件
 *
 * 目标 §二 明写「原生支持 ZIP/RAR/7Z/TAR.GZ 等格式的浏览、提取、创建」。ZIP 那一半在
 * `ArchiveCoreTest` 里已经钉住；tar 这一半此前**一行测试都没有**——它住在
 * `VfsArchive` 里，与 Android 入口缠在一起。
 *
 * tar 比 zip 更需要测：**tar 头里的 size 字段是归档作者自己写的，可以随便填**。
 * 填一个很小的 size、实际塞很多数据进去，朴素实现会被「读满 size 就当读完」骗过去，
 * 后面的数据被当成下一个条目的头去解析——轻则乱码报错，重则把别的内容写进当前文件。
 *
 * ## 钉住的不变量
 *
 *  1. 创建 → 提取的**往返**：目录树、嵌套目录、中文名、空目录，**逐字节相同**；
 *  2. **长文件名**（> 100 字节，走 GNU 'L' 扩展）往返后名字正确；
 *  3. **size 字段撒谎**：按声明的 size 写，不按实际数据量写；数据被截断时
 *     **不留半截文件**（半截文件比什么都不写更糟）；
 *  4. **Zip Slip 防护**在 tar 路径同样生效：越界条目被拒并如实计数；
 *  5. 已存在不覆盖 / 覆盖开启 / 只解选中项，三种策略在 tar 路径同样成立。
 */
class ArchiveCoreTarTest {

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
    fun `创建 TARGZ 再用生产代码解回来，内容逐字节相同`() {
        val src = temp.newFolder("src")
        val expected = buildTree(src)
        val tar = File(temp.root, "out.tar.gz")

        val count = ArchiveCore.createTarGz(tar, listOf(src))
        assertTrue("创建应当至少写进目录与文件条目", count >= expected.size)

        val dest = temp.newFolder("dest")
        val outcome = ArchiveCore.extractTarGz(tar, dest, emptyList(), overwrite = false)

        assertEquals(0, outcome.skippedUnsafe)
        assertEquals(0, outcome.skippedExisting)
        assertFalse(outcome.stoppedByEntryBudget)
        assertFalse(outcome.stoppedByTotalBytes)

        // 选的是**目录**时，条目带目录名前缀（"src/notes.txt"）——
        // 与用户「选中文件夹→压缩」的实际结果一致。
        val prefix = src.name
        for ((path, content) in expected) {
            val out = File(dest, "$prefix/$path")
            assertTrue("应当解出 $prefix/$path", out.isFile)
            assertArrayEquals("解出来的 $path 应当与源逐字节相同", content, out.readBytes())
        }
        assertTrue("空目录也要在", File(dest, "$prefix/空目录").isDirectory)
    }

    @Test
    fun `超过 100 字节的长文件名走 GNU 扩展，往返后名字正确`() {
        val src = temp.newFolder("srcLong")
        val longName = "很长的名字".repeat(20) + ".txt" // 远大于 100 字节
        writeFile(File(src, longName), bytes(500, 4))
        val tar = File(temp.root, "outLong.tar.gz")

        ArchiveCore.createTarGz(tar, listOf(src))

        val dest = temp.newFolder("destLong")
        val outcome = ArchiveCore.extractTarGz(tar, dest, emptyList(), overwrite = false)

        val extracted = File(dest, "${src.name}/$longName")
        assertTrue("长名字应当被正确解出", extracted.isFile)
        assertArrayEquals(bytes(500, 4), extracted.readBytes())
        assertEquals(0, outcome.skippedUnsafe)
    }

    @Test
    fun `数据被截断时不留半截文件`() {
        // 手工造一个包：头里声明 size=100，但**流在数据中途就结束了**。
        //
        // 注意这里不能沿用 writeHandMadeTar 的补齐逻辑：tar 的数据区按 512
        // 补齐，读满声明的 size 照样能读到（读到的是填充零）——那不叫截断，
        // 那叫「size 字段撒谎」。真截断是**流本身没了**。
        val tar = File(temp.root, "truncated.tar.gz")
        writeTruncatedTar(tar, TarEntrySpec("cut.txt", declaredSize = 100L, payload = bytes(10, 5)))

        val dest = temp.newFolder("destTrunc")
        val outcome = ArchiveCore.extractTarGz(tar, dest, emptyList(), overwrite = false)

        assertFalse(
            "数据不够就不该留下半截文件——半截文件比什么都不写更糟",
            File(dest, "cut.txt").exists(),
        )
        assertEquals("截断的条目应当被如实记成「已损坏」", 1, outcome.skippedDamaged)
        assertEquals("截断不是「太大」，不该混进那个计数", 0, outcome.skippedTooLarge)
    }

    @Test
    fun `size 字段撒谎时按声明的 size 写，不按实际数据量写`() {
        // 头里声明 size=10，实际塞 100 字节。
        // 提取必须只写出声明的那 10 字节——多写就是「把没声明的数据塞给用户」。
        val tar = File(temp.root, "liar.tar.gz")
        writeHandMadeTar(tar, listOf(TarEntrySpec("lie.txt", declaredSize = 10L, payload = bytes(100, 6))))

        val dest = temp.newFolder("destLiar")
        ArchiveCore.extractTarGz(tar, dest, emptyList(), overwrite = false)

        val out = File(dest, "lie.txt")
        if (out.exists()) {
            assertEquals("只应当写出声明的 10 字节", 10L, out.length())
        }
    }

    @Test
    fun `Zip Slip 在 tar 路径同样生效`() {
        val tar = File(temp.root, "evil.tar.gz")
        writeHandMadeTar(
            tar,
            listOf(
                TarEntrySpec("../escaped.txt", declaredSize = 6L, payload = "坏东西".toByteArray()),
                TarEntrySpec("ok.txt", declaredSize = 6L, payload = "好的".toByteArray()),
            ),
        )

        val dest = temp.newFolder("destEvil")
        val outcome = ArchiveCore.extractTarGz(tar, dest, emptyList(), overwrite = false)

        assertEquals("越界条目应当被计数", 1, outcome.skippedUnsafe)
        assertFalse("不该写到目标目录之外", File(temp.root, "escaped.txt").exists())
        assertTrue("正常条目照常解出", File(dest, "ok.txt").isFile)
    }

    @Test
    fun `已存在不覆盖、覆盖开启、只解选中项，三种策略都成立`() {
        val src = temp.newFolder("srcPolicy")
        val a = writeFile(File(src, "a.txt"), bytes(100, 7))
        val b = writeFile(File(src, "b.txt"), bytes(100, 8))
        val tar = File(temp.root, "outPolicy.tar.gz")
        ArchiveCore.createTarGz(tar, listOf(a, b))

        // 1) 已存在且不覆盖 → 跳过，且不覆盖用户的文件。
        val dest1 = temp.newFolder("destP1")
        writeFile(File(dest1, "a.txt"), bytes(100, 9))
        val r1 = ArchiveCore.extractTarGz(tar, dest1, emptyList(), overwrite = false)
        assertEquals(1, r1.skippedExisting)
        assertArrayEquals(bytes(100, 9), File(dest1, "a.txt").readBytes())

        // 2) 覆盖开启 → 真的覆盖。
        val dest2 = temp.newFolder("destP2")
        writeFile(File(dest2, "a.txt"), bytes(100, 10))
        val r2 = ArchiveCore.extractTarGz(tar, dest2, emptyList(), overwrite = true)
        assertEquals(0, r2.skippedExisting)
        assertArrayEquals(bytes(100, 7), File(dest2, "a.txt").readBytes())

        // 3) 只解选中的条目。
        val dest3 = temp.newFolder("destP3")
        ArchiveCore.extractTarGz(tar, dest3, listOf("a.txt"), overwrite = false)
        assertTrue(File(dest3, "a.txt").isFile)
        assertFalse("没选中的条目不该解出", File(dest3, "b.txt").exists())
    }

    @Test
    fun `tar 流在条目中途结束时：这一条记为损坏，且不留半截文件`() {
        // tar 是**顺序格式**：条目数据按 512 补齐，后面的条目紧跟其后。
        // 所以「一条被截断但后面还有完好条目」在 tar 里不存在——截断必然在
        // 流末尾。「这一条不行 ≠ 这个包不行」那条对 tar 不成立，
        // 对 ZIP（每条目独立寻址）才成立，见 [ArchiveCoreTest]。
        //
        // 这里钉的是 tar 该有的语义：流到一半没了 → 这条记「损坏」、
        // 不留半截文件、解包过程不抛异常。
        val tar = File(temp.root, "cut.tar.gz")
        writeTruncatedTar(tar, TarEntrySpec("cut.txt", declaredSize = 100L, payload = bytes(10, 5)))

        val dest = temp.newFolder("destCut")
        val outcome = ArchiveCore.extractTarGz(tar, dest, emptyList(), overwrite = false)

        assertFalse("不该留下半截文件", File(dest, "cut.txt").exists())
        assertEquals("损坏要如实计数", 1, outcome.skippedDamaged)
        assertEquals("损坏不是「太大」", 0, outcome.skippedTooLarge)
    }

    // ------------------------------------------------------------------
    // 手工造 tar 的小工具
    // ------------------------------------------------------------------

    /** 一个待写入的 tar 条目。 */
    private data class TarEntrySpec(
        val name: String,
        val declaredSize: Long,
        val payload: ByteArray,
    )

    /** 手写 tar 头（512 字节），够用来造各种「坏包」。 */
    private fun tarHeader(name: String, size: Long, typeFlag: Char): ByteArray {
        val block = ByteArray(512)
        val nameBytes = name.toByteArray(StandardCharsets.UTF_8)
        System.arraycopy(nameBytes, 0, block, 0, minOf(100, nameBytes.size))
        writeOctal(block, 100, 8, 0x1A4L)
        writeOctal(block, 108, 8, 0L)
        writeOctal(block, 116, 8, 0L)
        writeOctal(block, 124, 12, size)
        writeOctal(block, 136, 12, 0L)
        for (i in 148 until 156) block[i] = ' '.code.toByte()
        block[156] = typeFlag.code.toByte()
        "ustar".toByteArray(StandardCharsets.US_ASCII).copyInto(block, 257)
        block[263] = '0'.code.toByte()
        block[264] = '0'.code.toByte()
        var sum = 0L
        for (b in block) sum += (b.toInt() and 0xFF)
        val digits = String.format(java.util.Locale.US, "%06o", sum).toByteArray(StandardCharsets.US_ASCII)
        System.arraycopy(digits, 0, block, 148, minOf(6, digits.size))
        block[154] = 0
        block[155] = ' '.code.toByte()
        return block
    }

    private fun writeOctal(block: ByteArray, offset: Int, length: Int, value: Long) {
        val text = String.format(java.util.Locale.US, "%0${length - 1}o", value) + "\u0000"
        val bytes = text.toByteArray(StandardCharsets.US_ASCII)
        System.arraycopy(bytes, 0, block, offset, minOf(length, bytes.size))
    }

    private fun writeHandMadeTar(target: File, entries: List<TarEntrySpec>) {
        GZIPOutputStream(target.outputStream()).use { gz ->
            for (entry in entries) {
                gz.write(tarHeader(entry.name, entry.declaredSize, '0'))
                gz.write(entry.payload)
                // 按**实际**写入的字节数补齐到 512 的整数倍——这正是「撒谎」的来源：
                // 头里写的是 declaredSize，磁盘上却是 payload.size。
                val pad = (512 - (entry.payload.size % 512)) % 512
                if (pad > 0) gz.write(ByteArray(pad))
            }
            gz.write(ByteArray(1024)) // 两个空块 = 归档结束
        }
    }

    /**
     * 造一个**流中途结束**的包。
     *
     * 与 [writeHandMadeTar] 的区别：不补齐、不写结束块——数据区写一半就没了。
     * 这才是真正的「归档被截断」：读的人按头里声明的 size 去读，读不到那么多。
     */
    private fun writeTruncatedTar(target: File, entry: TarEntrySpec) {
        GZIPOutputStream(target.outputStream()).use { gz ->
            gz.write(tarHeader(entry.name, entry.declaredSize, '0'))
            gz.write(entry.payload) // 只写这么多，后面的流就没了
        }
    }
}
