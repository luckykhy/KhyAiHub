package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * S4 / T13-T14：前台违规计数与两个状态面（status.json 与 HTTP /status）。
 *
 * 计数刻意是内存量（与 reconnect_count 同口径，重启归零），所以断言全用
 * 增量，不假设整个 JVM 里只有这一个测试类动过它；绝对值由真机 status.json
 * 的 adb 读数见证。
 *
 * 「触发拉起 Amoo 的调用必须被拦截且计数 +1」在这一层是可测的：JVM 里没有
 * Context，bringAmooToFront() 必然失败——这正是 ask() 中「需要拉起却拉不起来」
 * 的那条拦截分支，走的是生产代码同一个方法。
 */
public class ForegroundViolationTest {

    @Test
    public void anInterceptedLaunchCountsExactlyOnce() {
        long before = AmooLoop.foregroundViolations();
        assertTrue("不在前台且拉不起来时必须拦下提问",
                AmooLoop.refuseIfCannotRaise("com.example.other"));
        assertEquals("拦下一次计数必须恰好 +1", before + 1, AmooLoop.foregroundViolations());
        assertEquals(AmooLoop.VIOLATION_BRING_UP_FAILED, AmooLoop.lastViolationSource());
        assertTrue("last_violation 必须是时间戳而不是布尔", AmooLoop.lastViolationMs() > 0);
    }

    @Test
    public void alreadyForegroundOrUnknownPackageIsNotAViolation() {
        long before = AmooLoop.foregroundViolations();
        assertFalse("amoo 已在前台不该拦", AmooLoop.refuseIfCannotRaise(AmooLoop.AMOO_PKG));
        assertFalse("读不到前台包名（空串）不该拦", AmooLoop.refuseIfCannotRaise(""));
        assertFalse("null 也不该拦", AmooLoop.refuseIfCannotRaise(null));
        assertEquals("正常路径不许涨计数", before, AmooLoop.foregroundViolations());
    }

    @Test
    public void bothRefusalSitesUseTheSamePredicate() {
        // 两个拦截点（拉不起来 / 等不到前台）必须说同一种前缀，否则回执分档
        // 与计数器会给出两种答案。
        for (String source : new String[]{
                AmooLoop.VIOLATION_BRING_UP_FAILED, AmooLoop.VIOLATION_AWAIT_TIMEOUT}) {
            String msg = AmooLoop.foregroundRefusalText(source, 8000L);
            assertTrue("两个拦截点必须共用同一判据：" + source,
                    AmooLoop.isForegroundRefusal(msg));
        }
        assertFalse(AmooLoop.isForegroundRefusal("timeout after 120000ms"));
        assertFalse(AmooLoop.isForegroundRefusal(""));
        assertFalse(AmooLoop.isForegroundRefusal(null));
    }

    @Test
    public void statusCarriesTheThreeContractFields() throws Exception {
        long before = AmooLoop.foregroundViolations();
        JSONObject o = BridgeService.elevationStatus(null);
        assertEquals("none", o.getString("elevated"));
        assertEquals("unpaired", o.getString("device_auth"));
        assertEquals(before, o.getLong("foreground_violations"));
        if (before == 0L) {
            // 一次违规都没有时两个字段必须同说「没有」：0 和时间戳来源空串。
            assertEquals(0L, o.getLong("last_violation"));
            assertEquals("", o.getString("last_violation_source"));
        }

        AmooLoop.refuseIfCannotRaise("com.example.other");
        JSONObject after = BridgeService.elevationStatus(null);
        assertEquals(before + 1, after.getLong("foreground_violations"));
        assertEquals(AmooLoop.VIOLATION_BRING_UP_FAILED, after.getString("last_violation_source"));
        assertTrue(after.getLong("last_violation") > 0);
    }

    @Test
    public void bothStatusFacesReadTheOneShaper() throws Exception {
        String svc = readSource("BridgeService.java");
        String http = readSource("HttpBridge.java");
        assertTrue("status.json 必须由 elevationStatus 供值",
                svc.contains("elevationStatus(this)"));
        assertTrue("/status 必须用同一份取值，不在端点里再拼一套",
                http.contains("elevationStatus(appContext)"));
    }

    private static String readSource(String name) throws Exception {
        java.util.List<String> tried = new java.util.ArrayList<String>();
        for (String base : new String[]{
                System.getProperty("user.dir", "."),
                Tools.class.getProtectionDomain().getCodeSource().getLocation().getPath(),
        }) {
            java.io.File cur = new java.io.File(base);
            for (int up = 0; up < 6 && cur != null; up++, cur = cur.getParentFile()) {
                java.io.File c = new java.io.File(cur,
                        "app/src/main/java/com/khyos/khy_os_client/bridge/" + name);
                tried.add(c.getAbsolutePath());
                if (c.isFile()) {
                    return new String(java.nio.file.Files.readAllBytes(c.toPath()),
                            java.nio.charset.StandardCharsets.UTF_8);
                }
            }
        }
        throw new IllegalStateException("找不到 " + name + "，已试：" + tried);
    }
}
