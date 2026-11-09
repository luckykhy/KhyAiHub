// khy-canary: Khy-20261101-051-G7J8Y3XT
package com.khyos.khy_os_client.bridge;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link LoopVerify}.
 *
 * NOTE on the classpath: these tests build real {@link JSONObject} instances.
 * The mockable android.jar that the Android Gradle plugin puts on the unit-test
 * classpath stubs out {@code org.json} (its methods throw "not mocked"), so a
 * real org.json implementation has to be on the unit-test classpath as well.
 */
public class LoopVerifyTest {

    // --- write -> READ_EQUALS -------------------------------------------------

    /** Spec: write without a verify field still yields READ_EQUALS (args.path, expectBytes=-1). */
    @Test
    public void writeWithoutVerify_stillYieldsReadEquals() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/main.py").put("content", "print(1)");

        LoopVerify.Plan p = LoopVerify.plan("write", args, null);

        assertEquals(LoopVerify.Kind.READ_EQUALS, p.kind);
        assertEquals("/sdcard/g/main.py", p.path);
        assertEquals(-1L, p.expectBytes);
        assertNull(p.expectInStdout);
        assertNull(p.expectText);
    }

    /** Spec rule: path comes from verify.path, falling back to args.path. */
    @Test
    public void writeWithVerifyPath_prefersVerifyPathOverArgsPath() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/stale.py");
        JSONObject verify = new JSONObject().put("path", "/sdcard/g/main.py");

        LoopVerify.Plan p = LoopVerify.plan("write", args, verify);

        assertEquals("/sdcard/g/main.py", p.path);
    }

    /** Spec rule: expectBytes comes from verify.expect_bytes (default -1). */
    @Test
    public void writeWithExpectBytes_carriesByteCount() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/main.py");
        JSONObject verify = new JSONObject().put("path", "/sdcard/g/main.py").put("expect_bytes", 1234);

        LoopVerify.Plan p = LoopVerify.plan("write", args, verify);

        assertEquals(LoopVerify.Kind.READ_EQUALS, p.kind);
        assertEquals(1234L, p.expectBytes);
    }

    /** Boundary: 0 is a real expectation, not a missing field. */
    @Test
    public void writeWithExpectBytesZero_keepsZero() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/empty.py");
        JSONObject verify = new JSONObject().put("expect_bytes", 0);

        LoopVerify.Plan p = LoopVerify.plan("write", args, verify);

        assertEquals(0L, p.expectBytes);
    }

    /** Boundary: a verify block without expect_bytes must not disable the byte check. */
    @Test
    public void writeWithVerifyButNoExpectBytes_defaultsToMinusOne() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/main.py");
        JSONObject verify = new JSONObject().put("kind", "read_equals");

        LoopVerify.Plan p = LoopVerify.plan("write", args, verify);

        assertEquals(LoopVerify.Kind.READ_EQUALS, p.kind);
        assertEquals(-1L, p.expectBytes);
    }

    /** Boundary: an unusable verify.path (empty string) must not win over a usable args.path. */
    @Test
    public void writeWithEmptyVerifyPath_fallsBackToArgsPath() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/main.py");
        JSONObject verify = new JSONObject().put("path", "");

        LoopVerify.Plan p = LoopVerify.plan("write", args, verify);

        assertEquals("/sdcard/g/main.py", p.path);
    }

    /**
     * Boundary: neither side supplies a path -> NONE, not READ_EQUALS with a
     * null target.
     *
     * Amoo sending {"tool":"write","args":{"content":"x"}} without a path used to
     * yield kind=READ_EQUALS with path=null — a verification method with nowhere
     * to look. The caller then had to special-case a null path to avoid lying
     * about success. Returning NONE makes "no proof available" the answer, which
     * is what the spec's general rule asks for.
     */
    @Test
    public void writeWithoutAnyPath_yieldsNoneNotReadEqualsWithNullTarget() throws Exception {
        LoopVerify.Plan p = LoopVerify.plan("write", new JSONObject(), null);

        assertEquals(LoopVerify.Kind.NONE, p.kind);
        assertNull(p.path);
        assertEquals(-1L, p.expectBytes);
    }

    /** Aliases Tools.dispatch folds must be verified the same way they execute. */
    @Test
    public void toolAliasesAreFoldedBeforePlanning() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/main.py").put("content", "x");
        // Tools turns file_write into write and really does write the file; the
        // verification plan has to agree, or a written file goes unverified.
        LoopVerify.Plan p = LoopVerify.plan("file_write", args, null);
        assertEquals(LoopVerify.Kind.READ_EQUALS, p.kind);
        assertEquals("/sdcard/g/main.py", p.path);
        // shell_exec folds to exec.
        assertEquals(LoopVerify.Kind.EXIT_ZERO,
                LoopVerify.plan("shell_exec", new JSONObject().put("cmd", "id"), null).kind);
    }

    /**
     * A negative expect_bytes must not disable the byte check.
     *
     * The caller's guard is `expectBytes >= 0 && actual != expectBytes`, so any
     * negative value other than -1 sails straight past it and the whole byte
     * comparison silently disappears — a truncated write would then be reported
     * as verified.
     */
    @Test
    public void negativeExpectBytesFallsBackToMinusOne() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/main.py");
        for (long bad : new long[] {-2L, -5L, -999L, Long.MIN_VALUE}) {
            JSONObject verify = new JSONObject().put("expect_bytes", bad);
            assertEquals("expect_bytes=" + bad, -1L, LoopVerify.plan("write", args, verify).expectBytes);
        }
        // A non-number is equally unusable and must not be coerced into one.
        JSONObject boolVerify = new JSONObject().put("expect_bytes", Boolean.TRUE);
        assertEquals(-1L, LoopVerify.plan("write", args, boolVerify).expectBytes);
        // 0 is a real, usable expectation (an empty file) and must survive.
        JSONObject zero = new JSONObject().put("expect_bytes", 0);
        assertEquals(0L, LoopVerify.plan("write", args, zero).expectBytes);
    }

    /** A numeric path is not a path: it must not be coerced into a target. */
    @Test
    public void numericPathIsNotCoercedIntoATarget() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/main.py");
        JSONObject verify = new JSONObject().put("path", 1234);
        LoopVerify.Plan p = LoopVerify.plan("write", args, verify);
        // verify.path is unusable, so the usable args.path wins.
        assertEquals("/sdcard/g/main.py", p.path);
        // With no usable path anywhere there is no target at all.
        assertEquals(LoopVerify.Kind.NONE, LoopVerify.plan("write", new JSONObject(), verify).kind);
    }

    /** Boundary: verify alone supplies the path even when args is null. */
    @Test
    public void writeWithNullArgs_usesVerifyPath() throws Exception {
        JSONObject verify = new JSONObject().put("path", "/sdcard/g/main.py").put("expect_bytes", 7);

        LoopVerify.Plan p = LoopVerify.plan("write", null, verify);

        assertEquals(LoopVerify.Kind.READ_EQUALS, p.kind);
        assertEquals("/sdcard/g/main.py", p.path);
        assertEquals(7L, p.expectBytes);
    }

    // --- exec -> EXIT_ZERO ----------------------------------------------------

    /** Spec: exec carrying expect_in_stdout must carry the expectation out. */
    @Test
    public void execWithExpectInStdout_carriesExpectation() throws Exception {
        JSONObject args = new JSONObject().put("cmd", "echo hello");
        JSONObject verify = new JSONObject().put("expect_in_stdout", "hello");

        LoopVerify.Plan p = LoopVerify.plan("exec", args, verify);

        assertEquals(LoopVerify.Kind.EXIT_ZERO, p.kind);
        assertEquals("hello", p.expectInStdout);
        assertNull(p.path);
        assertEquals(-1L, p.expectBytes);
        assertNull(p.expectText);
    }

    /** Spec rule: exec without a verify block -> EXIT_ZERO with a null stdout expectation. */
    @Test
    public void execWithoutVerify_exitZeroWithNullExpectation() throws Exception {
        JSONObject args = new JSONObject().put("cmd", "ls /sdcard");

        LoopVerify.Plan p = LoopVerify.plan("exec", args, null);

        assertEquals(LoopVerify.Kind.EXIT_ZERO, p.kind);
        assertNull(p.expectInStdout);
    }

    // --- ui_type -> UI_TEXT_EQUALS -------------------------------------------

    /** Spec: ui_type -> expectText equals args.text. */
    @Test
    public void uiType_carriesTextFromArgs() throws Exception {
        JSONObject args = new JSONObject().put("text", "贪吃蛇").put("target", "input");

        LoopVerify.Plan p = LoopVerify.plan("ui_type", args, null);

        assertEquals(LoopVerify.Kind.UI_TEXT_EQUALS, p.kind);
        assertEquals("贪吃蛇", p.expectText);
        assertNull(p.path);
        assertEquals(-1L, p.expectBytes);
        assertNull(p.expectInStdout);
    }

    /** Boundary: ui_type without a text field -> null expectation, still UI_TEXT_EQUALS. */
    @Test
    public void uiTypeWithoutText_expectTextIsNull() throws Exception {
        LoopVerify.Plan p = LoopVerify.plan("ui_type", new JSONObject(), null);

        assertEquals(LoopVerify.Kind.UI_TEXT_EQUALS, p.kind);
        assertNull(p.expectText);
    }

    /** Boundary: ui_type with null args -> null expectation, never throws. */
    @Test
    public void uiTypeWithNullArgs_expectTextIsNull() {
        LoopVerify.Plan p = LoopVerify.plan("ui_type", null, null);

        assertEquals(LoopVerify.Kind.UI_TEXT_EQUALS, p.kind);
        assertNull(p.expectText);
    }

    // --- everything else -> NONE ---------------------------------------------

    /**
     * Spec: read / ls / toast -> NONE.
     *
     * The alias spellings (shell_exec / file_write) are deliberately NOT in this
     * list: Tools.dispatch folds them onto exec / write and really does execute
     * them, so LoopVerify must fold them too — see toolAliasesAreFoldedBeforePlanning.
     */
    @Test
    public void readLsToast_yieldNone() throws Exception {
        String[] tools = {"read", "ls", "toast", "stat", "mv", "rm", "mkdir", "shot", "ui_dump", "ui_tap",
                "ping", "info", "unknown_tool", ""};
        for (String tool : tools) {
            LoopVerify.Plan p = LoopVerify.plan(tool, new JSONObject().put("path", "/sdcard/x"), null);
            assertEquals("tool=" + tool, LoopVerify.Kind.NONE, p.kind);
            assertNull("tool=" + tool, p.path);
            assertEquals("tool=" + tool, -1L, p.expectBytes);
            assertNull("tool=" + tool, p.expectInStdout);
            assertNull("tool=" + tool, p.expectText);
        }
    }

    // --- verify.kind must never override the tool ----------------------------

    /** Spec: a verify kind that contradicts the tool (write carrying kind "exit_zero") -> tool wins. */
    @Test
    public void verifyKindContradictingTool_toolWins() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/main.py").put("text", "hi");

        LoopVerify.Plan write = LoopVerify.plan("write", args,
                new JSONObject().put("kind", "exit_zero").put("expect_in_stdout", "nope"));
        assertEquals(LoopVerify.Kind.READ_EQUALS, write.kind);
        assertNull(write.expectInStdout);

        LoopVerify.Plan exec = LoopVerify.plan("exec", args,
                new JSONObject().put("kind", "read_equals").put("path", "/sdcard/g/main.py"));
        assertEquals(LoopVerify.Kind.EXIT_ZERO, exec.kind);
        assertNull(exec.path);

        LoopVerify.Plan ui = LoopVerify.plan("ui_type", args,
                new JSONObject().put("kind", "none").put("expect_bytes", 99));
        assertEquals(LoopVerify.Kind.UI_TEXT_EQUALS, ui.kind);
        assertEquals("hi", ui.expectText);
        assertEquals(-1L, ui.expectBytes);
    }

    // --- contract: never throws ----------------------------------------------

    /** Contract: null tool / null args / null verify must not throw. */
    @Test
    public void nullInputs_doNotThrow() {
        LoopVerify.Plan p = LoopVerify.plan(null, null, null);

        assertNotNull(p);
        assertEquals(LoopVerify.Kind.NONE, p.kind);
        assertNull(p.path);
        assertEquals(-1L, p.expectBytes);
        assertNull(p.expectInStdout);
        assertNull(p.expectText);
    }

    /** Contract: wrong-typed fields must degrade to defaults instead of throwing. */
    @Test
    public void wrongTypedFields_doNotThrow() throws Exception {
        JSONObject args = new JSONObject()
                .put("path", new JSONObject().put("nested", true))
                .put("text", new JSONArray().put(1).put(2))
                .put("cmd", new JSONObject());
        JSONObject verify = new JSONObject()
                .put("path", new JSONArray())
                .put("expect_bytes", Boolean.TRUE)
                .put("expect_in_stdout", new JSONObject().put("x", 1));

        LoopVerify.Plan write = LoopVerify.plan("write", args, verify);
        // Neither side supplies a usable path (verify.path is a JSONArray, args
        // has no path at all), so there is no target to read back: NONE, not
        // READ_EQUALS pointing at null.
        assertEquals(LoopVerify.Kind.NONE, write.kind);
        assertNull(write.path);
        assertEquals(-1L, write.expectBytes);

        LoopVerify.Plan exec = LoopVerify.plan("exec", args, verify);
        assertEquals(LoopVerify.Kind.EXIT_ZERO, exec.kind);
        assertNull(exec.expectInStdout);

        LoopVerify.Plan ui = LoopVerify.plan("ui_type", args, verify);
        assertEquals(LoopVerify.Kind.UI_TEXT_EQUALS, ui.kind);
        assertNull(ui.expectText);
    }

    /**
     * Contract: only a real JSON number is a usable byte count.
     *
     * A numeric STRING used to be parsed ("42" -> 42). It no longer is, and that
     * is deliberate: the caller's guard is `expectBytes >= 0 && actual != expectBytes`,
     * so any value that slips past parsing into something unexpected silently
     * switches the byte check off. Refusing to guess turns a silent no-op into
     * "no byte check", which the caller then reports honestly.
     */
    @Test
    public void onlyRealNumbersAreUsableByteCounts() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/main.py");

        assertEquals(-1L, LoopVerify.plan("write", args,
                new JSONObject().put("expect_bytes", "42")).expectBytes);
        assertEquals(-1L, LoopVerify.plan("write", args,
                new JSONObject().put("expect_bytes", "not-a-number")).expectBytes);
        // A JSON number still works, including a double that is a whole number.
        assertEquals(12L, LoopVerify.plan("write", args,
                new JSONObject().put("expect_bytes", 12.0)).expectBytes);
        assertEquals(1234L, LoopVerify.plan("write", args,
                new JSONObject().put("expect_bytes", 1234)).expectBytes);
    }

    /** Contract: the same inputs always produce the same plan (pure, deterministic). */
    @Test
    public void planIsDeterministic() throws Exception {
        JSONObject args = new JSONObject().put("path", "/sdcard/g/main.py").put("text", "hi");
        JSONObject verify = new JSONObject().put("expect_bytes", 1234).put("expect_in_stdout", "ok");

        for (int i = 0; i < 3; i++) {
            LoopVerify.Plan write = LoopVerify.plan("write", args, verify);
            assertEquals(LoopVerify.Kind.READ_EQUALS, write.kind);
            assertEquals("/sdcard/g/main.py", write.path);
            assertEquals(1234L, write.expectBytes);

            LoopVerify.Plan exec = LoopVerify.plan("exec", args, verify);
            assertEquals(LoopVerify.Kind.EXIT_ZERO, exec.kind);
            assertEquals("ok", exec.expectInStdout);

            LoopVerify.Plan ui = LoopVerify.plan("ui_type", args, verify);
            assertEquals("hi", ui.expectText);
            assertSame(LoopVerify.Kind.UI_TEXT_EQUALS, ui.kind);
        }
        assertTrue(LoopVerify.Kind.values().length == 4);
        assertFalse(LoopVerify.Kind.NONE == LoopVerify.Kind.READ_EQUALS);
    }
}
