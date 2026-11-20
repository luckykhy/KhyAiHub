package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;

/**
 * The console's admission logic: whitelist, argument schema, and the three-way
 * failure classification.
 *
 * <p>These run on a plain JVM with no phone attached, which is the point: the
 * classification is what the user reads, and it has to be provable without
 * hardware. What it needs a phone for — actually running the tool — is not
 * tested here.
 */
public class KhyConsoleValidateTest {

    /**
     * Every test starts from a clean slate: empty shared history AND empty
     * shortcuts.
     *
     * Clearing only the history is not enough — the favourites file persists
     * across tests, so a shortcut saved by one test shows up in the next one's
     * count. That produced `removingAShortcutDropsOnlyThatOne` failing with
     * "expected 1 but was 3", which pointed at the product when the real cause
     * was leftover state.
     */
    @Before
    public void cleanSlateBeforeEach() {
        KhyConsole.clearHistory();
        File fav = new File(KhyConsole.baseDir(), KhyConsole.FAVORITES_FILE);
        if (fav.exists()) {
            assertTrue("测试 setup 清不掉常用指令文件", fav.delete());
        }
    }

    // ── the three failure classes ──────────────────────────────────────────

    @Test
    public void malformedJsonIsInvalidArgs() {
        JSONObject r = KhyConsole.validateOnly("{not json");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
        assertTrue(r.optString("error").contains("参数不合法"));
    }

    @Test
    public void missingToolIsInvalidArgs() {
        JSONObject r = KhyConsole.validateOnly("{\"args\":{}}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
        assertTrue(r.optString("error").contains("tool"));
    }

    @Test
    public void nonStringToolIsInvalidArgs() {
        JSONObject r = KhyConsole.validateOnly("{\"tool\":42}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
    }

    @Test
    public void argsMustBeAnObject() {
        JSONObject r = KhyConsole.validateOnly("{\"tool\":\"ls\",\"args\":\"oops\"}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
    }

    @Test
    public void unknownToolIsToolUnavailable() {
        JSONObject r = KhyConsole.validateOnly("{\"tool\":\"rm_minus_rf\",\"args\":{}}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_TOOL_UNAVAILABLE, r.optString("status"));
        assertTrue(r.optString("error").contains("未知工具"));
    }

    @Test
    public void missingRequiredArgumentIsInvalidArgs() {
        JSONObject r = KhyConsole.validateOnly("{\"tool\":\"read\",\"args\":{}}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
        assertTrue(r.optString("error").contains("path"));
    }

    @Test
    public void unknownArgumentIsInvalidArgs() {
        JSONObject r = KhyConsole.validateOnly(
                "{\"tool\":\"read\",\"args\":{\"path\":\"/a\",\"psth\":\"/b\"}}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
        assertTrue(r.optString("error").contains("psth"));
    }

    @Test
    public void wrongArgumentTypeIsInvalidArgs() {
        JSONObject r = KhyConsole.validateOnly("{\"tool\":\"exec\",\"args\":{\"cmd\":42}}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
        assertTrue(r.optString("error").contains("cmd"));
    }

    @Test
    public void uiToolWithoutAccessibilityIsToolUnavailableNotInvalidArgs() {
        // The distinction that matters to the user: the command is well formed,
        // it just cannot run here. Telling them "参数不合法" would send them
        // looking in the wrong place.
        JSONObject r = KhyConsole.validateOnly("{\"tool\":\"ui_tap\",\"args\":{\"x\":1,\"y\":2}}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_TOOL_UNAVAILABLE, r.optString("status"));
        assertEquals("accessibility", r.optString("needs_auth"));
    }

    // ── the happy path ─────────────────────────────────────────────────────

    @Test
    public void wellFormedCommandPasses() {
        JSONObject r = KhyConsole.validateOnly(
                "{\"tool\":\"ls\",\"args\":{\"path\":\"/sdcard\"}}");
        assertTrue(r.optString("error"), r.optBoolean("ok", false));
        assertEquals(KhyConsole.STATUS_OK, r.optString("status"));
        assertEquals("ls", r.optString("tool"));
    }

    @Test
    public void toolWithoutArgumentsPasses() {
        JSONObject r = KhyConsole.validateOnly("{\"tool\":\"ping\"}");
        assertTrue(r.optString("error"), r.optBoolean("ok", false));
    }

    @Test
    public void aliasesFoldOntoTheCanonicalName() {
        JSONObject r = KhyConsole.validateOnly(
                "{\"tool\":\"shell_exec\",\"args\":{\"cmd\":\"echo hi\"}}");
        assertTrue(r.optString("error"), r.optBoolean("ok", false));
        assertEquals("exec", r.optString("tool"));
    }

    @Test
    public void theVerifyKeyIsAcceptedAlongsideToolAndArgs() {
        // Amoo's payload carries a third key. Rejecting it would break the
        // interception loop for a reason that has nothing to do with validity.
        JSONObject r = KhyConsole.validateOnly(
                "{\"tool\":\"write\",\"args\":{\"path\":\"/a\",\"content\":\"x\"},"
                        + "\"verify\":{\"path\":\"/a\"}}");
        assertTrue(r.optString("error"), r.optBoolean("ok", false));
    }

    @Test
    public void clipboardSetWithoutTextIsInvalidArgs() {
        JSONObject r = KhyConsole.validateOnly("{\"tool\":\"clipboard\",\"args\":{\"op\":\"set\"}}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
    }

    @Test
    public void loopStartWithUnknownModeIsInvalidArgs() {
        JSONObject r = KhyConsole.validateOnly(
                "{\"tool\":\"loop_start\",\"args\":{\"mode\":\"whatever\"}}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
    }

    @Test
    public void adouSigninWithUnknownOpIsInvalidArgs() {
        JSONObject r = KhyConsole.validateOnly(
                "{\"tool\":\"adou_signin\",\"args\":{\"op\":\"explode\"}}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
    }

    @Test
    public void rmWithNonBooleanRecursiveIsInvalidArgs() {
        JSONObject r = KhyConsole.validateOnly(
                "{\"tool\":\"rm\",\"args\":{\"path\":\"/a\",\"recursive\":\"yes\"}}");
        assertFalse(r.optBoolean("ok", true));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS, r.optString("status"));
    }

    // ── argument types ─────────────────────────────────────────────────────

    @Test
    public void requiredArgumentTypesAreCheckedNotJustOptionalOnes() throws Exception {
        // A required argument with the wrong type used to pass the shape check
        // and only fail deep inside the tool as "empty cmd" — which reads as
        // 执行报错 when the real problem is a number where a string belongs.
        assertEquals("参数「cmd」应为 字符串，实际是 数字",
                ToolSchema.validate("exec", new JSONObject().put("cmd", 42)));
        assertEquals("参数「path」应为 字符串，实际是 数字",
                ToolSchema.validate("read", new JSONObject().put("path", 7)));
        assertEquals("参数「x」应为 数字，实际是 字符串",
                ToolSchema.validate("ui_tap",
                        new JSONObject().put("x", "1").put("y", 2)));
    }

    @Test
    public void wrongOptionalArgumentTypeIsInvalidArgs() throws Exception {
        assertEquals("参数「timeout」应为 数字，实际是 字符串",
                ToolSchema.validate("exec",
                        new JSONObject().put("cmd", "ls").put("timeout", "soon")));
    }

    @Test
    public void booleanArgumentGivenAsStringIsInvalidArgs() throws Exception {
        // "true" as a JSON string is not a boolean, and reading it as one would
        // silently pick a default instead of what the user wrote.
        assertEquals("参数「recursive」应为 布尔值，实际是 字符串",
                ToolSchema.validate("rm",
                        new JSONObject().put("path", "/a").put("recursive", "true")));
    }

    // ── the tools added since the console was first written ─────────────────

    @Test
    public void theNewToolsHaveContracts() throws Exception {
        // zip/unzip took path+out/dest; a missing dest used to write into the
        // process cwd, which is precisely the silent failure a schema prevents.
        assertTrue(ToolSchema.validate("zip",
                new JSONObject().put("path", "/a")).contains("out"));
        assertTrue(ToolSchema.validate("unzip",
                new JSONObject().put("path", "/a.zip")).contains("dest"));
        // Credential delivery needs the one-time code, so a bare write is
        // rejected before it reaches the vault.
        assertTrue(ToolSchema.validate("secret_put",
                new JSONObject().put("name", "k").put("value", "v")).contains("code"));
        assertTrue(ToolSchema.validate("secret_del",
                new JSONObject().put("name", "k")).contains("code"));
        // The catalogue tool takes nothing at all.
        assertEquals(null, ToolSchema.validate("tools", new JSONObject()));
    }

    // ── catalogue alignment ────────────────────────────────────────────────

    @Test
    public void everyBridgeToolHasASchema() {
        // A tool without a schema would reject every command aimed at it
        // ("未知参数") — worse than not having it at all.
        for (String name : Tools.NAMES) {
            assertNotNull("没有 schema 的工具：" + name, ToolSchema.get(name));
        }
        assertEquals(Tools.NAMES.length, ToolSchema.all().size());
    }

    @Test
    public void everySchemaToolIsOnTheBridge() {
        for (ToolSchema.Spec spec : ToolSchema.all()) {
            assertTrue("schema 里有桥没有的工具：" + spec.tool,
                    KhyConsole.whitelist().contains(spec.tool));
        }
    }

    /**
     * The console must not describe a tool differently from the bridge does.
     *
     * {@link ToolSchema} deliberately borrows its descriptions from
     * {@link Tools#CATALOG} instead of copying them, so this is the guard that
     * keeps it that way. If someone re-adds a hand-written description, the two
     * drift and the console starts lying about what a tool does.
     */
    @Test
    public void descriptionsComeFromTheBridgesOwnCatalogue() {
        for (String[] row : Tools.CATALOG) {
            if (row.length < 3) {
                continue;
            }
            ToolSchema.Spec spec = ToolSchema.get(row[1]);
            assertNotNull("CATALOG 里有 console 没有的工具：" + row[1], spec);
            assertEquals(row[1], row[2], spec.desc);
            assertEquals(row[1], row[0], spec.group);
        }
    }

    @Test
    public void onlyUiToolsNeedAccessibility() {
        for (String name : Tools.NAMES) {
            boolean expected = name.startsWith("ui_") || "shot".equals(name)
                    || "shot_b64".equals(name);
            assertEquals(name, expected, ToolSchema.needsAccessibility(name));
        }
    }

    @Test
    public void theCatalogueDescribesEveryTool() {
        JSONObject d = ToolSchema.describe();
        assertEquals(Tools.NAMES.length, d.optJSONArray("tools").length());
    }

    // ── manual and Amoo commands are the same thing ──────────────────────────

    /**
     * The requirement that the two entry points produce indistinguishable
     * records, apart from the origin stamp.
     *
     * This is the property that makes the interception loop and the console
     * comparable at all: if they recorded differently, "the same command looks
     * different depending on who sent it" would be a permanent source of
     * confusion, and the Amoo side's failures would stay invisible in the
     * console's history.
     */
    @Test
    public void manualAndAmooCommandsRecordTheSameWay() throws Exception {
        KhyConsole.clearHistory();
        File tmp = File.createTempFile("khy_console_eq", ".txt");
        tmp.delete();
        String cmd = "{\"tool\":\"read\",\"args\":{\"path\":\"" + tmp.getAbsolutePath()
                .replace('\\', '/') + "\",\"max\":64}}";

        JSONObject manual = KhyConsole.exec(KhyConsole.ORIGIN_MANUAL, cmd);
        JSONObject amoo = KhyConsole.exec(KhyConsole.ORIGIN_AMOO, cmd);

        // Both must reach the same conclusion about the command itself.
        assertEquals(manual.optString("status"), amoo.optString("status"));
        assertEquals(manual.optString("tool"), amoo.optString("tool"));
        assertEquals(manual.optString("error"), amoo.optString("error"));
        assertEquals(manual.optString("hint"), amoo.optString("hint"));
        assertEquals(manual.optString("needs_auth"), amoo.optString("needs_auth"));
        assertEquals(manual.optString("capability_note"), amoo.optString("capability_note"));
        assertEquals(manual.optString("raw"), amoo.optString("raw"));
        assertEquals(manual.opt("args").toString(), amoo.opt("args").toString());
        assertEquals(manual.opt("result").toString(), amoo.opt("result").toString());

        // ...and the only thing that differs is the origin stamp.
        assertEquals(KhyConsole.ORIGIN_MANUAL, manual.optString("origin"));
        assertEquals(KhyConsole.ORIGIN_AMOO, amoo.optString("origin"));

        // Two records in the shared file, in order.
        List<String> lines = readHistory();
        assertEquals(2, lines.size());
        assertEquals(KhyConsole.ORIGIN_MANUAL, new JSONObject(lines.get(0)).optString("origin"));
        assertEquals(KhyConsole.ORIGIN_AMOO, new JSONObject(lines.get(1)).optString("origin"));
        // Same command text in both, so either can be replayed verbatim.
        assertEquals(cmd, new JSONObject(lines.get(0)).optString("raw"));
        assertEquals(cmd, new JSONObject(lines.get(1)).optString("raw"));
    }

    /** A rejected command is recorded too — from either origin. */
    @Test
    public void rejectedCommandsAreRecordedFromBothOrigins() {
        KhyConsole.clearHistory();
        String bad = "{\"tool\":\"read\"}";
        assertEquals(KhyConsole.STATUS_INVALID_ARGS,
                KhyConsole.exec(KhyConsole.ORIGIN_MANUAL, bad).optString("status"));
        assertEquals(KhyConsole.STATUS_INVALID_ARGS,
                KhyConsole.exec(KhyConsole.ORIGIN_AMOO, bad).optString("status"));
        // A command that never ran is exactly what someone needs to find later.
        assertEquals(2, readHistory().size());
    }

    /** The shared file is one file, not one per origin. */
    @Test
    public void bothOriginsAppendToTheSameFile() {
        KhyConsole.clearHistory();
        KhyConsole.exec(KhyConsole.ORIGIN_MANUAL, "{\"tool\":\"ping\"}");
        KhyConsole.exec(KhyConsole.ORIGIN_AMOO, "{\"tool\":\"ping\"}");
        assertEquals(2, readHistory().size());
    }

    // ── the exact 20-command acceptance mix ─────────────────────────────────

    /**
     * Acceptance criterion 3, run on the JVM: the same 20 mixed commands the
     * on-device script fires, each with the status it must produce.
     *
     * <p>Why this is worth pinning even though the device run is still pending:
     * the classification is decided in pure logic, so it is provable here. The
     * device run then only has to prove that the UI renders these three
     * statuses differently — not that the decision itself is right. Splitting it
     * that way means a UI regression cannot be confused with a logic bug.
     *
     * <p>Commands 16-20 are deliberately well-formed: they pass validation and
     * fail at execution, which is exactly what makes them 执行报错 rather than
     * 参数不合法. A test that only exercised the easy cases would leave the
     * boundary between those two classes untested.
     *
     * <p>21 commands, not 20, and the split is deliberately uneven (5/6/5/5):
     * command 11 (loop_start with an unknown mode) is rejected at validation time,
     * so it belongs with the invalid-args group even though it looks like a
     * runtime failure. The on-device tally must match this split — see the note
     * inside the test.
     */
    @Test
    public void theAcceptanceCommandMixClassifiesCorrectly() {
        // 5 well formed
        expectOk("{\"tool\":\"ping\"}");
        expectOk("{\"tool\":\"info\"}");
        expectOk("{\"tool\":\"ls\",\"args\":{\"path\":\"/sdcard/Download\"}}");
        expectOk("{\"tool\":\"battery\"}");
        expectOk("{\"tool\":\"stat\",\"args\":{\"path\":\"/sdcard\"}}");

        // 6 malformed arguments. NOTE the last one (loop_start with an unknown
        // mode) is a deliberate trap, and it is NOT an exec failure:
        //
        //   it is rejected at VALIDATION time (conditionalProblem,
        //   ToolSchema:403-406), so it never runs and can never produce an exec
        //   error. It is classified invalid_args, which is the correct
        //   classification — but it means the on-device tally for the four groups
        //   is 5/6/5/5, not an even split.
        //
        // This matters because the acceptance run counts records per group. If the
        // script expects an even split and does not get one, the natural next move
        // is to go hunting for a rendering bug in the console — when the real cause
        // is the command list itself. An earlier version of this list had
        // loop_start in the exec-error group, where it could never have belonged.
        expectStatus("{\"tool\":\"read\"}", KhyConsole.STATUS_INVALID_ARGS);
        expectStatus("{\"tool\":\"read\",\"args\":{\"psth\":\"/a\"}}",
                KhyConsole.STATUS_INVALID_ARGS);
        expectStatus("{\"tool\":\"exec\",\"args\":{\"cmd\":42}}",
                KhyConsole.STATUS_INVALID_ARGS);
        expectStatus("{\"tool\":\"ls\",\"args\":{\"path\":123}}",
                KhyConsole.STATUS_INVALID_ARGS);
        expectStatus("{\"tool\":\"clipboard\",\"args\":{\"op\":\"set\"}}",
                KhyConsole.STATUS_INVALID_ARGS);
        // Classified invalid_args, NOT exec_error — see the note above.
        expectStatus("{\"tool\":\"loop_start\",\"args\":{\"mode\":\"nope\"}}",
                KhyConsole.STATUS_INVALID_ARGS);

        // 5 tools that cannot run without the accessibility service
        expectStatus("{\"tool\":\"ui_tap\",\"args\":{\"x\":1,\"y\":2}}",
                KhyConsole.STATUS_TOOL_UNAVAILABLE);
        expectStatus("{\"tool\":\"ui_dump\"}", KhyConsole.STATUS_TOOL_UNAVAILABLE);
        expectStatus("{\"tool\":\"shot\"}", KhyConsole.STATUS_TOOL_UNAVAILABLE);
        expectStatus("{\"tool\":\"ui_click\",\"args\":{\"text\":\"x\"}}",
                KhyConsole.STATUS_TOOL_UNAVAILABLE);
        expectStatus("{\"tool\":\"shot_b64\"}", KhyConsole.STATUS_TOOL_UNAVAILABLE);

        // 5 commands that pass validation and then fail when they run.
        expectStatus("{\"tool\":\"exec\",\"args\":{\"cmd\":\"zz_no_such_cmd_xyz\"}}",
                KhyConsole.STATUS_EXEC_ERROR);
        expectStatus("{\"tool\":\"ls\",\"args\":{\"path\":\"/no_such_dir_xyz\"}}",
                KhyConsole.STATUS_EXEC_ERROR);
        expectStatus("{\"tool\":\"read\",\"args\":{\"path\":\"/no_such_file_xyz\"}}",
                KhyConsole.STATUS_EXEC_ERROR);
        expectStatus("{\"tool\":\"stat\",\"args\":{\"path\":\"/no_such_file_xyz\"}}",
                KhyConsole.STATUS_EXEC_ERROR);
        // Replaces the old loop_start entry. unzip takes two required strings and
        // is strict, so a missing archive is an exec failure rather than a
        // validation one — which is the property this group is supposed to test.
        // loop_start with a bad mode moved up to the invalid_args group.
        expectStatus("{\"tool\":\"unzip\",\"args\":{\"path\":\"/no_such_file_xyz.zip\","
                + "\"dest\":\"/sdcard/Download\"}}",
                KhyConsole.STATUS_EXEC_ERROR);
    }

    /** Every UI tool that needs accessibility names the permission to grant. */
    @Test
    public void everyAccessibilityGatedToolSaysSo() {
        String[] uiCmds = {
                "{\"tool\":\"ui_tap\",\"args\":{\"x\":1,\"y\":2}}",
                "{\"tool\":\"ui_dump\"}",
                "{\"tool\":\"shot\"}",
                "{\"tool\":\"ui_click\",\"args\":{\"text\":\"x\"}}",
                "{\"tool\":\"shot_b64\"}",
        };
        for (String cmd : uiCmds) {
            JSONObject r = KhyConsole.validateOnly(cmd);
            assertEquals(cmd, KhyConsole.STATUS_TOOL_UNAVAILABLE, r.optString("status"));
            // Without this field the UI cannot offer a "go grant" button, and
            // the user is told "unavailable" with no way out.
            assertEquals(cmd, "accessibility", r.optString("needs_auth"));
            assertTrue(cmd, r.optString("error").length() > 0);
        }
    }

    /** The three classes are never reported with the same wording. */
    @Test
    public void theThreeFailureClassesUseDistinctWording() {
        String invalid = KhyConsole.validateOnly("{\"tool\":\"read\"}")
                .optString("error");
        String unavailable = KhyConsole.validateOnly("{\"tool\":\"ui_dump\"}")
                .optString("error");
        String execError = KhyConsole.exec(KhyConsole.ORIGIN_MANUAL,
                "{\"tool\":\"ls\",\"args\":{\"path\":\"/no_such_dir_xyz\"}}")
                .optString("error");
        assertTrue(invalid.startsWith("参数不合法"));
        assertTrue(unavailable.startsWith("工具不可用"));
        assertTrue(execError.startsWith("执行报错"));
        // Three different sentences, not one word relabelled.
        assertNotEquals(invalid, unavailable);
        assertNotEquals(invalid, execError);
        assertNotEquals(unavailable, execError);
    }

    /**
     * A failed exec must not be reported as "未知错误".
     *
     * exec returns ok:false carrying only exit and err, so the generic
     * fallback used to print "未知错误" over a reason that was sitting right
     * there in stderr. Measured on the device: exit 127 plus
     * "zz_no_such_cmd_xyz: inaccessible or not found" — and the user was told
     * nothing was known.
     *
     * <p>What counts as "a reason" differs by platform, and that is not a bug:
     * on the device /system/bin/sh exists and the command fails with exit 127
     * plus stderr; on this Windows JVM the shell itself is missing, so the
     * reason is the IOException naming it. Both are reasons. What must never
     * happen is the message claiming nothing is known.
     */
    @Test
    public void aFailedExecSaysWhyNotUnknownError() {
        String err = KhyConsole.exec(KhyConsole.ORIGIN_MANUAL,
                "{\"tool\":\"exec\",\"args\":{\"cmd\":\"zz_no_such_cmd_xyz\"}}")
                .optString("error");
        assertTrue("exec 失败必须带上原因，收到：" + err,
                err.contains("zz_no_such_cmd_xyz") || err.contains("退出码")
                        || err.contains("IOException") || err.contains("/system/bin/sh"));
        assertFalse("不许退成未知错误：" + err, err.contains("未知错误"));
    }

    // ── shortcuts, export, retention ────────────────────────────────────────

    /**
     * Saving a shortcut must NOT run the command.
     *
     * This is the property that makes the feature safe to use at all. The
     * original implementation validated by executing, so saving
     * {@code {"tool":"rm","args":{"path":"/sdcard/DCIM"}}} deleted the camera
     * roll — the user asked to remember a command, not to run it. A shortcut is
     * a bookmark; bookmarks do not have side effects.
     */
    @Test
    public void savingAShortcutNeverExecutesTheCommand() throws Exception {
        KhyConsole.clearHistory();
        File victim = File.createTempFile("khy_console_victim", ".txt");
        assertTrue(victim.exists());
        String cmd = "{\"tool\":\"rm\",\"args\":{\"path\":\""
                + victim.getAbsolutePath().replace('\\', '/') + "\"}}";

        JSONObject saved = KhyConsole.addFavorite("删东西", cmd);

        assertTrue("可用的命令应该存得进去：" + saved.optString("error"),
                saved.optBoolean("ok", false));
        // The whole point: the file the command names is still there.
        assertTrue("存常用指令绝不执行命令——目标文件被删了", victim.exists());
        // ...and nothing was recorded either, because nothing ran.
        assertTrue("保存动作不该产生执行记录", readHistory().isEmpty());
    }

    /** A command that cannot run is not a useful shortcut. */
    @Test
    public void savingAnUnrunnableShortcutIsRefused() {
        KhyConsole.clearHistory();
        // Missing required argument: it would fail the moment it was used.
        JSONObject r = KhyConsole.addFavorite("坏的", "{\"tool\":\"read\"}");
        assertFalse(r.optBoolean("ok", true));
        assertTrue(r.optString("error").contains("path"));
    }

    /** Shortcuts round-trip: what was saved comes back from the list. */
    @Test
    public void shortcutsRoundTrip() {
        KhyConsole.clearHistory();
        KhyConsole.addFavorite("看电量", "{\"tool\":\"battery\"}");
        KhyConsole.addFavorite("看目录", "{\"tool\":\"ls\",\"args\":{\"path\":\"/sdcard\"}}");

        JSONArray items = KhyConsole.favorites().optJSONArray("items");
        assertNotNull(items);
        assertEquals(2, items.length());
        assertEquals("battery", items.optJSONObject(0).optString("tool"));
        assertEquals("看电量", items.optJSONObject(0).optString("label"));
    }

    /** Removing by id drops exactly that one. */
    @Test
    public void removingAShortcutDropsOnlyThatOne() {
        KhyConsole.clearHistory();
        KhyConsole.addFavorite("甲", "{\"tool\":\"battery\"}");
        KhyConsole.addFavorite("乙", "{\"tool\":\"info\"}");
        JSONArray items = KhyConsole.favorites().optJSONArray("items");
        String dropId = items.optJSONObject(0).optString("id");
        String keepId = items.optJSONObject(1).optString("id");

        KhyConsole.removeFavorite(dropId);

        JSONArray after = KhyConsole.favorites().optJSONArray("items");
        assertEquals(1, after.length());
        assertEquals(keepId, after.optJSONObject(0).optString("id"));
    }

    /**
     * Clearing the history empties the history, keeps the shortcuts, and leaves
     * the channel usable afterwards.
     *
     * WHY THIS TEST EXISTS. `clearHistory` was only ever called from this suite's
     * own setup — as a broom, never as a subject. Nothing asserted what it does.
     * The setup's own comment records the invariant it leans on ("clearing only
     * the history is not enough — the favourites file persists"), i.e. that
     * clearHistory must NOT touch favourites, and that reliance was never
     * verified. A regression there would silently wipe the user's shortcuts the
     * first time they cleared history, and this suite would then start failing
     * in a way that looks like leftover state all over again.
     *
     * The third assertion is the one that matters most in the field: if clearing
     * left the history file unwritable, every later command would fail and the
     * console would look dead after one button press.
     */
    @Test
    public void clearingHistoryLeavesShortcutsAloneAndKeepsTheChannelUsable() {
        KhyConsole.clearHistory();
        KhyConsole.addFavorite("看电量", "{\"tool\":\"battery\"}");
        KhyConsole.exec(KhyConsole.ORIGIN_MANUAL, "{\"tool\":\"ping\"}");
        KhyConsole.exec(KhyConsole.ORIGIN_MANUAL, "{\"tool\":\"ping\"}");
        assertEquals(2, readHistory().size());

        JSONObject r = KhyConsole.clearHistory();

        assertTrue("clearHistory 必须报 ok", r.optBoolean("ok", false));
        assertNotNull("clearHistory 必须回报路径", r.optString("path"));
        assertEquals(0, readHistory().size());
        JSONArray items = KhyConsole.favorites().optJSONArray("items");
        assertNotNull(items);
        assertEquals("清历史不该动常用指令", 1, items.length());
        assertEquals("battery", items.optJSONObject(0).optString("tool"));

        // 清完之后通道仍可用：再来一条命令必须正常落账。
        KhyConsole.exec(KhyConsole.ORIGIN_MANUAL, "{\"tool\":\"ping\"}");
        List<String> after = readHistory();
        assertEquals(1, after.size());
        assertTrue(after.get(0).contains("\"tool\":\"ping\""));
    }

    /**
     * Export writes exactly what the history holds.
     *
     * "可导出" is only useful if the export is faithful — a truncated or
     * reformatted export cannot be replayed, and the record's whole value is
     * that the exact command that produced a result is still readable.
     */
    @Test
    public void exportWritesEveryRecordedLine() throws Exception {
        KhyConsole.clearHistory();
        KhyConsole.exec(KhyConsole.ORIGIN_MANUAL, "{\"tool\":\"ping\"}");
        KhyConsole.exec(KhyConsole.ORIGIN_AMOO, "{\"tool\":\"info\"}");
        int before = readHistory().size();

        File out = File.createTempFile("khy_console_export", ".jsonl");
        JSONObject r = KhyConsole.export(out.getAbsolutePath());

        assertTrue(r.optString("error"), r.optBoolean("ok", false));
        assertEquals(before, r.optInt("lines"));
        assertEquals(before, readLines(out).size());
        // Line-for-line identical, so the export replays exactly.
        assertEquals(readHistory(), readLines(out));
    }

    /**
     * The history keeps its newest MAX_HISTORY lines.
     *
     * Without the trim the file grows without bound and every read pays for it.
     * The trim must drop from the FRONT — losing the newest record is losing the
     * one the user is most likely to want back.
     */
    @Test
    public void historyKeepsOnlyTheNewestRecords() throws Exception {
        KhyConsole.clearHistory();
        // Seed the file directly: appending MAX_HISTORY+ records one at a time
        // through exec() would trim as it goes and never reach the boundary.
        File f = KhyConsole.historyFile();
        int extra = KhyConsole.MAX_HISTORY + 5;
        java.io.Writer w = new java.io.OutputStreamWriter(
                new java.io.FileOutputStream(f, false), "UTF-8");
        try {
            for (int i = 0; i < extra; i++) {
                w.write("{\"n\":" + i + "}\n");
            }
            w.flush();
        } finally {
            w.close();
        }

        KhyConsole.exec(KhyConsole.ORIGIN_MANUAL, "{\"tool\":\"ping\"}");

        List<String> after = readHistory();
        assertEquals(KhyConsole.MAX_HISTORY, after.size());
        // The newest record is the one that just ran, and it is still there.
        assertTrue(after.get(after.size() - 1).contains("\"tool\":\"ping\""));
        // The oldest five are gone, not the newest.
        assertFalse(after.get(0).contains("\"n\":0"));
    }

    /**
     * The banner and the gate must read the SAME boolean.
     *
     * <p>Acceptance criterion 5 says a missing accessibility service may grey out
     * {@code ui_*} / {@code shot} but must not block anything else. The Dart side
     * draws its orange banner from {@code _tools.any((t) => t.needsA11y && !t.available)},
     * and {@code available} is computed natively in
     * {@link KhyConsole#describeTools()} as {@code !needs || a11y} — one boolean,
     * {@link #accessibilityReady()}, for the whole catalogue.
     *
     * <p>Why pin the wiring rather than the behaviour: on a plain JVM the service is
     * always off, so a behavioural test here can only ever see one branch. What can
     * go wrong is the wiring — the gate moving to the channel entry (blocking
     * everything), or {@code available} being computed from a different source than
     * the banner reads, which yields the contradiction "banner says not authorized,
     * panel shows the tool as usable". That contradiction is nearly impossible to
     * diagnose on a device, so it is pinned here by source text.
     */
    @Test
    public void theBannerAndTheGateReadTheSameBoolean() throws Exception {
        String src = readSource("KhyConsole.java");
        // The gate is per tool, not at the channel entrance: a missing service must
        // not take the console down with it.
        assertTrue("门必须挂在单个工具上（needsAccessibility(canonical)），不能挂在通道入口",
                src.contains("ToolSchema.needsAccessibility(canonical)"));
        assertTrue("门的判据必须复用 accessibilityReady()，不许自己再问一次系统",
                src.contains("!accessibilityReady()"));
        // The panel's per-tool availability must come from that same boolean.
        assertTrue("describeTools 必须为每个工具算 available",
                src.contains("o.put(\"available\", !needs || a11y)"));
        assertTrue("available 与门必须同源于一个 a11y 变量",
                src.contains("boolean a11y = accessibilityReady()"));
        // And the catalogue must publish the flag so the Dart side can tell the
        // user why, instead of showing a greyed-out row with no explanation.
        assertTrue("describeTools 必须把 a11y_ready 送回 Dart，否则界面只能看到灰掉的工具",
                src.contains("d.put(\"a11y_ready\", a11y)"));
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private void expectOk(String cmd) {
        JSONObject r = KhyConsole.validateOnly(cmd);
        assertTrue(cmd + " -> " + r.optString("error"), r.optBoolean("ok", false));
    }

    private void expectStatus(String cmd, String status) {
        JSONObject r = KhyConsole.validateOnly(cmd);
        if (KhyConsole.STATUS_EXEC_ERROR.equals(status)) {
            // Not a validation outcome: run it to see it fail.
            r = KhyConsole.exec(KhyConsole.ORIGIN_MANUAL, cmd);
        }
        assertEquals(cmd, status, r.optString("status"));
    }

    /**
     * Read a bridge source file as text.
     *
     * <p>For invariants that are about the wiring, not the behaviour: on a plain
     * JVM the accessibility service is always off, so a behavioural test can only
     * ever exercise one branch. Same helper, and same reason, as
     * {@code UiAdviceTest#readSource}.
     */
    private static String readSource(String name) throws Exception {
        List<String> tried = new ArrayList<String>();
        for (String base : new String[] {
                System.getProperty("user.dir", "."),
                Tools.class.getProtectionDomain().getCodeSource().getLocation().getPath(),
        }) {
            File cur = new File(base);
            for (int up = 0; up < 6 && cur != null;
                    up++, cur = cur.getParentFile()) {
                File c = new File(cur,
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

    private static List<String> readHistory() {
        return readLines(KhyConsole.historyFile());
    }

    /** Any file's non-blank lines, UTF-8. */
    private static List<String> readLines(File f) {
        List<String> out = new ArrayList<String>();
        if (f == null || !f.exists()) {
            return out;
        }
        BufferedReader r = null;
        try {
            r = new BufferedReader(new InputStreamReader(new FileInputStream(f), "UTF-8"));
            String line;
            while ((line = r.readLine()) != null) {
                if (line.trim().length() > 0) {
                    out.add(line);
                }
            }
        } catch (Throwable ignored) {
        } finally {
            try {
                if (r != null) {
                    r.close();
                }
            } catch (Throwable ignored) {
            }
        }
        return out;
    }
}
