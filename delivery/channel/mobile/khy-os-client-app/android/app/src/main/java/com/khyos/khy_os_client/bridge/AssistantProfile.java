// khy-canary: Khy-20261101-008-KE2DMKKX
package com.khyos.khy_os_client.bridge;

/**
 * AssistantProfile — what the assistant on the other end of the chat is.
 *
 * WHY this exists as data rather than as branches in the renderer. The bridge's
 * self-description used to be one hand-written block of prose that was correct
 * for exactly one assistant. Three of its paragraphs assert things that are
 * true of Amoo and false of, say, an on-device Honor YOYO:
 *
 *   · 「你自己不能在 App 界面里点按」 — Amoo's own policy limit. An assistant
 *     with GUI ability, or without that policy, makes the paragraph a lie.
 *   · 「不要用 ``` 代码块包裹」 — this device's renderer eats fence lines, so
 *     the fence protocol is unusable HERE. Elsewhere it may be the best option.
 *   · 「你和云端都连不到它」 — presumes a remote assistant. An on-device one
 *     reads that as nonsense.
 *
 * Hand-written prose cannot be correct for three assistants at once. So the
 * prose is generated, and the per-assistant facts live here as flags the
 * renderer selects on.
 *
 * WHY THIS IS ONLY THREE FLAGS TODAY. The full profile needs five axes —
 * identity (package, chat activity, resource ids), protocol, environment,
 * and timing (a turn takes ~6 minutes on Amoo and milliseconds on an
 * on-device model). Only the three that change the DESCRIPTION are here now;
 * the other two belong to {@code AmooLoop} and come with the profile extraction
 * that needs them. Building them now would mean a class with one constant and
 * no second caller — which is speculation, not design.
 *
 * Contract: immutable value object. No Android imports, so it is testable on
 * the bare JVM the unit tests run on.
 */
public final class AssistantProfile {

    /**
     * This device's renderer consumes markdown fence lines, so the fenced
     * {@code ```khy-exec} protocol never reaches the accessibility tree and
     * commands must be bare JSON objects on their own line.
     */
    public final boolean eatsCodeFences;

    /**
     * The assistant runs in the cloud, not on the phone. Changes the boundary
     * paragraph: it cannot reach the loopback bridge, and the phone's shared
     * storage is reachable only through the file tools.
     */
    public final boolean cloudBrain;

    /**
     * The assistant can operate a GUI itself. When false, the description has
     * to state the division of labour explicitly — otherwise the assistant
     * answers "I can't do that" to a request the bridge can fulfil.
     */
    public final boolean hasGuiAbility;

    /** Label for the assistant-facing tool group in the description. */
    public final String toolGroupLabel;

    public AssistantProfile(boolean eatsCodeFences, boolean cloudBrain,
                            boolean hasGuiAbility, String toolGroupLabel) {
        this.eatsCodeFences = eatsCodeFences;
        this.cloudBrain = cloudBrain;
        this.hasGuiAbility = hasGuiAbility;
        this.toolGroupLabel = toolGroupLabel == null ? "" : toolGroupLabel;
    }

    /**
     * Amoo, as measured on this device.
     *
     * These three values are not preferences — each one is a measured fact, and
     * each one has a comment where it is used explaining what was measured.
     * Changing one changes what the assistant is told, so it is pinned by test.
     */
    public static final AssistantProfile AMOO = new AssistantProfile(
            /* eatsCodeFences */ true,
            /* cloudBrain      */ true,
            /* hasGuiAbility   */ false,
            /* toolGroupLabel  */ "助手循环");

    /**
     * A conservative default for an assistant we know nothing about.
     *
     * Every flag is the value that keeps the description TRUE rather than
     * useful: do not claim fences work (bare JSON lines are always accepted),
     * do not claim it is remote, and do assume it lacks GUI reach. The cost is
     * a longer description; the alternative is a wrong one.
     */
    public static final AssistantProfile GENERIC = new AssistantProfile(
            /* eatsCodeFences */ false,
            /* cloudBrain      */ false,
            /* hasGuiAbility   */ false,
            /* toolGroupLabel  */ "助手循环");
}
