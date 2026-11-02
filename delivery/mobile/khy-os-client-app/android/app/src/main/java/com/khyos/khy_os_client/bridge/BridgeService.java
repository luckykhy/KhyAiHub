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
 *     超时，根因是旧实现每请求读 token 文件撞上存储 IO）。
 *
 * 契约：前台服务（dataSync），START_STICKY；不抛。悬浮框与桥可各自存活：
 * 桥重建（冷启动 / 开机 / PC 唤醒）只把用户还想要的悬浮框拉回来，桥停掉时
 * 不收回用户显式 show 的那一颗。
 */
public class BridgeService extends Service {
    public static final String BRIDGE_DIR = "/sdcard/bridge-amoobridge";
    public static final String ACTION_START = "com.khyos.khy_os_client.bridge.START";
    public static final String ACTION_STOP = "com.khyos.khy_os_client.bridge.STOP";
    private volatile boolean running = false;
    private Thread worker;

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
        // 悬浮框是独立开关：只有用户还留着「要」才拉。三条重建路径（这里冷启动、
        // BootReceiver 开机、ReviveReceiver PC 唤醒）全走 onCreate，所以这一行
        // 就是那道闸——不过它，用户每次进 App、每次重启手机、每次 PC
        // `khy phone revive` 都会把刚关掉的悬浮框拉回来，开关等于一次性有效。
        if (BridgeOverlayService.isEnabled(this)) {
            BridgeOverlayService.start(this);
        }
        HttpBridge.start(HttpBridge.DEFAULT_PORT);
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
     * （shell sidecar / Shizuku）。用户当初是自己打开这个开关的，这里只是把他的
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
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

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

    public static void notifyText(String title, String text) {
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
            nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
        } catch (Throwable ignored) {}
    }

    private void loop() {
        File dir = new File(BRIDGE_DIR);
        if (!dir.exists()) dir.mkdirs();
        long lastStatus = 0;
        long lastHeal = 0;
        while (running) {
            try {
                File[] files = dir.listFiles();
                if (files != null) {
                    Arrays.sort(files);
                    for (File f : files) {
                        String n = f.getName();
                        if (n.startsWith("cmd_") && n.endsWith(".json")) handle(f);
                    }
                }
                long now = System.currentTimeMillis();
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
            o.put("canWrite", new File(BRIDGE_DIR).canWrite());
            // 令牌是否在盘上——PC 侧只认 token.txt，写盘失败时桥看着在线、每个
            // 请求却 401。透出去让设备页与 `khy phone probe` 各给一句可操作提示。
            o.put("token_persisted", HttpBridge.persisted());
            // PC 是否在协作：桥只绑 loopback + adb forward，进来的鉴权请求只可能来自 PC。
            // App 据此决定显示「协作中」还是「独立工作」——不是故障，是两种正常模式。
            o.put("pc_reachable", HttpBridge.pcReachable());
            o.put("pc_idle_ms", HttpBridge.pcIdleMs());
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
            writeAtomic(new File(BRIDGE_DIR, "status.json"), o.toString());
        } catch (Throwable ignored) {}
    }

    private void handle(File f) {
        String id = null;
        JSONObject result = new JSONObject();
        try {
            String text = readText(f, 1024 * 512);
            JSONObject cmd = new JSONObject(text);
            id = cmd.optString("id", f.getName().substring(4, f.getName().length() - 5));
            String tool = cmd.optString("tool", "");
            JSONObject args = cmd.optJSONObject("args");
            if (args == null) args = new JSONObject();
            JSONObject out = Tools.dispatch(tool, args);
            result.put("id", id).put("tool", tool).put("ts", System.currentTimeMillis());
            java.util.Iterator<String> it = out.keys();
            while (it.hasNext()) {
                String k = it.next();
                result.put(k, out.get(k));
            }
        } catch (Throwable t) {
            try {
                result.put("ok", false).put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
                if (id == null) {
                    String n = f.getName();
                    id = n.substring(4, n.length() - 5);
                    result.put("id", id);
                }
            } catch (Throwable ignored) {}
        }
        try {
            writeAtomic(new File(BRIDGE_DIR, "result_" + id + ".json"), result.toString());
        } catch (Throwable ignored) {}
        try { f.delete(); } catch (Throwable ignored) {}
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
