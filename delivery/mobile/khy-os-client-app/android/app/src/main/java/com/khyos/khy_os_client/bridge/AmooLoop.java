// khy-canary: Khy-20261101-003-BPVF1EBV
package com.khyos.khy_os_client.bridge;

import android.content.Context;

import com.khyos.khy_os_client.KhyAccessibilityService;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * AmooLoop — the no-PC closed loop.
 *
 * Amoo is the cloud brain: it reads the task and emits COMMAND TEXT. Everything
 * else happens on the phone, in-process, with no PC in the path:
 *
 *   KhyUi.dump        read Amoo's screen
 *     -> AmooChatText  reconstruct the newest reply
 *     -> AmooProtocol  pull fenced commands out of it
 *     -> LoopModes     decide execute / confirm / defer (safety floor first)
 *     -> Tools         run it locally
 *     -> LoopVerify    prove it actually happened
 *     -> KhyUi.type    write the result back into Amoo's input box
 *     -> KhyUi.click   send
 *   -> Amoo takes the next step
 *
 * Design decisions that are NOT obvious and are load-bearing:
 *
 * 1. ONLY the newest bubble is scanned. The chat text is cumulative; scanning
 *    all of it every round would re-execute commands that already ran. Taking
 *    the last block needs no offset bookkeeping.
 *
 * 2. A processed bubble is remembered by hash, so a write-back that failed to
 *    create a new bubble cannot cause a re-execution.
 *
 * 3. An unclosed fence is NEVER executed. Amoo streams its reply, so a
 *    mid-stream snapshot yields half a JSON object. Waiting is always safe;
 *    executing half a command is not.
 *
 * 4. `khy-done` is the ONLY success exit. "No more commands" is reported as
 *    STALLED, not as success — silence may mean Amoo gave up.
 *
 *    The stall counts ONLY new turns that carry no command. An unchanged screen is
 *    deliberately NOT a stall signal: Amoo thinks for minutes at a time on this
 *    device (measured ~6 min/turn), and counting those polls made the loop abandon
 *    the task before the answer arrived. A reply that never comes is bounded by the
 *    wall-clock deadline instead.
 *
 * 5. The loop does NOT survive a process restart. `armed` is in-memory only and
 *    nothing re-arms it. Resuming after a kill would risk double-executing a
 *    command the cloud brain already believes ran; aborting and telling the
 *    human is the safe failure. The system is documented to freeze background
 *    apps, so this is an expected path, not a corner case.
 *
 * 6. CONFIRM/DEFER stop the loop rather than skipping the command. There is no
 *    interactive UI on this path, so "ask the human" means: write the pending
 *    commands to a file, raise a notification, and stop. Silently skipping
 *    would let the human believe the task is progressing.
 *
 * Contract: never throws. Every failure is reported through the result object.
 */
public final class AmooLoop {
    private AmooLoop() {}

    // Amoo's measured resource ids (1200x2670, density 520). Never tap a
    // remembered coordinate: the input box moves ~1300px when the soft keyboard
    // opens, so every interaction is resolved from the live dump.
    public static final String AMOO_PKG = "com.stepos.ailauncher";
    public static final String ID_CHAT_LIST = AMOO_PKG + ":id/chat_list";
    public static final String ID_INPUT = AMOO_PKG + ":id/et_input_bar";
    public static final String ID_SEND = AMOO_PKG + ":id/btn_text_send";

    private static final String PENDING_FILE = "/sdcard/bridge-amoobridge/amoo_pending.json";
    /** Where a failed write-back actually lands. Named in every user-facing report. */
    private static final String PENDING_TXT = PENDING_FILE + ".txt";
    /** Send attempts per write-back. The keyboard animation needs a moment to settle. */
    private static final int WRITE_BACK_ATTEMPTS = 3;
    /** How long to let the soft keyboard finish animating before resolving coordinates. */
    private static final long WRITE_BACK_SETTLE_MS = 900L;

    /** In-memory only. Deliberately not persisted — see design note 5. */
    private static volatile boolean armed = false;
    /** True while an amoo_ask job is in flight. Lets writeBack run outside the loop. */
    private static volatile boolean askRunning = false;
    /**
     * The thread running the current ask. Null when none is in flight.
     *
     * Kept so {@link #stopAsk()} can interrupt it. Without the handle, stopping an
     * ask only cleared the flag, and a worker sleeping in its 3s poll loop kept
     * going until its own deadline — up to 30 minutes of "I pressed stop and
     * nothing happened".
     */
    private static volatile Thread askWorker = null;
    private static volatile boolean running = false;
    private static volatile Thread worker = null;
    private static volatile LoopModes.Mode currentMode = LoopModes.defaultMode();
    private static volatile String lastReport = "";
    /**
     * The current step, for the floating overlay to show live.
     *
     * Deliberately separate from {@link #lastReport()}: the report is the
     * outcome of a stage ("command write executed but could not be verified"),
     * while this is what is happening RIGHT NOW ("executing 2/3: write"). Mixing
     * them would make the overlay either too quiet to be useful or too noisy to
     * read. Updated far more often, and never carries a payload.
     */
    private static volatile String progress = "";
    /**
     * When the current loop run started, in epoch ms. 0 when idle.
     *
     * Set in {@link #start} right before the worker is launched, so the elapsed
     * read below covers real work only. {@code runLoop}'s finally block clears
     * {@code running}, which is what drives {@link #elapsedMs()} back to 0 — no
     * separate reset needed.
     */
    private static volatile long startedAtMs = 0L;
    /** Outcome of the most recent write-back. Empty before the first one. */
    private static volatile String lastWriteBack = "";
    /**
     * Most recent FAILURE report. Empty when nothing has failed yet.
     *
     * Deliberately not a copy of {@link #lastReport()}: the report also carries
     * status broadcasts and the closing sentence of a perfectly good run, and
     * pinning those as errors would leave a permanent "上一条错误" line on the
     * overlay after success.
     */
    private static volatile String lastError = "";
    /**
     * Shared memory with Amoo.
     *
     * Loaded at loop start and saved on every verified fact. File IO goes through
     * Tools.dispatch rather than java.io directly, so it inherits the bridge's
     * own permission context and error shape.
     */
    private static volatile AmooMemory memory = AmooMemory.empty();

    public static boolean isRunning() {
        return running;
    }

    public static LoopModes.Mode currentMode() {
        return currentMode;
    }

    public static String lastReport() {
        return lastReport;
    }

    /** What the loop is doing right now. Empty when idle. */
    public static String progress() {
        return progress;
    }

    /**
     * Elapsed ms of the running loop; 0 when idle.
     *
     * Pure memory read, zero IO — same contract as {@link #progress()}. Safe to
     * call from the overlay's 2s ticker, which runs on the main thread.
     */
    public static long elapsedMs() {
        long at = startedAtMs;
        return (running && at > 0) ? System.currentTimeMillis() - at : 0L;
    }

    /** Outcome of the most recent write-back. Pure memory read, zero IO. */
    public static String lastWriteBack() {
        return lastWriteBack;
    }

    /**
     * Most recent failure report. Pure memory read, zero IO. Empty means the
     * last report was not a failure — NOT that nothing ever failed.
     */
    public static String lastError() {
        return lastError;
    }

    /**
     * True while the loop OR an in-flight amoo_ask is working. Zero IO.
     *
     * The overlay badge colours off this, so it must cover the reverse-proxy
     * path too: an ask is real work even though no loop is running.
     */
    public static boolean busy() {
        return running || askRunning;
    }

    /** The shared memory as currently held. For status reporting; never mutate. */
    public static AmooMemory memory() {
        return memory;
    }

    /**
     * Replace the shared memory and persist it.
     *
     * For the explicit memory_set path. The merge rules in
     * {@link AmooMemory#with} still apply, so this cannot silently demote a
     * verified fact either — the caller builds the new memory through `with`.
     */
    public static void replaceMemory(AmooMemory next) {
        memory = next == null ? AmooMemory.empty() : next;
        saveMemory();
    }

    /** Record the current step. Never throws; a dead overlay must not stop work. */
    private static void step(String text) {
        progress = text == null ? "" : text;
    }

    /**
     * Whether anything still intends to send: the loop, or an in-flight ask.
     *
     * writeBack used to guard on `armed` alone, which made it unusable outside
     * the loop — the retry loop body never ran and every send reported
     * "not attempted". The reverse-proxy path needs the same send machinery.
     */
    private static boolean sending() {
        return armed || askRunning;
    }

    // ── reverse proxy: use Amoo as a model ──────────────────────────────────

    private static final String ASK_IDLE = "";
    private static final String ASK_RUNNING = "running";
    private static final String ASK_DONE = "done";
    private static final String ASK_FAILED = "failed";

    private static volatile String askState = ASK_IDLE;
    private static volatile String askReply = "";
    private static volatile String askError = "";
    private static volatile long askStartedAt = 0L;
    private static volatile long askEndedAt = 0L;

    /**
     * Send a prompt to Amoo and collect its reply — the reverse proxy.
     *
     * ASYNC ON PURPOSE. Amoo thinks for minutes on this device (measured ~6
     * minutes per turn), and the bridge's socket timeout is 20s, so a blocking
     * call would be cut off long before an answer existed. Start here, poll
     * {@link #askResult()}.
     *
     * TWO-LAYER PREAMBLE (option C). Amoo runs in the cloud and has no prior
     * knowledge of khy-os — asked plainly it answers "I have no service by that
     * name, I won't guess", which is correct on its part and useless on ours.
     * So each ask is preceded by:
     *
     *   layer 1 — a self-description: what khy-os is, which tools exist, and
     *             the shape-based command rule. Static, derived from
     *             {@link Tools#NAMES} so it cannot drift.
     *   layer 2 — the shared memory: facts already verified. Dynamic, and only
     *             present when something has actually been verified.
     *
     * The two layers answer different questions ("what is this thing" vs "what
     * have we already established"), so they do not overlap and neither can be
     * folded into the other.
     *
     * @return a job id, or null when a job is already running
     */
    public static synchronized String ask(String prompt, long timeoutMs) {
        if (askRunning) {
            return null;
        }
        final String p = prompt == null ? "" : prompt.trim();
        if (p.length() == 0) {
            return null;
        }
        // Fail fast on a disabled accessibility service.
        //
        // This is the same shape as the foreground check below, one layer down:
        // both conditions make the ask unable to complete, and both used to cost
        // the full budget before saying so. The foreground one was caught and
        // refused up front; this one was not, so the caller waited out
        // `timeoutMs` and got back "timeout after 120000ms" — a message that
        // names the symptom and hides a cause readable in one boolean.
        //
        // Measured on PZ261A (2026-10-25): enabled_accessibility_services was
        // null, ask ran 120032ms and failed with exactly that string.
        if (!Tools.uiReady()) {
            // Stamp both ends. askResult() computes ms as askEndedAt - askStartedAt,
            // so setting only the end yields a raw epoch millisecond value
            // (measured: 1792914991499) where a duration belongs. ~0 is the honest
            // answer here — a pre-flight refusal costs nothing, and that is the
            // whole point of doing it before the thread starts.
            long now = System.currentTimeMillis();
            askStartedAt = now;
            askEndedAt = now;
            askReply = "";
            askError = Tools.uiAdvice();
            askState = ASK_FAILED;
            return null;
        }
        // The most dangerous failure mode is not a timeout: it is the prompt
        // landing in OUR OWN input box because Amoo is not in the foreground.
        // Then no send button is found, the write-back retries three times,
        // falls through to a pending file, and the caller waits out the whole
        // budget for an answer that was never asked. Refuse up front instead.
        String fg = foregroundPackage();
        if (fg.length() > 0 && !fg.equals(AMOO_PKG)) {
            askError = "amoo_not_foreground";
            askState = ASK_FAILED;
            return null;
        }
        final long budget = Math.max(15000L, Math.min(timeoutMs, 1800000L));
        final String job = "ask-" + System.currentTimeMillis();
        final String preamble = buildAskPreamble();
        askRunning = true;
        askState = ASK_RUNNING;
        askReply = "";
        askError = "";
        askStartedAt = System.currentTimeMillis();
        askEndedAt = 0L;
        Thread t = new Thread(new Runnable() {
            public void run() {
                try {
                    if (preamble.length() > 0) {
                        writeBack(preamble);
                    }
                    runAsk(p, budget);
                } catch (Throwable bad) {
                    askError = bad.getClass().getSimpleName() + ": " + bad.getMessage();
                    askState = ASK_FAILED;
                } finally {
                    // 归属检查不是洁癖。孤儿自愈（healOrphanedAsk）和 stopAsk 都会在
                    // worker 还活着的时候放掉锁，于是新的 ask 立刻就能起——而那个卡在
                    // 无界 IPC 里的旧 worker 迟早会回来跑这个 finally。没有这道检查，
                    // 它会把**新那一笔**的锁和结束时间一起清掉，新提问随之被判 aborted，
                    // 用户看到的是"又失败了"，而失败的原因是他自己上一笔卡死。
                    //
                    // 判据是 askWorker 还指向自己：新 ask 会把它换掉，所以旧 worker
                    // 到这里时条件为假，什么都不碰。（用 currentThread() 而不是捕获
                    // 外层那个 Thread 局部变量——后者在匿名类的初始化表达式里还没赋值，
                    // javac 直接报「可能尚未初始化变量 t」。）
                    if (askWorker == Thread.currentThread()) {
                        askRunning = false;
                        askEndedAt = System.currentTimeMillis();
                    }
                    step("");
                }
            }
        }, "amoo-ask");
        t.setDaemon(true);
        askWorker = t;
        t.start();
        return job;
    }

    /**
     * The package currently holding focus, or "" when unknown.
     *
     * Delegates to the accessibility service's active window. "" is a real
     * answer — it means "could not tell" — and the caller must treat it as
     * unknown rather than as "not Amoo", or every ask would be refused while
     * the service is briefly unavailable.
     */
    public static String foregroundPackage() {
        try {
            return KhyAccessibilityService.Companion.foregroundPackage();
        } catch (Throwable bad) {
            return "";
        }
    }

    /**
     * The two-layer preamble sent before the user's actual prompt.
     *
     * Pure assembly, no IO beyond reading the in-memory memory document — the
     * self-description now captures a {@link CapabilitySnapshot} per render,
     * but that snapshot reads in-memory counters and build constants and never
     * touches disk, so this is still safe to call on the caller's thread before
     * the worker starts.
     *
     * WHAT CHANGED AND WHY THE OLD COMMENT WAS WRONG. This used to say "the
     * self-description is static text". It is not any more: it reports whether
     * the accessibility service and the elevation channels are up right now,
     * because an assistant told about 42 tools with no mention of which of them
     * work will either claim a capability it lacks or refuse one it has. The
     * determinism that mattered for prompt caching is preserved — same state in,
     * same bytes out — it is the state that is now an input rather than a
     * constant.
     */
    static String buildAskPreamble() {
        StringBuilder sb = new StringBuilder();
        sb.append(AmooSelfDesc.render());
        AmooMemory mem = memory;
        if (mem != null && mem.size() > 0) {
            String inject = mem.renderForInjection(1200);
            if (inject.length() > 0) {
                sb.append("\n\n以下是我们已经核实过的事实，请以此为前提，不要重新测量：\n")
                        .append(inject);
            }
        }
        return sb.toString();
    }

    /**
     * Whether an ask job is currently in flight.
     *
     * Exported because the Dart side needs it to decide between "start a new
     * ask" and "poll the running one" — {@link #ask} returns null on a
     * collision, and null alone does not distinguish "already running" from
     * "empty prompt".
     */
    public static boolean askRunning() {
        return askRunning;
    }

    /**
     * Poll an ask job.
     *
     * @return never null; {@code state} is "running", "done" or "failed". The
     *         reply is only present on "done", and is the raw text of Amoo's
     *         newest bubble — not parsed, not summarised, not trusted.
     */
    public static JSONObject askResult() {
        JSONObject r = new JSONObject();
        try {
            healOrphanedAsk();
            r.put("ok", true)
                    .put("state", askState.length() == 0 ? ASK_IDLE : askState)
                    .put("ms", askEndedAt > 0 ? askEndedAt - askStartedAt
                            : (askStartedAt > 0 ? System.currentTimeMillis() - askStartedAt : 0));
            if (ASK_DONE.equals(askState)) {
                r.put("reply", askReply);
            } else if (ASK_FAILED.equals(askState)) {
                r.put("error", askError);
            }
        } catch (Throwable ignored) {
            // askResult must never throw; the caller is a status poll.
        }
        return r;
    }

    /**
     * 最大提问预算 + 轮询余量。见 {@link #healOrphanedAsk()}。
     *
     * 与 {@link #ask} 里那个 clamp 同源：1800000 是 {@code timeout_ms} 的上限，
     * 60s 是健康 worker 在 deadline 之后还要多走的一段（最后一轮 ui_dump 加两次
     * 稳定采样，每轮 3s）。小于这个数的"孤儿"只是还没跑完，不能动它。
     */
    private static final long ORPHANED_ASK_MS = 1_860_000L;

    /**
     * 孤儿提问自愈：把「一等到底」变成「可恢复」。
     *
     * WHY THIS IS THE ONLY LATCH-TO-FOREVER IN THE FILE. {@code askRunning} is a
     * process-wide single-flight lock cleared in the worker's {@code finally}.
     * That works for every failure a worker can reach — except the one that
     * matters most here: a worker blocked inside {@link KhyUi#dispatch}'s
     * unbounded accessibility IPC never reaches its finally at all. The flag then
     * stays true for the life of the process, every later {@link #ask} returns
     * null at its first line, and {@code amoo_result} keeps answering with the
     * same advice — a signal that says "wait" and never says "this will never
     * finish".
     *
     * WHY ELAPSED TIME AND NOT {@code askState == FAILED}. The stuck shape is
     * precisely the one where the worker never ran its finally, so the state is
     * still {@code running} and the error is still empty. Waiting for a failure
     * state would wait forever, which is the bug. A healthy worker, by contrast,
     * is bounded by {@code runAsk}'s deadline loop and must exit inside the
     * budget — so elapsed time is a sound discriminator, not a guess.
     *
     * Why this lives in {@link #askResult()} rather than a timer: polling is the
     * one thing that always happens while an ask is outstanding (the Dart card
     * every 2s, the bridge on demand), so no extra thread and no extra wakeup.
     */
    private static void healOrphanedAsk() {
        if (!askRunning) {
            return;
        }
        long startedAt = askStartedAt;
        if (startedAt <= 0) {
            return;
        }
        if (System.currentTimeMillis() - startedAt <= ORPHANED_ASK_MS) {
            return;
        }
        askRunning = false;
        askReply = "";
        // 前缀 "orphaned_ask" 是机器可读的判据：Tools.amooAsk 与 MainActivity
        // 都按它分档，不按整句相等——后半句是给人读的，改措辞不该让它换桶。
        askError = "orphaned_ask: 上一笔提问超过最大预算仍未结束"
                + "（无障碍 IPC 可能卡死），单飞锁已自动释放，可重试";
        askState = ASK_FAILED;
        askEndedAt = System.currentTimeMillis();
    }

    /**
     * Abort an in-flight ask. The prompt already sent cannot be un-sent.
     *
     * Also interrupts the worker, not just the flag. Clearing the flag alone left
     * a worker sleeping in its 3s poll loop running until its own deadline — up to
     * 30 minutes after the user pressed stop. A sleeping worker sees the interrupt
     * immediately and exits through {@code runAsk}'s InterruptedException branch.
     *
     * WHAT THE INTERRUPT CANNOT DO. A worker blocked inside
     * {@link KhyUi#dispatch}'s unbounded accessibility IPC cannot be woken — that
     * call has no interrupt point. The lock is still released here, which is the
     * part that matters: without it every later ask returns null at
     * {@link #ask}'s first line and the caller waits out a whole budget for a job
     * that was never started. See {@link #healOrphanedAsk} for the belt to this
     * pair of braces.
     */
    public static void stopAsk() {
        askRunning = false;
        Thread w = askWorker;
        if (w != null) {
            w.interrupt();
        }
    }

    private static void runAsk(String prompt, long timeoutMs) {
        step("反代：写入问题并发送");
        // Snapshot the current last block first: after sending, our own prompt
        // becomes the last block, and without the "before" value we could not
        // tell our echo from Amoo's answer.
        String before = currentLastBlock();
        writeBack(prompt);

        long deadline = System.currentTimeMillis() + timeoutMs;
        String prev = null;
        int stable = 0;
        while (askRunning && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(3000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                askError = "interrupted";
                askState = ASK_FAILED;
                return;
            }
            String cur = currentLastBlock();
            if (cur == null || cur.length() == 0) {
                continue;
            }
            // Not a reply yet: it is either the pre-existing last block or our
            // own prompt echoing back.
            if (cur.equals(before) || cur.equals(prompt)) {
                continue;
            }
            step("反代：等 Amoo 输出稳定");
            if (cur.equals(prev)) {
                stable++;
            } else {
                stable = 0;
                prev = cur;
            }
            // Two identical consecutive samples. Amoo streams, so a single match
            // is not enough — a mid-stream snapshot would be returned as final.
            if (stable >= 2) {
                askReply = cur;
                askState = ASK_DONE;
                step("反代：已收到回复");
                return;
            }
        }
        if (!askRunning) {
            askError = "aborted";
            askState = ASK_FAILED;
            return;
        }
        askError = "timeout after " + timeoutMs + "ms";
        askState = ASK_FAILED;
        step("反代：超时");
    }

    /** The newest chat bubble right now, or "" when the screen cannot be read. */
    private static String currentLastBlock() {
        JSONObject dump = KhyUi.dispatch("ui_dump", args("max_nodes", 2000));
        if (!dump.optBoolean("ok", false)) {
            return "";
        }
        String chat = AmooChatText.extract(dump.optString("xml", ""), ID_CHAT_LIST, ID_INPUT, ID_SEND);
        return AmooChatText.lastChatBlock(chat);
    }

    /**
     * Load the shared memory. A missing or corrupt file yields an empty memory —
     * memory is a convenience, never a dependency, so this must not fail the loop.
     */
    private static void loadMemory() {
        try {
            JSONObject r = Tools.dispatch("read",
                    args("path", AmooMemory.DEFAULT_PATH, "max", 200000));
            memory = r.optBoolean("ok", false)
                    ? AmooMemory.fromJson(r.optString("content", ""))
                    : AmooMemory.empty();
        } catch (Throwable bad) {
            memory = AmooMemory.empty();
        }
    }

    /** Persist the shared memory. Failure is silent by design: see loadMemory. */
    private static void saveMemory() {
        try {
            Tools.dispatch("write",
                    args("path", AmooMemory.DEFAULT_PATH, "content", memory.toJson()));
        } catch (Throwable ignored) {
            // A failed memory write must never fail a command that already ran.
        }
    }

    /** Tunables. Defaults are deliberately conservative. */
    public static final class Options {
        public int maxRounds = 30;

        /**
         * Wall-clock ceiling for the whole loop.
         *
         * WAS 600000L (10 min), which was BELOW the round cap and made
         * {@link LoopState#MAX_ROUNDS} unreachable dead code: one Amoo turn
         * measures ~6 min on this device, so the loop was cut off about four
         * minutes into Amoo's SECOND turn, every single time. The deadline is
         * written to be the backstop for a reply that never comes (class
         * javadoc, note 4) — it has to cover every round maxRounds allows, or
         * the clock fires before the round cap can.
         *
         * The number is a RANGE, not a derivation, and the range cannot be
         * closed without the device. A round is a new BUBBLE, and the loop's
         * own write-backs are new bubbles too (see the class javadoc note 2:
         * {@link #writeBack} types into Amoo's box and taps send, which
         * produces a bubble {@link AmooChatText} sees). So a turn that carried
         * commands costs 2 rounds and a turn that carried none costs 1, giving
         * a rounds-per-turn ratio in [1, 2]. At ~6 min per turn, 30 rounds is
         * therefore 90-180 min. This takes the TOP of the range so that
         * MAX_ROUNDS — not the clock — is the binding stop for every admissible
         * ratio.
         *
         * What this is NOT: a claim that 3 hours is the right policy for how
         * long a phone may be occupied. That is a human decision and it is not
         * made here. If the policy ceiling is lower, lower maxRounds to match
         * rather than lowering this back below the round cap — otherwise the
         * exact bug above returns. {@code AmooLoopDeadlineDefaultTest} is the
         * guard against that.
         *
         * DELIBERATE DIVERGENCE, do not "fix": the PC-side twin
         * {@code runtime/node/backend/.../amoo/amooDispatchPlan.js} keeps its
         * own {@code capMs = 600000}. That is a different budget — it bounds
         * the PC's poll phase, which does not occupy a phone screen. This value
         * bounds a foreground loop on the device. They are not the same
         * quantity and should not be kept equal.
         *
         * Callers can still override per run: {@code Tools.loopStart} accepts
         * {@code deadline_ms} (Tools.java, with a 1 s lower clamp). A human who
         * wants a 10-minute leash asks for one; no capability was removed.
         */
        public long deadlineMs = 10_800_000L;    // 3 h; see the derivation above
        public long pollBaseMs = 3000L;
        public long pollMaxMs = 30000L;
        public int maxNodes = 5000;            // KhyUi caps at 5000
        public int maxWriteBackChars = 1500;   // Amoo's input box is not infinite
        /**
         * Whether to send the shared memory to Amoo when the loop starts.
         *
         * On by default because that IS the sharing. Turn it off when you only
         * want to accumulate memory locally — it costs one Amoo round trip, which
         * is measured at roughly six minutes on this device.
         */
        public boolean injectMemory = true;
    }

    /**
     * One command that ran, and what actually became of it.
     *
     * WHY this is not a bare tool name. The pending file is what a human reads
     * when the loop stops and asks for a decision. It used to carry
     * {@code ["write","toast"]} — a list of names with no verdict, so a command
     * that ran but could not be proven was indistinguishable from one that was
     * measured. The human then approved the next step believing the previous
     * one had been checked.
     *
     * Three outcomes, and they are NOT a boolean: "verified" means a post-state
     * was measured, "unverified" means it ran but nothing proved it, "failed"
     * means the tool reported failure. Collapsing the middle one into either
     * neighbour is the fabrication this whole loop is built to prevent.
     */
    public static final class ExecutedCommand {
        /** "verified" | "unverified" | "failed". */
        public static final String VERIFIED = "verified";
        public static final String UNVERIFIED = "unverified";
        public static final String FAILED = "failed";

        public final String tool;
        public final String outcome;

        /** Why it could not be verified. Null unless outcome is UNVERIFIED. */
        public final String why;

        public ExecutedCommand(String tool, String outcome, String why) {
            this.tool = tool;
            this.outcome = outcome;
            this.why = why;
        }

        public org.json.JSONObject toJson() throws org.json.JSONException {
            return new org.json.JSONObject()
                    .put("tool", tool)
                    .put("outcome", outcome)
                    .put("verified", VERIFIED.equals(outcome))
                    .put("why", why == null ? org.json.JSONObject.NULL : why);
        }
    }

    /**
     * Arm and start the loop. Safe to call when already running (no-op).
     *
     * @param mode how local execution is gated; the safety floor applies on top
     *             of every mode including BYPASS
     */
    public static synchronized void start(LoopModes.Mode mode, Options opt) {
        if (running) {
            return;
        }
        currentMode = mode == null ? LoopModes.defaultMode() : mode;
        final Options o = opt == null ? new Options() : opt;
        // Same refusal as ask(): without the accessibility service the loop
        // cannot read Amoo's screen, cannot type, cannot tap. Starting it anyway
        // would produce a report full of timeouts and the user would read that as
        // "Amoo is slow" rather than "the permission is off".
        if (!Tools.uiReady()) {
            running = false;
            armed = false;
            worker = null;
            report(Tools.uiAdvice());
            step("循环未启动：无障碍服务未开启");
            return;
        }
        // Set here, before the worker launches, so elapsedMs() covers real work.
        // Deliberately NOT in the "accessibility off" early-return above: that
        // path never runs a loop, and a non-zero elapsed would make the overlay
        // claim the loop has been working for however long the user sat there.
        startedAtMs = System.currentTimeMillis();
        armed = true;
        worker = new Thread(new Runnable() {
            public void run() {
                try {
                    runLoop(o);
                } catch (Throwable t) {
                    report("循环异常退出：" + t.getClass().getSimpleName() + ": " + t.getMessage(), true);
                } finally {
                    running = false;
                    armed = false;
                    worker = null;
                }
            }
        }, "amoo-loop");
        worker.setDaemon(true);
        running = true;
        worker.start();
        report("循环已启动，模式 " + currentMode);
        step("循环已启动，准备读屏");
    }

    /** Ask the loop to stop. It finishes the current command, then exits. */
    public static synchronized void stop() {
        armed = false;
        Thread w = worker;
        if (w != null) {
            w.interrupt();
        }
    }

    // ── the loop ────────────────────────────────────────────────────────────

    private static void runLoop(Options o) {
        LoopState.State st = new LoopState.State();
        st.maxRounds = o.maxRounds;
        st.deadlineMs = o.deadlineMs;
        long startedAt = System.currentTimeMillis();
        int lastBubbleHash = 0;
        List<ExecutedCommand> executed = new ArrayList<ExecutedCommand>();

        // Memory first: whatever we already know is the premise Amoo should work
        // from, and loading it before the first poll means a fact verified in a
        // previous run is not re-measured in this one.
        loadMemory();
        if (o.injectMemory && memory.size() > 0) {
            String inject = memory.renderForInjection(o.maxWriteBackChars);
            if (inject.length() > 0) {
                step("注入共享记忆（" + memory.verifiedCount() + " 条已核实，"
                        + memory.unverifiedCount() + " 条未证实）");
                writeBack("以下是我们已经核实过的事实，请以此为前提，不要重新测量：\n" + inject);
                report("已注入共享记忆：" + memory.verifiedCount() + " 条已核实、"
                        + memory.unverifiedCount() + " 条未证实");
            }
        }

        while (true) {
            if (!armed) {
                st.aborted = true;
            }
            st.elapsedMs = System.currentTimeMillis() - startedAt;
            LoopState.Verdict v = LoopState.shouldStop(st);
            if (v.stop) {
                // DONE 时若还有未验证命令，报告必须说出来。
                //
                // 原来这里只说"循环结束：Amoo 报告任务完成（已执行 N 条命令）"——
                // 听起来像一切验收过了。而 DONE 是 Amoo 自己声明的，让被检查的
                // 一方签验收单就是 fabrication。未验证的条数现在从 Verdict 带出来，
                // 一句话把它写清楚，比让用户以为万事大吉要好。
                String tail = "（已执行 " + executed.size() + " 条命令）";
                if (LoopState.DONE_SIGNAL.equals(v.reason) && v.unverified > 0) {
                    tail += "，其中 " + v.unverified + " 条未验证/无法验证——"
                            + "Amoo 声称完成，但这些命令的结果没有被核对";
                }
                report("循环结束：" + describeStop(v.reason) + tail);
                step("");
                return;
            }

            // ── read Amoo's screen ──
            step("读屏中…（第 " + (st.round + 1) + " 轮）");
            JSONObject dump = KhyUi.dispatch("ui_dump", args("max_nodes", o.maxNodes));
            if (!dump.optBoolean("ok", false)) {
                // A failed read is a transient error, not Amoo going quiet: it must
                // not count toward the stall. The deadline is the backstop.
                report("读屏失败：" + dump.optString("error", "未知") + "，重试中", true);
                step("读屏失败，重试中");
                if (!sleep(next(st.round, o))) {
                    return;
                }
                continue;
            }
            String xml = dump.optString("xml", "");
            if (AmooChatText.isTruncated(xml, o.maxNodes)) {
                // A truncated dump can hold half a fence. Never treat that as
                // "no command" — that would look like progress and stall the
                // task. Say so and keep waiting for a smaller reply.
                report("读屏被节点上限截断（" + o.maxNodes + "），等 Amoo 输出短一点的内容");
                step("读屏被截断，等更短的回复");
                if (!sleep(next(st.round, o))) {
                    return;
                }
                continue;
            }

            String chat = AmooChatText.extract(xml, ID_CHAT_LIST, ID_INPUT, ID_SEND);
            String bubble = AmooChatText.lastChatBlock(chat);

            // Still streaming: an open fence means the reply is not finished.
            // Waiting is mandatory here — executing half a fence would be wrong —
            // and it is not a lack of progress either.
            if (AmooProtocol.hasOpenFence(bubble)) {
                step("Amoo 还在输出，等围栏闭合");
                if (!sleep(next(st.round, o))) {
                    return;
                }
                continue;
            }

            int hash = bubble.hashCode();
            if (hash == lastBubbleHash || bubble.length() == 0) {
                // Nothing new since the last poll. THIS IS THE NORMAL STATE WHILE
                // AMOO THINKS — measured at roughly six minutes per turn on this
                // device. It must not count toward the stall: conflating "no new
                // reply yet" with "Amoo went quiet" made the loop give up before
                // the answer ever arrived. The wall-clock deadline is the backstop
                // for a reply that never comes.
                if (!sleep(next(st.round, o))) {
                    return;
                }
                continue;
            }
            lastBubbleHash = hash;

            // Fences first: they are the explicit contract. On this device they
            // are usually NOT there at all, because Amoo renders a fenced block
            // as structured UI and the backtick lines never reach the
            // accessibility tree — so fall back to command-shaped JSON.
            List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(bubble);
            boolean viaShape = false;
            if (fences.isEmpty()) {
                fences = AmooProtocol.extractCommands(bubble);
                viaShape = !fences.isEmpty();
            }
            if (fences.isEmpty()) {
                // A NEW turn carrying no command. This is genuine idleness: Amoo
                // answered, and the answer does not advance the task. Only this
                // counts toward the stall.
                st.noProgressPolls++;
                st.round++;
                if (!sleep(next(st.round, o))) {
                    return;
                }
                continue;
            }
            if (viaShape) {
                report("按命令形状识别到 " + fences.size() + " 条命令（围栏标记未进入无障碍树）");
            }
            // A new turn that does carry commands resets the idle counter.
            st.noProgressPolls = 0;

            // ── execute this bubble's commands, in order ──
            boolean stopLoop = false;
            // 本轮真实处理的命令数。名字不用 done——跟 st.doneSignalled 太像，
            // 而两者含义不同：这是"执行了几条"，那是"Amoo 声称完成了"。
            int processed = 0;
            // 完成信号之后又被丢弃的命令数。
            //
            // 为什么必须数：Amoo 偶尔会在同一个气泡里先发几条命令、再发
            // khy-done、然后又补几条。后面的几条永远不会执行——循环见到
            // DONE 就 break。以前这里什么都不说，于是"本轮 2 条命令已处理"
            // 听起来像全部处理完了，而实际有 3 条被静默丢掉。
            // 静默截断读起来像"全都覆盖了"，正是本项目反复在防的那件事。
            int droppedAfterDone = 0;
            for (int fi = 0; fi < fences.size(); fi++) {
                AmooProtocol.Fence f = fences.get(fi);
                if (!armed) {
                    break;
                }
                if (f.kind == AmooProtocol.FenceKind.DONE) {
                    st.doneSignalled = true;
                    droppedAfterDone = commandsDroppedAfterDone(fences, fi);
                    break;
                }
                if (f.kind == AmooProtocol.FenceKind.PLAN) {
                    // Amoo restated its understanding of the goal. Recorded, not
                    // executed: catching a misheard task here saves a wasted
                    // round of local work.
                    report("Amoo 复述目标：" + abbreviate(f.payload, 200));
                    continue;
                }
                processed++;
                String outcome = executeOne(currentMode, f, executed, processed, fences.size(), st);
                if (outcome != null) {
                    // Non-null means "stop the loop and tell the human".
                    //
                    // No pre-abbreviate here. This used to be
                    // writeBack(abbreviate(outcome, o.maxWriteBackChars)), and
                    // because maxWriteBackChars == forAmoo's own 1500 the text
                    // was cut TWICE: the inner cut produced 1500 chars plus
                    // "…（共 N 字，已截断）", and forAmoo then cut that again and
                    // replaced the marker with "…（共 1515 字，已截断）". Amoo was
                    // told the result was 1515 chars when it was N. A truncation
                    // marker that reports the wrong length is worse than none —
                    // it is a measured-looking fact that is false.
                    //
                    // forAmoo cuts once and reports the true length. The other
                    // pre-abbreviating sites (300/400) are below 1500 and so
                    // never re-trigger the outer cut; they keep their own
                    // budget, which is what their messages are sized for.
                    writeBack(outcome);
                    // The refused tool has to be recovered from the fence here,
                    // because executeOne returns a STRING and the tool name is
                    // the one thing the human needs in order to act. Parsing the
                    // payload again is cheap and pure; guessing it from the
                    // outcome sentence would be string surgery on prose.
                    AmooProtocol.ParseResult refusedParse =
                            AmooProtocol.parseExec(f.payload);
                    writePending(fences, executed,
                            refusedParse.ok ? refusedParse.tool : "（围栏解析失败）",
                            outcome);
                    report(outcome, true);
                    step("已停止，等待人确认");
                    // floorRefused, not aborted. `aborted` means a HUMAN stopped
                    // the loop; this is the machine refusing a command, and
                    // reporting it as "人工中止" told the human they had done
                    // something they had not — on the exact path whose whole
                    // purpose is to make the refusal legible.
                    st.floorRefused = true;
                    stopLoop = true;
                    break;
                }
            }
            if (stopLoop) {
                st.elapsedMs = System.currentTimeMillis() - startedAt;
                report("循环结束：" + describeStop(LoopState.FLOOR_REFUSED));
                return;
            }
            // 报"处理了多少条"要用真实处理数，不是围栏总数。
            //
            // 原来是 fences.size()——那里面包含解析失败被丢掉的、以及 DONE 之后
            // 又出现因而不会再执行的。把它们算进"已处理"会让数字对不上，
            // 而用户是按这个数字判断任务有没有走完的。
            if (droppedAfterDone > 0) {
                report("Amoo 在发出完成信号之后又给了 " + droppedAfterDone
                        + " 条命令，这些命令没有执行（完成信号之后的命令不再执行）");
                step("本轮 " + processed + " 条命令已处理，另有 " + droppedAfterDone
                        + " 条在完成信号之后、未执行");
            } else {
                step("本轮 " + processed + " 条命令已处理，等 Amoo 下一步");
            }
            st.round++;
            if (!sleep(next(st.round, o))) {
                return;
            }
        }
    }

    /**
     * Run one fenced command.
     *
     * @param index 1-based position of this command within its bubble
     * @param total how many commands the bubble carried
     * @return null when the command ran (or was reported back to Amoo and the
     *         loop should continue); non-null when the loop must stop and the
     *         human must be told.
     */
    private static String executeOne(LoopModes.Mode mode, AmooProtocol.Fence fence,
                                     List<ExecutedCommand> executed, int index, int total,
                                     LoopState.State st) {
        AmooProtocol.ParseResult parse = AmooProtocol.parseExec(fence.payload);
        if (!parse.ok) {
            // Bad JSON is Amoo's problem to fix, not a reason to stop the loop.
            writeBack("命令解析失败（" + parse.reason + "），请重新发这条命令，围栏内必须是合法 JSON。"
                    + "原文：" + abbreviate(fence.payload, 300));
            return null;
        }

        // ── 环内特判一：amoo_stop 是紧急出口，不走通用分级 ──
        //
        // 为什么它不能被安全底拦下：安全底的否决权针对的是**不可撤销的动作**，
        // 而中止是相反方向的——中止掉一次提问，不会有任何东西因此发生（少做一件
        // 事永远比多做一件安全）。把中止也当成需要确认的动作，等于让用户在手机
        // 上喊不停——那正是 P0-2 要修的那个伤害（此前 amoo_stop 在解析期被丢，
        // 用户连「命令没被认出来」都看不到）。
        //
        // 只在旁路档（BYPASS）走这条紧急出口：那一档的定义就是「不问我」，而且
        // 喊停的方向是安全的。计划档（PLAN）与编辑档（EDIT）仍然按各自的语义
        // 走——它们本来就不执行任何东西，人要停就自己停。
        if (isLoopStopCommand(mode, parse.tool)) {
            return executeStopInLoop(parse, executed, index, total);
        }

        // ── 环内特判二：amoo_ask 不能在环里自调用 ──
        //
        // 沿用 ui_type 的既有先例（LoopModes.uiTypeFloorReason 的注释）：那条红线
        // 只属于 Amoo 驱动的循环这一条路径。PC 经 HTTP /call 或文件信箱驱动
        // amoo_ask 一点不受影响——那两条路不过 LoopModes.decide，直接进
        // Tools.dispatch。
        //
        // 这条拒绝不是一道待确认的门：环内再问一次 Amoo 必然撞单飞锁，确认也解决
        // 不了。所以这里不用通用的「需要人确认后继续」句式，直接说清原因。
        if (isLoopAskCommand(parse.tool)) {
            return loopAskRefusal();
        }

        LoopModes.Decision d = LoopModes.decide(mode, parse.tool, parse.args);
        if (d.action != LoopModes.Action.EXECUTE) {
            // No interactive UI on this path: stop and hand the human the list.
            return "需要人确认后继续。命令 " + parse.tool + " 未执行。原因：" + d.reason;
        }

        step("执行 " + index + "/" + total + "：" + parse.tool);
        JSONObject result = Tools.dispatch(parse.tool, parse.args);
        boolean ok = result.optBoolean("ok", false);

        LoopVerify.Plan vp = LoopVerify.plan(parse.tool, parse.args, parse.verify);
        step("验证 " + index + "/" + total + "：" + parse.tool);
        String verdict = applyVerify(vp, result);
        // 一条 add，三个结局都从这里出去。
        //
        // 原来是 executed.add(parse.tool) 一支，放在三个分支之前，于是待确认
        // 清单里只有一个工具名、分不出验证与否。改成先算出结局再 add：
        // 仍然只有一个 add 点（不会漏），但带上了结论。
        String outcome = !ok
                ? ExecutedCommand.FAILED
                : (verdict == null ? ExecutedCommand.VERIFIED : ExecutedCommand.UNVERIFIED);
        executed.add(new ExecutedCommand(parse.tool, outcome,
                verdict == null ? null : verdict));

        if (ok && verdict == null) {
            // The one path where a fact has actually been measured, so this is
            // the only path allowed to write a VERIFIED memory entry. Everything
            // else stays unverified — see AmooMemory's class javadoc.
            rememberVerified(parse, vp, result);
            step("写回 " + index + "/" + total + "：" + parse.tool + "（已验证）");
            writeBack("命令 " + parse.tool + " 已执行，验证通过。"
                    + abbreviate(result.toString(), 400));
            return null;
        }
        if (ok && verdict != null) {
            // Ran without error but could not be proven. Never claim success.
            // 计数：这是"派发了但没验证"的那一类，DONE 时必须能让最终报告说出来。
            if (st != null) st.unverifiedCommands++;
            step("写回 " + index + "/" + total + "：" + parse.tool + "（未验证）");
            writeBack("命令 " + parse.tool + " 执行了，但【未能验证】：" + verdict
                    + "。实际返回：" + abbreviate(result.toString(), 400)
                    + "。请据此判断下一步，不要假设它成功了。");
            return null;
        }
        step("写回 " + index + "/" + total + "：" + parse.tool + "（失败）");
        writeBack("命令 " + parse.tool + " 失败：" + result.optString("error", "未知错误")
                + "。实际返回：" + abbreviate(result.toString(), 400)
                + "。请修正后重发。");
        return null;
    }

    /**
     * 环内紧急出口的判定：这条命令是不是「中止提问」。
     *
     * <p>package-visible 而不是 private，理由与 {@link #describeStop} 一样：
     * 判定本身就是这条路径的关键事实，让它能被单测钉住，比让它藏在方法体里
     * 只能靠真机观察要好。
     */
    static boolean isLoopStopCommand(LoopModes.Mode mode, String tool) {
        return "amoo_stop".equals(tool) && mode == LoopModes.Mode.BYPASS;
    }

    /** 环内自调用提问的判定：{@code amoo_ask} 在循环路径上必须被拒。 */
    static boolean isLoopAskCommand(String tool) {
        return "amoo_ask".equals(tool);
    }

    /**
     * 环内拒绝 {@code amoo_ask} 时的文案。
     *
     * <p>不用通用的「需要人确认后继续」句式：环内再问一次 Amoo 必然撞单飞锁，
     * 确认解决不了——写成「等确认」会让人一直等一个永远不会到来的确认。
     */
    static String loopAskRefusal() {
        return "命令 amoo_ask 未执行。原因：" + LoopModes.amooAskLoopReason();
    }

    /**
     * 环内执行 {@code amoo_stop}：助手闭环唯一的即时中止出口。
     *
     * <p>为什么单独一条路：{@code Tools.dispatch("amoo_stop")} 会调用
     * {@link #stopAsk()}，把 {@code askRunning} 单飞锁放掉并打断还在跑的提问
     * worker。那把锁一旦卡死（无障碍 IPC 卡在里面），PC 侧就只能白等整个预算
     * （420s~1800s），而用户在手机上唯一能喊停的出口就是这条命令——此前它在解析期
     * 被丢掉，用户连「命令没被认出来」都看不到。
     *
     * <p>为什么它绕开安全底：安全底否决的是**不可撤销的动作**，中止是相反方向的
     * （少做一件事永远比多做一件安全）。这条路径只在旁路档
     * （{@link LoopModes.Mode#BYPASS}）生效，那一档的定义就是「不问我」；计划档与
     * 编辑档仍按各自语义走——它们本来就不执行任何东西。
     *
     * <p>为什么中止之后循环继续：{@code amoo_stop} 的职责是中止**提问**（它的目录
     * 描述原文如此），不是停循环——停循环是 {@code loop_stop} 的事。把两件事混成
     * 一件，会让人喊停之后连 Amoo 也失去回应。
     *
     * @return null —— 这条命令已经执行，循环照常继续（与其它命令同一条返回约定）
     */
    private static String executeStopInLoop(AmooProtocol.ParseResult parse,
                                            List<ExecutedCommand> executed,
                                            int index, int total) {
        step("执行 " + index + "/" + total + "：amoo_stop");
        JSONObject result = Tools.dispatch("amoo_stop", parse.args);
        boolean ok = result.optBoolean("ok", false);
        // 结果本身就是后置状态：ask_running 说锁放没放掉，所以这一条可以算已核实。
        executed.add(new ExecutedCommand("amoo_stop",
                ok ? ExecutedCommand.VERIFIED : ExecutedCommand.FAILED, null));
        if (ok) {
            step("写回 " + index + "/" + total + "：amoo_stop（已中止提问）");
            writeBack("命令 amoo_stop 已执行：进行中的提问已中止，单飞锁已释放"
                    + "（ask_running=" + result.optBoolean("ask_running", false)
                    + "，循环本身仍在运行）。");
        } else {
            step("写回 " + index + "/" + total + "：amoo_stop（失败）");
            writeBack("命令 amoo_stop 失败：" + result.optString("error", "未知错误")
                    + "。实际返回：" + abbreviate(result.toString(), 400));
        }
        return null;
    }

    /**
     * Record a fact that a command actually proved.
     *
     * ONLY reachable when verification passed, which is what makes the entry
     * VERIFIED rather than a restatement. The fact is the measured post-state,
     * not the command: "read back /sdcard/g/main.py, 11 bytes" rather than
     * "write was called". Never throws — a memory write must not kill a command
     * that already succeeded.
     */
    private static void rememberVerified(AmooProtocol.ParseResult parse,
                                         LoopVerify.Plan vp, JSONObject result) {
        try {
            String text;
            if (vp != null && vp.kind == LoopVerify.Kind.READ_EQUALS) {
                JSONObject back = Tools.dispatch("read", args("path", vp.path));
                if (!back.optBoolean("ok", false)) {
                    text = "已核实 " + vp.path + " 写入成功，但回读失败";
                } else if (back.optBoolean("truncated", false)) {
                    // 读被截断时不许报一个字节数。
                    //
                    // 原来这里用 content 的长度（back.optString("content").getBytes()），
                    // 于是任何超过单次读取上限的文件都会被写成"共 262144 字节"——
                    // 一个错数字，以「已核实」的名义进共享记忆，然后每次 ask 都
                    // 注入给 Amoo 当既定事实。错的事实比没有事实更糟：
                    // Amoo 会拿它当前提做后续判断。
                    text = "已核实 " + vp.path + " 可读回，但内容超过单次读取上限被截断"
                            + "（实际大小 " + back.optLong("size", -1) + " 字节）";
                } else {
                    // size 是文件真实长度，read_bytes 才是读出来的量。两者都有，
                    // 报 size——那才是"这个文件有多大"这件事的答案。
                    text = "已核实 " + vp.path + " 可读回，共 "
                            + back.optLong("size", -1) + " 字节";
                }
            } else if (vp != null && vp.kind == LoopVerify.Kind.EXIT_ZERO) {
                text = "已核实命令退出码为 0";
            } else {
                // Should not happen: NONE means unverifiable, and this method is
                // only called on the verified path. Say so rather than inventing.
                text = "已执行 " + parse.tool + "，但无独立核实手段";
            }
            memory = memory.with("verified:" + parse.tool + ":" + vpPath(vp),
                    text, AmooMemory.Confidence.VERIFIED, "verified:" + parse.tool);
            saveMemory();
        } catch (Throwable ignored) {
            // Memory is a convenience, never a dependency.
        }
    }

    /**
     * How many command fences follow the first DONE fence at or after
     * {@code from}, and therefore never run.
     *
     * The loop breaks on DONE, so anything after it in the same bubble is
     * dropped. Counting it is the difference between "本轮 2 条命令已处理" and
     * "本轮 2 条命令已处理，另有 3 条在完成信号之后、未执行" — the first reads
     * as "everything was handled", which is a lie when three commands were
     * silently discarded.
     *
     * Package-visible because this is the test seam: the counting lives inside
     * {@link #runLoop}, which needs a live accessibility service to reach.
     * Extracting the arithmetic is what makes it testable on a bare JVM.
     *
     * @return 0 when there is no DONE fence, or nothing follows it.
     */
    static int commandsDroppedAfterDone(List<AmooProtocol.Fence> fences, int from) {
        if (fences == null) {
            return 0;
        }
        for (int i = Math.max(0, from); i < fences.size(); i++) {
            if (fences.get(i).kind != AmooProtocol.FenceKind.DONE) {
                continue;
            }
            int dropped = 0;
            for (int j = i + 1; j < fences.size(); j++) {
                if (fences.get(j).kind == AmooProtocol.FenceKind.EXEC) {
                    dropped++;
                }
            }
            return dropped;
        }
        return 0;
    }

    private static String vpPath(LoopVerify.Plan vp) {
        return vp == null || vp.path == null ? "" : vp.path;
    }

    /**
     * Actually check the post-state.
     *
     * @return null when verified; a Chinese explanation of what could not be
     *         proven otherwise.
     */
    private static String applyVerify(LoopVerify.Plan vp, JSONObject result) {
        if (vp == null || vp.kind == LoopVerify.Kind.NONE) {
            return "该工具没有可验证的手段，结果未经独立核对";
        }
        try {
            if (vp.kind == LoopVerify.Kind.READ_EQUALS) {
                JSONObject back = Tools.dispatch("read", args("path", vp.path));
                if (!back.optBoolean("ok", false)) {
                    return "回读 " + vp.path + " 失败：" + back.optString("error", "读不到");
                }
                String content = back.optString("content", "");
                int got = content.getBytes("UTF-8").length;
                // 先判截断，再比字节数。
                //
                // 原来是直接比 content 长度和 expectBytes，对不上就写"内容被截断了"。
                // 那把一个真实的字节数不符也说成截断——而截断是有专门字段的
                // （Tools.read 返回 truncated/size/read_bytes）。两个原因必须分开报：
                // 截断是读取上限造成的，可以让 Amoo 分页重读；字节数不符是内容不对，
                // 重读多少次都一样。
                if (back.optBoolean("truncated", false)) {
                    return "回读 " + vp.path + " 被单次读取上限截断"
                            + "（读了 " + back.optLong("read_bytes", got)
                            + " 字节，文件实际 " + back.optLong("size", -1)
                            + " 字节），无法按字节核对";
                }
                if (vp.expectBytes >= 0 && got != vp.expectBytes) {
                    return "回读 " + vp.path + " 得到 " + got
                            + " 字节，预期 " + vp.expectBytes + " 字节——内容与预期不符";
                }
                return null;
            }
            if (vp.kind == LoopVerify.Kind.EXIT_ZERO) {
                if (result.optInt("exit", -1) != 0) {
                    return "退出码 " + result.optInt("exit", -1) + "，不是 0";
                }
                if (vp.expectInStdout != null && vp.expectInStdout.length() > 0) {
                    String out = result.optString("out", "");
                    if (out.indexOf(vp.expectInStdout) < 0) {
                        return "stdout 里找不到预期的「" + vp.expectInStdout + "」";
                    }
                }
                return null;
            }
            if (vp.kind == LoopVerify.Kind.UI_TEXT_EQUALS) {
                JSONObject dump = KhyUi.dispatch("ui_dump", args("max_nodes", 200));
                if (!dump.optBoolean("ok", false)) {
                    return "回读界面失败：" + dump.optString("error", "未知");
                }
                String chat = AmooChatText.extract(dump.optString("xml", ""), ID_CHAT_LIST, ID_INPUT, ID_SEND);
                // The text we just typed lives in the input box, which is
                // excluded from the chat text — so compare against the input
                // node directly.
                String actual = inputBoxText(dump.optString("xml", ""));
                if (actual == null) {
                    return "界面上找不到输入框";
                }
                if (!actual.equals(vp.expectText)) {
                    return "输入框里是「" + abbreviate(actual, 80) + "」，预期「"
                            + abbreviate(vp.expectText, 80) + "」";
                }
                return null;
            }
        } catch (Throwable t) {
            return "验证过程本身出错：" + t.getClass().getSimpleName() + ": " + t.getMessage();
        }
        return "未知的验证类型";
    }

    /** Read the input box's text out of a dump, or null when absent. */
    private static String inputBoxText(String xml) {
        // AmooChatText works on the chat region; the input box is excluded from
        // it by design, so pull the attribute straight out of the dump here.
        int at = xml.indexOf(ID_INPUT);
        if (at < 0) {
            return null;
        }
        int gt = xml.indexOf('>', at);
        if (gt < 0) {
            return null;
        }
        String tag = xml.substring(at, gt + 1);
        String needle = "text=\"";
        int t = tag.indexOf(needle);
        if (t < 0) {
            return null;
        }
        int s = t + needle.length();
        int e = tag.indexOf('"', s);
        if (e < 0) {
            return null;
        }
        return AmooChatText.decode(tag.substring(s, e));
    }

    // ── write-back ──────────────────────────────────────────────────────────

    /**
     * Put text into Amoo's input box and press send.
     *
     * The send is the fragile half, and it fails in a way that is invisible from
     * a single attempt: right after {@code ui_type} the soft keyboard is still
     * animating in, and a dump taken during the animation can lack the send
     * button entirely — so the coordinate resolve comes back null and the
     * node-level fallback (which cannot click this ImageView) fails too. Measured
     * on the device, not theorised.
     *
     * Hence: settle, then retry the resolve-and-tap a few times, and report the
     * ACTUAL reason rather than a generic failure. {@code ui_click} is kept only
     * as a last resort — it is the thing that does not work here.
     */
    private static void writeBack(String text) {
        String payload = forAmoo(text);
        step("写回结果到 Amoo 输入框");
        JSONObject typed = KhyUi.dispatch("ui_type", args("text", payload));
        if (!typed.optBoolean("ok", false)) {
            report("写回失败：输入框写不进去——" + typed.optString("error", "未知")
                    + "（内容已存入 " + PENDING_TXT + "）", true);
            step("写回失败：输入框写不进去");
            lastWriteBack = "失败：输入框写不进去（已存 " + PENDING_TXT + "）";
            // The pending file is the HUMAN's recovery copy, not a channel to
            // Amoo — so it keeps the raw text. Sanitising it would destroy
            // exactly the path the human needs in order to act, and Amoo is
            // never told to read it. The invariant that matters is that
            // ui_type above only ever receives the sanitised payload.
            appendPending(abbreviate(text, 1500));
            return;
        }

        String lastWhy = "未尝试";
        for (int attempt = 1; attempt <= WRITE_BACK_ATTEMPTS && sending(); attempt++) {
            // Let the keyboard finish animating before asking where the button is.
            if (!sleep(WRITE_BACK_SETTLE_MS)) {
                return;
            }
            // A generous node ceiling: the chat list is large after a long reply
            // and a small cap truncates the dump before it reaches the input row.
            JSONObject dump = KhyUi.dispatch("ui_dump", args("max_nodes", 2000));
            if (!dump.optBoolean("ok", false)) {
                lastWhy = "读屏失败：" + dump.optString("error", "未知");
                continue;
            }
            String xml = dump.optString("xml", "");
            int[] centre = boundsCentre(xml, ID_SEND);
            if (centre == null) {
                lastWhy = "这次读屏里没有发送按钮（节点 " + (AmooChatText.isTruncated(xml, 2000) ? "被截断" : "数 ") + "）";
                continue;
            }
            JSONObject tapped = KhyUi.dispatch("ui_tap", args("x", centre[0], "y", centre[1]));
            if (tapped.optBoolean("ok", false)) {
                lastWriteBack = "已发送（" + text.length() + " 字）";
                return;
            }
            lastWhy = "坐标 (" + centre[0] + "," + centre[1] + ") 点不到："
                    + tapped.optString("error", "未知");
        }

        report("发送失败（重试 " + WRITE_BACK_ATTEMPTS + " 次仍未成）：" + lastWhy
                + "（内容已存入 " + PENDING_TXT + "）", true);
        lastWriteBack = "失败：" + lastWhy + "（已存 " + PENDING_TXT + "）";
        appendPending(abbreviate(text, 1500));
    }

    /**
     * The outbound transform, in the order {@link #writeBack} applies it.
     *
     * SANITISE BEFORE ABBREVIATE, never the other way round. {@code abbreviate}
     * cuts at a fixed character count, so a path straddling the cut survives as
     * a half-path — which is still an absolute path. Sanitising first removes
     * the path while it is whole. Both orders were checked and they differ.
     *
     * Package-visible rather than private because this is the test seam:
     * {@link #writeBack} needs a live accessibility service to exercise, and
     * this does not.
     *
     * Fails closed and loudly. If the transform itself throws, the payload is
     * NOT sent — an unsanitised result is a red-line breach, whereas a missing
     * one is merely a lost turn. The two are not comparable.
     */
    static String forAmoo(String text) {
        try {
            return abbreviate(AmooSafe.sanitise(text), 1500);
        } catch (Throwable bad) {
            report("结果泛化失败：" + bad.getClass().getSimpleName() + "，本条未复述原始结果", true);
            return "（结果泛化处理自身失败，未复述原始结果）";
        }
    }

    /** Centre point of a node's bounds in a dump, or null when absent. */
    private static int[] boundsCentre(String xml, String resourceId) {
        int at = xml.indexOf(resourceId);
        if (at < 0) {
            return null;
        }
        int gt = xml.indexOf('>', at);
        if (gt < 0) {
            return null;
        }
        String tag = xml.substring(at, gt + 1);
        String needle = "bounds=\"";
        int b = tag.indexOf(needle);
        if (b < 0) {
            return null;
        }
        int s = b + needle.length();
        int e = tag.indexOf('"', s);
        if (e < 0) {
            return null;
        }
        String bounds = tag.substring(s, e);
        try {
            int a = bounds.indexOf('[');
            int c = bounds.indexOf(']', a);
            int d = bounds.indexOf('[', c);
            int f = bounds.indexOf(']', d);
            if (a < 0 || c < 0 || d < 0 || f < 0) {
                return null;
            }
            String[] p1 = bounds.substring(a + 1, c).split(",");
            String[] p2 = bounds.substring(d + 1, f).split(",");
            int x1 = Integer.parseInt(p1[0].trim());
            int y1 = Integer.parseInt(p1[1].trim());
            int x2 = Integer.parseInt(p2[0].trim());
            int y2 = Integer.parseInt(p2[1].trim());
            return new int[] {(x1 + x2) / 2, (y1 + y2) / 2};
        } catch (Throwable bad) {
            return null;
        }
    }

    // ── persistence for the human ───────────────────────────────────────────

    /** Dump the commands that still need a human decision. */
    private static void writePending(List<AmooProtocol.Fence> fences,
            List<ExecutedCommand> executed) {
        writePending(fences, executed, null, null);
    }

    /**
     * @param refusedTool the tool the safety floor refused, or null when this is
     *        not a refusal. Recorded in the file because the human reads THIS to
     *        decide what to do next, and a refusal whose reason lives only in the
     *        log is a refusal the human cannot act on.
     * @param refusedWhy the floor's Chinese reason, or null.
     */
    private static void writePending(List<AmooProtocol.Fence> fences,
            List<ExecutedCommand> executed, String refusedTool, String refusedWhy) {
        try {
            JSONObject o = new JSONObject();
            o.put("reason", refusedTool == null ? "needs_human" : "floor_refused");
            o.put("mode", currentMode.name());
            if (refusedTool != null) {
                // The refused command is deliberately NOT in `executed` — it
                // never ran. Putting it there would make the list claim it did.
                o.put("refused", new JSONObject()
                        .put("tool", refusedTool)
                        .put("why", refusedWhy == null
                                ? org.json.JSONObject.NULL : refusedWhy));
            }
            // 每条命令带结论，不只是一个名字。理由见 ExecutedCommand 的注释：
            // 人是按这份清单决定要不要放行下一步的，分不出验证与否就等于
            // 让他拿着一个没核过的状态做判断。
            org.json.JSONArray done = new org.json.JSONArray();
            for (ExecutedCommand e : executed) {
                done.put(e.toJson());
            }
            o.put("executed", done);
            org.json.JSONArray pending = new org.json.JSONArray();
            for (AmooProtocol.Fence f : fences) {
                pending.put(new JSONObject()
                        .put("kind", f.kind.name())
                        .put("payload", f.payload)
                        .put("json_valid", f.jsonValid));
            }
            o.put("fences", pending);
            File file = new File(PENDING_FILE);
            File parent = file.getParentFile();
            if (parent != null) {
                parent.mkdirs();
            }
            java.io.FileOutputStream fo = new java.io.FileOutputStream(file);
            fo.write(o.toString(2).getBytes("UTF-8"));
            fo.flush();
            fo.getFD().sync();
            fo.close();
        } catch (Throwable t) {
            report("待确认清单写入失败：" + t.getMessage(), true);
        }
    }

    private static void appendPending(String text) {
        try {
            File file = new File(PENDING_FILE + ".txt");
            File parent = file.getParentFile();
            if (parent != null) {
                parent.mkdirs();
            }
            java.io.FileOutputStream fo = new java.io.FileOutputStream(file, true);
            fo.write(("\n===== " + System.currentTimeMillis() + " =====\n" + text + "\n").getBytes("UTF-8"));
            fo.flush();
            fo.close();
        } catch (Throwable ignored) {
            // Best effort: the notification already carries the summary.
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Build a tool-args object with one or two entries.
     *
     * JSONObject.put is a CHECKED exception and the bridge's own classes
     * (KhyUi / Tools) do not declare it, so a bare {@code args().put(...)} chain
     * does not compile without threading {@code throws JSONException} through
     * every helper. Funnelling the puts through here keeps this class's
     * "never throws" contract intact instead.
     *
     * put() only fails on a null key or a non-finite double. Every call site
     * passes a literal string key and an int / long / String, so the catch is
     * unreachable in practice — and the loop must not die because of it.
     */
    private static JSONObject args(String key, Object value) {
        try {
            return new JSONObject().put(key, value);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static JSONObject args(String k1, Object v1, String k2, Object v2) {
        try {
            return new JSONObject().put(k1, v1).put(k2, v2);
        } catch (JSONException e) {
            return args(k1, v1);
        }
    }

    private static long next(int round, Options o) {
        return LoopState.nextPollDelay(round, o.pollBaseMs, o.pollMaxMs);
    }

    /** Sleep, honouring a stop request. @return false when told to stop. */
    private static boolean sleep(long ms) {
        if (!armed) {
            return false;
        }
        try {
            Thread.sleep(Math.max(0, ms));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
        return armed;
    }

    private static String abbreviate(String s, int max) {
        if (s == null) {
            return "";
        }
        String v = s.trim();
        if (v.length() <= max) {
            return v;
        }
        return v.substring(0, max) + "…（共 " + v.length() + " 字，已截断）";
    }

    /**
     * The human-facing wording for a stop reason.
     *
     * Package-visible rather than private because the test seam matters here:
     * the wording IS the fix. A floor refusal that reads as 「人工中止」 tells the
     * human they did something they did not, and the only way to keep that from
     * coming back is to assert on the string.
     */
    static String describeStop(String reason) {
        if (LoopState.DONE_SIGNAL.equals(reason)) {
            return "Amoo 报告任务完成";
        }
        if (LoopState.FLOOR_REFUSED.equals(reason)) {
            return "安全底拒绝了一条命令，已停止（不是人工中止——机器拒的，"
                    + "被拒命令和原因在待确认清单里）";
        }
        if (LoopState.MAX_ROUNDS.equals(reason)) {
            return "达到轮数上限";
        }
        if (LoopState.DEADLINE.equals(reason)) {
            return "超过时间上限";
        }
        if (LoopState.STALLED.equals(reason)) {
            return "连续多轮没有新命令（Amoo 可能已放弃，或还没回复）";
        }
        if (LoopState.ABORTED.equals(reason)) {
            return "人工中止";
        }
        return reason == null ? "未知" : reason;
    }

    private static void report(String text) {
        report(text, false);
    }

    /**
     * Publish a report, optionally as a failure.
     *
     * The two-argument form exists for the overlay's "上一条错误" line: only real
     * failures belong there. Status broadcasts ("循环已启动") and the closing
     * sentence of a good run stay out, otherwise the overlay shows a permanent
     * error after a run that actually succeeded.
     *
     * The original single-argument signature is kept so the sixteen call sites
     * need no edit beyond the seven that are genuinely failures.
     */
    private static void report(String text, boolean isError) {
        lastReport = text;
        if (isError) {
            lastError = text;
        }
        Context c = Tools.ctxRef();
        if (c == null) {
            return;
        }
        try {
            BridgeService.notifyText("khy-os 本地循环", abbreviate(text, 900));
        } catch (Throwable ignored) {
            // A dead notification channel must never kill the loop.
        }
    }
}
