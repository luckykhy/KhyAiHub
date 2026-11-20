package com.khyos.khy_os_client.battery;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.view.accessibility.AccessibilityManager;

import com.khyos.khy_os_client.AccessibilitySetup;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 无障碍服务在**系统侧**的登记状态。
 *
 * <p>为什么要单列一份系统侧事实：App 进程内的 {@code KhyAccessibilityService.instance}
 * 只说"服务对象还在不在"。它看不见两件对用户至关重要的事——
 *   1. 用户在系统设置里把开关关了（框架 unbind，instance 置空，但系统列表里
 *      也已经没了这一项）；
 *   2. Android 13+ 侧载应用的"受限设置"把开关置灰（用户点不动，列表里同样没有）。
 *
 * <p>而 {@code AccessibilityManager.getEnabledAccessibilityServiceList()} 是系统
 * 侧唯一权威的登记清单，比进程内的自述可信。本类只做读取与比对，不做任何写入。
 */
public final class AccessibilityState {

    private AccessibilityState() {}

    /**
     * 本 App 的无障碍服务当前是否登记在系统的"已启用"清单里。
     *
     * <p>注意：这只回答"系统认不认它"，不回答"它此刻还能不能收到事件"——后者
     * 由 {@code KhyAccessibilityService.isAlive()}（事件心跳）负责。两者合起来
     * 才能区分"被关了"与"被冻了"。
     */
    public static boolean isEnabledInSystem(Context c) {
        List<String> ours = ourComponentIds(c);
        if (ours.isEmpty()) return false;
        List<String> enabled = enabledIds(c);
        for (String id : enabled) {
            if (ours.contains(id)) return true;
        }
        return false;
    }

    /**
     * 系统当前已启用的无障碍服务 id 清单（{@code pkg/pkg.Svc} 形状）。
     *
     * <p>取不到时返回空表——调用方据此按"未知"处理，不按"全关"处理。
     */
    public static List<String> enabledIds(Context c) {
        List<String> out = new ArrayList<String>();
        try {
            AccessibilityManager am =
                    (AccessibilityManager) c.getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (am == null) return out;
            List<AccessibilityServiceInfo> list =
                    am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
            if (list == null) return out;
            for (AccessibilityServiceInfo info : list) {
                if (info == null) continue;
                // getId() 给的就是系统登记清单里的原样写法："pkg/cls"。
                // 不用 getServiceInfo() 再拼一遍——拼出来的是同一件事，
                // 而多一次 API 依赖就多一处可能编译不过的地方。
                String id = info.getId();
                if (id == null || id.isEmpty()) continue;
                out.add(id);
            }
        } catch (Throwable ignored) {
            // 取不到就是取不到：空表表示"未知"，不是"没有服务"。
        }
        return out;
    }

    /**
     * 本 App 的无障碍服务在系统清单里可能出现的几种拼写。
     *
     * <p>系统登记的是 {@code pkg/pkg.Svc}，而 Manifest 里写的是 {@code .Svc}
     * （相对名）。两种拼写都要留着比对，否则"明明开了却判定为没开"。
     */
    private static List<String> ourComponentIds(Context c) {
        List<String> out = new ArrayList<String>();
        try {
            String comp = AccessibilitySetup.component(c);
            if (comp == null || comp.isEmpty()) return out;
            out.add(comp);
            int slash = comp.indexOf('/');
            if (slash > 0) {
                String pkg = comp.substring(0, slash);
                String cls = comp.substring(slash + 1);
                if (cls.startsWith(".")) out.add(pkg + "/" + pkg + cls);
                else out.add(pkg + "/." + cls.substring(cls.lastIndexOf('.') + 1));
            }
        } catch (Throwable ignored) {
        }
        return Collections.unmodifiableList(out);
    }
}
