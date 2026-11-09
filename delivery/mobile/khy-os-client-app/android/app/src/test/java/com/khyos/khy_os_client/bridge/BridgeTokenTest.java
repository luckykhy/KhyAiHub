// khy-canary: Khy-20261101-044-30YPBK1K
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * BridgeTokenTest — the token path's only automated coverage.
 *
 * The rest of the token lifecycle lives in HttpBridge, which needs a Context and
 * a filesystem and therefore stays untested; this pins the one rule checkable on
 * a bare JVM, and that rule is what stops a malformed on-disk token from being
 * adopted forever.
 */
public class BridgeTokenTest {

    /** The shape the PC side accepts — mirrors isValidTokenShape in phoneBridgePolicy.js. */
    private static final String GOOD = "5500fae8db41cd054f45ea8834198d30";

    @Test
    public void aRealTokenIsAccepted() {
        assertTrue(BridgeToken.isWellFormedToken(GOOD));
        // Case-insensitive, and surrounding whitespace is tolerated.
        assertTrue(BridgeToken.isWellFormedToken(GOOD.toUpperCase()));
        assertTrue(BridgeToken.isWellFormedToken("  " + GOOD + "\n"));
        assertTrue(BridgeToken.isWellFormedToken("0123456789abcdef0123456789abcdef"));
    }

    @Test
    public void wrongLengthIsRejected() {
        assertFalse(BridgeToken.isWellFormedToken(""));
        assertFalse(BridgeToken.isWellFormedToken("abc"));
        assertFalse(BridgeToken.isWellFormedToken(GOOD.substring(0, 31)));
        assertFalse(BridgeToken.isWellFormedToken(GOOD + "a"));
        assertFalse(BridgeToken.isWellFormedToken("   " + GOOD + "   " + "x"));
    }

    @Test
    public void nonHexCharactersAreRejected() {
        // 'g' is the classic near-miss: 32 chars, but not hex.
        assertFalse(BridgeToken.isWellFormedToken(GOOD.substring(0, 31) + "g"));
        assertFalse(BridgeToken.isWellFormedToken(GOOD.replace('a', 'z')));
        // An embedded space keeps the length at 32 but breaks the shape.
        assertFalse(BridgeToken.isWellFormedToken(GOOD.substring(0, 8) + " " + GOOD.substring(9)));
        // A full-width digit is not ASCII hex.
        assertFalse(BridgeToken.isWellFormedToken("５500fae8db41cd054f45ea8834198d3"));
    }

    @Test
    public void nullIsRejectedNotThrown() {
        assertFalse(BridgeToken.isWellFormedToken(null));
    }

    /**
     * The generator's format must never produce a token its own validator rejects.
     *
     * If these two drift, the bridge would mint a token, refuse to adopt it on the
     * next start, and mint a fresh one every boot — the PC side would see the token
     * change on every restart for no visible reason. generate() is private, so this
     * asserts the invariant through the same format string it uses.
     */
    @Test
    public void theGeneratorAlwaysProducesAnAcceptableToken() {
        for (int i = 0; i < 200; i++) {
            StringBuilder sb = new StringBuilder();
            for (int b = 0; b < 16; b++) {
                // Mask to a byte, exactly as generate() does: %02x of a value
                // above 0xFF emits three characters and the token would be 33
                // long — which this very assertion caught while it was written.
                sb.append(String.format("%02x", (b * 17 + i) & 0xFF));
            }
            assertEquals(32, sb.length());
            assertTrue("iteration " + i + " produced " + sb,
                    BridgeToken.isWellFormedToken(sb.toString()));
        }
    }
}
