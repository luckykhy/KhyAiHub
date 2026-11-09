// khy-canary: Khy-20261101-046-WF9A93XM
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Tests for the elevation-state reporting gap.
 *
 * THE DEFECT: after a phone reboot the sidecar is gone — it is started by
 * {@code adb shell dalvikvm} from a PC, so it does not come back on its own. The
 * bridge then falls back to the app's own uid, where {@code input}/{@code am}/
 * {@code pm} silently do nothing while still reporting {@code ok:true}.
 *
 * That much was already reported. What was NOT reported was the Shizuku tier:
 * its {@code shizukuWhy} was only ever written from inside {@code execViaShizuku},
 * i.e. lazily on the first command that happened to go down that path. On a
 * device with no Shizuku at all, {@code info} therefore answered
 * {@code "shizuku":false,"shizuku_why":""} — which reads as "nothing wrong here".
 * The one state the user most needs to see after a reboot was the one state that
 * said nothing.
 *
 * WHY IT MATTERS BEYOND BUG COUNT: the two elevation tiers are not
 * interchangeable. The sidecar needs a computer. Shizuku on Android 11+ is
 * started from the phone's OWN wireless debugging — no PC, no root, one tap. A
 * bridge that reports the two identically hides the only self-sufficient option,
 * which is exactly the "don't depend on a PC after a reboot" requirement.
 */
public class ElevationAdviceTest {

    // ---- the advice text, which is the user-facing deliverable ----

    @Test
    public void adviceNamesBothRoutesAndMarksTheOneThatNeedsAPc() {
        // Both tiers down: the post-reboot state. The advice must name both and
        // say which needs a computer, because the phone is the thing the user
        // actually has with them.
        String a = Tools.elevationAdvice(false, false);
        assertNotNull(a);
        assertTrue("必须说明未提权", a.contains("未提权"));
        assertTrue("必须给出不需要电脑的那条路", a.contains("不需要电脑"));
        assertTrue("必须点名 Shizuku", a.contains("Shizuku"));
        assertTrue("必须说明用手机自己的无线调试", a.contains("无线调试"));
        assertTrue("必须说明那条路需要电脑", a.contains("需要电脑"));
        assertTrue("必须说清两条都不做的后果", a.contains("看起来成功"));
    }

    @Test
    public void adviceIsEmptyWhenEitherTierIsLive() {
        // No advice when there is nothing to advise. A permanent banner over a
        // working bridge trains the user to ignore it.
        assertEquals("", Tools.elevationAdvice(true, false));
        assertEquals("", Tools.elevationAdvice(false, true));
        assertEquals("", Tools.elevationAdvice(true, true));
    }

    @Test
    public void adviceIsDeterministic() {
        // It goes into a notification and a panel; instability would make them
        // flicker for no reason.
        assertEquals(Tools.elevationAdvice(false, false),
                Tools.elevationAdvice(false, false));
    }

    // ---- the probe, which is what makes the state known at all ----

    @Test
    public void theShizukuProbeExistsAndIsCallableFromStartup() throws Exception {
        // The fix is a probe, so the probe must exist and be public — BootReceiver
        // and HttpBridge's startup thread both call it, and neither is in this
        // package's test scope for anything else.
        java.lang.reflect.Method m = Tools.class.getMethod("probeShizuku");
        assertNotNull(m);
        assertEquals(0, m.getParameterTypes().length);
    }

    @Test
    public void theProbeIsWiredIntoBothStartupPaths() throws Exception {
        // THE property that makes the fix real: a probe that exists but is never
        // called is the same as no probe. Both the HTTP bridge's startup thread
        // and the boot receiver must call it.
        String http = readSource("HttpBridge.java");
        assertTrue("HttpBridge 启动线程必须探测 Shizuku",
                http.contains("Tools.probeShizuku()"));
        String boot = readSource("BootReceiver.java");
        assertTrue("BootReceiver 重启后必须重验 Shizuku",
                boot.contains("Tools.probeShizuku()"));
        assertTrue("BootReceiver 重启后必须重验 sidecar",
                boot.contains("Tools.probeSidecar()"));
    }

    @Test
    public void infoCarriesTheAdviceSoThePanelDoesNotHaveToComposeIt() throws Exception {
        // One source of the wording. If the panel composes its own, the three
        // surfaces drift and the user gets three different answers to "what do I
        // do" — on the exact screen they look at when the bridge seems broken.
        String src = readSource("Tools.java");
        assertTrue("info 必须带上 elevation_advice",
                src.contains("\"elevation_advice\""));
        assertTrue("advice 必须由 Tools 统一给，不是各界面自己拼",
                src.contains("elevationAdvice()"));
    }

    @Test
    public void theProbeNeverLeavesAnEmptyReasonWhenShizukuIsAbsent() throws Exception {
        // The original bug in one assertion: absent Shizuku must not produce an
        // empty reason. `Status.toString()` distinguishes ready /
        // installed-but-not-started / not-installed, and the probe stores the
        // whole sentence — so "absent" can never be spelled "".
        String src = readSource("Tools.java");
        assertTrue("探测必须存整句，不能存裸码",
                src.contains("st.toString()"));
        // And a failed probe must say so rather than stay silent.
        assertTrue("探测失败也必须留一句话",
                src.contains("提权状态探测失败"));
    }

    // ---- helper ----

    private static String readSource(String name) throws Exception {
        java.util.List<String> tried = new java.util.ArrayList<String>();
        for (String base : new String[] {
            System.getProperty("user.dir", "."),
            Tools.class.getProtectionDomain().getCodeSource().getLocation().getPath(),
        }) {
            java.io.File cur = new java.io.File(base);
            for (int up = 0; up < 6 && cur != null;
                    up++, cur = cur.getParentFile()) {
                java.io.File c = new java.io.File(cur,
                        "app/src/main/java/com/khyos/khy_os_client/bridge/" + name);
                tried.add(c.getAbsolutePath());
                if (c.isFile()) {
                    return new String(java.nio.file.Files.readAllBytes(c.toPath()),
                            java.nio.charset.StandardCharsets.UTF_8);
                }
            }
        }
        throw new IllegalStateException("找不到 " + name + "，已试：" + tried);
    }
}
