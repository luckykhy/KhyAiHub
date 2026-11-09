// khy-canary: Khy-20261101-049-8Y70JGQZ
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * DONE 信号的反 fabrication 测试。
 *
 * 核心问题：{@code khy-done} 是 **Amoo 自己声明**完成。让被检查的一方自己签验收单，
 * 正是这套桥要防的事。以前 shouldStop() 一见 doneSignalled 就返回成功语义，
 * 最终报告于是写「Amoo 报告任务完成」——听起来像验收过了。
 *
 * 改后：DONE 仍然停（那是个明确的终止信号，不该空转），但"停"和"成功"分开——
 * 未验证的命令数随 Verdict 带出去，报告必须能写出
 * 「Amoo 声称完成，但 N 条命令未验证/无法验证」。
 */
public class LoopStateDoneSignalTest {

    private static LoopState.State state() {
        LoopState.State s = new LoopState.State();
        s.maxRounds = 10;
        s.deadlineMs = 600000L;
        return s;
    }

    @Test
    public void doneWithNoUnverifiedIsStillSuccess() {
        LoopState.State s = state();
        s.doneSignalled = true;
        s.unverifiedCommands = 0;
        LoopState.Verdict v = LoopState.shouldStop(s);
        assertTrue("DONE 必须停", v.stop);
        assertEquals(LoopState.DONE_SIGNAL, v.reason);
        assertEquals("没有未验证命令时不该带出额外数字", 0, v.unverified);
    }

    @Test
    public void doneCarriesTheUnverifiedCount() {
        // 关键断言：Amoo 说完成，但有 3 条命令没验证过。
        // 这个数字必须能被最终报告拿到——否则它无法告诉用户"别全信"。
        LoopState.State s = state();
        s.doneSignalled = true;
        s.unverifiedCommands = 3;
        LoopState.Verdict v = LoopState.shouldStop(s);
        assertTrue(v.stop);
        assertEquals(LoopState.DONE_SIGNAL, v.reason);
        assertEquals(3, v.unverified);
    }

    @Test
    public void doneStillWinsOverExhaustion() {
        // 优先级不能变：Amoo 说完成时，即使同时撞了轮数/时间上限，
        // 原因也必须是 DONE_SIGNAL——否则一个完成了的任务会被报成超时。
        LoopState.State s = state();
        s.doneSignalled = true;
        s.unverifiedCommands = 2;
        s.round = 99;          // over maxRounds
        s.elapsedMs = 9999999; // over deadline
        LoopState.Verdict v = LoopState.shouldStop(s);
        assertEquals(LoopState.DONE_SIGNAL, v.reason);
        assertEquals(2, v.unverified);
    }

    @Test
    public void negativeUnverifiedIsClamped() {
        // 坏计数不该让报告显示"未验证 -1 条"——那比不显示更让人困惑。
        LoopState.Verdict v = new LoopState.Verdict(true, LoopState.DONE_SIGNAL, -5);
        assertEquals(0, v.unverified);
    }

    @Test
    public void twoArgVerdictDefaultsToZeroUnverified() {
        // 既有调用方（ABORTED / MAX_ROUNDS 等）不传未验证数，必须是 0 而不是垃圾。
        LoopState.Verdict v = new LoopState.Verdict(true, LoopState.MAX_ROUNDS);
        assertEquals(0, v.unverified);
    }

    @Test
    public void abortOutranksDone() {
        // 人工中止优先于一切，包括 DONE——人说要停就不是 Amoo 说完成能盖过去的。
        LoopState.State s = state();
        s.aborted = true;
        s.doneSignalled = true;
        s.unverifiedCommands = 4;
        LoopState.Verdict v = LoopState.shouldStop(s);
        assertEquals(LoopState.ABORTED, v.reason);
    }

    @Test
    public void otherStopReasonsCarryNoUnverifiedClaim() {
        // 只有 DONE 会带未验证数。轮数/时间/停滞这些原因的 unverified 必须是 0，
        // 否则报告会把"超时"也写成"N 条未验证"——那是把两件事混成一件。
        LoopState.State s = state();
        s.round = 10; // hits maxRounds
        LoopState.Verdict v = LoopState.shouldStop(s);
        assertEquals(LoopState.MAX_ROUNDS, v.reason);
        assertEquals(0, v.unverified);
    }

    @Test
    public void keepGoingWhenNothingSignalled() {
        LoopState.Verdict v = LoopState.shouldStop(state());
        assertFalse("什么都没信号时该继续", v.stop);
    }
}
