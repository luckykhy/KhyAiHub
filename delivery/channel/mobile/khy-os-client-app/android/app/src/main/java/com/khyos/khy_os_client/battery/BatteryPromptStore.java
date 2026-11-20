package com.khyos.khy_os_client.battery;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.HashMap;
import java.util.Map;

/**
 * 底部提示面板的"以后再说"记忆。
 *
 * <p><b>为什么要有 7 天冷却</b>：电池提示是<b>非阻断</b>的——它不拦任何功能，
 * 只在用户已经遇到掉线时才值得提一句。但"非阻断"不等于"可以反复弹"：同一个
 * 提示每冷启动一次就出现一次，用户第三次就会学会连看都不看，此后它对谁都失效
 * 了。用户点「以后再说」= 现在不想管；7 天是"下回真有掉线再说"的合理间隔。
 *
 * <p><b>本地记录、可清</b>：状态写在 {@link SharedPreferences}（App 私有目录），
 * 用户在设置里随时可以清掉这个冷却记录。
 */
public final class BatteryPromptStore {

    /**
     * 本地记录的键名。
     *
     * <p>带 {@code _v1} 后缀是这个功能的第一版键名。为什么要带版本后缀：这类
     * "用户已经处理过了"的记录一旦换语义（比如冷却天数从 7 改成别的），旧记录
     * 就成了错误的事实——带版本后缀，改语义时换名字，旧记录自然作废。
     */
    private static final String PREF = "khyos_battery_prompt_v1";
    private static final String KEY_DISMISSED_AT = "dismissed_at";
    private static final String KEY_COMPLETED = "completed";
    /** 手动打勾的步骤键前缀。 */
    private static final String KEY_DONE_PREFIX = "step_done_";

    /** 冷却天数。 */
    public static final int COOLDOWN_DAYS = 7;

    private static final long COOLDOWN_MS = COOLDOWN_DAYS * 24L * 60L * 60L * 1000L;

    private BatteryPromptStore() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    /**
     * 现在该不该弹这个面板。
     *
     * @param status 本次检测到的状态；全绿时不弹。
     */
    public static boolean shouldPrompt(Context c, BatteryStatus status) {
        if (c == null || status == null) return false;
        if (!status.hasActionable()) return false;
        try {
            SharedPreferences p = prefs(c);
            if (p.getBoolean(KEY_COMPLETED, false)) return false;
            long at = p.getLong(KEY_DISMISSED_AT, 0L);
            if (at <= 0L) return true;
            return System.currentTimeMillis() - at >= COOLDOWN_MS;
        } catch (Throwable t) {
            // 读不出来就当"该弹"：多弹一次比少弹一次安全。
            return true;
        }
    }

    /** 用户点了「以后再说」。 */
    public static void markDismissed(Context c) {
        try {
            prefs(c).edit()
                    .putLong(KEY_DISMISSED_AT, System.currentTimeMillis())
                    .putBoolean(KEY_COMPLETED, false)
                    .apply();
        } catch (Throwable ignored) {
        }
    }

    /** 用户走完了引导（全部步骤都处理过）。 */
    public static void markCompleted(Context c) {
        try {
            prefs(c).edit().putBoolean(KEY_COMPLETED, true).apply();
        } catch (Throwable ignored) {
        }
    }

    /** 清掉冷却与完成标记（设置页里的「清除记录」）。 */
    public static void clear(Context c) {
        try {
            prefs(c).edit().remove(KEY_DISMISSED_AT).remove(KEY_COMPLETED).apply();
        } catch (Throwable ignored) {
        }
    }

    /**
     * 记下"这一步用户自己处理好了"。
     *
     * <p>为什么需要手动打勾：有些状态<b>系统不告诉应用</b>（自启动权限在 MIUI 上
     * 能探到，在别的 ROM 上探不到；受限设置开关被解除后也没有公开的查询接口）。
     * 强行让用户回到设置页反复确认，比让他自己点一个「已完成」更难用。
     *
     * <p>手动打勾只影响提示层：它让引导页把这一步显示成已完成，<b>不会</b>因此
     * 改动任何系统设置。
     */
    public static void markStepDone(Context c, String stepId) {
        if (stepId == null || stepId.isEmpty()) return;
        try {
            prefs(c).edit().putBoolean(KEY_DONE_PREFIX + stepId, true).apply();
        } catch (Throwable ignored) {
        }
    }

    /** 这一步是否已被用户手动标记为完成。 */
    public static boolean isStepDone(Context c, String stepId) {
        if (stepId == null || stepId.isEmpty()) return false;
        try {
            return prefs(c).getBoolean(KEY_DONE_PREFIX + stepId, false);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 取消某一步的手动完成标记。 */
    public static void clearStepDone(Context c, String stepId) {
        if (stepId == null || stepId.isEmpty()) return;
        try {
            prefs(c).edit().remove(KEY_DONE_PREFIX + stepId).apply();
        } catch (Throwable ignored) {
        }
    }

    /** 状态快照，给设置页显示"下次提示时间"。 */
    public static Map<String, Object> state(Context c) {
        Map<String, Object> out = new HashMap<String, Object>();
        long at = 0L;
        boolean completed = false;
        try {
            SharedPreferences p = prefs(c);
            at = p.getLong(KEY_DISMISSED_AT, 0L);
            completed = p.getBoolean(KEY_COMPLETED, false);
        } catch (Throwable ignored) {
        }
        long now = System.currentTimeMillis();
        long nextAt = at > 0L ? at + COOLDOWN_MS : 0L;
        out.put("dismissedAt", at);
        out.put("completed", completed);
        out.put("cooldownDays", COOLDOWN_DAYS);
        out.put("nextPromptAt", nextAt > now ? nextAt : 0L);
        return out;
    }
}
