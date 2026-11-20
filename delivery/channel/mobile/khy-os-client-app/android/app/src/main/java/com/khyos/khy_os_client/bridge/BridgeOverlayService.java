// khy-canary: Khy-20261101-010-EH750FJZ
package com.khyos.khy_os_client.bridge;

import android.animation.ValueAnimator;
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
import com.khyos.khy_os_client.MainActivity;

/**
 * 悬浮框：桥工作期间常驻屏幕的可见抓手。
 *
 * 用户原话「工作时要存在悬浮框」。两层结构：
 *   - 气泡（44dp 状态红绿灯）：可拖拽（拖动钳在屏内），松手吸边；点按展开/收起
 *     面板；五态镜片（绿=在线空闲、绿呼吸=忙碌、红=有错误记录、黄=无障碍未开、
 *     灰=桥离线）+ 2 字进度前缀。
 *   - 面板：标题行（三颗状态灯仪表：桥/工作/无障碍 + ≡ 拖动把手，面板与气泡
 *     成对平移）+ 工作区（本轮进行中/接下来/待发，忙碌换绿）+ 参考区（在线/
 *     端口/令牌掩码/写回/上一条错误/UI 能力/提权/工具数，压暗）+ 四个动作
 *     （折叠、刷新、复制令牌、停止桥或关闭悬浮框）。面板摆在气泡正下方
 *     （放不下翻上方），气泡全程露出可抓。
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

    /** WRAP_CONTENT panel height is unknown before addView; 300dp covers the widest row. */
    private static final int PANEL_H_EST_DP = 300;

    private WindowManager wm;
    private View bubble;
    private View panel;
    /** 面板的实时工作区：本轮进行中/接下来/待发——用户开着悬浮窗最想看的部分。 */
    private TextView workText;
    /** 面板的参考区：端口/令牌/UI 能力/提权/工具，压暗弱化，排查时才细看。 */
    private TextView infoText;
    private boolean panelOpen = false;
    /** 面板实测高度（px）。WRAP_CONTENT 在 addView 前没有真值，layout 后回填，
     * 拖动钳制与摆位用它；没测到时退回 {@link #PANEL_H_EST_DP} 估算。 */
    private int panelHeightPx = -1;
    /** 展开那一刻定的摆位档（气泡下方/上方）。拖动沿用同一档，不做中途翻转，
     * 否则面板会跟着拖动跳变。 */
    private boolean panelAbove = false;

    private TextView bubbleText;
    private GradientDrawable bubbleBgIdle;
    private GradientDrawable bubbleBgBusy;
    private GradientDrawable bubbleBgError;
    private GradientDrawable bubbleBgNow;
    private GradientDrawable bubbleBgWarn;
    private GradientDrawable bubbleBgOff;
    /** 忙碌呼吸动画：绿镜片 alpha 255↔90 往返。离开忙碌即取消复位，不空转。 */
    private ValueAnimator busyPulse;
    /** 面板头三颗状态灯的镜片（桥在线/工作/无障碍），颜色由 refreshPanel 回填。 */
    private GradientDrawable ledBridgeBg;
    private GradientDrawable ledWorkBg;
    private GradientDrawable ledA11yBg;

    private final Runnable ticker = new Runnable() {
        public void run() {
            // Bubble first: refreshPanel early-returns on workText == null once
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
        setBusyPulse(false);
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

    /** 一片红绿灯镜片：实心灯色 + 深色灯罩厚描边，任何壁纸上都读得出「这是一盏灯」。 */
    private GradientDrawable lens(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setShape(GradientDrawable.OVAL);
        d.setStroke(dp(3), 0xF20E1226);
        return d;
    }

    private void buildBubble() {
        TextView tv = new TextView(this);
        tv.setText("桥");
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(13);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(dp(6), dp(6), dp(6), dp(6));
        // 红绿灯五态镜片，全部预建：GradientDrawable.setColors(int[]) 是 API 24+，
        // minSdk 不保证 24，运行中换渐变不可行；预建实例 + setBackground（API 16+）
        // 无版本风险。旧「渐变=空闲」换成实心绿——红绿灯的语义靠灯色+呼吸表达，
        // 不再靠品牌渐变。
        bubbleBgIdle = lens(0xFF2ECC71);
        bubbleBgBusy = lens(0xFF2ECC71);
        bubbleBgError = lens(0xFFE05252);
        bubbleBgWarn = lens(0xFFFFB300);
        bubbleBgOff = lens(0xFF5A6478);
        bubbleBgNow = bubbleBgIdle;
        tv.setBackground(bubbleBgNow);
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
                        // 钳在屏内：FLAG_LAYOUT_NO_LIMITS 允许窗口画出屏幕之外，
                        // 不钳的话气泡能被拖到状态栏底下甚至屏外，松手就再也够不着。
                        lp.x = clamp(start[0] + (int) dx, 0,
                                getResources().getDisplayMetrics().widthPixels - dp(44));
                        lp.y = clamp(start[1] + (int) dy, dp(24),
                                getResources().getDisplayMetrics().heightPixels - dp(72));
                        try { wm.updateViewLayout(bubble, lp); } catch (Throwable ignored) {}
                        // The panel is pinned to the bubble, not to the screen:
                        // dragging an open panel's ball must move both.
                        if (panelOpen && panel != null) {
                            try { wm.updateViewLayout(panel, panelLayoutParams(lp)); }
                            catch (Throwable ignored) {}
                        }
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
        // Snapping rewrites lp.x, so an open panel has to be re-anchored too.
        if (panelOpen && panel != null) {
            try { wm.updateViewLayout(panel, panelLayoutParams(lp)); }
            catch (Throwable ignored) {}
        }
    }

    /**
     * Where the panel goes, derived from the bubble's live position.
     *
     * 旧摆法 y = bubble.y - 8：面板右缘与气泡右缘对齐，而面板是后 add 的、z 序在
     * 上——整颗气泡被面板压在底下，展开后既点不到气泡收起，也没有任何抓手，
     * 用户报的「展开后的拖动需要优化」一半就是它。现在面板摆在气泡**正下方**
     * （气泡顶缘下 52dp），气泡全程露出来：可点、可拖，面板跟着走。屏幕下方
     * 放不下时整块翻到气泡上方——翻档只在展开那一刻定一次（panelAbove），
     * 拖动沿用同一档，不做中途翻转。
     *
     * 高度钳制优先用实测 panelHeightPx，没测到才退回 300dp 估算。估算偏大
     * 比裁掉底边好——Lifting the panel early beats clipping it.
     */
    private WindowManager.LayoutParams panelLayoutParams(WindowManager.LayoutParams bubbleLp) {
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = getResources().getDisplayMetrics().heightPixels;
        int panelW = dp(320);
        int panelH = panelHeightPx > 0 ? panelHeightPx : dp(PANEL_H_EST_DP);
        int x = clamp(bubbleLp.x + dp(44) - panelW, 0, screenW - panelW);
        int y = panelAbove
                ? bubbleLp.y - panelH - dp(8)
                : bubbleLp.y + dp(52);
        y = clamp(y, dp(24), Math.max(dp(24), screenH - panelH - dp(8)));
        return params(panelW, LinearLayout.LayoutParams.WRAP_CONTENT, x, y);
    }

    private static int clamp(int v, int lo, int hi) {
        if (hi < lo) return lo;
        return v < lo ? lo : (v > hi ? hi : v);
    }

    /**
     * 面板标题 = 拖动把手。气泡拖动在 buildBubble，但面板展开时用户的手自然
     * 落在面板上——标题拖动把面板与气泡当一对平移（同一个 delta、各自钳在
     * 屏内），相对锚位不变，收起后气泡就停在用户拖到的位置，不会漂回旧坐标。
     *
     * 只挂标题不挂整板：面板里全是按钮，挂整板要么吞点击要么得逐个放行。
     */
    private View.OnTouchListener panelDragHandler() {
        final float[] down = new float[] { 0f, 0f };
        final int[] pStart = new int[] { 0, 0 };
        final int[] bStart = new int[] { 0, 0 };
        return new View.OnTouchListener() {
            public boolean onTouch(View v, android.view.MotionEvent e) {
                // 拖动途中面板可能被「折叠」按钮收走：视图没了就别再解引用。
                if (panel == null || bubble == null) return false;
                WindowManager.LayoutParams plp = (WindowManager.LayoutParams) panel.getLayoutParams();
                WindowManager.LayoutParams blp = (WindowManager.LayoutParams) bubble.getLayoutParams();
                int screenW = getResources().getDisplayMetrics().widthPixels;
                int screenH = getResources().getDisplayMetrics().heightPixels;
                switch (e.getAction()) {
                    case android.view.MotionEvent.ACTION_DOWN:
                        down[0] = e.getRawX();
                        down[1] = e.getRawY();
                        pStart[0] = plp.x;
                        pStart[1] = plp.y;
                        bStart[0] = blp.x;
                        bStart[1] = blp.y;
                        return true;
                    case android.view.MotionEvent.ACTION_MOVE: {
                        float dx = e.getRawX() - down[0];
                        float dy = e.getRawY() - down[1];
                        int panelW = dp(320);
                        int panelH = panelHeightPx > 0 ? panelHeightPx : dp(PANEL_H_EST_DP);
                        plp.x = clamp(pStart[0] + (int) dx, 0, screenW - panelW);
                        plp.y = clamp(pStart[1] + (int) dy, dp(24),
                                Math.max(dp(24), screenH - panelH - dp(8)));
                        try { wm.updateViewLayout(panel, plp); } catch (Throwable ignored) {}
                        blp.x = clamp(bStart[0] + (int) dx, 0, screenW - dp(44));
                        blp.y = clamp(bStart[1] + (int) dy, dp(24), screenH - dp(72));
                        try { wm.updateViewLayout(bubble, blp); } catch (Throwable ignored) {}
                        return true;
                    }
                    default:
                        return false;
                }
            }
        };
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
        workText = null;
        infoText = null;
        ledBridgeBg = null;
        ledWorkBg = null;
        ledA11yBg = null;
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

        // 标题行 = 红绿灯仪表 + 拖动把手。三颗灯把面板自己变成仪表盘：展开第一眼
        // 读灯不读字就知道桥在不在线、干不干活、无障碍缺不缺。
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        // ≡ 提示可拖。把手只挂标题：面板里全是按钮，挂整板要么吞点击、要么逐个
        // 放行；标题在最上、够得着，是天然的把手位。气泡也露在面板外可拖
        // （见 panelLayoutParams），两条拖动路并存。
        title.setText("≡ khy-os 桥");
        title.setTextColor(0xFFB7C6FF);
        title.setTextSize(15);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(0, dp(4), 0, dp(8));
        title.setOnTouchListener(panelDragHandler());
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        tlp.weight = 1f;
        title.setLayoutParams(tlp);
        head.addView(title);
        head.addView(ledStrip());
        root.addView(head);

        // 工作区与参考区拆两块：旧版一整面 12sp 文字墙把「它现在在干什么」埋进
        // 端口/令牌/提权一堆静态参考里（用户报的「工作状态提示需要优化」）。
        // 工作区 12sp 粗体、忙碌换绿；参考区 11sp 压暗——哪半边会动一眼可辨。
        workText = new TextView(this);
        workText.setTextColor(0xFFC9D4F2);
        workText.setTextSize(12);
        workText.setTypeface(Typeface.DEFAULT_BOLD);
        workText.setLineSpacing(0, 1.4f);
        workText.setPadding(0, 0, 0, dp(6));
        root.addView(workText);

        infoText = new TextView(this);
        infoText.setTextColor(0xFF8A96B8);
        infoText.setTextSize(11);
        infoText.setLineSpacing(0, 1.4f);
        root.addView(infoText);

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
        // L4 输入行另起一行：320dp 是上面四颗胶囊不裁切的下限，往那一行里
        // 塞第五颗会把它撑爆（见 addView 处的注释）。
        root.addView(promptRow());

        panel = root;
        // 296 是「四颗 12sp+14dp 胶囊钮单行不裁切」的下限：原四颗（折叠/刷新/
        // 复制令牌/停止桥）合计约 284dp。桥不在时第四颗变成「关闭悬浮框」（5 字，
        // 比「停止桥」多 2 字 ≈ 24dp），合计约 308dp，所以离线那一档要 320 才不
        // 把按钮裁掉。两档共用同一个面板宽，取大者。
        // 坐标不再写死：由气泡当前 lp 推导（见 panelLayoutParams）。摆上/摆下在
        // 展开这一刻定档：下方放得下就摆下方（气泡露出来当抓手），放不下翻上方。
        // 用估算档判断即可——真高度此刻还没有，而估算偏大只会把该摆下的错判成
        // 摆上，不会裁掉底边。
        int screenH = getResources().getDisplayMetrics().heightPixels;
        // getLayoutParams() 的静态类型是 ViewGroup.LayoutParams，x/y 在
        // WindowManager.LayoutParams 上，这里必须强转（气泡的 lp 一定是它）。
        int bubbleY = ((WindowManager.LayoutParams) bubble.getLayoutParams()).y;
        panelAbove = bubbleY + dp(52) + dp(PANEL_H_EST_DP) > screenH - dp(24);
        wm.addView(panel, panelLayoutParams((WindowManager.LayoutParams) bubble.getLayoutParams()));
        // 真高度 layout 后才有：回填给拖动钳制与 ticker 的钳制刷新用。
        panel.post(new Runnable() {
            public void run() { if (panel != null) panelHeightPx = panel.getHeight(); }
        });
        panelOpen = true;
        refreshPanel();
    }

    /**
     * L4 输入行（[DESIGN-ARCH-208] 期 3）。两颗按钮都不碰执行链语义：
     * 「输入提示词」只拉起 App 内的输入页，「发送下一笔」只消费队首。
     */
    private LinearLayout promptRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(6), 0, 0);
        row.addView(actionButton("输入提示词", new View.OnClickListener() {
            public void onClick(View v) { openPromptInput(); }
        }, false));
        row.addView(actionButton("发送下一笔", new View.OnClickListener() {
            public void onClick(View v) {
                // 入口判定：队首是一条 JSON 命令，还是一句给 amoo 的话。
                //
                // 为什么悬浮框这一侧要自己判一次，尽管 AmooLoop.sendPendingPrompt
                // 里面也已经判过：判定本身只有 AmooLoop.looksLikeCommand 一处
                // （它问 KhyConsole.prepare 有没有认出 tool 字段），但「这一下该
                // 走哪条」是每个入口自己的事。两条路的等待时间差一个数量级——
                // 命令就地返回，提问要把 amoo 调到前台等约 6 分钟。入口不分流，
                // 用户就只有一个按钮和一句"已发送/失败"，不知道该等 3 秒还是 6 分钟。
                String head = AmooLoop.pendingPromptHead();
                String r = queueHeadIsCommand()
                        ? AmooLoop.runCommandLocally(head)
                        : AmooLoop.sendPendingPrompt();
                Toast.makeText(BridgeOverlayService.this, r, Toast.LENGTH_LONG).show();
                refreshPanel();
            }
        }, false));
        return row;
    }

    /**
     * 队首是不是一条 JSON 命令（{@code {"tool":…,"args":{…}}}），而不是一句
     * 给 amoo 的话。
     *
     * 判定不在本类里：AmooLoop.looksLikeCommand 是唯一判据（它问
     * KhyConsole.prepare 有没有认出 tool 字段），这里只是把它读出来给两个地方
     * 用——面板上的「待发」行，和「发送下一笔」那颗按钮。悬浮框自己抄一份 JSON
     * 解析，两边迟早会对「算不算命令」给出不同答案，而那种分歧在 UI 上只看得出
     * 「有时候明明能跑却不让你跑」。
     *
     * 零 IO：pendingPromptHead 是 volatile 镜像读，looksLikeCommand 只做一次
     * JSONObject 解析，都不碰磁盘。ticker 是主线程 2s 路径，见 isEnabled 的注释。
     */
    private static boolean queueHeadIsCommand() {
        return AmooLoop.looksLikeCommand(AmooLoop.pendingPromptHead());
    }

    /**
     * 方案 B（Q4 拍板）：输入在 App 内的独立 Activity 完成，悬浮窗始终保持
     * FLAG_NOT_FOCUSABLE —— params() 一处、气泡与面板共用，摘掉它会抢输入法
     * 焦点并让 AmooLoop.ask() 的前台预检失败。从 Service 启动必须带
     * FLAG_ACTIVITY_NEW_TASK；Android 10+ 的后台启动限制待真机验证。
     */
    private void openPromptInput() {
        try {
            Intent i = new Intent(this, PromptInputActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            // 输入页接手，收起面板免得它盖着新页面。
            collapsePanel();
        } catch (Throwable t) {
            Toast.makeText(this, "无法打开输入页：" + t.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    /** 面板头三颗状态灯：桥在线/工作/无障碍。每颗 = 8dp 镜片 + 9sp 名签，颜色由 refreshPanel 回填。 */
    private LinearLayout ledStrip() {
        LinearLayout strip = new LinearLayout(this);
        strip.setOrientation(LinearLayout.HORIZONTAL);
        strip.setGravity(Gravity.CENTER_VERTICAL);
        ledBridgeBg = led(strip, "桥");
        ledWorkBg = led(strip, "工作");
        ledA11yBg = led(strip, "无障碍");
        return strip;
    }

    private GradientDrawable led(LinearLayout strip, String label) {
        LinearLayout g = new LinearLayout(this);
        g.setOrientation(LinearLayout.HORIZONTAL);
        g.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable dot = new GradientDrawable();
        dot.setShape(GradientDrawable.OVAL);
        dot.setColor(0xFF333D5C);
        View v = new View(this);
        v.setBackground(dot);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(8), dp(8));
        dlp.rightMargin = dp(4);
        v.setLayoutParams(dlp);
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextColor(0xFF8A96B8);
        t.setTextSize(9);
        g.addView(v);
        g.addView(t);
        LinearLayout.LayoutParams glp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        glp.rightMargin = dp(10);
        g.setLayoutParams(glp);
        strip.addView(g);
        return dot;
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
     * 悬浮窗状态红绿灯（五态，按优先级取一盏亮）：
     *   1. 绿呼吸 = 忙碌（进行中的工作最想看，压过一切；镜片 alpha 呼吸 600ms）
     *   2. 红     = 有错误记录（同面板「上一条错误」的数据源；语义是"有记录在案"，
     *      不是"当前这轮在失败"——跑完一轮好的还亮红就说谎了，见 AmooLoop.report
     *      关于它从不清 lastError 的说明）
     *   3. 黄     = 无障碍未开（能力降级、可行动的警告）
     *   4. 灰     = 桥离线（仅悬浮窗独存，不是故障）
     *   5. 绿     = 在线空闲
     *
     * The 44dp size stays put: snapToEdge() hard-codes the 22dp radius and 48dp
     * margin, and buildBubble pins dp(44)/dp(56), so growing the badge would
     * desync three constants. Only the label and the lens change — two 13sp
     * glyphs still fit inside 44dp minus 6dp padding on each side.
     *
     * Zero IO: every read below is a volatile/cached field. Runs on the main
     * thread every 2s via the ticker, before refreshPanel.
     */
    private void refreshBubbleStatus() {
        if (bubble == null || bubbleBgNow == null || bubbleText == null) return;
        GradientDrawable want;
        String label;
        if (AmooLoop.busy()) {
            want = bubbleBgBusy;
            String p = AmooLoop.progress().trim();
            label = p.length() == 0 ? "…" : p.substring(0, Math.min(2, p.length()));
        } else if (AmooLoop.lastError().length() > 0) {
            want = bubbleBgError;
            label = "!";
        } else if (!Tools.uiReady()) {
            want = bubbleBgWarn;
            label = "△";
        } else if (!HttpBridge.healthy()) {
            want = bubbleBgOff;
            label = "离";
        } else {
            want = bubbleBgIdle;
            label = "桥";
        }
        setBusyPulse(want == bubbleBgBusy);
        if (want != bubbleBgNow) {
            bubbleBgNow = want;
            bubble.setBackground(want);
        }
        if (!label.equals(bubbleText.getText().toString())) {
            bubbleText.setText(label);
        }
    }

    /**
     * 忙碌呼吸：绿镜片 alpha 255↔90 往返 600ms。常驻动画全屏只批「运行中」这一处
     * ——呼吸就是工作态本身，不是装饰；离开忙碌立即取消并复位，不留空转的循环。
     */
    private void setBusyPulse(boolean on) {
        if (on) {
            if (busyPulse != null) return;
            busyPulse = ValueAnimator.ofInt(255, 90);
            busyPulse.setDuration(600);
            busyPulse.setRepeatCount(ValueAnimator.INFINITE);
            busyPulse.setRepeatMode(ValueAnimator.REVERSE);
            busyPulse.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
                public void onAnimationUpdate(ValueAnimator a) {
                    if (bubble != null && bubbleBgNow == bubbleBgBusy) {
                        bubbleBgBusy.setAlpha((Integer) a.getAnimatedValue());
                        bubble.invalidate();
                    }
                }
            });
            busyPulse.start();
        } else if (busyPulse != null) {
            busyPulse.cancel();
            busyPulse = null;
            bubbleBgBusy.setAlpha(255);
            if (bubble != null) bubble.invalidate();
        }
    }

    private void refreshPanel() {
        if (workText == null || infoText == null) return;
        // Zero file IO: refreshing the panel must not read the disk, and must not
        // create a token as a side effect.
        boolean online = HttpBridge.healthy();
        boolean busy = AmooLoop.busy();
        boolean uiOk = Tools.uiReady();
        long elapsed = AmooLoop.elapsedMs();

        // ── 工作区：用户开着悬浮窗最想知道的「它现在在干什么」。
        // AmooLoop.progress()/elapsedMs() 都是纯内存读，零 IO，跟 currentToken()
        // 同一约束；elapsedMs 只在运行中非 0（见 AmooLoop.java 的说明）。
        StringBuilder w = new StringBuilder();
        String prog = AmooLoop.progress();
        if (prog.length() > 0) {
            // 「本轮」不是修饰：index/total 是本气泡内的序号，每轮从 1 重算，
            // 不写清楚用户会读成整个任务的进度。
            w.append("● 本轮进行中");
            if (elapsed > 0) w.append("（已 ").append(fmtElapsed(elapsed)).append('）');
            w.append('\n')
                    .append(prog.length() > 60 ? prog.substring(0, 60) + "…" : prog);
        } else if (busy) {
            // 反代 ask 通道在跑：没有 progress 文本也要给一行在动的，别让用户
            // 把工作态读成卡死。
            w.append("● 进行中");
            if (elapsed > 0) w.append("（已 ").append(fmtElapsed(elapsed)).append('）');
        } else if (online) {
            // 空闲要说清是「等活」：旧版空闲时只字不提，分不清是等 PC 派活还是桥挂了。
            w.append("○ 空闲 · 等 PC 派活");
        } else {
            // 窗在而桥不在（用户主动 show 的）是合法状态，不是说桥坏了。
            w.append("○ 桥未运行，仅悬浮窗");
        }
        // "接下来" is intent, not outcome: upcoming() reads Amoo's PLAN
        // restatement or derives from mode/busy. lastReport() is deliberately
        // not used here — a result sentence reworded as a plan would be a lie.
        String upcoming = AmooLoop.upcoming();
        if (upcoming.length() > 0) {
            w.append('\n').append("接下来：").append(abbrev(upcoming, 40));
        }
        // L4 待发队列。全是 volatile 镜像读（AmooLoop 的 queueSize/queueHead），
        // 零锁、零 IO —— ticker 是主线程 2s 路径，不能为读计数去抢
        // sendPendingPrompt() 那把会一路走到前台预检的 class 锁。
        int pending = AmooLoop.pendingPromptCount();
        if (pending > 0) {
            w.append('\n').append("待发：").append(pending).append(" 笔 · ")
                    .append(abbrev(AmooLoop.pendingPromptHead(), 24));
            // 队首是 JSON 命令还是提问，写在这一行上（判定见 queueHeadIsCommand）。
            // 两条路的等待时间差一个数量级（就地返回 vs 约 6 分钟），用户看着同一颗
            // 「发送下一笔」按钮，得知道按下去等什么。
            w.append(queueHeadIsCommand() ? "（本地命令）" : "（问 amoo）");
        }
        workText.setText(w.toString());
        // 忙绿闲灰：与气泡红绿灯同一套语义，两处不各说各话。
        workText.setTextColor(busy ? 0xFF7FDFA8 : 0xFFC9D4F2);
        // 面板头三颗灯：判据与气泡红绿灯完全同源（在线/忙碌/无障碍），不另说一套。
        // 灰镜片 0xFF333D5C = 「这路没在动」，黄 = 缺能力，红 = 离线。
        ledBridgeBg.setColor(online ? 0xFF2ECC71 : 0xFFE05252);
        ledWorkBg.setColor(busy ? 0xFF2ECC71 : 0xFF333D5C);
        ledA11yBg.setColor(uiOk ? 0xFF2ECC71 : 0xFFFFB300);

        // ── 参考区：排查时才看的静态/半静态信息，压暗、小一号。
        String token = HttpBridge.currentToken();
        String masked = token.length() == 0 ? "未启动"
                : token.length() > 8
                ? token.substring(0, 4) + "…" + token.substring(token.length() - 4)
                : token;
        StringBuilder s = new StringBuilder();
        s.append("状态：").append(online ? "在线" : "离线")
                .append(" · 端口：")
                .append(HttpBridge.port() > 0 ? String.valueOf(HttpBridge.port()) : "未绑定")
                .append(" · 令牌：").append(masked);
        if (pending > 0) {
            String note = AmooLoop.queueNote();
            if (note.length() > 0) {
                s.append('\n').append("上次发送：").append(abbrev(note, 30));
            }
        }
        String wb = AmooLoop.lastWriteBack();
        if (wb.length() > 0) {
            s.append('\n').append("写回：").append(abbrev(wb, 20));
        }
        String err = AmooLoop.lastError();
        if (err.length() > 0) {
            s.append('\n').append("上一条错误：").append(abbrev(err, 24));
        }
        // 无障碍被系统清掉时（force-stop 会触发）把恢复入口直接做在悬浮框上：
        // 通知那条路要 POST_NOTIFICATIONS 运行时权限，用户未必授过，会静默失败；
        // 悬浮框本来就常驻可见、也不需要任何权限，是更可靠的主信号。
        s.append('\n').append("UI 能力：").append(uiOk ? "无障碍已开" : "无障碍未开（点此恢复）");
        // 提权通道。零 IO：读的是 exec 上次实测后留下的缓存，不在这里查 binder、
        // 不开 socket。重启后 sidecar 会消失（无 root 无法常驻），所以这行要能把
        // 「该重跑 adb 命令了」说清楚，而不是笼统一个「未提权」。
        String elevation;
        if (Tools.sidecarReady()) {
            elevation = "shell sidecar 已就绪（exec 走 uid 2000）";
        } else {
            String why = Tools.sidecarWhy();
            elevation = "未提权（exec 走 App 自身 uid）"
                    + (why.length() > 0 ? " · " + why : "");
        }
        s.append('\n').append("提权：").append(elevation);
        // 可用数，不是 NAMES.length。悬浮框是用户在「桥好像坏了」时会去看的地方
        // 之一（Tools.java 里 info 那段注释自己这么说），报一个含 8 个调不了的名字
        // 的计数就是让它说谎。
        //
        // 读缓存而不是现探：本类的 ticker 是契约上的零 IO 路径（见 isEnabled 的
        // 注释），而每次探测要 8 次 getPackageInfo。缓存由 Tools.refreshAvailability()
        // 在后台刷，见那边的说明。
        s.append('\n').append("工具：").append(Tools.availableCount()).append(" 个");
        infoText.setText(s.toString());

        // 面板真高度随内容增减（待发/错误行进出）：每次刷新顺手回填，拖动钳制
        // 与下次摆位拿到的就不是过期值。getHeight() 是纯内存读。
        if (panel != null) {
            int h = panel.getHeight();
            if (h > 0) panelHeightPx = h;
        }

        if (uiOk) {
            infoText.setOnClickListener(null);
            infoText.setClickable(false);
        } else {
            infoText.setClickable(true);
            infoText.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    try {
                        // 跳 App 内权限中心而不是直开系统无障碍页（2026-11-15 权限
                        // 收敛的裁定）：那里能看到全部授权位缺哪几样，一次补齐。
                        // 路由经 MainActivity.pendingRouteRequest 传递（事件，
                        // consume 即清），Flutter 侧 resumed 时领取并推页——
                        // 与 consumeSharedText 同一套模板。
                        MainActivity.pendingRouteRequest = "permission-center";
                        Intent i = new Intent(BridgeOverlayService.this, MainActivity.class);
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                        startActivity(i);
                    } catch (Throwable t) {
                        // 拉不起 App 就退回直开系统页：恢复无障碍是硬需求，
                        // 不能因为管道断了就没了入口。
                        try {
                            Intent fb = new Intent(
                                android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
                            fb.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(fb);
                        } catch (Throwable ignored) {
                            Toast.makeText(BridgeOverlayService.this,
                                "无法打开无障碍设置页", Toast.LENGTH_SHORT).show();
                        }
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
