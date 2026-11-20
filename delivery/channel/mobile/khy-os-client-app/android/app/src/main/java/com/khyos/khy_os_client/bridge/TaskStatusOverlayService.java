package com.khyos.khy_os_client.bridge;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.style.ForegroundColorSpan;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 任务悬浮胶囊：AgentLoop 任务执行期间浮在屏面上的进度窗。
 *
 * 数据来源是文件，不是通道：Dart 侧把任务状态写进
 * {@code <docs>/floating/task_state.json}（docs = getDir("app_flutter")，
 * 与 path_provider 的 getApplicationDocumentsDirectory 同一个目录），本服务
 * 每 1s 轮询一次。不新开 MethodChannel 的理由：任务开始与否本来就写在
 * 文件里，再开一条通道等于同一个事实两个真源。反向输入写
 * {@code <docs>/floating/inbox.jsonl}，Dart 侧 FloatingInboxWatcher 消费。
 *
 * 画与不画的门（缺一不可）：
 *   - phase != idle（idle = 没有任务，文件自己也说 idle）；
 *   - floating == true（Dart 设置页开关镜像进文件；进程死掉留下的旧文件
 *     若开关已关，不会把胶囊拉回来）；
 *   - updatedAtMs 距今 < 2h（stale 视同 idle：Dart 侧死了，别把几小时前
 *     的快照当成正在跑的任务）；
 *   - Settings.canDrawOverlays（onCreate 查一次，没授权直接不跑本服务）。
 *
 * 展开态窗口必须可聚焦（EditText 要输入法），折叠胶囊不可聚焦不抢焦点——
 * 两棵视图两个窗口参数，收起时把可聚焦窗口整个摘掉。
 *
 * 所有 View 代码构建（不新增 res 资源），全部 IO 都在 worker 线程：主线程
 * 每 1s 一次的路径里没有磁盘读，与 BridgeOverlayService 的零 IO 纪律一致。
 */
public class TaskStatusOverlayService extends Service {
    private static final String TAG = "TaskStatusOverlay";

    /** task_state.json 相对 docs 的路径；Dart 侧 TaskStateStore 同源。 */
    static final String STATE_DIR = "floating";
    static final String STATE_FILE = "task_state.json";
    static final String INBOX_FILE = "inbox.jsonl";

    /** 快照多旧算 stale。15 步 *（3min 模型 + 120s 审批）可到 ~1h，取 2h。 */
    private static final long STALE_MS = 2L * 60 * 60 * 1000;
    private static final long POLL_MS = 1000L;

    private static volatile boolean running = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Thread poller;
    private volatile boolean polling = false;

    private WindowManager wm;

    // ── 折叠态（胶囊）──
    private View capsule;
    private TextView capsuleSummary;
    private TextView capsuleTimer;
    private ProgressBar capsuleSpinner;

    // ── 展开态（面板，独立窗口）──
    private View panel;
    private TextView panelTitle;
    private TextView panelTimer;
    private ProgressBar headerSpinner;
    private TextView stepsText;
    private TextView phaseBadge;
    private LinearLayout approvalRow;
    private ImageView shotView;
    private EditText inputBox;

    /** 展开态面板当前是否挂着（胶囊与面板是两个窗口，分开管）。 */
    private boolean expanded = false;

    /** 最近一拍快照的 taskId（× / 关闭胶囊的抑制键）。 */
    private volatile String currentTaskId = "";

    /** worker 线程每拍算好的胶囊文案，主线程只 setText（避免重复刷同值）。 */
    private String lastCapsuleText = "";
    private String lastCapsuleTimer = "";
    private String lastStepsText = "";
    private String lastPanelTitle = "";

    // ── 截图缩略（worker 线程解码，主线程只 setImageBitmap）──
    private volatile Bitmap shotBitmap;
    private volatile String shotBitmapPath = "";
    private String lastShotShownPath = "";

    /**
     * 用户主动关掉的 taskId（× 或「关闭悬浮胶囊」）。任务还在跑，但用户
     * 已经说了「别再画」——轮询如果照常渲染，胶囊下一秒就会复活，等于
     * 抗拒用户的关闭动作。taskId 变了（新任务）或回到 idle 时解除。
     */
    private volatile String closedTaskId = "";

    /** 最近一拍的 pendingApproval.id，信箱回信必须带上它（见 appendApproval）。 */
    private volatile String approvalIdPending;

    public static boolean isRunning() { return running; }

    /** 供 BridgeService.onCreate 调（冷启动 / 开机 / PC 唤醒三条路都过它）。 */
    public static void start(Context c) {
        if (running) return;
        try { c.startService(new Intent(c, TaskStatusOverlayService.class)); }
        catch (Throwable ignored) {}
    }

    public static void stop(Context c) {
        try { c.stopService(new Intent(c, TaskStatusOverlayService.class)); }
        catch (Throwable ignored) {}
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (!canDrawOverlays()) {
            // 没授权不画、不崩：设置页的「悬浮窗权限」入口负责引导授权。
            stopSelf();
            return;
        }
        running = true;
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        polling = true;
        poller = new Thread(new Runnable() {
            public void run() { pollLoop(); }
        }, "task-status-poller");
        poller.setDaemon(true);
        poller.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        polling = false;
        if (poller != null) poller.interrupt();
        handler.post(new Runnable() {
            public void run() { removeAllViews(); }
        });
        Bitmap b = shotBitmap;
        shotBitmap = null;
        shotBitmapPath = "";
        if (b != null) b.recycle();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private boolean canDrawOverlays() {
        return android.provider.Settings.canDrawOverlays(this);
    }

    private File stateFile() {
        // path_provider 的 getApplicationDocumentsDirectory 在 Android 上就是
        // getDir("app_flutter")，两边必须同一目录，否则胶囊永远读不到快照。
        return new File(new File(getDir("app_flutter", Context.MODE_PRIVATE),
                STATE_DIR), STATE_FILE);
    }

    private File inboxFile() {
        return new File(new File(getDir("app_flutter", Context.MODE_PRIVATE),
                STATE_DIR), INBOX_FILE);
    }

    // ── 轮询（worker 线程）─────────────────────────────────────────────────

    private void pollLoop() {
        while (polling) {
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException dead) {
                return;
            }
            if (!polling) return;
            JSONObject snap = readSnapshot();
            // 缩略图解码留在这条 worker 线程：主线程的 1s 路径里没有磁盘读。
            decodeShot(snap == null ? "" : snap.optString("lastScreenshotPath", ""));
            handler.post(new Runnable() {
                public void run() { applySnapshot(snap); }
            });
        }
    }

    /** 路径没变不重解；文件被 5 张清理删掉时解码回 null，UI 自己摆占位。 */
    private void decodeShot(String path) {
        if (path == null || path.length() == 0) {
            if (shotBitmapPath.length() != 0) {
                shotBitmapPath = "";
                shotBitmap = null;
            }
            return;
        }
        if (path.equals(shotBitmapPath)) return;
        Bitmap b = null;
        try {
            b = BitmapFactory.decodeFile(path);
        } catch (Throwable ignored) {
        }
        shotBitmapPath = path;
        shotBitmap = b;
    }

    /** 读不到 / 读坏回 null，主线程把 null 当「收起」处理。 */
    private JSONObject readSnapshot() {
        try {
            File f = stateFile();
            if (!f.exists()) return null;
            String text = readText(f);
            if (text.trim().length() == 0) return null;
            return new JSONObject(text);
        } catch (Throwable t) {
            return null;
        }
    }

    private String readText(File f) throws Exception {
        java.io.FileInputStream in = new java.io.FileInputStream(f);
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) {
            bo.write(b, 0, n);
            if (bo.size() > 256 * 1024) break;
        }
        in.close();
        return new String(bo.toByteArray(), "UTF-8");
    }

    // ── 主线程渲染 ─────────────────────────────────────────────────────────

    private void applySnapshot(JSONObject snap) {
        boolean show = false;
        String phase = "idle", summary = "", source = "local";
        String taskId = "";
        long startedAt = 0, updatedAt = 0;
        int stepIndex = 0, totalSteps = 0;
        String steps = "", lastResult = "", errorMessage = "", hint = "";
        String shotPath = "";
        String approvalTool = null, approvalId = null, approvalTarget = null;
        if (snap != null) {
            phase = snap.optString("phase", "idle");
            source = snap.optString("source", "local");
            taskId = snap.optString("taskId", "");
            summary = snap.optString("lastAction", "");
            startedAt = snap.optLong("startedAtMs", 0L);
            updatedAt = snap.optLong("updatedAtMs", 0L);
            stepIndex = snap.optInt("stepIndex", 0);
            totalSteps = snap.optInt("totalSteps", 0);
            hint = snap.optString("thinkingHint", "");
            lastResult = snap.optString("lastResultExcerpt", "");
            errorMessage = snap.optString("errorMessage", "");
            shotPath = snap.optString("lastScreenshotPath", "");
            boolean floating = snap.optBoolean("floating", false);
            boolean stale =
                    updatedAt > 0 && System.currentTimeMillis() - updatedAt > STALE_MS;
            if (floating && !"idle".equals(phase) && !stale) show = true;
            steps = renderSteps(snap.optJSONArray("steps"));
            JSONObject pa = snap.optJSONObject("pendingApproval");
            if (pa != null && show) {
                approvalTool = pa.optString("tool", "");
                approvalId = pa.optString("id", "");
                approvalTarget = pa.optString("target", "");
            }
        }
        approvalIdPending = approvalId;
        currentTaskId = taskId;

        if (!show) {
            // idle 的语义就是收起：不保留「上次任务的残影」。
            closedTaskId = "";
            removeAllViews();
            return;
        }

        if (taskId.equals(closedTaskId)) {
            // 用户对这个任务说了「别画」。任务照跑，只是不再打扰。
            removeAllViews();
            return;
        }

        if (capsule == null) buildCapsule();
        String want = abbrev(summary, 44);
        if (!want.equals(lastCapsuleText)) {
            lastCapsuleText = want;
            capsuleSummary.setText(want.isEmpty() ? "在干活" : want);
        }
        String timer = "在干活 · " + fmtElapsed(startedAt);
        if (!timer.equals(lastCapsuleTimer)) {
            lastCapsuleTimer = timer;
            capsuleTimer.setText(timer);
        }
        capsuleSpinner.setVisibility(
                "done".equals(phase) || "error".equals(phase) ? View.GONE : View.VISIBLE);

        if (expanded) {
            refreshPanel(phase, summary, source, stepIndex, totalSteps, steps,
                    hint, lastResult, errorMessage, approvalTool,
                    approvalTarget, timer, shotPath);
        }
    }

    /** 最近 8 步，新在前；最新一条加「▶」并提亮。 */
    private String renderSteps(JSONArray steps) {
        if (steps == null || steps.length() == 0) return "";
        SpannableStringBuilder sb = new SpannableStringBuilder();
        int n = Math.min(steps.length(), 8);
        for (int i = 0; i < n; i++) {
            JSONObject s = steps.optJSONObject(i);
            if (s == null) continue;
            String text = s.optString("text", "");
            if (text.length() == 0) continue;
            String line = (i == 0 ? "▶ " : "· ") + abbrev(text, 70);
            int start = sb.length();
            sb.append(line);
            if (i == 0) {
                sb.setSpan(new ForegroundColorSpan(0xFF9FD6FF), start, sb.length(),
                        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            if (i < n - 1) sb.append('\n');
        }
        return sb.toString();
    }

    // ── 折叠态构建 ─────────────────────────────────────────────────────────

    private void buildCapsule() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xF0141A2E);
        bg.setCornerRadius(dp(22));
        bg.setStroke(dp(1), 0xFF263153);
        root.setBackground(bg);
        root.setPadding(dp(12), dp(8), dp(12), dp(8));

        capsuleSpinner = new ProgressBar(this);
        LinearLayout.LayoutParams slp =
                new LinearLayout.LayoutParams(dp(16), dp(16));
        slp.rightMargin = dp(8);
        capsuleSpinner.setLayoutParams(slp);
        root.addView(capsuleSpinner);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        capsuleSummary = new TextView(this);
        capsuleSummary.setText("在干活");
        capsuleSummary.setTextColor(0xFFE6ECFF);
        capsuleSummary.setTextSize(12);
        capsuleSummary.setTypeface(Typeface.DEFAULT_BOLD);
        capsuleSummary.setMaxLines(1);
        col.addView(capsuleSummary);
        capsuleTimer = new TextView(this);
        capsuleTimer.setText("在干活 · 0:00");
        capsuleTimer.setTextColor(0xFF8A96B8);
        capsuleTimer.setTextSize(10);
        col.addView(capsuleTimer);
        root.addView(col);

        capsule = root;
        attachDrag(root, dp(260), dp(44));
        try {
            wm.addView(capsule, overlayParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    dp(16), dp(120), false));
        } catch (Throwable t) {
            capsule = null;
        }
    }

    // ── 展开态构建 ─────────────────────────────────────────────────────────

    private void togglePanel() {
        if (expanded) {
            collapsePanel();
            return;
        }
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xF5141A2E);
        bg.setCornerRadius(dp(18));
        bg.setStroke(dp(1), 0xFF263153);
        root.setBackground(bg);
        int pad = dp(12);
        root.setPadding(pad, pad, pad, pad);

        // ── 头部：spinner + 任务标题（过长截断）+「在干活 · 计时」+ × ──
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setOnTouchListener(panelDragHandler());
        headerSpinner = new ProgressBar(this);
        LinearLayout.LayoutParams hslp =
                new LinearLayout.LayoutParams(dp(18), dp(18));
        hslp.rightMargin = dp(8);
        headerSpinner.setLayoutParams(hslp);
        header.addView(headerSpinner);

        LinearLayout headCol = new LinearLayout(this);
        headCol.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams hclp =
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        headCol.setLayoutParams(hclp);
        panelTitle = new TextView(this);
        panelTitle.setText("当前任务");
        panelTitle.setTextColor(0xFFE6ECFF);
        panelTitle.setTextSize(13);
        panelTitle.setTypeface(Typeface.DEFAULT_BOLD);
        panelTitle.setSingleLine(true);
        panelTitle.setEllipsize(TextUtils.TruncateAt.END);
        headCol.addView(panelTitle);
        panelTimer = new TextView(this);
        panelTimer.setText("在干活 · 0:00");
        panelTimer.setTextColor(0xFF8A96B8);
        panelTimer.setTextSize(10);
        headCol.addView(panelTimer);
        header.addView(headCol);

        Button closeBtn = new Button(this);
        closeBtn.setText("×");
        closeBtn.setTextColor(0xFF8A96B8);
        closeBtn.setTextSize(14);
        closeBtn.setAllCaps(false);
        closeBtn.setPadding(dp(6), dp(2), dp(6), dp(2));
        closeBtn.setMinimumWidth(0);
        closeBtn.setMinimumHeight(0);
        closeBtn.setBackground(null);
        closeBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { closeFloatingViews(); }
        });
        header.addView(closeBtn);
        root.addView(header);

        // ── 主体双列：左=实时截图缩略，右=phase 徽标 + 步骤列表 ──
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.HORIZONTAL);
        body.setPadding(0, dp(6), 0, 0);
        shotView = new ImageView(this);
        shotView.setScaleType(ImageView.ScaleType.CENTER_CROP);
        shotView.setBackgroundColor(0xFF0B1020);
        LinearLayout.LayoutParams svlp =
                new LinearLayout.LayoutParams(dp(108), dp(168));
        svlp.rightMargin = dp(8);
        shotView.setLayoutParams(svlp);
        body.addView(shotView);

        LinearLayout rightCol = new LinearLayout(this);
        rightCol.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams rclp =
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f);
        rightCol.setLayoutParams(rclp);
        phaseBadge = new TextView(this);
        phaseBadge.setTextColor(0xFF8A96B8);
        phaseBadge.setTextSize(11);
        rightCol.addView(phaseBadge);
        stepsText = new TextView(this);
        stepsText.setTextColor(0xFFC9D4F2);
        stepsText.setTextSize(11);
        stepsText.setLineSpacing(0, 1.4f);
        stepsText.setPadding(0, dp(4), 0, 0);
        rightCol.addView(stepsText);
        body.addView(rightCol);
        root.addView(body);

        // 审批行：本地任务的 ask 工具只能在这里或副屏被批准——微信 y/n
        // 不服务本地任务，没有这一行它必然等满 120s 假失败。
        approvalRow = new LinearLayout(this);
        approvalRow.setOrientation(LinearLayout.HORIZONTAL);
        approvalRow.setPadding(0, dp(2), 0, dp(2));
        Button approve = actionButton("批准", new View.OnClickListener() {
            public void onClick(View v) { appendApproval(true); }
        }, false);
        Button deny = actionButton("拒绝", new View.OnClickListener() {
            public void onClick(View v) { appendApproval(false); }
        }, true);
        approvalRow.addView(approve);
        approvalRow.addView(deny);
        approvalRow.setVisibility(View.GONE);
        root.addView(approvalRow);

        // ── 输入行：输入框 + 黑色圆形停止按钮（白方块图标）──
        LinearLayout inputRow = new LinearLayout(this);
        inputRow.setOrientation(LinearLayout.HORIZONTAL);
        inputRow.setGravity(Gravity.CENTER_VERTICAL);
        inputRow.setPadding(0, dp(6), 0, 0);
        inputBox = new EditText(this);
        inputBox.setHint("补充或修改要求…");
        inputBox.setTextColor(0xFFE6ECFF);
        inputBox.setHintTextColor(0xFF6B7694);
        inputBox.setTextSize(12);
        inputBox.setMaxLines(2);
        inputBox.setBackground(null);
        inputBox.setPadding(dp(8), dp(6), dp(8), dp(6));
        GradientDrawable inputBg = new GradientDrawable();
        inputBg.setColor(0x1AFFFFFF);
        inputBg.setCornerRadius(dp(10));
        inputBox.setBackground(inputBg);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        inputBox.setLayoutParams(ilp);
        inputRow.addView(inputBox);
        inputRow.addView(roundStopButton());
        root.addView(inputRow);

        // ── 页脚：打开任务副屏 · 关闭悬浮胶囊 ──
        LinearLayout footer = new LinearLayout(this);
        footer.setOrientation(LinearLayout.HORIZONTAL);
        footer.setPadding(0, dp(6), 0, 0);
        footer.addView(actionButton("打开任务副屏", new View.OnClickListener() {
            public void onClick(View v) { openTaskStatusScreen(); }
        }, false));
        footer.addView(actionButton("关闭悬浮胶囊", new View.OnClickListener() {
            public void onClick(View v) { closeFloatingViews(); }
        }, false));
        root.addView(footer);

        panel = root;
        try {
            wm.addView(panel, overlayParams(dp(332),
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    dp(16), dp(120), true));
        } catch (Throwable t) {
            panel = null;
            return;
        }
        expanded = true;
    }

    /**
     * 用户主动关掉悬浮窗（× 或页脚「关闭悬浮胶囊」）。语义是「收起、任务
     * 继续」：记住 taskId，轮询不再渲染；新任务或回到 idle 时解除。
     */
    private void closeFloatingViews() {
        closedTaskId = currentTaskId;
        removeAllViews();
        Toast.makeText(this, "悬浮胶囊已收起，任务仍在后台跑", Toast.LENGTH_SHORT).show();
    }

    /** 「打开任务副屏」：inbox 带话 + 把 App 带到前台；导航由 Dart 侧完成。 */
    private void openTaskStatusScreen() {
        appendInboxLine(openStatusLine());
        try {
            Intent i = new Intent();
            i.setClassName(getPackageName(), "com.khyos.khy_os_client.MainActivity");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        } catch (Throwable t) {
            Toast.makeText(this, "没能拉起主界面：" + t.getMessage(),
                    Toast.LENGTH_SHORT).show();
        }
    }

    private String openStatusLine() {
        try {
            JSONObject line = new JSONObject();
            line.put("cmd", "openStatus");
            line.put("atMs", System.currentTimeMillis());
            return line.toString();
        } catch (Throwable t) {
            return "{\"cmd\":\"openStatus\"}";
        }
    }

    /** 输入行右侧的停止按钮：黑色圆底 + 白方块。停止=放弃等待（文案在
     * Dart 写进状态文件，AgentLoop 无中断通道）。 */
    private Button roundStopButton() {
        Button b = new Button(this);
        b.setText("■");
        b.setTextColor(0xFFFFFFFF);
        b.setTextSize(10);
        b.setAllCaps(false);
        b.setPadding(0, 0, 0, 0);
        b.setMinimumWidth(0);
        b.setMinimumHeight(0);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF161616);
        bg.setShape(GradientDrawable.OVAL);
        b.setBackground(bg);
        b.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                appendInboxLine(stopLine());
                Toast.makeText(TaskStatusOverlayService.this,
                        "已请求停止（放弃等待）", Toast.LENGTH_SHORT).show();
            }
        });
        LinearLayout.LayoutParams lp =
                new LinearLayout.LayoutParams(dp(34), dp(34));
        lp.leftMargin = dp(6);
        b.setLayoutParams(lp);
        return b;
    }

    private void collapsePanel() {
        if (panel != null) {
            try { wm.removeView(panel); } catch (Throwable ignored) {}
            panel = null;
        }
        panelTitle = null;
        panelTimer = null;
        headerSpinner = null;
        stepsText = null;
        phaseBadge = null;
        approvalRow = null;
        shotView = null;
        inputBox = null;
        expanded = false;
    }

    private void removeAllViews() {
        collapsePanel();
        if (capsule != null) {
            try { wm.removeView(capsule); } catch (Throwable ignored) {}
            capsule = null;
            capsuleSummary = null;
            capsuleTimer = null;
            capsuleSpinner = null;
        }
        lastCapsuleText = "";
        lastCapsuleTimer = "";
        lastStepsText = "";
        lastPanelTitle = "";
        lastShotShownPath = "";
    }

    private void refreshPanel(String phase, String summary, String source,
                              int stepIndex, int totalSteps, String steps,
                              String hint, String lastResult,
                              String errorMessage, String approvalTool,
                              String approvalTarget, String timer,
                              String shotPath) {
        if (panelTitle == null || stepsText == null) return;
        if (panelTitle != null) {
            // 标题=任务摘要（胶囊同一份文案），过长截断由 ellipsize 管。
            String want = abbrev(summary, 40);
            if (!want.equals(lastPanelTitle) && want.length() > 0) {
                panelTitle.setText(want);
                lastPanelTitle = want;
            }
        }
        if (panelTimer != null) panelTimer.setText(timer);
        if (headerSpinner != null) {
            headerSpinner.setVisibility(
                    "done".equals(phase) || "error".equals(phase)
                            ? View.GONE : View.VISIBLE);
        }
        if (shotView != null) {
            boolean haveShot = shotBitmap != null && shotPath.length() > 0;
            if (haveShot) {
                shotView.setImageBitmap(shotBitmap);
                lastShotShownPath = shotPath;
            } else if (!shotPath.equals(lastShotShownPath)) {
                lastShotShownPath = shotPath;
                shotView.setImageDrawable(null);
            }
            shotView.setVisibility(haveShot ? View.VISIBLE : View.GONE);
        }
        String badge = phaseLabel(phase)
                + (totalSteps > 0
                   ? " · 第 " + Math.min(stepIndex, totalSteps) + "/" + totalSteps + " 步"
                   : "")
                + " · 来源：" + ("wechat".equals(source) ? "微信" : "悬浮窗")
                + (errorMessage.length() > 0
                   ? "\n" + abbrev(errorMessage, 60)
                   : (lastResult.length() > 0 && "done".equals(phase)
                      ? "\n" + abbrev(lastResult, 60) : ""));
        if (hint.length() > 0) badge += "\n在想：" + abbrev(hint, 60);
        phaseBadge.setText(badge);

        if (!steps.equals(lastStepsText)) {
            lastStepsText = steps;
            stepsText.setText(steps.length() == 0 ? "（还没有步骤）" : steps);
        }

        boolean pending = approvalTool != null && approvalTool.length() > 0;
        approvalRow.setVisibility(pending ? View.VISIBLE : View.GONE);
        if (pending) {
            // 按钮文案带上工具与目标，让「批准的是哪一下」无歧义。
            Button approve = (Button) approvalRow.getChildAt(0);
            Button deny = (Button) approvalRow.getChildAt(1);
            String what = abbrev(approvalTool
                    + (approvalTarget == null || approvalTarget.length() == 0
                       ? "" : "（" + abbrev(approvalTarget, 16) + "）"), 20);
            approve.setText("批准 " + what);
            deny.setText("拒绝");
        }
    }

    private String phaseLabel(String phase) {
        switch (phase) {
            case "thinking": return "在想下一步";
            case "acting": return "执行中";
            case "reflecting": return "核对结果";
            case "awaiting_approval": return "等你批准";
            case "done": return "已完成";
            case "error": return "出错";
            default: return "空闲";
        }
    }

    // ── 信箱写入（worker 侧随意调用，synchronized 保行完整） ────────────────

    private void appendText() {
        if (inputBox == null) return;
        String text = inputBox.getText().toString().trim();
        if (text.length() == 0) {
            Toast.makeText(this, "先写点什么再发送", Toast.LENGTH_SHORT).show();
            return;
        }
        inputBox.setText("");
        try {
            JSONObject line = new JSONObject();
            line.put("text", text);
            line.put("atMs", System.currentTimeMillis());
            appendInboxLine(line.toString());
            Toast.makeText(this, "已提交，进度在胶囊上", Toast.LENGTH_SHORT).show();
        } catch (Throwable t) {
            Toast.makeText(this, "提交失败：" + t.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private void appendApproval(boolean allow) {
        if (approvalIdPending == null || approvalIdPending.length() == 0) return;
        try {
            JSONObject line = new JSONObject();
            line.put("approval", allow ? "y" : "n");
            line.put("id", approvalIdPending);
            line.put("atMs", System.currentTimeMillis());
            appendInboxLine(line.toString());
            Toast.makeText(this, allow ? "已批准" : "已拒绝", Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {}
    }

    private String stopLine() {
        try {
            JSONObject line = new JSONObject();
            line.put("cmd", "stop");
            line.put("atMs", System.currentTimeMillis());
            return line.toString();
        } catch (Throwable t) {
            return "{\"cmd\":\"stop\"}";
        }
    }

    private final Object inboxLock = new Object();

    private void appendInboxLine(String line) {
        synchronized (inboxLock) {
            FileOutputStream fo = null;
            try {
                File f = inboxFile();
                File dir = f.getParentFile();
                if (dir != null && !dir.exists()) dir.mkdirs();
                fo = new FileOutputStream(f, true);
                fo.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                fo.flush();
                fo.getFD().sync();
            } catch (Throwable t) {
                Toast.makeText(this, "信箱写入失败：" + t.getMessage(),
                        Toast.LENGTH_SHORT).show();
            } finally {
                if (fo != null) try { fo.close(); } catch (Throwable ignored) {}
            }
        }
    }

    // ── 窗口参数 / 拖动 / 小工具 ───────────────────────────────────────────

    private WindowManager.LayoutParams overlayParams(int w, int h, int x, int y,
                                                     boolean focusable) {
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                w, h,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                (focusable ? 0 : WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = x;
        lp.y = y;
        return lp;
    }

    /** 胶囊 = 拖动把手 + 点按展开；钳在屏内，与 BridgeOverlayService 同一套。 */
    private void attachDrag(View v, int wPx, int hPx) {
        final float[] down = new float[] { 0f, 0f };
        final int[] start = new int[] { 0, 0 };
        final boolean[] moved = new boolean[] { false };
        v.setOnTouchListener(new View.OnTouchListener() {
            public boolean onTouch(View view, MotionEvent e) {
                WindowManager.LayoutParams lp =
                        (WindowManager.LayoutParams) capsule.getLayoutParams();
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        down[0] = e.getRawX();
                        down[1] = e.getRawY();
                        start[0] = lp.x;
                        start[1] = lp.y;
                        moved[0] = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = e.getRawX() - down[0];
                        float dy = e.getRawY() - down[1];
                        if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) moved[0] = true;
                        lp.x = clamp(start[0] + (int) dx, 0,
                                getResources().getDisplayMetrics().widthPixels - dp(260));
                        lp.y = clamp(start[1] + (int) dy, dp(24),
                                getResources().getDisplayMetrics().heightPixels - dp(72));
                        try { wm.updateViewLayout(capsule, lp); }
                        catch (Throwable ignored) {}
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved[0]) togglePanel();
                        return true;
                    default:
                        return false;
                }
            }
        });
    }

    /** 面板头部 = 拖动把手（面板里全是按钮与输入框，只挂头部）。点按不动 =
     * 收回折叠态；拖动优先于点按，跟胶囊同一套判定。 */
    private View.OnTouchListener panelDragHandler() {
        final float[] down = new float[] { 0f, 0f };
        final int[] pStart = new int[] { 0, 0 };
        final boolean[] moved = new boolean[] { false };
        return new View.OnTouchListener() {
            public boolean onTouch(View v, MotionEvent e) {
                if (panel == null) return false;
                WindowManager.LayoutParams plp =
                        (WindowManager.LayoutParams) panel.getLayoutParams();
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        down[0] = e.getRawX();
                        down[1] = e.getRawY();
                        pStart[0] = plp.x;
                        pStart[1] = plp.y;
                        moved[0] = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = e.getRawX() - down[0];
                        float dy = e.getRawY() - down[1];
                        if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) moved[0] = true;
                        plp.x = clamp(pStart[0] + (int) dx, 0,
                                getResources().getDisplayMetrics().widthPixels - dp(332));
                        plp.y = clamp(pStart[1] + (int) dy, dp(24),
                                getResources().getDisplayMetrics().heightPixels - dp(120));
                        try { wm.updateViewLayout(panel, plp); }
                        catch (Throwable ignored) {}
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved[0]) collapsePanel();
                        return true;
                    default:
                        return false;
                }
            }
        };
    }

    private Button actionButton(String label, View.OnClickListener l, boolean danger) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(danger ? 0xFFFF9B9B : 0xFFE6ECFF);
        b.setTextSize(12);
        b.setPadding(dp(14), dp(7), dp(14), dp(7));
        b.setMinimumWidth(0);
        b.setMinimumHeight(0);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(danger ? 0x26FF6B6B : 0x14FFFFFF);
        bg.setCornerRadius(dp(999));
        b.setBackground(bg);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(4);
        b.setLayoutParams(lp);
        return b;
    }

    private static int clamp(int v, int lo, int hi) {
        if (hi < lo) return lo;
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private static String abbrev(String s, int n) {
        if (s == null) return "";
        return s.length() > n ? s.substring(0, n) + "…" : s;
    }

    private String fmtElapsed(long startedAtMs) {
        // 参考效果的形态是「在干活 · 0:05」：分:秒，一小时以上分钟数继续涨。
        if (startedAtMs <= 0) return "0:00";
        long s = Math.max(0, (System.currentTimeMillis() - startedAtMs) / 1000);
        return (s / 60) + ":" + String.format("%02d", s % 60);
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }
}
