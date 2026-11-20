package com.khyos.khy_os_client.vfs

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 格式识别与条目预览的测试（[ArchiveCore] 的 detectFormat / listZip / listTarGz）。
 *
 * ## 为什么要有这个套件
 *
 * 这三个函数此前住在 `VfsArchive` 里，与 Android 入口（`Context` / `MethodCall`）
 * 缠在一起，一行测试都写不了。本轮把它们搬进纯 JVM 的 [ArchiveCore]，
 * 于是「这个文件到底是 zip 还是 tar.gz」「包里的条目表长什么样」这两类问题
 * 才第一次能在 JVM 上被钉住。
 *
 * ## 钉住的不变量
 *
 *  1. **扩展名优先**：`.zip` / `.tar.gz` / `.tgz` 按名字认；
 *  2. **魔数兜底**：改名的包（`.bin` 装的其实是 zip）靠文件头认，
 *     不认就会「解不出来」且无法自证；
 *  3. **不支持就明说**：`.rar` / `.7z` 抛 not_found 并在消息里写明只支持什么，
 *     不假装能读；
 *  4. **条目表字段齐**：name / path / isDirectory / size / compressedSize /
 *     modifiedMs / mode / mime 一个不少——Dart 侧照着这些字段名读，
 *     少一个就是界面上少一列。
 */
class ArchiveCoreFormatTest {

    @get:Rule
    val temp = TemporaryFolder()

    private fun bytes(size: Int, seed: Int = 0): ByteArray =
        ByteArray(size) { ((it * 17 + seed) % 251).toByte() }

    private fun writeFile(file: File, content: ByteArray): File {
        file.parentFile?.mkdirs()
        file.writeBytes(content)
        return file
    }

    @Test
    fun `按扩展名认格式`() {
        val zip = writeFile(File(temp.root, "a.zip"), bytes(10))
        val targz = writeFile(File(temp.root, "b.tar.gz"), bytes(10))
        val tgz = writeFile(File(temp.root, "c.tgz"), bytes(10))

        assertEquals("zip", ArchiveCore.detectFormat(zip))
        assertEquals("tar.gz", ArchiveCore.detectFormat(targz))
        assertEquals("tar.gz", ArchiveCore.detectFormat(tgz))
    }

    @Test
    fun `扩展名不认识时靠魔数认`() {
        // 改名成 .bin 的 zip：靠头两个字节 'P' 'K' 认出来。
        // 注意必须是**真的 zip**（用生产代码造），随机字节没有魔数，
        // 那样测的不是「改名后仍能认出」，而是「随机文件认不出」。
        val realZip = File(temp.root, "src.zip")
        ArchiveCore.createZip(realZip, listOf(writeFile(File(temp.root, "seed.txt"), bytes(100))))
        val renamedZip = File(temp.root, "renamed.bin")
        renamedZip.writeBytes(realZip.readBytes())
        assertEquals("改名后的 zip 应当仍被认出", "zip", ArchiveCore.detectFormat(renamedZip))

        // 改名成 .bin 的 tar.gz：靠 '1f 8b' 认出来。
        val realTgz = File(temp.root, "src2.tar.gz")
        ArchiveCore.createTarGz(realTgz, listOf(writeFile(File(temp.root, "seed2.txt"), bytes(50))))
        val renamedTgz = File(temp.root, "renamedTgz.bin")
        renamedTgz.writeBytes(realTgz.readBytes())
        assertEquals("改名后的 tar.gz 应当仍被认出", "tar.gz", ArchiveCore.detectFormat(renamedTgz))
    }

    @Test
    fun `rar 与 7z 明说不支持并写清支持什么`() {
        val rar = writeFile(File(temp.root, "x.rar"), bytes(10))
        val sevenZ = writeFile(File(temp.root, "x.7z"), bytes(10))

        for (f in listOf(rar, sevenZ)) {
            var thrown: VfsError? = null
            try {
                ArchiveCore.detectFormat(f)
            } catch (e: VfsError) {
                thrown = e
            }
            val err = thrown ?: throw AssertionError("应当抛 VfsError")
            assertEquals("not_found", err.code)
            assertTrue(
                "消息里要写明当前只支持什么：${err.message}",
                err.message.contains("ZIP") && err.message.contains("TAR.GZ"),
            )
        }
    }

    @Test
    fun `完全认不出的文件也明说不支持`() {
        val junk = writeFile(File(temp.root, "junk.bin"), bytes(20))
        var thrown: VfsError? = null
        try {
            ArchiveCore.detectFormat(junk)
        } catch (e: VfsError) {
            thrown = e
        }
        val err = thrown ?: throw AssertionError("应当抛 VfsError")
        assertEquals("not_found", err.code)
    }

    @Test
    fun `ZIP 条目表字段齐全且与实际内容一致`() {
        val src = temp.newFolder("srcZip")
        val file = writeFile(File(src, "a.txt"), bytes(1234))
        writeFile(File(src, "子/b.bin"), bytes(56))
        val zip = File(temp.root, "out.zip")
        ArchiveCore.createZip(zip, listOf(src))

        val entries = ArchiveCore.listZip(zip)
        val names = entries.map { it["name"] as String }
        // 目录条目的名字**归一后不带尾斜杠**（`normalizeEntryName` 的既定行为），
        // 「是不是目录」由 isDirectory 单独说，不靠名字后缀。
        assertTrue("应当有目录条目：$names", names.any { it == "srcZip" })
        assertTrue("应当有文件条目：$names", names.any { it == "srcZip/a.txt" })
        assertTrue("嵌套目录也要在：$names", names.any { it == "srcZip/子" })

        val aEntry = entries.first { it["name"] == "srcZip/a.txt" }
        assertEquals("大小应当与实际一致", 1234L, aEntry["size"])
        assertEquals("path 与 name 同值", aEntry["name"], aEntry["path"])
        assertEquals("文件不是目录", false, aEntry["isDirectory"])
        assertEquals("txt 的 MIME", "text/plain", aEntry["mime"])
        // zip 不携带 unix 权限位，给一个约定值而不是编一个假的。
        assertEquals("zip 的权限位是约定值", "rw-r--r--", aEntry["mode"])

        val dirEntry = entries.first { it["name"] == "srcZip" }
        assertEquals("目录就是目录", true, dirEntry["isDirectory"])
        assertEquals("目录的 MIME", "inode/directory", dirEntry["mime"])
        assertEquals("目录的权限位", "rwxr-xr-x", dirEntry["mode"])
    }

    @Test
    fun `TAR 条目表字段齐全且与实际内容一致`() {
        val src = temp.newFolder("srcTar")
        writeFile(File(src, "a.txt"), bytes(4321))
        writeFile(File(src, "子/b.bin"), bytes(78))
        val tar = File(temp.root, "out.tar.gz")
        ArchiveCore.createTarGz(tar, listOf(src))

        val entries = ArchiveCore.listTarGz(tar)
        val names = entries.map { it["name"] as String }
        assertTrue("应当有目录条目：$names", names.any { it == "srcTar" })
        assertTrue("应当有文件条目：$names", names.any { it == "srcTar/a.txt" })
        assertTrue("嵌套目录也要在：$names", names.any { it == "srcTar/子" })

        val aEntry = entries.first { it["name"] == "srcTar/a.txt" }
        assertEquals("大小应当与实际一致", 4321L, aEntry["size"])
        assertEquals("path 与 name 同值", aEntry["name"], aEntry["path"])
        assertEquals("文件不是目录", false, aEntry["isDirectory"])
        assertEquals("txt 的 MIME", "text/plain", aEntry["mime"])
        // tar 头里带 unix 权限位，这里解出来的是真实值，不是约定值。
        assertTrue("tar 的权限位应当是真实值：${aEntry["mode"]}", (aEntry["mode"] as String).length == 9)
    }

    @Test
    fun `条目名归一：目录条目的结尾斜杠在预览里去掉但目录性保留`() {
        val src = temp.newFolder("srcNorm")
        writeFile(File(src, "a.txt"), bytes(10))
        val zip = File(temp.root, "norm.zip")
        ArchiveCore.createZip(zip, listOf(src))

        val entries = ArchiveCore.listZip(zip)
        for (e in entries) {
            val name = e["name"] as String
            assertFalse("归一后的名字不该以斜杠结尾：$name", name.endsWith("/"))
            assertFalse("归一后的名字不该以 ./ 开头：$name", name.startsWith("./"))
        }
    }
}
