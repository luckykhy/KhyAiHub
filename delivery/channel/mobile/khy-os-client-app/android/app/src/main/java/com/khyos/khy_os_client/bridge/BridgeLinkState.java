// khy-canary: Khy-1.1.28+13-202611142308-0F62DE87
package com.khyos.khy_os_client.bridge;

/**
 * BridgeLinkState — 出向链路（设备 → 服务端）的当下事实。
 *
 * <p>WHY 单独一个类，而不是把字段塞进 {@link HttpBridge}：{@code pc_reachable}
 * 原来的唯一判据是「PC 最近有没有发过请求」（{@code pcIdleMs} 窗口）。那条判据
 * 在 adb 隧道断掉、端口仍绑在 loopback 时会永远说 false——设备根本不知道
 * 服务端还在不在，只能等对方来敲。出向长连接把这件事反过来：设备自己知道
 * 链路活没活，pong 就是证据。
 *
 * <p>WHY 全部放内存、不落盘：这份状态每 15s 被 Dart 侧覆写一次，落盘就是每
 * 15s 一次 sdcard 写，而它没有任何跨进程读者——status.json 已经把它透出去了。
 * 落盘还会制造第二个真源：进程被杀后残留的「connected=true」会让
 * {@code pc_reachable} 撒谎到下次启动。
 *
 * <p>WHY 有新鲜度窗口：Dart 侧若被回收而原生侧活着，内存里的 connected 会一直
 * 是 true。所以「活着」= connected && 最近一次更新在 {@link #FRESH_MS} 内 &&
 * 最近一次 pong 也在窗口内。超过窗口一律按 file 通道算，宁可说没连上，也不
 * 谎报在线——{@code pc_reachable=true} 的语义是「服务端此刻能下发指令」。
 */
public final class BridgeLinkState {
    private BridgeLinkState() {}

    /** 出向长连接活着。 */
    public static final String LINK_WSS = "wss";
    /** 只有文件通道：不知道服务端在不在，不声称在线。 */
    public static final String LINK_FILE = "file";

    /**
     * 新鲜度窗口。心跳 15s 一拍，连续三拍收不到更新就判死——比心跳阈值
     * （Doze 下实测会拉长到 60s+）短，所以只用来判「Dart 侧还活着吗」，
     * 不参与心跳陈旧判定：那件事由 {@code heartbeat_age_ms} 自己说。
     */
    static final long FRESH_MS = 50_000L;

    /** 还没开始鉴权（或进程刚起）。 */
    public static final String AUTH_NONE = "none";
    /** auth 帧已发出，还没等到 auth:ok。 */
    public static final String AUTH_PENDING = "pending";
    /** 服务端已接受这条身份（auth:ok）。 */
    public static final String AUTH_OK = "ok";
    /** 服务端拒了这条身份（auth:error），{@link #authCode()} 说明原因。 */
    public static final String AUTH_REJECTED = "rejected";

    private static volatile boolean connected = false;
    private static volatile long lastPongMs = 0L;
    private static volatile long lastUpdateMs = 0L;
    private static volatile long reconnectCount = 0L;
    private static volatile String endpoint = "";
    private static volatile String authState = AUTH_NONE;
    private static volatile String authCode = "";

    /**
     * Dart 侧每一拍（连上 / auth:ok / pong / 断开 / 重连）调一次。
     *
     * <p>WHY 鉴权状态要单独一个字段、并且参与 {@link #alive()}：断点二把共享
     * token 换成设备签名之后，出现过一次很难发现的形态——服务端回
     * {@code auth:error}，但 TCP 还开着、心跳还在往返，于是 {@code link=wss}
     * 一路报健康。那时 {@code pc_reachable=true} 是假的：身份没被接受，服务端
     * 不会下发任何指令。共享秘密换成签名只解决了「不可转移」，没解决
     * 「被拒也说自己好」。
     *
     * @param conn      此刻链路是否连着
     * @param pongMs    最近一次收到 pong 的墙钟毫秒；从未收到传 0
     * @param reconnects 累计重连次数（Dart 侧自增，原生侧只读）
     * @param ep        当前 endpoint（只留 origin+path，不带 query 里的任何凭据）
     * @param auth      鉴权状态：none / pending / ok / rejected
     * @param code      服务端给的拒绝码（如 signature_invalid），没有传空串
     */
    public static synchronized void update(boolean conn, long pongMs, long reconnects, String ep,
                                           String auth, String code) {
        connected = conn;
        if (pongMs > 0) lastPongMs = pongMs;
        reconnectCount = Math.max(0L, reconnects);
        if (ep != null) endpoint = ep;
        authState = (auth == null || auth.isEmpty()) ? AUTH_NONE : auth;
        authCode = code == null ? "" : code;
        lastUpdateMs = System.currentTimeMillis();
    }

    /** 兼容旧调用面：不给鉴权状态时按「未知」处理，绝不默认成 ok。 */
    public static synchronized void update(boolean conn, long pongMs, long reconnects, String ep) {
        update(conn, pongMs, reconnects, ep, AUTH_NONE, "");
    }

    /** 链路此刻是否可用于下发指令。 */
    public static boolean alive() {
        if (!connected) return false;
        // 身份没被接受 = 服务端不会下发指令。这一条不参与，就会重演
        // 「auth:error + 心跳正常 → link=wss」那种假健康。
        if (!AUTH_OK.equals(authState)) return false;
        long now = System.currentTimeMillis();
        long upd = lastUpdateMs;
        if (upd <= 0 || now - upd > FRESH_MS) return false;
        long pong = lastPongMs;
        return pong > 0 && now - pong <= FRESH_MS;
    }

    public static String link() {
        return alive() ? LINK_WSS : LINK_FILE;
    }

    /** 鉴权状态：none / pending / ok / rejected。 */
    public static String authState() { return authState; }

    /** 服务端给的拒绝码（rejected 时有意义）；其余情况为空串。 */
    public static String authCode() { return authCode; }

    /** 最近一次 pong 距今毫秒；从未收到返回 -1（与 {@code tokenAgeMs} 同约定）。 */
    public static long lastPongAgeMs() {
        long p = lastPongMs;
        return p <= 0 ? -1 : System.currentTimeMillis() - p;
    }

    public static long lastPongMs() { return lastPongMs; }

    public static long reconnectCount() { return reconnectCount; }

    public static String endpoint() { return endpoint; }

    /** 原生侧自检/测试用：把状态清回「没有出向链路」。 */
    public static synchronized void reset() {
        connected = false;
        lastPongMs = 0L;
        lastUpdateMs = 0L;
        reconnectCount = 0L;
        endpoint = "";
        authState = AUTH_NONE;
        authCode = "";
    }
}
