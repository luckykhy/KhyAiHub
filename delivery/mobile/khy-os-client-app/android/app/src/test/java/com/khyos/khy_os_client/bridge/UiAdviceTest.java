// khy-canary: Khy-20261101-055-CRT866M6
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Tests for the accessibility-service reporting gap.
 *
 * THE DEFECT, found on the real device on 2026-10-25: {@code info} answered
 * {@code "ui":false} and nothing else. {@code settings get secure
 * enabled_accessibility_services} returned {@code null} — the service had never
 * been turned on — and so every {@code amoo_ask} wrote its prompt into a pending
 * file, retried, and then waited out its entire budget before failing with
 * {@code "timeout after 120000ms"}. Two minutes of silence for a condition that
 * is knowable in one boolean read.
 *
 * WHY IT IS THE BLOCKING LAYER, NOT THE THIRD ONE. Elevation decides whether
 * commands take effect. Accessibility decides whether there is a loop at all:
 * the loop reads Amoo's screen through it, types into its input box through it,
 * and taps send through it. A bridge that reports {@code ui:false} as a bare flag
 * with no reason and no remedy is telling the user "something is off" on the one
 * screen where they have no way to guess what.
 *
 * It is the same shape as the elevation gap fixed the same day
 * ({@code "shizuku_why":""} reading as "nothing wrong here"), which is why the
 * fix is the same shape: a reason field, an advice field, and one source for both.
 */
public class UiAdviceTest {

    // ---- the advice, which is the user-facing deliverable ----

    @Test
    public void adviceSaysTheLoopCannotRunAtAll() {
        // The consequence must be stated as total, not partial. "部分功能不可用"
        // would send the user looking for a workaround; there is none.
        String a = Tools.uiAdvice(false);
        assertTrue("必须说清循环跑不了", a.contains("循环"));
        assertTrue("必须说清是读写界面和点击都做不了", a.contains("读"));
        assertTrue("必须点到无障碍服务", a.contains("无障碍"));
    }

    @Test
    public void advicePointsAtTheAppsOwnScreenNotAtAdb() {
        // This is a user-consent permission over screen content, so it is the
        // user's to grant, and the app already has a chip for it. Pointing at an
        // adb command would be pointing at a PC the user may not have — the exact
        // mistake the elevation advice was rewritten to stop making.
        String a = Tools.uiAdvice(false);
        assertTrue("必须给出 App 内的入口", a.contains("本 App"));
        assertTrue("必须给出系统设置路径", a.contains("系统设置"));
    }

    @Test
    public void adviceNamesTheSymptomTheUserActuallySaw() {
        // "timeout after 120000ms" is what came back. Naming it is what lets the
        // user connect the advice to the failure they are looking at.
        String a = Tools.uiAdvice(false);
        assertTrue("必须复现用户看到的那句超时", a.contains("timeout after 120000ms"));
    }

    @Test
    public void adviceSeparatesThisFromElevation() {
        // Two independent gates, and conflating them wastes a trip: a user who
        // fixes elevation and re-runs gets the same silence.
        String a = Tools.uiAdvice(false);
        assertTrue("必须说明提权是另一件事", a.contains("提权"));
    }

    @Test
    public void adviceIsEmptyWhenTheServiceIsReady() {
        // No banner over a working loop. A permanent notice trains the user to
        // ignore it, and then it is worse than nothing.
        assertEquals("", Tools.uiAdvice(true));
    }

    @Test
    public void adviceIsDeterministic() {
        // It goes into info, a report and a step line; instability would make the
        // panel flicker for no reason.
        assertEquals(Tools.uiAdvice(false), Tools.uiAdvice(false));
    }

    // ---- the reason, which is what makes the flag legible ----

    @Test
    public void theReasonIsNeverEmptyWhenTheServiceIsDown() throws Exception {
        // The whole bug in one assertion: the degraded state must not be spelled
        // as a bare flag with no text. uiWhy() cannot be called on a bare JVM
        // (it reaches the accessibility service), so assert the constant exists
        // and is a sentence rather than a code.
        String src = readSource("Tools.java");
        assertTrue("未开启时必须给一句话，不能给空串",
                src.contains("无障碍服务未开启"));
        assertTrue("原因必须由 uiWhy 提供，不能只由 advice 提供",
                src.contains("public static String uiWhy()"));
    }

    // ---- the fail-fast, which is what stops the two-minute hang ----

    @Test
    public void askRefusesUpFrontInsteadOfWaitingOutTheBudget() throws Exception {
        // Measured: 120032ms then "timeout after 120000ms". The condition is
        // readable before the thread starts, so it must be checked before the
        // thread starts — same as the foreground check directly below it.
        String src = readSource("AmooLoop.java");
        assertTrue("ask 必须前置检查无障碍", src.contains("if (!Tools.uiReady())"));
        assertTrue("ask 必须把 advice 写进 askError，否则调用方只看到 null",
                src.contains("askError = Tools.uiAdvice();"));
        assertTrue("ask 必须置失败态，不能停在 running",
                src.contains("askState = ASK_FAILED;"));
    }

    @Test
    public void theLoopAlsoRefusesRatherThanProducingATimeoutReport() throws Exception {
        // Starting the loop without it does not fail loudly — it produces a
        // report full of timeouts, which the user reads as "Amoo is slow".
        String src = readSource("AmooLoop.java");
        assertTrue("loop_start 也必须拒",
                src.contains("循环未启动：无障碍服务未开启"));
        assertTrue("拒了必须把原因写进 report，不能静默 return",
                src.contains("report(Tools.uiAdvice());"));
    }

    @Test
    public void loopStartAnswersWithAFailureCodeNotASuccessAndADeadLoop()
            throws Exception {
        // Measured on PZ261A before this was added: `{"ok":true,"running":false}`
        // with the reason sitting in `report`. A caller that checks `ok` sees
        // success; a caller that checks `running` sees a loop that started and
        // instantly finished. Neither tells them the permission is off.
        //
        // AmooLoop.start() already refuses, but it can only express that as
        // running == false — which is exactly what "already finished" looks like.
        // So the HTTP layer needs its own honest code.
        String src = readSource("Tools.java");
        assertTrue("loop_start 拒了必须回 ok:false，不能回 ok:true + running:false",
                src.contains("if (!Tools.uiReady()) {\n            return r.put(\"ok\", false)\n"
                        + "                    .put(\"code\", \"refused\")"));
    }

    @Test
    public void theRefusalIsNotSwallowedByTheSingleFlightBranch() throws Exception {        // THE BUG THIS GUARDS. ask()'s own comment says "null 有三种原因", but only
        // two were ever branched. The accessibility pre-flight was the third, and
        // it fell straight into `single_flight` — which reported a task in
        // progress when there was none, and threw the real reason away. The
        // caller then polled amoo_result, got the same advice back, and still had
        // no idea what to do.
        //
        // So the wrapper must pass a non-empty reason through as its own outcome
        // rather than claiming a concurrent task.
        String src = readSource("Tools.java");
        assertTrue("非空 reason 必须单独成一个 code，不能落到 single_flight",
                src.contains(".put(\"code\", \"refused\")"));
        assertTrue("refused 必须把原句带回去",
                src.contains(".put(\"error\", why);"));
    }

    @Test
    public void theRefusalCostsZeroMillisecondsAndSaysSo() throws Exception {
        // askResult() reports ms as askEndedAt - askStartedAt. A pre-flight that
        // sets only the end produces a raw epoch value where a duration belongs —
        // measured 1792914991499 on device. Both stamps, or the field lies.
        String src = readSource("AmooLoop.java");
        assertTrue("前置拒绝必须同时盖住起止两个时间戳",
                src.contains("askStartedAt = now;"));
        assertTrue("前置拒绝必须同时写 askEndedAt",
                src.contains("askEndedAt = now;"));
        // And it must not leave a stale reply behind from an earlier ask.
        assertTrue("前置拒绝必须清空上一个 reply",
                src.contains("askReply = \"\";"));
    }

    @Test
    public void infoCarriesBothFieldsSoThePanelDoesNotComposeItsOwn()
            throws Exception {
        // One source of wording. If the overlay composes its own, the three
        // surfaces drift and the user gets three different answers to "what do I
        // do" — on the exact screen they look at when the bridge seems broken.
        String src = readSource("Tools.java");
        assertTrue("info 必须带 ui_why", src.contains("\"ui_why\""));
        assertTrue("info 必须带 ui_advice", src.contains("\"ui_advice\""));
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
