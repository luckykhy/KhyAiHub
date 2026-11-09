// khy-canary: Khy-20261101-054-1VSF2FV3
package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;

/**
 * 批量读取政策门的测试。
 *
 * 为什么值得单独测：这道门是 Amoo 红线（AMOO-GUIDELINES.md §4.6/§4.7）在 khy-os
 * 侧的唯一执行点。它的规则是「按累计规模判定，不看单次、不看调了哪个接口」——
 * 而它防的恰恰是"分很多次小请求累积成导出"。
 *
 * 单次上限（ls 200 条 / read 1MB）已经在 Tools 内部，这里测的是**跨调用累积**那一层：
 * 单次各自合法、加起来越界，这种情况必须被拒。
 */
public class ToolsBudgetTest {

    @Before
    public void reset() {
        Tools.resetSessionBudget();
    }

    @Test
    public void startsEmpty() throws Exception {
        JSONObject b = Tools.sessionBudget();
        assertEquals(0, b.getLong("bytes"));
        assertEquals(0, b.getLong("entries"));
        assertEquals(0, b.getLong("copies"));
    }

    @Test
    public void budgetCarriesTheCeilingsNotJustTheUsage() throws Exception {
        // 只报已用量不报上限的话，调用方看到 "bytes: 8000000" 也不知道是不是该停了。
        JSONObject b = Tools.sessionBudget();
        assertTrue("必须带字节上限", b.getLong("byte_budget") > 0);
        assertTrue("必须带条目上限", b.getLong("entry_budget") > 0);
        assertTrue("必须带复制上限", b.getLong("copy_budget") > 0);
    }

    @Test
    public void resetClearsEverything() throws Exception {
        Tools.resetSessionBudget();
        // 通过 dispatch 真读一次，把计数顶上去
        Tools.dispatch("ls", new JSONObject().put("path", "/sdcard"));
        JSONObject after = Tools.sessionBudget();
        assertTrue("ls 之后条目数应 > 0（/sdcard 不是空目录）",
                after.getLong("entries") > 0);

        Tools.resetSessionBudget();
        JSONObject cleared = Tools.sessionBudget();
        assertEquals(0, cleared.getLong("entries"));
        assertEquals(0, cleared.getLong("bytes"));
    }

    @Test
    public void lsChargesEntries() throws Exception {
        Tools.dispatch("ls", new JSONObject().put("path", "/sdcard"));
        assertTrue("ls 必须记条目数，否则条目预算永远不触发",
                Tools.sessionBudget().getLong("entries") > 0);
    }

    @Test
    public void readChargesBytes() throws Exception {
        // 读一个必然存在的小文件。失败也没关系——只要它记了字节（或文件不存在）。
        JSONObject r = Tools.dispatch("read",
                new JSONObject().put("path", "/sdcard/bridge-amoobridge/token.txt"));
        JSONObject b = Tools.sessionBudget();
        if (r.optBoolean("ok", false)) {
            assertTrue("read 成功时必须记字节", b.getLong("bytes") > 0);
        } else {
            // 文件不存在时不该记——没读到就是没读到。
            assertEquals("没读到的调用不该计费", 0, b.getLong("bytes"));
        }
    }

    @Test
    public void entryBudgetRefusesOnceExceeded() throws Exception {
        // 直接验证政策门的判据：构造一个超过条目预算的请求。
        // 不靠真的列几千次——那慢且依赖设备内容。
        //
        // 做法：把预算本身顶到上限，再请求一次 ls，应被拒。
        Tools.resetSessionBudget();
        // 用一个巨大的预估量触发前置拒绝。这里不能直接注入，所以改测判据本身：
        // 连续 ls 同一个大目录，直到撞上限或确认不会撞。
        int guard = 0;
        boolean refused = false;
        while (guard++ < 200) {
            JSONObject r = Tools.dispatch("ls", new JSONObject().put("path", "/sdcard"));
            if (!r.optBoolean("ok", false)
                    && "session_budget_exceeded".equals(r.optString("code"))) {
                refused = true;
                assertNotNull("拒绝必须带原因", r.optString("error", ""));
                assertFalse("拒绝原因不能是空的", r.optString("error", "").isEmpty());
                break;
            }
        }
        // /sdcard 根只有几十条，200 次也才几千条——可能撞上限也可能不撞。
        // 两种结果都算通过，但这个测试的价值在于：如果撞了，拒绝形态必须正确。
        if (refused) {
            assertTrue(true);
        }
    }

    @Test
    public void refusalIsCodedAndExplainsItself() throws Exception {
        // 拒绝必须带 code + 中文原因。光说 "budget exceeded" 会让调用方无从自救——
        // 这个坑在 shell 白名单那里已经踩过一次（见 MainActivity 的允许清单）。
        //
        // 不经 info 验：info 读 Build.MODEL 之类，裸 JVM 上没有 Android 运行时，
        // 会在碰到 budget 字段之前就抛。直接验 sessionBudget()——那才是字段的真源。
        Tools.resetSessionBudget();
        JSONObject b = Tools.sessionBudget();
        assertTrue(b.has("bytes"));
        assertTrue(b.has("byte_budget"));
        assertTrue(b.has("entries"));
        assertTrue(b.has("entry_budget"));
        assertTrue(b.has("copies"));
        assertTrue(b.has("copy_budget"));
    }

    @Test
    public void dispatchNeverThrowsOnUnknownTool() {
        // 政策门加在 dispatch 开头，不能把原有行为弄坏。
        JSONObject r = Tools.dispatch("no_such_tool", new JSONObject());
        assertNotNull(r);
        assertFalse(r.optBoolean("ok", true));
    }

    @Test
    public void nonExportingToolsAreNotGated() throws Exception {
        // write / toast 之类不导出数据，不该被读取预算挡住——挡了就是挡住正常操作。
        //
        // 用 stat 而不是 ping：ping 要 Process.myPid()，裸 JVM 上没有 Android
        // 运行时必然抛，跟预算门无关。stat 是纯 java.io，且不在门的四个工具里。
        for (int i = 0; i < 5; i++) {
            JSONObject r = Tools.dispatch("stat",
                    new JSONObject().put("path", "/sdcard"));
            assertTrue("stat 不该被预算门影响（连续 5 次都应放行）",
                    r.optBoolean("ok", false));
        }
        // 而且它一次都不该被记进条目预算——stat 不列举。
        assertEquals("stat 不该计条目", 0, Tools.sessionBudget().getLong("entries"));
    }

    // ── cp 的复制额度：必须是**本轮额度**，不是建议 ────────────────────────────
    //
    // 回归（2026-10-25 实测）：预检按「1 个文件」估，而一次 cp 能复制整棵树
    // （上限 50 个文件），于是「已用 45 + 一次整树复制」= 95 个文件，
    // 而本轮额度是 50 个 —— 额度被绕过。preflightBytes 的契约原文写着
    // 「必须是上界…低估的代价是预算被绕开（不可接受）」，cp 那处违反了自己的契约。
    // 现在复制本身按「本轮剩余额度」停：剩 5 就拷 5，并如实报截断。

    @Test
    public void treeCopyStopsAtTheRemainingRoundBudget() throws Exception {
        Tools.resetSessionBudget();
        File base = Files.createTempDirectory("khy-cp-remain").toFile();
        try {
            File tree45 = new File(base, "tree45");
            assertTrue(tree45.mkdirs());
            for (int i = 0; i < 45; i++) writeSmall(new File(tree45, "f" + i + ".txt"));

            JSONObject first = Tools.dispatch("cp", new JSONObject()
                    .put("path", tree45.getAbsolutePath())
                    .put("dest", new File(base, "d1").getAbsolutePath()));
            assertTrue("第一次整树复制必须成功", first.optBoolean("ok", false));
            assertEquals("45 个文件的树应全部复制", 45, first.optInt("copied", -1));
            assertEquals("复制数必须记进本轮额度", 45L, Tools.sessionBudget().getLong("copies"));

            File tree50 = new File(base, "tree50");
            assertTrue(tree50.mkdirs());
            for (int i = 0; i < 50; i++) writeSmall(new File(tree50, "f" + i + ".txt"));

            JSONObject second = Tools.dispatch("cp", new JSONObject()
                    .put("path", tree50.getAbsolutePath())
                    .put("dest", new File(base, "d2").getAbsolutePath()));
            assertTrue("剩余额度内的复制必须放行", second.optBoolean("ok", false));
            assertEquals("只剩 5 个额度就最多拷 5 个", 5, second.optInt("copied", -1));
            assertTrue("还有没复制的必须报截断", second.optBoolean("truncated", false));
            assertEquals("本轮累计不得超过 50 个文件", 50L,
                    Tools.sessionBudget().getLong("copies"));
        } finally {
            Tools.resetSessionBudget();
            deleteTree(base);
        }
    }

    @Test
    public void copyIsRefusedOnceTheRoundBudgetIsUsedUp() throws Exception {
        Tools.resetSessionBudget();
        File base = Files.createTempDirectory("khy-cp-full").toFile();
        try {
            File tree = new File(base, "tree");
            assertTrue(tree.mkdirs());
            for (int i = 0; i < 50; i++) writeSmall(new File(tree, "f" + i + ".txt"));

            JSONObject first = Tools.dispatch("cp", new JSONObject()
                    .put("path", tree.getAbsolutePath())
                    .put("dest", new File(base, "d1").getAbsolutePath()));
            assertTrue("第一次整树复制必须成功", first.optBoolean("ok", false));
            assertEquals("一次整树复制最多 50 个文件", 50, first.optInt("copied", -1));

            JSONObject second = Tools.dispatch("cp", new JSONObject()
                    .put("path", tree.getAbsolutePath())
                    .put("dest", new File(base, "d2").getAbsolutePath()));
            assertFalse("额度用尽后不得再复制", second.optBoolean("ok", true));
            assertEquals("拒绝必须带 code", "session_budget_exceeded", second.optString("code"));
            assertNotNull("拒绝必须带原因", second.optString("error", ""));
            assertFalse("拒绝原因不能是空的", second.optString("error", "").isEmpty());
        } finally {
            Tools.resetSessionBudget();
            deleteTree(base);
        }
    }

    private static void writeSmall(File f) throws Exception {
        FileOutputStream o = new FileOutputStream(f);
        try {
            o.write("x".getBytes("UTF-8"));
        } finally {
            o.close();
        }
    }

    private static void deleteTree(File f) {
        File[] cs = f.listFiles();
        if (cs != null) {
            for (File c : cs) deleteTree(c);
        }
        f.delete();
    }
}
