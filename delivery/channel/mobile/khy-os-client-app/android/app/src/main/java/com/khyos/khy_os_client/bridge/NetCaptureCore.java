package com.khyos.khy_os_client.bridge;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 抓包改写的**判定核心**（断点五）：状态机 + 环形记录 + 改写规则 + 强制脱敏。
 *
 * <p>为什么把判定和 socket 分开。这一层是「什么时候算在抓」「什么算一条记录」
 * 「哪些字段必须打码」「规则什么时候失效」——全部是纯函数级的判断，可以在 JVM
 * 单测里跑；真正碰 socket / VpnService 的部分在 {@link NetCapture} 与
 * {@link NetProxy} 里。不分开的后果是每条判定都得靠真机抓一次才敢说成立，
 * 而真机抓包恰恰是最难复现的一类证据。
 *
 * <p>三条硬约束，写在这里是因为它们都是「省一步就破功」的类型：
 *
 * <ol>
 *   <li><b>默认关闭</b>：{@link #active()} 初始 false，只有 {@link #start} 能开。
 *       抓包会看到别人的密码，默认开等于默认泄露。</li>
 *   <li><b>规则不持久化</b>：规则只活在内存里，进程一死就没。落盘会让「上次调试
 *       留的改写规则」在下次正常运行里继续生效——那时没人记得它存在，症状是
 *       「接口返回的东西不对」，而没有人会去查一个看不见的规则表。</li>
 *   <li><b>ttl 上限 15 分钟</b>：到点自动停并清规则。抓包是手术刀不是常驻设施，
 *       忘记关的抓包进程是长期后门。</li>
 * </ol>
 *
 * <p>脱敏在**记录时**做，不在导出时做。导出时打码意味着内存里躺着一份明文，
 * 而内存里的明文会被下一次 {@code list} 带出去——打码点只有一个才守得住。
 */
public final class NetCaptureCore {

    /** 默认 ttl：15 分钟。 */
    public static final long DEFAULT_TTL_MS = 15L * 60L * 1000L;
    /** ttl 上限：15 分钟。传更大的值按上限截断，不报错（报错只会诱使调用方去掉这个参数）。 */
    public static final long MAX_TTL_MS = 15L * 60L * 1000L;
    /** 环形记录上限。超出后丢最旧的，{@code dropped} 计数只增不减。 */
    public static final int MAX_RECORDS = 200;
    /** 规则条数上限。 */
    public static final int MAX_RULES = 50;
    /** 单条 body 采样上限（脱敏后截断）。 */
    public static final int MAX_BODY_CHARS = 2048;

    /**
     * 打码占位串的前缀。完整形态是 {@code <redacted:原文长度>}。
     *
     * WHY THE LENGTH IS KEPT. 任务是「Authorization / Cookie / Set-Cookie / token /
     * 密码 → <redacted>，保留字段名与长度」。长度不是泄露，是调试信号：一个空 token
     * 和一个 200 字符的 token 是两种完全不同的故障，打成同一个串就分不出来了。
     * 而 {@code ***} 把长度一起抹掉——看着安全，实际把最有用的那一维丢掉了。
     */
    public static final String MASK_PREFIX = "<redacted:";

    /** 统一的打码值：保留原文字符数，不保留内容。 */
    public static String mask(String value) {
        return MASK_PREFIX + (value == null ? 0 : value.length()) + ">";
    }

    /** 一律打码的请求/响应头（小写比较）。 */
    static final String[] SENSITIVE_HEADERS = {
            "authorization", "proxy-authorization", "cookie", "set-cookie",
            "x-api-key", "x-auth-token", "x-khy-sig", "x-goog-api-key",
    };

    /** 一律打码的 query / JSON 字段名（小写比较）。 */
    static final String[] SENSITIVE_KEYS = {
            "token", "access_token", "refresh_token", "api_key", "apikey", "key",
            "secret", "password", "passwd", "sig", "signature", "authorization",
            "cookie", "client_secret",
    };

    /**
     * 文本规则里用的敏感键名（正则片段）。
     *
     * WHY IT IS NOT SENSITIVE_KEYS ITSELF. 这里刻意去掉了裸 {@code key}：它在 URL
     * 参数里太常见（{@code ?key=value} 的普通业务参数），按它打码会把正常数据打掉。
     * 打错和漏打都会让人不敢用这个工具，但打错更隐蔽——用户看到的是「工具坏了」，
     * 却不知道坏在哪。
     */
    static final String KEY_ALT = "token|access_token|refresh_token|api_key|apikey"
            + "|secret|password|passwd|sig|signature|authorization|cookie|client_secret";

    /** 动作：拦掉、改状态码、改 body、改/加一个响应头。 */    public static final String ACT_BLOCK = "block";
    public static final String ACT_STATUS = "status";
    public static final String ACT_BODY = "body";
    public static final String ACT_HEADER = "header";

    /** 一条改写规则。定义不可变——改规则靠删+建，避免「改了一半」的中间态被读到。 */
    public static final class Rule {
        public final String id;
        public final String method;
        public final String host;
        public final String path;
        /** 调用方写的动作名：set_header / replace_body / block / status / body / header。 */
        public final String action;
        public final int status;
        public final String body;
        public final String headerName;
        public final String headerValue;
        public final long createdAtMs;
        /** 规则自己的寿命：默认 15 分钟，上限同窗口。到点即从命中集里消失。 */
        public final long ttlMs;
        public final long expiresAtMs;

        // 命中统计是运行时记账，不是规则定义——所以上面的 final 不变、这些 volatile 可变。
        // 任务书 T6 要求「可按 rule_id 追溯命中次数与前后哈希」：只存哈希与摘要，
        // 不存改写前后正文（那等于把抓包变成明文仓库）。
        public volatile long hits;
        public volatile String lastBeforeSha256 = "";
        public volatile String lastAfterSha256 = "";
        public volatile String lastDiff = "";

        Rule(String id, String method, String host, String path, String action,
             int status, String body, String headerName, String headerValue, long createdAtMs,
             long ttlMs) {
            this.id = id;
            this.method = method == null || method.isEmpty() ? "*" : method.toUpperCase(Locale.US);
            this.host = host == null ? "" : host.toLowerCase(Locale.US);
            this.path = path == null ? "" : path;
            this.action = action;
            this.status = status;
            this.body = body;
            this.headerName = headerName;
            this.headerValue = headerValue;
            this.createdAtMs = createdAtMs;
            long ttl = ttlMs <= 0 ? DEFAULT_TTL_MS : ttlMs;
            if (ttl > MAX_TTL_MS) ttl = MAX_TTL_MS;
            this.ttlMs = ttl;
            this.expiresAtMs = createdAtMs + ttl;
        }

        /** 动作的规范名。任务书的词汇是 set_header / replace_body，引擎内部是 header / body。 */
        String canonicalAction() {
            if ("set_header".equals(action)) return ACT_HEADER;
            if ("replace_body".equals(action)) return ACT_BODY;
            return action;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("method", method);
            o.put("host", host);
            o.put("path", path);
            o.put("action", action);
            if (status > 0) o.put("status", status);
            if (body != null) o.put("body", body);
            if (headerName != null) o.put("header", headerName);
            if (headerValue != null) o.put("value", headerValue);
            o.put("created_at", createdAtMs);
            o.put("ttl_ms", ttlMs);
            o.put("expires_at", expiresAtMs);
            o.put("hits", hits);
            o.put("last_before_sha256", lastBeforeSha256);
            o.put("last_after_sha256", lastAfterSha256);
            o.put("last_diff", lastDiff);
            return o;
        }

        /**
         * 是否命中。
         *
         * <p>host 支持 `*.example.com` 后缀式通配，且**不含**裸 `*`——裸 `*` 会让
         * 一条规则命中所有域名，那和「没有规则」看起来一样，实际上把整台设备的
         * 响应都改了。
         */
        boolean matches(String m, String h, String p) {
            if (!"*".equals(method) && !method.equalsIgnoreCase(m)) return false;
            String hh = h == null ? "" : h.toLowerCase(Locale.US);
            if (!host.isEmpty()) {
                if (host.startsWith("*.")) {
                    String suffix = host.substring(1); // ".example.com"
                    if (!hh.endsWith(suffix)) return false;
                } else if (!host.equals(hh)) {
                    return false;
                }
            }
            String pp = p == null ? "" : p;
            if (!path.isEmpty()) {
                if (path.startsWith("^")) {
                    // 显式前缀写法 ^/v1/：避免「/v1 命中 /v10」这类静默扩大
                    if (!pp.startsWith(path.substring(1))) return false;
                } else if (!pp.equals(path)) {
                    return false;
                }
            }
            return true;
        }
    }

    private boolean active;
    private long startedAtMs;
    private long ttlMs = DEFAULT_TTL_MS;
    private String stopReason = "";
    private int port;

    /**
     * TLS 调试档。false = 只自记录明文 HTTP（默认，不需要 CA）；true = self+tls，
     * 由 {@link NetTls} 逐主机签叶证书尝试解密。这个布尔是 info.capture 三态的来源，
     * 所以它必须只说「档位」这一个事实，不夹带「解开了没有」——后者是逐条记录的
     * decrypted 字段的事，两者混在一个字段里就会出现在骗人的 self+tls。
     */
    private boolean tlsArmed;
    private NetTls tls;

    private final ArrayDeque<JSONObject> records = new ArrayDeque<JSONObject>();
    private final LinkedHashMap<String, Rule> rules = new LinkedHashMap<String, Rule>();

    private long seq;
    private long total;
    private long dropped;
    private long undecryptable;
    private long rewritten;
    private long redactedFields;
    private int nextRuleId = 1;

    // ==================== 状态机 ====================

    /** 是否在抓。 */
    public synchronized boolean active() {
        return active;
    }

    /**
     * 「开不开」的纯判定：调试菜单解锁 + 系统版本够。放在核心里而不是
     * {@link NetCapture#start} 里，是因为这道门是 T18「开启需确认」的判定本体，
     * 而 {@code NetCapture.start} 要碰 {@code Context} 与 {@code VpnService}——
     * 判定能在一个裸 JVM 上被证明，装配不能。
     *
     * <p>fail-closed：没解锁就返回 {@code debug_only}，并且**不透露参数该怎么改**。
     * 返回「参数错」之类的可猜测提示，等于告诉调用方「再试一次就能开」。
     */
    public JSONObject startGate(boolean debugUnlocked, int sdkInt) throws JSONException {
        JSONObject r = new JSONObject();
        if (!debugUnlocked) {
            return r.put("ok", false).put("code", "debug_only")
                    .put("error", "抓包只在调试菜单解锁后可用（设置 → 连点版本号 7 次解锁）");
        }
        if (sdkInt < 29) {
            return r.put("ok", false).put("code", "unsupported_api")
                    .put("error", "代理型 VPN 需要 Android 10+（setHttpProxy），当前 API " + sdkInt);
        }
        return r.put("ok", true);
    }

    /**
     * 开始抓包。重复调用**不重开**——重置 ttl 会让「忘了关」变成「永远开着」，
     * 所以第二次调用只回当前状态并把 {@code already_active} 置 true。
     */
    public synchronized JSONObject start(long nowMs, Long requestedTtlMs) throws JSONException {
        JSONObject r = new JSONObject();
        long ttl = requestedTtlMs == null ? DEFAULT_TTL_MS : requestedTtlMs;
        if (ttl <= 0) ttl = DEFAULT_TTL_MS;
        if (ttl > MAX_TTL_MS) ttl = MAX_TTL_MS;
        if (active) {
            r.put("ok", true);
            r.put("active", true);
            r.put("already_active", true);
            r.put("ttl_ms", ttlMs);
            r.put("expires_in_ms", Math.max(0L, startedAtMs + ttlMs - nowMs));
            r.put("records", records.size());
            r.put("rules", rules.size());
            return r;
        }
        active = true;
        startedAtMs = nowMs;
        ttlMs = ttl;
        stopReason = "";
        records.clear();
        // 开新一轮必须清规则：上一轮的规则若活过来，会改写这一轮没人预期的响应。
        rules.clear();
        nextRuleId = 1;
        seq = 0;
        total = 0;
        dropped = 0;
        undecryptable = 0;
        rewritten = 0;
        redactedFields = 0;
        r.put("ok", true);
        r.put("active", true);
        r.put("ttl_ms", ttlMs);
        r.put("expires_in_ms", ttlMs);
        return r;
    }

    /** 停止。返回停止前的统计快照，方便调用方在日志里留一行。 */
    public synchronized JSONObject stop(long nowMs, String reason) throws JSONException {
        JSONObject r = status(nowMs);
        active = false;
        stopReason = reason == null ? "" : reason;
        port = 0;
        // 退出即清规则：不持久化 + 不跨会话。记录留着（list 还要能看），
        // 规则不留——规则会改变行为，记录只是历史。
        rules.clear();
        tlsArmed = false;
        tls = null;
        r.put("ok", true);
        r.put("active", false);
        r.put("stopped_reason", stopReason);
        r.put("rules", 0);
        return r;
    }

    /**
     * 到点自停。由调用方（前台线程/定时器）周期性调用——不自己起线程，
     * 因为「谁负责关」只能有一个答案，两个地方都能关就会出现关两次、清两次。
     */
    public synchronized boolean tick(long nowMs) throws JSONException {
        if (!active) return false;
        if (nowMs - startedAtMs < ttlMs) return false;
        stop(nowMs, "ttl_expired");
        return true;
    }

    public synchronized void setPort(int p) {
        port = p;
    }

    // ==================== TLS 调试档 ====================

    /**
     * 打开/收起 TLS 调试档。true 时惰性生成一枚用户 CA（进程内有效，不落盘）。
     * 生成失败照抛——调用方据此把抓包停在「开不了」，而不是开成一个假的三态。
     *
     * <p>{@code ca} 可传一枚既有的 CA（测试里要让客户端信任的正是代理出示的那枚）；
     * 传 null 就自己生成。已经生成过再传不同的会被忽略——一枚窗口两枚 CA 会让
     * 「导出了 A、代理却出示 B」，那种故障没有任何报错会指向它。
     */
    public synchronized void setTlsArmed(boolean on) throws Exception {
        setTlsArmed(on, null);
    }

    public synchronized void setTlsArmed(boolean on, NetTls ca) throws Exception {
        if (on) {
            if (tls == null) tls = ca == null ? NetTls.create() : ca;
        }
        tlsArmed = on;
    }

    public synchronized boolean tlsArmed() {
        return tlsArmed;
    }

    /** 调试 CA 持有者；没开过 TLS 档时为 null。 */
    public synchronized NetTls tls() {
        return tls;
    }

    /**
     * info.capture 的三态：off / self / self+tls。
     *
     * <p>为什么 self+tls 只表示「档位已开」而不表示「解开了」：解密成功率取决于
     * 对方 App 信不信任用户 CA，那是逐条记录的事（decrypted / ca_untrusted）。
     * 把两者塞进一个字段，就会出现「报着 self+tls 而一条都没解开」的假象——
     * 那正是任务书 §10 禁的「轮询伪装 wss 却报 link=wss」的同一类事。
     */
    public synchronized String captureMode() {
        if (!active) return "off";
        return tlsArmed ? "self+tls" : "self";
    }

    public synchronized JSONObject status(long nowMs) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("active", active);
        o.put("port", active ? port : 0);
        o.put("ttl_ms", ttlMs);
        o.put("capture", captureMode());
        if (active) {
            long left = startedAtMs + ttlMs - nowMs;
            o.put("started_at", startedAtMs);
            o.put("expires_in_ms", Math.max(0L, left));
            o.put("expires_at", startedAtMs + ttlMs);
        }
        o.put("records", records.size());
        o.put("records_total", total);
        o.put("records_dropped", dropped);
        o.put("undecryptable", undecryptable);
        o.put("rewritten", rewritten);
        o.put("redacted_fields", redactedFields);
        o.put("rules", rules.size());
        o.put("stop_reason", stopReason);
        // 这两条是给「为什么没有数据」用的：没开 / 开了但没有流量 / 有流量但全解不开，
        // 三种情况的处置完全不同，只看 records=0 分不出来。
        o.put("hint", active
                ? (total == 0 ? "抓包已开但还没有请求经过代理" :
                   (undecryptable == total ? "全部是 HTTPS CONNECT，未做 MITM，无法解密" : ""))
                : "抓包未开启");
        return o;
    }

    // ==================== 记录 ====================

    /** 一条捕获记录（已脱敏）。返回入库后的副本，供调用方回显 seq。 */
    public synchronized JSONObject record(JSONObject rec) throws JSONException {
        if (!active) return rec;
        long s = ++seq;
        rec.put("seq", s);
        total++;
        records.addLast(rec);
        while (records.size() > MAX_RECORDS) {
            records.removeFirst();
            dropped++;
        }
        if (!rec.optBoolean("decrypted", true)) undecryptable++;
        if (rec.optBoolean("rewritten", false)) rewritten++;
        return rec;
    }

    public synchronized JSONObject list(long sinceSeq, int limit) throws JSONException {
        int cap = limit <= 0 ? 100 : Math.min(limit, MAX_RECORDS);
        JSONArray arr = new JSONArray();
        int n = 0;
        for (JSONObject o : records) {
            if (o.optLong("seq", 0) <= sinceSeq) continue;
            if (n++ >= cap) break;
            arr.put(o);
        }
        JSONObject r = new JSONObject();
        r.put("ok", true);
        r.put("count", arr.length());
        r.put("items", arr);
        r.put("records", records.size());
        r.put("dropped", dropped);
        r.put("active", active);
        return r;
    }

    // ==================== 规则 ====================

    public synchronized JSONObject setRule(JSONObject a, long nowMs) throws JSONException {
        JSONObject r = new JSONObject();
        if (!active) {
            // 规则只在抓包窗口内有效。允许「先设规则再开抓」等于给规则留了生命周期，
            // 而生命周期一长就没人记得它。
            return r.put("ok", false).put("code", "capture_off")
                    .put("error", "抓包未开启：规则只在抓包窗口内有效，先 net_capture_start");
        }
        // 任务书 T6/T19 的词汇是 set_header / replace_body；本引擎的既有词汇是
        // header / body。收别名而不是改名：规则按**调用方写的名字**存（listing 里
        // 看到的和设进去的是同一个词），匹配与执行时归一成规范名。
        String rawAction = a.optString("action", "").toLowerCase(Locale.US);
        String canonical = rawAction;
        if ("set_header".equals(rawAction)) canonical = ACT_HEADER;
        if ("replace_body".equals(rawAction)) canonical = ACT_BODY;
        if (!ACT_BLOCK.equals(canonical) && !ACT_STATUS.equals(canonical)
                && !ACT_BODY.equals(canonical) && !ACT_HEADER.equals(canonical)) {
            return r.put("ok", false).put("code", "bad_action")
                    .put("error", "action 必须是 block / status / body / header（或别名 set_header / replace_body）之一");
        }
        String host = a.optString("host", "");
        if (host.isEmpty()) {
            return r.put("ok", false).put("code", "bad_host")
                    .put("error", "缺 host：不允许无 host 的通配规则（会改写整台设备的响应）");
        }
        if ("*".equals(host)) {
            return r.put("ok", false).put("code", "bad_host")
                    .put("error", "host 不接受裸 *；要覆盖子域请写 *.example.com");
        }
        if (rules.size() >= MAX_RULES) {
            return r.put("ok", false).put("code", "too_many_rules")
                    .put("error", "规则上限 " + MAX_RULES + " 条，先删几条");
        }
        if (ACT_STATUS.equals(canonical) && a.optInt("status", 0) <= 0) {
            return r.put("ok", false).put("code", "bad_status")
                    .put("error", "action=status 需要 status（100-599）");
        }
        if (ACT_HEADER.equals(canonical) && a.optString("header", "").isEmpty()) {
            return r.put("ok", false).put("code", "bad_header")
                    .put("error", "action=header 需要 header 与 value");
        }
        String id = "r" + (nextRuleId++);
        // ttl_ms 默认 15 分钟：任务书「规则带 ttl_ms（默认 15 分钟），退出即清空」。
        // 上限与窗口同值——给规则一个比窗口更长的寿命没有意义，窗口一停规则就没了。
        long ruleTtl = a.has("ttl_ms") ? a.optLong("ttl_ms", DEFAULT_TTL_MS) : DEFAULT_TTL_MS;
        Rule rule = new Rule(id, a.optString("method", "*"), host, a.optString("path", ""),
                rawAction, a.optInt("status", 0), a.optString("body", null),
                a.optString("header", null), a.optString("value", null), nowMs, ruleTtl);
        rules.put(id, rule);
        return r.put("ok", true).put("rule", rule.toJson()).put("rules", rules.size());
    }

    public synchronized JSONObject listRules() throws JSONException {
        JSONArray arr = new JSONArray();
        for (Rule rule : rules.values()) arr.put(rule.toJson());
        JSONObject r = new JSONObject();
        r.put("ok", true);
        r.put("count", arr.length());
        r.put("items", arr);
        r.put("active", active);
        return r;
    }

    public synchronized JSONObject listRules(long nowMs) throws JSONException {
        // 到期的规则先扫掉再列：列出一条已经不会命中的规则，会让人以为它还有效。
        expireRules(nowMs);
        return listRules();
    }

    /** 扫掉到期的规则，返回清了几条。匹配路径也会顺手扫（见 match），不起第二个定时器。 */
    public synchronized int expireRules(long nowMs) {
        int removed = 0;
        java.util.Iterator<Rule> it = rules.values().iterator();
        while (it.hasNext()) {
            if (it.next().expiresAtMs <= nowMs) {
                it.remove();
                removed++;
            }
        }
        return removed;
    }

    /** 规则命中记账：hits+1，记前后 sha256 与结构化摘要。正文一律不落——只有哈希与形状。 */
    public synchronized void noteRuleHit(String ruleId, String before, String after, String diff) {
        Rule rule = rules.get(ruleId);
        if (rule == null) return;
        rule.hits++;
        rule.lastBeforeSha256 = sha256Hex(before == null ? "" : before);
        rule.lastAfterSha256 = sha256Hex(after == null ? "" : after);
        rule.lastDiff = diff == null ? "" : diff;
    }

    static String sha256Hex(String s) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    public synchronized JSONObject deleteRule(String id) throws JSONException {
        Rule removed = rules.remove(id);
        JSONObject r = new JSONObject();
        r.put("ok", removed != null);
        if (removed == null) r.put("code", "no_such_rule").put("error", "没有这条规则：" + id);
        r.put("rules", rules.size());
        return r;
    }

    public synchronized JSONObject clearRules() throws JSONException {
        int n = rules.size();
        rules.clear();
        return new JSONObject().put("ok", true).put("cleared", n).put("rules", 0);
    }

    /**
     * 找第一条命中的规则。顺序即优先级：先建的先命中。
     *
     * <p>过期规则在这里被跳过（并顺手清掉）：规则的 ttl 到期后它必须**不再命中**，
     * 而不是继续躺在表里等人来删。只在匹配路径上惰性清理，不起第二个定时器——
     * 「谁负责改规则表」只能有一个答案。
     */
    public synchronized Rule match(String method, String host, String path, long nowMs) {
        if (!active) return null;
        java.util.Iterator<Rule> it = rules.values().iterator();
        while (it.hasNext()) {
            Rule rule = it.next();
            if (rule.expiresAtMs <= nowMs) {
                it.remove();
                continue;
            }
            if (rule.matches(method, host, path)) return rule;
        }
        return null;
    }

    /**
     * 旧签名：不带时钟的匹配。**不做过期清扫**——它没有时间参照，把一切当过期的
     * 后果是把规则表清空（第一版就栽在这里：传 Long.MAX_VALUE 当「永不过期」，
     * 而每个规则的 expires_at 都小于它）。要按时钟匹配用四参数版本。
     */
    public synchronized Rule match(String method, String host, String path) {
        if (!active) return null;
        for (Rule rule : rules.values()) {
            if (rule.matches(method, host, path)) return rule;
        }
        return null;
    }

    // ==================== 脱敏 ====================

    /** 该头是否必须打码。 */
    public static boolean sensitiveHeader(String name) {
        if (name == null) return false;
        String n = name.toLowerCase(Locale.US).trim();
        for (String s : SENSITIVE_HEADERS) if (s.equals(n)) return true;
        // 名字以 -token 结尾的（x-khy-token / x-access-token / x-session-token…）
        // 一律按敏感处理：任务书点名的就是 token 这一类。用后缀而不是子串——
        // 子串会把 x-monkey-count 这种正常业务头一起打掉，打错比漏打更难排查。
        return n.equals("token") || n.endsWith("-token");
    }

    /** 该字段名是否必须打码。 */
    public static boolean sensitiveKey(String name) {
        if (name == null) return false;
        String n = name.toLowerCase(Locale.US).trim();
        for (String s : SENSITIVE_KEYS) if (s.equals(n)) return true;
        return false;
    }

    /**
     * 头表脱敏。返回值是**新表**，不改入参——调用方可能还要拿原表去转发。
     * 计数写回 {@code sink[0]}，让 status 能报「这次抓包一共打掉多少个字段」。
     */
    public synchronized JSONObject redactHeaders(JSONObject headers) throws JSONException {
        JSONObject out = new JSONObject();
        if (headers == null) return out;
        Iterator<String> it = headers.keys();
        while (it.hasNext()) {
            String k = it.next();
            String v = headers.optString(k, "");
            if (sensitiveHeader(k)) {
                out.put(k, mask(v));
                redactedFields++;
            } else {
                out.put(k, v);
            }
        }
        return out;
    }

    /**
     * URL 脱敏：query 里的敏感值打码，其余保留。
     *
     * <p>为什么要逐段重建而不是 replaceAll：`token=` 这种子串替换会把
     * `csrf_token_name=` 这类键也一起打掉，打码范围一扩大，抓包就失去意义。
     */
    public synchronized String redactUrl(String url) {
        if (url == null || url.isEmpty()) return "";
        int q = url.indexOf('?');
        if (q < 0) return url;
        String base = url.substring(0, q);
        String query = url.substring(q + 1);
        StringBuilder sb = new StringBuilder(base).append('?');
        String[] parts = query.split("&");
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) sb.append('&');
            String p = parts[i];
            int eq = p.indexOf('=');
            if (eq <= 0) {
                sb.append(p);
                continue;
            }
            String k = p.substring(0, eq);
            if (sensitiveKey(k)) {
                sb.append(k).append('=').append(mask(p.substring(eq + 1)));
                redactedFields++;
            } else {
                sb.append(p);
            }
        }
        return sb.toString();
    }

    /**
     * body 脱敏 + 截断。
     *
     * <p>三层：JSON 按键名递归打码；非 JSON 文本按 `Bearer xxx` / `sk-xxx` 两种
     * 常见形态打码；最后截断到 {@link #MAX_BODY_CHARS}。截断放在最后，是因为
     * 先截断可能把「键名 + 值」截断成半截，键名认不出来就不打码了——那正是
     * 最危险的一种漏。
     */
    public synchronized String redactBody(String body) throws JSONException {
        if (body == null || body.isEmpty()) return "";
        String out = body;
        String trimmed = body.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                Object parsed = trimmed.startsWith("{")
                        ? new JSONObject(trimmed) : new JSONArray(trimmed);
                out = redactJson(parsed).toString();
            } catch (Throwable ignored) {
                // 不是合法 JSON（半截/压缩/二进制）：退回文本规则，不假装解析成功。
                out = redactText(body);
            }
        } else {
            out = redactText(body);
        }
        if (out.length() > MAX_BODY_CHARS) {
            out = out.substring(0, MAX_BODY_CHARS) + "…(" + (out.length() - MAX_BODY_CHARS) + " chars truncated)";
        }
        return out;
    }

    private Object redactJson(Object node) throws JSONException {
        if (node instanceof JSONObject) {
            JSONObject o = (JSONObject) node;
            JSONObject out = new JSONObject();
            Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                Object v = o.opt(k);
                if (sensitiveKey(k)) {
                    out.put(k, mask(String.valueOf(v)));
                    redactedFields++;
                } else if (v instanceof JSONObject || v instanceof JSONArray) {
                    out.put(k, redactJson(v));
                } else if (v instanceof String) {
                    // 字符串值也要过文本规则：服务端回显的 URL、回显的请求体都在这里。
                    // 只按键名匹配的话，{"url":"/x?token=abc"} 这种会整条漏出去。
                    String sv = (String) v;
                    String rv = redactText(sv);
                    out.put(k, rv.equals(sv) ? v : rv);
                } else {
                    out.put(k, v);
                }
            }
            return out;
        }
        if (node instanceof JSONArray) {
            JSONArray a = (JSONArray) node;
            JSONArray out = new JSONArray();
            for (int i = 0; i < a.length(); i++) {
                Object v = a.opt(i);
                out.put(v instanceof JSONObject || v instanceof JSONArray ? redactJson(v) : v);
            }
            return out;
        }
        return node;
    }

    private String redactText(String text) {
        // 每条规则的替换值都要带上被命中秘密的长度，所以走 Matcher 循环而不是
        // replaceAll("$1***")——后者写死长度，而长度是这一版刻意保留的调试信号。
        String out = replaceMaskingGroup(text,
                "(?i)(bearer\\s+)([A-Za-z0-9._~+/=-]{6,})", 2, "");
        out = replaceMaskingGroup(out,
                "(?<![A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{8,})", 1, "");
        // URL 参数形态。服务端把请求 URL 原样回显进响应体（错误回显、调试回显）
        // 是最常见的一种泄露，而那个 URL 里的键名不在 JSON 键位上，按键名匹配穿不透。
        out = replaceMaskingGroup(out,
                "(?i)([?&;](?:" + KEY_ALT + ")=)([^&\\s\"'\\\\]+)", 2, "");
        // 内嵌 JSON 形态。**故意分两种写法各做一次**，而不是写一条「反斜杠可选」的正则：
        // 后者在 Java 字符串里要叠四层转义，写错一个 `?` 就会静默失效——本轮第一次
        // 实现就栽在这里（测试红在「转义 JSON 里的 password 没打码」）。
        // 拆成两条，每条都短到能用肉眼核对，比一条「聪明」的正则可靠。
        for (String k : SENSITIVE_KEYS) {
            // 裸 key 不参与：见 KEY_ALT 的注释，它会把 ?key=page2 这种正常参数打掉。
            if ("key".equals(k)) continue;
            // 形态一：{"password":"xxx"}
            out = replaceMaskingGroup(out,
                    "(?i)(\"" + k + "\"\\s*:\\s*\")([^\"]*)\"", 2, "\"");
            // 形态二：\"password\":\"xxx\" —— 响应体里又嵌了一层字符串化的 JSON
            out = replaceMaskingGroup(out,
                    "(?i)(\\\\\"" + k + "\\\\\"\\s*:\\s*\\\\\")([^\"\\\\]*)\\\\\"", 2, "\\\"");
        }
        if (!out.equals(text)) redactedFields++;
        return out;
    }

    /**
     * 按正则逐命中替换：group(prefixGroup) 原样保留，group(secretGroup) 换成带长度的
     * 打码值，再补上 suffix（JSON 形态的收尾引号在分组外面，不能丢）。
     *
     * 为什么不用 {@link java.util.regex.Matcher#replaceAll(String)}：替换值里需要
     * 被命中串的长度，而替换串是静态的。用 find/appendReplacement 手写一遍，
     * 行为完全可控。
     */
    private static String replaceMaskingGroup(String text, String regex, int secretGroup,
                                              String suffix) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(regex).matcher(text);
        StringBuffer sb = new StringBuffer();
        int hits = 0;
        while (m.find()) {
            String secret = m.group(secretGroup);
            String prefix = secretGroup > 1 ? m.group(secretGroup - 1) : null;
            String replacement = (prefix == null ? "" : java.util.regex.Matcher
                    .quoteReplacement(prefix)) + mask(secret)
                    + (suffix == null || suffix.isEmpty() ? ""
                            : java.util.regex.Matcher.quoteReplacement(suffix));
            m.appendReplacement(sb, replacement);
            hits++;
        }
        m.appendTail(sb);
        return hits == 0 ? text : sb.toString();
    }

    /** 给调用方一个总计数（规则/记录都清空后仍可读，用于日志对账）。 */
    public synchronized Map<String, Long> counters() {
        Map<String, Long> m = new LinkedHashMap<String, Long>();
        m.put("total", total);
        m.put("dropped", dropped);
        m.put("undecryptable", undecryptable);
        m.put("rewritten", rewritten);
        m.put("redacted_fields", redactedFields);
        return m;
    }

    /** 只读快照，测试用。 */
    synchronized List<JSONObject> snapshot() {
        return new ArrayList<JSONObject>(records);
    }
}
