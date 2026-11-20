// khy-canary: Khy-20261101-004-B44QKJHD
package com.khyos.khy_os_client.bridge;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * AmooMemory — the khy-os ↔ Amoo shared memory, as a pure data model.
 *
 * WHY this shape. The measured facts about Amoo are unforgiving: its command
 * environment is in the CLOUD and /sdcard does not exist for it, so there is no
 * shared filesystem to speak of. The only media that actually reach both sides
 * are Amoo's own conversation flow, the Android clipboard, and the bridge's own
 * directory on /sdcard. The conversation IS the shared memory — this class is
 * the normalized local half of it, rendered into that conversation at loop start
 * and folded back at loop end.
 *
 * The one rule that matters, and the reason there is no NLP here:
 *
 *   A fact is never silently promoted. Everything carries a confidence, and
 *   {@link Confidence#UNVERIFIED} means exactly what it says — somebody said it,
 *   nobody checked. {@link #renderForInjection} labels the two differently so
 *   Amoo cannot mistake a recollection for a measurement. Auto-extracting
 *   "facts" from prose would be guessing, which is the failure mode this whole
 * bridge is built to avoid; entries are therefore written only by an explicit
 * command, or by a command whose verification actually passed.
 *
 * Contract: pure, deterministic, never throws. All file IO stays in the caller
 * (AmooLoop), matching how every other pure leaf in this package behaves.
 */
public final class AmooMemory {
    /** Current schema version. Bumped only on a breaking shape change. */
    public static final int VERSION = 1;

    public enum Confidence {
        /** Confirmed by an executed-and-verified command. */
        VERIFIED,
        /** Somebody asserted it; nothing checked it. */
        UNVERIFIED
    }

    /** One remembered fact. {@code id} is the stable key used for merge/dedup. */
    public static final class Entry {
        public final String id;
        public final String text;
        public final Confidence confidence;
        /** Where it came from, e.g. "amoo-said", "user", "verified:write". */
        public final String provenance;

        Entry(String id, String text, Confidence confidence, String provenance) {
            this.id = id == null ? "" : id;
            this.text = text == null ? "" : text;
            this.confidence = confidence == null ? Confidence.UNVERIFIED : confidence;
            this.provenance = provenance == null ? "" : provenance;
        }

        /** True when this entry says something worth rendering. */
        public boolean isUsable() {
            return id.length() > 0 && text.length() > 0;
        }
    }

    /** Default file the caller reads and writes. */
    public static final String DEFAULT_PATH = "/sdcard/bridge-amoobridge/amoo_memory.json";

    private static final int MAX_ENTRIES = 60;

    // ── construction ────────────────────────────────────────────────────────

    /** An empty memory. */
    public static AmooMemory empty() {
        return new AmooMemory(new ArrayList<Entry>(), 0);
    }

    /**
     * Parse a memory document.
     *
     * Malformed JSON, a wrong version, or entries that fail to parse are all
     * tolerated: whatever parses is kept, the rest is dropped. A corrupt memory
     * file must never take the loop down — it is a convenience, not a dependency.
     *
     * THE LAST {@link #MAX_ENTRIES} ARE KEPT, NOT THE FIRST. This used to read
     * from the front while {@link #with} evicts from the front, so a document
     * over the cap was loaded as its oldest entries and saved as its newest —
     * everything in the middle vanished on that round trip, with no marker and
     * no log. For a fact store the asymmetry is backwards in both directions:
     * the newest entries are the ones the conversation is currently about, and
     * the oldest are the ones most likely to have been superseded. So read the
     * same side {@code with} writes.
     *
     * What was dropped is recorded in {@link #droppedOnLoad()} rather than
     * discarded, because {@link #renderForInjection} is prefixed with
     * 「请以此为前提，不要重新测量」 — and telling a model to treat a partial
     * list as the complete premise is the fabrication this class exists to
     * prevent, arriving through the one channel that is supposed to be the
     * trustworthy one.
     */
    public static AmooMemory fromJson(String json) {
        List<Entry> out = new ArrayList<Entry>();
        int dropped = 0;
        if (json == null || json.length() == 0) {
            return new AmooMemory(out, 0);
        }
        try {
            JSONObject root = new JSONObject(json);
            JSONArray arr = root.optJSONArray("entries");
            if (arr == null) {
                return new AmooMemory(out, 0);
            }
            // Parse everything that parses, then keep the tail. Parsing first
            // and slicing after (rather than stopping at MAX_ENTRIES) is what
            // makes the count honest: a document of 100 entries where 5 are
            // malformed drops 40, not 45.
            List<Entry> all = new ArrayList<Entry>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) {
                    continue;
                }
                String id = o.optString("id", "").trim();
                String text = o.optString("text", "").trim();
                if (id.length() == 0 || text.length() == 0) {
                    continue;
                }
                Confidence c = "verified".equalsIgnoreCase(o.optString("confidence", ""))
                        ? Confidence.VERIFIED
                        : Confidence.UNVERIFIED;
                all.add(new Entry(id, text, c, o.optString("provenance", "")));
            }
            if (all.size() > MAX_ENTRIES) {
                dropped = all.size() - MAX_ENTRIES;
                out.addAll(all.subList(dropped, all.size()));
            } else {
                out.addAll(all);
            }
        } catch (Throwable bad) {
            // Keep whatever was parsed before the failure.
        }
        return new AmooMemory(out, dropped);
    }

    private final List<Entry> entries;

    /**
     * How many entries the file had beyond the cap when it was read.
     *
     * WHY THIS IS REMEMBERED. The injection is prefixed with
     * 「请以此为前提，不要重新测量」. A memory that arrived over the cap and
     * was trimmed to the newest {@link #MAX_ENTRIES} is a PARTIAL list, and
     * presenting a partial list as the complete premise is the fabrication this
     * class exists to prevent. {@link #renderForInjection} already emits a
     * marker when its own length cap drops entries; this covers the other way
     * entries go missing.
     */
    private final int droppedOnLoad;

    private AmooMemory(List<Entry> entries, int droppedOnLoad) {
        this.entries = entries == null ? new ArrayList<Entry>() : entries;
        this.droppedOnLoad = Math.max(0, droppedOnLoad);
    }

    public List<Entry> entries() {
        return entries;
    }

    public int size() {
        return entries.size();
    }

    /** How many entries the source file had beyond the cap. 0 when it fit. */
    public int droppedOnLoad() {
        return droppedOnLoad;
    }

    // ── mutation ────────────────────────────────────────────────────────────

    /**
     * Add or replace one entry.
     *
     * The merge rule is the whole point: an incoming UNVERIFIED entry can never
     * demote an existing VERIFIED one. Losing a verified fact because somebody
     * restated it casually would be the exact silent-corruption this guards.
     */
    public AmooMemory with(String id, String text, Confidence confidence, String provenance) {
        List<Entry> next = new ArrayList<Entry>();
        boolean handled = false;
        for (Entry e : entries) {
            if (e.id.equals(id)) {
                // The id is accounted for either way — marking it only on the
                // replace branch made the "keep the stronger one" path fall
                // through to the append below and duplicate the entry.
                handled = true;
                if (e.confidence == Confidence.VERIFIED && confidence != Confidence.VERIFIED) {
                    next.add(e); // keep the stronger one
                } else {
                    next.add(new Entry(id, text, confidence, provenance));
                }
            } else {
                next.add(e);
            }
        }
        if (!handled) {
            next.add(new Entry(id, text, confidence, provenance));
        }
        // Newest last, but never grow without bound.
        while (next.size() > MAX_ENTRIES) {
            next.remove(0);
        }
        return new AmooMemory(next, 0);
    }

    // ── rendering ───────────────────────────────────────────────────────────

    /**
     * Render the memory as the text to put in front of Amoo.
     *
     * Verified and unverified entries are labelled differently and unverified
     * ones are explicitly marked as such, so Amoo cannot read a recollection as
     * a measurement. Returns "" when there is nothing usable to say — an empty
     * injection is better than a header with no content under it.
     *
     * A truncation marker is emitted when the cap drops entries. Why that is not
     * optional: the injection is prefixed, verbatim, with
     * 「请以此为前提，不要重新测量」. Telling a model to treat a PARTIAL list as
     * the complete premise — and not to re-measure it — is the fabrication this
     * whole loop exists to prevent, arriving through the one channel that is
     * supposed to be the trustworthy one. A fact verified at 14:00 and dropped
     * by the cap at 14:06 must not be indistinguishable from one that is present.
     */
    public String renderForInjection(int maxChars) {
        int cap = maxChars <= 0 ? 1200 : maxChars;
        StringBuilder sb = new StringBuilder();
        int used = 0;
        int emitted = 0;
        int dropped = 0;
        for (Entry e : entries) {
            if (!e.isUsable()) {
                continue;
            }
            String line = (e.confidence == Confidence.VERIFIED ? "· " : "· [未证实] ")
                    + e.text;
            if (used + line.length() + 1 > cap) {
                // Do not break silently. Count what is being left behind so the
                // marker below can name it.
                dropped++;
                continue;
            }
            if (sb.length() > 0) {
                sb.append('\n');
            }
            sb.append(line);
            used += line.length() + 1;
            emitted++;
        }
        if (dropped > 0) {
            sb.append("\n· …另有 ").append(dropped)
                    .append(" 条记忆因长度上限未注入（本条列表不完整，"
                            + "需要时应当重新测量，不要当作全部前提）");
        }
        // The other way entries go missing: the file itself was over the cap
        // when it was read. Reported here rather than swallowed at parse time
        // because this is the text Amoo actually sees — a truncation that only
        // exists in a log is a truncation Amoo cannot account for.
        if (droppedOnLoad > 0) {
            if (sb.length() > 0) {
                sb.append('\n');
            }
            sb.append("· …另有 ").append(droppedOnLoad)
                    .append(" 条更早的记忆因数量上限未加载（同上，本条列表不完整）");
        }
        return emitted == 0 && dropped == 0 && droppedOnLoad == 0 ? "" : sb.toString();
    }

    /** Serialize. Never throws; on failure returns a minimal valid document. */
    public String toJson() {
        try {
            JSONArray arr = new JSONArray();
            for (Entry e : entries) {
                if (!e.isUsable()) {
                    continue;
                }
                arr.put(new JSONObject()
                        .put("id", e.id)
                        .put("text", e.text)
                        .put("confidence", e.confidence == Confidence.VERIFIED ? "verified" : "unverified")
                        .put("provenance", e.provenance));
            }
            return new JSONObject().put("version", VERSION).put("entries", arr).toString();
        } catch (Throwable bad) {
            return "{\"version\":" + VERSION + ",\"entries\":[]}";
        }
    }

    /** Count of verified entries — the only ones that may be stated as fact. */
    public int verifiedCount() {
        int n = 0;
        for (Entry e : entries) {
            if (e.confidence == Confidence.VERIFIED) {
                n++;
            }
        }
        return n;
    }

    /** Count of entries that are explicitly marked unverified. */
    public int unverifiedCount() {
        return size() - verifiedCount();
    }

    /**
     * Fold a map of id → text into this memory, all as UNVERIFIED.
     *
     * Convenience for the "somebody said it" path. Order is preserved so the
     * rendered injection is stable across runs.
     */
    public AmooMemory withAllUnverified(LinkedHashMap<String, String> idToText) {
        AmooMemory next = this;
        for (java.util.Map.Entry<String, String> e : idToText.entrySet()) {
            next = next.with(e.getKey(), e.getValue(), Confidence.UNVERIFIED, "amoo-said");
        }
        return next;
    }
}
