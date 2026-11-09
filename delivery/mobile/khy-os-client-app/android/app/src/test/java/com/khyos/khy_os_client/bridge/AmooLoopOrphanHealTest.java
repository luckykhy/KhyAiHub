package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.lang.reflect.Field;

/**
 * AmooLoopOrphanHealTest — the self-heal that turns "wait forever" into
 * "retry", and the human exit that must work whether or not it fired.
 *
 * THE SHAPE THIS GUARDS. {@code askRunning} is a process-wide single-flight
 * lock cleared in the worker's {@code finally}. A worker blocked inside
 * {@link KhyUi#dispatch}'s unbounded accessibility IPC never reaches its
 * finally, so the flag stays true for the life of the process: every later
 * {@link AmooLoop#ask} returns null at its first line, and the caller waits
 * out a whole budget for a job that was never started. {@code healOrphanedAsk}
 * is the only exit from that shape, and it lives inside {@code askResult()} —
 * the poll path, which is the one thing that always happens while an ask is
 * outstanding.
 *
 * WHY PROBES AND NOT A REAL STUCK WORKER. The production writer of this state
 * is a worker thread that needs a live accessibility service and a real Amoo
 * screen. Reflection injects the two fields the heal reads —
 * {@code askRunning} and {@code askStartedAt} — and nothing else, so what is
 * under test is the heal itself rather than the machinery that gets there.
 *
 * WHY THE REASON'S WORDING IS ASSERTED. That sentence is not log noise: the
 * Flutter card shows it VERBATIM (MainActivity's orphan_cleared branch passes
 * it through, {@code AmooChatService.failureDetail} prefers it over any local
 * wording). A heal whose reason stopped naming the next step would leave the
 * user staring at "failed" with nothing to do — the prefix alone is for the
 * two bucketing call sites, the rest is for the human.
 *
 * Covered:
 *   - an ask past {@code ORPHANED_ASK_MS} is healed: state failed, reason
 *     prefixed {@code orphaned_ask}, lock released, elapsed time reported
 *     honestly;
 *   - an ask still inside its budget is NOT touched — the discriminator,
 *     without which a heal firing on every poll would pass too, and a healthy
 *     six-minute Amoo turn would be killed mid-think;
 *   - after the heal the next ask is judged on its own preconditions;
 *   - {@code amoo_stop} is idempotent with nothing running, and releases a
 *     lock it did find.
 */
public class AmooLoopOrphanHealTest {

    /** How far past the budget the probe sits, so "over" is measurable. */
    private static final long OVER_BY_MS = 60_000L;

    /** Read rather than hardcoded, so the probe follows the real budget. */
    private static long orphanBudgetMs() {
        try {
            Field f = AmooLoop.class.getDeclaredField("ORPHANED_ASK_MS");
            f.setAccessible(true);
            return f.getLong(null);
        } catch (Exception e) {
            throw new AssertionError("cannot read AmooLoop.ORPHANED_ASK_MS: " + e);
        }
    }

    @Before
    public void resetAskState() {
        // Process-wide statics shared with the real loop; every test starts
        // from the idle snapshot a fresh boot would show.
        set("askRunning", false);
        set("askWorker", null);
        set("askState", "");
        set("askReply", "");
        set("askError", "");
        set("askStartedAt", 0L);
        set("askEndedAt", 0L);
    }

    @Test
    public void anAskPastItsBudgetIsHealedInsteadOfWaitingForever() {
        long budget = orphanBudgetMs();
        set("askRunning", true);
        set("askState", "running");
        set("askStartedAt", System.currentTimeMillis() - budget - OVER_BY_MS);

        JSONObject r = AmooLoop.askResult();

        assertEquals("failed", r.optString("state"));
        String why = r.optString("error", "");
        assertTrue("自愈必须留下机器可读的前缀，两侧按它分档：" + why,
                why.startsWith("orphaned_ask"));
        assertTrue("后半句是给人读的，必须说清下一步（可重试）：" + why,
                why.contains("可重试"));
        assertFalse("单飞锁必须释放，否则每一笔后续提问都拿不到 job",
                AmooLoop.askRunning());
        assertTrue("healed 的这笔要如实报出耗掉的时间，不能报 0",
                r.optLong("ms") >= budget);
    }

    @Test
    public void anAskStillInsideItsBudgetIsNotTouched() {
        // The discriminator. Without it the test above would also pass for a
        // heal that fired on every poll — and Amoo thinks ~6 minutes per turn
        // on this device, so that would kill healthy asks mid-think.
        long budget = orphanBudgetMs();
        set("askRunning", true);
        set("askState", "running");
        set("askStartedAt", System.currentTimeMillis() - budget / 2);

        JSONObject r = AmooLoop.askResult();

        assertEquals("running", r.optString("state"));
        assertEquals("", r.optString("error", ""));
        assertTrue("没超预算就不许动锁", AmooLoop.askRunning());
    }

    @Test
    public void afterTheHealTheNextAskIsJudgedOnItsOwnPreconditions() {
        long budget = orphanBudgetMs();
        set("askRunning", true);
        set("askState", "running");
        set("askStartedAt", System.currentTimeMillis() - budget - OVER_BY_MS);
        AmooLoop.askResult();   // the heal runs here

        // The accessibility service is down in this JVM, so the pre-flight
        // refuses. That refusal IS the proof: a still-held single-flight lock
        // would have returned null at ask()'s first line and left the orphan
        // reason standing, and the caller would keep waiting on a dead ask.
        assertNull(AmooLoop.ask("重试", 420000L));
        String why = AmooLoop.askResult().optString("error", "");
        assertFalse("预检拒绝必须写它自己的理由，不能沿用孤儿自愈那句：" + why,
                why.startsWith("orphaned_ask"));
    }

    @Test
    public void amooStopIsIdempotentWithNothingRunning() {
        // The human exit must not depend on there being something to stop. A
        // stop that fails when idle leaves the caller believing the lock is
        // still held — the exact belief the heal exists to remove.
        JSONObject first = Tools.dispatch("amoo_stop", new JSONObject());
        assertTrue(first.optBoolean("ok"));
        assertFalse(first.optBoolean("ask_running"));

        JSONObject second = Tools.dispatch("amoo_stop", new JSONObject());
        assertTrue("无任务在跑也必须返回成功", second.optBoolean("ok"));
        assertFalse(second.optBoolean("ask_running"));
        assertFalse(AmooLoop.askRunning());
    }

    @Test
    public void amooStopReleasesALockItDidFind() {
        // Idempotent must not mean inert: when a lock IS held, the stop has to
        // be the thing that clears it. Reporting ok while leaving askRunning
        // true would be the dishonesty this whole path exists to prevent.
        set("askRunning", true);

        JSONObject r = Tools.dispatch("amoo_stop", new JSONObject());

        assertTrue(r.optBoolean("ok"));
        assertFalse(r.optBoolean("ask_running"));
        assertFalse(AmooLoop.askRunning());
    }

    // ── probe helpers ───────────────────────────────────────────────────────

    private static void set(String field, Object value) {
        try {
            Field f = AmooLoop.class.getDeclaredField(field);
            f.setAccessible(true);
            f.set(null, value);
        } catch (Exception e) {
            throw new AssertionError("cannot set AmooLoop." + field + ": " + e);
        }
    }
}
