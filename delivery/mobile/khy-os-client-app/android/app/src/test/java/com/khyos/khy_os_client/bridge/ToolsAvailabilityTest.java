package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Tests for the availability view — the second face of the tool surface.
 *
 * WHY TWO FACES AT ALL. {@link Tools#NAMES} / {@link #Tools.CATALOG} /
 * {@link #Tools.ROUTING} answer "what does this bridge have" and stay complete:
 * a filtered directory would red {@code AmooSelfDescTest} (three cases) and
 * {@code ToolCatalogTest} (two count assertions). The status face — HTTP
 * {@code /status}, {@code status.json}, the overlay — answers "what can be
 * called right now", and there the honest answer with Amoo uninstalled is
 * "not the four tools that need it".
 *
 * THE DEFECT THIS CLOSES. Measured 2026-10-26 and recorded at the top of
 * Tools.java: Amoo was told the bridge could not do GUI automation, when it
 * ships eleven UI tools. The opposite failure is just as expensive and had no
 * guard at all: four tools that return {@code not_installed} on every call
 * were advertised as present on every status surface, so a PC filtering its
 * model tool-face by {@code tools: NAMES.length} let four dead tools through.
 *
 * THE 2026-10-30 SPLIT. loop_status / amoo_result / amoo_memory / amoo_stop
 * only touch bridge-local state (AmooLoop's static fields, AmooMemory's
 * in-memory copy), so they left {@link Tools#OPTIONAL_TOOLS} entirely: one
 * third-party app's install state must not decide whether those four exist,
 * and {@code amoo_stop} in particular is the only manual exit when the PC
 * side drops. Amoo absent still withholds {@code amoo_ask}, which keeps the
 * desktop relay group disabled via {@code _relayAvailability} in
 * phoneBridgeClient.js — deliberately conservative, do not loosen that.
 *
 * WHY THE PROBE IS INJECTABLE. The Java unit tests here run on a bare JVM —
 * build.gradle ships junit and org.json only, and nothing in the test tree
 * calls {@code Tools.init}, so {@code ctxRef()} is always null. With a
 * hard-wired probe the case that matters most ("all four withheld") could
 * never be constructed. Same pattern as {@link CapabilitySnapshot}: the render
 * path takes its state as arguments, and only one method touches the device.
 */
public class ToolsAvailabilityTest {

    /** Every optional tool reported unavailable. */
    private static final Tools.OptionalToolProbe NONE =
            new Tools.OptionalToolProbe() {
                public boolean installed(String pkg) {
                    return false;
                }
            };

    /** Every optional tool reported present. */
    private static final Tools.OptionalToolProbe ALL =
            new Tools.OptionalToolProbe() {
                public boolean installed(String pkg) {
                    return true;
                }
            };

    /** Only the StepOS assistant installed; the a豆 helper is not. */
    private static final Tools.OptionalToolProbe ASSISTANT_ONLY =
            new Tools.OptionalToolProbe() {
                public boolean installed(String pkg) {
                    return AmooLoop.AMOO_PKG.equals(pkg);
                }
            };

    private static List<String> asList(String[] names) {
        return Arrays.asList(names);
    }

    private static List<String> optionalNames() {
        List<String> out = new ArrayList<String>();
        for (String[] row : Tools.OPTIONAL_TOOLS) out.add(row[0]);
        return out;
    }

    // ── the withheld case ─────────────────────────────────────────────────

    @Test
    public void withNothingInstalledTheFourOptionalToolsAreWithheld() {
        List<String> avail = asList(Tools.availableNames(NONE));
        for (String t : optionalNames()) {
            assertFalse("探针说没装，" + t + " 却仍报可用", avail.contains(t));
        }
        // 44 = 48 − 4. The generic tools must survive untouched: withholding is
        // about one missing app, not about the bridge being broken.
        assertEquals(Tools.NAMES.length - Tools.OPTIONAL_TOOLS.length, avail.size());
        assertTrue(avail.contains("ping"));
        assertTrue(avail.contains("exec"));
        assertTrue(avail.contains("ui_tap"));
        // 四个桥本地能力整行移出了 OPTIONAL_TOOLS：Amoo 装没装都不该连带死。
        // 这里正向钉住解绑，谁再把它绑回第三方 App 的安装态就红。
        assertTrue(avail.contains("amoo_stop"));
        assertTrue(avail.contains("amoo_result"));
        assertTrue(avail.contains("amoo_memory"));
        assertTrue(avail.contains("loop_status"));
    }

    @Test
    public void everyWithheldEntryCarriesANameAndAReason() throws Exception {
        JSONArray w = Tools.withheld(NONE);
        assertEquals(Tools.OPTIONAL_TOOLS.length, w.length());
        Set<String> seen = new LinkedHashSet<String>();
        for (int i = 0; i < w.length(); i++) {
            JSONObject e = w.getJSONObject(i);
            assertTrue("每条都要有 name", e.has("name"));
            assertTrue("每条都要有 why——「少了一个名字」不告诉任何人该干什么",
                    e.has("why"));
            String why = e.getString("why").trim();
            assertTrue(e.getString("name") + " 的 why 为空", why.length() > 0);
            // The reason must name the app to install, or it is not actionable.
            assertTrue(e.getString("name") + " 的 why 没说缺哪个包: " + why,
                    why.contains("com."));
            seen.add(e.getString("name"));
        }
        assertEquals(optionalNames().size(), seen.size());
    }

    @Test
    public void withheldAndAvailablePartitionNamesExactly() throws Exception {
        // No name may appear on both sides, and none may vanish. A hole here is
        // a tool that is neither advertised nor explained.
        List<String> avail = asList(Tools.availableNames(NONE));
        JSONArray w = Tools.withheld(NONE);
        Set<String> all = new LinkedHashSet<String>(asList(Tools.NAMES));
        Set<String> covered = new LinkedHashSet<String>(avail);
        for (int i = 0; i < w.length(); i++) {
            String n = w.getJSONObject(i).getString("name");
            assertTrue(n + " 同时出现在可用集与被扣下表", covered.add(n));
        }
        assertEquals(all, covered);
    }

    @Test
    public void theAssistantMissingAlsoWithholdsTheLoopGroup() throws Exception {
        // 拆表后循环组（loop_start/loop_stop）与反代（amoo_ask）仍只绑助手 App：
        // 助手在、a豆助手不在时，被扣下的只有 adou_signin 一行，循环组照常可用。
        // 四个桥本地能力已整行移出表外，Amoo 在不在都不归这条断言管。
        JSONArray w = Tools.withheld(ASSISTANT_ONLY);
        assertEquals(1, w.length());
        assertEquals("adou_signin", w.getJSONObject(0).getString("name"));
        assertTrue(asList(Tools.availableNames(ASSISTANT_ONLY)).contains("loop_start"));
    }

    // ── the complete case ─────────────────────────────────────────────────

    @Test
    public void withEverythingInstalledTheViewIsTheWholeCatalog() throws Exception {
        assertEquals(asList(Tools.NAMES), asList(Tools.availableNames(ALL)));
        assertEquals(0, Tools.withheld(ALL).length());
    }

    @Test
    public void theOptionalTableOnlyNamesToolsThatExist() {
        // A row pointing at a tool that is not in NAMES would withhold a name no
        // caller ever sees, and the count would silently disagree with the list.
        for (String[] row : Tools.OPTIONAL_TOOLS) {
            assertEquals("每条两段", 2, row.length);
            assertTrue(row[0] + " 不在 NAMES", asList(Tools.NAMES).contains(row[0]));
            assertTrue(row[0] + " 的包名为空", row[1].trim().length() > 0);
        }
        assertEquals(4, Tools.OPTIONAL_TOOLS.length);
    }

    @Test
    public void noToolIsOptionalTwice() {
        Set<String> seen = new LinkedHashSet<String>();
        for (String[] row : Tools.OPTIONAL_TOOLS) {
            assertTrue(row[0] + " 在 OPTIONAL_TOOLS 里重复", seen.add(row[0]));
        }
    }

    // ── the un-probed default, which is what a bare JVM sees ──────────────

    @Test
    public void withNoContextTheNoArgOverloadDoesNotFilter() throws Exception {
        // ctxRef() is null in every unit test in this project. "Unknown" is not
        // "absent": filtering on unknown would strip 44 working tools from every
        // status surface on a bridge that was never initialised.
        assertEquals(Tools.NAMES.length, Tools.availableNames().length);
        assertEquals(Tools.NAMES.length, Tools.availableCount());
        assertEquals(0, Tools.withheld().length());
        assertEquals(Tools.NAMES.length, Tools.availableNamesCached().length);
    }

    @Test
    public void refreshingWithoutAContextLeavesTheFullSet() {
        // Same contract as above, through the cached path the overlay reads.
        Tools.refreshAvailability();
        assertEquals(Tools.NAMES.length, Tools.availableCount());
        assertEquals(0, Tools.withheldCached().length());
        assertTrue("刷新过一次就必须记下时间，否则排查时看不出数字是不是旧的",
                Tools.availabilityAgeMs() >= 0);
    }

    // ── the catalog face must NOT be filtered ─────────────────────────────

    @Test
    public void theCatalogFaceStillListsEveryOptionalTool() throws Exception {
        // The whole point of the split. If someone "simplifies" by filtering
        // catalogJson too, AmooSelfDescTest goes red (three cases) and
        // ToolCatalogTest goes red (two count assertions) — this pins the intent
        // so the next person does not try it.
        JSONArray groups = Tools.catalogJson();
        Set<String> listed = new LinkedHashSet<String>();
        for (int i = 0; i < groups.length(); i++) {
            JSONArray tools = groups.getJSONObject(i).getJSONArray("tools");
            for (int j = 0; j < tools.length(); j++) {
                listed.add(tools.getJSONObject(j).getString("name"));
            }
        }
        for (String t : optionalNames()) {
            assertTrue("目录面不该过滤 " + t, listed.contains(t));
        }
        assertEquals(Tools.NAMES.length, listed.size());
    }

    @Test
    public void theSelfDescriptionStillNamesEveryTool() {
        // AmooSelfDesc.render() reads Tools.NAMES through SelfDesc.groups(); a
        // filtered description would tell the assistant the tools do not exist.
        // 唯一的例外是 SelfDesc.EXCLUDED_FROM_DESCRIPTION 里那四个凭据投递工具：
        // 它们要人在手机旁确认，云端的助手做不到，所以「助手不知道它们存在」
        // 是设计目的而不是过滤事故。这里同时钉住反向的一面——它们确实没出现。
        String s = AmooSelfDesc.render();
        for (String n : Tools.NAMES) {
            if (SelfDesc.excludedFromDescription().contains(n)) {
                assertFalse("凭据投递工具不该出现在给 Amoo 的自描述里: " + n, s.contains(n));
                continue;
            }
            assertTrue("自描述里没有工具 " + n, s.contains(n));
        }
    }

    // ── amoo_stop, deliberately NOT optional ──────────────────────────────

    @Test
    public void amooStopIsInAllThreeTablesButIsNotOptional() {
        // Three tables, added together or not at all: NAMES (dispatch surface),
        // CATALOG (the compact preamble), ROUTING (the on-demand instructions).
        // Missing one reds ToolCatalogTest's two drift assertions.
        assertTrue(asList(Tools.NAMES).contains("amoo_stop"));
        String what = null;
        for (String[] row : Tools.CATALOG) {
            if (row[1].equals("amoo_stop")) what = row[2];
        }
        assertTrue("CATALOG 里没有 amoo_stop", what != null);
        assertTrue("amoo_stop 的目录描述没说清它做什么: " + what,
                what.contains("中止") && what.contains("单飞锁"));
        assertTrue("ROUTING 里没有 amoo_stop", Tools.routingFor("amoo_stop") != null);
        // 它只碰桥内静态状态（stopAsk + 两个布尔读），不驱动 Amoo，所以整行移出了
        // OPTIONAL_TOOLS：一个第三方 App 的装卸不该一票决定这个人工出口的存续。
        // 这里钉住解绑——谁把它绑回安装态，或从三张表里摘掉它，都会红。
        assertFalse(optionalNames().contains("amoo_stop"));
        assertTrue(asList(Tools.availableNames(NONE)).contains("amoo_stop"));
    }
}
