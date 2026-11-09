// khy-canary: Khy-20261101-015-11AQZQ2Z
package com.khyos.khy_os_client.bridge;

/**
 * LoopState — stop/backoff decision logic for the Amoo interception loop.
 *
 * <p>Amoo streams its reply, so the loop has to judge for itself whether to keep
 * going. Two rules live here, both pure (no IO, no clock reads, no Android types)
 * so they can be proven on a desktop JVM without a phone attached:
 *
 * <ol>
 *   <li>{@link #shouldStop} — when the loop is finished. Only the {@code khy-done}
 *       fence counts as a success-shaped exit. "There are no more commands" is NOT
 *       success: it may just mean Amoo gave up, and the caller must tell those two
 *       apart.</li>
 *   <li>{@link #nextPollDelay} — capped linear backoff between polls, kept
 *       semantically identical to the PC side {@code amooDispatchPlan.nextPollDelay}
 *       so the phone and the PC pace the same dispatch the same way.</li>
 * </ol>
 *
 * <p>Deliberate design notes:
 * <ul>
 *   <li>This class reads no clock. {@code elapsedMs} / {@code deadlineMs} are fields
 *       the caller fills in, which keeps the unit deterministic and testable.</li>
 *   <li>Nothing here throws. Every entry point returns a value; a {@code null} State
 *       is answered conservatively (stop) instead of with a NullPointerException,
 *       because a crash inside the bridge service would take the whole loop down.</li>
 *   <li>The {@code shouldStop} priority list is implemented from the spec, with two
 *       clamps the spec did not spell out: a {@code maxRounds} below 1 is raised to 1
 *       (a negative cap would silently disable the round limit), and a
 *       {@code deadlineMs <= 0} means "no deadline" — the same convention the PC side
 *       uses — rather than "already expired", which stopped the loop before its
 *       first round.</li>
 * </ul>
 */
public final class LoopState {

    private LoopState() {}

    /** Amoo emitted a {@code khy-done} fence: the only success-shaped exit. */
    public static final String DONE_SIGNAL = "done_signal";

    /** Reached {@code maxRounds} completed rounds without a done signal. */
    public static final String MAX_ROUNDS = "max_rounds";

    /** Wall clock passed {@code deadlineMs}. */
    public static final String DEADLINE = "deadline";

    /** Consecutive rounds produced no new fence: Amoo most likely went quiet. */
    public static final String STALLED = "stalled";

    /** Ended from the outside — a human abort. */
    public static final String ABORTED = "aborted";

    /**
     * Stopped because the safety floor refused a command.
     *
     * NOT the same as {@link #ABORTED}, and the difference is the whole reason
     * this constant exists. ABORTED means a human stopped the loop; this means
     * the machine did. Reporting a floor refusal as "人工中止" tells the human
     * they did something they did not do, and sends them looking for a stop
     * button they never pressed. Every floor trip used to land here — including
     * the ones that are false positives — so the mislabel was on the exact path
     * whose risk section depends on the human understanding what happened.
     */
    public static final String FLOOR_REFUSED = "floor_refused";

    /** The caller lost its State snapshot: an internal fault, not a human abort. */
    public static final String STATE_LOST = "state_lost";

    /** Consecutive no-progress polls tolerated before STALLED trips. */
    private static final int STALL_AFTER_POLLS = 5;

    /** Fallback base interval when the caller supplies no usable one. */
    private static final long DEFAULT_BASE_MS = 3000L;

    /** Lower bound for a usable base interval (PC side: {@code Math.max(250, ...)}). */
    private static final long MIN_BASE_MS = 250L;

    /** Rounds per backoff step: rounds 1..5 share step 0, 6..10 step 1, and so on. */
    private static final int ROUNDS_PER_STEP = 5;

    /**
     * Mutable snapshot of the loop. The caller owns it and updates the counters as
     * rounds complete; this class only reads it.
     */
    public static final class State {
        /** Completed rounds, starting at 0. */
        public int round;
        /** Wall clock spent by the whole loop so far. */
        public long elapsedMs;
        /** Wall-clock ceiling for the whole loop. */
        public long deadlineMs;
        /** Round ceiling. */
        public int maxRounds;
        /** Consecutive rounds that produced no new fence. */
        public int noProgressPolls;
        /** A {@code khy-done} fence was seen. */
        public boolean doneSignalled;
        /**
         * 本轮已派发但尚未验证（或无法验证）的命令数。
         *
         * 为什么需要它：{@link #doneSignalled} 是 **Amoo 自己声明**完成。
         * 让被检查的一方自己签验收单，正是这套桥要防的 fabrication。
         * 所以 DONE 只有在"没有未验证命令"时才等价于成功退出；
         * 这个计数就是把差别带到界面上，让报告必须写
         * 「Amoo 声明完成，但 N 条命令未验证/无法验证」，而不是干一句"任务完成"。
         */
        public int unverifiedCommands;
        /** A human aborted the loop. */
        public boolean aborted;

        /**
         * The safety floor refused a command and the loop stopped for that
         * reason. Distinct from {@link #aborted} so the final report can say
         * "安全底拒绝" rather than "人工中止" — see {@link #FLOOR_REFUSED}.
         */
        public boolean floorRefused;
    }

    /**
     * Immutable answer. {@code reason} is null exactly when {@code stop} is false,
     * and otherwise one of the {@code *_SIGNAL} / {@code *_ROUNDS} / ... constants.
     */
    public static final class Verdict {
        public final boolean stop;
        public final String reason;

        /**
         * 停时仍有多少条命令没验证。只在 reason == {@link #DONE_SIGNAL} 时可能非零，
         * 但字段本身不带这个条件——调用方该自己判断要不要显示。
         */
        public final int unverified;

        public Verdict(boolean stop, String reason) {
            this(stop, reason, 0);
        }

        public Verdict(boolean stop, String reason, int unverified) {
            this.stop = stop;
            this.reason = reason;
            // 负数没有意义，钳住：一个坏计数不该让报告显示"未验证 -1 条"。
            this.unverified = unverified < 0 ? 0 : unverified;
        }
    }

    /**
     * Should the loop stop? Priority, highest first (first match wins):
     * aborted, doneSignalled, round cap, deadline, stall.
     *
     * <p>Success outranks exhaustion on purpose: once Amoo has said {@code khy-done}
     * the loop is finished even if it also happens to be out of rounds or out of
     * time, so a completed task is never reported as a timeout.
     *
     * @param s loop snapshot; may be null, in which case the loop is told to stop.
     * @return never null; {@code reason == null} means "keep going".
     */
    public static Verdict shouldStop(State s) {
        if (s == null) {
            // No snapshot means the caller cannot tell us anything; ending the loop
            // is safer than spinning on a guess. The reason is deliberately NOT
            // ABORTED — that constant means "a human stopped it", and reporting an
            // internal fault as a human abort would send the reader chasing the
            // wrong cause.
            return new Verdict(true, STATE_LOST);
        }
        if (s.aborted) {
            return new Verdict(true, ABORTED);
        }
        if (s.floorRefused) {
            // Below ABORTED on purpose: if a human stops the loop AND the floor
            // refused something, the human's action is the more useful thing to
            // report — they can act on it, whereas the refusal is already in the
            // pending file.
            return new Verdict(true, FLOOR_REFUSED);
        }
        if (s.doneSignalled) {
            // DONE 不等于"成功完成"。Amoo 是声明完成的那一方，而让被检查者
            // 自己签验收单就是 fabrication。所以这里把未验证命令数一起带出去，
            // 由调用方决定报告怎么写——它必须能写出
            // 「Amoo 声称完成，但 N 条命令未验证/无法验证」这种句子。
            //
            // 仍然停：Amoo 说完成就是一个明确的终止信号，不该继续空转。
            // 但"停"和"成功"是两件事，以前这里把两者合并了。
            return new Verdict(true, DONE_SIGNAL, s.unverifiedCommands);
        }
        // Clamp rather than trust: a negative maxRounds makes `round >= maxRounds`
        // false forever, which silently removes the round cap and leaves only the
        // deadline to stop the loop.
        int maxRounds = s.maxRounds < 1 ? 1 : s.maxRounds;
        if (s.round >= maxRounds) {
            return new Verdict(true, MAX_ROUNDS);
        }
        // deadlineMs <= 0 means "no deadline configured", matching the PC side's
        // `if (deadline > 0 && ...)`. Reading 0 as "already expired" stopped the
        // loop before it did a single round.
        if (s.deadlineMs > 0L && s.elapsedMs >= s.deadlineMs) {
            return new Verdict(true, DEADLINE);
        }
        if (s.noProgressPolls >= STALL_AFTER_POLLS) {
            return new Verdict(true, STALLED);
        }
        return new Verdict(false, null);
    }

    /**
     * Capped linear backoff. Rounds 1..5 use {@code baseMs}, then {@code +baseMs}
     * every 5 rounds, never above {@code maxMs}.
     *
     * <p>{@code baseMs <= 0} means "no interval was configured" and falls back to
     * 3000 ms. It is deliberately NOT read as "poll as fast as possible" — a plain
     * {@code x || fallback} would silently turn a missing config into a hot loop.
     * {@code maxMs <= 0} falls back to {@code baseMs}, and a {@code maxMs} below
     * {@code baseMs} is raised to {@code baseMs}, so the cap can never shorten the
     * first interval.
     *
     * @param round 1-based round number; anything below 1 is treated as 1.
     * @param baseMs base interval in ms; non-positive means "unset".
     * @param maxMs ceiling in ms; non-positive means "no ceiling".
     * @return delay in ms, always positive and never above the effective ceiling.
     */
    public static long nextPollDelay(int round, long baseMs, long maxMs) {
        long safeBase = baseMs > 0L ? Math.max(MIN_BASE_MS, baseMs) : DEFAULT_BASE_MS;
        long safeCap = maxMs > 0L ? Math.max(safeBase, maxMs) : safeBase;
        int effectiveRound = round < 1 ? 1 : round;
        int step = (effectiveRound - 1) / ROUNDS_PER_STEP;
        return Math.min(safeCap, mulCapped(safeBase, 1L + (long) step));
    }

    /** {@code value * factor}, saturating instead of wrapping on overflow. */
    private static long mulCapped(long value, long factor) {
        if (value <= 0L || factor <= 0L) {
            return 0L;
        }
        if (value > Long.MAX_VALUE / factor) {
            return Long.MAX_VALUE;
        }
        return value * factor;
    }
}
