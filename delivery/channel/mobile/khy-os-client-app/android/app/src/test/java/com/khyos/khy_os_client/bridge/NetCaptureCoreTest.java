// khy-canary: Khy-20261115-NET5-WRITE1
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * 断点五的判定测试：默认关闭、ttl 上限、规则生命周期、强制脱敏。
 *
 * <p>为什么这些判定必须在 JVM 里先钉住：真机抓包一次只能证明「那一次抓到了」，
 * 证明不了「没开的时候不抓」「15 分钟后一定停」「规则不会活到下一轮」。
 * 这三条恰恰是抓包功能最容易破的三种方式——它们都不是崩溃，是**静默地多做了事**。
 */
public class NetCaptureCoreTest {

    private static final long T0 = 1_700_000_000_000L;

    @Test
    public void defaultOffAndRecordsIgnoredWhenOff() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        assertFalse(c.active());
        JSONObject rec = new JSONObject().put("method", "GET").put("host", "a.test");
        c.record(rec);
        assertEquals(0, c.list(0, 10).optInt("count"));
        assertEquals(0L, c.counters().get("total").longValue());
        // 没开的时候 status 要说清楚是「没开」，不是「开了没数据」。
        assertEquals("抓包未开启", c.status(T0).optString("hint"));
    }

    @Test
    public void ttlDefaultsTo15MinAndIsCapped() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        JSONObject r = c.start(T0, null);
        assertEquals(NetCaptureCore.DEFAULT_TTL_MS, r.optLong("ttl_ms"));
        c.stop(T0, "manual");

        JSONObject r2 = c.start(T0, 60L * 60L * 1000L);
        // 传 1 小时按 15 分钟截断，不报错：报错只会诱使调用方去掉这个参数。
        assertEquals(NetCaptureCore.MAX_TTL_MS, r2.optLong("ttl_ms"));
        assertTrue(r2.optLong("ttl_ms") <= 15L * 60L * 1000L);
    }

    @Test
    public void secondStartDoesNotResetWindowOrRules() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        c.start(T0, 60_000L);
        c.setRule(new JSONObject().put("host", "a.test").put("action", "block"), T0);
        JSONObject again = c.start(T0 + 30_000L, 900_000L);
        assertTrue(again.optBoolean("already_active"));
        // 重置 ttl 会把「忘了关」变成「永远开着」，所以第二次 start 只读不写。
        assertEquals(60_000L, again.optLong("ttl_ms"));
        assertEquals(1, c.listRules().optInt("count"));
    }

    @Test
    public void ttlExpiryStopsAndClearsRules() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        c.start(T0, 60_000L);
        c.setRule(new JSONObject().put("host", "a.test").put("action", "block"), T0);
        c.record(new JSONObject().put("method", "GET").put("host", "a.test"));
        assertFalse(c.tick(T0 + 59_999L));
        assertTrue(c.active());
        assertTrue(c.tick(T0 + 60_000L));
        assertFalse(c.active());
        assertEquals("ttl_expired", c.status(T0 + 60_000L).optString("stop_reason"));
        assertEquals(0, c.listRules().optInt("count"));
        // 记录留着：停之后还要能看这一次抓到了什么。
        assertEquals(1, c.list(0, 10).optInt("count"));
    }

    @Test
    public void rulesRejectedWhenCaptureOff() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        JSONObject r = c.setRule(new JSONObject().put("host", "a.test").put("action", "block"), T0);
        assertFalse(r.optBoolean("ok"));
        assertEquals("capture_off", r.optString("code"));
    }

    @Test
    public void ruleValidationRejectsWideningShapes() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        c.start(T0, 60_000L);
        assertEquals("bad_action", c.setRule(new JSONObject()
                .put("host", "a.test").put("action", "drop"), T0).optString("code"));
        assertEquals("bad_host", c.setRule(new JSONObject()
                .put("action", "block"), T0).optString("code"));
        assertEquals("bad_host", c.setRule(new JSONObject()
                .put("host", "*").put("action", "block"), T0).optString("code"));
        assertEquals("bad_status", c.setRule(new JSONObject()
                .put("host", "a.test").put("action", "status"), T0).optString("code"));
        assertEquals("bad_header", c.setRule(new JSONObject()
                .put("host", "a.test").put("action", "header"), T0).optString("code"));
    }

    @Test
    public void ruleMatchingIsNarrowByDefault() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        c.start(T0, 60_000L);
        c.setRule(new JSONObject().put("host", "*.example.com")
                .put("path", "^/v1/").put("method", "post").put("action", "block"), T0);
        assertNotNull(c.match("POST", "api.example.com", "/v1/chat"));
        // 裸域不命中 *.example.com：通配只覆盖子域，不覆盖父域本身。
        assertNull(c.match("POST", "example.com", "/v1/chat"));
        // 前缀必须带边界：/v10 不能被 ^/v1/ 命中。
        assertNull(c.match("POST", "api.example.com", "/v10/chat"));
        assertNull(c.match("GET", "api.example.com", "/v1/chat"));
        // 精确 path 只在完全相等时命中。
        c.setRule(new JSONObject().put("host", "b.test").put("path", "/ping")
                .put("action", "status").put("status", 503), T0);
        assertNotNull(c.match("GET", "b.test", "/ping"));
        assertNull(c.match("GET", "b.test", "/ping2"));
    }

    @Test
    public void rulesClearedOnStop() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        c.start(T0, 60_000L);
        c.setRule(new JSONObject().put("host", "a.test").put("action", "block"), T0);
        assertEquals(1, c.listRules().optInt("count"));
        c.stop(T0 + 1000L, "manual");
        assertEquals(0, c.listRules().optInt("count"));
        // 新一轮必须从空规则表起：上一轮的规则活过来 = 改写这一轮没人预期的响应。
        c.start(T0 + 2000L, 60_000L);
        assertEquals(0, c.listRules().optInt("count"));
    }

    @Test
    public void redactsSensitiveHeadersAndKeepsTheRest() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        String secret = "Bearer abcdefghijklmnop";
        JSONObject h = new JSONObject()
                .put("Authorization", secret)
                .put("Cookie", "sid=1")
                .put("Set-Cookie", "sid=1; HttpOnly")
                .put("X-Khy-Sig", "sig")
                .put("Content-Type", "application/json")
                .put("X-Request-Id", "req-1");
        JSONObject out = c.redactHeaders(h);
        // 2026-11-16 E 段起占位串带长度：<redacted:原文长度>。长度是调试信号
        // （空 token 与长 token 是两种故障），打成同一个串就把这一维丢了。
        assertEquals(NetCaptureCore.mask(secret), out.optString("Authorization"));
        assertEquals(NetCaptureCore.mask("sid=1"), out.optString("Cookie"));
        assertEquals(NetCaptureCore.mask("sid=1; HttpOnly"), out.optString("Set-Cookie"));
        assertEquals(NetCaptureCore.mask("sig"), out.optString("X-Khy-Sig"));
        assertEquals("application/json", out.optString("Content-Type"));
        assertEquals("req-1", out.optString("X-Request-Id"));
        // 原表不动：调用方还要拿它去转发。
        assertEquals(secret, h.optString("Authorization"));
        assertEquals(4L, c.counters().get("redacted_fields").longValue());
    }

    @Test
    public void redactsUrlParamsWithoutOverMatching() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        String url = "https://api.test/v1/chat?token=abc123&csrf_token_name=keep&model=x";
        String out = c.redactUrl(url);
        assertTrue(out.contains("token=" + NetCaptureCore.mask("abc123")));
        assertTrue(out.contains("model=x"));
        // 子串替换会把 csrf_token_name 也打掉——那是过度脱敏，抓包就没意义了。
        assertTrue(out.contains("csrf_token_name=keep"));
        assertEquals("https://api.test/v1/ping", c.redactUrl("https://api.test/v1/ping"));
    }

    @Test
    public void redactsJsonBodyRecursively() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        String body = "{\"model\":\"m1\",\"api_key\":\"sk-abcdefgh1234\","
                + "\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],"
                + "\"auth\":{\"password\":\"p@ss\",\"user\":\"u\"}}";
        String out = c.redactBody(body);
        assertTrue(out.contains("\"model\":\"m1\""));
        assertTrue(out.contains("hi"));
        assertTrue(out.contains("\"user\":\"u\""));
        assertFalse(out.contains("sk-abcdefgh1234"));
        assertFalse(out.contains("p@ss"));
        // 长度保留：打码值里看得见原文有多长。
        assertTrue(out.contains("\"api_key\":\"" + NetCaptureCore.mask("sk-abcdefgh1234") + "\""));
        assertTrue(out.contains("\"password\":\"" + NetCaptureCore.mask("p@ss") + "\""));
    }

    @Test
    public void redactsTextualSecretsWhenNotJson() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        String out = c.redactBody("curl -H 'Authorization: Bearer abcdefghijkl' sk-abcdefgh12345678");
        assertFalse(out.contains("abcdefghijkl"));
        assertFalse(out.contains("sk-abcdefgh12345678"));
        assertTrue(out.contains(NetCaptureCore.MASK_PREFIX));
    }

    /**
     * 服务端把请求 URL / 请求体原样回显时，按键名匹配穿不透。
     *
     * WHY THIS TEST EXISTS. T17 实测里真实漏过一次：请求侧
     * authorization/cookie/token/password 全部打成 ***，但 resp_body 里
     * `"url":"/api/echo?token=SECRET-TOKEN"` 和 `"body_echo":"{\"password\":\"SECRET-PW\"}"`
     * 是明文——因为这两个键名本身不敏感，敏感值藏在「字符串里嵌 URL / 嵌转义 JSON」中。
     * 这类回显在错误响应、调试响应里非常常见，不是人造场景。
     */
    @Test
    public void redactsSecretsHiddenInsideStringValues() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        String body = "{\"url\":\"/api/echo?token=SECRET-TOKEN&csrf_token_name=keep\","
                + "\"body_echo\":\"{\\\"password\\\":\\\"SECRET-PW\\\",\\\"user\\\":\\\"bob\\\"}\"}";
        String out = c.redactBody(body);
        assertFalse("URL 里的 token 没打码: " + out, out.contains("SECRET-TOKEN"));
        assertFalse("转义 JSON 里的 password 没打码: " + out, out.contains("SECRET-PW"));
        // 不能过度脱敏：普通参数与普通字段必须留着，否则工具没法用。
        assertTrue("csrf_token_name 被误打码: " + out, out.contains("csrf_token_name"));
        assertTrue("普通字段 user 被误打码: " + out, out.contains("bob"));
    }

    /** 裸 key= 不当敏感参数：`?key=value` 是常见业务参数，打掉它比漏打更难排查。 */
    @Test
    public void doesNotRedactBareKeyParam() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        String out = c.redactBody("{\"url\":\"/list?key=page2&page=1\"}");
        assertTrue(out, out.contains("key=page2"));
        assertTrue(out, out.contains("page=1"));
    }

    @Test
    public void ringBufferKeepsNewestAndCountsDrops() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        c.start(T0, 60_000L);
        for (int i = 0; i < NetCaptureCore.MAX_RECORDS + 10; i++) {
            c.record(new JSONObject().put("method", "GET").put("host", "h" + i).put("path", "/"));
        }
        assertEquals(NetCaptureCore.MAX_RECORDS, c.list(0, 1000).optInt("count"));
        assertEquals(10L, c.counters().get("dropped").longValue());
        // 丢的是最旧的，不是最新的。
        assertEquals("h10", c.snapshot().get(0).optString("host"));
    }

    @Test
    public void listSupportsIncrementalCursor() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        c.start(T0, 60_000L);
        for (int i = 0; i < 3; i++) {
            c.record(new JSONObject().put("method", "GET").put("host", "h" + i));
        }
        JSONObject first = c.list(0, 10);
        assertEquals(3, first.optInt("count"));
        long lastSeq = first.optJSONArray("items").optJSONObject(2).optLong("seq");
        // 增量读：只给比游标新的，避免调用方每次把 200 条全搬一遍。
        assertEquals(0, c.list(lastSeq, 10).optInt("count"));
        c.record(new JSONObject().put("method", "GET").put("host", "h3"));
        assertEquals(1, c.list(lastSeq, 10).optInt("count"));
    }

    @Test
    public void undecryptableIsCountedSeparatelyFromTraffic() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        c.start(T0, 60_000L);
        c.record(new JSONObject().put("method", "CONNECT").put("host", "pinned.test")
                .put("decrypted", false).put("error", "tls_not_intercepted"));
        JSONObject st = c.status(T0 + 1000L);
        assertEquals(1, st.optInt("undecryptable"));
        // 「全部解不开」和「没有流量」必须给不同的提示：处置方式完全不同。
        assertEquals("全部是 HTTPS CONNECT，未做 MITM，无法解密", st.optString("hint"));
    }

    // ---- E 段新增：capture 三态 / 开门闸 / 规则 ttl ----

    @Test
    public void captureModeSpeaksTheThreeTiers() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        assertEquals("off", c.captureMode());
        c.start(T0, 60_000L);
        assertEquals("self", c.captureMode());
        // self+tls 只表示「档位已开」，不表示「解开了」——解密成败是逐条记录的事。
        c.setTlsArmed(true);
        assertEquals("self+tls", c.captureMode());
        c.stop(T0 + 1L, "manual");
        assertEquals("off", c.captureMode());
        assertFalse(c.tlsArmed());
    }

    @Test
    public void startGateRefusesLockedAndOldApi() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        JSONObject locked = c.startGate(false, 33);
        assertFalse(locked.optBoolean("ok"));
        assertEquals("debug_only", locked.optString("code"));
        JSONObject old = c.startGate(true, 28);
        assertFalse(old.optBoolean("ok"));
        assertEquals("unsupported_api", old.optString("code"));
        assertTrue(c.startGate(true, 33).optBoolean("ok"));
    }

    @Test
    public void ruleTtlExpiresAndIsSwept() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        c.start(T0, 900_000L);
        JSONObject set = c.setRule(new JSONObject().put("host", "a.test")
                .put("action", "block").put("ttl_ms", 60_000L), T0);
        assertEquals(60_000L, set.optJSONObject("rule").optLong("ttl_ms"));
        assertEquals(T0 + 60_000L, set.optJSONObject("rule").optLong("expires_at"));
        // 没过期：照常命中。
        assertNotNull(c.match("GET", "a.test", "/", T0 + 59_999L));
        // 过了期：不再命中，且被扫掉。
        assertNull(c.match("GET", "a.test", "/", T0 + 60_000L));
        assertEquals(0, c.listRules(T0 + 60_000L).optInt("count"));
        // ttl 上限与窗口同值：给规则比窗口更长的寿命没有意义。
        JSONObject long_ = c.setRule(new JSONObject().put("host", "a.test")
                .put("action", "block").put("ttl_ms", 3600_000L), T0);
        assertEquals(NetCaptureCore.MAX_TTL_MS,
                long_.optJSONObject("rule").optLong("ttl_ms"));
    }

    @Test
    public void stopClearsTheTlsTierToo() throws Exception {
        NetCaptureCore c = new NetCaptureCore();
        c.start(T0, 60_000L);
        c.setTlsArmed(true);
        assertNotNull(c.tls());
        c.stop(T0 + 1L, "manual");
        assertNull(c.tls());
        // 档位跟着停一起收：不然「核心说停了、CA 还活着」又是一个半开状态。
        assertEquals("off", c.captureMode());
    }
}
