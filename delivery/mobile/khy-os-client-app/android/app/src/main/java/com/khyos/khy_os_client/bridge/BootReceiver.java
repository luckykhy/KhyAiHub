// khy-canary: Khy-20261101-009-TKNBDH37
package com.khyos.khy_os_client.bridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.khyos.khy_os_client.AccessibilitySetup;

import java.util.concurrent.Executor;

/**
 * 开机 / 应用更新后自启桥。用户装了 khy-os 手机端，桥就应该在——
 * 「桥在 App 里」的默认语义，不需要每次手动开。
 * 悬浮框同理连带拉起（BridgeService.onCreate 会做）。
 *
 * 开机后同样要检查无障碍授权：设置一般能跨重启保留，但一旦没保留，
 * 症状和 force-stop 那次完全一样（桥活着、UI 工具全废），处理方式也一样。
 */
public class BootReceiver extends BroadcastReceiver {

    /**
     * Where the availability refresh runs. Production hands it to one fresh
     * thread — the same shape as HttpBridge.start's "avail-probe" thread.
     *
     * Mutable only so the unit test can install an executor it can watch:
     * "the refresh did not run on the receiving thread" is the one property
     * this receiver must guarantee, and it is not observable from outside the
     * executor. See BootReceiverThreadingTest.
     */
    static Executor refreshExecutor = new Executor() {
        public void execute(Runnable r) {
            new Thread(r, "avail-probe").start();
        }
    };

    @Override
    public void onReceive(Context c, Intent intent) {
        onAction(c, intent == null ? null : intent.getAction());
    }

    /**
     * Package-private so the unit test can drive the same code path: onReceive
     * takes an Intent, and the bare JVM cannot build one (every method body of
     * the platform jar throws "Stub!"), so the test hands over the action
     * string onReceive would have extracted. Everything below this line is
     * the code under test.
     */
    static void onAction(Context c, String action) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            try {
                BridgeService.start(c);
            } catch (Throwable ignored) {}

            // A reinstall clears enabled_accessibility_services (measured with
            // `adb install -r`: the key comes back null). Restore it, but only
            // when the user is on record as having turned it on through the app
            // — see AccessibilitySetup.restoreIfConsented for why this is wired
            // to MY_PACKAGE_REPLACED and not to BOOT_COMPLETED.
            //
            // Not silent: the user is told the app re-granted itself screen
            // access, because that is not a thing to do quietly.
            if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
                try {
                    AccessibilitySetup.Attempt a = AccessibilitySetup.restoreIfConsented(c);
                    if (a != null) {
                        if (a.ok) {
                            ReviveReceiver.notifyA11yRestored(c, a.via);
                        } else {
                            // Consent exists but the write failed — almost
                            // always because there is no elevation channel
                            // after a reinstall (the sidecar is a uid-2000
                            // process started from a PC and does not survive).
                            // Fall through to the one-tap system-settings
                            // notification below rather than leaving the user
                            // with dead UI tools and no explanation.
                            ReviveReceiver.ensureAccessibility(c);
                        }
                    }
                } catch (Throwable ignored) {}
            }

            ReviveReceiver.ensureAccessibility(c);
            // Re-probe elevation after a reboot.
            //
            // A reboot kills the sidecar (it was started by `adb shell dalvikvm`
            // from a PC), so the bridge comes back on the app's own uid and every
            // input/am/pm command becomes a no-op that still reports success.
            // HttpBridge.start already probes on the normal path; this covers the
            // case where the bridge was already running when the boot broadcast
            // arrived, and re-arms the panel so the degraded state is visible
            // immediately rather than after the first failed command.
            try {
                Tools.probeShizuku();
            } catch (Throwable ignored) {}
            try {
                Tools.probeSidecar();
            } catch (Throwable ignored) {}
            // 同理刷一次可用性：桥可能在上一次进程里已经跑着，那时刷的缓存
            // 属于那个进程，新进程要自己有一份。
            //
            // Dispatched, never called: refreshAvailability does eight
            // getPackageInfo calls and its own javadoc (Tools.java:1953)
            // restricts it to background threads, while onReceive of a
            // manifest-declared receiver always runs on the main thread. The
            // try/catch stays — a failed probe must not take the receiver
            // down — but it is not the fix; the dispatch is.
            refreshExecutor.execute(new Runnable() {
                public void run() {
                    try {
                        Tools.refreshAvailability();
                    } catch (Throwable ignored) {}
                }
            });
        }
    }
}
