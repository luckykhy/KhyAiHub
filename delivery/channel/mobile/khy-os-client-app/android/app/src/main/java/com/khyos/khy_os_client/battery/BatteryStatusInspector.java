package com.khyos.khy_os_client.battery;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

/**
 * 电池 / 后台运行状态检测器。
 *
 * <p><b>总契约：永不抛</b>。检测是"提示与引导"的前置，不是主流程的前置——
 * 任何一次 API 变动、权限缺失、ROM 差异都必须降级成一个保守的默认值，
 * 而不是把异常抛到调用方。调用方（本 App 的通道层）拿到的一定是
 * {@link BatteryStatus}，不会是异常。
 *
 * <p>各项的判据与它们的"不确定性"：
 * <ul>
 *   <li>{@code isIgnoringBatteryOptimizations}：{@code PowerManager}（API 23+），
 *       精确可信；本 App 的 minSdk 高于 23。</li>
 *   <li>{@code isBackgroundRestricted}：{@code ActivityManager}（API 28+），
 *       精确可信；更低版本返回 false（"没有被限制"），并在 UI 上按版本说明。</li>
 *   <li>{@code autostartState}：无标准 API，见 {@link AutostartProbe}，
 *       大多数机型是 unknown。</li>
 *   <li>{@code restrictedSettingsLikely}：Android 13+ 侧载安装且无障碍开关
 *       未登记时判"疑似"。系统没有公开"这个开关被置灰了"的查询接口，
 *       所以只能给"疑似"，UI 必须照实说"疑似"而不是"就是"。</li>
 * </ul>
 */
public final class BatteryStatusInspector {

    private static final String TAG = "BatteryGuard";

    private BatteryStatusInspector() {}

    /**
     * 取一次完整快照。
     *
     * @return 一定非 null；任何一项取不到就降级成该项的保守默认值。
     */
    public static BatteryStatus inspect(Context c) {
        if (c == null) {
            return new BatteryStatus("", false, false,
                    BatteryStatus.AutostartState.UNKNOWN, false, System.currentTimeMillis());
        }
        String manufacturer = normalizeManufacturer(Build.MANUFACTURER);
        boolean ignoring = isIgnoringBatteryOptimizations(c);
        boolean bgRestricted = isBackgroundRestricted(c);
        BatteryStatus.AutostartState autostart = AutostartProbe.probe(c, manufacturer);
        boolean restricted = isRestrictedSettingsLikely(c);
        BatteryStatus st = new BatteryStatus(manufacturer, ignoring, bgRestricted,
                autostart, restricted, System.currentTimeMillis());
        // 用 I 而不是 D：release 构建里 Log.d 会被 R8 的 assume-no-side-effects
        // 剥掉。这行是排障时唯一能回答"App 当时到底看到了什么"的证据
        //（用户报"无障碍又掉了"，第一件事就是看这行），不能只在 debug 版里有。
        Log.i(TAG, "inspect: " + st);
        return st;
    }

    /** 厂商名归一：去空白、转小写。空值归一成空串。 */
    static String normalizeManufacturer(String raw) {
        if (raw == null) return "";
        return raw.trim().toLowerCase();
    }

    /**
     * 本 App 是否已在系统电池优化白名单里。
     *
     * <p>{@code isIgnoringBatteryOptimizations} 自 API 23 起可用，本 App 的
     * minSdk 已高于它，因此这里不需要版本分支——但仍留一个 try/catch：某些 ROM
     * 的 PowerManager 实现会在别的进程上抛 {@code SecurityException}，
     * 那种情况下按"未放行"处理（提示用户去放行是安全的默认）。
     */
    public static boolean isIgnoringBatteryOptimizations(Context c) {
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return false;
            return pm.isIgnoringBatteryOptimizations(c.getPackageName());
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 是否处于后台受限状态。
     *
     * <p>{@code ActivityManager.isBackgroundRestricted()} 自 API 28 起可用；
     * 更低的系统没有这个概念，返回 false（"没被限制"），UI 按系统版本说明，
     * 不让用户去找一个不存在的开关。
     */
    public static boolean isBackgroundRestricted(Context c) {
        try {
            if (Build.VERSION.SDK_INT < 28) return false;
            ActivityManager am = (ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return false;
            return am.isBackgroundRestricted();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 是否"疑似受限设置"（Android 13+ 侧载 + 无障碍开关未登记）。
     *
     * <p>三项同时成立才判疑似：
     * <ol>
     *   <li>Android 13+：受限设置是 13 才引入的机制；</li>
     *   <li>侧载安装：应用商店装的 App 不受限；</li>
     *   <li>本 App 的无障碍服务不在系统已启用清单里——否则开关是亮的，
     *       不存在"被置灰"这回事。</li>
     * </ol>
     *
     * <p>为什么不给 100%：系统没有"该开关被置灰"的公开查询。adb 装的应用
     * （来源 {@code com.android.shell}）也落进"侧载"这一支，这是对的——
     * 13+ 上 adb 装的包同样需要手动解除受限设置。
     */
    public static boolean isRestrictedSettingsLikely(Context c) {
        try {
            if (Build.VERSION.SDK_INT < 33) return false;
            if (!AutostartProbe.isSideloaded(c)) return false;
            return !AccessibilityState.isEnabledInSystem(c);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 通知权限是否已授予（Android 13+ 才有运行时权限）。
     *
     * <p>为什么要单列：引导通知发不出去时，通知权限没授是最常见的原因，
     * 而它的表现是"通知凭空消失"，很难查。
     */
    public static boolean hasNotificationPermission(Context c) {
        try {
            if (Build.VERSION.SDK_INT < 33) return true;
            return c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return true;
        }
    }
}
