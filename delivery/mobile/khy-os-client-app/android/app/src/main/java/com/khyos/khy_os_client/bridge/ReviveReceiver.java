// khy-canary: Khy-20261101-017-NMEMV9V2
package com.khyos.khy_os_client.bridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;

import com.khyos.khy_os_client.KhyAccessibilityService;

/**
 * 导出的唤醒入口。PC 侧 `khy phone revive` 发这条广播把桥拉起来——
 * 比 monkey 干净（不起界面、不依赖 AMS 的 top-most 记录）。
 * 动作名带包名前缀，动作：com.khyos.khy_os_client.bridge.REVIVE。
 *
 * 唤醒后另有一项检查，见 {@link #ensureAccessibility(Context)}：
 * Android 在 force-stop 应用时会顺手把
 * Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES 里本服务的条目清掉，
 * 于是桥被唤活了、HTTP 与全部工具俱全，但 ui_dump / ui_tap / shot 等
 * 依赖无障碍的能力全部失效（/status 报 ui:false）。这是实测踩到的坑。
 * （工具数不写死在这里——它以 Tools.NAMES.length 为准，写数字只会再次过期。）
 */
public class ReviveReceiver extends BroadcastReceiver {
    public static final String ACTION_REVIVE = "com.khyos.khy_os_client.bridge.REVIVE";

    /** 固定 id：反复唤醒只替换通知，不堆叠。 */
    private static final int NOTIFY_A11Y = 0x62A11;
    /** Distinct id from NOTIFY_A11Y: one says "broken", the other says "fixed". */
    private static final int NOTIFY_A11Y_RESTORED = 0x62A12;

    @Override
    public void onReceive(Context c, Intent intent) {
        try {
            BridgeService.start(c);
        } catch (Throwable ignored) {}
        try {
            HttpBridge.ensureRunning(HttpBridge.DEFAULT_PORT);
        } catch (Throwable ignored) {}
        ensureAccessibility(c);
    }

    /**
     * 无障碍是否还开着的唯一可靠判据是 secure 设置本身，不是实例是否存活：
     * force-stop 后实例必然为 null，但「设置被清」才是根因，两者要分开看，
     * 否则会把根因和现象混为一谈。
     *
     * 设置里的条目有两种写法，都认：
     *   pkg/.ShortName          例如 com.khyos.khy_os_client/.KhyAccessibilityService
     *   pkg/fqn.Name            例如 com.khyos.khy_os_client/com.khyos.khy_os_client.KhyAccessibilityService
     * 多个服务用英文冒号分隔。
     */
    public static boolean isAccessibilityEnabled(Context c) {
        try {
            String enabled = Settings.Secure.getString(
                c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (enabled == null || enabled.length() == 0) return false;
            String pkg = c.getPackageName();
            String fqn = KhyAccessibilityService.class.getName();
            String shortName = fqn.substring(fqn.lastIndexOf('.') + 1);
            for (String entry : enabled.split(":")) {
                entry = entry.trim();
                if (entry.startsWith(pkg)
                        && (entry.endsWith("/." + shortName) || entry.endsWith("/" + fqn))) {
                    return true;
                }
            }
            return false;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * Tell the user the accessibility service was just restored on their behalf.
     *
     * WHY A NOTIFICATION AND NOT SILENCE. Restoring means the app re-granted
     * itself the ability to read every screen and synthesize input. Doing that
     * quietly — even to restore a choice the user made — is the kind of thing
     * that makes a user uninstall the app when they find out. So it is always
     * announced, with the channel that performed the write named, because "it
     * came back by itself" is the one explanation that is never acceptable.
     *
     * @param via which elevation channel executed the write: sidecar / shizuku
     */
    public static void notifyA11yRestored(Context c, String via) {
        try {
            NotificationManager nm =
                (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new NotificationChannel(
                    "a11y", "无障碍恢复", NotificationManager.IMPORTANCE_HIGH));
            }
            // Tapping it lands on the accessibility settings page, where the
            // switch is now visibly ON. Not a dismiss-and-forget: the user
            // should be able to confirm the claim in this notification.
            Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(
                c, 1, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(c, "a11y")
                : new Notification.Builder(c);
            b.setContentTitle("无障碍服务已恢复")
             .setContentText("更新/重装后系统清掉了这个授权，已按你之前的选择恢复"
                     + (via == null || via.isEmpty() ? "" : "（经 " + via + "）")
                     + "。点此查看，不需要可随时关掉。")
             .setSmallIcon(android.R.drawable.stat_notify_sync)
             .setAutoCancel(true)
             .setContentIntent(pi);
            nm.notify(NOTIFY_A11Y_RESTORED, b.build());
        } catch (Throwable ignored) {}
    }

    /**
     * 桥唤醒了但无障碍授权被系统清掉时，发一条可点的通知，一键跳到无障碍设置页。
     *
     * 历史备注：这段最初的理由是「写不了 Settings.Secure，所以只能通知」。
     * **那个理由已经不成立**——AccessibilitySetup 后来证明 uid 2000（shell
     * sidecar 或 Shizuku）能写 enabled_accessibility_services 并且立即生效。
     * 现在这里是**没有提权通道时**的降级路径：恢复不了，就至少让人一键去开，
     * 而不是让 UI 工具静默失效（PC 侧只看到 ui:false，分不清是被清了还是没授权过）。
     */
    public static void ensureAccessibility(Context c) {
        try {
            NotificationManager nm =
                (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            // 授权已恢复就撤掉之前可能还挂着的提示：通知是 setAutoCancel(true)，
            // 只在被点时消失，不主动撤的话用户修好了它还挂在那儿说"已失效"，
            // 那是又一个误导信号。
            if (isAccessibilityEnabled(c)) {
                nm.cancel(NOTIFY_A11Y);
                return;
            }
            // 设置读不到但实例还活着（极少见），说明能力其实在，别打扰用户。
            if (KhyAccessibilityService.Companion.isReady()) return;

            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new NotificationChannel(
                    "a11y", "无障碍恢复", NotificationManager.IMPORTANCE_HIGH));
            }
            Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(
                c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(c, "a11y")
                : new Notification.Builder(c);
            b.setContentTitle("khy-os 桥已唤醒，但 UI 能力已失效")
             .setContentText("系统清除了无障碍授权，点此重新开启，恢复 ui_dump / ui_tap / shot 等工具")
             .setSmallIcon(android.R.drawable.stat_notify_error)
             .setAutoCancel(true)
             .setContentIntent(pi);
            nm.notify(NOTIFY_A11Y, b.build());
        } catch (Throwable ignored) {}
    }
}
