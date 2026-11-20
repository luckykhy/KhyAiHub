// khy-canary: Khy-20261101-005-3R6RFQFY
package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Amoo fence protocol parsing.
 *
 * <p>Amoo talks in prose. Only text inside a fence is a machine instruction; anything
 * outside a fence is ignored even when it looks like a command. The fence dialect is
 * constrained by the Amoo-side prompt:
 *
 * <pre>
 * &#96;&#96;&#96;khy-exec
 * {"tool":"write","args":{...},"verify":{...}}
 * &#96;&#96;&#96;
 * </pre>
 *
 * <p>Rules implemented here (see the interception-layer spec for the source of truth):
 * <ul>
 *   <li>Only <b>closed</b> fences are returned. An unclosed fence means "still streaming,
 *       wait" — the caller detects that with {@link #hasOpenFence(String)}.</li>
 *   <li>A fence closes on the first line that consists of nothing but three backticks.
 *       Backticks that appear inline (for example inside a JSON string holding markdown)
 *       never close a fence, so code samples survive intact.</li>
 *   <li>Opening markers are matched case-insensitively and tolerate surrounding
 *       whitespace ({@code "   ```KHY-EXEC "} is a valid opener).</li>
 *   <li>Fences whose kind is not exec/plan/done are not fences at all.</li>
 * </ul>
 *
 * <p>Contract of the pure-logic bridge classes: zero IO, deterministic, never throws.
 * Every public method returns a value that expresses failure instead of raising.
 */
public final class AmooProtocol {

    /** The three fence kinds the Amoo prompt is allowed to emit. */
    public enum FenceKind { EXEC, PLAN, DONE }

    /** A closed fence. {@code payload} is the raw text between the marker lines. */
    public static final class Fence {
        public final FenceKind kind;
        public final String payload;
        /** True when {@code payload} parses as a JSON object. */
        public final boolean jsonValid;

        public Fence(FenceKind kind, String payload, boolean jsonValid) {
            this.kind = kind;
            this.payload = payload;
            this.jsonValid = jsonValid;
        }
    }

    /** Outcome of {@link #parseExec(String)}. */
    public static final class ParseResult {
        public final boolean ok;
        /** Non-null when {@code ok} is false. */
        public final String reason;
        public final String tool;
        /** May be null: the fence simply carried no arguments object. */
        public final JSONObject args;
        /** May be null: the fence simply carried no verification object. */
        public final JSONObject verify;

        public ParseResult(boolean ok, String reason, String tool, JSONObject args, JSONObject verify) {
            this.ok = ok;
            this.reason = reason;
            this.tool = tool;
            this.args = args;
            this.verify = verify;
        }
    }

    private static final String FENCE_MARK = "```";

    private AmooProtocol() {
    }

    /**
     * Extracts every closed fence from a chat message, in order of appearance.
     *
     * <p>Unclosed fences, unknown fence kinds and any prose outside the fences are
     * skipped. Returns an empty list for null or empty input.
     */
    public static List<Fence> extractFences(String chatText) {
        List<Fence> out = new ArrayList<Fence>();
        if (chatText == null || chatText.length() == 0) return out;

        String[] lines = splitLines(chatText);
        int i = 0;
        while (i < lines.length) {
            FenceKind kind = openingKind(lines[i]);
            if (kind == null) {
                if (markerTag(lines[i]) != null) {
                    // A fence kind we do not understand (```json, ```python, ...).
                    // Its whole body is ignored — including any known fence
                    // nested inside it. Otherwise a code sample that merely
                    // SHOWS the protocol would be lifted out and executed as a
                    // real command.
                    i = skipPastClose(lines, i + 1);
                    continue;
                }
                i++;
                continue;
            }
            // Walk forward until a line that is nothing but backticks.
            StringBuilder payload = new StringBuilder();
            boolean firstLine = true;
            int close = -1;
            for (int j = i + 1; j < lines.length; j++) {
                if (isClosingMarker(lines[j])) {
                    close = j;
                    break;
                }
                if (!firstLine) {
                    payload.append('\n');
                }
                payload.append(lines[j]);
                firstLine = false;
            }
            if (close < 0) {
                // Unclosed: everything that follows belongs to this fence, so there is
                // nothing more to scan.
                break;
            }
            String body = payload.toString();
            out.add(new Fence(kind, body, isJsonObject(body)));
            i = close + 1;
        }
        return out;
    }

    /** Index just past the closing marker of a fence opened before {@code from}. */
    private static int skipPastClose(String[] lines, int from) {
        for (int j = Math.max(0, from); j < lines.length; j++) {
            if (isClosingMarker(lines[j])) {
                return j + 1;
            }
        }
        return lines.length;
    }

    /**
     * True when at least one known fence is still open at the end of the text, i.e. the
     * model is mid-emission and the loop should keep waiting instead of concluding.
     */
    public static boolean hasOpenFence(String chatText) {
        if (chatText == null || chatText.length() == 0) return false;
        String[] lines = splitLines(chatText);
        boolean open = false;
        for (int n = 0; n < lines.length; n++) {
            if (open) {
                if (isClosingMarker(lines[n])) open = false;
                continue;
            }
            if (openingKind(lines[n]) != null) open = true;
        }
        return open;
    }

    /**
     * Find command-shaped JSON in plain chat text, one command per line.
     *
     * WHY this exists alongside {@link #extractFences} — measured on the target
     * device, not theorised. Amoo renders a {@code ```khy-exec} block as
     * STRUCTURED UI: the markdown renderer emits a header row carrying the
     * language tag plus a "copy code" button, then the code body as its own
     * accessibility node. The backtick fence lines are consumed by the renderer
     * and never reach the accessibility tree, so on this device the fences are
     * invisible while the JSON payload survives intact as a single text node. A
     * long reply also scrolls the first block's header off-screen entirely.
     *
     * <p>On top of that filter, the device measurement gives one more discriminator.
     * Amoo renders each command as its OWN TextView node, and prose is a separate
     * node; {@link AmooChatText} joins node texts with {@code "\n"} in geometric
     * order, so one command occupies exactly one line. An example typed inline
     * inside prose shares that prose's node, so its line does NOT start with
     * {@code '{'}. Requiring "the whole line is one JSON object" therefore kills
     * the common false positive — "for example {...} like this" — without needing
     * a fence to read.
     *
     * <p>Residual risk, stated plainly — there are three, and the fence path's
     * protection does not cover any of them:
     * <ul>
     *   <li>an example command written on a line of its own is still picked up;</li>
     *   <li>a {@code ```json} code sample whose body is a bare command is picked
     *       up too. The fence path swallows an unknown-kind fence whole
     *       (see {@link #extractFences}); the shape path has no fence to read, so
     *       it sees only the body. Verified reproducible on the device;</li>
     *   <li>a duplicate {@code "tool"} key is rejected outright rather than
     *       resolved, because which one wins depends on the JSON implementation.</li>
     * </ul>
     * The safety floor still applies to whatever is picked up and every execution
     * is reported back — but these ARE holes in the "only fenced text is a
     * command" guarantee, traded for the measured fact that the fences do not
     * survive rendering on this device at all.
     *
     * <p>The other edge of the same trade, deliberately biased toward false
     * negatives: multi-line / pretty-printed JSON is NOT recognised, and neither
     * is a command carrying any non-whitespace prefix — a list number
     * ({@code "1. {...}"}), a bullet, an inline-code backtick, or a quote. None of
     * those lines starts with {@code '{'}. A missed command surfaces as an idle
     * turn and the loop keeps polling; an invented command runs something nobody
     * asked for. Missing is the cheaper direction, so the shape test is
     * deliberately strict. Widening it — stripping list prefixes before the shape
     * check — would re-open the false-positive surface and needs a human decision.
     *
     * <p>THE TOOL-NAME FILTER IS NOT A SECOND SILENT-DROP ZONE (2026-11-03, P0-2).
     * A line that parses as one command object is kept only when it names a tool
     * the bridge has ({@link LoopModes#isKnownTool}). That filter used to be
     * narrower than the bridge's real tool set, so a command naming one of the
     * twelve missing tools was dropped here — silently, before any decision layer
     * — and the user saw nothing at all. The basis is now the mirror of
     * {@code Tools.NAMES}, and {@code LoopModesTest} pins the two by set.
     *
     * @return EXEC fences in order of appearance; empty for null/empty input
     */
    public static List<Fence> extractCommands(String chatText) {
        List<Fence> out = new ArrayList<Fence>();
        if (chatText == null || chatText.length() == 0) {
            return out;
        }
        for (String line : chatText.split("\n")) {
            String t = line.trim();
            // The whole line must be, and must be nothing but, one JSON object.
            // "Starts with '{'" plus "ends with '}'" is what rules out an inline
            // example such as "for example {...} like this": it lives in the same
            // accessibility node as its prose, so that line cannot start with '{'.
            if (t.length() < 2) {
                continue;
            }
            if (t.charAt(0) != '{' || t.charAt(t.length() - 1) != '}') {
                continue;
            }
            // ...and it must be exactly ONE object. org.json parses the first
            // value and ignores whatever follows, so "{...} {...}" on one line
            // would silently execute the first command and drop the second —
            // the same truncation failure the fence protocol exists to prevent.
            if (!isSingleJsonObject(t)) {
                continue;
            }
            ParseResult r = parseExec(t);
            // 过滤依据：LoopModes.KNOWN_TOOLS —— 它现在是 Tools.NAMES 的**集合镜像**
            // （48 项，P0-2 起；此前是 36 项，差集那 12 项在这里被无声丢掉：
            // adou_signin / amoo_ask / amoo_result / amoo_memory / amoo_stop /
            // zip / unzip / secret_code / secret_put / secret_list / secret_del / tools）。
            // 命令在这里被丢掉 = 用户看到「什么都没发生」，所以这份表必须与手机端
            // 真能答的工具集合一致；LoopModesTest 按集合钉住这份相等。
            if (r.ok && LoopModes.isKnownTool(r.tool)) {
                out.add(new Fence(FenceKind.EXEC, t, true));
            }
        }
        return out;
    }

    /**
     * Whether {@code s} is exactly one top-level JSON object, spanning all of it.
     *
     * String-aware: a brace inside a JSON string literal must not count. The
     * scan is over the already-trimmed line, so "the first object ends at the
     * last character" is the whole test.
     *
     * NOTE: this is a deliberate tightening BEYOND the written spec, which asked
     * only for the first/last-character check. It is the sole guard against
     * "{...} {...}" on one line — org.json would parse the first and silently
     * drop the second. Pinned by
     * AmooProtocolTest.severalObjectsOnOneLineAreNotCommands; do not remove it as
     * "redundant" on the grounds that the character check looks sufficient.
     */
    private static boolean isSingleJsonObject(String s) {
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (c == '\\') {
                    escaped = true;
                } else if (c == '"') {
                    inString = false;
                }
                continue;
            }
            if (c == '"') {
                inString = true;
            } else if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return i == s.length() - 1;
                }
            }
        }
        return false;
    }

    /** Non-overlapping occurrence count of {@code needle} in {@code haystack}. */
    private static int countOccurrences(String haystack, String needle) {
        if (haystack == null || haystack.length() == 0 || needle == null || needle.length() == 0) {
            return 0;
        }
        int n = 0;
        int i = haystack.indexOf(needle);
        while (i >= 0) {
            n++;
            i = haystack.indexOf(needle, i + needle.length());
        }
        return n;
    }

    /**
     * Parses the payload of an EXEC fence into a dispatchable command.
     *
     * <p>Failure reasons: {@code payload_not_json} (not a JSON object, includes
     * unparsable text), {@code missing_tool} (no usable "tool" member),
     * {@code tool_not_string} ("tool" present but not a JSON string),
     * {@code ambiguous_tool} (more than one "tool" key — see the guard inside).
     */
    public static ParseResult parseExec(String payload) {
        String text = payload == null ? "" : payload.trim();
        // A duplicate "tool" key makes the outcome depend on the JSON
        // implementation: some throw, some let the LAST one win. "Last wins"
        // would execute a tool nobody wrote, so reject instead of guessing.
        // Counting occurrences anywhere — not just at the top level — is
        // deliberately over-broad: a false rejection costs one resend, a false
        // acceptance runs the wrong command.
        if (countOccurrences(text, "\"tool\"") > 1) {
            return new ParseResult(false, "ambiguous_tool", null, null, null);
        }
        JSONObject root = null;
        if (text.length() > 0 && text.charAt(0) == '{') {
            try {
                root = new JSONObject(text);
            } catch (Throwable ignored) {
                root = null;
            }
        }
        if (root == null) return new ParseResult(false, "payload_not_json", null, null, null);

        String tool;
        try {
            if (!root.has("tool")) return new ParseResult(false, "missing_tool", null, null, null);
            Object raw = root.get("tool");
            if (!(raw instanceof String)) {
                return new ParseResult(false, "tool_not_string", null, null, null);
            }
            tool = (String) raw;
            if (tool.trim().length() == 0) {
                return new ParseResult(false, "missing_tool", null, null, null);
            }
        } catch (Throwable ignored) {
            return new ParseResult(false, "payload_not_json", null, null, null);
        }

        JSONObject args = null;
        JSONObject verify = null;
        try {
            args = root.optJSONObject("args");
            verify = root.optJSONObject("verify");
        } catch (Throwable ignored) {
            args = null;
            verify = null;
        }
        return new ParseResult(true, null, tool, args, verify);
    }

    /** Splits on "\n" and drops a trailing "\r" so CRLF transcripts parse the same. */
    private static String[] splitLines(String text) {
        String[] raw = text.split("\n", -1);
        String[] lines = new String[raw.length];
        for (int i = 0; i < raw.length; i++) {
            String l = raw[i];
            if (l.length() > 0 && l.charAt(l.length() - 1) == '\r') l = l.substring(0, l.length() - 1);
            lines[i] = l;
        }
        return lines;
    }

    /** Fence kind of an opening marker line, or null when the line opens nothing. */
    private static FenceKind openingKind(String line) {
        return kindOfTag(markerTag(line));
    }

    /**
     * The tag on a fence marker line, or null when the line is not a fence line
     * at all.
     *
     * The remainder after the backticks must be a SINGLE word. A line like
     * {@code "```khy-exec 只是提到这个词"} is prose that mentions the marker, not
     * an opener — and treating it as one made {@link #hasOpenFence} stay true
     * forever, stalling the loop to its deadline.
     */
    private static String markerTag(String line) {
        String t = stripEdgeSpace(line);
        if (!t.startsWith(FENCE_MARK)) {
            return null;
        }
        String rest = stripEdgeSpace(t.substring(FENCE_MARK.length()));
        if (rest.length() == 0) {
            return null;
        }
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
                return null;
            }
        }
        return rest;
    }

    private static FenceKind kindOfTag(String tag) {
        if ("khy-exec".equalsIgnoreCase(tag)) return FenceKind.EXEC;
        if ("khy-plan".equalsIgnoreCase(tag)) return FenceKind.PLAN;
        if ("khy-done".equalsIgnoreCase(tag)) return FenceKind.DONE;
        return null;
    }

    /**
     * A closing marker is a line holding nothing but backticks.
     *
     * Three or more are accepted: CommonMark lets a closing fence be longer
     * than the opening one, and Amoo emitting ```` on the closing line is
     * common enough that requiring exactly three lost real commands.
     */
    private static boolean isClosingMarker(String line) {
        String t = stripEdgeSpace(line);
        if (t.length() < FENCE_MARK.length()) {
            return false;
        }
        for (int i = 0; i < t.length(); i++) {
            if (t.charAt(i) != '`') {
                return false;
            }
        }
        return true;
    }

    /**
     * Trim the characters that can pad a fence marker line.
     *
     * {@link String#trim()} only strips code points <= U+0020, so a line padded
     * with U+3000 (ideographic space) or U+00A0 (nbsp) — both routine in Chinese
     * model output and in accessibility node text — would never be recognised.
     * A missed opener silently drops the command; a missed closer makes
     * {@link #hasOpenFence} true forever and spins the loop to its deadline.
     */
    private static String stripEdgeSpace(String s) {
        if (s == null) {
            return "";
        }
        int a = 0;
        int b = s.length();
        while (a < b && isFenceSpace(s.charAt(a))) {
            a++;
        }
        while (b > a && isFenceSpace(s.charAt(b - 1))) {
            b--;
        }
        return s.substring(a, b);
    }

    private static boolean isFenceSpace(char c) {
        return c <= 0x20 || c == 0x00A0 || c == 0x202F || c == 0x3000 || c == 0xFEFF;
    }

    private static boolean isJsonObject(String payload) {
        if (payload == null) return false;
        String t = payload.trim();
        if (t.length() == 0 || t.charAt(0) != '{') return false;
        try {
            new JSONObject(t);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }
}
