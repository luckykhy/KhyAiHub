package com.khyos.khy_os_client.bridge;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * KhyConsole — the one local command channel.
 *
 * <p>WHAT THIS IS. Everything that wants to run a tool on this phone goes through
 * {@link #exec}: the console panel a human types into, and the interception loop
 * that reads commands out of Amoo's chat. They produce the SAME record, in the
 * SAME file, with the SAME three-way failure classification. That is the whole
 * point — before this, the two paths were separate and the loop's failures were
 * invisible to the user while the console's failures were invisible to the log.
 *
 * <p>THE THREE FAILURE CLASSES, kept apart on purpose:
 * <ul>
 *   <li>{@link #STATUS_INVALID_ARGS} — the command itself is malformed: bad JSON,
 *       missing tool, unknown argument, wrong type. Nothing was executed.</li>
 *   <li>{@link #STATUS_TOOL_UNAVAILABLE} — the command is well formed but cannot
 *       run here: unknown tool, or a UI tool while the accessibility service is
 *       off. Nothing was executed, and there is an actionable next step.</li>
 *   <li>{@link #STATUS_EXEC_ERROR} — the tool ran and failed. Its own error text
 *       is preserved verbatim.</li>
 * </ul>
 * Collapsing these into one "失败" is what made the old channel unusable: the
 * three need three different reactions from the user (fix the text / grant a
 * permission / read the error), and only the middle one is worth a button.
 *
 * <p>THE RECORD. Every execution — manual or from Amoo — appends one JSON line to
 * {@code /sdcard/bridge-amoobridge/console_history.jsonl}. Same file for both
 * sides, so the phone and the interception layer read one history rather than
 * two. A line is a complete, self-contained record: request, response, and how
 * it ended. Appending is the format because a crash mid-write costs one line
 * instead of the whole history.
 *
 * <p>Contract: never throws. Every failure comes back as a status on the result
 * object, because the caller is a UI thread on one side and a background loop on
 * the other, and both need a value either way.
 */
public final class KhyConsole {

    private KhyConsole() {
    }

    // ── origins ────────────────────────────────────────────────────────────

    /** A command a human typed into the console panel. */
    public static final String ORIGIN_MANUAL = "manual";
    /** A command the interception loop read out of Amoo's chat. */
    public static final String ORIGIN_AMOO = "amoo";

    /**
     * Logcat tag for every command this channel runs, whatever the origin.
     *
     * <p>WHY IT EXISTS. The class doc says the console's failures used to be
     * "invisible to the log" — that was the stated reason this channel was
     * unified — but no log call was ever written, so the tag the acceptance
     * script greps for ({@code logcat -s KHYCONSOLE}) had never emitted a
     * single line. A witness that cannot fire is worse than no witness: the
     * script's "no command executed, every PASS is a false positive" verdict
     * then accused a genuinely successful 21/21 run, while the false PASS it
     * was written to catch would have sailed straight through.
     *
     * <p>Logged from {@link #finish}, the single choke point every outcome
     * passes through (ok / invalid_args / tool_unavailable / exec_error), so
     * no return path can skip it.
     */
    public static final String LOG_TAG = "KHYCONSOLE";

    // ── statuses (the three failure classes plus success) ──────────────────

    public static final String STATUS_OK = "ok";
    /** The command is malformed. Nothing ran. */
    public static final String STATUS_INVALID_ARGS = "invalid_args";
    /** The command is fine but cannot run here. Nothing ran. */
    public static final String STATUS_TOOL_UNAVAILABLE = "tool_unavailable";
    /** The tool ran and failed. */
    public static final String STATUS_EXEC_ERROR = "exec_error";

    // ── files ──────────────────────────────────────────────────────────────

    /** The shared record. Same directory as the bridge mailbox and shared memory. */
    public static final String HISTORY_FILE = "console_history.jsonl";
    /** The user's saved shortcuts. */
    public static final String FAVORITES_FILE = "console_favorites.json";
    /** How many records the file keeps. Older lines are dropped from the front. */
    public static final int MAX_HISTORY = 200;

    /** Aliases the bridge has always accepted, folded onto their canonical name. */
    private static final String[][] ALIASES = {
            {"shell_exec", "exec"},
            {"file_read", "read"},
            {"file_write", "write"},
            {"file_list", "ls"},
            {"sys_info", "info"},
    };

    /** The whitelist: exactly the tools the bridge has. */
    private static final Set<String> WHITELIST = new HashSet<String>(Arrays.asList(Tools.NAMES));

    /** Monotonic counter, so two commands in the same millisecond still differ. */
    private static final AtomicLong COUNTER = new AtomicLong(0);

    // ── the channel ────────────────────────────────────────────────────────

    /**
     * A command that has been parsed and checked, but not run.
     *
     * Kept separate from the execution so that a caller which only needs to know
     * "can this run here?" (the interception loop, before it decides whether to
     * stop and ask the human) asks exactly the same question the console asks —
     * not a second, slightly different copy of it.
     */
    public static final class Prepared {
        public String tool = "";
        public JSONObject args = new JSONObject();
        public String status = STATUS_OK;
        public String error = "";
        public String hint = "";
        public String needsAuth = "";
        public boolean ok = true;

        void fail(String status, String error, String hint, String needsAuth) {
            this.ok = false;
            this.status = status;
            this.error = error;
            this.hint = hint;
            this.needsAuth = needsAuth;
        }
    }

    /**
     * Parse and check one command WITHOUT running it.
     *
     * The three failure classes are decided here, once, so that every caller
     * reports the same reason for the same command.
     */
    public static Prepared prepare(String raw) {
        Prepared p = new Prepared();
        String text = raw == null ? "" : raw.trim();
        if (text.length() == 0) {
            p.fail(STATUS_INVALID_ARGS, "参数不合法：命令为空",
                    "命令必须是一行 JSON：{\"tool\":\"<工具名>\",\"args\":{…}}", "");
            return p;
        }
        if (text.charAt(0) != '{') {
            p.fail(STATUS_INVALID_ARGS,
                    "参数不合法：命令必须是一个 JSON 对象（形如 {\"tool\":…,\"args\":{…}}）",
                    "命令必须是一行 JSON：{\"tool\":\"<工具名>\",\"args\":{…}}", "");
            return p;
        }
        JSONObject root;
        try {
            root = new JSONObject(text);
        } catch (Throwable bad) {
            p.fail(STATUS_INVALID_ARGS,
                    "参数不合法：不是合法的 JSON（" + bad.getClass().getSimpleName() + "）",
                    "命令必须是一行 JSON：{\"tool\":\"<工具名>\",\"args\":{…}}", "");
            return p;
        }

        // ── tool ──
        Object rawTool;
        try {
            rawTool = root.has("tool") ? root.get("tool") : null;
        } catch (Throwable ignored) {
            rawTool = null;
        }
        if (rawTool == null) {
            p.fail(STATUS_INVALID_ARGS, "参数不合法：缺少「tool」字段",
                    "命令形如 {\"tool\":\"ls\",\"args\":{\"path\":\"/sdcard\"}}", "");
            return p;
        }
        if (!(rawTool instanceof String)) {
            p.fail(STATUS_INVALID_ARGS, "参数不合法：「tool」必须是字符串",
                    "命令形如 {\"tool\":\"ls\",\"args\":{\"path\":\"/sdcard\"}}", "");
            return p;
        }
        String tool = ((String) rawTool).trim();
        if (tool.length() == 0) {
            p.fail(STATUS_INVALID_ARGS, "参数不合法：「tool」为空",
                    "命令形如 {\"tool\":\"ls\",\"args\":{\"path\":\"/sdcard\"}}", "");
            return p;
        }
        String canonical = canonical(tool);
        p.tool = canonical;

        // ── args ──
        JSONObject args;
        try {
            if (root.has("args")) {
                Object rawArgs = root.get("args");
                if (rawArgs == null || rawArgs == JSONObject.NULL) {
                    args = new JSONObject();
                } else if (rawArgs instanceof JSONObject) {
                    args = (JSONObject) rawArgs;
                } else {
                    p.fail(STATUS_INVALID_ARGS, "参数不合法：「args」必须是对象",
                            "例：{\"tool\":\"ls\",\"args\":{\"path\":\"/sdcard\"}}", "");
                    return p;
                }
            } else {
                args = new JSONObject();
            }
        } catch (Throwable ignored) {
            args = new JSONObject();
        }
        p.args = args;

        // ── whitelist ──
        if (!WHITELIST.contains(canonical)) {
            p.fail(STATUS_TOOL_UNAVAILABLE, "工具不可用：未知工具「" + tool + "」",
                    "可用工具：" + join(new ArrayList<String>(WHITELIST)), "");
            return p;
        }

        // ── schema ──
        String schemaError = ToolSchema.validate(canonical, args);
        if (schemaError != null) {
            p.fail(STATUS_INVALID_ARGS, "参数不合法：" + schemaError,
                    ToolSchema.get(canonical) == null ? "" : ToolSchema.get(canonical).desc, "");
            return p;
        }

        // ── capability gate: accessibility ──
        // Only the UI tools are gated. Everything else keeps working without it —
        // a missing accessibility service must not take the console down with it.
        if (ToolSchema.needsAccessibility(canonical) && !accessibilityReady()) {
            p.fail(STATUS_TOOL_UNAVAILABLE,
                    "工具不可用：未授权无障碍服务，" + canonical + " 无法执行",
                    "在系统设置 > 无障碍中启用「khy-os」后即可使用；其余能力不受影响",
                    "accessibility");
            return p;
        }
        return p;
    }

    /**
     * Check a command without running it.
     *
     * @return {@code {"ok":…,"status":…,"error":…,"hint":…,"needs_auth":…,
     *         "tool":…,"args":{…}}} — the same classification the console shows.
     */
    public static JSONObject validateOnly(String raw) {
        Prepared p = prepare(raw);
        JSONObject out = new JSONObject();
        try {
            out.put("ok", p.ok);
            out.put("status", p.status);
            out.put("error_class", p.ok ? "" : p.status);
            out.put("error", p.error);
            out.put("hint", p.hint);
            out.put("needs_auth", p.needsAuth);
            out.put("tool", p.tool);
            out.put("args", p.args);
        } catch (Throwable ignored) {
        }
        return out;
    }

    /**
     * Parse, validate, execute and record one command — the one entry point for
     * actually RUNNING something.
     *
     * <p>It is a wrapper around {@link #execInner} so that the logcat witness
     * fires for executions ONLY. Logging inside {@link #finish} would have been
     * one line instead of two methods, but {@code finish} is also reached from
     * {@link #validateOnly} — a pure validation that runs nothing. A witness
     * that fires on validation cannot tell "executed" from "merely parsed", so
     * the acceptance check {@code logcat -s KHYCONSOLE} would pass on a run
     * where nothing executed: exactly the false PASS it exists to catch.
     *
     * @param origin {@link #ORIGIN_MANUAL} or {@link #ORIGIN_AMOO}; the origin is
     *               recorded, and it is what makes the two paths comparable.
     * @param raw    the single-line JSON text: {@code {"tool":…,"args":{…}}}
     * @return never null. The result carries {@code status}, {@code error_class},
     *         {@code tool}, {@code args}, {@code result} and the record id.
     */
    public static JSONObject exec(String origin, String raw) {
        JSONObject out = execInner(origin, raw);
        Log.i(LOG_TAG, "origin=" + out.optString("origin")
                + " tool=" + out.optString("tool")
                + " status=" + out.optString("status")
                + " id=" + out.optString("id"));
        return out;
    }

    private static JSONObject execInner(String origin, String raw) {
        final String src = origin == null ? ORIGIN_MANUAL : origin;
        JSONObject out = new JSONObject();
        final String id = "c-" + System.currentTimeMillis() + "-" + COUNTER.getAndIncrement();
        try {
            out.put("id", id);
            out.put("ts", System.currentTimeMillis());
            out.put("origin", src);
            out.put("raw", raw == null ? "" : raw);
        } catch (Throwable ignored) {
        }

        Prepared p = prepare(raw);
        if (!p.ok) {
            return finish(out, src, id, p.tool, p.args, p.status, p.error, p.hint, p.needsAuth, null);
        }
        final String canonical = p.tool;
        final JSONObject args = p.args;

        // ── execute ──
        JSONObject result;
        try {
            result = Tools.dispatch(canonical, args);
        } catch (Throwable bad) {
            return finish(out, src, id, canonical, args, STATUS_EXEC_ERROR,
                    "执行报错：" + bad.getClass().getSimpleName()
                            + (bad.getMessage() == null ? "" : "：" + bad.getMessage()),
                    "", "", null);
        }
        boolean ok = result != null && result.optBoolean("ok", false);
        if (!ok) {
            // 工具自己给了 error 就用它的；没给就用退出码/stderr 拼一句。
            // 退成「未知错误」是偷懒：exec 失败时 ok:false 但只有 err/exit，
            // 那句「未知」会把明明写在那里的原因盖掉——而原因才是用户要看的。
            String err = result == null ? "" : result.optString("error", "");
            if (err.trim().length() == 0) {
                err = describeFailureWithoutErrorField(canonical, result);
            }
            if (err.trim().length() == 0) {
                err = "工具没有返回结果";
            }
            return finish(out, src, id, canonical, args, STATUS_EXEC_ERROR,
                    "执行报错：" + err, "", "", result);
        }

        // The elevation caveat travels WITH the result. An exec that ran as the
        // app's own uid cannot really do input/am/pm — saying "ok" without
        // saying that would be a lie told by omission.
        String note = "";
        try {
            String via = result.optString("via", "");
            if ("exec".equals(canonical) && "app".equals(via)) {
                note = "以 App 身份运行（未提权）：input / am / pm / cmd / settings 等命令"
                        + "会因权限不足而无操作，不能当作系统级执行结果。";
            }
        } catch (Throwable ignored) {
        }
        return finish(out, src, id, canonical, args, STATUS_OK, "", "", "", result, note);
    }

    /**
     * A sentence describing a failure whose result carried no {@code error} field.
     *
     * exec is the case that matters: it returns {@code ok:false} with only
     * {@code exit} and {@code err}, and reporting "未知错误" there would hide the
     * one thing the user needs — why the command did not run.
     *
     * @return "" when nothing usable is present, so the caller can fall back.
     */
    private static String describeFailureWithoutErrorField(String tool, JSONObject result) {
        if (result == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        if (result.has("exit")) {
            sb.append("退出码 ").append(result.opt("exit"));
        }
        String err = result.optString("err", "");
        if (err.trim().length() > 0) {
            if (sb.length() > 0) {
                sb.append("，");
            }
            String oneLine = err.trim().replace('\n', ' ');
            sb.append(oneLine.length() > 200 ? oneLine.substring(0, 200) + "…" : oneLine);
        }
        return sb.toString();
    }

    /** Fold an alias onto its canonical tool name. */
    public static String canonical(String tool) {        if (tool == null) {
            return "";
        }
        String t = tool.trim().toLowerCase(java.util.Locale.ROOT);
        for (String[] a : ALIASES) {
            if (a[0].equals(t)) {
                return a[1];
            }
        }
        return t;
    }

    /** The whitelist, for the tool panel. */
    public static List<String> whitelist() {
        return new ArrayList<String>(WHITELIST);
    }

    /**
     * Whether the accessibility service is up.
     *
     * Wrapped because the check reaches into an Android service, and the pure
     * validation path has to stay runnable on a plain JVM (the unit tests
     * prove the classification without a phone attached). A check that throws
     * is a check that failed, and "failed" means "not authorized" — the
     * conservative direction.
     */
    static boolean accessibilityReady() {
        try {
            return Tools.uiReady();
        } catch (Throwable bad) {
            return false;
        }
    }

    /**
     * The catalogue plus the per-tool availability flags the tool panel needs.
     *
     * A UI tool is greyed out while the accessibility service is off — but only
     * that tool. Everything else stays usable, so the panel must say which is
     * which instead of greying out the whole thing.
     */
    public static JSONObject describeTools() {
        JSONObject d = ToolSchema.describe();
        try {
            boolean a11y = accessibilityReady();
            JSONArray arr = d.optJSONArray("tools");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o == null) {
                        continue;
                    }
                    String name = o.optString("name", "");
                    boolean needs = ToolSchema.needsAccessibility(name);
                    o.put("needs_a11y", needs);
                    o.put("available", !needs || a11y);
                }
            }
            d.put("a11y_ready", a11y);
            d.put("count", arr == null ? 0 : arr.length());
        } catch (Throwable ignored) {
        }
        return d;
    }

    // ── 令牌重置 ────────────────────────────────────────────────────────────

    /**
     * 重置桥的访问令牌：旧值立即失效，新值铸成并尝试落盘。
     *
     * <p>为什么这是一个控制台动作而不是又一个工具：工具表（{@link Tools#NAMES}）
     * 是给 PC 与 Amoo 调的，经 HTTP /call 与文件信箱两条通道进来；而重置令牌
     * 改变的正是这两条通道的准入本身。把它做成工具，等于让一条能被远程驱动的
     * 通道去换掉自己的钥匙——PC 上一个畸形请求就能把协作双方踢出线。只有本机
     * 人工从控制台面板触发，才说得上是「用户决定的轮换」。
     *
     * <p>回执只带新旧指纹（前 8 位 + 生效时间戳），不写全文，也不进
     * console_history——那份历史是共享的，PC 侧读得到。落盘失败时
     * {@code persisted:false} 必须原样送到界面：那时的真相是「新令牌只在手机
     * 内存里，PC 侧拿到的还是盘上的旧值，会持续 401」。
     */
    public static JSONObject resetToken() {
        return HttpBridge.resetToken();
    }

    // ── the record ─────────────────────────────────────────────────────────

    /**
     * Assemble the result and append it to the shared history.
     *
     * The append happens for EVERY outcome, including the ones that never
     * executed: a rejected command is exactly the thing somebody needs to see
     * afterwards.
     */
    private static JSONObject finish(JSONObject out, String origin, String id, String tool,
                                     JSONObject args, String status, String error,
                                     String hint, String needsAuth, JSONObject result) {
        return finish(out, origin, id, tool, args, status, error, hint, needsAuth, result, "");
    }

    private static JSONObject finish(JSONObject out, String origin, String id, String tool,
                                     JSONObject args, String status, String error,
                                     String hint, String needsAuth, JSONObject result,
                                     String note) {
        try {
            out.put("ok", STATUS_OK.equals(status));
            out.put("status", status);
            out.put("error_class", STATUS_OK.equals(status) ? "" : status);
            out.put("error", error == null ? "" : error);
            out.put("hint", hint == null ? "" : hint);
            out.put("needs_auth", needsAuth == null ? "" : needsAuth);
            out.put("tool", tool == null ? "" : tool);
            out.put("args", args == null ? new JSONObject() : args);
            out.put("result", result == null ? new JSONObject() : result);
            out.put("capability_note", note == null ? "" : note);
        } catch (Throwable ignored) {
        }
        record(out, origin);
        return out;
    }

    /** One JSON line per execution. Same file for manual and Amoo commands. */
    private static void record(JSONObject entry, String origin) {
        try {
            JSONObject line = new JSONObject();
            line.put("ts", entry.optLong("ts", System.currentTimeMillis()));
            line.put("id", entry.optString("id", ""));
            line.put("origin", origin == null ? ORIGIN_MANUAL : origin);
            line.put("tool", entry.optString("tool", ""));
            // The request text is kept verbatim: a record without the exact
            // command that produced it cannot be reproduced.
            line.put("raw", entry.optString("raw", ""));
            line.put("args", entry.opt("args") == null ? new JSONObject() : entry.opt("args"));
            line.put("status", entry.optString("status", STATUS_OK));
            line.put("error", entry.optString("error", ""));
            line.put("hint", entry.optString("hint", ""));
            line.put("needs_auth", entry.optString("needs_auth", ""));
            line.put("capability_note", entry.optString("capability_note", ""));
            line.put("result", entry.opt("result") == null ? new JSONObject() : entry.opt("result"));
            appendLine(line.toString());
        } catch (Throwable ignored) {
        }
    }

    /** Append one line and trim the file back to {@link #MAX_HISTORY} lines. */
    private static void appendLine(String line) {
        File f = historyFile();
        File parent = f.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }
        try {
            Writer w = new OutputStreamWriter(new FileOutputStream(f, true), "UTF-8");
            try {
                w.write(line);
                w.write("\n");
                w.flush();
            } finally {
                w.close();
            }
        } catch (Throwable ignored) {
            return;
        }
        trim();
    }

    /** Keep the newest MAX_HISTORY lines; drop the rest from the front. */
    private static void trim() {
        File f = historyFile();
        List<String> lines = readLines(f);
        if (lines.size() <= MAX_HISTORY) {
            return;
        }
        List<String> keep = lines.subList(lines.size() - MAX_HISTORY, lines.size());
        try {
            Writer w = new OutputStreamWriter(new FileOutputStream(f, false), "UTF-8");
            try {
                for (String l : keep) {
                    w.write(l);
                    w.write("\n");
                }
                w.flush();
            } finally {
                w.close();
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * Read the shared history, newest first.
     *
     * @return {@code {"ok":true,"entries":[…],"path":"…","shared":true}}
     */
    public static JSONObject history(int limit) {
        JSONObject out = new JSONObject();
        try {
            int cap = limit <= 0 ? MAX_HISTORY : Math.min(limit, MAX_HISTORY);
            List<String> lines = readLines(historyFile());
            JSONArray arr = new JSONArray();
            for (int i = lines.size() - 1; i >= 0 && arr.length() < cap; i--) {
                try {
                    arr.put(new JSONObject(lines.get(i)));
                } catch (Throwable ignored) {
                }
            }
            out.put("ok", true);
            out.put("entries", arr);
            out.put("path", historyFile().getAbsolutePath());
            out.put("shared", isShared());
        } catch (Throwable ignored) {
        }
        return out;
    }

    /** Delete the shared history. */
    public static JSONObject clearHistory() {
        JSONObject out = new JSONObject();
        try {
            File f = historyFile();
            boolean ok = !f.exists() || f.delete();
            out.put("ok", ok);
            out.put("path", f.getAbsolutePath());
        } catch (Throwable ignored) {
            // The catch body itself may throw the checked JSONException, so the
            // failure field is set through the same swallow-once helper.
            putQuietly(out, "ok", false);
        }
        return out;
    }

    /**
     * Export the history to a file.
     *
     * @param path where to write; null picks the console's own directory.
     */
    public static JSONObject export(String path) {
        JSONObject out = new JSONObject();
        try {
            File src = historyFile();
            String target = path;
            if (target == null || target.trim().length() == 0) {
                // S5：导出落点是 App 自己的目录，不是 /sdcard/Download。
                // 会话导出物不是交付物，不该堆进 install_apk 的白名单根——
                // 那里杂物越多，真正要装的包越容易被拿错（2026-11-18 实测
                // Download 里躺着 4 个 console-*.jsonl）。
                File dir = baseDir();
                target = new File(dir, "khy-os-console-"
                        + System.currentTimeMillis() + ".jsonl").getAbsolutePath();
            }
            File dst = new File(target);
            File parent = dst.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            List<String> lines = readLines(src);
            Writer w = new OutputStreamWriter(new FileOutputStream(dst, false), "UTF-8");
            try {
                for (String l : lines) {
                    w.write(l);
                    w.write("\n");
                }
                w.flush();
            } finally {
                w.close();
            }
            out.put("ok", true);
            out.put("path", dst.getAbsolutePath());
            out.put("lines", lines.size());
            out.put("bytes", dst.length());
        } catch (Throwable bad) {
            try {
                out.put("ok", false);
                out.put("error", bad.getClass().getSimpleName() + ": " + bad.getMessage());
            } catch (Throwable ignored) {
            }
        }
        return out;
    }

    // ── shortcuts (常用指令) ───────────────────────────────────────────────

    /** The saved shortcuts. */
    public static JSONObject favorites() {
        JSONObject out = new JSONObject();
        try {
            File f = new File(baseDir(), FAVORITES_FILE);
            List<String> lines = readLines(f);
            JSONArray arr = new JSONArray();
            if (!lines.isEmpty()) {
                try {
                    JSONObject root = new JSONObject(lines.get(0));
                    JSONArray items = root.optJSONArray("items");
                    if (items != null) {
                        arr = items;
                    }
                } catch (Throwable ignored) {
                }
            }
            out.put("ok", true);
            out.put("items", arr);
            out.put("path", f.getAbsolutePath());
        } catch (Throwable ignored) {
        }
        return out;
    }

    /**
     * Save one command as a shortcut.
     *
     * @param label a human name for it; empty falls back to the tool name.
     */
    public static JSONObject addFavorite(String label, String json) {
        JSONObject out = new JSONObject();
        try {
            String body = json == null ? "" : json.trim();
            if (body.length() == 0) {
                out.put("ok", false);
                out.put("error", "命令为空");
                return out;
            }
            // A shortcut that cannot run is a trap: store what the console
            // accepts, not what the user hoped would work.
            //
            // CHECK ONLY — never execute. Running the command to see whether it
            // works would mean that saving a shortcut deletes the files it
            // names, launches the app it names, and so on. Validation is the
            // only thing that may happen here.
            Prepared probe = prepare(body);
            if (!probe.ok) {
                out.put("ok", false);
                out.put("error", probe.error);
                return out;
            }
            JSONArray items = favorites().optJSONArray("items");
            if (items == null) {
                items = new JSONArray();
            }
            String name = label == null || label.trim().length() == 0
                    ? probe.tool : label.trim();
            JSONObject item = new JSONObject();
            item.put("id", "f-" + System.currentTimeMillis());
            item.put("label", name);
            item.put("json", body);
            item.put("tool", probe.tool);
            item.put("created_at", System.currentTimeMillis());
            items.put(item);
            writeFavorites(items);
            out.put("ok", true);
            out.put("item", item);
        } catch (Throwable bad) {
            try {
                out.put("ok", false);
                out.put("error", bad.getClass().getSimpleName() + ": " + bad.getMessage());
            } catch (Throwable ignored) {
            }
        }
        return out;
    }

    /** Remove one shortcut by id. */
    public static JSONObject removeFavorite(String id) {
        JSONObject out = new JSONObject();
        try {
            JSONArray items = favorites().optJSONArray("items");
            JSONArray next = new JSONArray();
            boolean found = false;
            if (items != null) {
                for (int i = 0; i < items.length(); i++) {
                    JSONObject o = items.optJSONObject(i);
                    if (o != null && id != null && id.equals(o.optString("id", ""))) {
                        found = true;
                        continue;
                    }
                    next.put(o == null ? new JSONObject() : o);
                }
            }
            writeFavorites(next);
            out.put("ok", found);
        } catch (Throwable ignored) {
            putQuietly(out, "ok", false);
        }
        return out;
    }

    private static void writeFavorites(JSONArray items) throws Exception {
        File f = new File(baseDir(), FAVORITES_FILE);
        File parent = f.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }
        Writer w = new OutputStreamWriter(new FileOutputStream(f, false), "UTF-8");
        try {
            w.write(new JSONObject().put("version", 1).put("items", items).toString());
            w.flush();
        } finally {
            w.close();
        }
    }

    // ── context for the Amoo round trip ────────────────────────────────────

    /**
     * The most recent record, rendered as one short block of text.
     *
     * Used when the console asks Amoo something: without it, Amoo has to be told
     * the whole situation again in every prompt, and the user ends up describing
     * the same command twice.
     */
    public static String lastContext(int maxChars) {
        try {
            JSONArray entries = history(1).optJSONArray("entries");
            if (entries == null || entries.length() == 0) {
                return "";
            }
            JSONObject e = entries.optJSONObject(0);
            if (e == null) {
                return "";
            }
            StringBuilder sb = new StringBuilder();
            sb.append("我们刚在 khy-os 本地执行了一条命令：")
                    .append(e.optString("tool", "")).append('\n');
            sb.append("参数：").append(String.valueOf(e.opt("args"))).append('\n');
            String status = e.optString("status", "");
            sb.append("结果：").append(STATUS_OK.equals(status) ? "执行成功" : status)
                    .append("  ").append(String.valueOf(e.opt("result"))).append('\n');
            String text = sb.toString();
            int cap = maxChars <= 0 ? 800 : maxChars;
            return text.length() <= cap ? text : text.substring(0, cap);
        } catch (Throwable ignored) {
            return "";
        }
    }

    // ── storage ────────────────────────────────────────────────────────────

    /**
     * Where the shared files live.
     *
     * The bridge directory on /sdcard is the shared one — the interception layer
     * and the PC side read it. When the app has no all-files access yet, the
     * console still works, but it falls back to the app's private directory and
     * says so, because "the two sides share one storage" is then not true and
     * the user must be able to see that.
     */
    public static File baseDir() {
        Context c = Tools.ctxRef();
        File shared = new File(BridgeService.BRIDGE_DIR);
        if (c != null) {
            if (!shared.exists()) {
                shared.mkdirs();
            }
            if (shared.exists() && shared.canWrite()) {
                return shared;
            }
            File internal = new File(c.getFilesDir(), "console");
            if (!internal.exists()) {
                internal.mkdirs();
            }
            return internal;
        }
        // No Android context at all — a plain JVM (unit tests, or the class used
        // before Tools.init). /sdcard does not exist there, so fall back to the
        // system temp directory rather than writing nowhere.
        if (shared.exists() && shared.canWrite()) {
            return shared;
        }
        File tmp = new File(System.getProperty("java.io.tmpdir", "/tmp"), "khy-console");
        if (!tmp.exists()) {
            tmp.mkdirs();
        }
        return tmp;
    }

    /** Whether the shared (visible to the other side) location is in use. */
    public static boolean isShared() {
        return baseDir().getAbsolutePath().equals(new File(BridgeService.BRIDGE_DIR).getAbsolutePath());
    }

    /** Where the history file lives, for tests and for the UI to display. */
    static File historyFile() {
        return new File(baseDir(), HISTORY_FILE);
    }

    /** Read a file into lines. Never throws; a missing file yields an empty list. */
    private static List<String> readLines(File f) {
        List<String> out = new ArrayList<String>();
        if (f == null || !f.exists()) {
            return out;
        }
        BufferedReader r = null;
        try {
            r = new BufferedReader(new InputStreamReader(new FileInputStream(f), "UTF-8"));
            String line;
            while ((line = r.readLine()) != null) {
                if (line.trim().length() > 0) {
                    out.add(line);
                }
            }
        } catch (Throwable ignored) {
        } finally {
            try {
                if (r != null) {
                    r.close();
                }
            } catch (Throwable ignored) {
            }
        }
        return out;
    }

    /**
     * Put a value, swallowing the checked JSONException.
     *
     * Only for the "we are already in a failure path" case, where throwing again
     * would lose the fact that something went wrong.
     */
    private static void putQuietly(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (Throwable ignored) {
        }
    }

    private static String join(List<String> names) {
        if (names.isEmpty()) {
            return "（无）";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < names.size(); i++) {
            if (i > 0) {
                sb.append("、");
            }
            sb.append(names.get(i));
        }
        return sb.toString();
    }
}
