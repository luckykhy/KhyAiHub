package com.khyos.khy_os_client.battery;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 各厂商引导入口目录（纯逻辑，不碰任何 Android 类型）。
 *
 * <p><b>这份表为什么必须"多候选 + 逐个降级"</b>：ROM 厂商改 Activity 名是常态，
 * 而且没有一条系统 API 能枚举"某应用的后台管理页在哪"。所以每一步都带一串
 * 候选组件（{@code pkg/cls}），运行时逐个尝试；全失败就退到兜底页
 * （应用详情页 / 电池优化列表）。任何一步失败都不允许抛异常，更不允许卡住。
 *
 * <p><b>候选从哪来</b>：社区与各 ROM 抓包中反复出现的入口名。厂商改名后第一个
 * 候选会失效——这正是这里放三四个候选、并配兜底页的原因。本表<b>不承诺</b>在
 * 某个 ROM 版本上一定命中；命中与否由真机验证记录说话（未实测的机型在交付物里
 * 逐条标注）。
 *
 * <p>本类刻意不引用 Android，因此可以在 JVM 单测里直接断言（见
 * {@code BatteryGuideCatalogTest}）。
 */
public final class BatteryGuideCatalog {

    private BatteryGuideCatalog() {}

    /** 兜底策略：跳本 App 的应用详情页（用户从那里找到"电池""权限"）。 */
    public static final String FALLBACK_APP_DETAILS = "app_details";
    /** 兜底策略：跳系统的电池优化应用列表。 */
    public static final String FALLBACK_BATTERY_LIST = "battery_optimization_list";
    /** 兜底策略：跳系统的无障碍设置。 */
    public static final String FALLBACK_ACCESSIBILITY = "accessibility_settings";
    /** 没有兜底：这一步在当前 ROM 上不存在（如原生 Android 的自启动）。 */
    public static final String FALLBACK_NONE = "none";

    /** 步骤 id：电池优化白名单。 */
    public static final String STEP_BATTERY = "battery_optimization";
    /** 步骤 id：自启动管理。 */
    public static final String STEP_AUTOSTART = "autostart";
    /** 步骤 id：后台运行 / 后台高耗电。 */
    public static final String STEP_BACKGROUND = "background_run";
    /** 步骤 id：允许受限设置（Android 13+ 侧载）。 */
    public static final String STEP_RESTRICTED = "restricted_settings";

    /** 一步引导。 */
    public static final class GuideStep {
        /** 稳定 id（跨版本不变，用于"已完成"打勾的本地记录）。 */
        public final String id;
        /** 入口名称：用户在厂商设置里看到的那个名字。 */
        public final String title;
        /** 为什么要设：说清不设的后果，不写"请去设置"这种空话。 */
        public final String why;
        /** 候选组件，形如 {@code pkg/cls}，按顺序尝试。 */
        public final List<String> components;
        /**
         * 候选 action（只有厂商为这个入口定义了对外 action 时才有）。
         *
         * <p>为什么要 action 这一种形式：实测（2026-11-15，PZ261A / StepOS）发现
         * {@code com.stepos.safe/.permission.AutoStartActivity} 这个组件被
         * {@code com.stepos.safe.permission.SAFE_ACCESS} 保护——显式跳它会被
         * SecurityException 拦下；而同一个入口的 action 形式
         * （{@code com.stepos.safe.security.background_manager_settings}）在
         * 另一个页面上却能正常打开。<b>action 与 component 是两条不同的路</b>，
         * 只留一条就会白扔一条能走的路。
         */
        public final List<String> actions;
        /** 兜底策略（见 FALLBACK_* 常量）。 */
        public final String fallback;
        /** 该 ROM 上没有这一步（true 时 UI 收起，不给用户找不存在的开关）。 */
        public final boolean optional;

        GuideStep(String id, String title, String why, List<String> components,
                  List<String> actions, String fallback, boolean optional) {
            this.id = id;
            this.title = title;
            this.why = why;
            this.components = Collections.unmodifiableList(new ArrayList<String>(components));
            this.actions = Collections.unmodifiableList(new ArrayList<String>(actions));
            this.fallback = fallback;
            this.optional = optional;
        }
    }

    /** 厂商家族。 */
    public enum Family {
        MIUI, COLOROS, ORIGINOS, HONOR, HUAWEI, STEPOS, STOCK, OTHER
    }

    /** 按厂商名归家族。 */
    public static Family familyOf(String manufacturer) {
        String m = manufacturer == null ? "" : manufacturer.trim().toLowerCase();
        if (m.isEmpty()) return Family.STOCK;
        // StepOS / StepX（真机实测：PZ261A / Android 16）。它的系统包命名空间是
        // com.stepos.*，**不是** com.miui.*——所以它不能挂到 MIUI 家族去：
        // 挂错了，MIUI 的候选组件一个都命中不了，只能退到兜底页。
        if (m.startsWith("stepx") || m.startsWith("stepos")) return Family.STEPOS;
        if (m.startsWith("xiaomi") || m.startsWith("redmi") || m.startsWith("poco")) {
            return Family.MIUI;
        }
        if (m.startsWith("oppo") || m.startsWith("realme") || m.startsWith("oneplus")) {
            return Family.COLOROS;
        }
        if (m.startsWith("vivo") || m.startsWith("iqoo")) return Family.ORIGINOS;
        if (m.startsWith("honor") || m.startsWith("hihonor")) return Family.HONOR;
        if (m.startsWith("huawei")) return Family.HUAWEI;
        if (m.startsWith("google") || m.startsWith("pixel") || m.startsWith("samsung")
                || m.startsWith("aosp") || m.startsWith("generic")) {
            return Family.STOCK;
        }
        return Family.OTHER;
    }

    /**
     * 取某个机型该走的引导步骤清单。
     *
     * @param manufacturer 厂商名（{@code Build.MANUFACTURER}）
     * @param sdkInt        系统 API 级别
     * @return 永不为 null；未知机型走 {@link Family#OTHER}（等价于原生 + 应用详情页兜底）。
     */
    public static List<GuideStep> stepsFor(String manufacturer, int sdkInt) {
        Family f = familyOf(manufacturer);
        List<GuideStep> steps = new ArrayList<GuideStep>();
        switch (f) {
            case MIUI:
                steps.add(miuiBattery());
                steps.add(miuiAutostart());
                steps.add(miuiBackground());
                break;
            case COLOROS:
                steps.add(colorosBattery());
                steps.add(colorosAutostart());
                steps.add(colorosBackground());
                break;
            case ORIGINOS:
                steps.add(originBattery());
                steps.add(originAutostart());
                steps.add(originBackground());
                break;
            case HONOR:
                steps.add(honorBattery());
                steps.add(honorAutostart());
                steps.add(honorBackground());
                break;
            case HUAWEI:
                steps.add(huaweiBattery());
                steps.add(huaweiAutostart());
                steps.add(huaweiBackground());
                break;
            case STEPOS:
                steps.add(steposBattery());
                steps.add(steposAutostart());
                steps.add(steposBackground());
                break;
            case STOCK:
            case OTHER:
            default:
                steps.add(stockBattery());
                steps.add(stockBackground());
                // 原生 Android 没有"自启动"这个概念：列出来只会让用户去找一个
                // 不存在的开关。标成 optional，UI 会把它收起来。
                steps.add(stockAutostart());
                break;
        }
        return steps;
    }

    // ── MIUI / HyperOS ──────────────────────────────────────────────────────

    private static GuideStep miuiBattery() {
        return new GuideStep(STEP_BATTERY,
                "省电策略（应用智能省电）",
                "系统省电会在锁屏后冻结本应用的网络与后台任务，无障碍服务会被掐断、"
                        + "助手会与 PC 掉线。把 khy-os 设为「无限制」，锁屏时它才能继续工作。",
                Arrays.asList(
                        "com.miui.powerkeeper/com.miui.powerkeeper.ui.HiddenAppsConfigActivity",
                        "com.miui.powerkeeper/com.miui.powerkeeper.ui.PowerSettings",
                        "com.miui.powerkeeper/.ui.Activity_appList"),
                Collections.<String>emptyList(),
                FALLBACK_BATTERY_LIST, false);
    }

    private static GuideStep miuiAutostart() {
        return new GuideStep(STEP_AUTOSTART,
                "自启动管理",
                "不允许自启动时，开机后本应用不会自动被拉起，桥与无障碍要等用户手动打开 App 才恢复。",
                Arrays.asList(
                        "com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity",
                        "com.miui.securitycenter/com.miui.permcenter.permissions.PermissionsManagementActivity"),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    private static GuideStep miuiBackground() {
        return new GuideStep(STEP_BACKGROUND,
                "后台行为（省电策略里的后台限制）",
                "MIUI 会把长时间没交互的应用从后台清掉，锁屏一段时间后无障碍事件就不再送达。",
                Arrays.asList(
                        "com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity",
                        "com.miui.powerkeeper/com.miui.powerkeeper.ui.HiddenAppsConfigActivity"),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    // ── OPPO / ColorOS ──────────────────────────────────────────────────────

    private static GuideStep colorosBattery() {
        return new GuideStep(STEP_BATTERY,
                "电池优化 / 耗电排行",
                "ColorOS 的省电策略会冻结后台网络与闹钟，锁屏后无障碍服务会掉线、"
                        + "助手与 PC 的连接会断。放行后本应用在锁屏时仍能保持工作。",
                Arrays.asList(
                        "com.coloros.oppagent/com.coloros.powermanager.fuelgaue.PowerUsageModelActivity",
                        "com.coloros.safecenter/.startupapp.StartupAppListActivity",
                        "com.oplus.safecenter/.startupapp.StartupAppListActivity"),
                Collections.<String>emptyList(),
                FALLBACK_BATTERY_LIST, false);
    }

    private static GuideStep colorosAutostart() {
        return new GuideStep(STEP_AUTOSTART,
                "自启动管理",
                "关掉自启动后，重启或系统清理后台时本应用不会被拉起，"
                        + "桥与无障碍要等用户手动打开 App 才恢复。",
                Arrays.asList(
                        "com.coloros.safecenter/.startupapp.StartupAppListActivity",
                        "com.coloros.safecenter/com.coloros.safecenter.startupapp.StartupAppListActivity",
                        "com.oppo.safe/.permission.startup.StartupAppListActivity"),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    private static GuideStep colorosBackground() {
        return new GuideStep(STEP_BACKGROUND,
                "后台运行（允许后台运行 / 允许自启动）",
                "ColorOS 默认限制应用在后台存活，锁屏后进程可能被冻结，"
                        + "无障碍事件与桥心跳都会停。",
                Arrays.asList(
                        "com.coloros.safecenter/.startupapp.StartupAppListActivity",
                        "com.oppo.safe/.permission.startup.StartupAppListActivity"),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    // ── vivo / OriginOS ─────────────────────────────────────────────────────

    private static GuideStep originBattery() {
        return new GuideStep(STEP_BATTERY,
                "后台高耗电 / 电池白名单",
                "系统的高耗电管控会限制本应用在后台的网络与定时任务，"
                        + "锁屏后无障碍服务会掉线。加白后后台才能持续工作。",
                Arrays.asList(
                        "com.iqoo.secure/.ui.phoneoptimize.AddWhiteListActivity",
                        "com.vivo.permissionmanager/.activity.BgStartUpManagerActivity",
                        "com.vivo.abe/.ui.AbeActivity"),
                Collections.<String>emptyList(),
                FALLBACK_BATTERY_LIST, false);
    }

    private static GuideStep originAutostart() {
        return new GuideStep(STEP_AUTOSTART,
                "自启动管理",
                "不允许自启动时，开机后本应用不会自动拉起，桥与无障碍要等手动打开 App 才恢复。",
                Arrays.asList(
                        "com.vivo.permissionmanager/.activity.BgStartUpManagerActivity",
                        "com.iqoo.secure/.ui.phoneoptimize.BgStartUpManagerActivity"),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    private static GuideStep originBackground() {
        return new GuideStep(STEP_BACKGROUND,
                "后台运行（允许后台运行 / 高耗电提醒）",
                "vivo 系默认限制后台自启与高耗电应用，锁屏后进程会被冻结，"
                        + "无障碍事件与桥心跳都会停。",
                Arrays.asList(
                        "com.vivo.permissionmanager/.activity.BgStartUpManagerActivity",
                        "com.iqoo.secure/.ui.phoneoptimize.BgStartUpManagerActivity"),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    // ── 荣耀 HONOR ──────────────────────────────────────────────────────────

    private static GuideStep honorBattery() {
        return new GuideStep(STEP_BATTERY,
                "应用启动管理 / 优化",
                "荣耀的后台管控会冻结本应用，锁屏后无障碍服务掉线、助手与 PC 断连。",
                Arrays.asList(
                        "com.hihonor.systemmanager/.optimize.process.ProtectActivity",
                        "com.hihonor.systemmanager/.appcontrol.activity.StartupAppControlActivity",
                        "com.huawei.systemmanager/.optimize.process.ProtectActivity"),
                Collections.<String>emptyList(),
                FALLBACK_BATTERY_LIST, false);
    }

    private static GuideStep honorAutostart() {
        return new GuideStep(STEP_AUTOSTART,
                "应用启动管理（自启动）",
                "关掉自启动后，重启或系统清理后台时本应用不会被拉起。",
                Arrays.asList(
                        "com.hihonor.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
                        "com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity"),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    private static GuideStep honorBackground() {
        return new GuideStep(STEP_BACKGROUND,
                "后台运行 / 关联启动",
                "限制后台运行时，锁屏一段时间后进程被冻结，无障碍事件与桥心跳都会停。",
                Arrays.asList(
                        "com.hihonor.systemmanager/.appcontrol.activity.StartupAppControlActivity",
                        "com.hihonor.systemmanager/.optimize.process.ProtectActivity"),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    // ── 华为 HUAWEI ─────────────────────────────────────────────────────────

    private static GuideStep huaweiBattery() {
        return new GuideStep(STEP_BATTERY,
                "应用启动管理 / 优化",
                "华为的后台管控会冻结本应用，锁屏后无障碍服务掉线、助手与 PC 断连。",
                Arrays.asList(
                        "com.huawei.systemmanager/.optimize.process.ProtectActivity",
                        "com.huawei.systemmanager/.appcontrol.activity.StartupAppControlActivity"),
                Collections.<String>emptyList(),
                FALLBACK_BATTERY_LIST, false);
    }

    private static GuideStep huaweiAutostart() {
        return new GuideStep(STEP_AUTOSTART,
                "应用启动管理（自启动）",
                "关掉自启动后，重启或系统清理后台时本应用不会被拉起。",
                Arrays.asList(
                        "com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
                        "com.huawei.systemmanager/.appcontrol.activity.StartupAppControlActivity"),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    private static GuideStep huaweiBackground() {
        return new GuideStep(STEP_BACKGROUND,
                "后台运行 / 关联启动",
                "限制后台运行时，锁屏一段时间后进程被冻结，无障碍事件与桥心跳都会停。",
                Arrays.asList(
                        "com.huawei.systemmanager/.appcontrol.activity.StartupAppControlActivity",
                        "com.huawei.systemmanager/.optimize.process.ProtectActivity"),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    // ── StepOS / StepX（真机实测：PZ261A / Android 16 / 2026-11-15）──
    //
    // 这些组件名不是查来的，是在本机上用
    // `cmd package resolve-activity --brief -a <action>` 解析出来的：
    //   com.stepos.safe.security.autostart_manager_settings
    //       → com.stepos.safe/.permission.AutoStartActivity
    //   com.stepos.safe.security.background_manager_settings
    //       → com.stepos.safe/.feature.TransformActivity
    // 系统包命名空间是 com.stepos.*（不是 com.miui.*），所以这一族要单列。

    private static GuideStep steposBattery() {
        return new GuideStep(STEP_BATTERY,
                "省电模式 / 后台省电",
                "系统的省电模式会在息屏后冻结后台网络与定时任务，无障碍服务会被掐断、"
                        + "助手与 PC 掉线。把 khy-os 排除在省电冻结之外，锁屏时它才能继续工作。",
                Arrays.asList(
                        "com.stepos.battery/com.stepos.battery.app.powermode.LowPowerPreferenceActivity",
                        "com.stepos.battery/com.stepos.battery.app.powermode.SuperSaverModeActivity",
                        "com.stepos.safe/com.stepos.safe.feature.TransformActivity"),
                Collections.<String>emptyList(),
                FALLBACK_BATTERY_LIST, false);
    }

    private static GuideStep steposAutostart() {
        return new GuideStep(STEP_AUTOSTART,
                "自启动管理",
                "不允许自启动时，开机或系统清理后台后本应用不会被拉起，"
                        + "桥与无障碍要等用户手动打开 App 才恢复。",
                Arrays.asList(
                        // AutoStartActivity 是这个入口的正主，但实测被
                        // com.stepos.safe.permission.SAFE_ACCESS 保护、直跳会被
                        // SecurityException 拦下；后面两个是同属安全中心的页面，
                        // 实测可跳，是这条链真正的兜底。
                        "com.stepos.safe/com.stepos.safe.permission.AutoStartActivity",
                        "com.stepos.safe/com.stepos.safe.feature.TransformActivity",
                        "com.stepos.safe/com.stepos.safe.SecurityMainActivity"),
                Arrays.asList("com.stepos.safe.security.autostart_manager_settings"),
                FALLBACK_APP_DETAILS, false);
    }

    private static GuideStep steposBackground() {
        return new GuideStep(STEP_BACKGROUND,
                "后台管理",
                "后台限制会让本应用在息屏后被冻结，无障碍事件与桥心跳都会停，"
                        + "助手与 PC 因而断连。",
                Arrays.asList(
                        "com.stepos.safe/com.stepos.safe.feature.TransformActivity",
                        "com.stepos.safe/com.stepos.safe.SecurityMainActivity"),
                Arrays.asList("com.stepos.safe.security.background_manager_settings"),
                FALLBACK_APP_DETAILS, false);
    }

    // ── 原生 Android ────────────────────────────────────────────────────────

    private static GuideStep stockBattery() {
        return new GuideStep(STEP_BATTERY,
                "电池优化（不受限制）",
                "Android 6+ 的 Doze 会在息屏后限制后台网络与定时任务，"
                        + "无障碍服务会被冻结、助手与 PC 掉线。放行后本应用在息屏时仍能工作。",
                Collections.<String>emptyList(),
                Collections.<String>emptyList(),
                FALLBACK_BATTERY_LIST, false);
    }

    private static GuideStep stockBackground() {
        return new GuideStep(STEP_BACKGROUND,
                "后台应用限制",
                "Android 13+ 可以在系统里限制某个应用在后台活动，限制后息屏即停止后台工作。",
                Collections.<String>emptyList(),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }

    private static GuideStep stockAutostart() {
        return new GuideStep(STEP_AUTOSTART,
                "自启动管理",
                "原生 Android 没有自启动开关，不需要设置。",
                Collections.<String>emptyList(),
                Collections.<String>emptyList(),
                FALLBACK_NONE, true);
    }

    /**
     * "允许受限设置"那一步（Android 13+ 侧载安装）。
     *
     * <p>它<b>没有</b>可直接跳转的 Activity：系统的"允许受限设置"藏在应用信息页
     * 右上角的溢出菜单里，系统没有对外的 Intent。因此这一步只能跳到应用详情页，
     * 再由文案告诉用户点哪里——这也正是它需要"图文步骤"而不是"去设置"按钮的原因。
     */
    public static GuideStep restrictedSettingsStep() {
        return new GuideStep(STEP_RESTRICTED,
                "允许受限设置",
                "侧载安装的 App 在 Android 13+ 默认处于「受限设置」，无障碍开关会被置灰、"
                        + "点不动。请在应用信息页点右上角菜单 →「允许受限设置」，"
                        + "回到无障碍设置里才能打开 khy-os 的开关。",
                Collections.<String>emptyList(),
                Collections.<String>emptyList(),
                FALLBACK_APP_DETAILS, false);
    }
}
