package com.khyos.khy_os_client.plugin

import org.json.JSONObject
import org.junit.Test

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue

/**
 * Tests for the host side of the one native binding.
 *
 * The JNI layer installs a JS wrapper per granted capability and funnels every call
 * into [PluginHost.invoke], which is where the grant is actually checked. These
 * tests cover that check and the handlers behind it.
 *
 * The two that matter most:
 *
 *  1. AN UNGRANTED CALL IS REFUSED EVEN WHEN IT REACHES THE HOST. The JS wrapper is
 *     the first gate; this is the second. If wrapper installation were ever bypassed
 *     — a bug in the C, a hand-written script calling `__khyInvoke` directly — the
 *     per-call check must still deny. Belt and braces is the point.
 *  2. STORAGE IS SCOPED TO THE CALLING PLUGIN, NOT TO WHOEVER OWNS THE DATA. The
 *     host is the only thing that turns (plugin id, key) into a real storage key, so
 *     a scoping bug here would let any plugin read any other plugin's state.
 */
class PluginHostTest {

    private class MemoryStore : PluginHost.PluginStore {
        val data = HashMap<String, String>()
        override fun get(scopedKey: String): String? = data[scopedKey]
        override fun set(scopedKey: String, value: String): Boolean {
            data[scopedKey] = value
            return true
        }
        override fun remove(scopedKey: String) { data.remove(scopedKey) }
        override fun totalChars(pluginId: String): Int =
            data.filterKeys { it.startsWith("$pluginId::") }.values.sumOf { it.length }
    }

    private val store = MemoryStore()
    private val toasts = ArrayList<String>()
    private val manifests = HashMap<String, PluginManifest>()

    private fun manifest(
        id: String,
        vararg caps: PluginCapability,
        domains: List<String> = emptyList(),
    ): PluginManifest =
        PluginManifest.parse(
            """
            {
              "id": "$id",
              "name": "T",
              "version": "1.0.0",
              "entry": "main.js",
              "permissions": [${caps.joinToString(",") { "\"${it.wireName}\"" }}]
              ${if (domains.isEmpty()) "" else ""","network": {"domains": ${org.json.JSONArray(domains)}}"""}
            }
            """.trimIndent()
        ).also { manifests[it.id] = it }

    private fun host() = PluginHost(
        manifestOf = { manifests[it] },
        deviceInfo = { mapOf("model" to "PZ261A") },
        store = store,
        toaster = { toasts.add(it) },
        // A transport that records and refuses nothing; the net behaviour itself is
        // covered in PluginNetTest, which has the scripted redirects.
        netTransport = object : PluginNetTransport {
            override fun send(
                url: String, method: String, headers: Map<String, String>, body: String?,
                connectTimeoutMs: Int, readTimeoutMs: Int,
            ) = PluginNetTransport.RawResponse(200, "ok", emptyMap(), null)
        },
        resolveHost = { listOf(java.net.InetAddress.getByName("93.184.216.34")) },
    )

    private fun call(pluginId: String, api: String, args: String = "{}"): JSONObject =
        JSONObject(host().invoke(pluginId, api, args))

    private fun ok(pluginId: String, api: String, args: String = "{}"): JSONObject {
        val r = call(pluginId, api, args)
        assertTrue("预期成功: $api -> $r", r.optBoolean("ok"))
        return r
    }

    private fun fail(pluginId: String, api: String, args: String = "{}"): JSONObject {
        val r = call(pluginId, api, args)
        assertFalse("预期失败: $api -> $r", r.optBoolean("ok"))
        return r
    }

    private val granted = "com.example.granted"
    private val bare = "com.example.bare"

    private fun setup() {
        manifest(granted, PluginCapability.LOG, PluginCapability.DEVICE_INFO,
            PluginCapability.STORE, PluginCapability.UI_TOAST)
        manifest(bare, PluginCapability.LOG)
    }

    // ── the grant check ──────────────────────────────────────────────────────

    @Test
    fun unknownApiIsRefused() {
        setup()
        val r = fail(granted, "nope")
        assertTrue(r.optString("error").contains("未知接口"))
    }

    @Test
    fun uninstalledPluginIsRefused() {
        setup()
        val r = call("com.example.ghost", "log")
        assertFalse(r.optBoolean("ok"))
        assertTrue(r.optString("error").contains("未安装"))
    }

    @Test
    fun ungrantedCapabilityIsRefusedEvenWhenItReachesTheHost() {
        // THE SECOND GATE. The JS wrapper would not be installed for this plugin, so
        // reaching here means the first gate was bypassed — by a bug in the C, or by
        // a script calling __khyInvoke directly. Either way the host must deny.
        setup()
        val r = fail(bare, "store.set", """{"key":"k","value":"v"}""")
        assertTrue(r.optString("error").contains("store"))
        assertEquals(0, store.data.size)
    }

    @Test
    fun netFetchReachesTheTransportWhenGranted() {
        // The wiring only: that a granted plugin's call actually arrives at the
        // transport. The allowlist and redirect behaviour live in PluginNetTest.
        setup()
        val netId = manifest("com.example.netter", PluginCapability.NET,
            domains = listOf("https://a.example.com")).id
        val r = ok(netId, "net.fetch", """{"url":"https://a.example.com/x"}""")
        assertEquals(200, r.optInt("status"))
    }

    @Test
    fun netFetchIsRefusedWithoutTheGrant() {
        setup()
        val r = fail(bare, "net.fetch", """{"url":"https://a.example.com/x"}""")
        assertTrue(r.optString("error").contains("net"))
    }

    @Test
    fun everyApiInTheTableHasACapability() {
        // An api reachable from JS but absent from API_CAPABILITY is refused before
        // any handler runs — so this map is the whole declared surface. If it and the
        // JS wrappers in khy_js_jni.cpp ever disagree, a granted capability silently
        // does nothing.
        val expected = setOf("log", "device.info", "store.get", "store.set", "store.remove",
            "ui.toast", "net.fetch")
        assertEquals(expected, PluginHost.API_CAPABILITY.keys)
    }

    // ── handlers ─────────────────────────────────────────────────────────────

    @Test
    fun logReturnsWhatItLogged() {
        setup()
        val r = ok(granted, "log", """{"args":["a","b"]}""")
        assertEquals(3, r.optInt("logged")) // "a b"
    }

    @Test
    fun deviceInfoIsPassedThrough() {
        setup()
        val r = ok(granted, "device.info")
        assertEquals("PZ261A", r.optString("model"))
    }

    @Test
    fun storeRoundTrips() {
        setup()
        ok(granted, "store.set", """{"key":"token","value":"abc"}""")
        val r = ok(granted, "store.get", """{"key":"token"}""")
        assertTrue(r.optBoolean("found"))
        assertEquals("abc", r.optString("value"))
    }

    @Test
    fun storeMissingKeyReportsNotFoundRatherThanNull() {
        setup()
        val r = ok(granted, "store.get", """{"key":"absent"}""")
        assertFalse(r.optBoolean("found"))
    }

    @Test
    fun storeIsScopedToTheCallingPlugin() {
        // THE ISOLATION PROPERTY. Same key, different plugin, different data — and
        // neither can see the other's.
        setup()
        val other = manifest("com.example.other", PluginCapability.STORE)
        ok(granted, "store.set", """{"key":"token","value":"mine"}""")
        ok(other.id, "store.set", """{"key":"token","value":"theirs"}""")

        assertEquals("mine", ok(granted, "store.get", """{"key":"token"}""").optString("value"))
        assertEquals("theirs", ok(other.id, "store.get", """{"key":"token"}""").optString("value"))
        assertEquals(2, store.data.size)
    }

    @Test
    fun crossNamespaceKeyIsRefused() {
        // A key crafted to address another plugin's namespace must be refused, not
        // rewritten — a silently rewritten key stores data the plugin can never read
        // back, which presents as data loss.
        setup()
        val r = fail(granted, "store.set", """{"key":"other::token","value":"x"}""")
        assertTrue(r.optString("error").contains("非法存储键"))
        assertEquals(0, store.data.size)
    }

    @Test
    fun valueOverThePerValueLimitIsRefused() {
        setup()
        val big = "x".repeat(PluginStoreScope.MAX_VALUE_CHARS + 1)
        val r = fail(granted, "store.set",
            JSONObject().put("key", "k").put("value", big).toString())
        assertTrue(r.optString("error").contains("单条上限"))
    }

    @Test
    fun totalOverThePerPluginLimitIsRefused() {
        // The per-plugin cap is checked against what is ALREADY stored, so a plugin
        // cannot get past it by writing many small values.
        //
        // The loop runs well past the cap rather than stopping at it. Stopping at
        // exactly MAX_PLUGIN_TOTAL_CHARS would exit before the write that is refused,
        // because a total equal to the cap is still within it.
        setup()
        val chunk = "x".repeat(PluginStoreScope.MAX_VALUE_CHARS) // exactly at the limit
        for (i in 0 until 40) {
            val r = call(granted, "store.set",
                JSONObject().put("key", "k$i").put("value", chunk).toString())
            if (!r.optBoolean("ok")) {
                assertTrue(r.optString("error").contains("总上限"))
                // And it must have stopped at the cap, not somewhere arbitrary.
                assertTrue("实际占用 ${store.totalChars(granted)} 字符，不应超过上限",
                    store.totalChars(granted) <= PluginStoreScope.MAX_PLUGIN_TOTAL_CHARS)
                return
            }
        }
        throw AssertionError("写 40 次仍未触到总上限 ${PluginStoreScope.MAX_PLUGIN_TOTAL_CHARS}")
    }

    @Test
    fun storeRemoveDeletesOnlyThatPluginsKey() {
        setup()
        ok(granted, "store.set", """{"key":"a","value":"1"}""")
        ok(granted, "store.remove", """{"key":"a"}""")
        assertFalse(ok(granted, "store.get", """{"key":"a"}""").optBoolean("found"))
    }

    @Test
    fun toastIsTruncatedAndDelivered() {
        // A toast is a UI element; an unbounded string is both a layout problem and a
        // way to push arbitrary text in front of the user.
        setup()
        val long = "y".repeat(PluginHost.MAX_TOAST_CHARS + 50)
        ok(granted, "ui.toast", JSONObject().put("message", long).toString())
        assertEquals(1, toasts.size)
        assertTrue(toasts[0].length <= PluginHost.MAX_TOAST_CHARS + 1) // + the ellipsis
        assertTrue(toasts[0].endsWith("…"))
    }

    @Test
    fun hostExceptionBecomesDataNotACrash() {
        // A bug in the host must not take the process down from inside JS_Eval.
        val throwing = PluginHost(
            manifestOf = { throw IllegalStateException("boom") },
            deviceInfo = { emptyMap() },
            store = store,
            toaster = {},
            netTransport = object : PluginNetTransport {
                override fun send(
                    url: String, method: String, headers: Map<String, String>, body: String?,
                    connectTimeoutMs: Int, readTimeoutMs: Int,
                ) = PluginNetTransport.RawResponse(200, "", emptyMap(), null)
            },
        )
        val r = JSONObject(throwing.invoke("com.example.granted", "log", "{}"))
        assertFalse(r.optBoolean("ok"))
        assertTrue(r.optString("error").contains("宿主内部错误"))
    }
}
