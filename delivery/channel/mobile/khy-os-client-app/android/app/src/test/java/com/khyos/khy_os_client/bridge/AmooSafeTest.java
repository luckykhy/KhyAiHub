// khy-canary: Khy-20261101-042-NW55MEQK
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * AmooSafeTest — the outbound transform for everything the bridge hands Amoo.
 *
 * Two halves of equal weight, and the second one is the reason this class is
 * shaped the way it is:
 *
 *   - **What must be hidden.** A path, a package, a resource id, a port, a
 *     fingerprint. Miss one and the bridge has handed Amoo material its own
 *     rules forbid it to repeat.
 *   - **What must survive.** Amoo has to still be able to *address* files in
 *     the commands it emits — that is how {@link Tools} works at all. A
 *     transform that strips every filename leaves it unable to act, and a
 *     bridge that cannot act is as broken as one that leaks. Hence the rule
 *     "hide the location, keep the name", and hence
 *     {@link #aRealisticLsResultKeepsEveryEntryName} being the single most
 *     important test here.
 *
 * No Android, no device: every assertion is pure string work.
 */
public class AmooSafeTest {

    private static String san(String s) {
        return AmooSafe.sanitise(s);
    }

    // ---------- paths: hide the location ----------

    @Test
    public void sdcardPathsBecomePhoneStorageAndKeepTheFileName() {
        // THE required case. The user asked about 词刻.apk; the location is
        // filesystem layout and never what they asked about.
        assertEquals("手机存储里的词刻.apk", san("/sdcard/Download/词刻.apk"));
    }

    @Test
    public void aBareFileNameIsNotAPathAndSurvivesUntouched() {
        // No leading slash → the path rule does not fire at all. A filename
        // that got rewritten would be a fabrication: the text now says
        // something the tool never said.
        assertEquals("词刻.apk", san("词刻.apk"));
        // Found by running the tests: `pending.json.txt` is three dotted
        // segments, so the package regex matched it and the mailbox filename
        // became `amoo_某个应用` — destroying the one string the human needs
        // in order to act on a failed write-back. Fixed by requiring a known
        // registry TLD in the first segment; this test pins the fix.
        assertEquals("amoo_pending.json.txt", san("amoo_pending.json.txt"));
        assertEquals("notes.txt", san("notes.txt"));
        assertEquals("main.py", san("main.py"));
    }

    @Test
    public void aDottedFilenameIsNotMistakenForAPackage() {
        // Same bug, more shapes. All of these are names a tool legitimately
        // returns and all of them must survive byte-identical — the first
        // segment is a word, not a registry TLD, which is the whole rule.
        for (String name : new String[] {
            "amoo_pending.json.txt", "build.gradle.kts", "settings.json",
            "khy_os_client.iml", "app-debug.apk", "index.html",
            "gradle-9.8.2-bin.zip", "TEST-x.xml",
        }) {
            assertEquals(name, san(name));
        }
    }

    @Test
    public void aFilenameThatEmbedsOurPackageStillLosesThePackage() {
        // Not a counterexample: the package inside it IS an identifier, so it
        // is genericised and the surrounding filename survives.
        //
        // The trailing `.xml` is eaten along with the package. That is
        // accepted, not overlooked: the pattern is greedy and cannot tell
        // where a package ends and an extension begins, and the shape
        // (a filename with a package name inside it) is rare — `pm` output,
        // error messages and `list_apps` never carry it. The property that
        // matters holds: the identifier is gone and the name around it lives.
        assertEquals("TEST-khy-os", san("TEST-com.khyos.khy_os_client.xml"));
    }

    @Test
    public void aDeepPathKeepsOnlyTheLastSegment() {
        assertEquals("手机存储里的IMG_20261024_101530.jpg",
                san("/sdcard/DCIM/Camera/IMG_20261024_101530.jpg"));
        assertEquals("工作区里的计划.md",
                san("/sdcard/khy-os/workspace/notes/计划.md"));
    }

    @Test
    public void theStagingDirectoryBecomesATransferDirectory() {
        // /data/local/tmp is where install_apk stages the file the user is
        // waiting on. Name survives, location does not.
        assertEquals("临时中转目录里的khyos-install.apk",
                san("/data/local/tmp/khyos-install.apk"));
    }

    @Test
    public void anotherAppsPrivateDirectoryLosesThePackageName() {
        // The package is an identifier; the db name is the thing under discussion.
        assertEquals("应用私有目录里的x.db", san("/data/data/com.tencent.mm/MicroMsg/x.db"));
    }

    @Test
    public void systemPrefixesDropTheRemainderEntirely() {
        // Nothing user-relevant lives under /system, and keeping a tail there
        // would let /system/bin/sh read as a command the user could run.
        assertEquals("系统内部目录", san("/system/bin/sh"));
        assertEquals("系统内部目录", san("/vendor/lib/libc.so"));
    }

    @Test
    public void aBareRootResolvesToItsOwnLabel() {
        assertEquals("手机存储", san("/sdcard"));
        // A lone slash is not a path token — there is nothing after it to be
        // a location or a name, so it passes through unchanged. The doubled
        // form IS matched by the pattern and resolves to the root label.
        assertEquals("/", san("/"));
        assertEquals("存储根目录", san("//"));
    }

    @Test
    public void anUnknownRootKeepsTheNameWhenThereIsATail() {
        assertEquals("内部目录里的x.apk", san("/opt/udisk/x.apk"));
        // A single unknown segment is pure layout — nothing was named.
        assertEquals("内部目录", san("/init"));
    }

    @Test
    public void aBasenameThatIsItselfAPackageIsDropped() {
        // The tail is an identifier, not a name. Keeping it would defeat the
        // package rule through the back door.
        assertEquals("手机存储", san("/sdcard/com.stepx.wordcraft"));
    }

    @Test
    public void punctuationAroundAPathSurvives() {
        assertEquals("路径是 手机存储里的词刻.apk，请处理。",
                san("路径是 /sdcard/Download/词刻.apk，请处理。"));
    }

    @Test
    public void urlsAreNotMistakenForPaths() {
        // Found by running the code, not by reading it: without ':' and '/'
        // in the lookbehind, every URL in any read-back file became
        // "https:内部目录里的c". Byte-identical is the only acceptable answer.
        assertEquals("https://example.com/a/b/c", san("https://example.com/a/b/c"));
        assertTrue(san("see http://127.0.0.1:8896/ping").contains("本机回环"));
        assertFalse(san("see http://127.0.0.1:8896/ping").contains("内部目录"));
    }

    // ---------- identifiers ----------

    @Test
    public void packageNamesBecomeAGenericAppTerm() {
        assertEquals("某个应用", san("com.stepx.wordcraft"));
        assertEquals("装在 某个应用 里", san("装在 com.stepx.wordcraft 里"));
        // Amoo and ourselves already have names in the conversation.
        assertEquals("amoo", san("com.stepos.ailauncher"));
        assertEquals("khy-os", san("com.khyos.khy_os_client"));
    }

    @Test
    public void javaAndKotlinClassNamesAreNotMistakenForPackages() {
        // Rewriting these would be wrong and useless — they carry nothing
        // Amoo is forbidden to say, and they arrive constantly via stack
        // traces and ui_dump's class attribute.
        assertEquals("android.widget.TextView", san("android.widget.TextView"));
        assertEquals("org.json.JSONObject", san("org.json.JSONObject"));
        assertEquals("java.util.List", san("java.util.List"));
    }

    @Test
    public void aSettingsKeyKeepsItsNameAndLosesThePackage() {
        // Also found by running it: allowing '_' in the first segment made the
        // pattern eat the whole key, so the one string that explains an
        // INSTALL_FAILED_USER_RESTRICTED failure vanished from the message.
        assertEquals("usb_install_item_某个应用",
                san("usb_install_item_com.stepx.wordcraft"));
    }

    @Test
    public void resourceIdsBecomeAUiElement() {
        // Both the prefixed and the bare form; both appear in every ui_dump.
        assertEquals("界面元素", san("com.stepos.ailauncher:id/et_input_bar"));
        assertEquals("界面元素", san(":id/btn_send"));
        // Must run before the path pass, or the /et_input_bar tail is matched
        // by the path rule and leaves the package standing.
        assertFalse(san("com.stepos.ailauncher:id/et_input_bar").contains("ailauncher"));
    }

    @Test
    public void theBridgePortAndLoopbackNeverLeak() {
        assertEquals("本地端口", san("8896"));
        assertEquals("本地端口", san("8897"));
        // Literal match, so an unrelated number does not move.
        assertEquals("1500", san("1500"));
        assertEquals("本机回环", san("127.0.0.1"));
        assertEquals("本机回环", san("localhost"));
    }

    @Test
    public void deviceFingerprintsAreGenericised() {
        assertEquals("当前系统版本", san("Android 16"));
        // Whitespace required, so a filename is not hit.
        assertEquals("Android16.txt", san("Android16.txt"));
        assertEquals("系统接口版本", san("SDK 36"));
        assertEquals("当前架构", san("arm64-v8a"));
        assertEquals("系统安全策略", san("u:object_r:fuse:s0"));
    }

    @Test
    public void theInfoResultKeepsItsKeysAndItsHonestyFields() {
        // Keys are kept so info does not look like it failed to report
        // something; only the identifying values move. And "sdk":36 is an
        // integer, so it needed its own pass — the value-only pattern could
        // not see it, which was a real leak through the tool most likely to
        // be called for device facts.
        String out = san("{\"ok\":true,\"model\":\"STEPX Neo\",\"brand\":\"stepos\","
                + "\"device\":\"PZ261A\",\"release\":\"16\",\"sdk\":36,\"via\":\"sidecar\"}");
        assertTrue(out.contains("\"ok\":true"));
        assertTrue(out.contains("\"model\":\"本机\""));
        assertTrue(out.contains("\"brand\":\"本机\""));
        assertTrue(out.contains("\"device\":\"本机\""));
        assertTrue(out.contains("\"release\":\"本机\""));
        assertTrue(out.contains("\"sdk\":\"系统接口版本\""));
        assertFalse(out.contains("STEPX Neo"));
        assertFalse(out.contains("PZ261A"));
        assertFalse(out.contains("\"sdk\":36"));
        // The honesty field survives verbatim.
        assertTrue(out.contains("\"via\":\"sidecar\""));
    }

    // ---------- the preservation half ----------

    @Test
    public void aRealisticLsResultKeepsEveryEntryName() {
        // THE preservation test. ls is how Amoo finds out what is on the
        // phone; the entry names ARE the answer. If this fails, the transform
        // has made the bridge useless even though it is technically safe.
        String raw = "{\"ok\":true,\"path\":\"/sdcard/khy-os/workspace\",\"entries\":["
                + "{\"name\":\"main.py\",\"dir\":false,\"size\":128},"
                + "{\"name\":\"词刻.apk\",\"dir\":false,\"size\":4096},"
                + "{\"name\":\"DCIM\",\"dir\":true},"
                + "{\"name\":\"notes\",\"dir\":true}],"
                + "\"returned\":4,\"total\":4,\"truncated\":false}";
        String out = san(raw);
        assertFalse("the location must be gone", out.contains("/sdcard"));
        for (String name : new String[] {"main.py", "词刻.apk", "DCIM", "notes"}) {
            assertTrue("entry name must survive: " + name, out.contains(name));
        }
        assertTrue(out.contains("\"truncated\":false"));
        assertTrue(out.contains("\"returned\":4"));
    }

    @Test
    public void aRealisticExecResultSurvivesAsUsableProse() {
        // Amoo has to be able to read this and conclude the install worked.
        String out = san("{\"ok\":true,\"exit\":0,\"out\":\"Success\\n\","
                + "\"via\":\"sidecar\",\"elevated\":true,\"cmd\":\"pm install /data/local/tmp/khyos-install.apk\"}");
        assertTrue(out.contains("Success"));
        assertTrue(out.contains("khyos-install.apk"));
        assertFalse(out.contains("/data/local/tmp"));
        // via/elevated are honesty fields: they say whether the "success" is
        // real. They must never be dropped.
        assertTrue(out.contains("\"via\":\"sidecar\""));
        assertTrue(out.contains("\"elevated\":true"));
    }

    @Test
    public void aRealisticFailureMessageIsSanitised() {
        // The leak is on the failure path: FileNotFoundException's message
        // carries the path, and this is what executeOne's failure branch
        // writes back. Path gone, exception class kept (it is a class name,
        // not a package), errno kept.
        String out = san("java.io.FileNotFoundException: /sdcard/khy-os/workspace/x.txt: "
                + "open failed: EACCES");
        assertFalse(out.contains("/sdcard"));
        assertTrue("the exception class is not a package and must survive",
                out.contains("java.io.FileNotFoundException"));
        assertTrue("EACCES is an errno, not an identifier", out.contains("EACCES"));
    }

    @Test
    public void aRealisticVerifiedMemoryFactIsSanitised() {
        // The exact string that crosses on EVERY ask: rememberVerified writes
        // measured post-states into shared memory, and buildAskPreamble folds
        // them in. A leak here leaks on every single conversation.
        String out = san("read back /sdcard/g/main.py, 11 bytes");
        assertFalse(out.contains("/sdcard"));
        assertTrue(out.contains("main.py"));
        assertTrue("the measured number is the fact", out.contains("11 bytes"));
        assertTrue(out.contains("手机存储"));
    }

    @Test
    public void listAppsKeepsTheLabelTheUserKnows() {
        // The one case where the package is NOT the interesting part.
        String out = san("{\"package\":\"com.stepx.wordcraft\",\"label\":\"词刻\"}");
        assertFalse(out.contains("com.stepx.wordcraft"));
        assertTrue(out.contains("词刻"));
    }

    @Test
    public void aDottedCoordinateKeepsItsVersion() {
        // Known false positive, accepted and pinned: a Gradle coordinate in a
        // file we read back. The version survives, the group id does not. The
        // alternative — only rewriting packages resolvable through the package
        // manager — would miss every package that is not installed, which is
        // most of the ones that matter.
        assertEquals("某个应用:gradle:8.1.0", san("com.android.tools.build:gradle:8.1.0"));
    }

    @Test
    public void theMailboxAndWorkspaceUseTheSelfDescriptionsOwnVocabulary() {
        // The labels must match what AmooSelfDesc already calls these places,
        // or Amoo reads two different names for one directory.
        assertTrue(san("/sdcard/bridge-amoobridge/amoo_pending.json")
                .startsWith(AmooSafe.BRIDGE_DIR));
        assertTrue(san("/sdcard/khy-os/workspace/x").startsWith(AmooSafe.WORKSPACE));
    }

    // ---------- contract ----------

    @Test
    public void sanitiseIsDeterministicAndIdempotent() {
        String[] inputs = {
            "/sdcard/Download/词刻.apk", "com.tencent.mm", "Android 16",
            "{\"ok\":true,\"sdk\":36}", "plain text, nothing to hide",
        };
        for (String in : inputs) {
            String once = san(in);
            assertEquals("same input must give the same output", once, san(in));
            assertEquals("running it again must change nothing", once, san(once));
        }
    }

    @Test
    public void sanitiseNeverReturnsEmptyForANonEmptyInput() {
        // An empty write-back is indistinguishable from a dead layer. That is
        // the one failure mode this class cannot afford, so it is pinned here
        // rather than assumed.
        for (String in : new String[] {
            "x", "/", "//", "///", "/a", "/a/", ":", "::", ".", "..",
            "/sdcard", "/sdcard/", "com.a.b", "a.b.c.d.e",
        }) {
            String out = san(in);
            assertNotNull(out);
            assertFalse("input '" + in + "' must not vanish", out.isEmpty());
        }
    }

    @Test
    public void sanitiseHandlesALargePathFreeInputWithoutBlowingUp() {
        // 200k characters of path-free text must complete quickly. A regex
        // with catastrophic backtracking would hang the write-back thread,
        // and the write-back thread is what types into Amoo's box.
        StringBuilder sb = new StringBuilder(200000);
        for (int i = 0; i < 20000; i++) {
            sb.append("the quick brown fox jumps over 1234 lazy dogs. ");
        }
        String in = sb.toString();
        long t0 = System.currentTimeMillis();
        String out = san(in);
        long ms = System.currentTimeMillis() - t0;
        assertEquals("path-free text must pass through untouched", in, out);
        assertTrue("took " + ms + "ms — possible catastrophic backtracking", ms < 5000);
    }

    @Test
    public void wouldChangeAgreesWithSanitise() {
        assertTrue(AmooSafe.wouldChange("/sdcard/x"));
        assertFalse(AmooSafe.wouldChange("nothing here"));
        assertFalse(AmooSafe.wouldChange(null));
        assertFalse(AmooSafe.wouldChange(""));
    }

    @Test
    public void nullAndEmptyPassThroughWithoutBecomingSomethingElse() {
        assertEquals("", san(null));
        assertEquals("", san(""));
    }
}
