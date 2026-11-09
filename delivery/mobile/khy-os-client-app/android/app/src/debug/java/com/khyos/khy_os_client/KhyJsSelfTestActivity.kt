package com.khyos.khy_os_client

import android.app.Activity
import android.os.Bundle
import android.util.Log
import com.khyos.khy_os_client.engine.KhyJs
import com.khyos.khy_os_client.plugin.PluginCapability
import com.khyos.khy_os_client.plugin.PluginHost
import com.khyos.khy_os_client.plugin.PluginManifest
import com.khyos.khy_os_client.plugin.PluginNetTransport
import org.json.JSONObject

/**
 * Debug-only acceptance gate for the per-plugin quickjs-ng runtime.
 *
 * WHY IT LIVES IN THE DEBUG SOURCE SET. It ships in debug APKs only, by
 * construction — there is no debug/release branch to get wrong and no
 * `BuildConfig.DEBUG` to forget. Launch it with
 *
 *   adb shell am start -n <pkg>/com.khyos.khy_os_client.KhyJsSelfTestActivity
 *
 * and read the verdict from logcat under `KhyJsSelfTest`. It holds no state beyond
 * an in-memory store and touches no file.
 *
 * WHAT IT COVERS THAT THE SPIKE DID NOT. The T2 spike proved the engine runs. This
 * covers the per-plugin architecture that makes the capability table enforceable:
 * one runtime per plugin, bindings installed only for granted capabilities, and
 * storage that cannot cross between plugins. Those are the properties the whole
 * option-C argument rests on, so they are acceptance items rather than extras.
 */
class KhyJsSelfTestActivity : Activity() {

    /** In-memory store, so the test touches no disk. */
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

    private var failures = 0
    private val store = MemoryStore()
    private val toasts = ArrayList<String>()

    private fun host() = PluginHost(
        manifestOf = { id -> manifests[id] },
        deviceInfo = { mapOf("model" to "PZ261A", "sdk" to 36, "abi" to "arm64-v8a") },
        store = store,
        toaster = { toasts.add(it) },
        // A scripted transport, so the test makes no network call. Records what it
        // was asked for so the redirect cases can assert on the hop sequence.
        netTransport = object : PluginNetTransport {
            override fun send(
                url: String, method: String, headers: Map<String, String>, body: String?,
                connectTimeoutMs: Int, readTimeoutMs: Int,
            ): PluginNetTransport.RawResponse {
                sentRequests.add("$method $url")
                return when {
                    url.endsWith("/redirect") ->
                        PluginNetTransport.RawResponse(302, "", emptyMap(), "https://evil.example.com/x")
                    else ->
                        PluginNetTransport.RawResponse(200, "body-of-$url", emptyMap(), null)
                }
            }
        },
        // Everything resolves to a public address, so the DNS half passes and the
        // string half is what these cases are testing.
        resolveHost = { listOf(java.net.InetAddress.getByName("93.184.216.34")) },
    )

    private val sentRequests = ArrayList<String>()

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
              "name": "Self Test",
              "version": "1.0.0",
              "entry": "main.js",
              "permissions": [${caps.joinToString(",") { "\"${it.wireName}\"" }}]
              ${if (domains.isEmpty()) "" else ""","network": {"domains": ${org.json.JSONArray(domains)}}"""}
            }
            """.trimIndent()
        ).also { manifests[it.id] = it }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        run()
        finish()
    }

    private fun check(name: String, condition: Boolean, detail: String) {
        if (condition) {
            Log.i(TAG, "PASS  $name  — $detail")
        } else {
            failures++
            Log.e(TAG, "FAIL  $name  — $detail")
        }
    }

    private fun run() {
        Log.i(TAG, "── quickjs-ng per-plugin self-test start ──")

        KhyJs.setHost(host())

        val full = manifest("com.khyos.test.full", PluginCapability.LOG,
            PluginCapability.DEVICE_INFO, PluginCapability.STORE, PluginCapability.UI_TOAST,
            PluginCapability.NET, domains = listOf("https://api.example.com"))
        val bare = manifest("com.khyos.test.bare", PluginCapability.LOG)

        val h1 = KhyJs.load(full)
        val h2 = KhyJs.load(bare)
        check("load", h1 != 0L && h2 != 0L, "handles=$h1,$h2")

        // 1. Basic evaluation still works, now through the per-plugin path.
        val basic = KhyJs.run(h1, "1 + 1")
        check("basic-eval", basic.ok && basic.value == "2", "1 + 1 -> ${basic.value}")

        // 2. A granted capability's binding exists.
        val hasStore = KhyJs.run(h1, "typeof store === 'object' && typeof store.set === 'function'")
        check("granted-binding-installed", hasStore.ok && hasStore.value == "true",
            "typeof store -> ${hasStore.value}")

        // 3. THE GRANULARITY DECISION, MADE REAL. A plugin that was not granted
        //    `store` must not have it at all — not a function that errors. This is
        //    the difference between "the table is enforced" and "the table is
        //    decorative".
        val noStore = KhyJs.run(h2, "typeof store")
        check("ungranted-binding-absent", noStore.ok && noStore.value == "undefined",
            "bare plugin typeof store -> ${noStore.value}")

        val noDevice = KhyJs.run(h2, "typeof device")
        check("ungranted-device-absent", noDevice.ok && noDevice.value == "undefined",
            "bare plugin typeof device -> ${noDevice.value}")

        // 4. A call that IS routed still gets refused by the host, because the JS
        //    wrapper is only the first gate. Belt and braces: if wrapper
        //    installation were ever bypassed, the per-call check still denies.
        //
        //    __khyInvoke returns the host's document as an OBJECT, so a bare call at
        //    top level would stringify to "[object Object]". Stringify explicitly.
        val sneaky = KhyJs.run(h2,
            "JSON.stringify(__khyInvoke('store.set', JSON.stringify({key:'k',value:'v'})))")
        check("host-denies-ungranted",
            sneaky.ok && !JSONObject(sneaky.value!!).optBoolean("ok"),
            "direct __khyInvoke of an ungranted api -> ${sneaky.value}")

        // 5. Store round-trip through the host. The wrappers return OBJECTS, so the
        //    result has to be stringified before it crosses back as text.
        val set = KhyJs.run(h1, "JSON.stringify(store.set('token', 'abc'))")
        check("store-set", set.ok && JSONObject(set.value!!).optBoolean("stored"),
            "set -> ${set.value}")
        val get = KhyJs.run(h1, "JSON.stringify(store.get('token'))")
        check("store-get", get.ok && JSONObject(get.value!!).optString("value") == "abc",
            "get -> ${get.value}")

        // 6. PER-PLUGIN ISOLATION. The bare plugin must not see the full plugin's
        //    data even if it asks for the same key. It has no `store` binding, so it
        //    goes through __khyInvoke directly — and the host must still scope the
        //    key to the CALLING plugin, not to whoever owns the data.
        val cross = KhyJs.run(h2,
            "JSON.stringify(__khyInvoke('store.get', JSON.stringify({key:'token'})))")
        check("store-isolated-between-plugins",
            cross.ok && !JSONObject(cross.value!!).optBoolean("found"),
            "bare plugin reading full plugin's key -> ${cross.value}")

        // 7. An unsafe key is refused rather than silently rewritten. The wrapper
        //    throws on a host error, so this surfaces as a failed evaluation.
        val badKey = KhyJs.run(h1, "store.set('other::token', 'x')")
        check("unsafe-key-refused", !badKey.ok, "cross-namespace key -> ${badKey.error}")

        // 8. device.info returns facts and no identifier.
        val info = KhyJs.run(h1, "JSON.stringify(device.info())")
        check("device-info", info.ok && info.value!!.contains("PZ261A"), "info -> ${info.value}")

        // 9. Toast reaches the injected toaster.
        val toast = KhyJs.run(h1, "ui.toast('hello from plugin')")
        check("ui-toast", toast.ok && toasts.contains("hello from plugin"),
            "toasts=$toasts")

        // 10. net.fetch reaches the transport when the host is allowlisted.
        val fetched = KhyJs.run(h1,
            "JSON.stringify(net.fetch('https://api.example.com/v1'))")
        check("net-fetch-allowed",
            fetched.ok && JSONObject(fetched.value!!).optInt("status") == 200,
            "status=${JSONObject(fetched.value ?: "{}").optInt("status")}")

        // 11. The bare plugin has no `net` binding at all — the granularity
        //     decision, for the one capability that sends data out.
        val noNet = KhyJs.run(h2, "typeof net")
        check("ungranted-net-absent", noNet.ok && noNet.value == "undefined",
            "bare plugin typeof net -> ${noNet.value}")

        // 12. THE REDIRECT BYPASS. The transport answers /redirect with a 302 to a
        //     host that is NOT allowlisted. Only one request must go out — following
        //     it without re-checking is the classic hole.
        val redirected = KhyJs.run(h1,
            "JSON.stringify(net.fetch('https://api.example.com/redirect'))")
        check("net-redirect-to-disallowed-refused", !redirected.ok,
            "error=${redirected.error?.take(90)}")
        check("net-redirect-sent-only-one-request",
            sentRequests.count { it.endsWith("/redirect") } == 1,
            "requests=$sentRequests")

        // 10. A script must not be able to hang the app.
        val t0 = System.currentTimeMillis()
        val loop = KhyJs.run(h1, "while (true) {}")
        val elapsed = System.currentTimeMillis() - t0
        check("infinite-loop-is-interrupted", !loop.ok && elapsed < 15_000,
            "ok=${loop.ok} after ${elapsed}ms")

        // 11. Memory limit stops a runaway allocation.
        val mem = KhyJs.run(h1, "new Array(4_000_000).fill('x'.repeat(64))")
        check("memory-limit-stops-runaway", !mem.ok, "error=${mem.error?.take(80)}")

        // 12. Each plugin survives the other's failures — separate runtimes.
        val after = KhyJs.run(h2, "'still alive'")
        check("plugins-are-independent", after.ok && after.value == "still alive",
            "bare plugin after full plugin's failures -> ${after.value}")

        // 13. An unknown api is refused. Stringified for the same reason as #4.
        val unknown = KhyJs.run(h1, "JSON.stringify(__khyInvoke('nope', '{}'))")
        check("unknown-api-refused",
            unknown.ok && !JSONObject(unknown.value!!).optBoolean("ok"),
            "error=${JSONObject(unknown.value!!).optString("error")}")

        KhyJs.unload(h1)
        KhyJs.unload(h2)

        // 14. A handle is dead after unload, and using it fails cleanly rather than
        //     crashing — the failure mode of a use-after-free would be a segfault.
        val dead = KhyJs.run(h1, "1")
        check("unloaded-handle-fails-cleanly", !dead.ok, "error=${dead.error}")

        Log.i(TAG, if (failures == 0) {
            "── self-test PASSED ──"
        } else {
            "── self-test FAILED ($failures failure(s)) ──"
        })
    }

    private companion object {
        const val TAG = "KhyJsSelfTest"
    }
}
