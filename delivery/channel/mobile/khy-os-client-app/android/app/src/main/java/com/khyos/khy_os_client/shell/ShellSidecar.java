// khy-canary: Khy-20261101-021-41M0VCAV
package com.khyos.khy_os_client.shell;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * ShellSidecar — the elevated half of the phone bridge, as pure Java.
 *
 * WHY this exists as a separate class in its own package, and why it imports
 * nothing from {@code android.*}:
 *
 * An app-uid process cannot obtain shell privilege by itself — that is an OS
 * boundary, not an implementation gap. Something that already holds shell
 * authority has to start the elevated process. On this device that something is
 * {@code adb shell dalvikvm}: adbd already runs as uid 2000, and dalvikvm can
 * execute this class under that uid. So the capability ships inside the khy-os
 * APK (no second APK to install, no third-party elevation app), and a one-line adb command
 * activates it.
 *
 * The {@code android.*}-free constraint is not stylistic: dalvikvm loads only
 * the classes reachable from {@link #main}, and any android import would drag
 * in framework classes that need libandroid_runtime — which is exactly why
 * {@code adb shell app_process} dies with UnsatisfiedLinkError here. Pure Java
 * has no such dependency.
 *
 * SECURITY — read before touching anything in this file. This process runs
 * commands as uid 2000 (shell), which on this device means {@code pm uninstall},
 * {@code setprop}, {@code reboot}, {@code dd if=} all genuinely work. It is
 * therefore a privilege-escalation surface for every app on the phone unless it
 * is gated, so it is gated twice:
 *
 *   1. Loopback only. {@code 127.0.0.1}, never a wildcard bind.
 *   2. Proof of the CALLER's identity, per connection. The caller must hold the
 *      device's private key — the same key the HTTP bridge signs PC
 *      certificates with — and prove it by signing a fresh challenge
 *      ({@code HELLO} → {@code CHALLENGE}, {@code AUTH <sig>}). The public key
 *      arrives on the command line at launch; the private key never leaves the
 *      app's private directory.
 *
 * WHY THE OLD GATE IS GONE (measured 2026-11-17). This class used to read a
 * shared bridge token from {@code /sdcard/bridge-amoobridge/token.txt}. The
 * bridge deliberately stopped writing that file: a 32-hex string on shared
 * storage is readable by any app with storage permission, so "holds the bridge
 * token" was never a claim about who is calling (see the 断点二 note in
 * {@code HttpBridge}). With the file gone this class failed CLOSED — every
 * connection was denied, and the sidecar was dead weight that still bound a
 * uid-2000 port. A signature over a per-connection challenge is the same claim
 * the bridge makes, and it needs no secret on disk anywhere.
 *
 * The third gate is NOT here and must never move into here: {@code LoopModes}
 * decides which commands are allowed at all, in every mode including bypass.
 * This class is a transport; it deliberately has no opinion about what it is
 * asked to run. Moving policy inwards would split the safety floor across two
 * processes and make it unauditable.
 *
 * PERSISTENCE — the honest limitation. Nothing on the device will restart this
 * process after a reboot: doing so needs root, a DevicePolicyManager
 * device-owner provisioning (blocked here by two existing accounts), or a
 * a self-pairing flow of the kind third-party elevation agents use. After a reboot the sidecar is gone and the
 * provisioning command has to be re-run. The overlay surfaces this as
 * "未提权" rather than pretending otherwise.
 *
 * PROTOCOL — newline-delimited, tab-separated, every variable field base64 so
 * no payload can inject a record separator or a newline:
 *
 *   PING                            -> PONG <version>
 *   HELLO                           -> CHALLENGE <b64 32 random bytes>
 *   AUTH <b64 sig over challenge>   -> OK | DENY
 *   EXEC <b64 cmd> <b64 cwd> <sec>  -> RESULT <exit> <b64 out> <b64 err>
 *   INFO                            -> INFO <uid> <b64 ident>
 *   QUIT                            -> BYE
 *
 * PING is deliberately unauthenticated: it answers only "is this port alive",
 * which is what the overlay needs to tell "not started" from "started but the
 * caller cannot prove who it is". Everything else needs AUTH first.
 *
 * Contract: pure, no Android dependencies, no logging of command contents.
 */
public final class ShellSidecar {

    /** Default port. The HTTP bridge owns 8896; this is deliberately adjacent. */
    public static final int DEFAULT_PORT = 8897;

    /** How many random bytes a challenge carries. */
    private static final int CHALLENGE_BYTES = 32;

    private static final java.security.SecureRandom RANDOM = new java.security.SecureRandom();

    /** Output caps, mirroring the app-uid exec path so both routes behave alike. */
    private static final int STDOUT_CAP = 1024 * 1024;
    private static final int STDERR_CAP = 512 * 1024;

    /** Connection budget: a flood must not fork-bomb a uid-2000 process. */
    private static final int MAX_CONCURRENT = 4;

    private static final String VERSION = "1";

    private ShellSidecar() {}

    /**
     * A fresh challenge, as base64 text.
     *
     * Text rather than raw bytes on purpose: the caller signs the same string
     * it received, so neither side has to agree on a binary encoding of it.
     */
    private static String newChallenge() {
        byte[] b = new byte[CHALLENGE_BYTES];
        RANDOM.nextBytes(b);
        return Base64.getEncoder().encodeToString(b);
    }

    /**
     * Check a signature over the challenge against the caller's public key.
     *
     * Fresh per connection, so a recorded exchange cannot be replayed: the
     * nonce in a signature captured yesterday does not match today's
     * challenge. And the claim being proven is "I hold the device private key"
     * — the same claim the HTTP bridge makes of a PC certificate, verified the
     * same way (SHA256withECDSA over UTF-8 bytes).
     */
    private static boolean verifyChallenge(String challenge, String[] fields,
            java.security.PublicKey key) {
        if (key == null || challenge == null || fields.length < 2) {
            return false;
        }
        try {
            byte[] sig = Base64.getDecoder().decode(fields[1]);
            java.security.Signature s = java.security.Signature.getInstance("SHA256withECDSA");
            s.initVerify(key);
            s.update(challenge.getBytes(StandardCharsets.UTF_8));
            return s.verify(sig);
        } catch (Throwable bad) {
            // A malformed signature is a failed proof, not a crash.
            return false;
        }
    }

    /**
     * Why a proof was refused, in one short phrase for the log.
     *
     * The distinctions that matter are "there is no key to check against",
     * "the JVM under app_process cannot do ECDSA at all" and "it did the
     * arithmetic and the answer was no" — they need completely different
     * fixes, and a bare DENY cannot tell them apart. Never log the nonce or
     * the signature itself.
     */
    private static String whyDenied(String challenge, String[] fields,
            java.security.PublicKey key) {
        if (key == null) {
            return "no caller key was given at launch";
        }
        if (challenge == null) {
            return "no outstanding challenge (AUTH before HELLO, or a repeat)";
        }
        if (fields.length < 2) {
            return "AUTH carried no signature";
        }
        byte[] sig;
        try {
            sig = Base64.getDecoder().decode(fields[1]);
        } catch (Throwable bad) {
            return "signature is not base64 (" + bad.getClass().getSimpleName() + ")";
        }
        try {
            java.security.Signature s = java.security.Signature.getInstance("SHA256withECDSA");
            s.initVerify(key);
            s.update(challenge.getBytes(StandardCharsets.UTF_8));
            if (s.verify(sig)) {
                return "accepted on re-check (challenge was already burned?)";
            }
            // Same arithmetic, wrong answer. The two hashes are what tell the
            // two sides apart: if the challenge hashes differ, the nonce the
            // caller signed is not the one we verified (a transport or framing
            // problem); if they match, the signature or the key is.
            return "signature does not match the challenge under the given key"
                    + " [challenge sha256=" + sha256Prefix(challenge)
                    + ", signature sha256=" + sha256Prefix(fields[1]) + "]";
        } catch (Throwable bad) {
            return "SHA256withECDSA unavailable under app_process: "
                    + bad.getClass().getName() + ": " + bad.getMessage();
        }
    }

    /** First 8 hex chars of a string's SHA-256 — enough to compare two sides. */
    private static String sha256Prefix(String s) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 4; i++) {
                sb.append(String.format("%02x", d[i]));
            }
            return sb.toString();
        } catch (Throwable bad) {
            return "?";
        }
    }

    /**
     * Parse the caller's public key, as handed over on the command line.
     *
     * A public key is not a secret — it is the half of the pair that may travel
     * anywhere — so passing it as an argument costs nothing and keeps the other
     * half out of every file on the device.
     *
     * @return the key, or null when the argument is absent or unparsable. Null
     *         means "deny everything", which is the safe direction.
     */
    private static java.security.PublicKey parseCallerKey(String b64) {
        if (b64 == null || b64.isEmpty()) {
            return null;
        }
        try {
            return java.security.KeyFactory.getInstance("EC").generatePublic(
                    new java.security.spec.X509EncodedKeySpec(
                            Base64.getDecoder().decode(b64)));
        } catch (Throwable bad) {
            return null;
        }
    }

    public static void main(String[] args) throws Exception {
        int port = DEFAULT_PORT;
        java.security.PublicKey callerKey = null;
        for (int i = 0; i < args.length - 1; i++) {
            if ("--port".equals(args[i])) {
                try {
                    port = Integer.parseInt(args[i + 1]);
                } catch (NumberFormatException ignored) {
                    // Keep the default; a bad argument is not worth dying over.
                }
            } else if ("--pub".equals(args[i])) {
                callerKey = parseCallerKey(args[i + 1]);
            }
        }

        // Loopback only. A wildcard bind would put a uid-2000 shell on the Wi-Fi
        // interface, which is the single worst thing this class could do.
        ServerSocket server = new ServerSocket();
        server.bind(new InetSocketAddress("127.0.0.1", port), 16);
        log("listening 127.0.0.1:" + port + " as uid " + uid()
                + (callerKey == null ? " (no caller key: every request will be denied)" : ""));

        final java.security.PublicKey key = callerKey;
        ExecutorService pool = Executors.newFixedThreadPool(MAX_CONCURRENT,
                new ThreadFactory() {
                    private final AtomicInteger n = new AtomicInteger(1);
                    public Thread newThread(Runnable r) {
                        Thread t = new Thread(r, "sidecar-" + n.getAndIncrement());
                        t.setDaemon(true);
                        return t;
                    }
                });

        while (true) {
            final Socket s = server.accept();
            pool.execute(new Runnable() {
                public void run() {
                    serve(s, key);
                }
            });
        }
    }

    // ── connection handling ─────────────────────────────────────────────────

    private static void serve(Socket s, java.security.PublicKey callerKey) {
        try {
            s.setSoTimeout(15000);
            s.setTcpNoDelay(true);
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            PrintWriter out = new PrintWriter(
                    new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8), false);
            boolean authed = false;
            String challenge = null;
            String line;
            while ((line = in.readLine()) != null) {
                String[] f = line.split("\t", -1);
                String head = f.length > 0 ? f[0] : "";
                if ("PING".equals(head)) {
                    // Unauthenticated on purpose: it reveals only that the
                    // sidecar is up, which the overlay needs to distinguish
                    // "not started" from "started but the caller cannot prove
                    // who it is".
                    write(out, "PONG\t" + VERSION);
                } else if ("QUIT".equals(head)) {
                    write(out, "BYE");
                    return;
                } else if ("HELLO".equals(head)) {
                    // A new challenge per connection. Asking again is allowed
                    // (a fresh one replaces the old), which costs nothing and
                    // means a caller that lost its reply can just re-ask.
                    challenge = newChallenge();
                    write(out, "CHALLENGE\t" + challenge);
                } else if ("AUTH".equals(head)) {
                    authed = verifyChallenge(challenge, f, callerKey);
                    if (!authed) {
                        log("auth denied: " + whyDenied(challenge, f, callerKey));
                    }
                    // Burn the challenge either way: a second AUTH with the
                    // same nonce must not pass on the strength of the first.
                    challenge = null;
                    write(out, authed ? "OK" : "DENY");
                } else if ("EXEC".equals(head)) {
                    if (!authed) {
                        write(out, "DENY");
                        continue;
                    }
                    if (f.length < 4) {
                        write(out, "RESULT\t2\t\tmalformed request");
                        continue;
                    }
                    write(out, exec(b64d(f[1]), b64d(f[2]), parseInt(f[3], 20)));
                } else if ("EXEC_IN".equals(head)) {
                    // The stdin-carrying variant, added for IRemoteProcess-style
                    // parity (three pipes instead of two; we could not feed a
                    // command anything before this).
                    //
                    // The old EXEC command is untouched: existing callers keep
                    // their record shape, and this one is purely additive.
                    if (!authed) {
                        write(out, "DENY");
                        continue;
                    }
                    if (f.length < 5) {
                        write(out, "RESULT\t2\t\tmalformed request");
                        continue;
                    }
                    write(out, exec(b64d(f[1]), b64d(f[2]), b64d(f[3]), parseInt(f[4], 20)));
                } else if ("INFO".equals(head)) {
                    if (!authed) {
                        write(out, "DENY");
                        continue;
                    }
                    write(out, "INFO\t" + uid() + "\t" + b64e(ident()));
                } else {
                    write(out, "ERR\tunknown command");
                }
            }
        } catch (Throwable bad) {
            // A dropped connection is normal; anything else is not worth
            // surfacing through the one line of log we are allowed.
        } finally {
            close(s);
        }
    }

    // ── command execution ───────────────────────────────────────────────────

    /**
     * Run one command and return the RESULT record.
     *
     * The command is handed to {@code /system/bin/sh -c} so callers get normal
     * shell syntax, exactly like the app-uid path. There is no policy here —
     * LoopModes is the gate and it runs before this is ever reached.
     */
    private static String exec(String cmd, String cwd, int timeoutSec) {
        return exec(cmd, cwd, null, timeoutSec);
    }

    /**
     * Run one command, optionally feeding it {@code stdin}.
     *
     * <p>The stdin bytes are written to the child's stdin and the pipe is then
     * closed — a command that reads to EOF (cat, wc, a python script) sees the
     * data and terminates, which is the whole point: without this, the only
     * way to hand a command data was to embed it in the command line.
     */
    private static String exec(String cmd, String cwd, String stdin, int timeoutSec) {
        if (cmd == null || cmd.length() == 0) {
            return "RESULT\t2\t\tempty command";
        }
        int budget = Math.max(1, Math.min(timeoutSec, 120));
        Process p = null;
        try {
            ProcessBuilder pb = new ProcessBuilder("/system/bin/sh", "-c", cmd);
            File dir = (cwd == null || cwd.length() == 0) ? null : new File(cwd);
            if (dir != null && dir.isDirectory()) {
                pb.directory(dir);
            }
            pb.redirectErrorStream(false);
            p = pb.start();

            if (stdin != null) {
                java.io.OutputStream in = p.getOutputStream();
                try {
                    in.write(stdin.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    in.flush();
                } finally {
                    try {
                        in.close();
                    } catch (Throwable ignored) {
                    }
                }
            }

            final ByteArrayOutputStream out = new ByteArrayOutputStream();
            final ByteArrayOutputStream err = new ByteArrayOutputStream();
            Thread ot = pump(p.getInputStream(), out, STDOUT_CAP);
            Thread et = pump(p.getErrorStream(), err, STDERR_CAP);
            ot.start();
            et.start();

            long deadline = System.currentTimeMillis() + budget * 1000L;
            boolean done = false;
            while (System.currentTimeMillis() < deadline) {
                try {
                    p.exitValue();
                    done = true;
                    break;
                } catch (IllegalThreadStateException e) {
                    Thread.sleep(50);
                }
            }
            if (!done) {
                p.destroyForcibly();
                ot.join(300);
                et.join(300);
                return "RESULT\t124\t" + b64e(out.toString("UTF-8"))
                        + "\ttimeout " + budget + "s";
            }
            ot.join(1000);
            et.join(1000);
            int code = p.exitValue();
            return "RESULT\t" + code + "\t" + b64e(out.toString("UTF-8"))
                    + "\t" + b64e(err.toString("UTF-8"));
        } catch (Throwable bad) {
            return "RESULT\t1\t\t" + b64e(bad.getClass().getSimpleName() + ": " + bad.getMessage());
        } finally {
            if (p != null) {
                try { p.destroy(); } catch (Throwable ignored) {}
            }
        }
    }

    /**
     * Drain a stream with a hard cap.
     *
     * The cap matters more here than on the app side: this process is uid 2000
     * and an uncapped read of, say, {@code cat /dev/block/...} would OOM it.
     */
    private static Thread pump(final InputStream is, final ByteArrayOutputStream sink, final int cap) {
        return new Thread(new Runnable() {
            public void run() {
                try {
                    byte[] b = new byte[4096];
                    int n;
                    while ((n = is.read(b)) > 0) {
                        if (sink.size() >= cap) {
                            return; // stop draining; the process will block on write
                        }
                        sink.write(b, 0, Math.min(n, cap - sink.size()));
                    }
                } catch (Throwable ignored) {
                    // Stream closed under us — the process died. Nothing to do.
                }
            }
        }, "sidecar-pump");
    }

    // ── token ───────────────────────────────────────────────────────────────
    // readToken() lives up with the token shape rule; see "the token shape rule".

    // ── small helpers ───────────────────────────────────────────────────────

    private static void write(PrintWriter out, String record) {
        out.print(record);
        out.print("\n");
        out.flush();
    }

    private static String b64e(String s) {
        if (s == null) {
            return "";
        }
        return Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }

    private static String b64d(String s) {
        return new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8);
    }

    private static int parseInt(String s, int fallback) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Throwable bad) {
            return fallback;
        }
    }

    private static String uid() {
        try {
            Process p = new ProcessBuilder("/system/bin/id", "-u")
                    .redirectErrorStream(true).start();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] b = new byte[128];
            int n;
            while ((n = p.getInputStream().read(b)) > 0) {
                bos.write(b, 0, n);
            }
            p.waitFor();
            return new String(bos.toByteArray(), StandardCharsets.UTF_8).trim();
        } catch (Throwable bad) {
            return "?";
        }
    }

    /** One line of identity for the INFO command — no command contents, ever. */
    private static String ident() {
        return "shell-sidecar " + VERSION;
    }

    private static void close(Socket s) {
        if (s == null) {
            return;
        }
        try { s.close(); } catch (Throwable ignored) {}
    }

    private static void log(String s) {
        System.out.println("[sidecar] " + s);
        System.out.flush();
    }
}
