// khy-canary: Khy-20261101-047-NG174R6S
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * 批量读取形状的测试。
 *
 * 判据放在安全底里，因为安全底是"任何模式都关不掉的否决权，BYPASS 也不例外"，
 * 而 BYPASS 正是这条唯一的缺口：它不触发安全底就一律 EXECUTE。
 *
 * 这个测试集有两个同等重要的半边：
 *   - **该拦的必须拦**（漏一个 = 一条导出通道）
 *   - **不该拦的必须放行**（误伤一个正常命令 = BYPASS 没法用，
 *     把人推回手工确认一切，那比漏拦更常见地发生）
 * LoopModes 的类注释把这件事说得很清楚：误伤和漏判一样要紧。
 */
public class LoopModesBulkReadTest {

    private static LoopModes.Decision decide(String cmd) {
        JSONObject args = new JSONObject();
        try {
            args.put("cmd", cmd);
        } catch (org.json.JSONException e) {
            throw new IllegalStateException(e);
        }
        return LoopModes.decide(LoopModes.Mode.BYPASS, "exec", args);
    }

    private static String reason(String cmd) {
        LoopModes.Decision d = decide(cmd);
        return d.action == LoopModes.Action.CONFIRM ? d.reason : null;
    }

    // ---------- 该拦的 ----------

    @Test
    public void catWithGlobIsBlocked() {
        assertNotNull("cat 配通配符必须拦", reason("cat /sdcard/DCIM/*"));
    }

    @Test
    public void catWithQuestionMarkGlobIsBlocked() {
        assertNotNull(reason("cat /sdcard/DCIM/IMG_?.jpg"));
    }

    @Test
    public void base64WithGlobIsBlocked() {
        // base64 + 通配符是最经典的导出形状：编码后直接进回复。
        assertNotNull(reason("base64 /sdcard/DCIM/*"));
    }

    @Test
    public void tarToStdoutIsBlocked() {
        // 整树归档再从标准输出读走，没有第二种解释。
        assertNotNull(reason("tar czf - /sdcard/DCIM"));
    }

    @Test
    public void tarLongFileStdoutIsBlocked() {
        assertNotNull(reason("tar cz --file=- /sdcard/DCIM"));
    }

    @Test
    public void findOnBroadRootWithoutFilterIsBlocked() {
        assertNotNull(reason("find /sdcard"));
    }

    @Test
    public void findOnStorageWithoutFilterIsBlocked() {
        assertNotNull(reason("find /storage/emulated/0"));
    }

    @Test
    public void filterlessFindIsBlockedEvenOnANarrowDir() {
        // 判据故意**不**看路径。原来那版要求"停在宽根"，可宽根本身没法定义：
        // /sdcard 下面每一层都可能是几千张照片，也都可能是一个已知的小目录。
        // 于是那条规则要么全拦要么全放——工作空间里的 find 会被误判成宽根。
        //
        // 换成只看有没有限定：一个连限定都没有的 find，语义就是"全部列给我"，
        // 那就是枚举，跟路径宽窄无关。这条测试就是把那次改动钉住。
        assertNotNull(reason("find /sdcard/khy-os/workspace"));
    }

    @Test
    public void floorTrippedFlagIsSet() {
        // 必须是安全底命中，不是普通高危确认——两者的处置不同。
        LoopModes.Decision d = decide("cat /sdcard/DCIM/*");
        assertTrue("批量读取必须走安全底", d.floorTripped);
        assertEquals(LoopModes.Action.CONFIRM, d.action);
    }

    @Test
    public void blockedInEveryModeIncludingBypass() {
        // 这条是重点：BYPASS 下不触发安全底就一律 EXECUTE，
        // 所以形状必须在安全底里，而不是模式层。
        //
        // 不变量是"任何模式下都拿不到 EXECUTE"，不是"任何模式都返回 CONFIRM"：
        // PLAN 模式的设计就是一条不执行、整份清单交人审，所以它返回 DEFER。
        // 把 PLAN 也断言成 CONFIRM 等于要求 PLAN 改变语义——那是测试写错了，
        // 不是规则错了。真正要守的是：BYPASS（唯一缺口）确实被挡住。
        for (LoopModes.Mode m : LoopModes.Mode.values()) {
            JSONObject args = new JSONObject();
            try {
                args.put("cmd", "cat /sdcard/DCIM/*");
            } catch (org.json.JSONException e) {
                throw new IllegalStateException(e);
            }
            LoopModes.Decision d = LoopModes.decide(m, "exec", args);
            assertTrue("模式 " + m + " 下也必须拦，不得放行",
                    d.action != LoopModes.Action.EXECUTE);
            assertTrue("模式 " + m + " 下安全底必须被触发", d.floorTripped);
        }
        // 三个会执行的模式都要走到人工确认这一步。
        for (LoopModes.Mode m : new LoopModes.Mode[] {
                LoopModes.Mode.DEFAULT, LoopModes.Mode.EDIT, LoopModes.Mode.BYPASS }) {
            JSONObject args = new JSONObject();
            try {
                args.put("cmd", "cat /sdcard/DCIM/*");
            } catch (org.json.JSONException e) {
                throw new IllegalStateException(e);
            }
            assertEquals("模式 " + m + " 必须走到人工确认",
                    LoopModes.Action.CONFIRM,
                    LoopModes.decide(m, "exec", args).action);
        }
    }

    // ---------- 不该拦的（误伤比漏判更常发生）----------

    @Test
    public void singleFileCatIsAllowed() {
        assertNull("读单个文件是最常见的正常用法", reason("cat /sdcard/a.txt"));
    }

    @Test
    public void catWithFlagsButSingleFileIsAllowed() {
        assertNull(reason("cat -n /sdcard/a.txt"));
    }

    @Test
    public void tarToAFileIsAllowed() {
        // `tar czf /sdcard/x.tgz /path` 是普通备份，只有写到 stdout 才是导出。
        assertNull(reason("tar czf /sdcard/backup.tgz /sdcard/khy-os/workspace"));
    }

    @Test
    public void findWithNameFilterIsAllowed() {
        // 加 -name 就缩小了范围，是正常查找。
        assertNull(reason("find /sdcard -name notes.txt"));
    }

    @Test
    public void findWithMaxdepthIsAllowed() {
        assertNull(reason("find /sdcard -maxdepth 1"));
    }

    @Test
    public void findWithFilterOnWorkspaceIsAllowed() {
        // 工作空间 + 限定条件：既知道在哪找，也知道找什么，是最正常的查找。
        assertNull(reason("find /sdcard/khy-os/workspace -name tmp -type d"));
    }

    @Test
    public void grepSingleFileIsAllowed() {
        assertNull(reason("grep error /sdcard/khy-os/log.txt"));
    }

    @Test
    public void lsIsStillAllowed() {
        // ls 不是 exec，不受形状底约束；它有自己的条目上限。
        JSONObject args = new JSONObject();
        LoopModes.Decision d = LoopModes.decide(
                LoopModes.Mode.BYPASS, "ls", args);
        assertEquals(LoopModes.Action.EXECUTE, d.action);
    }

    @Test
    public void unrelatedCommandsUnaffected() {
        assertNull(reason("input tap 540 1200"));
        assertNull(reason("am start -n com.tencent.mm/.ui.LauncherUI"));
    }

    // ---------- 形态本身 ----------

    @Test
    public void reasonIsChineseAndActionable() {
        String r = reason("cat /sdcard/DCIM/*");
        assertNotNull(r);
        assertTrue("原因必须是中文", r.codePointAt(0) > 0x4E00);
        assertTrue("必须说清怎么改", r.contains("逐个") || r.contains("缩小"));
    }

    @Test
    public void nestedShellIsStillCaught() {
        // `sh -c '...'` 会被展开后递归检查——这是本类既有能力，不能因新增而失效。
        assertNotNull(reason("sh -c 'cat /sdcard/DCIM/*'"));
    }

    @Test
    public void decideNeverThrowsOnGarbage() {
        for (String bad : new String[] {"", "   ", "'''", "cat", "tar -f"}) {
            try {
                JSONObject args = new JSONObject();
                args.put("cmd", bad);
                LoopModes.Decision d = LoopModes.decide(
                        LoopModes.Mode.BYPASS, "exec", args);
                assertNotNull(d);
            } catch (org.json.JSONException e) {
                throw new IllegalStateException(e);
            }
        }
    }
}
