// khy-canary: Khy-20261112-010-BOOTSTRAP
package com.khyos.khy_os_client.shell

import java.io.ByteArrayOutputStream
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPrivateCrtKey
import java.security.interfaces.RSAPublicKey

/**
 * AdbTlsCertificate — the client certificate the device demands.
 *
 * WHY THIS EXISTS. MEASURED 2026-11-12 against a real phone: after the STLS
 * upgrade the device answers our TLS ClientHello with a fatal
 * `certificate_required` alert. So the wireless-debugging transport is
 * MUTUAL TLS: the client has to present a certificate, and the device checks
 * it before it will talk adb. The device's own log says so:
 *
 *     E/adbd: [server]: Handshake failed in SSL_accept/SSL_connect [DECODE_ERROR]
 *
 * WHAT THE CERTIFICATE MUST LOOK LIKE. This is the part that is easy to get
 * wrong and impossible to guess. The device names the certificate it wants in
 * its TLS CertificateRequest:
 *
 *     "certificate authorities": [
 *         CN=FC6DA2D0A7BBEB3B2A4872BEE9FD83C998B7F8C21FB99851EB4DA151573E3FFD,
 *         O=AdbKey-0
 *     ]
 *
 * ⇒ the certificate's subject has to be **the adb key's fingerprint as CN**,
 * with the organization **AdbKey-0**. The fingerprint is SHA-256 over the
 * public key's SubjectPublicKeyInfo DER (see [AdbAuthKey.fingerprint]) — that
 * definition was matched against the device's own request, not guessed.
 *
 * The rest of the shape comes from the strings still inside `adb.exe` (AOSP's
 * `packages/modules/adb/crypto/x509_generator.cpp`):
 *
 *   · `critical,CA:TRUE`
 *   · `critical,keyCertSign,cRLSign,digitalSignature`
 *
 * WHY IT IS HAND-ROLLED. Java can PARSE certificates but not CREATE them:
 * `CertificateFactory` only reads, `KeyStore` only stores what it is given,
 * and the JDK-only `sun.security.x509` classes do not exist on Android. So
 * the DER is written here, byte by byte, and then parsed back with the
 * standard factory — which also means a malformed certificate fails loudly
 * instead of silently producing a socket that dies later.
 */
object AdbTlsCertificate {

    /** The organization part of the name the device asks for. */
    const val DEFAULT_ORGANIZATION = "AdbKey-0"

    /**
     * Build a self-signed certificate around an adb key.
     *
     * @param privateKey the adb key (its public half goes into the cert)
     * @param commonName the key's fingerprint — this is what the device asks for
     * @param organization the "AdbKey-N" part of the name the device asks for
     * @param withExtensions whether to add basicConstraints and keyUsage
     */
    @JvmStatic
    @Throws(Exception::class)
    fun selfSigned(
        privateKey: PrivateKey,
        commonName: String,
        organization: String = DEFAULT_ORGANIZATION,
        withExtensions: Boolean = true,
    ): X509Certificate {
        val publicKey = RSAPublicKeyOf(privateKey as RSAPrivateCrtKey)
        val tbs = tbsCertificate(publicKey, commonName, organization, withExtensions)
        val signature = Signature.getInstance("SHA256withRSA").run {
            initSign(privateKey)
            update(tbs)
            sign()
        }
        val certificate = der(
            0x30,
            // A BIT STRING is [unused-bits byte][raw bytes] — NOT a nested TLV.
            // Wrapping the signature in a TLV makes it 259 bytes instead of 256,
            // and the device answers that with a TLS alert whose name says
            // nothing about the cause ("decode_error").
            tbs + algorithmIdentifier() + der(0x03, byteArrayOf(0x00) + signature),
        )
        return CertificateFactory.getInstance("X.509")
            .generateCertificate(certificate.inputStream()) as X509Certificate
    }

    /**
     * The public key in X.509 SubjectPublicKeyInfo DER.
     *
     * Rebuilt by hand: the JDK's own encoding is not reachable through the
     * public interface for a synthesised key, and this exact byte sequence is
     * what the fingerprint is computed over.
     *
     * ⚠ The modulus goes in as a DER INTEGER, and a DER INTEGER whose top bit
     * is set has to carry a leading 0x00 byte — otherwise it reads as a
     * negative number. Skipping that byte changes the SPKI by one byte, which
     * changes the fingerprint, which makes the device refuse the certificate
     * with a TLS alert that says nothing about the cause. It is exactly the
     * kind of one-byte bug that a "it parses fine" check cannot see.
     */
    @JvmStatic
    fun spkiDer(privateKey: PrivateKey): ByteArray {
        val key = privateKey as RSAPrivateCrtKey
        val modulus = toFixedWidth(key.modulus, AdbAuthKey.MODULUS_BYTES)
        val exponent = key.publicExponent.toByteArray().let {
            if (it.size > 1 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it
        }
        val rsaPublicKey = der(0x30, derInteger(modulus) + derInteger(exponent))
        val algorithm = der(
            0x30,
            der(0x06, oid("1.2.840.113549.1.1.1")) + der(0x05, ByteArray(0)),
        )
        // A BIT STRING is [unused-bits byte][raw bytes] — NOT a nested TLV.
        return der(0x30, algorithm + der(0x03, byteArrayOf(0x00) + rsaPublicKey))
    }

    /** A DER INTEGER: the value, with a 0x00 prefix when the top bit is set. */
    private fun derInteger(value: ByteArray): ByteArray {
        val needsPad = value.isNotEmpty() && (value[0].toInt() and 0x80) != 0
        return if (needsPad) der(0x02, byteArrayOf(0x00) + value) else der(0x02, value)
    }

    /** The public half of an adb key, as an RSAPublicKey. */
    private fun RSAPublicKeyOf(key: RSAPrivateCrtKey): RSAPublicKey =
        object : RSAPublicKey {
            override fun getAlgorithm(): String = "RSA"
            override fun getFormat(): String = "X.509"
            override fun getModulus(): java.math.BigInteger = key.modulus
            override fun getPublicExponent(): java.math.BigInteger = key.publicExponent
            override fun getEncoded(): ByteArray = throw UnsupportedOperationException("not serialisable")
        }

    private fun tbsCertificate(
        publicKey: RSAPublicKey,
        commonName: String,
        organization: String,
        withExtensions: Boolean,
    ): ByteArray {
        // Name ::= SEQUENCE OF RelativeDistinguishedName
        // RelativeDistinguishedName ::= SET OF AttributeTypeAndValue
        //
        // The device asks for "CN=<fingerprint>, O=AdbKey-0" — and X.500
        // prints the RDNs in REVERSE order of the encoding, so the DER has to
        // carry O FIRST and CN SECOND for the name to read the way the device
        // expects. Get this backwards and the JDK's own KeyManager silently
        // refuses to offer the certificate (the issuer does not match), the
        // device answers `certificate_required`, and nothing says why.
        val org = der(
            0x31,
            der(
                0x30,
                der(0x06, oid("2.5.4.10")) + der(0x0c, organization.toByteArray(Charsets.US_ASCII)),
            ),
        )
        val cn = der(
            0x31,
            der(
                0x30,
                der(0x06, oid("2.5.4.3")) + der(0x0c, commonName.toByteArray(Charsets.US_ASCII)),
            ),
        )
        val name = der(0x30, org + cn)
        val now = System.currentTimeMillis()
        val notBefore = utcTime(now - 24L * 3600 * 1000)
        val notAfter = utcTime(now + 10L * 365 * 24 * 3600 * 1000)
        val validity = der(0x30, notBefore + notAfter)
        val spki = publicKey.encoded()
        var body = der(0xA0, der(0x02, byteArrayOf(0x02))) + // version v3
            der(0x02, byteArrayOf(0x01, 0x23, 0x45, 0x67, 0x89.toByte())) + // serial
            algorithmIdentifier() +
            name + // issuer == subject: self-signed
            validity +
            name + // subject
            spki
        if (withExtensions) body += extensions()
        return der(0x30, body)
    }

    /**
     * The two extensions the real adb client puts on this certificate.
     *
     * MEASURED 2026-11-12, from the strings in `adb.exe` — they come from
     * AOSP's `packages/modules/adb/crypto/x509_generator.cpp`, and they are
     * the literal configuration strings:
     *
     *   · `critical,CA:TRUE`
     *   · `critical,keyCertSign,cRLSign,digitalSignature`
     */
    private fun extensions(): ByteArray {
        // basicConstraints: SEQUENCE { BOOLEAN TRUE } (CA:TRUE)
        val basicConstraints = der(0x30, der(0x01, byteArrayOf(0xFF.toByte())))
        // keyUsage: digitalSignature(0) + keyCertSign(5) + cRLSign(6)
        //          -> seven bits used, so one unused bit at the end.
        val keyUsage = der(0x03, byteArrayOf(0x01, 0x86.toByte()))
        val extension = { oidValue: ByteArray, value: ByteArray ->
            der(
                0x30,
                der(0x06, oidValue) +
                    der(0x01, byteArrayOf(0xFF.toByte())) + // critical
                    der(0x04, value), // extnValue: OCTET STRING
            )
        }
        val list = der(
            0x30,
            extension(oid("2.5.29.19"), basicConstraints) + // basicConstraints
                extension(oid("2.5.29.15"), keyUsage), // keyUsage
        )
        return der(0xA3, list) // [3] EXPLICIT extensions
    }

    /** The X.509 encoding of the public key (SPKI). */
    private fun RSAPublicKey.encoded(): ByteArray {
        val modulus = toFixedWidth(modulus, AdbAuthKey.MODULUS_BYTES)
        val exponent = publicExponent.toByteArray().let {
            if (it.size > 1 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it
        }
        val rsaPublicKey = der(0x30, derInteger(modulus) + derInteger(exponent))
        val algorithm = der(
            0x30,
            der(0x06, oid("1.2.840.113549.1.1.1")) + der(0x05, ByteArray(0)),
        )
        // A BIT STRING is [unused-bits byte][raw bytes] — NOT a nested TLV.
        return der(0x30, algorithm + der(0x03, byteArrayOf(0x00) + rsaPublicKey))
    }

    private fun algorithmIdentifier(): ByteArray =
        der(
            0x30,
            der(0x06, oid("1.2.840.113549.1.1.11")) + der(0x05, ByteArray(0)),
        )

    private fun oid(dotted: String): ByteArray {
        val parts = dotted.split('.').map { it.toInt() }
        val out = ByteArrayOutputStream()
        out.write((parts[0] * 40 + parts[1]).toInt())
        for (i in 2 until parts.size) {
            val chunk = ByteArray(4)
            var index = 3
            var v = parts[i]
            chunk[index--] = (v and 0x7F).toByte()
            v = v shr 7
            while (v > 0) {
                chunk[index--] = ((v and 0x7F) or 0x80).toByte()
                v = v shr 7
            }
            for (j in index + 1..3) out.write(chunk[j].toInt())
        }
        return out.toByteArray()
    }

    /** UTCTime: YYMMDDHHMMSSZ. */
    private fun utcTime(millis: Long): ByteArray {
        val cal = java.util.Calendar.getInstance()
        cal.timeInMillis = millis
        val text = String.format(
            "%02d%02d%02d%02d%02d%02dZ",
            cal.get(java.util.Calendar.YEAR) % 100,
            cal.get(java.util.Calendar.MONTH) + 1,
            cal.get(java.util.Calendar.DAY_OF_MONTH),
            cal.get(java.util.Calendar.HOUR_OF_DAY),
            cal.get(java.util.Calendar.MINUTE),
            cal.get(java.util.Calendar.SECOND),
        )
        return der(0x17, text.toByteArray(Charsets.US_ASCII))
    }

    /** One DER TLV. */
    private fun der(tag: Int, content: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(tag)
        val length = content.size
        if (length < 0x80) {
            out.write(length)
        } else {
            val bytes = ArrayList<Int>()
            var v = length
            while (v > 0) {
                bytes.add(0, v and 0xFF)
                v = v shr 8
            }
            out.write(0x80 or bytes.size)
            bytes.forEach { out.write(it) }
        }
        out.write(content)
        return out.toByteArray()
    }

    private fun toFixedWidth(value: java.math.BigInteger, width: Int): ByteArray {
        val raw = value.toByteArray()
        val out = ByteArray(width)
        val src = if (raw.size > width) raw.copyOfRange(raw.size - width, raw.size) else raw
        src.copyInto(out, width - src.size)
        return out
    }
}
