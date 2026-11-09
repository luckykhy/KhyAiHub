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
    private static final long GC_INTERVAL_MS = 60_000L;
    private static final long RESULT_RETENTION_MS = 24L * 60 * 60 * 1000;
    private static final long TMP_RETENTION_MS = 60L * 60 * 1000;
    private static final long PROCESSING_RETENTION_MS = 72L * 60 * 60 * 1000;

    public static final String ACTION_START = "com.khyos.khy_os_client.bridge.START";
    public static final String ACTION_STOP = "com.khyos.khy_os_client.bridge.STOP";
    private volatile boolean running = false;
    private Thread worker;

    // Worker-loop heartbeat: bumped once per loop pass, read by HTTP /ping
    // cross-thread, hence static volatile.
    private static volatile long hbSeq = 0;
    private static volatile long hbTickMs = 0;
    // Leftover processing files registered once at startup (the mailbox
    // contract's recovered set). Their side effects are unknown: they are
    // reported, never replayed or deleted here.
    private JSONArray recoveredSnapshot = new JSONArray();
    // Mailbox queue depths from the last scan pass; the same thread publishes
    // them into status.json right after the scan, so plain fields suffice.
    private int mbPending = 0;
    private int mbProcessing = 0;
    private int mbResults = 0;
    private int mbTmp = 0;

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
                        if (n.startsWith("cmd_") && n.endsWith(".json")) {
                            pending++;
                        } else if (n.startsWith("processing_") && n.endsWith(".json")) {
                            processing++;
                            if (gcDue && age > PROCESSING_RETENTION_MS) gcDelete(f, "processing", age);
                        } else if (n.startsWith("result_") && n.endsWith(".json")) {
                            results++;
                            if (gcDue && age > RESULT_RETENTION_MS) gcDelete(f, "result", age);
                        } else if (n.endsWith(".tmp")) {
                            tmps++;
                            if (gcDue && age > TMP_RETENTION_MS) gcDelete(f, "tmp", age);
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
            // long command, not that the bridge died.
            o.put("mailbox", new JSONObject()
                    .put("pending", mbPending).put("processing", mbProcessing)
                    .put("results", mbResults).put("tmp", mbTmp));
            // Recovered leftovers registered at startup: claimed-but-outcome-
            // unknown commands. Report only; never replayed or deleted here.
            o.put("recovered", recoveredSnapshot);
            writeAtomic(new File(BRIDGE_DIR, "status.json"), o.toString());
        } catch (Throwable ignored) {}
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
        try {
            JSONObject cmd = new JSONObject(readText(processing, 1024 * 512));
            String bodyId = cmd.optString("id", id);
            tool = cmd.optString("tool", "");
            if (!bodyId.equals(id)) {
                result = HttpBridge.invalidArguments("信箱命令被拒绝：正文 id（" + bodyId + "）与文件名 id（" + id + "）不一致。修复：两者一致后重写 cmd_" + id + ".json", "mailbox");
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
