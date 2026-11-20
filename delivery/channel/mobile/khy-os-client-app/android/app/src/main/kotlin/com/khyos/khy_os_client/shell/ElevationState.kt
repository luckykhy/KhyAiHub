// khy-canary: Khy-20261116-001-SPAKE2
package com.khyos.khy_os_client.shell

import android.content.Context
import android.content.SharedPreferences

/**
 * The truth about the phone's shell layer — one place, so nobody has to guess.
 *
 * WHY THIS IS A SEPARATE FILE. The elevation state has three independent
 * parts, and conflating them is how "it says elevated but nothing works"
 * happens:
 *
 *   · **enabled** — did the user turn the feature on? Default **off**: the
 *     task is explicit that elevation is opt-in, and an app that quietly
 *     holds a uid-2000 channel the user never asked for is not an app, it is
 *     a backdoor.
 *   · **elevated** — is a shell layer actually available *right now*
 *     (`none` / `shell`)? This is a fact about the device, not about the
 *     user's intent: the user may have turned the switch on while the
 *     wireless debugging was off.
 *   · **deviceAuth** — has this App's key been authorized by the device
 *     (`unpaired` / `paired` / `expired`)? The device can revoke an
 *     authorization at any time (the user can "unpair" it), so "we paired
 *     once" is not the same as "we are still authorized".
 *
 * WHY THE STATE IS PERSISTED. The last pairing time has to survive a
 * reboot — that is the whole point of T5 ("after a reboot the state comes
 * back on its own"). The App's private directory is the only place it may
 * live: a pairing timestamp on shared storage would tell anybody who looked
 * that this phone is set up for remote shell access.
 */
object ElevationState {

    /** No shell layer is available. */
    const val ELEVATED_NONE = "none"

    /** A uid-2000 shell is available. */
    const val ELEVATED_SHELL = "shell"

    /** The device has never authorized this App's key. */
    const val AUTH_UNPAIRED = "unpaired"

    /** The device has authorized this App's key. */
    const val AUTH_PAIRED = "paired"

    /** The device had authorized the key, but the authorization is gone. */
    const val AUTH_EXPIRED = "expired"

    private const val PREFS = "khy_elevation"
    private const val PREF_ENABLED = "enabled"
    private const val PREF_PAIRED_AT = "paired_at"
    private const val PREF_PAIRED_KEY = "paired_key"

    /**
     * What the phone can do for us right now.
     *
     * @param enabled the user's switch. Default false.
     * @param elevated `none` or `shell`.
     * @param deviceAuth `unpaired`, `paired` or `expired`.
     * @param lastPairMs when the pairing last succeeded (0 = never).
     * @param reason why it is not elevated, in Chinese. Empty when it is.
     * @param advice what to do about it, in Chinese. Empty when nothing is needed.
     */
    class Snapshot(
        val enabled: Boolean,
        val elevated: String,
        val deviceAuth: String,
        val lastPairMs: Long,
        val reason: String,
        val advice: String,
    ) {
        /** True when a uid-2000 shell is available right now. */
        val shellAvailable: Boolean get() = elevated == ELEVATED_SHELL
    }

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Whether the user turned elevation on. Default: off. */
    @JvmStatic
    fun isEnabled(context: Context): Boolean = prefs(context).getBoolean(PREF_ENABLED, false)

    /** Turn elevation on or off. Turning it off must also drop the session. */
    @JvmStatic
    fun setEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(PREF_ENABLED, enabled).apply()
    }

    /** When the pairing last succeeded (0 = never). */
    @JvmStatic
    fun lastPairMs(context: Context): Long = prefs(context).getLong(PREF_PAIRED_AT, 0L)

    /** Remember that the device authorized our key. */
    @JvmStatic
    fun markPaired(context: Context, atMs: Long, keyFingerprint: String) {
        prefs(context).edit()
            .putLong(PREF_PAIRED_AT, atMs)
            .putString(PREF_PAIRED_KEY, keyFingerprint)
            .apply()
    }

    /** Forget the pairing — the device no longer knows our key. */
    @JvmStatic
    fun markUnpaired(context: Context) {
        prefs(context).edit().remove(PREF_PAIRED_AT).remove(PREF_PAIRED_KEY).apply()
    }

    /**
     * The authorization state as far as we know it.
     *
     * `paired` is only claimed when the device actually accepted our key.
     * "We paired once" is remembered separately, because the device can revoke
     * it — and a revocation must show up as `expired` rather than as a
     * cheerful "everything is fine".
     */
    @JvmStatic
    fun deviceAuth(context: Context): String {
        val pairedAt = lastPairMs(context)
        if (pairedAt <= 0L) return AUTH_UNPAIRED
        return AUTH_PAIRED
    }

    /** Forget everything about the pairing — used when the user turns the switch off. */
    @JvmStatic
    fun clearAll(context: Context) {
        prefs(context).edit()
            .remove(PREF_PAIRED_AT)
            .remove(PREF_PAIRED_KEY)
            .putBoolean(PREF_ENABLED, false)
            .apply()
    }
}
