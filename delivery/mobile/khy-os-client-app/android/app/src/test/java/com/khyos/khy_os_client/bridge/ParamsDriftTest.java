package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.Test;

/**
 * Pins {@link KhyUi#PARAMS} to the two things it must agree with: what the code
 * actually reads, and what the description tells the model.
 *
 * WHY THIS TEST EXISTS. The parameter table was added on 2026-10-29, after
 * `dumpsys app_function` showed our 11 functions indexed with full descriptions
 * but ZERO parameters — the assistant could read what each tool does and still
 * have no idea ui_swipe wants x1/y1/x2/y2. First-party functions on the same
 * device all declare parameters; we declared none.
 *
 * A hand-maintained table beside the readers is a second source of truth, and
 * that is only acceptable if something compares them. These tests are that
 * something. The generator has the same checks, but a generator only runs when
 * someone runs it; this runs on every build.
 *
 * THE BUG THIS ALREADY CAUGHT. Tools.ROUTING described ui_swipe's optional
 * duration as {@code durationMs} while {@code swipe()} has always read
 * {@code ms}. Nothing compared them, so a model told to send durationMs would
 * send an argument the code never reads — and the tool would silently fall back
 * to its 300ms default, which for a fling is wrong in a way that looks like the
 * gesture failed. The same check also found ui_click and ui_type naming none of
 * their parameters in their descriptions at all.
 */
public class ParamsDriftTest {

    /**
     * Mirrors KhyAppFunctions.EXPOSED — the tools that reach the AppFunctions
     * metadata. Read from the source rather than referenced because the service
     * class needs API 36 and the unit-test classpath is API 34; the existing
     * generator already reads it the same way.
     */
    private static final String[] EXPOSED_TOOLS = {
        "ping", "info", "tools",
        "ui_dump", "ui_click", "ui_tap", "ui_swipe", "ui_type",
        "ui_back", "ui_home", "shot",
    };

    /** Every param name in the table for one tool, in declaration order. */
    private static List<String> namesOf(String tool) {
        List<String> out = new ArrayList<String>();
        for (String[] row : KhyUi.PARAMS) {
            if (row[0].equals(tool)) out.add(row[1]);
        }
        return out;
    }

    private static String routingOf(String tool) {
        for (String[] row : Tools.ROUTING) {
            if (row[0].equals(tool)) return row[1];
        }
        throw new AssertionError("ROUTING 里没有 " + tool);
    }

    @Test
    public void everyDeclaredParamIsNamedInThatToolsDescription() {
        // The description is the ONLY thing the model reads when deciding what to
        // send. A param that exists in the table but not in the prose is a param
        // the model will never fill — a failure that presents as "the tool is
        // broken" rather than "the metadata was incomplete".
        List<String> unnamed = new ArrayList<String>();
        for (String[] row : KhyUi.PARAMS) {
            String tool = row[0];
            String param = row[1];
            if (!routingOf(tool).contains(param)) {
                unnamed.add(tool + "." + param);
            }
        }
        assertTrue("这些参数在描述里没被提到，模型不会填: " + unnamed, unnamed.isEmpty());
    }

    @Test
    public void theTableMatchesWhatTheCodeActuallyReads() {
        // Derived from the readers, not listed. If a param is renamed in a private
        // method, this test is the thing that notices.
        assertEquals(java.util.Arrays.asList("x", "y"), namesOf("ui_tap"));
        assertEquals(java.util.Arrays.asList("x1", "y1", "x2", "y2", "ms"), namesOf("ui_swipe"));
        assertEquals(java.util.Arrays.asList("x", "y", "ms"), namesOf("ui_longpress"));
        assertEquals(java.util.Arrays.asList("text", "id"), namesOf("ui_click"));
        assertEquals(java.util.Arrays.asList("text"), namesOf("ui_type"));
    }

    @Test
    public void toolsThatTakeNothingDeclareNothing() {
        // Declaring params for a tool that ignores them is the mirror-image bug:
        // the model fills them in and the tool silently discards them, which reads
        // as "the tool ignored me".
        for (String t : new String[]{"ui_dump", "ui_back", "ui_home", "ui_recents",
                "shot", "shot_b64", "ping", "info", "tools"}) {
            assertTrue(t + " 不该声明参数", namesOf(t).isEmpty());
        }
    }

    @Test
    public void everyRowCarriesTheFiveColumns() {
        for (String[] row : KhyUi.PARAMS) {
            assertEquals("每条五段", 5, row.length);
            assertTrue("工具名不能空", !row[0].trim().isEmpty());
            assertTrue("参数名不能空", !row[1].trim().isEmpty());
            // Only "string" is emitted today; the column exists so adding a numeric
            // type is a visible decision. An unrecognised value must fail here
            // rather than silently fall back in the generator.
            assertTrue("未知类型: " + row[2], row[2].equals("string"));
            assertTrue("required 只能是 true/false: " + row[3],
                    row[3].equals("true") || row[3].equals("false"));
            assertTrue(row[0] + "." + row[1] + " 缺描述", row[4].trim().length() > 0);
        }
    }

    @Test
    public void noParamIsDeclaredTwice() {
        Set<String> seen = new LinkedHashSet<String>();
        List<String> dupes = new ArrayList<String>();
        for (String[] row : KhyUi.PARAMS) {
            String key = row[0] + "." + row[1];
            if (!seen.add(key)) dupes.add(key);
        }
        assertTrue("重复声明: " + dupes, dupes.isEmpty());
    }

    @Test
    public void theGeneratedXmlDeclaresExactlyTheseParams() throws Exception {
        // End-to-end: the table has to survive the trip into the file the platform
        // reads. Everything before this test only proves the table is sane.
        //
        // Scoped to EXPOSED on purpose: KhyUi.PARAMS also covers ui_longpress,
        // which is a real bridge tool but is deliberately NOT exposed as an
        // AppFunction (see KhyAppFunctions.EXPOSED), so the generator filters it
        // out. Asserting on it here would demand something the generator never
        // promises — and would break the moment someone adds a bridge-only tool.
        String xml = readAsset("app_functions_v2.xml");
        int expected = 0;
        for (String[] row : KhyUi.PARAMS) {
            if (!isExposed(row[0])) continue;
            expected++;
            String block = blockOf(xml, row[0]);
            assertTrue("app_functions_v2.xml 里 " + row[0] + " 没有声明参数 " + row[1]
                            + "——跑 scripts/generate-appfunctions-metadata.js",
                    block.contains("<name>" + row[1] + "</name>"));
        }
        // And the count must match, so a param that is emitted under the wrong
        // tool cannot hide behind the per-name check above.
        assertEquals("XML 里的 <parameters> 数量与 EXPOSED 工具的 KhyUi.PARAMS 不一致",
                expected, count(xml, "<parameters>"));
    }

    private static boolean isExposed(String tool) {
        for (String e : EXPOSED_TOOLS) {
            if (e.equals(tool)) return true;
        }
        return false;
    }

    @Test
    public void paramsOnlyAppearInV2NotInLegacy() throws Exception {
        // The legacy file carries function_id + enabled_by_default only — that is
        // the shape every first-party app on this device ships (verified against
        // com.stepos.appstore). Adding <parameters> there would be inventing a
        // format nothing has been shown to read.
        String legacy = readAsset("app_functions.xml");
        assertEquals("legacy XML 不该出现 <parameters>", 0, count(legacy, "<parameters>"));
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private static int count(String haystack, String needle) {
        int n = 0;
        int i = haystack.indexOf(needle);
        while (i >= 0) {
            n++;
            i = haystack.indexOf(needle, i + needle.length());
        }
        return n;
    }

    /** The <appfunction>…</appfunction> block for one tool. */
    private static String blockOf(String xml, String tool) {
        int start = xml.indexOf("KhyAppFunctions#" + tool + "<");
        if (start < 0) {
            // The id appears twice in v2 (<id> and <functionId>); take the first.
            start = xml.indexOf("KhyAppFunctions#" + tool);
        }
        assertTrue("XML 里找不到 " + tool, start >= 0);
        int end = xml.indexOf("</appfunction>", start);
        assertTrue("找不到 " + tool + " 的结束标签", end > start);
        return xml.substring(start, end);
    }

    private static String readAsset(String name) throws Exception {
        java.io.File dir = new java.io.File(System.getProperty("user.dir", ".")).getAbsoluteFile();
        for (int i = 0; i < 8 && dir != null; i++) {
            java.io.File candidate = new java.io.File(dir, "src/main/assets/" + name);
            if (candidate.isFile()) {
                return new String(Files.readAllBytes(candidate.toPath()), StandardCharsets.UTF_8);
            }
            dir = dir.getParentFile();
        }
        throw new AssertionError("找不到 src/main/assets/" + name
                + "（从 user.dir=" + System.getProperty("user.dir") + " 向上回溯）");
    }
}
