// khy-canary: Khy-20261101-046-WF9A93XM
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Tests for the elevation-state reporting.
 *
 * THE DEFECT: after a phone reboot the sidecar is gone — nothing on the device
 * can restart a uid-2000 process on its own without a platform-level handle —
 * so the bridge falls back to the app's own uid, where {@code input}/{@code am}/
 * {@code pm} silently do nothing while still reporting {@code ok:true}.
 *
 * That much was already reported. What was NOT reported was WHY: the reason
 * field was only ever written from inside {@code execElevated}, i.e. lazily on
 * the first command that happened to go down that path. On a device with no
 * elevated channel at all, {@code info} therefore answered with an empty
 * reason — which reads as "nothing wrong here". The one state the user most
 * needs to see after a reboot was the one state that said nothing.
 *
 * WHY IT MATTERS BEYOND BUG COUNT: the two ways to get a uid-2000 shell are
 * not interchangeable. The sidecar-from-a-PC route needs a computer. The
 * self-bootstrap route — the app talking to the phone's own wireless debugging
 * endpoint — needs no PC after a one-time pairing. A bridge that reports the
 * two identically hides the only self-sufficient option, which is exactly the
 * "don't depend on a PC after a reboot" requirement.
 *
 * 2026-11-12: there is now ONE elevation tier (third-party elevation apps are
 * gone), so the advice names TWO ROUTES to raise that tier rather than two
 * tiers.
 */
public class ElevationAdviceTest {

    // ---- the advice text, which is the user-facing deliverable ----

    @Test
    public void adviceNamesBothRoutesAndMarksTheOneThatNeedsAPc() {
        // Both routes down: the post-reboot state. The advice must name both and
        // say which needs a computer, because the phone is the thing the user
        // actually has with them.
        String a = Tools.elevationAdvice(false);
        assertNotNull(a);
        assertTrue("必须说明未提权", a.contains("未提权"));
        assertTrue("必须给出不需要电脑的那条路", a.contains("不需要电脑"));
        assertTrue("必须说明用手机自己的无线调试", a.contains("无线调试"));
        assertTrue("必须说明那条路需要电脑", a.contains("需要电脑"));
        // 2026-11-13：门控收紧后「看起来成功」不再是实况——这类命令现在被直接
        // 拒绝，所以断言钉住拒绝本身（码 + 不跑），比原来的模糊措辞更硬。
        assertTrue("必须说清两条都不做的后果是被直接拒绝",
                a.contains("ok=false") && a.contains("needs_shell"));
        assertTrue("必须说清不会以 App 身份跑一遍", a.contains("不会以 App 身份跑一遍"));
        assertTrue("必须说清提权是什么权限级别", a.contains("uid 2000"));
    }

    @Test
    public void adviceNeverPointsAtAThirdPartyApp() {
        // 2026-11-12 人裁决：完全移除第三方提权应用。The advice is the one text
        // the user reads when they ask "how do I get this", so if it ever
        // mentions the removed app again, the product decision has been
        // silently reversed.
        String a = Tools.elevationAdvice(false);
        assertFalse("不得再提已移除的提权应用", a.contains("Shizuku"));
        assertFalse("不得再提任何第三方提权 App", a.contains("安装"));
    }

    @Test
    public void adviceIsEmptyWhenTheChannelIsLive() {
        // No advice when there is nothing to advise. A permanent banner over a
        // working bridge trains the user to ignore it.
        assertEquals("", Tools.elevationAdvice(true));
    }

    @Test
    public void adviceIsDeterministic() {
        // It goes into a notification and a panel; instability would make them
        // flicker for no reason.
        assertEquals(Tools.elevationAdvice(false),
                Tools.elevationAdvice(false));
    }

    // ---- the probe, which is what makes the state known at all ----

    @Test
    public void theSidecarProbeExistsAndIsCallableFromStartup() throws Exception {
        // The fix is a probe, so the probe must exist and be public — BootReceiver
        // and HttpBridge's startup thread both call it, and neither is in this
        // package's test scope for anything else.
        java.lang.reflect.Method m = Tools.class.getMethod("probeSidecar");
        assertNotNull(m);
        assertEquals(0, m.getParameterTypes().length);
    }

    @Test
    public void theProbeIsWiredIntoBothStartupPaths() throws Exception {
        // THE property that makes the fix real: a probe that exists but is never
        // called is the same as no probe. Both the HTTP bridge's startup thread
        // and the boot receiver must call it.
        String http = readSource("HttpBridge.java");
        assertTrue("HttpBridge 启动线程必须探测提权通道",
                http.contains("Tools.probeSidecar()"));
        String boot = readSource("BootReceiver.java");
        assertTrue("BootReceiver 重启后必须重验提权通道",
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
    public void theProbeNeverLeavesAnEmptyReasonWhenTheChannelIsAbsent() throws Exception {
        // The original bug in one assertion: an absent channel must not produce
        // an empty reason — and the reason must be what was OBSERVED, not a
        // guess at the cause ("重启后需重跑 adb 命令" when the real reason might
        // be a slow cold start).
        String src = readSource("ShellSidecarClient.java");
        assertTrue("探测失败必须写一整句原因",
                src.contains("PING 未应答"));
        assertTrue("连不上也必须写原因",
                src.contains("sidecar 不可达"));
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
