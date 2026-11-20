package com.khyos.khy_os_client.battery;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

/**
 * 无障碍掉线自检：拿系统侧的登记清单做比对，掉线就通知一次。
 *
 * <p><b>为什么要有它</b>：进程内的自述（{@code KhyAccessibilityService.instance != null}）
 * 看不见"用户在系统设置里把开关关了"这条路径——框架 unbind，instance 置空，
 * 于是桥一直安静地少一层能力，而用户以为一切正常，直到某次操作超时才发现。
 * 系统侧的 {@code getEnabledAccessibilityServiceList()} 是权威登记清单：开关一旦
 * 被关或被置灰，那里就没有本 App 的条目。
 *
 * <p><b>只在"从有到无"的那一刻通知一次</b>：持续失联时反复通知是骚扰。状态变化
 * 由本类自己记（静态字段），因此不依赖任何持久化。
 *
 * <p><b>边界（必须说清）</b>：
 *   - 判据只是"系统清单里还有没有本 App 的条目"，它<b>不区分</b>是用户主动关了
 *     还是系统冻结导致的。要区分还得看 App 内的开关状态，因此 UI 提示里写的是
 *     "已停止 / 被系统限制"，而不是"被系统偷偷关了"。
 *   - 本类只发通知、给一键跳转，<b>不</b>去替用户把开关写回去——那件事由
 *     {@code AccessibilitySetup} 负责，而且必须由用户点一下确认。
 */
public final class AccessibilitySelfCheck {

    private static final String TAG = "A11ySelfCheck";
    private static final String CHANNEL = "a11y_guard";
    private static final int NOTIF_ID = 0x4b48; // 'KH'

    /** 上一次观察到的"系统清单里有没有本 App"。null = 还没看过。 */
    private static volatile Boolean lastEnabled = null;

    private AccessibilitySelfCheck() {}

    /**
     * 纯逻辑：这次观察要不要发通知。
     *
     * <p>抽出来是为了可测——这一段的判断写反过一次（原实现把
     * "上一步是通的"当成"不通知"的条件，结果真掉线时反而静默），而它藏在
     * Android 上下文后面，JVM 测不到。规则只有三条：
     * <ul>
     *   <li>现在是通的 → 没什么可报；</li>
     *   <li>第一次看（{@code prev == null}）→ 不知道之前什么样，不报
     *       （否则从没开过无障碍的用户会被无缘无故通知）；</li>
     *   <li>上一步是通的、这一步不通 → 掉线，报。</li>
     * </ul>
     */
    static boolean shouldNotify(Boolean prev, boolean currentEnabled) {
        if (currentEnabled) return false;
        if (prev == null) return false;
        return prev.booleanValue();
    }

    /**
     * 做一次自检。
     *
     * @return true 表示"这次发现掉线，并且已经通知了用户"。
     */
    public static boolean checkAndNotify(Context c) {
        try {
            if (c == null) return false;
            boolean enabled = AccessibilityState.isEnabledInSystem(c);
            Boolean prev = lastEnabled;
            lastEnabled = Boolean.valueOf(enabled);
            if (!shouldNotify(prev, enabled)) return false;
            // 这里**不**要求 AccessibilitySetup.hasConsent()。那个 consent 记的是
            // "用户通过本 App 的开关开过无障碍"，而用户完全可能是在系统设置里
            // 开的（实测就是这样）——那种情况下服务从开变关同样是掉线，同样该
            // 通知。用 consent 当闸会让这类真掉线静默（实测踩到：服务被系统
            // 清掉后 30s 看守转一圈，通知没发出来）。
            // 不自动恢复（那件事归 AccessibilitySetup，且必须由用户点一下）。
            notifyLost(c);
            return true;
        } catch (Throwable t) {
            // 自检失败绝不影响调用方（它在看门狗线程里跑）。
            Log.w(TAG, "自检失败: " + t);
            return false;
        }
    }

    /** 供测试与诊断：当前观察到的系统侧状态（null = 未观察过）。 */
    public static Boolean lastEnabled() {
        return lastEnabled;
    }

    /** 重置观察状态（仅测试用）。 */
    public static void resetForTest() {
        lastEnabled = null;
    }

    private static void notifyLost(Context c) {
        String title = "khy-os 无障碍服务已停止";
        String text = "无障碍开关已不在系统的已启用列表里，助手将无法操作界面。"
                + "常见原因：被电池优化/后台限制冻结，或侧载安装的「受限设置」把开关置灰。"
                + "点此重新打开。";
        boolean posted = postNotification(c, title, text);
        if (!posted) {
            // 通知发不出去（13+ 未给 POST_NOTIFICATIONS，或用户关掉了渠道）时，
            // 至少让用户在屏幕上看到一句——否则这类故障依然是"凭空发生的"。
            //
            // 用自己的 Toast 而不是桥的 Tools.toastLong：那个方法是 bridge 包的
            // 包级可见，跨包调不到（也不该为一条提示去放宽它的可见性）。
            try {
                Toast.makeText(c, title + "：点 App 内「设备」页可重新打开无障碍。",
                        Toast.LENGTH_LONG).show();
            } catch (Throwable ignored) {
            }
        }
        Log.w(TAG, "检测到无障碍掉线，通知" + (posted ? "已发出" : "未发出（权限/渠道不可用）"));
    }

    /** 发一条带跳转 Intent 的通知；发不出去返回 false。 */
    private static boolean postNotification(Context c, String title, String text) {
        try {
            NotificationManager nm =
                    (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "无障碍守护",
                        NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("无障碍服务掉线时的提醒");
                nm.createNotificationChannel(ch);
            }
            Intent target = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getActivity(c, 0, target, flags);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
            b.setContentTitle(title)
                    .setContentText(text)
                    .setSmallIcon(android.R.drawable.stat_notify_error)
                    .setAutoCancel(true)
                    .setContentIntent(pi);
            nm.notify(NOTIF_ID, b.build());
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "通知发送失败: " + t);
            return false;
        }
    }
}
