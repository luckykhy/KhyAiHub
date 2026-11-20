package com.khyos.khy_os_client.bridge;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 共享层（断点三）：{@code /sdcard/khyos-sync} 的落盘真源。
 *
 * <h3>为什么是追加式 JSONL + 哈希链，而不是一份可重写的 JSON 文档</h3>
 * 两端各写各的，没有协调者。任何"读-改-写整份文档"的形态都会在两端同时写时
 * 互相吞掉对方的行——而且吞掉之后**没有任何痕迹**。追加式没有这个问题：谁写的
 * 谁那一行永远在，冲突退化成"两条都留着"，由消费侧按 id 决定谁是最新。
 *
 * 哈希链（每行带 {@code prev}）补的是另一件事：追加式能保证"不丢行"，但保证不了
 * "没少行"。少了中间一行，剩下的行看起来完全正常。{@code prev} 指向上一条的
 * {@code hash}，断一行就断链，{@link #verify} 能指到具体行号。**断链时停止合并**
 * 是硬要求：接着合下去等于把一段来历不明的数据当成事实。
 *
 * <h3>单写者</h3>
 * 本机只 append {@code self*.jsonl}，{@code peer*.jsonl} 只读不写。这条不是约定，
 * 是 {@link #append} 只接受 {@code self} 的实现约束——写对方那份没有入口。
 *
 * <h3>墓碑</h3>
 * 删除是追加 {@code {"op":"delete","id":...}}，不是重写、不是压缩。重写会让
 * 已经发出去的行号与哈希全部失效，对端手里那份就再也对不上链了。
 *
 * <h3>2MB 滚动</h3>
 * 段文件超过 {@link #MAX_SEGMENT_BYTES} 就新开一段，链**跨段延续**（新段首条
 * 的 {@code prev} 是上一段末条的 hash）。滚动只影响"行落在哪个文件"，不影响链。
 *
 * <h3>隐私</h3>
 * 两级。来源级不信任（{@link #NEVER_SYNC_SOURCES} 与 {@code meta.sensitive}）
 * **整条不入流**——那种记录连"哪段是敏感"都不可信，替换会漏。值级敏感
 * （Authorization/Cookie/Bearer/sk-/口令/私钥块/卡号）**替换后写入**：值换成
 * {@code <redacted>}，字段名留在原文位置，原长度记进 {@code meta.redacted}。
 * 明文在进文件系统之前就被换掉，"先落盘再打码"那一瞬间的窗口不存在。
 */
public final class SyncStore {

    public static final String DIR = "/sdcard/khyos-sync";

    /** 段文件上限。超过就滚到下一段；链跨段延续。 */
    static final long MAX_SEGMENT_BYTES = 2L * 1024 * 1024;

    /** 本机那份 / 对端那份。写入口只接受 SELF。 */
    public static final String SELF = "self";
    public static final String PEER = "peer";

    /** 链头。空串而不是 null：JSON 里 null 会被 optString 读成 "null" 四个字母。 */
    static final String GENESIS = "";

    private static final String TAG = "SyncStore";

    /**
     * 敏感内容形态。每个模式的**第 1 捕获组就是要替换的值**，字段名见
     * {@link #SENSITIVE_FIELD}——头名/键名留在原文位置，只换值。
     * 2026-11-15 起从"整条拒写"改为"值替换"：拒写让正常记录也进不了共享层，
     * 而替换在明文落盘前就把它换掉了，两者防的不是同一个风险。
     */
    private static final Pattern[] SENSITIVE = {
            // 内置/外部 API key 形态（sk- 开头是历史包袱里最常见的一种）
            Pattern.compile("(sk-[A-Za-z0-9_\\-]{12,})"),
            // Bearer 令牌（ authorization: Bearer xxx 里的 xxx）
            Pattern.compile("(?i)\\bbearer\\s+([A-Za-z0-9._\\-]{12,})"),
            // Authorization 头：引号串（JSON）与裸串（文本）都只取引号内/裸串部分
            Pattern.compile("(?i)\\bauthorization\\s*[:=]\\s*(\"[^\"]*\"|[^\\s,;}\\]\"]+)"),
            // Cookie 头（T9 补）：同上
            Pattern.compile("(?i)\\bcookie\\s*[:=]\\s*(\"[^\"]*\"|[^\\s,;}\\]\"]+)"),
            // 私钥块（整块都是秘密，无字段名可留）
            Pattern.compile("(-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----)"),
            // 口令字段
            Pattern.compile("(?i)\\b(?:password|passwd|pwd)\\s*[:=]\\s*(\"[^\"]*\"|[^\\s,;}\\]\"]+)"),
            // 投递码/一次性码字段
            Pattern.compile("(?i)\\b(?:token|secret|api[_-]?key)\\s*[:=]\\s*(\"[^\"]*\"|\\S{8,})"),
            // 连续 16~19 位数字（卡号形态，允许中间夹空格/短横）
            Pattern.compile("(\\b(?:\\d[ -]?){15,18}\\d\\b)"),
    };

    /** 与 {@link #SENSITIVE} 逐位对应的字段名，原长度随它一起记进 meta.redacted。 */
    private static final String[] SENSITIVE_FIELD = {
            "api-key", "bearer", "authorization", "cookie",
            "private-key", "password", "token", "card-number",
    };

    /** 脱敏后的值。JSON 字符串值只换引号内的部分，引号留着——否则记录不再是合法 JSON。 */
    private static String maskValue(String v) {
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
            return "\"<redacted>\"";
        }
        return "<redacted>";
    }

    /** 原值的真实长度：引号串去掉两头引号算。 */
    private static int secretLen(String v) {
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
            return v.length() - 2;
        }
        return v.length();
    }

    static final class Redaction {
        String content;
        final JSONArray hits = new JSONArray();
        boolean any() {
            return hits.length() > 0;
        }
    }

    /**
     * 值级脱敏：把命中位置的值换成 {@code <redacted>}，字段名与原长度记进 hits。
     * 原文绝不进返回值以外的任何地方（日志只报处数与字段名）。
     */
    static Redaction redact(String content) {
        Redaction r = new Redaction();
        r.content = content == null ? "" : content;
        if (content == null || content.isEmpty()) return r;
        String s = content;
        for (int i = 0; i < SENSITIVE.length; i++) {
            Matcher m = SENSITIVE[i].matcher(s);
            StringBuilder sb = new StringBuilder();
            int last = 0;
            boolean hit = false;
            while (m.find()) {
                String v = m.group(1);
                if (v == null) continue;
                hit = true;
                sb.append(s, last, m.start(1)).append(maskValue(v));
                last = m.end(1);
                try {
                    r.hits.put(new JSONObject().put("field", SENSITIVE_FIELD[i]).put("len", secretLen(v)));
                } catch (Throwable ignored) {}
            }
            if (hit) {
                sb.append(s.substring(last));
                s = sb.toString();
            }
        }
        r.content = s;
        return r;
    }

    /** 把 hits 并进 meta 的拷贝里——不改调用方传进来的那个对象。 */
    static JSONObject withRedactedMeta(JSONObject meta, JSONArray hits) {
        JSONObject m;
        try {
            m = meta == null ? new JSONObject() : new JSONObject(meta.toString());
        } catch (Throwable t) {
            m = new JSONObject();
        }
        try {
            m.put("redacted", hits);
        } catch (Throwable ignored) {}
        return m;
    }

    /** 产物来源里天然带原文的，整条不入流。 */
    private static final java.util.Set<String> NEVER_SYNC_SOURCES =
            new java.util.LinkedHashSet<>(java.util.Arrays.asList(
                    "clipboard", "shot", "screenshot", "screen", "payment", "credential"));

    /** 本进程内被拒条数（不落盘：重启归零，status 里看得到即可）。 */
    private static volatile long redactedCount = 0L;
    private static volatile long malformedCount = 0L;

    private SyncStore() {
    }

    // ==================== 布局 ====================

    /**
     * 首启自建：目录 + 默认配置。幂等，可以每次 onCreate 都调。
     *
     * 只建**结构**，不预置任何消息行、不写设备标识。T8 的判据就是"全新安装后
     * 目录里只有 config.json"——预置一个空 self.jsonl 都会让那条判据失去意义，
     * 因为"有没有被写过"从此看不出来了。
     */
    public static synchronized JSONObject ensureLayout() {
        JSONObject out = new JSONObject();
        File dir = new File(DIR);
        boolean created = false;
        boolean ok = true;
        try {
            if (!dir.isDirectory()) created = dir.mkdirs();
            ok = dir.isDirectory();
            File cfg = new File(dir, "config.json");
            if (ok && !cfg.isFile()) {
                writeAtomic(cfg, defaultConfig().toString());
            }
        } catch (Throwable t) {
            Log.w(TAG, "ensureLayout 失败: " + t);
            ok = false;
        }
        try {
            out.put("ok", ok).put("dir", DIR).put("created", created);
            out.put("config", readConfig());
        } catch (Throwable ignored) {
        }
        return out;
    }

    /** 默认配置。**不含**设备标识、路径、用户名——那些属于运行时，不属于出厂。 */
    static JSONObject defaultConfig() throws org.json.JSONException {
        return new JSONObject()
                .put("version", 1)
                .put("enabled", true)
                .put("max_segment_bytes", MAX_SEGMENT_BYTES)
                .put("max_content_bytes", DEFAULT_MAX_CONTENT_BYTES)
                .put("local_only_export", false)
                .put("redact", true);
    }

    static JSONObject readConfig() {
        JSONObject out = new JSONObject();
        try {
            File cfg = new File(DIR, "config.json");
            if (!cfg.isFile()) return defaultConfig();
            String s = readText(cfg);
            if (s.trim().isEmpty()) return defaultConfig();
            return new JSONObject(s);
        } catch (Throwable t) {
            // 配置坏了不拦共享层：用默认值继续，坏文件留在原地可查。
            try {
                return defaultConfig().put("config_error", String.valueOf(t));
            } catch (Throwable ignored) {
                return new JSONObject();
            }
        }
    }

    static File segmentFile(String role, int segment) {
        return new File(DIR, segment <= 0 ? role + ".jsonl" : role + "." + segment + ".jsonl");
    }

    // ==================== 游标 ====================

    static JSONObject readCursor() {
        try {
            File f = new File(DIR, "cursor.json");
            if (!f.isFile()) return emptyCursor();
            String s = readText(f);
            if (s.trim().isEmpty()) return emptyCursor();
            return new JSONObject(s);
        } catch (Throwable t) {
            Log.w(TAG, "cursor 读失败，按空游标继续: " + t);
            return emptyCursor();
        }
    }

    static JSONObject emptyCursor() {
        try {
            return new JSONObject()
                    .put(SELF, roleCursor(0, 0, 0, GENESIS))
                    .put(PEER, roleCursor(0, 0, 0, GENESIS));
        } catch (Throwable t) {
            return new JSONObject();
        }
    }

    static JSONObject roleCursor(int segment, long offset, long lines, String lastHash)
            throws org.json.JSONException {
        return new JSONObject()
                .put("segment", segment)
                .put("offset", offset)
                .put("lines", lines)
                .put("last_hash", lastHash == null ? GENESIS : lastHash);
    }

    /**
     * 读侧游标推进（S2）：把 verify 得到的真值一次写进 segment/offset/lines/
     * last_hash。为什么要有这一个方法：peer.lines/peer.last_hash 此前没有任何
     * 写入点（只有 append/delete 的 self 分支写它们），peer 游标停在 lines=0，
     * 读的人把 0 当成「没有数据」——数据在盘上，坏的是簿记。
     *
     * <p>「lines=0 + offset>0」是**事实**也要照写（刚滚段的空读）：0 与
     * 「无数据」是两回事，任何把 0 改写成别的值的好意都在伪造簿记。
     *
     * <p>只动被推进的 role：self 是写游标（append 的 prev 来源），读永远不许碰。
     * cursor 为 null 或缺 role 块时按 emptyCursor 同形补齐两份 role 块。
     * 纯静态、不碰 IO——JVM 单测唯一测得动的形状。
     */
    static JSONObject advanceCursor(JSONObject cursor, String role, int segment,
                                    long offset, long lines, String lastHash) {
        JSONObject out = cursor == null ? emptyCursor() : cursor;
        try {
            JSONObject rc = out.optJSONObject(role);
            if (rc == null) rc = roleCursor(0, 0, 0, GENESIS);
            rc.put("segment", segment);
            rc.put("offset", offset);
            rc.put("lines", lines);
            rc.put("last_hash", lastHash == null ? GENESIS : lastHash);
            out.put(role, rc);
        } catch (Throwable t) {
            Log.w(TAG, "advanceCursor 失败: " + t);
        }
        return out;
    }

    static synchronized void writeCursor(JSONObject cursor) {
        try {
            writeAtomic(new File(DIR, "cursor.json"), cursor.toString());
        } catch (Throwable t) {
            Log.w(TAG, "cursor 写失败: " + t);
        }
    }

    // ==================== 体量（blob 引用） ====================

    /**
     * 单条 content 的字节上限（T14）。超过的 content 落 {@code blobs/<sha>.blob}，
     * 行里只存引用（id + 字节数 + 摘要前缀）——否则一条 16KB 的消息能把整段
     * 的行均值抬高一倍，而 JSONL 的每一行都是要过哈希链的。
     *
     * 为什么走 config 而不是常量：阈值是产品决策（UI 展示、传输预算都受它影响），
     * 写死就意味着改它要改代码。默认 8KB。
     */
    static final long DEFAULT_MAX_CONTENT_BYTES = 8L * 1024;

    /** 引用型 content 的标记键——content 字段里一个 JSON 串，形如 {"khyos_blob_ref":{…}}。 */
    static final String REF_KEY = "khyos_blob_ref";

    private static File blobFile(String sha) {
        return new File(DIR, "blobs" + File.separator + sha + ".blob");
    }

    private static String preview(String s) {
        String t = s == null ? "" : s.trim();
        return t.length() > 80 ? t.substring(0, 80) + "…" : t;
    }

    /**
     * 大 content 落 blob，返回引用串。失败返回 null——调用方按原样写行：
     * 引用建不起来也不能把数据丢了（保命优先于体量）。
     */
    private static String writeBlobRef(String content) {
        try {
            byte[] b = content.getBytes(StandardCharsets.UTF_8);
            String sha = sha256Hex(content);
            File dir = new File(DIR, "blobs");
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            File f = blobFile(sha);
            if (!f.isFile()) {
                writeAtomic(f, new String(b, StandardCharsets.UTF_8));
            }
            return new JSONObject()
                    .put(REF_KEY, new JSONObject()
                            .put("id", sha)
                            .put("bytes", b.length)
                            .put("preview", preview(content)))
                    .toString();
        } catch (Throwable t) {
            Log.w(TAG, "blob 写入失败，按原样写行: " + t);
            return null;
        }
    }

    /**
     * 引用型记录还原：content 是引用串时把 blob 内容读回 content。
     * blob 缺失不抛异常——记录照原样出去（引用串即 content），调用方自己看得懂；
     * 哈希校验走的是引用形态（append 时就按它算的），还原只发生在读路径。
     */
    static JSONObject restoreBlob(JSONObject rec) {
        try {
            String c = rec.optString("content", null);
            if (c == null || !c.contains(REF_KEY)) return rec;
            JSONObject ref = new JSONObject(c).optJSONObject(REF_KEY);
            if (ref == null) return rec;
            File f = blobFile(ref.optString("id", ""));
            if (!f.isFile()) return rec;
            rec.put("content", new String(readBytes(f), StandardCharsets.UTF_8));
            rec.put("blob_restored", true);
        } catch (Throwable t) {
            Log.w(TAG, "blob 还原失败: " + t);
        }
        return rec;
    }

    // ==================== 写 ====================

    /**
     * 追加一条活记录。**只允许 SELF**：写对方那份没有入口，这是单写者的实现约束。
     *
     * @return {@code ok=true} + id/hash/prev/segment/offset/redacted（脱敏处数）；
     *         来源级敏感返回 {@code ok=false, code=redacted} 且**不写任何字节**。
     */
    public static synchronized JSONObject append(String sessionId, String role, String content,
                                                 JSONObject meta) {
        JSONObject out = new JSONObject();
        try {
            JSONObject cfg = readConfig();
            if (!cfg.optBoolean("enabled", true)) {
                return out.put("ok", false).put("code", "disabled");
            }
            String reason = sensitiveReason(content, meta);
            if (reason != null) {
                redactedCount++;
                Log.w(TAG, "拒绝写入敏感记录: " + reason);
                return out.put("ok", false).put("code", "redacted")
                        .put("reason", reason).put("written", 0);
            }
            // 值级脱敏（T9）：命中敏感形态不再整条拒写，而是把值换成 <redacted>
            // 再落盘——明文在进文件系统之前就被换掉，字段名与原长度记进
            // meta.redacted。整条拒写只留给来源级不信任：那种记录连"哪段是
            // 敏感"都不可信，替换会漏。
            Redaction red = redact(content);
            int redactedHits = 0;
            boolean blobRef = false;
            if (red.any()) {
                redactedHits = red.hits.length();
                content = red.content;
                meta = withRedactedMeta(meta, red.hits);
                redactedCount += redactedHits;
                Log.w(TAG, "脱敏写入 " + redactedHits + " 处（字段名与长度见 meta.redacted，不记原文）");
            }
            // 体量闸（T14）：超过 max_content_bytes 的 content 落 blob，行里只存
            // 引用。判据用 config（默认 8KB）——阈值是产品决策，不许写死。
            long maxContent = cfg.optLong("max_content_bytes", DEFAULT_MAX_CONTENT_BYTES);
            if (maxContent > 0 && content.getBytes(StandardCharsets.UTF_8).length > maxContent) {
                String ref = writeBlobRef(content);
                if (ref != null) {
                    content = ref;
                    blobRef = true;
                }
            }

            ensureLayout();
            JSONObject cursor = readCursor();
            JSONObject self = cursor.optJSONObject(SELF);
            if (self == null) self = roleCursor(0, 0, 0, GENESIS);

            int segment = self.optInt("segment", 0);
            long maxBytes = cfg.optLong("max_segment_bytes", MAX_SEGMENT_BYTES);
            File seg = segmentFile(SELF, segment);
            if (seg.length() >= maxBytes) {
                // 滚动：新段首条的 prev 仍是上一段的 last_hash，链跨段不断。
                segment++;
                seg = segmentFile(SELF, segment);
                self.put("segment", segment);
                self.put("offset", 0);
            }

            JSONObject rec = new JSONObject()
                    .put("id", UUID.randomUUID().toString())
                    .put("session_id", sessionId == null ? "" : sessionId)
                    .put("role", role == null || role.isEmpty() ? "user" : role)
                    .put("content", content == null ? "" : content)
                    .put("ts", System.currentTimeMillis())
                    .put("meta", meta == null ? new JSONObject() : meta);
            String prev = self.optString("last_hash", GENESIS);
            rec.put("prev", prev);
            String hash = hashOf(rec);
            rec.put("hash", hash);

            byte[] line = (rec.toString() + "\n").getBytes(StandardCharsets.UTF_8);
            appendBytes(seg, line);

            self.put("offset", self.optLong("offset", 0) + line.length);
            self.put("lines", self.optLong("lines", 0) + 1);
            self.put("last_hash", hash);
            cursor.put(SELF, self);
            writeCursor(cursor);

            return out.put("ok", true)
                    .put("id", rec.getString("id"))
                    .put("hash", hash)
                    .put("prev", prev)
                    .put("segment", segment)
                    .put("offset", self.optLong("offset", 0))
                    .put("file", seg.getName())
                    .put("redacted", redactedHits)
                    .put("blob_ref", blobRef);
        } catch (Throwable t) {
            Log.w(TAG, "append 失败: " + t);
            try {
                return out.put("ok", false).put("code", "append_error")
                        .put("reason", String.valueOf(t));
            } catch (Throwable ignored) {
                return out;
            }
        }
    }

    /**
     * 追加墓碑。只对已存在的 id 生效：给不存在的 id 写墓碑会让链上多一条
     * 指向虚空的删除，对端合并时会把它当成"这条曾经有过"，比不删更糟。
     */
    public static synchronized JSONObject delete(String id) {
        JSONObject out = new JSONObject();
        try {
            if (id == null || id.trim().isEmpty()) {
                return out.put("ok", false).put("code", "invalid_args");
            }
            boolean found = containsId(SELF, id) || containsId(PEER, id);
            if (!found) {
                return out.put("ok", false).put("code", "not_found").put("id", id);
            }
            ensureLayout();
            JSONObject cursor = readCursor();
            JSONObject self = cursor.optJSONObject(SELF);
            if (self == null) self = roleCursor(0, 0, 0, GENESIS);
            int segment = self.optInt("segment", 0);
            File seg = segmentFile(SELF, segment);

            JSONObject rec = new JSONObject()
                    .put("op", "delete")
                    .put("id", id)
                    .put("ts", System.currentTimeMillis());
            String prev = self.optString("last_hash", GENESIS);
            rec.put("prev", prev);
            String hash = hashOf(rec);
            rec.put("hash", hash);

            byte[] line = (rec.toString() + "\n").getBytes(StandardCharsets.UTF_8);
            appendBytes(seg, line);

            self.put("offset", self.optLong("offset", 0) + line.length);
            self.put("lines", self.optLong("lines", 0) + 1);
            self.put("last_hash", hash);
            cursor.put(SELF, self);
            writeCursor(cursor);

            return out.put("ok", true).put("id", id)
                    .put("op", "delete").put("hash", hash).put("prev", prev);
        } catch (Throwable t) {
            Log.w(TAG, "delete 失败: " + t);
            try {
                return out.put("ok", false).put("code", "delete_error")
                        .put("reason", String.valueOf(t));
            } catch (Throwable ignored) {
                return out;
            }
        }
    }

    static boolean containsId(String role, String id) {
        for (JSONObject o : readAll(role, 0, 0, Integer.MAX_VALUE).items) {
            if (id.equals(o.optString("id", ""))) return true;
        }
        return false;
    }

    // ==================== 读 ====================

    static final class ReadResult {
        final List<JSONObject> items = new ArrayList<>();
        /** 最后读到的段号与该段末尾偏移；调用方用它推进读游标。 */
        long nextOffset = 0;
        int segment = 0;
        int skipped = 0;
    }

    /**
     * 增量读。{@code startOffset} 是**字节**偏移而不是行号：行号在滚动/追加下会漂，
     * 字节偏移不会。从 {@code startSegment} 段的 {@code startOffset} 开始，后续段从 0 开始。
     *
     * 半截行（对端正在写、被截断、掉电）解析失败时**跳过并记日志**，不中断整次读取
     * ——一行坏数据不该让后面所有好数据都读不到。
     */
    static ReadResult readAll(String role, int startSegment, long startOffset, int limit) {
        ReadResult r = new ReadResult();
        try {
            JSONObject cursor = readCursor();
            JSONObject rc = cursor.optJSONObject(role);
            int lastSegment = rc == null ? 0 : rc.optInt("segment", 0);
            for (int seg = Math.max(0, startSegment); seg <= lastSegment; seg++) {
                File f = segmentFile(role, seg);
                if (!f.isFile()) continue;
                long skip = (seg == startSegment) ? startOffset : 0;
                byte[] all = readBytes(f);
                int pos = (int) Math.min(Math.max(0, skip), all.length);
                // skip 落在行中间时向后找到下一个换行，避免把半行当成完整行。
                while (pos > 0 && pos < all.length && all[pos - 1] != '\n') pos++;
                while (pos < all.length) {
                    int nl = -1;
                    for (int i = pos; i < all.length; i++) {
                        if (all[i] == '\n') {
                            nl = i;
                            break;
                        }
                    }
                    int end = nl < 0 ? all.length : nl;
                    String s = new String(all, pos, end - pos, StandardCharsets.UTF_8).trim();
                    if (!s.isEmpty()) {
                        if (r.items.size() >= limit) {
                            r.segment = seg;
                            r.nextOffset = pos;
                            return r;
                        }
                        try {
                            r.items.add(restoreBlob(new JSONObject(s)));
                        } catch (Throwable bad) {
                            r.skipped++;
                            malformedCount++;
                            Log.w(TAG, "跳过半截/损坏行（" + f.getName() + "）: "
                                    + (s.length() > 120 ? s.substring(0, 120) + "…" : s));
                        }
                    }
                    pos = nl < 0 ? all.length : nl + 1;
                }
                r.segment = seg;
                r.nextOffset = all.length;
            }
        } catch (Throwable t) {
            Log.w(TAG, "readAll 失败: " + t);
        }
        return r;
    }

    // ==================== 校验 ====================

    /**
     * 全量哈希链校验。逐行重算 hash 并检查 {@code prev == 上一条 hash}。
     *
     * 断链返回 {@code ok=false, code=hash_chain_broken, break_line=N}；调用方据此
     * **停止合并**。{@code break_line} 是 1 基的行号（含被跳过的坏行），这样人拿
     * 到它就能直接 {@code sed -n 'Np'} 看那一行。
     */
    public static synchronized JSONObject verify(String role) {
        JSONObject out = new JSONObject();
        String r = (role == null || role.isEmpty()) ? PEER : role;
        int lineNo = 0;
        int badLines = 0;
        String expected = GENESIS;
        try {
            JSONObject cursor = readCursor();
            JSONObject rc = cursor.optJSONObject(r);
            int lastSegment = rc == null ? 0 : rc.optInt("segment", 0);
            for (int seg = 0; seg <= lastSegment; seg++) {
                File f = segmentFile(r, seg);
                if (!f.isFile()) continue;
                String body = new String(readBytes(f), StandardCharsets.UTF_8);
                for (String line : body.split("\n")) {
                    String s = line.trim();
                    if (s.isEmpty()) continue;
                    lineNo++;
                    JSONObject o;
                    try {
                        o = new JSONObject(s);
                    } catch (Throwable bad) {
                        badLines++;
                        continue;
                    }
                    String prev = o.optString("prev", null);
                    String hash = o.optString("hash", "");
                    if (prev == null) {
                        return out.put("ok", false).put("code", "hash_missing")
                                .put("role", r).put("break_line", lineNo);
                    }
                    if (!prev.equals(expected)) {
                        return out.put("ok", false).put("code", "hash_chain_broken")
                                .put("role", r).put("break_line", lineNo)
                                .put("expected_prev", expected).put("actual_prev", prev);
                    }
                    o.remove("hash");
                    String recomputed = hashOf(o);
                    if (!recomputed.equals(hash)) {
                        return out.put("ok", false).put("code", "hash_mismatch")
                                .put("role", r).put("break_line", lineNo)
                                .put("stored", hash).put("recomputed", recomputed);
                    }
                    expected = hash;
                }
            }
            return out.put("ok", true).put("role", r).put("lines", lineNo)
                    .put("bad_lines", badLines).put("last_hash", expected)
                    .put("segments", lastSegment + 1);
        } catch (Throwable t) {
            try {
                return out.put("ok", false).put("code", "verify_error")
                        .put("reason", String.valueOf(t)).put("break_line", lineNo);
            } catch (Throwable ignored) {
                return out;
            }
        }
    }

    // ==================== 导出 ====================

    /**
     * 导出。{@code meta.local_only=true} 的记录不进导出（任务书 K 项），墓碑保留
     * ——删掉墓碑等于让对端把这条当成"还在"。
     */
    public static synchronized JSONObject export() {
        JSONObject out = new JSONObject();
        try {
            ensureLayout();
            long ts = System.currentTimeMillis();
            File f = new File(DIR, "export-" + ts + ".jsonl");
            int written = 0;
            int localOnly = 0;
            StringBuilder sb = new StringBuilder();
            for (String role : new String[]{SELF, PEER}) {
                for (JSONObject o : readAll(role, 0, 0, Integer.MAX_VALUE).items) {
                    JSONObject meta = o.optJSONObject("meta");
                    if (meta != null && meta.optBoolean("local_only", false)) {
                        localOnly++;
                        continue;
                    }
                    sb.append(o.toString()).append('\n');
                    written++;
                }
            }
            writeAtomic(f, sb.toString());
            return out.put("ok", true).put("file", f.getAbsolutePath())
                    .put("bytes", f.length()).put("records", written)
                    .put("skipped_local_only", localOnly);
        } catch (Throwable t) {
            try {
                return out.put("ok", false).put("code", "export_error")
                        .put("reason", String.valueOf(t));
            } catch (Throwable ignored) {
                return out;
            }
        }
    }

    // ==================== 状态 ====================

    public static synchronized JSONObject status() {
        JSONObject out = new JSONObject();
        try {
            File dir = new File(DIR);
            JSONObject cursor = readCursor();
            JSONObject self = cursor.optJSONObject(SELF);
            JSONObject peer = cursor.optJSONObject(PEER);
            JSONObject selfChain = verify(SELF);
            JSONObject peerChain = verify(PEER);

            JSONObject seg = new JSONObject();
            File[] files = dir.listFiles();
            int segments = 0;
            long bytes = 0;
            if (files != null) {
                for (File f : files) {
                    if (f.isFile() && f.getName().endsWith(".jsonl")
                            && !f.getName().startsWith("export-")) {
                        segments++;
                        bytes += f.length();
                    }
                }
            }
            seg.put("files", segments).put("bytes", bytes);

            return out.put("ok", dir.isDirectory())
                    .put("dir", DIR)
                    .put("exists", dir.isDirectory())
                    .put("config", readConfig())
                    .put("self", self == null ? roleCursor(0, 0, 0, GENESIS) : self)
                    .put("peer", peer == null ? roleCursor(0, 0, 0, GENESIS) : peer)
                    .put("segments", seg)
                    .put("self_chain", selfChain)
                    .put("peer_chain", peerChain)
                    .put("redacted_total", redactedCount)
                    .put("malformed_total", malformedCount);
        } catch (Throwable t) {
            try {
                return out.put("ok", false).put("code", "status_error")
                        .put("reason", String.valueOf(t));
            } catch (Throwable ignored) {
                return out;
            }
        }
    }

    // ==================== 隐私 ====================

    /**
     * 来源级敏感判定。返回 null = 可写；否则返回一个**不含原文**的原因串。
     *
     * 只管两级里的第一级（来源不信任）：NEVER_SYNC_SOURCES 与 meta.sensitive。
     * 值级敏感不走这里——那条路是替换后写入，见 {@link #redact}。
     * 模式循环**不在**本方法里：值命中要被替换，不能被这条路整条拒掉
     * （2026-11-15 首跑就栽在这：redact 成了死代码，T9 拿到的是旧拒写行为）。
     *
     * 原因串里绝不能带匹配到的片段——那会把刚拒绝的内容原样写进日志和 status。
     */
    static String sensitiveReason(String content, JSONObject meta) {
        if (meta != null) {
            String source = meta.optString("source", "").trim().toLowerCase();
            if (!source.isEmpty() && NEVER_SYNC_SOURCES.contains(source)) {
                return "source:" + source;
            }
            if (meta.optBoolean("sensitive", false)) return "meta.sensitive";
        }
        return null;
    }

    // ==================== 哈希 ====================

    /**
     * 规范 JSON：键排序、无空格。两端对同一份记录必须算出同一串字节，
     * 否则链在跨端校验时必然误报。{@code org.json} 的 toString 不保证键序。
     */
    static String canonical(Object v) throws org.json.JSONException {
        if (v instanceof JSONObject) {
            JSONObject o = (JSONObject) v;
            List<String> keys = new ArrayList<>();
            Iterator<String> it = o.keys();
            while (it.hasNext()) keys.add(it.next());
            Collections.sort(keys);
            StringBuilder sb = new StringBuilder("{");
            for (int i = 0; i < keys.size(); i++) {
                if (i > 0) sb.append(',');
                String k = keys.get(i);
                sb.append(JSONObject.quote(k)).append(':').append(canonical(o.get(k)));
            }
            return sb.append('}').toString();
        }
        if (v instanceof JSONArray) {
            JSONArray arr = (JSONArray) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < arr.length(); i++) {
                if (i > 0) sb.append(',');
                sb.append(canonical(arr.get(i)));
            }
            return sb.append(']').toString();
        }
        if (v == null || v == JSONObject.NULL) return "null";
        if (v instanceof String) return JSONObject.quote((String) v);
        if (v instanceof Boolean || v instanceof Number) return v.toString();
        return JSONObject.quote(v.toString());
    }

    static String hashOf(JSONObject rec) {
        try {
            return sha256Hex(canonical(rec));
        } catch (Throwable t) {
            return "";
        }
    }

    static String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    // ==================== IO ====================

    static void appendBytes(File f, byte[] data) throws java.io.IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory()) parent.mkdirs();
        FileOutputStream fos = new FileOutputStream(f, true);
        try {
            fos.write(data);
            fos.flush();
        } finally {
            try {
                fos.close();
            } catch (Throwable ignored) {
            }
        }
    }

    static byte[] readBytes(File f) throws java.io.IOException {
        FileInputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            try {
                in.close();
            } catch (Throwable ignored) {
            }
        }
    }

    static String readText(File f) throws java.io.IOException {
        return new String(readBytes(f), StandardCharsets.UTF_8);
    }

    /** 先写临时文件再改名：半截的 config/cursor 比没有更糟。 */
    static boolean writeAtomic(File f, String text) {
        File tmp = new File(f.getAbsolutePath() + ".tmp");
        try {
            File parent = f.getParentFile();
            if (parent != null && !parent.isDirectory()) parent.mkdirs();
            FileOutputStream fos = new FileOutputStream(tmp, false);
            try {
                fos.write(text.getBytes(StandardCharsets.UTF_8));
                fos.flush();
            } finally {
                try {
                    fos.close();
                } catch (Throwable ignored) {
                }
            }
            return tmp.renameTo(f) || (f.delete() && tmp.renameTo(f));
        } catch (Throwable t) {
            Log.w(TAG, "writeAtomic 失败 " + f.getName() + ": " + t);
            try {
                tmp.delete();
            } catch (Throwable ignored) {
            }
            return false;
        }
    }
}
