// khy-canary: Khy-20261101-007-PHA8XKMZ
package com.khyos.khy_os_client.bridge;

/**
 * AmooSelfDesc — the Amoo entry point into the generated self-description.
 *
 * WHY THIS CLASS STILL EXISTS. It is three lines of delegation, which is a fair
 * thing to ask about, so: the renderer moved to {@link SelfDesc} because the
 * description is now assembled from a tool directory, a live capability
 * snapshot and an {@link AssistantProfile} instead of being hand-written. This
 * class remains because two things depend on its exact surface —
 *
 *   1. a dozen tests call {@link #render()} with no arguments, and
 *      {@code AmooSafeHostAuditTest} calls it to assert the sanitiser leaves
 *      the description alone;
 *   2. it shares its vocabulary with {@link AmooSafe}, and
 *      {@code AmooSafeTest.theMailboxAndWorkspaceUseTheSelfDescriptionsOwnVocabulary}
 *      asserts the two agree on what to call the mailbox and the workspace.
 *      Splitting that vocabulary across two packages is how the two drift into
 *      naming one directory two different things.
 *
 * So: Amoo's path enters here, the portable renderer lives in {@link SelfDesc},
 * and the shared vocabulary stays co-located with its consumer.
 *
 * WHY IT CAPTURES A SNAPSHOT PER CALL. The description used to be static text.
 * It is not any more — it reports whether the accessibility service and the
 * elevation channels are up — so each render reads the current state. That is
 * why the caller's javadoc in {@code AmooLoop.buildAskPreamble} was updated:
 * "no IO" is still true (the snapshot reads in-memory counters and build
 * constants, never disk), but "static text" is not.
 *
 * The snapshot falls back to {@link CapabilitySnapshot#none()} when the bridge
 * has not been initialised, which is the unit-test case. That render says
 * everything is unavailable, which is the honest answer for a bridge that was
 * never started — and it keeps {@code render()} callable with no Context, which
 * is what the tests need.
 */
public final class AmooSelfDesc {

    private AmooSelfDesc() {}

    /** Hard ceiling, kept here as well so callers of this façade need not import SelfDesc. */
    public static final int MAX_CHARS = SelfDesc.MAX_CHARS;

    /** The description Amoo needs, given what the phone can do right now. */
    public static String render() {
        android.content.Context c = Tools.ctxRef();
        CapabilitySnapshot snap = (c == null)
                ? CapabilitySnapshot.none()
                : CapabilitySnapshot.capture(c);
        return SelfDesc.render(AssistantProfile.AMOO, snap);
    }

    /**
     * Whether every tool is named in exactly one group.
     *
     * Kept as a delegate rather than moved outright: {@code AmooSelfDescTest}
     * calls it by name, and a test hook that silently stops being called reads
     * as a passed test.
     */
    public static boolean groupsCoverEveryToolExactlyOnce() {
        return SelfDesc.groupsCoverEveryToolExactlyOnce();
    }
}
