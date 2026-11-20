package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;

/**
 * MailboxGcPolicy — S1 的设备侧 GC 判定与审计行（纯函数，不需要 Android 运行时）。
 *
 * <p>为什么单独成类：保留期（result 24h / processing 72h / tmp 1h）是**契约**
 * 而不是顺便写死的常量，BridgeService 与状态面（status.json 的
 * oldest_result_age_ms / dropped）必须用同一份判定。放进 Service 里就没法在
 * JVM 上钉住「超过 24h」这个边界。
 *
 * <p>GC 是**丢弃**，不是消费：消费方（发起 cmd_&lt;id&gt; 的那个信箱客户端）
 * 读到并核对回执后自己删除；GC 只在消费方失约时兜底，并把丢弃记进
 * gc_audit.jsonl 与 status.mailbox.dropped —— 审计行只有元数据，绝不带正文。
 */
public final class MailboxGcPolicy {

    public static final long RESULT_RETENTION_MS = 24L * 60 * 60 * 1000;
    public static final long PROCESSING_RETENTION_MS = 72L * 60 * 60 * 1000;
    public static final long TMP_RETENTION_MS = 60L * 60 * 1000;

    /** 审计落盘文件名（与 status.json 同目录；一行一条 JSON）。 */
    public static final String AUDIT_FILE = "gc_audit.jsonl";

    private MailboxGcPolicy() {}

    /**
     * 文件名 → 资源类别。只认信箱的三类形状：
     * result_&lt;id&gt;.json / processing_&lt;id&gt;.json / *.tmp；其余返回 null。
     */
    public static String kindOf(String name) {
        if (name == null) return null;
        if (name.startsWith("result_") && name.endsWith(".json")) return "result";
        if (name.startsWith("processing_") && name.endsWith(".json")) return "processing";
        if (name.endsWith(".tmp")) return "tmp";
        return null;
    }

    /** 「超过 N 小时」是严格大于：边界那一刻不动。未知类别永不到期。 */
    public static boolean isDue(String kind, long ageMs) {
        if (ageMs < 0) return false;
        if ("result".equals(kind)) return ageMs > RESULT_RETENTION_MS;
        if ("processing".equals(kind)) return ageMs > PROCESSING_RETENTION_MS;
        if ("tmp".equals(kind)) return ageMs > TMP_RETENTION_MS;
        return false;
    }

    /**
     * 最老一条 result 的年龄；没有结果时为 -1（与 heartbeat_age_ms 的
     * 「-1 = 还没发生过」口径一致，不用 0 冒充）。
     */
    public static long oldestResultAgeMs(long[] ages) {
        if (ages == null || ages.length == 0) return -1L;
        long oldest = -1L;
        for (long age : ages) {
            if (age > oldest) oldest = age;
        }
        return oldest;
    }

    /** 审计行：op/ts/kind/name/age_ms 五个键，不含任何回执正文。 */
    public static String auditJson(long nowMs, String kind, String name, long ageMs) {
        try {
            return new JSONObject()
                    .put("op", "gc_drop")
                    .put("ts", nowMs)
                    .put("kind", kind)
                    .put("name", name)
                    .put("age_ms", ageMs)
                    .toString();
        } catch (Throwable t) {
            return "";
        }
    }
}
