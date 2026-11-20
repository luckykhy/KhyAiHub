// khy-canary: Khy-20261116-001-SPAKE2
package com.khyos.khy_os_client.shell

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * SPAKE2 over the Ed25519 group — byte-compatible with the platform's.
 *
 * WHAT THIS IS FOR. The adb pairing protocol ([DESIGN-ARCH-212]) authenticates
 * the 6-digit pairing code with SPAKE2, so that only someone who can read the
 * phone's screen can authorize a key. The platform implements it in BoringSSL
 * (`crypto/curve25519/spake25519.c`), which an app cannot borrow — see
 * [Ed25519] for why.
 *
 * THE REFERENCE. Everything here follows BoringSSL's `spake25519.c` (commit
 * 9b8b483276da) and AOSP's `packages/modules/adb/pairing_auth/pairing_auth.cpp`:
 *
 *   · the two fixed points M and N, with their encodings, are that file's;
 *   · the "password scalar hack" below is that file's, and it is **not** optional:
 *     AOSP never sets `disable_password_scalar_hack`, so both sides apply it;
 *   · the transcript is SHA-512 over length-prefixed fields in the order that
 *     file writes them — and for the two roles that order is *different*
 *     (`my_name, their_name, my_msg, their_msg` for Alice versus
 *     `their_name, my_name, their_msg, my_msg` for Bob), which is precisely
 *     what makes the two sides agree.
 *
 * THE NAMES CARRY A TRAILING NUL. AOSP passes `sizeof(kClientName)` — the
 * array size, not `strlen` — so the transcript binds `"adb pair client\0"`
 * and `"adb pair server\0"`, 16 bytes each (15 characters plus the NUL).
 * Getting that wrong produces
 * a different transcript and a pairing that fails for no visible reason.
 */
internal class Spake2(
    /** True for the client (Alice), false for the server (Bob). */
    private val isClient: Boolean,
    /** This side's transcript name, NUL-terminated. */
    private val myName: ByteArray,
    /** The other side's transcript name, NUL-terminated. */
    private val theirName: ByteArray,
) {

    /** Our ephemeral private scalar, 32 bytes little-endian. */
    private var privateKey: ByteArray? = null

    /** The masked password scalar, 32 bytes little-endian. */
    private var passwordScalar: ByteArray? = null

    /** SHA-512 of the password, 64 bytes — it goes into the transcript as-is. */
    private var passwordHash: ByteArray? = null

    /** Our SPAKE2 message: the encoded point P*. */
    private var myMsg: ByteArray? = null

    /**
     * Produce our SPAKE2 message.
     *
     * @param password the shared secret: the pairing code followed by the
     *   64 bytes of TLS keying material (that is how AOSP builds it).
     * @param privateKeyOverride pin the ephemeral scalar instead of drawing a
     *   random one. **Test only**: it makes the whole exchange deterministic
     *   so this implementation can be compared byte for byte against the
     *   reference one in `scripts/adb-pairing-common.js` (see
     *   [Spake2Test]). Production always leaves it null.
     * @return the 32-byte message.
     */
    fun generateMsg(password: ByteArray, privateKeyOverride: ByteArray? = null): ByteArray {
        check(myMsg == null) { "generateMsg may only be called once" }

        // 1. The ephemeral scalar: 64 random bytes, reduced modulo the group
        //    order, then multiplied by eight so that the cofactor is cleared.
        var secret = if (privateKeyOverride != null) {
            require(privateKeyOverride.size == 32) { "钉住的临时标量必须是 32 字节" }
            privateKeyOverride.copyOf()
        } else {
            val random = ByteArray(64)
            SecureRandom().nextBytes(random)
            leftShift3(Ed25519.bigIntegerToLittleEndian(reduce(random), 32))
        }
        privateKey = secret

        // 2. P = secret · B
        val p = Ed25519.mulBase(secret)

        // 3. The password: SHA-512 for the transcript, and the same digest
        //    reduced for the mask.
        val digest = MessageDigest.getInstance("SHA-512").digest(password)
        passwordHash = digest
        var scalar = reduce(digest)

        // 4. The "password scalar hack".
        //
        //    BoringSSL used to leave the mask scalar unreduced by eight, which
        //    leaked three bits of the password hash. The fix was to add points
        //    of small order, which is the same as adding multiples of the group
        //    order to the scalar until its low three bits are clear. Because the
        //    ephemeral scalar is a multiple of eight, those points cancel out in
        //    the shared secret — so the peers still agree.
        //
        //    The order is odd, so adding it flips bit 0; doubling it and adding
        //    again flips bit 1; and so on. The checks read the *updated* scalar,
        //    which is what the reference implementation does.
        //
        //    NOTE: the scalar is deliberately NOT reduced modulo the group order
        //    afterwards. The reference adds multiples of the order and lets the
        //    value grow to at most 8·order − 1; reducing it would change the
        //    low bits the next two checks look at, and the mask would come out
        //    different from the platform's.
        var order = Ed25519.L
        if (scalar.testBit(0)) scalar = scalar.add(order)
        order = order.shiftLeft(1)
        if (scalar.testBit(1)) scalar = scalar.add(order)
        order = order.shiftLeft(1)
        if (scalar.testBit(2)) scalar = scalar.add(order)
        passwordScalar = Ed25519.bigIntegerToLittleEndian(scalar, 32)

        // 5. The mask point: passwordScalar · M (Alice) or · N (Bob).
        val mask = Ed25519.mul(passwordScalar!!, if (isClient) POINT_M else POINT_N)

        // 6. P* = P + mask, and that is our message.
        val msg = Ed25519.encode(Ed25519.add(p, mask))
        myMsg = msg
        return msg
    }

    /**
     * Consume the peer's message and derive the shared key material.
     *
     * @param theirMsg the peer's 32-byte message.
     * @return 64 bytes of key material, or null when the peer's message is not
     *         a valid point.
     */
    fun processMsg(theirMsg: ByteArray): ByteArray? {
        val secret = privateKey ?: return null
        val mask = passwordScalar ?: return null
        val digest = passwordHash ?: return null
        val mine = myMsg ?: return null

        val qStar = Ed25519.decode(theirMsg) ?: return null
        val peersMask = Ed25519.mul(mask, if (isClient) POINT_N else POINT_M)
        val qExt = Ed25519.sub(qStar, peersMask)
        val shared = Ed25519.encode(Ed25519.mul(secret, qExt))

        val sha = MessageDigest.getInstance("SHA-512")
        // The order differs by role; that is what makes both sides hash the
        // same byte string.
        if (isClient) {
            sha.update(lengthPrefixed(myName))
            sha.update(lengthPrefixed(theirName))
            sha.update(lengthPrefixed(mine))
            sha.update(lengthPrefixed(theirMsg))
        } else {
            sha.update(lengthPrefixed(theirName))
            sha.update(lengthPrefixed(myName))
            sha.update(lengthPrefixed(theirMsg))
            sha.update(lengthPrefixed(mine))
        }
        sha.update(lengthPrefixed(shared))
        sha.update(lengthPrefixed(digest))
        return sha.digest()
    }

    /** A length-prefixed field: 8 bytes of little-endian length, then the bytes. */
    private fun lengthPrefixed(data: ByteArray): ByteArray {
        val out = ByteArray(8 + data.size)
        var len = data.size.toLong()
        for (i in 0 until 8) {
            out[i] = (len and 0xFF).toByte()
            len = len shr 8
        }
        System.arraycopy(data, 0, out, 8, data.size)
        return out
    }

    /** Multiply a 32-byte little-endian scalar by eight. */
    private fun leftShift3(scalar: ByteArray): ByteArray {
        val out = ByteArray(32)
        var carry = 0
        for (i in 0 until 32) {
            val nextCarry = (scalar[i].toInt() and 0xFF) shr 5
            out[i] = (((scalar[i].toInt() and 0xFF) shl 3) or carry).toByte()
            carry = nextCarry
        }
        return out
    }

    /** Reduce a little-endian byte string modulo the group order. */
    private fun reduce(value: ByteArray): BigInteger =
        Ed25519.littleEndianToBigInteger(value).mod(Ed25519.L)

    companion object {
        /**
         * The fixed point M, in its compressed encoding.
         *
         * From BoringSSL's `spake25519.c`, which documents it as the point
         * generated from the seed "edwards25519 point generation seed (M)".
         */
        val POINT_M: Ed25519.Point by lazy {
            Ed25519.decode(hex("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e"))
                ?: error("M does not decode")
        }

        /** The fixed point N, in its compressed encoding. */
        val POINT_N: Ed25519.Point by lazy {
            Ed25519.decode(hex("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778"))
                ?: error("N does not decode")
        }

        private fun hex(s: String): ByteArray {
            val out = ByteArray(s.length / 2)
            for (i in out.indices) {
                out[i] = ((Character.digit(s[i * 2], 16) shl 4) or Character.digit(s[i * 2 + 1], 16)).toByte()
            }
            return out
        }
    }
}
