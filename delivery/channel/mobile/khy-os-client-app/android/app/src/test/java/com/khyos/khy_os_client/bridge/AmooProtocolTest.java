// khy-canary: Khy-20261101-040-1NF2HAE9
package com.khyos.khy_os_client.bridge;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link AmooProtocol}.
 *
 * <p>Each test names the spec edge it covers. The class is pure logic, so these run on the
 * JVM with no device attached.
 */
public class AmooProtocolTest {

    // ---- edge: an unclosed fence is not returned, but is reported as open -----------

    @Test
    public void unclosedFenceIsNotReturnedButFlaggedAsOpen() {
        String chat = "好的，我先写文件。\n```khy-exec\n{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/g/main.py\"}}";
        assertTrue(AmooProtocol.extractFences(chat).isEmpty());
        assertTrue(AmooProtocol.hasOpenFence(chat));
    }

    @Test
    public void closedFenceBeforeAnUnclosedOneIsStillReturned() {
        String chat = "```khy-plan\n{\"goal\":\"贪吃蛇\"}\n```\n继续：\n```khy-exec\n{\"tool\":\"write\"";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(chat);
        assertEquals(1, fences.size());
        assertEquals(AmooProtocol.FenceKind.PLAN, fences.get(0).kind);
        assertTrue(AmooProtocol.hasOpenFence(chat));
    }

    // ---- edge: several fences in one message are all returned, in order -------------

    @Test
    public void multipleFencesAreReturnedInOrder() {
        String chat = "先说明计划：\n"
                + "```khy-plan\n{\"goal\":\"写一个贪吃蛇\"}\n```\n"
                + "然后执行：\n"
                + "```khy-exec\n{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/g/main.py\"}}\n```\n"
                + "最后汇报：\n"
                + "```khy-done\n{\"summary\":\"已完成\"}\n```\n";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(chat);
        assertEquals(3, fences.size());
        assertEquals(AmooProtocol.FenceKind.PLAN, fences.get(0).kind);
        assertEquals(AmooProtocol.FenceKind.EXEC, fences.get(1).kind);
        assertEquals(AmooProtocol.FenceKind.DONE, fences.get(2).kind);
        assertEquals("{\"goal\":\"写一个贪吃蛇\"}", fences.get(0).payload);
        assertEquals("{\"summary\":\"已完成\"}", fences.get(2).payload);
        assertFalse(AmooProtocol.hasOpenFence(chat));
    }

    // ---- edge: broken JSON inside a fence ------------------------------------------

    @Test
    public void fenceWithBrokenJsonIsFlaggedInvalid() {
        String chat = "```khy-exec\n{\"tool\":\"write\", oops\n```";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(chat);
        assertEquals(1, fences.size());
        assertFalse(fences.get(0).jsonValid);
        AmooProtocol.ParseResult r = AmooProtocol.parseExec(fences.get(0).payload);
        assertFalse(r.ok);
        assertEquals("payload_not_json", r.reason);
    }

    @Test
    public void fenceWithValidJsonIsFlaggedValid() {
        String chat = "```khy-exec\n{\"tool\":\"write\"}\n```";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(chat);
        assertEquals(1, fences.size());
        assertTrue(fences.get(0).jsonValid);
    }

    // ---- edge: marker case and surrounding whitespace ------------------------------

    @Test
    public void fenceMarkerToleratesCaseAndSurroundingWhitespace() {
        String chat = "   ```KHY-EXEC   \n{\"tool\":\"write\"}\n   ```   \n";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(chat);
        assertEquals(1, fences.size());
        assertEquals(AmooProtocol.FenceKind.EXEC, fences.get(0).kind);
        assertEquals("{\"tool\":\"write\"}", fences.get(0).payload);
    }

    @Test
    public void fenceMarkerToleratesTabsAndMixedCaseForEveryKind() {
        String chat = "\t```Khy-Plan\n{}\n```\n\t```khy-DONE\n{}\n```";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(chat);
        assertEquals(2, fences.size());
        assertEquals(AmooProtocol.FenceKind.PLAN, fences.get(0).kind);
        assertEquals(AmooProtocol.FenceKind.DONE, fences.get(1).kind);
    }

    // ---- edge: backticks inside the payload ----------------------------------------

    @Test
    public void inlineBackticksInPayloadDoNotCloseTheFence() {
        // The payload carries a markdown snippet whose backticks sit inline inside a JSON
        // string, so they must not be mistaken for the closing marker.
        String payload = "{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/g/main.py\","
                + "\"content\":\"```python\\nprint(1)\\n```\"}}";
        String chat = "```khy-exec\n" + payload + "\n```";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(chat);
        assertEquals(1, fences.size());
        assertEquals(payload, fences.get(0).payload);
        assertTrue(fences.get(0).jsonValid);
        assertFalse(AmooProtocol.hasOpenFence(chat));
    }

    @Test
    public void firstStandaloneBacktickLineClosesTheFence() {
        // Spec's counting rule: a line holding nothing but three backticks closes the
        // fence, even when the author meant it as payload content.
        String chat = "```khy-exec\n{\"content\":\"a\n```\nb\"}\n```";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(chat);
        assertEquals(1, fences.size());
        assertEquals("{\"content\":\"a", fences.get(0).payload);
        assertFalse(AmooProtocol.hasOpenFence(chat));
    }

    // ---- edge: prose that merely mentions the marker -------------------------------

    @Test
    public void proseMentioningTheMarkerIsNotAFence() {
        String chat = "我不会使用 ```khy-exec 这种格式，直接告诉你：把贪吃蛇写到 /sdcard/g/main.py。";
        assertTrue(AmooProtocol.extractFences(chat).isEmpty());
        assertFalse(AmooProtocol.hasOpenFence(chat));
    }

    @Test
    public void proseWithLoneBackticksIsNotAFence() {
        String chat = "代码大概长这样：\n```\nprint(1)\n```\n就这样。";
        assertTrue(AmooProtocol.extractFences(chat).isEmpty());
        assertFalse(AmooProtocol.hasOpenFence(chat));
    }

    // ---- edge: unknown fence kinds are not fences ----------------------------------

    @Test
    public void unknownFenceKindIsIgnored() {
        String chat = "```json\n{\"tool\":\"write\"}\n```";
        assertTrue(AmooProtocol.extractFences(chat).isEmpty());
        assertFalse(AmooProtocol.hasOpenFence(chat));
    }

    @Test
    public void unknownFenceKindPrefixIsIgnored() {
        String chat = "```khy-execute\n{\"tool\":\"write\"}\n```";
        assertTrue(AmooProtocol.extractFences(chat).isEmpty());
        assertFalse(AmooProtocol.hasOpenFence(chat));
    }

    // ---- edge: null / empty / pure prose -------------------------------------------

    @Test
    public void nullAndEmptyInputsYieldNothing() {
        assertTrue(AmooProtocol.extractFences(null).isEmpty());
        assertFalse(AmooProtocol.hasOpenFence(null));
        assertTrue(AmooProtocol.extractFences("").isEmpty());
        assertFalse(AmooProtocol.hasOpenFence(""));
        assertTrue(AmooProtocol.extractFences("\n\n").isEmpty());
        assertFalse(AmooProtocol.hasOpenFence("\n\n"));
    }

    @Test
    public void pureProseYieldsNothing() {
        String chat = "我来帮你写一个贪吃蛇。\n第一步先建文件，第二步写主循环，第三步加碰撞检测。";
        assertTrue(AmooProtocol.extractFences(chat).isEmpty());
        assertFalse(AmooProtocol.hasOpenFence(chat));
    }

    // ---- parseExec -----------------------------------------------------------------

    @Test
    public void parseExecExtractsToolArgsAndVerify() {
        String payload = "{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/g/main.py\",\"content\":\"x\"},"
                + "\"verify\":{\"kind\":\"read_equals\",\"path\":\"/sdcard/g/main.py\",\"expect_bytes\":1234}}";
        AmooProtocol.ParseResult r = AmooProtocol.parseExec(payload);
        assertTrue(r.ok);
        assertNull(r.reason);
        assertEquals("write", r.tool);
        assertNotNull(r.args);
        assertEquals("/sdcard/g/main.py", r.args.optString("path"));
        assertNotNull(r.verify);
        assertEquals(1234, r.verify.optInt("expect_bytes"));
    }

    @Test
    public void parseExecAcceptsPayloadWithoutArgsOrVerify() {
        AmooProtocol.ParseResult r = AmooProtocol.parseExec("{\"tool\":\"exec\"}");
        assertTrue(r.ok);
        assertEquals("exec", r.tool);
        assertNull(r.args);
        assertNull(r.verify);
    }

    @Test
    public void parseExecReportsMissingTool() {
        AmooProtocol.ParseResult empty = AmooProtocol.parseExec("{}");
        assertFalse(empty.ok);
        assertEquals("missing_tool", empty.reason);
        assertNull(empty.tool);

        AmooProtocol.ParseResult noTool = AmooProtocol.parseExec("{\"args\":{\"path\":\"/a\"}}");
        assertFalse(noTool.ok);
        assertEquals("missing_tool", noTool.reason);
    }

    @Test
    public void parseExecReportsToolNotString() {
        AmooProtocol.ParseResult num = AmooProtocol.parseExec("{\"tool\":123}");
        assertFalse(num.ok);
        assertEquals("tool_not_string", num.reason);

        AmooProtocol.ParseResult obj = AmooProtocol.parseExec("{\"tool\":{\"name\":\"write\"}}");
        assertFalse(obj.ok);
        assertEquals("tool_not_string", obj.reason);

        AmooProtocol.ParseResult arr = AmooProtocol.parseExec("{\"tool\":[\"write\"]}");
        assertFalse(arr.ok);
        assertEquals("tool_not_string", arr.reason);
    }

    @Test
    public void parseExecTreatsBlankToolAsMissing() {
        AmooProtocol.ParseResult r = AmooProtocol.parseExec("{\"tool\":\"   \"}");
        assertFalse(r.ok);
        assertEquals("missing_tool", r.reason);
    }

    @Test
    public void parseExecRejectsNonJsonPayloads() {
        String[] bad = new String[]{
                null,
                "",
                "   ",
                "not json at all",
                "[1,2,3]",
                "\"write\"",
                "{\"tool\":\"write\"",
                // Missing comma between members. Deliberately NOT a trailing comma
                // ({"tool":"write",}): JSONObject implementations disagree on
                // trailing commas, so asserting on one would test the parser
                // version rather than AmooProtocol.
                "{\"tool\":\"write\" \"args\":{}}",
                // A NUL plus a non-BMP character: a surrogate pair must not be
                // mistaken for the start of a JSON object.
                "invalid\0🚀",
                "🚀"
        };
        for (int i = 0; i < bad.length; i++) {
            AmooProtocol.ParseResult r = AmooProtocol.parseExec(bad[i]);
            assertFalse("expected failure for: " + bad[i], r.ok);
            assertEquals("payload_not_json", r.reason);
            assertNull(r.tool);
            assertNull(r.args);
            assertNull(r.verify);
        }
    }

    // ---- misc robustness -----------------------------------------------------------

    @Test
    public void crlfTranscriptIsHandled() {
        String chat = "计划：\r\n```khy-exec\r\n{\"tool\":\"write\"}\r\n```\r\n完成。\r\n";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(chat);
        assertEquals(1, fences.size());
        assertEquals(AmooProtocol.FenceKind.EXEC, fences.get(0).kind);
        assertEquals("{\"tool\":\"write\"}", fences.get(0).payload);
        assertTrue(fences.get(0).jsonValid);
        assertFalse(AmooProtocol.hasOpenFence(chat));
    }

    @Test
    public void payloadIsReturnedVerbatimWithoutMarkerLines() {
        String chat = "```khy-exec\nline one\n\nline three\n```";
        List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(chat);
        assertEquals(1, fences.size());
        assertEquals("line one\n\nline three", fences.get(0).payload);
        assertFalse(fences.get(0).jsonValid);
    }

    @Test
    public void extractionIsDeterministic() {
        String chat = "```khy-exec\n{\"tool\":\"write\"}\n```\n```khy-plan\n{\"goal\":\"x\"}\n```";
        List<AmooProtocol.Fence> first = AmooProtocol.extractFences(chat);
        List<AmooProtocol.Fence> second = AmooProtocol.extractFences(chat);
        assertEquals(first.size(), second.size());
        for (int i = 0; i < first.size(); i++) {
            assertSame(first.get(i).kind, second.get(i).kind);
            assertEquals(first.get(i).payload, second.get(i).payload);
            assertEquals(first.get(i).jsonValid, second.get(i).jsonValid);
        }
    }

    // ---- edge: garbage input never throws ------------------------------------------

    @Test
    public void garbageInputNeverThrows() {
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < 20000; i++) big.append("```khy-exec\n{").append(i).append("}\n```\n");
        String[] inputs = new String[]{
                null,
                "",
                " ",
                "\n",
                "\r",
                "\r\n",
                "```",
                "``",
                "````",
                "```khy",
                "```khy-exec",
                "```khy-exec\n",
                "```khy-exec\n```",
                "```khy-exec\n\n```",
                "```khy-exec\n{",
                "invalid\0🚀",
                "🚀",
                "{\"tool\":null}",
                big.toString(),
                "```khy-exec\n" + big.toString() + "🚀"
        };
        for (int i = 0; i < inputs.length; i++) {
            String in = inputs[i];
            try {
                List<AmooProtocol.Fence> fences = AmooProtocol.extractFences(in);
                if (fences != null) {
                    for (int j = 0; j < fences.size(); j++) {
                        AmooProtocol.Fence f = fences.get(j);
                        assertNotNull(f.kind);
                        assertNotNull(f.payload);
                    }
                }
                AmooProtocol.hasOpenFence(in);
                AmooProtocol.ParseResult r = AmooProtocol.parseExec(in);
                if (r != null && !r.ok) assertNotNull(r.reason);
            } catch (Throwable t) {
                throw new AssertionError("must never throw for input of length "
                        + (in == null ? -1 : in.length()) + ": " + t);
            }
        }
        // Whole-API smoke pass: null in, values out.
        assertFalse(AmooProtocol.parseExec(null).ok);
        assertTrue(AmooProtocol.extractFences(null).isEmpty());
        assertFalse(AmooProtocol.hasOpenFence(null));
    }

    // ── regressions found by adversarial review ─────────────────────────────

    /**
     * Full-width space (U+3000) must not break fence recognition.
     *
     * String.trim() only strips code points <= U+0020, so a marker line padded
     * with U+3000 or U+00A0 — both routine in Chinese model output and in
     * accessibility node text — was invisible. A missed opener silently dropped
     * the command; a missed closer made hasOpenFence true forever and spun the
     * loop to its deadline.
     */
    @Test
    public void fullWidthSpaceAroundMarkersIsTolerated() {
        String ideographic = "　```khy-exec\n{\"tool\":\"write\"}\n　```";
        List<AmooProtocol.Fence> f = AmooProtocol.extractFences(ideographic);
        assertEquals(1, f.size());
        assertEquals(AmooProtocol.FenceKind.EXEC, f.get(0).kind);
        assertTrue(f.get(0).jsonValid);
        assertFalse(AmooProtocol.hasOpenFence(ideographic));

        String nbsp = " ```khy-exec\n{\"tool\":\"write\"}\n ```";
        assertEquals(1, AmooProtocol.extractFences(nbsp).size());
        assertFalse(AmooProtocol.hasOpenFence(nbsp));
    }

    /**
     * A line that merely MENTIONS the marker is not an opener.
     *
     * Taking the first whitespace-delimited token as the tag made
     * "```khy-exec 只是提到这个词" an opener, so hasOpenFence stayed true forever
     * and the loop stalled to its deadline without ever running a command.
     */
    @Test
    public void proseMentioningTheMarkerOnTheSameLineIsNotAnOpener() {
        String prose = "```khy-exec 只是提到这个词，我不会用";
        assertTrue(AmooProtocol.extractFences(prose).isEmpty());
        assertFalse(AmooProtocol.hasOpenFence(prose));
        // A real fence after the prose line is still found.
        String mixed = prose + "\n```khy-exec\n{\"tool\":\"write\"}\n```";
        assertEquals(1, AmooProtocol.extractFences(mixed).size());
    }

    /**
     * A fence of unknown kind swallows its whole body.
     *
     * Otherwise a code sample that merely SHOWS the protocol — a ```json block
     * containing a ```khy-exec fence — had its inner fence lifted out and
     * executed as a real command.
     */
    @Test
    public void unknownKindFenceHidesAnyKnownFenceInsideIt() {
        String sample = "```json\n```khy-exec\n{\"tool\":\"write\"}\n```\n```";
        assertTrue(AmooProtocol.extractFences(sample).isEmpty());
        // ...and the unknown fence itself must not be reported as open.
        assertFalse(AmooProtocol.hasOpenFence(sample));
    }

    /** A closing fence may be longer than the opening one (CommonMark rule). */
    @Test
    public void longerClosingFenceIsAccepted() {
        String four = "```khy-exec\n{\"tool\":\"write\"}\n````";
        List<AmooProtocol.Fence> f = AmooProtocol.extractFences(four);
        assertEquals(1, f.size());
        assertTrue(f.get(0).jsonValid);
        assertFalse(AmooProtocol.hasOpenFence(four));
    }

    /** Blank lines inside the payload belong to the payload. */
    @Test
    public void leadingBlankLinesInsidePayloadArePreserved() {
        String f = "```khy-exec\n\n{\"tool\":\"write\"}\n```";
        List<AmooProtocol.Fence> got = AmooProtocol.extractFences(f);
        assertEquals(1, got.size());
        assertEquals("\n{\"tool\":\"write\"}", got.get(0).payload);
        // parseExec still tolerates the padding.
        assertTrue(AmooProtocol.parseExec(got.get(0).payload).ok);
    }

    // ── extractCommands: the shape-based path the device actually needs ──────
    //
    // Contract, as measured on the device: the fences never reach the
    // accessibility tree, so a command is recognised by its SHAPE — one line that
    // is exactly one JSON object naming a known tool. Inline examples share their
    // prose's node and therefore never start a line with '{'; a standalone
    // example is the one residual hole, pinned by a dedicated test below.

    /**
     * The reply Amoo REALLY sends, verbatim from the target device.
     *
     * The markdown renderer turned each ```khy-exec block into a header row
     * ("khy-exec" + "复制代码") plus a content node, and swallowed the backtick
     * lines entirely — so extractFences finds nothing here while the JSON
     * payloads survive intact. This is the case that made the shape-based path
     * necessary rather than optional.
     */
    @Test
    public void findsCommandsInARenderedReplyWhoseFencesAreGone() {
        String rendered = "按协议发给你，三条按顺序执行；第二条的 verify 不过就先别跑第三条。\n"
                + "{\"tool\":\"mkdir\",\"args\":{\"path\":\"/sdcard/amoo_test\",\"parents\":true}}\n"
                + "说明：建目录，parents:true 保证父级不存在也能建。\n"
                + "khy-exec\n"
                + "复制代码\n"
                + "{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/amoo_test/hello.py\","
                + "\"content\":\"print('hi')\"},\"verify\":{\"kind\":\"read_equals\","
                + "\"path\":\"/sdcard/amoo_test/hello.py\"}}\n"
                + "说明：内容 11 字节，不带结尾换行。\n"
                + "khy-exec\n"
                + "复制代码\n"
                + "{\"tool\":\"toast\",\"args\":{\"text\":\"已写好\"}}\n"
                + "说明：前一条验证通过后再执行。";

        // The fence path is blind to this shape — that is the point.
        assertTrue(AmooProtocol.extractFences(rendered).isEmpty());

        List<AmooProtocol.Fence> cmds = AmooProtocol.extractCommands(rendered);
        assertEquals(3, cmds.size());
        assertEquals("mkdir", AmooProtocol.parseExec(cmds.get(0).payload).tool);
        assertEquals("write", AmooProtocol.parseExec(cmds.get(1).payload).tool);
        assertEquals("toast", AmooProtocol.parseExec(cmds.get(2).payload).tool);
        // The write command keeps its verify block through the shape path.
        AmooProtocol.ParseResult w = AmooProtocol.parseExec(cmds.get(1).payload);
        assertNotNull(w.verify);
        assertEquals("read_equals", w.verify.optString("kind"));
    }

    /**
     * Prose braces, unknown tools and non-string tools are not commands.
     *
     * The first case is the inline-example shape: the '{' sits mid-line, so the
     * line test rejects it before parseExec ever runs.
     */
    @Test
    public void proseAndUnknownToolsAreNotCommands() {
        assertEquals(0, AmooProtocol.extractCommands("这个配置长得像 {\"a\":1} 这样").size());
        assertEquals(0, AmooProtocol.extractCommands("{\"tool\":\"not_a_real_tool\",\"args\":{}}").size());
        assertEquals(0, AmooProtocol.extractCommands("{\"args\":{\"path\":\"/sdcard/x\"}}").size());
        assertEquals(0, AmooProtocol.extractCommands("{\"tool\":123}").size());
        assertEquals(0, AmooProtocol.extractCommands("").size());
        assertEquals(0, AmooProtocol.extractCommands(null).size());
    }

    /**
     * Pretty-printed JSON spanning many lines is NOT recognised.
     *
     * The shape test requires one line to be exactly one JSON object, and no
     * single line of a pretty-printed object both starts with '{' and ends with
     * '}'. This is a deliberate false NEGATIVE: a missed command surfaces as an
     * idle turn and the loop keeps polling, whereas an invented command runs
     * something nobody asked for. Missing is the cheaper direction.
     */
    @Test
    public void prettyPrintedJsonIsNotRecognised() {
        String text = "{\n  \"tool\": \"write\",\n  \"args\": {\n    \"path\": \"/sdcard/a.py\",\n"
                + "    \"content\": \"x\"\n  }\n}";
        assertEquals(0, AmooProtocol.extractCommands(text).size());
    }

    /**
     * Several commands on ONE line are not commands.
     *
     * Rejected by isSingleJsonObject, NOT by the first/last-character check: the
     * line does start with '{' and end with '}', so those both pass. What stops it
     * is the brace depth returning to zero before the last character, which means
     * there is more than one object on the line.
     *
     * That distinction is load-bearing. org.json parses the first value and
     * silently ignores the rest, so without isSingleJsonObject this input would
     * execute the first command and drop the second — the exact truncation
     * failure the fence protocol exists to prevent.
     */
    @Test
    public void severalObjectsOnOneLineAreNotCommands() {
        String text = "{\"tool\":\"write\",\"args\":{\"path\":\"/a\",\"meta\":{\"k\":{\"deep\":1}}}}"
                + " 然后 "
                + "{\"tool\":\"toast\",\"args\":{\"text\":\"hi\"}}";
        assertEquals(0, AmooProtocol.extractCommands(text).size());
    }

    /**
     * Commands are returned in order of appearance, one per line.
     *
     * Order is load-bearing: AmooLoop executes this bubble's commands
     * sequentially and the third one is gated on the second one's verify.
     */
    @Test
    public void commandsAreReturnedInOrderOfAppearance() {
        String chat = "按协议发给你，三条按顺序执行。\n"
                + "{\"tool\":\"mkdir\",\"args\":{\"path\":\"/sdcard/amoo_test\",\"parents\":true}}\n"
                + "说明：先建目录。\n"
                + "{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/amoo_test/hello.py\"}}\n"
                + "{\"tool\":\"toast\",\"args\":{\"text\":\"已写好\"}}\n"
                + "说明：最后弹提示。";
        List<AmooProtocol.Fence> cmds = AmooProtocol.extractCommands(chat);
        assertEquals(3, cmds.size());
        assertEquals("mkdir", AmooProtocol.parseExec(cmds.get(0).payload).tool);
        assertEquals("write", AmooProtocol.parseExec(cmds.get(1).payload).tool);
        assertEquals("toast", AmooProtocol.parseExec(cmds.get(2).payload).tool);
    }

    /**
     * An EXAMPLE command inline in prose is not a command.
     *
     * This is the false positive the fix exists for. Amoo explains the protocol
     * with "for example {...} like this"; the example shares its prose's
     * accessibility node, so that line does not start with '{'. The old
     * brace-pairing scanner executed it.
     */
    @Test
    public void inlineExampleCommandIsNotRecognised() {
        assertEquals(0, AmooProtocol.extractCommands(
                "例如 {\"tool\":\"write\",\"args\":{\"path\":\"/x\"}} 这样").size());
        assertEquals(0, AmooProtocol.extractCommands(
                "命令长这样 {\"tool\":\"rm\",\"args\":{\"path\":\"/sdcard/x\"}}，看懂了吗？").size());
        assertEquals(0, AmooProtocol.extractCommands(
                "像这样：{\"tool\":\"toast\",\"args\":{\"text\":\"hi\"}}").size());
    }

    /**
     * A line carrying a trailing comment is not a clean command line.
     *
     * The rendered device transcript sometimes appends "// note" to a payload
     * line. Such a line ends with the comment's last character, not '}', so the
     * shape test rejects it rather than executing a payload the model annotated.
     */
    @Test
    public void commandLineWithTrailingCommentIsNotRecognised() {
        assertEquals(0, AmooProtocol.extractCommands(
                "{\"tool\":\"toast\",\"args\":{\"text\":\"hi\"}} // 说明").size());
        assertEquals(0, AmooProtocol.extractCommands(
                "{\"tool\":\"write\"}  // 这条先别跑").size());
    }

    /**
     * KNOWN COMPROMISE, pinned on purpose.
     *
     * An example command written on a line of its own IS picked up: nothing in
     * the text distinguishes it from a real command, because the fences never
     * reach the accessibility tree on this device. The safety floor still
     * applies to whatever is picked up and every execution is reported back, so
     * the hole is narrowed rather than closed. This test documents the boundary
     * so that a future change cannot silently widen it.
     */
    @Test
    public void standaloneExampleCommandIsStillRecognisedKnownCompromise() {
        String chat = "举例来说，命令格式是这样的：\n"
                + "{\"tool\":\"write\",\"args\":{\"path\":\"/x\"}}\n"
                + "上面那条只是个示例。";
        List<AmooProtocol.Fence> cmds = AmooProtocol.extractCommands(chat);
        assertEquals(1, cmds.size());
        assertEquals("write", AmooProtocol.parseExec(cmds.get(0).payload).tool);
    }

    /** Degenerate inputs yield nothing and never throw. */
    @Test
    public void degenerateInputsYieldNothingAndNeverThrow() {
        String[] bad = new String[]{
                null,
                "",
                " ",
                "\n",
                "\r\n",
                "{",
                "{}",
                "}",
                "好的，我先写文件。",
                "我不会使用 ```khy-exec 这种格式。",
                "这个配置长得像 {\"a\":1} 这样",
                "{\"tool\":\"not_a_real_tool\",\"args\":{}}",
                "{\"args\":{\"path\":\"/sdcard/x\"}}",
                "{\"tool\":123}",
                "{\"tool\":null}",
                "{\"tool\":\"   \"}",
                "{\"tool\":\"write\" \"args\":{}}",
                "invalid\0🚀",
                "🚀"
        };
        for (int i = 0; i < bad.length; i++) {
            String in = bad[i];
            try {
                assertTrue("expected no command for: " + in,
                        AmooProtocol.extractCommands(in).isEmpty());
            } catch (Throwable t) {
                throw new AssertionError("must never throw for input of length "
                        + (in == null ? -1 : in.length()) + ": " + t);
            }
        }
    }

    /**
     * CRLF transcripts are handled.
     *
     * {@code String#trim()} strips the trailing "\r", so a CRLF transcript is
     * recognised exactly like an LF one.
     */
    @Test
    public void crlfChatTextIsHandled() {
        String chat = "计划：\r\n{\"tool\":\"write\"}\r\n{\"tool\":\"toast\"}\r\n";
        List<AmooProtocol.Fence> cmds = AmooProtocol.extractCommands(chat);
        assertEquals(2, cmds.size());
        assertEquals("write", AmooProtocol.parseExec(cmds.get(0).payload).tool);
        assertEquals("toast", AmooProtocol.parseExec(cmds.get(1).payload).tool);
    }

    /**
     * Malformed command lines yield nothing and do not hang.
     *
     * The line test rejects them up front (they do not end with '}'), and
     * parseExec is the second line of defence for anything that slips through.
     */
    @Test
    public void malformedCommandLinesYieldNothing() {
        assertEquals(0, AmooProtocol.extractCommands("{\"tool\":\"write\",\"args\":{").size());
        assertEquals(0, AmooProtocol.extractCommands("{").size());
        assertEquals(0, AmooProtocol.extractCommands("{\"tool\":\"write\" \"args\":{}}").size());
        assertEquals(0, AmooProtocol.extractCommands("{\"tool\":\"write\"").size());
        assertEquals(0, AmooProtocol.extractCommands("[[[[[[").size());
    }

    /**
     * Braces inside JSON strings stay inside the command.
     *
     * The payload carries a brace and a closing brace inside a JSON string. The
     * line still starts with '{' and ends with '}', and parseExec reads the whole
     * object rather than truncating at the brace inside the string.
     */
    @Test
    public void bracesInsideStringsStayInsideTheCommand() {
        String text = "{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/a.py\","
                + "\"content\":\"if x: { y = '}' }\"}}";
        List<AmooProtocol.Fence> cmds = AmooProtocol.extractCommands(text);
        assertEquals(1, cmds.size());
        AmooProtocol.ParseResult r = AmooProtocol.parseExec(cmds.get(0).payload);
        assertTrue(r.ok);
        assertEquals("write", r.tool);
        // The payload is complete, not truncated at the brace inside the string.
        assertTrue(cmds.get(0).payload.endsWith("}}"));
        assertTrue(r.args.optString("content").contains("}"));
    }

    /**
     * KNOWN LIMITATION, pinned on purpose.
     *
     * The shape test trims with {@link String#trim()}, which only strips code
     * points <= U+0020. A command line padded with U+3000 (ideographic space) or
     * U+00A0 — both routine in Chinese model output and in accessibility node
     * text — therefore fails the "starts with '{'" check and is missed. The
     * direction is safe (a miss is an idle turn, not a wrong execution), and the
     * spec pins {@code trim()} rather than the fence path's wider
     * {@code stripEdgeSpace}; this test keeps the gap visible.
     */
    @Test
    public void fullWidthSpacePaddingDefeatsTheShapeTest() {
        String chat = "　{\"tool\":\"write\"}　";
        assertEquals(0, AmooProtocol.extractCommands(chat).size());
    }

    // ── findings from adversarial review of the shape path ──────────────────

    /**
     * A duplicate "tool" key must be rejected, not resolved.
     *
     * Which key wins depends on the JSON implementation: some throw, some let the
     * last one win. "Last wins" would execute a tool nobody wrote, so the parser
     * refuses the payload outright and the caller reports it back for a resend.
     */
    @Test
    public void aDuplicateToolKeyIsRejectedRatherThanResolved() {
        String dup = "{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/a.py\"},\"tool\":\"rm\"}";
        AmooProtocol.ParseResult r = AmooProtocol.parseExec(dup);
        assertFalse(r.ok);
        assertEquals("ambiguous_tool", r.reason);
        assertNull(r.tool);
        // And it therefore never becomes a command.
        assertEquals(0, AmooProtocol.extractCommands(dup).size());
        // A single occurrence is unaffected, including inside a nested object.
        assertTrue(AmooProtocol.parseExec(
                "{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/a.py\"}}").ok);
    }

    /**
     * A code SAMPLE whose body is a bare command is picked up — a known, pinned
     * compromise.
     *
     * The fence path swallows an unknown-kind fence whole, so a ```json block
     * showing the protocol is ignored there. The shape path has no fence to read
     * and sees only the body, so it accepts the command. Reproduced on the device.
     * This test exists to keep the hole VISIBLE rather than to bless it.
     */
    @Test
    public void aCodeSampleWhoseBodyIsABareCommandIsStillAccepted() {
        String chat = "用法是这样：\n"
                + "```json\n"
                + "{\"tool\":\"rm\",\"args\":{\"path\":\"/sdcard/x\"}}\n"
                + "```\n"
                + "把要执行的命令包在里面就行。";
        List<AmooProtocol.Fence> cmds = AmooProtocol.extractCommands(chat);
        // KNOWN COMPROMISE: 1, not 0. The safety floor still gates whatever runs.
        assertEquals(1, cmds.size());
        assertEquals("rm", AmooProtocol.parseExec(cmds.get(0).payload).tool);
    }

    /** Any non-whitespace prefix costs the line its command status (safe direction). */
    @Test
    public void aCommandWithAnyPrefixLosesItsStatus() {
        String[] prefixed = {
            "1. {\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/a.py\"}}",
            "- {\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/a.py\"}}",
            "`{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/a.py\"}}`",
            "“{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/a.py\"}}”",
        };
        for (String line : prefixed) {
            assertEquals(line, 0, AmooProtocol.extractCommands(line).size());
        }
    }
}
