package com.khyos.khy_os_client.engine

import com.khyos.khy_os_client.plugin.PluginCapability
import com.khyos.khy_os_client.plugin.PluginHost
import com.khyos.khy_os_client.plugin.PluginManifest
import org.json.JSONObject

/**
 * KhyJs — the Kotlin face of the per-plugin quickjs-ng runtime.
 *
 * WHY THIS EXISTS. DESIGN-ARCH-195 (khyos 手机版插件架构选型) recommends an
 * in-process QuickJS plugin runtime (option C) over in-process JVM plugins
 * (option B). The recommendation rests on the claim that C's attack surface is a
 * small, auditable table of JNI bindings rather than arbitrary bytecode in the
 * app's uid — which is only true if the engine is compiled from source here and
 * the bindings are written by hand. This class is the Kotlin end of that.
 *
 * THE SHAPE. One native function, `__khyInvoke`, plus a thin JS wrapper per granted
 * capability; every wrapper calls a [PluginHost], which checks the grant per call.
 * See khy_js_jni.cpp's header for why there is exactly one native function.
 *
 * WHAT CHANGED FROM THE SPIKE. The T2 spike exposed a bare `eval(String)` on a
 * single global context, and a MethodChannel entry drove it from Dart. Both are
 * gone. `eval` ran whatever it was handed with the full binding table — the same
 * hole option B would have opened, reached by a different road — and there was no
 * manifest, so no way to scope anything. There is now no bare-string entry point at
 * all: the only way to run script is [load] a validated manifest first.
 *
 * CURRENT REACHABILITY. The only caller in the tree is `KhyJsSelfTestActivity`,
 * which lives in the DEBUG source set. A release build therefore has no reachable
 * path to the engine and R8 strips it as dead code — the engine ships dormant.
 * That is intended: the runtime is proven and unit-tested, but there is no loader
 * that installs a plugin from disk yet (DESIGN-ARCH-195 §8.3).
 */
object KhyJs {

    /**
     * The outcome of one evaluation. [ok] is the ONLY discriminator — never branch
     * on [value] being non-null, because a script can legitimately evaluate to
     * `undefined` and that is a success with a null value.
     */
    data class EvalResult(val ok: Boolean, val value: String?, val error: String?)

    @Volatile
    private var nativeLibLoaded = false

    @Volatile
    private var hostSet = false

    private external fun nativeSetHost(host: Any)
    private external fun nativeLoad(pluginId: String, capabilities: String): Long
    private external fun nativeRun(handle: Long, code: String): String
    private external fun nativeUnload(handle: Long)

    /**
     * Register the host that `__khyInvoke` calls.
     *
     * Must be called before [load]. Idempotent. The host is held by a JNI global
     * ref, so it must not be a short-lived anonymous object.
     */
    fun setHost(host: PluginHost) {
        ensureNativeLib()
        if (hostSet) return
        synchronized(this) {
            if (hostSet) return
            nativeSetHost(host)
            hostSet = true
        }
    }

    private fun ensureNativeLib() {
        if (nativeLibLoaded) return
        synchronized(this) {
            if (nativeLibLoaded) return
            // loadLibrary, not System.load: the .so ships inside the APK's lib dir,
            // which is the only place the OS lets an app load native code from.
            System.loadLibrary("khyjs")
            nativeLibLoaded = true
        }
    }

    /**
     * Create a runtime for [manifest] and return its handle.
     *
     * @return a non-zero handle, or 0 if the runtime could not be created
     */
    fun load(manifest: PluginManifest): Long {
        ensureNativeLib()
        // Ordinals, not wire names. An out-of-range ordinal fails loudly in the JNI
        // layer, whereas a typo'd wire name would silently install nothing — a
        // plugin that appears to work and has no bindings.
        //
        // This couples the C enum in khy_js_jni.cpp to PluginCapability's declaration
        // ORDER. PluginSecurityTest.pluginCapabilityOrdinalsMatchTheNativeEnum pins
        // the two together; if that test is ever removed, this is the thing that
        // breaks silently.
        val capabilities = manifest.permissions
            .sortedBy { it.ordinal }
            .joinToString(",") { it.ordinal.toString() }
        return nativeLoad(manifest.id, capabilities)
    }

    /** Run [code] in the plugin's context. */
    fun run(handle: Long, code: String): EvalResult {
        val doc = JSONObject(nativeRun(handle, code))
        return if (doc.optBoolean("ok", false)) {
            EvalResult(ok = true, value = doc.optString("value", "undefined"), error = null)
        } else {
            EvalResult(ok = false, value = null, error = doc.optString("error", "unknown"))
        }
    }

    /** Free the plugin's runtime. Safe to call with an unknown handle. */
    fun unload(handle: Long) {
        if (handle == 0L) return
        nativeUnload(handle)
    }
}
