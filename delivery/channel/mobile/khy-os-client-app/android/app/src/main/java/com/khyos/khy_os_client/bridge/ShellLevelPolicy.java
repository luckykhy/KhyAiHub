// khy-canary: Khy-20261113-001-SHELLLEVEL
package com.khyos.khy_os_client.bridge;

import java.util.Arrays;
import java.util.Locale;
import java.util.Set;

/**
 * Which commands can only work at the shell layer (uid 2000).
 *
 * WHY this class exists. Before it, {@code exec} fell back to the app's own
 * uid when the sidecar was down and reported {@code ok:true} whenever
 * {@code sh} exited 0. For {@code input}, {@code am} and {@code pm} that exit
 * status means nothing: the command is parsed, permission is denied, and the
 * shell still exits 0 on some builds. The caller reads success, the screen
 * does not change, and nobody can tell from outside. That is the exact
 * "looks successful but changes nothing" failure this policy removes.
 *
 * WHAT IS NOT HERE. The A-class tools (ls/read/write/mkdir/rm/mv/cp/stat/
 * zip/unzip, clipboard/toast/notify/vibrate, shot/record_audio/camera_open,
 * the ui_* accessibility tools, volume/brightness) never call this class:
 * they work as the app's own uid, and gating them would break the
 * "install and it works" promise.
 *
 * Pure Java, no Android types, so the rules run in a bare JVM unit test.
 */
public final class ShellLevelPolicy {

    /**
     * Stable error code for every B-class call made without the shell layer.
     *
     * WHY THE NAME CHANGED (2026-11-16). It used to be {@code elevation_required},
     * which describes the *cause*; the caller needs to know the *fix*. {@code needs_shell}
     * says what is missing — a shell layer (uid 2000) — and that is the thing the user
     * can actually go and get (turn on wireless debugging, pair once). The old name
     * also read as "the app wants more privilege", which is not what happened:
     * the app never asks for privilege, it runs as the user gave it.
     *
     * The old string is still accepted by readers that learned it (the Dart side
     * treats both as the same refusal), so this is a rename, not a wire break.
     */
    public static final String CODE = "needs_shell";

    /** The previous name for {@link #CODE}; kept so old readers still recognise it. */
    public static final String LEGACY_CODE = "elevation_required";

    /**
     * Commands that address the system rather than this app. {@code settings}
     * covers both {@code get} and {@code put}: the app uid cannot read the
     * settings providers either.
     *
     * LinkedHashSet, not HashSet: the order is part of the contract now — {@code info}
     * publishes this list so a caller can tell in advance which command families
     * need the shell layer, and an unstable order would make two identical devices
     * report different lists.
     */
    private static final Set<String> SHELL_ONLY = new java.util.LinkedHashSet<>(Arrays.asList(
            "input", "am", "pm", "cmd", "content", "dumpsys", "settings",
            "setprop", "svc", "wm", "appops", "device_config"));

    private ShellLevelPolicy() {
    }

    /**
     * The command families that only work at the shell layer, in a stable order.
     *
     * WHY THIS IS PUBLISHED. "Which commands need elevation" used to be knowledge
     * that lived only inside this class: a caller had to try a command and read the
     * refusal to find out. A model that does not know in advance will try
     * {@code input tap} at the app tier, get a refusal, and — having been told
     * nothing else — try the next thing. Publishing the list lets the caller decide
     * before spending a round trip on it.
     */
    public static java.util.List<String> shellOnlyCommands() {
        return java.util.Collections.unmodifiableList(new java.util.ArrayList<>(SHELL_ONLY));
    }

    /**
     * True when {@code cmd} cannot do its job as the app's own uid.
     *
     * A command is B-class when any of its segments starts with one of
     * {@link #SHELL_ONLY}, or when it references {@code /data} (the app uid
     * cannot traverse it; the sidecar can).
     */
    public static boolean requiresShell(String cmd) {
        if (cmd == null) {
            return false;
        }
        String text = cmd.trim();
        if (text.isEmpty()) {
            return false;
        }
        if (referencesDataPartition(text)) {
            return true;
        }
        for (String segment : text.split("(?:;|&&|\\|\\||\\||&|\\r?\\n)")) {
            String first = firstWord(segment);
            if (first != null && SHELL_ONLY.contains(first)) {
                return true;
            }
        }
        return false;
    }

    /**
     * One human-readable line explaining why the call was refused.
     *
     * The command name is included because callers batch several execs; a
     * generic "需要提权" sentence is not enough to know which one failed.
     *
     * The second half names the way out. A refusal that only says "no" leaves the
     * caller with nothing to do; the whole point of refusing loudly instead of
     * running as the app uid is that the caller can then go and fix it.
     */
    public static String reason(String cmd) {
        String name = offendingCommand(cmd);
        String what = name == null ? "这条命令" : "`" + name + "`";
        return what + " 需要 shell 层（uid 2000）才能生效，当前只有 App 身份。"
                + "在 App 的「提权」页开一次无线调试并配对（或用电脑侧脚本拉起提权代理），"
                + "之后这条命令原样重试即可。";
    }

    /** The first B-class word found, or null when the trigger was a /data path. */
    private static String offendingCommand(String cmd) {
        if (cmd == null) {
            return null;
        }
        for (String segment : cmd.trim().split("(?:;|&&|\\|\\||\\||&|\\r?\\n)")) {
            String first = firstWord(segment);
            if (first != null && SHELL_ONLY.contains(first)) {
                return first;
            }
        }
        return null;
    }

    /** First executable word of a segment, skipping env assignments. */
    private static String firstWord(String segment) {
        String s = segment.trim();
        if (s.isEmpty()) {
            return null;
        }
        String[] parts = s.split("\\s+");
        for (String part : parts) {
            if (part.isEmpty() || part.indexOf('=') > 0) {
                continue;
            }
            int slash = part.lastIndexOf('/');
            return (slash >= 0 ? part.substring(slash + 1) : part).toLowerCase(Locale.ROOT);
        }
        return null;
    }

    /** Any path that points into /data (the sidecar's territory, not the app's). */
    private static boolean referencesDataPartition(String text) {
        String padded = " " + text + " ";
        int at = padded.indexOf("/data/");
        while (at >= 0) {
            char before = padded.charAt(at - 1);
            if (before == ' ' || before == '=' || before == '\'' || before == '"'
                    || before == ':' || before == '(') {
                return true;
            }
            at = padded.indexOf("/data/", at + 1);
        }
        return false;
    }
}
