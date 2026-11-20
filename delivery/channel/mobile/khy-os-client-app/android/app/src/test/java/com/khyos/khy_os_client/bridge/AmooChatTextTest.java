// khy-canary: Khy-20261101-034-91FVX0Q4
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * AmooChatTextTest — the reconstruction is the loop's only ear. If it drops a
 * line, a fence loses its closing marker and nothing ever executes; if it
 * invents one, prose gets executed. Both failure modes are pinned here.
 */
public class AmooChatTextTest {

    private static final String LIST = "com.stepos.ailauncher:id/chat_list";
    private static final String INPUT = "com.stepos.ailauncher:id/et_input_bar";
    private static final String SEND = "com.stepos.ailauncher:id/btn_text_send";

    /** Build one <node .../> exactly the way KhyUi.walk emits it. */
    private static String node(String id, String text, String bounds) {
        // KhyUi escapes text before writing it; replicate for the raw-attr path.
        String esc = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&#34;").replace("'", "&#39;")
                .replace("\n", "&#10;").replace("\r", "&#13;").replace("\t", "&#9;");
        return "<node index=\"1\" text=\"" + esc + "\" resource-id=\"" + id
                + "\" class=\"android.widget.TextView\" package=\"com.stepos.ailauncher\""
                + " content-desc=\"\" checkable=\"false\" checked=\"false\" clickable=\"false\""
                + " enabled=\"true\" focusable=\"false\" focused=\"false\" scrollable=\"false\""
                + " long-clickable=\"false\" selected=\"false\" bounds=\"" + bounds + "\"/>";
    }

    private static final String XML_HEAD =
            "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">";
    private static final String XML_TAIL = "</hierarchy>";

    private static String xml(String... nodes) {
        StringBuilder sb = new StringBuilder(XML_HEAD);
        for (String n : nodes) {
            sb.append(n);
        }
        return sb.append(XML_TAIL).toString();
    }

    @Test
    public void reconstructsChatTextInReadingOrder() {
        String x = xml(
                node(LIST, "", "[52,0][1148,1269]"),
                // Deliberately out of order in the dump; must come back sorted.
                node("", "第二行", "[52,600][1148,700]"),
                node("", "第一行", "[52,300][1148,400]"),
                node("", "同行右侧", "[600,300][1148,400]")
        );
        assertEquals("第一行\n同行右侧\n第二行",
                AmooChatText.extract(x, LIST, INPUT, SEND));
    }

    @Test
    public void inputHintDoesNotLeakIntoChatText() {
        // The measured failure: on an empty conversation the chat list spans the
        // whole content area, so the input box is geometrically inside it.
        String x = xml(
                node(LIST, "", "[0,196][1200,2660]"),
                node("", "你好", "[52,300][1148,400]"),
                node(INPUT, "发消息或按住说话", "[98,2388][1109,2505]"),
                node(SEND, "", "[960,1301][1103,1418]")
        );
        assertEquals("你好", AmooChatText.extract(x, LIST, INPUT, SEND));
    }

    @Test
    public void multiLineFencedPayloadSurvivesTheRoundTrip() {
        // Byte-for-byte what ui_type wrote and ui_dump read back on the device.
        String payload = "```khy-exec\n{\"tool\":\"write\",\"args\":{\"path\":\"/sdcard/g/main.py\","
                + "\"content\":\"print(1)\"}}\n```";
        String x = xml(
                node(LIST, "", "[52,0][1148,1269]"),
                node("", payload, "[52,300][1148,1100]")
        );
        String got = AmooChatText.extract(x, LIST, INPUT, SEND);
        assertEquals(payload, got);
        assertTrue(got.contains("khy-exec"));
        assertTrue(got.contains("\"tool\":\"write\""));
    }

    @Test
    public void decodeDoesNotDoubleUnescapeAmpersand() {
        // "&amp;#10;" is an escaped literal "&#10;", NOT a newline. Decoding '&'
        // last is what makes this correct; the opposite order silently corrupts
        // any fenced payload containing an ampersand.
        assertEquals("&#10;", AmooChatText.decode("&amp;#10;"));
        assertEquals("a & b", AmooChatText.decode("a &amp; b"));
        assertEquals("\n", AmooChatText.decode("&#10;"));
        assertEquals("\"", AmooChatText.decode("&#34;"));
        assertEquals("<x>", AmooChatText.decode("&lt;x&gt;"));
    }

    @Test
    public void duplicateTextIsCollapsed() {
        // Some ROMs repeat a parent's text on its children; a repeated line
        // would break fence counting downstream.
        String x = xml(
                node(LIST, "", "[52,0][1148,1269]"),
                node("", "同一行", "[52,300][1148,400]"),
                node("", "同一行", "[52,300][1148,400]")
        );
        assertEquals("同一行", AmooChatText.extract(x, LIST, INPUT, SEND));
    }

    @Test
    public void missingChatListYieldsEmptyNotGarbage() {
        String x = xml(node("", "孤儿文本", "[52,300][1148,400]"));
        assertEquals("", AmooChatText.extract(x, LIST, INPUT, SEND));
    }

    @Test
    public void isTruncatedDetectsTheNodeCeiling() {
        StringBuilder sb = new StringBuilder(XML_HEAD);
        for (int i = 0; i < 50; i++) {
            sb.append(node("", "行" + i, "[52," + (300 + i) + "][1148," + (320 + i) + "]"));
        }
        String x = sb.append(XML_TAIL).toString();
        assertTrue(AmooChatText.isTruncated(x, 50));
        assertFalse(AmooChatText.isTruncated(x, 51));
        assertFalse(AmooChatText.isTruncated(x, 0));
    }

    @Test
    public void lastChatBlockTakesTheNewestBubbleOnly() {
        // The cumulative-chat trap: without this, round 2 would re-execute the
        // commands that already ran in round 1.
        String chat = "第一轮：你好\n\n第一轮：```khy-exec\n{\"tool\":\"toast\"}\n```"
                + "\n\n第二轮：```khy-exec\n{\"tool\":\"write\"}\n```";
        assertEquals("第二轮：```khy-exec\n{\"tool\":\"write\"}\n```",
                AmooChatText.lastChatBlock(chat));
    }

    @Test
    public void lastChatBlockHandlesDegenerateInput() {
        assertEquals("", AmooChatText.lastChatBlock(null));
        assertEquals("", AmooChatText.lastChatBlock(""));
        assertEquals("", AmooChatText.lastChatBlock("\n\n\n"));
        assertEquals("", AmooChatText.lastChatBlock("   \n \n  "));
        assertEquals("只有一块", AmooChatText.lastChatBlock("只有一块"));
        // Blocks are separated by BLANK lines, not by any newline — so a plain
        // two-line message is still ONE block. (Matches the PC side's
        // lastChatBlock, which splits on /\n{2,}/.)
        assertEquals("甲\n乙", AmooChatText.lastChatBlock("甲\n乙"));
    }

    @Test
    public void junkInputNeverThrows() {
        assertEquals("", AmooChatText.extract(null, LIST));
        assertEquals("", AmooChatText.extract("", LIST));
        assertEquals("", AmooChatText.extract("not xml at all", LIST));
        assertEquals("", AmooChatText.extract("<node text=\"x\"", LIST));
        assertEquals("", AmooChatText.extract(xml(node(LIST, "", "garbage-bounds")), LIST));
        assertEquals("", AmooChatText.extract(xml(node(LIST, "", "[1,2][3]")), LIST));
        assertEquals("", AmooChatText.extract(xml(node(LIST, "", "[a,b][c,d]")), LIST));
        assertEquals("", AmooChatText.fromCallResult(null, LIST));
        assertEquals("", AmooChatText.fromCallResult("{not json", LIST));
        assertEquals("", AmooChatText.fromCallResult("{\"ok\":false}", LIST));
        // A node whose text attribute is simply absent.
        assertEquals("", AmooChatText.extract(
                "<hierarchy><node index=\"1\" resource-id=\"" + LIST + "\" bounds=\"[0,0][9,9]\"/></hierarchy>",
                LIST));
    }

    @Test
    public void fromCallResultReadsTheBridgeEnvelope() {
        String payload = "```khy-done\n{\"summary\":\"ok\"}\n```";
        String x = xml(node(LIST, "", "[52,0][1148,1269]"), node("", payload, "[52,300][1148,900]"));
        String body = "{\"ok\":true,\"xml\":" + org.json.JSONObject.quote(x) + ",\"nodes\":2}";
        assertEquals(payload, AmooChatText.fromCallResult(body, LIST, INPUT, SEND));
    }
}
