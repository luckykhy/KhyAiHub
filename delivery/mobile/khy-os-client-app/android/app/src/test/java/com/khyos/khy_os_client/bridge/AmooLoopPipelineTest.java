// khy-canary: Khy-20261101-038-E8FA2HJW
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

/**
 * AmooLoopPipelineTest — the decision path, end to end, with no Android in it.
 *
 * The unit tests prove each pure class in isolation. This one proves they
 * COMPOSE: a realistic Amoo reply goes in one end and a dispatchable decision
 * comes out the other. That is the join where the real bugs hide — a fence that
 * parses but yields a tool the gate cannot classify, a verify block that names a
 * path the writer never touched, a done fence that looks like a command.
 *
 * No device, no bridge, no accessibility service: every step here is pure.
 */
public class AmooLoopPipelineTest {

    /** A reply shaped like what Amoo actually emits: prose around the fences. */
    private static final String REPLY =
            "好的，我来写这个贪吃蛇。先建目录和主文件。\n"
            + "\n"
            + "```khy-plan\n"
            + "{\"goal\":\"写一个能跑的贪吃蛇\",\"done\":\"/sdcard/game/main.py 存在且能运行\"}\n"
            + "```\n"
            + "\n"
            + "下面开始落地：\n"
            + "\n"
            + "```khy-exec\n"
            + "{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/game/main.py\",\"content\":\"print(1)\"},"
            + "\"verify\":{\"kind\":\"read_equals\",\"path\":\"/sdcard/game/main.py\",\"expect_bytes\":9}}\n"
            + "```\n"
            + "\n"
            + "```khy-exec\n"
            + "{\"tool\":\"toast\",\"args\":{\"text\":\"文件已写入\"}}\n"
            + "```\n"
            + "\n"
            + "```khy-exec\n"
            + "{\"tool\":\"rm\",\"args\":{\"path\":\"/sdcard/game\",\"recursive\":true}}\n"
            + "```\n"
            + "\n"
            + "写入完成后我会回报结果。";

    @Test
    public void aRealisticReplyYieldsThreeCommandsInOrder() {
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(REPLY);
        assertEquals(4, fences.size());
        assertEquals(AmooProtocol.FenceKind.PLAN, fences.get(0).kind);
        assertEquals(AmooProtocol.FenceKind.EXEC, fences.get(1).kind);
        assertEquals(AmooProtocol.FenceKind.EXEC, fences.get(2).kind);
        assertEquals(AmooProtocol.FenceKind.EXEC, fences.get(3).kind);
        // The prose between fences is not a command.
        assertFalse(AmooProtocol.hasOpenFence(REPLY));
    }

    @Test
    public void planFenceCarriesTheGoalAndIsNotExecuted() {
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(REPLY);
        AmooProtocol.Fence plan = fences.get(0);
        assertTrue(plan.jsonValid);
        // A PLAN fence is Amoo restating the task, so it carries goal/done and no
        // tool. Feeding it to parseExec therefore fails with missing_tool — which
        // is exactly why the runner must branch on fence.kind and only ever call
        // parseExec for EXEC. This assertion is that guard's proof.
        AmooProtocol.ParseResult r = AmooProtocol.parseExec(plan.payload);
        assertFalse(r.ok);
        assertEquals("missing_tool", r.reason);
    }

    @Test
    public void theThreeCommandsLandOnThreeDifferentVerdicts() {
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(REPLY);
        LoopModes.Mode bypass = LoopModes.defaultMode();

        // 1. A verified write: runs, and has something to prove it.
        AmooProtocol.ParseResult write = AmooProtocol.parseExec(fences.get(1).payload);
        assertTrue(write.ok);
        assertEquals("write", write.tool);
        assertEquals(LoopModes.Action.EXECUTE, LoopModes.decide(bypass, write.tool, write.args).action);
        LoopVerify.Plan wp = LoopVerify.plan(write.tool, write.args, write.verify);
        assertEquals(LoopVerify.Kind.READ_EQUALS, wp.kind);
        assertEquals("/sdcard/game/main.py", wp.path);
        assertEquals(9L, wp.expectBytes);

        // 2. A toast: runs, but there is nothing to verify afterwards.
        AmooProtocol.ParseResult toast = AmooProtocol.parseExec(fences.get(2).payload);
        assertTrue(toast.ok);
        assertEquals(LoopModes.Action.EXECUTE, LoopModes.decide(bypass, toast.tool, toast.args).action);
        assertEquals(LoopVerify.Kind.NONE, LoopVerify.plan(toast.tool, toast.args, toast.verify).kind);

        // 3. An EXPLICITLY recursive rm: the floor catches it even in BYPASS.
        //
        // The fixture used to omit `recursive` and rely on Tools.rm defaulting it
        // to true. That default was flipped to false on 2026-10-25 (a bare
        // `{"path":"/sdcard/DCIM"}` wiped the whole tree), so an absent field is
        // now a single-file delete that fails on a non-empty directory — not a
        // destructive command at all, and the floor correctly stays quiet.
        //
        // The fixture is pinned to `recursive:true` rather than left bare so this
        // keeps guarding the case it was written for. A fixture that stops being
        // destructive would turn a safety test into a tautology.
        AmooProtocol.ParseResult rm = AmooProtocol.parseExec(fences.get(3).payload);
        assertTrue(rm.ok);
        assertEquals(Boolean.TRUE, rm.args.opt("recursive"));
        LoopModes.Decision d = LoopModes.decide(bypass, rm.tool, rm.args);
        assertEquals(LoopModes.Action.CONFIRM, d.action);
        assertTrue(d.floorTripped);
        assertNotNull(d.reason);
    }

    /** A bare rm is no longer a tree delete, so the floor must not fire on it. */
    @Test
    public void aBareRmIsASingleFileDeleteAndDoesNotTripTheFloor() throws Exception {
        // The counterpart to the test above, and the reason the fixture needed
        // changing: with the default now false, `{"path":"/sdcard/game"}` asks for
        // a single-file delete that simply fails on a directory. Blocking it would
        // put a confirmation in front of every ordinary file removal, and a floor
        // that cries wolf is a floor people learn to click through.
        LoopModes.Decision d = LoopModes.decide(LoopModes.defaultMode(), "rm",
                new JSONObject("{\"path\":\"/sdcard/game/main.py\"}"));
        assertFalse(d.floorTripped);
        assertNotNull(d.reason);
    }

    /**
     * The safety floor is not optional, and it is not bypassable by mode.
     *
     * This is the property the whole design rests on: the human chose BYPASS as
     * the default, and BYPASS must still refuse to delete a directory tree.
     *
     * The invariant asserted here is "never EXECUTE", not "always CONFIRM" —
     * PLAN legitimately answers DEFER for everything, and demanding CONFIRM
     * there would be asserting an implementation detail instead of the property.
     */
    @Test
    public void noModeEverExecutesTheDestructiveCommand() {
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(REPLY);
        AmooProtocol.ParseResult rm = AmooProtocol.parseExec(fences.get(3).payload);
        for (LoopModes.Mode mode : LoopModes.Mode.values()) {
            LoopModes.Decision d = LoopModes.decide(mode, rm.tool, rm.args);
            assertFalse(mode + " must not execute an unqualified recursive rm",
                    d.action == LoopModes.Action.EXECUTE);
            assertTrue(mode + " must report the floor", d.floorTripped);
            assertNotNull(mode + " must explain itself", d.reason);
        }
    }

    /**
     * A code sample that merely SHOWS the protocol must not become a command.
     *
     * Amoo explaining how the bridge works is the most likely way a fake fence
     * enters the transcript, and executing it would be indistinguishable from
     * prompt injection.
     */
    @Test
    public void aCodeSampleShowingTheProtocolIsNotACommand() {
        String reply = "用法是这样：\n"
                + "\n"
                + "```json\n"
                + "{\"example\":\"```khy-exec\\n{\\\"tool\\\":\\\"write\\\"}\\n```\"}\n"
                + "```\n"
                + "\n"
                + "把要执行的命令包在里面就行。";
        assertTrue(AmooProtocol.extractFences(reply).isEmpty());
        assertFalse(AmooProtocol.hasOpenFence(reply));
        // And the real fence after the sample is still found.
        String withReal = reply + "\n\n```khy-exec\n{\"tool\":\"toast\",\"args\":{\"text\":\"hi\"}}\n```";
        assertEquals(1, AmooProtocol.extractFences(withReal).size());
    }

    /** An unclosed fence is waited for, never executed. */
    @Test
    public void aHalfStreamedFenceIsNeverExecuted() {
        String streaming = "我来写文件：\n\n```khy-exec\n{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/g/m";
        assertTrue(AmooProtocol.hasOpenFence(streaming));
        assertTrue(AmooProtocol.extractFences(streaming).isEmpty());
    }

    /** A broken-JSON fence is reported back, not silently dropped. */
    @Test
    public void aBrokenFenceIsSurfacedRatherThanSwallowed() {
        String reply = "```khy-exec\n{\"tool\":\"write\" \"args\":{}}\n```";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(reply);
        assertEquals(1, fences.size());
        assertFalse(fences.get(0).jsonValid);
        AmooProtocol.ParseResult r = AmooProtocol.parseExec(fences.get(0).payload);
        assertFalse(r.ok);
        assertEquals("payload_not_json", r.reason);
        assertNull(r.tool);
    }

    /** The done fence is the only success-shaped exit. */
    @Test
    public void theDoneFenceEndsTheLoopAndNothingElseDoes() {
        String done = "搞定了。\n\n```khy-done\n{\"summary\":\"贪吃蛇已能运行\"}\n```";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(done);
        assertEquals(1, fences.size());
        assertEquals(AmooProtocol.FenceKind.DONE, fences.get(0).kind);
        assertTrue(fences.get(0).jsonValid);
        // Silence is NOT done: the loop reports STALLED, which is a failure.
        LoopState.State quiet = new LoopState.State();
        quiet.maxRounds = 30;
        quiet.deadlineMs = 600_000L;
        quiet.noProgressPolls = 5;
        assertEquals(LoopState.STALLED, LoopState.shouldStop(quiet).reason);
        // An explicit done signal outranks even an exhausted round budget.
        LoopState.State both = new LoopState.State();
        both.maxRounds = 1;
        both.round = 99;
        both.deadlineMs = 600_000L;
        both.doneSignalled = true;
        assertEquals(LoopState.DONE_SIGNAL, LoopState.shouldStop(both).reason);
    }

    /**
     * Chat text is cumulative; only the newest bubble may be acted on.
     *
     * Without this the loop re-executes round 1's commands forever.
     */
    @Test
    public void onlyTheNewestBubbleIsActedOn() {
        String round1 = "第一轮\n\n```khy-exec\n{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/g/a.py\"}}\n```";
        String both = round1 + "\n\n第二轮\n\n```khy-exec\n{\"tool\":\"toast\",\"args\":{\"text\":\"第二步\"}}\n```";
        String newest = AmooChatText.lastChatBlock(both);
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(newest);
        assertEquals(1, fences.size());
        AmooProtocol.ParseResult r = AmooProtocol.parseExec(fences.get(0).payload);
        assertEquals("toast", r.tool);
    }

    /** A verify block naming a path the command never touched must not be trusted blindly. */
    @Test
    public void verifyPathFallsBackToThePathTheCommandActuallyUsed() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/game/real.py").put("content", "x");
        // Amoo mistyped the verify path.
        JSONObject verify = new JSONObject().put("path", "/sdcard/game/typo.py").put("expect_bytes", 1);
        LoopVerify.Plan p = LoopVerify.plan("write", args, verify);
        // Spec: verify.path wins when present. The caller therefore reads back
        // the path Amoo named — which is why a mismatch is reported, not hidden.
        assertEquals("/sdcard/game/typo.py", p.path);
        // With no verify path at all, the command's own path is used.
        assertEquals("/sdcard/game/real.py", LoopVerify.plan("write", args, null).path);
    }

    /** Null and garbage never take the pipeline down. */
    @Test
    public void thePipelineSurvivesGarbageAtEveryStage() {
        String[] junk = {null, "", "   ", "```", "```khy-exec", "```khy-exec\n", "\n\n\n",
                "```khy-exec\nnull\n```", "```khy-exec\n[]\n```", "```khy-exec\n{}\n```"};
        for (String in : junk) {
            List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(in);
            for (AmooProtocol.Fence f : fences) {
                AmooProtocol.ParseResult r = AmooProtocol.parseExec(f.payload);
                // Whatever came out must be classifiable without throwing.
                LoopModes.decide(LoopModes.defaultMode(), r.tool, r.args);
                LoopVerify.plan(r.tool, r.args, r.verify);
            }
            AmooProtocol.parseExec(in);
        }
    }

    // ------------------------------------------------------------------
    // The outbound chokepoint.
    //
    // Everything the bridge hands Amoo goes through AmooLoop.forAmoo. These
    // three tests pin the parts that are easy to break by accident: the ORDER
    // of sanitise-then-abbreviate, that the ask preamble really is covered,
    // and that abbreviate was not dropped in the reorder.
    // ------------------------------------------------------------------

    @Test
    public void forAmooSanitisesBeforeItAbbreviates() {
        // THE subtlest part of the change, and the reason this test exists.
        //
        // abbreviate cuts at a fixed character count, so a path straddling the
        // cut is left as a half-path. Sanitising first rewrites the whole path
        // while it is still whole; abbreviating first leaves a fragment that
        // the path rule can no longer resolve.
        //
        // The filler is exactly 1490 characters (149 x 10), so the path
        // straddles the 1500 cut: raw length 1519, sanitised length 1508.
        // Both orders are computed explicitly below and they differ — this is
        // not an assertion about an implementation detail, it is a
        // demonstration that the order changes the output.
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 149; i++) {
            sb.append("一二三四五六七八九十");
        }
        String in = sb + " /sdcard/Download/词刻.apk TAIL";

        String right = AmooLoop.forAmoo(in);
        // Right order: the whole path was rewritten, so the filename survives
        // even though the text is still cut.
        assertFalse("no absolute path may survive", right.contains("/sdcard"));
        assertTrue("the filename must survive the cut", right.contains("词刻"));
        assertTrue("the reader must still see the truncation marker",
                right.contains("已截断"));

        // Wrong order, computed here rather than asserted from memory: the cut
        // lands mid-path, leaving "/sdcard/D" — which the path rule resolves
        // to a directory label plus the single letter D. The filename is gone
        // and the text now names a file that does not exist.
        String wrong = AmooSafe.sanitise(abbreviateOf(in, 1500));
        assertFalse("the wrong order loses the filename", wrong.contains("词刻"));
        assertTrue("the wrong order invents a file called D",
                wrong.contains("手机存储里的D"));
    }

    /** Local mirror of AmooLoop.abbreviate, so the wrong order can be computed. */
    private static String abbreviateOf(String s, int max) {
        String v = s.trim();
        if (v.length() <= max) {
            return v;
        }
        return v.substring(0, max) + "…（共 " + v.length() + " 字，已截断）";
    }

    @Test
    public void theAskPreambleIsSafeOnceItGoesThroughTheChokepoint() {
        // The preamble is folded into EVERY ask, and it carries verified
        // memory facts — which rememberVerified writes as measured
        // post-states, i.e. with real paths in them. A leak here leaks on
        // every single conversation, not once.
        AmooMemory mem = AmooMemory.empty()
                .with("f1", "read back /sdcard/g/main.py, 11 bytes",
                        AmooMemory.Confidence.VERIFIED, "test");
        AmooLoop.replaceMemory(mem);

        String out = AmooLoop.forAmoo(AmooLoop.buildAskPreamble());
        assertFalse(out.contains("/sdcard"));
        assertTrue(out.contains(AmooSafe.PHONE_STORAGE));
        assertTrue("the measured number is the fact", out.contains("11 bytes"));
        assertTrue("the filename is what the user cares about", out.contains("main.py"));
        // The tool list must still be there — a preamble that lost its tools
        // would leave Amoo unable to act at all.
        assertTrue(out.contains("【可用的工具】"));
    }

    @Test
    public void forAmooStillTruncatesAfterSanitising() {
        // Proves abbreviate was not dropped in the reorder. A clean,
        // path-free 2000-char string must still be cut at 1500.
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 200; i++) {
            sb.append("0123456789");
        }
        String out = AmooLoop.forAmoo(sb.toString());
        assertTrue(out.contains("已截断"));
        assertTrue("the cut is still at 1500", out.startsWith(sb.substring(0, 1500)));
    }

    @Test
    public void forAmooNeverReturnsNullForAnyInput() {
        // An empty write-back is indistinguishable from a dead layer.
        for (String in : new String[] {null, "", "   ", "x", "/", "//", "com.a.b"}) {
            String out = AmooLoop.forAmoo(in);
            assertNotNull(out);
        }
    }

    // ------------------------------- P0-2：环内特判（中止出口 / 自调用拒绝）

    /**
     * {@code amoo_stop} 只在旁路档走紧急出口。
     *
     * <p>为什么只在旁路档：旁路档的定义是「不问我」，而中止的方向是安全的
     * （少做一件事永远比多做一件安全）。计划档与编辑档本来就不执行任何东西，
     * 人要停就自己停；让它们也走紧急出口，等于把「什么都不执行」这一档的语义
     * 改掉。
     */
    @Test
    public void amooStopTakesTheEmergencyPathOnlyInBypass() {
        assertTrue(AmooLoop.isLoopStopCommand(LoopModes.Mode.BYPASS, "amoo_stop"));
        assertFalse("默认档以外的档位不走紧急出口",
                AmooLoop.isLoopStopCommand(LoopModes.Mode.DEFAULT, "amoo_stop"));
        assertFalse(AmooLoop.isLoopStopCommand(LoopModes.Mode.PLAN, "amoo_stop"));
        assertFalse(AmooLoop.isLoopStopCommand(LoopModes.Mode.EDIT, "amoo_stop"));
        assertFalse("别的工具不走紧急出口",
                AmooLoop.isLoopStopCommand(LoopModes.Mode.BYPASS, "amoo_ask"));
    }

    /** 环内自调用提问必须被识别出来（且只有 amoo_ask 是这一类）。 */
    @Test
    public void amooAskIsTheOnlySelfCallCommand() {
        assertTrue(AmooLoop.isLoopAskCommand("amoo_ask"));
        assertFalse(AmooLoop.isLoopAskCommand("amoo_result"));
        assertFalse(AmooLoop.isLoopAskCommand("amoo_stop"));
        assertFalse(AmooLoop.isLoopAskCommand("write"));
    }

    /**
     * 环内拒绝 {@code amoo_ask} 的文案必须说清「确认解决不了」。
     *
     * <p>写成「等确认」会让人一直等一个永远不会到来的确认：环内再问一次 Amoo
     * 必然撞单飞锁（{@code AmooLoop.ask} 第一行就是
     * {@code if (askRunning) return null;}）。
     */
    @Test
    public void theLoopRefusalForAmooAskSaysConfirmationCannotFixIt() {
        String refusal = AmooLoop.loopAskRefusal();
        assertNotNull(refusal);
        assertTrue(refusal.contains("amoo_ask"));
        assertTrue(refusal.contains("单飞锁"));
        assertTrue(refusal.contains("确认也解决不了"));
        assertFalse("不能用「需要人确认后继续」这种把人引到死等的话术",
                refusal.contains("需要人确认后继续"));
    }
}
