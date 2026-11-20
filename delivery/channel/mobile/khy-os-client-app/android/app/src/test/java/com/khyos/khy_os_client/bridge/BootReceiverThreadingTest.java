package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertTrue;

import android.content.Intent;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * The boot broadcast must refresh the availability table on a background
 * thread, never on the thread that received the broadcast.
 *
 * THE DEFECT this pins down: BootReceiver.onReceive called
 * Tools.refreshAvailability() inline. onReceive of a manifest-declared
 * receiver (AndroidManifest.xml:185-193, BOOT_COMPLETED +
 * MY_PACKAGE_REPLACED, exported) always runs on the main thread, and
 * refreshAvailability does eight getPackageInfo calls — the cost its own
 * javadoc restricts to background threads (Tools.java:1953). Eight
 * package-manager round trips inside the boot handler is main-thread IO at the
 * one moment the user is watching the phone come up.
 *
 * WHY THIS IS A BEHAVIOUR TEST AND NOT A SOURCE TEST. The repo has been burned
 * by "the source contains new Thread" assertions: they stay green while the
 * code is wrong (thread created, call still inline). So nothing here reads a
 * source file. The test drives the receiver's own dispatch through an executor
 * it can watch, and asserts two properties of the RUN:
 *
 *   1. the refresh happens on a thread other than the receiving one;
 *   2. the receiver returns before the refresh has finished.
 *
 * WHY A SEAM AND WHY AN ACTION STRING. onReceive takes an Intent, and the bare
 * JVM cannot build one — every method body of the platform jar throws
 * RuntimeException("Stub!") (the same reason build.gradle puts the real
 * org.json on the test classpath). So onReceive delegates to
 * onAction(Context, String) with exactly the action it extracted, and this
 * test drives onAction. Nothing above that delegation is skipped.
 */
public class BootReceiverThreadingTest {

    private Executor production;

    @Before
    public void rememberTheProductionExecutor() {
        production = BootReceiver.refreshExecutor;
    }

    @After
    public void putTheProductionExecutorBack() {
        BootReceiver.refreshExecutor = production;
    }

    @Test
    public void theRefreshRunsOffTheThreadThatReceivedTheBroadcast() throws Exception {
        GatedExecutor gate = new GatedExecutor();
        BootReceiver.refreshExecutor = gate;

        Thread caller = Thread.currentThread();
        BootReceiver.onAction(null, Intent.ACTION_BOOT_COMPLETED);

        assertTrue("刷新任务没有被派发出去——它又变成行内调用了",
                gate.entered.await(10, TimeUnit.SECONDS));
        assertNotSame("刷新跑在收广播的同一条线程上，那正是要修的那件事",
                caller, gate.ranOn.get());
        assertEquals("一次开机只该刷一次可用性", 1, gate.dispatches.get());

        gate.release.countDown();
        assertTrue("放行之后后台任务仍然没有跑完", gate.done.await(10, TimeUnit.SECONDS));
    }

    @Test
    public void theReceiverReturnsBeforeTheRefreshHasFinished() throws Exception {
        GatedExecutor gate = new GatedExecutor();
        BootReceiver.refreshExecutor = gate;

        BootReceiver.onAction(null, Intent.ACTION_BOOT_COMPLETED);

        // Back already, while the task sits parked at the gate and the refresh
        // therefore has not run. A receiver that waited for the refresh could
        // not reach this line with both assertions still true.
        assertTrue("刷新任务没有被派发出去", gate.entered.await(10, TimeUnit.SECONDS));
        assertFalse("onReceive 等刷新跑完才返回", gate.finished);

        gate.release.countDown();
        assertTrue("放行之后刷新仍然没有跑完", gate.done.await(10, TimeUnit.SECONDS));
    }

    @Test
    public void theDispatchedTaskIsTheAvailabilityRefresh() throws Exception {
        GatedExecutor gate = new GatedExecutor();
        BootReceiver.refreshExecutor = gate;
        long before = availabilityRefreshedAt();

        BootReceiver.onAction(null, Intent.ACTION_BOOT_COMPLETED);
        assertTrue("刷新任务没有被派发出去", gate.entered.await(10, TimeUnit.SECONDS));

        // Windows' currentTimeMillis ticks at ~15.6ms, so a strict "the
        // timestamp moved" check needs the clock to actually move between the
        // two reads — otherwise a refresh that DID run can read as unchanged.
        Thread.sleep(30);
        gate.release.countDown();
        assertTrue(gate.done.await(10, TimeUnit.SECONDS));

        assertTrue("派发出去的不是可用性刷新", availabilityRefreshedAt() > before);
    }

    @Test
    public void theProductionExecutorAlsoRunsTheRefreshOffTheCaller() throws Exception {
        // The real default, wrapped rather than replaced: this is the executor
        // a phone actually runs, so it is the one that has to be off-thread.
        SpyExecutor spy = new SpyExecutor(BootReceiver.refreshExecutor);
        BootReceiver.refreshExecutor = spy;

        Thread caller = Thread.currentThread();
        BootReceiver.onAction(null, Intent.ACTION_BOOT_COMPLETED);

        assertTrue("生产 executor 没有把刷新交到另一条线程上跑",
                spy.entered.await(10, TimeUnit.SECONDS));
        assertNotSame("生产 executor 在收广播的那条线程上跑刷新", caller, spy.ranOn.get());
    }

    @Test
    public void theUpdateBroadcastRefreshesOffThreadToo() throws Exception {
        GatedExecutor gate = new GatedExecutor();
        BootReceiver.refreshExecutor = gate;

        BootReceiver.onAction(null, Intent.ACTION_MY_PACKAGE_REPLACED);

        assertTrue("MY_PACKAGE_REPLACED 没有派发刷新", gate.entered.await(10, TimeUnit.SECONDS));
        assertNotSame("MY_PACKAGE_REPLACED 的刷新跑在调用线程上",
                Thread.currentThread(), gate.ranOn.get());

        gate.release.countDown();
        assertTrue(gate.done.await(10, TimeUnit.SECONDS));
    }

    @Test
    public void anUnrelatedBroadcastRefreshesNothing() {
        GatedExecutor gate = new GatedExecutor();
        BootReceiver.refreshExecutor = gate;

        BootReceiver.onAction(null, "com.example.SOMETHING_ELSE");

        assertEquals("不相干的广播也去刷可用性", 0, gate.dispatches.get());
    }

    // ── helpers ────────────────────────────────────────────────────────────

    /**
     * Runs the task on a real background thread but will not let it finish
     * until the test says so. The gate is what turns "the receiver did not
     * wait" from a race into a fact: while the latch is held the refresh
     * physically cannot complete, so a receiver that has already returned by
     * then returned without it.
     */
    private static final class GatedExecutor implements Executor {
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        final CountDownLatch done = new CountDownLatch(1);
        final AtomicReference<Thread> ranOn = new AtomicReference<Thread>();
        final AtomicInteger dispatches = new AtomicInteger();
        volatile boolean finished;

        public void execute(final Runnable task) {
            dispatches.incrementAndGet();
            new Thread(new Runnable() {
                public void run() {
                    ranOn.set(Thread.currentThread());
                    entered.countDown();
                    try {
                        release.await();
                    } catch (InterruptedException ignored) {
                        Thread.currentThread().interrupt();
                    }
                    try {
                        task.run();
                        finished = true;
                    } finally {
                        done.countDown();
                    }
                }
            }, "test-avail-probe").start();
        }
    }

    /** Wraps the production executor so the test can see which thread it chose. */
    private static final class SpyExecutor implements Executor {
        private final Executor delegate;
        final CountDownLatch entered = new CountDownLatch(1);
        final AtomicReference<Thread> ranOn = new AtomicReference<Thread>();

        SpyExecutor(Executor delegate) {
            this.delegate = delegate;
        }

        public void execute(final Runnable task) {
            delegate.execute(new Runnable() {
                public void run() {
                    ranOn.set(Thread.currentThread());
                    entered.countDown();
                    task.run();
                }
            });
        }
    }

    /**
     * The only observable effect of a refresh: the cache timestamp. Read by
     * reflection because it is private and there is deliberately no getter for
     * the raw value — availabilityAgeMs() is derived from it and drifts with
     * the clock, so it cannot tell "refreshed just now" from "refreshed a
     * while ago".
     */
    private static long availabilityRefreshedAt() throws Exception {
        java.lang.reflect.Field f = Tools.class.getDeclaredField("availRefreshedAt");
        f.setAccessible(true);
        return f.getLong(null);
    }
}
