// khy-canary: Khy-20261101-053-W7R3AEQK
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Tests for the capability catalog and the zip/unzip gap it closes.
 *
 * THE DEFECT, found on the real device on 2026-10-26: Amoo was asked what it could
 * do to the phone and answered "cannot do GUI auto-clicking... no root, cannot get
 * outside the permission sandbox". Both statements contradict the code — the bridge
 * ships eleven UI tools (ui_tap/ui_click/ui_swipe/ui_longpress/ui_type/ui_back/
 * ui_home/ui_recents/ui_dump/shot/shot_b64) and two elevation tiers (sidecar uid
 * 2000, Shizuku, the latter startable from the phone's own wireless debugging with
 * no PC and no root).
 *
 * The root cause was not a missing capability but an invisible one: {@code info}
 * reports device, UI state, elevation state and budget, but never the tool list;
 * HTTP {@code /status} reports only {@code tools: NAMES.length}. A caller therefore
 * knows there are 39 tools without knowing what any of them do, and has to guess —
 * and a guess about one's own abilities is biased low. Nobody claims a skill they
 * never used.
 *
 * These tests pin the catalog to {@code dispatch}'s real surface in both
 * directions, so the directory can neither promise a tool that does not exist nor
 * hide one that does.
 */
public class ToolCatalogTest {

    @Test
    public void catalogMentionsEveryDispatchedTool() {
        // 目录漏一个 = 那个工具事实上不存在于调用方的认知里。
        Set<String> missing = Tools.undocumentedTools();
        assertTrue("NAMES 里这些工具目录没提到: " + missing, missing.isEmpty());
    }

    @Test
    public void catalogPromisesNothingThatDoesNotExist() {
        // 更糟的方向：目录说有、dispatch 没有 → 用户照着调，得到 not found。
        Set<String> phantom = Tools.catalogDrift();
        assertTrue("目录里这些工具不在 NAMES: " + phantom, phantom.isEmpty());
    }

    @Test
    public void everyEntryHasAOneLineDescription() {
        // 光有名字不够：ui_longpress 对不知道它存在的人和对不知道它干什么的人
        // 是一样无用的。
        //
        // 判据刻意**不设字数下限**：第一版写了 length() >= 4，结果把「复制」
        // 「滑动」「长按」全判红——而这些描述简短但说得清，该修的是判据不是数据。
        // 真正能区分「有信息」和「没信息」的是另外两条：非空，且不能只是把
        // 工具名翻译一遍（"cp: cp" 这种等于没写）。
        for (String[] row : Tools.CATALOG) {
            assertEquals("每组三段", 3, row.length);
            assertTrue("组名不能空: " + row[1], !row[0].trim().isEmpty());
            assertTrue("工具名不能空", !row[1].trim().isEmpty());
            String what = row[2].trim();
            assertTrue(row[1] + " 描述为空", what.length() >= 2);
            assertTrue(row[1] + " 的描述只是工具名本身，没有信息量: " + what,
                    !what.equalsIgnoreCase(row[1].replace('_', ' ')));
        }
    }

    @Test
    public void theGuiGroupIsPresentAndComplete() {
        // 直接钉住 Amoo 判错的那一组。少一个，就等于这次修的那个洞又开一半。
        Set<String> gui = new java.util.LinkedHashSet<>();
        for (String[] row : Tools.CATALOG) {
            if (row[0].equals("界面自动化")) gui.add(row[1]);
        }
        for (String t : new String[]{"ui_dump", "ui_tap", "ui_click", "ui_swipe",
                "ui_longpress", "ui_type", "ui_back", "ui_home", "ui_recents",
                "shot", "shot_b64"}) {
            assertTrue("界面自动化组缺 " + t, gui.contains(t));
        }
        assertEquals(11, gui.size());
    }

    @Test
    public void zipAndUnzipAreAdvertised() {
        // Amoo 自报「zip、unzip 没装」而直接放弃的那两个。
        Set<String> all = new java.util.LinkedHashSet<>();
        for (String[] row : Tools.CATALOG) all.add(row[1]);
        assertTrue(all.contains("zip"));
        assertTrue(all.contains("unzip"));
    }

    @Test
    public void theRmEntryStatesTheRecursiveDefault() {
        // rm 默认 recursive:false 是最容易误伤的一步，目录里必须写清，
        // 否则调用方按「删目录」的直觉调一次就抹掉整棵树。
        for (String[] row : Tools.CATALOG) {
            if (row[1].equals("rm")) {
                assertTrue(row[2].contains("recursive"));
                return;
            }
        }
        throw new AssertionError("目录里没有 rm");
    }

    @Test
    public void catalogJsonGroupsAndCountsMatch() throws Exception {
        JSONArray groups = Tools.catalogJson();
        assertEquals(Tools.NAMES.length, countTools(groups));
        // 每组都要有组名，且工具数 > 0——空组在界面上是一个空白标题。
        for (int i = 0; i < groups.length(); i++) {
            JSONObject g = groups.getJSONObject(i);
            assertTrue("组名不能空", g.getString("group").trim().length() > 0);
            assertTrue(g.getString("group") + " 是空组",
                    g.getJSONArray("tools").length() > 0);
        }
    }

    @Test
    public void catalogJsonEntriesCarryNameAndWhat() throws Exception {
        JSONArray groups = Tools.catalogJson();
        JSONObject first = groups.getJSONObject(0).getJSONArray("tools").getJSONObject(0);
        assertTrue(first.has("name"));
        assertTrue(first.has("what"));
        assertTrue(first.getString("what").length() > 0);
    }

    // ── 富路由指令（ROUTING） ────────────────────────────────────────────────
    //
    // WHY A SECOND TABLE INSTEAD OF EXPANDING CATALOG. CATALOG is injected into
    // every assistant turn, and that preamble is abbreviated to 1500 characters
    // (SelfDesc.java:30). Measured 2026-10-28: the compact catalog costs 1227 of
    // those 1500 bytes. Expanding all 43 entries into the routing format would
    // push it past several thousand and the abbreviation would cut the list in
    // half — a truncated directory is worse than a short accurate one.
    //
    // So ROUTING is delivered on demand, through the `tools` call, whose output is
    // not budget-capped. These tests pin that split rather than trusting it.

    @Test
    public void routingMentionsOnlyToolsThatExist() {
        // 与 catalogDrift 同向：ROUTING 里出现 NAMES 没有的工具 = 一段指令指向不存在的能力。
        assertTrue("ROUTING 里这些工具不在 NAMES: " + Tools.routingDrift(),
                Tools.routingDrift().isEmpty());
    }

    @Test
    public void everyRoutingEntryCarriesTheFourSections() {
        // 少一段，这段指令就退化成散文——而它存在的理由正是那几段各自回答一个问题：
        // 干什么 / 什么时候找我 / 什么时候别找我 / 出错会怎样。
        for (String[] row : Tools.ROUTING) {
            assertEquals("每条两段", 2, row.length);
            String tool = row[0];
            String text = row[1];
            assertTrue(tool + " 缺 # description", text.contains("# description"));
            assertTrue(tool + " 缺 # positive_samples", text.contains("# positive_samples"));
            assertTrue(tool + " 缺 # negative_samples", text.contains("# negative_samples"));
            assertTrue(tool + " 缺 # return", text.contains("# return"));
        }
    }

    @Test
    public void routingCoversTheGroupThatWasMeasuredWrong() {
        // 2026-10-26 实测：Amoo 自报「做不了 GUI 自动点击」。那一组 11 个工具
        // 必须每条都有富指令——少一条，那个洞就还开着一半。
        for (String t : new String[]{"ui_dump", "ui_tap", "ui_click", "ui_swipe",
                "ui_longpress", "ui_type", "ui_back", "ui_home", "ui_recents",
                "shot", "shot_b64"}) {
            assertTrue("界面自动化组缺 " + t + " 的富路由指令", Tools.routingFor(t) != null);
        }
    }

    @Test
    public void routingForReturnsNullForAnythingUnknown() {
        assertNull(Tools.routingFor("nope"));
        assertNull(Tools.routingFor(null));
        assertNull(Tools.routingFor(""));
    }

    @Test
    public void catalogJsonAttachesRoutingToEveryTool() throws Exception {
        // 2026-10-28：从「只有部分工具有富指令」改成「全都有」。
        //
        // 为什么改：第一版只给 18 个工具写了 ROUTING，理由是按需输出会太大。
        // 那个理由是错的——按需输出不受前言 1500 字预算限制（受限制的是 CATALOG，
        // 那条单独由 theCompactCatalogStillFitsThePreambleBudget 钉着）。而「哪个
        // 工具值得写、哪个不值得」是范围判断，不该由实现方替用户做。
        //
        // 现在方向反过来：没有富指令才是异常。少一个，那个工具在模型眼里就只剩
        // 目录里那一行——而那一行回答不了「什么时候别用我、用错会怎样」。
        JSONArray groups = Tools.catalogJson();
        int withRouting = 0;
        java.util.List<String> missing = new java.util.ArrayList<String>();
        for (int i = 0; i < groups.length(); i++) {
            JSONArray tools = groups.getJSONObject(i).getJSONArray("tools");
            for (int j = 0; j < tools.length(); j++) {
                JSONObject t = tools.getJSONObject(j);
                boolean has = t.has("routing");
                assertEquals(t.getString("name") + " 的 routing 与该工具的 ROUTING 表不一致",
                        Tools.routingFor(t.getString("name")) != null, has);
                if (has) {
                    withRouting++;
                    assertEquals(Tools.routingFor(t.getString("name")), t.getString("routing"));
                } else {
                    missing.add(t.getString("name"));
                }
            }
        }
        assertEquals(Tools.ROUTING.length, withRouting);
        assertEquals(Tools.NAMES.length, withRouting);
        assertTrue("这些工具没有富路由指令: " + missing, missing.isEmpty());
    }


    @Test
    public void theCompactCatalogStillFitsThePreambleBudget() {
        // 这条是**防复发**的锁：CATALOG 是喂进每轮前言的，而前言被缩写到 1500 字
        // （SelfDesc.java:30）。实测 2026-10-28 改完之后是 1227/1500。
        //
        // 为什么必须有机测：把某条一句话描述「顺手写详细点」是人的本能，而后果
        // （前言被截断、模型看到半份目录）要等到下一次对话才显现，且看起来像
        // 模型变笨了而不是目录变长了。没有这条测试，同样的膨胀会再发生一次。
        //
        // 阈值取 1500 而不是某个更漂亮的数：它就是 SelfDesc 真实的缩写上限，
        // 写别的数等于另立一套会漂的真源。
        int bytes = 0;
        for (String[] row : Tools.CATALOG) {
            bytes += row[1].length() + row[2].length() + 10; // 组名/标点的粗估
        }
        assertTrue("紧凑目录已到 " + bytes + " 字节，超过前言 1500 字预算——"
                + "该把详细内容挪到 ROUTING（按需取），不要继续撑 CATALOG",
                bytes < 1500);
    }

    @Test
    public void amooStopIsAdvertisedInAllThreeTables() {
        // 单飞的人工出口。桥侧此前没有任何工具能调到 AmooLoop.stopAsk()——唯一入口是
        // Flutter 专有通道，PC/Agent 侧一次掉线就永久堵死，只能白等 420s~1800s。
        //
        // 三表必须同批加：NAMES 是 dispatch 的真面目，CATALOG 进每轮前言，ROUTING 是
        // 按需取的富指令。上面两条 drift 断言（catalogMentionsEveryDispatchedTool /
        // catalogPromisesNothingThatDoesNotExist）已经能从两边夹住漏表，这里再点名钉
        // 一次，是为了让「少一张表」有一个说得出名字的失败，而不是一句泛泛的集合差。
        Set<String> names = new java.util.LinkedHashSet<String>(
                java.util.Arrays.asList(Tools.NAMES));
        assertTrue("NAMES 里没有 amoo_stop", names.contains("amoo_stop"));
        boolean inCatalog = false;
        for (String[] row : Tools.CATALOG) {
            if (row[1].equals("amoo_stop")) inCatalog = true;
        }
        assertTrue("CATALOG 里没有 amoo_stop", inCatalog);
        assertTrue("ROUTING 里没有 amoo_stop", Tools.routingFor("amoo_stop") != null);
    }

    private static int countTools(JSONArray groups) throws Exception {
        int n = 0;
        for (int i = 0; i < groups.length(); i++) {
            n += groups.getJSONObject(i).getJSONArray("tools").length();
        }
        return n;
    }
}
