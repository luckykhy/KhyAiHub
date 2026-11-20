// khy-canary: Khy-20261112-001-SHIZUKU0
package com.khyos.khy_os_client.shell

/**
 * AdbProtocol — the wire format of the adb host protocol, reduced to the
 * pieces khyos needs to become its own privileged-agent bootstrapper.
 *
 * WHY THIS EXISTS. The goal is a khyos that needs no third-party privilege
 * app: the phone keeps exactly one APK, and that APK can raise its own
 * uid-2000 agent. An app cannot grant itself shell — but on Android 11+ the
 * device's own adbd exposes a wireless-debugging endpoint on loopback, and an
 * app that has paired with it can open a shell. That is exactly how a
 * third-party elevation agent starts itself without a computer (verified: its
 * own classes talk to `127.0.0.1` over the `_adb-tls-pairing._tcp` endpoint —
 * see [DESIGN-ARCH-212]).
 *
 * WHY THE BYTES HERE ARE MEASURED, NOT RECALLED. The framing has details
 * that silently break the handshake when wrong, and on a phone a broken
 * handshake is indistinguishable from "the service is off". So every constant
 * below was captured from the REAL adb client on this machine
 * (`platform-tools/adb.exe` connecting to a local fake adbd, 2026-11-12) and
 * pinned as golden vectors in `AdbProtocolTest`. Three of those measurements
 * contradict what most people remember:
 *
 *   · the 6th header word ("magic") is NOT the constant 0xffffffff — it is
 *     the command XORed with 0xffffffff. Measured: CNXN -> 0xb1a7b1bc,
 *     OPEN -> 0xb1baafb0.
 *   · the 5th header word ("data_crc32") is NOT a CRC32 — it is the sum of
 *     the payload bytes, and only for CNXN. Measured: 0x701d for the 286-byte
 *     banner, 0 for the OPEN packet.
 *   · the CNXN payload has NO trailing NUL: the captured payload is exactly
 *     286 bytes of "host::features=...".
 *
 * A wrong magic or a stray NUL does not error out — it just never completes,
 * which on a phone looks like "elevation is off". Hence: measured, not guessed.
 *
 * This class is deliberately PURE (no android.* imports, no IO): it is the
 * piece that must be provable offline, in a JVM unit test, against the
 * captured golden vectors.
 */
object AdbProtocol {

    /** Header size in bytes: cmd, arg0, arg1, data_length, data_crc32, magic. */
    const val HEADER_SIZE = 24

    /**
     * The 6th header word is `command XOR 0xffffffff`, not a fixed constant.
     * Measured on 2026-11-12 (see the class doc).
     *
     * Written as -1 because 0xffffffff does not fit in a signed Int literal.
     */
    const val MAGIC_INVERT = -1

    /** Protocol version this client speaks (arg0 of CNXN). */
    const val VERSION_1_1 = 0x01000001

    /** Max payload we advertise (arg1 of CNXN). The real client uses 1 MiB. */
    const val MAX_PAYLOAD = 1024 * 1024

    // ── commands (first header word, ASCII) ──────────────────────────────────
    const val CMD_CNXN = "CNXN"
    const val CMD_AUTH = "AUTH"
    const val CMD_OPEN = "OPEN"
    const val CMD_OKAY = "OKAY"
    const val CMD_CLSE = "CLSE"
    const val CMD_WRTE = "WRTE"

    /**
     * The TLS upgrade command.
     *
     * MEASURED 2026-11-12 against a REAL device (MITM between the real adb
     * client and the real adbd):
     *
     *   client -> CNXN   (plaintext, 286-byte banner)
     *   device -> STLS   (24 bytes, arg0=1, arg1=0, len=0)
     *   client -> STLS   (the same 24 bytes, echoed back)
     *   ... TLS handshake starts here, and the rest of the adb protocol runs
     *       INSIDE the TLS session ...
     *
     * So the transport starts in the clear and is upgraded mid-handshake.
     * Starting with TLS instead makes the device hang up: it is waiting for a
     * plaintext CNXN, and a ClientHello reads as garbage to it.
     */
    const val CMD_STLS = "STLS"

    // ── AUTH types (arg0 of an AUTH packet) ─────────────────────────────────
    /**
     * The device challenges the client with a 20-byte token.
     *
     * MEASURED 2026-11-12 from the real adb client talking to a fake adbd:
     * the device sent `AUTH arg0=1 len=20`, and the client answered with
     * `AUTH arg0=2 len=256` (the RSA signature over that token).
     */
    const val AUTH_TOKEN = 1

    /**
     * The client's answer: the 256-byte RSA signature over the challenge.
     *
     * The payload is the signature ALONE — no public key, no length prefix.
     * That is the modern adb layout; the older one (public key first, then a
     * signature) is what most write-ups describe, and it is wrong for a
     * current platform-tools.
     */
    const val AUTH_SIGNATURE = 2

    /** The client's public key (used by the pairing flow, not by the connect flow). */
    const val AUTH_RSAPUBLICKEY = 3

    /** The device's challenge (the older layout's second round). */
    const val AUTH_RSAchallenge = 4

    /** A decoded packet header. */
    data class Header(
        val command: String,
        val arg0: Int,
        val arg1: Int,
        val dataLength: Int,
        val dataCrc32: Int,
        val magic: Int,
    ) {
        /** True when the magic word matches this command's expected value. */
        val magicValid: Boolean
            get() = magic == expectedMagic(command)
    }

    /** The magic value a packet with this command must carry. */
    fun expectedMagic(command: String): Int = commandToInt(command) xor MAGIC_INVERT

    /** "CNXN" -> 0x4e584e43 (little-endian read of the 4 ASCII bytes). */
    fun commandToInt(command: String): Int {
        require(command.length == 4) { "adb command must be 4 ASCII chars: $command" }
        var v = 0
        for (i in 0 until 4) {
            val c = command[i].code
            require(c in 32..126) { "adb command must be printable ASCII: $command" }
            v = v or ((c and 0xFF) shl (8 * i))
        }
        return v
    }

    /** CRC32 (the zlib/PNG variant) over the payload. */
    fun crc32(payload: ByteArray): Int {
        var crc = -1
        for (b in payload) {
            crc = (crc ushr 8) xor CRC_TABLE[(crc xor b.toInt()) and 0xFF]
        }
        return crc xor -1
    }

    /**
     * The checksum adb puts in the `data_crc32` header word.
     *
     * MEASURED, and the name is a lie: it is **not** a CRC32. For the CNXN
     * banner the real client sent 0x701d, which is exactly the SUM of the
     * 286 payload bytes — verified against the captured bytes, and no CRC
     * variant (zlib / BZIP2 / MPEG-2 / adler / fnv) reproduces that value.
     *
     * And it is only filled in for CNXN: the captured OPEN packet ("shell:echo
     * hello", 17 bytes) carried 0, even though the byte sum of its payload is
     * 1573. So the rule the real client follows is:
     *
     *   CNXN  -> sum of the payload bytes
     *   other -> 0
     *
     * The value is advisory: our fake adbd answered with a real zlib CRC32 and
     * the genuine client accepted the reply, so a peer does not reject a wrong
     * value here. CNXN still gets the exact sum, because that is what the real
     * client sends and there is no reason to differ from it.
     */
    fun payloadChecksum(command: String, payload: ByteArray): Int {
        if (command != CMD_CNXN) return 0
        var sum = 0L
        for (b in payload) sum += (b.toInt() and 0xFF)
        return (sum and 0xFFFFFFFFL).toInt()
    }

    /**
     * Build a complete packet: 24-byte header + payload.
     *
     * @param command one of the CMD_* constants
     * @param arg0 command-specific first argument
     * @param arg1 command-specific second argument
     * @param payload the body (may be empty)
     */
    fun encode(command: String, arg0: Int, arg1: Int, payload: ByteArray = ByteArray(0)): ByteArray {
        val out = ByteArray(HEADER_SIZE + payload.size)
        out[0] = command[0].code.toByte()
        out[1] = command[1].code.toByte()
        out[2] = command[2].code.toByte()
        out[3] = command[3].code.toByte()
        writeIntLE(out, 4, arg0)
        writeIntLE(out, 8, arg1)
        writeIntLE(out, 12, payload.size)
        writeIntLE(out, 16, payloadChecksum(command, payload))
        writeIntLE(out, 20, expectedMagic(command))
        payload.copyInto(out, HEADER_SIZE)
        return out
    }

    /**
     * The opening packet.
     *
     * The payload is the feature string the client offers. The real client
     * sends "host::features=shell_v2,cmd,stat_v2,..." with **no trailing
     * NUL** (measured: exactly 286 bytes).
     */
    fun encodeCnxn(
        features: String,
        version: Int = VERSION_1_1,
        maxPayload: Int = MAX_PAYLOAD,
    ): ByteArray = encode(CMD_CNXN, version, maxPayload, features.toByteArray(Charsets.UTF_8))

    /**
     * The packet that opens a service stream.
     *
     * The service string is NUL-terminated — measured: the captured OPEN for
     * "shell:echo hello" carried 17 bytes, not 16. Note the asymmetry with
     * CNXN, whose banner carries NO trailing NUL.
     *
     * @param localId the client's local stream id (the real client uses 4407)
     * @param service e.g. "shell:echo hello", "pair:123456", "host:version"
     */
    fun encodeOpen(localId: Int, service: String): ByteArray {
        val payload = ByteArray(service.length + 1)
        service.toByteArray(Charsets.UTF_8).copyInto(payload, 0)
        return encode(CMD_OPEN, localId, 0, payload)
    }

    /**
     * The answer to an AUTH challenge: our signature over the token.
     *
     * MEASURED 2026-11-12: the payload is the 256-byte signature and nothing
     * else — no public key in front of it, no length prefix. The argument is
     * AUTH_SIGNATURE (2), not 3.
     *
     * @param signature the signature bytes (256 for RSA-2048)
     */
    fun encodeAuthSignature(signature: ByteArray): ByteArray =
        encode(CMD_AUTH, AUTH_SIGNATURE, 0, signature)

    /** Decode a header from the first 24 bytes of a buffer. */
    fun decodeHeader(buf: ByteArray): Header? {
        if (buf.size < HEADER_SIZE) return null
        val command = String(buf, 0, 4, Charsets.US_ASCII)
        return Header(
            command = command,
            arg0 = readIntLE(buf, 4),
            arg1 = readIntLE(buf, 8),
            dataLength = readIntLE(buf, 12),
            dataCrc32 = readIntLE(buf, 16),
            magic = readIntLE(buf, 20),
        )
    }

    private fun writeIntLE(buf: ByteArray, offset: Int, value: Int) {
        buf[offset] = (value and 0xFF).toByte()
        buf[offset + 1] = ((value ushr 8) and 0xFF).toByte()
        buf[offset + 2] = ((value ushr 16) and 0xFF).toByte()
        buf[offset + 3] = ((value ushr 24) and 0xFF).toByte()
    }

    private fun readIntLE(buf: ByteArray, offset: Int): Int =
        (buf[offset].toInt() and 0xFF) or
            ((buf[offset + 1].toInt() and 0xFF) shl 8) or
            ((buf[offset + 2].toInt() and 0xFF) shl 16) or
            ((buf[offset + 3].toInt() and 0xFF) shl 24)

    private val CRC_TABLE: IntArray = IntArray(256) { n ->
        var c = n
        repeat(8) { c = if (c and 1 != 0) 0xEDB88320.toInt() xor (c ushr 1) else c ushr 1 }
        c
    }
}
