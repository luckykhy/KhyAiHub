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
 * ({@code ui}, {@code sidecar}, {@code shizuku}, {@code budget}). What it never
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

    /** Shizuku is installed, connected and granted. */
    public final boolean shizuku;
    /** Why it is not. Empty when it is. */
    public final String shizukuWhy;

    /** Both elevation routes named, and which one needs a computer. */
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

    public CapabilitySnapshot(boolean ui, String uiWhy, String uiAdvice,
                              boolean sidecar, String sidecarWhy,
                              boolean shizuku, String shizukuWhy,
                              String elevationAdvice,
                              long bytesLeft, long byteBudget,
                              boolean elevationUnconfirmed,
                              String model, String release, int sdk) {
        this.ui = ui;
        this.uiWhy = uiWhy == null ? "" : uiWhy;
        this.uiAdvice = uiAdvice == null ? "" : uiAdvice;
        this.sidecar = sidecar;
        this.sidecarWhy = sidecarWhy == null ? "" : sidecarWhy;
        this.shizuku = shizuku;
        this.shizukuWhy = shizukuWhy == null ? "" : shizukuWhy;
        this.elevationAdvice = elevationAdvice == null ? "" : elevationAdvice;
        this.bytesLeft = Math.max(0, bytesLeft);
        this.byteBudget = Math.max(0, byteBudget);
        this.elevationUnconfirmed = elevationUnconfirmed;
        this.model = model == null ? "" : model;
        this.release = release == null ? "" : release;
        this.sdk = sdk;
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
        // 重探一次 Shizuku。为什么需要：HttpBridge 启动时那条 shizuku-probe 线程
        // 可能跑在 Tools.init() 之前，于是 shizukuWhy 被写成「桥没有 Context」，
        // 而之后再没有重探过——那个说法就此永久留在 info 里，哪怕桥后来明明有
        // Context。2026-10-26 真机上正是这样。
        //
        // 为什么敢在这里探：Tools.shizukuReady() 的 javadoc 要求「不能放进悬浮框
        // ticker，那条路径零 IO」。capture 的调用方是 info 工具和 ask 的前置渲染，
        // 都不是 ticker；而且本机没装 Shizuku 时 ensureConnected 只是一次失败的
        // getPackageInfo，代价远小于一次 ui_dump。
        if (c != null) {
            try {
                Tools.probeShizuku();
            } catch (Throwable ignored) {
            }
        }
        return new CapabilitySnapshot(
                Tools.uiReady(), Tools.uiWhy(), Tools.uiAdvice(),
                Tools.sidecarReady(), Tools.sidecarWhy(),
                Tools.shizukuReady(), Tools.shizukuWhy(),
                Tools.elevationAdvice(),
                budget - used, budget,
                // 只有 sidecar 单独处于"通了但没证实"时才为真。Shizuku 的
                // available 本身就是一次真握手，没有这个中间态。
                !Tools.sidecarReady() && !Tools.shizukuReady()
                        && ShellSidecarClient.online(),
                model, release, sdk);
    }

    /** True when at least one uid-2000 channel is up. */
    public boolean elevated() {
        return sidecar || shizuku;
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
                    .put("shizuku", shizuku)
                    .put("shizuku_why", shizukuWhy)
                    .put("elevation_advice", elevationAdvice)
                    .put("elevated", elevated())
                    .put("elevation_unconfirmed", elevationUnconfirmed)
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

    @Override
    public String toString() {
        return "CapabilitySnapshot{ui=" + ui + ", sidecar=" + sidecar
                + ", shizuku=" + shizuku + ", bytesLeft=" + bytesLeft + "}";
    }
}
