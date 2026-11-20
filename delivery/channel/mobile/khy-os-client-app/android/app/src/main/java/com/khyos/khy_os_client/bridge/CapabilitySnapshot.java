// khy-canary: Khy-20261101-012-QYZ0A2BT
package com.khyos.khy_os_client.bridge;

import android.content.Context;

import org.json.JSONObject;

/**
 * CapabilitySnapshot — what the phone can actually do, right now.
 *
 * WHY this class exists. The bridge has reported capability *counts* for a
 * while ({@code info} returns {@code tools: NAMES.length}, {@code /status}
 * returns the same number) and has reported *state* for just as long
 * ({@code ui}, {@code sidecar}, {@code elevation}, {@code budget}). What it never
 * did was put the two together, so a caller — human or model — had to know that
 * "42 tools" plus "ui=false" means "the eleven UI tools do not work right now".
 * That inference is exactly the kind that gets made wrong, and it gets made
 * wrong in the pessimistic direction: a model that is unsure whether it can tap
 * the screen will say it cannot.
 *
 * So this is ONE object holding both halves, built once and consumed twice:
 *   · {@code info} returns it as {@code capabilities}
 *   · the self-description renders a paragraph from it
 *
 * WHY ONE SOURCE. Before this, {@code info} assembled those fields inline. If
 * the self-description had re-derived them, the two would drift — and the
 * failure mode is the worst available: the description claims a capability that
 * {@code info} contradicts, and the model believes the description because it
 * is prose and {@code info} is a field.
 *
 * WHY THE FIELDS ARE INJECTABLE. Every method here takes the state as
 * arguments rather than reading it, so {@link #of} is the only thing that
 * touches the device and the rendering can be tested on a bare JVM with
 * hand-built states. The Java unit tests in this project run without
 * Robolectric — anything that reached for {@code Context} inside the render
 * path would be untestable.
 *
 * Contract: immutable, never throws, no Android types in the render path.
 */
public final class CapabilitySnapshot {

    /** Accessibility service bound and able to act. */
    public final boolean ui;
    /** Why the accessibility service is unavailable. Empty when it is. */
    public final String uiWhy;
    /** What to do about it, in Chinese. Empty when there is nothing to do. */
    public final String uiAdvice;

    /** The uid-2000 shell sidecar is usable. */
    public final boolean sidecar;
    /** Why it is not. Empty when it is. */
    public final String sidecarWhy;

    /**
     * Whether elevation is available at all.
     *
     * 2026-11-12（人裁决：完全移除第三方提权应用）：提权只剩一级——sidecar。
     * 所以这个字段现在就是 sidecar 那一级的别名，JSON 键名仍是 "elevation"
     * （消费方读的是键名，不是 Java 字段名，改键名会动契约，不在本次范围内）。
     */
    public final boolean elevation;
    /** Why elevation is unavailable. Empty when it is available. */
    public final String elevationWhy;

    /** What the user should do about the elevation state, in Chinese. */
    public final String elevationAdvice;

    /** Remaining read budget for this session, in bytes. 0 when exhausted. */
    public final long bytesLeft;
    /** Total byte budget, for the "已用 X / 共 Y" phrasing. */
    public final long byteBudget;

    /**
     * The sidecar answered a PING but no exec has confirmed it yet.
     *
     * THE THIRD STATE, AND WHY IT EXISTS. {@link Tools#sidecarReady()} is
     * deliberately pessimistic: it only turns true after a real exec succeeds,
     * because "will it run anything" needs the token and one actual command to
     * prove. That leaves a window — every moment between provisioning and the
     * first exec — in which the sidecar is listening and {@code ready} is still
     * false. Caught on device on 2026-10-26: {@code info} reported
     * {@code sidecar:false} with {@code sidecar_why:"sidecar 在线，待首次执行确认"}
     * while the sidecar was in fact up.
     *
     * Without this flag the capability paragraph has only two options in that
     * window, and both are wrong: claim elevation works (unproven) or claim
     * exec cannot change the system (false, and the very next exec disproves
     * it). So the description says "unconfirmed, try it" instead.
     */
    public final boolean elevationUnconfirmed;

    /** Build.MODEL — the phone, for the description's opening line. */
    public final String model;
    /** Build.VERSION.RELEASE. */
    public final String release;
    /** Build.VERSION.SDK_INT. */
    public final int sdk;

    /**
     * 此刻 {@code amoo_ask} 这一轮会先走哪条路：{@code amoo-direct} /
     * {@code amoo-screen} / {@code amoo-none}。
     *
     * 为什么这个字段必须存在：断点四之前的现状是「反代靠读屏」，但代码里其实
     * 两条路都在（AmooApexLink 直连 + AmooLoop 读屏），**没有任何字段说得出
     * 这一轮走的是哪条**。于是一个「锁屏 + 无障碍关闭仍然答上了」的现场，
     * 和「无障碍开着、读屏答上的」现场，在证据里长得一模一样。
     *
     * 取值只报原生能看见的那一段：{@code local} / {@code pc-bridge} /
     * {@code script} 是 Dart UI 层的 driver 选择，原生侧不知道，硬报就是猜。
     * UI 的选择走 {@code driver_selected}（Dart 同步过来的），两个字段各自诚实。
     */
    public final String driver;
    /** 为什么是这条。空串 = 没有可解释的（正常直连）。 */
    public final String driverWhy;

    public CapabilitySnapshot(boolean ui, String uiWhy, String uiAdvice,
                              boolean sidecar, String sidecarWhy,
                              boolean elevation, String elevationWhy,
                              String elevationAdvice,
                              long bytesLeft, long byteBudget,
                              boolean elevationUnconfirmed,
                              String model, String release, int sdk) {
        this(ui, uiWhy, uiAdvice, sidecar, sidecarWhy, elevation, elevationWhy,
                elevationAdvice, bytesLeft, byteBudget, elevationUnconfirmed,
                model, release, sdk, "amoo-none", "未探测");
    }

    public CapabilitySnapshot(boolean ui, String uiWhy, String uiAdvice,
                              boolean sidecar, String sidecarWhy,
                              boolean elevation, String elevationWhy,
                              String elevationAdvice,
                              long bytesLeft, long byteBudget,
                              boolean elevationUnconfirmed,
                              String model, String release, int sdk,
                              String driver, String driverWhy) {
        this.ui = ui;
        this.uiWhy = uiWhy == null ? "" : uiWhy;
        this.uiAdvice = uiAdvice == null ? "" : uiAdvice;
        this.sidecar = sidecar;
        this.sidecarWhy = sidecarWhy == null ? "" : sidecarWhy;
        this.elevation = elevation;
        this.elevationWhy = elevationWhy == null ? "" : elevationWhy;
        this.elevationAdvice = elevationAdvice == null ? "" : elevationAdvice;
        this.bytesLeft = Math.max(0, bytesLeft);
        this.byteBudget = Math.max(0, byteBudget);
        this.elevationUnconfirmed = elevationUnconfirmed;
        this.model = model == null ? "" : model;
        this.release = release == null ? "" : release;
        this.sdk = sdk;
        this.driver = driver == null || driver.isEmpty() ? "amoo-none" : driver;
        this.driverWhy = driverWhy == null ? "" : driverWhy;
    }

    /** A snapshot with nothing available — the pessimistic case. */
    public static CapabilitySnapshot none() {
        return new CapabilitySnapshot(false, "", "", false, "", false, "", "",
                0, 0, false, "", "", 0);
    }

    /**
     * Read the live state.
     *
     * Deliberately the only method that touches the device: everything the
     * renderer needs is a field by the time this returns.
     */
    public static CapabilitySnapshot capture(Context c) {
        long used = 0, budget = 0;
        try {
            JSONObject b = Tools.sessionBudget();
            used = b.optLong("bytes", 0);
            budget = b.optLong("byte_budget", 0);
        } catch (Throwable ignored) {
            // Budget is advisory. A failure here must not take the whole
            // snapshot — and therefore the self-description — down with it.
        }
        String model = "", release = "";
        int sdk = 0;
        try {
            model = android.os.Build.MODEL == null ? "" : android.os.Build.MODEL;
            release = android.os.Build.VERSION.RELEASE == null ? ""
                    : android.os.Build.VERSION.RELEASE;
            sdk = android.os.Build.VERSION.SDK_INT;
        } catch (Throwable ignored) {
        }
        // 重探一次提权通道。为什么需要：HttpBridge 启动时那条 sidecar-probe 线程
        // 可能跑在 Tools.init() 之前，于是 sidecarWhy 被写成「桥没有 Context」，
        // 而之后再没有重探过——那个说法就此永久留在 info 里，哪怕桥后来明明有
        // Context。2026-10-26 真机上正是这样。
        //
        // 为什么敢在这里探：sidecarReady() 的 javadoc 要求「不能放进悬浮框
        // ticker，那条路径零 IO」。capture 的调用方是 info 工具和 ask 的前置渲染，
        // 都不是 ticker；而且本机没拉起 sidecar 时 currentStatus 只是一次失败的
        // 握手，代价远小于一次 ui_dump。
        if (c != null) {
            try {
                Tools.probeSidecar();
            } catch (Throwable ignored) {
            }
        }
        // amoo 这一轮会先走哪条路。判据只看「apex 桥装没装」——provider 掉是
        // 运行时故障，会由 AmooChatService._degradeToScreen 在那一轮现场降级，
        // 那件事只有真正发一次 ask 才知道，不是快照能预告的。把「可能掉」也写进
        // driver 会变成猜，而猜错的方向恰好是「看着像直连、其实在读屏」。
        String driver = driverNow(c);
        String driverWhy = "";
        try {
            if (driver.equals("amoo-screen")) {
                driverWhy = Tools.uiReady()
                        ? "apex 桥未安装：回退读屏（需要无障碍 + amoo 窗口在）"
                        : "apex 桥未安装且无障碍不可用：读屏路径也不通";
            }
        } catch (Throwable t) {
            driverWhy = "探测失败：" + t.getClass().getSimpleName();
        }
        return new CapabilitySnapshot(
                Tools.uiReady(), Tools.uiWhy(), Tools.uiAdvice(),
                Tools.sidecarReady(), Tools.sidecarWhy(),
                // 提权只剩一级：sidecar。但「sidecar 进程可用」与「下一命令会用它」
                // 是两个问题——开关关着时前者仍真、后者为假。T8 实测（2026-11-17）
                // 就是这两个字段被填成同一个值，于是 info 说 shell 而 exec 回 app。
                Tools.elevatedNow().equals("shell"), Tools.sidecarWhy(),
                Tools.elevationAdvice(),
                budget - used, budget,
                // 只有 sidecar 单独处于"通了但没证实"时才为真。
                !Tools.sidecarReady() && ShellSidecarClient.online(),
                model, release, sdk,
                driver, driverWhy);
    }

    /**
     * True when the next exec will actually run as uid 2000.
     *
     * Reads {@link #elevation}, not {@link #sidecar}: the two used to be filled
     * from the same value (there is only one elevated channel left, so they were
     * "necessarily equal"), and that equality is exactly what hid T8 — with the
     * switch off, exec fell back to the app uid while info still said
     * {@code elevated:shell}. {@code sidecar} now means "the process is usable"
     * and {@code elevation} means "the switch says use it", so they can and
     * should differ.
     */
    public boolean elevated() {
        return elevation;
    }

    /**
     * The privilege level right now, as the status contract (T1/T2) spells it:
     * "shell" when a uid-2000 channel is up, "none" when not.
     *
     * 2026-11-17: renamed from "sidecar"/"app". The old values named the
     * CHANNEL; the status contract wants the LEVEL — an observer reading info
     * should see none|shell without having to know what a sidecar is. The
     * channel name survives in the {@code via} field of exec receipts, where
     * "which implementation ran it" is the question.
     */
    public String elevatedChannel() {
        // 快照实例是纯投影：elevation 字段在 capture() 里就取自
        // Tools.elevatedNow()（见 :221），这里只许复述，不许再探。
        // JVM 单测直接 new 快照并断言 shell/none，靠的就是这个纯度。
        return elevated() ? "shell" : "none";
    }

    /**
     * 同一档位，但不依赖快照实例——给每 2s 一拍的 status.json 用。
     *
     * 档位定义只允许一处：{@link Tools#elevatedNow()}（开关 + 缓存就绪）。
     * 不读 {@link #sidecar}：「sidecar 进程可用」在开关关着时仍为真，用它冒充
     * 档位正是 T8 实测到的自相矛盾（exec 回 app，info 却报 shell）。零 IO，
     * 只读缓存的 ShellSidecarClient.ready()。
     */
    public static String elevatedChannelNow() {
        return Tools.elevatedNow();
    }

    /**
     * 当前生效的 driver，五取值：amoo-direct | amoo-screen | local | pc-bridge | script。
     *
     * 与 {@link #capture} 分开是因为调用方节奏不同：status.json 每 2s 一拍，
     * 走不了 capture 里的 sidecar 探测（那条路有 IO）。「选了谁」是 UI 状态、
     * 「这一轮实际走哪条」是原生事实——合成一个字段就再也说不清
     * 「选了 amoo、实际在读屏」这件事，而那正是最需要被看见的状态。
     *
     * 无法直连时默认落 amoo-screen（2026-11-15 任务书裁定）：降级要有可读提示，
     * 不许谎称成功；local/pc-bridge/script 是显式选择，原样上报。
     */
    public static String driverNow(Context c) {
        String sel = BridgeDriverState.selected();
        if (sel.equals("local") || sel.equals("pc-bridge") || sel.equals("script")) {
            return sel;
        }
        if (c != null && com.khyos.khy_os_client.AmooApexLink.INSTANCE.isInstalled(c)) {
            return "amoo-direct";
        }
        return "amoo-screen";
    }

    /**
     * The same object as {@code info} reports it.
     *
     * Kept as a separate method rather than inlining the fields at the call
     * site so that "what info says" and "what the description says" cannot
     * drift: both go through here.
     */
    public JSONObject toJson() {
        try {
            return new JSONObject()
                    .put("ui", ui)
                    .put("ui_why", uiWhy)
                    .put("ui_advice", uiAdvice)
                    .put("sidecar", sidecar)
                    .put("sidecar_why", sidecarWhy)
                    .put("elevation", elevation)
                    .put("elevation_why", elevationWhy)
                    .put("elevation_advice", elevationAdvice)
                    .put("elevated", elevatedChannel())
                    .put("elevation_unconfirmed", elevationUnconfirmed)
                    .put("driver", driver)
                    .put("driver_why", driverWhy)
                    // UI 选的那个（amoo / local / pc-bridge / script / assistant）。
                    // 空串 = Dart 还没上报过。与 driver 分开：一个说"选了什么"，
                    // 一个说"这一轮实际会走哪条"——两者不同正是降级的现场。
                    .put("driver_selected", BridgeDriverState.selected())
                    .put("families", families())
                    .put("bytes_left", bytesLeft)
                    .put("byte_budget", byteBudget)
                    .put("model", model)
                    .put("release", release)
                    .put("sdk", sdk);
        } catch (org.json.JSONException e) {
            // Unreachable: scalars only.
            return new JSONObject();
        }
    }

    /**
     * 每个命令族此刻能不能用——「不再用 shell 冒充全能」的机读形态。
     *
     * 为什么标族而不是逐个工具：{@code NAMES} 有 50 个，逐工具标注既冗长，又会和
     * {@link ToolSchema#needsAccessibility}、{@link ShellLevelPolicy} 两张表漂移。
     * 族的划分与那两张表一一对应：界面族就是 needsAccessibility 那一组，
     * {@code shell_elevated} 就是 ShellLevelPolicy 的 B 类。
     *
     * 恒 true 的几族不是占位：文件 / 包管理 / 应用启停 / 系统信息走的是 App 自己的
     * API（java.io、PackageManager、Intent、BatteryManager、AudioManager、
     * Settings.System），不经过任何提权层，没有"此刻不能用"这个状态。真正有门的
     * 只有两族——界面族挂无障碍，shell 的 B 类挂 uid 2000——所以也只有那两族
     * 会随设备状态翻 false。
     */
    public JSONObject families() {
        try {
            return new JSONObject()
                    .put("ui", ui)                    // ui_* / shot / shot_b64
                    .put("ui_why", uiWhy)
                    .put("shell_elevated", sidecar)   // exec 的 B 类：pm/am/input/settings/dumpsys…
                    .put("shell_app", true)           // exec 的 A 类：App 身份就够
                    .put("files", true)
                    .put("apps", true)
                    .put("system_info", true);
        } catch (org.json.JSONException e) {
            return new JSONObject();
        }
    }

    @Override
    public String toString() {
        return "CapabilitySnapshot{ui=" + ui + ", sidecar=" + sidecar
                + ", elevation=" + elevation + ", bytesLeft=" + bytesLeft + "}";
    }
}
