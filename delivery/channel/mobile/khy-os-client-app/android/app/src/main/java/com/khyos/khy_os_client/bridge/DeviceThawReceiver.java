// khy-canary: Khy-1.1.40+25-202611151316-QJBAC0S7
package com.khyos.khy_os_client.bridge;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * 锁屏冻结的自解冻泵（Doze 实测的产物，2026-11-15 本机实测）。
 *
 * <p>实测（PZ261A / StepOS，锁屏态）：锁屏后 ≤20s 内整个进程停调度——
 * utime/stime 零增长、status.json 停更、worker 循环与 Dart 重连循环全部停摆。
 * 当时已有的三道保险（deviceidle user 白名单、前台 dataSync 服务、
 * PARTIAL_WAKE_LOCK）以及本轮补的 RUN_ANY_IN_BACKGROUND allow 与
 * `dumpsys deviceidle disable`，都拦不住它。{@code HEARTBEAT_STALE_MS} 的
 * 180s 判定在这种冻结面前不是"阈值不合适"，而是"进程根本没得跑"。
 *
 * <p>能穿过冻结的通道是精确闹钟：系统要投递 {@code setExactAndAllowWhileIdle}
 * 的广播，就必须解冻进程。到点解冻的那一小段窗口里，worker 循环与 BridgeLink
 * 会自己跑起来（心跳落盘、重连、ping/pong），跑完再被冻——链路靠这些碎片
 * 窗口活着。onReceive 里续排下一发，链条由 {@link BridgeService#onCreate} 起头，
 * BootReceiver 的三条重建路径都会经过。
 *
 * <p>权限：targetSdk 36 上 {@code SCHEDULE_EXACT_ALARM} 默认拒绝，但设备
 * 电池优化白名单内的应用自动获得（本应用已在 user 白名单，实测见日志）。
 * 不能排精确闹钟时退 {@code setAndAllowWhileIdle}——弱一点，但比没有强。
 *
 * <p>边界：这是保活泵，不是业务逻辑。它只续排自己；心跳/重连仍归 worker 与
 * BridgeLink，冻结期错过的指令仍由服务端重投（msg_id 幂等兜底）。
 */
public class DeviceThawReceiver extends BroadcastReceiver {
    public static final String ACTION_THAW = "com.khyos.khy_os_client.bridge.THAW_TICK";

    /** 下一次解冻的间隔。20s：与 worker 2s 拍、link 15s 心跳同一量级，又不至于闹钟风暴。 */
    static final long THAW_INTERVAL_MS = 20_000L;

    private static volatile String lastExactState = "";

    @Override
    public void onReceive(Context c, Intent intent) {
        try {
            if (ACTION_THAW.equals(intent == null ? null : intent.getAction())) {
                Log.d("DeviceThaw", "thaw tick");
            }
        } catch (Throwable ignored) {
            // 任何异常都不允许断掉续排：断一发 = 冻结期链路死透
        }
        scheduleThawAlarm(c);
    }

    /**
     * 排下一发解冻闹钟。幂等：同一 requestCode + FLAG_UPDATE_CURRENT 覆盖旧请求，
     * 反复调用不会堆积。放 static 供 {@link BridgeService} 与本类共用一条链。
     */
    public static void scheduleThawAlarm(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(c, DeviceThawReceiver.class);
            i.setAction(ACTION_THAW);
            PendingIntent pi = PendingIntent.getBroadcast(
                    c, 0, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            long at = System.currentTimeMillis() + THAW_INTERVAL_MS;
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                lastExactState = "inexact(allowWhileIdle)";
            } else {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                lastExactState = "exact(allowWhileIdle)";
            }
        } catch (Throwable t) {
            Log.w("DeviceThaw", "schedule failed: " + t);
        }
    }

    /** 诊断面：当前走的是精确还是退路。 */
    public static String lastExactState() {
        return lastExactState;
    }
}
