// khy-canary: Khy-20261101-021-41M0VCAV
package com.khyos.khy_os_client.shell;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
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
import java.util.concurrent.TimeUnit;
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
 * APK (no second APK to install, no Shizuku), and a one-line adb command
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
 *   2. The bridge token, required on every connection. The token is read from
 *      the bridge's own directory on /sdcard at connection time — never
 *      hardcoded, never passed on a command line (a command line is world
 *      readable through /proc). If the token file is missing or malformed the
 *      sidecar refuses every connection rather than falling open.
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
 * Shizuku-style self-pairing flow. After a reboot the sidecar is gone and the
 * provisioning command has to be re-run. The overlay surfaces this as
 * "未提权" rather than pretending otherwise.
 *
 * PROTOCOL — newline-delimited, tab-separated, every variable field base64 so
 * no payload can inject a record separator or a newline:
 *
 *   PING                                   -> PONG <version>
 *   AUTH <b64 token>                       -> OK | DENY
 *   EXEC <b64 cmd> <b64 cwd> <timeoutSec>  -> RESULT <exit> <b64 out> <b64 err>
 *   INFO                                   -> INFO <uid> <b64 ident>
 *   QUIT                                   -> BYE
 *
 * Contract: pure, no Android dependencies, no logging of command contents.
 */
public final class ShellSidecar {

    /** Default port. The HTTP bridge owns 8896; this is deliberately adjacent. */
    public static final int DEFAULT_PORT = 8897;

    /** Bridge directory — same mailbox the HTTP bridge and the overlay use. */
    public static final String TOKEN_PATH = "/sdcard/bridge-amoobridge/token.txt";

    /** Output caps, mirroring the app-uid exec path so both routes behave alike. */
    private static final int STDOUT_CAP = 1024 * 1024;
    private static final int STDERR_CAP = 512 * 1024;

    /** Connection budget: a flood must not fork-bomb a uid-2000 process. */
    private static final int MAX_CONCURRENT = 4;

    private static final String VERSION = "1";

    private ShellSidecar() {}

    /**
     * The token shape rule, deliberately NOT redefined here.
     *
     * {@link com.khyos.khy_os_client.bridge.BridgeToken} is a pure class with no
     * android references, so importing it is safe under dalvikvm and keeps a
     * single source of truth. Its own javadoc spells out what happens when the
     * phone and the PC disagree about a token's shape; a second copy of the rule
     * in this package is exactly how that drift starts.
     */
    public static boolean isWellFormedToken(String t) {
        return com.khyos.khy_os_client.bridge.BridgeToken.isWellFormedToken(t);
    }

    /**
     * Read the bridge token from disk.
     *
     * Read per connection rather than cached at startup so that a token
     * rotation on the app side takes effect without restarting the sidecar,
     * and so that a sidecar started before the bridge ever wrote a token does
     * not latch a null forever.
     *
     * @return the trimmed token, or null when absent, unreadable or malformed.
     */
    static String readToken() {
        File f = new File(TOKEN_PATH);
        if (!f.isFile()) {
            return null;
        }
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] b = new byte[256];
            int n;
            while ((n = in.read(b)) > 0) {
                bos.write(b, 0, n);
            }
            String t = new String(bos.toByteArray(), StandardCharsets.UTF_8).trim();
            return isWellFormedToken(t) ? t : null;
        } catch (Throwable bad) {
            return null;
        } finally {
            if (in != null) {
                try { in.close(); } catch (Throwable ignored) {}
            }
        }
    }

    public static void main(String[] args) throws Exception {
        int port = DEFAULT_PORT;
        for (int i = 0; i < args.length - 1; i++) {
            if ("--port".equals(args[i])) {
                try {
                    port = Integer.parseInt(args[i + 1]);
                } catch (NumberFormatException ignored) {
                    // Keep the default; a bad argument is not worth dying over.
                }
            }
        }

        // Loopback only. A wildcard bind would put a uid-2000 shell on the Wi-Fi
        // interface, which is the single worst thing this class could do.
        ServerSocket server = new ServerSocket();
        server.bind(new InetSocketAddress("127.0.0.1", port), 16);
        log("listening 127.0.0.1:" + port + " as uid " + uid());

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
                    serve(s);
                }
            });
        }
    }

    // ── connection handling ─────────────────────────────────────────────────

    private static void serve(Socket s) {
        try {
            s.setSoTimeout(15000);
            s.setTcpNoDelay(true);
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            PrintWriter out = new PrintWriter(
                    new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8), false);
            boolean authed = false;
            String line;
            while ((line = in.readLine()) != null) {
                String[] f = line.split("\t", -1);
                String head = f.length > 0 ? f[0] : "";
                if ("PING".equals(head)) {
                    // Unauthenticated on purpose: it reveals only that the
                    // sidecar is up, which the overlay needs to distinguish
                    // "not started" from "started but token mismatch".
                    write(out, "PONG\t" + VERSION);
                } else if ("QUIT".equals(head)) {
                    write(out, "BYE");
                    return;
                } else if ("AUTH".equals(head)) {
                    authed = authenticate(f);
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

    private static boolean authenticate(String[] fields) {
        if (fields.length < 2) {
            return false;
        }
        String presented;
        try {
            presented = b64d(fields[1]);
        } catch (Throwable bad) {
            return false;
        }
        String expected = readToken();
        if (expected == null) {
            // Fail closed: no readable token means nothing can be authenticated,
            // so nothing runs. Never fall open to "no auth required".
            return false;
        }
        // Constant-time-ish compare: length first, then content.
        if (presented.length() != expected.length()) {
            return false;
        }
        int diff = 0;
        for (int i = 0; i < presented.length(); i++) {
            diff |= presented.charAt(i) ^ expected.charAt(i);
        }
        return diff == 0;
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
