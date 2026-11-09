// khy-canary: Khy-20261101-045-VDFH64QH
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * CapabilitySnapshotTest — the snapshot must turn into words that tell the
 * truth, in both directions.
 *
 * WHY TWO DIRECTIONS. The capability paragraph is the reason this refactor
 * exists: before it, the description listed 42 tools and said nothing about
 * which of them would work, so an assistant on a phone with the accessibility
 * service off either claimed it could tap the screen or refused a request it
 * could have met another way. Both are guesses, and the state is one field read
 * away.
 *
 * The obvious test is the degraded case, and on its own it is the one that
 * matters least: a renderer that always says "everything is broken" passes it.
 * So the full-capability case is pinned too — the text must NOT degrade when
 * nothing is wrong. A description that only knows how to say bad news trains
 * the assistant to ignore it.
 *
 * These run on a bare JVM: every state is hand-built, no Context is touched.
 */
public class CapabilitySnapshotTest {

    /** Everything unavailable — the state right after a reboot with no PC. */
    private static CapabilitySnapshot degraded() {
        return new CapabilitySnapshot(
                false, "无障碍服务未连接", "去系统设置开启",
                false, "PING 未应答",
                false, "未安装 Shizuku",
                "未提权。两条路，选一条：① 不需要电脑——装 Shizuku；② 需要电脑——重跑 adb 提权命令。",
                1024 * 1024, 8 * 1024 * 1024, false,
                "PZ261A", "16", 36);
    }

    /** Everything up — the state after provisioning plus granting a11y. */
    private static CapabilitySnapshot full() {
        return new CapabilitySnapshot(
                true, "", "",
                true, "",
                false, "未安装 Shizuku",
                "",
                6 * 1024 * 1024, 8 * 1024 * 1024, false,
                "PZ261A", "16", 36);
    }

    private static String render(CapabilitySnapshot s) {
        return SelfDesc.render(AssistantProfile.AMOO, s);
    }

    // ── the degraded case ──

    @Test
    public void whenAccessibilityIsOffTheTextSaysTheUiToolsDoNotWork() {
        String t = render(degraded());
        assertTrue("必须明说界面自动化此刻不可用，否则助手会去调 ui_tap 然后失败:\n" + t,
                t.contains("无障碍没开"));
        assertTrue(t.contains("ui_ 开头的工具与 shot"));
        assertTrue(t.contains("此刻不可用"));
    }

    @Test
    public void whenAccessibilityIsOffTheTextSaysItIsAPermissionNotAnInability() {
        // 区别是承重的：「做不到」会让助手拒绝请求，「差授权」会让它去请用户授权。
        // 原来自描述里那句「你自己不能点按」正是把这俩混成一个的坏例子。
        String t = render(degraded());
        assertTrue(t.contains("差授权"));
        assertTrue(t.contains("不是做不到"));
        assertTrue("必须让它别把「没授权」说成「我做不到」",
                t.contains("别回答「无法操作界面」"));
        assertTrue("必须让它去告诉用户差什么", t.contains("告诉用户差这一步授权"));
    }

    @Test
    public void whenNoElevationChannelIsUpTheTextNamesTheSilentFailure() {
        // 「看起来成功但改不动系统」是最难从外部诊断的失败形态，必须说。
        String t = render(degraded());
        assertTrue(t.contains("提权未就绪"));
        assertTrue(t.contains("exec 以 App 身份跑"));
        assertTrue(t.contains("看起来成功但改不动系统"));
    }

    @Test
    public void theElevationDetailIsPointedAtInfoRatherThanDuplicated() {
        // 两条提权路的完整措辞住在 Tools.elevationAdvice 里，悬浮框、通知、info
        // 三处共用。在这里再抄一份，两边迟早说成两种话——那正是那个方法存在
        // 所要避免的。所以自描述只指路。
        String t = render(degraded());
        assertTrue(t.contains("见 info"));
        assertFalse("不许把 elevationAdvice 抄进来", t.contains("未提权。两条路"));
        assertFalse("也不许出现它的标识符变体", t.contains("Shizuku，在 Shizuku"));
    }

    @Test
    public void theBudgetRemainingIsStatedSoItBatchesInsteadOfHittingTheWall() {
        String t = render(degraded());
        assertTrue(t.contains("本轮还能读约 1MB"));
        assertTrue(t.contains("共 8MB"));
        assertTrue("要提示它打包而不是逐个读", t.contains("多文件优先打包"));
    }

    // ── the full case: must NOT degrade ──

    @Test
    public void whenEverythingIsUpTheTextDoesNotClaimOtherwise() {
        // 只会说坏话的渲染器同样是一种失能：训练助手忽略这段话。
        String t = render(full());
        assertTrue(t.contains("无障碍已开"));
        assertTrue(t.contains("界面自动化与截图可用"));
        assertTrue(t.contains("提权已就绪"));
        assertTrue(t.contains("exec 以 shell 身份跑"));
        assertFalse("全通时不提未提权那套", t.contains("提权未就绪"));
        assertFalse("全通时不许出现降级措辞", t.contains("改不动系统"));
    }

    @Test
    public void whenEverythingIsUpTheTextStillReportsTheBudget() {
        // 预算是使用量不是可用性，两种状态下都有意义。
        String t = render(full());
        assertTrue(t.contains("本轮还能读约 6MB"));
    }

    @Test
    public void shizukuAloneCountsAsElevated() {
        // sidecar 需要电脑重启后才回来，Shizuku 不需要。只认 sidecar 会把
        // 「不需要电脑」那条路走通的设备误报成未提权。
        CapabilitySnapshot s = new CapabilitySnapshot(
                true, "", "", false, "", true, "", "",
                0, 8 * 1024 * 1024, false, "PZ261A", "16", 36);
        assertTrue(s.elevated());
        assertTrue(render(s).contains("提权已就绪"));
    }

    @Test
    public void aSidecarThatAnsweredPingButNeverRanExecIsUnconfirmedNotDown() {
        // 2026-10-26 真机实测到的第三种状态：provision 完、一次 exec 都没跑时，
        // sidecar 通着而 ready 仍是 false（ready 刻意悲观，要真 exec 才翻真）。
        // 此时只有两种说法都是错的——说"已就绪"是未证实的断言，说"改不动系统"
        // 是假的（紧接着第一次 exec 就成功）。所以必须是第三种：去试。
        CapabilitySnapshot s = new CapabilitySnapshot(
                true, "", "", false, "sidecar 在线，待首次执行确认", false, "", "",
                0, 8 * 1024 * 1024, true, "PZ261A", "16", 36);
        assertFalse(s.elevated());
        assertTrue(s.elevationUnconfirmed);

        String t = render(s);
        assertTrue(t.contains("提权通道可能已就绪但尚未证实"));
        assertTrue("要让它真的去试，而不是两种错话里选一种", t.contains("先跑一条 exec 试试"));
        assertFalse("不许在这种状态下断言改不动系统", t.contains("改不动系统"));
    }

    // ── the write-back budget ──

    @Test
    public void theCapabilityParagraphDoesNotPushTheMemoryOutOfTheBox() {
        // 这条是实测逼出来的，不是理论担心。ask() 把 preamble 经 writeBack 发出，
        // 而 writeBack 截到 maxWriteBackChars（1500，按 Amoo 输入框量的）。
        // 描述和记忆层共用这一个框，记忆还拼在描述后面——所以能力段每长一个字，
        // 就把一条已核实的事实挤出去。第一版能力段写了约 400 字，直接把整段
        // 记忆挤没了，是 AmooLoopPipelineTest 抓到的（"11 bytes" 不复存在）。
        //
        // 这里把它钉成显式不变量：最坏情况（全降级）下，描述 + 一条典型记忆
        // 必须仍装得进框里。
        String description = render(degraded());
        String memory = "\n\n以下是我们已经核实过的事实，请以此为前提，不要重新测量：\n"
                + "f1: read back 手机存储里的g/main.py, 11 bytes";
        assertTrue("描述本身已超限: " + description.length(),
                description.length() <= 1500);
        assertTrue("描述 + 一条典型记忆已超限: " + (description.length() + memory.length()),
                description.length() + memory.length() <= 1500);
    }

    @Test
    public void theCapabilityParagraphIsBoundedSoItCannotGrowWithoutNotice() {
        // 上一条只约束了今天的内容。这条约束增长：谁往能力段里加长句之前，
        // 会先撞到这条，而不是先撞到真机上记忆丢失。
        String t = render(degraded());
        int cap = t.indexOf("【此刻能用什么】");
        int next = t.indexOf("【分工", cap);
        assertTrue("能力段不存在或顺序错了", cap >= 0 && next > cap);
        int len = next - cap;
        assertTrue("能力段已长到 " + len + " 字符，会挤掉记忆层；要加内容先想清楚拿什么换",
                len <= 200);
    }

    // ── the snapshot object itself ──

    @Test
    public void negativeHeadroomIsClampedToZero() {
        // bytesLeft 是「预算 − 已用」，超支时是负数。渲染成「还能读约 -2MB」
        // 比不报更糟。
        CapabilitySnapshot s = new CapabilitySnapshot(
                false, "", "", false, "", false, "", "",
                -5L, 8 * 1024 * 1024, false, "", "", 0);
        assertEquals(0L, s.bytesLeft);
        assertFalse(render(s).contains("还能读约 -"));
    }

    @Test
    public void nullStringsBecomeEmptyNotTheLiteralNull() {
        CapabilitySnapshot s = new CapabilitySnapshot(
                false, null, null, false, null, false, null, null,
                0, 0, false, null, null, 0);
        assertEquals("", s.uiWhy);
        assertEquals("", s.sidecarWhy);
        assertEquals("", s.shizukuWhy);
        assertEquals("", s.elevationAdvice);
        assertEquals("", s.model);
    }

    @Test
    public void toJsonCarriesEveryFieldTheDescriptionRendersFrom() throws Exception {
        // 自描述和 info 必须说的是同一份状态。这个测试是那句话的机器形式：
        // 渲染用到的每个字段都在 toJson 里，少一个就会出现「描述说的和 info 说的
        // 不是一回事」而这种分歧从外表看不出来。
        CapabilitySnapshot s = degraded();
        org.json.JSONObject j = s.toJson();
        for (String key : new String[] {"ui", "ui_why", "ui_advice", "sidecar",
                "sidecar_why", "shizuku", "shizuku_why", "elevation_advice",
                "elevated", "elevation_unconfirmed", "bytes_left", "byte_budget",
                "model", "release", "sdk"}) {
            assertTrue("toJson 少了 " + key, j.has(key));
        }
        assertFalse(j.getBoolean("elevated"));
        assertEquals(36, j.getInt("sdk"));
        assertEquals("PZ261A", j.getString("model"));
    }

    @Test
    public void toJsonAndTheRenderedTextAgreeOnElevation() throws Exception {
        // 一个真源的两个消费者：info 说未提权时，描述里也必须是未提权。
        // 第三态也要对得上——那正是真机上出的那次岔子。
        CapabilitySnapshot unconfirmed = new CapabilitySnapshot(
                true, "", "", false, "sidecar 在线，待首次执行确认", false, "", "",
                0, 8 * 1024 * 1024, true, "PZ261A", "16", 36);
        for (CapabilitySnapshot s : new CapabilitySnapshot[] {
                degraded(), full(), unconfirmed}) {
            boolean elevated = s.toJson().getBoolean("elevated");
            boolean unconfirmedFlag = s.toJson().getBoolean("elevation_unconfirmed");
            String t = render(s);
            assertEquals("elevated 与 unconfirmed 不该同时为真",
                    false, elevated && unconfirmedFlag);
            if (elevated) {
                assertTrue(t.contains("提权已就绪"));
            } else if (unconfirmedFlag) {
                assertTrue(t.contains("提权通道可能已就绪但尚未证实"));
            } else {
                assertTrue(t.contains("提权未就绪"));
            }
        }
    }

    @Test
    public void aNoneSnapshotRendersWithoutThrowing() {
        // 桥没初始化时（单测就是这种情形）facade 会退到 none()。它必须渲染出
        // 东西来，而且必须诚实——不能假装什么都能用。
        String t = render(CapabilitySnapshot.none());
        assertTrue(t.contains("【此刻能用什么】"));
        assertTrue(t.contains("无障碍没开"));
        assertTrue(t.contains("提权未就绪"));
    }
}
