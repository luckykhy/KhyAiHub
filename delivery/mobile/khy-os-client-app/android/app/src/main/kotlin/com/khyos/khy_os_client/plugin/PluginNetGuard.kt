package com.khyos.khy_os_client.plugin

import java.net.InetAddress
import java.net.URI

/**
 * The connect-time half of the network allowlist.
 *
 * WHY THIS EXISTS. [PluginNetPolicy] is a pure function on strings, deliberately:
 * it does no DNS, so it can be called on every redirect hop without I/O and
 * without becoming non-deterministic. That choice leaves a hole the class doc
 * names explicitly — a hostname is not an address, and `evil.example.com` may
 * resolve to `127.0.0.1`. A plugin that declares an allowed hostname and controls
 * its DNS record could therefore reach the app's own bridge on loopback, which is
 * exactly the bypass the allowlist exists to close.
 *
 * This class closes it: it runs the string policy first, then classifies what DNS
 * ACTUALLY returned. Both halves are needed. The string half is what a reviewer
 * reads; this half is what stops a name from being a lie.
 *
 * WHY THE RESOLVER IS INJECTED. Real DNS in a unit test is a network call, which
 * makes the test slow, flaky, and dependent on the machine. The resolver is a
 * parameter so the tests can hand back whatever addresses the case needs —
 * including a hostname that resolves to loopback, which is the whole point.
 */
class PluginNetGuard(
    private val manifest: PluginManifest,
    private val resolve: (String) -> List<InetAddress>,
) {

    sealed class Verdict {
        object Allowed : Verdict()
        data class Denied(val reason: String) : Verdict()
    }

    /**
     * Decide whether [url] may be connected to.
     *
     * Called once per hop by the HTTP client — the initial URL and every redirect
     * target. Re-running it per hop is what closes the redirect bypass: a 302 from
     * an allowed host to a disallowed one lands here again and is refused.
     */
    fun check(url: String): Verdict {
        // The string-level rules first. They are cheap and they produce the better
        // error messages, so a malformed URL never reaches DNS at all.
        when (val decision = PluginNetPolicy.isAllowed(manifest, url)) {
            is PluginNetPolicy.NetDecision.Denied -> return Verdict.Denied(decision.reason)
            PluginNetPolicy.NetDecision.Allowed -> Unit
        }

        val host = try {
            URI(url).host
        } catch (e: Exception) {
            null
        } ?: return Verdict.Denied("URL 没有 host")

        val addresses = try {
            resolve(host)
        } catch (e: Exception) {
            // A resolution failure is a denial, not a pass. Treating it as "unknown,
            // allow" would let a plugin reach a name that only fails to resolve here
            // — and the connect would then fail anyway with a less useful message.
            return Verdict.Denied("DNS 解析失败: $host")
        }
        if (addresses.isEmpty()) {
            return Verdict.Denied("DNS 无结果: $host")
        }

        // EVERY address must be public. A name that resolves to both a public and a
        // loopback address is refused: the connection could pick either, and the
        // loopback one is the one that reaches the bridge.
        for (addr in addresses) {
            val kind = PluginNetPolicy.classify(addr)
            if (kind != PluginNetPolicy.AddressKind.PUBLIC) {
                return Verdict.Denied("$host 解析到${kind.label}地址 ${addr.hostAddress}")
            }
        }
        return Verdict.Allowed
    }
}
