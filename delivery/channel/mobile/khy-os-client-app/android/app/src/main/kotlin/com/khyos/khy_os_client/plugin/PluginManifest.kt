package com.khyos.khy_os_client.plugin

import org.json.JSONObject

/**
 * The plugin manifest — the declarative half of DESIGN-ARCH-195's option C.
 *
 * WHY A MANIFEST AT ALL. Option C was chosen over option B (in-process JVM
 * plugins) on one argument: C's attack surface is a small, auditable table of JNI
 * bindings rather than arbitrary bytecode in the app's uid. That argument is only
 * worth anything if the table is *selective* — a plugin that only shows a toast
 * must not also get the network. The manifest is what makes it selective: it is
 * the document a plugin author writes to say which bindings they want, and the
 * loader installs exactly those and no others.
 *
 * A manifest that is not validated is worse than no manifest. A plugin that
 * declares `permissions: ["net"]` and gets nothing (because the runtime
 * misspelled the capability) fails in a way that looks like a bug in the plugin.
 * A plugin that declares a capability the runtime has never heard of must be
 * REJECTED, not silently trimmed — otherwise a manifest written against a newer
 * runtime installs with less than its author intended, and the author has no way
 * to find out.
 *
 * FIELD SHAPE IS DELIBERATELY StepX-COMPATIBLE. The StepX AI App format
 * (verified 2026-10-29 against com.stepx.aiapp.pc242ff271564) uses
 * `entry` / `version` / `versionCode` / `permissions` / `network.domains`. Keeping
 * the same field names means a manifest written for one is readable by the other,
 * which is the whole point of piggybacking that marketplace rather than inventing
 * a private format.
 */
data class PluginManifest(
    /** Reverse-DNS plugin id. Also the storage namespace; see [PluginStoreScope]. */
    val id: String,
    val name: String,
    val version: String,
    val description: String,
    /** Path of the entry script, relative to the plugin root. */
    val entry: String,
    /** Capabilities the plugin asks for. Never empty-by-accident: see [validate]. */
    val permissions: Set<PluginCapability>,
    /** Hosts the plugin may reach. Only meaningful when [PluginCapability.NET] is granted. */
    val networkDomains: Set<String>,
) {

    fun grants(capability: PluginCapability): Boolean = permissions.contains(capability)

    companion object {

        /**
         * Reverse-DNS id. Lowercase alphanumerics and dots, at least one dot.
         *
         * `::` is impossible by construction (no colons in the class at all), which
         * is what makes the store separator unambiguous — see [PluginStoreScope].
         * Underscores are allowed in a segment because plenty of real package names
         * use them, but a segment still has to start with a letter so the id cannot
         * begin with a dot or a digit.
         */
        val ID_RE = Regex("^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$")

        /** x.y.z, numeric only. No pre-release/build metadata in the minimal set. */
        val VERSION_RE = Regex("^\\d+\\.\\d+\\.\\d+$")

        /**
         * Parse and validate a manifest.
         *
         * @throws PluginManifestException on ANY problem. Fail-closed: a manifest
         *   that does not fully validate never reaches the loader, so there is no
         *   path where a half-understood manifest produces a half-privileged
         *   plugin.
         */
        fun parse(json: String): PluginManifest {
            val obj = try {
                JSONObject(json)
            } catch (e: org.json.JSONException) {
                throw PluginManifestException("manifest 不是合法 JSON: ${e.message}")
            }

            val id = obj.optString("id").trim()
            val name = obj.optString("name").trim()
            val version = obj.optString("version").trim()
            val entry = obj.optString("entry").trim()
            val description = obj.optString("description").trim()

            val permissions = parsePermissions(obj.optJSONArray("permissions"))
            val networkDomains = parseDomains(obj.optJSONObject("network"))

            val manifest = PluginManifest(
                id = id,
                name = name,
                version = version,
                description = description,
                entry = entry,
                permissions = permissions,
                networkDomains = networkDomains,
            )
            manifest.validate()
            return manifest
        }

        private fun parsePermissions(arr: org.json.JSONArray?): Set<PluginCapability> {
            if (arr == null) return emptySet()
            val out = linkedSetOf<PluginCapability>()
            for (i in 0 until arr.length()) {
                val raw = arr.optString(i).trim()
                if (raw.isEmpty()) continue
                // Unknown capability is a hard error, not a skipped entry. See the
                // class doc: silently dropping one installs a plugin with less than
                // its author asked for, and nothing downstream can detect that.
                val cap = PluginCapability.fromWireName(raw)
                    ?: throw PluginManifestException(
                        "未知 capability「$raw」。已知: ${PluginCapability.wireNames()}")
                out.add(cap)
            }
            return out
        }

        private fun parseDomains(network: JSONObject?): Set<String> {
            if (network == null) return emptySet()
            val arr = network.optJSONArray("domains") ?: return emptySet()
            val out = linkedSetOf<String>()
            for (i in 0 until arr.length()) {
                val raw = arr.optString(i).trim()
                if (raw.isNotEmpty()) out.add(raw)
            }
            return out
        }
    }

    /**
     * Every rule that can reject a manifest, in one place.
     *
     * Called from [parse] so there is exactly one entry path. A second public
     * `validate()` that callers may forget is how a validated-once object becomes
     * an unvalidated one.
     */
    private fun validate() {
        requireId()
        require(name.isNotEmpty()) { "manifest 缺 name" }
        require(VERSION_RE.matches(version)) {
            "version「$version」不是 x.y.z 形式"
        }
        requireEntry()

        // A `net` grant with no allowlisted host is almost certainly a mistake, and
        // failing at install time is far more useful than failing on the first
        // request at runtime. It is also the fail-closed direction: the alternative
        // (allow it, deny everything later) leaves a plugin installed and broken
        // with no install-time signal.
        if (grants(PluginCapability.NET)) {
            require(networkDomains.isNotEmpty()) {
                "声明了 net 但 network.domains 为空——这个插件将无法发出任何请求"
            }
            // Every declared domain must normalise to a bare host. A declaration the
            // policy cannot parse would be dropped at request time, so the plugin
            // would install, appear to have network access, and have every request
            // denied for a reason that never surfaces at install. Rejecting here
            // puts the error where the author is looking.
            val unusable = networkDomains.filter {
                PluginNetPolicy.normalizeDeclaredDomain(it) == null
            }
            require(unusable.isEmpty()) {
                "这些 network.domains 无法解析为主机名（只允许 https 与裸主机，不含路径/端口/查询）: $unusable"
            }
        } else {
            // The mirror mistake: declaring hosts for a capability not granted. The
            // manifest and the runtime disagree about what the plugin can do, which
            // is exactly the class of bug this validation exists to catch.
            require(networkDomains.isEmpty()) {
                "声明了 network.domains 但没有 net capability——域名白名单不会生效"
            }
        }
    }

    private fun requireId() {
        require(id.isNotEmpty()) { "manifest 缺 id" }
        // The id doubles as the storage namespace separator boundary. `::` is the
        // store's separator (PluginStoreScope), so an id containing it could let one
        // plugin address another's keys by crafting its own id.
        require(ID_RE.matches(id)) {
            "id「$id」必须是反向 DNS 形式（小写字母数字与点，至少一个点，不含 :）"
        }
    }

    private fun requireEntry() {
        require(entry.isNotEmpty()) { "manifest 缺 entry" }
        // Relative, and no traversal. The entry path is joined onto the plugin root;
        // `../../` in it would read a file outside the plugin's own directory, which
        // is the one boundary the loader does have.
        require(!entry.startsWith("/")) { "entry 必须是相对路径: $entry" }
        require(!entry.contains("..")) { "entry 不允许 ..: $entry" }
        require(!entry.contains("\\")) { "entry 不允许反斜杠: $entry" }
    }

    private fun require(value: Boolean, lazyMessage: () -> String) {
        if (!value) throw PluginManifestException(lazyMessage())
    }
}

/** Thrown for every manifest problem. Carries a Chinese, actionable message. */
class PluginManifestException(message: String) : Exception(message)
