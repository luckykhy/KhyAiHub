package com.khyos.khy_os_client.plugin

import org.json.JSONObject

import java.net.InetAddress
import java.net.URI

/**
 * The host side of the one native binding.
 *
 * WHY THIS EXISTS. The JNI shim (khy_js_jni.cpp) installs exactly one native
 * function, `__khyInvoke`, plus a thin JS wrapper per granted capability. Every
 * wrapper funnels here. That keeps the C file's audit surface at one function no
 * matter how many capabilities are added — which is the property option C was
 * chosen for.
 *
 * WHAT THIS OWNS. The actual capability decision. The JNI layer deliberately does
 * not know what a capability is; it only knows which wrappers to install. So the
 * grant is checked HERE, per call, against the manifest of the plugin that is
 * asking. A bug in the JS wrapper installation therefore denies access rather than
 * granting it, which is the fail-closed direction.
 *
 * WHAT THIS MUST NEVER DO. Return anything secret. There is no `api` in
 * [API_CAPABILITY] that maps to a credential, the bridge token, or the bridge's own
 * tools — see the "not in the table" list in DESIGN-ARCH-195 §8.3 and the
 * `noCapabilityExposesACredentialOrTheBridge` test that pins it.
 *
 * THREADING. Called from whichever thread ran `nativeRun`, i.e. from inside
 * JS_Eval. Every implementation here must therefore be fast and must not block
 * indefinitely — a blocking call cannot be interrupted by the engine's deadline,
 * so a plugin could hang the app. That is exactly why `net.fetch` is not wired yet.
 */
class PluginHost(
    /** Resolves a plugin id to its validated manifest. Null means "not installed". */
    private val manifestOf: (String) -> PluginManifest?,
    /** Non-identifying device facts. Injected so this class holds no Android dep. */
    private val deviceInfo: () -> Map<String, Any?>,
    /** The storage backend. Scoped keys only — see [PluginStoreScope]. */
    private val store: PluginStore,
    /** Shows a toast. Injected because it needs a main-thread hop. */
    private val toaster: (String) -> Unit,
    /** The network transport. Injected so tests need no server. */
    private val netTransport: PluginNetTransport,
    /** Resolves a hostname to its addresses. Injected so tests need no DNS. */
    private val resolveHost: (String) -> List<InetAddress> =
        { InetAddress.getAllByName(it).toList() },
) {

    /**
     * The storage backend, in scoped-key space.
     *
     * Deliberately narrow: the host is the only thing that turns a
     * (plugin id, caller key) pair into a real storage key, so no implementation
     * can be handed an unscoped one.
     */
    interface PluginStore {
        fun get(scopedKey: String): String?
        fun set(scopedKey: String, value: String): Boolean
        fun remove(scopedKey: String)
        /** Total characters this plugin already occupies, for the per-plugin cap. */
        fun totalChars(pluginId: String): Int
    }

    /**
     * Handle one `__khyInvoke(api, argsJson)` call.
     *
     * Always returns a JSON document, never throws. A failure is DATA so the
     * plugin can handle it — that is what makes the bindings usable at all, and it
     * is why the JNI side parses this rather than expecting an exception.
     */
    fun invoke(pluginId: String, api: String, argsJson: String): String {
        val required = API_CAPABILITY[api]
            ?: return fail("未知接口「$api」")

        // Everything below runs inside the try. A bug in the host — including in the
        // manifestOf lookup — must not take the process down from inside JS_Eval, so
        // every failure becomes data the plugin can handle.
        return try {
            val manifest = manifestOf(pluginId)
            when {
                manifest == null ->
                    fail("插件 $pluginId 未安装")
                // The grant check. This is the security decision.
                !manifest.grants(required) ->
                    fail("插件 $pluginId 没有 ${required.wireName} 权限，拒绝 $api")
                else -> dispatch(api, pluginId, argsJson)
            }
        } catch (e: Exception) {
            fail("宿主内部错误: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private fun dispatch(api: String, pluginId: String, argsJson: String): String =
        when (api) {
            "log" -> ok(handleLog(argsJson))
            "device.info" -> ok(deviceInfo())
            "store.get" -> ok(handleStoreGet(pluginId, argsJson))
            "store.set" -> ok(handleStoreSet(pluginId, argsJson))
            "store.remove" -> ok(handleStoreRemove(pluginId, argsJson))
            "ui.toast" -> ok(handleToast(argsJson))
            "net.fetch" -> ok(handleNetFetch(pluginId, argsJson))
            else -> fail("接口 ${api} 未接线")
        }

    // ── handlers ─────────────────────────────────────────────────────────────

    private fun handleLog(argsJson: String): Map<String, Any?> {
        val args = JSONObject(argsJson).optJSONArray("args")
        val text = if (args == null) "" else (0 until args.length()).joinToString(" ") { args.optString(it) }
        return mapOf("logged" to text.length)
    }

    private fun handleStoreGet(pluginId: String, argsJson: String): Map<String, Any?> {
        val key = requireSafeKey(JSONObject(argsJson).optString("key"))
        val scoped = PluginStoreScope.scopedKey(pluginId, key)
        val value = store.get(scoped)
        return mapOf("found" to (value != null), "value" to value)
    }

    private fun handleStoreSet(pluginId: String, argsJson: String): Map<String, Any?> {
        val obj = JSONObject(argsJson)
        val key = requireSafeKey(obj.optString("key"))
        val value = obj.opt("value")?.toString() ?: ""
        if (!PluginStoreScope.isValueWithinLimit(value.length)) {
            // Thrown, not returned as {stored:false}. A handler that reports failure
            // inside a successful payload leaves the plugin unable to tell success
            // from failure by looking at `ok` — which is the only discriminator the
            // JNI side gives it. Throwing routes through the catch, which produces a
            // proper {ok:false,error:…}.
            throw IllegalArgumentException(
                "值超过单条上限 ${PluginStoreScope.MAX_VALUE_CHARS} 字符")
        }
        // The per-plugin cap is checked against what is ALREADY there, so a plugin
        // cannot grow past it by writing many small values.
        val existing = store.get(PluginStoreScope.scopedKey(pluginId, key))?.length ?: 0
        val projected = store.totalChars(pluginId) - existing + value.length
        if (!PluginStoreScope.isTotalWithinLimit(projected)) {
            throw IllegalArgumentException(
                "超过本插件总上限 ${PluginStoreScope.MAX_PLUGIN_TOTAL_CHARS} 字符")
        }
        val scoped = PluginStoreScope.scopedKey(pluginId, key)
        return mapOf("stored" to store.set(scoped, value))
    }

    private fun handleStoreRemove(pluginId: String, argsJson: String): Map<String, Any?> {
        val key = requireSafeKey(JSONObject(argsJson).optString("key"))
        store.remove(PluginStoreScope.scopedKey(pluginId, key))
        return mapOf("removed" to true)
    }

    private fun handleToast(argsJson: String): Map<String, Any?> {
        val message = JSONObject(argsJson).optString("message")
        // Bounded: a toast is a UI element, and an unbounded string is both a layout
        // problem and a way to push arbitrary text in front of the user.
        val shown = if (message.length > MAX_TOAST_CHARS) message.take(MAX_TOAST_CHARS) + "…" else message
        toaster(shown)
        return mapOf("shown" to true)
    }

    // ── net.fetch ────────────────────────────────────────────────────────────

    /**
     * The redirect loop, which is where the allowlist is actually enforced per hop.
     *
     * WHY A LOOP AND NOT A SINGLE CHECK. The transport deliberately does not follow
     * redirects (see [PluginNetTransport.send]), so the caller sees each hop and
     * re-runs the guard on it. A 302 from an allowed host to a disallowed one is
     * refused here rather than silently followed — that is the redirect bypass, and
     * closing it requires exactly this structure.
     *
     * THE BLOCKING TRADEOFF, STATED PLAINLY. This runs inside JS_Eval, so the
     * engine's interrupt deadline cannot fire while it blocks. The block is bounded
     * by the transport's connect and read timeouts rather than by the deadline —
     * finite, but not cancellable. A plugin that calls a slow host stalls its own
     * evaluations for up to those timeouts; it cannot stall the app forever, and it
     * cannot stall another plugin (each has its own runtime and its own calling
     * thread). A promise-based async bridge would remove the stall entirely and is
     * the right eventual shape; it is a larger change than this increment.
     */
    private fun handleNetFetch(pluginId: String, argsJson: String): Map<String, Any?> {
        val obj = JSONObject(argsJson)
        val url = obj.optString("url")
        require(url.isNotBlank()) { "net.fetch 缺 url" }

        val method = obj.optString("method", "GET").ifBlank { "GET" }.uppercase()
        val headers = obj.optJSONObject("headers")?.let { h ->
            (0 until h.length()).mapNotNull { h.names()?.optString(it) }.associateWith { h.optString(it) }
        } ?: emptyMap()
        var body: String? = obj.optString("body").takeIf { it.isNotEmpty() }

        val manifest = manifestOf(pluginId) ?: throw IllegalStateException("插件未安装")
        val guard = PluginNetGuard(manifest, resolveHost)

        var current = url
        for (hop in 0..PluginNetTransport.MAX_REDIRECT_HOPS) {
            when (val verdict = guard.check(current)) {
                is PluginNetGuard.Verdict.Denied ->
                    throw IllegalArgumentException("拒绝请求 $current: ${verdict.reason}")
                PluginNetGuard.Verdict.Allowed -> Unit
            }

            val response = netTransport.send(
                url = current,
                method = method,
                headers = headers,
                body = body,
                connectTimeoutMs = PluginNetTransport.CONNECT_TIMEOUT_MS,
                readTimeoutMs = PluginNetTransport.READ_TIMEOUT_MS,
            )

            val location = response.location
            if (response.status in 300..399 && !location.isNullOrBlank()) {
                // Resolve relative redirects against the URL that produced them, then
                // loop so the guard sees the new target.
                current = try {
                    URI(current).resolve(location.trim()).toString()
                } catch (e: Exception) {
                    throw IllegalArgumentException("重定向目标无法解析: $location")
                }
                // A redirect must not carry the previous request's body: re-POSTing to
                // wherever a 302 points is both wrong per HTTP and a way to make the
                // plugin send its payload somewhere it never named.
                body = null
                continue
            }

            return mapOf(
                "status" to response.status,
                "body" to response.body,
                "headers" to response.headers,
            )
        }
        throw IllegalArgumentException("重定向超过 ${PluginNetTransport.MAX_REDIRECT_HOPS} 跳")
    }

    private fun requireSafeKey(raw: String): String {
        require(PluginStoreScope.isSafeKey(raw)) {
            "非法存储键「$raw」（允许 A-Z a-z 0-9 . _ - ，最长 ${PluginStoreScope.MAX_KEY_CHARS}）"
        }
        return raw
    }

    private fun ok(value: Any?): String {
        val payload = if (value is Map<*, *>) value else mapOf("value" to value)
        return JSONObject(payload as Map<*, *>).put("ok", true).toString()
    }

    private fun fail(message: String): String =
        JSONObject().put("ok", false).put("error", message).toString()

    companion object {
        /** A toast is a single line of UI. 200 characters is already generous. */
        const val MAX_TOAST_CHARS = 200

        /**
         * Which capability each api requires.
         *
         * The single place the api surface is declared. An api that is not in this
         * map is refused before any handler runs, so adding a handler without
         * registering its capability is a no-op rather than an open door.
         */
        val API_CAPABILITY: Map<String, PluginCapability> = mapOf(
            "log" to PluginCapability.LOG,
            "device.info" to PluginCapability.DEVICE_INFO,
            "store.get" to PluginCapability.STORE,
            "store.set" to PluginCapability.STORE,
            "store.remove" to PluginCapability.STORE,
            "ui.toast" to PluginCapability.UI_TOAST,
            "net.fetch" to PluginCapability.NET,
        )
    }
}
