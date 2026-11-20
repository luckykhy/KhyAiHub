package com.khyos.khy_os_client.vfs

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.security.NoSuchAlgorithmException
import java.security.SecureRandom
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.IllegalBlockSizeException
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * 加密归档容器格式（KHYENC1）的读写。
 *
 * **容器格式（字节布局）**：
 * ```
 * 偏移 0   长度 8   魔数 4B 48 59 45 4E 43 31 00（ASCII "KHYENC1" + 1 个 0x00）
 * 偏移 8   长度 16  盐 salt（随机）
 * 偏移 24  长度 16  初始向量 iv（随机）
 * 偏移 40  长度不定 密文 ciphertext
 * ```
 * 密文 = `AES-256-CBC(明文, key) + PKCS5Padding`，其中
 * `key = PBKDF2WithHmacSHA256(password, salt, 65536 次迭代, 256 位)`。
 *
 * 为什么单独成 object 而不是塞在 [VfsCrypto] 里：这一段是**纯文件 + 纯密码学**，
 * 不碰任何 Android API，可以直接在 JVM 单元测试里跑（[VfsCrypto] 的入口要
 * `Context` 与 `MethodCall`，拖进单测得 stub 一堆东西）。
 *
 * 这条格式以前只能靠真机点菜单验证——真机一轮往返要十几步交互、还随时被
 * 锁屏打断，于是「加密→解密能不能拿回原文件」这件事一直没有硬证据。
 * 判据抽成纯逻辑，才能被测：测不了的安全承诺等于没有。
 *
 * 三条不变量（单测钉住）：
 *  1. 魔数固定 8 字节 `4B 48 59 45 4E 43 31 00`；
 *  2. 加密→解密拿回的字节与原文件逐字节相同；
 *  3. 密码错 / 文件被截断 / 魔数不对，三种失败各有各的错误码，不混成一锅。
 */
internal object KhyEncContainer {

    /** 容器魔数的可读形式：ASCII "KHYENC1"。 */
    const val MAGIC = "KHYENC1"

    /**
     * 魔数字段的 8 个字节：`4B 48 59 45 4E 43 31 00`。
     *
     * 为什么是 8 字节而不是 7 字节：格式规定魔数占 8 字节，而 "KHYENC1" 只有
     * 7 个字符。第 8 个字节固定补 0x00（而不是空格），这样这个字段同时是一个
     * 合法的 C 风格字符串，其它语言复刻时按 `"KHYENC1" + 0x00` 写即可，
     * 不会在「补什么」上产生歧义。比较时按 8 字节逐字节比对。
     */
    val MAGIC_BYTES = byteArrayOf(
        0x4B, 0x48, 0x59, 0x45, 0x4E, 0x43, 0x31, 0x00,
    )

    /** 盐长度：16 字节。 */
    const val SALT_SIZE = 16

    /** 初始向量长度：16 字节（AES 块大小）。 */
    const val IV_SIZE = 16

    /** 头部总长：魔数 8 + 盐 16 + 初始向量 16 = 40 字节。 */
    const val HEADER_SIZE = 8 + SALT_SIZE + IV_SIZE

    /** PBKDF2 迭代次数。 */
    const val PBKDF2_ITERATIONS = 65536

    /** 派生密钥长度（位）：AES-256。 */
    const val KEY_BITS = 256

    /** 流式复制的缓冲区大小。 */
    const val BUFFER_SIZE = 64 * 1024

    /** 随机源。盐与初始向量都由它产生，绝不用时间戳之类的弱随机。 */
    private val random = SecureRandom()

    /**
     * 把 [plaintext] 写成容器文件 [target]。
     *
     * 原子性靠「先写 `<目标>.tmp`，写完才改名」实现：改名在同一个目录内完成，
     * 是原子的；中途失败则临时文件被删掉，目标路径上不会出现半个容器。
     *
     * @param targetLabel 出错消息里用的路径标签（不参与密码学）。
     * @param conflictCode 目标已存在时抛出的错误码。
     * @param unknownCode 其它失败时抛出的错误码。
     */
    fun write(
        plaintext: File,
        target: File,
        password: String,
        targetLabel: String,
        conflictCode: String,
        unknownCode: String,
    ) {
        val salt = ByteArray(SALT_SIZE).also { random.nextBytes(it) }
        val iv = ByteArray(IV_SIZE).also { random.nextBytes(it) }
        val key = deriveKey(password, salt)
        val cipher = newCipher(Cipher.ENCRYPT_MODE, key, iv)

        val tmp = File(target.absolutePath + ".tmp")
        tmp.parentFile?.mkdirs()
        var committed = false
        try {
            FileOutputStream(tmp).use { fos ->
                // 头部直接写进文件，不经过 cipher：它必须是明文前缀。
                fos.write(MAGIC_BYTES)
                fos.write(salt)
                fos.write(iv)
                // 密文走 cipher 流，整个明文 ZIP 不进内存。
                CipherOutputStream(fos, cipher).use { cos ->
                    FileInputStream(plaintext).use { input ->
                        input.copyTo(cos, BUFFER_SIZE)
                    }
                }
            }
            // 改名之前再确认一次目标不存在：并发时宁可失败，也不要悄悄覆盖用户的旧文件。
            if (target.exists()) {
                throw VfsError(conflictCode, "目标已存在：$targetLabel")
            }
            if (!tmp.renameTo(target)) {
                throw VfsError(unknownCode, "写入失败：${target.name}")
            }
            committed = true
        } finally {
            if (!committed) tmp.delete()
        }
    }

    /**
     * 读容器文件 [source] 并解出明文到 [target]。
     *
     * 口令错误与文件损坏走同一个出口（`denied`）：两者都会让 PKCS5 填充校验
     * 不过，或让解密出的长度对不上，语义上也无法进一步区分。
     */
    fun read(
        source: File,
        target: File,
        password: String,
        targetLabel: String,
        deniedCode: String,
        notFoundCode: String,
        conflictCode: String,
        unknownCode: String,
    ) {
        val tmp = File(target.absolutePath + ".tmp")
        tmp.parentFile?.mkdirs()
        var committed = false
        try {
            FileInputStream(source).use { fis ->
                val magic = ByteArray(MAGIC_BYTES.size)
                if (!readFully(fis, magic) || !magic.contentEquals(MAGIC_BYTES)) {
                    throw VfsError(notFoundCode, "这不是加密归档")
                }
                val salt = ByteArray(SALT_SIZE)
                val iv = ByteArray(IV_SIZE)
                if (!readFully(fis, salt) || !readFully(fis, iv)) {
                    // 魔数对上了但头都读不全：容器被截断，落在「已损坏」这一侧。
                    throw VfsError(deniedCode, "密码不正确，或文件已损坏")
                }
                val key = deriveKey(password, salt)
                val cipher = newCipher(Cipher.DECRYPT_MODE, key, iv)
                try {
                    CipherInputStream(fis, cipher).use { cin ->
                        FileOutputStream(tmp).use { fos ->
                            cin.copyTo(fos, BUFFER_SIZE)
                        }
                    }
                } catch (e: IOException) {
                    if (isPaddingFailure(e)) {
                        throw VfsError(deniedCode, "密码不正确，或文件已损坏")
                    }
                    throw VfsError(unknownCode, "解密失败：${source.name}")
                }
                // 长度自检：密文长度必须是 16 的倍数（否则块不对齐，必坏），
                // 明文长度必须落在 [密文长 - 16, 密文长 - 1]（填充 1..16 字节）。
                // 这一道是为了兜住「解密流提前结束但没有抛异常」的实现差异：
                // 口令错误时有些平台的 CipherInputStream 只是少给几个字节。
                val cipherLength = source.length() - HEADER_SIZE
                val plainLength = tmp.length()
                if (cipherLength <= 0L || cipherLength % 16L != 0L ||
                    plainLength < cipherLength - 16L || plainLength > cipherLength - 1L
                ) {
                    throw VfsError(deniedCode, "密码不正确，或文件已损坏")
                }
            }
            if (target.exists()) {
                throw VfsError(conflictCode, "目标已存在：$targetLabel")
            }
            if (!tmp.renameTo(target)) {
                throw VfsError(unknownCode, "写入失败：${target.name}")
            }
            committed = true
        } finally {
            if (!committed) tmp.delete()
        }
    }

    /**
     * 派生 AES-256 密钥。
     *
     * 首选平台的 `PBKDF2WithHmacSHA256`。Android 8.0（API 26）以下没有这个
     * 算法，而本 App 的 minSdk 是 24，所以低版本退回用 [Mac] 手写同一套
     * PBKDF2（RFC 8018）——两条路派生出的密钥字节完全一致，容器格式不变。
     *
     * 口令以 char[] 交给 [PBEKeySpec]（平台按 UTF-8 编码），以 UTF-8 字节交给
     * 手写实现，两边一致，所以容器在低版本设备上解出来的结果也一样。
     */
    fun deriveKey(password: String, salt: ByteArray): SecretKeySpec {
        val factory = try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        } catch (e: NoSuchAlgorithmException) {
            null
        }
        val bytes = if (factory != null) {
            val spec = PBEKeySpec(password.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_BITS)
            try {
                factory.generateSecret(spec).encoded
            } finally {
                spec.clearPassword()
            }
        } else {
            pbkdf2HmacSha256(
                password.toByteArray(StandardCharsets.UTF_8),
                salt,
                PBKDF2_ITERATIONS,
                KEY_BITS / 8,
            )
        }
        return SecretKeySpec(bytes, "AES")
    }

    /**
     * PBKDF2-HMAC-SHA256 的手写实现（RFC 8018）。
     *
     * 只在平台没有 PBKDF2WithHmacSHA256 时用（API 24/25）。它与平台实现
     * 输出逐字节相同，所以容器可以在新旧设备之间互通。
     */
    fun pbkdf2HmacSha256(
        password: ByteArray,
        salt: ByteArray,
        iterations: Int,
        keyLength: Int,
    ): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(password, "HmacSHA256"))
        val hashLength = mac.macLength
        val blocks = (keyLength + hashLength - 1) / hashLength
        val output = ByteArray(keyLength)
        val blockIndex = ByteArray(4)
        for (block in 1..blocks) {
            blockIndex[0] = (block ushr 24).toByte()
            blockIndex[1] = (block ushr 16).toByte()
            blockIndex[2] = (block ushr 8).toByte()
            blockIndex[3] = block.toByte()
            // U1 = PRF(P, S || INT(i))
            mac.update(salt)
            mac.update(blockIndex)
            var u = mac.doFinal()
            val acc = u.copyOf()
            for (round in 2..iterations) {
                u = mac.doFinal(u)
                for (i in 0 until hashLength) {
                    acc[i] = (acc[i].toInt() xor u[i].toInt()).toByte()
                }
            }
            val offset = (block - 1) * hashLength
            val length = minOf(hashLength, keyLength - offset)
            acc.copyInto(output, offset, 0, length)
        }
        return output
    }

    /** 新建一把 AES-256-CBC + PKCS5Padding 的 cipher。 */
    private fun newCipher(mode: Int, key: SecretKeySpec, iv: ByteArray): Cipher {
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(mode, key, IvParameterSpec(iv))
        return cipher
    }

    /** 读满整个缓冲区；中途 EOF 返回 false（文件比要求的短）。 */
    private fun readFully(input: InputStream, buffer: ByteArray): Boolean {
        var offset = 0
        while (offset < buffer.size) {
            val read = input.read(buffer, offset, buffer.size - offset)
            if (read < 0) return false
            offset += read
        }
        return true
    }

    /**
     * 判断异常链里有没有填充 / 块长错误。
     *
     * CipherInputStream 会把 [BadPaddingException] 包进 [IOException]，
     * 所以不能只看最外层异常的类型。
     */
    private fun isPaddingFailure(error: Throwable): Boolean {
        var cause: Throwable? = error
        while (cause != null) {
            if (cause is BadPaddingException || cause is IllegalBlockSizeException) return true
            cause = cause.cause
        }
        return false
    }
}
