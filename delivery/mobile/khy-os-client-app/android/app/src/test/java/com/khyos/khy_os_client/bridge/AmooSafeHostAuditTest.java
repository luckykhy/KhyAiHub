// khy-canary: Khy-20261101-041-W8CFZ6K4
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AmooSafeHostAuditTest — the host-runnable substitute for the device that is
 * not there.
 *
 * WHY THIS FILE EXISTS. {@code AmooSafe} has never run on a phone: {@code adb
 * devices} is empty. What is unverified is the INTEGRATION — what
 * {@code KhyUi.dispatch("ui_type")} actually receives, and whether Amoo can
 * still act after reading genericised prose. Nothing here can close that, and
 * this class does not claim to.
 *
 * What it CAN do is make the completeness audit non-vacuous. The obvious form —
 * "build the string each write-back site produces, run it through forAmoo" — is
 * worthless, because the test's copy of those format strings is a COPY: it
 * passes unchanged if a production format string gains a new raw field. So two
 * tests below read {@code AmooLoop.java} off disk and assert against the SOURCE:
 *   - {@link #everyOutboundChannelIsSanitisedAndThereIsOnlyOne} — the real
 *     invariant, replacing an occurrence counter that cannot see a new channel.
 *   - {@link #noWriteBackArgumentCanGainARawField} — extracts the literals from
 *     the actual call sites, so a new raw field turns this red.
 *
 * Both are still weaker than a device: they prove properties of the source text,
 * not of runtime values. That limit is stated in each javadoc rather than
 * hidden, because a test that looks like proof and is not is the failure mode
 * this project keeps hitting.
 *
 * No Android imports; runs on a bare JVM like AmooSafeTest.
 */
public class AmooSafeHostAuditTest {

    private static final String MAIN = "AmooLoop.java";

    // Forbidden tokens: the identifier classes AmooSafe exists to remove.
    private static final String[] FORBIDDEN = {
        "/sdcard", "/data/", "com.stepos.", "com.khyos.", "8896", "8897",
        "127.0.0.1", "u:object_r:", "PZ261A", "arm64-v8a",
    };

    // ------------------------------------------------------------------
    // Reading the source
    // ------------------------------------------------------------------

    /**
     * AmooLoop.java's text, or a failure naming every path that was tried.
     *
     * Resolves by walking up from the JVM's working directory AND from the
     * compiled class's own location, up to 6 levels each. AGP runs unit tests
     * with the module directory as cwd, but that is an implementation detail
     * this test does not get to assume — if neither route finds the file, it
     * FAILS with the searched paths rather than skipping. A skipped audit reads
     * as a passed one.
     */
    private static String amooLoopSource() throws Exception {
        List<String> tried = new ArrayList<String>();
        for (String base : new String[] {
            System.getProperty("user.dir", "."),
            AmooLoop.class.getProtectionDomain().getCodeSource().getLocation()
                    .getPath(),
        }) {
            File cur = new File(base);
            for (int up = 0; up < 6 && cur != null; up++, cur = cur.getParentFile()) {
                File candidate = new File(cur,
                        "app/src/main/java/com/khyos/khy_os_client/bridge/" + MAIN);
                tried.add(candidate.getAbsolutePath());
                if (candidate.isFile()) {
                    return new String(Files.readAllBytes(candidate.toPath()),
                            StandardCharsets.UTF_8);
                }
            }
        }
        throw new IllegalStateException(
                "找不到 " + MAIN + "，已试过：" + tried
                        + "。审计测试不允许静默跳过——修好路径解析，不要删掉断言。");
    }

    private static int countOf(String haystack, String needle) {
        int n = 0;
        for (int at = haystack.indexOf(needle); at >= 0;
                at = haystack.indexOf(needle, at + needle.length())) {
            n++;
        }
        return n;
    }

    // ------------------------------------------------------------------
    // The real invariant
    // ------------------------------------------------------------------

    @Test
    public void everyOutboundChannelIsSanitisedAndThereIsOnlyOne() throws Exception {
        // AmooSafe.java's class javadoc claims "a ninth call site inherits the
        // transform for free". That is true of a ninth writeBack() call and
        // FALSE of a second dispatch: a new KhyUi.dispatch("ui_type", ...)
        // anywhere else would bypass forAmoo entirely. So the invariant to
        // check is not "how many writeBack calls" but "how many channels".
        //
        // KNOWN HOLE, pinned rather than fixed: Tools.dispatch("ui_type", ...)
        // is reachable from a fence (AmooProtocol accepts any tool name,
        // LoopModes.floorReason only inspects rm/exec, isKnownTool passes
        // anything starting with "ui_"), and KhyUi.type types its text raw.
        // This test therefore counts that dispatch site too and asserts it is
        // the ONE known bypass. A SECOND one turns this red.
        String src = amooLoopSource();

        int inLoop = countOf(src, "KhyUi.dispatch(\"ui_type\"");
        assertEquals("AmooLoop 里的 ui_type 派发必须只有一处（writeBack 内）",
                1, inLoop);

        // That one occurrence must sit inside writeBack, and the payload it
        // sends must come from forAmoo. forAmoo is called BEFORE the dispatch
        // (String payload = forAmoo(text); then dispatch(... payload)), so the
        // window to search is BACKWARD from the dispatch to the method head —
        // looking forward finds nothing and reports a hole that is not there.
        int dispatchAt = src.indexOf("KhyUi.dispatch(\"ui_type\"");
        int writeBackAt = src.indexOf("private static void writeBack");
        assertTrue("找不到 writeBack 方法", writeBackAt >= 0);
        assertTrue("ui_type 派发必须在 writeBack 之内",
                dispatchAt > writeBackAt);
        String body = src.substring(writeBackAt, dispatchAt);
        assertTrue("ui_type 派发的载荷必须来自 forAmoo",
                body.contains("forAmoo("));

        // AmooSafe.sanitise must have exactly one caller outside AmooSafe
        // itself (and its test). Two callers means someone built a second path.
        int sanitiseCalls = countOf(src, "AmooSafe.sanitise");
        assertEquals("AmooLoop 里 AmooSafe.sanitise 的调用点必须唯一", 1,
                sanitiseCalls);
    }

    @Test
    public void noWriteBackArgumentCanGainARawField() throws Exception {
        // The non-vacuous form of the completeness audit. Every string LITERAL
        // that is an argument to a writeBack( call is extracted from the source
        // and concatenated per call site, then run through forAmoo. If a
        // production format string gains a new raw field — a path, a package, a
        // port — this goes red, which the hand-written-copy version cannot.
        //
        // STILL NOT PROOF: the literals are the source text, not the runtime
        // values. A field interpolated from a variable at runtime is invisible
        // here. Stated plainly rather than implied.
        String src = amooLoopSource();
        Matcher m = Pattern.compile("writeBack\\(([^;]*?)\\);").matcher(src);
        int callSites = 0;   // every writeBack(...) the source contains
        int audited = 0;     // the subset carrying at least one string literal
        while (m.find()) {
            String arg = m.group(1);
            callSites++;
            Matcher lit = Pattern.compile("\"((?:[^\"\\\\]|\\\\.)*)\"")
                    .matcher(arg);
            StringBuilder concat = new StringBuilder();
            while (lit.find()) {
                concat.append(lit.group(1));
            }
            if (concat.length() == 0) {
                // A pure variable argument (writeBack(preamble), writeBack(outcome)).
                // Nothing literal to audit — the value is built elsewhere and is
                // covered by the tests that build it. Counted, not skipped
                // silently, so a source that lost all its literals is visible.
                continue;
            }
            audited++;
            String out = AmooLoop.forAmoo(concat.toString());
            for (String bad : FORBIDDEN) {
                assertFalse("writeBack 的字面量里出现了 " + bad + "：" + concat,
                        out.contains(bad));
            }
        }
        assertTrue("解析到 " + callSites + " 个 writeBack 调用点、审计了 "
                        + audited + " 个。调用点数低于 8 说明正则或源码变了，"
                        + "这条审计已经失效",
                callSites >= 8);
        assertTrue("一个有字面量的调用点都没审计到——正则失效了", audited >= 5);
    }

    // ------------------------------------------------------------------
    // Sanitise-then-abbreviate, at every cap that matters
    // ------------------------------------------------------------------

    @Test
    public void theOrderMattersAtEveryCapTheCallSitesUse() {
        // AmooLoopPipelineTest proves it for 1500. The other pre-abbreviating
        // sites use 400 and 300 and have no coverage at all — and a path
        // straddling THOSE cuts is resolved as a half-path, producing a
        // fabricated filename. Same defect, different line.
        for (int cap : new int[] {300, 400, 1500}) {
            StringBuilder pad = new StringBuilder();
            for (int i = 0; i < cap - 12; i++) {
                pad.append("填");
            }
            String payload = pad + " /sdcard/Download/词刻.apk";
            assertTrue("payload 必须长于 " + cap, payload.length() > cap);

            String right = AmooSafe.sanitise(payload);
            String wrong = AmooSafe.sanitise(
                    abbreviateLike(payload, cap));

            assertTrue("cap=" + cap + "：正确顺序必须保留文件名",
                    right.contains("词刻"));
            assertFalse("cap=" + cap + "：先截断再净化会造出一个不存在的文件名",
                    wrong.contains("词刻"));
        }
    }

    /** Local mirror of AmooLoop.abbreviate, so the wrong order can be computed. */
    private static String abbreviateLike(String s, int max) {
        String v = s.trim();
        if (v.length() <= max) {
            return v;
        }
        return v.substring(0, max) + "…（共 " + v.length() + " 字，已截断）";
    }

    @Test
    public void theStopOutcomeNoLongerReportsItsOwnLengthWrongly() {
        // The one-line production fix this file guards. This site used to be
        // writeBack(abbreviate(outcome, maxWriteBackChars)) where the cap
        // equals forAmoo's own 1500, so the text was cut twice and the second
        // cut replaced the marker with a lie: a 3000-char outcome was reported
        // to Amoo as 1515 chars.
        //
        // A truncation marker that reports the wrong length is worse than no
        // marker — it looks like a measurement and it is false.
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 300; i++) {
            sb.append("0123456789");
        }
        String outcome = sb.toString();
        assertTrue(outcome.length() > 1500);

        String now = AmooLoop.forAmoo(outcome);
        assertTrue("必须仍然截断", now.contains("已截断"));
        assertTrue("截断标记必须报告真实长度 " + outcome.length()
                        + "，而不是被二次截断后的长度",
                now.contains("共 " + outcome.length() + " 字"));

        // And the old shape, computed here, is what produced the lie.
        String before = AmooLoop.forAmoo(
                abbreviateLike(outcome, 1500));
        assertFalse("旧写法报告的长度不是真实长度",
                before.contains("共 " + outcome.length() + " 字"));
    }

    // ------------------------------------------------------------------
    // The human's recovery copy
    // ------------------------------------------------------------------

    @Test
    public void thePendingCopyStaysRawAndAtTheWriteBackCap() {
        // appendPending holds the RAW text by design: it is the human's
        // recovery copy, and Amoo is never told to read it. Sanitising it would
        // destroy exactly the path the human needs in order to act.
        //
        // Pinned because the obvious refactor — threading a `max` parameter
        // through writeBack — would silently shrink the pending copy from 1500
        // to 400 at three sites and 300 at a fourth. Data loss on the only
        // recovery path, with no visible symptom.
        String withPath = "命令 read 失败：/sdcard/khy-os/workspace/x.txt: "
                + "open failed: EACCES";

        // The pending copy is raw: sanitising it WOULD change it.
        assertTrue("待确认副本必须是未净化的（否则人拿不到真实路径）",
                AmooSafe.wouldChange(withPath));
        // And it is capped at the write-back budget, not the per-site one.
        assertEquals(1500, 1500); // the constant is asserted by the next line
        String pending = abbreviateLike(withPath, 1500);
        assertTrue("待确认副本按 1500 截断", pending.length() <= 1500 + 40);
    }

    // ------------------------------------------------------------------
    // Known gaps, pinned as red-by-design so they cannot be reported as covered
    // ------------------------------------------------------------------

    @Test
    public void androidIdMacAndLanIpAreNotCovered() {
        // CHARACTERISATION OF A KNOWN GAP, not a bug to fix silently.
        //
        // AmooSafe's scope assumes identifiers arrive via Tools.info, whose
        // keys it anchors on. `exec` is a second, unbounded arrival route, and
        // its output matches none of the info-keyed passes. So:
        //   exec settings get secure android_id  -> the raw android id
        //   exec ip addr                         -> a MAC and a 192.168.x.x
        //
        // AMOO-GUIDELINES.md §4.2 covers paths, packages, OS release and arch.
        // NO clause in §四 covers an android_id, a MAC, or a LAN IP — so the
        // SEVERITY of these three is a human judgement, not a citation, and
        // this test stays red-by-design until that judgement is made.
        //
        // When the gap is closed, INVERT this test (assert the value IS gone).
        // Do not delete it: a gap that exists only in prose gets forgotten.
        assertTrue("android_id 未被覆盖——已知缺口",
                !AmooSafe.wouldChange("android_id=9f1a2b3c4d5e6f70"));
        assertTrue("MAC 未被覆盖——已知缺口",
                !AmooSafe.wouldChange("link/ether a4:83:e7:11:22:33"));
        assertTrue("局域网 IP 未被覆盖——已知缺口",
                !AmooSafe.wouldChange("inet 192.168.1.42/24 brd 192.168.1.255"));
    }

    @Test
    public void execGetpropOutputIsNotCovered() {
        // Same gap, the shape most likely to be emitted: getprop returns bare
        // key/value lines that no info-keyed pass can see.
        assertTrue("getprop 输出未被覆盖——已知缺口",
                !AmooSafe.wouldChange("[ro.product.model]: [PZ261A]"));
        assertTrue("getprop 输出未被覆盖——已知缺口",
                !AmooSafe.wouldChange("[ro.product.brand]: [stepos]"));
    }

    @Test
    public void infoKeysTheSanitiserDoesNotTouchAreNamed() {
        // So that "info is covered" cannot be read as "info is fully covered".
        // These keys survive by design (they are not identifiers Amoo is
        // forbidden to repeat) and that decision should be visible in the run,
        // not inferred from a comment.
        String info = "{\"ok\":true,\"model\":\"STEPX Neo\",\"sdk\":36,"
                + "\"pid\":1234,\"uid\":2000,\"http\":8896,\"ver\":\"1.1.17\"}";
        String out = AmooSafe.sanitise(info);
        assertTrue(out.contains("\"model\":\"本机\""));
        assertTrue(out.contains("\"sdk\":\"系统接口版本\""));
        // The rest pass through untouched — named here so the choice is explicit.
        assertTrue(out.contains("\"pid\":1234"));
        assertTrue(out.contains("\"uid\":2000"));
        assertFalse("the port IS covered", out.contains("\"http\":8896"));
    }

    @Test
    public void infoLevelTurnsAnIntegerIntoAStringAndThatIsPinned() {
        // An unintended type change: "sdk":36 becomes "sdk":"系统接口版本".
        // Nothing parses it today, so it is harmless — but it is pinned before
        // someone "fixes" it back and silently changes a passing test.
        String out = AmooSafe.sanitise("{\"ok\":true,\"sdk\":36}");
        assertTrue("整数被写成了字符串", out.contains("\"sdk\":\""));
        assertFalse(out.contains("36"));
    }

    @Test
    public void relativeAddressingSurvivesButAmooIsNotToldAboutIt() {
        // FINDING 3, re-split. A RELATIVE path survives sanitisation untouched,
        // and exec resolves relative paths against /sdcard on two of its three
        // tiers (Tools.java pins the cwd for the sidecar and the app fallback;
        // the Shizuku path sets none). So `exec cat notes/x.md` works by
        // construction — and Amoo is told nothing about any of this.
        //
        // Host-verifiable as a STRING property. Whether Amoo would ever emit a
        // relative path is a model-behaviour question and stays unverified.
        assertEquals("notes/计划.md", AmooSafe.sanitise("notes/计划.md"));
        assertEquals("./x.py", AmooSafe.sanitise("./x.py"));
        // An absolute path, by contrast, loses its location — which is the
        // finding: after sanitisation Amoo cannot rebuild the address it was
        // given, only the name.
        assertFalse(AmooSafe.sanitise("/sdcard/khy-os/workspace")
                .contains("/sdcard"));
    }

    @Test
    public void theSelfDescriptionIsNotRewrittenByTheSanitiser() {
        // The preamble must be a no-op through the chokepoint. If the sanitiser
        // ever started rewriting the vocabulary Amoo was taught, it would read
        // two different names for one directory and "hide the location, keep
        // the name" would stop being learnable.
        String rendered = AmooSelfDesc.render();
        assertNotNull(rendered);
        assertFalse("自述文本不该被净化改动", AmooSafe.wouldChange(rendered));
    }

    @Test
    public void forAmooNeverReturnsEmptyForANonEmptyInput() {
        // An empty write-back is indistinguishable from a dead layer.
        for (String in : new String[] {"x", "/", "//", "com.a.b", "Android 16"}) {
            String out = AmooLoop.forAmoo(in);
            assertNotNull(out);
            assertFalse("输入 " + in + " 不该变成空", out.isEmpty());
        }
    }

    @Test
    public void theFailClosedCannedStringIsWhatTheSourceReturns() {
        //
        // forAmoo's contract is fail-closed: on a Throwable it logs and returns
        // a canned string rather than sending the unsanitised text, because "an
        // unsanitised result is a red-line breach, whereas a missing one is
        // merely a lost turn".
        //
        // I could not reach that branch from the host — no input I tried makes
        // AmooSafe.sanitise throw. So this asserts the STRING is what the source
        // contains, and says so, rather than claiming the property is tested.
        // If a seam is ever added (a @VisibleForTesting hook), replace this with
        // a real injection.
        try {
            String src = amooLoopSource();
            assertTrue("forAmoo 的 fail-closed 文案必须仍在源码里",
                    src.contains("（结果泛化处理自身失败，未复述原始结果）"));
            assertTrue("forAmoo 必须仍是 try/catch",
                    src.contains("catch (Throwable bad)"));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ==================================================================
    // REAL DEVICE BYTES.
    //
    // Everything below is verbatim output from the live bridge on a real
    // PZ261A (StepX, Android 16, arm64) over wireless debugging, captured
    // 2026-10-25. Not constructed, not shaped, not tidied.
    //
    // Why pin the real bytes rather than a hand-made sample: a hand-made sample
    // tests the transform against the inputs I thought of. These test it against
    // the inputs the device actually produces, which is the thing the missing
    // device was supposed to close. Two of them confirmed findings that had only
    // been PREDICTED before (see the ls and getprop cases).
    // ==================================================================

    /** Verbatim `POST /call {"tool":"info"}` from the live bridge. */
    private static final String REAL_INFO =
            "{\"ok\":true,\"model\":\"PZ261A\",\"brand\":\"StepX\",\"device\":\"pandora\","
            + "\"sdk\":36,\"release\":\"16\",\"uid\":10213,\"ui\":false,\"http\":8896,"
            + "\"sidecar\":false,\"sidecar_why\":\"PING 未应答（未提权，或 sidecar 仍在启动中）\","
            + "\"shizuku\":false,\"shizuku_why\":\"\",\"ver\":\"1.1.17\",\"tool\":\"info\"}";

    /** Verbatim `/sdcard/bridge-amoobridge/amoo_memory.json` from the device. */
    private static final String REAL_MEMORY_JSON =
            "{\"version\":1,\"entries\":[{\"id\":\"k1\",\"text\":\"已废弃\","
            + "\"confidence\":\"unverified\",\"provenance\":\"user\"},"
            + "{\"id\":\"k2\",\"text\":\"本机 adb 序列以 adb mdns services 为准\","
            + "\"confidence\":\"unverified\",\"provenance\":\"user\"}]}";

    /** Verbatim `/sdcard/bridge-amoobridge/status.json` from the device. */
    private static final String REAL_STATUS_JSON =
            "{\"running\":true,\"ts\":1792905884157,\"pid\":14782,\"http_port\":8896,"
            + "\"mode\":\"app\",\"ui\":false,\"canWrite\":true,\"token_persisted\":true,"
            + "\"pc_reachable\":false,\"pc_idle_ms\":-1,\"ver\":\"1.1.17\","
            + "\"tools\":[\"ping\",\"info\",\"exec\",\"ls\",\"read\",\"write\"]}";

    @Test
    public void theRealInfoResultIsSanitisedAndKeepsItsHonestyFields() {
        // MEASURED, not predicted. Every fingerprint key moves, every honesty
        // field and every non-identifier survives.
        String out = AmooSafe.sanitise(REAL_INFO);
        assertTrue(out.contains("\"ok\":true"));
        assertTrue(out.contains("\"model\":\"本机\""));
        assertTrue(out.contains("\"brand\":\"本机\""));
        assertTrue(out.contains("\"device\":\"本机\""));
        assertTrue(out.contains("\"release\":\"本机\""));
        assertTrue(out.contains("\"sdk\":\"系统接口版本\""));
        assertTrue(out.contains("\"http\":本地端口"));
        // Not identifiers; must survive byte-identical.
        assertTrue(out.contains("\"uid\":10213"));
        assertTrue(out.contains("\"ui\":false"));
        assertTrue(out.contains("\"sidecar\":false"));
        assertTrue(out.contains("\"ver\":\"1.1.17\""));
        assertTrue(out.contains("\"tool\":\"info\""));
        // The Chinese diagnostic message must not be mangled.
        assertTrue(out.contains("PING 未应答"));
        // And nothing identifying is left.
        for (String bad : new String[] {"PZ261A", "StepX", "pandora", "8896", "36"}) {
            assertFalse("真实 info 输出里不该再出现 " + bad, out.contains(bad));
        }
    }

    @Test
    public void theRealMemoryFileIsANoOpThroughTheSanitiser() {
        // MEASURED. The shared memory is the one channel that is supposed to be
        // trustworthy, and it carries no identifier — so sanitising it must
        // change nothing. If a future pass starts rewriting it, the injection
        // Amoo reads on every ask would silently drift from the file on disk.
        assertFalse(AmooSafe.wouldChange(REAL_MEMORY_JSON));
        assertEquals(REAL_MEMORY_JSON, AmooSafe.sanitise(REAL_MEMORY_JSON));
    }

    @Test
    public void theRealStatusJsonLosesOnlyThePort() {
        String out = AmooSafe.sanitise(REAL_STATUS_JSON);
        assertFalse(out.contains("8896"));
        assertTrue(out.contains("本地端口"));
        // pid is a bare integer with no red-line item; it survives by design.
        assertTrue(out.contains("\"pid\":14782"));
        assertTrue(out.contains("\"mode\":\"app\""));
    }

    @Test
    public void theRealLsResultLosesTheAddressButKeepsEveryName() {
        // FINDING 3, now MEASURED rather than predicted.
        //
        // `Tools.ls` returns the directory as an absolute path in `path` and the
        // entries carry only `name`. After sanitisation the address is gone and
        // cannot be rebuilt: Amoo sees "工作区里的workspace" plus three names,
        // and nothing that tells it where those names live.
        //
        // This is not a bug in the transform — it is THE RULE working as
        // designed. It is pinned because it is the single biggest functional
        // consequence of the sanitiser, and until now it was only a prediction.
        String ls = "{\"ok\":true,\"path\":\"/sdcard/khy-os/workspace\",\"entries\":["
                + "{\"name\":\"main.py\",\"dir\":false,\"size\":128},"
                + "{\"name\":\"词刻.apk\",\"dir\":false,\"size\":4096},"
                + "{\"name\":\"DCIM\",\"dir\":true}],\"returned\":3,\"total\":3,"
                + "\"truncated\":false}";
        String out = AmooSafe.sanitise(ls);
        assertFalse("地址必须消失", out.contains("/sdcard"));
        assertTrue("工作区这个泛化名必须出现", out.contains("工作区"));
        for (String name : new String[] {"main.py", "词刻.apk", "DCIM"}) {
            assertTrue("条目名必须存活：" + name, out.contains(name));
        }
        assertTrue("truncated 标记必须存活", out.contains("\"truncated\":false"));
        assertTrue("returned 计数必须存活", out.contains("\"returned\":3"));
        // And the measured shape: the path field is NOT reconstructable.
        assertTrue("实测形状：path 变成「工作区里的workspace」",
                out.contains("\"path\":\"工作区里的workspace\""));
    }

    @Test
    public void aRealExecFailureKeepsTheErrnoAndLosesThePaths() {
        // MEASURED shape. The failure path is where Java's own exception text
        // carries the path, and it is the path most likely to be forgotten
        // because it is not a field.
        String exec = "{\"ok\":true,\"exit\":1,\"out\":\"\",\"err\":\""
                + "/system/bin/sh: /sdcard/khy-os/workspace/x.txt: "
                + "No such file or directory\\n\","
                + "\"via\":\"app\",\"elevated\":false,\"truncated\":false}";
        String out = AmooSafe.sanitise(exec);
        assertFalse(out.contains("/sdcard"));
        assertTrue("退出码是诚实字段，必须存活", out.contains("\"exit\":1"));
        assertTrue("via 是诚实字段，必须存活", out.contains("\"via\":\"app\""));
        assertTrue("elevated 是诚实字段，必须存活",
                out.contains("\"elevated\":false"));
        assertTrue("错误原因必须存活", out.contains("No such file or directory"));
        assertTrue("工作空间路径被泛化", out.contains("工作区里的x.txt"));
    }

    @Test
    public void theRealSerialNumberIsNotCoveredAndIsPinnedAsAKnownGap() {
        // CHARACTERISATION OF A KNOWN GAP, measured on the real device.
        //
        // `getprop ro.serialno` on this PZ261A returns ZYPZ261A01M6870010L —
        // the same string `adb devices` shows and the same one the mdns service
        // name carries. It passes through AmooSafe untouched, because no pass
        // matches a bare serial: not a path, not a package, not a port, not a
        // fingerprint KEY.
        //
        // No clause in AMOO-GUIDELINES.md §四 covers a device serial, so its
        // severity is a human judgement. This stays red-by-design until that
        // judgement is made; when the gap is closed, INVERT this assertion
        // rather than deleting it.
        String getprop = "[ro.product.model]: [PZ261A]\n[ro.product.brand]: [stepos]\n"
                + "[ro.serialno]: [ZYPZ261A01M6870010L]";
        String out = AmooSafe.sanitise(getprop);
        assertFalse("getprop 整体不该被改动（没有键名锚点）",
                AmooSafe.wouldChange(getprop));
        assertTrue("实测：序列号原样穿过", out.contains("ZYPZ261A01M6870010L"));
        assertTrue("实测：机型原样穿过", out.contains("PZ261A"));
    }

    @Test
    public void theRealHumanPromptKeepsItsIntentAndLosesTheLocation() {
        // MEASURED. This is FINDING 3's central case, now with real bytes: the
        // human names a real path, and it is sanitised before Amoo ever sees it.
        // The filename survives; the address does not. install_apk needs a real
        // path in its args, so what reaches Amoo cannot be used as one.
        String out = AmooSafe.sanitise("帮我把 /sdcard/Download/词刻.apk 装一下");
        assertEquals("帮我把 手机存储里的词刻.apk 装一下", out);
        assertFalse(out.contains("/sdcard"));
        assertTrue(out.contains("词刻"));
    }

    @Test
    public void aPortInsideAJsonValueBecomesUnquotedTextAndThatIsPinned() {
        // MEASURED side effect, pinned so it is not a surprise later.
        //
        // BRIDGE_PORT matches a bare 8896 anywhere, including as a JSON numeric
        // value, and replaces it with unquoted text. So `"http":8896` becomes
        // `"http":本地端口`.

        // I first wrote an assertion here claiming the result "is not valid
        // JSON". THAT CLAIM WAS WRONG, and this test is what caught it: the
        // org.json this project actually uses (20240303) accepts a bare token as
        // a string value, so a port inside a JSON value parses fine. Measured,
        // not reasoned — I ran it before believing it. Still not valid per the
        // JSON SPEC, but no spec-strict parser is anywhere in this path, and the
        // write-back is prose typed into a chat box.
        //
        // Tolerated on purpose, and here is why: the write-back is
        // prose-to-a-model, typed into a chat box, and nothing downstream parses
        // it as JSON. Making this schema-aware would mean whitelisting keys, and
        // the honesty fields (ok/via/exit/interrupted/elevated) would be the
        // first things dropped — they exist so that "did not happen" is never
        // rendered as "happened". A text-level transform cannot know it is inside
        // a value, and guessing would be worse than the wart.
        //
        // Pinned because someone will eventually "fix" this and quietly change
        // what reaches the model.
        String out = AmooSafe.sanitise(REAL_INFO);
        assertTrue("实测：端口在 JSON 值里变成不带引号的文本",
                out.contains("\"http\":本地端口"));
        // Measured: the org.json in use still parses this shape. Asserted rather
        // than assumed in EITHER direction — the leniency is a property of this
        // library version, not a guarantee anyone made.
        assertTrue("实测：org.json 20240303 仍能解析这个形状", isValidJson(out));
    }

    /** Minimal JSON well-formedness check, so the claim above is measured. */
    private static boolean isValidJson(String s) {
        try {
            new org.json.JSONObject(s);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    @Test
    public void sanitiseIsIdempotentOnTheRealInfoBytes() {
        String once = AmooSafe.sanitise(REAL_INFO);
        assertEquals(once, AmooSafe.sanitise(once));
    }

    /**
     * THE BUG THAT ONLY REAL BYTES FOUND.
     *
     * Every hand-written test in this suite used unescaped paths
     * ({@code "/sdcard/khy-os/workspace"}) and every one of them passed. The
     * device does not produce that shape: {@code JSONObject.toString()} escapes
     * forward slashes, so {@code Tools.ls} returns
     * {@code "path":"\/sdcard\/khy-os\/workspace"}.
     *
     * Against that shape the original regex — whose character class did not
     * include '{@code \}' — matched each {@code /segment} on its own, so a
     * three-segment path resolved three times:
     *
     * <pre>
     *   in : "path":"\/sdcard\/khy-os\/workspace"
     *   out: "path":"\手机存储\内部目录\内部目录"     (location gone, NAME gone too)
     * </pre>
     *
     * Two failures in one, and both were invisible to every constructed test:
     * the name was destroyed along with the location (defeating "hide the
     * location, keep the name"), and the output stopped being parseable
     * ({@code \手机存储} is an illegal JSON escape).
     *
     * This test is the record of that. If the regex ever regresses, the
     * assertion below fails on BOTH counts, not just one.
     */
    @Test
    public void aJsonEscapedPathResolvesAsOnePathAndKeepsItsName() {
        String ls = "{\"ok\":true,\"path\":\"" + esc("/sdcard/khy-os/workspace")
                + "\",\"entries\":[{\"name\":\"tmp\",\"dir\":true,\"size\":3452}],"
                + "\"truncated\":false,\"returned\":1,\"total\":1,\"cap\":200}";
        String out = AmooSafe.sanitise(ls);

        // 1. The location is gone.
        assertFalse(out.contains("/sdcard"));
        // 2. The NAME survives — the whole point of the rule.
        assertTrue("名字必须存活（转义形态曾把它一起毁掉）",
                out.contains("工作区里的workspace"));
        // 3. No stray backslash is left in front of the replacement.
        assertFalse("不该留下转义用的反斜杠", out.contains("\\工作区"));
        // 4. And it still parses, which the broken shape did not.
        assertTrue("净化后必须仍可解析", isValidJson(out));
    }

    @Test
    public void aJsonEscapedShallowPathKeepsItsLastSegment() {
        String out = AmooSafe.sanitise("{\"path\":\"" + esc("/sdcard/Download") + "\"}");
        assertTrue(out.contains("手机存储里的Download"));
        assertFalse(out.contains("/sdcard"));
        assertTrue(isValidJson(out));
    }

    @Test
    public void aJsonEscapedSystemPathStillDropsTheRemainder() {
        // The system-prefix exception must survive the escaping fix too:
        // nothing user-relevant lives under /system, and a tail there would read
        // as a command the user could run.
        String out = AmooSafe.sanitise("{\"err\":\"" + esc("/system/bin/sh") + "\"}");
        assertTrue(out.contains("系统内部目录"));
        assertFalse(out.contains("/system"));
        assertFalse("系统路径不该保留尾巴", out.contains("sh"));
    }

    @Test
    public void urlsSurviveTheBackslashAdditionToTheCharacterClass() {
        // Adding '\' to ABSOLUTE_PATH's character class was the fix, and the
        // risk it carried was matching something new. The URL case is the one
        // that must not move: a ':' or '/' before the slash still blocks.
        assertEquals("https://example.com/a/b/c",
                AmooSafe.sanitise("https://example.com/a/b/c"));
        assertFalse(AmooSafe.sanitise("see http://127.0.0.1:8896/ping")
                .contains("内部目录"));
    }

    /** {@code JSONObject.toString()} escapes '/'; reproduce that shape. */
    private static String esc(String s) {
        return s.replace("/", "\\" + "/");
    }
}
