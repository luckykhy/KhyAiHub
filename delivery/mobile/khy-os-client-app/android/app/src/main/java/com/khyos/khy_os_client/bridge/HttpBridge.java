package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;

/**
 * 本地 HTTP 接口：比文件信箱快，必须带令牌。
 *
 * 本类是 StepBridge 的 v2.3.0 实现，从独立 APK（com.stepx.amoobridge）并入
 * khy-os 手机端（com.khyos.khy_os_client）。并入时刻意保持的三件事：
 *   1) 端口仍是 8896、信箱目录仍是 /sdcard/bridge-amoobridge、token 文件名
 *      不变——PC 侧 khy-os 的配置零改动；
 *   2) 卡死根因修复保留：每请求零文件 IO；实测 lite 版「进程活着但全通道
 *      超时」就是旧实现每请求 synchronized 读 token.txt 撞上存储 IO 卡死导致
 *      的。所以文件 IO 只允许出现在 ensureToken() 一个方法里，且它【不是】
 *      每请求路径——请求路径走 activeToken() / tokenMatches()，两者都零 IO；
 *      展示路径（MainActivity.bridgeStatus、BridgeOverlayService.refreshPanel）
 *      走 currentToken()，同样零 IO。早先版本在 ensureToken 里起了两个异步线程，
 *      谁先落盘不定，且读盘线程会把刚生成的内存令牌反写成磁盘上的旧值，
 *      重启后必然 unauthorized；
 *   3) accept 环自愈保留：BridgeService 心跳每 10s 调 ensureRunning()。
 *
 * 与独立版唯一的功能差别：UI 工具不再由本 APK 自己的无障碍服务承接，而是
 * 路由到 app 既有的 KhyAccessibilityService（一个 app 只需一个无障碍服务）。
 */
public class HttpBridge {
    public static final int DEFAULT_PORT = 8896;
    private static volatile int port = 0;
    private static volatile boolean running = false;
    private static volatile String token = "";
    /** Whether the in-memory token reached the disk. False means the PC side cannot authenticate. */
    private static volatile boolean persisted = false;
    /** 最近一次被 PC 侧请求（经 adb forward 进来）的时间；0 = 从未。 */
    private static volatile long lastPcSeenAt = 0;
    /** 超过这个窗口没见到 PC，就认为 PC 不在（App 转独立模式）。 */
    private static final long PC_REACHABLE_WINDOW_MS = 90000L;
    private static ServerSocket server;

    /** External storage can be transiently busy right after boot; do not give up on one failure. */
    private static final int TOKEN_WRITE_ATTEMPTS = 3;

    public static int port() { return port; }

    public static boolean healthy() { return running && port > 0; }

    /** 是否已落盘（见 {@link #retryPersist()}）。 */
    public static boolean persisted() { return persisted; }

    /**
     * 记下「PC 刚来过」。桥是 loopback-only + adb forward，能进到这个位置并且
     * 通过鉴权的请求只可能来自本机 adb 转发，也就是 PC 侧。
     *
     * 用途：手机要能自己判断「现在有没有人跟我协作」。PC 不在时 App 应当照常
     * 用自己的内置通道工作（独立模式），而不是把「没连上 PC」显示成故障。
     * 判据是「多久没看到 PC」而不是「端口通不通」：端口一直是通的，PC 可能不在。
     */
    private static void notePcSeen() {
        lastPcSeenAt = System.currentTimeMillis();
    }

    /** 最近一次 PC 请求距今的毫秒数；从未见过返回 -1。 */
    public static long pcIdleMs() {
        long at = lastPcSeenAt;
        if (at <= 0) return -1;
        long idle = System.currentTimeMillis() - at;
        return idle < 0 ? 0 : idle;
    }

    /** PC 在最近 {@link #PC_REACHABLE_WINDOW_MS} 内出现过。 */
    public static boolean pcReachable() {
        long idle = pcIdleMs();
        return idle >= 0 && idle <= PC_REACHABLE_WINDOW_MS;
    }

    /**
     * 令牌落盘重试。只在自愈心跳（BridgeService.loop 的 10s 拍）里调用——不在
     * 请求路径上，也不在展示路径上。     *
     * <p>实测死锁：无「所有文件访问」时 start() 里写盘必失败，token 只剩内存
     * 份；ensureToken() 见到内存令牌非空就直接返回，start() 见到 running 也直接
     * 返回，于是用户补授权后没有任何路径把令牌补写到盘上——PC 侧每个请求都 401，
     * 只有杀进程才能自愈。这里把「补写」挂到心跳上：授权一生效，下一拍就落盘。
     */
    public static void retryPersist() {
        if (persisted) return;
        String t = token;
        if (t.length() == 0) return;
        persisted = writeTokenToDisk(t);
    }

    public static String tokenFile() { return BridgeService.BRIDGE_DIR + "/token.txt"; }

    /** 请求路径专用：绝不在此处做文件 IO。 */
    public static String activeToken() {
        return token;
    }

    /**
     * The in-memory token, with NO file IO of any kind.
     *
     * This is what display paths must use. {@link #ensureToken()} resolves the
     * token and MAY touch the disk, so calling it from a status query turns a
     * read-only screen into a disk read — and, when no token exists yet, into a
     * disk WRITE. That is exactly the class of stall the per-request-IO ban
     * exists to prevent, and it was the mistake in the first cut of this fix:
     * the javadoc claimed ensureToken was startup-only, but the overlay panel
     * and MainActivity.bridgeStatus both called it.
     *
     * Returns "" when the bridge has not resolved a token yet. Callers must
     * render that as "not started", not trigger creation.
     */
    public static String currentToken() {
        return token;
    }

    /**
     * Resolves the bridge token: adopts a well-formed on-disk one, otherwise
     * mints and persists a new one. THE ONLY METHOD IN THIS CLASS THAT MAY TOUCH
     * THE DISK.
     *
     * <p>The race this replaces: {@code ensureToken} used to generate a token,
     * then hand it to a persist thread AND to a load-file thread. Whichever
     * thread lost would write the OLD on-disk value back over the freshly
     * generated in-memory token. Measured consequence: disk and memory disagreed,
     * and once the 15s dualToken window expired every request answered
     * {@code unauthorized} — recoverable only by force-stop, deleting the token
     * file, and re-granting the accessibility service.
     *
     * <p>Now: one synchronous read, or one synchronous write, and only then
     * publish. Memory and disk cannot diverge — with two deliberate exceptions,
     * both stated rather than papered over:
     * <ul>
     *   <li>a malformed on-disk token is DISCARDED and overwritten, so a corrupt
     *       file self-heals instead of being adopted forever;</li>
     *   <li>if every write attempt fails, the token is memory-only and the PC
     *       side cannot authenticate. {@link #persisted} reports that, and
     *       {@link #retryPersist()} retries from the self-heal heartbeat — the
     *       token is not latched.</li>
     * </ul>
     *
     * <p>Callers that only want to SHOW the token must use {@link #currentToken()};
     * calling this from a display path is what made the first cut of this fix
     * turn a status query into a disk read.
     */
    public static String ensureToken() {
        String t = token;
        if (t.length() == 0) {
            synchronized (HttpBridge.class) {
                if (token.length() == 0) {
                    // 1) Adopt a WELL-FORMED on-disk token, so a restart needs no
                    //    re-read on the PC side. Shape is checked, not just length:
                    //    the PC side only accepts /^[0-9a-f]{32}$/i, and adopting
                    //    anything else would lock in a token it must reject.
                    String onDisk = readTokenFromDisk();
                    if (onDisk != null && BridgeToken.isWellFormedToken(onDisk)) {
                        token = onDisk;
                        // 采纳自磁盘 = 令牌就在盘上（PC 侧 cat token.txt 读得到）。
                        // 不置 true 的话，重启这条最常见的路径会让 token_persisted
                        // 报「否」，把「一切都好」误报成「去授所有文件访问」。
                        persisted = true;
                    } else {
                        // 2) Nothing usable on disk (absent, or malformed — which
                        //    we are about to overwrite): mint one and publish it
                        //    only after a write succeeds.
                        String fresh = generate();
                        token = fresh;
                        persisted = writeTokenToDisk(fresh);
                    }
                }
                t = token;
            }
        }
        return t;
    }

    private static String generate() {
        SecureRandom r = new SecureRandom();
        byte[] raw = new byte[16];
        r.nextBytes(raw);
        StringBuilder sb = new StringBuilder();
        for (byte x : raw) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    /** Reads the on-disk token; null when absent, unreadable, or the wrong shape. */
    private static String readTokenFromDisk() {
        FileInputStream in = null;
        try {
            File f = new File(tokenFile());
            if (!f.exists() || f.length() < 8 || f.length() > 4096) return null;
            byte[] b = new byte[(int) f.length()];
            in = new FileInputStream(f);
            int off = 0;
            while (off < b.length) {
                int n = in.read(b, off, b.length - off);
                if (n <= 0) break;
                off += n;
            }
            in.close();
            in = null;
            if (off < b.length) return null;
            String s = new String(b, "UTF-8").trim();
            // Shape, not merely length: the PC side only accepts 32 hex, and
            // adopting anything else locks in a token it must reject.
            return BridgeToken.isWellFormedToken(s) ? s : null;
        } catch (Throwable ignored) {
            return null;
        } finally {
            if (in != null) { try { in.close(); } catch (Throwable ignored) {} }
        }
    }

    /**
     * Writes the token to disk, retrying. True on success.
     *
     * A single attempt is not enough: external storage can be transiently busy
     * right after boot, and giving up on the first failure would leave the PC
     * side permanently unable to authenticate for this process lifetime.
     */
    private static boolean writeTokenToDisk(String t) {
        if (t == null || t.length() == 0) return false;
        for (int attempt = 1; attempt <= TOKEN_WRITE_ATTEMPTS; attempt++) {
            if (writeTokenOnce(t)) return true;
        }
        return false;
    }

    private static boolean writeTokenOnce(String t) {
        FileOutputStream fo = null;
        try {
            File f = new File(tokenFile());
            File parent = f.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) return false;
            fo = new FileOutputStream(f);
            fo.write(t.getBytes("UTF-8"));
            fo.flush();
            fo.getFD().sync();
            fo.close();
            fo = null;
            return true;
        } catch (Throwable ignored) {
            return false;
        } finally {
            if (fo != null) { try { fo.close(); } catch (Throwable ignored) {} }
        }
    }

    /** 鉴权：只比内存令牌。绝不碰文件。 */
    public static boolean tokenMatches(String presented) {
        if (presented == null) return false;
        String t = token;
        return t.length() > 0 && presented.equals(t);
    }

    /**
     * Binds the listening socket to LOOPBACK ONLY, never to every interface.
     *
     * <p>Measured: {@code new ServerSocket(port)} binds 0.0.0.0, and
     * {@code ss -ltn} then reports {@code *:8896} — any device on the same Wi-Fi
     * can reach the port. A Bearer token still guards it, but there is no reason
     * to expose the surface at all.
     *
     * <p>Why loopback is compatible with every real caller: the PC reaches the
     * bridge through {@code adb forward tcp:<local> tcp:<remote>}, and adbd on
     * the device completes that forward with a loopback connection — so a
     * loopback-bound server accepts it unchanged. In-app callers (AmooLoop via
     * KhyUi/Tools) go in-process and never touch HTTP. A full-repo search
     * confirmed nothing depends on reaching the bridge over a Wi-Fi IP.
     */
    public static synchronized void start(final int wantPort) {
        if (running) return;
        ensureToken();
        running = true;
        // Sidecar liveness, off the startup path: it opens a socket and must not
        // delay the bind. Without this the overlay would report elevation as
        // "not yet probed" until the first exec, which tells the user nothing
        // actionable after a reboot killed the sidecar.
        new Thread(new Runnable() {
            public void run() {
                try { Tools.probeSidecar(); } catch (Throwable ignored) {}
            }
        }, "sidecar-probe").start();
        // Shizuku, same treatment and same reason. Without it the reboot case is
        // the worst one: the sidecar is dead, there is no PC to restart it, and
        // `info` reports shizuku_why as "" — which reads as "nothing wrong".
        // Shizuku started from the phone's own wireless debugging is the only
        // elevation tier that survives a reboot without a computer.
        new Thread(new Runnable() {
            public void run() {
                try { Tools.probeShizuku(); } catch (Throwable ignored) {}
            }
        }, "shizuku-probe").start();
        // Optional-tool availability, same treatment and a different reason: it
        // costs eight getPackageInfo calls, so it must not run on the overlay's
        // zero-IO ticker — and without it the ticker would report NAMES.length,
        // a count that includes eight tools that cannot be called.
        new Thread(new Runnable() {
            public void run() {
                try { Tools.refreshAvailability(); } catch (Throwable ignored) {}
            }
        }, "avail-probe").start();
        new Thread(new Runnable() {
            public void run() {
                ServerSocket bound = null;
                try {
                    bound = new ServerSocket();
                    bound.setReuseAddress(true);
                    bound.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), wantPort), 50);
                    server = bound;
                    bound = null; // ownership transferred; the catch must not close it
                    port = wantPort;
                    while (running) {
                        final Socket s = server.accept();
                        new Thread(new Runnable() {
                            public void run() { handle(s); }
                        }).start();
                    }
                } catch (Throwable t) {
                    running = false;
                    port = 0;
                    // A failed bind leaves an OPEN-but-unbound socket behind unless
                    // it is closed here. The old one-arg constructor bound and
                    // constructed in one step, so a failure never assigned anything.
                    if (bound != null) {
                        try { bound.close(); } catch (Throwable ignored) {}
                    }
                }
            }
        }, "http-bridge").start();
    }

    /** accept 环的自愈入口：活着就什么都不做，死了就重启。 */
    public static synchronized void ensureRunning(final int wantPort) {
        if (running && port > 0) return;
        try { if (server != null) server.close(); } catch (Throwable ignored) {}
        server = null;
        running = false;
        start(wantPort);
    }

    public static synchronized void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Throwable ignored) {}
        server = null;
        port = 0;
    }

    private static void handle(Socket s) {
        try {
            s.setSoTimeout(20000); // 半开连接 20s 后回收，不再永久占线程
            BufferedInputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            String reqLine = readLine(in);
            if (reqLine == null) { s.close(); return; }
            String[] parts = reqLine.split(" ");
            String path = parts.length > 1 ? parts[1] : "/";
            Map<String, String> headers = new HashMap<String, String>();
            String line;
            while ((line = readLine(in)) != null && line.length() > 0) {
                int i = line.indexOf(':');
                if (i > 0) headers.put(line.substring(0, i).trim().toLowerCase(), line.substring(i + 1).trim());
            }
            int len = 0;
            try { len = Integer.parseInt(headers.containsKey("content-length") ? headers.get("content-length") : "0"); } catch (Throwable ignored) {}
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int remain = len;
            while (remain > 0) {
                int n = in.read(buf, 0, Math.min(buf.length, remain));
                if (n <= 0) break;
                bo.write(buf, 0, n);
                remain -= n;
            }
            String body = new String(bo.toByteArray(), "UTF-8");

            JSONObject resp = new JSONObject();
            int code = 200;
            String auth = headers.containsKey("authorization") ? headers.get("authorization") : "";
            if (!tokenMatches(auth.startsWith("Bearer ") ? auth.substring(7).trim() : "")) {
                resp.put("ok", false).put("error", "unauthorized");
                code = 401;
            } else if (path.startsWith("/ping")) {
                notePcSeen();
                resp.put("ok", true).put("pong", System.currentTimeMillis());
            } else if (path.startsWith("/status")) {
                notePcSeen();
                // tools 仍是数字（PC 侧 amooDispatchRunner.js:289、phoneCliPlan.js:235
                // 与两个 mock 测试都按数字读它，改形态会连带红一片），但改成**可用**数：
                // 报一个含 8 个调不了的名字的计数，就是让 PC 侧按它过滤模型工具面时
                // 把鬼工具放进去。
                // withheld 数组给名字和理由——「少了几个」本身不告诉任何人该干什么，
                // 装对应 App 才是下一步。与 status.json 同形（Tools.withheld()）。
                //
                // 这里是现探，而 status.json 与悬浮框读缓存（那两条每 2s 跑一次，
                // 现探要 8 次 getPackageInfo）。两者最多差一个刷新周期（10s），
                // 差异只说得出「刚装上还没报到」，方向永远是缓存偏旧——把它写在这
                // 里，而不是让比对两边的人自己去发现。
                resp.put("ok", true).put("up", running).put("port", port).put("mode", "app")
                    .put("ui", KhyUi.isReady())
                    .put("tools", Tools.availableNames().length)
                    .put("withheld", Tools.withheld());
            } else if (path.startsWith("/call")) {
                notePcSeen();
                JSONObject req = new JSONObject(body.length() == 0 ? "{}" : body);
                String tool = req.optString("tool", "");
                JSONObject args = req.optJSONObject("args");
                if (args == null) args = new JSONObject();
                resp = Tools.dispatch(tool, args);
                resp.put("tool", tool);
            } else {
                resp.put("ok", false).put("error", "not found");
                code = 404;
            }

            byte[] outB = resp.toString().getBytes("UTF-8");
            String head = "HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "ERR") + "\r\n"
                    + "Server: khy-os-bridge (" + khyBuild() + ")\r\n"
                    + "Content-Type: application/json; charset=utf-8\r\n"
                    + "Content-Length: " + outB.length + "\r\nConnection: close\r\n\r\n";
            out.write(head.getBytes("UTF-8"));
            out.write(outB);
            out.flush();
            s.close();
        } catch (Throwable t) {
            try { s.close(); } catch (Throwable ignored) {}
        }
    }

    private static String readLine(InputStream in) {
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            int c;
            while ((c = in.read()) != -1) {
                if (c == '\n') break;
                if (c != '\r') bo.write(c);
                if (bo.size() > 8192) break;
            }
            if (bo.size() == 0 && c == -1) return null;
            return new String(bo.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return null;
        }
    }

    // Delivery canary stamp, from the same "khy.build" manifest literal
    // MainActivity reads. Package-private so BridgeService logs it too. Must
    // never throw into the accept loop (same contract as every other path
    // here), and the marker charset excludes CR/LF by construction, so the
    // value cannot break the header block it is spliced into.
    static String khyBuild() {
        try {
            android.content.Context ctx = Tools.ctxRef();
            if (ctx == null) return "";
            android.content.pm.ApplicationInfo ai = ctx.getPackageManager()
                    .getApplicationInfo(ctx.getPackageName(), android.content.pm.PackageManager.GET_META_DATA);
            String v = ai.metaData == null ? null : ai.metaData.getString("khy.build");
            return v == null ? "" : v;
        } catch (Throwable t) {
            return "";
        }
    }
}
