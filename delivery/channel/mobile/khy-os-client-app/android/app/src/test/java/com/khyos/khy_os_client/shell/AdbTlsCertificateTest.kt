package com.khyos.khy_os_client.shell

import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.RSAPrivateCrtKey
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The client certificate the device demands.
 *
 * WHY THE SHAPE IS PINNED HERE. MEASURED 2026-11-12: the device answers our
 * TLS ClientHello with a fatal `certificate_required` alert — the wireless
 * debugging transport is mutual TLS. The real adb client generates the
 * certificate itself, and the strings still inside `adb.exe` say exactly how
 * (AOSP's `packages/modules/adb/crypto/x509_generator.cpp`):
 *
 *   · the name is "Android"
 *   · `critical,CA:TRUE`
 *   · `critical,keyCertSign,cRLSign,digitalSignature`
 *
 * A certificate that differs in any of those is not the certificate the
 * device expects, and the failure is a TLS alert whose name says nothing
 * about the cause. So the shape is asserted here rather than discovered on a
 * phone, one silent alert at a time.
 */
class AdbTlsCertificateTest {

    private fun newKey(): AdbAuthKey = AdbAuthKey.generate()

    @Test
    fun `the subject is the fingerprint and AdbKey-0, in the order the device asks for`() {
        // MEASURED 2026-11-12 — the device's CertificateRequest says:
        //   "certificate authorities": [ CN=<fingerprint>, O=AdbKey-0 ]
        // and X.500 prints the RDNs in reverse order of the encoding, so the
        // DER must carry O first and CN second. Get it backwards and the JDK
        // refuses to offer the certificate at all (the issuer does not match).
        val key = newKey()
        val cert = AdbTlsCertificate.selfSigned(key.privateKey, key.fingerprint)
        val subject = cert.subjectX500Principal.name
        assertTrue(
            "subject 应当是 CN=<指纹>, O=AdbKey-0，实际是 $subject",
            subject.replace(" ", "").contains("CN=${key.fingerprint},O=AdbKey-0"),
        )
        assertEquals("自签证书的签发者必须等于主体", subject, cert.issuerX500Principal.name)
    }

    @Test
    fun `the fingerprint is the sha256 of the public key's spki, uppercase`() {
        // The definition was matched against the device's own request: the
        // sha256 of the SubjectPublicKeyInfo DER matches; the sha256 of the
        // bare modulus does not.
        val key = newKey()
        assertEquals(64, key.fingerprint.length)
        assertTrue(key.fingerprint.all { it in '0'..'9' || it in 'A'..'F' })
        val expected = java.security.MessageDigest.getInstance("SHA-256")
            .digest(key.spkiDer)
            .joinToString("") { "%02X".format(it) }
        assertEquals(expected, key.fingerprint)
    }

    @Test
    fun `the certificate carries the adb key's own public half`() {
        val key = newKey()
        val cert = AdbTlsCertificate.selfSigned(key.privateKey, key.fingerprint)
        assertNotNull(cert)
        val certKey = cert.publicKey as java.security.interfaces.RSAPublicKey
        val privateKey = key.privateKey as RSAPrivateCrtKey
        // The device matches this against the key it authorized at pairing
        // time. A certificate built from a different key is worthless here.
        assertEquals(privateKey.modulus, certKey.modulus)
        assertEquals(privateKey.publicExponent, certKey.publicExponent)
    }

    @Test
    fun `the certificate is self-signed`() {
        val key = newKey()
        val cert = AdbTlsCertificate.selfSigned(key.privateKey, "Android")
        assertEquals(cert.subjectX500Principal.name, cert.issuerX500Principal.name)
        // And the signature verifies with the certificate's own key.
        val tbs = cert.tbsCertificate
        val signature = cert.signature
        val verifier = Signature.getInstance("SHA256withRSA").apply {
            initVerify(cert.publicKey)
            update(tbs)
        }
        assertTrue("自签名必须验得过", verifier.verify(signature))
    }

    @Test
    fun `the certificate carries the two extensions adb puts on it`() {
        val key = newKey()
        val cert = AdbTlsCertificate.selfSigned(key.privateKey, "Android")
        val oids = cert.criticalExtensionOIDs ?: emptySet()
        // basicConstraints (2.5.29.19) and keyUsage (2.5.29.15), both critical.
        assertTrue("必须有 basicConstraints: $oids", oids.contains("2.5.29.19"))
        assertTrue("必须有 keyUsage: $oids", oids.contains("2.5.29.15"))
    }

    @Test
    fun `the certificate says it is a CA with the adb key usages`() {
        val key = newKey()
        val cert = AdbTlsCertificate.selfSigned(key.privateKey, "Android")
        // basicConstraints: CA:TRUE. Java reports an unlimited path length as
        // Integer.MAX_VALUE (and -1 would mean "not a CA").
        assertTrue("必须是 CA", cert.basicConstraints >= 0)
        // keyUsage: digitalSignature | keyCertSign | cRLSign
        //          (X509Certificate.getKeyUsage returns one boolean per bit)
        val usage = cert.keyUsage
        assertNotNull("必须有 keyUsage", usage)
        assertTrue("digitalSignature", usage[0])
        assertTrue("keyCertSign", usage[5])
        assertTrue("cRLSign", usage[6])
    }

    @Test
    fun `two certificates from the same key have the same public half`() {
        // The device matches on the key, so regenerating the certificate (for
        // example after a reboot) must not change what it identifies.
        val key = newKey()
        val first = AdbTlsCertificate.selfSigned(key.privateKey, "Android")
        val second = AdbTlsCertificate.selfSigned(key.privateKey, "Android")
        val digest = MessageDigest.getInstance("SHA-256")
        assertArrayEquals(
            digest.digest(first.publicKey.encoded),
            digest.digest(second.publicKey.encoded),
        )
    }
}
