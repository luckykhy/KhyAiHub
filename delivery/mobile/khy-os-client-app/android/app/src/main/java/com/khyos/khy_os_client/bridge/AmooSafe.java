// khy-canary: Khy-20261101-006-N7Q9VFWP
package com.khyos.khy_os_client.bridge;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AmooSafe — the outbound transform for everything the bridge hands to Amoo.
 *
 * WHY this class exists. Amoo's own rules (AMOO-GUIDELINES.md §4.2/§4.4) forbid
 * it from repeating absolute filesystem paths, package names, and internal
 * device identifiers back to the user. But the bridge's whole job is to run
 * commands on Amoo's behalf and read the results back, and those results are
 * full of exactly those strings: {@code Tools.ls} returns {@code /sdcard/...},
 * {@code Tools.read} throws {@code FileNotFoundException} carrying the path,
 * {@code Tools.info} returns the model and SDK level, and {@code ui_dump}
 * returns {@code com.stepos.ailauncher:id/et_input_bar} on every node.
 *
 * So the bridge is structurally in the position of handing Amoo material it is
 * not allowed to repeat. Closing that in each of ~40 tools is 40 places to
 * forget, and the failure mode is the worst available: one tool leaks and the
 * conversation looks identical to the ones that don't.
 *
 * Hence ONE chokepoint — {@link AmooLoop#forAmoo} — and this class doing the
 * work. A ninth call site inherits the transform for free.
 *
 * WHY text-level and not schema-level. Tool results are prose-to-a-model: they
 * are typed into a chat box and nothing downstream parses them as JSON. A
 * schema mapper would have to whitelist keys, and the honesty fields
 * ({@code ok}, {@code via}, {@code exit}, {@code interrupted}, {@code elevated})
 * would be the first things dropped — they exist precisely so that "did not
 * happen" is never rendered as "happened". This class never drops or renames a
 * key; it only rewrites values that are identifiers.
 *
 * THE RULE: hide the location, keep the name. A path carries two different
 * kinds of content. The directory part is filesystem layout — what Amoo must
 * not repeat, and never what the user asked about. The final segment is the
 * thing the user named, asked for, or is waiting on. So: resolve the longest
 * known prefix to its generic name, then keep the last segment of whatever
 * follows and drop every segment in between.
 *
 * Contract: pure, deterministic, idempotent, never throws. No Android imports —
 * the unit test runs on a bare JVM. {@link #AMOO_PKG} and
 * {@link #OWN_PKG_PREFIX} are literals rather than references to
 * {@link AmooLoop#AMOO_PKG} / {@code ctx.getPackageName()} for the same reason
 * {@link AmooSelfDesc} pins its own constants: both are pinned by tests.
 */
public final class AmooSafe {

    private AmooSafe() {}

    // ------------------------------------------------------------------
    // The only strings this class may introduce.
    //
    // Deliberately the same vocabulary AmooSelfDesc already uses, because a
    // term the self-description never mentions is a term Amoo has no reason
    // to trust when it reads it back in a result.
    // ------------------------------------------------------------------

    public static final String PHONE_STORAGE = "手机存储";
    public static final String WORKSPACE = "工作区";
    public static final String BRIDGE_DIR = "桥的共享目录";
    public static final String TRANSFER_DIR = "临时中转目录";
    public static final String APP_PRIVATE = "应用私有目录";
    public static final String SYSTEM_DIR = "系统内部目录";
    public static final String SYSTEM_APP = "系统安装目录";
    public static final String UNKNOWN_DIR = "内部目录";
    public static final String ROOT_DIR = "存储根目录";
    public static final String GENERIC_APP = "某个应用";
    public static final String AMOO = "amoo";
    public static final String KHY_OS = "khy-os";
    public static final String UI_ELEMENT = "界面元素";
    public static final String LOCAL_PORT = "本地端口";
    public static final String LOOPBACK = "本机回环";
    public static final String THIS_DEVICE = "本机";
    public static final String OS_LEVEL = "系统接口版本";
    public static final String CURRENT_ARCH = "当前架构";
    public static final String CURRENT_OS = "当前系统版本";
    public static final String SELINUX_POLICY = "系统安全策略";

    /** Amoo's package. Already in the conversation under the name {@link #AMOO}. */
    private static final String AMOO_PKG = "com.stepos.ailauncher";

    /** Our own package prefix. Already in the conversation as {@link #KHY_OS}. */
    private static final String OWN_PKG_PREFIX = "com.khyos.";

    /**
     * Second segments that mark a dotted string as a Java/Kotlin class name
     * rather than a package: {@code android.widget.TextView},
     * {@code org.json.JSONObject}, {@code java.util.List}.
     *
     * They reach results through stack traces and {@code ui_dump}'s
     * {@code class} attribute. Rewriting them would be both wrong and useless —
     * they carry nothing Amoo is forbidden to say.
     */
    private static final String[] NOT_A_PACKAGE_SECOND = {
        "widget", "view", "internal", "content", "os", "graphics", "webkit",
        "provider", "telephony", "media", "hardware", "nfc", "bluetooth",
        "annotation", "transition", "json", "junit", "apache", "eclipse",
        "jetbrains", "intellij", "kotlin", "java", "javax", "dalvik",
    };

    /**
     * First segments that denote an APPLICATION package.
     *
     * WHY this allowlist exists — it was added because {@code
     * amoo_pending.json.txt} was being rewritten to {@code amoo_某个应用}.
     * A bare filename is not a path, so the path pass correctly leaves it
     * alone; the package pass then saw {@code pending.json.txt}, matched it as
     * three dotted segments, and genericised it. The result was text saying
     * something the tool never said — a fabrication, and one that destroys the
     * mailbox filename the human needs in order to act.
     *
     * So the discriminator cannot be "three dotted segments" alone. A package
     * and a filename are both dotted; what separates them is that a package's
     * first segment is a registry TLD and a filename's is a word. Requiring a
     * known TLD is the only signal available without querying the package
     * manager — and querying it was already rejected, because it would miss
     * every package that is not installed, which is most of the ones that
     * matter.
     *
     * Deliberately EXCLUDED: {@code android}, {@code java}, {@code javax},
     * {@code kotlin}, {@code dalvik}, {@code org}. Those are library and
     * framework namespaces, not application packages — Amoo is not forbidden
     * from saying {@code android.os.Build}, and mangling it would break stack
     * traces that explain real failures. The consequence, accepted: a Gradle
     * coordinate written as {@code android.tools.build:gradle} keeps its group
     * id. The {@code com.android.tools.build} spelling is still caught.
     */
    private static final String[] PACKAGE_FIRST = {
        "com", "cn", "net", "io", "me", "dev", "app", "co", "tv", "xyz",
        "top", "vip", "im", "so",
    };

    // ------------------------------------------------------------------
    // Patterns.
    //
    // Two of these carry fixes that were found by running the code, not by
    // reading it, and both are load-bearing:
    //
    //   ABSOLUTE_PATH's lookbehind includes ':' and '/'. Without them,
    //   {@code https://example.com/a/b} becomes {@code https:内部目录里的b}
    //   and {@code http://127.0.0.1:8896/ping} becomes
    //   {@code http:内部目录里的127.0.0.1:本地端口/ping} — every URL in any
    //   read-back file rewritten into nonsense.
    //
    //   PACKAGE's first segment is {@code [a-z][a-z0-9]*} with no underscore.
    //   Allowing '_' made it match the whole of
    //   {@code usb_install_item_com.stepx.wordcraft} and replace the settings
    //   key along with the package — losing the one string that explains an
    //   INSTALL_FAILED_USER_RESTRICTED failure.
    // ------------------------------------------------------------------

    /**
     * An absolute POSIX path. The lookbehind is what keeps URLs intact:
     * a ':' or '/' immediately before the slash means this is part of a
     * scheme or a doubled separator, not the start of a path.
     *
     * The character class includes '{@code \}' for a reason found by running the
     * REAL device output through this class: {@code JSONObject.toString()}
     * escapes forward slashes, so {@code Tools.ls} returns
     * {@code "path":"\/sdcard\/khy-os\/workspace"} — not
     * {@code "/sdcard/khy-os/workspace"}. Without '{@code \}' in the class the
     * regex matched each {@code /segment} separately, and a three-segment path
     * resolved to {@code 手机存储\内部目录\内部目录}: the location was hidden but
     * the NAME was destroyed with it, and the result stopped being parseable
     * ({@code \手机存储} is an illegal JSON escape).
     *
     * Including it makes the whole escaped path one token, which
     * {@link #resolvePath} then unescapes before matching prefixes. Every
     * hand-written test in this file used unescaped paths and so never exercised
     * this shape — only the real bytes did.
     *
     * The leading {@code \\?} swallows the escape's own backslash. Without it the
     * path resolved correctly but left a stray {@code \} in front of the
     * replacement ({@code "\工作区里的workspace"}), which is an illegal JSON
     * escape — measured, not theorised.
     */
    private static final Pattern ABSOLUTE_PATH = Pattern.compile(
            "(?<![A-Za-z0-9.:/])(\\\\?/[A-Za-z0-9_\\-.\\\\/+%~@=&\\u4e00-\\u9fff]+)");

    /** {@code com.stepos.ailauncher:id/et_input_bar} — a resource id. */
    private static final Pattern RESOURCE_ID = Pattern.compile(
            "(?<![A-Za-z0-9.\\-])[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]+){2,}:id/[A-Za-z0-9_.\\-]+");

    /** {@code :id/btn_send} — the same thing with the package elided. */
    private static final Pattern RESOURCE_ID_BARE = Pattern.compile(
            "(?<![A-Za-z0-9.\\-]):id/[A-Za-z0-9_.\\-]+");

    /**
     * A package name. The trailing lookahead rejects {@code foo.bar.Baz}
     * (a class) and {@code a.b-c} while accepting {@code com.tencent.mm}.
     */
    private static final Pattern PACKAGE = Pattern.compile(
            "(?<![A-Za-z0-9.])([a-z][a-z0-9]*(?:\\.[a-z][a-z0-9_]+){2,})(?![A-Za-z0-9_\\-])");

    /**
     * The {@code list_apps} pair, where the package is NOT the interesting
     * part — the label is the app's name as the user knows it. Must run
     * before the package pass or the pair is already gone.
     */
    private static final Pattern APP_LABEL_PAIR = Pattern.compile(
            "\"package\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"label\"\\s*:\\s*\"([^\"]*)\"");

    /** The bridge's own ports. Literal, so no unrelated number moves. */
    private static final Pattern BRIDGE_PORT = Pattern.compile("\\b(8896|8897)\\b");

    private static final Pattern LOOPBACK_ADDR =
            Pattern.compile("\\b127\\.0\\.0\\.1\\b|\\blocalhost\\b");

    /** Requires whitespace so {@code Android16.txt} is not hit. */
    private static final Pattern OS_VERSION =
            Pattern.compile("(?i)\\bandroid[ \\t]+\\d+(?:\\.\\d+)*");

    private static final Pattern SDK_LEVEL = Pattern.compile("(?i)\\bsdk[ \\t]+\\d+\\b");

    private static final Pattern ARCH = Pattern.compile(
            "\\b(arm64-v8a|armeabi-v7a|armeabi|aarch64|x86_64|x86)\\b");

    private static final Pattern SELINUX_CTX =
            Pattern.compile("u:object_r:[a-z0-9_]+:s0");

    /**
     * {@code info}'s fingerprint values, anchored on the key name.
     *
     * The anchor is what makes this safe: those five keys are produced in
     * exactly one place, {@link Tools#info}. The KEY is kept so {@code info}
     * does not look like it failed to report something.
     */
    private static final Pattern INFO_VALUE = Pattern.compile(
            "\"(model|brand|device|release)\"\\s*:\\s*\"[^\"]*\"");

    /**
     * {@code "sdk":36} — the one number in {@code info} that states the OS
     * version outright. Covered as its own pass because the value is an
     * integer, not a string, so {@link #INFO_VALUE} cannot see it.
     */
    private static final Pattern INFO_LEVEL = Pattern.compile("\"sdk\"\\s*:\\s*-?\\d+");

    // ------------------------------------------------------------------
    // The prefix table. LONGEST PREFIX FIRST — the order IS the mechanism:
    // /data must be tested after /data/data, /data/app and /data/local/tmp,
    // or a staging path resolves to the generic system directory.
    // ------------------------------------------------------------------

    /** One entry: a known root, what to call it, and whether the tail survives. */
    private static final class Loc {
        final String prefix;
        final String label;
        final boolean keepBase;

        Loc(String prefix, String label, boolean keepBase) {
            this.prefix = prefix;
            this.label = label;
            this.keepBase = keepBase;
        }
    }

    private static final Loc[] PREFIXES = {
        new Loc("/sdcard/bridge-amoobridge", BRIDGE_DIR, true),
        new Loc("/sdcard/khy-os", WORKSPACE, true),
        new Loc("/storage/emulated/0", PHONE_STORAGE, true),
        new Loc("/storage/self/primary", PHONE_STORAGE, true),
        new Loc("/data/local/tmp", TRANSFER_DIR, true),
        new Loc("/data/user", APP_PRIVATE, true),
        new Loc("/data/data", APP_PRIVATE, true),
        new Loc("/data/app", SYSTEM_APP, false),
        new Loc("/data", SYSTEM_DIR, false),
        new Loc("/sdcard", PHONE_STORAGE, true),
        new Loc("/system", SYSTEM_DIR, false),
        new Loc("/vendor", SYSTEM_DIR, false),
        new Loc("/product", SYSTEM_DIR, false),
        new Loc("/odm", SYSTEM_DIR, false),
        new Loc("/apex", SYSTEM_DIR, false),
        new Loc("/proc", SYSTEM_DIR, false),
        new Loc("/sys", SYSTEM_DIR, false),
        new Loc("/dev", SYSTEM_DIR, false),
        new Loc("/etc", SYSTEM_DIR, false),
        new Loc("/boot", SYSTEM_DIR, false),
        new Loc("/config", SYSTEM_DIR, false),
        new Loc("/mnt", SYSTEM_DIR, false),
    };

    // ------------------------------------------------------------------
    // Entry points
    // ------------------------------------------------------------------

    /**
     * Rewrite everything Amoo must not be handed, and nothing else.
     *
     * Never null. Never empty for a non-empty input — an empty write-back is
     * indistinguishable from a dead layer, which is the one failure mode this
     * whole class cannot afford.
     *
     * @param text raw tool result, prompt, or memory injection. May be null.
     * @return the same text with identifiers genericised.
     */
    public static String sanitise(String text) {
        if (text == null || text.isEmpty()) {
            return text == null ? "" : text;
        }
        String s = text;
        // Order is load-bearing; see each method's javadoc.
        s = resourceIds(s);
        s = appLabelPairs(s);
        s = absolutePaths(s);
        s = packageNames(s);
        s = bridgePorts(s);
        s = systemFingerprints(s);
        return s;
    }

    /**
     * Whether {@link #sanitise} would change this text at all.
     *
     * For tests and for callers that want to log "nothing to hide here"
     * without diffing two strings.
     */
    public static boolean wouldChange(String text) {
        return text != null && !text.isEmpty() && !sanitise(text).equals(text);
    }

    // ------------------------------------------------------------------
    // Passes, in the order sanitise applies them.
    // ------------------------------------------------------------------

    /**
     * Pass 1 — resource ids, both prefixed and bare.
     *
     * MUST run before the path pass: {@code com.stepos.ailauncher:id/et_input_bar}
     * ends in {@code /et_input_bar}, which the path rule would match and turn
     * into {@code com.stepos.ailauncher:id/界面元素} — leaving the package
     * standing and mangling the node name. Doing this first removes the whole
     * token before the path rule ever sees it.
     */
    private static String resourceIds(String s) {
        s = RESOURCE_ID.matcher(s).replaceAll(UI_ELEMENT);
        s = RESOURCE_ID_BARE.matcher(s).replaceAll(UI_ELEMENT);
        return s;
    }

    /**
     * Pass 2 — the {@code list_apps} package/label pair.
     *
     * Drops the package, keeps the label. Lossless in the way that matters:
     * the label is the app's name as the user knows it.
     *
     * MUST run before the package pass, or the pair is already gone and the
     * label is orphaned next to a generic term.
     */
    private static String appLabelPairs(String s) {
        Matcher m = APP_LABEL_PAIR.matcher(s);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            m.appendReplacement(sb, Matcher.quoteReplacement(
                    "\"label\":\"" + m.group(2) + "\""));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /**
     * Pass 3 — absolute paths, via THE RULE.
     *
     * Runs after the resource-id pass for the reason given there, and before
     * the package pass so that {@code /data/data/com.tencent.mm/MicroMsg/x.db}
     * resolves its prefix while the package is still visible to the prefix
     * matcher.
     */
    private static String absolutePaths(String s) {
        Matcher m = ABSOLUTE_PATH.matcher(s);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            m.appendReplacement(sb, Matcher.quoteReplacement(resolvePath(m.group(1))));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /**
     * Pass 4 — package names.
     *
     * Amoo's own package and ours become the names they already go by in the
     * conversation; everything else becomes {@link #GENERIC_APP}. A package
     * that is already generic keeps its key: {@code usb_install_item_com.x}
     * becomes {@code usb_install_item_某个应用}, because that key is the one
     * string that explains an install-permission failure.
     */
    private static String packageNames(String s) {
        Matcher m = PACKAGE.matcher(s);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            String pkg = m.group(1);
            // The regex finds three-or-more dotted segments; whether that IS a
            // package is a separate question, and `pending.json.txt` is the
            // reason. Keeping the original text when it is not one is what
            // stops a bare filename from being rewritten into a lie.
            String out = looksLikePackage(pkg) ? genericFor(pkg) : pkg;
            m.appendReplacement(sb, Matcher.quoteReplacement(out));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /** Pass 5 — the bridge's own ports and loopback addresses. */
    private static String bridgePorts(String s) {
        s = BRIDGE_PORT.matcher(s).replaceAll(LOCAL_PORT);
        s = LOOPBACK_ADDR.matcher(s).replaceAll(LOOPBACK);
        return s;
    }

    /** Pass 6 — device fingerprints: OS version, arch, SELinux, info values. */
    private static String systemFingerprints(String s) {
        s = OS_VERSION.matcher(s).replaceAll(CURRENT_OS);
        s = SDK_LEVEL.matcher(s).replaceAll(OS_LEVEL);
        s = ARCH.matcher(s).replaceAll(CURRENT_ARCH);
        s = SELINUX_CTX.matcher(s).replaceAll(SELINUX_POLICY);
        s = INFO_LEVEL.matcher(s).replaceAll("\"sdk\":\"" + OS_LEVEL + "\"");
        s = INFO_VALUE.matcher(s).replaceAll(
                "\"$1\":\"" + THIS_DEVICE + "\"");
        return s;
    }

    // ------------------------------------------------------------------
    // THE RULE
    // ------------------------------------------------------------------

    /**
     * Resolve one absolute path: hide the location, keep the name.
     *
     * Longest known prefix wins, then the last segment of the remainder is
     * kept and everything in between is dropped. Two deliberate exceptions:
     *
     *   1. System prefixes drop the remainder too. Nothing user-relevant
     *      lives under {@code /system}, and keeping a tail there would let
     *      {@code /system/bin/sh} read as a command the user could run.
     *   2. A basename that is itself a package name is dropped, because it is
     *      an identifier rather than a name.
     */
    private static String resolvePath(String raw) {
        // Undo JSON's forward-slash escaping before doing anything else.
        //
        // Tool results reach this class as `JSONObject.toString()` output, which
        // escapes '/' as '\/'. Matching prefixes against the escaped form fails
        // for every entry in the table, so the path resolves as an unknown root
        // and the name is destroyed along with the location. Measured on a real
        // `Tools.ls` response; see ABSOLUTE_PATH's javadoc.
        String path = raw.replace("\\/", "/");
        while (path.length() > 1 && path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        if (path.length() <= 1) {
            return ROOT_DIR;
        }

        Loc best = null;
        for (int i = 0; i < PREFIXES.length; i++) {
            Loc c = PREFIXES[i];
            if (path.equals(c.prefix) || path.startsWith(c.prefix + "/")) {
                best = c; // table is longest-first, so the first hit is the best
                break;
            }
        }

        if (best == null) {
            // Unknown root. Keep the name only when there is a real tail to
            // keep — a single unknown segment (/init, /opt) is pure layout.
            String rest = path.substring(1);
            int slash = rest.indexOf('/');
            if (slash < 0) {
                return UNKNOWN_DIR;
            }
            String tail = rest.substring(rest.lastIndexOf('/') + 1);
            if (tail.isEmpty() || looksLikePackage(tail)) {
                return UNKNOWN_DIR;
            }
            return UNKNOWN_DIR + "里的" + tail;
        }

        if (path.equals(best.prefix)) {
            return best.label;
        }
        if (!best.keepBase) {
            return best.label;
        }
        String tail = lastSegment(path.substring(best.prefix.length()));
        if (tail.isEmpty() || looksLikePackage(tail)) {
            return best.label;
        }
        return best.label + "里的" + tail;
    }

    /** The final segment of a remainder that always starts with '/'. */
    private static String lastSegment(String rest) {
        if (rest == null || rest.isEmpty()) {
            return "";
        }
        String v = rest;
        while (v.length() > 1 && v.endsWith("/")) {
            v = v.substring(0, v.length() - 1);
        }
        int slash = v.lastIndexOf('/');
        return slash < 0 ? v : v.substring(slash + 1);
    }

    // ------------------------------------------------------------------
    // Package helpers
    // ------------------------------------------------------------------

    /**
     * Whether a dotted string is a package rather than a filename or a
     * Java/Kotlin class.
     *
     * Two signals, both cheap and both load-bearing:
     *
     *   1. First segment must be a known registry TLD ({@link #PACKAGE_FIRST}).
     *      Without this, {@code pending.json.txt} reads as a package.
     *   2. Second segment must not be a class namespace
     *      ({@link #NOT_A_PACKAGE_SECOND}) — {@code android.widget.*} and
     *      {@code org.json.*} arrive constantly via stack traces and
     *      {@code ui_dump}'s {@code class} attribute.
     *
     * A third signal — "no segment may contain {@code _}" — was tried and
     * REVERTED. It rejected {@code com.khyos.khy_os_client}, which is this
     * project's own package and therefore one of the most common strings in
     * its results. Package segments are Java identifiers and may legally
     * carry an underscore; the TLD check alone separates them from filenames.
     */
    private static boolean looksLikePackage(String dotted) {
        if (dotted == null || dotted.isEmpty()) {
            return false;
        }
        int first = dotted.indexOf('.');
        if (first <= 0) {
            return false;
        }
        int second = dotted.indexOf('.', first + 1);
        if (second < 0) {
            return false; // two segments only: a filename like notes.txt
        }
        String head = dotted.substring(0, first);
        boolean knownTld = false;
        for (int i = 0; i < PACKAGE_FIRST.length; i++) {
            if (PACKAGE_FIRST[i].equals(head)) {
                knownTld = true;
                break;
            }
        }
        if (!knownTld) {
            return false;
        }
        String seg = dotted.substring(first + 1, second);
        for (int i = 0; i < NOT_A_PACKAGE_SECOND.length; i++) {
            if (NOT_A_PACKAGE_SECOND[i].equals(seg)) {
                return false;
            }
        }
        return true;
    }

    /**
     * The generic term for a package name.
     *
     * Amoo's and ours are already named in the conversation, so they keep
     * their names — genericising them would make the self-description and the
     * results disagree about what "amoo" means.
     */
    private static String genericFor(String pkg) {
        if (AMOO_PKG.equals(pkg)) {
            return AMOO;
        }
        if (pkg.startsWith(OWN_PKG_PREFIX)) {
            return KHY_OS;
        }
        return GENERIC_APP;
    }
}
