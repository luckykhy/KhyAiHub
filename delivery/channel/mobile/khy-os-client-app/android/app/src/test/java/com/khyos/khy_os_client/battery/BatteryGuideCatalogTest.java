package com.khyos.khy_os_client.battery;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 引导目录的纯逻辑测试（JVM，无需设备）。
 *
 * <p>钉住的东西：
 *   - 厂商 → 家族 的归类（归错家族 = 跳到错误的厂商页）；
 *   - 每一步都必须有"入口名称"和"为什么要设"（空文案等于没引导）；
 *   - 每一步都必须有兜底（没有兜底的跳转在 ROM 改名时就是死路）；
 *   - 原生 Android 的"自启动"必须标成 optional（它没有这个开关）；
 *   - 步骤 id 不重复（打勾是按 id 记的，重复会串）。
 */
public class BatteryGuideCatalogTest {

    @Test
    public void familyOfRecognizesEachVendor() {
        assertEquals(BatteryGuideCatalog.Family.MIUI, BatteryGuideCatalog.familyOf("Xiaomi"));
        assertEquals(BatteryGuideCatalog.Family.MIUI, BatteryGuideCatalog.familyOf("redmi"));
        assertEquals(BatteryGuideCatalog.Family.MIUI, BatteryGuideCatalog.familyOf("POCO"));
        // StepOS 不是 MIUI：实机（PZ261A / Android 16）上它的系统包命名空间是
        // com.stepos.*，没有 com.miui.*。归到 MIUI 会让所有候选组件都落空。
        assertEquals(BatteryGuideCatalog.Family.STEPOS, BatteryGuideCatalog.familyOf("StepX"));
        assertEquals(BatteryGuideCatalog.Family.STEPOS, BatteryGuideCatalog.familyOf("stepos"));
        assertEquals(BatteryGuideCatalog.Family.COLOROS, BatteryGuideCatalog.familyOf("OPPO"));
        assertEquals(BatteryGuideCatalog.Family.COLOROS, BatteryGuideCatalog.familyOf("realme"));
        assertEquals(BatteryGuideCatalog.Family.COLOROS, BatteryGuideCatalog.familyOf("OnePlus"));
        assertEquals(BatteryGuideCatalog.Family.ORIGINOS, BatteryGuideCatalog.familyOf("vivo"));
        assertEquals(BatteryGuideCatalog.Family.ORIGINOS, BatteryGuideCatalog.familyOf("iQOO"));
        assertEquals(BatteryGuideCatalog.Family.HONOR, BatteryGuideCatalog.familyOf("HONOR"));
        assertEquals(BatteryGuideCatalog.Family.HUAWEI, BatteryGuideCatalog.familyOf("HUAWEI"));
        assertEquals(BatteryGuideCatalog.Family.STOCK, BatteryGuideCatalog.familyOf("Google"));
        assertEquals(BatteryGuideCatalog.Family.OTHER, BatteryGuideCatalog.familyOf("Whatever"));
        assertEquals(BatteryGuideCatalog.Family.STOCK, BatteryGuideCatalog.familyOf(null));
    }

    @Test
    public void everyVendorGetsThreeStepsWithUniqueIds() {
        String[] vendors = {"Xiaomi", "OPPO", "vivo", "HONOR", "HUAWEI", "StepX",
                "Google", "Whatever"};
        for (String v : vendors) {
            List<BatteryGuideCatalog.GuideStep> steps =
                    BatteryGuideCatalog.stepsFor(v, 34);
            assertNotNull("厂商 " + v + " 必须有步骤清单", steps);
            assertEquals("厂商 " + v + " 的步骤数应为 3", 3, steps.size());
            Set<String> ids = new HashSet<String>();
            for (BatteryGuideCatalog.GuideStep s : steps) {
                assertTrue("步骤 id 不能为空：" + v, s.id != null && !s.id.isEmpty());
                assertTrue("步骤 id 不能重复：" + v, ids.add(s.id));
                assertFalse("入口名称不能为空：" + v + "/" + s.id, s.title.trim().isEmpty());
                assertFalse("必须写清为什么要设：" + v + "/" + s.id, s.why.trim().isEmpty());
                // 可选步骤（原生 Android 的自启动）本来就没有对应入口，
                // 它不是"需要兜底"的——它是"这一步不存在"。
                if (!s.optional) {
                    assertFalse("必须有兜底策略：" + v + "/" + s.id,
                            BatteryGuideCatalog.FALLBACK_NONE.equals(s.fallback));
                }
            }
        }
    }

    @Test
    public void stockAndroidHasNoAutostartStepAsRequired() {
        List<BatteryGuideCatalog.GuideStep> steps =
                BatteryGuideCatalog.stepsFor("Google", 34);
        BatteryGuideCatalog.GuideStep autostart = null;
        for (BatteryGuideCatalog.GuideStep s : steps) {
            if (BatteryGuideCatalog.STEP_AUTOSTART.equals(s.id)) autostart = s;
        }
        assertNotNull("原生 Android 也要有自启动那一步（标成可选）", autostart);
        assertTrue("原生 Android 没有自启动开关，这一步必须是 optional", autostart.optional);
    }

    @Test
    public void vendorStepsAreNotOptional() {
        // 厂商机型上的三步都是真需要做的：标成 optional 会让 UI 把它们收起来，
        // 用户就永远做不完。
        for (String v : new String[]{"Xiaomi", "OPPO", "vivo", "HONOR", "HUAWEI", "StepX"}) {
            for (BatteryGuideCatalog.GuideStep s : BatteryGuideCatalog.stepsFor(v, 34)) {
                assertFalse("厂商步骤不应是 optional：" + v + "/" + s.id, s.optional);
            }
        }
    }

    @Test
    public void vendorStepsCarryCandidateComponents() {
        // 有厂商组件候选的步骤：候选全失败时还有兜底页。
        for (String v : new String[]{"Xiaomi", "OPPO", "vivo", "HONOR", "HUAWEI", "StepX"}) {
            for (BatteryGuideCatalog.GuideStep s : BatteryGuideCatalog.stepsFor(v, 34)) {
                assertFalse("厂商步骤必须带组件候选：" + v + "/" + s.id,
                        s.components.isEmpty());
                for (String comp : s.components) {
                    assertTrue("组件候选必须是 pkg/cls 形状：" + comp,
                            comp.contains("/") && comp.indexOf('/') > 0);
                }
            }
        }
    }

    @Test
    public void steposCandidatesMatchTheRealDeviceComponents() {
        // 真机（PZ261A）上 `cmd package resolve-activity --brief -a
        // com.stepos.safe.security.autostart_manager_settings` 解析出
        // com.stepos.safe/.permission.AutoStartActivity。这条断言把那两个
        // 已验证的组件钉住：谁把它们改成别的名字，测试会红。
        List<BatteryGuideCatalog.GuideStep> steps = BatteryGuideCatalog.stepsFor("StepX", 36);
        boolean sawAutoStart = false;
        boolean sawBackground = false;
        for (BatteryGuideCatalog.GuideStep s : steps) {
            if (BatteryGuideCatalog.STEP_AUTOSTART.equals(s.id)) {
                for (String c : s.components) {
                    if (c.contains("AutoStartActivity")) sawAutoStart = true;
                }
            }
            if (BatteryGuideCatalog.STEP_BACKGROUND.equals(s.id)) {
                for (String c : s.components) {
                    if (c.contains("TransformActivity")) sawBackground = true;
                }
            }
        }
        assertTrue("StepOS 自启动候选必须含已验证的 AutoStartActivity", sawAutoStart);
        assertTrue("StepOS 后台候选必须含已验证的 TransformActivity", sawBackground);
    }

    @Test
    public void steposKeepsActionCandidatesBesidesComponents() {
        // 实测（2026-11-15）：显式组件 com.stepos.safe/.permission.AutoStartActivity
        // 被 com.stepos.safe.permission.SAFE_ACCESS 拦下（SecurityException），
        // 而 action com.stepos.safe.security.background_manager_settings 能打开。
        // component 与 action 是两条不同的路，目录里必须同时留着。
        for (BatteryGuideCatalog.GuideStep s : BatteryGuideCatalog.stepsFor("StepX", 36)) {
            if (BatteryGuideCatalog.STEP_AUTOSTART.equals(s.id)) {
                assertTrue("StepOS 自启动必须留 action 候选",
                        s.actions.contains("com.stepos.safe.security.autostart_manager_settings"));
            }
            if (BatteryGuideCatalog.STEP_BACKGROUND.equals(s.id)) {
                assertTrue("StepOS 后台必须留 action 候选",
                        s.actions.contains("com.stepos.safe.security.background_manager_settings"));
                assertTrue("StepOS 后台的 action 是实测能跳通的那条",
                        s.actions.get(0).equals("com.stepos.safe.security.background_manager_settings"));
            }
        }
    }

    @Test
    public void restrictedSettingsStepFallsBackToAppDetails() {
        // 「允许受限设置」藏在应用信息页的溢出菜单里，系统没有对外的 Intent，
        // 所以它只能退到应用详情页 + 图文说明。
        BatteryGuideCatalog.GuideStep s = BatteryGuideCatalog.restrictedSettingsStep();
        assertEquals(BatteryGuideCatalog.STEP_RESTRICTED, s.id);
        assertEquals(BatteryGuideCatalog.FALLBACK_APP_DETAILS, s.fallback);
        assertFalse(s.why.trim().isEmpty());
        assertTrue("受限设置那一步必须讲清入口位置", s.why.contains("允许受限设置"));
    }

    @Test
    public void batteryStatusActionableRules() {
        BatteryStatus clean = new BatteryStatus("google", true, false,
                BatteryStatus.AutostartState.ALLOWED, false, 1L);
        assertFalse("全绿时不该有待办", clean.hasActionable());

        BatteryStatus notWhitelisted = new BatteryStatus("google", false, false,
                BatteryStatus.AutostartState.ALLOWED, false, 1L);
        assertTrue(notWhitelisted.hasActionable());

        BatteryStatus bgBlocked = new BatteryStatus("google", true, true,
                BatteryStatus.AutostartState.ALLOWED, false, 1L);
        assertTrue(bgBlocked.hasActionable());

        BatteryStatus restricted = new BatteryStatus("google", true, false,
                BatteryStatus.AutostartState.ALLOWED, true, 1L);
        assertTrue(restricted.hasActionable());

        // 自启动"未知"不算待办：判不出来不等于有问题。
        BatteryStatus unknownAutostart = new BatteryStatus("vivo", true, false,
                BatteryStatus.AutostartState.UNKNOWN, false, 1L);
        assertFalse(unknownAutostart.hasActionable());

        BatteryStatus deniedAutostart = new BatteryStatus("vivo", true, false,
                BatteryStatus.AutostartState.DENIED, false, 1L);
        assertTrue(deniedAutostart.hasActionable());
    }

    @Test
    public void autostartWireRoundTrip() {
        assertEquals(BatteryStatus.AutostartState.ALLOWED,
                BatteryStatus.AutostartState.fromWire("allowed"));
        assertEquals(BatteryStatus.AutostartState.DENIED,
                BatteryStatus.AutostartState.fromWire("denied"));
        assertEquals(BatteryStatus.AutostartState.UNKNOWN,
                BatteryStatus.AutostartState.fromWire("unknown"));
        assertEquals(BatteryStatus.AutostartState.UNKNOWN,
                BatteryStatus.AutostartState.fromWire(null));
        assertEquals(BatteryStatus.AutostartState.UNKNOWN,
                BatteryStatus.AutostartState.fromWire("garbage"));
    }
}
