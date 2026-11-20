// khy-canary: Khy-20261116-001-SPAKE2
package com.khyos.khy_os_client.shell

import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.math.BigInteger
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.SSLSocket

/**
 * The adb *pairing* client — the App authorizing its own key on its own phone.
 *
 * WHY THIS EXISTS. A shell layer (uid 2000) is the only way to run the
 * commands that talk to the *system* rather than to this App: `input`, `am`,
 * `pm`, `settings put`, reading under `/data`. The device grants such a shell
 * only to an adb key it has authorized, and authorizing a key is what the
 * pairing protocol does. Until now this repository could only get a key
 * authorized from a computer (`pair-khyos-key.ps1`); this class does it from
 * the phone itself, so the whole "install and it lifts itself" story holds
 * without a PC ([DESIGN-ARCH-212]).
 *
 * THE PROTOCOL, in full (AOSP `packages/modules/adb`, Android 16):
 *
 *   1. TCP connect to the pairing port. The endpoint listens on the device's
 *      own loopback, so the App dials 127.0.0.1.
 *   2. TLS 1.3. The client MUST present a certificate; it may be any
 *      certificate, because the pairing server accepts every peer certificate
 *      (the 6-digit code is the trust anchor, not the certificate). The
 *      client's KeyManager must therefore hand the certificate over
 *      **regardless of the issuer list the server asks for** — the JDK's own
 *      matching logic declines it otherwise, and the device then reports
 *      "certificate_required".
 *   3. The TLS exporter output — 64 bytes under the label "adb-label\0" — is
 *      appended to the pairing code to form the SPAKE2 password. Both sides
 *      do this, and because a TLS exporter is symmetric, they end up with the
 *      same password.
 *   4. SPAKE2 over Ed25519 ([Spake2]), transcript names "adb pair client\0"
 *      and "adb pair server\0".
 *   5. 6-byte frames: version, type, payload length (big-endian). Type 0 is
 *      the SPAKE2 message, type 1 the encrypted PeerInfo.
 *   6. PeerInfo is 8192 bytes — one type byte plus 8191 bytes. This side
 *      sends ADB_RSA_PUB_KEY (0) carrying the base64 of its public key in
 *      Android's mincrypt layout ([AdbAuthKey.mincryptPublicKeyBase64]); the
 *      device replies with ADB_DEVICE_GUID (1).
 *   7. PeerInfo is encrypted with AES-128-GCM. The key is
 *      HKDF-SHA256(ikm = the 64-byte SPAKE2 key material, info = "adb
 *      pairing_auth aes-128-gcm key"); the nonce is a 12-byte counter that
 *      starts at zero.
 *
 * VERIFIED against the platform: the same protocol, implemented in
 * `scripts/adb-pairing-client.js`, was accepted by the real `adb pair`
 * client — see
 * `works/data/khy/feedback/2026-11-16-selfconnect-adbd/pairing-oracle-verified.txt`.
 *
 * WHY IT IS TESTABLE OFF-DEVICE. Everything except the TLS exporter is plain
 * Java, and the exporter can be substituted with a fixed value ([fixedKeyingMaterial])
 * so a JVM test can run the client against a local pairing server. That is how
 * this class is regression-tested without a phone in the loop.
 */
class AdbPairingClient(
    /** The identity to authorize — the App's own adb key. */
    private val key: AdbAuthKey,
    /** The 6-digit pairing code the device is showing. */
    private val code: String,
    private val host: String = "127.0.0.1",
    private val port: Int,
    private val timeoutMs: Int = 10_000,
    /**
     * Skip the TLS exporter and use this value as the keying material.
     *
     * Only for tests: a JVM has no TLS exporter, and the pairing server on the
     * other side has to agree on the value anyway, so both ends get told the
     * same constant.
     */
    private val fixedKeyingMaterial: ByteArray? = null,
) : Closeable {

    /** What a completed pairing produced. */
    data class Result(
        /** The device's GUID, as the server reported it. Empty when unknown. */
        val deviceGuid: String,
    )

    private var plainSocket: Socket? = null
    private var tlsSocket: SSLSocket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null

    /**
     * Pair with the device.
     *
     * @return the device GUID, or null when the device refused the pairing.
     */
    fun pair(): Result? {
        val socket = Socket()
        socket.connect(InetSocketAddress(host, port), timeoutMs)
        socket.soTimeout = timeoutMs
        socket.tcpNoDelay = true
        plainSocket = socket

        // TLS 1.3 with our adb key as the client certificate.
        //
        // The certificate is self-signed and its subject carries the adb key's
        // fingerprint; the pairing server accepts any certificate, so what
        // matters here is only that we present one (and that we do present it
        // even though the issuer does not match the list the server asks for).
        val certificate = AdbTlsCertificate.selfSigned(
            key.privateKey,
            key.fingerprint,
            AdbTlsCertificate.DEFAULT_ORGANIZATION,
            true,
        )
        val ssl = conscryptSocketFactory(certificate, key.privateKey)
            .createSocket(socket, host, port, false) as SSLSocket
        ssl.soTimeout = timeoutMs
        ssl.startHandshake()
        tlsSocket = ssl
        input = ssl.inputStream
        output = ssl.outputStream

        // The exporter output: both sides append it to the pairing code, so it
        // must be the same value on both — a TLS exporter is symmetric, so as
        // long as both sides use the same label they agree.
        val keying = fixedKeyingMaterial ?: exportKeyingMaterial(ssl)
        val password = code.toByteArray(Charsets.US_ASCII) + keying

        // SPAKE2, client side.
        val spake = Spake2(
            isClient = true,
            myName = CLIENT_NAME,
            theirName = SERVER_NAME,
        )
        val myMsg = spake.generateMsg(password)
        writeFrame(TYPE_SPAKE2, myMsg)

        val theirMsg = readFrame(TYPE_SPAKE2)
            ?: return null
        val keyMaterial = spake.processMsg(theirMsg) ?: return null

        // PeerInfo: our public key, in the layout the device parses.
        val peerInfo = ByteArray(PEER_INFO_SIZE)
        peerInfo[0] = PEER_INFO_TYPE_RSA_PUB_KEY.toByte()
        val publicKeyText = key.mincryptPublicKeyBase64().toByteArray(Charsets.US_ASCII)
        require(publicKeyText.size < PEER_INFO_SIZE - 1) { "公钥 base64 太长，放不进 PeerInfo" }
        publicKeyText.copyInto(peerInfo, 1)
        writeFrame(TYPE_PEER_INFO, aesEncrypt(aesKey(keyMaterial), 0, peerInfo))

        val theirPeerInfo = readFrame(TYPE_PEER_INFO) ?: return null
        val plain = aesDecrypt(aesKey(keyMaterial), 0, theirPeerInfo) ?: return null
        val guid = plain.copyOfRange(1, plain.size).toString(Charsets.US_ASCII).trimEnd(NUL_CHAR)
        return Result(deviceGuid = guid)
    }

    // ── framing ────────────────────────────────────────────────────────────

    private fun writeFrame(type: Int, payload: ByteArray) {
        val head = ByteArray(6)
        head[0] = 1.toByte()                          // protocol version
        head[1] = type.toByte()
        val len = payload.size
        head[2] = ((len ushr 24) and 0xFF).toByte()
        head[3] = ((len ushr 16) and 0xFF).toByte()
        head[4] = ((len ushr 8) and 0xFF).toByte()
        head[5] = (len and 0xFF).toByte()
        val out = output ?: throw IllegalStateException("连接已关闭")
        out.write(head)
        out.write(payload)
        out.flush()
    }

    private fun readFrame(expectType: Int): ByteArray? {
        val inp = input ?: throw IllegalStateException("连接已关闭")
        val head = ByteArray(6)
        readFully(inp, head)
        val type = head[1].toInt() and 0xFF
        val len = ((head[2].toInt() and 0xFF) shl 24) or
            ((head[3].toInt() and 0xFF) shl 16) or
            ((head[4].toInt() and 0xFF) shl 8) or
            (head[5].toInt() and 0xFF)
        if (type != expectType) return null
        if (len <= 0 || len > MAX_FRAME) return null
        val payload = ByteArray(len)
        readFully(inp, payload)
        return payload
    }

    private fun readFully(inp: InputStream, buffer: ByteArray) {
        var read = 0
        while (read < buffer.size) {
            val n = inp.read(buffer, read, buffer.size - read)
            if (n < 0) throw java.io.IOException("配对连接在读满 ${buffer.size} 字节前断开了（已读 $read）")
            read += n
        }
    }

    override fun close() {
        try {
            tlsSocket?.close()
        } catch (_: Throwable) {
            // Closing a socket that is already dead is not a failure.
        }
        try {
            plainSocket?.close()
        } catch (_: Throwable) {
            // Same.
        }
    }

    companion object {
        /** Frame type: the SPAKE2 message. */
        const val TYPE_SPAKE2 = 0

        /** Frame type: the encrypted PeerInfo. */
        const val TYPE_PEER_INFO = 1

        /** PeerInfo is a fixed-size blob. */
        const val PEER_INFO_SIZE = 8192

        /** PeerInfo type: an RSA public key. */
        const val PEER_INFO_TYPE_RSA_PUB_KEY = 0

        /** PeerInfo type: a device GUID. */
        const val PEER_INFO_TYPE_DEVICE_GUID = 1

        /**
     * The NUL byte, built at run time.
     *
     * WHY NOT A LITERAL. The transcript names and the exporter label both END
     * with a NUL, and writing that byte literally into the source makes the file
     * unreadable in diffs and breaks some editors. So it is built here instead.
     */
    private val NUL_CHAR: Char = 0.toChar()

    /** A frame bigger than this is not something we are prepared to read. */
        private const val MAX_FRAME = 1 shl 20

        /**
         * The transcript names, with the trailing NUL.
         *
         * AOSP passes `sizeof(kClientName)` — the array size, not `strlen` — so
         * both names are 16 bytes long (15 characters plus the NUL). Getting
         * this wrong produces a pairing that fails with no visible reason.
         */
        val CLIENT_NAME: ByteArray = ("adb pair client" + NUL_CHAR).toByteArray(Charsets.US_ASCII)
        val SERVER_NAME: ByteArray = ("adb pair server" + NUL_CHAR).toByteArray(Charsets.US_ASCII)

        /**
         * The TLS exporter label, with its trailing NUL (sizeof("adb-label") = 10).
         */
        val EXPORT_LABEL: String = "adb-label" + NUL_CHAR

        /**
         * The TLS exporter output: 64 bytes.
         *
         * Conscrypt exposes this as `sslExportKeyingMaterial`; it is reached
         * reflectively because the method is not part of the public Android SDK
         * surface, and a hard reference to it would make this class refuse to
         * load on a platform that lacks it — which should degrade to "this
         * device cannot pair", not "the whole app crashes".
         *
         * WHY THE SOCKET MUST BE A CONSCRYPT SOCKET (measured 2026-11-17, on a
         * real Android 16 device). The exporter belongs to Conscrypt and only
         * accepts sockets Conscrypt itself created (`Conscrypt.toConscrypt`
         * rejects everything else). Android's default `SSLContext` already
         * produces such sockets, so that half is satisfied in practice — but
         * it is not what went wrong first.
         *
         * WHAT ACTUALLY WENT WRONG (measured 2026-11-17, same device). The
         * first implementation called `sslExportKeyingMaterial`, the
         * pre-Android-9 spelling. `Class.getMethod` then throws
         * NoSuchMethodException whose message lists the parameter types we
         * asked for:
         *
         *   com.android.org.conscrypt.Conscrypt.sslExportKeyingMaterial
         *     [class javax.net.ssl.SSLSocket, class java.lang.String,
         *      class [B, int]
         *
         * which reads exactly like "your socket has the wrong type" and cost
         * two debugging rounds chasing socket factories while the handshake
         * had already succeeded. `dexdump` on the device's own
         * `/apex/com.android.conscrypt/javalib/conscrypt.jar` settles it:
         *
         *   invoke-static {}, Conscrypt;.exportKeyingMaterial:(Ljavax/net/ssl/SSLSocket;...)
         *
         * no `ssl` prefix. The chain below tries each name the helper has
         * shipped under and reports every failure — a silent "one of these
         * worked" is how a wrong hypothesis survives.
         */
        private fun exportKeyingMaterial(socket: SSLSocket): ByteArray {
            val conscrypt = try {
                Class.forName("com.android.org.conscrypt.Conscrypt")
            } catch (e: Throwable) {
                throw IllegalStateException("这台设备没有 Conscrypt，配对无法完成：${e.javaClass.name}")
            }
            val attempts = mutableListOf<String>()
            for (methodName in EXPORT_METHOD_NAMES) {
                try {
                    val method = conscrypt.getMethod(
                        methodName,
                        SSLSocket::class.java,
                        String::class.java,
                        ByteArray::class.java,
                        Int::class.javaPrimitiveType,
                    )
                    val out = method.invoke(null, socket, EXPORT_LABEL, ByteArray(0), EXPORT_LENGTH)
                    return out as ByteArray
                } catch (e: Throwable) {
                    attempts += "$methodName → ${causeChain(e)}"
                }
            }
            throw IllegalStateException(
                "这台设备的 Conscrypt 给不出 TLS 导出密钥（socket=${socket.javaClass.name}）："
                    + attempts.joinToString("; ")
            )
        }

        /** The throwable and each of its causes, so a wrapped failure is not a one-word mystery. */
        private fun causeChain(e: Throwable): String =
            generateSequence(e as Throwable?) { it.cause }
                .take(4)
                .joinToString(" ← ") { "${it.javaClass.name}: ${it.message}" }

        /**
         * Every name the Conscrypt exporter has shipped under.
         *
         * `exportKeyingMaterial` is the current one (Android 9+, confirmed by
         * `dexdump` on Android 16); `sslExportKeyingMaterial` is the older
         * spelling, kept so a platform that still uses it can pair too.
         */
        private val EXPORT_METHOD_NAMES = listOf("exportKeyingMaterial", "sslExportKeyingMaterial")

        /**
         * A socket factory that presents our certificate.
         *
         * The KeyManager must hand the certificate over **regardless of the
         * issuer list the pairing server asks for** — the JDK's own matching
         * logic declines it otherwise, and the device then reports
         * "certificate_required" instead of pairing.
         *
         * Conscrypt is what makes this a Conscrypt socket: Android installs it
         * as a JSSE provider, so `SSLContext.getInstance("TLS", provider)`
         * yields a context that both carries our KeyManager and produces
         * sockets `Conscrypt.exportKeyingMaterial` accepts. Off-device (JVM
         * tests) there is no Conscrypt and the plain default provider is used
         * — the same object then runs in the unit tests, where the exporter is
         * never called anyway (see [fixedKeyingMaterial]).
         */
        private fun conscryptSocketFactory(
            clientCertificate: java.security.cert.X509Certificate,
            clientKey: java.security.PrivateKey,
        ): javax.net.ssl.SSLSocketFactory {
            val trustAll = arrayOf<javax.net.ssl.X509TrustManager>(
                object : javax.net.ssl.X509TrustManager {
                    override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>?, authType: String?) = Unit
                    override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>?, authType: String?) = Unit
                    override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = emptyArray()
                })
            val keyManager = arrayOf<javax.net.ssl.X509KeyManager>(object : javax.net.ssl.X509KeyManager {
                override fun getClientAliases(
                    keyType: String?,
                    issuers: Array<out java.security.Principal>?,
                ): Array<String> = arrayOf("khyos-adb")

                override fun chooseClientAlias(
                    keyType: Array<String>?,
                    issuers: Array<out java.security.Principal>?,
                    socket: Socket?,
                ): String = "khyos-adb"

                override fun getCertificateChain(alias: String?): Array<java.security.cert.X509Certificate>? =
                    arrayOf(clientCertificate)

                override fun getPrivateKey(alias: String?): java.security.PrivateKey = clientKey

                override fun getServerAliases(
                    keyType: String?,
                    issuers: Array<out java.security.Principal>?,
                ): Array<String> = emptyArray()

                override fun chooseServerAlias(
                    keyType: String?,
                    issuers: Array<out java.security.Principal>?,
                    socket: Socket?,
                ): String? = null
            })
            // Conscrypt's provider when it is installed; the JVM default otherwise.
            val provider = try {
                Class.forName("com.android.org.conscrypt.OpenSSLProvider")
                    .getDeclaredConstructor().newInstance() as java.security.Provider
            } catch (_: Throwable) {
                null
            }
            val context = if (provider != null) {
                javax.net.ssl.SSLContext.getInstance("TLS", provider)
            } else {
                javax.net.ssl.SSLContext.getInstance("TLS")
            }
            context.init(keyManager, trustAll, java.security.SecureRandom())
            return context.socketFactory
        }

        /** How many bytes of keying material the protocol wants. */
        const val EXPORT_LENGTH = 64

        /** The AES key: HKDF-SHA256 over the SPAKE2 key material. */
        fun aesKey(keyMaterial: ByteArray): ByteArray {
            val info = "adb pairing_auth aes-128-gcm key".toByteArray(Charsets.US_ASCII)
            return hkdf(keyMaterial, ByteArray(0), info, 16)
        }

        /** HKDF (RFC 5869) with SHA-256. */
        fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
            val mac = Mac.getInstance("HmacSHA256")
            // Extract. An empty salt and a salt of HashLen zeros are the same
            // thing here: HMAC pads both to the block size with zeros.
            val prk = mac.apply {
                init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
                update(ikm)
            }.doFinal()
            // Expand.
            val out = ByteArray(length)
            var previous = ByteArray(0)
            var offset = 0
            var counter = 1
            while (offset < length) {
                val block = mac.apply {
                    init(SecretKeySpec(prk, "HmacSHA256"))
                    update(previous)
                    update(info)
                    update(counter.toByte())
                }.doFinal()
                val take = minOf(block.size, length - offset)
                block.copyInto(out, offset, 0, take)
                offset += take
                previous = block
                counter++
            }
            return out
        }

        /** The GCM nonce: a 12-byte counter, little-endian in the first 8 bytes. */
        fun nonce(sequence: Long): ByteArray {
            val nonce = ByteArray(12)
            var value = sequence
            for (i in 0 until 8) {
                nonce[i] = (value and 0xFF).toByte()
                value = value ushr 8
            }
            return nonce
        }

        /** Encrypt with AES-128-GCM; the tag is appended. */
        fun aesEncrypt(key: ByteArray, sequence: Long, plain: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.ENCRYPT_MODE,
                SecretKeySpec(key, 0, key.size, "AES"),
                GCMParameterSpec(128, nonce(sequence)),
            )
            return cipher.doFinal(plain)
        }

        /** Decrypt with AES-128-GCM; null when the tag does not check out. */
        fun aesDecrypt(key: ByteArray, sequence: Long, payload: ByteArray): ByteArray? = try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, 0, key.size, "AES"),
                GCMParameterSpec(128, nonce(sequence)),
            )
            cipher.doFinal(payload)
        } catch (_: Throwable) {
            null
        }
    }
}
