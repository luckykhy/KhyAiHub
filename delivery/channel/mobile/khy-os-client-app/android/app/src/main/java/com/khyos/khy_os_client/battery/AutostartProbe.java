package com.khyos.khy_os_client.battery;

import android.app.AppOpsManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import java.lang.reflect.Method;

/**
 * 自启动状态探测（尽力而为，判不出就是 unknown）。
 *
 * <p><b>为什么没有一行标准 API</b>：Android 从来没有提供"应用能否自启动"的查询
 * 接口。各家 ROM 各自实现（MIUI 的 AppOps 扩展、ColorOS 的安全中心、vivo 的
 * 权限管理器……），入口、类名、语义随版本变，没有任何一个可以依赖。
 *
 * <p><b>因此本类的契约是"永不抛、永不猜"</b>：
 *   - 任何反射/调用异常一律吞掉并返回 {@link BatteryStatus.AutostartState#UNKNOWN}；
 *   - 拿不到明确结论时返回 UNKNOWN，绝不返回 DENIED（假阴性会让用户去关一个
 *     本来就开着的开关，代价是真事）。
 *
 * <p>目前只有 MIUI / HyperOS 系有较稳定的探法（隐藏的 {@code AppOps} 操作码
 * {@code OP_AUTO_START = 10000}）。其余厂商一律 UNKNOWN——UI 必须把 UNKNOWN
 * 讲成"要去厂商页自己看一眼"，而不是"已关闭"。
 */
final class AutostartProbe {

    private AutostartProbe() {}

    /**
     * MIUI 的自启动 AppOps 操作码。厂商扩展，非 AOSP 常量。
     * 取值 10000 来自 MIUI 各版本的 {@code AppOpsManager} 扩展区。
     */
    private static final int MIUI_OP_AUTO_START = 10000;

    /** AppOps 返回值：允许。 */
    private static final int MODE_ALLOWED = 0;
    /** AppOps 返回值：忽略（即被关掉）。 */
    private static final int MODE_IGNORED = 1;

    /**
     * 探测自启动状态。
     *
     * @return 永不返回 null；判不出来就是 {@code UNKNOWN}。
     */
    static BatteryStatus.AutostartState probe(Context c, String manufacturer) {
        if (c == null || manufacturer == null) return BatteryStatus.AutostartState.UNKNOWN;
        try {
            if (isMiuiFamily(manufacturer)) {
                BatteryStatus.AutostartState s = probeMiui(c);
                if (s != BatteryStatus.AutostartState.UNKNOWN) return s;
            }
            // 其余厂商：没有可靠的公开探法。
            // 这里刻意**不**去猜各家隐藏 op 的编号——猜错会得到一个语义完全
            // 不同的 AppOps 结果（比如读成"读日志是否允许"），比 unknown 更有害。
            return BatteryStatus.AutostartState.UNKNOWN;
        } catch (Throwable t) {
            // 探测失败不是错误路径，是常态路径。
            return BatteryStatus.AutostartState.UNKNOWN;
        }
    }

    /** MIUI / HyperOS 系。 */
    static boolean isMiuiFamily(String manufacturer) {
        if (manufacturer == null) return false;
        String m = manufacturer.toLowerCase();
        // 注意：StepOS / StepX **不在**这一支里。实机（2026-11-15, PZ261A）上它的
        // 系统包命名空间是 com.stepos.*，没有 com.miui.*，MIUI 的 AppOps 扩展
        // 探法对它不成立——归错家族只会得到一个语义无关的 AppOps 结果。
        return m.startsWith("xiaomi") || m.startsWith("redmi") || m.startsWith("poco");
    }

    /**
     * MIUI 探法：{@code AppOpsManager.checkOpNoThrow(int, int, String)}（隐藏 API）
     * 配 {@code OP_AUTO_START = 10000}。
     *
     * <p>Android 14+ 的非 SDK 接口限制可能让反射直接失败——那正是 UNKNOWN 的
     * 正确归宿，不做任何绕过。
     */
    private static BatteryStatus.AutostartState probeMiui(Context c) {
        try {
            AppOpsManager aom = (AppOpsManager) c.getSystemService(Context.APP_OPS_SERVICE);
            if (aom == null) return BatteryStatus.AutostartState.UNKNOWN;
            Method m = null;
            try {
                m = AppOpsManager.class.getMethod("checkOpNoThrow", int.class, int.class, String.class);
            } catch (Throwable ignored) {
                // 隐藏 API 不可达（Android 14+ 常见）→ UNKNOWN
            }
            if (m == null) return BatteryStatus.AutostartState.UNKNOWN;
            m.setAccessible(true);
            Object mode = m.invoke(aom, Integer.valueOf(MIUI_OP_AUTO_START),
                    Integer.valueOf(uidOf(c)), c.getPackageName());
            if (!(mode instanceof Integer)) return BatteryStatus.AutostartState.UNKNOWN;
            int v = ((Integer) mode).intValue();
            if (v == MODE_ALLOWED) return BatteryStatus.AutostartState.ALLOWED;
            if (v == MODE_IGNORED) return BatteryStatus.AutostartState.DENIED;
            // MODE_DEFAULT / 其它：ROM 没给这个 op 明确结论。
            return BatteryStatus.AutostartState.UNKNOWN;
        } catch (Throwable t) {
            return BatteryStatus.AutostartState.UNKNOWN;
        }
    }

    /** 取本 App 的 uid；取不到时返回 -1（探针会因此得到 unknown）。 */
    private static int uidOf(Context c) {
        try {
            return c.getApplicationInfo().uid;
        } catch (Throwable t) {
            return -1;
        }
    }

    /**
     * 本 App 是否为侧载安装（不是从应用商店装的）。
     *
     * <p>Android 13+ 只对侧载安装的 App 施加"受限设置"（无障碍开关被置灰，
     * 需要用户到 App 信息页的溢出菜单里手动"允许受限设置"）。
     *
     * <p>判据取安装来源包名：应用商店（{@code com.android.vending}）与 Google
     * 反馈应用（{@code com.google.android.feedback}）装的不受限；adb 安装的
     * 来源是 {@code com.android.shell}，属于侧载，同样受限。
     */
    static boolean isSideloaded(Context c) {
        try {
            if (Build.VERSION.SDK_INT < 30) return false;
            String installer = c.getPackageManager()
                    .getInstallSourceInfo(c.getPackageName())
                    .getInstallingPackageName();
            if (installer == null) return true; // 无来源记录：按侧载处理（更保守）
            return !("com.android.vending".equals(installer)
                    || "com.google.android.feedback".equals(installer));
        } catch (Throwable t) {
            // 老系统没有这个 API；PackageManager.NameNotFoundException 也走这里。
            return false;
        }
    }

    /** 便于测试：包是否装得上。 */
    static boolean isPackageInstalled(Context c, String pkg) {
        try {
            PackageManager pm = c.getPackageManager();
            pm.getPackageInfo(pkg, 0);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
