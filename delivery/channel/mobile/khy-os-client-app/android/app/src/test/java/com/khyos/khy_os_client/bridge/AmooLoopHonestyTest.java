// khy-canary: Khy-20261101-037-5XEJNJJS
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Tests for the two honesty holes the refutation round named in the loop itself.
 *
 * Both are cases where the code was *correct about what it did* and *silent about
 * what it did not do* — which is worse than being wrong, because a wrong number
 * gets questioned and a missing one does not.
 *
 *   1. {@link AmooLoop#commandsDroppedAfterDone} — a DONE fence mid-bubble drops
 *      every command after it, and nothing used to say so.
 *   2. {@link AmooLoop.ExecutedCommand} — the pending file carried tool names
 *      with no verdict, so a human approving the next step could not tell which
 *      of the previous ones had actually been measured.
 */
public class AmooLoopHonestyTest {

    private static AmooProtocol.Fence exec(String payload) {
        return new AmooProtocol.Fence(AmooProtocol.FenceKind.EXEC, payload, true);
    }

    private static AmooProtocol.Fence done() {
        return new AmooProtocol.Fence(AmooProtocol.FenceKind.DONE, "khy-done", true);
    }

    private static AmooProtocol.Fence plan() {
        return new AmooProtocol.Fence(AmooProtocol.FenceKind.PLAN, "{}", true);
    }

    // ---------- commands dropped after DONE ----------

    @Test
    public void nothingIsDroppedWhenDoneIsLast() {
        List<AmooProtocol.Fence> f = new ArrayList<AmooProtocol.Fence>(
                Arrays.asList(exec("{}"), exec("{}"), done()));
        assertEquals(0, AmooLoop.commandsDroppedAfterDone(f, 0));
    }

    @Test
    public void commandsAfterDoneAreCounted() {
        // The exact shape that used to be silent: Amoo sends two commands,
        // declares done, then adds three more. Those three never run.
        List<AmooProtocol.Fence> f = new ArrayList<AmooProtocol.Fence>(
                Arrays.asList(exec("{}"), exec("{}"), done(),
                        exec("{}"), exec("{}"), exec("{}")));
        assertEquals(3, AmooLoop.commandsDroppedAfterDone(f, 0));
    }

    @Test
    public void planFencesAfterDoneAreNotCountedAsDroppedCommands() {
        // A restated goal is not a command. Counting it would inflate the
        // number of things that "did not run" and send the human chasing
        // something that was never going to execute anyway.
        List<AmooProtocol.Fence> f = new ArrayList<AmooProtocol.Fence>(
                Arrays.asList(done(), plan(), exec("{}"), plan()));
        assertEquals(1, AmooLoop.commandsDroppedAfterDone(f, 0));
    }

    @Test
    public void noDoneFenceMeansNothingDropped() {
        List<AmooProtocol.Fence> f = new ArrayList<AmooProtocol.Fence>(
                Arrays.asList(exec("{}"), exec("{}"), plan()));
        assertEquals(0, AmooLoop.commandsDroppedAfterDone(f, 0));
    }

    @Test
    public void onlyTheFirstDoneFenceCounts() {
        // A second DONE is itself a dropped fence of no consequence; counting
        // past the first would double-count.
        List<AmooProtocol.Fence> f = new ArrayList<AmooProtocol.Fence>(
                Arrays.asList(done(), exec("{}"), done(), exec("{}")));
        assertEquals(2, AmooLoop.commandsDroppedAfterDone(f, 0));
    }

    @Test
    public void anEmptyBubbleDropsNothing() {
        assertEquals(0, AmooLoop.commandsDroppedAfterDone(
                new ArrayList<AmooProtocol.Fence>(), 0));
    }

    @Test
    public void aNullListIsNotACrash() {
        // This runs on the loop thread; an NPE here would take the whole
        // conversation down over a bookkeeping number.
        assertEquals(0, AmooLoop.commandsDroppedAfterDone(null, 0));
    }

    @Test
    public void aStartIndexPastTheEndIsNotACrash() {
        List<AmooProtocol.Fence> f = new ArrayList<AmooProtocol.Fence>(
                Arrays.asList(exec("{}"), done()));
        assertEquals(0, AmooLoop.commandsDroppedAfterDone(f, 99));
    }

    @Test
    public void aNegativeStartIndexIsClampedNotCrashed() {
        List<AmooProtocol.Fence> f = new ArrayList<AmooProtocol.Fence>(
                Arrays.asList(done(), exec("{}")));
        assertEquals(1, AmooLoop.commandsDroppedAfterDone(f, -5));
    }

    // ---------- ExecutedCommand carries a verdict ----------

    @Test
    public void theThreeOutcomesAreDistinctStrings() {
        // They go into a JSON file a human reads. Three distinct literals, not
        // a boolean plus a special case.
        assertFalse(AmooLoop.ExecutedCommand.VERIFIED
                .equals(AmooLoop.ExecutedCommand.UNVERIFIED));
        assertFalse(AmooLoop.ExecutedCommand.UNVERIFIED
                .equals(AmooLoop.ExecutedCommand.FAILED));
        assertFalse(AmooLoop.ExecutedCommand.VERIFIED
                .equals(AmooLoop.ExecutedCommand.FAILED));
    }

    @Test
    public void aVerifiedCommandSerialisesWithVerifiedTrue() throws Exception {
        JSONObject j = new AmooLoop.ExecutedCommand(
                "write", AmooLoop.ExecutedCommand.VERIFIED, null).toJson();
        assertEquals("write", j.getString("tool"));
        assertEquals("verified", j.getString("outcome"));
        assertTrue(j.getBoolean("verified"));
        assertTrue("no reason to give when it was proven",
                j.isNull("why"));
    }

    @Test
    public void anUnverifiedCommandKeepsItsReason() throws Exception {
        // The whole point: the pending file must say WHY it could not be
        // proven, or the human is approving the next step blind.
        JSONObject j = new AmooLoop.ExecutedCommand(
                "install_apk", AmooLoop.ExecutedCommand.UNVERIFIED,
                "未做事后查询，无法确认装上").toJson();
        assertEquals("unverified", j.getString("outcome"));
        assertFalse(j.getBoolean("verified"));
        assertEquals("未做事后查询，无法确认装上", j.getString("why"));
    }

    @Test
    public void aFailedCommandIsNotVerified() throws Exception {
        JSONObject j = new AmooLoop.ExecutedCommand(
                "read", AmooLoop.ExecutedCommand.FAILED, null).toJson();
        assertEquals("failed", j.getString("outcome"));
        assertFalse(j.getBoolean("verified"));
    }

    @Test
    public void verifiedIsTrueForExactlyOneOutcome() throws Exception {
        // If this ever becomes true for two outcomes, the flag has stopped
        // meaning anything and the pending file is lying again.
        int trues = 0;
        for (String outcome : new String[] {
            AmooLoop.ExecutedCommand.VERIFIED,
            AmooLoop.ExecutedCommand.UNVERIFIED,
            AmooLoop.ExecutedCommand.FAILED,
        }) {
            if (new AmooLoop.ExecutedCommand("t", outcome, null)
                    .toJson().getBoolean("verified")) {
                trues++;
            }
        }
        assertEquals(1, trues);
    }

    @Test
    public void toJsonIsStableAcrossCalls() throws Exception {
        AmooLoop.ExecutedCommand e = new AmooLoop.ExecutedCommand(
                "toast", AmooLoop.ExecutedCommand.UNVERIFIED, "no probe");
        assertEquals(e.toJson().toString(), e.toJson().toString());
    }

    @Test
    public void aGarbageOutcomeIsStillSerialisable() throws Exception {
        // A future caller passing an unknown literal must not throw — this
        // runs inside writePending, whose catch would swallow the whole
        // pending file and leave the human with nothing at all.
        JSONObject j = new AmooLoop.ExecutedCommand("t", "something_new", null)
                .toJson();
        assertNotNull(j);
        assertEquals("something_new", j.getString("outcome"));
        assertFalse(j.getBoolean("verified"));
    }
}
