// khy-canary: Khy-20261101-048-KCG16QJ9
package com.khyos.khy_os_client.bridge;

import org.json.JSONObject;
import org.junit.Assert;
import org.junit.Test;

import java.util.Arrays;
import java.util.List;

/**
 * Unit tests for {@link LoopModes}.
 *
 * <p>Every case below maps to a "must handle" boundary of the LoopModes section
 * of amoo-loop-spec.md, plus the extra guards that keep the safety floor from
 * firing on innocent commands (a floor that cries wolf makes BYPASS useless).
 *
 * <p>Runs on the JVM only: the class under test is pure logic with zero IO, so
 * no device, no emulator and no Android framework is involved.
 */
public class LoopModesTest {

    // ---------------------------------------------------------------- helpers

    private static JSONObject json(String s) throws Exception {
        return new JSONObject(s);
    }

    private static LoopModes.Decision decide(LoopModes.Mode m, String tool, JSONObject args) {
        return LoopModes.decide(m, tool, args);
    }

    private static boolean floor(String tool, JSONObject args) {
        return LoopModes.safetyFloorTripped(tool, args);
    }

    private static boolean floor(String cmd) throws Exception {
        return floor("exec", json("{\"cmd\":" + quote(cmd) + "}"));
    }

    /** JSON-escape a raw command string so it can be embedded in a literal. */
    private static String quote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2);
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') {
                b.append('\\');
            }
            b.append(c);
        }
        b.append('"');
        return b.toString();
    }

    private static boolean hasChinese(String s) {
        if (s == null) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) > 0x4DFF) {
                return true;
            }
        }
        return false;
    }

    private static String repeat(String unit, int n) {
        StringBuilder b = new StringBuilder(unit.length() * n);
        for (int i = 0; i < n; i++) {
            b.append(unit);
        }
        return b.toString();
    }

    // ------------------------------------------- spec boundary: mode routing

    /** BYPASS + 普通 write -> EXECUTE, floorTripped=false. */
    @Test
    public void bypassPlainWriteIsExecuted() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.BYPASS, "write",
                json("{\"path\":\"/sdcard/g/main.py\",\"content\":\"print(1)\"}"));
        Assert.assertEquals(LoopModes.Action.EXECUTE, d.action);
        Assert.assertFalse(d.floorTripped);
    }

    /** BYPASS + rm recursive=true -> CONFIRM, floorTripped=true. */
    @Test
    public void bypassRecursiveRmNeedsConfirmation() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.BYPASS, "rm",
                json("{\"path\":\"/sdcard/g\",\"recursive\":true}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, d.action);
        Assert.assertTrue(d.floorTripped);
    }

    /**
     * rm with an EXPLICIT recursive:true must trip the floor, in every mode.
     *
     * This case has been rewritten once and the history matters, because both
     * versions were correct when written:
     *
     * v1 asserted the opposite — that an ABSENT recursive field trips the floor.
     * That was right at the time: Tools.rm was {@code optBoolean("recursive",
     * true)}, so omitting the field meant RECURSIVE, and a floor reading "absent"
     * as "not recursive" let {"path":"/sdcard/DCIM"} wipe the camera roll under
     * BYPASS. The floor has to assume the tool's real default.
     *
     * Then on 2026-10-25 the tool's default itself was flipped to false, because
     * "只传 path" is the shape people reach for by accident and it deleted whole
     * trees. With the default false, an absent field is a single-file delete that
     * fails on a directory — not destructive, and the floor must stay quiet or it
     * blocks every ordinary file removal.
     *
     * So the destructive case is now pinned EXPLICITLY. Leaving it bare would have
     * quietly converted this from a safety test into a tautology: the fixture
     * would stop being destructive while the assertion kept saying "must trip".
     */
    @Test
    public void rmWithoutRecursiveFieldStillTripsFloor() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.BYPASS, "rm",
                json("{\"path\":\"/sdcard/DCIM\",\"recursive\":true}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, d.action);
        Assert.assertTrue(d.floorTripped);
        Assert.assertTrue(LoopModes.safetyFloorTripped("rm",
                json("{\"path\":\"/sdcard/x\",\"recursive\":true}")));
        // Explicit false is safe to run.
        Assert.assertFalse(LoopModes.safetyFloorTripped("rm",
                json("{\"path\":\"/sdcard/x\",\"recursive\":false}")));
        // And absent is safe too, now that the tool defaults it to false.
        Assert.assertFalse(LoopModes.safetyFloorTripped("rm",
                json("{\"path\":\"/sdcard/x\"}")));
    }

    /** BYPASS + exec cmd="rm -rf /sdcard/x" -> CONFIRM, floorTripped=true. */
    @Test
    public void bypassRmRfCommandNeedsConfirmation() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.BYPASS, "exec",
                json("{\"cmd\":\"rm -rf /sdcard/x\"}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, d.action);
        Assert.assertTrue(d.floorTripped);
    }

    /** BYPASS + exec cmd="echo rm -rf" -> 不踩底（只是提到，不是真删）. */
    @Test
    public void mereMentionOfRmRfDoesNotTripFloor() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.BYPASS, "exec",
                json("{\"cmd\":\"echo rm -rf\"}"));
        Assert.assertEquals(LoopModes.Action.EXECUTE, d.action);
        Assert.assertFalse(d.floorTripped);
    }

    /** PLAN + 任何东西 -> DEFER，包括最普通的 write. */
    @Test
    public void planModeAlwaysDefers() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.PLAN, "write",
                json("{\"path\":\"/sdcard/g/main.py\",\"content\":\"x\"}"));
        Assert.assertEquals(LoopModes.Action.DEFER, d.action);
        Assert.assertFalse(d.floorTripped);
    }

    /** PLAN + 危险命令 -> 仍然 DEFER（安全底仍然如实上报）. */
    @Test
    public void planModeDefersEvenForDangerousCommand() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.PLAN, "rm",
                json("{\"path\":\"/sdcard/g\",\"recursive\":true}"));
        Assert.assertEquals(LoopModes.Action.DEFER, d.action);
        Assert.assertTrue(d.floorTripped);
    }

    /** EDIT + 普通 write -> CONFIRM（执行前逐条改）. */
    @Test
    public void editModeAlwaysConfirms() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.EDIT, "write",
                json("{\"path\":\"/sdcard/g/main.py\",\"content\":\"x\"}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, d.action);
        Assert.assertFalse(d.floorTripped);
    }

    /** EDIT + 危险命令 -> CONFIRM 且 floorTripped=true. */
    @Test
    public void editModeConfirmsAndReportsFloor() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.EDIT, "exec",
                json("{\"cmd\":\"rm -rf /sdcard/x\"}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, d.action);
        Assert.assertTrue(d.floorTripped);
    }

    /** DEFAULT + exec（无危险模式）-> CONFIRM（高危工具）. */
    @Test
    public void defaultModeTreatsExecAsHighRisk() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.DEFAULT, "exec",
                json("{\"cmd\":\"echo hello\"}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, d.action);
        Assert.assertFalse(d.floorTripped);
    }

    /** DEFAULT + rm（无危险模式）-> CONFIRM（高危工具），但没踩安全底. */
    /**
     * DEFAULT + rm（未声明 recursive）-> CONFIRM，但不踩安全底。
     *
     * 这段的注释改过两次，两次都是有实测依据的，别凭印象再改回去：
     *
     * 第一次：floorTripped 曾经是 false，理由是「字段缺失不算递归」——但当时
     * Tools.rm 实际是 {@code optBoolean("recursive", true)}，缺字段就是递归删，
     * 底线的假设比工具更松，等于把删目录树放过去了。于是补成踩底。
     *
     * 第二次（2026-10-25）：Tools.rm 的默认值本身改成了 **false**，因为原默认下
     * {@code {"path":"/sdcard/DCIM"}} 直接抹掉整棵树，而「只传 path」是最容易
     * 误伤的形态。默认一改，「字段缺失」就等于「不递归」，底线再按递归拒绝就是
     * 比工具更严——把一次普通的单文件删除也拦下。
     *
     * 现在两个信号分开亮：rm 仍在 HIGH_RISK_TOOLS 里，所以要 CONFIRM；
     * 但缺字段不再是破坏性形态，所以不踩底。真正要拦的形态是显式
     * {@code recursive:true}，见下面的用例。
     */
    @Test
    public void defaultModeTreatsRmAsHighRisk() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.DEFAULT, "rm",
                json("{\"path\":\"/sdcard/g/a.txt\"}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, d.action);
        Assert.assertFalse("缺 recursive 字段 = 单文件删，不该踩底", d.floorTripped);
        // 显式递归仍然踩底，这条才是底线真正要拦的。
        Assert.assertTrue(LoopModes.safetyFloorTripped("rm",
                json("{\"path\":\"/sdcard/g\",\"recursive\":true}")));
    }

    /** DEFAULT + 低危 write -> EXECUTE. */
    @Test
    public void defaultModeExecutesLowRiskTool() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.DEFAULT, "write",
                json("{\"path\":\"/sdcard/g/main.py\",\"content\":\"x\"}"));
        Assert.assertEquals(LoopModes.Action.EXECUTE, d.action);
        Assert.assertFalse(d.floorTripped);
    }

    /** args 为 null -> CONFIRM + floorTripped=true（无法判断，按最保守）. */
    @Test
    public void nullArgsFallBackToConfirmation() {
        LoopModes.Decision bypass = decide(LoopModes.Mode.BYPASS, "write", null);
        Assert.assertEquals(LoopModes.Action.CONFIRM, bypass.action);
        Assert.assertTrue(bypass.floorTripped);

        LoopModes.Decision def = decide(LoopModes.Mode.DEFAULT, "read", null);
        Assert.assertEquals(LoopModes.Action.CONFIRM, def.action);
        Assert.assertTrue(def.floorTripped);
    }

    /** defaultMode() 返回 Mode.BYPASS. */
    @Test
    public void defaultModeIsBypass() {
        Assert.assertEquals(LoopModes.Mode.BYPASS, LoopModes.defaultMode());
    }

    /** 无法识别的 mode（null）-> CONFIRM，最保守. */
    @Test
    public void nullModeIsConservative() throws Exception {
        LoopModes.Decision d = decide(null, "write",
                json("{\"path\":\"/sdcard/g/main.py\"}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, d.action);
        Assert.assertFalse(d.floorTripped);
    }

    // ------------------------------------- spec floor: 至少覆盖 these patterns

    /** `rm -fr` 与 `rm -Rf` 同样踩底. */
    @Test
    public void floorCoversForceOrRecursiveFlagVariants() throws Exception {
        Assert.assertTrue(floor("rm -fr /sdcard/x"));
        Assert.assertTrue(floor("rm -Rf /sdcard/x"));
        Assert.assertTrue(floor("rm --recursive --force /sdcard/x"));
    }

    /** 引号包裹的命令名也要看穿：`"rm" -rf` / `'RM' -RF`. */
    @Test
    public void floorSeesThroughQuotedCommandName() throws Exception {
        Assert.assertTrue(floor("\"rm\" -rf /sdcard/x"));
        Assert.assertTrue(floor("'RM' -RF /sdcard/x"));
    }

    /** 大小写不敏感. */
    @Test
    public void floorIsCaseInsensitive() throws Exception {
        Assert.assertTrue(floor("RM -RF /sdcard/x"));
        Assert.assertTrue(floor("Mkfs.Ext4 /dev/block/mmcblk0p1"));
        Assert.assertTrue(floor("PM UNINSTALL com.example.app"));
    }

    /** 绝对路径调用的命令同样认出（/system/bin/rm）. */
    @Test
    public void floorCoversAbsolutePathCommand() throws Exception {
        Assert.assertTrue(floor("/system/bin/rm -rf /data/data/com.example"));
    }

    /** `mkfs`（含 mkfs.ext4 之类变体）. */
    @Test
    public void floorCoversMkfs() throws Exception {
        Assert.assertTrue(floor("mkfs /dev/block/mmcblk0p1"));
        Assert.assertTrue(floor("mkfs.ext4 /dev/block/mmcblk0p1"));
    }

    /** `dd if=`. */
    @Test
    public void floorCoversDdIf() throws Exception {
        Assert.assertTrue(floor("dd if=/dev/block/mmcblk0 of=/sdcard/disk.img"));
        Assert.assertTrue(floor("dd if=/sdcard/img of=/dev/block/mmcblk0"));
    }

    /** `>/dev/block`. */
    @Test
    public void floorCoversDevBlockRedirect() throws Exception {
        Assert.assertTrue(floor("echo x > /dev/block/mmcblk0"));
        Assert.assertTrue(floor("echo x >>/dev/block/mmcblk0"));
    }

    /** `:(){` fork 炸弹. */
    @Test
    public void floorCoversForkBomb() throws Exception {
        Assert.assertTrue(floor(":(){ :|:& };:"));
        Assert.assertTrue(floor(": () { :|:& };:"));
    }

    /** `reboot`. */
    @Test
    public void floorCoversReboot() throws Exception {
        Assert.assertTrue(floor("reboot"));
        Assert.assertTrue(floor("reboot recovery"));
    }

    /** `setprop`. */
    @Test
    public void floorCoversSetprop() throws Exception {
        Assert.assertTrue(floor("setprop persist.sys.locale zh-CN"));
    }

    /** `pm uninstall`. */
    @Test
    public void floorCoversPmUninstall() throws Exception {
        Assert.assertTrue(floor("pm uninstall com.example.app"));
    }

    /** `chmod -R 000`. */
    @Test
    public void floorCoversChmodRecursiveZeroMode() throws Exception {
        Assert.assertTrue(floor("chmod -R 000 /sdcard/g"));
        Assert.assertTrue(floor("chmod --recursive 000 /sdcard/g"));
    }

    /** `chown -R`. */
    @Test
    public void floorCoversChownRecursive() throws Exception {
        Assert.assertTrue(floor("chown -R system:system /sdcard/g"));
    }

    /** `find ... -delete`. */
    @Test
    public void floorCoversFindDelete() throws Exception {
        Assert.assertTrue(floor("find /sdcard -name \"*.tmp\" -delete"));
    }

    /** `mv /`. */
    @Test
    public void floorCoversMovingRoot() throws Exception {
        Assert.assertTrue(floor("mv / /sdcard/root"));
        Assert.assertTrue(floor("mv /sdcard/g /"));
    }

    /** `ln -s /`. */
    @Test
    public void floorCoversRootSymlink() throws Exception {
        Assert.assertTrue(floor("ln -s / /sdcard/root-link"));
    }

    /** `sh -c 'rm -rf /'` 之类解释器包装（看穿引号的延伸）. */
    @Test
    public void floorCoversShellCWrappedCommand() throws Exception {
        Assert.assertTrue(floor("sh -c 'rm -rf /sdcard/g'"));
        Assert.assertTrue(floor("bash -c \"mkfs /dev/block/mmcblk0\""));
    }

    /** `FOO=bar rm -rf /` 前缀环境变量. */
    @Test
    public void floorCoversEnvPrefixedCommand() throws Exception {
        Assert.assertTrue(floor("FOO=bar rm -rf /sdcard/g"));
    }

    /** `echo $(rm -rf /)` / 反引号：子命令真会被执行. */
    @Test
    public void floorCoversCommandSubstitution() throws Exception {
        Assert.assertTrue(floor("echo $(rm -rf /sdcard/g)"));
        Assert.assertTrue(floor("echo `rm -rf /sdcard/g`"));
    }

    /** `a && rm -rf /`：后一段也要看. */
    @Test
    public void floorCoversChainedCommands() throws Exception {
        Assert.assertTrue(floor("cd /sdcard && rm -rf g"));
        Assert.assertTrue(floor("cd /sdcard; rm -rf g"));
        Assert.assertTrue(floor("cd /sdcard | rm -rf g"));
    }

    // ----------------------------------- spec floor: 误报防护（不踩底的情况）

    /** `echo rm -rf` 首 token 是 echo，不踩底——这是 bypass 可用的前提. */
    @Test
    public void mentionsInsideAnotherCommandDoNotTrip() throws Exception {
        List<String> harmless = Arrays.asList(
                "echo rm -rf",
                "echo reboot",
                "echo mkfs.ext4 /dev/block/mmcblk0",
                "echo dd if=/dev/block/mmcblk0",
                "echo pm uninstall com.example",
                "echo setprop a b",
                "echo chown -R system /sdcard",
                "echo find /sdcard -delete",
                "echo mv /",
                "echo ln -s /",
                "printf 'rm -rf is dangerous'");
        for (int i = 0; i < harmless.size(); i++) {
            Assert.assertFalse("must not trip: " + harmless.get(i),
                    floor(harmless.get(i)));
        }
    }

    /** 日常无害命令不踩底. */
    @Test
    public void harmlessCommandsDoNotTrip() throws Exception {
        List<String> harmless = Arrays.asList(
                "ls -la /sdcard",
                "cat /sdcard/g/main.py",
                "grep -r foo /sdcard/g",
                "echo hello > /sdcard/g/out.txt",
                "echo hi > /dev/null 2>&1",
                "rm /sdcard/g/a.txt",
                "rm -v /sdcard/g/a.txt",
                "mv /sdcard/g/a /sdcard/g/b",
                "cp -r /sdcard/g /sdcard/h",
                "ln -s /sdcard/g/a /sdcard/g/b",
                "find /sdcard -name \"*.py\"",
                "chmod 000 /sdcard/g/a.txt",
                "chmod -R 0755 /sdcard/g",
                "dd if=/sdcard/img of=/sdcard/copy.img",
                "mkdir -p /sdcard/g/sub",
                "cat /proc/cpuinfo",
                "top -n 1");
        for (int i = 0; i < harmless.size(); i++) {
            Assert.assertFalse("must not trip: " + harmless.get(i),
                    floor(harmless.get(i)));
        }
    }

    /** rm 的 recursive 字段为 false -> 不踩底. */
    @Test
    public void recursiveFalseDoesNotTrip() throws Exception {
        Assert.assertFalse(floor("rm", json("{\"path\":\"/sdcard/g/a.txt\",\"recursive\":false}")));
        Assert.assertFalse(floor("rm", json("{\"path\":\"/sdcard/g/a.txt\",\"recursive\":\"false\"}")));
    }

    /**
     * recursive 字段缺失 -> 不踩底。
     *
     * 名字和断言都改过。原名是 {@code recursiveAbsentTripsFloorBecauseToolsDefaultsItTrue}，
     * 依据是 Tools.rm 当年默认 recursive=true，缺字段就是递归删。
     *
     * 2026-10-25 那个默认值本身被改成了 false（原默认下
     * {@code {"path":"/sdcard/DCIM"}} 直接抹掉整棵树），于是「字段缺失」变成
     * 「不递归」，底线再踩就是比工具更严。
     *
     * 保留这条用例而不是删掉：它钉住的是一个容易反复的边界——工具默认值和底线
     * 假设必须一致。哪天 Tools.rm 的默认又被改回 true，这条会立刻红，提醒你底线
     * 那边也要跟着改。
     */
    @Test
    public void recursiveAbsentDoesNotTripFloorBecauseToolsDefaultsItFalse()
            throws Exception {
        Assert.assertFalse(floor("rm", json("{\"path\":\"/sdcard/g/a.txt\"}")));
        Assert.assertFalse(floor("rm", json("{\"path\":\"/sdcard/DCIM\"}")));
        // 显式 true 仍然踩底——底线没有变松，只是跟着工具的真实默认走了。
        Assert.assertTrue(floor("rm", json("{\"path\":\"/sdcard/g\",\"recursive\":true}")));
    }

    /** recursive 字段类型/取值无法解析 -> 按踩底处理（保守）. */
    @Test
    public void unparsableRecursiveFieldTrips() throws Exception {
        Assert.assertTrue(floor("rm", json("{\"path\":\"/sdcard/g\",\"recursive\":\"yes\"}")));
        Assert.assertTrue(floor("rm", json("{\"path\":\"/sdcard/g\",\"recursive\":1}")));
        Assert.assertTrue(floor("rm", json("{\"path\":\"/sdcard/g\",\"recursive\":{}}")));
    }

    /** exec 缺 cmd 字段 -> 解析不了，按踩底. */
    @Test
    public void missingCmdTripsFloor() throws Exception {
        Assert.assertTrue(floor("exec", json("{\"timeout\":20}")));
    }

    /** exec 的 cmd 字段类型不对 -> 按踩底. */
    @Test
    public void nonStringCmdTripsFloor() throws Exception {
        Assert.assertTrue(floor("exec", json("{\"cmd\":{\"a\":1}}")));
        Assert.assertTrue(floor("exec", json("{\"cmd\":123}")));
    }

    /**
     * 包装命令不能藏住真命令。
     *
     * 首 token 分词法只看 token[0]，于是 `env rm -rf /data` 的首 token 是 env、
     * 直接放行——而 mksh 会真的递归删 /data。同类还有 nice / nohup / setsid /
     * stdbuf / ionice / timeout / busybox。现在改成扫全部 token。
     */
    @Test
    public void commandWrappersCannotHideTheRealCommand() throws Exception {
        String[] wrapped = {
            "env rm -rf /data",
            "env -u FOO rm -rf /sdcard/x",
            "nice -n 19 rm -rf /sdcard/x",
            "nohup rm -rf /sdcard/x",
            "setsid rm -rf /sdcard/x",
            "stdbuf -o0 rm -rf /sdcard/x",
            "ionice -c3 rm -rf /sdcard/x",
            "timeout 5 rm -rf /sdcard/x",
            "busybox rm -rf /sdcard/x",
            "command rm -rf /sdcard/x",
            "FOO=bar rm -rf /sdcard/x",
        };
        for (String cmd : wrapped) {
            Assert.assertTrue("应当踩底却放行了: " + cmd, floor("exec", json("{\"cmd\":" + q(cmd) + "}")));
        }
    }

    /** 反斜杠转义不能拆分 token：`r\m -rf` 在 mksh 里就是 `rm -rf`。 */
    @Test
    public void backslashEscapedCommandNameStillTrips() throws Exception {
        Assert.assertTrue(floor("exec", json("{\"cmd\":" + q("r\\m -rf /sdcard/x") + "}")));
        Assert.assertTrue(floor("exec", json("{\"cmd\":" + q("/bin/r\\m -rf /sdcard/x") + "}")));
    }

    /** `sh -c` 不出现在首位时也要解包（env sh -c '...'）。 */
    @Test
    public void shellUnwrapWorksWhenShellIsNotFirst() throws Exception {
        Assert.assertTrue(floor("exec", json("{\"cmd\":" + q("env sh -c 'rm -rf /sdcard/x'") + "}")));
        Assert.assertTrue(floor("exec", json("{\"cmd\":" + q("nice sh -c 'dd if=/dev/block/mmcblk0 of=/sdcard/x'") + "}")));
    }

    /** 只打印参数的命令仍不踩底——否则 bypass 会废掉。 */
    @Test
    public void printingCommandsStillDoNotTrip() throws Exception {
        String[] safe = {
            "echo rm -rf /sdcard/x",
            "printf 'use rm -rf carefully'",
            "cat note.txt",
            "man rm",
            "which rm",
            "grep 'rm -rf' notes.md",
            "ls -la /sdcard",
            "rm /sdcard/g/a.txt",
            "rm -v /sdcard/g/a.txt",
            "dd if=/sdcard/a of=/sdcard/b",
            "echo done > /dev/null",
        };
        for (String cmd : safe) {
            Assert.assertFalse("误报了: " + cmd, floor("exec", json("{\"cmd\":" + q(cmd) + "}")));
        }
    }

    /** 测试辅助：把字符串安全地包成 JSON 字符串字面量。 */
    private static String q(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') {
                sb.append('\\').append(c);
            } else if (c == '\n') {
                sb.append("\\n");
            } else {
                sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /** exec 的 cmd 是空串/纯空白 -> 没什么可跑，不踩底. */
    @Test
    public void emptyCmdDoesNotTrip() throws Exception {
        Assert.assertFalse(floor("exec", json("{\"cmd\":\"\"}")));
        Assert.assertFalse(floor("exec", json("{\"cmd\":\"   \"}")));
    }

    /** 工具名缺失/为空 -> 无法判断，按踩底. */
    @Test
    public void missingToolNameTripsFloor() throws Exception {
        Assert.assertTrue(floor(null, json("{\"path\":\"/sdcard/g/a.txt\"}")));
        Assert.assertTrue(floor("", json("{\"path\":\"/sdcard/g/a.txt\"}")));
        Assert.assertTrue(floor("   ", json("{\"path\":\"/sdcard/g/a.txt\"}")));
    }

    /** 未登记的工具在 DEFAULT 下无法分级 -> CONFIRM（最保守）. */
    @Test
    public void unknownToolInDefaultModeNeedsConfirmation() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.DEFAULT, "frobnicate",
                json("{\"path\":\"/sdcard/g/a.txt\"}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, d.action);
        Assert.assertFalse(d.floorTripped);
    }

    /**
     * 未登记的工具在 BYPASS 下没有踩底 -&gt; 直接执行（规格表格如此）。
     *
     * <p>2026-11-03（P0-2）订正：这条断言只对**泛化的未知工具**成立，不是说
     * 「凡是没被分级的东西，BYPASS 都放行」。两处例外，各有各的理由：
     *
     * <ol>
     *   <li>不可逆工具（{@code secret_*} / {@code adou_signin} / {@code amoo_*}）
     *       踩的是**安全底**，不是分级：BYPASS 也关不掉它，见
     *       {@link #irreversibleToolsTripTheSafetyFloorInEveryMode()}。</li>
     *   <li>{@code ui_type} 踩的也是安全底（Amoo 红线），与本条无关。</li>
     * </ol>
     *
     * <p>为什么这条曾经写错过：{@code KNOWN_TOOLS} 的 docblock 写着「表外一律
     * 「无法分级」-&gt; CONFIRM」，而 {@code LoopModes.defaultMode()} 是
     * {@code BYPASS}——那句话只在 DEFAULT 档成立。默认档下，泛化未知工具是
     * **直接执行**的，这条断言就是钉这个事实。
     */
    @Test
    public void unknownToolInBypassIsExecuted() throws Exception {
        LoopModes.Decision d = decide(LoopModes.Mode.BYPASS, "frobnicate",
                json("{\"path\":\"/sdcard/g/a.txt\"}"));
        Assert.assertEquals(LoopModes.Action.EXECUTE, d.action);
        Assert.assertFalse("泛化未知工具不踩安全底", d.floorTripped);
    }

    /** 工具别名折叠（Tools.dispatch 的同名映射）. */
    @Test
    public void toolAliasesAreFolded() throws Exception {
        Assert.assertTrue(floor("shell_exec", json("{\"cmd\":\"rm -rf /sdcard/g\"}")));
        Assert.assertTrue(floor("SHELL_EXEC", json("{\"cmd\":\"rm -rf /sdcard/g\"}")));
        LoopModes.Decision d = decide(LoopModes.Mode.DEFAULT, "shell_exec",
                json("{\"cmd\":\"echo hi\"}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, d.action);
    }

    /** rm 的 recursive 用字符串 "true" 表达也要认. */
    @Test
    public void recursiveAsStringTrueTrips() throws Exception {
        Assert.assertTrue(floor("rm", json("{\"path\":\"/sdcard/g\",\"recursive\":\"true\"}")));
        Assert.assertTrue(floor("rm", json("{\"path\":\"/sdcard/g\",\"recursive\":\"TRUE\"}")));
    }

    // ------------------------------------------------ spec contract: robustness

    /** 安全底与 mode 无关：同一条命令在四种模式下 floorTripped 恒等. */
    @Test
    public void floorIsIndependentOfMode() throws Exception {
        JSONObject args = json("{\"cmd\":\"rm -rf /sdcard/g\"}");
        for (int i = 0; i < LoopModes.Mode.values().length; i++) {
            LoopModes.Decision d = decide(LoopModes.Mode.values()[i], "exec", args);
            Assert.assertTrue(d.floorTripped);
            Assert.assertNotNull(d.reason);
        }
        JSONObject safe = json("{\"path\":\"/sdcard/g/a.txt\"}");
        for (int i = 0; i < LoopModes.Mode.values().length; i++) {
            Assert.assertFalse(decide(LoopModes.Mode.values()[i], "write", safe).floorTripped);
        }
    }

    /** 踩底时 reason 必须说明原因，且 reason 恒非空. */
    @Test
    public void reasonIsAlwaysPopulatedAndChinese() throws Exception {
        LoopModes.Decision tripped = decide(LoopModes.Mode.BYPASS, "rm",
                json("{\"path\":\"/sdcard/g\",\"recursive\":true}"));
        Assert.assertNotNull(tripped.reason);
        Assert.assertTrue(hasChinese(tripped.reason));
        Assert.assertTrue(tripped.reason.indexOf("递归") >= 0);

        LoopModes.Decision ok = decide(LoopModes.Mode.BYPASS, "write",
                json("{\"path\":\"/sdcard/g/a.txt\"}"));
        Assert.assertNotNull(ok.reason);
        Assert.assertTrue(hasChinese(ok.reason));
    }

    /** 喂垃圾/null 输入不抛异常（规格：永不抛异常）. */
    @Test
    public void garbageAndNullInputNeverThrows() throws Exception {
        List<String> tools = Arrays.asList(
                null, "", "   ", "write", "WRITE", "Write", "rm", "exec", "shell_exec",
                "ui_type", "ui_", "shot_b64", "frobnicate", "\t", "\n",
                repeat("x", 500), repeat("rm ", 200), "rm\t", " rm ");
        List<JSONObject> argss = Arrays.asList(
                null,
                new JSONObject(),
                json("{}"),
                json("{\"recursive\":null}"),
                json("{\"recursive\":[]}"),
                json("{\"recursive\":\"\"}"),
                json("{\"cmd\":null}"),
                json("{\"cmd\":\"\"}"),
                json("{\"cmd\":\"   \"}"),
                json("{\"cmd\":\";;;&&||\\n\\t\"}"),
                json("{\"cmd\":\">>> /dev/\"}"),
                json("{\"cmd\":\"::::::::\"}"),
                json("{\"cmd\":\"sh -c sh -c sh -c sh -c sh -c sh -c\"}"),
                json("{\"cmd\":" + quote(repeat("rm -rf / ", 50)) + "}"),
                json("{\"cmd\":" + quote(repeat("a ", 2000)) + "}"),
                json("{\"path\":null,\"content\":null}"));

        for (int m = 0; m <= LoopModes.Mode.values().length; m++) {
            LoopModes.Mode mode = (m == LoopModes.Mode.values().length)
                    ? null : LoopModes.Mode.values()[m];
            for (int t = 0; t < tools.size(); t++) {
                for (int a = 0; a < argss.size(); a++) {
                    LoopModes.Decision d = decide(mode, tools.get(t), argss.get(a));
                    Assert.assertNotNull("decision must never be null", d);
                    Assert.assertNotNull(d.action);
                    Assert.assertNotNull(d.reason);
                    boolean f = floor(tools.get(t), argss.get(a));
                    Assert.assertEquals(f, d.floorTripped);
                }
            }
        }
    }

    /** 极长/病态命令不抛、不挂（确定性与有界性）. */
    @Test
    public void pathologicalCommandsStayBounded() throws Exception {
        Assert.assertFalse(floor("echo " + repeat("a", 5000)));
        Assert.assertTrue(floor(repeat("rm -rf /sdcard/x; ", 100)));
        Assert.assertTrue(floor("sh -c " + quote("sh -c " + quote("rm -rf /sdcard/g"))));
    }

    // --------------------------------- 清单镜像：KNOWN_TOOLS 与 Tools.NAMES

    /**
     * {@code KNOWN_TOOLS} 与 {@code Tools.NAMES} 的集合镜像。
     *
     * <p>为什么要这条：手机侧有两份工具清单——{@code Tools.NAMES}（48 项，桥真的
     * 能答的工具）与 {@code LoopModes.KNOWN_TOOLS}（能被风险分级的工具）。两份靠
     * 人手抄，改一边另一边不知道，于是 {@code Tools.NAMES} 里多出来的那 12 项在
     * 循环里全都「无法识别」→ 在 {@code AmooProtocol.extractCommands} 的解析期被
     * <b>静默丢掉</b>：命令无声消失，用户看到的是「什么都没发生」。最硬的一条是
     * {@code amoo_stop}——它是唯一能清掉 {@code askRunning} 单飞锁的即时中止入口。
     *
     * <p>比法：<b>按集合比，不按行序</b>。两份清单的书写顺序本来就不同
     * （{@code Tools.NAMES} 按能力分组，{@code KNOWN_TOOLS} 按可分级与否分组），
     * 按行序比会天天假红。
     *
     * <p>为什么用反射读私有字段：{@code KNOWN_TOOLS} 是 {@code LoopModes} 的
     * 私有实现细节（该类刻意不依赖 IO 层），测试是唯一该看它的地方——改生产
     * 代码只为让测试好读，是把测试口径搞反了。
     *
     * <p>待补名单（PENDING）现在是<b>空的</b>：P0-2 已把这 12 项补进
     * {@code KNOWN_TOOLS}，差集归零，本用例即成为严格的集合相等断言。名单保留在
     * 这里而不是删掉，是为了下次再加工具时红字能指名要补哪一项。
     */
    @Test
    public void knownToolsMirrorToolsNamesAsSets() throws Exception {
        List<String> known = readKnownTools();
        List<String> names = Arrays.asList(Tools.NAMES);

        Assert.assertEquals("Tools.NAMES 里有重名工具", names.size(),
                new java.util.HashSet<String>(names).size());
        Assert.assertEquals("KNOWN_TOOLS 里有重名工具", known.size(),
                new java.util.HashSet<String>(known).size());

        java.util.Set<String> knownSet = new java.util.LinkedHashSet<String>(known);
        java.util.Set<String> nameSet = new java.util.LinkedHashSet<String>(names);
        for (String tool : knownSet) {
            Assert.assertTrue("KNOWN_TOOLS 知道一个 Tools.NAMES 里没有的工具：" + tool,
                    nameSet.contains(tool));
        }

        java.util.Set<String> pending = new java.util.LinkedHashSet<String>(nameSet);
        pending.removeAll(knownSet);
        Assert.assertEquals("Tools.NAMES 与 KNOWN_TOOLS 的差集与待补名单不符（补齐后请清空待补名单）",
                PENDING_NOT_YET_CLASSIFIED, pending);
    }

    /** 反射读 LoopModes 的私有 KNOWN_TOOLS（生产代码不因测试而改形）。 */
    @SuppressWarnings("unchecked")
    private static List<String> readKnownTools() throws Exception {
        java.lang.reflect.Field field = LoopModes.class.getDeclaredField("KNOWN_TOOLS");
        field.setAccessible(true);
        return (List<String>) field.get(null);
    }

    /**
     * Tools.NAMES 里尚未进入 KNOWN_TOOLS 的工具（按集合比，与行序无关）。
     * P0-2 补齐后这份名单归零，本用例即成为严格的集合相等断言。
     */
    private static final java.util.Set<String> PENDING_NOT_YET_CLASSIFIED =
            new java.util.HashSet<String>();

    // ------------------------------- P0-2：不再静默吞命令 + 安全底覆盖不可逆项

    /**
     * 那 12 项在循环里不再被静默丢掉。
     *
     * <p>丢在哪一步：{@code AmooProtocol.extractCommands} 的解析期过滤
     * （{@code LoopModes.isKnownTool}）。命令在进决策层之前就没了，所以既没有
     * 报错也没有拒绝——用户看到的是「什么都没发生」。这条用例把「不再消失」钉住。
     */
    @Test
    public void theTwelveFormerlySwallowedToolsSurviveParsing() {
        String[] twelve = {
                "adou_signin", "amoo_ask", "amoo_result", "amoo_memory", "amoo_stop",
                "zip", "unzip", "secret_code", "secret_put", "secret_list", "secret_del",
                "tools",
        };
        for (int i = 0; i < twelve.length; i++) {
            String tool = twelve[i];
            List<AmooProtocol.Fence> cmds = AmooProtocol.extractCommands(
                    "{\"tool\":\"" + tool + "\",\"args\":{}}");
            Assert.assertEquals("工具 " + tool + " 在循环里被静默丢弃了", 1, cmds.size());
            Assert.assertTrue("命令原文被改写了：" + tool,
                    cmds.get(0).payload.contains("\"tool\":\"" + tool + "\""));
        }
    }

    /** 真的不认识的工具仍然不是命令（过滤不能变成「什么都要」）。 */
    @Test
    public void genuinelyUnknownToolsAreStillNotCommands() {
        Assert.assertEquals(0, AmooProtocol.extractCommands(
                "{\"tool\":\"not_a_real_tool\",\"args\":{}}").size());
    }

    /**
     * 不可逆工具在**每一种**模式下都踩安全底。
     *
     * <p>为什么 BYPASS 也要拦：BYPASS 是默认档（{@code defaultMode()}），而
     * 「不踩底就一律 EXECUTE」正是 BYPASS 的行为。不可逆的东西若只在非默认档被
     * 拦，等于「不可逆」三个字在默认档里不成立。安全底是模式无关的否决权。
     *
     * <p>为什么计划档是 DEFER 而不是 CONFIRM：安全底与模式路由是**两件独立的事**
     * ——底决定「这条命令要不要人点头」，模式决定「人点头之前怎么走」。计划档的
     * 语义是「一条不执行，命令清单交给人审」，所以它给 DEFER；但底线照样如实上报
     * （{@code floorTripped=true}），不会被模式悄悄抹掉。四档里唯一可能出现
     * EXECUTE 的是「没踩底 + 旁路档」，而不可逆项永远踩底。
     */
    @Test
    public void irreversibleToolsTripTheSafetyFloorInEveryMode() throws Exception {
        String[] irreversible = {
                "secret_code", "secret_put", "secret_list", "secret_del",
                "adou_signin",
                "amoo_ask", "amoo_result", "amoo_memory", "amoo_stop",
        };
        for (int i = 0; i < irreversible.length; i++) {
            String tool = irreversible[i];
            for (int m = 0; m < LoopModes.Mode.values().length; m++) {
                LoopModes.Mode mode = LoopModes.Mode.values()[m];
                LoopModes.Decision d = decide(mode, tool, json("{}"));
                Assert.assertTrue(tool + " 在 " + mode + " 档的 floorTripped 不为 true",
                        d.floorTripped);
                Assert.assertNotNull(tool + " 的拒绝理由不能为空", d.reason);
                Assert.assertTrue(tool + " 的拒绝理由必须是中文", hasChinese(d.reason));
                if (mode == LoopModes.Mode.PLAN) {
                    Assert.assertEquals(tool + " 在计划档应当是 DEFER（一条不执行）",
                            LoopModes.Action.DEFER, d.action);
                } else {
                    Assert.assertEquals(tool + " 在 " + mode + " 档没有被安全底拦住",
                            LoopModes.Action.CONFIRM, d.action);
                }
            }
        }
    }

    /**
     * BYPASS 下不可逆项是 CONFIRM，泛化未知工具仍是 EXECUTE。
     *
     * <p>两条并排钉：安全底是「按工具名否决」，不是「把所有不认识的东西都拦下」。
     * 后者会让 BYPASS 变得没法用——而模式表里 BYPASS 的定义恰恰是不问人。
     */
    @Test
    public void bypassRefusesIrreversibleButRunsGenericUnknown() throws Exception {
        LoopModes.Decision secret = decide(LoopModes.Mode.BYPASS, "secret_del",
                json("{\"path\":\"/sdcard/x\"}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, secret.action);
        Assert.assertTrue(secret.floorTripped);

        LoopModes.Decision signin = decide(LoopModes.Mode.BYPASS, "adou_signin",
                json("{\"op\":\"run\"}"));
        Assert.assertEquals(LoopModes.Action.CONFIRM, signin.action);
        Assert.assertTrue(signin.floorTripped);

        LoopModes.Decision unknown = decide(LoopModes.Mode.BYPASS, "frobnicate",
                json("{\"path\":\"/sdcard/x\"}"));
        Assert.assertEquals(LoopModes.Action.EXECUTE, unknown.action);
        Assert.assertFalse(unknown.floorTripped);
    }

    /**
     * {@code zip} / {@code unzip} 在 BYPASS 下直接执行——**这是当前的取舍，不是终局**。
     *
     * <p>取舍本身：它们的破坏面是「覆盖目标目录里的同名文件」（可逆，重新生成
     * 即可），而 {@code unzip} 自带 Zip Slip 防护（canonical 路径包含检查）。把
     * 不可逆限定为 {@code secret_*} / {@code adou_signin} / {@code amoo_*} 是可辩护的，
     * 但**是否也该把 zip/unzip 纳入安全底要由人裁决**——已写进
     * {@code [DESIGN-ARCH-193]} Q5 与本轮的 openQuestions。
     *
     * <p>这条用例的作用是「把当前取舍钉住」，让将来改它的人必须同时改这里、
     * 改 Q5 的留痕、并且说明理由——而不是无声地改掉行为。
     */
    @Test
    public void zipAndUnzipRunInBypassUnderTheCurrentTradeoff() throws Exception {
        LoopModes.Decision zip = decide(LoopModes.Mode.BYPASS, "zip",
                json("{\"src\":\"/sdcard/a\",\"dest\":\"/sdcard/b.zip\"}"));
        Assert.assertEquals(LoopModes.Action.EXECUTE, zip.action);
        Assert.assertFalse(zip.floorTripped);

        LoopModes.Decision unzip = decide(LoopModes.Mode.BYPASS, "unzip",
                json("{\"src\":\"/sdcard/b.zip\",\"dest\":\"/sdcard/out\"}"));
        Assert.assertEquals(LoopModes.Action.EXECUTE, unzip.action);
        Assert.assertFalse(unzip.floorTripped);
    }

    /**
     * {@code amoo_ask} 的拒绝理由必须说清「确认解决不了」。
     *
     * <p>这条路径不是一道待确认的门：环内再问一次 Amoo 必然撞单飞锁
     * （{@code AmooLoop.ask} 第一行就是 {@code if (askRunning) return null;}）。
     * 理由里若出现「确认后继续」，人就会一直等一个永远不会到来的确认。
     */
    @Test
    public void amooAskReasonSaysConfirmationCannotFixIt() {
        String reason = LoopModes.amooAskLoopReason();
        Assert.assertNotNull(reason);
        Assert.assertTrue(hasChinese(reason));
        Assert.assertTrue("理由必须提到单飞锁", reason.contains("单飞锁"));
        Assert.assertTrue("理由必须说清确认解决不了", reason.contains("确认也解决不了"));
    }
}
