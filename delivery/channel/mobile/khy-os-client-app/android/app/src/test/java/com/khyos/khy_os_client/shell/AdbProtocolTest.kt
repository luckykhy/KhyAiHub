package com.khyos.khy_os_client.shell

import org.junit.Test

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue

/**
 * Golden-vector tests for the adb wire format.
 *
 * WHERE THE VECTORS COME FROM. Captured 2026-11-12 from the REAL adb client
 * on this machine: `platform-tools/adb.exe` was pointed at a local fake adbd
 * (`works/data/khy/T4-transient/tmp/aosp-adb/fake-adbd-handshake.js`), and
 * the bytes it put on the wire were recorded. This test pins those bytes.
 *
 * WHY THIS IS WORTH A TEST FILE. Two details of the framing are routinely
 * misremembered, and both fail SILENTLY — a broken handshake looks exactly
 * like "the service is off" on a phone:
 *
 *   · the 6th header word is not a constant 0xffffffff, it is
 *     `command XOR 0xffffffff` (measured: CNXN -> 0xb1a7b1bc, OPEN ->
 *     0xb1baafb0);
 *   · the CNXN payload carries no trailing NUL — the captured payload is
 *     exactly 286 bytes of feature string.
 *
 * A test that pins the captured bytes is the only thing standing between a
 * future refactor and a phone that quietly stops being able to elevate.
 */
class AdbProtocolTest {

    /** The exact feature string the real client sent (286 bytes, no NUL). */
    private val capturedFeatures =
        "host::features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb," +
            "fixed_push_symlink_timestamp,abb_exec,remount_shell,track_app," +
            "sendrecv_v2,sendrecv_v2_brotli,sendrecv_v2_lz4,sendrecv_v2_zstd," +
            "sendrecv_v2_dry_run_send,devicetracker_proto_format,devraw,app_info," +
            "server_status,track_mdns"

    /** The 24 header bytes the real client sent for that CNXN. */
    private val capturedCnxnHeaderHex =
        "43 4e 58 4e 01 00 00 01 00 00 10 00 1e 01 00 00 1d 70 00 00 bc b1 a7 b1"

    /** The 24 header bytes the real client sent for "shell:echo hello". */
    private val capturedOpenHeaderHex =
        "4f 50 45 4e 37 11 00 00 00 00 00 00 11 00 00 00 00 00 00 00 b0 af ba b1"

    private fun hex(bytes: ByteArray): String =
        bytes.joinToString(" ") { "%02x".format(it) }

    private fun bytesOf(hexText: String): ByteArray =
        hexText.trim().split(Regex("\\s+")).map { it.toInt(16).toByte() }.toByteArray()

    @Test
    fun `the captured feature string is 286 bytes with no trailing NUL`() {
        assertEquals(286, capturedFeatures.toByteArray(Charsets.UTF_8).size)
        assertNotEquals(0.toByte(), capturedFeatures.toByteArray(Charsets.UTF_8).last())
    }

    @Test
    fun `the payload checksum is a byte sum, not a CRC32`() {
        val payload = capturedFeatures.toByteArray(Charsets.UTF_8)
        // Measured: the real client sent 0x701d, which is the sum of the 286
        // payload bytes — and no CRC variant reproduces that value.
        assertEquals(0x701d, AdbProtocol.payloadChecksum(AdbProtocol.CMD_CNXN, payload))
        assertNotEquals(0x701d, AdbProtocol.crc32(payload))
        assertEquals(
            0,
            AdbProtocol.payloadChecksum(
                AdbProtocol.CMD_OPEN,
                "shell:echo hello".toByteArray(Charsets.UTF_8),
            ),
        )
    }

    @Test
    fun `magic is the command xor 0xffffffff, not a constant`() {
        // Measured, and the two values below differ — which is exactly the
        // point: a constant 0xffffffff would be wrong for both.
        assertEquals(0xb1a7b1bc.toInt(), AdbProtocol.expectedMagic(AdbProtocol.CMD_CNXN))
        assertEquals(0xb1baafb0.toInt(), AdbProtocol.expectedMagic(AdbProtocol.CMD_OPEN))
        assertNotEquals(
            AdbProtocol.MAGIC_INVERT,
            AdbProtocol.expectedMagic(AdbProtocol.CMD_CNXN),
        )
        assertNotEquals(
            AdbProtocol.expectedMagic(AdbProtocol.CMD_CNXN),
            AdbProtocol.expectedMagic(AdbProtocol.CMD_OPEN),
        )
    }

    @Test
    fun `encodeCnxn reproduces the captured bytes`() {
        val packet = AdbProtocol.encodeCnxn(capturedFeatures)
        assertEquals(24 + 286, packet.size)
        assertEquals(
            capturedCnxnHeaderHex,
            hex(packet.copyOfRange(0, 24)),
        )
        assertEquals(
            capturedFeatures,
            String(packet, 24, 286, Charsets.UTF_8),
        )
    }

    @Test
    fun `encodeOpen reproduces the captured bytes`() {
        val packet = AdbProtocol.encodeOpen(4407, "shell:echo hello")
        // Measured: the captured OPEN was 17 bytes for a 16-char service
        // string — the service string is NUL-terminated.
        assertEquals(24 + 17, packet.size)
        assertEquals(capturedOpenHeaderHex, hex(packet.copyOfRange(0, 24)))
        assertEquals("shell:echo hello", String(packet, 24, 16, Charsets.UTF_8))
        assertEquals(0.toByte(), packet[24 + 16])
    }

    @Test
    fun `decodeHeader round-trips what encode produced`() {
        val packet = AdbProtocol.encodeCnxn(capturedFeatures)
        val header = AdbProtocol.decodeHeader(packet)
        assertTrue(header != null)
        requireNotNull(header)
        assertEquals("CNXN", header.command)
        assertEquals(0x01000001, header.arg0)
        assertEquals(1024 * 1024, header.arg1)
        assertEquals(286, header.dataLength)
        assertEquals(0x701d, header.dataCrc32)
        assertTrue(header.magicValid)
    }

    @Test
    fun `a header shorter than 24 bytes is refused instead of guessed`() {
        assertEquals(null, AdbProtocol.decodeHeader(ByteArray(23)))
    }

    @Test
    fun `command words are read little-endian from ASCII`() {
        assertEquals(0x4e584e43, AdbProtocol.commandToInt("CNXN"))
        assertEquals(0x4e45504f, AdbProtocol.commandToInt("OPEN"))
        assertArrayEquals(
            byteArrayOf('C'.code.toByte(), 'N'.code.toByte(), 'X'.code.toByte(), 'N'.code.toByte()),
            AdbProtocol.encode("CNXN", 0, 0).copyOfRange(0, 4),
        )
    }
}
