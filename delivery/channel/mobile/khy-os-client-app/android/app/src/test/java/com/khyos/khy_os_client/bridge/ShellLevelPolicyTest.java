package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The gate that turns "command ran, nothing changed" into an honest failure.
 *
 * The corpus is the one that matters on a phone without the sidecar: input /
 * am / pm / settings are the B-class calls whose exit status lies.
 */
public class ShellLevelPolicyTest {

    private static final String[] SHELL_ONLY = {
            "input tap 500 900",
            "input keyevent 3",
            "am start -n com.android.settings/.Settings",
            "am force-stop com.example",
            "pm list packages",
            "pm uninstall com.example",
            "settings put system screen_brightness 120",
            "settings get secure enabled_accessibility_services",
            "dumpsys battery",
            "wm size",
            "svc power stayon true",
    };

    @Test
    public void everyShellOnlyVerbIsRefusedWithoutTheShellLayer() {
        for (String cmd : SHELL_ONLY) {
            assertTrue("应判为需要 shell 层：" + cmd, ShellLevelPolicy.requiresShell(cmd));
        }
    }

    @Test
    public void aShellVerbLaterInTheChainStillCounts() {
        // This is the shape that used to slip through: an allowed first command
        // followed by the one that needs uid 2000.
        assertTrue(ShellLevelPolicy.requiresShell("echo hi; input tap 1 2"));
        assertTrue(ShellLevelPolicy.requiresShell("ls /sdcard && pm list packages"));
        assertTrue(ShellLevelPolicy.requiresShell("echo a || am start -a android.intent.action.VIEW"));
        assertTrue(ShellLevelPolicy.requiresShell("echo a\npm list packages"));
    }

    @Test
    public void envAssignmentsAndAbsolutePathsDoNotHideTheVerb() {
        assertTrue(ShellLevelPolicy.requiresShell("FOO=1 input tap 1 2"));
        assertTrue(ShellLevelPolicy.requiresShell("/system/bin/pm list packages"));
    }

    @Test
    public void dataPartitionIsBClassEvenForAnInnocuousVerb() {
        assertTrue(ShellLevelPolicy.requiresShell("ls /data/local/tmp"));
        assertTrue(ShellLevelPolicy.requiresShell("cat /data/system/packages.list"));
        // A path that merely contains "/data/" as a substring is a different
        // directory; the policy only fires when the slash starts a path.
        assertFalse(ShellLevelPolicy.requiresShell("ls /sdcard/mydata/notes"));
    }

    @Test
    public void appUidWorkIsNotGated() {
        // A-class capabilities must keep working after a plain install; gating
        // them would break the "install and it works" promise.
        assertFalse(ShellLevelPolicy.requiresShell("ls /sdcard"));
        assertFalse(ShellLevelPolicy.requiresShell("cat /sdcard/notes.md"));
        assertFalse(ShellLevelPolicy.requiresShell("echo hello"));
        assertFalse(ShellLevelPolicy.requiresShell("getprop ro.product.model"));
        assertFalse(ShellLevelPolicy.requiresShell(""));
        assertFalse(ShellLevelPolicy.requiresShell(null));
    }

    @Test
    public void theReasonNamesTheCommandAndTheRemedy() {
        String r = ShellLevelPolicy.reason("pm uninstall com.example");
        assertTrue("要说清是哪条命令", r.contains("pm"));
        assertTrue("要说清层级是 uid 2000", r.contains("uid 2000"));
        assertTrue("要给出下一步", r.contains("提权代理"));
    }

    @Test
    public void theErrorCodeIsStable() {
        // Callers match on this string; renaming it is a contract change.
        // 2026-11-17 任务书点名「input/am/pm 明确报 needs_shell」，错误码从
        // elevation_required（描述原因）改为 needs_shell（说清缺什么）。
        // LEGACY_CODE 保留旧值供旧读取方识别——改名不断契约。
        assertEquals("needs_shell", ShellLevelPolicy.CODE);
        assertEquals("elevation_required", ShellLevelPolicy.LEGACY_CODE);
    }
}
