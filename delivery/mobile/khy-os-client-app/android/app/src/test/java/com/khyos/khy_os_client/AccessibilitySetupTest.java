// khy-canary: Khy-20261101-032-P8185SHY
package com.khyos.khy_os_client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Tests for the pure string logic in {@link AccessibilitySetup}.
 *
 * WHAT IS UNDER TEST AND WHY IT IS THE RISKY PART. The enable/disable flow is
 * read-modify-write over {@code Settings.Secure.enabled_accessibility_services},
 * a colon-separated list shared with every other accessibility service on the
 * device — TalkBack included. The three ways to get this wrong are all silent:
 *
 *   · assign instead of merge  → every other service is switched off and nobody
 *     is told;
 *   · compare component names without folding {@code pkg/.Svc} to
 *     {@code pkg/pkg.Svc} → the system normalises on write, so "already on"
 *     reads as "off" and a duplicate row appears in system settings;
 *   · interpolate an unvalidated value into a shell command → the app runs
 *     something the user did not ask for.
 *
 * Each of those is a test below. The elevation itself is not tested here — it
 * needs a device, and it is covered by the on-device verification.
 */
public class AccessibilitySetupTest {

    private static final String SVC = "com.khyos.khy_os_client/com.khyos.khy_os_client.KhyAccessibilityService";
    private static final String OTHER = "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService";

    // ── sameService / normalize ──

    @Test
    public void shortAndLongSpellingsNameTheSameService() {
        // 系统写入时会把 pkg/.Svc 规范化成 pkg/pkg.Svc。不折叠这个前缀，
        // 「已启用」就会被读成「未启用」，于是重复追加一行。
        assertTrue(AccessibilitySetup.sameService(
                "com.khyos.khy_os_client/.KhyAccessibilityService",
                "com.khyos.khy_os_client/com.khyos.khy_os_client.KhyAccessibilityService"));
        assertTrue(AccessibilitySetup.sameService(
                "com.khyos.khy_os_client/com.khyos.khy_os_client.KhyAccessibilityService",
                "com.khyos.khy_os_client/.KhyAccessibilityService"));
    }

    @Test
    public void differentServicesAreNotTheSame() {
        assertFalse(AccessibilitySetup.sameService(SVC, OTHER));
    }

    @Test
    public void normalizeIsSymmetricAndHandlesBothSpellings() {
        assertEquals(AccessibilitySetup.normalize("a/.B"), AccessibilitySetup.normalize("a/a.B"));
        assertEquals("a/a.B", AccessibilitySetup.normalize("a/.B"));
    }

    @Test
    public void normalizeSurvivesAValueWithNoSlash() {
        // 畸形值不该抛异常——这里只做字符串折叠，抛出去会把整个开关变成崩溃。
        assertEquals("garbage", AccessibilitySetup.normalize("garbage"));
        assertEquals("", AccessibilitySetup.normalize(null));
    }

    // ── listContains ──

    @Test
    public void containsFindsUsInASharedList() {
        String list = OTHER + ":" + SVC + ":com.third/.Svc";
        assertTrue(AccessibilitySetup.listContains(list, "com.khyos.khy_os_client/.KhyAccessibilityService"));
    }

    @Test
    public void containsIsFalseForAnEmptyOrNullList() {
        assertFalse(AccessibilitySetup.listContains(null, SVC));
        assertFalse(AccessibilitySetup.listContains("", SVC));
        assertFalse(AccessibilitySetup.listContains("   ", SVC));
        assertFalse(AccessibilitySetup.listContains("null", SVC));
    }

    // ── addToList ──

    @Test
    public void addToEmptyListYieldsJustUs() {
        assertEquals(SVC, AccessibilitySetup.addToList("", SVC));
        assertEquals(SVC, AccessibilitySetup.addToList(null, SVC));
    }

    @Test
    public void addAppendsRatherThanReplacing() {
        // 这是整个类最重要的一条：绝不能把别人的服务挤掉。
        String merged = AccessibilitySetup.addToList(OTHER, SVC);
        assertEquals(OTHER + ":" + SVC, merged);
        assertTrue(merged.startsWith(OTHER));
    }

    @Test
    public void addIsIdempotent() {
        // 已在列表里就原样返回——重复追加会让系统设置里出现两行同一个服务。
        String once = AccessibilitySetup.addToList(OTHER, SVC);
        assertEquals(once, AccessibilitySetup.addToList(once, SVC));
    }

    @Test
    public void addRefusesAListItCannotRewriteSafely() {
        // 含 shell 元字符的现有值：宁可放弃，也不把它拼进命令行。
        assertNull(AccessibilitySetup.addToList("a/b; rm -rf /", SVC));
        assertNull(AccessibilitySetup.addToList("a/b$(id)", SVC));
    }

    @Test
    public void addRefusesAnUnsafeComponent() {
        assertNull(AccessibilitySetup.addToList("", "a/b c"));
    }

    // ── 看守拉活的写入值 ──
    //
    // 2026-10-28：BridgeService 的无障碍看守自己拼了一条
    //   settings put secure enabled_accessibility_services <本服务>
    // 那是整体赋值——用户同时开着 TalkBack 时，这一次巡检就把 TalkBack 关掉，
    // 而且没有任何提示。修法是让看守改走 AccessibilitySetup.revive()，由
    // addToList 做读-改-写。
    //
    // 下面这条锁的是「看守最终写进去的那个值」。它测不到「看守有没有走这条路」
    // （那需要设备或源码形状断言），但能保证一旦走了，别人的服务都在。

    @Test
    public void theValueTheWatchdogWritesKeepsEveryOtherService() {
        // 冻结时设置里通常仍然列着本服务，所以走的是「已在列表里」这条分支——
        // 旧实现同样是这个形态，而它照样把别人挤掉了。
        String frozen = OTHER + ":" + SVC;
        assertEquals(frozen, AccessibilitySetup.addToList(frozen, SVC));
        assertTrue(AccessibilitySetup.addToList(frozen, SVC).startsWith(OTHER));

        // 设置被清成只剩 TalkBack 时，补写必须追加而不是替换。
        String onlyOther = OTHER;
        assertEquals(OTHER + ":" + SVC, AccessibilitySetup.addToList(onlyOther, SVC));

        // 三个服务都在时一个都不能少，顺序也保持不变（顺序是用户的开机顺序，
        // 重排会让系统设置里的列表无缘无故变样）。
        String third = "com.example.other/com.example.other.Service";
        String three = OTHER + ":" + third + ":" + SVC;
        assertEquals(three, AccessibilitySetup.addToList(three, SVC));
        assertEquals(three, AccessibilitySetup.addToList(OTHER + ":" + third, SVC));
    }

    @Test
    public void theWatchdogRefusesToWriteAListItCannotParse() {
        // 宁可不动，也不能把一个解析不了的列表重新写回去——那会把解析不出来的
        // 服务静默删掉。旧实现连这一步都没有，直接覆盖。
        assertNull(AccessibilitySetup.addToList(OTHER + ":a/b;reboot", SVC));
        assertNull(AccessibilitySetup.addToList(OTHER + ":a/b`id`", SVC));
    }

    // ── removeFromList ──

    @Test
    public void removeKeepsEveryoneElseInOrder() {
        String list = OTHER + ":" + SVC + ":com.third/.Svc";
        assertEquals(OTHER + ":com.third/.Svc",
                AccessibilitySetup.removeFromList(list, SVC));
    }

    @Test
    public void removeOfTheOnlyEntryLeavesAnEmptyList() {
        assertEquals("", AccessibilitySetup.removeFromList(SVC, SVC));
    }

    @Test
    public void removeOfAnAbsentServiceChangesNothing() {
        assertEquals(OTHER, AccessibilitySetup.removeFromList(OTHER, SVC));
    }

    @Test
    public void removeRefusesAListItCannotRewriteSafely() {
        assertNull(AccessibilitySetup.removeFromList("a/b`id`", SVC));
    }

    // ── round trip ──

    @Test
    public void addThenRemoveRestoresTheOriginalExactly() {
        // 一次开→关不该在列表里留下痕迹：多一个冒号、少一项顺序，都算改坏了。
        for (String start : new String[] {"", OTHER, OTHER + ":com.third/.Svc", "null"}) {
            String merged = AccessibilitySetup.addToList(start, SVC);
            String back = AccessibilitySetup.removeFromList(merged, SVC);
            String expected = ("null".equals(start)) ? "" : start;
            assertEquals("start=" + start, expected, back);
        }
    }

    @Test
    public void removeThenAddKeepsEveryServiceExactlyOnce() {
        // 这一方向**不**还原顺序：add 是追加，我们的服务会落到末尾。框架把这个
        // 列表当集合解析，顺序对它没有意义，所以不为「看起来整齐」去追原始下标
        // ——那会让合并逻辑多一块只为 cosmetics 存在的状态。这里钉住真正要紧的
        // 三件事：一项不少、一项不多、顺序确定。
        String list = OTHER + ":" + SVC + ":com.third/.Svc";
        String withoutUs = AccessibilitySetup.removeFromList(list, SVC);
        String back = AccessibilitySetup.addToList(withoutUs, SVC);
        assertEquals(OTHER + ":com.third/.Svc:" + SVC, back);
        assertTrue(AccessibilitySetup.listContains(back, SVC));
        assertTrue(AccessibilitySetup.listContains(back, OTHER));
        assertTrue(AccessibilitySetup.listContains(back, "com.third/.Svc"));
        assertEquals(3, back.split(":").length);
    }

    @Test
    public void anEmptyRemainderIsDistinguishableFromANonEmptyOne() {
        // enable/disable 靠这个分流：空了就 delete 整个 key，否则 put 剩余列表。
        assertTrue(AccessibilitySetup.removeFromList(SVC, SVC).isEmpty());
        assertFalse(AccessibilitySetup.removeFromList(OTHER + ":" + SVC, SVC).isEmpty());
    }
}
