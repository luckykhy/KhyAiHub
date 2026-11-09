package com.khyos.khy_os_client.bridge;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;

/**
 * The one-time code that gates writing a sandbox credential into the vault.
 *
 * <h2>What threat this addresses</h2>
 * The bridge's Bearer token lives on shared storage ({@code /sdcard/bridge-amoobridge/
 * token.txt}), so "holds the bridge token" is not a strong claim — any app with a
 * storage permission, an adb shell, or an MTP session may hold it. Without a second
 * factor, such a holder could inject a credential of its choosing: point the future
 * sandbox connector at a server it controls, or install a key it also holds. The
 * credential would then be indistinguishable from one the operator installed.
 *
 * <p>So the write path requires something a remote holder cannot obtain: a code shown
 * in a notification on the phone. Generating a code is unauthenticated-by-design
 * (anyone may ask); <b>reading</b> it requires being at the device.
 *
 * <h2>Why the state is in memory only</h2>
 * Persisting it would put a verifier on disk next to the thing it protects. A restart
 * invalidating an in-flight provisioning is a minor inconvenience; a persisted code is
 * a permanent bypass.
 *
 * <h2>Testability</h2>
 * {@code now} is always a parameter. Nothing here calls the clock, so the expiry and
 * single-use rules are provable on the JVM.
 */
final class ProvisioningCode {
    /** Six decimal digits: enough entropy for a 120-second window, short enough to read off a notification and retype. */
    static final int LENGTH = 6;

    /**
     * Two minutes. Long enough for an operator to notice the notification, walk to the
     * PC and type it; short enough that a shoulder-surfed code goes stale quickly.
     */
    static final long TTL_MS = 120_000L;

    private static final char[] DIGITS = "0123456789".toCharArray();
    private static final String SALT = "khy-sandbox-vault-provisioning|1";

    private final SecureRandom random;

    /** SHA-256 of the live code, or {@code null} when none is outstanding. */
    private String liveHash;
    private long expiresAt;
    private boolean consumed;

    ProvisioningCode() {
        this(new SecureRandom());
    }

    ProvisioningCode(SecureRandom random) {
        this.random = random;
    }

    /**
     * Mints a code and makes it the only outstanding one.
     *
     * <p>Issuing replaces rather than stacks: two live codes would mean an old,
     * possibly-already-shown code stays valid, and the operator has no way to tell
     * which of the two notifications in the shade is the current one.
     */
    String issue(long now) {
        StringBuilder sb = new StringBuilder(LENGTH);
        for (int i = 0; i < LENGTH; i++) {
            // nextInt(10) is uniform; modulo of a raw nextInt() would not be.
            sb.append(DIGITS[random.nextInt(DIGITS.length)]);
        }
        String code = sb.toString();
        liveHash = hash(code);
        expiresAt = now + TTL_MS;
        consumed = false;
        return code;
    }

    /**
     * Consumes the live code if {@code presented} matches and it is still valid.
     *
     * <p>Order matters: an expired code is rejected without burning the single use, so
     * a typo followed by the correct code still works. A correct code is burned
     * whether or not the caller then succeeds in using it — otherwise a failed write
     * would leave a valid code lying around for a second attempt the operator never
     * authorised.
     *
     * @return {@code null} on success, or a short Chinese reason for the failure. The
     *         reason deliberately does not distinguish "wrong code" from "expired" for
     *         a remote caller beyond what is needed to act on it.
     */
    String verify(String presented, long now) {
        if (liveHash == null) {
            return "当前没有待确认的投递码，先调 secret_code";
        }
        if (now > expiresAt) {
            // Burn it: leaving an expired-but-matching code valid would let a slow
            // retry succeed long after the operator looked away.
            liveHash = null;
            consumed = false;
            return "投递码已过期，重新调 secret_code";
        }
        if (consumed) {
            return "投递码已使用过一次，不能复用";
        }
        String candidate = normalize(presented);
        if (candidate.length() != LENGTH || !matches(hash(candidate), liveHash)) {
            return "投递码不匹配";
        }
        consumed = true;
        return null;
    }

    /** Drops any outstanding code. Called after a successful write so the code cannot be replayed. */
    void clear() {
        liveHash = null;
        expiresAt = 0L;
        consumed = false;
    }

    boolean hasOutstanding(long now) {
        return liveHash != null && !consumed && now <= expiresAt;
    }

    long expiresAt() {
        return expiresAt;
    }

    /**
     * Accepts the shapes an operator plausibly types: with or without spaces, and
     * with any non-digit stripped. Rejecting "123 456" would only produce a failed
     * write and a second round trip.
     */
    static String normalize(String raw) {
        if (raw == null) return "";
        StringBuilder sb = new StringBuilder(LENGTH);
        for (int i = 0; i < raw.length() && sb.length() < LENGTH; i++) {
            char c = raw.charAt(i);
            if (c >= '0' && c <= '9') sb.append(c);
        }
        return sb.toString();
    }

    /**
     * Hashes the code with a fixed salt.
     *
     * <p>The salt is a constant rather than per-issue because there is exactly one
     * live code and it lives for two minutes: a per-issue salt would add a column to
     * keep and nothing to defend against. What it does buy is that the stored value is
     * not the code itself, so a memory dump taken after a successful write yields
     * nothing replayable.
     */
    static String hash(String code) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest((SALT + "|" + code).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is mandated for every Java platform; if it is missing the JVM
            // is broken and no fallback would be safe.
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /**
     * Constant-time comparison of two hex digests.
     *
     * <p>{@link String#equals} short-circuits on the first differing character, which
     * is a timing side channel. Over a loopback socket with a 120-second window this
     * is depth rather than a real risk — but the fix is one line and the alternative
     * is a comment explaining why the risk is acceptable.
     */
    static boolean matches(String presented, String storedHash) {
        if (presented == null || storedHash == null) return false;
        return MessageDigest.isEqual(
                presented.getBytes(StandardCharsets.UTF_8),
                storedHash.getBytes(StandardCharsets.UTF_8));
    }
}
