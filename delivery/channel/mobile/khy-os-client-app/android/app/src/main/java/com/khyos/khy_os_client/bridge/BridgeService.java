package com.khyos.khy_os_client.bridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import com.khyos.khy_os_client.AccessibilitySetup;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.Arrays;

/**
 * 桥服务：HTTP + 文件信箱 + 自愈心跳 + 悬浮框联动。
 *
 * 由独立版 StepBridge v2.3.0 并入 khy-os 手机端。并入后新增的职责：
 *   - 启动/停止时连带拉起/撤掉悬浮框（BridgeOverlayService）——用户要求
 *     「工作时要存在悬浮框」。**但悬浮框现在是独立开关**：拉起要过
 *     BridgeOverlayService.isEnabled 这个用户偏好闸门（见 onCreate），撤掉只
 *     收「桥自己拉起的那个」，用户主动 show 的那颗不收回；
 *   - 自愈心跳每 10s 体检 accept 环（实测卡死形态：信箱心跳照写、HTTP 全
 *     超时，根因是旧实现每请求读 token 文件撞上存储 IO）；
 *   - 信箱命令走 cmd→processing→result 三态：改名占位后才执行，回执发布失败
 *     时保留 processing 不假装完成；遗留 processing 在启动时登记 recovered，
 *     运行期由 GC 兜底清理（契约原文见 assets/khy_bridge_guide.md 的 mailbox 主题）。
 *
 * 契约：前台服务（dataSync），START_STICKY；不抛。悬浮框与桥可各自存活：
 * 桥重建（冷启动 / 开机 / PC 唤醒）只把用户还想要的悬浮框拉回来，桥停掉时
 * 不收回用户显式 show 的那一颗。
 */
public class BridgeService extends Service {
    public static final String BRIDGE_DIR = "/sdcard/bridge-amoobridge";

    // The worker loop can legitimately block on a single mailbox command for up
    // to ~120s (exec's own cap), so "stale" must clear that bar — anything
    // shorter cries wolf during every long exec. Beyond it the loop stopped
    // ticking: frozen process or dead worker thread.
    private static final long HEARTBEAT_STALE_MS = 180_000L;

    // Mailbox GC leashes. The consumer deleting result_<id>.json after reading
    // it is the first-responsibility path (documented in the guide asset);
    // these are the server-side janitor for callers that never clean up.
    // processing gets the longest leash: a leftover there means the command's
    // side effects are unknown and must stay observable.
    // S1：保留期本身（result 24h / processing 72h / tmp 1h）只在
    // MailboxGcPolicy 里定义一次——那是契约边界，JVM 测试钉得住；这里只留节拍。
    private static final long GC_INTERVAL_MS = 60_000L;

    public static final String ACTION_START = "com.khyos.khy_os_client.bridge.START";
    public static final String ACTION_STOP = "com.khyos.khy_os_client.bridge.STOP";
    private volatile boolean running = false;
    private Thread worker;

    /**
     * 出向链路（断点一）跑在 Dart 侧。前台服务保证"不被随手杀"，但挡不住 CPU
     * 休眠：锁屏进 Doze 后唤醒源被掐，表现是 status.json 停更几十秒、
     * heartbeat_seq 不涨，而进程本身还活着。
     *
     * PARTIAL_WAKE_LOCK 只保 CPU 不亮屏。35 分钟单次覆盖 30 分钟验收窗口，
     * **到期不续**——常驻唤醒锁是另一种"看起来修好了"，代价是电。
     */
    private android.os.PowerManager.WakeLock wakeLock;
    private static volatile boolean wakeLockHeld = false;
    private static final long WAKE_LOCK_MS = 35L * 60L * 1000L;

    // Worker-loop heartbeat: bumped once per loop pass, read by HTTP /ping
    // cross-thread, hence static volatile.
    private static volatile long hbSeq = 0;
    private static volatile long hbTickMs = 0;
    // status.json 写失败累计。实测成因：未授「所有文件访问」时每拍 writeAtomic
    // 都 EACCES，而失败被 catch 整口吞掉——文件停在旧快照上，PC 的 probe 只读
    // 这一个文件，会把几小时前的现状当真。计数本身也经 HTTP /status 出去，
    // 那条路不碰盘，所以「写不进去」这件事终于有一个不依赖盘的见证者。
    private static volatile long statusWriteFailures = 0;
    // Leftover processing files registered once at startup (the mailbox
    // contract's recovered set). Their side effects are unknown: they are
    // reported, never replayed or deleted here.
    private JSONArray recoveredSnapshot = new JSONArray();
    // Mailbox queue depths from the last scan pass; the same thread publishes
    // them into status.json right after the scan. static volatile: HTTP /status
    // 在另一条线程读同一份快照（与 statusWriteFailures 同一理由）。
    private static volatile int mbPending = 0;
    private static volatile int mbProcessing = 0;
    private static volatile int mbResults = 0;
    private static volatile int mbTmp = 0;
    // S1：最老一条 result 的年龄（ms；-1 = 没有结果）与被 GC 丢弃的累计数。
    // dropped 必须和「被消费」分开——GC 兜底丢文件不是回执被取走。
    private static volatile long mbOldestResultAgeMs = -1L;
    private static volatile long mbDropped = 0;
    private static volatile long mbLastGcMs = 0;
    // 上一次循环看到的无障碍态。撤销是"从有到无"的一次跳变：只有跳变那一刻值得
    // 打扰用户，持续 false 时每 2s 弹一次是骚扰。
    private boolean uiStateKnown = false;
    private boolean uiWasReady = false;

    /** ms since the last loop tick; -1 before the first tick. */
    static long heartbeatAgeMs() {
        long t = hbTickMs;
        return t == 0 ? -1 : System.currentTimeMillis() - t;
    }

    static boolean heartbeatStale() {
        long age = heartbeatAgeMs();
        return age < 0 || age > HEARTBEAT_STALE_MS;
    }

    static long heartbeatSeq() { return hbSeq; }

    /** status.json 写失败累计；0 = 每拍都写成功了。 */
    static long statusWriteFailures() { return statusWriteFailures; }

    @Override
    public void onCreate() {
        super.onCreate();
        Tools.init(this);
        // Per-delivery stamp in logcat: every revival path (app cold start /
        // BootReceiver / ReviveReceiver PC wake) crosses onCreate, so one line
        // here witnesses which build actually ran on this device — including
        // when the APK was unpacked and its manifest strings renamed.
        Log.i("BridgeService", "canary " + HttpBridge.khyBuild());
        startForeground(1, buildNotification("khy-os 桥已启动", "HTTP 与信箱就绪"));
        // 共享层（断点三）：首启自建 /sdcard/khyos-sync + 默认配置。幂等，
        // 每次 onCreate 都过一遍——用户清过目录之后，下一次冷启就自己长回来。
        try {
            SyncStore.ensureLayout();
        } catch (Throwable t) {
            Log.w("BridgeService", "共享层布局失败: " + t);
        }
        acquireWakeLock();
        // 被系统清掉的无障碍服务，在用户有过授权记录时拉回来。
        //
        // 为什么补在 HttpBridge.start 之前：restoreIfConsented 今天的全部调用点
        // 只有 BootReceiver 的 ACTION_MY_PACKAGE_REPLACED 分支，而 force-stop 后
        // 进程死了、看守（startA11yWatchdog）也无从运行——于是桥活着、无障碍
        // 没了，每个 amoo_ask 都要等满整个预算才报一句 timeout。
        //
        // consent 门控保证「用户在 App 里关掉的」不会被这行复活：AccessibilitySetup.disable
        // 会连同意志标记一起清。另外两种情况它也直接返回 null——无 consent、
        // 以及设置还在、服务对象还活着（那是 ROM 的冻结态，归看守管）。
        AccessibilitySetup.restoreIfConsented(this);
        // 启动自检：把系统侧无障碍读数原样写进日志。status.json 每 2s 会带 ui 与
        // ui_reason，但「这次冷启时系统是什么状态」只有日志里有——排查「是不是
        // 一重启就没了」时，第一件事就是看这一行，而不是去猜快照。
        try {
            Tools.A11yState st = Tools.a11yState();
            Log.i("BridgeService", "a11y 自检：ui=" + Tools.uiReady()
                    + " settingReadOk=" + st.settingReadOk
                    + " settingListsUs=" + st.settingListsUs
                    + " masterOn=" + st.masterOn
                    + " frameworkReadOk=" + st.frameworkReadOk
                    + " frameworkListsUs=" + st.frameworkListsUs
                    + " raw=" + st.raw
                    + " reason=" + Tools.uiWhy());
        } catch (Throwable ignored) {
            // 自检读不到不拦启动：桥的其余能力与它无关
        }
        // 悬浮框是独立开关：只有用户还留着「要」才拉。三条重建路径（这里冷启动、
        // BootReceiver 开机、ReviveReceiver PC 唤醒）全走 onCreate，所以这一行
        // 就是那道闸——不过它，用户每次进 App、每次重启手机、每次 PC
        // `khy phone revive` 都会把刚关掉的悬浮框拉回来，开关等于一次性有效。
        if (BridgeOverlayService.isEnabled(this)) {
            BridgeOverlayService.start(this);
        }
        // 任务悬浮胶囊：独立于桥的开关（Dart 写 task_state.json，这里每 1s
        // 轮询），无任务/无授权时自己不画。三条重建路径都过 onCreate，所以
        // 这一行就是它的常驻保证。
        TaskStatusOverlayService.start(this);
        // 断点二：把 Context 交给桥——设备密钥对落 App 私有目录，只有 Context 拿得到。
        HttpBridge.start(HttpBridge.DEFAULT_PORT, this);
        // 锁屏冻结的自解冻泵（2026-11-15 实测：StepOS 锁屏 ≤20s 冻结全进程，
        // wakelock/白名单/FGS 都拦不住）。链条从这里起头，见 DeviceThawReceiver。
        DeviceThawReceiver.scheduleThawAlarm(this);
        Log.i("BridgeService", "thaw pump armed: " + DeviceThawReceiver.lastExactState());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopBridge();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            worker = new Thread(new Runnable() {
                public void run() { loop(); }
            }, "bridge-worker");
            worker.start();
            startA11yWatchdog();
        }
        return START_STICKY;
    }

    /**
     * 无障碍服务看守：发现它不再收事件就尝试拉活。
     *
     * 为什么需要：系统（StepOS/MIUI 派生）会冻结甚至停掉后台无障碍服务。
     * 停掉时 onDestroy 会跑，我们看得见；但**冻结**时对象还在、事件停收，
     * {@code KhyAccessibilityService.isReady()} 一直返回 true，于是手势和
     * 读气泡悄悄全废，而界面上一切都显示正常。判据只能是"最近还在收事件吗"。
     *
     * 怎么拉活：经 AccessibilitySetup.revive()，它内部走 uid 2000 的提权通道
     * （shell sidecar）。用户当初是自己打开这个开关的，这里只是把他的
     * 选择恢复回去——不是绕过什么。
     *
     * 边界（必须说清）：只对"被系统停掉/冻结"动手，冷启动（从未活过）不碰。
     * 另有一道 consent 闸，管的是用户在 App 内关掉开关后的那个竞态窗口——
     * disable() 清了设置，但框架要过一会儿才 unbind，这期间对象还活着、事件已停，
     * 正好命中上面的触发条件。细节见 reviveA11y() 的注释。
     *
     * 2026-10-28 之前这里是**自己拼 shell 整体赋值** enabled_accessibility_services，
     * 会把别人开的无障碍服务静默关掉。详见 reviveA11y() 的注释。
     */
    private void startA11yWatchdog() {
        Thread t = new Thread(new Runnable() {
            public void run() {
                while (running) {
                    try {
                        Thread.sleep(30000L);
                    } catch (InterruptedException dead) {
                        return;
                    }
                    if (!running) return;
                    try {
                        boolean wasReady = com.khyos.khy_os_client.KhyAccessibilityService
                                .Companion.isReady();
                        boolean alive = com.khyos.khy_os_client.KhyAccessibilityService
                                .Companion.isAlive();
                        if (wasReady && !alive) {
                            Log.w("BridgeService", "a11y 停在收事件，尝试拉活");
                            reviveA11y();
                        }
                    } catch (Throwable ignored) {
                        // 看守线程绝不因单次异常退出：它一停，上面这套就再没人做了
                    }
                    // 系统侧登记清单自检：进程内自述看不见"用户在系统设置里把开关
                    // 关了"这条路径（框架 unbind → instance 置空 → wasReady 不成立）。
                    // 这一道比对 getEnabledAccessibilityServiceList()，掉线时发一条
                    // 带跳转的通知。放在同一轮里，不新增线程、不新增定时器。
                    try {
                        // 注意用 BridgeService.this：这里的 this 是那个匿名
                        // Runnable 自己，不是 Service。
                        com.khyos.khy_os_client.battery.AccessibilitySelfCheck
                                .checkAndNotify(BridgeService.this);
                    } catch (Throwable ignored) {
                    }
                }
            }
        }, "bridge-a11y-watchdog");
        t.setDaemon(true);
        t.start();
    }

    /**
     * 经提权通道把用户的选择恢复回去。
     *
     * 2026-10-28 修正：旧实现自己拼了一条
     * {@code settings put secure enabled_accessibility_services <本服务>}——
     * 那是**整体赋值**，设备上其它已开的无障碍服务（TalkBack 算一个）会被静默
     * 关掉，而且没有任何提示。AccessibilitySetup 的文件头把「读-改-写」列为该类
     * 存在的理由（WHY READ-MODIFY-WRITE），而这里恰恰在违反它；同一个仓库里两个
     * 文件互相矛盾，改动的人看哪份都像真的。
     *
     * 旧实现还有第二个问题：没有 consent 门控。用户在 App 内关掉无障碍时
     * {@code AccessibilitySetup.disable()} 会清掉 consent，三十秒后看守又把它
     * 打开——那是把用户刚撤回的授权又塞回去。
     *
     * 现在委托 {@link AccessibilitySetup#revive}：consent 门控 + 读-改-写 + 写后
     * 校验，安全逻辑全部留在声明了它的那一处，桥这边不再自己拼 shell。
     *
     * consent 闸在这里管的是一个**竞态窗口**，不是「用户在系统设置里关掉」那种
     * 情况：用户在 App 内关无障碍时 disable() 清了设置和 consent，但框架要过一会儿
     * 才 unbind，KhyAccessibilityService 的 instance 在 onUnbind 里才置空——那段
     * 时间里对象还活着、事件已停，正好是上面的触发条件。没有这道闸，看守会把用户
     * 刚关掉的开关在三十秒内又打开。
     *
     * 而「用户在系统设置里关掉」根本到不了这里：那条路同样会 unbind，instance 置空，
     * 上面的 wasReady 判据就不成立。（真正观测不到系统设置操作的盲区在
     * restoreIfConsented 的重装路径上，与看守无关。）
     */
    private void reviveA11y() {
        try {
            AccessibilitySetup.Attempt a = AccessibilitySetup.revive(this);
            if (a == null) {
                Log.i("BridgeService", "a11y 拉活跳过：用户未通过本 App 开启过无障碍");
                return;
            }
            if (a.ok) {
                Log.i("BridgeService", "a11y 拉活指令已下发（经 " + a.via + "）");
            } else {
                Log.w("BridgeService", "a11y 拉活未成：" + a.reason);
            }
        } catch (Throwable ignored) {
            // 拉活失败不致命：下次巡检还会试
        }
    }

    /**
     * 运行期无障碍失联时提示一次。
     *
     * 为什么单独一条：现有的 30s 看守（{@link #startA11yWatchdog}）判据是
     * {@code wasReady && !alive}——"对象还在但停收事件"的冻结态。用户在系统设置里
     * 关掉开关、或系统撤销时，框架会 unbind，instance 被 {@code onUnbind} 置空，
     * {@code wasReady} 不成立，看守**看不见**这条路。于是桥一直安静地少一层能力，
     * 而 status.json 的 ui=false 又不带原因。2026-11-14 真机实测（R1R2/
     * repro-before.txt）：总开关被关掉之后，没有任何提示，用户只能下次冷启
     * 或自己进 App 才发现。
     *
     * 为什么不自动恢复：AccessibilitySetup 的文件头把这件事讲得很清楚——
     * "设置项缺失"分不清是安装器清掉的还是用户自己关的，静默重新授权就是
     * stalkerware 原型，那个类拒绝做。这里只负责让人知道，恢复交给用户点一下
     * （悬浮框那行「无障碍未开（点此恢复）」，或系统设置 → 无障碍）。
     */
    private void noticeA11yLost() {
        boolean uiNow = Tools.uiReady();
        if (uiStateKnown && uiWasReady && !uiNow) {
            String why = Tools.uiWhy();
            Log.w("BridgeService", "a11y 运行期失联：" + why);
            Tools.toastLong("无障碍服务已停止，ui_* 与截图暂不可用（" + why
                    + "）。恢复：点悬浮框里的「UI 能力」行，或系统设置 → 无障碍 → khy-os");
        }
        uiWasReady = uiNow;
        uiStateKnown = true;
    }

    private void stopBridge() {
        running = false;
        HttpBridge.stop();
        // 只收回桥自己拉起的那个。用户主动 show 的悬浮框不归桥管。
        BridgeOverlayService.stopWithBridge(this);
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        // 同 stopBridge：桥结束不等于悬浮窗该消失。
        BridgeOverlayService.stopWithBridge(this);
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void acquireWakeLock() {
        try {
            android.os.PowerManager pm =
                    (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            if (wakeLock == null) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "khyos:bridge");
                wakeLock.setReferenceCounted(false);
            }
            wakeLock.acquire(WAKE_LOCK_MS);
            wakeLockHeld = true;
            Log.i("BridgeService", "wake lock 已持有 " + (WAKE_LOCK_MS / 60000L) + " 分钟");
        } catch (Throwable t) {
            Log.w("BridgeService", "wake lock 获取失败: " + t);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Throwable ignored) {
        } finally {
            wakeLockHeld = false;
        }
    }

    /** 唤醒锁是否持有；status.json 的 {@code wake_lock} 读它，验收时不必猜。 */
    static boolean wakeLockHeld() { return wakeLockHeld; }

    private Notification buildNotification(String title, String text) {
        String ch = "bridge";
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel c = new NotificationChannel(ch, "khy-os 桥", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(c);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, ch) : new Notification.Builder(this);
        b.setContentTitle(title).setContentText(text)
         .setSmallIcon(android.R.drawable.stat_notify_sync).setOngoing(true);
        return b.build();
    }

    /**
     * 通知栏是否还能显示（Android 13+ 的 POST_NOTIFICATIONS 或用户手动关掉）。
     *
     * <p>为什么要问：配对码**只**经通知栏下发。权限没给时 {@code notify()}
     * 静默失败，接口照样回 ok，于是「码发不出去」在两端都表现成「你没看手机」。
     * 这个判据让调用方能在回执里直接说清原因。
     */
    public static boolean notificationsEnabled() {
        try {
            Context c = Tools.ctxRef();
            if (c == null) return false;
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            return nm != null && nm.areNotificationsEnabled();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * Post the pairing prompt: an inline reply for the code, plus a shortcut to
     * the wireless-debugging page.
     *
     * WHY IT LIVES IN THE SHADE (measured 2026-11-18). The pairing endpoint only
     * exists while the「使用配对码配对设备」dialog is on screen, and that dialog
     * dies as soon as the user switches to this app — the settings activity is
     * stopped, the service is unregistered, mDNS goes quiet. The notification
     * shade leaves it paused-but-visible, so it is the one place the user can
     * type the code without killing the thing they are pairing with.
     *
     * The two actions, in the order the user needs them:
     *   1. 跳转无线调试 — the shortcut the guide's step 1 asks for, reachable
     *      without opening the app at all.
     *   2. the inline reply — where the 6 digits go.
     */
    public static void notifyPairingPrompt() {
        try {
            Context c = Tools.ctxRef();
            if (c == null) return;
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String ch = "pairing";
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new NotificationChannel(ch, "配对", NotificationManager.IMPORTANCE_HIGH));
            }
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(c, ch) : new Notification.Builder(c);
            b.setSmallIcon(android.R.drawable.stat_notify_sync)
             .setContentTitle("输入配对码")
             .setContentText("保持系统「使用配对码配对设备」弹窗开着，在这里填那 6 位，点发送")
             .setOngoing(true)
             .setAutoCancel(false);

            // 1) 跳转无线调试：同一套回退链，UI 里那颗按钮在通知栏也有一个。
            Intent jump = new Intent(android.provider.Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS);
            jump.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            b.addAction(new Notification.Action.Builder(
                    null, "跳转无线调试",
                    android.app.PendingIntent.getActivity(c, 1, jump,
                            android.app.PendingIntent.FLAG_UPDATE_CURRENT
                                    | android.app.PendingIntent.FLAG_IMMUTABLE)).build());

            // 2) 内联输入。FLAG_MUTABLE 是 RemoteInput 的前提（API 31+ 强制）。
            android.content.ComponentName cn = new android.content.ComponentName(
                    c.getPackageName(), PairingCodeReceiver.class.getName());
            Intent reply = new Intent(PairingCodeReceiver.ACTION).setComponent(cn);
            int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) {
                flags |= android.app.PendingIntent.FLAG_MUTABLE;
            }
            android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(c, 2, reply, flags);
            android.app.RemoteInput ri = new android.app.RemoteInput.Builder(PairingCodeReceiver.KEY_CODE)
                    .setLabel("6 位配对码")
                    .build();
            b.addAction(new Notification.Action.Builder(
                    null, "发送配对码", pi).addRemoteInput(ri).build());

            nm.notify(PairingCodeReceiver.NOTIFICATION_ID, b.build());
        } catch (Throwable t) {
            // A failed prompt must not take the caller down; the in-app path
            // still exists and reports its own result.
        }
    }

    public static void notifyText(String title, String text) {
        // 时间取模的 id：同一次操作里的多条消息各自保留。配对码走的是
        // notifyText(title, text, id) 那条重载——它必须**替换**而不是堆积。
        notifyText(title, text, (int) (System.currentTimeMillis() % 100000));
    }

    /**
     * 带固定 id 的通知：同一 id 会替换上一条。
     *
     * <p>配对码必须走这条。用时间 id 时实测的后果是通知栏里堆着三四个「配对码
     * XXXXXX」，而 {@code ProvisioningCode.issue()} 每次只让最新那个有效——
     * 操作者看到四个码，随手挑一个，四个里有三个是废的，失败信息还叫「不匹配」。
     */
    public static void notifyText(String title, String text, int id) {
        try {
            Context c = Tools.ctxRef();
            if (c == null) return;
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new NotificationChannel("msg", "消息", NotificationManager.IMPORTANCE_DEFAULT));
            }
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(c, "msg") : new Notification.Builder(c);
            b.setContentTitle(title).setContentText(text)
             .setSmallIcon(android.R.drawable.stat_notify_chat).setAutoCancel(true);
            nm.notify(id, b.build());
        } catch (Throwable ignored) {}
    }

    private void loop() {
        File dir = new File(BRIDGE_DIR);
        if (!dir.exists()) dir.mkdirs();
        registerRecovered(dir);
        long lastStatus = 0;
        long lastHeal = 0;
        long lastGc = 0;
        while (running) {
            try {
                hbSeq++;
                long now = System.currentTimeMillis();
                hbTickMs = now;
                File[] files = dir.listFiles();
                int pending = 0, processing = 0, results = 0, tmps = 0;
                long oldestResultAge = -1;
                boolean gcDue = now - lastGc > GC_INTERVAL_MS;
                if (gcDue) lastGc = now;
                if (files != null) {
                    Arrays.sort(files);
                    // Count + GC on one pass over the snapshot; handling runs
                    // after, so the counts describe the queue as it stood, not
                    // a queue mid-drain.
                    for (File f : files) {
                        String n = f.getName();
                        long age = now - f.lastModified();
                        String kind = MailboxGcPolicy.kindOf(n);
                        if ("result".equals(kind)) {
                            results++;
                            // 最老一条 result 的年龄：消费方失约时，这是唯一
                            // 能看出「积压了多久」的数。
                            if (age > oldestResultAge) oldestResultAge = age;
                        } else if ("processing".equals(kind)) {
                            processing++;
                        } else if ("tmp".equals(kind)) {
                            tmps++;
                        } else if (n.startsWith("cmd_") && n.endsWith(".json")) {
                            pending++;
                            continue;
                        }
                        if (gcDue && kind != null && MailboxGcPolicy.isDue(kind, age)
                                && gcDelete(f, kind, age, now)) {
                            if ("result".equals(kind)) mbDropped++;
                        }
                    }
                    for (File f : files) {
                        String n = f.getName();
                        if (n.startsWith("cmd_") && n.endsWith(".json")) handle(f);
                    }
                }
                mbPending = pending;
                mbProcessing = processing;
                mbResults = results;
                mbTmp = tmps;
                mbOldestResultAgeMs = oldestResultAge;
                noticeA11yLost();
                if (now - lastStatus > 2000) {
                    lastStatus = now;
                    writeStatus();
                }
                // 自愈：accept 环意外死亡时重启（信箱心跳照写但 HTTP 全超时，
                // 就是这个实测卡死形态）。
                if (now - lastHeal > 10000) {
                    lastHeal = now;
                    try { HttpBridge.ensureRunning(HttpBridge.DEFAULT_PORT); } catch (Throwable ignored) {}
                    // 补授权后把内存令牌补写到盘上：写盘失败期间 PC 侧一直 401，
                    // 而 ensureToken/start 都不会再试——只有这里能让它自愈。
                    try { HttpBridge.retryPersist(); } catch (Throwable ignored) {}
                    // 可用性也在这里重探：装/卸一个助手 App 是运行期真的会变的
                    // 一件事，而 status.json 与悬浮框读的都是缓存。放在这条已有
                    // 的 10s tick 上，而不是新建一个线程——它已经是后台路径。
                    try { Tools.refreshAvailability(); } catch (Throwable ignored) {}
                }
                Thread.sleep(120);
            } catch (Throwable t) {
                try { Thread.sleep(500); } catch (InterruptedException ignored) {}
            }
        }
    }

    private void writeStatus() {
        try {
            JSONObject o = new JSONObject();
            o.put("running", running);
            o.put("ts", System.currentTimeMillis());
            o.put("pid", android.os.Process.myPid());
            o.put("http_port", HttpBridge.port());
            o.put("mode", "app");
            o.put("ui", Tools.uiReady());
            // 为什么 ui 旁边必须跟一句原因：status.json 是 PC 侧 probe 唯一读的
            // 文件，而 ui=false 有四种成因（从未开启 / 刚被撤销 / 总开关关闭 /
            // 框架未重绑），处置一个都不一样。2026-11-14 真机实测（R1R2/
            // repro-before.txt）：总开关被关掉，ui=false 却不带任何原因，
            // 读文件的人只能猜。
            o.put("ui_reason", Tools.uiWhy());
            o.put("canWrite", new File(BRIDGE_DIR).canWrite());
            // 断点二：明文令牌已停写。这个字段保留成恒 false，是为了让还在读它的
            // 旧调用方看到「没落盘」而不是「字段消失」——字段消失会让 PC 侧把
            // 缺省值当成 false 之外的别的东西，行为反而不可预测。真正的身份状态
            // 看下面的 identity 块。
            o.put("token_persisted", HttpBridge.persisted());
            o.put("token_retired", true);
            try {
                o.put("identity", DeviceIdentity.status(this));
            } catch (Throwable t) {
                o.put("identity", new org.json.JSONObject().put("ok", false)
                        .put("code", "identity_unavailable").put("why", String.valueOf(t)));
            }
            // 当前生效的 driver（五取值：amoo-direct | amoo-screen | local |
            // pc-bridge | script，算法在 CapabilitySnapshot.driverNow）。status.json
            // 是 PC 侧 probe 唯一读的文件——driver 只放 info 里的话，探测方就看不到
            // 「选了 amoo、实际在读屏」这种最需要被看见的状态。
            o.put("driver", CapabilitySnapshot.driverNow(this));
            // PC 是否在协作：桥只绑 loopback + adb forward，进来的鉴权请求只可能来自 PC。
            // App 据此决定显示「协作中」还是「独立工作」——不是故障，是两种正常模式。
            o.put("pc_reachable", HttpBridge.pcReachable());
            o.put("pc_idle_ms", HttpBridge.pcIdleMs());
            // 出向链路与心跳分开统计（断点一）：link 说「走的是哪条路」，
            // last_pong_ms 说「这条路最后一次有回音是什么时候」，
            // reconnect_count 说「这条路上断过几次」。
            //
            // 为什么必须与 heartbeat 分开：heartbeat_seq/age 描述的是本机自愈
            // 循环还活着（它不需要任何人参与），而这三项描述的是与对端的往返。
            // 合成一个数，就会出现「心跳在涨，于是以为链路活着」——正是本轮要
            // 修的那个误判。
            o.put("link", BridgeLinkState.link());
            o.put("last_pong_ms", BridgeLinkState.lastPongMs());
            o.put("reconnect_count", BridgeLinkState.reconnectCount());
            // 鉴权结果（断点二）：link=file 有两种截然不同的原因——「没配 endpoint」
            // 和「连上了但服务端不认我」。只看 link 分不出来，PC 侧就会一直重连、
            // 一直不知道为什么。auth 说状态，auth_code 说服务端给的理由。
            o.put("link_auth", BridgeLinkState.authState());
            o.put("auth_code", BridgeLinkState.authCode());
            // 唤醒锁与共享层：两个都"看不见就验不了"。前者决定锁屏期间链路
            // 能不能继续跑，后者决定共享层有没有被首启建起来。
            o.put("wake_lock", wakeLockHeld);
            o.put("sync_dir", SyncStore.DIR);
            o.put("sync_exists", new File(SyncStore.DIR).isDirectory());
            // Same heartbeat fields as HTTP /ping: status.json is what the PC
            // probe actually reads, so /ping alone would leave it blind.
            o.put("heartbeat_seq", heartbeatSeq());
            o.put("heartbeat_age_ms", heartbeatAgeMs());
            o.put("heartbeat_stale", heartbeatStale());
            try {
                o.put("ver", getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
            } catch (Throwable ignored) {}
            // 可用集而不是全量 NAMES。status.json 是 phoneBridgeClient.probe()
            // 唯一读的文件，只改 HTTP /status 的话 PC 侧拿不到可用性信号。
            //
            // 改数组语义是安全的：parseBridgeStatus（amooBridgePolicy.js:449-478）
            // 在生产里零调用方，没有任何地方按「全量」推断过什么。
            //
            // withheld 与 HTTP /status 同形（Tools.withheld() 的缓存副本），
            // names 与 withheld 同源，不会一个说 36 另一个列 8 个。
            //
            // 读缓存而不是现探，两个理由：这条路径每 2s 跑一次，现探要 8 次
            // getPackageInfo；更重要的是缓存形永不上抛——现探的 withheld() 是受检
            // 异常，一旦抛出会被这个方法的 catch(Throwable) 整口吞掉，结果是
            // status.json 停在旧内容上不再更新，而 probe() 只看到一个陈旧的快照。
            // 缓存由下面 loop() 的 10s 自愈 tick 刷，最多旧一个周期。
            JSONArray a = new JSONArray();
            for (String t : Tools.availableNamesCached()) a.put(t);
            o.put("tools", a);
            o.put("withheld", Tools.withheldCached());
            // Queue depths from the last scan pass: the caller's view of
            // backpressure. A deep pending queue means the loop is busy with a
            // long command, not that the bridge died. S1: the same block also
            // carries the oldest result age and the GC-dropped count, and HTTP
            // /status serves the identical snapshot (one source, two faces).
            o.put("mailbox", mailboxSnapshot());
            // S4：提权档位 / 设备鉴权 / 前台违规（含来源）。与 HTTP /status
            // 同一份取值——两个状态面各拼一套就会漂。字段展开成顶层键，
            // 与 info 的扁平形状一致（PC 侧读的是同名键，不套一层壳）。
            JSONObject elevation = elevationStatus(this);
            java.util.Iterator<String> ek = elevation.keys();
            while (ek.hasNext()) {
                String k = ek.next();
                o.put(k, elevation.opt(k));
            }
            // Recovered leftovers registered at startup: claimed-but-outcome-
            // unknown commands. Report only; never replayed or deleted here.
            o.put("recovered", recoveredSnapshot);
            // 写失败累计随文件一起出去：读到这个数非 0，就该知道这份快照的
            // 新鲜度本身就不可信（它是在失败 N 次之后才落成的）。
            o.put("status_write_failures", statusWriteFailures);
            writeAtomic(new File(BRIDGE_DIR, "status.json"), o.toString());
        } catch (Throwable ignored) {
            // 数一下：文件没写成，但「没写成」这件事必须能在别处被看见。
            statusWriteFailures++;
        }
    }

    /**
     * Startup registration of leftover processing_<id>.json files — the mailbox
     * contract's recovered set. These commands were claimed but their outcome
     * is unknown: report id/tool/age/args-presence only (the args body is never
     * parsed), keep the file, replay nothing. The caller must check side
     * effects via the id's result file or the UI itself.
     */
    private void registerRecovered(File dir) {
        JSONArray out = new JSONArray();
        File[] files = dir.listFiles();
        if (files != null) {
            Arrays.sort(files);
            long now = System.currentTimeMillis();
            for (File f : files) {
                if (out.length() >= 20) break;
                String n = f.getName();
                if (!n.startsWith("processing_") || !n.endsWith(".json")) continue;
                try {
                    JSONObject e = new JSONObject()
                            .put("id", n.substring("processing_".length(), n.length() - 5))
                            .put("tool", "")
                            .put("age_ms", now - f.lastModified())
                            .put("args_present", false)
                            .put("side_effects", "unknown");
                    try {
                        JSONObject cmd = new JSONObject(readText(f, 16 * 1024));
                        e.put("tool", cmd.optString("tool", ""))
                         .put("args_present", cmd.has("args") && !cmd.isNull("args"));
                    } catch (Throwable ignored) {
                        // Unreadable envelope: report what the filename tells, nothing more.
                    }
                    out.put(e);
                } catch (Throwable ignored) {
                    // A registration failure must not take the worker loop down.
                }
            }
        }
        recoveredSnapshot = out;
    }

    /**
     * The mailbox id lives in the FILENAME, never in the body: the caller
     * polls result_<id>.json by the name it wrote, so a body disagreeing with
     * the filename would publish a receipt nobody ever reads.
     */
    private static boolean isValidMailboxId(String id) {
        if (id == null || id.length() < 1 || id.length() > 128) return false;
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z')
                    || (c >= 'A' && c <= 'Z') || c == '_' || c == '-';
            if (!ok) return false;
        }
        return true;
    }

    private void gcDelete(File f, String kind, long ageMs) {
        if (f.delete()) {
            Log.i("BridgeService", "信箱 GC：删除 " + kind + " 文件 " + f.getName()
                    + "（已 " + (ageMs / 60000) + " 分钟无人处理）");
        }
    }

    /**
     * GC 删除 + 审计（S1）。删除成功才记审计：gc_audit.jsonl 一行一条
     * MailboxGcPolicy.auditJson（只有 op/ts/kind/name/age_ms 元数据，不含任何
     * 回执正文——GC 是丢弃不是消费，审计不能变成第二份内容出口）。审计写失败
     * 只计数，不影响删除本身。
     *
     * @return 是否真的删除了（调用方据此累加 dropped）
     */
    private boolean gcDelete(File f, String kind, long ageMs, long nowMs) {
        if (!f.delete()) return false;
        mbLastGcMs = nowMs;
        Log.i("BridgeService", "信箱 GC：删除 " + kind + " 文件 " + f.getName()
                + "（已 " + (ageMs / 60000) + " 分钟无人处理）");
        try {
            File audit = new File(BRIDGE_DIR, MailboxGcPolicy.AUDIT_FILE);
            FileOutputStream out = null;
            try {
                out = new FileOutputStream(audit, true);
                out.write((MailboxGcPolicy.auditJson(nowMs, kind, f.getName(), ageMs) + "\n")
                        .getBytes("UTF-8"));
                out.flush();
            } finally {
                if (out != null) {
                    try { out.close(); } catch (Throwable ignored) { /* best effort */ }
                }
            }
        } catch (Throwable ignored) {
            // 审计落不了盘时 dropped 计数（status.json）仍在：不能因为审计
            // 失败就把「丢过文件」这件事藏起来。
        }
        return true;
    }

    /** GC 已丢弃的累计条数（GC ≠ 消费）；HTTP /status 与 status.json 同源。 */
    static long mailboxDropped() { return mbDropped; }

    /** status.mailbox 快照（S1）：两处状态面共用一份取值，不再各拼各的。 */
    static JSONObject mailboxSnapshot() {
        try {
            return new JSONObject()
                    .put("pending", mbPending).put("processing", mbProcessing)
                    .put("results", mbResults).put("tmp", mbTmp)
                    .put("oldest_result_age_ms", mbOldestResultAgeMs)
                    .put("dropped", mbDropped)
                    .put("last_gc_ms", mbLastGcMs);
        } catch (Throwable t) {
            return new JSONObject();
        }
    }

    /**
     * S4：提权档位、设备鉴权、前台违规——status.json 与 HTTP /status 共用这一份。
     *
     * 为什么必须共用：info 早就在报 elevated / device_auth，而 status.json
     * （PC probe 唯一读的文件）三十个顶层键里一个都没有——三个状态面各说各的，
     * 正是 ui_reason 与 mailbox 那两次立过的教训。
     *
     * 取值全部零 IO，可上每 2s 的 ticker：
     *   elevated    = CapabilitySnapshot.elevatedChannelNow()（缓存的开关+就绪，
     *                 与 info/exec 同源；不拿 sidecar 就绪冒充档位，见 T8）
     *   device_auth = ElevationState.deviceAuth（SharedPreferences）
     *   违规计数    = AmooLoop 的内存计数器（刻意不落盘，与 reconnect_count 同口径）
     *
     * 「后两项恒为 0」在没有违规时就是 foreground_violations=0、
     * last_violation=0（来源空串）；拉起被拦一次就 +1，来源写进
     * last_violation_source。
     */
    static JSONObject elevationStatus(Context c) {
        String elevated = "none";
        try {
            elevated = CapabilitySnapshot.elevatedChannelNow();
        } catch (Throwable ignored) {}
        // 没有 Context（JVM 单测 / 服务未起）时这一进程没有任何配对可谈，
        // 报 unpaired 而不是编一个 paired。
        String auth = com.khyos.khy_os_client.shell.ElevationState.AUTH_UNPAIRED;
        if (c != null) {
            try {
                auth = com.khyos.khy_os_client.shell.ElevationState.deviceAuth(c);
            } catch (Throwable ignored) {}
        }
        long violations = 0L;
        long lastMs = 0L;
        String lastSource = "";
        try {
            violations = AmooLoop.foregroundViolations();
            lastMs = AmooLoop.lastViolationMs();
            lastSource = AmooLoop.lastViolationSource();
        } catch (Throwable ignored) {}
        try {
            return new JSONObject()
                    .put("elevated", elevated)
                    .put("device_auth", auth)
                    .put("foreground_violations", violations)
                    .put("last_violation", lastMs)
                    .put("last_violation_source", lastSource);
        } catch (Throwable t) {
            return new JSONObject();
        }
    }

    private void handle(File f) {
        String name = f.getName();
        String id = name.substring(4, name.length() - 5);
        if (!isValidMailboxId(id)) {
            // Never claimed, so never executed and no side effects. It cannot
            // get a result under a conforming name either, and keeping it
            // would re-fail every 120ms forever.
            Log.w("BridgeService", "信箱命令丢弃（文件 " + name + "）：id 不合规范（须 1-128 位字母/数字/下划线/短横线），未执行、无副作用");
            try { f.delete(); } catch (Throwable ignored) {}
            return;
        }
        File processing = new File(BRIDGE_DIR, "processing_" + id + ".json");
        File resultFile = new File(BRIDGE_DIR, "result_" + id + ".json");
        if (processing.exists()) {
            // Leftover processing = this id was claimed before and its outcome
            // is unknown (registered as recovered at startup). Re-running would
            // replay non-idempotent work — refuse and point at the checks. An
            // existing result_<id>.json is the receipt of that earlier claim;
            // the rejection must never overwrite it.
            if (!resultFile.exists()) {
                JSONObject reject = new JSONObject();
                try {
                    reject.put("ok", false)
                          .put("id", id).put("ts", System.currentTimeMillis())
                          .put("code", "duplicate_id")
                          .put("error", "同 id 已有遗留的 processing_" + id + ".json（上次执行结果未知）：先读 result_" + id + ".json 或核对界面副作用，确认后删除该遗留文件再发新命令")
                          .put("action_dispatched", false)
                          .put("replay_safe", false)
                          .put("retry_safe", false);
                    writeAtomic(resultFile, reject.toString());
                } catch (Throwable t) {
                    Log.w("BridgeService", "duplicate_id 回执发布失败（result_" + id + ".json）：" + t.getClass().getSimpleName()
                            + "；新命令已丢弃未执行，遗留 processing_" + id + ".json 保留，上次命令结果仍未知、副作用需核对");
                }
            }
            try { f.delete(); } catch (Throwable ignored) {}
            return;
        }
        if (!f.renameTo(processing)) {
            // Transient storage failure: the cmd file stays and the next 120ms pass retries.
            return;
        }
        JSONObject result;
        String tool = "";
        JSONObject args = new JSONObject();
        boolean dispatched = false;
        JSONObject callChain = null;
        try {
            JSONObject cmd = new JSONObject(readText(processing, 1024 * 512));
            String bodyId = cmd.optString("id", id);
            tool = cmd.optString("tool", "");
            if (!bodyId.equals(id)) {
                result = HttpBridge.invalidArguments("信箱命令被拒绝：正文 id（" + bodyId + "）与文件名 id（" + id + "）不一致。修复：两者一致后重写 cmd_" + id + ".json", "mailbox");
            } else if (CallChain.isEnvelope(cmd)) {
                // 调用链信封（B6）：先过护栏再派发。护栏拒时什么都没到工具层，
                // 三个幂等字段恒 false（K-24）；放行才从 payload 里取 tool/args。
                callChain = cmd;
                JSONObject payload = cmd.optJSONObject("payload");
                if (payload != null) tool = payload.optString("tool", "");
                CallChain.Verdict verdict = CallChain.admit(cmd);
                if (!verdict.admitted) {
                    Log.i("BridgeService", "调用链拒绝 trace=" + cmd.optString("trace_id")
                            + " msg=" + cmd.optString("msg_id") + " depth=" + cmd.optInt("depth")
                            + " code=" + verdict.code);
                    result = CallChain.receipt(verdict);
                } else {
                    Log.i("BridgeService", "调用链放行 trace=" + cmd.optString("trace_id")
                            + " msg=" + cmd.optString("msg_id") + " depth=" + cmd.optInt("depth")
                            + " seq=" + cmd.optInt("seq") + " 已用 "
                            + CallChain.usedCalls(cmd.optString("trace_id")) + "/"
                            + CallChain.MAX_CALLS_PER_TRACE + " 次");
                    args = payload != null && payload.optJSONObject("args") != null
                            ? payload.optJSONObject("args") : new JSONObject();
                    if (tool.length() == 0) {
                        result = HttpBridge.invalidArguments("调用链信封被拒绝：payload 缺 tool 或 tool 为空。修复：payload 形状为 {\"tool\":\"工具名\",\"args\":{...}}，工具表读 GET /agent-guide?topic=schema", "schema");
                    } else {
                        result = Tools.dispatch(tool, args);
                        dispatched = true;
                        // Same boundary enrichment as HTTP /call: the guide's unknown-
                        // tool receipt promise holds on both channels.
                        HttpBridge.markUnknownTool(result);
                    }
                }
            } else if (tool.length() == 0) {
                result = HttpBridge.invalidArguments("缺 tool 字段：信箱命令形状为 {\"id\",\"tool\",\"args\"}。修复：补上工具名（可用清单读 GET /agent-guide）后重写 cmd_" + id + ".json", "schema");
            } else if (cmd.has("args") && cmd.optJSONObject("args") == null) {
                result = HttpBridge.invalidArguments("args 必须是 JSON 对象：信箱命令形状为 {\"id\",\"tool\",\"args\"}。修复：把 args 改为对象后重写 cmd_" + id + ".json，每工具参数细节读 GET /agent-guide?topic=schema", "schema");
            } else {
                if (cmd.has("args")) args = cmd.optJSONObject("args");
                result = Tools.dispatch(tool, args);
                dispatched = true;
                // Same boundary enrichment as HTTP /call: the guide's unknown-
                // tool receipt promise holds on both channels.
                HttpBridge.markUnknownTool(result);
            }
        } catch (Throwable t) {
            result = new JSONObject();
            try {
                result.put("ok", false).put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
            } catch (Throwable ignored) {}
        }
        try {
            result.put("id", id);
            if (tool.length() > 0) result.put("tool", tool);
            result.put("ts", System.currentTimeMillis());
            // Boundary truth for the caller's replay decision: dispatched=false
            // means nothing reached the tool layer; retry is only safe for a
            // read-only tool that answered ok. ok=false is never retry-safe —
            // whether a failed tool acted first is not knowable here.
            result.put("action_dispatched", dispatched);
            boolean read = dispatched && result.optBoolean("ok", false) && isReadOnlyCall(tool, args);
            result.put("replay_safe", read);
            result.put("retry_safe", read);
            // 调用链信封的回执回显三字段（判据【B6】：每跳回显同一个 trace_id，
            // parent_span 链可反推回根）。扁平命令没有这三个字段，不补。
            if (callChain != null) CallChain.echoTrace(result, callChain);
        } catch (Throwable ignored) {}
        try {
            writeAtomic(resultFile, result.toString());
        } catch (Throwable t) {
            // A receipt that cannot be written (disk full / IO error) must not
            // be mistaken for success. Keep the processing file: "processing
            // present, result absent" is the observable that says unconfirmed —
            // deleting it would pretend the command never ran.
            Log.w("BridgeService", "回执发布失败（result_" + id + ".json）：" + t.getClass().getSimpleName()
                    + "；保留 processing_" + id + ".json，命令未确认完成、副作用需核对");
            return;
        }
        try { processing.delete(); } catch (Throwable ignored) {}
    }

    /**
     * Tools whose re-run cannot change device state. Mutating args of the dual
     * tools (level/value/op) flip them to false; anything not listed here is
     * treated as mutating — an unknown tool must never be called safe.
     */
    private static boolean isReadOnlyCall(String tool, JSONObject args) {
        if (tool.equals("volume")) return !args.has("level");
        if (tool.equals("brightness")) return !args.has("value");
        if (tool.equals("clipboard")) return !"set".equals(args.optString("op", "get"));
        if (tool.equals("amoo_memory")) return !"set".equals(args.optString("op", "get"));
        // 抓包改写族（断点五）。判据是「重放会不会改变什么」，按调用逐个算，
        // 不给整族开绿灯：
        //   · status / net_rule_list 只读内存状态——重放无副作用（拆分后 replay_safe
        //     的判据从「一个工具＋一个 op」变成「一个工具名」）；
        //   · start / stop 改运行位与 ttl，net_rule_set/delete/clear 改规则表
        //     （set 还会重置 ttl 与命中账）——重放它们不是无副作用；
        //   · export 每次往 /sdcard/khyos-evidence 写一个新文件，重放即多一份
        //     导出物。标成 replay_safe 会让调用方自动重试，那正是本字段要防的事。
        if (tool.equals("net_capture_status") || tool.equals("net_capture_list")
                || tool.equals("net_rule_list")) {
            return true;
        }
        // 共享层（断点三）同理：status/read/verify 只读，append/delete/export 会写盘。
        if (tool.equals("sync_status") || tool.equals("sync_read")
                || tool.equals("sync_verify")) {
            return true;
        }
        return tool.equals("ping") || tool.equals("info") || tool.equals("tools")
                || tool.equals("ls") || tool.equals("read") || tool.equals("stat")
                || tool.equals("list_apps") || tool.equals("battery")
                || tool.equals("loop_status") || tool.equals("amoo_result")
                || tool.equals("secret_list") || tool.equals("ui_dump")
                || tool.equals("shot") || tool.equals("shot_b64");
    }

    private String readText(File f, int max) throws Exception {
        FileInputStream in = new FileInputStream(f);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) {
            bo.write(b, 0, n);
            if (bo.size() >= max) break;
        }
        in.close();
        return new String(bo.toByteArray(), "UTF-8");
    }

    private void writeAtomic(File f, String content) throws Exception {
        File tmp = new File(f.getAbsolutePath() + ".tmp");
        FileOutputStream fo = new FileOutputStream(tmp);
        fo.write(content.getBytes("UTF-8"));
        fo.flush();
        fo.getFD().sync();
        fo.close();
        if (!tmp.renameTo(f)) {
            f.delete();
            tmp.renameTo(f);
        }
    }

    /** 供 MainActivity / Dart 通道调用的启动入口。 */
    public static void start(Context c) {
        Intent i = new Intent(c, BridgeService.class);
        i.setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    public static void stop(Context c) {
        Intent i = new Intent(c, BridgeService.class);
        i.setAction(ACTION_STOP);
        try { c.startService(i); } catch (Throwable ignored) {}
    }
}
