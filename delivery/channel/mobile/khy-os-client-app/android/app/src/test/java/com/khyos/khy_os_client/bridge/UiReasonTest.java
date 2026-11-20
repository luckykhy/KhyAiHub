// khy-canary: Khy-20261114-001-UIR1R2A
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * UiReasonTest — status.json 的 ui 为什么必须带一句原因。
 *
 * THE DEFECT, found on the real device on 2026-11-14 (R1R2/repro-before.txt):
 * {@code settings get secure accessibility_enabled} returned {@code 0} and
 * {@code enabled_accessibility_services} returned {@code null} — the master
 * switch was off and the service unlisted — while status.json answered
 * {@code "ui":false} and nothing else. PC 侧 probe 只读那一个文件，于是
 * 「从未开启 / 刚被撤销 / 总开关关闭 / 框架未重绑」四种成因在它眼里长得
 * 完全一样，而四种的处置一个都不一样。
 *
 * 修法：{@code ui} 旁边加 {@code ui_reason}，原因由 {@link Tools#a11yState}
 * 的两条公开读数现算（Settings.Secure + AccessibilityManager），拼句子的
 * {@link Tools#uiWhyFor} 是纯函数——Android 全在读数那一侧，所以这里能在裸
 * JVM 上逐分支钉住。
 */
public class UiReasonTest {

    // ---- 读数构造：五个布尔就是全部输入 ----

    private static Tools.A11yState st(boolean settingReadOk, boolean settingListsUs,
                                      boolean masterOn, boolean frameworkReadOk,
                                      boolean frameworkListsUs) {
        return new Tools.A11yState(settingReadOk, settingListsUs, masterOn,
                frameworkReadOk, frameworkListsUs, "");
    }

    /** 正常关着：设置与框架都不认本服务。 */
    private static Tools.A11yState neverEnabled() {
        return st(true, false, true, true, false);
    }

    // ---- 每一族失败都要有自己的一句话 ----

    @Test
    public void masterSwitchOffIsNamedAsSuch() {
        // 2026-11-14 真机就是这个态：总开关被关掉。旧常量只会说"设置列表为空"，
        // 用户照那句话去翻列表会翻不到东西——空的原因说错了。
        String why = Tools.uiWhyFor(st(true, false, false, true, false));
        assertTrue("必须点名总开关", why.contains("总开关"));
        assertTrue("必须给出 setting 键名", why.contains("accessibility_enabled"));
    }

    @Test
    public void neverEnabledSaysSoAndAdmitsTheAmbiguity() {
        String why = Tools.uiWhyFor(neverEnabled());
        assertTrue("未开启必须说清", why.contains("无障碍服务未开启"));
        // 撤销与从未开启从这一侧读不出区别——照直说，不编一个因果。
        assertTrue("必须说明撤销与从未开启读不出区别", why.contains("撤销与从未开启"));
    }

    @Test
    public void settingListsButFrameworkHasNotBoundIsItsOwnCase() {
        // 进程刚起来、系统还没重绑的那个窗口。说成"未开启"会把人支去开一个
        // 已经开着的开关。
        String why = Tools.uiWhyFor(st(true, true, true, true, false));
        assertTrue("必须说框架还没绑上", why.contains("框架还没绑上"));
        assertTrue("必须给出可执行的下一步", why.contains("重启"));
    }

    @Test
    public void frameworkBoundButInstanceMissingNamesTheLyingGate() {
        // 唯一指向"isReady() 在撒谎"的分支：框架说绑着，我们却没有对象。
        // 这也是验收项要防的反面（adb 授权后 Bound services 非空而 ui 仍 false）。
        String why = Tools.uiWhyFor(st(true, true, true, true, true));
        assertTrue("必须说框架已绑定", why.contains("框架已绑定"));
        assertTrue("必须说服务对象未就绪", why.contains("服务对象未就绪"));
    }

    @Test
    public void frameworkBoundBeatsSettingContradiction() {
        // 设置里没有、框架里有：以框架为准，并明说这是矛盾态。
        String why = Tools.uiWhyFor(st(true, false, true, true, true));
        assertTrue("矛盾态必须以框架为准", why.contains("框架已绑定"));
        assertTrue("矛盾态要照直说", why.contains("矛盾"));
    }

    @Test
    public void bothReadsFailingSaysItCannotTell() {
        // 读不到就不猜。一个把"读不到"说成"未开启"的实现会把排查引向完全
        // 错误的方向。
        String why = Tools.uiWhyFor(st(false, false, false, false, false));
        assertTrue("必须说读不到", why.contains("读不到"));
        assertTrue("必须说无法判断", why.contains("无法判断"));
    }

    @Test
    public void settingReadSurvivesFrameworkReadFailure() {
        // 框架列表读不到不否决设置层读数：两条腿各站各的。
        String why = Tools.uiWhyFor(st(true, true, true, false, false));
        assertTrue("设置里已启用必须照说", why.contains("系统设置里本服务已启用"));
        String why2 = Tools.uiWhyFor(st(true, false, true, false, false));
        assertTrue("设置层说没开就说没开", why2.contains("无障碍服务未开启"));
    }

    @Test
    public void nullStateIsNotACrash() {
        assertTrue(Tools.uiWhyFor(null).contains("读不到"));
    }

    @Test
    public void everyBranchIsANonEmptySentence() {
        for (boolean a : new boolean[] {true, false})
            for (boolean b : new boolean[] {true, false})
                for (boolean c : new boolean[] {true, false})
                    for (boolean d : new boolean[] {true, false})
                        for (boolean e : new boolean[] {true, false}) {
                            String why = Tools.uiWhyFor(st(a, b, c, d, e));
                            assertFalse("空原因等于没报：" + a + b + c + d + e, why.isEmpty());
                            assertTrue("原因必须是句子，不是代码：" + why, why.length() > 10);
                        }
    }

    // ---- 落盘形状：status.json 与 /status 都必须带上原因 ----

    @Test
    public void statusJsonCarriesTheReason() throws Exception {
        String src = readSource("BridgeService.java");
        assertTrue("status.json 必须带 ui_reason", src.contains("\"ui_reason\""));
        assertTrue("ui_reason 必须由 uiWhy 现算，不是常量",
                src.contains("o.put(\"ui_reason\", Tools.uiWhy())"));
    }

    @Test
    public void liveStatusEndpointCarriesTheReasonToo() throws Exception {
        String src = readSource("HttpBridge.java");
        assertTrue("/status 必须与 status.json 同形", src.contains(".put(\"ui_reason\", Tools.uiWhy())"));
    }

    @Test
    public void theReasonIsComputedFromTheAccessibilityManagerRead() throws Exception {
        String src = readSource("Tools.java");
        assertTrue("必须读 AccessibilityManager 的 enabled service 列表",
                src.contains("getEnabledAccessibilityServiceList"));
        assertTrue("必须读 Settings.Secure 的设置列表",
                src.contains("Settings.Secure.getString"));
    }

    @Test
    public void theRevokeNoticeIsWiredIntoTheLoop() throws Exception {
        // 运行期撤销不能等下次冷启：现有的 30s 看守只覆盖冻结态（对象还在、
        // 事件停收），覆盖不了 instance 被 onUnbind 置空这条。
        String src = readSource("BridgeService.java");
        assertTrue("循环里必须调用失联提示", src.contains("noticeA11yLost()"));
        assertTrue("提示必须带原因", src.contains("a11y 运行期失联"));
    }

    // ---- helper ----

    private static String readSource(String name) throws Exception {
        java.util.List<String> tried = new java.util.ArrayList<String>();
        for (String base : new String[] {
                System.getProperty("user.dir", "."),
                Tools.class.getProtectionDomain().getCodeSource().getLocation().getPath(),
        }) {
            java.io.File cur = new java.io.File(base);
            for (int up = 0; up < 6 && cur != null;
                    up++, cur = cur.getParentFile()) {
                java.io.File c = new java.io.File(cur,
                        "app/src/main/java/com/khyos/khy_os_client/bridge/" + name);
                tried.add(c.getAbsolutePath());
                if (c.isFile()) {
                    return new String(java.nio.file.Files.readAllBytes(c.toPath()),
                            java.nio.charset.StandardCharsets.UTF_8);
                }
            }
        }
        throw new IllegalStateException("找不到 " + name + "，已试：" + tried);
    }
}
