// khy-canary: Khy-20261101-002-X0RM5F2J
package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * AmooChatText — turn a uiautomator-compatible XML dump into Amoo's chat text.
 *
 * WHY this exists: the interception loop reads Amoo's replies through the
 * accessibility tree (there is no other channel — Amoo's command workspace is
 * in the cloud and the phone has no inbound network path). The dump gives a
 * FLAT list of nodes, so the chat text has to be reconstructed geometrically:
 * find the chat list's bounds, keep every text-bearing node inside them, sort
 * top-to-bottom then left-to-right, and join.
 *
 * This mirrors the PC-side `extractChatListText` in
 * runtime/node/backend/src/services/domain/network/amoo/amooUiSnapshot.js.
 * It is a deliberate duplicate, not an oversight: that module is JavaScript and
 * runs on the PC, and the whole point of this loop is that it must work with
 * NO PC attached.
 *
 * Two measured constraints baked in:
 *
 * 1. `excludeIds` is NOT optional in practice. On an empty conversation the
 *    chat list spans the whole content area, so the input box and the send
 *    button are geometrically "inside" it. Without the exclusion the input
 *    hint ("发消息") leaks into the chat text and corrupts both fence
 *    extraction and the stability judgement.
 *
 * 2. Node text can carry a multi-line payload: KhyUi.escapeXml encodes '\n'
 *    as &#10; and '"' as &#34;, and a code block inside a bubble arrives as
 *    ONE node with embedded newlines. Verified on the target device by writing
 *    a fence into the input box and reading it back byte-for-byte. The reverse
 *    decoding therefore has to be exact, or the fence JSON will not parse.
 *
 * Contract: zero IO, deterministic, never throws.
 */
public final class AmooChatText {
    private AmooChatText() {}

    /** Bounds of a node, or null when absent/unparseable. */
    private static final class Rect {
        final int x1, y1, x2, y2;

        Rect(int x1, int y1, int x2, int y2) {
            this.x1 = x1;
            this.y1 = y1;
            this.x2 = x2;
            this.y2 = y2;
        }
    }

    /** One flattened node, carrying only what the reconstruction needs. */
    private static final class Node {
        final String resourceId;
        final String text;
        final Rect rect;

        Node(String resourceId, String text, Rect rect) {
            this.resourceId = resourceId == null ? "" : resourceId;
            this.text = text == null ? "" : text;
            this.rect = rect;
        }
    }

    /**
     * Reconstruct the chat text from a dump.
     *
     * @param xml        raw uiautomator-compatible XML (as returned by ui_dump)
     * @param chatListId resource-id of the chat list container, e.g.
     *                   "com.stepos.ailauncher:id/chat_list"
     * @param excludeIds resource-ids to keep out of the chat text. Pass at
     *                   least the input box and the send button.
     * @return the chat text, lines joined with '\n'. Empty when the chat list
     *         is absent. Never null, never throws.
     */
    public static String extract(String xml, String chatListId, String... excludeIds) {
        String text = xml == null ? "" : xml;
        String listId = chatListId == null ? "" : chatListId;
        if (text.length() == 0 || listId.length() == 0) {
            return "";
        }
        List<Node> nodes;
        try {
            nodes = parseNodes(text);
        } catch (Throwable bad) {
            return "";
        }
        Node list = null;
        for (Node n : nodes) {
            if (listId.equals(n.resourceId)) {
                list = n;
                break;
            }
        }
        if (list == null || list.rect == null) {
            return "";
        }
        List<Node> inside = new ArrayList<Node>();
        for (Node n : nodes) {
            if (n == list || n.rect == null) {
                continue;
            }
            if (isExcluded(n.resourceId, excludeIds)) {
                continue;
            }
            if (n.text.length() == 0) {
                continue;
            }
            if (isInside(n.rect, list.rect)) {
                inside.add(n);
            }
        }
        // Reading order: top-to-bottom, then left-to-right. Stable across dumps
        // so the stability judgement downstream can compare two snapshots.
        Collections.sort(inside, new Comparator<Node>() {
            public int compare(Node a, Node b) {
                if (a.rect.y1 != b.rect.y1) {
                    return a.rect.y1 < b.rect.y1 ? -1 : 1;
                }
                if (a.rect.x1 != b.rect.x1) {
                    return a.rect.x1 < b.rect.x1 ? -1 : 1;
                }
                return 0;
            }
        });
        // Dedup by exact text: the accessibility tree repeats a parent's text on
        // some ROMs, and a repeated line would break fence counting.
        List<String> seen = new ArrayList<String>();
        StringBuilder out = new StringBuilder();
        for (Node n : inside) {
            String value = n.text.trim();
            if (value.length() == 0 || seen.contains(value)) {
                continue;
            }
            seen.add(value);
            if (out.length() > 0) {
                out.append('\n');
            }
            out.append(value);
        }
        return out.toString();
    }

    /**
     * The newest reply only.
     *
     * Amoo renders one bubble per turn, separated by a blank line. The loop MUST
     * work on the last block rather than the whole chat text: the chat text is
     * cumulative, so re-scanning it every round would re-execute commands that
     * already ran. Taking the last block turns "what is new" into "what is at
     * the end", which needs no offset bookkeeping and survives the RecyclerView
     * recycling off-screen bubbles.
     *
     * Mirrors lastChatBlock in the PC-side amooUiSnapshot.js.
     *
     * @param chatText output of {@link #extract}
     * @return the last non-empty block, or "" when there is none
     */
    public static String lastChatBlock(String chatText) {
        if (chatText == null || chatText.length() == 0) {
            return "";
        }
        // Split on runs of 2+ newlines, tolerating surrounding whitespace.
        String[] raw = chatText.split("\\n\\s*\\n");
        String last = "";
        for (String block : raw) {
            String trimmed = block.trim();
            if (trimmed.length() > 0) {
                last = trimmed;
            }
        }
        return last;
    }

    /**
     * Whether a dump hit the node ceiling and was silently truncated.
     *
     * This matters more than it looks: KhyUi.walk stops at maxNodes, so a long
     * reply produces a dump whose fence is cut in half. The loop must NOT treat
     * a truncated dump as "no fence" — it must treat it as "cannot tell yet" and
     * retry with a higher ceiling or after scrolling.
     *
     * @param xml      raw dump XML
     * @param maxNodes the max_nodes the caller asked for
     * @return true when the dump contains at least maxNodes nodes
     */
    public static boolean isTruncated(String xml, int maxNodes) {
        if (xml == null || maxNodes <= 0) {
            return false;
        }
        try {
            return countNodes(xml) >= maxNodes;
        } catch (Throwable bad) {
            return false;
        }
    }

    /**
     * Parse a bridge /call response body into the chat text in one step.
     * Convenience for the loop; same contract as {@link #extract}.
     */
    public static String fromCallResult(String callResultJson, String chatListId, String... excludeIds) {
        if (callResultJson == null) {
            return "";
        }
        try {
            JSONObject o = new JSONObject(callResultJson);
            if (!o.optBoolean("ok", false)) {
                return "";
            }
            return extract(o.optString("xml", ""), chatListId, excludeIds);
        } catch (Throwable bad) {
            return "";
        }
    }

    // ── internals ───────────────────────────────────────────────────────────

    private static boolean isExcluded(String resourceId, String... excludeIds) {
        if (excludeIds == null) {
            return false;
        }
        for (String id : excludeIds) {
            if (id != null && id.length() > 0 && id.equals(resourceId)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isInside(Rect node, Rect container) {
        // A small tolerance: measured bounds can be a pixel off between dumps,
        // and a strict comparison would drop the last line of a bubble.
        final int t = 2;
        return node.x1 >= container.x1 - t
                && node.y1 >= container.y1 - t
                && node.x2 <= container.x2 + t
                && node.y2 <= container.y2 + t;
    }

    private static List<Node> parseNodes(String xml) {
        List<Node> out = new ArrayList<Node>();
        int i = 0;
        int n = xml.length();
        while (i < n) {
            int lt = xml.indexOf("<node", i);
            if (lt < 0) {
                break;
            }
            int gt = xml.indexOf('>', lt);
            if (gt < 0) {
                break;
            }
            String tag = xml.substring(lt, gt + 1);
            String resourceId = attr(tag, "resource-id");
            String text = decode(attr(tag, "text"));
            if (text.length() == 0) {
                // content-desc is the other place text lives on some bubbles.
                text = decode(attr(tag, "content-desc"));
            }
            out.add(new Node(resourceId, text, parseBounds(attr(tag, "bounds"))));
            i = gt + 1;
        }
        return out;
    }

    private static int countNodes(String xml) {
        int count = 0;
        int i = 0;
        while (true) {
            int lt = xml.indexOf("<node", i);
            if (lt < 0) {
                return count;
            }
            int gt = xml.indexOf('>', lt);
            if (gt < 0) {
                return count;
            }
            count++;
            i = gt + 1;
        }
    }

    private static String attr(String tag, String name) {
        // Matches name="..." inside one <node ...> tag. Attribute values never
        // contain a raw '"' — KhyUi.escapeXml encodes it as &#34; — so the
        // non-greedy match up to the next quote is safe.
        String needle = name + "=\"";
        int at = tag.indexOf(needle);
        if (at < 0) {
            return "";
        }
        int start = at + needle.length();
        int end = tag.indexOf('"', start);
        if (end < 0) {
            return "";
        }
        return tag.substring(start, end);
    }

    private static Rect parseBounds(String bounds) {
        // "[241,1302][807,1419]"
        if (bounds == null || bounds.length() < 4) {
            return null;
        }
        try {
            int a = bounds.indexOf('[');
            int b = bounds.indexOf(']', a);
            if (a < 0 || b < 0) {
                return null;
            }
            String[] p1 = bounds.substring(a + 1, b).split(",");
            int c = bounds.indexOf('[', b);
            int d = bounds.indexOf(']', c);
            if (c < 0 || d < 0) {
                return null;
            }
            String[] p2 = bounds.substring(c + 1, d).split(",");
            return new Rect(
                    Integer.parseInt(p1[0].trim()),
                    Integer.parseInt(p1[1].trim()),
                    Integer.parseInt(p2[0].trim()),
                    Integer.parseInt(p2[1].trim())
            );
        } catch (Throwable bad) {
            return null;
        }
    }

    /**
     * Reverse KhyUi.escapeXml exactly.
     *
     * Order matters: '&' MUST be decoded last, otherwise "&amp;#10;" would
     * decode to "&#10;" and then to "\n" — a double-unescape bug that would
     * silently corrupt fenced payloads containing a literal ampersand.
     */
    static String decode(String s) {
        if (s == null || s.length() == 0 || s.indexOf('&') < 0) {
            return s == null ? "" : s;
        }
        String v = s;
        v = v.replace("&#10;", "\n");
        v = v.replace("&#13;", "\r");
        v = v.replace("&#9;", "\t");
        v = v.replace("&lt;", "<");
        v = v.replace("&gt;", ">");
        v = v.replace("&quot;", "\"");
        v = v.replace("&#34;", "\"");
        v = v.replace("&#39;", "'");
        v = v.replace("&apos;", "'");
        v = v.replace("&amp;", "&");
        return v;
    }
}
