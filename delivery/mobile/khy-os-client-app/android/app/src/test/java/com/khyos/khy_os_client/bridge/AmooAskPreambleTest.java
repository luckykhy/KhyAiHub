// khy-canary: Khy-20261101-033-2J2M93M7
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * AmooAskPreambleTest — the two-layer preamble of the reverse-proxy ask path.
 *
 * WHY two layers and not one. They answer different questions: the
 * self-description answers "what is khy-os and what can it do", the memory
 * answers "what have we already established". Folding them together would mean
 * the static part gets re-sent with every memory change and the dynamic part
 * loses its confidence labels.
 */
public class AmooAskPreambleTest {

    @Test
    public void preambleAlwaysCarriesTheSelfDescription() {
        // Even with an empty memory — that is the cold start, and it is exactly
        // when Amoo knows the least.
        String p = AmooLoop.buildAskPreamble();
        assertNotNull(p);
        assertTrue(p.contains("khy-os"));
        assertTrue(p.contains("【可用的工具】"));
        assertTrue(p.contains("【怎么下达命令】"));
    }

    @Test
    public void preambleAppendsVerifiedMemoryWhenPresent() {
        AmooLoop.replaceMemory(AmooLoop.memory().with("k1", "本机 adb 序列以 mdns 为准",
                com.khyos.khy_os_client.bridge.AmooMemory.Confidence.VERIFIED, "test"));
        String p = AmooLoop.buildAskPreamble();
        assertTrue("已验证事实必须进 preamble", p.contains("本机 adb 序列以 mdns 为准"));
        assertTrue("必须带「已核实」这句导语", p.contains("已经核实过的事实"));
        // And the self-description is still there — layer 1 is unconditional.
        assertTrue(p.contains("【可用的工具】"));
        // Order matters: identity before facts.
        assertTrue(p.indexOf("【可用的工具】") < p.indexOf("已经核实过的事实"));
    }

    @Test
    public void preambleIsStableForTheSameMemory() {
        AmooLoop.replaceMemory(AmooLoop.memory().with("k2", "端口是 8896",
                com.khyos.khy_os_client.bridge.AmooMemory.Confidence.VERIFIED, "test"));
        assertEquals(AmooLoop.buildAskPreamble(), AmooLoop.buildAskPreamble());
    }

    @Test
    public void preambleSurvivesAnEmptyAndAGarbageMemory() {
        AmooLoop.replaceMemory(AmooMemory.empty());
        assertTrue(AmooLoop.buildAskPreamble().contains("【可用的工具】"));
        AmooLoop.replaceMemory(AmooMemory.fromJson("{ not json at all"));
        assertTrue(AmooLoop.buildAskPreamble().contains("【可用的工具】"));
        AmooLoop.replaceMemory(AmooMemory.fromJson(null));
        assertTrue(AmooLoop.buildAskPreamble().contains("【可用的工具】"));
    }

    @Test
    public void foregroundPackageNeverThrowsWhenTheServiceIsAbsent() {
        // In a unit test there is no accessibility service, so this must degrade
        // to "" rather than blowing up — and "" must read as "unknown", which
        // the caller treats as "proceed", not as "not Amoo".
        String fg = AmooLoop.foregroundPackage();
        assertNotNull(fg);
        // Either empty (no service) or a real package name; never an exception.
        assertTrue(fg.length() == 0 || fg.indexOf(' ') < 0);
    }

    @Test
    public void askResultCarriesProgressAndTiming() {
        // The overlay shows live progress; askResult is what the Dart side polls,
        // so it has to expose the same stage string the loop uses.
        JSONObject r = AmooLoop.askResult();
        assertNotNull(r);
        assertTrue(r.has("state"));
        assertTrue(r.has("ms"));
    }

    @Test
    public void anEmptyPromptIsRefusedWithoutTouchingThePreamble() {
        // Regression: the old code returned null for an empty prompt before any
        // pre-check. Keep that order — an empty prompt is a caller bug, and
        // reporting it as amoo_not_foreground would send the caller hunting in
        // the wrong place entirely.
        assertEquals(null, AmooLoop.ask("   ", 60000L));
        assertEquals(null, AmooLoop.ask(null, 60000L));
        assertFalse(AmooLoop.askRunning());
    }
}
