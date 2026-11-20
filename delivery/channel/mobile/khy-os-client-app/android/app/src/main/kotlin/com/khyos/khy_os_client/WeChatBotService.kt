package com.khyos.khy_os_client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * WeChat bot channel keep-alive shell: a dataSync foreground service whose only
 * job is holding the process alive while the Dart-side ilink long-poll loop
 * (lib/core/ilink/) runs inside it.
 *
 * Why a shell and not the poll itself: the poll is pure Dart/HTTP and belongs
 * to the Flutter isolate where the account state lives; splitting it into a
 * native loop would fork credentials, cursor and allowlist into a second
 * storage world. The service owns no protocol state — stop the service and the
 * channel dies with the process, start it and Dart resumes from disk.
 *
 * Registration shape mirrors .bridge.BridgeService (dataSync
 * foregroundServiceType, START_STICKY, startForegroundService on O+);
 * FOREGROUND_SERVICE / FOREGROUND_SERVICE_DATA_SYNC / POST_NOTIFICATIONS /
 * WAKE_LOCK are already declared in the manifest for the bridge.
 */
class WeChatBotService : Service() {

    companion object {
        private const val TAG = "WeChatBotService"
        const val ACTION_START = "com.khyos.khy_os_client.wechat.START"
        const val ACTION_STOP = "com.khyos.khy_os_client.wechat.STOP"

        @Volatile
        private var running = false

        @JvmStatic
        fun isRunning(): Boolean = running

        /** Same start shape as BridgeService.start: O+ requires startForegroundService. */
        @JvmStatic
        fun start(c: Context) {
            val i = Intent(c, WeChatBotService::class.java)
            i.setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i)
            else c.startService(i)
        }

        @JvmStatic
        fun stop(c: Context) {
            val i = Intent(c, WeChatBotService::class.java)
            i.setAction(ACTION_STOP)
            try {
                c.startService(i)
            } catch (ignored: Throwable) {
                // App already in background on some ROMs — stop via the
                // Dart side calling stopService next launch instead.
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        startForeground(1, buildNotification())
        running = true
        Log.i(TAG, "keep-alive up; Dart-side ilink poll owns the actual work")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent != null && ACTION_STOP == intent.getAction()) {
            stopSelf()
            return START_NOT_STICKY
        }
        // Sticky: a ROM kill mid-poll gets the shell back; Dart resumes the
        // cursor from disk on next launch.
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val ch = "wechat_bot"
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(ch, "微信机器人通道", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val b: Notification.Builder = if (Build.VERSION.SDK_INT >= 26)
            Notification.Builder(this, ch)
        else
            Notification.Builder(this)
        b.setContentTitle("微信机器人在线")
            .setContentText("长轮询运行中,保持后台连接")
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setOngoing(true)
        return b.build()
    }
}
