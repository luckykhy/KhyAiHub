package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * S5 / T15：Download 里的误装源要被拦在 pm 之前。
 *
 * 实测形态（2026-11-17）：Download 里同时躺着 debug 签名包与已装的
 * release 包，同包名同 versionName，肉眼看不出差别——装上去就是
 * INSTALL_FAILED_UPDATE_INCOMPATIBLE，或者更糟：反过来把 release 的覆盖掉。
 * 判据收成一个纯函数，JVM 单测不需要 Android 运行时就能钉死这张决策表。
 */
public class InstallGuardTest {

    private static final String OWN_PKG = "com.khyos.khy_os_client";
    private static final String OWN_RELEASE = "cb16f14c" + "a".repeat(48);
    private static final String DEBUG_SIG = "75ca93f5" + "b".repeat(48);

    @Test
    public void samePackageDifferentSignatureIsRefusedWithAFix() throws Exception {
        JSONObject r = InstallGuard.evaluate(OWN_PKG, OWN_PKG, DEBUG_SIG, OWN_RELEASE);
        assertFalse(r.optBoolean("ok"));
        assertEquals("signature_mismatch", r.optString("code"));
        String err = r.optString("error");
        assertTrue("错误必须说出两边签名的差别才可判读: " + err,
                err.contains("75ca93f5") && err.contains("cb16f14c"));
        assertTrue("错误必须给出可执行的下一步: " + err, err.contains("Download"));
    }

    @Test
    public void samePackageSameSignaturePasses() throws Exception {
        JSONObject r = InstallGuard.evaluate(OWN_PKG, OWN_PKG, OWN_RELEASE, OWN_RELEASE);
        assertTrue(r.optBoolean("ok"));
        assertEquals("", r.optString("code", ""));
    }

    @Test
    public void aDifferentPackageIsNotThisGuardBusiness() throws Exception {
        // 装别的 App 是既有能力；这道闸只管「往本 App 头上盖一个不同签名的包」。
        JSONObject r = InstallGuard.evaluate("com.other.app", OWN_PKG, DEBUG_SIG, OWN_RELEASE);
        assertTrue(r.optBoolean("ok"));
    }

    @Test
    public void unreadableArchiveSignatureDoesNotBlockButIsDeclared() throws Exception {
        // 解析不出签名时拦不拦？拦=把所有无法判读的包都拒了（误伤合法安装），
        // 放=回到 pm 的行为。选放行，但必须把「没验证」写进回执，不许假装查过。
        JSONObject r = InstallGuard.evaluate(OWN_PKG, OWN_PKG, "", OWN_RELEASE);
        assertTrue(r.optBoolean("ok"));
        assertEquals("signature_unknown", r.optString("code"));
        JSONObject r2 = InstallGuard.evaluate(OWN_PKG, OWN_PKG, null, OWN_RELEASE);
        assertTrue(r2.optBoolean("ok"));
        assertEquals("signature_unknown", r2.optString("code"));
    }

    @Test
    public void emptyPackageNameFallsBackToOwningComparison() throws Exception {
        // getPackageArchiveInfo 解析失败时 pkg 为 null：没有包名就没有「盖错签名」
        // 的主体，交给 pm 的既有行为（不是这道闸的误伤对象）。
        JSONObject r = InstallGuard.evaluate(null, OWN_PKG, DEBUG_SIG, OWN_RELEASE);
        assertTrue(r.optBoolean("ok"));
    }
}
