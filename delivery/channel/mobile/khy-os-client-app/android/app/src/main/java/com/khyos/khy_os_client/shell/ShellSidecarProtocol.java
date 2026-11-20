// khy-canary: Khy-20261112-002-SHIZUKU1
package com.khyos.khy_os_client.shell;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * ShellSidecarProtocol — the request side of the elevated-exec protocol, as a
 * pure class.
 *
 * WHY a class of its own. The client half of this protocol lives in
 * {@code ShellSidecarClient}, which reaches {@code HttpBridge} and therefore
 * cannot be compiled on a bare JVM — so everything about the request framing
 * was untestable offline, and the request framing is exactly where the
 * dangerous part is. Every variable field is base64 so that no command output
 * (or any input) can contain a tab or a newline and therefore cannot forge an
 * extra field or a whole extra record. That invariant deserves a test, and a
 * test needs a class that compiles without the Android SDK.
 *
 * The server half ({@code ShellSidecar}) is pure Java too — it is started by
 * {@code dalvikvm} under uid 2000 — so the protocol as a whole is testable
 * off-device; only the socket handshake and the uid-2000 process need a phone.
 *
 * Contract: pure, deterministic, never throws.
 */
public final class ShellSidecarProtocol {

    private ShellSidecarProtocol() {}

    /** The command that runs a command with no input. */
    public static final String CMD_EXEC = "EXEC";

    /** The command that runs a command and feeds it stdin. */
    public static final String CMD_EXEC_IN = "EXEC_IN";

    /** Upper bound on the timeout the sidecar will honour. */
    public static final int MAX_TIMEOUT_SEC = 120;

    /**
     * The request record for a plain exec.
     *
     * <p>Shape: {@code EXEC <b64 cmd> <b64 cwd> <timeout>}.
     */
    public static String execRecord(String cmd, String cwd, int timeoutSec) {
        return CMD_EXEC + "\t" + b64(cmd) + "\t" + b64(cwd) + "\t" + clampTimeout(timeoutSec);
    }

    /**
     * The request record for an exec that carries stdin.
     *
     * <p>Shape: {@code EXEC_IN <b64 cmd> <b64 cwd> <b64 stdin> <timeout>}.
     *
     * <p>This is the sidecar's move toward IRemoteProcess-style parity: three
     * pipes, and before this command a command could not be handed any data
     * at all.
     */
    public static String execInRecord(String cmd, String cwd, String stdin, int timeoutSec) {
        return CMD_EXEC_IN + "\t" + b64(cmd) + "\t" + b64(cwd) + "\t" + b64(stdin) + "\t"
                + clampTimeout(timeoutSec);
    }

    /** The sidecar's answer to an exec: {@code RESULT <exit> <b64 out> <b64 err>}. */
    public static String resultRecord(int exit, String out, String err) {
        return "RESULT\t" + exit + "\t" + b64(out) + "\t" + b64(err);
    }

    /** A timeout outside the allowed window is clamped, never dropped. */
    public static int clampTimeout(int timeoutSec) {
        return Math.max(1, Math.min(timeoutSec, MAX_TIMEOUT_SEC));
    }

    /** Base64 of the UTF-8 bytes; null becomes the empty string. */
    public static String b64(String s) {
        if (s == null) {
            return "";
        }
        return Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }

    /** Inverse of {@link #b64}. */
    public static String unb64(String s) {
        if (s == null || s.isEmpty()) {
            return "";
        }
        return new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8);
    }
}
