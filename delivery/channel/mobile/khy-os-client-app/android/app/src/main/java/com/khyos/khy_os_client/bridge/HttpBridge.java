package com.khyos.khy_os_client.bridge;

import org.json.JSONArray;
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
 *      的。所以文件 IO 只允许出现在 ensureToken() 与 resetToken() 两个方法里，
 *      且两者都【不是】每请求路径——请求路径走 activeToken() / tokenMatches()，
 *      两者都零 IO（resetToken 是控制台的人工动作，天然低频）；
 *      loadGuide() 是后并入的第二个 IO 点（每进程只读一次指南 asset，之后
 *      纯内存应答），同样不进每请求路径；
 *      展示路径（MainActivity.bridgeStatus、BridgeOverlayService.refreshPanel）
 *      走 currentToken()，同样零 IO。早先版本在 ensureToken 里起了两个异步线程，
 *      谁先落盘不定，且读盘线程会把刚生成的内存令牌反写成磁盘上的旧值，
 *      重启后必然 unauthorized；
 *   3) accept 环自愈保留：BridgeService 心跳每 10s 调 ensureRunning()。
 * 并入后新增：resetToken()（控制台的显式重置，旧令牌即时失效、回执只带指纹）、
 * 401 回执带 code=token_mismatch 与 token_age_ms（静默 401 说不清「内存与盘
 * 已分叉」这件事，2026-11-14 实测）、token.txt 原子落盘（.tmp + rename）。
 *
 * 与独立版唯一的功能差别：UI 工具不再由本 APK 自己的无障碍服务承接，而是
 * 路由到 app 既有的 KhyAccessibilityService（一个 app 只需一个无障碍服务）。
 * 并入后新增：/ping 心跳字段、/call 信封校验（参数闭集 + guide_topic）、
 * /agent-guide 指南端点——契约原文见 assets/khy_bridge_guide.md。
 */
public class HttpBridge {
    public static final int DEFAULT_PORT = 8896;
    private static volatile int port = 0;
    private static volatile boolean running = false;
    private static volatile String token = "";
    /** Whether the in-memory token reached the disk. False means the PC side cannot authenticate. */
    private static volatile boolean persisted = false;
    /** 当前内存令牌开始生效的时刻（铸成 / 采纳 / 重置）；token_age_ms 的分母。0 = 从未解析。 */
    private static volatile long tokenSinceMs = 0;
    /** 最近一次被 PC 侧请求（经 adb forward 进来）的时间；0 = 从未。 */
    private static volatile long lastPcSeenAt = 0;
    /** 超过这个窗口没见到 PC，就认为 PC 不在（App 转独立模式）。 */
    private static final long PC_REACHABLE_WINDOW_MS = 90000L;
    /**
     * 持有证明的时间窗。60 秒：够一次 adb forward 的请求往返，短到抓到一个签名
     * 也来不及在别的请求上复用（何况签名还绑了路径与请求体）。
     */
    private static final long POP_WINDOW_MS = 60000L;

    /** 配对码通知的固定 id。换 id 就会在通知栏堆出多个码，只有最新那个有效。 */
    private static final int NOTIFY_ID_PAIRING = 0x4B4859;
    private static ServerSocket server;

    /**
     * 配对码（断点二）。与 SandboxVault 的那一个**刻意分开**：共用一个实例的话，
     * 一次凭据写入的码也能用来换证书，等于把「写一条沙箱凭据」的授权升级成
     * 「这台设备认我这个 PC」——权限混淆，且用户看不出自己批了什么。
     */
    private static final ProvisioningCode pairingCode = new ProvisioningCode();

    /** App 上下文。只为拿私有目录（密钥对落点），不持有 Activity。 */
    private static volatile android.content.Context appContext;

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

    /**
     * PC 此刻是否可达。两条判据取或，缺一不可：
     *
     * <p>① 出向链路活着（{@link BridgeLinkState#alive()}）。这是主动判据：设备
     * 自己发过 ping、收到过 pong，所以「服务端此刻能下发指令」是它知道的事。
     *
     * <p>② 入向窗口：PC 在最近 {@link #PC_REACHABLE_WINDOW_MS} 内敲过门。
     *
     * <p>WHY 必须补 ①：原来的唯一判据是 ②，而出向通道为零时设备只能等对方来敲；
     * adb 隧道一断，②永远为 false，于是 {@code pc_reachable} 恒 false——那不是
     * 「PC 不在」，是「设备看不见 PC」。把出向链路的 pong 也算进来之后，false
     * 才重新只表示一件事：两条路都不通。
     */
    public static boolean pcReachable() {
        if (BridgeLinkState.alive()) return true;
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

    /** 当前令牌已生效多少毫秒；从未解析过返回 -1。 */
    public static long tokenAgeMs() {
        long at = tokenSinceMs;
        return at <= 0 ? -1 : System.currentTimeMillis() - at;
    }

    /**
     * 显式重置令牌：旧值立即失效，新值铸成并落盘，回执只带指纹。
     *
     * <p>为什么先发布内存再写盘：重置的目的是「旧令牌马上不能再进」。若等落盘
     * 成功才换内存令牌，写盘失败的那段时间里旧令牌仍然有效——那正好是重置想
     * 关掉的窗口。反过来，写盘失败时新令牌只在内存（{@link #persisted()} 为
     * false），PC 侧仍持盘上的旧值、每个请求 401，直到「所有文件访问」授予后
     * 自愈心跳补写——回执的 persisted 字段必须把这个状态说出去，不能让调用方
     * 以为已经落盘。
     *
     * <p>回执只带新旧指纹（前 8 位 + 生效时间戳），完整令牌不出现在界面、日志
     * 或 console_history 里：那条历史文件是共享的，PC 侧读得到。
     *
     * <p>与 {@link #ensureToken()} 同一把锁：两者都会改「内存令牌 ↔ 盘上令牌」
     * 的配对关系。不串行化的坏交织是——ensureToken 在临界区里读到盘上的旧值，
     * 重置同时把新值写盘并发布到内存，ensureToken 再把旧值发布回内存：于是
     * 内存与盘分叉，正是本类存在以来最贵的那类故障。
     */
    public static JSONObject resetToken() {
        JSONObject out = new JSONObject();
        try {
            String old;
            long oldSince;
            String fresh;
            long now;
            boolean ok;
            synchronized (HttpBridge.class) {
                old = token;
                oldSince = tokenSinceMs;
                fresh = generate();
                now = System.currentTimeMillis();
                token = fresh;
                tokenSinceMs = now;
                ok = writeTokenToDisk(fresh);
                persisted = ok;
            }
            out.put("ok", true)
               .put("reset", true)
               .put("old_fingerprint", BridgeToken.fingerprint(old))
               .put("old_fp_at", oldSince)
               .put("old_age_ms", oldSince <= 0 ? -1 : now - oldSince)
               .put("new_fingerprint", BridgeToken.fingerprint(fresh))
               .put("new_fp_at", now)
               .put("persisted", persisted)
               .put("ts", now);
            if (!persisted) {
                out.put("error", "新令牌只在内存：写盘失败（未授予「所有文件访问」时必然如此）。"
                        + "PC 侧仍持盘上的旧令牌，会持续 401，直到授权后由自愈心跳补写");
            }
        } catch (Throwable t) {
            try {
                out.put("ok", false).put("reset", false)
                   .put("error", "重置失败：" + t.getClass().getSimpleName());
            } catch (Throwable ignored) {}
        }
        return out;
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
     * mints and persists a new one. One of only TWO methods here that may touch
     * the disk — the other is {@link #resetToken()}, and neither is on the
     * request path.
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
                        tokenSinceMs = System.currentTimeMillis();
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
                        tokenSinceMs = System.currentTimeMillis();
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
        // 断点二：明文令牌不再落共享存储。
        //
        // 这里保留方法而不是删掉调用点，是为了让「谁在试图写」这件事仍然有
        // 一个落点：返回 false 之后 persisted 恒 false，status.json 的
        // token_persisted 会如实说「没落盘」，界面上的那句提示也就跟着改成
        // 「已停用明文令牌」。删掉方法的话，调用点会编译不过，下一个人只会
        // 把它加回来。
        return false;
    }

    /**
     * 删掉升级前留下的 token.txt（含 .tmp）。
     *
     * 只停写不删等于没改：盘上那份仍是有效的长期凭据，`cat` 一下就能继续用，
     * T5 的静态扫描也照样扫得到。删除是这次切换的一部分。
     */
    private static void purgeLegacyTokenFile() {
        try {
            File f = new File(tokenFile());
            if (f.isFile() && !f.delete()) {
                android.util.Log.w("HttpBridge", "旧 token.txt 删除失败（PC 侧仍可读到它）");
            }
            File tmp = new File(f.getAbsolutePath() + ".tmp");
            if (tmp.isFile()) tmp.delete();
        } catch (Throwable ignored) {}
    }

    /**
     * 鉴权：只认设备签发的 PC 证书。
     *
     * <p>为什么不再认共享 token：那正是断点二要拆的东西——一个躺在 /sdcard 上、
     * 任何有存储权限的进程都能读的 32 位十六进制。证书的签名只有设备私钥做得出，
     * 而私钥从不出私有目录，所以「出示得出有效证书」真的是一句关于调用者身份的主张。
     *
     * <p>回执必须带机器可判的 code：静默 401 在断点二里比之前更糟——之前至少
     * 只有一种失败（token 不匹配），现在有「没配对」「证书过期」「证书不是这台
     * 设备签的」三种，下一步动作完全不同。
     */
    private static boolean authorized(String presented, JSONObject resp) {
        return authorized(presented, resp, null, "GET", "/", "");
    }

    /**
     * 鉴权 + 持有证明。
     *
     * <p>只验证书是不够的：证书是「设备签过的一段 JSON」，抄走就能用，那样它只是
     * 换了个位置的 bearer token。所以每个请求还必须带一份用**PC 自己的私钥**签的
     * 持有证明：
     * <pre>X-Khy-Sig = base64(ECDSA_P256(SHA256(method|path|ts|sha256(body))))</pre>
     * 公钥在证书的 {@code pc_key} 里，设备用它验。签名绑定了方法、路径、时间与
     * 请求体，所以抄到证书的人没有私钥签不出来，抄到一次签名也换不了路径或请求体。
     *
     * <p>回执必须带机器可判的 code：静默 401 在断点二里比之前更糟——之前至少
     * 只有一种失败（token 不匹配），现在有「没配对」「证书过期」「证书不是这台
     * 设备签的」「没有持有证明」四种，下一步动作完全不同。
     */
    private static boolean authorized(String presented, JSONObject resp,
                                      Map<String, String> headers, String method,
                                      String path, String body) {
        if (presented == null || presented.isEmpty()) {
            try {
                resp.put("ok", false).put("error", "unauthorized")
                    .put("code", DeviceIdentity.ERR_PAIRING_REQUIRED)
                    .put("hint", "POST /pair/code 取一次性码（显示在手机通知栏），"
                            + "再 POST /pair {\"code\":\"…\",\"pc_key\":\"<base64 SPKI>\"} 换证书，"
                            + "之后每个请求带 Authorization: Bearer <证书 JSON 的 base64> "
                            + "+ X-Khy-Ts / X-Khy-Sig（持有证明）");
            } catch (Throwable ignored) {}
            return false;
        }
        JSONObject cert = null;
        try {
            String text = presented;
            if (!text.startsWith("{")) {
                text = new String(android.util.Base64.decode(text, android.util.Base64.DEFAULT), "UTF-8");
            }
            cert = new JSONObject(text);
        } catch (Throwable ignored) {}
        if (appContext == null) {
            // start(port) 的单参重载（旧调用点）不会带 Context：那时既没有密钥目录
            // 也没有可签的证书，只能 fail closed。报明确码，不要静默 401。
            try {
                resp.put("ok", false).put("error", "unauthorized")
                    .put("code", "identity_unavailable")
                    .put("hint", "桥以无 Context 方式启动：改用 start(port, context)");
            } catch (Throwable ignored) {}
            return false;
        }
        JSONObject verdict = DeviceIdentity.verifyPcCert(appContext, cert, System.currentTimeMillis());
        if (!verdict.optBoolean("ok", false)) {
            try {
                resp.put("ok", false).put("error", "unauthorized")
                    .put("code", verdict.optString("code", DeviceIdentity.ERR_CERT_INVALID))
                    .put("hint", DeviceIdentity.ERR_PAIRING_REQUIRED.equals(verdict.optString("code"))
                            ? "先配对" : "重新配对：POST /pair/code → POST /pair");
            } catch (Throwable ignored) {}
            return false;
        }
        String pcKey = verdict.optString("pc_key", "");
        String tsRaw = headers == null ? "" : headers.get("x-khy-ts");
        String sig = headers == null ? "" : headers.get("x-khy-sig");
        if (tsRaw == null || tsRaw.isEmpty() || sig == null || sig.isEmpty()) {
            try {
                resp.put("ok", false).put("error", "unauthorized")
                    .put("code", "pop_required")
                    .put("hint", "带 X-Khy-Ts 与 X-Khy-Sig：sig 用配对时的私钥签 "
                            + "method|path|ts|sha256(body)");
            } catch (Throwable ignored) {}
            return false;
        }
        long ts;
        try {
            ts = Long.parseLong(tsRaw.trim());
        } catch (Throwable t) {
            ts = 0;
        }
        if (ts <= 0 || Math.abs(System.currentTimeMillis() - ts) > POP_WINDOW_MS) {
            try {
                resp.put("ok", false).put("error", "unauthorized")
                    .put("code", "pop_stale").put("window_ms", POP_WINDOW_MS);
            } catch (Throwable ignored) {}
            return false;
        }
        if (!verifyPop(pcKey, method, path, ts, body, sig)) {
            try {
                resp.put("ok", false).put("error", "unauthorized").put("code", "pop_invalid");
            } catch (Throwable ignored) {}
            return false;
        }
        return true;
    }

    /**
     * 持有证明的规范串。与 PC 侧
     * {@code phoneBridgeCredential.popPayload} 必须逐字节一致——两处各写一个
     * 「同一个」规范串，正是「合法请求突然报 pop_invalid」的来源。
     */
    static String popPayload(String method, String path, long ts, String body) {
        return (method == null ? "GET" : method.toUpperCase()) + "|" + path + "|" + ts + "|"
                + sha256Hex(body == null ? "" : body);
    }

    private static String sha256Hex(String text) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(text.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder(64);
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    private static boolean verifyPop(String pcKeyB64, String method, String path,
                                     long ts, String body, String sigB64) {
        try {
            byte[] der = android.util.Base64.decode(pcKeyB64, android.util.Base64.DEFAULT);
            java.security.PublicKey pub = java.security.KeyFactory.getInstance("EC")
                    .generatePublic(new java.security.spec.X509EncodedKeySpec(der));
            java.security.Signature s = java.security.Signature.getInstance("SHA256withECDSA");
            s.initVerify(pub);
            s.update(popPayload(method, path, ts, body).getBytes("UTF-8"));
            return s.verify(android.util.Base64.decode(sigB64, android.util.Base64.DEFAULT));
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * One atomic write: tmp file first, rename second.
     *
     * Why not write token.txt directly: a process that dies between the write
     * and the close leaves a half-written file. The next start then reads a
     * malformed token, discards it and mints a fresh one — and the PC side,
     * which reads whatever token.txt says, is locked out until someone notices.
     * rename is atomic on the same filesystem, so token.txt is always either
     * the complete old value or the complete new one.
     *
     * The rename-fallback (delete + rename again) mirrors
     * BridgeService.writeAtomic; a leftover .tmp is cleaned here so the mailbox
     * janitor does not have to carry it.
     */
    private static boolean writeTokenOnce(String t) {
        if (t == null || t.length() == 0) return false;
        File f = new File(tokenFile());
        File tmp = new File(f.getAbsolutePath() + ".tmp");
        FileOutputStream fo = null;
        try {
            File parent = f.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) return false;
            fo = new FileOutputStream(tmp);
            fo.write(t.getBytes("UTF-8"));
            fo.flush();
            fo.getFD().sync();
            fo.close();
            fo = null;
            if (tmp.renameTo(f)) return true;
            if (f.delete() && tmp.renameTo(f)) return true;
            tmp.delete();
            return false;
        } catch (Throwable ignored) {
            if (tmp.exists()) {
                try { tmp.delete(); } catch (Throwable alsoIgnored) {}
            }
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
        start(wantPort, null);
    }

    /**
     * @param ctx App 上下文。断点二之后必须给：设备密钥对落在 App 私有目录，
     *            而私有目录只能从 Context 拿到。传 null 时桥仍能起，但所有需要
     *            身份的请求会回 {@code identity_unavailable}——不静默降级成
     *            「不需要身份」，那等于把断点二改回断点二之前。
     */
    public static synchronized void start(final int wantPort, android.content.Context ctx) {
        if (running) return;
        if (ctx != null) appContext = ctx.getApplicationContext();
        ensureToken();
        // 断点二：明文令牌停写，并把升级前留下的那份删掉。
        //
        // 只停写不删是不够的——盘上那份还是有效的长期凭据，任何人 cat 一下就
        // 能继续用，T5 的静态扫描也照样能扫到。删除是这次切换的一部分，不是清理。
        purgeLegacyTokenFile();
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
            String method = parts.length > 0 ? parts[0].toUpperCase() : "GET";
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
            // Non-JSON paths (the guide) answer with their own body and type;
            // everything else keeps the JSON receipt.
            String contentType = "application/json; charset=utf-8";
            byte[] rawBody = null;
            String auth = headers.containsKey("authorization") ? headers.get("authorization") : "";
            String presented = auth.startsWith("Bearer ") ? auth.substring(7).trim() : "";

            // ── 配对（断点二）────────────────────────────────────────────
            //
            // 这两个端点必须在鉴权之前：配对的目的就是拿到凭据，先鉴权就成了
            // 「要凭据才能拿凭据」。
            //
            // /pair/code 是刻意不鉴权的：任何能连上 8896 的进程都可以请求生成
            // 一个码，但**看不到它**——码只出现在手机通知栏里。要读它得人在设备
            // 旁边。这与 secret_code 是同一条理由，也是同一套 ProvisioningCode。
            if (path.startsWith("/pair/code")) {
                String minted = pairingCode.issue(System.currentTimeMillis());
                boolean shown = BridgeService.notificationsEnabled();
                if (shown) {
                    // 固定 id：新码**替换**旧码。用时间 id 时通知栏会堆出好几个
                    // 「配对码」，而只有最新那个有效——操作者挑错是必然的。
                    BridgeService.notifyText(
                            "khy-os 配对码",
                            "配对码 " + minted + "（" + (ProvisioningCode.TTL_MS / 1000)
                                    + " 秒内有效，仅一次）。只在本人操作时填回 PC。",
                            NOTIFY_ID_PAIRING);
                }
                resp.put("ok", true)
                    .put("ttl_ms", ProvisioningCode.TTL_MS)
                    .put("delivered_via", "notification")
                    .put("notifications_enabled", shown)
                    .put("note", shown
                            ? "码只显示在手机通知栏，不回传；这是刻意的——远端能要码，但看不到码"
                            : "手机通知被关掉了（POST_NOTIFICATIONS 未授予或用户关闭），码发不出来。"
                                    + "先在系统设置里允许 khy-os 发通知，再重新取码。");
            } else if (path.startsWith("/pair")) {
                JSONObject req = null;
                try { req = new JSONObject(body); } catch (Throwable ignored) {}
                if (req == null) {
                    resp.put("ok", false).put("code", "invalid_arguments")
                        .put("error", "配对请求体必须是 JSON：{\"code\":\"123456\",\"pc_key\":\"<base64 SPKI>\"}");
                    code = 400;
                } else {
                    String why = pairingCode.verify(req.optString("code", ""), System.currentTimeMillis());
                    if (why != null) {
                        resp.put("ok", false).put("code", "pairing_rejected").put("error", why);
                        code = 401;
                    } else {
                        JSONObject cert = DeviceIdentity.issuePcCert(
                                appContext, req.optString("pc_key", ""),
                                DeviceIdentity.PC_CERT_TTL_MS, System.currentTimeMillis());
                        if (!cert.optBoolean("ok", false)) {
                            resp.put("ok", false).put("code", cert.optString("code", "issue_failed"));
                            code = 400;
                        } else {
                            cert.put("ok", true);
                            resp = cert;
                        }
                    }
                }
            } else if (!authorized(presented, resp, headers, method, path, body)) {
                code = 401;
            } else if (path.startsWith("/ping")) {
                notePcSeen();
                // Worker-loop heartbeat fields (source: BridgeService.loop).
                // heartbeat_age_ms = -1 means the worker loop has not ticked
                // yet; stale alone never implies frozen/crashed — long mailbox
                // commands run synchronously in the loop and age it honestly.
                resp.put("ok", true).put("pong", System.currentTimeMillis())
                     .put("pid", android.os.Process.myPid())
                     .put("heartbeat_seq", BridgeService.heartbeatSeq())
                     .put("heartbeat_age_ms", BridgeService.heartbeatAgeMs())
                     .put("heartbeat_stale", BridgeService.heartbeatStale());
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
                //
                // 令牌的活真相也走这条不碰盘的端点：status.json 写不进去时（实测：
                // 未授「所有文件访问」，每拍 writeAtomic 都 EACCES），PC 的 probe
                // 只会看到几小时前的旧快照，而这里的字段是当前进程内存的实况。
                resp.put("ok", true).put("up", running).put("port", port).put("mode", "app")
                    .put("ui", KhyUi.isReady())
                    // 与 status.json 同形：那边是 PC probe 唯一读的文件，这边是不碰盘的
                    // 活真相。两边都带原因，"ui=false 是为什么"才不用猜。
                    .put("ui_reason", Tools.uiWhy())
                    .put("tools", Tools.availableNames().length)
                    .put("withheld", Tools.withheld())
                    .put("token_persisted", persisted)
                    .put("token_age_ms", tokenAgeMs())
                    // 设备公钥：sidecar 提权要它（挑战应答验签用），PC 侧兜底脚本
                    // 也要它（launch 时 --pub 传进去）。公钥不是秘密——秘密是私钥，
                    // 而私钥从不出私有目录——所以放进来不缩小任何攻击面。
                    .put("device_pub_b64", DeviceIdentity.publicKeyB64(appContext))
                    // S1：与 status.json 的 mailbox 块同一份取值（含
                    // oldest_result_age_ms / dropped）。漏了这块，两条状态面
                    // 就会各报一套队列事实。
                    .put("mailbox", BridgeService.mailboxSnapshot())
                    .put("status_write_failures", BridgeService.statusWriteFailures());
                // S4：与 status.json 同一份取值（elevated / device_auth /
                // foreground_violations / last_violation / last_violation_source）。
                // 这条端点不碰盘：status.json 写不进去时（实测未授「所有文件
                // 访问」），提权与违规事实至少还能从这里读到。
                JSONObject elevation = BridgeService.elevationStatus(appContext);
                java.util.Iterator<String> ek = elevation.keys();
                while (ek.hasNext()) {
                    String k = ek.next();
                    resp.put(k, elevation.opt(k));
                }
            } else if (path.startsWith("/call")) {
                notePcSeen();
                resp = callTool(body);
            } else if (path.startsWith("/agent-guide")) {
                notePcSeen();
                try {
                    loadGuide();
                    String topic = queryParam(path, "topic");
                    String md;
                    if (topic == null) {
                        md = guideCore;
                    } else if (guideTopics.containsKey(topic)) {
                        md = guideTopics.get(topic) + "\n\n---\n" + topicIndexLine();
                    } else {
                        resp.put("ok", false).put("code", "guide_topic_unavailable")
                             .put("error", "主题 \"" + topic + "\" 不存在：本桥指南只提供主题索引里列出的主题。修复：改用索引中的主题名，或去掉 topic 参数读核心层")
                             .put("guide_topics", new JSONArray(guideTopics.keySet()));
                        code = 400;
                        md = null;
                    }
                    if (md != null) {
                        rawBody = fillGuide(md).getBytes("UTF-8");
                        contentType = "text/markdown; charset=utf-8";
                    }
                } catch (Throwable t) {
                    resp.put("ok", false).put("code", "guide_unavailable")
                         .put("error", "指南资产读取失败（" + t.getClass().getSimpleName() + "）：APK 内缺 khy_bridge_guide.md。修复：重装含该资产的 APK 后重试");
                    code = 500;
                }
            } else {
                resp.put("ok", false).put("error", "not found");
                code = 404;
            }

            byte[] outB = rawBody != null ? rawBody : resp.toString().getBytes("UTF-8");
            String head = "HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "ERR") + "\r\n"
                    + "Server: khy-os-bridge (" + khyBuild() + ")\r\n"
                    + "Content-Type: " + contentType + "\r\n"
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

    // ==================== /call 信封校验 ====================

    /**
     * Envelope-level rejection receipt, shared by the two /call-shaped entry
     * points (HTTP and file mailbox). Parameters are a closed set by contract;
     * a rejection must say what to read next (guide_topic) and that nothing
     * was dispatched, so the caller fixes the request instead of retrying it.
     */
    static JSONObject invalidArguments(String error, String guideTopic) {
        try {
            return new JSONObject()
                    .put("ok", false)
                    .put("code", "invalid_arguments")
                    .put("error", error)
                    .put("guide_topic", guideTopic)
                    .put("action_dispatched", false)
                    .put("replay_safe", false)
                    .put("retry_safe", false);
        } catch (Throwable t) {
            return new JSONObject();
        }
    }

    /**
     * The unknown-tool fallbacks inside Tools/KhyUi carry no code and no guide
     * pointer; the schema topic is exactly what a caller with a wrong tool name
     * needs next. Applied at BOTH /call-shaped boundaries — HTTP and the file
     * mailbox dispatch the same receipts — matched by their stable error
     * prefixes so nothing inside Tools changes.
     */
    static void markUnknownTool(JSONObject out) {
        try {
            if (!out.optBoolean("ok", false)) {
                String err = out.optString("error", "");
                if (err.startsWith("unknown tool:") || err.startsWith("unknown ui tool:")) {
                    out.put("code", "invalid_arguments").put("guide_topic", "schema");
                }
            }
        } catch (Throwable ignored) {}
    }

    /**
     * Envelope validation + dispatch for POST /call. The envelope is a closed
     * set by contract ({"tool","args"}), and args must be an object — the old
     * behavior coerced a non-object args into {} silently, turning a malformed
     * call into a random no-arg call against whatever tool was named.
     */
    private static JSONObject callTool(String body) {
        try {
            JSONObject req;
            try {
                req = new JSONObject(body.length() == 0 ? "{}" : body);
            } catch (Throwable t) {
                return invalidArguments("请求体不是合法 JSON（" + t.getClass().getSimpleName() + "）：/call 形状为 {\"tool\":\"工具名\",\"args\":{...}}。修复：按该形状重发，每工具参数细节读 GET /agent-guide?topic=schema", "schema");
            }
            java.util.Iterator<String> keys = req.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                if (!k.equals("tool") && !k.equals("args")) {
                    return invalidArguments("收到未定义的字段 \"" + k + "\"：/call 顶层只允许 tool 与 args。修复：去掉多余字段后重发，形状细节读 GET /agent-guide?topic=schema", "schema");
                }
            }
            String tool = req.optString("tool", "");
            if (tool.length() == 0) {
                return invalidArguments("缺 tool 字段或 tool 为空：/call 形状为 {\"tool\":\"工具名\",\"args\":{...}}。修复：补上工具名（可用清单读 GET /agent-guide）后重发", "schema");
            }
            JSONObject args = new JSONObject();
            if (req.has("args")) {
                args = req.optJSONObject("args");
                if (args == null) {
                    return invalidArguments("args 必须是 JSON 对象（收到 " + req.get("args").getClass().getSimpleName() + "）：/call 形状为 {\"tool\":\"工具名\",\"args\":{...}}。修复：把 args 改为对象后重发，每工具参数细节读 GET /agent-guide?topic=schema", "schema");
                }
            }
            JSONObject out = Tools.dispatch(tool, args);
            out.put("tool", tool);
            markUnknownTool(out);
            return out;
        } catch (Throwable t) {
            return invalidArguments("/call 信封处理失败（" + t.getClass().getSimpleName() + "）：请求未派发到工具层。修复：按 {\"tool\",\"args\"} 形状重发，细节读 GET /agent-guide?topic=schema", "schema");
        }
    }

    // ==================== /agent-guide ====================

    private static final Object GUIDE_LOCK = new Object();
    private static volatile String guideCore = null;
    private static volatile java.util.LinkedHashMap<String, String> guideTopics = null;

    /**
     * Loads the guide asset once. It ships inside the APK and cannot change at
     * runtime, so it is parsed one time and served from memory — the request
     * path must not touch storage (same rule that keeps token reads off it).
     */
    private static void loadGuide() throws Exception {
        if (guideCore != null) return;
        synchronized (GUIDE_LOCK) {
            if (guideCore != null) return;
            android.content.Context ctx = Tools.ctxRef();
            if (ctx == null) throw new IllegalStateException("context 未就绪");
            java.io.InputStream in = ctx.getAssets().open("khy_bridge_guide.md");
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            String raw = new String(bo.toByteArray(), "UTF-8");
            // Sections are delimited by <!-- TOPIC:name --> anchors; the core is
            // everything before the first anchor and after the last section. The
            // anchor set IS the topic whitelist — the endpoint cannot drift from
            // what the asset actually carries.
            java.util.LinkedHashMap<String, String> topics = new java.util.LinkedHashMap<String, String>();
            java.util.ArrayList<int[]> marks = new java.util.ArrayList<int[]>();
            java.util.ArrayList<String> names = new java.util.ArrayList<String>();
            int p = 0;
            while (true) {
                int i = raw.indexOf("<!-- TOPIC:", p);
                if (i < 0) break;
                int j = raw.indexOf("-->", i);
                if (j < 0) break;
                names.add(raw.substring(i + 11, j).trim());
                marks.add(new int[] { i, j + 3 });
                p = j + 3;
            }
            if (!names.isEmpty()) {
                for (int k = 0; k < names.size(); k++) {
                    int from = marks.get(k)[1];
                    int to = k + 1 < names.size() ? marks.get(k + 1)[0] : raw.length();
                    topics.put(names.get(k), raw.substring(from, to).trim());
                }
                guideCore = raw.substring(0, marks.get(0)[0])
                        + raw.substring(marks.get(marks.size() - 1)[1]);
            } else {
                guideCore = raw;
            }
            guideTopics = topics;
        }
    }

    /** ?topic= style query value; plain words only — anything else misses the whitelist anyway. */
    private static String queryParam(String path, String key) {
        int q = path.indexOf('?');
        if (q < 0) return null;
        for (String part : path.substring(q + 1).split("&")) {
            int eq = part.indexOf('=');
            if (eq > 0 && part.substring(0, eq).equals(key)) return part.substring(eq + 1);
        }
        return null;
    }

    private static String topicIndexLine() {
        StringBuilder index = new StringBuilder("主题索引（GET /agent-guide?topic=<名>，未列出的主题返回 400 guide_topic_unavailable）：");
        boolean first = true;
        for (String t : guideTopics.keySet()) {
            index.append(first ? "" : "、").append(t);
            first = false;
        }
        return index.toString();
    }

    /** Placeholders the asset leaves to runtime: port, token, tool names, topic index. */
    private static String fillGuide(String md) {
        StringBuilder toolNames = new StringBuilder();
        for (String t : Tools.availableNamesCached()) {
            if (toolNames.length() > 0) toolNames.append(' ');
            toolNames.append(t);
        }
        return md.replace("{{PORT}}", String.valueOf(port()))
                 .replace("{{BRIDGE_TOKEN}}", activeToken())
                 .replace("{{TOOL_NAMES}}", toolNames.toString())
                 .replace("{{TOPIC_INDEX}}", topicIndexLine());
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
