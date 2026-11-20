// khy-canary: Khy-20261113-002-EXECGATE
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * ToolsExecGateTest — the dispatch layer, not just the policy.
 *
 * WHY a second test layer. {@link ShellLevelPolicyTest} pins the classifier, but
 * the defect this guards against lives one layer up: {@code exec} used to run
 * the command as the app's uid and report {@code ok:true} whenever {@code sh}
 * exited 0. A correct classifier wired to nothing would still ship that
 * failure, so the refusal is asserted where the caller actually sees it.
 *
 * In a bare JVM there is no bridge token, so {@code ShellSidecarClient.exec}
 * returns null — the same state a fresh install is in before the sidecar is
 * provisioned. Everything below therefore exercises the app-uid path.
 */
public class ToolsExecGateTest {

    @Test
    public void inputIsRefusedAsTheAppUid() throws Exception {
        assertRefused("input tap 1 2");
    }

    @Test
    public void amIsRefusedAsTheAppUid() throws Exception {
        assertRefused("am start -n com.android.settings/.Settings");
    }

    @Test
    public void pmIsRefusedAsTheAppUid() throws Exception {
        assertRefused("pm list packages");
    }

    @Test
    public void aShellVerbLaterInAChainIsStillRefused() throws Exception {
        assertRefused("echo hi; pm uninstall com.example");
    }

    private static void assertRefused(String cmd) throws Exception {
        JSONObject r = Tools.exec(cmd, 5);
        assertTrue("回执里必须有 ok 字段", r.has("ok"));
        assertFalse("未提权时「" + cmd + "」不许报成功", r.getBoolean("ok"));
        assertEquals(ShellLevelPolicy.CODE, r.getString("code"));
        assertFalse("原因不能是空串", r.getString("error").trim().isEmpty());
        assertTrue("原因要点名 shell 层",
                r.getString("error").contains("shell 层"));
        assertEquals("none", r.getString("elevated"));
        assertEquals("app", r.getString("via"));
        assertEquals(126, r.getInt("exit"));
    }
}
