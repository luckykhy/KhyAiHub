// khy-canary: Khy-20261101-014-9X7AXKSJ
package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Mode gate and safety floor for the local interception loop.
 *
 * <p>Two independent decisions live here, and the second one always wins:
 * <ul>
 *   <li>the <b>mode</b> decides how a command is routed -- run it now, ask the
 *       human first, or hand the whole plan over;</li>
 *   <li>the <b>safety floor</b> is a veto that no mode may switch off,
 *       {@code BYPASS} included. "Do not ask me about anything" and "do not run
 *       something that wipes the device" are different claims, so the floor is
 *       evaluated independently of the mode and reported separately through
 *       {@link Decision#floorTripped}.</li>
 * </ul>
 *
 * <p>Contract (see amoo-loop-spec.md): zero IO, deterministic, never throws.
 * Anything that cannot be judged resolves to the most conservative outcome
 * ({@link Action#CONFIRM}) instead of an exception, so a malformed command
 * stops the loop for a human instead of crashing it.
 *
 * <p>False positives matter as much as false negatives here: a floor that trips
 * on every command that merely <i>mentions</i> {@code rm -rf} would make
 * {@code BYPASS} useless and push the human back into confirming everything by
 * hand. Every pattern below is therefore matched at the <i>command position</i>
 * (after shell splitting and quote stripping), never as a bare substring,
 * except for the few constructs that are dangerous wherever they appear.
 */
public final class LoopModes {

    /** How aggressively the loop may act on its own. */
    public enum Mode { BYPASS, PLAN, EDIT, DEFAULT }

    /** What should happen to a single command. */
    public enum Action { EXECUTE, CONFIRM, DEFER }

    /** Outcome of {@link #decide(Mode, String, JSONObject)}. */
    public static final class Decision {
        public final Action action;
        /** Chinese, meant for the human reading the log / notification. */
        public final String reason;
        /** True when the safety floor was hit; {@code reason} then says why. */
        public final boolean floorTripped;

        public Decision(Action action, String reason, boolean floorTripped) {
            this.action = action;
            this.reason = reason;
            this.floorTripped = floorTripped;
        }
    }

    /** Tools whose side effects are irreversible enough to always confirm. */
    private static final List<String> HIGH_RISK_TOOLS = Arrays.asList("exec", "rm");

    /**
     * 不可逆工具：模式无关安全底覆盖的第二类。
     *
     * <p>与 {@link #HIGH_RISK_TOOLS} 的分工：那一类判的是「这条命令本身有多危险」
     * （删目录树、跑任意 shell），判据在参数里；这一类判的是「这个工具做的事撤不回来」，
     * 判据在工具名上——所以参数再正常也不改变结论。
     *
     * <p>为什么必须进安全底而不是只进 DEFAULT 档的高危名单：BYPASS 是默认档
     * （{@link #defaultMode()}），而 BYPASS 恰恰是「不踩底就一律 EXECUTE」的那一档。
     * 一条不可逆的命令在默认档里裸奔，等于「不可逆」这三个字只在非默认档成立。
     * 安全底是模式无关的否决权，BYPASS 也不例外。
     *
     * <p>为什么是这 13 项：
     * <ul>
     *   <li>{@code secret_*}：凭据进 App 私有目录 + Keystore，投递码用过即失效，
     *       写进去的凭据删掉也回不来（人只能重投一次）。</li>
     *   <li>{@code adou_signin}：替你在第三方 App 里执行签到流程，对方那边可能已记为
     *       「今天签过了」，本地撤不回。</li>
     *   <li>{@code amoo_*}：助手闭环四件套。要么替人发了一句话（{@code amoo_ask}
     *       写进 Amoo 输入框就撤不回），要么动了跨会话共享记忆
     *       （{@code amoo_memory}），要么释放了单飞锁（{@code amoo_stop}，释放本身
     *       可逆，但它是这条链上唯一的紧急出口，环内另有专门处理，见
     *       {@code AmooLoop.executeOne}）。</li>
     * </ul>
     *
     * <p>取舍留痕：{@code zip} / {@code unzip} **不在**这一类里——它们的破坏面是
     * 「覆盖目标目录里的同名文件」，可逆（重新生成），而 {@code unzip} 自带 Zip Slip
     * 防护（{@code Tools.java} 的 canonical 路径包含检查）。这条取舍是「可辩护但待人
     * 裁决」，已写进 {@code [DESIGN-ARCH-193]} Q5 与本轮的 openQuestions，不在实现里
     * 默默定案。
     */
    private static final List<String> IRREVERSIBLE_TOOLS = Arrays.asList(
            "secret_code", "secret_put", "secret_list", "secret_del",
            "adou_signin",
            "amoo_ask", "amoo_result", "amoo_memory", "amoo_stop");

    /**
     * Tool names the bridge actually knows — a set mirror of {@code Tools.NAMES}
     * (48 items, kept local so this pure-logic class carries no dependency on the
     * IO layer; {@code LoopModesTest.knownToolsMirrorToolsNamesAsSets} pins the
     * equality by set, not by line order).
     *
     * <p>WHY IT IS A MIRROR AND NOT A SUBSET (2026-11-03, P0-2). The list used to
     * hold 36 of the 48 names. The other 12 — {@code adou_signin}, {@code amoo_ask},
     * {@code amoo_result}, {@code amoo_memory}, {@code amoo_stop}, {@code zip},
     * {@code unzip}, {@code secret_code}, {@code secret_put}, {@code secret_list},
     * {@code secret_del}, {@code tools} — were dropped at parse time by
     * {@code AmooProtocol.extractCommands}, so a command naming them vanished
     * without a word: no error, no refusal, nothing on the overlay. The worst of
     * them is {@code amoo_stop}, the only instant abort for an in-flight ask.
     *
     * <p>WHAT "OUTSIDE THIS SET" MEANS NOW, and it is NOT the same in every mode:
     * an unregistered tool is one the bridge has no risk classification for, so
     * DEFAULT treats it as "cannot judge" -&gt; CONFIRM. BYPASS does NOT: per the
     * mode table it executes whatever is not stopped by the safety floor. So the
     * old docblock line "anything outside this set -&gt; CONFIRM" was only ever
     * true for DEFAULT, while {@link #defaultMode()} is BYPASS. The generic-unknown
     * case is pinned by {@code LoopModesTest.unknownToolInBypassIsExecuted},
     * which now says so in words.
     */
    private static final List<String> KNOWN_TOOLS = Arrays.asList(
            "ping", "info", "exec", "ls", "read", "write", "mkdir", "rm", "mv", "cp",
            "stat", "start_app", "open_url", "share_text", "clipboard", "toast",
            "notify", "list_apps", "battery", "volume", "brightness", "vibrate",
            "adou_signin",
            "loop_start", "loop_stop", "loop_status",
            "amoo_ask", "amoo_result", "amoo_memory", "amoo_stop",
            "ui_dump", "ui_tap", "ui_click", "ui_swipe", "ui_longpress", "ui_type",
            "ui_back", "ui_home", "ui_recents", "shot", "shot_b64",
            "zip", "unzip",
            "secret_code", "secret_put", "secret_list", "secret_del",
            "tools");

    /** Interpreters that can hide a second command behind {@code -c}. */
    private static final List<String> SHELLS =
            Arrays.asList("sh", "bash", "dash", "ash", "zsh", "ksh", "mksh");

    /**
     * Commands that only PRINT their arguments.
     *
     * This is what keeps {@code echo rm -rf} from tripping the floor. It is not
     * a nicety: without an exemption list, BYPASS would refuse every command
     * that merely mentions a dangerous verb and the mode would be useless in
     * practice.
     */
    private static final List<String> PRINTING_COMMANDS = Arrays.asList(
            "echo", "printf", "cat", "head", "tail", "grep", "egrep", "fgrep", "ls",
            "man", "which", "type", "true", "false", ":", "test", "[");

    /** Guard against {@code sh -c 'sh -c sh -c ...'} recursion. */
    private static final int MAX_UNWRAP_DEPTH = 4;

    /** {@code > /dev/<something>} -- a write into a device node. */
    private static final Pattern DEV_REDIRECT = Pattern.compile(">+\\s*/dev/[^\\s;&|]*");

    /** {@code :(){ :|:& };:} -- the classic fork bomb, whitespace tolerant. */
    private static final Pattern FORK_BOMB = Pattern.compile(":\\s*\\(\\s*\\)\\s*\\{");

    // ---------------------------------------------------------------- public

    /**
     * Decide how one command travels under the given mode.
     *
     * @param mode requested mode; {@code null} means "unknown" and falls back
     *             to the most conservative routing
     * @param tool bridge tool name (aliases such as {@code shell_exec} are
     *             folded onto their canonical name)
     * @param args command arguments, may be {@code null}
     * @return never {@code null}; {@link Action#CONFIRM} whenever the floor is
     *         hit or the command cannot be judged
     */
    public static Decision decide(Mode mode, String tool, JSONObject args) {
        String floor = floorReason(tool, args);
        boolean tripped = floor != null;

        if (mode == null) {
            return new Decision(Action.CONFIRM,
                    "模式无法识别，按最保守处理" + suffix(floor), tripped);
        }
        switch (mode) {
            case PLAN:
                return new Decision(Action.DEFER,
                        "计划模式：一条不执行，命令清单交给人审" + suffix(floor), tripped);
            case EDIT:
                return new Decision(Action.CONFIRM,
                        "编辑模式：执行前逐条让人改" + suffix(floor), tripped);
            case BYPASS:
                if (tripped) {
                    return new Decision(Action.CONFIRM, "命中安全底：" + floor, true);
                }
                return new Decision(Action.EXECUTE, "旁路模式：直接执行", false);
            case DEFAULT:
            default:
                if (tripped) {
                    return new Decision(Action.CONFIRM, "命中安全底：" + floor, true);
                }
                String t = normalizeTool(tool);
                if (HIGH_RISK_TOOLS.contains(t)) {
                    return new Decision(Action.CONFIRM,
                            "高危工具（" + t + "），需确认后执行", false);
                }
                if (!isKnownTool(t)) {
                    return new Decision(Action.CONFIRM,
                            "无法识别工具（" + t + "），按最保守处理", false);
                }
                return new Decision(Action.EXECUTE, "默认模式：低危，直接执行", false);
        }
    }

    /**
     * Whether the safety floor is hit by this command. Independent of the mode
     * and therefore always the highest priority check.
     */
    public static boolean safetyFloorTripped(String tool, JSONObject args) {
        return floorReason(tool, args) != null;
    }

    /** Default mode: {@link Mode#BYPASS} (decided by the human). */
    public static Mode defaultMode() {
        return Mode.BYPASS;
    }

    // ------------------------------------------------------- safety floor

    /**
     * Single source of truth for the floor: returns a Chinese explanation when
     * the command is (or cannot be proven not to be) dangerous, {@code null}
     * when it is safe. {@link #safetyFloorTripped} is just a null check on this
     * so the two can never disagree.
     */
    private static String floorReason(String tool, JSONObject args) {
        String t = normalizeTool(tool);
        if (t == null || t.length() == 0) {
            return "工具名缺失，无法判断命令内容";
        }
        // 不可逆工具的判定只看工具名，与参数无关——所以它排在「参数缺失」之前：
        // 少传参数不会把一条不可逆命令变成可逆命令。
        if (IRREVERSIBLE_TOOLS.contains(t)) {
            return irreversibleReason(t);
        }
        if (args == null) {
            return "命令参数缺失，无法判断命令内容";
        }
        if ("rm".equals(t)) {
            return rmFloorReason(args);
        }
        if ("exec".equals(t)) {
            return execFloorReason(args);
        }
        if ("ui_type".equals(t)) {
            return uiTypeFloorReason(args);
        }
        return null;
    }

    /**
     * 为什么这个工具不可逆（中文，一句话说完：问题 + 原因 + 能怎么办）。
     *
     * 每一句都给出「人能怎么办」，不然拒绝就只是一堵墙：说完原因不说出路，
     * 人只能猜自己该换哪个工具。
     */
    private static String irreversibleReason(String t) {
        if ("amoo_ask".equals(t)) {
            return amooAskLoopReason();
        }
        if ("amoo_stop".equals(t)) {
            return "amoo_stop 中止一次进行中的提问，被中止的那次提问不会自动续上。"
                    + "除旁路档外先经人确认；旁路档里环内的中止走 AmooLoop 的紧急出口"
                    + "——中止是方向正确的动作，拒绝一次中止等于让人喊不停。";
        }
        if ("amoo_result".equals(t)) {
            return "amoo_result 读的是助手闭环自己的内部状态，环内自取会和循环自己的"
                    + "提问撞同一把单飞锁。要结果请在手机上手动发起，或等循环自己写回。";
        }
        if ("amoo_memory".equals(t)) {
            return "amoo_memory 改的是跨会话共享记忆：写进去的条目会被以后的每一轮"
                    + "提问当成既定事实，撤回不了。要改记忆请在手机上手动发起。";
        }
        if ("adou_signin".equals(t)) {
            return "adou_signin 替你在第三方 App 里执行签到，对方那边可能已经记成"
                    + "今天签过了，本地撤不回。请在手机上直接操作那个 App。";
        }
        if ("secret_put".equals(t)) {
            return "secret_put 写入的凭据进 App 私有目录 + Keystore，删掉也回不来。"
                    + "要投递凭据请走手机上的投递码流程（secret_code → 通知上的码 → "
                    + "secret_put），由人在手机旁确认。";
        }
        if ("secret_del".equals(t)) {
            return "secret_del 删掉的凭据无法恢复。要删请在手机上用投递码手动删除。";
        }
        if ("secret_code".equals(t)) {
            return "secret_code 生成的投递码由「人在手机旁」这道确认把关，环内自动"
                    + "发起等于绕开它。请在手机上直接发起投递。";
        }
        if ("secret_list".equals(t)) {
            return "secret_list 列的是凭据面，环内自动列等于把凭据面交给模型自主翻查。"
                    + "要看凭据请在手机上手动发起。";
        }
        return "该工具的操作不可逆（" + t + "），按最保守处理";
    }

    /**
     * 环内自调用 {@code amoo_ask} 为什么不行。
     *
     * <p>与 {@code ui_type} 的先例同构：那条红线只属于 Amoo 驱动的循环这一条路径，
     * PC 经 HTTP {@code /call} 或文件信箱驱动 {@code amoo_ask} 不受此限——那两条路
     * 不过 {@link #decide}，直接进 {@code Tools.dispatch}。
     *
     * <p>为什么环内自调用必然失败：{@code AmooLoop.ask} 第一行就是单飞检查
     * （{@code if (askRunning) return null;}），而循环本身正等着 Amoo 的回答。
     * 环内再问一次，撞的是同一把锁——那笔提问永远等不到结果，循环会一直等到
     * 整个预算走完。这不是「慢一点」，是「等不到」。
     *
     * <p>所以这条拒绝**不是**一道待确认的门：确认也解决不了。要问 Amoo 就直接说，
     * 循环会自己把结果写回。
     */
    public static String amooAskLoopReason() {
        return "amoo_ask 不能在 Amoo 驱动的循环里自调用：循环正等着 Amoo 的回答，"
                + "环内再问一次会撞上单飞锁（askRunning），那笔提问永远等不到结果。"
                + "要问 Amoo 直接说，循环会自己写回；这条拒绝不是待确认项，"
                + "确认也解决不了。";
    }

    /**
     * Why {@code ui_type} is refused on THIS path and only this path.
     *
     * {@code KhyUi.type} types its text raw — {@link AmooSafe#sanitise} is never
     * called on it. Every other channel into Amoo's composer funnels through
     * {@code AmooLoop.forAmoo}, which sanitises before it abbreviates; this one
     * tool bypasses that entirely, because it is a TOOL (reachable from a fence,
     * and from {@code Tools.dispatch} over HTTP or the mailbox) rather than the
     * write-back function.
     *
     * So a fence {@code {"tool":"ui_type","args":{"text":"/sdcard/…"}}} would put
     * an unsanitised absolute path into Amoo's input box — one human tap from
     * being transmitted. That is exactly the red line the sanitiser exists to
     * hold.
     *
     * WHY A FLOOR RULE AND NOT A TOOL-LEVEL SANITISE. The tool-level fix
     * (sanitising inside {@code KhyUi.type}) closes the hole for every caller,
     * but it also breaks {@code LoopVerify}: {@code plan("ui_type", …)} records
     * {@code expectText} from the RAW args and {@code applyVerify} compares the
     * box against it, so sanitising at the tool level makes every {@code ui_type}
     * permanently "未能验证". Fixing that means changing the verifier in the same
     * commit, which is a second behaviour change on a live tool surface.
     *
     * WHY THIS DOES NOT BREAK THE WRITE-BACK. {@code AmooLoop.writeBack} calls
     * {@code KhyUi.dispatch("ui_type", …)} DIRECTLY — it never goes through
     * {@code Tools.dispatch}, and {@link #decide} has exactly one production
     * caller ({@code AmooLoop.executeOne}). So refusing the TOOL leaves the
     * write-back path untouched. That asymmetry is the whole reason this works.
     *
     * WHAT THIS LEAVES OPEN, on purpose: {@code Tools.dispatch("ui_type", …)}
     * called over HTTP by the PC, or through the mailbox. Those are a human
     * driving the phone with their own hands, they get raw results back by
     * design, and the bridge binds loopback only. Applying Amoo's red line to
     * the human's own typing would be the wrong policy.
     */
    private static String uiTypeFloorReason(JSONObject args) {
        String text = args == null ? "" : args.optString("text", "");
        if (text.trim().length() == 0) {
            // An empty type is harmless and the tool already rejects it. Let the
            // tool give its own message rather than a floor message about a
            // sanitisation concern that does not apply to nothing.
            return null;
        }
        return "ui_type 会把文本原样写进 Amoo 输入框，不过净化——"
                + "本路径（Amoo 驱动的循环）禁止用它，否则未净化的路径/标识符"
                + "会出现在输入框里，离发送只差一次人工点击。"
                + "要把结果告诉 Amoo，直接说，循环会自己写回；"
                + "要操作界面用 ui_tap / ui_swipe / ui_dump。";
    }

    /**
     * {@code rm} is only floor-relevant when it is recursive. A missing
     * {@code recursive} field means "not recursive" -- and since 2026-10-25
     * {@code Tools.rm} defaults it to false as well (the destructive form must
     * be opted into explicitly), so the floor and the tool now agree.
     */
    static String rmFloorReason(JSONObject args) {
        Object v = args.opt("recursive");
        if (v == null) {
            // Tools.rm 的 `recursive` 默认值已在 2026-10-25 改成 **false**
            // （破坏性形态必须显式 opt-in）。所以「字段缺失」现在等于「不递归」，
            // 底线不该再按递归拒绝 —— 否则底线的假设比工具的实际默认更严，
            // 把一次普通的单文件删除也拦了。
            return null;
        }
        if (v instanceof Boolean) {
            return ((Boolean) v).booleanValue() ? "递归删除（rm recursive）" : null;
        }
        if (v instanceof String) {
            String s = ((String) v).trim().toLowerCase(Locale.ROOT);
            if ("true".equals(s)) {
                return "递归删除（rm recursive）";
            }
            if ("false".equals(s)) {
                return null;
            }
        }
        return "recursive 字段类型或取值无法解析，按踩底处理";
    }

    /**
     * 工具级底线：危险命令在**任何入口**都不执行。
     *
     * 为什么放在工具里：Tools.dispatch 有三条入口 —— Amoo 循环、HTTP /call、文件信箱。
     * 只有 Amoo 那条过 {@link #decide}，另两条（PC 手动驱动、信箱）此前完全不过任何
     * 命令底线，于是 `rm -rf /`、`mkfs`、`dd if=/dev/zero`、`reboot`、`pm uninstall`
     * 这类系统级破坏命令能被一条 HTTP 请求或一个信箱文件直接叫起来。
     *
     * 与 {@link #decide} 的分工：decide 管的是「这次循环该不该问人/该不该拒」——模式语义与
     * ui_type 净化那条红线，只属于 Amoo 路径（见本类注释 WHAT THIS LEAVES OPEN：
     * 人手动驱动的路径不套 Amoo 的红线）。这里管的是另一件事：**这条命令本身就不该被执行**
     * ——误触即毁设备，人在不在场都一样。
     */
    static String execDangerReason(JSONObject args) {
        Object v = args == null ? null : args.opt("cmd");
        if (!(v instanceof String)) {
            return null;
        }
        String raw = ((String) v).trim();
        if (raw.length() == 0) {
            return null;
        }
        return cmdDangerReason(raw, 0);
    }

    private static String execFloorReason(JSONObject args) {
        Object v = args.opt("cmd");
        if (!(v instanceof String)) {
            return "exec 命令缺失或类型不正确，无法解析";
        }
        String raw = (String) v;
        if (raw.trim().length() == 0) {
            return null;
        }
        return cmdDangerReason(raw, 0);
    }

    private static String cmdDangerReason(String raw, int depth) {
        if (depth > MAX_UNWRAP_DEPTH) {
            return null;
        }
        String low = stripQuotes(raw).toLowerCase(Locale.ROOT);

        String whole = wholeStringReason(low);
        if (whole != null) {
            return whole;
        }
        List<List<String>> segments = commandSegments(low);
        for (int i = 0; i < segments.size(); i++) {
            String r = segmentReason(segments.get(i), depth);
            if (r != null) {
                return r;
            }
        }
        return null;
    }

    /**
     * Patterns that are dangerous wherever they appear, so they are matched on
     * the whole (quote-stripped, lower-cased) command string.
     */
    private static String wholeStringReason(String low) {
        if (FORK_BOMB.matcher(low).find()) {
            return "fork 炸弹";
        }
        Matcher m = DEV_REDIRECT.matcher(low);
        while (m.find()) {
            String hit = m.group();
            // /dev/null is the canonical discard sink; treating it as dangerous
            // would flag the extremely common `cmd > /dev/null 2>&1` idiom and
            // make BYPASS useless in practice.
            if (!hit.endsWith("/dev/null")) {
                return "重定向写入设备节点（> /dev/）";
            }
        }
        return null;
    }

    /**
     * One shell segment (commands between {@code ;} / {@code |} / {@code &&} /
     * newline). The command name is the first token after quote stripping and
     * after any leading {@code VAR=value} assignment, which is what keeps
     * {@code echo rm -rf} safe while {@code "rm" -rf} is not.
     */
    /**
     * One shell segment (commands between {@code ;} / {@code |} / {@code &&} /
     * newline).
     *
     * The command name is NOT assumed to be the first token. {@code env},
     * {@code nice}, {@code nohup}, {@code setsid}, {@code stdbuf},
     * {@code ionice}, {@code timeout} and {@code busybox} all put their own
     * options in front of the real command, and a floor that only inspected
     * token[0] let {@code env rm -rf /data} straight through under BYPASS. So
     * every token is inspected, and a token is excused only when the segment
     * contains a PRINTING command somewhere before it — which is what keeps
     * {@code echo rm -rf} and {@code printf 'use rm -rf carefully'} from
     * tripping the floor.
     */
    private static String segmentReason(List<String> tokens, int depth) {
        // Unwrap `sh -c '<command>'` wherever the shell appears in the segment,
        // not only in position 0 — `env sh -c 'rm -rf /data'` is the same trick.
        if (depth < MAX_UNWRAP_DEPTH) {
            for (int i = 0; i < tokens.size(); i++) {
                if (!SHELLS.contains(baseName(tokens.get(i)))) {
                    continue;
                }
                int c = indexOfToken(tokens, "-c", i + 1);
                if (c < 0) {
                    continue;
                }
                StringBuilder nested = new StringBuilder();
                for (int k = c + 1; k < tokens.size(); k++) {
                    if (k > c + 1) {
                        nested.append(' ');
                    }
                    nested.append(tokens.get(k));
                }
                String r = cmdDangerReason(nested.toString(), depth + 1);
                if (r != null) {
                    return r;
                }
            }
        }

        for (int i = 0; i < tokens.size(); i++) {
            if (precededByPrinting(tokens, i)) {
                continue;
            }
            List<String> rest = tokens.subList(i + 1, tokens.size());
            String r = commandReason(baseName(tokens.get(i)), rest);
            if (r != null) {
                return r;
            }
        }
        return null;
    }

    /**
     * Whether a command that merely PRINTS its arguments appears before
     * {@code index} in this segment.
     *
     * The whole segment is scanned, not just the previous token: in
     * {@code printf use rm -rf carefully} the dangerous verb is two tokens after
     * the printer, and a "previous token only" rule flagged it.
     */
    private static boolean precededByPrinting(List<String> tokens, int index) {
        for (int i = 0; i < index && i < tokens.size(); i++) {
            if (PRINTING_COMMANDS.contains(baseName(tokens.get(i)))) {
                return true;
            }
        }
        return false;
    }

    /** Danger rules for one command name plus its arguments. */
    private static String commandReason(String first, List<String> rest) {
        if ("rm".equals(first)) {
            for (int k = 0; k < rest.size(); k++) {
                if (isForceOrRecursiveFlag(rest.get(k))) {
                    return "删除命令带递归或强制参数（rm -r/-f）";
                }
            }
            return null;
        }
        if (first.startsWith("mkfs")) {
            return "格式化命令（mkfs）";
        }
        if ("dd".equals(first)) {
            // `dd` is only dangerous when it touches a device node. A blanket
            // `if=` match would also flag `dd if=/sdcard/a of=/sdcard/b`, which
            // is an ordinary file copy, so the /dev/ path is required.
            boolean hasRedirection = false;
            boolean touchesDevice = false;
            for (int k = 0; k < rest.size(); k++) {
                String a = rest.get(k);
                if (a.startsWith("if=") || a.startsWith("of=")) {
                    hasRedirection = true;
                }
                if (a.indexOf("/dev/") >= 0) {
                    touchesDevice = true;
                }
            }
            if (hasRedirection && touchesDevice) {
                return "原始块设备读写（dd if=/of=/dev/）";
            }
            return null;
        }
        if ("reboot".equals(first)) {
            return "重启设备（reboot）";
        }
        if ("setprop".equals(first)) {
            return "修改系统属性（setprop）";
        }
        if ("pm".equals(first) && containsArg(rest, "uninstall")) {
            return "卸载应用（pm uninstall）";
        }
        if ("chmod".equals(first) && hasRecursiveFlag(rest) && hasZeroMode(rest)) {
            return "递归清空权限位（chmod -R 000）";
        }
        if ("chown".equals(first) && hasRecursiveFlag(rest)) {
            return "递归修改属主（chown -R）";
        }
        // ---- 批量读取形状 ----
        // 放在安全底里而不是模式层：安全底是"任何模式都关不掉的否决权，
        // BYPASS 也不例外"。而 BYPASS 恰恰是这条唯一的缺口——它不触发安全底
        // 就一律 EXECUTE，于是 `exec: cat /sdcard/DCIM/*` 在旁路模式下畅行无阻。
        //
        // 依据是 Amoo 的红线（AMOO-GUIDELINES.md §4.6）：它不许用 ls/find/exec
        // 静默批量导出用户数据，且"判定是最终读到了什么，不是调了哪个接口"。
        // 我们替它执行，所以形状识别由我们做。
        //
        // 沿用本类既有原则：匹配**命令位置**（分词、去引号之后），不做裸子串匹配。
        // 一个把每个提到 `cat *` 的命令都拦住的底，会让 BYPASS 变得没法用。
        String bulk = bulkReadReason(first, rest);
        if (bulk != null) return bulk;
        if ("find".equals(first) && containsArg(rest, "-delete")) {
            return "按条件批量删除（find -delete）";
        }
        if ("mv".equals(first) && hasRootPath(rest)) {
            return "移动根目录（mv /）";
        }
        if ("ln".equals(first) && hasSymlinkFlag(rest) && hasRootPath(rest)) {
            return "根目录符号链接（ln -s /）";
        }
        return null;
    }

    /**
     * 能把一批文件内容一次性带出设备的命令形状。
     *
     * 三条判据，按误伤风险从低到高：
     *
     *   1. 读类命令的操作数里出现通配符（`*` / `?`）。单文件工作里几乎不会出现，
     *      而它是"我要一批"的最强信号。
     *   2. `tar` 打包到 stdout（`-f -`）。整树归档再从标准输出读走，是没有第二种
     *      解释的形状。相比之下 `tar czf /sdcard/x.tgz` 只是普通备份，不拦。
     *   3. `find` 不带任何限定条件。正常查找总是知道自己在找什么；一个连限定
     *      都没有的 find，语义就是"把这里全部列给我"。
     *
     * **这是启发式，不是完备的。** 换个写法就能绕（`c""at`、`$(echo Y2F0)`、
     * 变量间接）。真正的后闸是 Tools 里的每轮字节预算——它限住"总共能带走多少"，
     * 而这里限住"这种形状不许过"。两层都要，缺一层都不够。
     */
    private static String bulkReadReason(String first, List<String> rest) {
        // 1. 读类命令 + 通配符
        if (READ_COMMANDS.contains(first)) {
            for (int i = 0; i < rest.size(); i++) {
                String a = rest.get(i);
                if (a.startsWith("-")) continue; // 是旗标不是操作数
                if (a.indexOf('*') >= 0 || a.indexOf('?') >= 0) {
                    return "读类命令配通配符（" + first + " " + a + "），"
                            + "疑似批量导出；请逐个小范围读取";
                }
            }
        }
        // 2. tar 打包到 stdout
        if ("tar".equals(first)) {
            for (int i = 0; i < rest.size(); i++) {
                String a = rest.get(i);
                // `--file=-` 长写法
                if (a.startsWith("--file=") && "-".equals(a.substring(7))) {
                    return "打包到标准输出（tar --file=-），疑似整树导出";
                }
                // `-f -` 或 `-f-` 独立写法
                if (a.startsWith("-f")) {
                    String target = a.length() > 2 ? a.substring(2) : "";
                    if (target.isEmpty() && i + 1 < rest.size()) {
                        target = rest.get(i + 1);
                    }
                    if ("-".equals(target)) {
                        return "打包到标准输出（tar -f -），疑似整树导出";
                    }
                }
                // 合并短选项：`tar czf - /path` 里 -f 的值是下一个 token `-`，
                // 而 `-f` 并不作为独立 token 出现（整块是 `czf`）。只查 `-f` 前缀
                // 永远匹配不到这种最常见的写法，所以这里额外判一个孤立的 `-` 操作数。
                if ("-".equals(a)) {
                    return "打包到标准输出（tar -f -），疑似整树导出";
                }
            }
        }
        // 3. find 不带任何限定条件
        //
        // 原来还要求"停在宽根"，但那判据是坏的：宽根本身没法定义。/sdcard 下面
        // 每一层都可能是几千张照片，也都可能是一个已知的小目录——按路径判断
        // 等于没有判据（工作空间里的 find /sdcard/khy-os/workspace 也会被判成宽根，
        // 于是规则要么全拦要么全放）。
        //
        // 换成只看**有没有限定**：正常查找总是知道自己在找什么（-name/-path/
        // -maxdepth/-type）；一个连限定都没有的 find，语义就是"把这里全部列给我"，
        // 那正是枚举形状。可解释、误伤面小，且与路径无关。
        if ("find".equals(first)) {
            boolean filtered = false;
            for (int i = 0; i < rest.size(); i++) {
                String a = rest.get(i);
                if (!a.startsWith("-")) continue;
                if ("-name".equals(a) || "-path".equals(a) || "-iname".equals(a)
                        || "-maxdepth".equals(a) || "-type".equals(a)) {
                    filtered = true;
                }
            }
            if (!filtered) {
                return "遍历目录且不带任何限定条件（find 无 -name/-maxdepth），"
                        + "疑似枚举；请加限定条件缩小范围";
            }
        }
        return null;
    }

    /** 读文件内容的命令。用于通配符判据。 */
    private static final List<String> READ_COMMANDS = Arrays.asList(
            "cat", "base64", "xxd", "od", "strings", "grep", "zcat", "bzcat");

    private static int indexOfToken(List<String> tokens, String want, int from) {
        for (int i = Math.max(0, from); i < tokens.size(); i++) {
            if (want.equals(tokens.get(i))) {
                return i;
            }
        }
        return -1;
    }

    // ------------------------------------------------------------- helpers

    /** {@code VAR=value} / {@code shell_exec} -> canonical bridge tool name. */
    private static String normalizeTool(String tool) {
        if (tool == null) {
            return null;
        }
        String t = tool.trim().toLowerCase(Locale.ROOT);
        if ("shell_exec".equals(t)) {
            return "exec";
        }
        if ("file_read".equals(t)) {
            return "read";
        }
        if ("file_write".equals(t)) {
            return "write";
        }
        if ("file_list".equals(t)) {
            return "ls";
        }
        if ("sys_info".equals(t)) {
            return "info";
        }
        return t;
    }

    /**
     * Whether {@code t} names a tool the bridge actually has.
     *
     * Public because {@link AmooProtocol#extractCommands} uses it as its strongest
     * false-positive filter: a bare JSON object that names a real bridge tool is
     * almost certainly a command, while prose that merely mentions the protocol
     * almost never does.
     *
     * <p>THE FILTER BASIS IS NOW THE {@code Tools.NAMES} MIRROR (2026-11-03, P0-2).
     * {@link #KNOWN_TOOLS} used to hold 36 of the 48 names, and the 12 missing ones
     * were dropped here — at parse time, before any decision layer — so a command
     * naming them disappeared without a word. The set is now a mirror of
     * {@code Tools.NAMES}; {@code LoopModesTest} pins the equality by set.
     *
     * <p>WHY THE {@code ui_} PREFIX RULE STAYS. The mirror already contains all
     * nine {@code ui_} tools, so the prefix rule no longer adds a real tool — it
     * only widens the filter to <i>misspelled</i> {@code ui_} names. That is
     * deliberate: a misspelled tool must come back as an explicit
     * {@code unknown tool} error, not vanish. Removing it would re-introduce the
     * very failure mode P0-2 removes (a command that disappears instead of
     * reporting itself).
     */
    public static boolean isKnownTool(String t) {
        if (t == null) {
            return false;
        }
        if (t.startsWith("ui_")) {
            return true;
        }
        return KNOWN_TOOLS.contains(t);
    }

    private static String suffix(String floor) {
        if (floor == null) {
            return "";
        }
        return "（同时命中安全底：" + floor + "）";
    }

    /** Remove quote characters so {@code "rm"} and {@code rm} look alike. */
    private static String stripQuotes(String s) {
        if (s.indexOf('"') < 0 && s.indexOf('\'') < 0) {
            return s;
        }
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '"' && c != '\'') {
                b.append(c);
            }
        }
        return b.toString();
    }

    /** Last path component, so {@code /system/bin/rm} is recognised as {@code rm}. */
    private static String baseName(String tok) {
        int i = tok.lastIndexOf('/');
        return i >= 0 ? tok.substring(i + 1) : tok;
    }

    private static boolean containsArg(List<String> args, String v) {
        for (int i = 0; i < args.size(); i++) {
            if (args.get(i).equals(v)) {
                return true;
            }
        }
        return false;
    }

    /** {@code -r}, {@code -f}, {@code -rf}, {@code -fr}, {@code -Rf}, {@code --recursive}. */
    private static boolean isForceOrRecursiveFlag(String a) {
        if (!a.startsWith("-") || a.length() < 2) {
            return false;
        }
        if (a.startsWith("--")) {
            return "--recursive".equals(a) || "--force".equals(a);
        }
        String body = a.substring(1);
        boolean hit = false;
        for (int i = 0; i < body.length(); i++) {
            char c = body.charAt(i);
            char lc = Character.toLowerCase(c);
            if (lc != 'r' && lc != 'f') {
                return false;
            }
            hit = true;
        }
        return hit;
    }

    private static boolean hasRecursiveFlag(List<String> args) {
        for (int i = 0; i < args.size(); i++) {
            String a = args.get(i);
            if ("--recursive".equals(a)) {
                return true;
            }
            if (a.length() >= 2 && a.charAt(0) == '-' && a.charAt(1) != '-') {
                for (int k = 1; k < a.length(); k++) {
                    char c = a.charAt(k);
                    if (c == 'r' || c == 'R') {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static boolean hasSymlinkFlag(List<String> args) {
        for (int i = 0; i < args.size(); i++) {
            String a = args.get(i);
            if ("--symbolic".equals(a)) {
                return true;
            }
            if (a.length() >= 2 && a.charAt(0) == '-' && a.charAt(1) != '-') {
                for (int k = 1; k < a.length(); k++) {
                    if (a.charAt(k) == 's') {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /** {@code 000} / {@code 0000} -- a permission mode with every bit cleared. */
    private static boolean hasZeroMode(List<String> args) {
        for (int i = 0; i < args.size(); i++) {
            String a = args.get(i);
            if (a.length() == 0) {
                continue;
            }
            boolean allZero = true;
            for (int k = 0; k < a.length(); k++) {
                if (a.charAt(k) != '0') {
                    allZero = false;
                    break;
                }
            }
            if (allZero) {
                return true;
            }
        }
        return false;
    }

    /** Whether any argument names the filesystem root ({@code /}, {@code ///}). */
    private static boolean hasRootPath(List<String> args) {
        for (int i = 0; i < args.size(); i++) {
            String p = args.get(i);
            while (p.length() > 0 && p.endsWith("/")) {
                p = p.substring(0, p.length() - 1);
            }
            if (p.length() == 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * Split a command into segments of tokens.
     *
     * <p>Segment boundaries are the shell command separators ({@code ;}, {@code |},
     * {@code &}, newline, backtick, {@code $(} / {@code )}); token boundaries are
     * whitespace, redirections and parentheses. Quote characters are already gone
     * by the time this runs, which is the "see through quoting" requirement.
     */
    private static List<List<String>> commandSegments(String cmd) {
        List<List<String>> out = new ArrayList<List<String>>();
        List<String> cur = new ArrayList<String>();
        StringBuilder tok = new StringBuilder();
        for (int i = 0; i < cmd.length(); i++) {
            char c = cmd.charAt(i);
            if (c == ';' || c == '|' || c == '&' || c == '\n' || c == '\r'
                    || c == '`' || c == '$' || c == '(' || c == ')') {
                if (tok.length() > 0) {
                    cur.add(tok.toString());
                    tok.setLength(0);
                }
                if (cur.size() > 0) {
                    out.add(cur);
                    cur = new ArrayList<String>();
                }
                continue;
            }
            if (c == '\\' && i + 1 < cmd.length()) {
                // POSIX: a backslash escapes the next character, so `r\m` IS
                // `rm`. Dropping it instead splits the token, which let
                // `r\m -rf /sdcard/x` through the floor while mksh executed it
                // as rm without complaint.
                tok.append(cmd.charAt(i + 1));
                i++;
                continue;
            }
            if (c == ' ' || c == '\t' || c == '<' || c == '>') {
                if (tok.length() > 0) {
                    cur.add(tok.toString());
                    tok.setLength(0);
                }
                continue;
            }
            tok.append(c);
        }
        if (tok.length() > 0) {
            cur.add(tok.toString());
        }
        if (cur.size() > 0) {
            out.add(cur);
        }
        return out;
    }
}
