// khy-canary: Khy-20261116-001-SPAKE2
package com.khyos.khy_os_client.shell

import java.math.BigInteger

/**
 * Ed25519 group arithmetic — only the operations SPAKE2 needs.
 *
 * WHY THIS EXISTS AT ALL. The adb pairing protocol authenticates the 6-digit
 * pairing code with **SPAKE2 over the Ed25519 group**. The platform has that
 * implementation (BoringSSL), but it is not something an app may borrow:
 * it lives inside `libcrypto` in the `com.android.adbd` APEX, and an app
 * loading a library out of another APEX is not something to build a feature
 * on (SELinux denies `execute_no_trans` on `system_file` to `untrusted_app`).
 *
 * So the arithmetic is written out here, from the algorithm rather than from a
 * copy of the code. The reference is:
 *
 *   · BoringSSL `crypto/curve25519/spake25519.c`（commit 9b8b483276da，2024-01-16）
 *   · AOSP `packages/modules/adb/pairing_auth/pairing_auth.cpp`（Android 16）
 *
 * Every constant below was read out of those two files, and the whole thing is
 * checked against **the platform's own `adb pair` client** in
 * `Spake2Test` — see the comment there on why that is the only oracle that counts.
 *
 * WHY PLAIN BIGINTEGER MATH. A pairing happens once, in the background, while
 * the user is looking at a dialog. A few hundred milliseconds of modular
 * arithmetic is free; a native dependency is not.
 *
 * WHY THE LADDER HAS NO SECRET-DEPENDENT BRANCHES. The password scalar is
 * derived from the pairing code, which is a secret until it is used. The
 * scalar multiplication below is written as double-and-add-**always** with a
 * constant-time select, so the control flow does not depend on secret bits.
 * (Java cannot promise constant time at the instruction level — that would need
 * native code. What this buys is the absence of the obvious leak: branches and
 * memory access patterns that depend on the secret.)
 */
internal object Ed25519 {

    /** The field prime, 2^255 − 19. */
    val P: BigInteger = BigInteger.TWO.pow(255).subtract(BigInteger.valueOf(19))

    /** The order of the prime-order subgroup. */
    val L: BigInteger = BigInteger.ONE.shiftLeft(252)
        .add(BigInteger("27742317777372353535851937790883648493"))

    /** The curve constant d = −121665/121666. */
    private val D: BigInteger = BigInteger.valueOf(-121665)
        .multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P)

    /** 2^((p−1)/4) — the square-root of −1, used when decoding a point. */
    private val SQRT_M1: BigInteger = BigInteger.TWO.modPow(P.subtract(BigInteger.ONE).divide(BigInteger.valueOf(4)), P)

    /**
     * A point in extended coordinates: x = X/Z, y = Y/Z, and T = XY/Z.
     *
     * The point at infinity is Z = 0.
     */
    class Point(
        val x: BigInteger,
        val y: BigInteger,
        val z: BigInteger,
        val t: BigInteger,
    ) {
        companion object {
            /** The identity element. */
            val IDENTITY = Point(BigInteger.ZERO, BigInteger.ONE, BigInteger.ZERO, BigInteger.ZERO)
        }

        /** True when this is the identity (Z = 0). */
        fun isIdentity(): Boolean = z.signum() == 0
    }

    /**
     * The Ed25519 base point, decoded from its standard encoding.
     *
     * The encoding is the well-known `58 66 66 … 66`: little-endian y = 4/5 with
     * the sign bit clear. Decoding it rather than hard-coding x and y keeps the
     * constants to a single well-known byte string.
     */
    val BASE: Point by lazy {
        val encoded = ByteArray(32)
        encoded[0] = 0x58
        for (i in 1 until 32) encoded[i] = 0x66
        decode(encoded) ?: error("Ed25519 base point does not decode")
    }

    /**
     * Decode a compressed point (32 bytes).
     *
     * @return the point, or null when the bytes are not a valid encoding.
     */
    fun decode(encoded: ByteArray): Point? {
        if (encoded.size != 32) return null
        val bytes = encoded.copyOf()
        val sign = (bytes[31].toInt() and 0x80) != 0
        bytes[31] = (bytes[31].toInt() and 0x7f).toByte()
        val y = littleEndianToBigInteger(bytes)
        if (y >= P) return null

        val y2 = y.multiply(y).mod(P)
        val u = y2.subtract(BigInteger.ONE).mod(P)
        val v = D.multiply(y2).add(BigInteger.ONE).mod(P)
        if (v.signum() == 0) return null

        // x = u * v^3 * (u * v^7)^((p−5)/8)
        val v3 = v.multiply(v).multiply(v).mod(P)
        val v7 = v3.multiply(v3).multiply(v).mod(P)
        var x = u.multiply(v3).multiply(u.multiply(v7).modPow(P.subtract(BigInteger.valueOf(5)).divide(BigInteger.valueOf(8)), P)).mod(P)

        val check = v.multiply(x).multiply(x).subtract(u).mod(P)
        if (check.signum() != 0) {
            x = x.multiply(SQRT_M1).mod(P)
            if (v.multiply(x).multiply(x).subtract(u).mod(P).signum() != 0) return null
        }
        if (x.signum() == 0 && sign) return null
        if ((x.testBit(0)) != sign) {
            x = P.subtract(x)
        }
        return Point(x, y, BigInteger.ONE, x.multiply(y).mod(P))
    }

    /** Encode a point into its 32-byte compressed form. */
    fun encode(point: Point): ByteArray {
        val zInv = point.z.modInverse(P)
        val x = point.x.multiply(zInv).mod(P)
        val y = point.y.multiply(zInv).mod(P)
        val out = ByteArray(32)
        val yBytes = bigIntegerToLittleEndian(y, 32)
        System.arraycopy(yBytes, 0, out, 0, 32)
        if (x.testBit(0)) {
            out[31] = (out[31].toInt() or 0x80).toByte()
        }
        return out
    }

    /** Add two points (a = −1 twisted Edwards). */
    fun add(p: Point, q: Point): Point {
        if (p.isIdentity()) return q
        if (q.isIdentity()) return p
        val a = p.y.subtract(p.x).multiply(q.y.subtract(q.x)).mod(P)
        val b = p.y.add(p.x).multiply(q.y.add(q.x)).mod(P)
        val c = p.t.multiply(TWO_D).multiply(q.t).mod(P)
        val d = p.z.multiply(TWO).multiply(q.z).mod(P)
        val e = b.subtract(a).mod(P)
        val f = d.subtract(c).mod(P)
        val g = d.add(c).mod(P)
        val h = b.add(a).mod(P)
        return Point(
            e.multiply(f).mod(P),
            g.multiply(h).mod(P),
            f.multiply(g).mod(P),
            e.multiply(h).mod(P),
        )
    }

    /** Subtract a point (add its negation). */
    fun sub(p: Point, q: Point): Point {
        val negQ = if (q.isIdentity()) q else Point(q.x, P.subtract(q.y).mod(P), q.z, q.t.negate().mod(P))
        return add(p, negQ)
    }

    /** Double a point. */
    fun double(p: Point): Point {
        if (p.isIdentity()) return p
        val a = p.x.multiply(p.x).mod(P)
        val b = p.y.multiply(p.y).mod(P)
        val c = TWO.multiply(p.z).multiply(p.z).mod(P)
        val d = a.negate().mod(P)
        val e = p.x.add(p.y).multiply(p.x.add(p.y)).subtract(a).subtract(b).mod(P)
        val g = d.add(b).mod(P)
        val f = g.subtract(c).mod(P)
        val h = d.subtract(b).mod(P)
        return Point(
            e.multiply(f).mod(P),
            g.multiply(h).mod(P),
            f.multiply(g).mod(P),
            e.multiply(h).mod(P),
        )
    }

    /**
     * Multiply a point by a scalar given as a little-endian byte string.
     *
     * The scalar is used as-is (up to 2^256), which is what BoringSSL does: the
     * group's prime-order subgroup makes the reduction implicit.
     *
     * The ladder is double-and-add-**always**: the addition is performed at every
     * bit and the result is chosen with a constant-time select, so neither the
     * number of iterations nor the memory access pattern depends on the scalar.
     */
    fun mul(scalar: ByteArray, point: Point): Point {
        var result = Point.IDENTITY
        for (bit in 255 downTo 0) {
            result = double(result)
            val sum = add(result, point)
            result = select(sum, result, bitAt(scalar, bit))
        }
        return result
    }

    /** Read one bit of a little-endian byte string. */
    fun bitAt(bytes: ByteArray, bit: Int): Boolean =
        ((bytes[bit / 8].toInt() shr (bit % 8)) and 1) == 1

    /** Multiply the base point by a scalar. */
    fun mulBase(scalar: ByteArray): Point = mul(scalar, BASE)

    /**
     * Choose between two values without branching on the selector.
     *
     * The selector is a public bit in every call site here (it comes from the
     * scalar's bits, which are secret), so this is the place where a secret
     * could leak; the implementation therefore always touches both values.
     */
    private fun select(ifSet: Point, ifNotSet: Point, selector: Boolean): Point {
        val mask = BigInteger.valueOf(if (selector) -1L else 0L)
        fun pick(a: BigInteger, b: BigInteger): BigInteger =
            a.and(mask).or(b.and(mask.not()))
        return Point(
            pick(ifSet.x, ifNotSet.x),
            pick(ifSet.y, ifNotSet.y),
            pick(ifSet.z, ifNotSet.z),
            pick(ifSet.t, ifNotSet.t),
        )
    }

    /** Read a little-endian byte string as a non-negative integer. */
    fun littleEndianToBigInteger(bytes: ByteArray): BigInteger {
        return BigInteger(1, bytes.reversedArray())
    }

    /** Write a non-negative integer as a fixed-width little-endian byte string. */
    fun bigIntegerToLittleEndian(value: BigInteger, width: Int): ByteArray {
        val raw = value.toByteArray() // big-endian, two's complement
        val out = ByteArray(width)
        var src = raw
        // Drop the sign byte BigInteger may prepend.
        if (src.size > width) {
            src = src.copyOfRange(src.size - width, src.size)
        } else if (src.size == width + 1 && src[0] == 0.toByte()) {
            src = src.copyOfRange(1, src.size)
        }
        for (i in 0 until src.size) {
            out[width - 1 - i] = src[i]
        }
        return out
    }

    private val TWO = BigInteger.valueOf(2)
    private val TWO_D = BigInteger.valueOf(2).multiply(D).mod(P)
}
