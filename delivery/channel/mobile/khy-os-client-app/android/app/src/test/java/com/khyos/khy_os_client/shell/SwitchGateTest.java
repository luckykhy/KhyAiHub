// khy-canary: Khy-20261117-004-SWITCHGATE
package com.khyos.khy_os_client.shell;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.khyos.khy_os_client.bridge.ShellLevelPolicy;

import org.junit.Test;

/**
 * SwitchGateTest — the elevation switch is a gate on EVERY raise path.
 *
 * WHY this test exists (2026-11-17). The task's red line is that elevation is
 * off by default and turning it on is the user's explicit first step; the
 * second step (raise) then lifts the agent. Measured on a real device, the
 * bridge tool enforced that and the UI did NOT: {@code elevationBootstrap} —
 * the path the「让手机自己拉起」button takes — called
 * {@link ElevationBootstrap#bootstrap} directly, so a uid-2000 agent came up
 * with the switch off. One入口 enforcing a red line while the other does not
 * is worse than neither, because it makes the guide's promise false in the
 * direction that matters.
 *
 * What is pinned here is the part that is cheap to get silently wrong: the
 * refusal text. The UI audience and the tool audience must get different next
 * steps ("open the switch on this page" vs "run elevate op=on") — telling a
 * person tapping a button to run a bridge command is how "self-elevation
 * failed" gets reported when nothing is broken.
 */
public class SwitchGateTest {

    @Test
    public void theUiRefusalNamesSomethingTheUserCanActuallyDo() throws Exception {
        String msg = ElevationBootstrap.switchOffMessage(true);
        // 给人看的那半句必须指向界面上的开关，不能指向一条命令。
        assertTrue("UI 回执要提到开关: " + msg, msg.contains("启用提权"));
        assertTrue("UI 回执要点名下一步动作: " + msg, msg.contains("让手机自己拉起"));
        assertFalse("UI 回执不许出现桥工具命令: " + msg, msg.contains("elevate op=on"));
        // 共用的理由：为什么不静默提权。
        assertTrue(msg.contains(ElevationBootstrap.SWITCH_OFF_WHY));
    }

    @Test
    public void theToolRefusalNamesTheToolCall() throws Exception {
        String msg = ElevationBootstrap.switchOffMessage(false);
        assertTrue("工具回执要给出命令: " + msg, msg.contains("elevate op=on"));
        assertTrue(msg.contains(ElevationBootstrap.SWITCH_OFF_WHY));
    }

    @Test
    public void theRefusalCodeIsNeedsShell() throws Exception {
        // 两个入口（桥工具与 UI 按钮）都直接取 ShellLevelPolicy.CODE，值必须是
        // needs_shell：调用方按它分支，悄悄改名会让它们全落进「未知错误」。
        assertEquals("needs_shell", ShellLevelPolicy.CODE);
    }

    @Test
    public void theNotPairedRefusalSaysPairingNotTheAddress() throws Exception {
        // 实测 2026-11-18：全新安装（没配对）时，旧回执说的是「连不上无线调试端口…
        // 端口可能已经过期」——用户照着它去改那个本来没错的地址。这里钉住新回执
        // 必须指向配对，并且明说「填端点代替不了它」。
        String msg = ElevationBootstrap.notPairedMessage("unpaired");
        assertTrue("要说明是配对问题: " + msg, msg.contains("配对"));
        assertTrue("要给出下一步: " + msg, msg.contains("6 位"));
        assertTrue("要堵住「填地址就行」这个误解: " + msg, msg.contains("代替不了"));
        assertFalse("不许把用户指回地址/端口: " + msg, msg.contains("端口可能已经过期"));
        // 授权态要出现在 detail 里（调用方与排查都要看得见）
        assertTrue(msg.contains("unpaired"));
    }

    private static void assertEquals(Object a, Object b) {
        org.junit.Assert.assertEquals(a, b);
    }
}
