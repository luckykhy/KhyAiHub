package com.khyos.khy_os_client.plugin

import java.net.InetAddress
import java.net.URI

/**
 * The network allowlist — the one decision in the minimal binding table that
 * actually bounds what a plugin can reach.
 *
 * WHY THIS IS THE CRUX. Every other capability in [PluginCapability] either reads
 * something harmless or writes somewhere scoped. `net` is the only one that lets a
 * plugin send data OUT. Without a strict allowlist, a plugin is an exfiltration
 * channel with the app's own network position, and the entire argument for option
 * C over option B collapses — because "arbitrary code that can phone home" is
 * roughly what option B already was.
 *
 * THE LOOPBACK BYPASS THIS EXISTS TO CLOSE. khy-os's own phone bridge listens on
 * 127.0.0.1 (verified earlier in this project). A plugin granted `net` with
 * `https://127.0.0.1` in its manifest could therefore talk to the bridge directly
 * and invoke every tool the bridge exposes — ui_tap, ui_swipe, the restricted
 * shell — none of which appear in [PluginCapability] at all. That would make the
 * whole table decorative. So loopback and private ranges are denied outright,
 * regardless of what the manifest declares.
 *
 * THE REDIRECT BYPASS. An allowlist checked once, on the initial URL, is defeated
 * by a 302 from an allowed host to a disallowed one. This policy is a pure
 * function on a single URL precisely so the runtime can call it AGAIN on every hop
 * of a redirect chain; a redirect that lands outside the allowlist aborts the
 * request. Wiring that into the HTTP client is follow-up work, but the decision
 * function is built to be re-entrant per hop.
 *
 * WHAT THIS CANNOT DECIDE. A hostname is not an address. `evil.example.com` may
 * resolve to 127.0.0.1, and this function — deliberately pure, no DNS, no I/O —
 * cannot know that. Literal IPs ARE classified here. Hostnames must additionally
 * be checked against their RESOLVED address at connect time by the HTTP client.
 * That second check does not exist yet; until it does, treat a hostname grant as
 * weaker than an IP grant, and do not read the loopback rule below as covering
 * hostnames that resolve to loopback.
 */
object PluginNetPolicy {

    /** Outcome of one decision. [Denied] always carries the reason, for the log. */
    sealed class NetDecision {
        object Allowed : NetDecision()
        data class Denied(val reason: String) : NetDecision()
    }

    /**
     * Decide whether [manifest] may fetch [url].
     *
     * Every rule is a separate early return so the denial reason names the rule
     * that fired. "denied" with no reason is the failure mode that makes an
     * allowlist impossible to debug.
     */
    fun isAllowed(manifest: PluginManifest, url: String): NetDecision {
        if (!manifest.grants(PluginCapability.NET)) {
            return NetDecision.Denied("插件没有 net capability")
        }

        val uri = try {
            URI(url)
        } catch (e: Exception) {
            return NetDecision.Denied("URL 无法解析: $url")
        }

        // https only. Cleartext http is both a confidentiality problem and trivially
        // interceptable, and nothing in the minimal set needs it.
        val scheme = uri.scheme?.lowercase()
        if (scheme != "https") {
            return NetDecision.Denied("只允许 https，收到 ${scheme ?: "无 scheme"}")
        }

        // Userinfo in a URL is the classic parser-confusion trick:
        // `https://allowed.example.com@evil.com/` has host evil.com to a naive
        // matcher that looks for the allowed name anywhere in the string. Rejecting
        // any userinfo removes the ambiguity entirely.
        if (!uri.rawUserInfo.isNullOrEmpty()) {
            return NetDecision.Denied("URL 不允许带 userinfo")
        }

        val host = uri.host
        if (host.isNullOrEmpty()) {
            return NetDecision.Denied("URL 没有 host")
        }

        // A non-default port is a different service on the same name. Granting
        // `api.example.com` should not silently grant `api.example.com:8443`.
        val port = uri.port
        if (port != -1 && port != 443) {
            return NetDecision.Denied("只允许默认端口 443，收到 $port")
        }

        // Loopback / private / link-local. See the class doc: this is what stops a
        // plugin from reaching the app's own bridge on 127.0.0.1.
        classifyAddress(host)?.let { verdict ->
            if (verdict != AddressKind.PUBLIC) {
                return NetDecision.Denied("不允许访问${verdict.label}地址: $host")
            }
        }

        // Exact host match, not suffix match. A declared `example.com` must NOT
        // grant `evil.example.com`: subdomains are frequently attacker-controlled
        // (user-content hosts, vanity hosts), and a suffix rule turns every such
        // subdomain into a bypass. Declare the subdomain explicitly instead.
        val declared = declaredHosts(manifest)
        if (declared.none { it.equals(host, ignoreCase = true) }) {
            return NetDecision.Denied("主机 $host 不在白名单内（白名单: ${declared.sorted()}）")
        }

        return NetDecision.Allowed
    }

    /**
     * Normalise a manifest's `network.domains` entry to a bare host.
     *
     * Accepts `https://api.example.com` (StepX's own shape) and `api.example.com`.
     * Returns null for anything with a path, port, query or userinfo — those are
     * rejected at manifest-validation time rather than silently trimmed, because a
     * trimmed declaration grants less than the author wrote and nothing detects it.
     */
    fun normalizeDeclaredDomain(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null

        val withScheme = if (trimmed.contains("://")) trimmed else "https://$trimmed"
        val uri = try {
            URI(withScheme)
        } catch (e: Exception) {
            return null
        }
        if (uri.scheme?.lowercase() != "https") return null
        if (!uri.rawUserInfo.isNullOrEmpty()) return null
        val host = uri.host ?: return null
        if (uri.port != -1) return null
        if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") return null
        if (!uri.rawQuery.isNullOrEmpty()) return null
        if (!uri.rawFragment.isNullOrEmpty()) return null
        if (classifyAddress(host) == AddressKind.LOOPBACK) return null
        return host.lowercase()
    }

    /** The normalised hosts a manifest declares, for logging and consent display. */
    fun declaredHosts(manifest: PluginManifest): Set<String> =
        manifest.networkDomains.mapNotNull { normalizeDeclaredDomain(it) }.toSet()

    // ── address classification ───────────────────────────────────────────────

    enum class AddressKind(val label: String) {
        LOOPBACK("回环"),
        PRIVATE("私有网段"),
        LINK_LOCAL("链路本地"),
        MULTICAST("组播"),
        UNSPECIFIED("未指定"),
        PUBLIC("公网"),
    }

    /**
     * Classify a host IF it is a literal address. Returns null for a hostname,
     * which cannot be classified without DNS — see the class doc.
     */
    fun classifyAddress(host: String): AddressKind? {
        val addr = parseLiteralAddress(host) ?: return null
        return classify(addr)
    }

    /**
     * Classify an already-resolved address.
     *
     * Split out from [classifyAddress] so the connect-time check in
     * [PluginNetGuard] can classify what DNS actually returned. Before that split
     * there was no way to ask "is this address loopback" without going through a
     * hostname string, which meant the DNS half of the loopback rule could not be
     * implemented at all.
     */
    fun classify(addr: InetAddress): AddressKind = when {
        addr.isLoopbackAddress -> AddressKind.LOOPBACK
        addr.isLinkLocalAddress -> AddressKind.LINK_LOCAL
        addr.isMulticastAddress -> AddressKind.MULTICAST
        addr.isAnyLocalAddress -> AddressKind.UNSPECIFIED
        isPrivateRange(addr) -> AddressKind.PRIVATE
        else -> AddressKind.PUBLIC
    }

    /**
     * Parse a literal IPv4/IPv6 host without touching DNS.
     *
     * [InetAddress.getByName] would resolve, which is a network call — unacceptable
     * in a function the runtime may call on every redirect hop, and it would make
     * the policy non-deterministic in tests. `InetAddress.getByName` is only used
     * on the already-extracted literal form, via [parseLiteralAddress]'s numeric
     * check.
     */
    private fun parseLiteralAddress(host: String): InetAddress? {
        val bare = host.removePrefix("[").removeSuffix("]")
        // A bare IPv6 literal contains ':'; a hostname with a port has already been
        // split by URI, so a ':' here means an unbracketed IPv6 literal.
        if (!bare.contains(':') && !bare.contains('.')) return null
        // Fast reject: anything with a letter that is not a hex digit pattern is a
        // hostname, not an address.
        if (bare.any { it.isLetter() && it.lowercaseChar() !in 'a'..'f' }) return null
        return try {
            val addr = InetAddress.getByName(bare)
            // getByName on a hostname returns something; only accept it if the input
            // really was numeric, so a DNS lookup can never sneak in here.
            if (addr.hostAddress == null) null else addr
        } catch (e: Exception) {
            null
        }
    }

    /**
     * RFC1918 plus the rest of the non-routable space.
     *
     * `InetAddress.isSiteLocalAddress` covers 10/8, 172.16/12 and 192.168/16 but not
     * 100.64/10 (CGNAT), 169.254/16 (already link-local), or 0.0.0.0/8. Those are
     * spelled out because "site local" is narrower than "not the public internet".
     */
    private fun isPrivateRange(addr: InetAddress): Boolean {
        if (addr.isSiteLocalAddress) return true
        val b = addr.address
        if (b.size == 4) {
            val a = b[0].toInt() and 0xff
            val c = b[1].toInt() and 0xff
            if (a == 100 && c in 64..127) return true      // 100.64.0.0/10 CGNAT
            if (a == 0) return true                        // 0.0.0.0/8
            if (a == 192 && c == 0) return true            // 192.0.0.0/24, 192.0.2.0/24
            if (a == 198 && (c == 18 || c == 19)) return true // 198.18.0.0/15 benchmarking
            if (a == 203 && c == 0) return true            // 203.0.113.0/24 documentation
        }
        return false
    }
}
