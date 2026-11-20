package com.khyos.khy_os_client.battery;

import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 引导层的"去设置"动作：把一步引导真的送到对应的系统/厂商设置页。
 *
 * <p><b>总契约：永不抛、永不卡</b>。每条路径都是"逐个候选试 → 全失败退兜底页
 * → 再失败如实回报"，任何一步失败都只影响这一步，不影响其余步骤，更不影响主流程。
 *
 * <p>为什么必须有多级退路：厂商改 Activity 名、系统拦截请求 Intent、侧载包
 * 触发"受限设置"灰开关——这三种情况在真机上都会发生，而且没有任何一个能被
 * 提前知道。所以策略是"多候选 + 兜底 + 如实回报"，而不是"猜一个跳转目标"。
 */
public final class BatteryGuidance {

    private static final String TAG = "BatteryGuard";

    private BatteryGuidance() {}

    /**
     * 当前机型该走的引导步骤清单。
     *
     * @param status 本次检测到的状态；"疑似受限设置"时额外插入"允许受限设置"那一步。
     */
    public static List<BatteryGuideCatalog.GuideStep> stepsFor(Context c, BatteryStatus status) {
        String manufacturer = "";
        int sdk = Build.VERSION.SDK_INT;
        try {
            manufacturer = BatteryStatusInspector.normalizeManufacturer(Build.MANUFACTURER);
        } catch (Throwable ignored) {
        }
        List<BatteryGuideCatalog.GuideStep> steps =
                new ArrayList<BatteryGuideCatalog.GuideStep>(
                        BatteryGuideCatalog.stepsFor(manufacturer, sdk));
        // 受限设置那一步只在"疑似"时才出现：没这回事的时候提它，
        // 只会让用户去应用信息页找一个他看不到的菜单项。
        if (status != null && status.restrictedSettingsLikely) {
            steps.add(0, BatteryGuideCatalog.restrictedSettingsStep());
        }
        return steps;
    }

    /**
     * 带"是否已完成"状态的步骤清单（给引导页渲染）。
     *
     * <p>"完成"有两种来源，UI 上要能区分：
     * <ul>
     *   <li>{@code detected}：系统状态查得到（已在电池白名单、自启动已允许、
     *       未被后台限制）；</li>
     *   <li>{@code manual}：用户自己点了「已完成」（有些状态系统不告诉应用，
     *       例如受限设置被解除后没有公开的查询接口）。</li>
     * </ul>
     * 手动打勾只改提示层，不改任何系统设置。
     */
    public static List<Map<String, Object>> stepsWithState(Context c, BatteryStatus status) {
        List<BatteryGuideCatalog.GuideStep> steps = stepsFor(c, status);
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        for (BatteryGuideCatalog.GuideStep s : steps) {
            Map<String, Object> m = new HashMap<String, Object>();
            m.put("id", s.id);
            m.put("title", s.title);
            m.put("why", s.why);
            m.put("components", new ArrayList<String>(s.components));
            m.put("actions", new ArrayList<String>(s.actions));
            m.put("fallback", s.fallback);
            m.put("optional", s.optional);
            boolean detected = isDetectedDone(c, s.id, status);
            boolean manual = !detected && BatteryPromptStore.isStepDone(c, s.id);
            m.put("done", detected || manual);
            m.put("doneBy", detected ? "detected" : (manual ? "manual" : ""));
            out.add(m);
        }
        return out;
    }

    /** 这一步是否能从系统状态直接判定为"已完成"。 */
    private static boolean isDetectedDone(Context c, String stepId, BatteryStatus st) {
        if (st == null) return false;
        try {
            if (BatteryGuideCatalog.STEP_BATTERY.equals(stepId)) {
                return st.isIgnoringBatteryOptimizations;
            }
            if (BatteryGuideCatalog.STEP_AUTOSTART.equals(stepId)) {
                return st.autostartState == BatteryStatus.AutostartState.ALLOWED;
            }
            if (BatteryGuideCatalog.STEP_BACKGROUND.equals(stepId)) {
                return !st.isBackgroundRestricted;
            }
            if (BatteryGuideCatalog.STEP_RESTRICTED.equals(stepId)) {
                return !st.restrictedSettingsLikely
                        && AccessibilityState.isEnabledInSystem(c);
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    /**
     * 打开某一步引导对应的设置页。
     *
     * @param stepId 步骤 id（见 {@link BatteryGuideCatalog} 的 STEP_* 常量）
     * @return {@code {opened, via, message}}；{@code opened=false} 时 {@code message}
     *         是给用户看的中文说明，{@code via} 说明试过/走了哪条路。
     */
    public static Map<String, Object> openStep(Context c, String stepId) {
        Map<String, Object> out = new HashMap<String, Object>();
        out.put("opened", false);
        out.put("via", "");
        out.put("message", "");
        if (c == null || stepId == null || stepId.isEmpty()) {
            out.put("message", "步骤 id 为空");
            return out;
        }
        BatteryStatus status = BatteryStatusInspector.inspect(c);
        List<BatteryGuideCatalog.GuideStep> steps = stepsFor(c, status);
        BatteryGuideCatalog.GuideStep target = null;
        for (BatteryGuideCatalog.GuideStep s : steps) {
            if (s.id.equals(stepId)) {
                target = s;
                break;
            }
        }
        if (target == null) {
            out.put("message", "当前机型没有这一步：" + stepId);
            return out;
        }
        if (target.optional) {
            out.put("message", target.why);
            out.put("via", "skip");
            return out;
        }

        // 1) 候选组件，逐个试。
        for (String comp : target.components) {
            if (startComponent(c, comp)) {
                out.put("opened", true);
                out.put("via", comp);
                out.put("message", "已打开：" + target.title);
                return out;
            }
        }

        // 1b) 候选 action，逐个试。action 与 component 是两条不同的路：
        // 实测 StepOS 上 AutoStartActivity（component）被权限拦死，而
        // background_manager_settings（action）能打开——只留一条就白扔一条。
        for (String action : target.actions) {
            if (startAction(c, new Intent(action))) {
                out.put("opened", true);
                out.put("via", action);
                out.put("message", "已打开：" + target.title);
                return out;
            }
        }

        // 2) 兜底页。
        String fallback = target.fallback;
        if (BatteryGuideCatalog.FALLBACK_BATTERY_LIST.equals(fallback)) {
            if (startAction(c, new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) {
                out.put("opened", true);
                out.put("via", "battery_optimization_list");
                out.put("message", "厂商入口没找到，已打开系统的「电池优化」应用列表");
                return out;
            }
        } else if (BatteryGuideCatalog.FALLBACK_APP_DETAILS.equals(fallback)) {
            if (startAppDetails(c)) {
                out.put("opened", true);
                out.put("via", "app_details");
                out.put("message", "厂商入口没找到，已打开本应用的信息页");
                return out;
            }
        } else if (BatteryGuideCatalog.FALLBACK_ACCESSIBILITY.equals(fallback)) {
            if (startAction(c, new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))) {
                out.put("opened", true);
                out.put("via", "accessibility_settings");
                out.put("message", "已打开系统的无障碍设置");
                return out;
            }
        }

        out.put("via", "none");
        out.put("message", "这台机器上找不到「" + target.title
                + "」的入口。可手动打开「设置 → 应用 → khy-os」查看电池与权限选项。");
        return out;
    }

    /**
     * 一键请求加入电池优化白名单。
     *
     * <p>首选 {@code ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS}（系统弹窗里
     * 一键放行）；部分 ROM 的安全中心会拦下这个跳转或改道到二级页，此时退到
     * {@code ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS}（应用列表，用户自己点）。
     *
     * <p>注意：系统弹窗的结果<b>无法</b>在这里读到（弹窗是系统进程的），
     * 所以回执只表示"已经把用户送到该去的页面"，实际是否放行要靠返回后重新检测
     * （{@link BatteryStatusInspector#inspect}）来判定。
     */
    public static Map<String, Object> requestIgnoreBatteryOptimizations(Context c) {
        Map<String, Object> out = new HashMap<String, Object>();
        out.put("opened", false);
        out.put("via", "");
        out.put("message", "");
        if (c == null) {
            out.put("message", "没有上下文");
            return out;
        }
        try {
            Intent req = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            req.setData(Uri.parse("package:" + c.getPackageName()));
            req.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(req);
            out.put("opened", true);
            out.put("via", "request_ignore_battery_optimizations");
            out.put("message", "已请求加入电池优化白名单");
            return out;
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "request intent 被系统/安全中心拦下: " + e.getMessage());
        } catch (SecurityException e) {
            Log.w(TAG, "request intent 被安全策略拒绝: " + e.getMessage());
        } catch (Throwable t) {
            Log.w(TAG, "request intent 失败: " + t);
        }
        // 回退：应用列表。
        try {
            Intent list = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(list);
            out.put("opened", true);
            out.put("via", "battery_optimization_list");
            out.put("message", "一键请求没能弹出，已打开系统的「电池优化」应用列表，请在其中找到 khy-os 并选「不受限制」");
            return out;
        } catch (Throwable t) {
            Log.w(TAG, "battery list fallback 失败: " + t);
        }
        out.put("via", "none");
        out.put("message", "这台机器打不开电池优化页面，可手动到「设置 → 应用 → khy-os → 电池」设为「不受限制」。");
        return out;
    }

    /** 跳到本 App 的应用详情页。 */
    public static boolean startAppDetails(Context c) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + c.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "打开应用详情页失败: " + t);
            return false;
        }
    }

    /** 跳到系统的无障碍设置。 */
    public static boolean startAccessibilitySettings(Context c) {
        try {
            Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "打开无障碍设置失败: " + t);
            return false;
        }
    }

    /** 试一个 {@code pkg/cls} 组件；失败（不存在/被拦）返回 false，不抛。 */
    private static boolean startComponent(Context c, String component) {
        try {
            int slash = component.indexOf('/');
            if (slash <= 0) return false;
            String pkg = component.substring(0, slash);
            String cls = component.substring(slash + 1);
            Intent i = new Intent();
            i.setComponent(new ComponentName(pkg, cls));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            return true;
        } catch (ActivityNotFoundException e) {
            Log.d(TAG, "组件不存在: " + component);
        } catch (SecurityException e) {
            Log.d(TAG, "组件被拒绝: " + component + " (" + e.getMessage() + ")");
        } catch (Throwable t) {
            Log.d(TAG, "组件跳转失败: " + component + " (" + t + ")");
        }
        return false;
    }

    /** 试一个普通 Intent；失败返回 false，不抛。 */
    private static boolean startAction(Context c, Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            return true;
        } catch (Throwable t) {
            Log.d(TAG, "Intent 跳转失败: " + i.getAction() + " (" + t + ")");
            return false;
        }
    }
}
