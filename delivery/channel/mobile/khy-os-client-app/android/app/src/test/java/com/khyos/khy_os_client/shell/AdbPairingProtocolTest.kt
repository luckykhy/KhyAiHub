package com.khyos.khy_os_client.shell

import org.junit.Test

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue

/**
 * Golden-vector tests for the adb *pairing* transport.
 *
 * WHERE THE VECTORS COME FROM. Captured 2026-11-12 from the REAL adb client:
 * `platform-tools/adb.exe pair 127.0.0.1:<port> <code>` was pointed at a
 * recording TLS server (`scripts/capture-adb-pairing.js`), and the bytes it
 * sent after the TLS handshake were recorded.
 *
 * WHAT IS PINNED HERE, AND WHAT IS NOT. Only what was measured is pinned: the
 * first packet's shape, and the fact that the material it carries is fresh on
 * every connection. The meaning of the second field, the nature of the 32
 * bytes, and the server's reply are NOT pinned — they are not known yet, and
 * inventing them here would be exactly the mistake this project already made
 * once with the ordinary transport's "magic" and "CRC32" fields.
 */
class AdbPairingProtocolTest {

    @Test
    fun `the captured first packet is 38 bytes with the measured prefix`() {
        val material = ByteArray(32) { it.toByte() }
        val packet = AdbPairingProtocol.firstPacket(material)
        assertEquals(38, packet.size)
        assertEquals(AdbPairingProtocol.FIRST_PACKET_SIZE, packet.size)
        // 01 00 00 00 | 00 20 | <32 bytes>
        assertArrayEquals(
            byteArrayOf(0x01, 0x00, 0x00, 0x00, 0x00, 0x20),
            packet.copyOfRange(0, 6),
        )
        assertArrayEquals(material, packet.copyOfRange(6, 38))
    }

    @Test
    fun `the version is 1 in little-endian`() {
        assertArrayEquals(
            byteArrayOf(0x01, 0x00, 0x00, 0x00),
            AdbPairingProtocol.versionBytes(),
        )
        assertEquals(1, AdbPairingProtocol.VERSION)
    }

    @Test
    fun `material of the wrong length is refused rather than padded`() {
        // A short or long material is a protocol error. Padding it would send
        // something the peer never asked for and fail silently later.
        var threw = false
        try {
            AdbPairingProtocol.firstPacket(ByteArray(31))
        } catch (e: IllegalArgumentException) {
            threw = true
        }
        assertTrue("a 31-byte material must be rejected", threw)
    }

    @Test
    fun `the material is connection scoped, so the prefix is the only constant`() {
        // Measured: the same pairing code twice produced different 32 bytes,
        // and so did a different code — so the bytes are per connection, and
        // the part worth pinning is the fixed prefix.
        val a = AdbPairingProtocol.firstPacket(ByteArray(32) { 1 })
        val b = AdbPairingProtocol.firstPacket(ByteArray(32) { 2 })
        assertNotEquals(a.toList(), b.toList())
        assertArrayEquals(a.copyOfRange(0, 6), b.copyOfRange(0, 6))
    }
}
