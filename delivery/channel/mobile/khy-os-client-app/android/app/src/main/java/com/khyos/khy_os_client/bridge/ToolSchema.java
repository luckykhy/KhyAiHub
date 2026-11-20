package com.khyos.khy_os_client.bridge;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The console's tool catalogue: which tools exist and what arguments each one takes.
 *
 * <p>WHY a schema at all. Before this existed the bridge accepted whatever arguments
 * arrived and let the tool itself decide: {@code read} with a missing {@code path}
 * threw a {@code FileNotFoundException} deep inside, {@code ui_tap} without
 * coordinates returned "gesture cancelled", and both looked like "the tool failed".
 * That collapses three very different situations into one word, and the user cannot
 * tell "you typed it wrong" from "the device refused" from "the tool crashed".
 *
 * <p>So the console validates BEFORE dispatching, and the failure is reported with
 * the field that is wrong. A schema here is therefore not documentation — it is the
 * thing that lets the console say "参数不合法：缺少参数「path」" instead of "失败".
 *
 * <p>WHY descriptions come from {@link Tools#CATALOG} rather than being written out
 * again here. The catalogue is the bridge's own list, and it is what the {@code tools}
 * tool returns to callers. Copying the sentences into a second array guarantees the
 * two drift, and the direction they drift in is "the console describes a tool the
 * bridge no longer has". So this class holds only the part the catalogue does NOT
 * carry: the argument contract.
 *
 * <p>WHY {@link Spec#strict} exists. Rejecting an unknown argument is only safe when
 * the full argument set of that tool is known. Where it is known — verified against
 * the implementation — the check is worth a lot: it catches {@code {"path":"/a",
 * "psth":"/b"}}, which would otherwise look like it worked while doing the wrong
 * thing. Where it is not known, guessing the set would falsely reject commands that
 * are perfectly valid, and a falsely rejected command is worse than an unvalidated
 * one. So the strict check is opt-in per tool, and everything else still gets its
 * required-argument check.
 *
 * <p>Contract: pure, deterministic, never throws. Zero IO — the file side lives in
 * {@link KhyConsole}.
 */
public final class ToolSchema {

    private ToolSchema() {
    }

    /** One tool's contract. */
    public static final class Spec {
        public final String tool;
        public final String desc;
        public final String group;
        /** Required arguments as {name, type} pairs. */
        public final String[][] required;
        /** Optional arguments as {name, type} pairs. */
        public final String[][] optional;
        /**
         * A group of which at least one must be present ("text" or "id").
         * Empty when the tool has no such requirement.
         */
        public final String[] oneOf;
        /**
         * Whether an argument outside {@link #knownArgs()} is rejected.
         *
         * True only where the tool's full argument set was verified against the
         * implementation — see the class javadoc.
         */
        public final boolean strict;

        Spec(String tool, String desc, String group, String[][] required,
             String[][] optional, String[] oneOf, boolean strict) {
            this.tool = tool;
            this.desc = desc == null ? "" : desc;
            this.group = group == null ? "" : group;
            this.required = required == null ? new String[0][] : required;
            this.optional = optional == null ? new String[0][] : optional;
            this.oneOf = oneOf == null ? new String[0] : oneOf;
            this.strict = strict;
        }

        /** Every argument name this tool accepts. */
        public List<String> knownArgs() {
            List<String> out = new ArrayList<String>();
            for (String[] r : required) {
                out.add(r[0]);
            }
            for (String[] o : optional) {
                out.add(o[0]);
            }
            for (String o : oneOf) {
                if (!out.contains(o)) {
                    out.add(o);
                }
            }
            return out;
        }

        /**
         * Type of one argument, or "any" when it is not constrained.
         *
         * Required arguments carry a type too, and this is load-bearing rather
         * than decorative: without it {@code {"tool":"exec","args":{"cmd":42}}}
         * passes the shape check and only fails deep inside the tool as
         * "empty cmd" — which the user reads as 执行报错 when the real problem
         * is that they passed a number where a string belongs.
         */
        public String typeOf(String name) {
            for (String[] r : required) {
                if (r[0].equals(name)) {
                    return r[1];
                }
            }
            for (String[] o : optional) {
                if (o[0].equals(name)) {
                    return o[1];
                }
            }
            return "any";
        }
    }

    // ── the contracts ──────────────────────────────────────────────────────
    //
    // strict=true 的每一行都是对着 Tools.java 的实现逐字核对过的；没核对过的
    // 一律 strict=false（仍查必填，不查未知参数）。

    private static final Map<String, Spec> SPECS = new LinkedHashMap<String, Spec>();

    private static void put(String tool, String[][] required, String[][] optional,
                            String[] oneOf, boolean strict) {
        SPECS.put(tool, new Spec(tool, descOf(tool), groupOf(tool), required, optional, oneOf, strict));
    }

    /** Group straight from the bridge's own catalogue. */
    private static String groupOf(String tool) {
        for (String[] row : Tools.CATALOG) {
            if (row.length >= 2 && row[1].equals(tool)) {
                return row[0];
            }
        }
        return "";
    }

    /** One-line description straight from the bridge's own catalogue. */
    private static String descOf(String tool) {
        for (String[] row : Tools.CATALOG) {
            if (row.length >= 3 && row[1].equals(tool)) {
                return row[2];
            }
        }
        return "";
    }

    static {
        // ── 基础 ──
        put("ping", null, null, null, true);
        put("info", null, null, null, true);
        put("tools", null, null, null, true);
        // 提权自举：op 选动作（status/pair/raise/on/off），code 只在 pair 时用。
        put("elevate", new String[][]{{"op", "string"}},
                new String[][]{{"code", "string"}, {"endpoint", "string"}}, null, true);

        // ── 文件 ──
        put("ls", null, new String[][]{{"path", "string"}}, null, true);
        put("read", new String[][]{{"path", "string"}},
                new String[][]{{"max", "number"}}, null, true);
        put("write", new String[][]{{"path", "string"}},
                new String[][]{{"content", "string"}, {"append", "bool"}}, null, true);
        put("mkdir", new String[][]{{"path", "string"}}, null, null, true);
        put("rm", new String[][]{{"path", "string"}},
                new String[][]{{"recursive", "bool"}}, null, true);
        put("mv", new String[][]{{"path", "string"}, {"dest", "string"}}, null, null, true);
        put("cp", new String[][]{{"path", "string"}, {"dest", "string"}}, null, null, false);
        put("stat", new String[][]{{"path", "string"}}, null, null, true);
        put("zip", new String[][]{{"path", "string"}, {"out", "string"}}, null, null, true);
        put("unzip", new String[][]{{"path", "string"}, {"dest", "string"}}, null, null, true);

        // ── 凭据投递 ──
        // 这四个不回凭据内容：secret_list 只给名字/时间/长度，secret_put 只给长度。
        // 写入与删除都要 secret_code 发到通知栏的那枚一次性码，所以 Console 暴露
        // 它们不构成一条能读出密钥的通道——R2 的红线在工具自己那侧就已经守住了。
        put("secret_code", null, null, null, true);
        put("secret_put", new String[][]{{"name", "string"}, {"value", "string"},
                {"code", "string"}}, null, null, true);
        put("secret_list", null, null, null, true);
        put("secret_del", new String[][]{{"name", "string"}, {"code", "string"}},
                null, null, true);

        // ── 共享层（断点三）──
        // 这里是 dispatch 之外的第二道门：Console 入口先过 ToolSchema 再进 dispatch，
        // 漏登记的表现是「未知工具」而不是「没实现」——两者看起来都是"调不了"，
        // 但前者会让 T9-T11 全部判成 fail，所以这张表必须与 Tools.NAMES 同步。
        // sync_append 的 meta 是 object：local_only 与 source 都放在里面。
        put("sync_status", null, null, null, true);
        put("sync_append", new String[][]{{"content", "string"}},
                new String[][]{{"session_id", "string"}, {"role", "string"},
                        {"meta", "object"}}, null, true);
        put("sync_read", null,
                new String[][]{{"role", "string"}, {"since_cursor", "bool"},
                        {"since_offset", "number"}, {"limit", "number"}}, null, true);
        put("sync_delete", new String[][]{{"id", "string"}}, null, null, true);
        put("sync_verify", null, new String[][]{{"role", "string"}}, null, true);
        put("sync_export", null, null, null, true);

        // ── 抓包改写（断点五）──
        // 这里只声明参数形状；「能不能开」由 dispatch 的调试菜单门判。
        // 两件事分开是因为形状错和权限不足要报不同的错：前者调用方自己能改，
        // 后者只有人能在手机上改。
        put("net_capture_start", null, new String[][]{{"ttl_ms", "number"}, {"tls", "bool"}},
                null, true);
        put("net_capture_stop", null, null, null, true);
        put("net_capture_status", null, null, null, true);
        put("net_capture_list", null,
                new String[][]{{"since_seq", "number"}, {"limit", "number"}}, null, true);
        put("net_capture_export", null, null, null, true);
        // 四个规则操作是四个独立工具（2026-11-17 拆分）：op 由工具名决定，调用方
        // 不再需要猜 op/action 两个字段。host 只在 set 时是业务必填，但那属于
        // setRule 的校验（bad_host 有专门回执），Schema 这层只保证形状——
        // 两个错误码指向不同的修法。
        put("net_rule_set", null,
                new String[][]{{"action", "string"}, {"host", "string"},
                        {"method", "string"}, {"path", "string"}, {"status", "number"},
                        {"body", "string"}, {"header", "string"}, {"value", "string"},
                        {"ttl_ms", "number"}}, null, true);
        put("net_rule_list", null, null, null, true);
        put("net_rule_delete", new String[][]{{"id", "string"}}, null, null, true);
        put("net_rule_clear", null, null, null, true);

        // ── 执行 ──
        put("exec", new String[][]{{"cmd", "string"}},
                new String[][]{{"timeout", "number"}}, null, true);

        // ── 应用与系统 ──
        put("start_app", null,
                new String[][]{{"package", "string"}, {"component", "string"},
                        {"action", "string"}, {"uri", "string"}},
                new String[]{"package", "component"}, false);
        put("open_url", new String[][]{{"url", "string"}}, null, null, true);
        put("share_text", new String[][]{{"text", "string"}},
                new String[][]{{"title", "string"}}, null, true);
        put("clipboard", null, new String[][]{{"op", "string"}, {"text", "string"}},
                null, true);
        put("toast", new String[][]{{"text", "string"}}, null, null, true);
        put("notify", null, new String[][]{{"title", "string"}, {"text", "string"}},
                null, true);
        put("list_apps", null, null, null, true);
        put("battery", null, null, null, true);
        put("volume", null, new String[][]{{"level", "number"}}, null, true);
        put("brightness", null, new String[][]{{"value", "number"}}, null, true);
        put("vibrate", null, new String[][]{{"ms", "number"}}, null, true);
        put("adou_signin", null, new String[][]{{"op", "string"}}, null, false);
        put("record_audio", null, new String[][]{{"seconds", "number"},
                {"name", "string"}}, null, true);
        put("camera_open", null, new String[][]{{"mode", "string"},
                {"name", "string"}}, null, true);

        // ── 循环与反代 ──
        put("loop_start", null, new String[][]{{"mode", "string"},
                {"max_rounds", "number"}, {"deadline_ms", "number"},
                {"poll_ms", "number"}, {"inject_memory", "bool"}}, null, false);
        put("loop_stop", null, null, null, true);
        put("loop_status", null, null, null, true);
        put("amoo_ask", new String[][]{{"prompt", "string"}},
                new String[][]{{"timeout_ms", "number"}}, null, true);
        put("amoo_result", null, null, null, true);
        put("amoo_stop", null, null, null, true);
        put("amoo_memory", null, new String[][]{{"op", "string"}, {"id", "string"},
                {"text", "string"}, {"verified", "bool"},
                {"provenance", "string"}}, null, true);

        // ── 界面与截图（需要无障碍） ──
        put("ui_dump", null, new String[][]{{"max_nodes", "number"}}, null, false);
        put("ui_tap", new String[][]{{"x", "number"}, {"y", "number"}}, null, null, false);
        put("ui_click", null, new String[][]{{"text", "string"}, {"id", "string"}},
                new String[]{"text", "id"}, false);
        put("ui_swipe", new String[][]{{"x1", "number"}, {"y1", "number"},
                {"x2", "number"}, {"y2", "number"}},
                new String[][]{{"ms", "number"}}, null, false);
        put("ui_longpress", new String[][]{{"x", "number"}, {"y", "number"}},
                new String[][]{{"ms", "number"}}, null, false);
        put("ui_type", new String[][]{{"text", "string"}}, null, null, false);
        put("ui_back", null, null, null, true);
        put("ui_home", null, null, null, true);
        put("ui_recents", null, null, null, true);
        put("shot", null, new String[][]{{"path", "string"}}, null, false);
        put("shot_b64", null, new String[][]{{"maxw", "number"},
                {"quality", "number"}}, null, false);
    }

    // ── 能力分级：每个工具需要哪一层权限 ──────────────────────────────────
    //
    // WHY 每一行都写死，不给默认值（2026-11-16）。这条分级要回答的问题是
    // 「这个工具在**没有提权**的设备上还剩多少能力」。含糊的代价不是不好看：
    // 调用方（尤其是模型）会按「大概不用提权」安排动作，而工具集里真正需要
    // shell 的那一个恰好是能力最大的那一个——exec 能跑任意命令。把它含糊成
    // app，等于让模型在没有 shell 层时反复尝试一整族 input/am/pm/settings。
    //
    // 口径（写在这里，免得每个读代码的人重新推一遍）：
    //   app   = 这个工具的完整能力在 App 自己的 uid 下就能交付。
    //   shell = 这个工具的能力里有一部分必须 uid 2000；在没有 shell 层时，
    //           那一部分会明确回 needs_shell，**不静默降级**。
    //
    // 2026-11-16 实测结论：63 个工具里**只有 exec 是 shell**。文件、界面、
    // 应用、媒体、凭据、共享层、抓包、反代这一族全在 App 层跑得动（逐条实测见
    // works/data/khy/feedback/2026-11-16-selfconnect-adbd/）。这就是「能力下移」
    // 这条路的实际收益：提权依赖面被压到一个工具上，而那一个工具的缺失部分
    // 又是可枚举的（见 ShellLevelPolicy.shellOnlyCommands()）。
    public static final String LEVEL_APP = "app";
    public static final String LEVEL_SHELL = "shell";

    private static final Map<String, String> REQUIRED_LEVEL = new LinkedHashMap<String, String>();

    private static void level(String tool, String level) {
        REQUIRED_LEVEL.put(tool, level);
    }

    static {
        // ── 基础 ──
        level("ping", LEVEL_APP);
        level("info", LEVEL_APP);
        level("tools", LEVEL_APP);
        level("exec", LEVEL_SHELL);
        // 提权自举自己不需要 shell 层——它是**去拿** shell 层的那一步。
        // 标成 app 是对的：没有 shell 时才需要它；等 elevated=shell 之后，
        // 它剩下的活儿只是报状态和拉起代理。
        level("elevate", LEVEL_APP);

        // ── 文件 ──
        level("ls", LEVEL_APP);
        level("read", LEVEL_APP);
        level("write", LEVEL_APP);
        level("mkdir", LEVEL_APP);
        level("rm", LEVEL_APP);
        level("mv", LEVEL_APP);
        level("cp", LEVEL_APP);
        level("stat", LEVEL_APP);
        level("zip", LEVEL_APP);
        level("unzip", LEVEL_APP);

        // ── 凭据投递 ──
        level("secret_code", LEVEL_APP);
        level("secret_put", LEVEL_APP);
        level("secret_list", LEVEL_APP);
        level("secret_del", LEVEL_APP);

        // ── 共享层 ──
        level("sync_status", LEVEL_APP);
        level("sync_append", LEVEL_APP);
        level("sync_read", LEVEL_APP);
        level("sync_delete", LEVEL_APP);
        level("sync_verify", LEVEL_APP);
        level("sync_export", LEVEL_APP);

        // ── 抓包改写 ──
        level("net_capture_start", LEVEL_APP);
        level("net_capture_stop", LEVEL_APP);
        level("net_capture_status", LEVEL_APP);
        level("net_capture_list", LEVEL_APP);
        level("net_capture_export", LEVEL_APP);
        level("net_rule_set", LEVEL_APP);
        level("net_rule_list", LEVEL_APP);
        level("net_rule_delete", LEVEL_APP);
        level("net_rule_clear", LEVEL_APP);

        // ── 应用与系统 ──
        level("start_app", LEVEL_APP);
        level("open_url", LEVEL_APP);
        level("share_text", LEVEL_APP);
        level("clipboard", LEVEL_APP);
        level("toast", LEVEL_APP);
        level("notify", LEVEL_APP);
        level("list_apps", LEVEL_APP);
        level("battery", LEVEL_APP);
        level("volume", LEVEL_APP);
        level("brightness", LEVEL_APP);
        level("vibrate", LEVEL_APP);
        level("adou_signin", LEVEL_APP);

        // ── 媒体 ──
        level("record_audio", LEVEL_APP);
        level("camera_open", LEVEL_APP);

        // ── 循环与反代 ──
        level("loop_start", LEVEL_APP);
        level("loop_stop", LEVEL_APP);
        level("loop_status", LEVEL_APP);
        level("amoo_ask", LEVEL_APP);
        level("amoo_result", LEVEL_APP);
        level("amoo_memory", LEVEL_APP);
        level("amoo_stop", LEVEL_APP);

        // ── 界面与截图 ──
        level("ui_dump", LEVEL_APP);
        level("ui_tap", LEVEL_APP);
        level("ui_click", LEVEL_APP);
        level("ui_swipe", LEVEL_APP);
        level("ui_longpress", LEVEL_APP);
        level("ui_type", LEVEL_APP);
        level("ui_back", LEVEL_APP);
        level("ui_home", LEVEL_APP);
        level("ui_recents", LEVEL_APP);
        level("shot", LEVEL_APP);
        level("shot_b64", LEVEL_APP);
    }

    /**
     * The privilege a tool needs: {@link #LEVEL_APP} or {@link #LEVEL_SHELL}.
     *
     * @return the level; never null. An unknown tool is reported as
     *         {@link #LEVEL_SHELL} — the conservative direction. Guessing "app"
     *         for a tool nobody classified would hand out a capability nobody
     *         checked; guessing "shell" merely refuses something that might have
     *         worked, and the caller can see why.
     */
    public static String requiredLevel(String tool) {
        String level = tool == null ? null : REQUIRED_LEVEL.get(tool);
        return level == null ? LEVEL_SHELL : level;
    }

    /** Every tool and its level, in catalogue order. */
    public static Map<String, String> requiredLevels() {
        return java.util.Collections.unmodifiableMap(REQUIRED_LEVEL);
    }

    /** The catalogue, in declaration order. */
    public static List<Spec> all() {
        return new ArrayList<Spec>(SPECS.values());
    }

    /** One tool's spec, or null when the tool is not in the catalogue. */
    public static Spec get(String tool) {
        if (tool == null) {
            return null;
        }
        return SPECS.get(tool);
    }

    /** Whether the tool needs the accessibility service to work at all. */
    public static boolean needsAccessibility(String tool) {
        if (tool == null) {
            return false;
        }
        return tool.startsWith("ui_") || "shot".equals(tool) || "shot_b64".equals(tool);
    }

    /**
     * Validate the arguments of one tool call.
     *
     * @return null when the arguments are acceptable; otherwise a Chinese sentence
     *         naming exactly what is wrong with them.
     */
    public static String validate(String tool, JSONObject args) {
        Spec spec = get(tool);
        if (spec == null) {
            return "未知工具「" + tool + "」";
        }
        if (args == null) {
            args = new JSONObject();
        }
        List<String> known = spec.knownArgs();

        // Unknown arguments are an error, not a shrug: a silently ignored
        // {"path": "/a", "psth": "/b"} looks like it worked while doing the
        // wrong thing — the most expensive kind of quiet. Only enforced where
        // the tool's full argument set is known; see Spec#strict.
        if (spec.strict) {
            java.util.Iterator<String> keys = args.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!known.contains(key)) {
                    return "未知参数「" + key + "」（" + tool + " 可用：" + join(known) + "）";
                }
            }
        }

        for (String[] req : spec.required) {
            if (!args.has(req[0])) {
                return "缺少参数「" + req[0] + "」";
            }
        }

        if (spec.oneOf.length > 0) {
            boolean any = false;
            for (String name : spec.oneOf) {
                if (args.has(name)) {
                    any = true;
                    break;
                }
            }
            if (!any) {
                return "参数「" + join(Arrays.asList(spec.oneOf)) + "」至少要提供一个";
            }
        }

        // Type checks cover required AND optional arguments. A required argument
        // with the wrong type is the case that used to slip through and surface
        // as a deep tool failure.
        for (String[] req : spec.required) {
            if (!args.has(req[0])) {
                continue;
            }
            String bad = typeProblem(spec, args, req[0]);
            if (bad != null) {
                return bad;
            }
        }
        for (String[] opt : spec.optional) {
            if (args.has(opt[0])) {
                String bad = typeProblem(spec, args, opt[0]);
                if (bad != null) {
                    return bad;
                }
            }
        }

        // Conditional requirements: a couple of tools only need some arguments
        // in some modes, and getting that wrong is the most common way to get a
        // silent no-op ("clipboard" with op=set but no text).
        String cond = conditionalProblem(tool, args);
        if (cond != null) {
            return cond;
        }
        return null;
    }

    /** Type mismatch for one argument, or null when the type fits. */
    private static String typeProblem(Spec spec, JSONObject args, String name) {
        Object v = args.opt(name);
        if (v == null) {
            return null;
        }
        String type = spec.typeOf(name);
        boolean ok;
        if ("string".equals(type)) {
            ok = v instanceof String;
        } else if ("number".equals(type)) {
            ok = v instanceof Number;
        } else if ("bool".equals(type)) {
            ok = v instanceof Boolean;
        } else if ("object".equals(type)) {
            ok = v instanceof JSONObject;
        } else if ("array".equals(type)) {
            ok = v instanceof JSONArray;
        } else {
            ok = true;
        }
        if (ok) {
            return null;
        }
        return "参数「" + name + "」应为 " + typeName(type) + "，实际是 " + jsonTypeName(v);
    }

    /** Requirements that only apply in some modes. */
    private static String conditionalProblem(String tool, JSONObject args) {
        if ("clipboard".equals(tool)) {
            String op = args.optString("op", "get");
            if ("set".equals(op) && !args.has("text")) {
                return "op=set 时必须提供参数「text」";
            }
            if (!"set".equals(op) && !"get".equals(op)) {
                return "参数「op」只能是 get 或 set";
            }
        }
        if ("amoo_memory".equals(tool)) {
            String op = args.optString("op", "get");
            if ("set".equals(op)) {
                if (!args.has("id")) {
                    return "op=set 时必须提供参数「id」";
                }
                if (!args.has("text")) {
                    return "op=set 时必须提供参数「text」";
                }
            } else if (!"get".equals(op)) {
                return "参数「op」只能是 get 或 set";
            }
        }
        if ("loop_start".equals(tool) && args.has("mode")) {
            String m = args.optString("mode", "");
            if (!Arrays.asList("bypass", "plan", "edit", "default")
                    .contains(m.toLowerCase(Locale.ROOT))) {
                return "参数「mode」只能是 bypass / plan / edit / default";
            }
        }
        if ("adou_signin".equals(tool) && args.has("op")) {
            String op = args.optString("op", "");
            if (!Arrays.asList("run", "status", "schedule", "stop").contains(op)) {
                return "参数「op」只支持 run/status/schedule/stop";
            }
        }
        if ("rm".equals(tool)) {
            Object r = args.opt("recursive");
            if (r != null && !(r instanceof Boolean)) {
                return "参数「recursive」应为 布尔值";
            }
        }
        return null;
    }

    private static String typeName(String type) {
        if ("string".equals(type)) return "字符串";
        if ("number".equals(type)) return "数字";
        if ("bool".equals(type)) return "布尔值";
        if ("object".equals(type)) return "对象";
        if ("array".equals(type)) return "数组";
        return "任意值";
    }

    private static String jsonTypeName(Object v) {
        if (v instanceof String) return "字符串";
        if (v instanceof Number) return "数字";
        if (v instanceof Boolean) return "布尔值";
        if (v instanceof JSONObject) return "对象";
        if (v instanceof JSONArray) return "数组";
        if (v == JSONObject.NULL) return "null";
        return "未知类型";
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

    /**
     * The catalogue as JSON, for the console's tool panel.
     *
     * Shape: {@code {"tools":[{"name","desc","group","required":[["path","string"]],
     * "optional":[["level","number"]],"one_of":["text","id"],"strict":true}]}}
     */
    public static JSONObject describe() {
        JSONObject root = new JSONObject();
        JSONArray arr = new JSONArray();
        try {
            for (Spec s : all()) {
                JSONObject o = new JSONObject();
                o.put("name", s.tool);
                o.put("desc", s.desc);
                o.put("group", s.group);
                JSONArray req = new JSONArray();
                for (String[] r : s.required) {
                    req.put(new JSONArray().put(r[0]).put(r[1]));
                }
                o.put("required", req);
                JSONArray opt = new JSONArray();
                for (String[] p : s.optional) {
                    opt.put(new JSONArray().put(p[0]).put(p[1]));
                }
                o.put("optional", opt);
                JSONArray one = new JSONArray();
                for (String p : s.oneOf) {
                    one.put(p);
                }
                o.put("one_of", one);
                o.put("strict", s.strict);
                arr.put(o);
            }
            root.put("tools", arr);
        } catch (Throwable ignored) {
        }
        return root;
    }

    /** Tool names by group, for the self-description sent to Amoo. */
    public static Map<String, List<String>> byGroup() {
        Map<String, List<String>> out = new HashMap<String, List<String>>();
        for (Spec s : all()) {
            List<String> l = out.get(s.group);
            if (l == null) {
                l = new ArrayList<String>();
                out.put(s.group, l);
            }
            l.add(s.tool);
        }
        return out;
    }
}
