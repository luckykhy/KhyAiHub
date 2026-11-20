// khy-canary: Khy-20261101-035-KKN3RJEG
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * Tests for the two decisions that closed holes the refutation round found.
 *
 * Both are cases where the code was correct about what it did and silent — or
 * wrong — about what it did not do:
 *
 *   1. {@code ui_type} was a SECOND channel into Amoo's composer that bypassed
 *      {@link AmooSafe} entirely. AmooSafe's own javadoc claimed "a ninth call
 *      site inherits the transform for free", which is true of a ninth
 *      writeBack and false of a second dispatch.
 *   2. A safety-floor refusal was reported to the human as 「人工中止」 — telling
 *      them they had done something they had not, on the exact path whose whole
 *      purpose is to make the refusal legible.
 */
public class AmooLoopChannelTest {

    private static LoopModes.Decision decide(String tool, JSONObject args)
            throws org.json.JSONException {
        return LoopModes.decide(LoopModes.Mode.BYPASS, tool, args);
    }

    // ---------- ui_type is refused on the loop path, in every mode ----------

    @Test
    public void uiTypeIsRefusedInEveryModeIncludingBypass()
            throws org.json.JSONException {
        // The floor is mode-independent by design: BYPASS does not switch it off.
        JSONObject args = new JSONObject().put("text", "/sdcard/DCIM/IMG_0001.jpg 装一下");
        for (LoopModes.Mode m : LoopModes.Mode.values()) {
            LoopModes.Decision d = LoopModes.decide(m, "ui_type", args);
            assertTrue("模式 " + m + " 下 ui_type 必须被拦", d.floorTripped);
            assertTrue("模式 " + m + " 下不得放行",
                    d.action != LoopModes.Action.EXECUTE);
        }
    }

    @Test
    public void theReasonNamesWhatToDoInstead() throws org.json.JSONException {
        // A refusal that only says "no" leaves the model retrying the same
        // command. The reason has to name the working alternatives.
        JSONObject args = new JSONObject().put("text", "abc");
        String why = decide("ui_type", args).reason;
        assertTrue(why.contains("ui_type"));
        assertTrue("必须说清为什么", why.contains("不过净化"));
        assertTrue("必须给出替代动作", why.contains("ui_tap"));
        assertTrue("必须说明结果该怎么说", why.contains("直接说"));
    }

    @Test
    public void anEmptyTypeIsNotARefusal() throws org.json.JSONException {
        // The tool already rejects an empty text with its own message. A floor
        // message about sanitisation would be answering a question nobody asked.
        assertEquals(LoopModes.Action.EXECUTE,
                decide("ui_type", new JSONObject().put("text", "")).action);
        assertEquals(LoopModes.Action.EXECUTE,
                decide("ui_type", new JSONObject().put("text", "   ")).action);
    }

    @Test
    public void otherUiToolsAreUnaffected() throws org.json.JSONException {
        // The refusal is scoped to the ONE tool that types into Amoo's box.
        // ui_tap / ui_swipe / ui_dump do not carry identifiers and must keep
        // working — an over-broad floor would make the loop useless.
        for (String t : new String[] {"ui_tap", "ui_swipe", "ui_dump",
                "ui_click", "ui_longpress", "ui_back", "ui_home"}) {
            assertEquals("工具 " + t + " 不该被这条规则波及",
                    LoopModes.Action.EXECUTE, decide(t, new JSONObject()).action);
        }
    }

    @Test
    public void theWriteBackPathIsNotWhatGotRefused() {
        // THE property that makes the whole fix safe. AmooLoop.writeBack calls
        // KhyUi.dispatch("ui_type", …) DIRECTLY — it never goes through
        // Tools.dispatch, and LoopModes.decide has exactly one production
        // caller (AmooLoop.executeOne). So refusing the TOOL cannot break the
        // write-back. Asserted from the source, because it is a structural
        // invariant and a comment is not a check.
        //
        // If this ever goes red, the refusal has started blocking the loop's own
        // output and must be moved.
        String src = readAmooLoop();
        int directDispatch = countOf(src, "KhyUi.dispatch(\"ui_type\"");
        int viaTools = countOf(src, "Tools.dispatch(\"ui_type\"");
        assertEquals("writeBack 必须仍走 KhyUi.dispatch 直连", 1, directDispatch);
        assertEquals("循环内不该出现经 Tools.dispatch 的 ui_type", 0, viaTools);
    }

    // ---------- a floor refusal is not a human abort ----------

    @Test
    public void floorRefusedIsItsOwnStopReason() {
        LoopState.State s = new LoopState.State();
        s.floorRefused = true;
        s.aborted = false;
        LoopState.Verdict v = LoopState.shouldStop(s);
        assertTrue(v.stop);
        assertEquals(LoopState.FLOOR_REFUSED, v.reason);
    }

    @Test
    public void aHumanAbortStillOutranksAFloorRefusal() {
        // If a human stops the loop AND the floor refused something, the human's
        // action is the more useful thing to report — they can act on it, whereas
        // the refusal is already in the pending file.
        LoopState.State s = new LoopState.State();
        s.floorRefused = true;
        s.aborted = true;
        assertEquals(LoopState.ABORTED, LoopState.shouldStop(s).reason);
    }

    @Test
    public void neitherFlagMeansKeepGoing() {
        LoopState.State s = new LoopState.State();
        s.maxRounds = 10;
        s.deadlineMs = 600000L;
        assertFalse(LoopState.shouldStop(s).stop);
    }

    @Test
    public void describeStopSaysTheMachineRefusedItNotTheHuman() {
        // The actual defect: 「人工中止」 told the human they had stopped
        // something they had not. Every floor trip used to land there, including
        // the false positives — so the mislabel sat on the exact path whose risk
        // section depends on the human understanding what happened.
        String text = AmooLoop.describeStop(LoopState.FLOOR_REFUSED);
        assertNotNull(text);
        assertTrue("必须说明是安全底拒的", text.contains("安全底"));
        assertTrue("必须明确说不是人工中止", text.contains("不是人工中止"));
        assertTrue("必须告诉人去哪里看原因", text.contains("待确认清单"));
        // And the plain human-abort wording must not have been reused.
        assertFalse(text.equals("人工中止"));
    }

    @Test
    public void aHumanAbortStillSaysSo() {
        assertEquals("人工中止",
                AmooLoop.describeStop(LoopState.ABORTED));
    }

    // ---------- source helpers ----------

    private static String readAmooLoop() {
        try {
            java.util.List<String> tried = new java.util.ArrayList<String>();
            for (String base : new String[] {
                System.getProperty("user.dir", "."),
                AmooLoop.class.getProtectionDomain().getCodeSource().getLocation()
                        .getPath(),
            }) {
                java.io.File cur = new java.io.File(base);
                for (int up = 0; up < 6 && cur != null;
                        up++, cur = cur.getParentFile()) {
                    java.io.File c = new java.io.File(cur,
                            "app/src/main/java/com/khyos/khy_os_client/bridge/AmooLoop.java");
                    tried.add(c.getAbsolutePath());
                    if (c.isFile()) {
                        return new String(java.nio.file.Files.readAllBytes(c.toPath()),
                                java.nio.charset.StandardCharsets.UTF_8);
                    }
                }
            }
            throw new IllegalStateException("找不到 AmooLoop.java，已试：" + tried);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static int countOf(String hay, String needle) {
        int n = 0;
        for (int at = hay.indexOf(needle); at >= 0;
                at = hay.indexOf(needle, at + needle.length())) {
            n++;
        }
        return n;
    }
}
