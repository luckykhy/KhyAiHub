// khy-canary: Khy-20261101-016-ASPSA0RZ
package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;

/**
 * Post-hoc verification planning for the Amoo interception loop.
 *
 * A command that "ran" is not a command that "worked": every command must be
 * followed by a check that can prove the intended effect. When no proof is
 * available the caller gets {@link Kind#NONE} and must label the round as
 * unverified instead of reporting success to Amoo.
 *
 * The {@code verify} block carried inside a command is only a hint. The tool
 * name is the authority, so a {@code verify.kind} that contradicts the tool is
 * ignored (tool wins).
 *
 * Pure logic contract: zero IO, deterministic, never throws - failures are
 * expressed through the returned {@link Plan}.
 */
public final class LoopVerify {
    public enum Kind { READ_EQUALS, EXIT_ZERO, UI_TEXT_EQUALS, NONE }

    /** What to check after a command ran. Fields not relevant to {@link #kind} stay null / -1. */
    public static final class Plan {
        public final Kind kind;
        public final String path;          // READ_EQUALS
        public final long expectBytes;     // READ_EQUALS, -1 means "do not check the byte count"
        public final String expectInStdout; // EXIT_ZERO, may be null
        public final String expectText;    // UI_TEXT_EQUALS

        private Plan(Kind kind, String path, long expectBytes, String expectInStdout, String expectText) {
            this.kind = kind;
            this.path = path;
            this.expectBytes = expectBytes;
            this.expectInStdout = expectInStdout;
            this.expectText = expectText;
        }
    }

    /**
     * Builds the verification plan for one command.
     *
     * <ul>
     *   <li>{@code write}   -> {@link Kind#READ_EQUALS}: path from {@code verify.path}, falling back
     *       to {@code args.path}; byte count from {@code verify.expect_bytes}, default -1.</li>
     *   <li>{@code exec}    -> {@link Kind#EXIT_ZERO}: expected substring from
     *       {@code verify.expect_in_stdout} (null when absent).</li>
     *   <li>{@code ui_type} -> {@link Kind#UI_TEXT_EQUALS}: expected text from {@code args.text}.</li>
     *   <li>anything else   -> {@link Kind#NONE}.</li>
     * </ul>
     *
     * @param tool   bridge tool name; may be null
     * @param args   command arguments; may be null
     * @param verify verify block carried by the command; may be null
     * @return never null, never throws
     */
    public static Plan plan(String tool, JSONObject args, JSONObject verify) {
        try {
            // Fold the same aliases Tools.dispatch folds, so a command Amoo sent
            // as file_write is verified the same way it was executed. Two
            // different tool-name vocabularies on one command is how a verified
            // write silently becomes an unverified one.
            String t = canonicalTool(tool);
            if ("write".equals(t)) {
                String path = stringOf(verify, "path");
                if (path == null || path.length() == 0) path = stringOf(args, "path");
                if (path == null || path.length() == 0) {
                    // No target to read back: claiming a verification method that
                    // has nowhere to look is how "unverified" gets reported as
                    // "verified".
                    return new Plan(Kind.NONE, null, -1L, null, null);
                }
                return new Plan(Kind.READ_EQUALS, path, usableBytes(verify, "expect_bytes"), null, null);
            }
            if ("exec".equals(t)) {
                return new Plan(Kind.EXIT_ZERO, null, -1L, stringOf(verify, "expect_in_stdout"), null);
            }
            if ("ui_type".equals(t)) {
                return new Plan(Kind.UI_TEXT_EQUALS, null, -1L, null, stringOf(args, "text"));
            }
            return new Plan(Kind.NONE, null, -1L, null, null);
        } catch (Throwable t) {
            // Absolute backstop: an unverifiable command must never take the loop down.
            return new Plan(Kind.NONE, null, -1L, null, null);
        }
    }

    /** {@code shell_exec} / {@code file_write} / ... -> the canonical bridge name. */
    private static String canonicalTool(String tool) {
        if (tool == null) {
            return null;
        }
        String t = tool.trim().toLowerCase(java.util.Locale.ROOT);
        if ("shell_exec".equals(t)) return "exec";
        if ("file_write".equals(t)) return "write";
        if ("file_read".equals(t)) return "read";
        if ("file_list".equals(t)) return "ls";
        if ("sys_info".equals(t)) return "info";
        return t;
    }

    /**
     * {@code expect_bytes} as a usable value, or -1.
     *
     * Only a non-negative number is usable. Anything else — a negative number
     * included — is reported as -1 ("do not check"), because the caller's test is
     * {@code expectBytes >= 0 && actual != expectBytes}: a stray -5 would sail
     * past that guard and silently switch the whole byte check off.
     */
    private static long usableBytes(JSONObject o, String key) {
        if (o == null || key == null || !o.has(key)) {
            return -1L;
        }
        Object v = o.opt(key);
        if (!(v instanceof Number)) {
            return -1L;
        }
        long n = ((Number) v).longValue();
        return n >= 0L ? n : -1L;
    }

    /**
     * Reads a string field without ever throwing.
     *
     * Strictly a String: a Number or Boolean is NOT coerced. {@code path: 1234}
     * is not a path and {@code text: true} is not an expected text — coercing
     * either produces a verification target that looks legitimate and points at
     * nothing, which is worse than having no target at all.
     */
    private static String stringOf(JSONObject o, String key) {
        if (o == null || key == null) return null;
        try {
            if (!o.has(key)) return null;
            Object v = o.opt(key);
            return v instanceof String ? (String) v : null;
        } catch (Throwable t) {
            return null;
        }
    }

    private LoopVerify() {
    }
}
