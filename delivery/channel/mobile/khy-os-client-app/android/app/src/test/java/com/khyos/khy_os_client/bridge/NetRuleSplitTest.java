package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/**
 * NetRuleSplitTest — S3：net_rule 拆回四个独立工具（T11），并钉住工具面总数。
 *
 * 判定映射（任务书原文不在仓内/数据家，按 ask 字面定义；见证据目录 acceptance）：
 *   T11  net_rule_set/list/delete/clear 四个**独立工具**存在；合并名 net_rule 消失；
 *        net_capture 五个保持不变；replay_safe 判据变成「按工具名」（net_rule_list）。
 *   T12  info.capture 三态 off|self|self+tls 且默认 off —— 这条**已经实现**：
 *        NetCaptureCore.captureMode()（NetCaptureCore.java:365-368）与
 *        NetCaptureCoreTest.captureModeSpeaksTheThreeTiers 早于本批存在，本文件不再
 *        复制一份同义测试；T12 的新增面是「工具面计数」这一条。
 *
 * 关于计数：asks 写「tools 必须 62→65」，那是**当时** NAMES 尚无 elevate 的口径
 * （63 - 1 + 4 在本仓现值下是 66）。`elevate` 由 2026-11-17 提权批次加入 NAMES
 * （Tools.java:422、LoopModes.java:145），删它等于删另一批的能力。本测试钉住
 * 现值 66，并把「62→65 与 63→66 的差 1」记在证据里等任务书方裁决。
 */
public class NetRuleSplitTest {

    private static final List<String> NET_RULE_FOUR = Arrays.asList(
            "net_rule_set", "net_rule_list", "net_rule_delete", "net_rule_clear");
    private static final List<String> NET_CAPTURE_FIVE = Arrays.asList(
            "net_capture_start", "net_capture_stop", "net_capture_status",
            "net_capture_list", "net_capture_export");

    private static List<String> names() {
        return Arrays.asList(Tools.NAMES);
    }

    @Test
    public void fourRuleToolsExistAndMergedNameIsGone() {
        List<String> names = names();
        for (String n : NET_RULE_FOUR) {
            assertTrue("拆分后的 " + n + " 必须在 NAMES 里", names.contains(n));
        }
        assertFalse("合并名 net_rule 必须消失（保留它 = 名册与 dispatch 两处各一份）",
                names.contains("net_rule"));
    }

    @Test
    public void captureFiveAreUntouched() {
        List<String> names = names();
        for (String n : NET_CAPTURE_FIVE) {
            assertTrue("net_capture 的 " + n + " 保持不变", names.contains(n));
        }
    }

    @Test
    public void toolSurfaceCountsMoveByExactlyThree() {
        // 拆分前 63（含 elevate/tools），拆 1 合 4 → 66。+3 与任务书一致；
        // 绝对值差 1 来自 elevate（见类注释），不是拆分本身。
        assertEquals("NAMES 规模：拆分后应为 63 - 1 + 4 = 66", 66, Tools.NAMES.length);
        assertEquals("ROUTING 必须与 NAMES 等长（ToolCatalogTest 也钉这条）",
                Tools.NAMES.length, Tools.ROUTING.length);
    }

    @Test
    public void catalogHasOneLinePerRuleToolAndNoMergedEntry() {
        List<String> catalogNames = new ArrayList<>();
        for (String[] row : Tools.CATALOG) {
            if (row[0].equals("抓包改写")) catalogNames.add(row[1]);
        }
        for (String n : NET_RULE_FOUR) {
            assertTrue("目录缺 " + n + "（组名仍是 抓包改写）", catalogNames.contains(n));
        }
        assertFalse("目录不能再有合并名 net_rule", catalogNames.contains("net_rule"));
    }

    @Test
    public void routingHasFourEntriesWithAllFourSections() {
        for (String n : NET_RULE_FOUR) {
            String text = Tools.routingFor(n);
            assertNotNull("ROUTING 缺 " + n, text);
            assertTrue(n + " 缺 # description", text.contains("# description"));
            assertTrue(n + " 缺 # positive_samples", text.contains("# positive_samples"));
            assertTrue(n + " 缺 # negative_samples", text.contains("# negative_samples"));
            assertTrue(n + " 缺 # return", text.contains("# return"));
        }
        assertNull("ROUTING 不应再有 net_rule", Tools.routingFor("net_rule"));
    }

    @Test
    public void toolSchemaDeclaresFourAndDropsMergedEntry() {
        // schema：list/clear 无必填；delete 必填 id；set 无必填
        //（host 的必填性归 setRule 的 bad_host，两个错误码指向不同修法）。
        ToolSchema.Spec list = ToolSchema.get("net_rule_list");
        assertNotNull("ToolSchema 缺 net_rule_list", list);
        assertEquals("net_rule_list 不应有必填参数", 0, list.required.length);
        ToolSchema.Spec clear = ToolSchema.get("net_rule_clear");
        assertNotNull("ToolSchema 缺 net_rule_clear", clear);
        assertEquals("net_rule_clear 不应有必填参数", 0, clear.required.length);
        ToolSchema.Spec del = ToolSchema.get("net_rule_delete");
        assertNotNull("ToolSchema 缺 net_rule_delete", del);
        assertEquals("net_rule_delete 必填必须是 id", "id", del.required[0][0]);
        ToolSchema.Spec set = ToolSchema.get("net_rule_set");
        assertNotNull("ToolSchema 缺 net_rule_set", set);
        assertEquals("net_rule_set 不应有必填参数", 0, set.required.length);
        assertTrue("net_rule_set 的可选参数里应有 host", set.knownArgs().contains("host"));
        assertFalse("net_rule_set 的可选参数里不应再有 op（由工具名决定）",
                set.knownArgs().contains("op"));
        assertNull("ToolSchema 不应再有 net_rule", ToolSchema.get("net_rule"));
        for (String n : NET_RULE_FOUR) {
            assertEquals("抓包族仍在 App 层", ToolSchema.LEVEL_APP, ToolSchema.requiredLevel(n));
        }
    }

    @Test
    public void selfDescExcludesAllFourNotTheMergedName() {
        for (String n : NET_RULE_FOUR) {
            assertTrue("SelfDesc 排除集缺 " + n, SelfDesc.excludedFromDescription().contains(n));
        }
        assertFalse("SelfDesc 排除集不应再有 net_rule",
                SelfDesc.excludedFromDescription().contains("net_rule"));
    }
}
