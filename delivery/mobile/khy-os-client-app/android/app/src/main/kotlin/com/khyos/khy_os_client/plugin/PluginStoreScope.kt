package com.khyos.khy_os_client.plugin

/**
 * Storage scoping — the rule that keeps one plugin's data out of another's.
 *
 * WHY THIS IS A SECURITY PROPERTY AND NOT A NAMING CONVENTION. The minimal
 * binding table gives a plugin a key-value store. If the key a plugin passes is
 * used verbatim as the storage key, then plugin A can read and overwrite plugin
 * B's state simply by asking for B's key — and, worse, both can reach the app's own
 * preferences, because those live in the same store. The fix is not to trust the
 * key: it is to derive the real storage key from (plugin id, caller-supplied key)
 * and to refuse any caller-supplied key that could escape that derivation.
 *
 * THE ESCAPE THAT DRIVES THE VALIDATION. The separator is `::`. A plugin whose own
 * id is `com.a` storing key `b::c` produces `com.a::b::c`; a plugin whose id is
 * `com.a::b` storing key `c` produces the same string. So an id containing the
 * separator would let one plugin forge another's namespace — which is why
 * [PluginManifest] rejects such ids, and why the key may not contain the separator
 * either.
 *
 * SIZE CAPS ARE PART OF THE RULE, NOT A TUNING DETAIL. Without a per-value cap a
 * plugin can write a single value large enough to evict everything else; without a
 * per-plugin cap it can grow until the app is out of disk. Both are checked here,
 * as pure functions, so they are testable without a filesystem.
 */
object PluginStoreScope {

    /** Separates the plugin id from the caller-supplied key. */
    const val SEPARATOR = "::"

    /** One value may not exceed this. 64 KB is far above any plausible plugin state. */
    const val MAX_VALUE_CHARS = 64 * 1024

    /** A single plugin's whole footprint may not exceed this. 1 MB. */
    const val MAX_PLUGIN_TOTAL_CHARS = 1024 * 1024

    /** Keys are short identifiers, not documents. */
    const val MAX_KEY_CHARS = 256

    private val SAFE_KEY_RE = Regex("^[A-Za-z0-9._-]{1,$MAX_KEY_CHARS}$")

    /**
     * Derive the real storage key for [pluginId]'s [key].
     *
     * @throws IllegalArgumentException if either part could escape the namespace.
     *   Throwing rather than sanitising is deliberate: a silently rewritten key
     *   stores data the plugin can never read back, which presents as data loss.
     */
    fun scopedKey(pluginId: String, key: String): String {
        require(isSafePluginId(pluginId)) { "非法插件 id: $pluginId" }
        require(isSafeKey(key)) { "非法存储键: $key（允许 A-Z a-z 0-9 . _ - ，最长 $MAX_KEY_CHARS）" }
        return pluginId + SEPARATOR + key
    }

    /**
     * Whether [pluginId] can be used as a namespace prefix.
     *
     * Must agree with [PluginManifest]'s id rule. Duplicated on purpose: this object
     * is the one that actually builds storage keys, and it must not depend on a
     * manifest having been parsed to be safe. The alternative — trusting the caller
     * — is the bug this whole file exists to prevent.
     */
    fun isSafePluginId(pluginId: String): Boolean =
        pluginId.isNotEmpty() &&
            !pluginId.contains(SEPARATOR) &&
            !pluginId.contains('/') &&
            !pluginId.contains('\\') &&
            !pluginId.contains("..") &&
            PluginManifest.ID_RE.matches(pluginId)

    /**
     * Whether a caller-supplied [key] is safe to append after the separator.
     *
     * The character class is allowlist-based. Denying known-bad characters (`:`,
     * `/`, `..`) is the approach that always misses one; allowing only
     * `[A-Za-z0-9._-]` cannot.
     */
    fun isSafeKey(key: String): Boolean = SAFE_KEY_RE.matches(key)

    /**
     * Whether a value of [chars] characters is within the per-value cap.
     *
     * Counted in characters rather than bytes: UTF-16 length is what the JVM
     * actually holds in memory for a String, so it is the honest measure of the
     * cost even though the on-disk size will differ.
     */
    fun isValueWithinLimit(chars: Int): Boolean = chars in 0..MAX_VALUE_CHARS

    /**
     * Whether a plugin's total footprint of [chars] characters is within the cap.
     *
     * The runtime is responsible for summing what it already holds for this plugin
     * and calling this before accepting a write. The rule lives here so the cap is
     * stated once.
     */
    fun isTotalWithinLimit(chars: Int): Boolean = chars in 0..MAX_PLUGIN_TOTAL_CHARS
}
