// khy-canary: Khy-20261101-050-Y9NH0GJX
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Unit tests for {@link LoopState}.
 *
 * <p>JUnit 4, JVM only — the class under test reads no clock and touches no Android
 * type, so the whole decision table can be proven without a device.
 */
public class LoopStateTest {

    private static final Set<String> STOP_REASONS = new HashSet<String>(Arrays.asList(
            LoopState.DONE_SIGNAL, LoopState.MAX_ROUNDS, LoopState.DEADLINE,
            LoopState.STALLED, LoopState.ABORTED, LoopState.STATE_LOST));

    // ---------------------------------------------------------------- helpers

    private static LoopState.State state(int round, long elapsedMs, long deadlineMs,
                                        int maxRounds, int noProgressPolls,
                                        boolean doneSignalled, boolean aborted) {
        LoopState.State s = new LoopState.State();
        s.round = round;
        s.elapsedMs = elapsedMs;
        s.deadlineMs = deadlineMs;
        s.maxRounds = maxRounds;
        s.noProgressPolls = noProgressPolls;
        s.doneSignalled = doneSignalled;
        s.aborted = aborted;
        return s;
    }

    /** A representative mid-loop state: nothing tripped yet. */
    private static LoopState.State healthy() {
        return state(3, 9_000L, 600_000L, 20, 0, false, false);
    }

    /** {@link #healthy()} with the abort flag flipped. */
    private static LoopState.State healthy(boolean aborted) {
        LoopState.State s = healthy();
        s.aborted = aborted;
        return s;
    }

    // ------------------------------------------------- stop reason vocabulary

    @Test
    public void stopReasonConstantsAreStableStrings() {
        // These strings cross the bridge into logs / PC-side reports; a typo here
        // would silently break every consumer that matches on them.
        assertEquals("done_signal", LoopState.DONE_SIGNAL);
        assertEquals("max_rounds", LoopState.MAX_ROUNDS);
        assertEquals("deadline", LoopState.DEADLINE);
        assertEquals("stalled", LoopState.STALLED);
        assertEquals("aborted", LoopState.ABORTED);
    }

    // ------------------------------------------------- shouldStop: continuing

    @Test
    public void healthyMidLoopStateContinues() {
        LoopState.Verdict v = LoopState.shouldStop(healthy());
        assertFalse(v.stop);
        assertNull("reason must be null exactly when stop is false", v.reason);
    }

    @Test
    public void roundJustBelowCapContinues() {
        LoopState.Verdict v = LoopState.shouldStop(state(19, 0L, 600_000L, 20, 0, false, false));
        assertFalse(v.stop);
        assertNull(v.reason);
    }

    @Test
    public void elapsedJustBelowDeadlineContinues() {
        LoopState.Verdict v = LoopState.shouldStop(state(1, 599_999L, 600_000L, 20, 0, false, false));
        assertFalse(v.stop);
        assertNull(v.reason);
    }

    // ---------------------------------------------- shouldStop: ABORTED (top)

    @Test
    public void abortedAloneStopsWithAborted() {
        LoopState.Verdict v = LoopState.shouldStop(state(0, 0L, 600_000L, 20, 0, false, true));
        assertTrue(v.stop);
        assertEquals(LoopState.ABORTED, v.reason);
    }

    @Test
    public void abortedOutranksDoneSignalRoundCapDeadlineAndStall() {
        LoopState.Verdict v = LoopState.shouldStop(
                state(99, 999_999L, 1_000L, 5, 99, true, true));
        assertTrue(v.stop);
        assertEquals(LoopState.ABORTED, v.reason);
    }

    // ------------------------------------------ shouldStop: DONE_SIGNAL (2nd)

    @Test
    public void doneSignalBeatsRoundCap() {
        // Spec: success outranks exhaustion. Amoo said khy-done AND the loop is out
        // of rounds at the same time — the answer is still DONE_SIGNAL, not a
        // timeout-looking MAX_ROUNDS.
        LoopState.Verdict v = LoopState.shouldStop(state(99, 0L, 600_000L, 5, 0, true, false));
        assertTrue(v.stop);
        assertEquals(LoopState.DONE_SIGNAL, v.reason);
    }

    @Test
    public void doneSignalBeatsDeadlineAndStall() {
        LoopState.Verdict v = LoopState.shouldStop(
                state(2, 900_000L, 600_000L, 20, 42, true, false));
        assertTrue(v.stop);
        assertEquals(LoopState.DONE_SIGNAL, v.reason);
    }

    // ------------------------------------------- shouldStop: MAX_ROUNDS (3rd)

    @Test
    public void roundCapTripsAtExactlyMaxRounds() {
        // The comparison is >=, so round == maxRounds already stops.
        LoopState.Verdict v = LoopState.shouldStop(state(5, 0L, 600_000L, 5, 0, false, false));
        assertTrue(v.stop);
        assertEquals(LoopState.MAX_ROUNDS, v.reason);
    }

    @Test
    public void roundCapBeatsDeadlineAndStall() {
        LoopState.Verdict v = LoopState.shouldStop(
                state(30, 900_000L, 600_000L, 30, 99, false, false));
        assertTrue(v.stop);
        assertEquals(LoopState.MAX_ROUNDS, v.reason);
    }

    // -------------------------------------------- shouldStop: DEADLINE (4th)

    @Test
    public void deadlineTripsAtExactlyElapsedEqualsDeadline() {
        LoopState.Verdict v = LoopState.shouldStop(state(2, 600_000L, 600_000L, 20, 0, false, false));
        assertTrue(v.stop);
        assertEquals(LoopState.DEADLINE, v.reason);
    }

    @Test
    public void deadlineBeatsStall() {
        LoopState.Verdict v = LoopState.shouldStop(state(2, 600_001L, 600_000L, 20, 5, false, false));
        assertTrue(v.stop);
        assertEquals(LoopState.DEADLINE, v.reason);
    }

    /**
     * deadlineMs = 0 means "no deadline configured", NOT "already expired".
     *
     * This used to stop the loop before its first round, which is
     * indistinguishable from an instant stall. The PC side guards with
     * `if (deadline > 0 && ...)`; the phone now matches it.
     */
    @Test
    public void zeroDeadlineMeansNoDeadline() {
        LoopState.Verdict v = LoopState.shouldStop(state(0, 1L, 0L, 20, 0, false, false));
        assertFalse(v.stop);
        assertEquals(null, v.reason);
        // Even a huge elapsed time does not trip an unset deadline.
        v = LoopState.shouldStop(state(3, 10_000_000L, 0L, 20, 0, false, false));
        assertFalse(v.stop);
        // A real deadline still fires.
        v = LoopState.shouldStop(state(3, 6_000L, 5_000L, 20, 0, false, false));
        assertEquals(LoopState.DEADLINE, v.reason);
    }

    // --------------------------------------------- shouldStop: STALLED (5th)

    @Test
    public void noProgressFiveStopsStalled() {
        LoopState.Verdict v = LoopState.shouldStop(state(2, 0L, 600_000L, 20, 5, false, false));
        assertTrue(v.stop);
        assertEquals(LoopState.STALLED, v.reason);
    }

    @Test
    public void noProgressFourDoesNotStop() {
        LoopState.Verdict v = LoopState.shouldStop(state(2, 0L, 600_000L, 20, 4, false, false));
        assertFalse("4 no-progress polls is still inside tolerance", v.stop);
        assertNull(v.reason);
    }

    @Test
    public void noProgressFarAboveThresholdStopsStalled() {
        LoopState.Verdict v = LoopState.shouldStop(state(2, 0L, 600_000L, 20, 500, false, false));
        assertTrue(v.stop);
        assertEquals(LoopState.STALLED, v.reason);
    }

    // ---------------------------------------------------- shouldStop: garbage

    @Test
    public void nullStateStopsInsteadOfThrowing() {
        LoopState.Verdict v;
        try {
            v = LoopState.shouldStop(null);
        } catch (Throwable t) {
            throw new AssertionError("shouldStop(null) must not throw", t);
        }
        assertNotNull(v);
        assertTrue("a lost snapshot must end the loop, not spin on a guess", v.stop);
        assertTrue(STOP_REASONS.contains(v.reason));
    }

    @Test
    public void extremeStateValuesNeverThrowAndAlwaysAnswer() {
        List<LoopState.State> states = Arrays.asList(
                state(Integer.MIN_VALUE, Long.MIN_VALUE, Long.MIN_VALUE,
                        Integer.MIN_VALUE, Integer.MIN_VALUE, false, false),
                state(Integer.MAX_VALUE, Long.MAX_VALUE, Long.MAX_VALUE,
                        Integer.MAX_VALUE, Integer.MAX_VALUE, true, true),
                state(-1, -1L, -1L, -1, -1, true, false),
                state(0, 0L, 0L, 0, 0, false, false),
                state(1, 1L, 1L, 1, 1, true, true));

        for (LoopState.State s : states) {
            LoopState.Verdict v;
            try {
                v = LoopState.shouldStop(s);
            } catch (Throwable t) {
                throw new AssertionError("shouldStop threw on " + s.round, t);
            }
            assertNotNull(v);
            if (v.stop) {
                assertTrue("unknown reason: " + v.reason, STOP_REASONS.contains(v.reason));
            } else {
                assertNull(v.reason);
            }
        }
    }

    @Test
    public void stopIsFalseExactlyWhenReasonIsNull() {
        List<LoopState.State> states = Arrays.asList(
                healthy(),
                state(19, 0L, 600_000L, 20, 4, false, false),
                state(5, 0L, 600_000L, 5, 0, false, false),
                state(2, 600_000L, 600_000L, 20, 0, false, false),
                state(2, 0L, 600_000L, 20, 5, false, false),
                state(0, 0L, 600_000L, 20, 0, true, false),
                state(0, 0L, 600_000L, 20, 0, false, true));

        for (LoopState.State s : states) {
            LoopState.Verdict v = LoopState.shouldStop(s);
            if (v.stop) {
                assertTrue("stopped at round " + s.round + " but reason is null", v.reason != null);
                assertTrue("unknown reason: " + v.reason, STOP_REASONS.contains(v.reason));
            } else {
                assertNull("not stopping, so reason must be null; was: " + v.reason, v.reason);
            }
        }
    }

    // ------------------------------------------------- shouldStop: invariants

    @Test
    public void everyStopReasonIsReachable() {
        // Guards the priority ladder: if a branch is ever reordered or dropped,
        // one of these five disappears.
        assertEquals(LoopState.ABORTED,
                LoopState.shouldStop(healthy(/*aborted*/ true)).reason);
        assertEquals(LoopState.DONE_SIGNAL,
                LoopState.shouldStop(state(3, 9_000L, 600_000L, 20, 0, true, false)).reason);
        assertEquals(LoopState.MAX_ROUNDS,
                LoopState.shouldStop(state(20, 9_000L, 600_000L, 20, 0, false, false)).reason);
        assertEquals(LoopState.DEADLINE,
                LoopState.shouldStop(state(3, 600_000L, 600_000L, 20, 0, false, false)).reason);
        assertEquals(LoopState.STALLED,
                LoopState.shouldStop(state(3, 9_000L, 600_000L, 20, 5, false, false)).reason);
    }

    // ------------------------------------------------ nextPollDelay: the spec

    @Test
    public void nextPollDelayFollowsTheCappedLinearLadder() {
        assertEquals(3000L, LoopState.nextPollDelay(1, 3000L, 30000L));
        assertEquals(6000L, LoopState.nextPollDelay(6, 3000L, 30000L));
        assertEquals(9000L, LoopState.nextPollDelay(11, 3000L, 30000L));
    }

    @Test
    public void nextPollDelayCapsAtMaxMs() {
        assertEquals(30000L, LoopState.nextPollDelay(100, 3000L, 30000L));
        assertEquals(30000L, LoopState.nextPollDelay(Integer.MAX_VALUE, 3000L, 30000L));
    }

    @Test
    public void nextPollDelayZeroBaseFallsBackToDefaultNotToZero() {
        // baseMs <= 0 means "unset", NOT "poll as fast as possible".
        assertEquals(3000L, LoopState.nextPollDelay(1, 0L, 0L));
        assertEquals(3000L, LoopState.nextPollDelay(6, 0L, 0L));
        assertEquals(3000L, LoopState.nextPollDelay(1, -5000L, 10000L));
    }

    @Test
    public void nextPollDelayStepBoundariesAreRoundFiveAndSix() {
        assertEquals(3000L, LoopState.nextPollDelay(5, 3000L, 30000L));
        assertEquals(6000L, LoopState.nextPollDelay(6, 3000L, 30000L));
        assertEquals(6000L, LoopState.nextPollDelay(10, 3000L, 30000L));
        assertEquals(9000L, LoopState.nextPollDelay(11, 3000L, 30000L));
    }

    @Test
    public void nextPollDelayRoundBelowOneIsTreatedAsRoundOne() {
        assertEquals(3000L, LoopState.nextPollDelay(0, 3000L, 30000L));
        assertEquals(3000L, LoopState.nextPollDelay(-7, 3000L, 30000L));
        assertEquals(3000L, LoopState.nextPollDelay(Integer.MIN_VALUE, 3000L, 30000L));
    }

    @Test
    public void nextPollDelayClampsBaseToTheLowerBound() {
        // Effective lower bound for baseMs is 250.
        assertEquals(250L, LoopState.nextPollDelay(1, 100L, 30000L));
        assertEquals(250L, LoopState.nextPollDelay(1, 1L, 1000L));
        // The clamp applies to the base, so the ladder still doubles it.
        assertEquals(500L, LoopState.nextPollDelay(6, 10L, 30000L));
    }

    @Test
    public void nextPollDelayMaxBelowBaseIsRaisedToBase() {
        // The cap may never shorten the first interval.
        assertEquals(3000L, LoopState.nextPollDelay(1, 3000L, 100L));
        assertEquals(3000L, LoopState.nextPollDelay(1, 3000L, Long.MIN_VALUE));
        assertEquals(250L, LoopState.nextPollDelay(1, 100L, 0L));
    }

    @Test
    public void nextPollDelayNeverReturnsNonPositive() {
        long[][] cases = {
                {1, 0, 0}, {0, 0, 0}, {-5, -5, -5}, {1, 1, 1},
                {6, 250, 250}, {100, Long.MAX_VALUE, Long.MAX_VALUE},
                {Integer.MAX_VALUE, Long.MAX_VALUE, 1}, {2, Long.MIN_VALUE, Long.MAX_VALUE}};
        for (long[] c : cases) {
            long d = LoopState.nextPollDelay((int) c[0], c[1], c[2]);
            assertTrue("delay must be positive, got " + d, d > 0L);
        }
    }

    @Test
    public void nextPollDelaySaturatesInsteadOfOverflowing() {
        // A huge round count must not wrap the multiplication negative and become a
        // tiny (or negative) delay; it must saturate and then be capped.
        long saturated = LoopState.nextPollDelay(Integer.MAX_VALUE, 3000L, 60_000L);
        assertEquals(60_000L, saturated);
        // With base == ceiling the answer is the base, not a wrapped product.
        long bothHuge = LoopState.nextPollDelay(Integer.MAX_VALUE, Long.MAX_VALUE, Long.MAX_VALUE);
        assertEquals(Long.MAX_VALUE, bothHuge);
    }

    // ── regressions found by adversarial review ─────────────────────────────

    /**
     * A negative maxRounds must not silently disable the round cap.
     *
     * `round >= maxRounds` is false forever when maxRounds is negative, which
     * removed the only round bound and left the deadline as the sole stop
     * condition. The PC side clamps with Math.max(1, ...); this now matches.
     *
     * Note the clamp lands on 1, not 0: a loop that has completed zero rounds is
     * legitimately still running, so the first stop happens at round >= 1.
     */
    @Test
    public void negativeMaxRoundsStillCapsTheLoop() {
        LoopState.State s = new LoopState.State();
        s.deadlineMs = 600_000L;

        s.maxRounds = -1;
        s.round = 0;
        assertEquals(null, LoopState.shouldStop(s).reason);
        s.round = 1;
        assertEquals(LoopState.MAX_ROUNDS, LoopState.shouldStop(s).reason);

        s.maxRounds = 0;
        s.round = 0;
        assertEquals(null, LoopState.shouldStop(s).reason);
        s.round = 1;
        assertEquals(LoopState.MAX_ROUNDS, LoopState.shouldStop(s).reason);

        // A sane cap still behaves as before.
        s.maxRounds = 5;
        s.round = 4;
        assertEquals(null, LoopState.shouldStop(s).reason);
        s.round = 5;
        assertEquals(LoopState.MAX_ROUNDS, LoopState.shouldStop(s).reason);
    }

    /**
     * Losing the State is an internal fault, not a human abort.
     *
     * Both stop the loop, but reporting state_lost as "aborted" sends the reader
     * chasing a human who never touched anything.
     */
    @Test
    public void lostStateIsReportedAsItsOwnReason() {
        LoopState.Verdict v = LoopState.shouldStop(null);
        assertEquals(true, v.stop);
        assertEquals(LoopState.STATE_LOST, v.reason);
        // A genuine human abort keeps its own reason.
        LoopState.State s = new LoopState.State();
        s.aborted = true;
        assertEquals(LoopState.ABORTED, LoopState.shouldStop(s).reason);
    }
}
