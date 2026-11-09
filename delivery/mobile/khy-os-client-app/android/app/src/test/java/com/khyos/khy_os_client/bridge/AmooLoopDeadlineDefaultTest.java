// khy-canary: Khy-20261101-036-DGYS25R2
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * AmooLoopDeadlineDefaultTest — the guard for a default that silently drifted
 * below the round cap.
 *
 * THE DEFECT: {@code Options.deadlineMs} was 600000L (10 min) while
 * {@code Options.maxRounds} was 30. One Amoo round trip measures ~6 minutes on
 * this device, so the loop was cut off by {@link LoopState#DEADLINE} about four
 * minutes into Amoo's SECOND turn, every time — and
 * {@link LoopState#MAX_ROUNDS} was unreachable dead code. A round cap that can
 * never bind is worse than no round cap: it reads as a limit in the source and
 * in the published tool schema ({@code phoneBridgeCatalog.js} describes
 * {@code max_rounds} as "循环轮数上限，默认 30"), so a reader reasonably assumes
 * 30 rounds can happen. They could not.
 *
 * WHY THIS TEST AND NOT A COMMENT. The failure mode is a single constant being
 * edited without re-deriving the other one. A comment cannot catch that; a test
 * can. If someone raises {@code maxRounds} without raising the deadline, this
 * goes red and says exactly which two numbers disagree.
 *
 * The bound is a RANGE, not a derivation. A round is a new bubble, and the
 * loop's own write-backs are new bubbles too (see AmooLoop's class javadoc note
 * 2 — {@code writeBack} types into Amoo's box and taps send), so a turn that
 * carried commands costs 2 rounds and one that carried none costs 1. The
 * rounds-per-turn ratio is therefore in [1, 2], and 30 rounds at ~6 min/turn is
 * 90-180 min. The assertion uses the CONSERVATIVE end (ratio 1) because that is
 * the only range that keeps MAX_ROUNDS binding under every admissible ratio.
 *
 * No device needed: {@code new AmooLoop.Options()} is a plain field assignment,
 * and {@code AmooAskPreambleTest} already loads AmooLoop's statics on a bare JVM.
 */
public class AmooLoopDeadlineDefaultTest {

    /** One Amoo round trip, measured on the device. Recorded in five places:
     *  AmooLoop.java class javadoc note 4, Options.injectMemory's javadoc,
     *  runLoop's AMOO-THINKS comment, Tools.java's amoo_ask note, and
     *  AMOO-INTEGRATION.md's timing row. If this number is ever re-measured,
     *  update it here too — a stale value makes this guard stale with it. */
    private static final long MEASURED_TURN_MS = 6L * 60 * 1000;

    @Test
    public void deadlineDefaultCoversEveryRoundMaxRoundsAllows() {
        AmooLoop.Options o = new AmooLoop.Options();
        long needed = o.maxRounds * MEASURED_TURN_MS;
        assertTrue(
                "deadlineMs=" + o.deadlineMs + " 小于 maxRounds=" + o.maxRounds
                        + " 条轮次所需的最短时间 " + needed + "ms（约 "
                        + (needed / 60000) + " 分钟）。"
                        + "后果：LoopState.MAX_ROUNDS 永远不可达，循环会在 Amoo 第二轮中途"
                        + "被墙钟掐掉。请按 AmooLoop.Options.deadlineMs 的注释重新推导，"
                        + "或者反过来调低 maxRounds——不要只改其中一个。",
                o.deadlineMs >= needed);
    }

    @Test
    public void theRoundCapIsActuallyReachable() {
        // The point of the fix, stated positively: with the default deadline,
        // shouldStop must be able to return MAX_ROUNDS. Otherwise the round cap
        // is decoration and the published schema (phoneBridgeCatalog.js's
        // "max_rounds，默认 30") is a promise the code cannot keep.
        LoopState.State s = new LoopState.State();
        s.maxRounds = new AmooLoop.Options().maxRounds;
        s.deadlineMs = new AmooLoop.Options().deadlineMs;
        s.round = s.maxRounds;      // exactly at the cap
        s.elapsedMs = 0L;           // and nowhere near the clock
        LoopState.Verdict v = LoopState.shouldStop(s);
        assertTrue("轮数上限必须能独立于墙钟触发", v.stop);
        assertTrue("此时停止原因必须是轮数上限，不是时间上限",
                LoopState.MAX_ROUNDS.equals(v.reason));
    }

    @Test
    public void theDeadlineIsStillABackstopForAReplyThatNeverComes() {
        // Raising the deadline must not have removed the backstop. A loop where
        // Amoo never answers again has to stop on the clock, not spin forever.
        LoopState.State s = new LoopState.State();
        s.maxRounds = 30;
        s.deadlineMs = new AmooLoop.Options().deadlineMs;
        s.round = 1;                        // nowhere near the round cap
        s.elapsedMs = s.deadlineMs;         // but the clock ran out
        LoopState.Verdict v = LoopState.shouldStop(s);
        assertTrue(v.stop);
        assertTrue("时钟仍是兜底", LoopState.DEADLINE.equals(v.reason));
    }

    @Test
    public void thePcSidePollCapIsDeliberatelyNotThisNumber() {
        // Documents the divergence recorded in Options.deadlineMs's javadoc, so
        // the next reader does not "fix" it. amooDispatchPlan.js keeps
        // capMs = 600000: that bounds the PC's poll phase, which does not occupy
        // a phone screen. This value bounds a foreground loop on the device.
        // Different quantities; keeping them equal would be the mistake.
        //
        // Asserted as a number here rather than left in a comment, because the
        // comment is exactly what got ignored the first time.
        assertTrue("PC 侧轮询上限应保持 600000（不同预算，不是本类的默认值）",
                new AmooLoop.Options().deadlineMs != 600000L);
    }
}
