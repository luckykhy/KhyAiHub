// khy-canary: Khy-20261112-010-BOOTSTRAP
package com.khyos.khy_os_client.shell

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.interfaces.RSAPrivateCrtKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec

/**
 * AdbAuthKey — the RSA identity khyos uses to talk to the phone's OWN adbd.
 *
 * WHY THIS EXISTS. The self-bootstrap (see [DESIGN-ARCH-212]) needs the app to
 * be a *known* adb client: adbd only grants a shell to a key it has already
 * authorized, and the only way to authorize a key is the pairing flow, which
 * the platform implements in native code. So the plan is: the app owns an
 * RSA-2048 keypair, and the app signs the platform's auth challenge with it.
 *
 * WHY THE SIGNING RULE LOOKES WRONG. The obvious guess is "RSA over
 * SHA-1(challenge)", and that guess is **wrong** — measured, not recalled:
 *
 *   · MEASURED 2026-11-12, from the REAL adb client on this machine: the
 *     device's challenge is a 20-byte AUTH token, and the client's answer is
 *     a 256-byte AUTH packet.
 *   · The signature was recovered by RSA's own algebra (m = s^e mod n) with
 *     the PC's own adbkey. The recovered PKCS#1 v1.5 block is:
 *
 *         00 01 FF FF … FF 00 | 30 21 30 09 06 05 2b 0e 03 02 1a 05 00 04 14 | <20 bytes>
 *
 *     The DigestInfo says SHA-1 — but the 20 bytes after it are the CHALLENGE
 *     ITSELF, byte for byte. They are **not** SHA-1(challenge)
 *     (SHA-1 of that challenge is 853a1eee…, which appears nowhere in the
 *     recovered block).
 *
 *   So the platform treats the 20-byte token as an ALREADY-HASHED digest and
 *   signs it as-is. Hashing it a second time produces a signature the device
 *   rejects, and the failure is silent: the device simply never answers.
 *
 * That is why this class builds the PKCS#1 v1.5 block by hand instead of
 * using `Signature.getInstance("SHA1withRSA")`. The JCA would hash the token
 * again — exactly the mistake this file exists to prevent.
 *
 * WHY IT IS PURE. No `android.*` imports: the same class runs inside the app,
 * inside a JVM unit test, and inside a host-side harness that speaks to a
 * real device. That is deliberate — a protocol that can only be tested on a
 * phone is a protocol that stays broken until a phone is handy.
 */
class AdbAuthKey private constructor(
    key: RSAPrivateCrtKey,
    /**
     * The public half.
     *
     * Public because the tests need it to undo the signature the way the
     * device does (m = s^e mod n) — that is the only way to prove the block
     * we build is byte-identical to the one the real adb client produces.
     */
    publicKey: RSAPublicKey,
) {

    /** The modulus, big-endian, fixed width. This is adb's wire public key. */
    val modulus: ByteArray = toFixedWidth(key.modulus, MODULUS_BYTES)

    /** The public half, for verification. */
    val publicKey: RSAPublicKey = publicKey

    /**
     * The private half.
     *
     * Public because the TLS client certificate has to carry this key's public
     * half (see [AdbTlsCertificate]) — and the same key is already exported in
     * PEM form by [toPrivateKeyPem], so this exposes nothing new.
     */
    val privateKey: PrivateKey = key

    /** The CRT form, for the raw RSA operation. */
    private val crtKey: RSAPrivateCrtKey = key

    /** The public key in X.509 SubjectPublicKeyInfo form. */
    val spkiDer: ByteArray = AdbTlsCertificate.spkiDer(privateKey)

    /**
     * The adb fingerprint of this key: SHA-256 over the public key's
     * SubjectPublicKeyInfo DER, uppercase hex.
     *
     * MEASURED 2026-11-12, and it matters more than it looks: the device
     * names the certificate it wants in its TLS CertificateRequest as
     *
     *     "certificate authorities": [ CN=<fingerprint>, O=AdbKey-0 ]
     *
     * so this string is not decoration — it is how the client says "this is
     * the key I am". Getting the definition wrong (SHA-256 of the bare
     * modulus, say) produces a certificate the device silently refuses.
     *
     * The definition was found by matching the PC's own key against the
     * fingerprint the device asked for: SHA-256 of the SPKI DER matches;
     * SHA-256 of the bare modulus does not.
     */
    val fingerprint: String = java.security.MessageDigest.getInstance("SHA-256")
        .digest(spkiDer)
        .joinToString("") { "%02X".format(it) }

    /**
     * Sign an auth challenge.
     *
     * @param token the 20-byte challenge the device sent (AUTH arg0=1)
     * @return the 256-byte signature (AUTH arg0=2)
     */
    fun signChallenge(token: ByteArray): ByteArray {
        require(token.size == TOKEN_BYTES) {
            "adb auth challenge is $TOKEN_BYTES bytes, got ${token.size}"
        }
        val block = pkcs1v15Block(token)
        val m = BigInteger(1, block)
        val s = m.modPow(crtKey.privateExponent, crtKey.modulus)
        return toFixedWidth(s, MODULUS_BYTES)
    }

    /**
     * Verify a signature the way the device does: recover the padded block and
     * compare its digest slot with the challenge.
     *
     * Used by the tests to prove that [signChallenge] produces exactly what
     * the real adb client produces — see the class doc for the measurement.
     */
    fun verifyChallenge(token: ByteArray, signature: ByteArray): Boolean {
        if (signature.size != MODULUS_BYTES) return false
        val s = BigInteger(1, signature)
        val m = s.modPow(publicKey.publicExponent, publicKey.modulus)
        val block = toFixedWidth(m, MODULUS_BYTES)
        val expected = pkcs1v15Block(token)
        return block.contentEquals(expected)
    }

    /**
     * The PKCS#1 v1.5 block for this challenge.
     *
     * `00 01 | 0xFF … | 0x00 | DigestInfo(SHA-1) | challenge`
     *
     * The challenge sits in the digest slot **verbatim** — see the class doc
     * for why that is not a typo.
     */
    private fun pkcs1v15Block(token: ByteArray): ByteArray {
        val digestInfo = SHA1_DIGEST_INFO
        val tail = digestInfo.size + token.size
        val padding = MODULUS_BYTES - tail - 3
        require(padding >= 8) { "RSA modulus too small for a PKCS#1 v1.5 block" }
        val block = ByteArray(MODULUS_BYTES)
        block[0] = 0x00
        block[1] = 0x01
        for (i in 2 until 2 + padding) block[i] = 0xFF.toByte()
        block[2 + padding] = 0x00
        digestInfo.copyInto(block, 3 + padding)
        token.copyInto(block, 3 + padding + digestInfo.size)
        return block
    }

    /** The private key in the PEM form `adb` reads (PKCS#8, "BEGIN PRIVATE KEY"). */
    fun toPrivateKeyPem(): String {
        val der = privateKey.encoded
        return pem("PRIVATE KEY", der)
    }

    /**
     * The Android "mincrypt" encoding of this key's public half, base64-encoded.
     *
     * WHAT THIS IS FOR. The adb pairing protocol carries the public key as a
     * **text** blob: the base64 of Android's own RSA public key structure,
     * which is what `adb` writes into `/data/misc/adb/adb_keys` and what the
     * device parses back with `android_pubkey_decode`. Sending a PEM here
     * would be rejected by the device — it expects this exact layout:
     *
     * ```
     * struct RSAPublicKey {
     *   uint32 modulus_size_words;   // 64 for a 2048-bit modulus
     *   uint32 n0inv;                // -1 / n[0] mod 2^32
     *   uint8  modulus[256];         // little-endian
     *   uint8  rr[256];              // R^2 mod N, little-endian
     *   uint32 exponent;             // 65537
     * };
     * ```
     *
     * VERIFIED, not assumed: on 2026-11-16 this function's output was compared
     * against the key the **device itself** had authorized — the base64 in
     * `dumpsys adb`'s `user_keys` — and the two were byte-for-byte identical
     * (716 characters). See
     * `works/data/khy/feedback/2026-11-16-selfconnect-adbd/pairing-oracle-verified.txt`.
     */
    fun mincryptPublicKeyBase64(): String = mincryptPublicKeyBase64(publicKey)

    /** Write a 32-bit little-endian value. */
    private fun writeLeInt(target: ByteArray, offset: Int, value: Int) {
        target[offset] = (value and 0xFF).toByte()
        target[offset + 1] = ((value ushr 8) and 0xFF).toByte()
        target[offset + 2] = ((value ushr 16) and 0xFF).toByte()
        target[offset + 3] = ((value ushr 24) and 0xFF).toByte()
    }

    /** A stable id for this keypair, safe to show in the UI. */
    fun shortId(): String = fingerprint

    companion object {
        /** RSA-2048: the size adb uses. */
        const val KEY_BITS = 2048

        /** The modulus width in bytes (256 for RSA-2048). */
        const val MODULUS_BYTES = KEY_BITS / 8

        /** The auth challenge length in bytes (a SHA-1 sized blob). */
        const val TOKEN_BYTES = 20

        /**
         * DigestInfo for SHA-1, DER encoded.
         *
         * `30 21 30 09 06 05 2b 0e 03 02 1a 05 00 04 14`
         */
        val SHA1_DIGEST_INFO: ByteArray = byteArrayOf(
            0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e.toByte(),
            0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
        )

        /** Generate a fresh keypair. This takes a moment; do it off the UI thread. */
        @JvmStatic
        fun generate(): AdbAuthKey {
            val gen = KeyPairGenerator.getInstance("RSA")
            gen.initialize(KEY_BITS)
            val pair = gen.generateKeyPair()
            return AdbAuthKey(
                pair.private as RSAPrivateCrtKey,
                pair.public as RSAPublicKey,
            )
        }

        /** Load a keypair from the PEM this class produced. */
        @JvmStatic
        fun fromPrivateKeyPem(pemText: String): AdbAuthKey {
            val der = fromPem(pemText, "PRIVATE KEY")
            val factory = KeyFactory.getInstance("RSA")
            val pkcs8 = PKCS8EncodedKeySpec(der)
            val priv = factory.generatePrivate(pkcs8) as RSAPrivateCrtKey
            // Rebuild the matching public key from the CRT parameters: the
            // modulus and the public exponent are both in the private key.
            val pub = RSAPublicKeyImpl(priv.modulus, priv.publicExponent)
            return AdbAuthKey(priv, pub)
        }

        /** Load only the public half — enough to verify a signature. */
        @JvmStatic
        fun fromPublicKeyPem(pemText: String): RSAPublicKey {
            val der = fromPem(pemText, "PUBLIC KEY")
            return KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(der)) as RSAPublicKey
        }

        /**
         * The Android "mincrypt" encoding of a public key, base64-encoded.
         *
         * Split out from the instance method so that a test can encode a key
         * it only has the public half of — which is exactly the situation on
         * the wire: the device only ever sees the public half.
         *
         * The layout is AOSP's `crypto_utils/android_pubkey.c`:
         * ```
         * struct RSAPublicKey {
         *   uint32 modulus_size_words;   // 64 for a 2048-bit modulus
         *   uint32 n0inv;                // -1 / n[0] mod 2^32
         *   uint8  modulus[256];         // little-endian
         *   uint8  rr[256];              // R^2 mod N, little-endian
         *   uint32 exponent;             // 65537
         * };
         * ```
         */
        @JvmStatic
        fun mincryptPublicKeyBase64(publicKey: RSAPublicKey): String {
            val modulusBytes = MODULUS_BYTES
            val modulusBe = toFixedWidth(publicKey.modulus, modulusBytes)
            val n = java.math.BigInteger(1, modulusBe)
            // The little-endian modulus is the big-endian one reversed.
            val modulusLe = modulusBe.reversedArray()
            // n0 is the low 32 bits of n — which are the FIRST four bytes of
            // the little-endian form.
            val n0 = n.mod(java.math.BigInteger.ONE.shiftLeft(32))
            val twoTo32 = java.math.BigInteger.ONE.shiftLeft(32)
            val n0inv = twoTo32.subtract(n0.modInverse(twoTo32)).mod(twoTo32)
            // rr = (2^2048)^2 mod N
            val r = java.math.BigInteger.TWO.modPow(java.math.BigInteger.valueOf(modulusBytes * 8L), n)
            val rr = r.multiply(r).mod(n)

            val out = ByteArray(12 + modulusBytes * 2)
            writeLeIntStatic(out, 0, MODULUS_BYTES / 4)
            writeLeIntStatic(out, 4, n0inv.toInt())
            System.arraycopy(modulusLe, 0, out, 8, modulusBytes)
            val rrLe = toFixedWidth(rr, modulusBytes).reversedArray()
            System.arraycopy(rrLe, 0, out, 8 + modulusBytes, modulusBytes)
            writeLeIntStatic(out, 8 + modulusBytes * 2, publicKey.publicExponent.toInt())
            return base64(out)
        }

        /** Write a 32-bit little-endian value. */
        private fun writeLeIntStatic(target: ByteArray, offset: Int, value: Int) {
            target[offset] = (value and 0xFF).toByte()
            target[offset + 1] = ((value ushr 8) and 0xFF).toByte()
            target[offset + 2] = ((value ushr 16) and 0xFF).toByte()
            target[offset + 3] = ((value ushr 24) and 0xFF).toByte()
        }

        private fun toFixedWidth(value: BigInteger, width: Int): ByteArray {
            val raw = value.toByteArray()
            // BigInteger may prepend a zero byte to keep the value positive.
            val out = ByteArray(width)
            val src = if (raw.size > width) raw.copyOfRange(raw.size - width, raw.size) else raw
            src.copyInto(out, width - src.size)
            return out
        }

        private fun pem(label: String, der: ByteArray): String {
            val b64 = base64(der)
            val sb = StringBuilder()
            sb.append("-----BEGIN ").append(label).append("-----\n")
            var i = 0
            while (i < b64.length) {
                val end = minOf(i + 64, b64.length)
                sb.append(b64, i, end).append('\n')
                i = end
            }
            sb.append("-----END ").append(label).append("-----\n")
            return sb.toString()
        }

        private fun fromPem(text: String, label: String): ByteArray {
            val begin = "-----BEGIN $label-----"
            val end = "-----END $label-----"
            val start = text.indexOf(begin)
            val stop = text.indexOf(end)
            require(start >= 0 && stop > start) { "not a $label PEM" }
            val body = text.substring(start + begin.length, stop).filterNot { it.isWhitespace() }
            return base64Decode(body)
        }

        /**
         * Base64 without `java.util.Base64` (API 26+) and without
         * `android.util.Base64` (not available off-device) — this class has to
         * run in a bare JVM too.
         */
        private fun base64(data: ByteArray): String {
            val table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            val out = StringBuilder((data.size + 2) / 3 * 4)
            var i = 0
            while (i + 2 < data.size) {
                val n = ((data[i].toInt() and 0xFF) shl 16) or
                    ((data[i + 1].toInt() and 0xFF) shl 8) or
                    (data[i + 2].toInt() and 0xFF)
                out.append(table[(n shr 18) and 63]).append(table[(n shr 12) and 63])
                out.append(table[(n shr 6) and 63]).append(table[n and 63])
                i += 3
            }
            val rest = data.size - i
            if (rest == 1) {
                val n = (data[i].toInt() and 0xFF) shl 16
                out.append(table[(n shr 18) and 63]).append(table[(n shr 12) and 63]).append("==")
            } else if (rest == 2) {
                val n = ((data[i].toInt() and 0xFF) shl 16) or ((data[i + 1].toInt() and 0xFF) shl 8)
                out.append(table[(n shr 18) and 63]).append(table[(n shr 12) and 63])
                out.append(table[(n shr 6) and 63]).append('=')
            }
            return out.toString()
        }

        private fun base64Decode(text: String): ByteArray {
            val table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            val clean = text.filter { it != '=' }
            val out = ByteArray(clean.length * 3 / 4)
            var acc = 0
            var bits = 0
            var o = 0
            for (c in clean) {
                val v = table.indexOf(c)
                require(v >= 0) { "bad base64 character: $c" }
                acc = (acc shl 6) or v
                bits += 6
                if (bits >= 8) {
                    bits -= 8
                    out[o++] = ((acc shr bits) and 0xFF).toByte()
                }
            }
            return if (o == out.size) out else out.copyOf(o)
        }
    }
}

/**
 * A public key assembled from a private key's CRT parameters.
 *
 * `RSAPrivateCrtKey` carries the modulus and the public exponent, so the
 * public half never has to be stored separately — and the app therefore has
 * exactly one secret file.
 */
private class RSAPublicKeyImpl(
    private val n: BigInteger,
    private val e: BigInteger,
) : RSAPublicKey {
    override fun getAlgorithm(): String = "RSA"
    override fun getFormat(): String = "X.509"
    override fun getModulus(): BigInteger = n
    override fun getPublicExponent(): BigInteger = e
    override fun getEncoded(): ByteArray = throw UnsupportedOperationException("not serialisable")
}
