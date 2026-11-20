// khy-canary: Khy-20261112-010-BOOTSTRAP
package com.khyos.khy_os_client.shell

import java.io.BufferedInputStream
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/**
 * AdbClient — khyos speaking the adb host protocol to the phone's OWN adbd.
 *
 * WHY THIS EXISTS. This is the piece that makes "install khyos and it lifts
 * itself" possible: the app opens a shell on its own device through the
 * device's wireless-debugging endpoint, and every command it runs there is a
 * uid-2000 (shell) command. No third-party elevation app, no PC, no root.
 *
 * THE BYTES ARE MEASURED, NOT RECALLED. Everything below was captured from
 * the REAL adb client talking to a REAL phone (2026-11-12), with a MITM in
 * the middle. Three measurements contradict what most write-ups say, and
 * each of them fails SILENTLY — a broken handshake looks exactly like "the
 * service is off" on a phone:
 *
 *   1. the 6th header word is `command XOR 0xffffffff`, not a constant;
 *   2. the transport starts in the CLEAR and is upgraded mid-handshake: the
 *      client sends a plaintext CNXN, the device answers `STLS`, the client
 *      echoes `STLS`, and only then does the TLS handshake happen — the rest
 *      of the adb protocol runs inside the TLS session;
 *   3. the auth challenge is signed AS-IS — the platform treats the 20-byte
 *      token as an already-hashed digest, so "RSA over SHA-1(token)" is wrong
 *      (see [AdbAuthKey] for the recovered PKCS#1 block).
 *
 * WHY IT IS PURE. No `android.*` imports: the same class runs in the app, in
 * a JVM unit test, and in a host-side harness that talks to a real phone.
 */
class AdbClient(
    private val socket: Socket,
    private val key: AdbAuthKey,
    private val host: String = "",
    private val port: Int = 0,
    /**
     * The name the client certificate carries.
     *
     * MEASURED 2026-11-12: the device's adbd compares the client certificate
     * against the key it has authorized, and that key carries the adb user
     * name ("user@host"). A certificate whose subject says something else is
     * not the same key, and the device hangs up.
     */
    private val clientName: String = DEFAULT_CLIENT_NAME,
    /** Whether the client certificate carries basicConstraints and keyUsage. */
    private val withExtensions: Boolean = true,
) : Closeable {

    /** What a shell command produced. */
    data class ExecResult(
        val output: String,
        val error: String,
        val exitCode: Int,
    )

    private var input: InputStream = socket.getInputStream()
    private var output: OutputStream = socket.getOutputStream()

    /** Set once the transport has been upgraded to TLS, so close() can close it. */
    private var tlsSocket: SSLSocket? = null

    /** Our own stream ids. The real client starts at 4407; the value is ours. */
    private var nextLocalId = 4407

    /**
     * CNXN + (optional TLS upgrade) + AUTH: announce ourselves and answer the
     * device's challenge.
     *
     * MEASURED against a real phone (2026-11-12), the plain transport:
     *
     *   client -> CNXN
     *   device -> AUTH arg0=1 len=20   the challenge
     *   client -> AUTH arg0=2 len=256  our signature
     *
     * …and over TLS (the wireless-debugging endpoint), per AOSP
     * `adb.cpp` `handle_packet` + `daemon/adb_wifi.cpp`
     * `adbd_wifi_secure_connect` (read 2026-11-17 in the Android 16 tree):
     *
     *   client -> CNXN     plaintext
     *   device -> STLS     because the transport was registered with use_tls
     *   client -> STLS     the same 24 bytes, echoed back
     *   [TLS handshake — the client certificate is the credential]
     *   device -> CNXN     its banner; that is the whole auth in TLS mode
     *
     * THERE IS NO AUTH CHALLENGE OVER TLS: `handle_packet` ignores A_AUTH when
     * `use_tls` is set, and authentication is the client certificate. So the
     * device's CNXN after the handshake means "online", and this method
     * returns right there.
     *
     * WHY THE CLIENT MUST NOT RESEND CNXN HERE (the 2026-11-12 measurement
     * recorded a second STLS and treated it as an open question; the AOSP
     * source answers it). If the client repeats its CNXN after the upgrade,
     * the device runs `handle_new_connection` again, sees `use_tls` already
     * set, and calls `send_tls_request` — a SECOND STLS. Echoing that makes
     * the device start a new TLS handshake over a session that is already
     * established, and it hangs up. `client/auth.cpp` `adb_auth_tls_handshake`
     * is explicit about the correct behaviour: "Handshake succeeded. Waiting
     * for CNXN packet..." — the client says nothing more.
     */
    fun handshake(features: String = FEATURES) {
        send(AdbProtocol.encodeCnxn(features))
        var challenge: ByteArray? = null
        var insideTls = false
        while (challenge == null) {
            val packet = readPacket()
            when (packet.header.command) {
                AdbProtocol.CMD_CNXN ->
                    if (insideTls) {
                        // The device's post-handshake banner: in TLS mode the
                        // certificate was the auth, so we are online now.
                        return
                    }
                // In the clear the banner arrives only after we sign, so a
                // CNXN here is not the end of the handshake.
                AdbProtocol.CMD_STLS -> {
                    check(!insideTls) {
                        "设备在 TLS 会话里又发了一次 STLS：多半是本端在升级后重发了 CNXN"
                    }
                    // Echo it verbatim, then upgrade on the same socket. The
                    // banner is NOT repeated — see the doc above.
                    send(packet.raw)
                    upgradeToTls()
                    insideTls = true
                }
                AdbProtocol.CMD_AUTH -> {
                    require(packet.header.arg0 == AdbProtocol.AUTH_TOKEN) {
                        "expected an AUTH token, got arg0=${packet.header.arg0}"
                    }
                    require(packet.payload.size == AdbAuthKey.TOKEN_BYTES) {
                        "auth challenge is ${packet.payload.size} bytes, expected ${AdbAuthKey.TOKEN_BYTES}"
                    }
                    challenge = packet.payload
                }
                else -> Unit
            }
        }
        send(AdbProtocol.encodeAuthSignature(key.signChallenge(challenge)))
    }

    /**
     * Run one command in a shell on the device and collect its output.
     *
     * The service string is `shell:<command>` — the classic service. It is
     * used on purpose: `cmd:` (the no-PTY service) is newer and not every
     * device build offers it, while `shell:` is what every adbd has.
     *
     * @param command the shell command line
     * @param timeoutMs how long to wait for the stream to close
     */
    fun exec(command: String, timeoutMs: Int): ExecResult {
        val localId = nextLocalId++
        send(AdbProtocol.encodeOpen(localId, "shell:$command"))

        // The device acknowledges the OPEN before any output arrives.
        var deviceId = 0
        while (true) {
            val packet = readPacket()
            if (packet.header.command == AdbProtocol.CMD_OKAY &&
                packet.header.arg1 == localId
            ) {
                deviceId = packet.header.arg0
                break
            }
            if (packet.header.command == AdbProtocol.CMD_CLSE) {
                return ExecResult("", "设备拒绝了这次执行", -1)
            }
        }

        val collected = StringBuilder()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val remaining = (deadline - System.currentTimeMillis()).toInt()
            if (remaining <= 0) break
            socket.soTimeout = remaining
            val packet = try {
                readPacket()
            } catch (e: java.net.SocketTimeoutException) {
                break
            }
            when (packet.header.command) {
                AdbProtocol.CMD_WRTE -> {
                    collected.append(String(packet.payload, Charsets.UTF_8))
                    // Acknowledge every chunk, or the device stops sending.
                    send(AdbProtocol.encode(AdbProtocol.CMD_OKAY, localId, deviceId))
                }
                AdbProtocol.CMD_CLSE -> return ExecResult(collected.toString(), "", 0)
                AdbProtocol.CMD_OKAY -> Unit
                else -> Unit
            }
        }
        return ExecResult(collected.toString(), "", -1)
    }

    /**
     * Upgrade the transport to TLS, in place.
     *
     * The device asks for it with STLS; from then on the adb protocol runs
     * inside the TLS session. The socket is layered rather than replaced, so
     * the TCP connection (and whatever the device already sent) survives.
     *
     * The device ALSO demands a client certificate (measured: a fatal
     * `certificate_required` alert when we present none), so the adb key
     * goes into the handshake as a self-signed certificate. See
     * [AdbTlsCertificate] for why that is the right shape.
     */
    private fun upgradeToTls() {
        // The certificate's subject IS the adb key's identity: the device asks
        // for "CN=<fingerprint>, O=AdbKey-N" by name. (MEASURED 2026-11-12 —
        // see AdbTlsCertificate.)
        val certificate = AdbTlsCertificate.selfSigned(
            key.privateKey,
            key.fingerprint,
            AdbTlsCertificate.DEFAULT_ORGANIZATION,
            withExtensions,
        )
        val ssl = socketFactory(certificate, key.privateKey)
            .createSocket(socket, host, port, false) as SSLSocket
        ssl.soTimeout = socket.soTimeout
        ssl.startHandshake()
        tlsSocket = ssl
        // The SSLSocket's own stream is already buffered; wrapping it again
        // only adds a layer that can hold records the TLS layer still wants.
        input = ssl.inputStream
        output = ssl.outputStream
    }

    /** Send one packet. */
    private fun send(packet: ByteArray) {
        output.write(packet)
        output.flush()
    }

    /** Read one packet: a 24-byte header plus its payload. */
    private fun readPacket(): Packet {
        val headerBytes = ByteArray(AdbProtocol.HEADER_SIZE)
        readFully(headerBytes)
        val header = AdbProtocol.decodeHeader(headerBytes)
            ?: throw IllegalStateException("adb header could not be decoded")
        val payload = if (header.dataLength > 0) ByteArray(header.dataLength) else ByteArray(0)
        if (payload.isNotEmpty()) readFully(payload)
        return Packet(header, payload, headerBytes)
    }

    private fun readFully(buffer: ByteArray) {
        var read = 0
        while (read < buffer.size) {
            val n = input.read(buffer, read, buffer.size - read)
            if (n < 0) throw java.io.IOException("adb connection closed after $read of ${buffer.size} bytes")
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
            socket.close()
        } catch (_: Throwable) {
            // Same.
        }
    }

    private data class Packet(
        val header: AdbProtocol.Header,
        val payload: ByteArray,
        /** The raw 24 header bytes, so a STLS packet can be echoed verbatim. */
        val raw: ByteArray,
    )

    companion object {
        /**
         * The feature banner we advertise.
         *
         * Short on purpose: we only need the shell service. `cmd` is what
         * makes the device offer the no-PTY `cmd:` service, and `shell_v2`
         * keeps the device's behaviour identical to a real adb client's.
         */
        const val FEATURES = "host::features=cmd,shell_v2"

        /**
         * The default name on the client certificate.
         *
         * The device compares the certificate against the key it authorized,
         * and that key carries the adb user name. For khyos' own key the name
         * is whatever was registered at pairing time — the app passes its own
         * in; this default only matters for a key that was never paired.
         */
        const val DEFAULT_CLIENT_NAME = "khyos-adb"

        /**
         * Open a connection and complete the handshake.
         *
         * The socket starts in the clear on purpose: the device decides
         * whether to upgrade to TLS (it answers a plaintext CNXN with STLS).
         * Starting with TLS makes the device hang up.
         *
         * @param timeoutMs how long the whole handshake may take
         * @param tls kept for the callers' intent — the handshake adapts to
         *   whatever the device offers, so this changes nothing on the wire.
         */
        @JvmStatic
        @Throws(Exception::class)
        fun connect(
            host: String,
            port: Int,
            key: AdbAuthKey,
            timeoutMs: Int = 8000,
            tls: Boolean = true,
            features: String = FEATURES,
            clientName: String = DEFAULT_CLIENT_NAME,
            withExtensions: Boolean = true,
        ): AdbClient {
            val socket = Socket().apply {
                connect(InetSocketAddress(host, port), timeoutMs)
                soTimeout = timeoutMs
                tcpNoDelay = true
            }
            val client = AdbClient(socket, key, host, port, clientName, withExtensions)
            try {
                // `tls` says whether an STLS upgrade is EXPECTED. A device
                // that never offers it (a plain-TCP adbd) is fine too: the
                // handshake simply continues in the clear.
                client.handshake(features)
            } catch (e: Throwable) {
                client.close()
                throw e
            }
            return client
        }

        /**
         * A socket factory that accepts any server certificate, and presents
         * the adb key as the client certificate the device demands.
         *
         * WHY THAT IS NOT THE SLOPPY CHOICE IT LOOKS LIKE. The endpoint we
         * connect to is the phone's OWN adbd, on the phone's OWN network
         * interface — the app is talking to itself, over a link the platform
         * already authenticated. The device's certificate is not something we
         * can pin (it is generated per device and never published), and the
         * security that matters here is not "is this really the phone" but
         * "is the phone talking to a stranger": that is exactly what the AUTH
         * challenge answers. We prove ourselves to the device; the device's
         * certificate is not what we are verifying here.
         */
        @JvmStatic
        fun socketFactory(
            clientCertificate: X509Certificate? = null,
            clientKey: java.security.PrivateKey? = null,
        ): SSLSocketFactory {
            val trustAll = arrayOf<javax.net.ssl.X509TrustManager>(object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) = Unit
                override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) = Unit
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            })
            val keyManager = if (clientCertificate != null && clientKey != null) {
                arrayOf<javax.net.ssl.X509KeyManager>(object : javax.net.ssl.X509KeyManager {
                    override fun getClientAliases(
                        keyType: String?,
                        issuers: Array<out java.security.Principal>?,
                    ): Array<String> = arrayOf("khyos-adb")

                    override fun chooseClientAlias(
                        keyType: Array<String>?,
                        issuers: Array<out java.security.Principal>?,
                        socket: Socket?,
                    ): String = "khyos-adb"

                    override fun getCertificateChain(alias: String?): Array<X509Certificate>? =
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
            } else {
                null
            }
            val context = SSLContext.getInstance("TLS")
            context.init(keyManager, trustAll, SecureRandom())
            return context.socketFactory
        }

        /** A socket factory that accepts any server certificate and no client cert. */
        @JvmStatic
        fun trustAllSocketFactory(): SSLSocketFactory = socketFactory()
    }
}
