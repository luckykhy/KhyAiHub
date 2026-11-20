package com.khyos.khy_os_client.bridge;

/**
 * UI 层当前选中的 driver —— 由 Dart 上报，纯内存。
 *
 * <h3>为什么不让 Java 自己判断</h3>
 * 「选了什么」是 UI 状态（{@code ActiveDriverNotifier}），「这一轮会走哪条路」
 * 是原生事实（{@link CapabilitySnapshot#driver}）。两者分开存、分开报：
 * 降级的现场恰恰是「选的是 amoo，实际走的是 screen」，合成一个字段就再也
 * 说不出这件事了。
 *
 * <h3>为什么纯内存</h3>
 * 进程被杀之后「上次选了什么」没有意义——重启后 UI 自己会重新选一次并再上报。
 * 落盘只会留下一个过期的选择，让 {@code info} 报一个已经不在生效的值。
 */
public final class BridgeDriverState {

    private static volatile String selected = "";
    private static volatile long updatedMs = 0L;

    private BridgeDriverState() {
    }

    public static void set(String id) {
        selected = id == null ? "" : id.trim();
        updatedMs = System.currentTimeMillis();
    }

    /** 空串 = 本轮进程内 Dart 还没上报过。 */
    public static String selected() {
        return selected;
    }

    public static long updatedMs() {
        return updatedMs;
    }
}
