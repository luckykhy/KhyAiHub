// khy-canary: Khy-20261101-039-42F2XM3W
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.LinkedHashMap;

/**
 * AmooMemoryTest — the shared-memory model.
 *
 * The property that matters most is the last one: an unverified restatement must
 * never demote a verified fact. Everything else is bookkeeping around it.
 */
public class AmooMemoryTest {

    @Test
    public void roundTripPreservesEntriesAndConfidence() {
        AmooMemory m = AmooMemory.empty()
                .with("a", "hello.py 是 11 字节", AmooMemory.Confidence.VERIFIED, "verified:write")
                .with("b", "Amoo 说它有 Node 22", AmooMemory.Confidence.UNVERIFIED, "amoo-said");
        AmooMemory back = AmooMemory.fromJson(m.toJson());
        assertEquals(2, back.size());
        assertEquals(1, back.verifiedCount());
        assertEquals(1, back.unverifiedCount());
        assertEquals("hello.py 是 11 字节", back.entries().get(0).text);
        assertEquals(AmooMemory.Confidence.VERIFIED, back.entries().get(0).confidence);
        assertEquals(AmooMemory.Confidence.UNVERIFIED, back.entries().get(1).confidence);
    }

    @Test
    public void malformedDocumentsNeverThrowAndYieldSomethingUsable() {
        String[] junk = {null, "", "   ", "not json", "{", "[]", "{\"entries\":null}",
                "{\"version\":99,\"entries\":[{\"id\":\"a\",\"text\":\"b\"}]}",
                "{\"entries\":[null,5,\"x\",{\"id\":\"\",\"text\":\"y\"},{\"id\":\"a\"}]}"};
        for (String in : junk) {
            AmooMemory m = AmooMemory.fromJson(in);
            // Must not throw, and toJson must still produce a parseable document.
            AmooMemory again = AmooMemory.fromJson(m.toJson());
            assertEquals("input=" + in, m.size(), again.size());
        }
        // A wrong version is tolerated rather than rejected wholesale.
        assertEquals(1, AmooMemory.fromJson(
                "{\"version\":99,\"entries\":[{\"id\":\"a\",\"text\":\"b\"}]}").size());
    }

    /**
     * THE property: an unverified restatement must not demote a verified fact.
     *
     * Losing a measurement because somebody mentioned it casually is exactly the
     * silent corruption the confidence field exists to prevent.
     */
    @Test
    public void unverifiedNeverDemotesVerified() {
        AmooMemory m = AmooMemory.empty()
                .with("f", "文件是 11 字节", AmooMemory.Confidence.VERIFIED, "verified:write");
        AmooMemory after = m.with("f", "文件大概是 12 字节吧", AmooMemory.Confidence.UNVERIFIED, "amoo-said");
        assertEquals(1, after.size());
        assertEquals(AmooMemory.Confidence.VERIFIED, after.entries().get(0).confidence);
        assertEquals("文件是 11 字节", after.entries().get(0).text);
        // A verified restatement DOES replace.
        AmooMemory stronger = after.with("f", "文件是 12 字节", AmooMemory.Confidence.VERIFIED, "verified:read");
        assertEquals("文件是 12 字节", stronger.entries().get(0).text);
    }

    @Test
    public void sameIdReplacesRatherThanDuplicates() {
        AmooMemory m = AmooMemory.empty()
                .with("k", "v1", AmooMemory.Confidence.UNVERIFIED, "amoo-said")
                .with("k", "v2", AmooMemory.Confidence.UNVERIFIED, "amoo-said");
        assertEquals(1, m.size());
        assertEquals("v2", m.entries().get(0).text);
    }

    @Test
    public void injectionLabelsTheTwoConfidencesDifferently() {
        AmooMemory m = AmooMemory.empty()
                .with("v", "已测量：11 字节", AmooMemory.Confidence.VERIFIED, "verified:write")
                .with("u", "听说还有个备份", AmooMemory.Confidence.UNVERIFIED, "amoo-said");
        String out = m.renderForInjection(1200);
        assertTrue(out.contains("已测量：11 字节"));
        assertTrue(out.contains("听说还有个备份"));
        // The unverified one is explicitly marked so it cannot read as a fact.
        assertTrue(out.contains("[未证实]"));
        assertTrue(out.indexOf("[未证实]") > out.indexOf("已测量"));
    }

    @Test
    public void emptyMemoryRendersNothingNotJustAHeader() {
        assertEquals("", AmooMemory.empty().renderForInjection(1200));
        // Entries with no text are not rendered either.
        AmooMemory m = AmooMemory.empty().with("a", "", AmooMemory.Confidence.VERIFIED, "x");
        assertEquals("", m.renderForInjection(1200));
    }

    @Test
    public void injectionRespectsTheCharacterCap() {
        AmooMemory m = AmooMemory.empty();
        for (int i = 0; i < 20; i++) {
            m = m.with("k" + i, "第 " + i + " 条很长很长很长的事实内容", AmooMemory.Confidence.VERIFIED, "x");
        }
        String out = m.renderForInjection(100);
        // The cap bounds the MEMORY CONTENT, not the whole string.
        //
        // The truncation marker is allowed past the cap on purpose: a marker
        // that gets cut away is the same silent truncation the marker exists to
        // prevent. What must hold is that the content itself stays inside the
        // budget, and that the marker is present and names the drop count.
        int markerAt = out.indexOf("…另有 ");
        assertTrue("被截断时必须出现标记", markerAt >= 0);
        String content = markerAt < 0 ? out : out.substring(0, markerAt);
        assertTrue("记忆内容超出 cap：" + content.length(), content.length() <= 100);
        assertTrue("标记必须说明丢了多少条", out.contains("条记忆因长度上限未注入"));
        // And it drops whole entries rather than cutting one in half.
        assertFalse(content.endsWith("第"));
    }

    @Test
    public void theMarkerIsPresentEvenWhenOnlyOneEntryFits() {
        // The single most important case: a cap that fits exactly one entry used
        // to produce that one entry and nothing else — which reads as "here is
        // everything I know". It is not.
        //
        // cap is 1205 on purpose: entry "a" renders to 1202 chars (1200 + the
        // "· " prefix), so it fits with 3 chars to spare, and entry "b" then
        // does not. At 1300 both would fit and dropped would be 0; at 1200
        // neither fits. Verified by arithmetic, not by guessing.
        AmooMemory m = AmooMemory.empty()
                .with("a", "一条非常长的事实内容".repeat(120), AmooMemory.Confidence.VERIFIED, "x")
                .with("b", "第二条", AmooMemory.Confidence.VERIFIED, "x");
        String out = m.renderForInjection(1205);
        assertTrue("第一条必须注入", out.contains("一条非常长的事实内容"));
        assertTrue("丢掉的那条必须被说出来", out.contains("另有 1 条"));
        assertTrue("标记必须说清单不完整", out.contains("本条列表不完整"));
    }

    @Test
    public void nothingIsDroppedMeansNoMarker() {
        // A marker on a complete list would be a lie in the other direction.
        AmooMemory m = AmooMemory.empty()
                .with("a", "短事实", AmooMemory.Confidence.VERIFIED, "x");
        String out = m.renderForInjection(1200);
        assertFalse(out.contains("未注入"));
        assertEquals("· 短事实", out);
    }

    @Test
    public void entryCountIsBounded() {
        AmooMemory m = AmooMemory.empty();
        for (int i = 0; i < 200; i++) {
            m = m.with("k" + i, "v" + i, AmooMemory.Confidence.UNVERIFIED, "amoo-said");
        }
        assertTrue("unbounded growth: " + m.size(), m.size() <= 60);
        // Newest survive.
        assertEquals("v199", m.entries().get(m.size() - 1).text);
    }

    @Test
    public void withAllUnverifiedKeepsOrderAndMarksEverything() {
        LinkedHashMap<String, String> src = new LinkedHashMap<String, String>();
        src.put("a", "第一条");
        src.put("b", "第二条");
        AmooMemory m = AmooMemory.empty().withAllUnverified(src);
        assertEquals(2, m.size());
        assertEquals(0, m.verifiedCount());
        assertEquals("第一条", m.entries().get(0).text);
        assertEquals("amoo-said", m.entries().get(0).provenance);
    }

    @Test
    public void toJsonIsAlwaysParseableEvenAfterCorruption() {
        AmooMemory m = AmooMemory.fromJson("garbage");
        String json = m.toJson();
        assertTrue(json.startsWith("{"));
        assertEquals(0, AmooMemory.fromJson(json).size());
    }

    // ── the cap asymmetry ──
    //
    // `with` evicts from the front (newest last, bounded). `fromJson` used to
    // read from the front too — which meant a document over the cap was loaded
    // as its OLDEST entries and saved as its NEWEST, so everything in the
    // middle disappeared on that round trip. No marker, no log, nothing.
    //
    // These tests pin the two halves that were wrong: which side survives, and
    // whether the loss is reported.

    /** A document of [n] entries, ids "e0".."e{n-1}", newest last. */
    private static String document(int n) {
        StringBuilder sb = new StringBuilder("{\"version\":1,\"entries\":[");
        for (int i = 0; i < n; i++) {
            if (i > 0) sb.append(',');
            sb.append("{\"id\":\"e").append(i).append("\",\"text\":\"fact ")
                    .append(i).append("\",\"confidence\":\"unverified\"}");
        }
        return sb.append("]}").toString();
    }

    @Test
    public void anOverCapDocumentKeepsTheNewestNotTheOldest() {
        // The core fix. 100 entries, cap 60: the survivors must be e40..e99.
        AmooMemory m = AmooMemory.fromJson(document(100));
        assertEquals(60, m.size());
        assertEquals("e40", m.entries().get(0).id);
        assertEquals("e99", m.entries().get(59).id);
    }

    @Test
    public void aRoundTripOverTheCapLosesNothingInTheMiddle() {
        // The failure this fixes, stated as a property: load → save must be
        // idempotent once the cap has been applied. Before the fix, loading a
        // 100-entry document and saving it wrote back e40..e99 — so 40 entries
        // had been destroyed by reading the file.
        AmooMemory loaded = AmooMemory.fromJson(document(100));
        AmooMemory again = AmooMemory.fromJson(loaded.toJson());
        assertEquals(loaded.size(), again.size());
        assertEquals(loaded.entries().get(0).id, again.entries().get(0).id);
        assertEquals(loaded.entries().get(59).id, again.entries().get(59).id);
    }

    @Test
    public void theNumberOfEntriesDroppedOnLoadIsReported() {
        AmooMemory m = AmooMemory.fromJson(document(100));
        assertEquals(40, m.droppedOnLoad());

        // Exactly at the cap is not over it.
        assertEquals(0, AmooMemory.fromJson(document(60)).droppedOnLoad());
        assertEquals(0, AmooMemory.fromJson(document(59)).droppedOnLoad());
    }

    @Test
    public void theLoadTimeDropIsStatedInTheInjectionNotSilentlyDropped() {
        // The injection is prefixed with 「请以此为前提，不要重新测量」. A partial
        // list presented as the complete premise is the fabrication this class
        // exists to prevent — so the trim must be visible in the text Amoo
        // reads, not only in a log it never sees.
        AmooMemory m = AmooMemory.fromJson(document(100));
        String out = m.renderForInjection(1200);
        assertTrue("加载时被裁掉的那 40 条必须在注入里说出来:\n" + out,
                out.contains("另有 40 条更早的记忆因数量上限未加载"));
        assertTrue(out.contains("本条列表不完整"));
    }

    @Test
    public void anInCapDocumentSaysNothingWasDropped() {
        // Only the over-cap case gets a marker. A marker on every render would
        // train Amoo to ignore it.
        AmooMemory m = AmooMemory.fromJson(document(60));
        String out = m.renderForInjection(1200);
        assertFalse(out.contains("数量上限未加载"));
    }

    @Test
    public void malformedEntriesDoNotInflateTheDropCount() {
        // 60 good + 5 broken = 65 parsed-worthy entries, so the cap drops 5 —
        // not 10. Counting the malformed ones as "dropped by the cap" would
        // misreport what happened, and the number is the only signal the user
        // has that the file is partly broken.
        StringBuilder sb = new StringBuilder("{\"version\":1,\"entries\":[");
        for (int i = 0; i < 60; i++) {
            if (i > 0) sb.append(',');
            sb.append("{\"id\":\"e").append(i).append("\",\"text\":\"fact ")
                    .append(i).append("\"}");
        }
        for (int i = 0; i < 5; i++) {
            sb.append(",{\"id\":\"\",\"text\":\"\"}");
        }
        sb.append("]}");
        AmooMemory m = AmooMemory.fromJson(sb.toString());
        assertEquals(60, m.size());
        assertEquals(0, m.droppedOnLoad());
    }

    @Test
    public void emptyAndNullInputsReportNothingDropped() {
        assertEquals(0, AmooMemory.fromJson(null).droppedOnLoad());
        assertEquals(0, AmooMemory.fromJson("").droppedOnLoad());
        assertEquals(0, AmooMemory.empty().droppedOnLoad());
    }
}
