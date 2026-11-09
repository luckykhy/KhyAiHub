// khy-canary: Khy-20261101-011-TNY53FYF
package com.khyos.khy_os_client.bridge;

/**
 * BridgeToken — the bridge token's shape rule, isolated so it is testable.
 *
 * WHY a class of its own: {@link HttpBridge} cannot be compiled on a bare JVM
 * (it reaches BridgeService, Tools and KhyUi, which need the Kotlin
 * accessibility service), so any rule living inside it has zero automated
 * coverage. This rule matters more than its size suggests — it is what stops a
 * malformed on-disk token from being adopted forever, which would lock the PC
 * side out with no self-healing.
 *
 * The rule mirrors {@code isValidTokenShape} in
 * runtime/node/backend/src/services/domain/network/phone/phoneBridgePolicy.js.
 * Keep the two in step: if they drift, the phone accepts a token the PC rejects.
 *
 * Contract: pure, deterministic, never throws.
 */
public final class BridgeToken {
    private BridgeToken() {}

    /** Expected length: 16 random bytes rendered as lowercase hex. */
    public static final int LENGTH = 32;

    /**
     * Whether {@code t} is a token both sides accept: exactly 32 hex characters,
     * case-insensitive, with surrounding whitespace tolerated.
     */
    public static boolean isWellFormedToken(String t) {
        if (t == null) {
            return false;
        }
        String s = t.trim();
        if (s.length() != LENGTH) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!hex) {
                return false;
            }
        }
        return true;
    }
}
