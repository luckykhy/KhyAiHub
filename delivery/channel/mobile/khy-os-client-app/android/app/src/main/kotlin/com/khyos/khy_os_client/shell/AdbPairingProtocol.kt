// khy-canary: Khy-20261112-003-SHIZUKU2
package com.khyos.khy_os_client.shell

/**
 * AdbPairingProtocol — what is MEASURED about the adb *pairing* transport.
 *
 * WHY THIS CLASS IS HALF EMPTY, ON PURPOSE. The pairing endpoint is the one
 * piece of the adb protocol that this project has not yet fully reverse
 * engineered, because the AOSP sources are unreachable from this network
 * (raw.githubusercontent / android.googlesource / jsdelivr / codeload all
 * fail) and the endpoint only exists while the phone shows the "pair device
 * with pairing code" screen.
 *
 * So instead of writing the protocol from memory — which is how the magic
 * value, the "CRC32" and the trailing NUL all went wrong in the ordinary
 * transport ([DESIGN-ARCH-212] §2.2) — this class records what was actually
 * captured, and refuses to pretend the rest is known:
 *
 *   MEASURED (2026-11-12, real `adb pair` against a recording fake server):
 *     · the pairing endpoint is TLS-wrapped (mDNS: `_adb-tls-pairing._tcp`);
 *       the pairing code is the trust anchor, not the certificate — which is
 *       why a self-signed fake server can sit on that side at all;
 *     · the first thing the client sends, after the TLS handshake, is exactly
 *       38 bytes: `01 00 00 00` + `00 20` + 32 further bytes;
 *     · those 32 bytes are FRESH PER CONNECTION: the same pairing code
 *       produced different bytes on two consecutive attempts, and so did a
 *       different code;
 *     · they are not derived from the client's stable adbkey either — the
 *       `~/.android/adbkey` on the capturing machine was NOT rewritten by the
 *       pairing attempts, so the bytes are connection-scoped material (a
 *       nonce or an ephemeral public key), not a hash of a long-lived key.
 *
 *   NOT YET KNOWN (and therefore not encoded here):
 *     · what the 32 bytes are (nonce vs ephemeral key), and what the second
 *       field `00 20` denotes (a big-endian length? a command?);
 *     · the server's reply format, and the packet that carries the pairing
 *       code itself.
 *     Both need one more capture: the phone's own adbd is the authority, and
 *     it will answer a replayed first packet on its pairing port (see
 *     `capture-adb-pairing.js` and the recipe in [DESIGN-ARCH-212] §10).
 *
 * The point of writing the KNOWN part down in code, with a test, is that the
 * next person does not have to re-derive it — and does not accidentally
 * "fix" it into something that was never measured.
 */
object AdbPairingProtocol {

    /** Protocol version the client announces. Measured: 1. */
    const val VERSION = 1

    /**
     * Length of the connection-scoped material the client sends first.
     * Measured: exactly 32 bytes, fresh on every connection.
     */
    const val MATERIAL_BYTES = 32

    /**
     * The first packet's fixed prefix, as captured:
     * `01 00 00 00` (version, little-endian u32) followed by `00 20`.
     *
     * The second field's MEANING is still unresolved — see the class doc. It
     * is pinned here as raw bytes precisely because that is all that is
     * actually known; interpreting it is a separate, still-open step.
     */
    val FIRST_PACKET_PREFIX: ByteArray = byteArrayOf(
        0x01, 0x00, 0x00, 0x00,
        0x00, 0x20,
    )

    /** Total size of the captured first packet. */
    const val FIRST_PACKET_SIZE = 38

    /**
     * Build the pairing connection's first packet.
     *
     * @param material the 32 connection-scoped bytes; must be exactly
     *   [MATERIAL_BYTES] long — a wrong length is a protocol error, not
     *   something to pad or truncate silently.
     */
    fun firstPacket(material: ByteArray): ByteArray {
        require(material.size == MATERIAL_BYTES) {
            "pairing material must be $MATERIAL_BYTES bytes, got ${material.size}"
        }
        return FIRST_PACKET_PREFIX + material
    }

    /** The version field as it appears on the wire (little-endian u32). */
    fun versionBytes(): ByteArray = byteArrayOf(
        (VERSION and 0xFF).toByte(),
        ((VERSION ushr 8) and 0xFF).toByte(),
        ((VERSION ushr 16) and 0xFF).toByte(),
        ((VERSION ushr 24) and 0xFF).toByte(),
    )
}
