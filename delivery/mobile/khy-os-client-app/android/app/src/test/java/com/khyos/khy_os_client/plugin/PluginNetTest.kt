package com.khyos.khy_os_client.plugin

import org.json.JSONObject
import org.junit.Test

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail

import java.net.InetAddress

/**
 * Tests for the network capability: the connect-time guard and the redirect loop.
 *
 * `net` is the only capability in the table that sends data OUT, so it is the one
 * where a bypass matters most. Two bypasses are covered here, both of which were
 * open until this increment:
 *
 *  1. DNS. The string-level policy cannot classify a hostname, so a plugin that
 *     controls its own DNS record could point an allowed name at 127.0.0.1 and
 *     reach the app's own bridge. PluginNetGuard classifies what DNS ACTUALLY
 *     returned.
 *  2. Redirects. A 302 from an allowed host to a disallowed one. The transport
 *     deliberately does not follow redirects, so the host re-runs the guard on
 *     every hop.
 */
class PluginNetTest {

    // ── fixtures ─────────────────────────────────────────────────────────────

    private fun netManifest(vararg domains: String): PluginManifest =
        PluginManifest.parse(
            """
            {
              "id": "com.example.net",
              "name": "T",
              "version": "1.0.0",
              "entry": "main.js",
              "permissions": ["net"],
              "network": {"domains": ${org.json.JSONArray(domains.toList())}}
            }
            """.trimIndent()
        )

    /** A fake resolver, so no test touches DNS. */
    private fun resolver(vararg pairs: Pair<String, String>): (String) -> List<InetAddress> =
        { host -> pairs.filter { it.first == host }.map { InetAddress.getByName(it.second) } }

    private val publicResolver = resolver("api.example.com" to "93.184.216.34")

    private fun guard(
        vararg domains: String,
        resolve: (String) -> List<InetAddress> = publicResolver,
    ) = PluginNetGuard(netManifest(*domains), resolve)

    private fun assertAllowed(v: PluginNetGuard.Verdict) {
        assertTrue("预期允许，实际 $v", v is PluginNetGuard.Verdict.Allowed)
    }

    private fun assertDenied(v: PluginNetGuard.Verdict, contains: String = "") {
        assertTrue("预期拒绝，实际 $v", v is PluginNetGuard.Verdict.Denied)
        if (contains.isNotEmpty()) {
            assertTrue(
                "拒绝原因「${(v as PluginNetGuard.Verdict.Denied).reason}」应包含「$contains」",
                v.reason.contains(contains)
            )
        }
    }

    // ── the DNS half ─────────────────────────────────────────────────────────

    @Test
    fun allowedHostWithPublicResolutionIsAllowed() {
        assertAllowed(guard("https://api.example.com").check("https://api.example.com/v1"))
    }

    @Test
    fun hostnameThatResolvesToLoopbackIsDenied() {
        // THE DNS BYPASS. The string policy passes — the host IS allowlisted — but
        // the name points at the app's own bridge. Only the resolved-address check
        // catches this.
        val g = guard("https://api.example.com",
            resolve = resolver("api.example.com" to "127.0.0.1"))
        assertDenied(g.check("https://api.example.com/"), "回环")
    }

    @Test
    fun hostnameThatResolvesToLoopbackIpv6IsDenied() {
        val g = guard("https://api.example.com",
            resolve = resolver("api.example.com" to "::1"))
        assertDenied(g.check("https://api.example.com/"), "回环")
    }

    @Test
    fun hostnameThatResolvesToPrivateRangeIsDenied() {
        val g = guard("https://api.example.com",
            resolve = resolver("api.example.com" to "192.168.1.10"))
        assertDenied(g.check("https://api.example.com/"), "私有网段")
    }

    @Test
    fun onePublicAndOneLoopbackAddressIsDenied() {
        // A name may resolve to several addresses and the connection could pick any.
        // One loopback answer is enough to refuse the whole name.
        val g = guard("https://api.example.com",
            resolve = resolver(
                "api.example.com" to "93.184.216.34",
                "api.example.com" to "127.0.0.1",
            ))
        assertDenied(g.check("https://api.example.com/"), "回环")
    }

    @Test
    fun dnsFailureIsDeniedNotPassed() {
        // Treating a resolution failure as "unknown, allow" would let a plugin reach
        // a name that only fails to resolve here.
        val g = guard("https://api.example.com",
            resolve = { throw java.net.UnknownHostException("nope") })
        assertDenied(g.check("https://api.example.com/"), "DNS")
    }

    @Test
    fun emptyDnsResultIsDenied() {
        val g = guard("https://api.example.com", resolve = { emptyList() })
        assertDenied(g.check("https://api.example.com/"), "DNS")
    }

    @Test
    fun stringPolicyRunsBeforeDns() {
        // Cheap rules first, so a malformed or disallowed URL never reaches the
        // resolver — and the denial reason is the useful one.
        var resolved = false
        val g = PluginNetGuard(netManifest("https://api.example.com")) { resolved = true; emptyList() }
        assertDenied(g.check("https://evil.com/"), "白名单")
        assertFalse("被拒的 URL 不该触发 DNS", resolved)
    }

    // ── the redirect loop ────────────────────────────────────────────────────

    private class FakeTransport : PluginNetTransport {
        val requests = ArrayList<String>()
        var script: (String) -> PluginNetTransport.RawResponse = {
            PluginNetTransport.RawResponse(200, "ok", emptyMap(), null)
        }

        override fun send(
            url: String, method: String, headers: Map<String, String>, body: String?,
            connectTimeoutMs: Int, readTimeoutMs: Int,
        ): PluginNetTransport.RawResponse {
            requests.add("$method $url")
            return script(url)
        }
    }

    private fun host(
        transport: PluginNetTransport = FakeTransport(),
        resolve: (String) -> List<InetAddress> = publicResolver,
        granted: Boolean = true,
    ): PluginHost {
        val id = "com.example.net"
        val manifests = if (granted) {
            mapOf(id to netManifest("https://api.example.com"))
        } else {
            emptyMap()
        }
        return PluginHost(
            manifestOf = { manifests[it] },
            deviceInfo = { emptyMap() },
            store = object : PluginHost.PluginStore {
                override fun get(scopedKey: String) = null
                override fun set(scopedKey: String, value: String) = true
                override fun remove(scopedKey: String) {}
                override fun totalChars(pluginId: String) = 0
            },
            toaster = {},
            netTransport = transport,
            resolveHost = resolve,
        )
    }

    private fun fetch(
        h: PluginHost,
        url: String = "https://api.example.com/v1",
        method: String = "GET",
        body: String? = null,
    ): JSONObject = JSONObject(h.invoke("com.example.net", "net.fetch",
        JSONObject().put("url", url).put("method", method)
            .put("body", body).toString()))

    @Test
    fun happyPathReturnsStatusAndBody() {
        val t = FakeTransport()
        t.script = { PluginNetTransport.RawResponse(200, "hello", mapOf("Content-Type" to "text/plain"), null) }
        val r = fetch(host(t))
        assertTrue(r.optBoolean("ok"))
        assertEquals(200, r.optInt("status"))
        assertEquals("hello", r.optString("body"))
    }

    @Test
    fun redirectToAllowedHostIsFollowedAndRechecked() {
        val t = FakeTransport()
        // First hop redirects to a DIFFERENT allowed host; the guard must be re-run
        // on it, not skipped because the original URL passed.
        t.script = { url ->
            if (url == "https://api.example.com/a") {
                PluginNetTransport.RawResponse(302, "", emptyMap(), "https://other.example.com/b")
            } else {
                PluginNetTransport.RawResponse(200, "final", emptyMap(), null)
            }
        }
        val h = PluginHost(
            manifestOf = { netManifest("https://api.example.com", "https://other.example.com") },
            deviceInfo = { emptyMap() },
            store = object : PluginHost.PluginStore {
                override fun get(scopedKey: String) = null
                override fun set(scopedKey: String, value: String) = true
                override fun remove(scopedKey: String) {}
                override fun totalChars(pluginId: String) = 0
            },
            toaster = {},
            netTransport = t,
            resolveHost = resolver(
                "api.example.com" to "93.184.216.34",
                "other.example.com" to "93.184.216.35",
            ),
        )
        val r = fetch(h, url = "https://api.example.com/a")
        assertTrue(r.optBoolean("ok"))
        assertEquals("final", r.optString("body"))
        assertEquals(2, t.requests.size)
    }

    @Test
    fun redirectToDisallowedHostIsRefused() {
        // THE REDIRECT BYPASS. The first URL is allowlisted; the redirect target is
        // not. Following it without re-checking is the classic hole.
        val t = FakeTransport()
        t.script = { PluginNetTransport.RawResponse(302, "", emptyMap(), "https://evil.com/x") }
        val r = fetch(host(t))
        assertFalse(r.optBoolean("ok"))
        assertTrue(r.optString("error").contains("evil.com"))
        assertEquals("只应发出第一个请求", 1, t.requests.size)
    }

    @Test
    fun redirectToLoopbackIsRefusedByTheResolvedAddressCheck() {
        // A redirect to a hostname that resolves to loopback must be caught by the
        // DNS half, not just the string half.
        val t = FakeTransport()
        t.script = { PluginNetTransport.RawResponse(302, "", emptyMap(), "https://sneaky.example.com/x") }
        val h = PluginHost(
            manifestOf = { netManifest("https://api.example.com", "https://sneaky.example.com") },
            deviceInfo = { emptyMap() },
            store = object : PluginHost.PluginStore {
                override fun get(scopedKey: String) = null
                override fun set(scopedKey: String, value: String) = true
                override fun remove(scopedKey: String) {}
                override fun totalChars(pluginId: String) = 0
            },
            toaster = {},
            netTransport = t,
            resolveHost = resolver(
                "api.example.com" to "93.184.216.34",
                "sneaky.example.com" to "127.0.0.1",
            ),
        )
        val r = fetch(h)
        assertFalse(r.optBoolean("ok"))
        assertTrue(r.optString("error").contains("回环"))
        assertEquals(1, t.requests.size)
    }

    @Test
    fun relativeRedirectIsResolvedAgainstThePreviousUrl() {
        val t = FakeTransport()
        t.script = { url ->
            if (url == "https://api.example.com/a/b") {
                PluginNetTransport.RawResponse(302, "", emptyMap(), "/c")
            } else {
                PluginNetTransport.RawResponse(200, "landed", emptyMap(), null)
            }
        }
        val r = fetch(host(t), url = "https://api.example.com/a/b")
        assertTrue(r.optBoolean("ok"))
        assertEquals("landed", r.optString("body"))
        assertTrue("相对重定向应按上一跳解析", t.requests.contains("GET https://api.example.com/c"))
    }

    @Test
    fun bodyIsDroppedOnRedirect() {
        // Re-POSTing to wherever a 302 points would send the plugin's payload
        // somewhere it never named.
        val t = FakeTransport()
        t.script = { url ->
            if (url == "https://api.example.com/a") {
                PluginNetTransport.RawResponse(302, "", emptyMap(), "https://api.example.com/b")
            } else {
                PluginNetTransport.RawResponse(200, "ok", emptyMap(), null)
            }
        }
        val r = fetch(host(t), url = "https://api.example.com/a", method = "POST", body = "secret")
        assertTrue(r.optBoolean("ok"))
        assertEquals("POST https://api.example.com/a", t.requests[0])
        assertEquals("POST https://api.example.com/b", t.requests[1])
    }

    @Test
    fun tooManyRedirectsIsRefused() {
        val t = FakeTransport()
        // Every hop redirects to the next, forever. The hop cap must stop it.
        t.script = { url ->
            val n = url.substringAfterLast('/').toIntOrNull() ?: 0
            PluginNetTransport.RawResponse(302, "", emptyMap(), "https://api.example.com/${n + 1}")
        }
        val r = fetch(host(t), url = "https://api.example.com/0")
        assertFalse(r.optBoolean("ok"))
        assertTrue(r.optString("error").contains("重定向超过"))
        // The initial URL plus MAX_REDIRECT_HOPS more.
        assertEquals(PluginNetTransport.MAX_REDIRECT_HOPS + 1, t.requests.size)
    }

    @Test
    fun ungrantedPluginCannotFetch() {
        val t = FakeTransport()
        val r = fetch(host(t, granted = false))
        assertFalse(r.optBoolean("ok"))
        assertTrue(r.optString("error").contains("net"))
        assertEquals(0, t.requests.size)
    }

    @Test
    fun transportFailureBecomesDataNotACrash() {
        val t = object : PluginNetTransport {
            override fun send(
                url: String, method: String, headers: Map<String, String>, body: String?,
                connectTimeoutMs: Int, readTimeoutMs: Int,
            ) = throw java.io.IOException("connection reset")
        }
        val r = fetch(host(t))
        assertFalse(r.optBoolean("ok"))
        assertTrue(r.optString("error").contains("宿主内部错误"))
    }

    @Test
    fun missingUrlIsRefused() {
        val r = JSONObject(host().invoke("com.example.net", "net.fetch", "{}"))
        assertFalse(r.optBoolean("ok"))
        assertTrue(r.optString("error").contains("url"))
    }

    @Test
    fun netFetchIsRegisteredAgainstTheNetCapability() {
        // The api → capability map is the declared surface. net.fetch appearing here
        // is what makes the JS wrapper in khy_js_jni.cpp meaningful.
        assertEquals(PluginCapability.NET, PluginHost.API_CAPABILITY["net.fetch"])
    }

    @Test
    fun transportTimeoutsAreFinite() {
        // The blocking tradeoff is only acceptable because the block is bounded.
        // These numbers ARE the bound.
        assertTrue(PluginNetTransport.CONNECT_TIMEOUT_MS > 0)
        assertTrue(PluginNetTransport.READ_TIMEOUT_MS > 0)
        assertTrue(PluginNetTransport.CONNECT_TIMEOUT_MS < 60_000)
        assertTrue(PluginNetTransport.READ_TIMEOUT_MS < 60_000)
    }
}
