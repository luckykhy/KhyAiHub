package com.khyos.khy_os_client.shell

import java.math.BigInteger
import java.security.MessageDigest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the adb auth challenge is really signed with.
 *
 * THE MEASUREMENT THIS FILE PINS. On 2026-11-12 the real adb client on this
 * machine was pointed at a fake adbd and every byte it sent was recorded:
 *
 *   device -> AUTH arg0=1 len=20   (the challenge)
 *   client -> AUTH arg0=2 len=256  (the signature)
 *
 * The signature was then recovered with RSA's own algebra (m = s^e mod n)
 * using the PC's own adbkey. The recovered PKCS#1 v1.5 block was:
 *
 *   00 01 FF … FF 00 | 30 21 30 09 06 05 2b 0e 03 02 1a 05 00 04 14 | <20 bytes>
 *
 * The DigestInfo says SHA-1 — but the 20 bytes after it are the CHALLENGE
 * ITSELF, byte for byte. SHA-1 of that challenge does not appear anywhere in
 * the block. So the platform signs the token AS-IS: it treats the token as an
 * already-hashed digest.
 *
 * This matters because the obvious implementation — `Signature.getInstance
 * ("SHA1withRSA")` — hashes it a second time and produces a signature the
 * device silently rejects. The failure is silent on purpose: the device
 * simply never answers, which on a phone looks exactly like "wireless
 * debugging is off".
 *
 * These tests build the block themselves and check the shape, so the rule
 * cannot be broken by a well-meaning refactor to the JCA.
 */
class AdbAuthKeyTest {

    /** A fixed challenge: no randomness, so a failure is reproducible. */
    private val token: ByteArray = ByteArray(20) { (it * 7 + 3).toByte() }

    private fun recover(signature: ByteArray, key: AdbAuthKey): ByteArray {
        val s = BigInteger(1, signature)
        val m = s.modPow(key.publicKey.publicExponent, key.publicKey.modulus)
        val out = ByteArray(AdbAuthKey.MODULUS_BYTES)
        val raw = m.toByteArray()
        val src = if (raw.size > out.size) raw.copyOfRange(raw.size - out.size, raw.size) else raw
        src.copyInto(out, out.size - src.size)
        return out
    }

    @Test
    fun `the challenge is signed as-is, not hashed again`() {
        val key = AdbAuthKey.generate()
        val signature = key.signChallenge(token)
        assertEquals(AdbAuthKey.MODULUS_BYTES, signature.size)

        val block = recover(signature, key)
        // PKCS#1 v1.5: 00 01, then 0xFF padding, then 0x00, then the DigestInfo,
        // then the challenge.
        assertEquals(0x00.toByte(), block[0])
        assertEquals(0x01.toByte(), block[1])
        val separator = block.size - AdbAuthKey.TOKEN_BYTES - AdbAuthKey.SHA1_DIGEST_INFO.size - 1
        assertEquals(0x00.toByte(), block[separator])
        // The digest slot holds the challenge verbatim.
        val digestSlot = block.copyOfRange(
            block.size - AdbAuthKey.TOKEN_BYTES,
            block.size,
        )
        assertArrayEquals(token, digestSlot)
    }

    @Test
    fun `the digest slot is NOT sha1 of the challenge`() {
        // The whole point of this file: if someone "fixes" the signing to
        // hash the token again, this assertion is what notices.
        val key = AdbAuthKey.generate()
        val signature = key.signChallenge(token)
        val block = recover(signature, key)
        val digestSlot = block.copyOfRange(
            block.size - AdbAuthKey.TOKEN_BYTES,
            block.size,
        )
        val sha1 = MessageDigest.getInstance("SHA-1").digest(token)
        assertFalse(
            "签名的摘要槽必须是 token 本身，而不是 sha1(token)",
            sha1.contentEquals(digestSlot),
        )
        assertNotEquals(token.toList(), sha1.toList())
    }

    @Test
    fun `the digest info says sha1`() {
        val key = AdbAuthKey.generate()
        val signature = key.signChallenge(token)
        val block = recover(signature, key)
        val digestInfoStart = block.size - AdbAuthKey.TOKEN_BYTES - AdbAuthKey.SHA1_DIGEST_INFO.size
        val digestInfo = block.copyOfRange(digestInfoStart, digestInfoStart + AdbAuthKey.SHA1_DIGEST_INFO.size)
        assertArrayEquals(AdbAuthKey.SHA1_DIGEST_INFO, digestInfo)
    }

    @Test
    fun `a signature verifies against its own challenge and no other`() {
        val key = AdbAuthKey.generate()
        val signature = key.signChallenge(token)
        assertTrue(key.verifyChallenge(token, signature))

        val other = ByteArray(20) { 0x5A }
        assertFalse(key.verifyChallenge(other, signature))
    }

    @Test
    fun `the private key survives a PEM round trip`() {
        val key = AdbAuthKey.generate()
        val pem = key.toPrivateKeyPem()
        assertTrue(pem.contains("-----BEGIN PRIVATE KEY-----"))
        val restored = AdbAuthKey.fromPrivateKeyPem(pem)
        assertArrayEquals(key.modulus, restored.modulus)
        // A restored key signs the same way.
        assertArrayEquals(
            key.signChallenge(token),
            restored.signChallenge(token),
        )
    }

    @Test
    fun `the PEM is the shape adb reads`() {
        // adb reads private keys with OpenSSL, so the file has to be a
        // PKCS#8 PEM with 64-character lines — the same shape as the
        // ~/.android/adbkey file on this machine (measured).
        val pem = AdbAuthKey.generate().toPrivateKeyPem()
        val lines = pem.trim().split("\n")
        assertEquals("-----BEGIN PRIVATE KEY-----", lines.first())
        assertEquals("-----END PRIVATE KEY-----", lines.last())
        lines.subList(1, lines.size - 1).forEach { line ->
            assertTrue("PEM 行必须是 64 字符: $line", line.length <= 64)
            assertTrue(line.all { it.isLetterOrDigit() || it == '+' || it == '/' || it == '=' })
        }
    }

    @Test
    fun `the fingerprint is stable and is the full adb fingerprint`() {
        val key = AdbAuthKey.generate()
        // 64 uppercase hex: the adb key fingerprint, which is SHA-256 over the
        // public key's SPKI DER (see AdbTlsCertificateTest for the measurement).
        assertEquals(64, key.fingerprint.length)
        assertTrue(key.fingerprint.all { it in '0'..'9' || it in 'A'..'F' })
        assertEquals(key.fingerprint, AdbAuthKey.fromPrivateKeyPem(key.toPrivateKeyPem()).fingerprint)
    }
}
