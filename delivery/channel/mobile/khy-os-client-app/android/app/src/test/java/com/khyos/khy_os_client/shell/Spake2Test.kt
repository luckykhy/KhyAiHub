package com.khyos.khy_os_client.shell

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pairing crypto, checked against vectors that the **platform** produced.
 *
 * WHERE THESE VECTORS COME FROM. They were computed by
 * `scripts/adb-pairing-common.js` — the same algorithm in JavaScript — and that
 * JavaScript implementation was accepted by the **real `adb pair` client** of
 * platform-tools 37.0.1 on 2026-11-16 ("Successfully paired to 127.0.0.1:5605").
 * So these numbers are not "what our own code happens to produce": they are
 * what BoringSSL produces, and the App's Kotlin implementation has to agree
 * with them byte for byte.
 *
 * The evidence is in
 * `works/data/khy/feedback/2026-11-16-selfconnect-adbd/pairing-oracle-verified.txt`.
 *
 * WHY THE VECTORS PIN THE EPHEMERAL SCALARS. SPAKE2 draws a random scalar per
 * run, so a message is not reproducible. Pinning both ends' scalars makes the
 * whole exchange deterministic, which is what turns "it worked once" into
 * "it cannot drift without a test going red".
 *
 * WHY THE MINCRYPT VECTOR IS THE INTERESTING ONE. The base64 of the public
 * key is what the device stores in `/data/misc/adb/adb_keys` and parses back
 * with `android_pubkey_decode`. If our layout were off by a byte order or a
 * field, the device would refuse the key — and the failure would be silent.
 * The vector below was produced by the JavaScript implementation and matches
 * the key the **device itself** had authorized (716 base64 characters).
 */
class Spake2Test {

    private fun hex(s: String): ByteArray {
        val out = ByteArray(s.length / 2)
        for (i in out.indices) {
            out[i] = ((Character.digit(s[i * 2], 16) shl 4) or Character.digit(s[i * 2 + 1], 16)).toByte()
        }
        return out
    }

    private fun toHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }

    /** The password: the 6-digit code followed by 64 bytes of keying material. */
    private val password: ByteArray = hex(
        "3132333435360b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4"
    )

    /** The client's pinned ephemeral scalar. */
    private val clientPrivate: ByteArray = hex("03101d2a3744515e6b7885929facb9c6d3e0edfa0714212e3b4855626f7c8996")

    /** The server's pinned ephemeral scalar. */
    private val serverPrivate: ByteArray = hex("05223f5c7996b3d0ed0a2744617e9bb8d5f20f2c496683a0bddaf714314e6b88")

    private val expectedClientMsg: ByteArray =
        hex("90ba592ac148c82fbc15c385710d5b351dea07b70edee277f432bffb01c4643e")

    private val expectedServerMsg: ByteArray =
        hex("58a4fbff8076aca6f393ae428b5b63f4773cd57524b26a4cad06f6f776567e5d")

    private val expectedSharedKey: ByteArray = hex(
        "b9de056f484731a2b9810147bf5831ca0dfd526c08a2656cc21ca2f8b0de0140a9a8b6dea7eac17612d53ea5432a866ed323dbe9605bc03f99d4961da267d748"
    )

    private fun client(): Spake2 = Spake2(
        isClient = true,
        myName = AdbPairingClient.CLIENT_NAME,
        theirName = AdbPairingClient.SERVER_NAME,
    )

    private fun server(): Spake2 = Spake2(
        isClient = false,
        myName = AdbPairingClient.SERVER_NAME,
        theirName = AdbPairingClient.CLIENT_NAME,
    )

    @Test
    fun clientMessageMatchesThePlatform() {
        val msg = client().generateMsg(password, clientPrivate)
        assertArrayEquals(expectedClientMsg, msg)
    }

    @Test
    fun serverMessageMatchesThePlatform() {
        val msg = server().generateMsg(password, serverPrivate)
        assertArrayEquals(expectedServerMsg, msg)
    }

    @Test
    fun bothSidesDeriveTheSameKey() {
        val c = client()
        val s = server()
        val clientMsg = c.generateMsg(password, clientPrivate)
        val serverMsg = s.generateMsg(password, serverPrivate)
        val clientKey = c.processMsg(serverMsg)
        val serverKey = s.processMsg(clientMsg)
        assertNotNull(clientKey)
        assertNotNull(serverKey)
        assertArrayEquals(expectedSharedKey, clientKey)
        assertArrayEquals(expectedSharedKey, serverKey)
    }

    @Test
    fun theTranscriptNamesCarryTheirNul() {
        // AOSP passes sizeof(), not strlen(): "adb pair client" and
        // "adb pair server" are 15 characters each, so both arrays are
        // 16 bytes with the NUL.
        assertEquals(16, AdbPairingClient.CLIENT_NAME.size)
        assertEquals(16, AdbPairingClient.SERVER_NAME.size)
        assertEquals(0, AdbPairingClient.CLIENT_NAME[15].toInt())
        assertEquals(0, AdbPairingClient.SERVER_NAME[15].toInt())
        // And the exporter label is sizeof("adb-label") = 10.
        assertEquals(10, AdbPairingClient.EXPORT_LABEL.length)
        assertEquals(0, AdbPairingClient.EXPORT_LABEL[9].code)
    }

    @Test
    fun theAesKeyMatchesThePlatform() {
        val key = AdbPairingClient.aesKey(expectedSharedKey)
        assertEquals("e2643a1802d548ba3b2ef42fd729a8cb", toHex(key))
    }

    @Test
    fun thePeerInfoCiphertextMatchesThePlatform() {
        val key = AdbPairingClient.aesKey(expectedSharedKey)
        val plain = ByteArray(AdbPairingClient.PEER_INFO_SIZE)
        plain[0] = 0
        "QUJD".toByteArray(Charsets.US_ASCII).copyInto(plain, 1)
        val cipher = AdbPairingClient.aesEncrypt(key, 0, plain)
        assertEquals(
            "04d6161732765167e83d4e487f8979cfe1bf7dff3df278998bce5d9d416dcbdd5c92fd3925cd7c600d717e411199f2fd",
            toHex(cipher).substring(0, 96),
        )
        // And it round-trips.
        assertArrayEquals(plain, AdbPairingClient.aesDecrypt(key, 0, cipher))
    }

    @Test
    fun thePublicKeyEncodingMatchesTheDevice() {
        val pem = """
            -----BEGIN PUBLIC KEY-----
            MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnhuapqDYow+F4uBM8BLQ
            I41b4walTAJdu9WeqHBNwgbJ/NBE6uDzxdkcv/79ZNziWNKeoA/VG0KrvbGfuHBW
            KcNiWjxpw3JF6DfgAkU4161fIdG1UZ/bKz7zPvyW2xdgB2QdWPLLG8GyZY6wpA1K
            mgSsG/sPBoUCLf2fM+XFDtLS2o9fLLZqmfljIoMhndDa1JiyYjuL82I8qc4MDp/K
            iAZeqrmjblF8YVzpZUbY+l7rdFSyKuPgwU2B8hpOcfKgJIHj5wYiSEYrT0T+jp2d
            i+oyU8GTXmnyi4toKkGg/KSjsAWoMGV3FGYqBpztuFnlxTfYnQeHD8O8u+mS4Vv1
            twIDAQAB
            -----END PUBLIC KEY-----
        """.trimIndent()
        val publicKey = AdbAuthKey.fromPublicKeyPem(pem)
        val encoded = AdbAuthKey.mincryptPublicKeyBase64(publicKey)
        // Regenerated 2026-11-17 after fixing the reference's modular inverse:
        // inverting mod 2^32 needs extended Euclid (2^32 is not prime), and
        // with that fix the JavaScript reference agrees with this Kotlin
        // implementation — and both agree with the n0inv the DEVICE itself
        // stores for the PC's authorized key (0xFA29D6DD for n0 = 0xC7854E8B).
        assertEquals(
            "QAAAAPkH2lS39Vvhkum7vMMPhwed2DfF5Vm47ZwGKmYUd2UwqAWwo6T8oEEqaIuL8mlek8FTMuqLnZ2O/kRPK0ZIIgbn44EkoPJxThrygU3B4OMqslR061762EZl6VxhfFFuo7mqXgaIyp8ODM6pPGLziztispjU2tCdIYMiY/mZarYsX4/a0tIOxeUzn/0tAoUGD/sbrASaSg2ksI5lssEby/JYHWQHYBfblvw+8z4r259RtdEhX63XOEUC4DfoRXLDaTxaYsMpVnC4n7G9q0Ib1Q+gntJY4txk/f6/HNnF8+DqRND8yQbCTXContW7XQJMpQbjW40j0BLwTODihQ+j2KCmmhueDGVqHvVwX4tyaZ2WA3AO7BtXQ/uCz2OR73UWj8AlewHD0hkjoTJ56dCj8KT2gVnZuDokIJfXJsVS7hbrkPfq5d8q3qQjy5JLOTEe5EVpTPWFbZ42MIWi4er7TlA1I5Isr6dQtirDNaWcaepmVoNLgrEUFgULM5ljhi864u2URf0J9cv/gqMl4BgKx4oRODGhtO/VP7vrbL/ITSrCwp1AOrrIqbOTeogKL2G0CxFii8czAojFtY1N3jtq4oGL6GaqWjMdfgZqc7BxmXpE9Wq7xmRZO6LTnJqcUhbbK0TnX6vP3pekt/Yd4wKuelljMYdmQ5LMYb8BK5/erwwdDhqxCwEAAQA=",
            encoded,
        )
        // The layout the device parses: 524 bytes, 64 words, exponent 65537.
        val raw = java.util.Base64.getDecoder().decode(encoded)
        assertEquals(524, raw.size)
        assertEquals(64, (raw[0].toInt() and 0xFF) or ((raw[1].toInt() and 0xFF) shl 8))
        // 65537 = 0x00010001, little-endian across all four bytes.
        assertEquals(
            65537,
            (raw[520].toInt() and 0xFF) or ((raw[521].toInt() and 0xFF) shl 8)
                or ((raw[522].toInt() and 0xFF) shl 16) or ((raw[523].toInt() and 0xFF) shl 24),
        )
    }

    @Test
    fun aWrongPasswordProducesADifferentKey() {
        val c = client()
        val s = server()
        val clientMsg = c.generateMsg(password, clientPrivate)
        // "123457" + 64 zero bytes: same shape, different secret.
        val wrongPassword = "123457".toByteArray(Charsets.US_ASCII) + ByteArray(64)
        val serverMsg = s.generateMsg(wrongPassword, serverPrivate)
        val clientKey = c.processMsg(serverMsg)
        val serverKey = s.processMsg(clientMsg)
        assertNotNull(clientKey)
        assertNotNull(serverKey)
        assertTrue(!clientKey.contentEquals(serverKey!!))
    }
}
