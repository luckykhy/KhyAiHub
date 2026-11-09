package com.khyos.khy_os_client.plugin

/**
 * The capability table — the complete list of things a plugin can be granted.
 *
 * THIS IS THE SECURITY BOUNDARY, so it is deliberately short and every entry is
 * auditable by reading one file. DESIGN-ARCH-195 chose option C (in-process
 * QuickJS) over option B (in-process JVM) on exactly this: a plugin running as
 * bytecode in our uid could open any file the app can, including the bridge token
 * and `api_keys.json`. A plugin running under this table can reach only what is
 * listed here, because a capability that is not granted is never installed into
 * that plugin's JS context — `typeof net` is `undefined`, not a function that
 * returns an error.
 *
 * That last point is a design decision worth stating plainly. The alternative —
 * install every binding and check the grant at call time — is weaker in two ways:
 * a plugin cannot feature-detect honestly, and a bug in the check grants access
 * instead of denying it. Not installing is the fail-closed direction.
 *
 * WHAT IS NOT HERE, AND WHY. These are the entries a reviewer should expect to
 * find and their absence should be treated as deliberate:
 *
 *  - **Anything returning the bridge token, the app secret, or a key from
 *    `api_keys.json`.** This is the entire reason C beat B. There is no "read
 *    credential" capability and there must never be one.
 *  - **The bridge tools** (`ui_tap`, `ui_swipe`, `shell`, …). Those are the app's
 *    own privileged surface: with them a plugin drives the device and runs
 *    commands. That is a much higher tier than "show a toast" and must not ride
 *    along with the minimal set. If it is ever added it is a separate capability
 *    with its own consent, not an extension of this enum.
 *  - **Filesystem access.** [STORE] covers the stateful case with a namespace
 *    scoped to one plugin. Raw file access would let a plugin read the app's own
 *    preferences and any other plugin's data.
 *  - **Clipboard read.** The clipboard holds whatever the user last copied, which
 *    is frequently a password. Write-only toast-style output is fine; reading is
 *    not in the minimal set.
 *  - **Device identifiers.** [DEVICE_INFO] returns model / SDK / ABI / app
 *    version and deliberately NOT `ANDROID_ID`, IMEI, or the serial number. Those
 *    are stable tracking identifiers; handing one to an arbitrary plugin is a
 *    privacy cost with no functional payoff.
 *  - **`eval` from inside plugin code.** A plugin's own source is already
 *    arbitrary code, so eval adds nothing to what it can do — but eval on a string
 *    that arrived over the network is a code-injection vector. Not binding it
 *    removes the footgun.
 */
enum class PluginCapability(
    /** The name that appears in a manifest's `permissions` array. */
    val wireName: String,
    /** The JS bindings this capability installs into the plugin's context. */
    val bindings: List<String>,
    /** What the capability reaches, in one line, for a future consent screen. */
    val reach: String,
) {
    /**
     * Logcat only. Zero reach beyond the process's own log, which the user can
     * already read with any log viewer. Safe to grant unconditionally and
     * required for a plugin to be debuggable at all.
     */
    LOG("log", listOf("log"), "写日志（logcat），不读任何数据"),

    /**
     * Non-identifying device facts. The one binding that is pure read of
     * information the plugin could mostly infer anyway.
     */
    DEVICE_INFO("device.info", listOf("device.info"), "读设备型号/系统版本/ABI/应用版本，不含任何设备标识符"),

    /**
     * A key-value store scoped to THIS plugin. The scoping rule lives in
     * [PluginStoreScope] and is the security property, not this enum entry.
     */
    STORE("store", listOf("store"), "读写属于本插件的键值存储，碰不到其它插件或应用自己的数据"),

    /**
     * HTTP, but only to hosts the manifest declared. The allowlist decision is
     * [PluginNetPolicy]; this enum entry only records that the capability exists.
     */
    NET("net", listOf("net.fetch"), "向 manifest 里声明的主机发 HTTPS 请求，其它主机一律拒绝"),

    /**
     * A toast. The only user-visible output in the minimal set, and harmless:
     * it shows text the plugin supplies and grants no access in return.
     */
    UI_TOAST("ui.toast", listOf("ui.toast"), "弹一条 toast，不读任何数据"),
    ;

    companion object {
        private val BY_WIRE = values().associateBy { it.wireName }

        fun fromWireName(name: String): PluginCapability? = BY_WIRE[name]

        fun wireNames(): String = BY_WIRE.keys.sorted().joinToString(", ")
    }
}
