package com.khyos.khy_os_client.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

/**
 * R7 的两条入口判定，以及它们各自要防的那一种「看起来成功了」。
 *
 * 1. JSON 直显（{@link AmooLoop#looksLikeCommand} /
 *    {@link AmooLoop#runCommandLocally}）。待发队列里既可能是一句给 amoo 的话，
 *    也可能是一条从聊天框粘过来的控制台命令。后者走 amoo 的输入框是绕路：它
 *    本来在本机就能跑，跑完该以卡片形式回到控制台历史里，而不是变成 amoo 聊天
 *    记录里的一行字。判定只有一处，两个入口（悬浮框「发送下一笔」与
 *    PromptInputActivity「立即发送」）都经它。
 *
 * 2. 单飞锁回执的形状（{@code Tools.amooAsk} 的 {@code single_flight} 分支）。
 *    「已有一个任务在进行中」不是可执行的：调用方不知道该去取哪一笔，于是
 *    重发——而重发正是这把锁要防的事。receipt 必须带 job id 与已耗时。
 *
 * 为什么单飞锁那条只能从源码断言：要真跑进那个分支，得先让一笔 ask 真的占住
 * 锁，而那需要无障碍服务 + 一块点着的 amoo 屏幕（见 AmooLoopOrphanHealTest 的
 * 「WHY PROBES」）。UiAdviceTest 对同一类不变量用的也是源码断言；这里照办，并
 * 明说这是源码属性、不是运行期证据。
 */
public class AmooCommandRouteTest {

    @Before
    public void cleanSlate() {
        KhyConsole.clearHistory();
    }

    // ── looksLikeCommand ────────────────────────────────────────────────────

    @Test
    public void aConsoleCommandIsRecognised() {
        assertTrue(AmooLoop.looksLikeCommand("{\"tool\":\"ls\",\"args\":{\"path\":\"/sdcard\"}}"));
        // 前后空白不改变判定——从输入框或聊天框粘过来的文本几乎总带换行。
        assertTrue(AmooLoop.looksLikeCommand("  \n{\"tool\":\"ping\"}\n"));
        // 别名也认：canonical 化发生在 prepare 认出 tool 之后，判定只看「是不是命令」。
        assertTrue(AmooLoop.looksLikeCommand("{\"tool\":\"file_list\"}"));
    }

    @Test
    public void proseIsNotACommand() {
        // 判错方向的代价不对称：把一句提问当命令跑，是拿用户的话去执行；把一条
        // 命令当提问发，只是多绕一步。所以「不像命令」是默认答案。
        assertFalse(AmooLoop.looksLikeCommand("帮我把 /sdcard/Download/词刻.apk 装一下"));
        assertFalse(AmooLoop.looksLikeCommand("现在屏幕上有什么"));
        assertFalse(AmooLoop.looksLikeCommand(""));
        assertFalse(AmooLoop.looksLikeCommand("   "));
        assertFalse(AmooLoop.looksLikeCommand(null));
    }

    @Test
    public void jsonThatIsNotACommandIsNotACommand() {
        // 以 { 开头但不是命令的 JSON：数组根、缺 tool、tool 不是字符串、tool 为空。
        assertFalse(AmooLoop.looksLikeCommand("{\"args\":{\"path\":\"/sdcard\"}}"));
        assertFalse(AmooLoop.looksLikeCommand("{\"tool\":123}"));
        assertFalse(AmooLoop.looksLikeCommand("{\"tool\":\"\"}"));
        assertFalse(AmooLoop.looksLikeCommand("{\"tool\":\"   \"}"));
        // 语法错误：宁可当提问，也不要执行半个命令。
        assertFalse(AmooLoop.looksLikeCommand("{\"tool\":\"ls\""));
        // 一个看起来像 JSON 的纯文本：{ 开头但根本解析不了。
        assertFalse(AmooLoop.looksLikeCommand("{这不是 json}"));
    }

    @Test
    public void theJudgementAsksTheConsoleNotASecondParser() {
        // 判定与 KhyConsole.prepare 同一件事：prepare 把 tool 抠出来之后才会查
        // 白名单和 schema，所以「prepare 认出了 tool」就是控制台意义上的命令。
        // 自己抄一份 JSON 解析，两边迟早对「算不算命令」给出不同答案。
        String src = readSource("AmooLoop.java");
        assertTrue("looksLikeCommand 必须问 KhyConsole.prepare",
                src.contains("KhyConsole.prepare(t).tool.length() > 0"));
    }

    // ── runCommandLocally ───────────────────────────────────────────────────

    @Test
    public void aCommandRunsLocallyAndLandsInTheSharedHistory() throws Exception {
        File tmp = File.createTempFile("khy_r7_route", ".txt");
        tmp.delete();
        Files.write(tmp.toPath(), "R7".getBytes(StandardCharsets.UTF_8));
        String cmd = "{\"tool\":\"read\",\"args\":{\"path\":\""
                + tmp.getAbsolutePath().replace('\\', '/') + "\",\"max\":16}}";

        String said = AmooLoop.runCommandLocally(cmd);

        assertTrue("要告诉人跑成了，并且记录落在控制台历史里：" + said,
                said.contains("已执行") && said.contains("read"));
        // 共享历史里必须多出一行，且 origin 是 manual——这条路是人在悬浮框或
        // 输入页按出来的，不是 amoo 产的。混成一个 origin，「谁跑的」就查不出来了。
        org.json.JSONArray entries = KhyConsole.history(10).optJSONArray("entries");
        assertNotNull("本地执行必须落共享历史", entries);
        assertEquals(1, entries.length());
        assertEquals(KhyConsole.ORIGIN_MANUAL,
                entries.getJSONObject(0).optString("origin"));
        assertEquals("read", entries.getJSONObject(0).optString("tool"));
        tmp.delete();
    }

    @Test
    public void aCommandThatCannotRunStillLeavesARecord() {
        // 一张写着「为什么没跑成」的卡片，比什么都不留更接近现场。exec_error 也落。
        KhyConsole.clearHistory();
        String said = AmooLoop.runCommandLocally("{\"tool\":\"no_such_tool\"}");
        assertTrue("失败也要说清是哪个工具、哪一类：" + said,
                said.contains("no_such_tool") && said.contains("tool_unavailable"));
    }

    @Test
    public void sendingAQueuedCommandDoesNotHandItToAmoo() throws Exception {
        // 队首是命令时，「发送下一笔」不得去调 amoo_ask——那会把一条本机可跑的
        // 命令送去 amoo 的输入框，并且因为 amoo 不在前台而被前台预检拒掉，
        // 用户看到的是一次无缘无故的失败。
        File tmp = File.createTempFile("khy_r7_queue", ".txt");
        tmp.delete();
        Files.write(tmp.toPath(), "队列".getBytes(StandardCharsets.UTF_8));
        String cmd = "{\"tool\":\"read\",\"args\":{\"path\":\""
                + tmp.getAbsolutePath().replace('\\', '/') + "\",\"max\":8}}";

        AmooLoop.enqueuePrompt(cmd, false);
        String said = AmooLoop.sendPendingPrompt();

        assertTrue("命令该就地执行：" + said, said.contains("已执行"));
        assertFalse("走本地执行这条路时，单飞锁不该被碰",
                AmooLoop.askRunning());
        // 命令留在队首：结果可能要求人改一个参数再发，那时他手里还得有原文。
        assertEquals(1, AmooLoop.pendingPromptCount());
        tmp.delete();
    }

    // ── 单飞锁回执的形状 ────────────────────────────────────────────────────

    @Test
    public void theSingleFlightReceiptNamesTheJobAndTheElapsedTime() {
        // 源码断言，理由见类注释：真跑进这个分支需要一块点着的 amoo 屏幕。
        String src = readSource("Tools.java");
        int at = src.indexOf(".put(\"code\", \"single_flight\")");
        assertTrue("Tools.java 里找不到 single_flight 回执", at > 0);
        String tail = src.substring(at, Math.min(src.length(), at + 600));
        assertTrue("single_flight 必须带 job id，否则调用方不知道该去取哪一笔",
                tail.contains(".put(\"job\", runningJob)"));
        assertTrue("single_flight 必须带已耗时，否则调用方不知道等了多久",
                tail.contains(".put(\"elapsed_ms\", runningMs)"));
        // 两个值必须来自 AmooLoop，而不是 Tools 自己另存一份——另存一份就会漂移。
        assertTrue("job id 必须取 AmooLoop.askJobId()",
                src.contains("AmooLoop.askJobId()"));
        assertTrue("已耗时必须取 AmooLoop.askElapsedMs()",
                src.contains("AmooLoop.askElapsedMs()"));
    }

    @Test
    public void thePollCarriesTheJobIdToo() {
        // amoo_result 是唯一的取结果出口，它也带 job：轮询方要把「我在等的那一笔」
        // 和回执里的 id 对上，才知道自己没在等一笔已经换了主的旧任务。
        String src = readSource("AmooLoop.java");
        assertTrue("askResult 必须回 job", src.contains(".put(\"job\", askJob)"));
    }

    @Test
    public void theForegroundRefusalIsBucketedByPrefixNotByEquality() {
        // 实测吃过一次：askError 从裸 "amoo_not_foreground" 改成带指引的长句后，
        // Tools.amooAsk 与 MainActivity 的等值判断整个失效，调用方重新落进
        // single_flight——而现场一个任务都没有。
        //
        // S4 起判据收进 AmooLoop.isForegroundRefusal 一处（计数器与回执分档
        // 必须同源），两处调用方都改为引用它；前缀语义本身由 AmooLoop 里的
        // startsWith 钉住——检查挪了位置，没有放宽。
        String tools = readSource("Tools.java");
        assertTrue("Tools.amooAsk 必须走统一的前台拒绝判据",
                tools.contains("AmooLoop.isForegroundRefusal(why)"));
        assertFalse("不许在调用方再抄一份 startsWith（两套判据会漂）",
                tools.contains("why.startsWith(\"amoo_not_foreground\")"));
        String main = readSource("MainActivity.kt");
        assertTrue("MainActivity 的 amoo 路由必须走统一判据",
                main.contains("AmooLoop.isForegroundRefusal(why)"));
        assertFalse(main.contains("why.startsWith(\"amoo_not_foreground\")"));
        String loop = readSource("AmooLoop.java");
        assertTrue("前缀语义只许存在一处：AmooLoop.isForegroundRefusal",
                loop.contains("why.startsWith(\"amoo_not_foreground\")"));
    }

    @Test
    public void bringingAmooForwardIsAnnouncedBeforeItStealsTheScreen() {
        // 静默切走屏幕会被读成「App 崩了，别的东西自己打开了」。一条通知是
        // 「解释过的切换」和「惊吓」之间的差别。
        String src = readSource("AmooLoop.java");
        assertTrue("拉起 amoo 前必须先发通知",
                src.contains("BridgeService.notifyText(\"khy-os 反代提问\""));
        assertTrue("拉起必须显式指向聊天页，而不是随便一个 launcher 入口",
                src.contains("AMOO_CHAT_ACTIVITY"));
        // 拉起失败才是拒绝；拉起成功就交给 worker 去确认前台真的换过来了。
        assertTrue("worker 必须确认前台真的换成了 amoo 才动手写",
                src.contains("awaitAmooForeground(FOREGROUND_PROBE_MS)"));
    }

    @Test
    public void theWriteBackRetryLoopAndItsSleepUseTheSameGuard() {
        // THE BUG THIS PINS. writeBack's retry loop was widened from `armed` to
        // `sending()` so the reverse-proxy path could use it, but the sleep at
        // the top of the loop body still asked `armed` — which is false for the
        // whole of an ask. Every sleep returned false, the loop body never ran
        // once, and writeBack returned right after typing: three send attempts,
        // zero attempted, and no report and no pending copy either. Measured on
        // the device as a prompt sitting in Amoo's input box with an empty chat
        // list and nothing anywhere saying why.
        //
        // Half of one fix. The half left out was the half that did the work.
        String src = readSource("AmooLoop.java");
        int sleepAt = src.indexOf("private static boolean sleep(long ms)");
        assertTrue("找不到 sleep()", sleepAt > 0);
        String sleepBody = src.substring(sleepAt, src.indexOf("private static String abbreviate", sleepAt));
        assertTrue("sleep 的判据必须是 sending()，不是 armed——反代路径上 armed 恒为 false",
                sleepBody.contains("if (!sending()) {"));
        assertFalse("sleep 不该再回头看 armed", sleepBody.contains("if (!armed) {"));
        // And the loop guard it has to agree with.
        assertTrue("writeBack 的重试条件仍是 sending()",
                src.contains("attempt <= WRITE_BACK_ATTEMPTS && sending()"));
    }

    @Test
    public void aSendThatNeverHappensIsReportedToThePollingCaller() {
        // 反代路径上调用方只轮询 amoo_result，而 writeBack 的 report 它看不见。
        // 三次发送都点不到发送键时，原因必须写进 askError——否则它拿到的是
        // "timeout after Nms"，一句把「发送键没按下去」说成「等太久」的假话。
        String src = readSource("AmooLoop.java");
        assertTrue("发送失败必须把原因写进反代那一侧的状态",
                src.contains("stampAskError(\"发送失败（重试 \""));
        assertTrue("被叫停也不许静默 return", src.contains("发送被叫停"));
        // And the poll loop must not overwrite a real reason with a timeout.
        assertTrue("runAsk 不许把已知的失败原因覆盖成超时",
                src.contains("if (ASK_FAILED.equals(askState)) {"));
    }

    @Test
    public void bothNativeEntriesCarryTheDetermination() {
        // R7 的两个原生入口都要能回答「这句话会去哪里」，而且答案必须来自同一处
        // 判据。曾出现过只改了一半的状态：判定在 AmooLoop 里，悬浮框那一侧只剩
        // 一句注释——于是面板照旧显示「待发 N 笔」，按钮照旧只有一个词，用户按
        // 下去不知道该等 3 秒还是 6 分钟。
        String overlay = readSource("BridgeOverlayService.java");
        assertTrue("悬浮框必须自己判一次（判据仍只有 AmooLoop.looksLikeCommand 一处）",
                overlay.contains("queueHeadIsCommand()"));
        assertTrue("悬浮框的判据必须是 looksLikeCommand，不是自己抄一份 JSON 解析",
                overlay.contains("AmooLoop.looksLikeCommand(AmooLoop.pendingPromptHead())"));
        assertTrue("命令要就地执行，不进 amoo 的输入框",
                overlay.contains("AmooLoop.runCommandLocally(head)"));

        String prompt = readSource("PromptInputActivity.java");
        assertTrue("输入页必须自己判一次", prompt.contains("AmooLoop.looksLikeCommand(p)"));
        assertTrue("命令要就地执行，不进 amoo 的输入框",
                prompt.contains("AmooLoop.runCommandLocally(p)"));
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static String readSource(String name) {
        try {
            for (String base : new String[] {
                    System.getProperty("user.dir", "."),
                    AmooLoop.class.getProtectionDomain().getCodeSource().getLocation()
                            .getPath(),
            }) {
                File cur = new File(base);
                for (int up = 0; up < 8 && cur != null; up++, cur = cur.getParentFile()) {
                    File c = new File(cur,
                            "app/src/main/java/com/khyos/khy_os_client/bridge/" + name);
                    if (!c.isFile()) {
                        c = new File(cur,
                                "app/src/main/kotlin/com/khyos/khy_os_client/" + name);
                    }
                    if (c.isFile()) {
                        return new String(Files.readAllBytes(c.toPath()),
                                StandardCharsets.UTF_8);
                    }
                }
            }
            throw new IllegalStateException("找不到 " + name);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
