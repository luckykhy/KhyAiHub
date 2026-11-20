package com.khyos.khy_os_client.bridge;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * B6 调用链护栏的设备侧实现 —— lib/core/trajectory/call_chain.dart 的同一份
 * 数值契约（device/B6.md §1.1）：depth 上限 2、单条 trace 调用上限 30
 * （复用 AmooLoop.Options.maxRounds，不新造第二个预算数值）、错误码与
 * contract K-23 表逐字一致。两端漂移时 Dart 侧单元门先红。
 *
 * 为什么这道门只加在信箱边界：跨端信封按 C2 走「节点通道下发 + 结果文件回写」，
 * 信箱是本机唯一收信封的入口。HTTP /call 是 PC 侧 adb forward 通道的既有形状
 * （闭集 {tool,args}，K-12 不扩展它的使用面），不掺第二套信封进来。
 *
 * 记账只进内存：进程重启后序号基线从零起，跨轮续接的基线要调用方按已确认的
 * 最大 seq 重喂（B8 租约的面，这里不做持久化）。
 */
final class CallChain {
    private CallChain() {}

    /** 本端声明的协议版本；对端不在支持集合内即拒（K-20）。 */
    static final String PROTO_V = "1.0";

    private static final Set<String> SUPPORTED_PROTO_V =
            new HashSet<>(Arrays.asList(PROTO_V));

    /** depth=0/1 放行，depth>=2 拒（K-51）。 */
    static final int MAX_DEPTH = 2;

    /** 单条 trace 的调用上限，与 AmooLoop.Options.maxRounds 同一个数。 */
    static final int MAX_CALLS_PER_TRACE = 30;

    static final String CODE_RECURSION_DEPTH_EXCEEDED = "recursion_depth_exceeded";
    static final String CODE_SESSION_BUDGET_EXCEEDED = "session_budget_exceeded";
    static final String CODE_INVALID_ARGUMENTS = "invalid_arguments";
    static final String CODE_SEQ_CONFLICT = "seq_conflict";
    static final String CODE_PROTO_V_UNSUPPORTED = "proto_v_unsupported";

    /** 回执让人去读的规范主题；白名单在 /agent-guide（exec/mailbox/schema/ui/loop）。 */
    private static final String GUIDE_TOPIC = "mailbox";
    private static final String GUIDE_TOPIC_SCHEMA = "schema";

    /** 12 个合约字段（TASK.md §5）；信箱传输另有 id（K-03：正文 id 与文件名一致）。 */
    private static final Set<String> FIELDS = new HashSet<>(Arrays.asList(
            "proto_v", "session_id", "msg_id", "seq", "from", "to", "kind",
            "payload", "trace_id", "parent_span", "depth", "idempotency_key"));

    private static final Set<String> KINDS = new HashSet<>(Arrays.asList(
            "指令", "事件", "审批", "结果", "错误"));

    private static final Pattern SESSION_ID = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");

    private static final Object LOCK = new Object();

    /** trace_id -> 已放行次数。 */
    private static final LinkedHashMap<String, Integer> CALLS = new LinkedHashMap<>();

    /** "session|from|to" -> 已确认的最大 seq（每方向独立计数，K-20）。 */
    private static final LinkedHashMap<String, Integer> SEQ_BASE = new LinkedHashMap<>();

    /**
     * 记账表的上限。桥是常驻前台服务，trace_id / session_id 都来自对端——不设
     * 上限就是一条缓慢的内存泄漏。到顶丢最早见过的那条：它的调用计数与序号
     * 基线一起失效（该 trace 重新计预算、该方向的续接会吃一次 seq_conflict），
     * 但那已是 4096 条不同的链之前的事。
     */
    private static final int MAX_TRACKED = 4096;

    /** 这一跳过不过闸门。 */
    static final class Verdict {
        final boolean admitted;
        final String code;
        final String error;
        final String fix;
        final String guideTopic;

        /** 预算拒时是已用量，其余 -1。 */
        final int used;

        final int limit;

        private Verdict(boolean admitted, String code, String error, String fix,
                        String guideTopic, int used, int limit) {
            this.admitted = admitted;
            this.code = code;
            this.error = error;
            this.fix = fix;
            this.guideTopic = guideTopic;
            this.used = used;
            this.limit = limit;
        }

        static Verdict admit() {
            return new Verdict(true, null, null, null, null, -1, -1);
        }

        static Verdict reject(String code, String error, String fix, String guideTopic) {
            return new Verdict(false, code, error, fix, guideTopic, -1, -1);
        }

        static Verdict budget(String code, String error, String fix, String guideTopic,
                              int used, int limit) {
            return new Verdict(false, code, error, fix, guideTopic, used, limit);
        }
    }

    /**
     * 信箱命令是不是调用链信封。判据是 trace_id + depth 同时在场：既有扁平
     * 形状（{id,tool,args}）两个都没有，不会误入这条路。
     */
    static boolean isEnvelope(JSONObject cmd) {
        return cmd.has("trace_id") && cmd.has("depth");
    }

    /** 这条 trace 已放行的调用数。 */
    static int usedCalls(String traceId) {
        synchronized (LOCK) {
            Integer n = CALLS.get(traceId);
            return n == null ? 0 : n;
        }
    }

    /**
     * 形状校验 + 护栏。顺序与 Dart 侧一致（device/B6.md §1.3）：depth → 预算
     * → seq。超预算的 trace 再发报预算码而不是序号码——不让调用方误以为只是
     * 序号错。
     */
    static Verdict admit(JSONObject env) {
        Verdict shape = checkShape(env);
        if (shape != null) return shape;

        int depth = env.optInt("depth");
        if (depth >= MAX_DEPTH) {
            return Verdict.reject(CODE_RECURSION_DEPTH_EXCEEDED,
                    "调用链第 " + (depth + 1) + " 层被拒：depth 上限 " + MAX_DEPTH
                            + "，被调用方不得回调用发起方做同一目标。",
                    "收敛调用链（换 trace_id 重开一条）或改用结果文件回写，"
                            + "递归防护读 GET /agent-guide?topic=" + GUIDE_TOPIC,
                    GUIDE_TOPIC);
        }

        String traceId = env.optString("trace_id");
        int used = usedCalls(traceId);
        if (used >= MAX_CALLS_PER_TRACE) {
            return Verdict.budget(CODE_SESSION_BUDGET_EXCEEDED,
                    "本条 trace 的调用次数已达上限（已用 " + used + " / 上限 "
                            + MAX_CALLS_PER_TRACE + "）：互调熔断，不再放行。",
                    "停止继续调用，先汇总已得结果或另起 trace_id，"
                            + "预算语义读 GET /agent-guide?topic=" + GUIDE_TOPIC,
                    GUIDE_TOPIC, used, MAX_CALLS_PER_TRACE);
        }

        String key = env.optString("session_id") + "|" + env.optString("from")
                + "|" + env.optString("to");
        int expect;
        synchronized (LOCK) {
            Integer base = SEQ_BASE.get(key);
            expect = (base == null ? 0 : base) + 1;
            if (env.optInt("seq") != expect) {
                return Verdict.reject(CODE_SEQ_CONFLICT,
                        "序号冲突：本方向下一条应为 " + expect + "，收到 "
                                + env.optInt("seq") + "。",
                        "按已确认的最大 seq 续序后重发（被拒的消息不进基线），"
                                + "信封字段读 GET /agent-guide?topic=" + GUIDE_TOPIC,
                        GUIDE_TOPIC);
            }
            Integer seen = CALLS.get(traceId);
            CALLS.put(traceId, seen == null ? 1 : seen + 1);
            SEQ_BASE.put(key, expect);
            evictOldest(CALLS);
            evictOldest(SEQ_BASE);
        }
        return Verdict.admit();
    }

    private static void evictOldest(LinkedHashMap<String, Integer> table) {
        if (table.size() > MAX_TRACKED) {
            table.remove(table.keySet().iterator().next());
        }
    }

    /**
     * 拒绝回执，镜像 HttpBridge.invalidArguments 的形状：三个幂等字段恒 false
     * （K-24：信封级拒绝时什么都没到工具层），预算拒时另带 used 与 limit。
     */
    static JSONObject receipt(Verdict v) throws JSONException {
        JSONObject r = new JSONObject()
                .put("ok", false)
                .put("code", v.code)
                .put("error", v.error)
                .put("fix", v.fix)
                .put("guide_topic", v.guideTopic)
                .put("action_dispatched", false)
                .put("replay_safe", false)
                .put("retry_safe", false);
        if (v.used >= 0) {
            r.put("used", v.used).put("limit", v.limit);
        }
        return r;
    }

    /**
     * 把调用链三字段回显到回执上（判据【B6】：每跳回执都回显同一个 trace_id，
     * parent_span 链可反推回根）。根消息的 parent_span 显式写 null。
     */
    static void echoTrace(JSONObject receipt, JSONObject env) throws JSONException {
        receipt.put("trace_id", env.optString("trace_id", ""));
        receipt.put("parent_span",
                env.has("parent_span") && !env.isNull("parent_span")
                        ? env.optString("parent_span", "")
                        : JSONObject.NULL);
        receipt.put("depth", env.optInt("depth"));
    }

    /**
     * 信封形状。只判护栏要消费的字段与闭集，不重新实现一遍业务语义；
     * 返回值非空即拒绝理由，code 必是 K-23 表里的一个。
     */
    private static Verdict checkShape(JSONObject env) {
        java.util.Iterator<String> keys = env.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            if (!FIELDS.contains(k) && !k.equals("id")) {
                return invalid("信封含未定义字段 \"" + k + "\"：顶层只允许 12 个合约字段"
                        + "（信箱传输另加 id）。", "去掉该字段后重写，字段表读 GET /agent-guide?topic="
                        + GUIDE_TOPIC, GUIDE_TOPIC);
            }
        }

        String protoV = env.optString("proto_v");
        if (protoV.isEmpty()) {
            return invalid("proto_v 缺失或不是字符串。", "补上本端声明的协议版本",
                    GUIDE_TOPIC);
        }
        if (!SUPPORTED_PROTO_V.contains(protoV)) {
            return Verdict.reject(CODE_PROTO_V_UNSUPPORTED,
                    "proto_v \"" + protoV + "\" 不在对端支持集合内：本端只支持 "
                            + PROTO_V + "。",
                    "把 proto_v 改成受支持的值（" + PROTO_V + "）后重发", GUIDE_TOPIC);
        }

        String sessionId = env.optString("session_id");
        if (!SESSION_ID.matcher(sessionId).matches()) {
            return invalid("session_id \"" + sessionId + "\" 形状不合法：须 1-64 位"
                    + "字母/数字/下划线/短横线。", "改用合法形状的会话 id 后重发", GUIDE_TOPIC);
        }

        if (env.optString("msg_id").isEmpty()) {
            return invalid("msg_id 缺失或为空：span id 就是 msg_id，空值无法复原调用链。",
                    "补上全局唯一的 msg_id", GUIDE_TOPIC);
        }
        if (!hasInt(env, "seq")) {
            return invalid("seq 缺失或不是整数。", "把 seq 改成本方向的下一个序号", GUIDE_TOPIC);
        }
        if (env.optString("from").isEmpty() || env.optString("to").isEmpty()) {
            return invalid("from/to 缺失或为空。", "补上发起方与接收方身份", GUIDE_TOPIC);
        }

        String kind = env.optString("kind");
        if (!KINDS.contains(kind)) {
            return invalid("kind \"" + kind + "\" 不是五个合约值之一"
                    + "（指令/事件/审批/结果/错误）。", "把 kind 改成五个合约值之一", GUIDE_TOPIC);
        }

        JSONObject payload = env.optJSONObject("payload");
        if (payload == null) {
            return invalid("payload 缺失或不是 JSON 对象。", "把 payload 改为对象后重发",
                    GUIDE_TOPIC);
        }
        if (kind.equals("指令")) {
            java.util.Iterator<String> pk = payload.keys();
            while (pk.hasNext()) {
                String k = pk.next();
                if (!k.equals("tool") && !k.equals("args")) {
                    return invalid("kind=指令 的 payload 含未定义字段 \"" + k
                            + "\"：闭集为 {tool,args}。", "去掉该字段后重发，每工具参数细节读"
                            + " GET /agent-guide?topic=" + GUIDE_TOPIC_SCHEMA, GUIDE_TOPIC_SCHEMA);
                }
            }
            if (payload.optString("tool").isEmpty()) {
                return invalid("kind=指令 的 payload 缺 tool 或 tool 为空：闭集为 {tool,args}。",
                        "补上工具名后重发，工具表读 GET /agent-guide?topic="
                                + GUIDE_TOPIC_SCHEMA, GUIDE_TOPIC_SCHEMA);
            }
            if (payload.optJSONObject("args") == null) {
                return invalid("kind=指令 的 payload 的 args 不是 JSON 对象：闭集为 {tool,args}。",
                        "把 args 改为对象后重发，每工具参数细节读 GET /agent-guide?topic="
                                + GUIDE_TOPIC_SCHEMA, GUIDE_TOPIC_SCHEMA);
            }
        }

        if (env.optString("trace_id").isEmpty()) {
            return invalid("trace_id 缺失或为空：一次跨端任务全程不变，空值无法对账。",
                    "补上调用链根 id", GUIDE_TOPIC);
        }
        if (env.has("parent_span") && !env.isNull("parent_span")
                && env.optString("parent_span").isEmpty()) {
            return invalid("parent_span 必须是字符串或空：根消息用 null，不用空串。",
                    "把 parent_span 改为父消息的 msg_id，根消息改为 null", GUIDE_TOPIC);
        }
        if (!hasInt(env, "depth") || env.optInt("depth") < 0) {
            return invalid("depth 缺失、不是整数或为负：depth 是主叫方的实际层级。",
                    "把 depth 改为 0 或正整数后重发", GUIDE_TOPIC);
        }
        if (kind.equals("指令") || kind.equals("审批")) {
            if (env.optString("idempotency_key").isEmpty()) {
                return invalid("kind=" + kind + " 缺 idempotency_key：同 key 重放要能返回"
                        + "首次结果。", "补上全局唯一的幂等键后重发", GUIDE_TOPIC);
            }
        }
        return null;
    }

    private static Verdict invalid(String problem, String fix, String guideTopic) {
        return Verdict.reject(CODE_INVALID_ARGUMENTS, problem, fix, guideTopic);
    }

    /** optInt 会把非数字字符串吞成默认值，这里要先分清「没有」和「不是整数」。 */
    private static boolean hasInt(JSONObject o, String key) {
        if (!o.has(key)) return false;
        Object v = o.opt(key);
        return v instanceof Integer || v instanceof Long || v instanceof Double;
    }
}
