// khy-canary: Khy-20261101-001-RZDZWPTA
package com.khyos.khy_os_client;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;

import com.khyos.khy_os_client.bridge.ShellSidecarClient;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * AccessibilitySetup — turn this app's own accessibility service on and off
 * without sending the user into system settings every time.
 *
 * WHY this class exists. The 系统能力 switch in settings used to have exactly
 * one action in both directions: open {@code Settings.ACTION_ACCESSIBILITY_SETTINGS}.
 * On StepOS (a MIUI derivative) that action lands on the 辅助功能 hub, so the
 * user had to tap 辅助功能 → 无障碍 → scroll → find khy-os → toggle, every
 * single time. Measured on device on 2026-10-26.
 *
 * The obvious shortcuts were tried first and all three are closed on this
 * device, which is why this class writes the setting instead of navigating:
 *
 *   1. {@code ACCESSIBILITY_DETAILS_SETTINGS} + {@code EXTRA_FRAGMENT_ARG_KEY}
 *      — the "land on my own toggle" deep link. Rejected with
 *      {@code SecurityException: requires android.permission
 *      .OPEN_ACCESSIBILITY_DETAILS_SETTINGS}, and that permission is
 *      {@code signature|installer}: neither the app nor even uid 2000 holds it.
 *   2. {@code pm grant android.permission.WRITE_SECURE_SETTINGS} — the route
 *      Tasker/MacroDroid document for one-tap DND and similar. Silently does
 *      nothing here: the permission is {@code signature|privileged}, so
 *      {@code pm grant} refuses it (it only grants {@code dangerous} ones).
 *   3. A public API to enable one's own service. There is none, by design.
 *
 * WHAT IS OPEN. {@code enabled_accessibility_services} lives in
 * {@code Settings.Secure}, and uid 2000 can write it — verified on device:
 * the write takes effect and the service is bound immediately. The app already
 * owns two uid-2000 channels (the shell sidecar, Shizuku), so this class just
 * runs two {@code settings} commands through them.
 *
 * WHY IT IS NOT SILENT, AND WHY THAT IS THE WHOLE DESIGN. Writing
 * {@code enabled_accessibility_services} is the one thing Android deliberately
 * keeps out of an app's hands, because it grants screen reading and synthetic
 * input over every app on the device — the stalkerware primitive. This class
 * therefore never grants anything the user has not already agreed to: a NEW
 * grant only happens after the Dart layer has shown a dialog that says in plain
 * Chinese what is about to be written and where to undo it, and every other
 * caller restores a choice that is already on record (see {@link #PREF_NAME}).
 * The entry point for a new grant is a tap on a switch, and nothing else.
 *
 * WHY READ-MODIFY-WRITE. {@code enabled_accessibility_services} is a
 * colon-separated list that other apps share. Assigning to it would silently
 * disable every other accessibility service on the device — TalkBack included.
 * So the current value is always read first, and only ever appended to or
 * subtracted from. There is no caller that may skip this: the 2026-10-28 fix to
 * {@code BridgeService.reviveA11y} existed because that watchdog was assigning
 * the key outright with its own component, which is the one thing this paragraph
 * forbids.
 *
 * WHY THE STRING LOGIC IS STATIC. Everything here is testable on a bare JVM —
 * no Android imports touch {@link #addToList}, {@link #removeFromList} or
 * {@link #sameService} — which is what makes the merge/split rules provable
 * rather than assumed. The elevation and the PackageManager lookup are the
 * only parts that need a device.
 *
 * Contract: total. Every failure path returns an {@link Attempt} with
 * {@code ok=false} and a Chinese {@code reason}; nothing throws.
 */
public final class AccessibilitySetup {

    private AccessibilitySetup() {}

    /**
     * Charset a component name may legally contain.
     *
     * The merged list is interpolated into a shell command, so a value that
     * does not match this is not merely odd — it is a way to make the app
     * execute something the user did not ask for. When the existing list does
     * not match, the write is refused rather than sanitised: silently dropping
     * a service we failed to parse would disable it without saying so.
     */
    private static final Pattern SAFE = Pattern.compile("[a-zA-Z0-9._/:\\-]+");

    /** The permission that marks a service as an accessibility service. */
    private static final String BIND_ACCESSIBILITY_SERVICE =
            "android.permission.BIND_ACCESSIBILITY_SERVICE";

    private static final String KEY_SERVICES = "enabled_accessibility_services";
    private static final String KEY_ENABLED = "accessibility_enabled";

    // ── consent memory ──────────────────────────────────────────────────────
    //
    // WHY THIS EXISTS. A reinstall (measured: `adb install -r`) clears
    // `enabled_accessibility_services`, so the accessibility service the user
    // turned on is gone after every update and every tool that reads the screen
    // silently stops working. Restoring it is easy — the elevation channel is
    // already here. The hard part is the OTHER case:
    //
    //   Setting absent because the INSTALLER cleared it  → restore, that was
    //                                                   not the user's choice.
    //   Setting absent because the USER turned it off   → must NOT restore.
    //
    // Both look identical from the setting's value, and getting it wrong is not
    // a cosmetic bug: re-granting screen reading after the user withdrew it is
    // the stalkerware primitive this whole class is careful about. So the
    // discriminator is not "is the setting absent" but "did this user ever
    // choose to enable it, through a path that showed them what it means".
    //
    // The flag is therefore written ONLY by enable(Context, userConfirmed=true),
    // which the settings screen reaches after its confirmation dialog, and
    // cleared by disable() — the user switching it off through the app is a
    // deliberate withdrawal. Turning it off from SYSTEM settings cannot be
    // observed, which is why restore is deliberately NOT wired to boot: see
    // restoreIfConsented.
    private static final String PREF_NAME = "khyos_a11y_consent";
    private static final String KEY_CONSENT = "user_enabled_via_app";

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    /** True when the user enabled this service through the app's own UI. */
    public static boolean hasConsent(Context c) {
        try {
            return prefs(c).getBoolean(KEY_CONSENT, false);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * The user-visible switch: may the app restore the service after an update?
     *
     * Deliberately the SAME key {@link #hasConsent} reads. Two keys would let
     * the settings page show 「已开」 while the restore path saw nothing, which
     * is a consent the user gave and the app then ignored.
     */
    public static boolean isAutoRestore(Context c) {
        return hasConsent(c);
    }

    public static boolean setAutoRestore(Context c, boolean on) {
        try {
            setConsent(c, on);
            return prefs(c).getBoolean(KEY_CONSENT, false) == on;
        } catch (Throwable t) {
            return false;
        }
    }

    private static void setConsent(Context c, boolean v) {
        try {
            prefs(c).edit().putBoolean(KEY_CONSENT, v).apply();
        } catch (Throwable ignored) {
            // A failure to persist means the next reinstall will not restore.
            // That is the safe direction: the user gets a notification and a
            // one-tap link instead of a silent re-grant.
        }
    }

    /** Outcome of one enable/disable attempt, including how it got there. */
    public static final class Attempt {
        /** True only when the setting was verified to hold the wanted state. */
        public final boolean ok;
        /** Which channel executed the command: sidecar / shizuku / app. */
        public final String via;
        /** True when the service was already in the wanted state. */
        public final boolean already;
        /** Human-readable, Chinese. Empty on success. */
        public final String reason;

        Attempt(boolean ok, String via, boolean already, String reason) {
            this.ok = ok;
            this.via = via;
            this.already = already;
            this.reason = reason;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Pure string logic. No Android imports below this line.
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Whether two component strings name the same service.
     *
     * The system normalises {@code pkg/.Svc} to {@code pkg/pkg.Svc} on write,
     * so a comparison that did not fold the leading package prefix would see
     * "already enabled" as "not enabled" and append a duplicate. Both spellings
     * are therefore accepted on either side.
     */
    public static boolean sameService(String a, String b) {
        if (a == null || b == null) return false;
        String x = normalize(a);
        String y = normalize(b);
        return !x.isEmpty() && x.equals(y);
    }

    /** {@code pkg/.Svc} and {@code pkg/pkg.Svc} both fold to {@code pkg/pkg.Svc}. */
    static String normalize(String component) {
        if (component == null) return "";
        String s = component.trim();
        int slash = s.indexOf('/');
        if (slash < 0) return s;
        String pkg = s.substring(0, slash);
        String cls = s.substring(slash + 1);
        if (cls.startsWith(".")) cls = pkg + cls;
        return pkg + "/" + cls;
    }

    /** Whether {@code list} already names this service. */
    public static boolean listContains(String list, String component) {
        if (list == null || list.trim().isEmpty()) return false;
        String want = normalize(component);
        for (String part : list.split(":")) {
            if (sameService(part, want)) return true;
        }
        return false;
    }

    /**
     * Append {@code component} to a colon-separated service list.
     *
     * @return the merged list, or null when the existing value cannot be
     *         rewritten safely (see {@link #SAFE}).
     */
    public static String addToList(String list, String component) {
        String me = normalize(component);
        if (!SAFE.matcher(me).matches()) return null;
        if (list == null || list.trim().isEmpty() || "null".equals(list.trim())) {
            return me;
        }
        if (!SAFE.matcher(list).matches()) return null;
        if (listContains(list, me)) return list;
        return list + ":" + me;
    }

    /**
     * Remove {@code component} from a colon-separated service list.
     *
     * @return the remaining list — empty when nothing is left — or null when
     *         the existing value cannot be rewritten safely.
     */
    public static String removeFromList(String list, String component) {
        String me = normalize(component);
        if (list == null || list.trim().isEmpty() || "null".equals(list.trim())) {
            return "";
        }
        if (!SAFE.matcher(list).matches()) return null;
        List<String> kept = new ArrayList<String>();
        for (String part : list.split(":")) {
            if (!sameService(part, me)) kept.add(part);
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < kept.size(); i++) {
            if (i > 0) sb.append(':');
            sb.append(kept.get(i));
        }
        return sb.toString();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Elevation + device side.
    // ─────────────────────────────────────────────────────────────────────

    /**
     * The service component of THIS app's accessibility service.
     *
     * Resolved from the manifest rather than written as a literal: the class
     * name is the kind of thing that gets renamed during a refactor, and a
     * stale literal here would write a component that does not exist — the
     * setting would report success while nothing was enabled.
     */
    public static String component(Context c) {
        try {
            String pkg = c.getPackageName();
            ServiceInfo[] all = c.getPackageManager()
                    .getPackageInfo(pkg, PackageManager.GET_SERVICES).services;
            if (all == null) return "";
            for (ServiceInfo si : all) {
                if (BIND_ACCESSIBILITY_SERVICE.equals(si.permission)) {
                    return pkg + "/" + si.name;
                }
            }
        } catch (Throwable ignored) {
        }
        return "";
    }

    /**
     * Run one {@code settings} command through the app's elevation chain.
     *
     * Order is the same one {@code Tools.exec} uses, and for the same reason:
     * the sidecar is fastest but needs a PC to restart it after a reboot, so
     * Shizuku is tried next and the app's own uid last. The app-uid attempt is
     * expected to fail — but its stderr is the clearest available explanation
     * of why, and a future platform-signed build would make it succeed.
     *
     * @return {via, out, err, exit} or null when no channel produced a result.
     */
    private static String[] run(Context c, String cmd) {
        try {
            JSONObject side = ShellSidecarClient.exec(cmd, "/sdcard", 15);
            if (side != null) {
                return new String[] {"sidecar",
                        side.optString("out", ""),
                        side.optString("err", ""),
                        String.valueOf(side.optInt("exit", -1))};
            }
        } catch (Throwable ignored) {
        }
        try {
            kotlin.Triple<String, String, Integer> sh =
                    ShizukuServiceManager.execViaShizuku(c, cmd, 15000L);
            if (sh != null && sh.getThird() != null && sh.getThird() != -1) {
                return new String[] {"shizuku",
                        sh.getFirst() == null ? "" : sh.getFirst(),
                        sh.getSecond() == null ? "" : sh.getSecond(),
                        String.valueOf(sh.getThird())};
            }
        } catch (Throwable ignored) {
        }
        try {
            ProcessBuilder pb = new ProcessBuilder("/system/bin/sh", "-c", cmd);
            java.lang.Process p = pb.start();
            byte[] out = readAll(p.getInputStream());
            byte[] err = readAll(p.getErrorStream());
            int code = p.waitFor();
            return new String[] {"app",
                    new String(out, "UTF-8"),
                    new String(err, "UTF-8"),
                    String.valueOf(code)};
        } catch (Throwable e) {
            return new String[] {"app", "", String.valueOf(e), "1"};
        }
    }

    private static byte[] readAll(java.io.InputStream in) {
        try {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                if (bos.size() + n > 64 * 1024) break;
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        } catch (Throwable t) {
            return new byte[0];
        }
    }

    /** {@code settings get secure <key>} — the trimmed stdout, or "null". */
    private static String get(Context c, String key) {
        String[] r = run(c, "settings get secure " + key);
        if (r == null) return "null";
        return r[1].trim();
    }

    /** Single-quote a value that has already passed {@link #SAFE}. */
    private static String q(String value) {
        return "'" + value + "'";
    }

    /**
     * Whether the service is currently listed as enabled.
     *
     * Reads the setting rather than asking the service, because the service
     * object only exists once the system has bound it — which is exactly the
     * state being asked about.
     */
    public static boolean isEnabled(Context c) {
        String svc = component(c);
        if (svc.isEmpty()) return false;
        return listContains(get(c, KEY_SERVICES), svc);
    }

    /**
     * Turn the service on.
     *
     * Idempotent: when it is already listed, only {@code accessibility_enabled}
     * is forced to 1 and no list write happens — a duplicate entry would show
     * up in system settings as a second row for the same service.
     *
     * @param userConfirmed true only when the caller has already shown the user
     *        what is about to be granted and where to undo it. This is what arms
     *        the consent flag that lets a later reinstall restore the service;
     *        see {@link #PREF_NAME}. Every other caller — the watchdog, the
     *        boot path, the bridge — must pass false, because those are
     *        restoring a choice, not making one.
     */
    public static Attempt enable(Context c) {
        return enable(c, false);
    }

    public static Attempt enable(Context c, boolean userConfirmed) {
        String svc = component(c);
        if (svc.isEmpty()) {
            return new Attempt(false, "", false, "找不到本 App 的无障碍服务声明");
        }
        String current = get(c, KEY_SERVICES);
        boolean already = listContains(current, svc);
        if (already) {
            String[] r = run(c, "settings put secure " + KEY_ENABLED + " 1");
            if (r == null || !"0".equals(r[3])) {
                return new Attempt(false, r == null ? "" : r[0], true,
                        "写入 accessibility_enabled 失败：" + errOf(r));
            }
            if (userConfirmed) setConsent(c, true);
            return new Attempt(true, r[0], true, "");
        }
        String merged = addToList(current, svc);
        if (merged == null) {
            return new Attempt(false, "", false,
                    "现有无障碍服务列表含无法安全改写的字符，已放弃（不改动他人服务）");
        }
        String[] w1 = run(c, "settings put secure " + KEY_SERVICES + " " + q(merged));
        if (w1 == null || !"0".equals(w1[3])) {
            return new Attempt(false, w1 == null ? "" : w1[0], false,
                    "写入无障碍服务列表失败：" + errOf(w1));
        }
        String[] w2 = run(c, "settings put secure " + KEY_ENABLED + " 1");
        if (w2 == null || !"0".equals(w2[3])) {
            return new Attempt(false, w2 == null ? "" : w2[0], false,
                    "写入 accessibility_enabled 失败：" + errOf(w2));
        }
        // Verify rather than assume: a write that reports exit 0 but did not
        // take effect would leave the switch showing ON with nothing behind it.
        if (!listContains(get(c, KEY_SERVICES), svc)) {
            return new Attempt(false, w1[0], false, "写入后仍未生效，服务没有真正打开");
        }
        if (userConfirmed) setConsent(c, true);
        return new Attempt(true, w1[0], false, "");
    }

    /**
     * Restore the accessibility service after the system cleared it, but only
     * when the user is on record as having chosen it.
     *
     * WHY THIS IS NOT WIRED TO BOOT. On a boot the setting is just as absent
     * whether the installer cleared it or the user turned it off in system
     * settings, and nothing here can tell those apart. Resurrecting it on every
     * boot would mean the app re-grants itself screen reading after a
     * deliberate withdrawal — the exact thing this class refuses to do. The
     * unambiguous signal is ACTION_MY_PACKAGE_REPLACED: the installer is the
     * only party that clears the setting without the user asking, so that is
     * the one place this is called from.
     *
     * Returns null when there is nothing to do (no consent, already enabled, or
     * no elevation channel). Never throws.
     */
    public static Attempt restoreIfConsented(Context c) {
        try {
            if (!hasConsent(c)) return null;
            if (isEnabled(c)) return null;
            // The service object being alive while the setting is absent is the
            // ROM's frozen state, not a cleared one — the watchdog owns that.
            if (com.khyos.khy_os_client.KhyAccessibilityService.Companion.isReady()) {
                return null;
            }
            return enable(c, false);
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 看守专用：无障碍服务被系统冻结（对象还在、事件停收）时，把用户的选择恢复回去。
     *
     * WHY THIS IS NOT {@link #enable}. Two differences, both deliberate:
     *
     *   1. It does not take the {@code already} shortcut. When the service is
     *      frozen the setting still lists it, so {@code enable} would only force
     *      {@code accessibility_enabled=1} and report success — and a revive
     *      that reports success without rebinding is exactly the silent failure
     *      the watchdog exists to catch. So the whole list is rewritten.
     *   2. It is consent-gated. The bridge-side implementation it replaces was
     *      not: a user who switched the service off through this app had
     *      {@link #disable} clear the consent, and the watchdog re-enabled it
     *      thirty seconds later anyway.
     *
     * The write is read-modify-write through {@link #addToList} — the rule the
     * class header calls the whole reason this class exists. The implementation
     * this replaces assigned the key outright with its own component, which
     * silently switched off every other accessibility service on the device.
     *
     * WHAT THE CONSENT GATE BUYS HERE. A user who switches this off through the
     * app runs {@link #disable}, which clears the setting AND the consent flag.
     * The framework then unbinds the service — but not instantly, and
     * {@link com.khyos.khy_os_client.KhyAccessibilityService} only nulls its
     * instance in {@code onUnbind}/{@code onDestroy}. Inside that window the
     * object is still alive with events stopped, which is exactly the watchdog's
     * trigger. Without the gate the watchdog would re-enable a switch the user
     * had just turned off, up to thirty seconds later.
     *
     * WHAT IT DOES NOT NEED TO COVER. A user disabling from SYSTEM settings also
     * unbinds, so the instance is null and the watchdog's {@code wasReady} guard
     * never passes — that path cannot reach here at all. (The real "system
     * settings is invisible to us" blind spot is in
     * {@link #restoreIfConsented}, where a reinstall can resurrect a choice
     * withdrawn from system settings. Recorded there, not here.)
     *
     * @return the attempt, or null when there is no consent (nothing touched).
     *         Never throws.
     */
    public static Attempt revive(Context c) {
        try {
            if (!hasConsent(c)) {
                return null;
            }
            String svc = component(c);
            if (svc.isEmpty()) {
                return new Attempt(false, "", false, "找不到本 App 的无障碍服务声明");
            }
            String merged = addToList(get(c, KEY_SERVICES), svc);
            if (merged == null) {
                return new Attempt(false, "", false,
                        "现有无障碍服务列表含无法安全改写的字符，已放弃（不改动他人服务）");
            }
            String[] w1 = run(c, "settings put secure " + KEY_SERVICES + " " + q(merged));
            if (w1 == null || !"0".equals(w1[3])) {
                return new Attempt(false, w1 == null ? "" : w1[0], false,
                        "写入无障碍服务列表失败：" + errOf(w1));
            }
            String[] w2 = run(c, "settings put secure " + KEY_ENABLED + " 1");
            if (w2 == null || !"0".equals(w2[3])) {
                return new Attempt(false, w2 == null ? "" : w2[0], false,
                        "写入 accessibility_enabled 失败：" + errOf(w2));
            }
            // Verify rather than assume: exit 0 does not prove the framework
            // rebound the service, and a watchdog that cannot tell the
            // difference between "wrote it" and "it works" is worthless.
            if (!listContains(get(c, KEY_SERVICES), svc)) {
                return new Attempt(false, w1[0], false, "写入后仍未生效，服务没有真正打开");
            }
            return new Attempt(true, w1[0], false, "");
        } catch (Throwable t) {
            return new Attempt(false, "", false, String.valueOf(t));
        }
    }

    /**
     * Turn the service off.
     *
     * The capability-reducing direction, so it needs no confirmation beyond
     * the switch tap. Only this app's entry is removed; when the list becomes
     * empty the key is deleted rather than set to "", because an empty
     * {@code enabled_accessibility_services} is not the same thing to the
     * framework as an absent one.
     *
     * Also clears the consent flag. That is what makes "restore after a
     * reinstall" safe: a user who switches this off through the app is
     * withdrawing the choice, and the next update must not put it back.
     */
    public static Attempt disable(Context c) {
        setConsent(c, false);
        String svc = component(c);
        if (svc.isEmpty()) {
            return new Attempt(false, "", false, "找不到本 App 的无障碍服务声明");
        }
        String current = get(c, KEY_SERVICES);
        if (!listContains(current, svc)) {
            return new Attempt(true, "", true, "");
        }
        String rest = removeFromList(current, svc);
        if (rest == null) {
            return new Attempt(false, "", false,
                    "现有无障碍服务列表含无法安全改写的字符，已放弃（不改动他人服务）");
        }
        String[] r;
        if (rest.isEmpty()) {
            r = run(c, "settings delete secure " + KEY_SERVICES);
            String[] off = run(c, "settings put secure " + KEY_ENABLED + " 0");
            if (off == null || !"0".equals(off[3])) {
                return new Attempt(false, off == null ? "" : off[0], false,
                        "关闭 accessibility_enabled 失败：" + errOf(off));
            }
        } else {
            r = run(c, "settings put secure " + KEY_SERVICES + " " + q(rest));
        }
        if (r == null || !"0".equals(r[3])) {
            return new Attempt(false, r == null ? "" : r[0], false,
                    "移除无障碍服务失败：" + errOf(r));
        }
        if (listContains(get(c, KEY_SERVICES), svc)) {
            return new Attempt(false, r[0], false, "移除后仍显示已启用");
        }
        return new Attempt(true, r[0], false, "");
    }

    /**
     * What the UI should tell the user about one-tap availability.
     *
     * WHY THIS DOES NOT PREDICT. The first version read
     * {@link ShellSidecarClient#ready()} and promised "一键可用" / "一键不可用".
     * On device on 2026-10-26 that was caught lying: the flag is only flipped by
     * an actual {@code exec}, so on a cold start it is false even when the
     * sidecar is listening — the line said "一键不可用" while the very next tap
     * succeeded and the service came up. A wrong prediction is worse than none:
     * it sends the user off to set up a channel they already have.
     *
     * So only the cheap, live check is allowed to make a promise: a connected
     * Shizuku binder. Everything else states the requirement and the fallback,
     * and leaves "did it work this time" to the switch itself — whose failure
     * path already carries the real reason plus a way into system settings.
     */
    public static String channelAdvice(Context c) {
        boolean shizuku;
        try {
            shizuku = ShizukuServiceManager.ensureConnected(c).getAvailable();
        } catch (Throwable t) {
            shizuku = false;
        }
        if (shizuku) {
            return "一键可用（Shizuku 已就绪）";
        }
        return "一键需要 sidecar（adb 提权）或 Shizuku；未就绪时点开关会改为打开系统设置";
    }

    private static String errOf(String[] r) {
        if (r == null) return "无提权通道";
        String e = r[2].trim();
        if (e.isEmpty()) e = "exit " + r[3];
        return e.length() > 200 ? e.substring(0, 200) + "…" : e;
    }
}
