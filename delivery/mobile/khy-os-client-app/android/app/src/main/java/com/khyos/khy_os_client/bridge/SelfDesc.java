// khy-canary: Khy-20261101-018-VQ2YFS5H
package com.khyos.khy_os_client.bridge;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * SelfDesc — the generated introduction the bridge hands to an assistant.
 *
 * WHY THIS IS GENERATED AND NOT WRITTEN. The previous version of this text was
 * one hand-written block. Its tool list was derived from {@link Tools#NAMES}
 * and could not drift; its prose could, and did — it once told every
 * conversation that the phone's storage did not exist for the assistant, which
 * was measured false. A wrong sentence injected on every turn is worse than no
 * sentence: it makes the assistant reason from a false premise.
 *
 * So the prose is assembled from three mechanical sources instead:
 *
 *   1. the tool directory — always {@link Tools#CATALOG} / {@link Tools#NAMES},
 *      never a hand-copied list, so a new tool appears everywhere at once;
 *   2. a {@link CapabilitySnapshot} — what the phone can do RIGHT NOW, so the
 *      assistant is told which of those tools will actually work;
 *   3. the {@link AssistantProfile} — which of the conditional paragraphs are
 *      true of the assistant being addressed.
 *
 * That third source is what makes this portable. Three of the old paragraphs
 * assert things that are true of Amoo and false of an on-device assistant;
 * they are now selected on flags rather than assumed.
 *
 * WHY THE CAPABILITY PARAGRAPH COMES AFTER THE TOOLS. {@code AmooLoop.forAmoo}
 * abbreviates the preamble to 1500 characters, and a test asserts that
 * {@code 【可用的工具】} survives that cut. Anything inserted before the tool
 * table pushes it out. The capability paragraph is the one place where order
 * is load-bearing, so it is stated here rather than left to whoever adds the
 * next section.
 *
 * WHY EVERY STRING HERE AVOIDS INTERNAL IDENTIFIERS. {@code AmooSafe} rewrites
 * paths, package names, ports, resource ids and OS versions out of everything
 * the bridge sends outward, and a test asserts the rendered description is
 * already clean — {@code wouldChange(render()) == false}. So this text says
 * 「本地端口」 and never 8896, 「手机存储」 and never a slash path, and no
 * {@code Android <n>} (the version rule is whitespace-anchored and would fire).
 * Adding a phrase that trips the sanitiser fails that test rather than
 * corrupting the text at runtime, which is the intended trade.
 *
 * Contract: pure and deterministic. No Android imports, no clock, no map whose
 * iteration order is not fixed — prompt caching depends on byte stability, and
 * {@code AmooSelfDescTest} pins that two renders in one JVM are equal.
 */
public final class SelfDesc {

    private SelfDesc() {}

    /** Hard ceiling on the rendered description. The assistant's context is not free. */
    public static final int MAX_CHARS = 2600;

    /**
     * Render the introduction for one assistant, given what the phone can do.
     *
     * @param profile which assistant is being addressed
     * @param snap    live capability state; never null
     */
    public static String render(AssistantProfile profile, CapabilitySnapshot snap) {
        AssistantProfile p = profile == null ? AssistantProfile.AMOO : profile;
        CapabilitySnapshot s = snap == null ? CapabilitySnapshot.none() : snap;

        StringBuilder sb = new StringBuilder();
        sb.append("【khy-os 是什么】\n");
        sb.append("khy-os 是跑在这台手机上的执行器。它有一个桥，下面这些工具由它在手机本地真实执行。\n\n");

        // ── ① tools: derived, never hand-written ──
        sb.append("【可用的工具】\n");
        for (Map.Entry<String, String[]> e : groups(p).entrySet()) {
            sb.append(e.getKey()).append("：");
            for (String n : e.getValue()) {
                sb.append(' ').append(n);
            }
            sb.append('\n');
        }
        sb.append('\n');

        // ── ② what works right now: the section that makes "accurate use" possible ──
        sb.append(capabilityParagraph(s));

        // ── ③ division of labour: only when the assistant cannot drive a GUI ──
        if (!p.hasGuiAbility) {
            sb.append("【分工：你出指令，khy-os 执行】\n");
            sb.append("你自己不能在 App 界面里点按、不能滑动、不能逐级进入深层目录、也不能点开一个文件开始读。\n");
            sb.append("这些你一律回答做不到——但「做不到」只限于你自己，不限于这件事。\n");
            sb.append("khy-os 就在这台手机上，能真实地点、滑、输入、读写文件、执行命令。\n");
            sb.append("所以正确做法不是回答做不到，而是把需要点按／进入／读取的那部分写成下面的命令，交给 khy-os 执行。\n");
            sb.append("你自己能顺手做一部分时（比如把文件挪到浅层目录）可以先做，但那不抵消剩下的部分：\n");
            sb.append("只要还有一步需要界面操作，那一步就必须变成命令，不能留着说做不到。\n\n");
        }

        // ── ④ how to issue a command: the fence advice is device-specific ──
        sb.append("【怎么下达命令】\n");
        sb.append("单独占一整行，恰好是一个 JSON 对象，且它的 tool 是上面列出的真实工具名。例如：\n");
        sb.append("{\"tool\":\"toast\",\"args\":{\"text\":\"已完成\"}}\n");
        if (p.eatsCodeFences) {
            sb.append("不要用 ``` 代码块包裹——这台设备上围栏会被渲染器吃掉，拦截层看不到。\n");
        }
        sb.append("带任何非空白前缀（编号、列表符、引号、反引号）的行会被当作普通文字忽略。\n\n");

        // ── ⑤ the loopback boundary: only meaningful for a remote assistant ──
        if (p.cloudBrain) {
            sb.append("【你不需要连那个桥——这条最容易被搞错】\n");
            sb.append("桥跑在手机内部，只监听本机回环，你和云端都连不到它，也不需要连。\n");
            sb.append("分工是：你把命令写在这个对话里，khy-os 在手机本地读到它、替你去连桥、把结果写回这个对话。\n");
            sb.append("所以不要说「我连不上桥所以做不到」——连桥不是你的活儿，写命令才是。\n");
            sb.append("也不要提议把桥对外开放或经隧道暴露：那会在手机上开一个能执行任意命令的远程入口，不做。\n\n");
        }

        // ── ⑥ the limits ──
        // 标题不带「先说清楚免得白跑」：那是修辞。写下来的硬约束是
        // CapabilitySnapshotTest.theCapabilityParagraphDoesNotPushTheMemoryOutOfTheBox——
        // 描述 + 一条典型记忆必须仍装得进 writeBack 的 1500 字框里。加一个工具名
        // （amoo_stop，10 字符）就把那一项顶到 1507，所以新增内容必须在这里付费。
        // 砍的两处都是纯强调句，信息量一句没少。
        sb.append("【边界】\n");
        if (p.cloudBrain) {
            sb.append("你自己的执行环境在云端；但手机的共享存储（本桥称作「手机存储」）"
                    + "经上面的文件工具可达，你已经实测往里面写过文件。\n");
            // 同上：「不要说 X」本身已经是否定句，尾缀「——那是错的」是第二遍。
            sb.append("要读写它就带绝对路径，不要说「手机存储对我不存在」。\n");
        } else {
            sb.append("手机的共享存储（本桥称作「手机存储」）经上面的文件工具可达，要读写它就带绝对路径。\n");
        }
        sb.append("结果会由桥写回这个对话，你接着往下说就行。\n");
        sb.append("有一条 khy-os 也做不到：某个应用自己的私有目录（只有那个应用本身和 root 能读）。\n");
        sb.append("遇到这种路径，直接说明读不到；不要承诺，也不要绕成别的说法。\n");

        return clamp(sb.toString());
    }

    /**
     * Group the bridge's tools for presentation.
     *
     * Keys are Chinese group labels (read by a model and by a human, so
     * user-facing); values are the exact tool names as they appear in
     * {@link Tools#NAMES}. Order is preserved so the rendering is stable across
     * runs — an unstable description would change the prompt bytes on every
     * call and defeat prompt caching.
     *
     * The loop group's label comes from the profile because it is the one group
     * whose name names an assistant. The others describe a mechanism, not a
     * counterparty, and are the same for everyone.
     */
    private static Map<String, String[]> groups(AssistantProfile p) {
        Map<String, String[]> g = new LinkedHashMap<String, String[]>();
        g.put("文件", new String[] {
            "ls", "read", "write", "mkdir", "rm", "mv", "cp", "stat", "zip", "unzip",
        });
        g.put("执行", new String[] {"exec"});
        g.put("应用与系统", new String[] {
            "start_app", "open_url", "list_apps", "share_text", "clipboard",
            "toast", "notify", "battery", "volume", "brightness", "vibrate", "adou_signin",
        });
        g.put("屏幕与手势", new String[] {
            "ui_dump", "ui_tap", "ui_click", "ui_swipe", "ui_longpress", "ui_type",
            "ui_back", "ui_home", "ui_recents", "shot", "shot_b64",
        });
        g.put(p.toolGroupLabel.isEmpty() ? "助手循环" : p.toolGroupLabel,
                new String[] {"loop_start", "loop_stop", "loop_status"});
        g.put("反代与记忆", new String[] {"amoo_ask", "amoo_result", "amoo_memory", "amoo_stop"});
        g.put("探活与自述", new String[] {"ping", "info", "tools"});
        return g;
    }

    /**
     * The 「此刻能用什么」 paragraph.
     *
     * WHY IT IS THIS TERSE. {@code ask()} sends the preamble through
     * {@code writeBack}, which abbreviates to {@code maxWriteBackChars} — 1500,
     * measured against Amoo's input box. The description and the verified-memory
     * layer share that one box, and the memory is appended AFTER the
     * description, so every character added here pushes a remembered fact off
     * the end. That is not hypothetical: the first draft of this paragraph was
     * ~400 characters and it silently truncated the memory layer away, which
     * {@code AmooLoopPipelineTest} caught. Hence three short lines — and hence
     * the pointer to {@code info} for the elevation detail rather than a second
     * copy of {@code elevationAdvice}: forking that wording across two files is
     * exactly the drift {@link Tools#elevationAdvice} exists to prevent.
     *
     * The three things reported, in the order the assistant needs them:
     *   1. whether the UI tools work — the largest group, and the one gated on
     *      a permission the user has to grant;
     *   2. whether {@code exec} is really elevated — an unelevated exec reports
     *      success while changing nothing, the hardest failure to spot from
     *      outside;
     *   3. how much read budget is left, so it batches rather than discovering
     *      the ceiling by hitting it.
     */
    private static String capabilityParagraph(CapabilitySnapshot s) {
        StringBuilder sb = new StringBuilder();
        sb.append("【此刻能用什么】\n");

        if (s.ui) {
            sb.append("无障碍已开：界面自动化与截图可用。\n");
        } else {
            sb.append("无障碍没开：ui_ 开头的工具与 shot 此刻不可用——差授权，"
                    + "不是做不到，别回答「无法操作界面」，告诉用户差这一步授权。\n");
        }

        if (s.elevated()) {
            sb.append("提权已就绪：exec 以 shell 身份跑。\n");
        } else if (s.elevationUnconfirmed) {
            // 第三种状态，2026-10-26 真机逼出来的。sidecar 答了 PING 但还没有
            // 任何一次 exec 证实过它（ready 刻意悲观）。此时说"已就绪"是未经
            // 证实的断言，说"改不动系统"是假的——紧接着第一次 exec 就会成功。
            // 所以让它去试，并说清为什么不确定。
            sb.append("提权通道可能已就绪但尚未证实：先跑一条 exec 试试，"
                    + "成功了就当它可用，失败了再看来电的那条路。\n");
        } else {
            sb.append("提权未就绪：exec 以 App 身份跑，input／am／pm 看起来成功"
                    + "但改不动系统；两条提权路见 info。\n");
        }

        if (s.byteBudget > 0) {
            long leftMb = s.bytesLeft / 1024 / 1024;
            long totalMb = s.byteBudget / 1024 / 1024;
            sb.append("本轮还能读约 ").append(leftMb).append("MB（共 ").append(totalMb)
                    .append("MB），多文件优先打包。\n");
        }

        sb.append('\n');
        return sb.toString();
    }

    /**
     * Tools deliberately absent from the assistant-facing description.
     *
     * <h2>Why an exclusion exists at all</h2>
     * {@link #groupsCoverEveryToolExactlyOnce} otherwise demands every name in
     * {@link Tools#NAMES} appear in exactly one group. That rule is right for almost
     * everything: a name in no group is silently dropped, and the model never learns
     * the tool exists. For these four, the model <b>must</b> not learn they exist.
     *
     * <p>They are the PC-side credential-provisioning path. Writing a sandbox
     * credential requires a code shown in a notification on the phone and a human
     * standing next to it — an assistant running in the cloud can never satisfy that,
     * so listing them would only invite it to try and to report a confusing failure.
     * Advertising them also widens the surface for nothing.
     *
     * <h2>Why this is not a loophole</h2>
     * The set is explicit, tiny and reasoned, and the guard still requires every
     * remaining name to sit in exactly one group. Adding a tool to {@code NAMES} and
     * forgetting it here fails the guard — so the exclusion cannot grow by neglect.
     *
     * <h2>The other reason: the box is full</h2>
     * The description shares {@code writeBack}'s 1500-character box with the verified
     * memory layer, and memory is appended after it — so every character added here
     * pushes a remembered fact off the end. That is measured, not theoretical: see
     * {@code CapabilitySnapshotTest.theCapabilityParagraphDoesNotPushTheMemoryOutOfTheBox}
     * and the note above 【边界】, where adding the ten characters of {@code amoo_stop}
     * alone pushed the total to 1507. These four names plus their group label cost
     * about fifty. Spending them on tools the assistant cannot use would be the worst
     * possible trade.
     */
    private static final java.util.Set<String> EXCLUDED_FROM_DESCRIPTION =
            java.util.Collections.unmodifiableSet(new java.util.LinkedHashSet<String>(
                    java.util.Arrays.asList(
                            "secret_code", "secret_put", "secret_list", "secret_del")));

    /**
     * The exclusion set, exported so the drift tests can consult it instead of
     * keeping their own copy.
     *
     * <p>A second copy would be exactly the drift this whole file exists to prevent:
     * the set changes, the tests keep asserting the old contents, and the failure
     * message points at the wrong thing.
     */
    public static java.util.Set<String> excludedFromDescription() {
        return EXCLUDED_FROM_DESCRIPTION;
    }

    /**
     * Whether every name in {@link Tools#NAMES} appears in exactly one group, or is
     * deliberately excluded with a reason recorded above.
     *
     * Exported for the drift test: a name in two groups is rendered twice (the
     * model sees a duplicate and may reason about it), a name in none is
     * silently dropped from the description (the model never learns it exists).
     * Both are bugs this catches — except for {@link #EXCLUDED_FROM_DESCRIPTION},
     * where being unknown to the model is the point.
     */
    public static boolean groupsCoverEveryToolExactlyOnce() {
        Map<String, Integer> seen = new LinkedHashMap<String, Integer>();
        for (String[] names : groups(AssistantProfile.AMOO).values()) {
            for (String n : names) {
                Integer c = seen.get(n);
                seen.put(n, c == null ? 1 : c + 1);
            }
        }
        if (seen.size() + EXCLUDED_FROM_DESCRIPTION.size() != Tools.NAMES.length) {
            return false;
        }
        for (String n : Tools.NAMES) {
            Integer c = seen.get(n);
            if (EXCLUDED_FROM_DESCRIPTION.contains(n)) {
                // 排除集中的名字同时也不该出现在任何组里：那会让它既被宣传又被声明为
                // 「不该被知道」，两种说法必有一处是过期的。
                if (c != null) return false;
                continue;
            }
            if (c == null || c != 1) {
                return false;
            }
        }
        return true;
    }

    /** Trim to {@link #MAX_CHARS} on a line boundary, never mid-escape. */
    private static String clamp(String s) {
        if (s.length() <= MAX_CHARS) {
            return s;
        }
        int cut = s.lastIndexOf('\n', MAX_CHARS);
        if (cut <= 0) {
            cut = MAX_CHARS;
        }
        return s.substring(0, cut) + "\n…（自描述过长已截断）";
    }
}
