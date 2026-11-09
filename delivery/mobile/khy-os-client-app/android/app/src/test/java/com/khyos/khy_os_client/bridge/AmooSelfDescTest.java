// khy-canary: Khy-20261101-043-5XNGWTB1
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * AmooSelfDescTest — the drift guard on what we tell Amoo about ourselves.
 *
 * WHY the drift guard is the important test here. Amoo runs in the cloud with
 * no prior knowledge of khy-os, so this description is its ONLY source of truth
 * about what the bridge can do. If it drifts from Tools.NAMES the failure is
 * the worst kind available: the model emits a tool name that no longer exists,
 * dispatch rejects it as unknown_action, and the run looks like a model problem
 * rather than a stale-description problem. A red test is the only cheap fix.
 */
public class AmooSelfDescTest {

    @Test
    public void groupsCoverEveryToolExactlyOnce() {
        assertTrue("自描述的分组没有完整覆盖 Tools.NAMES——有工具被漏掉或重复",
                AmooSelfDesc.groupsCoverEveryToolExactlyOnce());
    }

    @Test
    public void renderMentionsEveryToolName() {
        String s = AmooSelfDesc.render();
        for (String n : Tools.NAMES) {
            // 凭据投递那四个故意不给 Amoo 看：要人在手机旁输确认码，云端的助手
            // 永远满足不了，列出来只会诱使它去试。排除集从 SelfDesc 取，不在这里
            // 抄第二份——抄了就会在它变更时指向错误的原因。
            if (SelfDesc.excludedFromDescription().contains(n)) {
                assertFalse("被声明为「不该被知道」的工具却出现在自描述里: " + n, s.contains(n));
                continue;
            }
            assertTrue("自描述里没有工具 " + n, s.contains(n));
        }
    }

    @Test
    public void renderStatesTheShapeRuleNotTheFenceProtocol() {
        String s = AmooSelfDesc.render();
        // The fence protocol is unusable on this device — Amoo renders markdown
        // code blocks into structured UI and the fence lines never reach the
        // accessibility tree. Sending Amoo down that path wastes a turn.
        assertTrue(s.contains("JSON"));
        assertTrue(s.contains("tool"));
        assertTrue("必须告诉 Amoo 不要用代码块包裹", s.contains("不要用"));
        assertTrue("必须说清围栏不可用", s.contains("围栏"));
    }

    @Test
    public void renderStatesTheDivisionOfLabourNotJustTheTools() {
        // THE section. Amoo's own guidelines forbid it from in-app tapping and
        // require it to refuse GUI requests outright. Without this section it
        // answers "I can't do that" to every phone action; with it, it emits a
        // command instead. Everything else here is secondary to this.
        String s = AmooSelfDesc.render();
        assertTrue("必须说清 Amoo 自己不能点按", s.contains("不能") && s.contains("点按"));
        // 原来断言的是「补的」这个措辞。 rewritten 后那句话没了，但意图没变，
        // 而且能断言得更硬：必须把 khy-os 的能力逐项列出来。只泛泛说"它能帮你"
        // 的话，模型不知道能帮到什么程度，还是会往窄了猜。
        assertTrue("必须说清 khy-os 就在这台手机上", s.contains("就在这台手机上"));
        assertTrue("必须逐项列出 khy-os 的能力：点", s.contains("点"));
        assertTrue("必须逐项列出 khy-os 的能力：滑", s.contains("滑"));
        assertTrue("必须逐项列出 khy-os 的能力：输入", s.contains("输入"));
        assertTrue("必须逐项列出 khy-os 的能力：读写文件", s.contains("读写文件"));
        assertTrue("必须逐项列出 khy-os 的能力：执行命令", s.contains("执行命令"));
        // 措辞从「不要回答做不到」改成了「正确做法不是回答做不到」——后者先说该
        // 做什么，再说别做什么，对模型的约束更明确。这里钉死实际用词：改写这段话
        // 的人必须是有意识地改，而不是不小心把这条指令删掉了。
        assertTrue("必须给出「不是回答做不到」的明确指令",
                s.contains("不是回答做不到") && s.contains("正确做法"));
    }

    @Test
    public void renderNamesTheExactThingsAmooDisclaimed() {
        // Regression guard, and the reason this text was rewritten.
        //
        // Amoo once answered a "open this file in the file manager" request by
        // moving the file somewhere shallow, then said: "替你在 App 里逐级点进
        // 某个深层目录，或者点开这个文件开始阅读，我还是做不到". It never once
        // said "so khy-os will do that part" — it stopped at its own boundary.
        //
        // Naming those specific capabilities is what turns a flat refusal into a
        // hand-off. A generic "you can't tap" leaves the model to guess which
        // actions count, and it guesses narrowly.
        String s = AmooSelfDesc.render();
        assertTrue("必须点名逐级进入深层目录", s.contains("深层目录"));
        assertTrue("必须点名滑动", s.contains("滑动"));
        assertTrue("必须点名点开文件读取", s.contains("点开") && s.contains("读"));
    }

    @Test
    public void renderSaysPartialWorkDoesNotCloseTheQuestion() {
        // The other half of the same regression. Amoo DID find a workaround
        // within its own reach (relocating the file) and treated the task as
        // answered. That is the trap: a partial solution feels like a solution.
        //
        // The rule has to be stated as a conditional on the REMAINDER, not as
        // "always emit a command" — that would make it emit commands for things
        // it can simply do itself, which is worse.
        String s = AmooSelfDesc.render();
        assertTrue("必须说清先做一部分不抵消剩下的",
                s.contains("不抵消"));
        assertTrue("必须把条件说成「还有一步需要界面操作」",
                s.contains("还有一步") && s.contains("界面操作"));
    }

    @Test
    public void renderSaysAmooDoesNotNeedToReachTheBridge() {
        // Regression guard, from a real exchange.
        //
        // Amoo correctly observed that the bridge is up on the phone and that it
        // had no connectivity to port 8896 — then concluded the bridge was
        // therefore unusable and proposed exposing it over a tunnel. Both halves
        // are wrong for the same reason: it assumed reaching the bridge was ITS
        // job. It isn't. khy-os reads the command out of the conversation and
        // makes the loopback call itself.
        //
        // Left unaddressed, this produces exactly the failure the whole
        // reverse-proxy exists to avoid: "I can't reach it, so I can't do it."
        String s = AmooSelfDesc.render();
        assertTrue("必须说清桥只监听本机回环", s.contains("回环"));
        assertTrue("必须说清连桥不是 Amoo 的活儿", s.contains("连桥不是你的活儿"));
        assertTrue("必须说清写命令才是它的活儿", s.contains("写命令才是"));
        // And it must pre-empt the tunnel proposal, which would put an
        // arbitrary-command executor on the network.
        assertTrue("必须明确拒绝把桥对外开放", s.contains("对外开放"));
        assertTrue("必须说明对外开放等于远程命令入口", s.contains("远程入口"));
    }

    @Test
    public void renderStatesTheLimitKhyOsAlsoCannotCross() {
        // Honesty in both directions. Telling Amoo about capabilities it lacks
        // makes it use them; telling it about one it does NOT have stops it
        // promising the impossible. Another app's private directory is exactly
        // that: shell uid cannot read it, and the sidecar runs as shell.
        //
        // Without this line Amoo either promises to read it (and fails) or
        // invents a plausible-sounding workaround.
        String s = AmooSelfDesc.render();
        assertTrue("必须说清应用私有目录这条边界", s.contains("私有目录"));
        assertTrue("必须要求它直接说明读不到，不承诺",
                s.contains("读不到"));
        assertTrue("必须禁止绕成别的说法", s.contains("绕成"));
    }

    @Test
    public void renderCarriesNoInternalIdentifiers() {
        // Amoo's own red lines forbid it from echoing internal package names,
        // ports and absolute paths back to the user. A preamble that hands it
        // those strings sets a trap it cannot avoid springing — it would either
        // break its own rule or drop the information it needs.
        String s = AmooSelfDesc.render();
        assertFalse("不能出现包名", s.contains("com.khyos"));
        assertFalse("不能出现端口号", s.contains("8896"));
        assertFalse("不能出现绝对路径", s.contains("/sdcard/"));
        assertFalse("不能出现 /data 路径", s.contains("/data/"));
        // Tool names are the API contract and must stay; everything else that
        // looks like an identifier must not. The credential-provisioning four are
        // the one exception — see SelfDesc.EXCLUDED_FROM_DESCRIPTION for why the
        // assistant must not be told they exist.
        for (String n : Tools.NAMES) {
            if (SelfDesc.excludedFromDescription().contains(n)) {
                assertFalse("被排除的工具却出现在自描述里: " + n, s.contains(n));
                continue;
            }
            assertTrue(s.contains(n));
        }
    }

    @Test
    public void renderStatesTheCloudBoundarySoAmooDoesNotWasteATurn() {
        String s = AmooSelfDesc.render();
        assertTrue("必须说清 Amoo 自己的执行环境在云端", s.contains("云端"));
        // 泛化说法，不用裸路径——这条保持不变。
        assertTrue("必须用「手机存储」这个泛化说法", s.contains("手机存储"));
    }

    /**
     * 那句错的边界话必须已经改掉，而且断言要跟着改。
     *
     * 原断言只查 contains("手机存储")，所以把「手机存储对你不存在」换成任何
     * 别的含这四个字的句子它都绿——包括把错的改成更错的。实测 Amoo 往
     * /sdcard/Download 写过 apk 和 zip（AMOO-INTEGRATION.md §一），所以旧句子
     * 是假的，而它每次对话都注入。
     *
     * 这条测试就是那个"决定措辞的同时决定断言"的落点：它钉住**新的事实陈述**，
     * 不只是钉住一个子串。下一个人如果再改这句话，必须同时改这里，
     * 而那时他会不得不重新读一遍实测依据。
     *
     * 2026-10-30: the second misalignment, fixed here. The wrong sentence as it
     * actually appears is SelfDesc.java:124's 「不要说『手机存储对我不存在』」 — the
     * 「我」 is the assistant's own voice, so that line is a prohibition, not a
     * claim. What this test had been asserting all along was
     * contains("手机存储对你不存在"), a string that does not exist in the render:
     * vacuously green, and blind to any rewording. It now pins the sentence the
     * render really contains, and only in its 「不要说」 quoted form — stated on
     * its own it is the sentence measurement proved false.
     */
    @Test
    public void renderNoLongerClaimsPhoneStorageDoesNotExist() {
        String s = AmooSelfDesc.render();
        assertTrue("必须点名那句错话并禁止说它：不要说「手机存储对我不存在」",
                s.contains("不要说「手机存储对我不存在」"));
        int at = s.indexOf("手机存储对我不存在");
        assertTrue("那句错话只能以「不要说」的引用形式出现，不能单独成句",
                at >= 0 && at == s.lastIndexOf("手机存储对我不存在")
                        && s.substring(0, at).endsWith("不要说「"));
        // 而且必须换成可达性陈述，不是把那句话删掉了事——删掉会让模型
        // 回到"我不知道存不存在"的状态，那同样浪费一轮。
        assertTrue("必须说清共享存储经文件工具可达",
                s.contains("可达"));
        assertTrue("必须告诉它读写要带绝对路径",
                s.contains("绝对路径"));
    }

    /**
     * The four differences from the pre-rewrite text are deliberate. Pinned here.
     *
     * khyos-decouple-report once wrote 「SelfDesc.render() 与改造前逐字节相同」 as the
     * criterion and offered 「AmooSelfDescTest 全绿」 as its evidence. Neither half
     * holds: the bytes are NOT identical (these four differences), and a green
     * suite only proves the existing assertions did not fire — it cannot prove
     * byte equality. Criterion and evidence are now written separately in that
     * record; the four differences themselves are gated by this test. The content
     * stays, but anyone rewording the prose or adding a tool name has to pass
     * here deliberately rather than quietly changing one of them back.
     */
    @Test
    public void renderKeepsTheFourDeliberateDifferencesFromThePreRewriteText() {
        String s = AmooSelfDesc.render();
        // Difference 1: the title 【边界，先说清楚免得白跑】 was cut to 【边界】. What was
        // cut is rhetoric, not constraint — every character is paid for out of
        // writeBack's 1500-character box, pinned by
        // CapabilitySnapshotTest.theCapabilityParagraphDoesNotPushTheMemoryOutOfTheBox.
        assertTrue("【边界】这个标题被动过", s.contains("【边界】"));
        assertFalse("标题不该把「先说清楚免得白跑」这类修辞加回来",
                s.contains("先说清楚免得白跑"));
        // Difference 2: the suffix 「——那是错的」 was dropped. 「不要说 X」 is already a
        // negation; the suffix was the same negation a second time.
        assertFalse("不该把尾缀「——那是错的」加回来", s.contains("——那是错的"));
        // Differences 3 and 4: adou_signin joined 「应用与系统」, amoo_stop joined
        // 「反代与记忆」. groupsCoverEveryToolExactlyOnce only guarantees each name
        // appears exactly once — not that it sits in the right group. A misplaced
        // name leaves that assertion just as green, while the assistant reads the
        // group label to guess what a tool is for.
        assertTrue("adou_signin 必须落在「应用与系统」组",
                groupLine(s, "应用与系统").contains("adou_signin"));
        assertTrue("amoo_stop 必须落在「反代与记忆」组",
                groupLine(s, "反代与记忆").contains("amoo_stop"));
    }

    /** The rendered line that opens a tool group ("label："), or "" if absent. */
    private static String groupLine(String rendered, String label) {
        for (String line : rendered.split("\n")) {
            if (line.startsWith(label + "：")) {
                return line;
            }
        }
        return "";
    }

    @Test
    public void renderIsStableAcrossCalls() {
        // Prompt caching depends on byte stability. A description that reordered
        // itself between calls would defeat that for no benefit.
        assertEquals(AmooSelfDesc.render(), AmooSelfDesc.render());
    }

    @Test
    public void renderStaysUnderTheContextBudget() {
        String s = AmooSelfDesc.render();
        assertTrue("自描述 " + s.length() + " 字符，超出预算 " + AmooSelfDesc.MAX_CHARS,
                s.length() <= AmooSelfDesc.MAX_CHARS);
        // And it must not have been silently emptied by the clamp either.
        assertTrue(s.contains("khy-os"));
        assertTrue(s.contains("【可用的工具】"));
    }

    @Test
    public void renderIsNeverNullOnAnEmptyToolSet() {
        // Defensive: if NAMES ever became empty the render must still produce
        // something usable rather than a blank preamble.
        assertNotNull(AmooSelfDesc.render());
        assertFalse(AmooSelfDesc.render().length() == 0);
    }
}
