// khy-canary: Khy-20261101-010-EH750FJZ
package com.khyos.khy_os_client.bridge;

import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 悬浮框：桥工作期间常驻屏幕的可见抓手。
 *
 * 用户原话「工作时要存在悬浮框」。两层结构：
 *   - 气泡（44dp 圆牌「桥」）：可拖拽，松手吸边；点按展开/收起面板；
 *   - 面板：状态行（在线/本轮进行中/已耗时/端口/令牌掩码/写回/上一条错误/
 *     UI 能力/提权/工具数）+ 四个动作（折叠、刷新、复制令牌、停止桥或关闭
 *     悬浮框）。
 *
 * **它与桥是两个独立的开关**（2026-10-28 起）：
 *   - 桥重建时（冷启动 / 开机 / PC `khy phone revive`）只有用户在偏好里留着
 *     「要」才会拉起它——见 {@link #isEnabled(Context)}，闸门在
 *     BridgeService.onCreate。
 *   - 用户在设置里显式 show 的那一颗不再随桥停止而被收回（sticky
 *     {@link #userOwned}，见 {@link #stopWithBridge(Context)}）。
 *   - 桥不在而窗在是合法状态，不是故障：面板的「停止桥」按钮此时变成
 *     「关闭悬浮框」，气泡底色也不视为异常。
 *
 * 权限：SYSTEM_ALERT_WINDOW（悬浮窗）。没有授权时不画、不崩，MainActivity
 * 与 `khy phone setup` 都会引导去授；桥本身不依赖悬浮框，两者可各自存活。
 *
 * 所有 View 代码构建（不新增 res 资源），窗口参数用 TYPE_APPLICATION_OVERLAY
 * （API 26+）/ TYPE_PHONE（旧系统），FLAG_NOT_FOCUSABLE 保证不抢输入法。
 */
public class BridgeOverlayService extends Service {
    private static volatile boolean running = false;
    private final Handler handler = new Handler(Looper.getMainLooper());

    /**
     * True once the user asked for the overlay independently of the bridge.
     *
     * Sticky: never cleared while the overlay lives, so a bridge restart cannot
     * quietly take back something the user asked for. Cleared only by
     * {@link #stop(Context)} — i.e. when the user (or the panel's own close
     * button) takes the overlay down on purpose.
     */
    private static volatile boolean userOwned = false;

    /** Preference container for the overlay switch. Deliberately its own file. */
    private static final String PREF_NAME = "khyos_overlay_pref";
    private static final String KEY_ENABLED = "overlay_enabled";

    private WindowManager wm;
    private View bubble;
    private View panel;
    private TextView statusText;
    private boolean panelOpen = false;

    private TextView bubbleText;
    private GradientDrawable bubbleBgIdle;
    private GradientDrawable bubbleBgBusy;
    private GradientDrawable bubbleBgNow;

    private final Runnable ticker = new Runnable() {
        public void run() {
            // Bubble first: refreshPanel early-returns on statusText == null once
            // the panel is collapsed, so running it first would freeze the badge.
            refreshBubbleStatus();
            refreshPanel();
            handler.postDelayed(this, 2000);
        }
    };

    public static boolean isRunning() {
        return running;
    }

    /**
     * Whether the user wants the floating overlay. Default true keeps the
     * behaviour every existing install already has.
     *
     * Read on the bridge's start path (BridgeService.onCreate), NOT on any
     * status/display path: reading SharedPreferences is disk IO, and the overlay
     * panel, bridgeStatus and this class's ticker are all contractually zero-IO.
     */
    public static boolean isEnabled(Context c) {
        try {
            return c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
                    .getBoolean(KEY_ENABLED, true);
        } catch (Throwable t) {
            // A broken preference store must not stop the bridge from starting.
            return true;
        }
    }

    /** Persist the user's choice. apply() so the caller's thread never does disk IO. */
    public static void setEnabled(Context c, boolean on) {
        try {
            SharedPreferences sp = c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            sp.edit().putBoolean(KEY_ENABLED, on).apply();
        } catch (Throwable ignored) {}
    }

    public static void start(Context c) {
        startInternal(c, false);
    }

    /**
     * Called from MainActivity.overlayShow: the overlay now outlives the bridge.
     *
     * Without this, stopping the bridge takes the overlay down even though the
     * user asked for it explicitly and never asked for it to go away.
     */
    public static void startForUser(Context c) {
        startInternal(c, true);
    }

    private static void startInternal(Context c, boolean byUser) {
        if (byUser) userOwned = true;
        if (running) return;
        try {
            c.startService(new Intent(c, BridgeOverlayService.class));
        } catch (Throwable ignored) {}
    }

    public static void stop(Context c) {
        userOwned = false;
        if (!running) return;
        try {
            c.stopService(new Intent(c, BridgeOverlayService.class));
        } catch (Throwable ignored) {}
    }

    /**
     * Called by BridgeService when the bridge itself goes away.
     *
     * A user-requested overlay is NOT the bridge's to take back: the user may
     * well want the floating handle to stay while the HTTP bridge is down (that
     * is also the state in which they most want to see why).
     */
    public static void stopWithBridge(Context c) {
        if (userOwned) return;
        stop(c);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (!hasOverlayPermission()) {
            running = false;
            stopSelf();
            return;
        }
        running = true;
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        buildBubble();
        handler.postDelayed(ticker, 2000);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(ticker);
        if (bubble != null) { try { wm.removeView(bubble); } catch (Throwable ignored) {} }
        if (panel != null) { try { wm.removeView(panel); } catch (Throwable ignored) {} }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private boolean hasOverlayPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return android.provider.Settings.canDrawOverlays(this);
    }

    private int overlayType() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
        }
        return WindowManager.LayoutParams.TYPE_PHONE;
    }

    private WindowManager.LayoutParams params(int w, int h, int x, int y) {
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                w, h, overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = x;
        lp.y = y;
        return lp;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    // 1.5dp 描边这类小数尺寸走这个重载。
    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void buildBubble() {
        TextView tv = new TextView(this);
        tv.setText("桥");
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(13);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(dp(6), dp(6), dp(6), dp(6));
        // Two pre-built drawables rather than setColor() on the fly:
        // GradientDrawable.setColors(int[]) is API 24+ and minSdk is not
        // guaranteed to be 24, so swapping the gradient in place is not an
        // option. Two instances + setBackground (API 16+) carry no version risk.
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[] { 0xFF4D7CFF, 0xFFE363F9 });
        bg.setShape(GradientDrawable.OVAL);
        bg.setStroke(dp(1.5f), 0x40FFFFFF);
        bubbleBgIdle = bg;
        GradientDrawable busy = new GradientDrawable();
        busy.setColor(0xFF2ECC71);
        busy.setShape(GradientDrawable.OVAL);
        busy.setStroke(dp(1.5f), 0x40FFFFFF);
        bubbleBgBusy = busy;
        bubbleBgNow = bg;
        tv.setBackground(bg);
        bubble = tv;
        bubbleText = tv;
        // 默认右上吸边、落在顶栏之下；老坐标 x=8/y=220 会正好压住「khy-os」标题。
        int screenW = getResources().getDisplayMetrics().widthPixels;
        wm.addView(bubble, params(dp(44), dp(44), screenW - dp(56), dp(176)));

        final float[] down = new float[] { 0f, 0f };
        final int[] start = new int[] { 0, 0 };
        final boolean[] moved = new boolean[] { false };
        bubble.setOnTouchListener(new View.OnTouchListener() {
            public boolean onTouch(View v, android.view.MotionEvent e) {
                WindowManager.LayoutParams lp = (WindowManager.LayoutParams) bubble.getLayoutParams();
                switch (e.getAction()) {
                    case android.view.MotionEvent.ACTION_DOWN:
                        down[0] = e.getRawX();
                        down[1] = e.getRawY();
                        start[0] = lp.x;
                        start[1] = lp.y;
                        moved[0] = false;
                        return true;
                    case android.view.MotionEvent.ACTION_MOVE:
                        float dx = e.getRawX() - down[0];
                        float dy = e.getRawY() - down[1];
                        if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) moved[0] = true;
                        lp.x = start[0] + (int) dx;
                        lp.y = start[1] + (int) dy;
                        try { wm.updateViewLayout(bubble, lp); } catch (Throwable ignored) {}
                        return true;
                    case android.view.MotionEvent.ACTION_UP:
                        if (!moved[0]) togglePanel();
                        else snapToEdge(lp);
                        return true;
                    default:
                        return false;
                }
            }
        });
    }

    private void snapToEdge(WindowManager.LayoutParams lp) {
        int screenW = getResources().getDisplayMetrics().widthPixels;
        lp.x = (lp.x + dp(22) < screenW / 2) ? dp(4) : screenW - dp(48);
        try { wm.updateViewLayout(bubble, lp); } catch (Throwable ignored) {}
    }

    /**
     * Remove the panel and leave only the bubble.
     *
     * Split out of togglePanel so the panel can carry its own collapse button.
     * Without one, the only way to close the panel is to tap the bubble — which
     * the panel itself covers — so an expanded panel was a one-way door.
     */
    private void collapsePanel() {
        if (panel != null) {
            try { wm.removeView(panel); } catch (Throwable ignored) {}
            panel = null;
        }
        statusText = null;
        panelOpen = false;
    }

    private void togglePanel() {
        if (panelOpen) {
            collapsePanel();
            return;
        }
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable panelBg = new GradientDrawable();
        panelBg.setColor(0xF5141A2E);
        panelBg.setCornerRadius(dp(20));
        panelBg.setStroke(dp(1), 0xFF263153);
        root.setBackground(panelBg);
        int pad = dp(12);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("khy-os 桥");
        title.setTextColor(0xFFB7C6FF);
        title.setTextSize(15);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        statusText = new TextView(this);
        statusText.setTextColor(0xFFC9D4F2);
        statusText.setTextSize(12);
        statusText.setLineSpacing(0, 1.5f);
        statusText.setPadding(0, dp(6), 0, dp(6));
        root.addView(statusText);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        // 折叠放最前：面板自己盖住了气泡，所以「点气泡收起」这条路在面板展开时
        // 是够不着的。没有这个按钮，面板就是单向门——只能靠停止桥来退出。
        row.addView(actionButton("折叠", new View.OnClickListener() {
            public void onClick(View v) { collapsePanel(); }
        }, false));
        row.addView(actionButton("刷新", new View.OnClickListener() {
            public void onClick(View v) { refreshPanel(); }
        }, false));
        row.addView(actionButton("复制令牌", new View.OnClickListener() {
            public void onClick(View v) { copyToken(); }
        }, false));
        // 按钮按桥是否在线分流：桥在，这一颗停桥；桥不在（用户主动 show 的悬浮框
        // 仍在）时没有桥可停，它就变成关掉这个悬浮框本身——否则四个按钮里三个
        // 无操作，用户唯一的出路是回设置页关。
        boolean online = HttpBridge.healthy();
        if (online) {
            row.addView(actionButton("停止桥", new View.OnClickListener() {
                public void onClick(View v) {
                    BridgeService.stop(BridgeOverlayService.this);
                    collapsePanel();
                    Toast.makeText(BridgeOverlayService.this, "桥已停止", Toast.LENGTH_SHORT).show();
                }
            }, true));
        } else {
            row.addView(actionButton("关闭悬浮框", new View.OnClickListener() {
                public void onClick(View v) {
                    // setEnabled must come first, and must be here at all.
                    //
                    // stop() alone only tears the window down; the preference
                    // stays true, so the next bridge rebuild (cold start, reboot,
                    // or PC `khy phone revive` — all three pass through
                    // BridgeService.onCreate's isEnabled gate) puts the overlay
                    // straight back. The user would watch it return and conclude
                    // the switch is broken.
                    //
                    // The settings-page switch persists because MainActivity
                    // .overlayHide does setEnabled + stop. Two "close" paths with
                    // different durability is the bug this line removes; the
                    // panel is the one a user reaches for while the bridge is
                    // already down, which is exactly when a silently temporary
                    // close is least forgivable.
                    setEnabled(BridgeOverlayService.this, false);
                    stop(BridgeOverlayService.this);
                    collapsePanel();
                    Toast.makeText(BridgeOverlayService.this, "悬浮框已关闭", Toast.LENGTH_SHORT).show();
                }
            }, true));
        }
        root.addView(row);

        panel = root;
        // 296 是「四颗 12sp+14dp 胶囊钮单行不裁切」的下限：原四颗（折叠/刷新/
        // 复制令牌/停止桥）合计约 284dp。桥不在时第四颗变成「关闭悬浮框」（5 字，
        // 比「停止桥」多 2 字 ≈ 24dp），合计约 308dp，所以离线那一档要 320 才不
        // 把按钮裁掉。两档共用同一个面板宽，取大者。
        wm.addView(panel, params(dp(320), LinearLayout.LayoutParams.WRAP_CONTENT, dp(8), dp(120)));
        panelOpen = true;
        refreshPanel();
    }

    private Button actionButton(String label, View.OnClickListener l, boolean danger) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(danger ? 0xFFFF9B9B : 0xFFE6ECFF);
        b.setTextSize(12);
        b.setPadding(dp(14), dp(7), dp(14), dp(7));
        // 主题默认的按钮最小宽高会把四颗胶囊挤出面板，按内容收缩。
        b.setMinimumWidth(0);
        b.setMinimumHeight(0);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(danger ? 0x26FF6B6B : 0x14FFFFFF);
        bg.setCornerRadius(dp(999));
        b.setBackground(bg);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(4);
        b.setLayoutParams(lp);
        return b;
    }

    /**
     * Colour-only status on the 44dp badge: green while the loop or an in-flight
     * amoo_ask is working, the gradient otherwise.
     *
     * Deliberately colour-only — the text stays "桥". snapToEdge() hard-codes the
     * 22dp radius and 48dp margin, and buildBubble pins dp(44)/dp(56), so growing
     * the bubble would desync three constants for a third character that the
     * 44dp round badge plus 6dp padding cannot hold without clipping anyway.
     *
     * Zero IO: AmooLoop.busy() is a volatile read. Runs on the main thread every
     * 2s via the ticker, before refreshPanel (which early-returns when the panel
     * is collapsed).
     */
    private void refreshBubbleStatus() {
        if (bubble == null || bubbleBgNow == null) return;
        GradientDrawable want = AmooLoop.busy() ? bubbleBgBusy : bubbleBgIdle;
        if (want != bubbleBgNow) {
            bubbleBgNow = want;
            bubble.setBackground(want);
        }
    }

    private void refreshPanel() {
        if (statusText == null) return;
        // Zero file IO: refreshing the panel must not read the disk, and must not
        // create a token as a side effect.
        String token = HttpBridge.currentToken();
        String masked = token.length() == 0 ? "未启动"
                : token.length() > 8
                ? token.substring(0, 4) + "…" + token.substring(token.length() - 4)
                : token;
        boolean uiOk = Tools.uiReady();
        boolean online = HttpBridge.healthy();
        StringBuilder sb = new StringBuilder();
        sb.append("状态：").append(online ? "在线" : "离线");
        // 窗在而桥不在（用户主动 show 的）是合法状态，不是说桥坏了。
        if (!online) sb.append("（桥未运行，仅悬浮窗）");
        sb.append('\n');
        // 实时进度放在最前面：这是用户开着悬浮窗最想知道的事——"它现在在干什么"。
        // AmooLoop.progress() 是纯内存读，零 IO，跟 currentToken() 同一约束。
        String prog = AmooLoop.progress();
        if (prog.length() > 0) {
            // 「本轮」不是修饰：index/total 是本气泡内的序号，每轮从 1 重算，
            // 不写清楚用户会读成整个任务的进度。
            sb.append("本轮进行中：")
                    .append(prog.length() > 60 ? prog.substring(0, 60) + "…" : prog)
                    .append('\n');
        } else if (AmooLoop.isRunning()) {
            sb.append("本轮进行中：循环运行中\n");
        }
        long elapsed = AmooLoop.elapsedMs();
        if (elapsed > 0) {
            sb.append("已耗时：").append(fmtElapsed(elapsed)).append('\n');
        }
        sb.append("端口：").append(HttpBridge.port() > 0 ? String.valueOf(HttpBridge.port()) : "未绑定").append('\n');
        sb.append("令牌：").append(masked).append('\n');
        String wb = AmooLoop.lastWriteBack();
        if (wb.length() > 0) {
            sb.append("写回：").append(abbrev(wb, 20)).append('\n');
        }
        String err = AmooLoop.lastError();
        if (err.length() > 0) {
            sb.append("上一条错误：").append(abbrev(err, 24)).append('\n');
        }
        // 无障碍被系统清掉时（force-stop 会触发）把恢复入口直接做在悬浮框上：
        // 通知那条路要 POST_NOTIFICATIONS 运行时权限，用户未必授过，会静默失败；
        // 悬浮框本来就常驻可见、也不需要任何权限，是更可靠的主信号。
        sb.append("UI 能力：").append(uiOk ? "无障碍已开" : "无障碍未开（点此恢复）").append('\n');
        // 提权通道。零 IO：读的是 exec 上次实测后留下的缓存，不在这里查 binder、
        // 不开 socket。重启后 sidecar 会消失（无 root 无法常驻），所以这行要能把
        // 「该重跑 adb 命令了」说清楚，而不是笼统一个「未提权」。
        String elevation;
        if (Tools.sidecarReady()) {
            elevation = "shell sidecar 已就绪（exec 走 uid 2000）";
        } else if (Tools.shizukuReady()) {
            elevation = "Shizuku 已就绪（exec 走 shell uid）";
        } else {
            String why = Tools.sidecarWhy();
            elevation = "未提权（exec 走 App 自身 uid）"
                    + (why.length() > 0 ? " · " + why : "");
        }
        sb.append("提权：").append(elevation).append('\n');
        // 可用数，不是 NAMES.length。悬浮框是用户在「桥好像坏了」时会去看的地方
        // 之一（Tools.java 里 info 那段注释自己这么说），报一个含 8 个调不了的名字
        // 的计数就是让它说谎。
        //
        // 读缓存而不是现探：本类的 ticker 是契约上的零 IO 路径（见 isEnabled 的
        // 注释），而每次探测要 8 次 getPackageInfo。缓存由 Tools.refreshAvailability()
        // 在后台刷，见那边的说明。
        sb.append("工具：").append(Tools.availableCount()).append(" 个");
        statusText.setText(sb.toString());

        if (uiOk) {
            statusText.setOnClickListener(null);
            statusText.setClickable(false);
        } else {
            statusText.setClickable(true);
            statusText.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    try {
                        Intent i = new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                    } catch (Throwable t) {
                        Toast.makeText(BridgeOverlayService.this,
                            "无法打开无障碍设置页", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }
    }

    /**
     * Panel width is pinned at 320dp (the wider of the two button rows — see the
     * comment at the addView call), so every long value must be cut here.
     * AmooLoop.abbreviate is private and appends a character count the panel
     * has no room for, so the panel truncates on its own terms.
     *
     * The bound is expressed in characters rather than pixels because the text
     * view is measured against a fixed width: a value that fits today stops
     * fitting the moment someone lengthens a label, and the failure is silent
     * (an ellipsis) rather than visible. Raise n only with the width.
     */
    private static String abbrev(String s, int n) {
        return s.length() > n ? s.substring(0, n) + "…" : s;
    }

    private static String fmtElapsed(long ms) {
        long s = ms / 1000;
        if (s < 60) return s + " 秒";
        return (s / 60) + " 分 " + String.format("%02d", s % 60) + " 秒";
    }

    private void copyToken() {
        try {
            // currentToken() does zero file IO. ensureToken() would CREATE a token
            // as a side effect of tapping "copy", which is not what the user asked
            // for — and a status/display path doing disk IO is the stall class the
            // per-request-IO ban exists to prevent.
            String token = HttpBridge.currentToken();
            if (token.length() == 0) {
                Toast.makeText(this, "桥尚未启动，没有令牌可复制", Toast.LENGTH_SHORT).show();
                return;
            }
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("bridge-token", token));
            Toast.makeText(this, "令牌已复制", Toast.LENGTH_SHORT).show();
        } catch (Throwable t) {
            Toast.makeText(this, "复制失败：" + t.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }
}
