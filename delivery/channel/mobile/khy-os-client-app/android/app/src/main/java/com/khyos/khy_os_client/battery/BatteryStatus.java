package com.khyos.khy_os_client.battery;

import java.util.HashMap;
import java.util.Map;

/**
 * 电池 / 后台运行状态的统一快照。
 *
 * <p>为什么是"一个结构"而不是若干个散落的 boolean：这个 App 的用户同时面对三件
 * 互相独立、又互相长得像的事——系统省电（Doze/App Standby 冻结）、厂商自启动/后台
 * 开关、以及 Android 13+ 侧载应用的"受限设置"。用户反馈时说的往往是同一句话
 * （"无障碍又掉了"），但三种病因的解法完全相反：前两种要去系统/厂商页放行，第三种
 * 要去 App 信息里解除"受限设置"。把这三项合成一个结构返回，UI 才有办法把它们分开讲。
 *
 * <p><b>字段一律只用于提示与引导</b>。任何一项为 false 都不允许阻断主流程——
 * 见 {@code [DESIGN-ARCH-*} 电池白名单引导} 的约束：检测是给人看的，不是闸门。
 *
 * <p>本类不引用任何 Android 类型，因此可在 JVM 单测里直接构造与断言。
 */
public final class BatteryStatus {

    /**
     * 自启动状态。
     *
     * <p>为什么只有三态而不是布尔：自启动<b>没有任何标准 API</b>，各家 ROM 的
     * 实现彼此无关、随版本改名。能判出来就是判出来，判不出来必须是
     * {@link #UNKNOWN}——把它折成 boolean 就等于告诉用户"已关闭"，而用户会照着
     * 一个假结论去反复找开关。
     */
    public enum AutostartState {
        /** 厂商侧明确报告"允许自启动"。 */
        ALLOWED("allowed"),
        /** 厂商侧明确报告"禁止自启动"。 */
        DENIED("denied"),
        /** 判不出来（绝大多数 ROM 与所有非厂商机型）。 */
        UNKNOWN("unknown");

        public final String wire;

        AutostartState(String wire) {
            this.wire = wire;
        }

        public static AutostartState fromWire(String s) {
            if (s == null) return UNKNOWN;
            for (AutostartState v : values()) {
                if (v.wire.equals(s)) return v;
            }
            return UNKNOWN;
        }
    }

    /** 厂商名（{@code Build.MANUFACTURER}，小写去空白）。 */
    public final String manufacturer;

    /** 是否已在系统电池优化白名单里（{@code PowerManager.isIgnoringBatteryOptimizations}）。 */
    public final boolean isIgnoringBatteryOptimizations;

    /** 是否被后台限制（{@code ActivityManager.isBackgroundRestricted}）。 */
    public final boolean isBackgroundRestricted;

    /** 自启动状态。 */
    public final AutostartState autostartState;

    /**
     * 是否"疑似处于受限设置"（Android 13+ 侧载安装，无障碍开关被置灰）。
     *
     * <p>为什么要单独拎出来：受限设置下无障碍开关是<b>灰的</b>，用户点不动，
     * 于是他以为"电池优化没做"，于是去电池页反复折腾——而真正的解法在
     * App 信息页的"允许受限设置"。不区分这两件事，引导就指错了地方。
     */
    public final boolean restrictedSettingsLikely;

    /** 本次检测的时间戳（epoch ms）。 */
    public final long lastCheckAt;

    public BatteryStatus(String manufacturer,
                         boolean isIgnoringBatteryOptimizations,
                         boolean isBackgroundRestricted,
                         AutostartState autostartState,
                         boolean restrictedSettingsLikely,
                         long lastCheckAt) {
        this.manufacturer = manufacturer == null ? "" : manufacturer;
        this.isIgnoringBatteryOptimizations = isIgnoringBatteryOptimizations;
        this.isBackgroundRestricted = isBackgroundRestricted;
        this.autostartState = autostartState == null ? AutostartState.UNKNOWN : autostartState;
        this.restrictedSettingsLikely = restrictedSettingsLikely;
        this.lastCheckAt = lastCheckAt;
    }

    /**
     * 是否有"需要用户动手"的项。
     *
     * <p>注意：{@link AutostartState#UNKNOWN} 不算需要动手——判不出来不等于
     * 有问题，只等于"要去厂商页自己看一眼"。把这个算成"需要处理"会让所有非
     * 厂商机型永远显示一条待办，用户学会忽略它之后，这条提示也就失效了。
     */
    public boolean hasActionable() {
        return !isIgnoringBatteryOptimizations || isBackgroundRestricted
                || restrictedSettingsLikely || autostartState == AutostartState.DENIED;
    }

    /** 转成 MethodChannel 能直接送出的 Map。 */
    public Map<String, Object> toMap() {
        Map<String, Object> m = new HashMap<String, Object>();
        m.put("manufacturer", manufacturer);
        m.put("isIgnoringBatteryOptimizations", isIgnoringBatteryOptimizations);
        m.put("isBackgroundRestricted", isBackgroundRestricted);
        m.put("autostartState", autostartState.wire);
        m.put("restrictedSettingsLikely", restrictedSettingsLikely);
        m.put("lastCheckAt", lastCheckAt);
        m.put("hasActionable", hasActionable());
        return m;
    }

    @Override
    public String toString() {
        return "BatteryStatus{" + manufacturer
                + ", ignoreBattery=" + isIgnoringBatteryOptimizations
                + ", bgRestricted=" + isBackgroundRestricted
                + ", autostart=" + autostartState.wire
                + ", restrictedSettings=" + restrictedSettingsLikely
                + ", at=" + lastCheckAt + '}';
    }
}
