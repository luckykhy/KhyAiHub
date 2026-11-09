// khy-canary: Khy-20261101-019-RHYC1GSF
package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * ShellSidecarClient — the app-side half of the elevated exec path.
 *
 * WHY a sidecar at all. An app-uid process cannot grant itself shell; only a
 * process that already holds shell authority can start one. {@code adb shell
 * dalvikvm} is that authority, and it runs a class that ships inside this very
 * APK — so the phone needs exactly one APK, no Shizuku install, and one adb
 * command to activate. See {@code ShellSidecar} for the mechanism, the security
 * gates, and the honest reboot limitation.
 *
 * WHY the readiness cache is a plain volatile read. The overlay refreshes every
 * two seconds on a path that must stay free of IO — reading the disk or opening
 * a socket there would reintroduce exactly the class of stall that made the old
 * token handling deadlock the whole bridge. So {@link #ready()} and
 * {@link #why()} only read memory; the cache is refreshed solely by
 * {@link #exec(String, String, int)} and {@link #probe()}, both of which are
 * called from request-handling or startup threads.
 *
 * Contract: every method is total. A missing sidecar returns null / reports
 * not-ready and never throws — the caller falls back to the app-uid path, which
 * is the normal state after a reboot.
 */
public final class ShellSidecarClient {

    /** Adjacent to the HTTP bridge's 8896. Kept in one place, not scattered. */
    static final int PORT = 8897;

    /** How long to wait for the loopback connect. A dead sidecar must fail fast. */
    private static final int CONNECT_TIMEOUT_MS = 2000;

    private static volatile boolean ready = false;
    private static volatile String why = "未探测";
    /** PING succeeded at least once. See {@link #online()}. */
    private static volatile boolean online = false;

    private ShellSidecarClient() {}

    /** Cached readiness. Zero IO — safe on the overlay ticker path. */
    public static boolean ready() {
        return ready;
    }

    /** Cached reason. Zero IO — safe on the overlay ticker path. */
    public static String why() {
        return why;
    }

    /**
     * Run one command through the sidecar.
     *
     * @return the result envelope carrying {@code via:"sidecar"}, or null when
     *         the sidecar is absent, unreachable, unauthenticated or timed out.
     *         A null return is the expected outcome on an unprovisioned device
     *         and must not be surfaced to the user as an error.
     */
    public static JSONObject exec(String cmd, String cwd, int timeoutSec) {
        try {
            String token = HttpBridge.currentToken();
            if (token.length() != 32) {
                // No token yet means the bridge has not finished starting; there
                // is nothing to authenticate with and nothing to report.
                ready = false;
                why = "桥令牌未就绪";
                return null;
            }
            final String[] box = new String[] {null};
            final String tok = token;
            Thread t = new Thread(new Runnable() {
                public void run() {
                    box[0] = roundTrip(tok, "EXEC\t" + b64(cmd) + "\t" + b64(cwd)
                            + "\t" + Math.max(1, Math.min(timeoutSec, 120)),
                            Math.max(1, timeoutSec) * 1000L + 10000L);
                }
            }, "sidecar-exec");
            t.setDaemon(true);
            t.start();
            t.join(Math.max(1, timeoutSec) * 1000L + 12000L);
            String record = box[0];
            if (record == null) {
                ready = false;
                why = "sidecar 无响应";
                return null;
            }
            JSONObject r = parseResult(record);
            if (r == null) {
                ready = false;
                why = "sidecar 协议异常";
                return null;
            }
            ready = true;
            why = "";
            return r;
        } catch (Throwable bad) {
            ready = false;
            why = "sidecar 不可达";
            return null;
        }
    }

    /**
     * Cheap liveness probe: one PING, no auth, no command.
     *
     * Used at bridge startup so the overlay can show the real elevation state
     * before the first command runs. Distinguishes "not started" from "started
     * but the token does not match", which are very different problems for
     * whoever is looking at the phone.
     */
    /**
     * 探测 sidecar 是否在线。
     *
     * 两处修正，都来自实测：
     *
     * 1. **要重试**。sidecar 是 dalvikvm 拉的 JVM，冷启动不止 3 秒。原来的单次
     *    3 秒 PING 在刚提权完的那一刻必然失败，于是 `info` 报"未提权"——而紧接着
     *    的 exec 明明走了 sidecar 并返回 Success。同一个进程里两个矛盾的答案。
     *    （实测三次都是这个形态。）
     *
     * 2. **失败时只说观察到的，不说处方**。原来失败时写"未提权（重启后需重跑 adb
     *    提权命令）"——那是猜的。PING 没应答只说明"没应答"，可能是没提权、可能是
     *    冷启动慢、可能是令牌没就绪。让用户按一个错误的原因去重跑提权命令，
     *    比没有提示更糟。
     *
     * 仍然不在这里证明"能执行"：那要令牌 + 一次真 exec。所以 PING 通但没 exec 过，
     * 一律说"待首次执行确认"——乐观的猜测比悲观的猜测更难查。
     */
    static void probe() {
        // 冷启动的 JVM 需要时间：3 秒不够就再给，累计约 6 秒。
        final int[] waits = {3000, 3000};
        String record = null;
        for (int w : waits) {
            record = roundTrip(null, "PING", w);
            if (record != null && record.startsWith("PONG")) break;
        }
        if (record == null || !record.startsWith("PONG")) {
            // 只在"曾经通过"的情况下才翻成 false。从未通过就报 false 是对的，
            // 但不该覆盖掉 exec 已经建立的 true——那个是更强的证据。
            if (ready) {
                // exec 成功过而 PING 现在不通：sidecar 可能刚被杀。
                why = "PING 未应答（此前执行成功过，sidecar 可能已退出）";
                return;
            }
            why = "PING 未应答（未提权，或 sidecar 仍在启动中）";
            return;
        }
        // PING 通了。这与 ready 是两件事，2026-10-26 在真机上被这个区别咬到：
        // ready 刻意悲观（"能不能真执行要令牌 + 一次真 exec 才能证明"），所以
        // 刚 provision 完、一次 exec 都没跑时，ready 仍是 false 而 sidecar 其实
        // 通着。调用方只看 ready 就会对用户（以及对助手）说「exec 改不动系统」——
        // 而那是假的，紧接着第一次 exec 明明成功了。online 记的就是 PING 这层，
        // 让调用方能区分"不通"和"通了但还没证实"。
        online = true;
        // Alive. Whether it will actually run anything depends on the token,
        // which only a real exec can prove — so stay pessimistic until then.
        if (!ready) {
            why = "sidecar 在线，待首次执行确认";
        } else {
            why = "";
        }
    }

    /**
     * Whether the sidecar answered a PING at least once, regardless of whether
     * an exec has confirmed it.
     *
     * Distinct from {@link #ready()}: ready is deliberately pessimistic and only
     * turns true after a real exec succeeds, so on a freshly provisioned device
     * ready is false while the sidecar is in fact listening. Callers that need
     * to tell "not elevated" from "elevated but unconfirmed" — the capability
     * description does, because it must not tell an assistant that exec cannot
     * change the system when it can — read this instead.
     */
    public static boolean online() {
        return online;
    }

    /** Open one connection, send one record, read one line, close. */
    private static String roundTrip(String token, String request, long readTimeoutMs) {
        Socket s = null;
        try {
            s = new Socket();
            s.connect(new InetSocketAddress("127.0.0.1", PORT), CONNECT_TIMEOUT_MS);
            s.setSoTimeout((int) Math.max(1000L, Math.min(readTimeoutMs, 180000L)));
            s.setTcpNoDelay(true);
            PrintWriter out = new PrintWriter(new OutputStreamWriter(
                    s.getOutputStream(), StandardCharsets.UTF_8), false);
            if (token != null) {
                out.print("AUTH\t" + b64(token) + "\n");
                out.flush();
                BufferedReader ai = reader(s);
                String ack = ai.readLine();
                if (ack == null || !"OK".equals(ack.trim())) {
                    ready = false;
                    why = "sidecar 令牌不匹配";
                    return null;
                }
            }
            out.print(request + "\n");
            out.flush();
            return reader(s).readLine();
        } catch (Throwable bad) {
            return null;
        } finally {
            if (s != null) {
                try { s.close(); } catch (Throwable ignored) {}
            }
        }
    }

    private static BufferedReader reader(Socket s) throws Exception {
        return new BufferedReader(new InputStreamReader(
                s.getInputStream(), StandardCharsets.UTF_8));
    }

    /**
     * Parse {@code RESULT <exit> <b64 out> <b64 err>} into the same envelope
     * shape the app-uid and Shizuku paths return, so callers see one contract.
     *
     * Package-private rather than private so the record grammar is covered by a
     * JVM unit test — the socket itself cannot be, and the grammar is where a
     * malformed or hostile reply would otherwise be trusted.
     */
    static JSONObject parseResult(String record) {
        try {
            String[] f = record.split("\t", -1);
            if (f.length < 3 || !"RESULT".equals(f[0])) {
                return null;
            }
            int code = Integer.parseInt(f[1].trim());
            String out = f.length > 2 ? unb64(f[2]) : "";
            String err = f.length > 3 ? unb64(f[3]) : "";
            JSONObject r = new JSONObject();
            r.put("out", out);
            if (err.length() > 0) {
                r.put("err", err);
            }
            r.put("exit", code);
            r.put("ok", code == 0);
            r.put("via", "sidecar");
            return r;
        } catch (Throwable bad) {
            return null;
        }
    }

    private static String b64(String s) {
        return Base64.getEncoder().encodeToString(
                (s == null ? "" : s).getBytes(StandardCharsets.UTF_8));
    }

    private static String unb64(String s) {
        try {
            return new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8);
        } catch (Throwable bad) {
            return "";
        }
    }
}
