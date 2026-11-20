package com.khyos.khy_os_client.vfs

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 加密归档容器（KHYENC1）的格式判据测试。
 *
 * 为什么要有这个套件：这一层以前只能靠真机点菜单验证——真机一轮往返要十几步
 * 交互，还随时被锁屏打断，于是「加密→解密能不能拿回原文件」这件事一直没有
 * 硬证据，只能靠「dex 里有 KHYENC1 这个字符串」这种弱证据撑着。
 *
 * 抽出 [KhyEncContainer] 之后，这段判据是纯文件 + 纯密码学，可以在 JVM 上跑。
 *
 * 钉住的不变量：
 *  1. 魔数是固定的 8 字节 `4B 48 59 45 4E 43 31 00`；
 *  2. 加密→解密拿回的字节与原文件**逐字节相同**；
 *  3. 密码错、魔数不对、文件被截断——三种失败各有各的错误码，不混成一锅；
 *  4. 同一个明文加密两次，密文不同（盐与 iv 是随机的，不是固定值）。
 */
class KhyEncContainerTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val conflict = VfsBridge.ERR_CONFLICT
    private val denied = VfsBridge.ERR_DENIED
    private val notFound = VfsBridge.ERR_NOT_FOUND
    private val unknown = VfsBridge.ERR_UNKNOWN

    private fun plainBytes(size: Int = 4096): ByteArray =
        ByteArray(size) { (it % 251).toByte() }

    private fun writePlain(name: String = "src.zip", size: Int = 4096): File {
        val file = temp.newFile(name)
        file.writeBytes(plainBytes(size))
        return file
    }

    private fun encrypt(source: File, target: File, password: String) {
        KhyEncContainer.write(
            plaintext = source,
            target = target,
            password = password,
            targetLabel = target.name,
            conflictCode = conflict,
            unknownCode = unknown,
        )
    }

    private fun decrypt(source: File, target: File, password: String) {
        KhyEncContainer.read(
            source = source,
            target = target,
            password = password,
            targetLabel = target.name,
            deniedCode = denied,
            notFoundCode = notFound,
            conflictCode = conflict,
            unknownCode = unknown,
        )
    }

    @Test
    fun `魔数是固定的 8 字节`() {
        assertEquals(8, KhyEncContainer.MAGIC_BYTES.size)
        assertArrayEquals(
            byteArrayOf(0x4B, 0x48, 0x59, 0x45, 0x4E, 0x43, 0x31, 0x00),
            KhyEncContainer.MAGIC_BYTES,
        )
        assertEquals("KHYENC1", KhyEncContainer.MAGIC)
        assertEquals(40, KhyEncContainer.HEADER_SIZE)
    }

    @Test
    fun `加密后再解密拿回逐字节相同的明文`() {
        val plain = writePlain()
        val enc = File(temp.root, "out.khyenc")
        val back = File(temp.root, "back.zip")

        encrypt(plain, enc, "khy1234")
        decrypt(enc, back, "khy1234")

        assertTrue("解密结果应该存在", back.exists())
        assertArrayEquals("拿回的字节必须与原文件一致", plain.readBytes(), back.readBytes())
    }

    @Test
    fun `空文件也能往返`() {
        val plain = temp.newFile("empty.zip")
        plain.writeBytes(ByteArray(0))
        val enc = File(temp.root, "empty.khyenc")
        val back = File(temp.root, "empty-back.zip")

        encrypt(plain, enc, "pw")
        decrypt(enc, back, "pw")

        assertArrayEquals(ByteArray(0), back.readBytes())
    }

    @Test
    fun `大文件靠流式处理也能原样往返`() {
        // 超过 BUFFER_SIZE（64KB），确保走的是多轮拷贝而不是一次性读进内存。
        val plain = writePlain("big.zip", size = 200_000)
        val enc = File(temp.root, "big.khyenc")
        val back = File(temp.root, "big-back.zip")

        encrypt(plain, enc, "pw")
        decrypt(enc, back, "pw")

        assertArrayEquals(plain.readBytes(), back.readBytes())
    }

    @Test
    fun `容器文件的头部就是魔数`() {
        val plain = writePlain()
        val enc = File(temp.root, "hdr.khyenc")

        encrypt(plain, enc, "pw")

        val head = enc.readBytes().copyOfRange(0, 8)
        assertArrayEquals(KhyEncContainer.MAGIC_BYTES, head)
    }

    @Test
    fun `密码错时报 denied 而不是崩`() {
        val plain = writePlain()
        val enc = File(temp.root, "wrongpw.khyenc")
        val back = File(temp.root, "wrongpw-back.zip")

        encrypt(plain, enc, "right-password")
        val error = runCatching { decrypt(enc, back, "wrong-password") }.exceptionOrNull()

        assertTrue("密码错必须抛 VfsError", error is VfsError)
        assertEquals(denied, (error as VfsError).code)
        assertFalse("失败的解密不该留下结果文件", back.exists())
    }

    @Test
    fun `不是容器时报 not_found`() {
        val plain = writePlain("notenc.bin")
        val back = File(temp.root, "notenc-back.zip")

        val error = runCatching { decrypt(plain, back, "pw") }.exceptionOrNull()

        assertTrue(error is VfsError)
        assertEquals(notFound, (error as VfsError).code)
    }

    @Test
    fun `容器被截断时报 denied`() {
        val plain = writePlain()
        val enc = File(temp.root, "cut.khyenc")
        encrypt(plain, enc, "pw")

        // 砍掉一半：魔数还在，但密文不再完整。
        val bytes = enc.readBytes()
        enc.writeBytes(bytes.copyOfRange(0, bytes.size / 2))

        val error = runCatching {
            decrypt(enc, File(temp.root, "cut-back.zip"), "pw")
        }.exceptionOrNull()

        assertTrue(error is VfsError)
        assertEquals(denied, (error as VfsError).code)
    }

    @Test
    fun `同一个明文加密两次得到不同的密文`() {
        val plain = writePlain()
        val enc1 = File(temp.root, "a.khyenc")
        val enc2 = File(temp.root, "b.khyenc")

        encrypt(plain, enc1, "same-password")
        encrypt(plain, enc2, "same-password")

        assertFalse(
            "盐与 iv 必须随机，否则同样的包每次都长得一样",
            enc1.readBytes().contentEquals(enc2.readBytes()),
        )
    }

    @Test
    fun `目标已存在时报 conflict 且不覆盖`() {
        val plain = writePlain()
        val enc = File(temp.root, "dup.khyenc")
        encrypt(plain, enc, "pw")

        val original = enc.readBytes()
        val error = runCatching { encrypt(plain, enc, "pw") }.exceptionOrNull()

        assertTrue(error is VfsError)
        assertEquals(conflict, (error as VfsError).code)
        assertArrayEquals("不能悄悄覆盖用户已有的文件", original, enc.readBytes())
    }

    @Test
    fun `非 ASCII 密码也能往返`() {
        // 口令按 UTF-8 编码（平台 PBEKeySpec 与手写回退实现一致），所以中文
        // 密码也必须能开——这是「用户会用自己的母语当密码」的常见情况。
        val plain = writePlain()
        val enc = File(temp.root, "cn.khyenc")
        val back = File(temp.root, "cn-back.zip")

        encrypt(plain, enc, "密码测试123")
        decrypt(enc, back, "密码测试123")

        assertArrayEquals(plain.readBytes(), back.readBytes())
    }

    @Test
    fun `手写 PBKDF2 与平台实现派生出同一把密钥`() {
        // 两条路（API 26+ 的平台实现 / API 24-25 的手写回退）必须逐字节一致，
        // 否则同一个容器在旧设备上解不开——那是「低版本用户打不开自己的包」。
        val salt = ByteArray(16) { it.toByte() }
        val platform = KhyEncContainer.deriveKey("portable-password", salt).encoded
        val manual = KhyEncContainer.pbkdf2HmacSha256(
            "portable-password".toByteArray(Charsets.UTF_8),
            salt,
            KhyEncContainer.PBKDF2_ITERATIONS,
            KhyEncContainer.KEY_BITS / 8,
        )
        assertArrayEquals(platform, manual)
        assertEquals(32, platform.size)
    }
}
