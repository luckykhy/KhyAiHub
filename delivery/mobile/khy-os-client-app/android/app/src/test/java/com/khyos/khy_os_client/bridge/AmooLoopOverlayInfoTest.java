package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

import org.junit.Before;
import org.junit.Test;

/**
 * AmooLoopOverlayInfoTest — the state the floating overlay reads every 2s.
 *
 * Pure JVM on purpose: everything the overlay shows (progress, elapsed,
 * write-back outcome, last error, busy) is static volatile memory, and
 * {@code report()} returns on {@code Tools.ctxRef() == null} before it touches
 * anything Android. So the whole overlay-facing surface is testable with no
 * device, no bridge and no accessibility service — which matters, because this
 * state is read on the MAIN thread by the overlay's ticker and must never
 * require IO or a live service to be correct.
 *
 * Reflection is used for the write side (running / askRunning / startedAtMs /
 * report(text, isError)) because the production writers are the loop itself,
 * which needs a live accessibility service to run. That is exactly the state
 * worth pinning down: the overlay can be up and reading while the loop is only
 * partially up, and a wrong answer there is a lie on screen.
 *
 * Covered:
 *   - elapsedMs() is 0 unless the loop is actually running
 *   - busy() covers the loop AND an in-flight amoo_ask
 *   - lastWriteBack()/lastError() start empty
 *   - report(text) does NOT pollute lastError; report(text, true) does
 */
public class AmooLoopOverlayInfoTest {

    @Before
    public void resetOverlayState() {
        // These are process-wide statics shared with the real loop, so every test
        // starts from the idle snapshot the overlay sees on a fresh boot.
        set("running", false);
        set("askRunning", false);
        set("startedAtMs", 0L);
        set("lastWriteBack", "");
        set("lastError", "");
        set("lastReport", "");
    }

    @Test
    public void everythingStartsEmptyAndIdle() {
        assertEquals("", AmooLoop.lastWriteBack());
        assertEquals("", AmooLoop.lastError());
        assertEquals("", AmooLoop.progress());
        assertEquals(0L, AmooLoop.elapsedMs());
        assertFalse(AmooLoop.busy());
        assertFalse(AmooLoop.isRunning());
    }

    @Test
    public void elapsedIsZeroUnlessTheLoopIsRunning() {
        // A timestamp on its own means nothing: the loop may have finished, or
        // never started because the accessibility service was off.
        set("startedAtMs", System.currentTimeMillis() - 5000L);
        assertEquals(0L, AmooLoop.elapsedMs());

        set("running", true);
        long elapsed = AmooLoop.elapsedMs();
        assertTrue("elapsed must cover the 5s the loop has been up, was " + elapsed,
                elapsed >= 4000L && elapsed <= 6000L);

        // runLoop's finally clears running; elapsed must follow it back to 0 with
        // no separate reset of startedAtMs.
        set("running", false);
        assertEquals(0L, AmooLoop.elapsedMs());
    }

    @Test
    public void elapsedIsZeroWhenStartedAtWasNeverSet() {
        set("running", true);
        set("startedAtMs", 0L);
        assertEquals(0L, AmooLoop.elapsedMs());
    }

    @Test
    public void busyCoversBothTheLoopAndAnInFlightAsk() {
        // The badge colours off this, so it must cover the reverse-proxy path
        // too: an amoo_ask is real work even though no loop is running.
        assertFalse(AmooLoop.busy());

        set("askRunning", true);
        assertTrue(AmooLoop.busy());

        set("askRunning", false);
        set("running", true);
        assertTrue(AmooLoop.busy());
    }

    @Test
    public void plainReportDoesNotPolluteLastError() {
        // Status broadcasts and the closing sentence of a good run must NOT
        // become "上一条错误" on the overlay — that line is permanent once set,
        // and a false one teaches the user to ignore it.
        report("循环已启动，模式 BYPASS", false);
        report("循环结束：Amoo 报告任务完成", false);

        assertEquals("循环结束：Amoo 报告任务完成", AmooLoop.lastReport());
        assertEquals("", AmooLoop.lastError());
    }

    @Test
    public void failureReportDoesPolluteLastError() {
        report("读屏失败：xxx，重试中", true);
        assertEquals("读屏失败：xxx，重试中", AmooLoop.lastError());
        assertEquals("读屏失败：xxx，重试中", AmooLoop.lastReport());
    }

    @Test
    public void aLaterPlainReportDoesNotClearTheError() {
        // "Empty means the last report was not a failure — NOT that nothing ever
        // failed." So a plain report after a failure leaves the error standing.
        report("发送失败（重试 3 次仍未成）：坐标点不到", true);
        report("循环结束：达到轮数上限", false);
        assertEquals("发送失败（重试 3 次仍未成）：坐标点不到", AmooLoop.lastError());
    }

    @Test
    public void writeBackOutcomeIsCarriedVerbatim() {
        set("lastWriteBack", "已发送（12 字）");
        assertEquals("已发送（12 字）", AmooLoop.lastWriteBack());
    }

    // ── reflection helpers ──────────────────────────────────────────────────

    private static void set(String field, Object value) {
        try {
            Field f = AmooLoop.class.getDeclaredField(field);
            f.setAccessible(true);
            f.set(null, value);
        } catch (Exception e) {
            throw new AssertionError("cannot set AmooLoop." + field + ": " + e);
        }
    }

    private static void report(String text, boolean isError) {
        try {
            Method m = AmooLoop.class.getDeclaredMethod("report", String.class, boolean.class);
            m.setAccessible(true);
            m.invoke(null, text, isError);
        } catch (Exception e) {
            throw new AssertionError("cannot call AmooLoop.report: " + e);
        }
    }
}
