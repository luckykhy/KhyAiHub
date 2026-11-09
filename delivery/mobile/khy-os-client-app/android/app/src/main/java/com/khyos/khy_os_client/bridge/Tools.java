// khy-canary: Khy-20261101-020-ABHRWYEJ
package com.khyos.khy_os_client.bridge;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Vibrator;
import android.provider.Settings;
import android.widget.Toast;

import com.khyos.khy_os_client.KhyAccessibilityService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.Arrays;
import java.util.List;

/**
 * 桥的工具分发：exec/文件/应用/系统 + 循环与反代(6) + 11 个 UI 工具 = 39 个。
 *
 * 由独立版 StepBridge v2.3.0 的 Tools.java 并入而来，两处适配：
 *   1) UI 工具路由到 KhyUi（它再转给 app 既有的 KhyAccessibilityService），
 *      不再用本 APK 自己的无障碍服务；
 *   2) ping/info 的 ui 字段改为 KhyAccessibilityService 的真实在线态——
 *      PC 侧 khy-os 的 UI 工具准入只看这个字段。
 *
 * exec 沿用 v2.3.0 的修法：stdout/stderr 独立线程抽取，主线程轮询退出码。
 * 旧实现先把 stdout 读到 EOF 才轮询，`sleep 300` 会让 1..120s 超时永不触发。
 */
public class Tools {
    private static Context ctx;

    public static void init(Context c) {
        ctx = c.getApplicationContext();
    }

    public static Context ctxRef() {
        return ctx;
    }

    public static boolean uiReady() {
        return KhyAccessibilityService.Companion.isReady();
    }

    /**
     * Why the accessibility service is not usable, in Chinese. Empty when it is.
     *
     * {@link #uiReady()} is a bare boolean. On a device where the service was
     * never enabled, {@code info} answered {@code "ui":false} and nothing else —
     * the same silent-dead-layer shape as {@code "shizuku_why":""} before it was
     * fixed: a degraded state reported as a flag with no reason attached.
     *
     * Measured on PZ261A (2026-10-25): {@code settings get secure
     * enabled_accessibility_services} returned {@code null}, i.e. the service had
     * never been turned on. Every {@code amoo_ask} then burned its full budget
     * and failed with {@code "timeout after 120000ms"} — a message that names the
     * symptom and hides the cause completely.
     */
    public static String uiWhy() {
        return uiReady() ? "" : UI_WHY;
    }

    /** The reason text. One constant, so the advice and the flag cannot drift. */
    private static final String UI_WHY =
            "无障碍服务未开启（系统设置里 enabled_accessibility_services 为空）";

    /**
     * What to do about a disabled accessibility service. Empty when there is
     * nothing to advise.
     *
     * WHY THIS IS THE BLOCKING ONE, NOT THE THIRD ONE. Elevation decides whether
     * commands work. Accessibility decides whether there is a loop at all: the
     * Amoo loop reads Amoo's screen through it, types into its input box through
     * it, and taps send through it. With it off, {@code amoo_ask} does not fail
     * fast — it writes to a pending file, retries, and then waits out the whole
     * budget before reporting a timeout. Two minutes of silence for a condition
     * that is knowable in one boolean read.
     *
     * The remedy is deliberately pointed at the app's own screen rather than at
     * {@code adb}: this is a user-consent permission over screen content, so it
     * is the user's to grant, and the app already has a chip for it.
     */
    static String uiAdvice(boolean uiReady) {
        if (uiReady) {
            return "";
        }
        return "无障碍服务没开，Amoo 循环一步都跑不了。"
                + "它靠无障碍读 Amoo 的界面、往输入框写字、点发送；"
                + "没有这个权限，读写界面和点击都做不了，问出去也收不到回复"
                + "（本机实测：空转 120 秒后返回 timeout after 120000ms，原因一个都没说）。"
                + "开法：本 App 界面里点「无障碍」权限项，"
                + "或系统设置 → 无障碍 → 已下载的应用 → 本 App。"
                + "提权和它是两件事：那边决定命令跑不跑得动，这边决定循环到底存不存在。";
    }

    /** {@link #uiAdvice(boolean)} against the live state. */
    public static String uiAdvice() {
        return uiAdvice(uiReady());
    }

    /**
     * Whether Shizuku elevation is currently usable.
     *
     * Cached, and refreshed only by an actual exec attempt: querying it costs a
     * package-manager lookup plus a binder check, which must not run on the
     * overlay's refresh ticker (that path is deliberately IO-free).
     */
    public static boolean shizukuReady() {
        return shizukuReady;
    }

    /** Why elevation is unavailable, in Chinese. Empty when it is available. */
    public static String shizukuWhy() {
        return shizukuWhy;
    }

    /**
     * Whether the shell sidecar is currently usable.
     *
     * Same contract as {@link #shizukuReady()}: cached, refreshed only by an
     * actual exec attempt, and therefore free to read from the overlay's
     * IO-free refresh ticker.
     */
    public static boolean sidecarReady() {
        return ShellSidecarClient.ready();
    }

    /** Why the sidecar is unavailable, in Chinese. Empty when it is available. */
    public static String sidecarWhy() {
        return ShellSidecarClient.why();
    }

    /**
     * Kick a one-shot liveness probe at the sidecar.
     *
     * Called from a startup thread, never from the overlay ticker: this opens a
     * socket. It exists so the panel can show the elevation state before the
     * first command ever runs — otherwise the state would read as
     * "not yet probed" and tell the user nothing actionable.
     *
     * The wording matters here. It used to say only "重启后需重跑 adb 提权命令",
     * which presumes a PC is available. It often is not — the phone is the thing
     * you have with you — so the panel now names BOTH routes and says which one
     * needs a computer:
     *
     *   · sidecar（需要电脑）：{@code adb shell dalvikvm …}
     *   · Shizuku（不需要电脑）：装 Shizuku，用它自己的「无线调试」启动
     *
     * {@link #elevationAdvice()} is the single source of that text so the
     * overlay, the notification and {@code info} cannot drift apart.
     */
    public static void probeSidecar() {
        ShellSidecarClient.probe();
    }

    /**
     * What the user should DO about the current elevation state, in Chinese.
     *
     * Empty when either tier is live — there is nothing to advise. Otherwise it
     * names both routes and marks the one that needs a computer, because after a
     * reboot the sidecar is gone and a PC may not be to hand.
     */
    public static String elevationAdvice() {
        return elevationAdvice(sidecarReady(), shizukuReady());
    }

    /**
     * The pure form. Package-visible because the advice is the user-facing
     * deliverable of this whole change, and it must be assertable on a bare JVM —
     * {@link #elevationAdvice()} reads two volatile flags that only a device can
     * set, so a test of it would be a test of nothing.
     */
    static String elevationAdvice(boolean sidecar, boolean shizuku) {
        if (sidecar || shizuku) {
            return "";
        }
        // 「（Android 11+ 可用手机自己的无线调试，不用连电脑）」被删掉了。
        // 原因不是它说错了，而是它让这段话无法被自描述复用：净化器的
        // OS_VERSION 规则是「android + 空白 + 数字」，「Android 11+」会被改写成
        // 「当前系统版本」，于是任何含这段话的文本都过不了
        // AmooSafe.wouldChange(text) == false 那道钉子。要么在这里删掉这句
        // （三处消费方共用一份措辞），要么在自描述里分叉出第二份——后者正是
        // 这个方法存在所要避免的漂移。「不需要电脑」已经把意思说清了。
        return "未提权。两条路，选一条："
                + "① 不需要电脑——装 Shizuku，在 Shizuku 里用「无线调试」启动；"
                + "② 需要电脑——重启后重跑 adb 提权命令把 sidecar 拉起来。"
                + "两条都不做的话，input/am/pm 这类命令会以 App 自己的 uid 跑，"
                + "看起来成功但实际改不动系统。";
    }

    /**
     * Kick a one-shot Shizuku availability probe, off the startup path.
     *
     * WHY THIS EXISTS AND WHY IT WAS MISSING. The sidecar has been probed
     * eagerly since the bridge was written; Shizuku never was. Its
     * {@link #shizukuWhy} was only ever written from inside
     * {@code execViaShizuku} — i.e. lazily, on the first command that actually
     * went down that path. So on a device with no Shizuku at all, {@code info}
     * reported {@code "shizuku":false,"shizuku_why":""}, which reads as "no
     * problem here". That is the silent-dead-layer failure: the one state the
     * user most needs to know about — after a reboot killed the sidecar and
     * there is no PC to restart it — was the one state that said nothing.
     *
     * Probing eagerly costs one {@code getPackageInfo} plus a binder check, both
     * microseconds, and makes {@code info} answerable before any command runs.
     *
     * WHY THIS IS THE PC-INDEPENDENT PATH. The sidecar is started by
     * {@code adb shell dalvikvm}, so after a reboot it is gone until a PC runs
     * the elevation command again. Shizuku on Android 11+ is started from the
     * phone's OWN wireless debugging — no PC, no root, one tap in the Shizuku
     * app. So the two tiers are not interchangeable: one needs a computer and
     * one does not, and a bridge that reports them identically hides the only
     * self-sufficient option.
     */
    public static void probeShizuku() {
        try {
            android.content.Context c = ctxRef();
            if (c == null) {
                shizukuWhy = "无法探测提权状态：桥没有 Context";
                return;
            }
            com.khyos.khy_os_client.ShizukuServiceManager.Status st =
                    com.khyos.khy_os_client.ShizukuServiceManager.ensureConnected(c);
            shizukuReady = st.getAvailable();
            // Status.toString() already distinguishes all three states a user
            // has to act on: ready / installed-but-not-started / not-installed.
            // Storing the whole sentence, not a bare code, is what makes the
            // panel actionable.
            shizukuWhy = st.getAvailable() ? "" : st.toString();
        } catch (Throwable bad) {
            // A failed probe must still say something. "Unknown" with the
            // exception class is honest; an empty string is not.
            shizukuWhy = "提权状态探测失败：" + bad.getClass().getSimpleName();
        }
    }

    private static volatile boolean shizukuReady = false;
    private static volatile String shizukuWhy = "";

    public static final String[] NAMES = {
        "ping", "info", "exec", "ls", "read", "write", "mkdir", "rm", "mv", "cp", "stat",
        "start_app", "open_url", "share_text", "clipboard", "toast", "notify", "list_apps",
        "battery", "volume", "brightness", "vibrate", "adou_signin",
        "loop_start", "loop_stop", "loop_status",
        "amoo_ask", "amoo_result", "amoo_memory", "amoo_stop",
        "ui_dump", "ui_tap", "ui_click", "ui_swipe", "ui_longpress", "ui_type",
        "ui_back", "ui_home", "ui_recents", "shot", "shot_b64",
        "zip", "unzip",
        "secret_code", "secret_put", "secret_list", "secret_del",
        "tools",
    };

    // ==================== 能力目录 ====================

    /**
     * 工具目录：分组 + 每个工具一句话说清能干什么。
     *
     * THE DEFECT，2026-10-26 实测于 Amoo 的自报：Amoo 被问「你能对手机做什么」，
     * 回答「做不了 GUI 自动点击……没有 root，超不出系统给的权限沙盒」。
     * 两条都与代码不符——桥里躺着 11 个界面工具（ui_tap/ui_click/ui_swipe/
     * ui_longpress/ui_type/ui_back/ui_home/ui_recents/ui_dump/shot/shot_b64），
     * 以及两条提权通道（sidecar uid 2000、Shizuku）。
     *
     * 根因不是能力缺失，是**能力不可见**：{@code info} 报了设备、UI 状态、提权
     * 状态、预算，唯独没有工具清单；HTTP /status 只给 {@code tools: NAMES.length}
     * 一个计数。于是调用方知道「有 39 个工具」，却不知道有哪些、分别能干什么，
     * 只能靠猜——而猜错的方向永远是低估（没人会声称自己有能力却没做过）。
     *
     * 为什么一句话描述是必须的：光给名字，{@code ui_longpress} 对不知道它存在的人
     * 和对不知道它干什么的人是一样无用的。名字回答「有什么」，描述才回答「能干嘛」。
     *
     * 为什么是静态表而不是反射枚举 dispatch 的分支：dispatch 是手写 if 链，
     * 反射得不到描述；而手抄一份就有漂移风险——所以 {@link #catalogDrift} 在测试里
     * 比对两边，漏一个就红。
     */
    static final String[][] CATALOG = {
        // 组, 工具, 一句话
        {"基础", "ping", "探活，回 pong"},
        {"基础", "info", "设备/系统/UI/提权/预算 一次全报"},
        {"基础", "exec", "跑一条 shell 命令，回 stdout/stderr/退出码/耗时"},
        {"基础", "tools", "本目录：分组列出所有工具及用途"},

        {"文件", "ls", "列目录（白名单根之下）"},
        {"文件", "read", "读文件内容"},
        {"文件", "write", "写文件（覆盖）"},
        {"文件", "mkdir", "建目录"},
        {"文件", "rm", "删文件；删目录要显式 recursive:true"},
        {"文件", "mv", "移动/重命名"},
        {"文件", "cp", "复制"},
        {"文件", "stat", "看大小/时间/可读可写"},
        {"文件", "zip", "把目录或文件打成 zip（用系统自带 zip 库，不需外部命令）"},
        {"文件", "unzip", "解 zip 到指定目录"},

        // 沙箱凭据投递。这四个是 G04 的入口：凭据只进 App 私有目录 + Keystore，
        // 永远不落 /sdcard；写入要一道「人在手机旁」的确认码。见 SandboxVault。
        {"凭据投递", "secret_code", "生成一次性投递码，码只显示在手机通知上"},
        {"凭据投递", "secret_put", "凭投递码写入一条沙箱凭据（写后码即失效）"},
        {"凭据投递", "secret_list", "列已存凭据的名字、写入时间与长度（不回内容）"},
        {"凭据投递", "secret_del", "删除一条凭据（凭投递码）"},

        {"应用与系统", "start_app", "按包名启动 App"},
        {"应用与系统", "open_url", "打开链接"},
        {"应用与系统", "share_text", "调系统分享"},
        {"应用与系统", "clipboard", "读/写剪贴板"},
        {"应用与系统", "toast", "弹一条 toast"},
        {"应用与系统", "notify", "发一条通知"},
        {"应用与系统", "list_apps", "列已装应用"},
        {"应用与系统", "battery", "电量与充电状态"},
        {"应用与系统", "volume", "读/设音量"},
        {"应用与系统", "brightness", "读/设亮度"},
        {"应用与系统", "vibrate", "震一下"},
        // 跨 App 协作：khy的a豆助手（com.amoo.adousignin）把签到流程开成广播接口，
        // 这里只做转发与回执解析，不碰它的坐标和截图逻辑。
        {"应用与系统", "adou_signin", "调用 khy的a豆助手：op=run/status/schedule/stop"},

        {"界面自动化", "ui_dump", "界面操作第一步：导出控件树拿文本与坐标"},
        {"界面自动化", "ui_tap", "按坐标点（坐标取自 ui_dump 的 bounds）"},
        {"界面自动化", "ui_click", "按文本找控件并点，比 ui_tap 可靠"},
        {"界面自动化", "ui_swipe", "滑动；横滑条必须点垂直中心"},
        {"界面自动化", "ui_longpress", "长按某坐标"},
        {"界面自动化", "ui_type", "往焦点输入框写文字，写完回读校验"},
        {"界面自动化", "ui_back", "系统返回键"},
        {"界面自动化", "ui_home", "回桌面（不结束进程）"},
        {"界面自动化", "ui_recents", "最近任务列表"},
        {"界面自动化", "shot", "截屏存文件返回路径（理解内容需配视觉模型）"},
        {"界面自动化", "shot_b64", "截屏直接回 base64，体积大慎用"},

        // 组名不叫「Amoo 循环」：这一组是「驱动一个聊天助手的循环」，Amoo 只是
        // 目前唯一被实测过的那一个。换个助手（荣耀 YOYO、华为小艺）的用户看到
        // 「Amoo」只会困惑。组名不镜像到 PC 侧目录（那边按工具名映射），所以
        // 改它没有跨仓库代价。
        {"助手循环", "loop_start", "启动反代循环（读屏→提问→写回）"},
        {"助手循环", "loop_stop", "停循环"},
        {"助手循环", "loop_status", "循环状态"},
        {"助手循环", "amoo_ask", "问助手一句，异步取结果"},
        {"助手循环", "amoo_result", "取上一句的回答"},
        {"助手循环", "amoo_memory", "读/写助手的跨会话记忆"},
        // 单飞的唯一人工出口。没有它的话，一笔卡在无界 IPC 里的提问只能白等
        // 420s~1800s 的整个预算，而 PC/Agent 侧连"等的是什么"都不知道。
        {"助手循环", "amoo_stop", "中止进行中的提问，立即释放单飞锁"},
    };

    /**
     * 富路由指令：给模型的「什么时候用我、什么时候别用我、用错会怎样」。
     *
     * WHY THIS IS A SEPARATE TABLE FROM {@link #CATALOG}. The catalog is injected
     * into every assistant turn as a preamble, and that preamble is abbreviated to
     * 1500 characters (SelfDesc.java:30). Measured on 2026-10-28: the compact
     * catalog already costs 1086 of those 1500 bytes, leaving 414. Expanding all
     * 42 entries into the routing format would push it past several thousand and
     * the abbreviation would cut the list in half — the model would see a
     * truncated directory, which is strictly worse than a short accurate one.
     *
     * So the split is by delivery mechanism, not by importance:
     *   · CATALOG  — compact index, always in the preamble. Answers "what exists".
     *   · ROUTING  — full instructions, fetched on demand via the {@code tools}
     *                call, whose output is not budget-capped. Answers "when do I
     *                reach for which one, and what happens if I get it wrong".
     *
     * The format is borrowed from what StepOS's own AppFunctions ship, verified by
     * reading {@code dumpsys app_function} on a PZ261A: the description field of a
     * first-party function that is known to route correctly is not documentation,
     * it is a routing instruction with verb normalisation, positive samples,
     * negative samples that name the function to use instead, and the return
     * codes. {@code AppStoreFunctions#searchApp} is the reference shape.
     *
     * Only entries where a wrong pick is measured or destructive are here. A
     * routing block for {@code vibrate} would be noise; one for {@code ui_tap} vs
     * {@code ui_click} is the difference between tapping the wrong pixel and
     * tapping the right button.
     *
     * Drift is pinned by test in both directions, same as CATALOG.
     */
    static final String[][] ROUTING = {
        // 三个元工具放在最前面：它们是「问这个桥能干什么、现在什么状态」的入口，
        // 而 2026-10-26 那次误判（Amoo 自报做不了 GUI 自动化）正是因为调用方
        // 只看了状态就下能力结论。顺序即优先级——模型先看到该问谁。
        {
            "tools",
            """
                # description
                本桥的完整能力目录：分组列出全部工具，并对配了用法约束的工具附上
                富路由指令（什么时候用我、什么时候别用我、出错会怎样）。
                想知道「这个桥能干什么」或「该用哪个工具」时，先调它。

                **动词归一化**：你能做什么 / 有哪些工具 / 该用哪个 / 这个桥能干什么 → 本函数。

                # positive_samples
                - 你能对这台手机做什么
                - 有哪些工具可以用
                - 我想点个按钮，该用哪个

                # negative_samples
                - 现在屏幕上有什么 → ui_dump（要控件树）或 shot（要画面）
                - 设备现在什么状态 → info

                # return
                ok=true 给 groups[]，每组含 tools[]，每个工具有 name/what，
                配了 ROUTING 的还带 routing（多行路由指令）。没有 routing 键的
                工具表示没有额外用法约束，不是约束为空。"""},

        {
            "info",
            """
                # description
                一次报全：设备型号、系统版本、无障碍服务是否连着、提权通道
                （sidecar / Shizuku）是否就绪、本轮剩余读取预算。
                **判断某个能力此刻能不能用，看这里，不要看工具目录**——目录说的是
                这个桥有什么，info 说的是这台设备现在什么状态，两者答的不是同一个问题。

                **动词归一化**：现在什么状态 / 无障碍开着吗 / 能提权吗 / 还能读多少 → 本函数。

                # positive_samples
                - 现在无障碍服务连上了吗
                - 提权通道就绪了吗
                - 还剩多少读取预算

                # negative_samples
                - 这个桥有哪些工具 → tools
                - 屏幕上有什么 → ui_dump

                # return
                ok=true 给 model/brand/device/sdk/ui/elevated/budget 等字段。
                ui=false 时所有界面工具会失败，那时先修无障碍，不要反复调 ui_dump。"""},

        {
            "ping",
            """
                # description
                探活。回 pong，顺带证明这条通路是通的。

                **动词归一化**：在吗 / 通不通 / ping → 本函数。

                # positive_samples
                - ping 一下

                # negative_samples
                - 看能力状态 → info，ping 只证明活着不证明能用

                # return
                ok=true 给 pong。"""},

        // 界面自动化。2026-10-26 实测：Amoo 自报「做不了 GUI 自动点击」，而桥里
        // 躺着 11 个界面工具。根因是能力不可见 + 用法不清——所以这一组每条都写
        // 明顺序：先 dump 拿 bounds，再决定用 click（按文本）还是 tap（按坐标）。
        {
            "ui_dump",
            """
                # description
                导出当前界面的控件树：每个可交互节点的文本、content-desc、viewId、
                可点击/可编辑状态与屏幕坐标 bounds。这是所有界面操作的**第一步**——
                不知道控件在哪，ui_tap 就只能猜坐标，而猜错就是点到别的东西上。

                **动词归一化**：看界面 / 读屏幕 / 这个页面有什么 / 按钮在哪 / 
                找一下输入框 / 控件树 / dump → 本函数。

                # positive_samples
                - 现在屏幕上有什么可以点的
                - 微信的输入框在哪里
                - 帮我看看这个页面有哪些按钮

                # negative_samples
                - 点一下登录按钮 → 先 ui_dump 拿到 bounds，再 ui_click（按文本）或 ui_tap（按坐标）
                - 现在屏幕上是什么内容 → 要「看懂」用 shot_b64 交给视觉模型；本函数只给结构与坐标，不给语义

                # return
                ok=true 时给 nodes[]（含 text/desc/viewId/clickable/editable/bounds）与窗口信息；
                节点数有上限，超出会标 truncated=true——那时按 bounds 分区再 dump，不要当成界面只有这么多。
                无障碍服务未连接时 ok=false，原因见 info 的 ui 字段。"""},

        {
            "ui_click",
            """
                # description
                **按文本或描述找到控件并点它**，不用自己算坐标。内部就是 ui_dump 加一次
                ui_tap，所以它比手算坐标可靠：文本匹配不上时会明确说没找到，而不是点到一个
                碰巧在那个坐标的东西上。

                参数：text 是控件上可见的文字（优先）；id 是 resource-id，文字匹配不上时才
                用它。两者至少给一个。

                **动词归一化**：点一下 X / 点击 X 按钮 / 按一下 X / 选 X → 本函数。

                # positive_samples
                - 点一下「发送」
                - 点击登录按钮
                - 按一下右上角的更多

                # negative_samples
                - 点坐标 (540,1200) → 那是 ui_tap，本函数按文本找
                - 长按 X → ui_longpress
                - 在输入框里写字 → ui_type

                # return
                ok=true 已点到；ok=false 且 reason=not_found 表示文本没匹配上——这时先
                ui_dump 看真实文本（可能是 content-desc 而不是 text），不要反复重试同一个词。"""},

        {
            "ui_tap",
            """
                # description
                按**屏幕坐标**点一下。只在已经知道坐标时用——坐标通常来自 ui_dump 的
                bounds，取中心点。不知道坐标就别用：猜坐标是最容易点到别的东西的一种方式。

                **动词归一化**：点这个坐标 / tap x y / 点屏幕这个位置 → 本函数。

                # positive_samples
                - 点 (540, 1200)
                - 点一下这个 bounds 的中心

                # negative_samples
                - 点一下「发送」→ ui_click，按文本比按坐标可靠
                - 滑动 → ui_swipe

                # return
                ok=true 已派发手势；ok=false 多为无障碍未连接或坐标越界。注意 ok=true 
                只说明手势派出去了，不说明点中了想要的东西——要确认就再 ui_dump 一次。"""},

        {
            "ui_swipe",
            """
                # description
                从 (x1,y1) 滑到 (x2,y2)，ms 可选。列表滚动、翻页、拉出抽屉都走它。

                **动词归一化**：滑动 / 上滑 / 下滑 / 左滑 / 右滑 / 滚动 / 翻到下一页 → 本函数。

                # positive_samples
                - 向上滑一下看更多
                - 把这个列表滚到底

                # negative_samples
                - 长按 X → ui_longpress
                - 点 X → ui_click

                # return
                ok=true 已派发。横滑条（ViewPager 一类）必须点**垂直中心**，点边缘会
                被当成纵向滚动——这是实测过的失败形态。"""},

        {
            "ui_longpress",
            """
                # description
                长按某个坐标。呼出上下文菜单、选中、触发长按反馈用它。

                参数：x 与 y 是要长按的坐标（像素），ms 是时长（默认 700）。

                **动词归一化**：长按 / 按住 X / 选中这条 → 本函数。

                # positive_samples
                - 长按这条消息
                - 按住这个图标

                # negative_samples
                - 点一下 X → ui_click
                - 在输入框里写字 → ui_type

                # return
                ok=true 已派发。要长按的控件先用 ui_dump 拿 bounds 取中心。"""},

        {
            "ui_type",
            """
                # description
                往当前获得焦点的输入框写文字，**写完会回读校验**。空字符串表示清空。

                参数：text 是要写入的文字，不能为空。

                **动词归一化**：输入 X / 打字 / 写上 X / 填 X / 搜索 X → 本函数。

                # positive_samples
                - 在输入框里写「明天天气」
                - 把搜索框填成 khy-os

                # negative_samples
                - 点一下输入框 → 先用 ui_click 或 ui_tap 让它获得焦点，再本函数
                - 把文字发出去 → 本函数只写不发送；发送要另点发送键

                # return
                ok=true 且 verified=true 表示回读一致；verified=false 表示**写进去了但
                读回来不一样**——密码框会跳过回读（那时 verified 恒为 false，不是失败）。
                不要把 verified=false 当成已成功，也不要在没确认焦点时就反复写。"""},

        {
            "ui_back",
            """
                # description
                系统返回键。关当前页、收起键盘、退出二级界面。

                **动词归一化**：返回 / 回去 / 关掉这个页面 / 收起键盘 → 本函数。

                # positive_samples
                - 返回上一页
                - 收起键盘

                # negative_samples
                - 回桌面 → ui_home
                - 看最近任务 → ui_recents

                # return
                ok=true 已派发。"""},

        {
            "ui_home",
            """
                # description
                回桌面。不等同于结束任何进程。

                **动词归一化**：回桌面 / 回到主屏 / home → 本函数。

                # positive_samples
                - 回桌面

                # negative_samples
                - 返回上一页 → ui_back
                - 关掉这个 App → 本函数不结束进程，用 exec 配 pm force-stop（有安全底，需确认）

                # return
                ok=true 已派发。"""},

        {
            "ui_recents",
            """
                # description
                打开最近任务列表。

                **动词归一化**：最近任务 / 多任务 / 切换 App → 本函数。

                # positive_samples
                - 打开最近任务

                # negative_samples
                - 切到某个 App → 用 start_app 按包名直接起，比在最近任务里找可靠

                # return
                ok=true 已派发。"""},

        {
            "shot",
            """
                # description
                截屏并**存成文件**，返回路径、宽高、字节数。要「看懂屏幕上是什么」时，
                把路径交给视觉模型，不要用 shot_b64——后者会把一整张图塞进对话上下文。

                **动词归一化**：截图 / 截个屏 / 保存当前屏幕 → 本函数。

                # positive_samples
                - 截个屏保存下来
                - 把当前界面存成图片

                # negative_samples
                - 现在屏幕上是什么内容 → 要「理解」就 shot + 视觉模型；要「结构」就 ui_dump
                - 把图直接给我看 → 那是 shot_b64，仅在图很小且确实需要内联时用

                # return
                ok=true 给 path/width/height/bytes。path 在 /sdcard 之下，可直接 read。
                不解码、不上传、不记录。"""},

        {
            "shot_b64",
            """
                # description
                截屏并**直接回 base64**。只在确实需要把图内联进上下文时用——一张全屏
                base64 是几十万字符，会把上下文吃光。默认应该用 shot。

                **动词归一化**：把屏幕内容直接给我 / base64 截图 → 本函数。

                # positive_samples
                - 把当前屏幕编码后直接返回

                # negative_samples
                - 截图保存 → shot，那个只给路径
                - 屏幕上有什么按钮 → ui_dump，比图小得多也准得多

                # return
                ok=true 给 b64/width/height。体积有上限，超出会被拒绝而不是静默截断。"""},

        // 以下几条的危险不是「选错工具」，而是「选了但不知道后果」。
        {
            "rm",
            """
                # description
                删文件。**默认不递归**：删一个目录本身要显式 recursive:true。这是刻意
                的反直觉默认——按「删目录」的直觉调一次，反直觉默认下只删掉一个文件，
                而直觉默认下会抹掉整棵树。

                **动词归一化**：删除 X / 删掉 X / 清理 X → 本函数。

                # positive_samples
                - 删掉 notes/tmp.md
                - 清掉这个缓存目录（recursive:true）

                # negative_samples
                - 移动而不是删除 → mv
                - 删整个目录但没说 recursive → 先向人确认，别默认 true

                # return
                ok=true 已删。拒绝清单（rm -rf / 一类）在**桥的工具层**就挡掉，
                见 LoopModes；传进来也会被拒并给出原因。"""},

        {
            "exec",
            """
                # description
                跑一条 shell 命令，回 stdout/stderr/退出码/耗时。cwd 钉在 /sdcard。

                **动词归一化**：执行 X / 跑一下 X / 运行命令 X → 本函数。

                # positive_samples
                - 跑一下 getprop ro.product.model
                - 看看 ip addr

                # negative_samples
                - 装 APK → install_apk 一类专用工具，别用 exec 拼 pm
                - 读文件 → read，比 exec cat 干净且受同一套围栏

                # return
                ok=true 给 out/err/exit/耗时。**含 shell 控制符（; & | ` > < 换行 $(）
                的命令整体拒绝**并说明原因——那是命令注入面，不是风格问题。
                提权通道（sidecar uid 2000 / Shizuku）可用时自动走，不可用则降级并说明。"""},

        {
            "amoo_ask",
            """
                # description
                向手机上的助手问一句，**异步**：本函数只负责把问题送出去，回答要另外
                用 amoo_result 取。两步缺一不可——只问不取，问题就永远没有下文。

                **动词归一化**：问助手 X / 让 Amoo 看看 X / 问它一句 → 本函数。

                # positive_samples
                - 问一下助手现在该点什么
                - 让 Amoo 描述这张截图

                # negative_samples
                - 直接读回答 → amoo_result
                - 查记忆 → amoo_memory

                # return
                ok=true 给 turnId。之后必须调 amoo_result；超时未答会报 interrupted 而不是
                假装成功。助手不在前台时本函数会失败并说明，不要反复重试。"""},

        {
            "amoo_result",
            """
                # description
                取上一句 amoo_ask 的回答。amoo_ask 的配套出口。

                **动词归一化**：取回答 / 结果呢 / 它说了什么 → 本函数。

                # positive_samples
                - 取一下刚才那个问题的回答

                # negative_samples
                - 提问 → amoo_ask

                # return
                ok=true 给回答文本；pending 表示还没答（可再取）；interrupted 表示提问
                被中断（进程死过），那时要重新 amoo_ask，不要当失败重试同一个 turnId。"""},

        // ── 文件组 ──────────────────────────────────────────────────────────
        //
        // 这一组的共同约束是**路径围栏与批量预算**，所以每条都写「边界在哪」。
        // rm 的最危险（默认不递归是刻意反直觉），read/write 次之（有单次与累计上限）。
        {
            "ls",
            """
                # description
                列目录内容（白名单根之下）。单次上限 200 条，超出会标 truncated。

                **动词归一化**：列目录 / 看看有什么文件 / 这个文件夹里有什么 / ls → 本函数。

                # positive_samples
                - 看看 /sdcard/Download 里有什么
                - 列一下工作区根目录

                # negative_samples
                - 读文件内容 → read，ls 只给名字不给内容
                - 看文件大小和时间 → stat 更直接

                # return
                ok=true 给 entries[]（name/size/mtime/dir）。truncated=true 时**不要**把
                结果当成完整目录——按子目录分批再列。累计读取有每轮预算，超了会报并说明。"""},

        {
            "read",
            """
                # description
                读文件内容。单次上限 1MB；每轮累计读取另有预算，超了会拒并说明剩多少。

                **动词归一化**：读文件 / 看看内容 / 这个文件写了什么 / cat → 本函数。

                # positive_samples
                - 读一下 notes/todo.md
                - 这个配置文件的内容是什么

                # negative_samples
                - 只要文件名列表 → ls
                - 写文件 → write

                # return
                ok=true 给 content 与 bytes。二进制内容会被拒而不是返回乱码——
                那时先 stat 看大小，或用 exec 配 base64。累计预算超限时 ok=false 且
                带剩余量，此时应合并请求而不是拆成更多次。"""},

        {
            "write",
            """
                # description
                写文件，**覆盖**已有内容。受路径围栏约束（只能写白名单根之下）。

                **动词归一化**：写入 / 保存到 / 创建文件并写入 / 把这段存成 → 本函数。

                # positive_samples
                - 把这段文字存到 notes/out.md
                - 写一个配置文件

                # negative_samples
                - 追加而不是覆盖 → 本函数是覆盖；要先读再原样拼回
                - 建目录 → mkdir
                - 移动/重命名 → mv

                # return
                ok=true 给 path 与 bytes。**覆盖不可撤销**——写之前不确定原内容
                要不要留，就先 read。围栏外的路径会被拒并说明允许的根。"""},

        {
            "mkdir",
            """
                # description
                建目录（含中间层级）。已存在不报错。

                **动词归一化**：建目录 / 创建文件夹 / mkdir -p → 本函数。

                # positive_samples
                - 建一个 notes/2026 目录

                # negative_samples
                - 写文件 → write（write 会自动建父目录）

                # return
                ok=true 给 path。"""},

        {
            "mv",
            """
                # description
                移动或重命名。跨目录移动也行，但两端都必须在围栏内。

                **动词归一化**：移动 / 重命名 / 改成 / mv → 本函数。

                # positive_samples
                - 把 a.md 重命名成 b.md
                - 把这个文件移到 archive 下

                # negative_samples
                - 复制（保留原文件）→ cp
                - 删除 → rm

                # return
                ok=true 给 from/to。**目标已存在时会被覆盖**，那是不可撤销的——
                不确定就先 stat。"""},

        {
            "cp",
            """
                # description
                复制文件或目录。复制目录要显式 recursive:true，与 rm 的默认方向相反
                （rm 默认不递归，cp 默认也不递归，但「复制整个目录」是常见意图，
                 所以这里要求显式声明而不是默认放行）。

                **动词归一化**：复制 / 拷贝 / 备份一份 / cp → 本函数。

                # positive_samples
                - 把 config.json 复制一份成 config.bak
                - 递归复制整个目录（recursive:true）

                # negative_samples
                - 移动 → mv
                - 打包 → zip

                # return
                ok=true 给 from/to/copied。单次复制的文件数有上限（50），
                超出会复制到上限为止并报 truncated——**不要**当成全部复制完成。"""},

        {
            "stat",
            """
                # description
                看文件或目录的大小、修改时间、可读可写。不读内容，所以比 read 便宜。

                **动词归一化**：多大 / 什么时候改的 / 这文件存在吗 / 能不能写 → 本函数。

                # positive_samples
                - notes.md 多大
                - 这个路径存在吗

                # negative_samples
                - 看内容 → read
                - 列整个目录 → ls

                # return
                ok=true 给 size/mtime/dir/readable/writable。不存在时 ok=false
                且 reason=not_found，不要重试。"""},

        {
            "zip",
            """
                # description
                把目录或文件打成 zip。用系统自带 zip 库，不需要外部命令，也不需要 root。

                **动词归一化**：打包 / 压缩 / 打成 zip → 本函数。

                # positive_samples
                - 把 logs 目录打包成 zip
                - 压缩这几个文件

                # negative_samples
                - 解压 → unzip
                - 只复制不压缩 → cp

                # return
                ok=true 给 path 与 bytes。条目数有上限，超出会报 truncated。"""},

        {
            "unzip",
            """
                # description
                解 zip 到指定目录。同样用系统自带库。

                **动词归一化**：解压 / 展开 / 提取 → 本函数。

                # positive_samples
                - 把这个 zip 解到 workspace 下

                # negative_samples
                - 打包 → zip

                # return
                ok=true 给 to 与 extracted。围栏外的目标路径会被拒。"""},

        // ── 凭据投递组 ──────────────────────────────────────────────────────
        // 这一组与别的工具有一个根本区别：它**不**让远端读到任何东西。
        // secret_code 把码发到手机通知上而不是返回值里，secret_list 走的每条
        // 路都不解密。原因是桥的 Bearer 令牌落在 /sdcard 上，「持有桥令牌」
        // 不是强声明；而一条被投递的凭据决定手机连到哪台服务器。
        {
            "secret_code",
            """
                # description
                生成一次性投递码，用于往这台手机里写一条沙箱凭据。**码只出现在手机的
                通知栏，不会出现在本函数的返回值里。**

                **动词归一化**：准备写凭据 / 生成投递码 / 让我确认一下 → 本函数。

                # positive_samples
                - 我要写入沙箱凭据，先给我一个投递码

                # negative_samples
                - 直接写凭据（跳过确认）→ 没有这条路，secret_put 必须要码
                - 读已存的凭据 → 没有任何工具能做这件事，secret_list 只给元信息

                # return
                ok=true 给 ttl_ms 与 expires_at，以及 code_returned=false。
                **返回值里没有码**，去手机通知栏看。看不到通知就是没发出来，
                不要反复调——每次调都会让上一个码作废。"""},

        {
            "secret_put",
            """
                # description
                凭投递码写入一条沙箱凭据（沙箱网关 token、SSH 私钥等）。
                凭据落在 App 私有目录，用 Android Keystore 加密，**不落 /sdcard**。
                写入成功即焚码：一次确认只写一条。

                **动词归一化**：存一下凭据 / 写入沙箱密钥 / 配上网关 token → 本函数。

                # positive_samples
                - 用投递码把网关 token 写进 sandbox.gateway_token

                # negative_samples
                - 不给人确认就写 → 拒绝，code 必填
                - 把凭据写到 /sdcard → 拒绝，那是本函数存在的理由的反面

                # return
                ok=true 给 name 与 bytes（明文长度，用于发现粘贴截断）。
                失败给中文原因：码过期 / 码已用过 / 码不匹配 / 条目名非法 / 内容为空。
                bytes 是唯一能验证「粘完整了」的信号，截断的凭据会在很久以后
                以一个完全不提凭据的报错形式失败。"""},

        {
            "secret_list",
            """
                # description
                列已存凭据的名字、写入时间与明文长度。**任何情况下都不回凭据内容。**

                **动词归一化**：存了哪些凭据 / 凭据是什么时候写的 → 本函数。

                # positive_samples
                - 这台手机上现在存了哪些沙箱凭据

                # negative_samples
                - 把凭据内容读出来 → 做不到，没有任何桥工具能读回内容
                - 凭据还能用吗 → 本函数只报存在与长度，不验证有效性

                # return
                ok=true 给 items[]（name / readable / created_at / bytes）与
                code_outstanding。readable=false 表示信封损坏，条目按不存在处理，
                不会被就地修复——修一个半合法的信封正是把损坏的凭据变成
                看似可用的凭据的路。"""},

        {
            "secret_del",
            """
                # description
                删除一条已存凭据。同样要投递码——删除和写入一样改变手机连到哪。

                **动词归一化**：删掉这条凭据 / 轮换掉旧密钥 → 本函数（先 secret_code）。

                # positive_samples
                - 用投递码删掉 sandbox.ssh_key

                # negative_samples
                - 不给人确认就删 → 拒绝，code 必填

                # return
                ok=true 已删除。ok=false 且 error 为「条目不存在或删除失败」时，
                条目可能本来就不在——先 secret_list 确认，不要当成功。"""},

        // ── 应用与系统组 ────────────────────────────────────────────────────
        {
            "start_app",
            """
                # description
                按包名启动 App。比在最近任务里找可靠，也不需要图形界面配合。

                **动词归一化**：打开 X / 启动 X / 跳到 X → 本函数。

                # positive_samples
                - 打开微信
                - 启动 com.tencent.mm

                # negative_samples
                - 打开链接 → open_url
                - 看最近任务 → ui_recents

                # return
                ok=true 已发出启动意图。**ok=true 不代表 App 起来了**——包名不存在
                或已被禁用时意图会静默失败，要确认就再 list_apps 或 ui_dump。"""},

        {
            "open_url",
            """
                # description
                用系统浏览器打开链接（http/https，其它 scheme 会被拒）。

                **动词归一化**：打开链接 / 访问 / 跳转到 → 本函数。

                # positive_samples
                - 打开 https://example.com

                # negative_samples
                - 打开 App → start_app
                - 分享文字 → share_text

                # return
                ok=true 已发出意图。"""},

        {
            "share_text",
            """
                # description
                调系统分享面板，把一段文字交给用户选中的 App。不指定目标，由人决定。

                **动词归一化**：分享 / 发送到 / 转发这段 → 本函数。

                # positive_samples
                - 分享这段文字

                # negative_samples
                - 直接发到某个 App → 那是 ui_type 加点击发送，且需要人确认目标
                - 复制到剪贴板 → clipboard

                # return
                ok=true 已拉起分享面板。**之后发生什么由用户决定**，本函数不回报结果。"""},

        {
            "clipboard",
            """
                # description
                读或写系统剪贴板。op=read 读，op=write 写。

                **动词归一化**：复制到剪贴板 / 剪贴板里是什么 / 读一下剪贴板 → 本函数。

                # positive_samples
                - 把这段文字放进剪贴板
                - 剪贴板现在是什么

                # negative_samples
                - 分享 → share_text（那会让人选目标）
                - 写进输入框 → ui_type

                # return
                ok=true。read 给 text（可能为空——空与「读不到」是两件事，
                用 text 字段是否存在区分）。"""},

        {
            "toast",
            """
                # description
                弹一条 toast。短提示，会自动消失，不需要用户操作。

                **动词归一化**：提示一下 / 弹个提示 / toast → 本函数。

                # positive_samples
                - 弹个提示说「已完成」

                # negative_samples
                - 需要用户处理的通知 → notify（那条进通知栏且可点）
                - 在界面上显示 → 那是 App 自己的事，不是桥的事

                # return
                ok=true 已弹出。toaste 时长有限，长文本会被截断。"""},

        {
            "notify",
            """
                # description
                发一条系统通知。进通知栏，可带标题与正文，用户可点。

                **动词归一化**：发通知 / 通知我 / 提醒 → 本函数。

                # positive_samples
                - 发个通知说任务完成了

                # negative_samples
                - 只是短暂提示 → toast
                - 让用户去做选择 → 本函数只通知，不收集输入

                # return
                ok=true 已发。需要 POST_NOTIFICATIONS 权限，未授时 ok=false 并说明。"""},

        {
            "list_apps",
            """
                # description
                列已安装应用（包名 + 名称 + 版本）。可按关键字过滤。

                **动词归一化**：装了哪些应用 / 有没有装 X / 应用列表 → 本函数。

                # positive_samples
                - 列出所有非系统应用
                - 有没有装微信

                # negative_samples
                - 启动某个应用 → start_app
                - 看界面上有什么 → ui_dump

                # return
                ok=true 给 apps[]。默认只列非系统应用，要全量显式传 system=true——
                全量有两三百条，会把上下文吃光。"""},

        {
            "battery",
            """
                # description
                读电量百分比、充电状态、温度。只读，不能改。

                **动词归一化**：电量多少 / 在充电吗 / 电池温度 → 本函数。

                # positive_samples
                - 现在电量多少
                - 是否正在充电

                # negative_samples
                - 设置省电模式 → 本函数只读；要写得走系统设置
                - 开机多久了 → info 没有这个，用系统设置（见关于手机）

                # return
                ok=true 给 level/charging/temperature。"""},

        {
            "volume",
            """
                # description
                读或设媒体/铃音/通知/闹钟音量。op=read 读，op=set 设。

                **动词归一化**：音量多少 / 调大一点 / 静音 → 本函数。

                # positive_samples
                - 现在媒体音量多少
                - 把铃音调到最大

                # negative_samples
                - 亮度 → brightness
                - 震动开关 → vibrate 只震一下，不切换开关

                # return
                ok=true。**设音量是改变用户可感知状态的操作**——非交互场景下先说明
                要设成多少，不要凭「调大一点」就猜一个值。"""},

        {
            "brightness",
            """
                # description
                读或设屏幕亮度（0-255）。op=read 读，op=set 设。

                **动词归一化**：亮度多少 / 调亮 / 调暗 → 本函数。

                # positive_samples
                - 现在亮度多少
                - 把亮度设到 128

                # negative_samples
                - 音量 → volume
                - 保持屏幕常亮 → 那是桥自己的策略，不是这个工具

                # return
                ok=true。**自动亮度开着时设值可能不生效**，那时 ok=true 但屏幕没变；
                要先关自动亮度。这是实测过的失败形态。"""},

        {
            "vibrate",
            """
                # description
                震一下，可设时长（毫秒，默认 200）。

                **动词归一化**：震一下 / 振动反馈 / 让我知道 → 本函数。

                # positive_samples
                - 震一下

                # negative_samples
                - 切换震动开关 → 本函数只震一次，不改设置
                - 发声 → 本函数不发声

                # return
                ok=true。需要 VIBRATE 权限，未授时 ok=false 并说明。"""},

        {
            "adou_signin",
            """
                # description
                驱动 khy 的 a 豆助手（com.amoo.adousignin）跑签到流程。op=run 执行、
                status 查状态、schedule 排程、stop 停止。经广播接口，不需要图形界面。

                **动词归一化**：跑签到 / 看看签到状态 / 排个签到 / 别签了 → 本函数。

                # positive_samples
                - 跑一次签到
                - 签到排程设成每天早上

                # negative_samples
                - 操作别的 App 的界面 → ui_* 那一组
                - 装 APK → 另有专用工具

                # return
                ok=true 视 op 而定。目标 App 未安装时 ok=false 且 reason 指明包名——
                那时不要重试，先确认装没装。"""},

        // ── 助手循环组 ──────────────────────────────────────────────────────
        {
            "loop_start",
            """
                # description
                启动反代循环：读屏 → 提问 → 写回，把手机上的助手当后端模型用。
                **需要目标助手在前台**，整个循环期间都是。

                **动词归一化**：开始反代 / 让它自己问 / 启动循环 → 本函数。

                # positive_samples
                - 启动反代循环问这个问题

                # negative_samples
                - 只问一句不循环 → amoo_ask
                - 查循环状态 → loop_status
                - 结束循环 → loop_stop

                # return
                ok=true 已启动。**前台要求是硬约束**：助手被切到后台循环会停，
                那时 loop_status 会报 stopped 并说明原因，不要当成成功跑完。"""},

        {
            "loop_stop",
            """
                # description
                停掉正在跑的反代循环。幂等，没在跑也返回成功。

                **动词归一化**：停 / 别循环了 / 结束 → 本函数。

                # positive_samples
                - 停止循环

                # negative_samples
                - 启动 → loop_start
                - 只查状态 → loop_status

                # return
                ok=true。停之后正在进行的提问会标记 interrupted，不会假装完成。"""},

        {
            "loop_status",
            """
                # description
                反代循环的当前状态：在跑/已停/中断，以及停的原因。

                **动词归一化**：循环还在跑吗 / 什么状态 / 进行到哪了 → 本函数。

                # positive_samples
                - 循环现在什么状态

                # negative_samples
                - 启动或停止 → loop_start / loop_stop

                # return
                ok=true 给 state 与 reason。state=stopped 时 reason 说清是用户停的、
                助手被切后台、还是提问中断——这三种的下一步完全不同。"""},

        {
            "amoo_memory",
            """
                # description
                读或写助手的跨会话记忆。op=read 读，op=write 写。

                **动词归一化**：记一下 / 之前记了什么 / 翻一下记忆 → 本函数。

                # positive_samples
                - 记下「用户的无线调试端口是 37719」
                - 之前记过什么

                # negative_samples
                - 提问 → amoo_ask
                - 取回答 → amoo_result

                # return
                ok=true。**写入的记忆会被注入到之后的每一次提问前言里**，
                所以只记「已核实的 fact」，不要记推测或临时状态——
                前言有字数上限，记满了会挤掉真正有用的事实。"""},

        {
            "amoo_stop",
            """
                # description
                中止正在进行的那一笔提问，并**立即释放单飞锁**。已经发出去的话收不回来
                （amoo 可能仍在回答），但下一个 amoo_ask 不必再等。

                **动词归一化**：停 / 别等了 / 太久了中止它 / 上一笔卡住了 → 本函数。

                # positive_samples
                - 这笔问太久了，停掉
                - 上一笔提问好像卡死了，先停再重问

                # negative_samples
                - 停整个循环 → loop_stop（本函数只停单笔提问，循环本身继续跑）
                - 只是想知道现在什么状态 → amoo_result（那个不动任何东西）

                # return
                ok=true，running=false。单飞锁已释放，可以立刻重新 amoo_ask。
                阻塞在无障碍 IPC 里的那笔救不回来，但锁放掉之后不会有人再被它堵住。"""},
    };

    /** {@link #ROUTING} 里配了富路由指令的那个工具 → 指令文本。 */
    static String routingFor(String tool) {
        if (tool == null) return null;
        for (String[] row : ROUTING) {
            if (row[0].equals(tool)) return row[1];
        }
        return null;
    }

    /** {@link #ROUTING} 提到的工具 → {@link #NAMES} 里没有的那些。空 = 一致。 */
    static java.util.Set<String> routingDrift() {
        java.util.Set<String> listed = new java.util.LinkedHashSet<>();
        for (String[] row : ROUTING) listed.add(row[0]);
        java.util.Set<String> real = new java.util.LinkedHashSet<>(Arrays.asList(NAMES));
        listed.removeAll(real);
        return listed;
    }

    /**
     * 目录里提到的工具名 → {@link #NAMES} 里没有的那些。
     *
     * 空集合 = 两边一致。测试直接断言它为空：加工具时只改一边会立刻红，
     * 而那正是「目录说有、dispatch 没有」——用户照着目录调，得到一个
     * not found，比没有目录更糟。
     */
    static java.util.Set<String> catalogDrift() {
        java.util.Set<String> listed = new java.util.LinkedHashSet<>();
        for (String[] row : CATALOG) listed.add(row[1]);
        java.util.Set<String> real = new java.util.LinkedHashSet<>(Arrays.asList(NAMES));
        listed.removeAll(real);
        return listed;
    }

    /** {@link #NAMES} 里目录没提到的那些。 */
    static java.util.Set<String> undocumentedTools() {
        java.util.Set<String> listed = new java.util.LinkedHashSet<>();
        for (String[] row : CATALOG) listed.add(row[1]);
        java.util.Set<String> real = new java.util.LinkedHashSet<>(Arrays.asList(NAMES));
        real.removeAll(listed);
        return real;
    }

    /** 目录的 JSON 形态，按组聚合成数组。 */
    static JSONArray catalogJson() throws org.json.JSONException {
        // 保序：CATALOG 已按组分块，这里顺着扫，遇到新组就开一个对象。
        JSONArray groups = new JSONArray();
        String current = null;
        JSONObject cur = null;
        for (String[] row : CATALOG) {
            if (!row[0].equals(current)) {
                current = row[0];
                cur = new JSONObject().put("group", current).put("tools", new JSONArray());
                groups.put(cur);
            }
            JSONObject entry = new JSONObject()
                    .put("name", row[1]).put("what", row[2]);
            // 富路由指令按需附上：tools 这个调用本身不受前言 1500 字预算限制，
            // 所以这里可以给全量。没有配 ROUTING 的工具就不带这个键——调用方
            // 据此知道「这个工具没有额外用法约束」，而不是看到一个空串。
            String routing = routingFor(row[1]);
            if (routing != null) {
                entry.put("routing", routing);
            }
            cur.getJSONArray("tools").put(entry);
        }
        return groups;
    }

    // ==================== 批量读取的政策门 ====================

    /**
     * 每轮（session）的累计读取预算。
     *
     * 为什么必须有这一层，而不只是各工具自己的单次上限：
     *
     * 单次上限防不住累积。`ls` 限 200 条，调 20 次就是 4000 条；`read` 限 1MB，
     * 调 100 次就是 100MB。Amoo 的红线（AMOO-GUIDELINES.md §4.7）说得很清楚：
     * 「折成多轮小请求累积的，按累计规模判定」。所以判据必须是累计，不是单次。
     *
     * 为什么放在 {@link #dispatch} 而不是各工具内部：
     * 有两条入口都到 dispatch——AmooLoop 和 HttpBridge。而 HttpBridge 那条
     * **完全绕过 LoopModes**，门放在工具内部就只有一条路径会 consult 它，
     * 那不是门。放在 dispatch 是唯一能同时覆盖两者的位置。
     *
     * 为什么 exec 和 cp 也要计数：
     * 它们比 ls/read 更能带数据。exec 单次可返回 1MB stdout，cp 能在设备本地
     * 静默复制整棵树而调用方连一个可检查的结果都没有。只给 ls/read 加上限、
     * 留着这两个，等于把最大的门开着。
     */
    private static final java.util.concurrent.atomic.AtomicLong SESSION_BYTES =
            new java.util.concurrent.atomic.AtomicLong(0);
    private static final java.util.concurrent.atomic.AtomicLong SESSION_ENTRIES =
            new java.util.concurrent.atomic.AtomicLong(0);
    private static final java.util.concurrent.atomic.AtomicLong SESSION_COPIES =
            new java.util.concurrent.atomic.AtomicLong(0);

    /** 一轮内允许读出的总字节。8MB：够读十几个中等文件，不够导出一个图库。 */
    private static final long SESSION_BYTE_BUDGET = 8L * 1024 * 1024;

    /** 一轮内允许列举的总条目数。 */
    private static final long SESSION_ENTRY_BUDGET = 2000;

    /**
     * 一轮内允许复制的文件数。
     *
     * 单独计数而不是并进字节：cp 的伤害不在读出，在于它在设备本地静默完成，
     * 调用方拿不到任何可检查的结果。文件数是唯一能事前约束它的量。
     */
    private static final long SESSION_COPY_BUDGET = 50;

    /** 重置一轮的预算。{@link com.khyos.khy_os_client.bridge.AmooLoop} 起轮时调。 */
    public static void resetSessionBudget() {
        SESSION_BYTES.set(0);
        SESSION_ENTRIES.set(0);
        SESSION_COPIES.set(0);
    }

    /** 当前已用量，供 info / 排查。 */
    public static JSONObject sessionBudget() throws org.json.JSONException {
        return new JSONObject()
                .put("bytes", SESSION_BYTES.get())
                .put("byte_budget", SESSION_BYTE_BUDGET)
                .put("entries", SESSION_ENTRIES.get())
                .put("entry_budget", SESSION_ENTRY_BUDGET)
                .put("copies", SESSION_COPIES.get())
                .put("copy_budget", SESSION_COPY_BUDGET);
    }

    /**
     * 政策门：这个工具这一调用是否超出本轮预算。
     *
     * @return null 表示放行；非 null 是一句人类可读的拒绝理由（中文）
     */
    private static String budgetVerdict(String tool, long addBytes, long addEntries,
                                        long addCopies) {
        if (addBytes > 0 && SESSION_BYTES.get() + addBytes > SESSION_BYTE_BUDGET) {
            return "本轮读取量已达上限（"
                    + (SESSION_BYTE_BUDGET / 1024 / 1024) + "MB，已用 "
                    + (SESSION_BYTES.get() / 1024 / 1024) + "MB）。"
                    + "大批量导出需要你明确指定范围和数量，不能整批拉。";
        }
        if (addEntries > 0 && SESSION_ENTRIES.get() + addEntries > SESSION_ENTRY_BUDGET) {
            return "本轮列举条目数已达上限（" + SESSION_ENTRY_BUDGET + " 条，已列 "
                    + SESSION_ENTRIES.get() + " 条）。请分批或指定子目录。";
        }
        if (addCopies > 0 && SESSION_COPIES.get() + addCopies > SESSION_COPY_BUDGET) {
            return "本轮复制文件数已达上限（" + SESSION_COPY_BUDGET + " 个）。"
                    + "整目录复制需要先确认范围和目标位置。";
        }
        return null;
    }

    /** 记入用量。放行后调，失败也调（读到了就是读到了，不管成不成功）。 */
    private static void charge(long addBytes, long addEntries, long addCopies) {
        if (addBytes > 0) SESSION_BYTES.addAndGet(addBytes);
        if (addEntries > 0) SESSION_ENTRIES.addAndGet(addEntries);
        if (addCopies > 0) SESSION_COPIES.addAndGet(addCopies);
    }

    /**
     * 一次调用的预估读出字节数，用于执行前的前置判断。
     *
     * 必须是**上界**而不是精确值：精确值要执行完才知道，而拒绝必须在执行前。
     * 高估的代价是偶尔早一点触发上限（可接受），低估的代价是预算被绕开（不可接受）。
     */
    private static long preflightBytes(String tool, JSONObject a) {
        if (tool.equals("read")) {
            return Math.min(a.optInt("max", 256 * 1024), READ_HARD_MAX);
        }
        if (tool.equals("exec")) {
            // exec 的输出上限就是它最多能带出的量。
            return EXEC_STDOUT_MAX + EXEC_STDERR_MAX;
        }
        // ls 记条目不记字节；cp 记文件数不记字节。
        return 0;
    }

    public static JSONObject dispatch(String tool, JSONObject a) {
        JSONObject r = new JSONObject();
        try {
            if (tool.equals("shell_exec")) tool = "exec";

            // ---- 危险命令底线（所有入口共用）----
            // exec 的命令来自自由文本，桥又以 sidecar/Shizuku 的高权限去跑它。
            // `rm -rf /`、`mkfs`、`dd if=/dev/zero`、`reboot`、`pm uninstall` 这类命令
            // 没有任何正当工作流需要，却能一次毁掉设备 —— 所以在**工具层**就拒，
            // 三条入口（Amoo 循环 / HTTP /call / 文件信箱）一次覆盖。
            // 模式语义与 ui_type 净化那条红线仍归 LoopModes.decide（Amoo 路径专用）。
            if (tool.equals("exec")) {
                String danger = LoopModes.execDangerReason(a);
                if (danger != null) {
                    return r.put("ok", false)
                            .put("error", "命令被拒绝（危险命令底线：" + danger
                                    + "）。桥在任何入口都不执行系统级破坏命令。")
                            .put("code", "dangerous_command_refused");
                }
            }
            if (tool.equals("file_read")) tool = "read";
            if (tool.equals("file_write")) tool = "write";
            if (tool.equals("file_list")) tool = "ls";
            if (tool.equals("sys_info")) tool = "info";

            // ---- 政策门：读出类工具先过预算 ----
            // 只拦"把数据带出设备"的几类：ls / read / exec / cp / zip。
            // write / mkdir / unzip / tap 之类不拦——它们不导出数据，拦了反而挡住正常操作。
            //
            // zip 为什么算导出：它自己不往设备外发一个字节，但它把「读 200 个小文件」
            // 换成「读 1 个 zip」。同一批数据，后者一次 read 就全拿走——这正是预算
            // 存在的理由（Amoo 红线 §4.7：「折成多轮小请求累积的，按累计规模判定」）。
            // 不拦的话，逐文件读会被额度挡住，打个包再读就绕过去了。
            //
            // 计数在工具执行之后记（见各工具尾部），因为读了多少要到执行才知道；
            // 但拒绝必须在执行之前判，所以这里用"预估量"做一次前置判断。
            if (tool.equals("ls") || tool.equals("read") || tool.equals("exec")
                    || tool.equals("cp") || tool.equals("zip")) {
                // cp 的预检量是**这次调用能复制的文件数上界**，不是 1。
                //
                // 原来按 1 个算：一次 cp 可以复制整棵树（上限 COPY_MAX_FILES=50），
                // 于是「已用 45 + 一次整树复制」= 95 个文件，而本轮额度是 50 个
                // —— 事前估小了，额度被绕过（preflightBytes 的契约原文写着
                // 「必须是上界…低估的代价是预算被绕开（不可接受）」）。
                // 改成按「本轮剩余额度」估：剩 50 就估 50，剩 3 就估 3，
                // 预检与实际停下来的地方一致，额度才是额度。
                //
                // max(1, …) 是为了额度用尽时也走同一条拒绝路径：剩余为 0 时预检量
                // 若取 0，budgetVerdict 的 `addCopies > 0` 判据就拦不住它。
                long copiesLeft = SESSION_COPY_BUDGET - SESSION_COPIES.get();
                String pre = budgetVerdict(tool, preflightBytes(tool, a),
                        tool.equals("ls") ? LS_MAX_ENTRIES : 0,
                        tool.equals("cp") || tool.equals("zip")
                                ? (int) Math.max(1, Math.min(COPY_MAX_FILES, copiesLeft)) : 0);
                if (pre != null) {
                    return r.put("ok", false).put("error", pre)
                            .put("code", "session_budget_exceeded")
                            .put("budget", sessionBudget());
                }
            }

            if (tool.equals("ping")) {
                r.put("ok", true).put("pong", System.currentTimeMillis())
                 .put("pid", android.os.Process.myPid())
                 .put("ui", uiReady());
                return r;
            }
            if (tool.equals("tools")) {
                // 能力目录。放在 info 旁边是有意的：两者回答的是同一个问题的两半——
                // info 说「这台设备现在什么状态」，tools 说「这个桥能干什么」。
                // 分两次问，就会重演 Amoo 那次自报：只看状态就下能力结论。
                return r.put("ok", true)
                        .put("count", NAMES.length)
                        .put("groups", catalogJson());
            }
            if (tool.equals("info")) {
                // 这些字段以前是在这里逐项 put 的。现在统一走 CapabilitySnapshot：
                // 自描述要说「此刻什么能用」，说的必须是同一份状态。分两处各算一遍，
                // 结局必然是 info 说 ui=false 而描述说界面自动化可用——而模型会信
                // 描述，因为它是散文、info 只是个字段。
                CapabilitySnapshot cap = CapabilitySnapshot.capture(ctx);
                r.put("ok", true).put("model", cap.model).put("brand", android.os.Build.BRAND)
                 .put("device", android.os.Build.DEVICE).put("sdk", cap.sdk)
                 .put("release", cap.release).put("uid", android.os.Process.myUid())
                 .put("ui", cap.ui)
                 .put("ui_why", cap.uiWhy)
                 .put("ui_advice", cap.uiAdvice)
                 .put("http", HttpBridge.port())
                 // 提权通道状态。exec 会优先走 shell sidecar（adb 拉起、uid 2000），
                 // 其次 Shizuku，都不可用则退回 App 自己的 uid——那时 input/am/pm/cmd
                 // 之类的命令会因权限不足而无操作。这个字段就是把差别说清楚。
                 .put("sidecar", cap.sidecar)
                 .put("sidecar_why", cap.sidecarWhy)
                 .put("shizuku", cap.shizuku)
                 .put("shizuku_why", cap.shizukuWhy)
                 // 两条都不通时，告诉人该干什么。空串 = 不用看。
                 //
                 // 单独一个字段而不是让调用方自己去拼：拼一次的代价是
                 // 悬浮框、通知、info 三处措辞漂移，而这三处恰恰是用户
                 // 在"桥好像坏了"的时候唯一会去看的地方。
                 .put("elevation_advice", cap.elevationAdvice)
                 .put("elevated", cap.elevated());
                // 本轮已用量。排查"是不是撞上限了"时第一个该看的东西。
                r.put("budget", sessionBudget());
                // 同一份快照的整体形态。上面那些扁平字段保留是为了不改 PC 侧的
                // 读取方；这个是为了让「自描述说的是不是这份状态」可以直接比对。
                r.put("capabilities", cap.toJson());
                try {
                    r.put("ver", ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName);
                } catch (Throwable ignored) {}
                return r;
            }
            if (tool.equals("exec")) {
                String cmd = a.optString("cmd", "");
                if (cmd.length() == 0) return r.put("ok", false).put("error", "empty cmd");
                return exec(cmd, Math.max(1, Math.min(a.optInt("timeout", 20), 120)));
            }
            if (tool.equals("ls")) return ls(a);
            if (tool.equals("read")) return read(a);
            if (tool.equals("write")) return write(a);
            if (tool.equals("mkdir")) {
                File f = new File(a.optString("path", ""));
                return r.put("ok", f.mkdirs() || f.isDirectory()).put("path", f.getAbsolutePath());
            }
            if (tool.equals("rm")) {
                File f = new File(a.optString("path", ""));
                // recursive **默认 false**：只传 path 就抹掉整棵目录树是最容易误伤的一步，
                // 破坏性的形态必须显式 opt-in（原默认 true 时 `{"tool":"rm","args":{"path":
                // "/sdcard/DCIM"}}` 直接删掉整棵树）。PC 侧策略同样要求 rm 走确认。
                boolean ok = a.optBoolean("recursive", false) ? deleteTree(f) : f.delete();
                return r.put("ok", ok).put("path", f.getAbsolutePath());
            }
            if (tool.equals("mv") || tool.equals("cp")) {
                File s = new File(a.optString("path", ""));
                File d = new File(a.optString("dest", ""));
                if (tool.equals("mv")) {
                    boolean ok = s.renameTo(d);
                    return r.put("ok", ok).put("path", s.getAbsolutePath()).put("dest", d.getAbsolutePath());
                }
                // cp 带计数与截断上报：整树复制是唯一能在设备本地静默搬走大量数据
                // 而不留任何可检查痕迹的操作，所以它必须自己说清复制了多少、
                // 还有多少没复制。
                int[] counter = new int[] {0, 0};
                // 本次能复制多少文件：单次上限与**本轮剩余额度**取小。
                //
                // 为什么不能只看单次上限：一次 cp 能复制整棵树（上限 COPY_MAX_FILES=50），
                // 而本轮额度也是 50 个文件。只按单次上限停、事前又只按「1 个」估，
                // 于是「已用 45 + 一次整树复制」把额度用到 95 —— 额度就成了建议。
                // 剩下多少就最多复制多少：剩 3 个文件时整树复制只拷 3 个，并如实报
                // truncated（还有多少没复制）。
                int cap = (int) Math.max(0,
                        Math.min(COPY_MAX_FILES, SESSION_COPY_BUDGET - SESSION_COPIES.get()));
                boolean ok = copyTree(s, d, counter, cap);
                charge(0, 0, counter[0]);
                return r.put("ok", ok)
                        .put("path", s.getAbsolutePath())
                        .put("dest", d.getAbsolutePath())
                        .put("copied", counter[0])
                        .put("truncated", counter[1] != 0)
                        .put("cap", cap);
            }
            if (tool.equals("stat")) {
                File f = new File(a.optString("path", ""));
                return r.put("ok", f.exists()).put("path", f.getAbsolutePath())
                        .put("exists", f.exists()).put("dir", f.isDirectory())
                        .put("size", f.length()).put("mtime", f.lastModified())
                        .put("readable", f.canRead()).put("writable", f.canWrite());
            }
            if (tool.equals("zip")) return zip(a);
            if (tool.equals("unzip")) return unzip(a);
            if (tool.equals("secret_code")) return secretCode();
            if (tool.equals("secret_put")) return secretPut(a);
            if (tool.equals("secret_list")) return secretList();
            if (tool.equals("secret_del")) return secretDel(a);
            if (tool.equals("start_app")) return startApp(a);
            if (tool.equals("open_url")) {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(a.optString("url", "")));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                return r.put("ok", true);
            }
            if (tool.equals("share_text")) {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_TEXT, a.optString("text", ""));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(Intent.createChooser(i, a.optString("title", "分享")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return r.put("ok", true);
            }
            if (tool.equals("clipboard")) {
                ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                if (a.optString("op", "get").equals("set")) {
                    cm.setPrimaryClip(ClipData.newPlainText("bridge", a.optString("text", "")));
                    return r.put("ok", true).put("op", "set");
                }
                String t = "";
                ClipData c = cm.getPrimaryClip();
                if (c != null && c.getItemCount() > 0 && c.getItemAt(0).getText() != null) {
                    t = c.getItemAt(0).getText().toString();
                }
                return r.put("ok", true).put("op", "get").put("text", t);
            }
            if (tool.equals("toast")) {
                final String m = a.optString("text", "");
                new android.os.Handler(ctx.getMainLooper()).post(new Runnable() {
                    public void run() { Toast.makeText(ctx, m, Toast.LENGTH_SHORT).show(); }
                });
                return r.put("ok", true);
            }
            if (tool.equals("notify")) {
                BridgeService.notifyText(a.optString("title", "khy-os 桥"), a.optString("text", ""));
                return r.put("ok", true);
            }
            if (tool.equals("list_apps")) return listApps();
            if (tool.equals("battery")) return battery();
            if (tool.equals("volume")) return volume(a);
            if (tool.equals("brightness")) return brightness(a);
            if (tool.equals("vibrate")) {
                Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null) v.vibrate(a.optInt("ms", 200));
                return r.put("ok", true);
            }
            if (tool.equals("adou_signin")) return adouSignin(a);
            if (tool.equals("loop_start")) return loopStart(a);
            if (tool.equals("amoo_ask")) return amooAsk(a);
            if (tool.equals("amoo_result")) return AmooLoop.askResult();
            if (tool.equals("amoo_memory")) return amooMemory(a);
            if (tool.equals("amoo_stop")) {
                // 单飞的人工出口。桥侧此前没有任何工具能调到 stopAsk——唯一入口是
                // Flutter 专有通道，PC/Agent 侧一次掉线就永久堵死，只能白等
                // 420s~1800s 的整个预算，而且连"等的是什么"都不知道。
                AmooLoop.stopAsk();
                return r.put("ok", true)
                        // 循环态：stopAsk 不动它，所以它可能还是 true。
                        .put("running", AmooLoop.isRunning())
                        // 本次真正 actuate 的那把锁。不给这个字段的话，上面的
                        // running:true 会被读成"停失败了吗"——而它说的是另一件事。
                        .put("ask_running", AmooLoop.askRunning());
            }
            if (tool.equals("loop_stop")) {
                AmooLoop.stop();
                return r.put("ok", true).put("running", AmooLoop.isRunning());
            }
            if (tool.equals("loop_status")) {
                return r.put("ok", true)
                        .put("running", AmooLoop.isRunning())
                        .put("mode", AmooLoop.currentMode().name())
                        .put("report", AmooLoop.lastReport());
            }
            if (tool.startsWith("ui_") || tool.equals("shot") || tool.equals("shot_b64")) {
                return KhyUi.dispatch(tool, a);
            }
            return r.put("ok", false).put("error", "unknown tool: " + tool);
        } catch (Throwable t) {
            try {
                return r.put("ok", false).put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
            } catch (Throwable ignored) {
                return r;
            }
        }
    }

    private static final String ADOU_PKG = "com.amoo.adousignin";
    private static final String ADOU_RECEIVER = "com.amoo.adousignin.CommandReceiver";
    private static final String ADOU_URI = "content://" + ADOU_PKG + ".status/status";

    // ==================== 可用性视图 ====================

    /**
     * 一个第三方依赖在不在。
     *
     * 为什么要可注入：单元测试跑在裸 JVM 上（build.gradle 只有 junit + org.json，
     * 全 test 树零处调 {@link Tools#init}），{@link #ctxRef()} 恒为 null。探针写死的
     * 话，「探针全 false 时扣下 4 个」这条最重要的用例永远构造不出来——而它恰恰是
     * 这轮要钉住的那条。与 {@link CapabilitySnapshot} 同一个模式：渲染路径把状态当
     * 参数收，只有一处碰设备。
     */
    public interface OptionalToolProbe {
        boolean installed(String pkg);
    }

    /**
     * 默认探针：真的去问包管理器。
     *
     * {@link #ctxRef()} 为 null 时返回 true = 不过滤。这不是乐观，是与所有静态
     * 计数的现状一致：{@link #NAMES} 的长度、{@link #catalogJson}、
     * {@code SelfDesc} 在桥没启动的环境里都照报全量。「未知」不等于「缺席」，
     * 而把未知报成缺席会让 PC 侧连同 44 个好好的工具一起过滤掉。
     *
     * 形态与 {@code adouSignin} 里的 getPackageInfo 一致：装上 = 返回 true，
     * 抛异常 = 没装。
     */
    static final OptionalToolProbe CTX_PROBE = new OptionalToolProbe() {
        public boolean installed(String pkg) {
            android.content.Context c = ctxRef();
            if (c == null) {
                return true;
            }
            try {
                c.getPackageManager().getPackageInfo(pkg, 0);
                return true;
            } catch (Throwable t) {
                return false;
            }
        }
    };

    /**
     * 依赖别的 App 才能跑的工具 → 那个 App 的包名。4 个。
     *
     * 为什么要这张表：这些工具今天在所有状态面上都报"存在"，而它们的依赖没装时
     * 调下去只会得到 {@code not_installed}。Tools.java 头部记的 2026-10-26 那次
     * 实测（Amoo 自报做不了 GUI 自动化）就是同一类问题的反面——能力不可见的代价
     * 是低估，能力虚报的代价是白等一整轮预算。所以目录面照旧全量（那里回答
     * 「这个桥有什么」），状态面报可用集（这里回答「此刻调得动哪些」）。
     *
     * 只收真正跨 App 驱动的：loop_start / loop_stop / amoo_ask 要经无障碍读 Amoo
     * 的界面、往输入框写字、点发送，adou_signin 要跨进程调 a豆助手。反过来
     * loop_status / amoo_result / amoo_memory / amoo_stop 只碰桥内静态状态与本地
     * 文件（AmooLoop 的静态字段、AmooMemory 的内存副本），Amoo 装没装都照跑——
     * 把它们绑进来等于让一个第三方 App 的装卸一票决定这四个能力的存续，其中
     * amoo_stop 还是 PC 侧掉线时唯一的人工出口。所以这四个整行留在表外，恒可用
     * （见 {@link #isAvailable} 的表外分支）。
     *
     * 包名一律写显式全名，不按前缀匹配：{@code com.amoo.adousignin} 与
     * {@code com.stepos.ailauncher} 同命名空间不同包，按 {@code com.amoo.} 前缀
     * 找会连带圈进别的应用。
     */
    static final String[][] OPTIONAL_TOOLS = {
        // 循环与反代：都要驱动 Amoo 的界面，Amoo 缺席就跑不了。
        {"loop_start", AmooLoop.AMOO_PKG},
        {"loop_stop", AmooLoop.AMOO_PKG},
        {"amoo_ask", AmooLoop.AMOO_PKG},
        // 跨进程调 a豆助手，与上面三行不同 App。
        {"adou_signin", ADOU_PKG},
    };

    /**
     * 此刻调得动的工具名，按 {@link #NAMES} 原序。
     *
     * 目录面不过滤，这里过滤——两处回答的不是同一个问题，见 {@link #OPTIONAL_TOOLS}。
     */
    public static String[] availableNames(OptionalToolProbe probe) {
        java.util.List<String> out = new java.util.ArrayList<String>();
        for (String n : NAMES) {
            if (isAvailable(n, probe)) {
                out.add(n);
            }
        }
        return out.toArray(new String[0]);
    }

    public static String[] availableNames() {
        return availableNames(CTX_PROBE);
    }

    // ── 可用性缓存 ────────────────────────────────────────────────────────
    //
    // WHY A CACHE EXISTS AT ALL. The live probe above costs one
    // getPackageInfo per optional tool. Two readers cannot afford that:
    //   · the overlay's 2s ticker, which BridgeOverlayService's own javadoc calls
    //     "contractually zero-IO" — the same constraint Tools.shizukuReady()
    //     already documents and honours by caching;
    //   · BridgeService.writeStatus(), which runs every 2s on the worker thread
    //     and would otherwise spend its life in the package manager.
    //
    // So the live form stays for callers that are already on a background path
    // and want the truth right now (HTTP /status), and everyone else reads the
    // cache refreshed by {@link #refreshAvailability()}.

    /**
     * 未探测过的默认值 = 全量不过滤。与 {@link #CTX_PROBE} 在 ctxRef()==null 时的
     * 行为同口径：「未知」不等于「缺席」。探测线程在桥启动后几毫秒内就跑完。
     */
    private static volatile String[] availNames = NAMES;
    private static volatile JSONArray availWithheld = new JSONArray();
    private static volatile long availRefreshedAt = 0L;

    /** 可用工具名，按 {@link #NAMES} 原序。零 IO，读缓存。 */
    public static String[] availableNamesCached() {
        return availNames;
    }

    /** 可用工具数。零 IO，读缓存。 */
    public static int availableCount() {
        return availNames.length;
    }

    /**
     * 被扣下的工具 + 为什么。零 IO，读缓存。
     *
     * 返回的是共享实例：只读，别改。要改就改 {@link #refreshAvailability()}。
     */
    public static JSONArray withheldCached() {
        return availWithheld;
    }

    /** 缓存多久刷新过一次，epoch ms。0 = 还没探测过。供排查「数字是不是旧的」。 */
    public static long availabilityAgeMs() {
        long at = availRefreshedAt;
        return at <= 0 ? -1L : System.currentTimeMillis() - at;
    }

    /**
     * 重算可用性并更新缓存。**只能在后台线程调**：它做 4 次 getPackageInfo。
     *
     * 调用点与 {@link #probeSidecar()} / {@link #probeShizuku()} 同一批——
     * HttpBridge.start 的探测线程、BootReceiver、以及 BridgeService 那条 10s
     * 自愈 tick。永不抛：一次失败的探测不能把桥带走。
     */
    public static void refreshAvailability() {
        try {
            String[] names = availableNames(CTX_PROBE);
            JSONArray w = withheld(CTX_PROBE);
            availNames = names;
            availWithheld = w;
            availRefreshedAt = System.currentTimeMillis();
        } catch (Throwable ignored) {
            // 保持上一份缓存。一个陈旧的数字好过没有数字。
        }
    }

    /**
     * 被扣下的工具 + 为什么，按 {@link #NAMES} 原序。空数组 = 没有扣下的。
     *
     * 每条都带 why 而不是只给名字：PC 侧要按这个过滤模型工具面，而"少了一个名字"
     * 本身不告诉任何人该干什么——装对应 App 才是下一步。
     */
    public static JSONArray withheld(OptionalToolProbe probe)
            throws org.json.JSONException {
        JSONArray out = new JSONArray();
        for (String n : NAMES) {
            if (isAvailable(n, probe)) {
                continue;
            }
            out.put(new JSONObject().put("name", n).put("why", withheldWhy(n)));
        }
        return out;
    }

    public static JSONArray withheld() throws org.json.JSONException {
        return withheld(CTX_PROBE);
    }

    /**
     * 不在 {@link #OPTIONAL_TOOLS} 里的工具永远可用。四个桥本地能力（loop_status /
     * amoo_result / amoo_memory / amoo_stop）走的正是这个分支，理由见表上的拆分说明。
     */
    private static boolean isAvailable(String name, OptionalToolProbe probe) {
        for (String[] row : OPTIONAL_TOOLS) {
            if (row[0].equals(name)) {
                return probe.installed(row[1]);
            }
        }
        return true;
    }

    /** 扣下理由。包名从 {@link #OPTIONAL_TOOLS} 取，不另写一份，避免两边漂移。 */
    private static String withheldWhy(String name) {
        for (String[] row : OPTIONAL_TOOLS) {
            if (row[0].equals(name)) {
                return "依赖的应用未安装：" + row[1]
                        + "。装上之前调它只会得到 not_installed，所以状态面先把它扣下。";
            }
        }
        return "";
    }

    /**
     * 调用 khy的a豆助手。
     *
     * 主通道是 ContentProvider.call，不是广播：StepOS 会拦「后台应用给第三方 App 发广播」
     * （实测 2026-10-28：Background execution not allowed 3rd app: com.amoo.adousignin），
     * 而 provider 调用不受这条策略管。广播留作兜底，给没装新版助手的机器用。
     */
    private static JSONObject adouSignin(JSONObject a) throws Exception {
        JSONObject r = new JSONObject();
        String op = a.optString("op", "run");
        if (!op.equals("run") && !op.equals("status") && !op.equals("schedule") && !op.equals("stop")) {
            return r.put("ok", false).put("code", "bad_op")
                    .put("error", "op 只支持 run/status/schedule/stop，收到 " + op);
        }
        try {
            ctx.getPackageManager().getPackageInfo(ADOU_PKG, 0);
        } catch (Throwable t) {
            return r.put("ok", false).put("code", "not_installed")
                    .put("error", "未安装 khy的a豆助手（" + ADOU_PKG + "）");
        }

        String json = adouCall(op, a);
        if (json.isEmpty()) {
            json = adouBroadcast(op, a);
        }
        if (json.isEmpty()) {
            return r.put("ok", false).put("code", "no_reply")
                    .put("error", "khy的a豆助手 没有回执：确认已装 v1.4+ 且未被系统冻结");
        }
        JSONObject inner = new JSONObject(json);
        r.put("ok", !inner.has("ok") || inner.optBoolean("ok", true));
        r.put("code", inner.optString("code", ""));
        r.put("message", inner.optString("message", ""));
        r.put("adou", inner);
        return r;
    }

    private static String adouCall(String op, JSONObject a) {
        try {
            Bundle b = new Bundle();
            if (op.equals("schedule")) {
                b.putInt("hour", a.optInt("hour", 9));
                b.putInt("minute", a.optInt("minute", 0));
                b.putBoolean("enabled", a.optBoolean("enabled", true));
            }
            Bundle res = ctx.getContentResolver().call(Uri.parse(ADOU_URI), op, "khy-os", b);
            String json = res == null ? "" : res.getString("json", "");
            return json == null ? "" : json;
        } catch (Throwable t) {
            return "";
        }
    }

    private static String adouBroadcast(String op, JSONObject a) throws Exception {
        String action = ADOU_PKG + "." + op.toUpperCase(java.util.Locale.US);
        Intent i = new Intent(action).setClassName(ADOU_PKG, ADOU_RECEIVER);
        // 0x01000000 = FLAG_RECEIVER_INCLUDE_BACKGROUND（@hide），部分 ROM 靠它放行
        // 后台跨应用广播。
        i.addFlags(0x01000000);
        i.putExtra("source", "khy-os");
        if (op.equals("schedule")) {
            i.putExtra("hour", a.optInt("hour", 9));
            i.putExtra("minute", a.optInt("minute", 0));
            i.putExtra("enabled", a.optBoolean("enabled", true));
        }

        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        final String[] data = new String[]{""};
        BroadcastReceiver reply = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent it) {
                data[0] = getResultData();
                latch.countDown();
            }
        };
        // 3s 只等回执，不杀任何任务：签到流程本身异步，run 立即回 accepted，
        // 进度用 op=status 轮询。
        ctx.sendOrderedBroadcast(i, null, reply, null, 0, null, null);
        boolean replied = latch.await(3, java.util.concurrent.TimeUnit.SECONDS);
        return replied && data[0] != null ? data[0] : "";
    }

    private static JSONObject startApp(JSONObject a) throws Exception {
        JSONObject r = new JSONObject();
        String pkg = a.optString("package", "");
        Intent i = null;
        JSONObject ex = a.optJSONObject("extras");
        if (a.has("component")) {
            String[] parts = a.optString("component").split("/");
            if (parts.length == 2) {
                String cls = parts[1].startsWith(".") ? parts[0] + parts[1] : parts[1];
                i = new Intent();
                i.setClassName(parts[0], cls);
            }
        }
        if (i == null) i = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
        if (i == null) return r.put("ok", false).put("error", "no launch intent: " + pkg);
        if (ex != null) {
            java.util.Iterator<String> it = ex.keys();
            while (it.hasNext()) {
                String k = it.next();
                i.putExtra(k, ex.optString(k));
            }
        }
        if (a.has("action")) i.setAction(a.optString("action"));
        if (a.has("uri")) i.setData(Uri.parse(a.optString("uri")));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
        return r.put("ok", true).put("package", pkg);
    }

    /**
     * 启动 Amoo 本地拦截循环。
     *
     * mode 缺省走 {@link LoopModes#defaultMode()}（bypass）。传了不认识的值
     * 直接报错，不静默回退——调用方以为自己选了 plan、实际在 bypass 里跑，
     * 比报错危险得多。
     */
    // throws Exception 与同文件的 startApp / listApps 一致：JSONObject.put 是
    // 受检异常，而 dispatch 整体已在 try/catch(Throwable) 里，声明一下即可。
    private static JSONObject loopStart(JSONObject a) throws Exception {
        JSONObject r = new JSONObject();
        // 新的一轮 = 新的预算。放在这里而不是每次 ask：loop_start 是"开始一个任务"的
        // 显式信号，ask 是任务内的一次提问——后者的多次调用本该共享同一份预算。
        resetSessionBudget();
        // Refuse here as well as inside AmooLoop.start(), and for a different
        // reason: start()'s refusal protects every caller but can only express
        // itself as `running == false`, which is indistinguishable from "started
        // and immediately finished". Measured on PZ261A: loop_start answered
        // `ok:true, running:false` with the reason buried in `report` — the caller
        // sees success and a dead loop.
        //
        // One boolean read, duplicated on purpose. The inner guard is the safety
        // net; this one is the honest status code.
        if (!Tools.uiReady()) {
            return r.put("ok", false)
                    .put("code", "refused")
                    .put("error", Tools.uiAdvice());
        }
        String name = a.optString("mode", "").trim();
        LoopModes.Mode mode = LoopModes.defaultMode();
        if (name.length() > 0) {
            try {
                mode = LoopModes.Mode.valueOf(name.toUpperCase());
            } catch (IllegalArgumentException e) {
                return r.put("ok", false).put("error", "mode 只能是 bypass / plan / edit / default");
            }
        }
        AmooLoop.Options opt = new AmooLoop.Options();
        if (a.has("max_rounds")) {
            opt.maxRounds = Math.max(1, a.optInt("max_rounds", opt.maxRounds));
        }
        if (a.has("deadline_ms")) {
            opt.deadlineMs = Math.max(1000L, a.optLong("deadline_ms", opt.deadlineMs));
        }
        if (a.has("poll_ms")) {
            opt.pollBaseMs = Math.max(250L, a.optLong("poll_ms", opt.pollBaseMs));
        }
        // 默认开：注入共享记忆就是"共享"本身。关掉用于只在本地累积记忆、
        // 不想为此多花一轮（这机器上 Amoo 一想约 6 分钟）。
        if (a.has("inject_memory")) {
            opt.injectMemory = a.optBoolean("inject_memory", true);
        }
        AmooLoop.start(mode, opt);
        return r.put("ok", true).put("mode", mode.name()).put("running", AmooLoop.isRunning())
                .put("memory", new JSONObject()
                        .put("entries", AmooLoop.memory().size())
                        .put("verified", AmooLoop.memory().verifiedCount()));
    }

    /**
     * 反代：把 Amoo 当模型用。
     *
     * 异步是必须的，不是偷懒：Amoo 在本机一想就是约 6 分钟，而桥的 socket 超时是
     * 20s，阻塞调用会在答案出现之前就被切断。这里只启动，结果用 amoo_result 轮询。
     */
    private static JSONObject amooAsk(JSONObject a) throws Exception {
        JSONObject r = new JSONObject();
        // 一次独立的 amoo_ask 也是一轮：它不经过 loop_start，所以预算在这里重置。
        // 不重置的话，第一次提问用掉的额度会一直跟着后面所有提问，直到有人
        // loop_start——那会让"明明没读多少却撞上限"变成一个查不出来的问题。
        resetSessionBudget();
        String prompt = a.optString("prompt", "").trim();
        if (prompt.length() == 0) {
            return r.put("ok", false).put("error", "amoo_ask 需要 prompt");
        }
        long timeoutMs = Math.max(15000L, Math.min(a.optLong("timeout_ms", 420000L), 1800000L));
        String job = AmooLoop.ask(prompt, timeoutMs);
        if (job == null) {
            // null 有三种原因，要的动作完全不同，不能一律说"已有任务在进行中"。
            //
            // 这是实测出来的坑：khy-os 在前台时调 amoo_ask，AmooLoop 的前台预检
            // 直接返回 null，而这里回一句"已有任务在进行中"——于是调用方（人或
            // Agent）以为要等，实际压根没发出去，白等整个预算。
            //
            // 判别顺序：先看 askResult 里的 error（前台预检失败时会写进去），
            // 剩下的才真的是单飞。
            //
            // 不判 empty_prompt：上面已经对空 prompt 提前返回了，到这里 prompt
            // 必然非空。留着就是死代码。
            String why = AmooLoop.askResult().optString("error", "");
            if ("amoo_not_foreground".equals(why)) {
                return r.put("ok", false)
                        .put("code", "amoo_not_foreground")
                        .put("error", "amoo 不在前台，提问没有发出。先打开 amoo 的聊天页再重试。");
            }
            // 第三种 null：前置拒绝对应的 reason（目前是无障碍服务没开）。
            //
            // 这个分支是补出来的，不是一开始就有的。ask() 里加无障碍前置检查时
            // 漏了这里，于是真正的理由被上面那句"已有一个反代任务在进行中"
            // 整个吞掉——而那句话是假的，现场根本没有任务在跑。调用方读到
            // "先用 amoo_result 取结果"，去取，取到的是同一条 advice，
            // 于是既不知道问题是什么、也不知道该干什么。
            //
            // 判据是 why 非空且不是上面那一种：预检失败都会往 askError 写一句
            // 人话，而真正的单飞是 askRunning 还站着、askError 为空。
            //
            // 第四种，2026-10-29 加：上一笔提问被 askResult 的孤儿自愈清掉了。
            // 顺序很要紧——上面那次 askResult() 就是执行自愈的地方：它发现
            // askRunning 还站着而耗时已超过最大预算，就把锁放掉、状态写成 failed、
            // 理由写成 "orphaned_ask: …"。所以走到这里时锁已经空了，why 正是那句。
            //
            // 不并进上面那个 refused 分支：并进去的后果是调用方看到「被拒绝」，
            // 于是去逐个检查前置条件（开无障碍、把 amoo 调到前台），而那些条件
            // 一直是好的——真正发生的是上一笔卡死刚被释放，该做的只是再发一次。
            // 判据用前缀而不是整句相等：那句话是给人读的，改措辞不该让它悄悄
            // 换桶。
            if (why.startsWith("orphaned_ask")) {
                return r.put("ok", false)
                        .put("code", "orphaned_ask")
                        .put("error", why);
            }
            if (why.length() > 0) {
                return r.put("ok", false)
                        .put("code", "refused")
                        .put("error", why);
            }
            return r.put("ok", false)
                    .put("code", "single_flight")
                    .put("error", "已有一个反代任务在进行中，先用 amoo_result 取结果");
        }
        return r.put("ok", true).put("job", job).put("state", "running")
                .put("timeout_ms", timeoutMs);
    }

    /**
     * 共享记忆的显式读写口。
     *
     * op=get 读当前记忆（含每条的确信度与来源）；op=set 写一条。
     * 写进去的默认是 unverified——只有命令验证通过才能自动写成 verified，
     * 手工设置不该冒充满测量结果。
     */
    private static JSONObject amooMemory(JSONObject a) throws Exception {
        JSONObject r = new JSONObject();
        String op = a.optString("op", "get").trim();
        if ("set".equals(op)) {
            String id = a.optString("id", "").trim();
            String text = a.optString("text", "").trim();
            if (id.length() == 0 || text.length() == 0) {
                return r.put("ok", false).put("error", "op=set 需要 id 与 text");
            }
            boolean verified = a.optBoolean("verified", false);
            AmooMemory.Confidence c = verified
                    ? AmooMemory.Confidence.VERIFIED
                    : AmooMemory.Confidence.UNVERIFIED;
            AmooMemory next = AmooLoop.memory().with(id, text, c,
                    a.optString("provenance", verified ? "user:verified" : "user"));
            AmooLoop.replaceMemory(next);
            return r.put("ok", true).put("op", "set").put("entries", next.size())
                    .put("verified", next.verifiedCount());
        }
        if (!"get".equals(op)) {
            return r.put("ok", false).put("error", "op 只能是 get / set");
        }
        AmooMemory m = AmooLoop.memory();
        return r.put("ok", true).put("op", "get")
                .put("entries", m.size())
                .put("verified", m.verifiedCount())
                .put("unverified", m.unverifiedCount())
                .put("json", m.toJson())
                .put("injection", m.renderForInjection(1500));
    }

    private static JSONObject listApps() throws Exception {
        JSONObject r = new JSONObject();
        android.content.pm.PackageManager pm = ctx.getPackageManager();
        java.util.LinkedHashMap<String, String> map = new java.util.LinkedHashMap<String, String>();
        Intent i = new Intent(Intent.ACTION_MAIN);
        i.addCategory(Intent.CATEGORY_LAUNCHER);
        java.util.List<android.content.pm.ResolveInfo> ris = pm.queryIntentActivities(i, 0);
        if (ris != null) {
            for (android.content.pm.ResolveInfo ri : ris) {
                try {
                    String pkg = ri.activityInfo.packageName;
                    if (!map.containsKey(pkg)) {
                        map.put(pkg, ri.loadLabel(pm).toString());
                    }
                } catch (Throwable ignored) {}
            }
        }
        try {
            for (PackageInfo pi : pm.getInstalledPackages(0)) {
                if (!map.containsKey(pi.packageName)) {
                    String label = pi.packageName;
                    try { label = pm.getApplicationLabel(pi.applicationInfo).toString(); } catch (Throwable ignored) {}
                    map.put(pi.packageName, label);
                }
            }
        } catch (Throwable ignored) {}

        java.util.List<String> pkgs = new java.util.ArrayList<String>(map.keySet());
        java.util.Collections.sort(pkgs, new java.util.Comparator<String>() {
            public int compare(String a, String b) {
                return map.get(a).compareToIgnoreCase(map.get(b));
            }
        });
        JSONArray arr = new JSONArray();
        for (String pkg : pkgs) {
            if (arr.length() >= 800) break;
            arr.put(new JSONObject().put("package", pkg).put("label", map.get(pkg)));
        }
        return r.put("ok", true).put("count", arr.length()).put("apps", arr);
    }

    private static JSONObject battery() throws Exception {
        JSONObject r = new JSONObject();
        IntentFilter f = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent b = ctx.registerReceiver(null, f);
        if (b != null) {
            int lvl = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            int pct = scale > 0 ? (int) (lvl * 100f / scale) : -1;
            r.put("percent", pct);
            r.put("status", b.getIntExtra(BatteryManager.EXTRA_STATUS, -1));
            r.put("plugged", b.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1));
            r.put("temp", b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) / 10.0);
        }
        return r.put("ok", true);
    }

    private static JSONObject volume(JSONObject a) throws Exception {
        JSONObject r = new JSONObject();
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        int stream = AudioManager.STREAM_MUSIC;
        if (a.has("level")) {
            int max = am.getStreamMaxVolume(stream);
            int lv = Math.max(0, Math.min(a.optInt("level"), max));
            am.setStreamVolume(stream, lv, 0);
            return r.put("ok", true).put("level", lv).put("max", max);
        }
        return r.put("ok", true).put("level", am.getStreamVolume(stream))
                .put("max", am.getStreamMaxVolume(stream));
    }

    private static JSONObject brightness(JSONObject a) throws Exception {
        JSONObject r = new JSONObject();
        if (Build.VERSION.SDK_INT >= 23 && !Settings.System.canWrite(ctx)) {
            return r.put("ok", false).put("error", "需要「修改系统设置」权限");
        }
        if (a.has("value")) {
            int v = Math.max(0, Math.min(a.optInt("value"), 255));
            Settings.System.putInt(ctx.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, v);
            return r.put("ok", true).put("value", v);
        }
        return r.put("ok", true).put("value",
                Settings.System.getInt(ctx.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, -1));
    }

    /**
     * 单次目录列举的上限。
     *
     * 从 2000 降到 200，两个理由：
     *   1. 真实用法——"这个目录里有没有我要的文件"看前 200 条足够，2000 条只是
     *      让结果更难读。
     *   2. Amoo 的红线（见 AMOO-GUIDELINES.md §4.6）禁止它用 ls/find 静默批量导出
     *      用户数据。单次列举不是导出，但 2000 条已经接近"把整个图库列一遍"。
     *
     * 注意这只是单次上限，防不住"分很多次小列举累积成导出"。那需要任务级预算，
     * 属于规划层的职责，不在这一个函数里。
     */
    private static final int LS_MAX_ENTRIES = 200;

    private static JSONObject ls(JSONObject a) throws Exception {
        JSONObject r = new JSONObject();
        File d = new File(a.optString("path", "/sdcard"));
        File[] fs = d.listFiles();
        JSONArray arr = new JSONArray();
        // 截断必须显式说出来。原来是 `if (arr.length() >= 2000) break;`——
        // 调用方拿到的是一份看起来完整、实际被砍过的清单，而它无法知道。
        // 一个看起来完整的部分结果，比一个明确的错误更糟：错误会促使排查，
        // 部分结果会被当成结论用。
        boolean truncated = false;
        int total = 0;
        if (fs != null) {
            total = fs.length;
            Arrays.sort(fs);
            for (File x : fs) {
                if (arr.length() >= LS_MAX_ENTRIES) {
                    truncated = true;
                    break;
                }
                arr.put(new JSONObject().put("name", x.getName()).put("dir", x.isDirectory())
                        .put("size", x.length()).put("mtime", x.lastModified()));
            }
        }
        // 记进本轮预算。条数取实际返回数——被拒的那些根本没执行到。
        charge(0, arr.length(), 0);
        return r.put("ok", fs != null).put("path", d.getAbsolutePath()).put("entries", arr)
                .put("truncated", truncated)
                .put("returned", arr.length())
                // total 只在没截断时等于 returned；截断时它是目录里的真实条数，
                // 调用方据此能判断"还有多少没看到"。
                .put("total", truncated ? total : arr.length())
                .put("cap", LS_MAX_ENTRIES);
    }

    /** 单次读取的硬上限。原来是 4MB，降到 1MB——理由同 {@link #LS_MAX_ENTRIES}。 */
    private static final int READ_HARD_MAX = 1024 * 1024;

    /** exec 的 stdout 上限。原来是散在 pump 调用里的字面量 1MB。 */
    private static final int EXEC_STDOUT_MAX = 1024 * 1024;

    /** exec 的 stderr 上限。原来是字面量 512KB。 */
    private static final int EXEC_STDERR_MAX = 512 * 1024;

    /** copyTree 一次最多复制的文件数。原来是无限的。 */
    private static final int COPY_MAX_FILES = 50;

    private static JSONObject read(JSONObject a) throws Exception {
        String p = a.optString("path", "");
        File f = new File(p);
        // 默认 256KB，上限 1MB（原 4MB）。调用方仍可显式要更小。
        int max = Math.min(a.optInt("max", 256 * 1024), READ_HARD_MAX);
        FileInputStream in = new FileInputStream(f);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) {
            bo.write(b, 0, n);
            if (bo.size() >= max) break;
        }
        in.close();
        // truncated 显式给出。原来只有 size（文件真实大小）而没有标记，
        // 调用方要靠"content.length() != size"自己推断——那要求它想起来去比。
        boolean truncated = bo.size() < f.length();
        // 记实际读出的字节，不是文件大小——读了多少才算多少。
        charge(bo.size(), 0, 0);
        return new JSONObject().put("ok", true).put("path", p)
                .put("content", new String(bo.toByteArray(), "UTF-8"))
                .put("size", f.length())
                .put("read_bytes", bo.size())
                .put("truncated", truncated)
                .put("cap", max);
    }

    private static JSONObject write(JSONObject a) throws Exception {
        File f = new File(a.optString("path", ""));
        File parent = f.getParentFile();
        if (parent != null) parent.mkdirs();
        FileOutputStream fo = new FileOutputStream(f, a.optBoolean("append", false));
        fo.write(a.optString("content", "").getBytes("UTF-8"));
        fo.close();
        return new JSONObject().put("ok", true).put("path", f.getAbsolutePath()).put("bytes", f.length());
    }

    // ==================== zip / unzip ====================

    /**
     * 用 Android 自带的 {@code java.util.zip} 打/解 zip。
     *
     * WHY THIS EXISTS. Amoo 2026-10-26 自报「zip、unzip、ffmpeg 没装」，
     * 于是「打包一批截图」这类活被直接判为做不了。但那三条里前两条是**判错了**：
     * Android 的 shell 里确实没有 zip 二进制，可 {@code java.util.zip} 一直在
     * 这个进程里——桥自己是 Java 写的，缺的只是一个暴露它的工具。
     *
     * 为什么值得做而不是让调用方装 termux：装一个完整的 Linux 用户层来解决
     * 「打个包」，代价是一个几十 MB 的 App 加一套包管理，而需求只是一行 API。
     *
     * 安全面刻意与 write/mkdir 一致（都往设备里写，不往外导数据），所以不进
     * 读出预算门——见 dispatch 里 ls/read/exec/cp 那段的注释。
     */
    // ==================== 沙箱凭据投递（G04） ====================

    /**
     * 生成一次性投递码。
     *
     * <p><b>返回值里没有码。</b>码只出现在手机的通知上。这不是抠门：桥的 Bearer 令牌
     * 落在 /sdcard 上，「持有桥令牌」不是强声明，任何有存储权限的 App、adb shell、
     * MTP 会话都可能持有它。若码随返回值回去，远端就能自己完成整个投递，
     * 「人在手机旁」这道闸等于没设。
     *
     * <p>所以这个函数对远端完全开放——谁都可以问——但问不到结果。
     */
    private static JSONObject secretCode() throws org.json.JSONException {
        android.content.Context c = ctxRef();
        if (c == null) return new JSONObject().put("ok", false).put("error", "原生壳未就绪");
        SandboxVault vault = SandboxVault.get(c);
        long now = System.currentTimeMillis();
        long ttl = vault.issueCode(now);
        return new JSONObject()
                .put("ok", true)
                .put("ttl_ms", ttl)
                .put("expires_at", vault.codeExpiresAt())
                .put("how", "投递码已发到手机通知栏。把它填进 secret_put 的 code 字段。")
                // 明确说清「这里没有码」，否则调用方会以为是字段漏了而去猜。
                .put("code_returned", false);
    }

    /**
     * 凭投递码写入一条沙箱凭据。
     *
     * <p>写成功即焚码：不允许一次确认写多条。让操作员对每一次写入都有一次明确的
     * 「是我在操作」的动作，比少点几次通知更重要——一条被投递的凭据会决定手机
     * 连到哪台服务器。
     */
    private static JSONObject secretPut(JSONObject a) throws org.json.JSONException {
        android.content.Context c = ctxRef();
        if (c == null) return new JSONObject().put("ok", false).put("error", "原生壳未就绪");
        SandboxVault vault = SandboxVault.get(c);
        String name = a.optString("name", "").trim();
        String value = a.optString("value", "");
        String code = a.optString("code", "");
        String why = vault.put(name, value, code, System.currentTimeMillis());
        if (why != null) return new JSONObject().put("ok", false).put("error", why);
        // 回长度不回内容：操作员需要确认「粘进去的东西是完整的」，
        // 而截断的凭据会在很久以后以一个完全不提凭据的报错形式失败。
        VaultEnvelope env = vault.meta(name);
        return new JSONObject()
                .put("ok", true)
                .put("name", name)
                .put("bytes", env == null ? -1 : env.plaintextLength())
                .put("stored_in", "App 私有目录（Keystore 加密，未落 /sdcard）");
    }

    /**
     * 列已存凭据的元信息。
     *
     * <p><b>任何情况下都不回内容。</b>这个函数是给远端看的，所以它走的每一条路都
     * 必须不解密——名字、写入时间、明文长度全都来自信封本身，不经 Cipher。
     * 「没有能从桥通向凭据明文的代码路径」这件事由 SandboxVaultLogicTest 机械检查，
     * 不靠注释提醒。
     */
    private static JSONObject secretList() throws org.json.JSONException {
        android.content.Context c = ctxRef();
        if (c == null) return new JSONObject().put("ok", false).put("error", "原生壳未就绪");
        SandboxVault vault = SandboxVault.get(c);
        long now = System.currentTimeMillis();
        JSONArray items = new JSONArray();
        for (String name : vault.list()) {
            VaultEnvelope env = vault.meta(name);
            JSONObject o = new JSONObject().put("name", name);
            if (env == null) {
                // 存在但读不出信封：如实说「不可读」，不假装不存在，也不就地修。
                // 修一个半合法的信封，正是把损坏的凭据变成看似可用的凭据的路。
                o.put("readable", false);
            } else {
                o.put("readable", true)
                        .put("created_at", env.createdAt())
                        .put("bytes", env.plaintextLength());
            }
            items.put(o);
        }
        return new JSONObject()
                .put("ok", true)
                .put("items", items)
                .put("code_outstanding", vault.codeOutstanding(now))
                .put("note", "本函数不回凭据内容；没有任何桥工具能读回内容。");
    }

    /** 删除一条凭据。同样要投递码——删除和写入一样改变手机连到哪。 */
    private static JSONObject secretDel(JSONObject a) throws org.json.JSONException {
        android.content.Context c = ctxRef();
        if (c == null) return new JSONObject().put("ok", false).put("error", "原生壳未就绪");
        SandboxVault vault = SandboxVault.get(c);
        String name = a.optString("name", "").trim();
        String nameBad = SandboxVault.validateName(name);
        if (nameBad != null) return new JSONObject().put("ok", false).put("error", nameBad);
        // 必须走 vault 上那个实例：码的状态存在 SandboxVault 里，自己 new 一个
        // ProvisioningCode 拿到的是空实例，verify 恒回「没有待确认的投递码」——
        // 那个报错指向桥坏了，而真正的原因是调用方写错了。
        String why = vault.verifyCode(a.optString("code", ""), System.currentTimeMillis());
        if (why != null) return new JSONObject().put("ok", false).put("error", why);
        boolean gone = vault.delete(name);
        return new JSONObject()
                .put("ok", gone)
                .put("name", name)
                .put("error", gone ? null : "条目不存在或删除失败");
    }

    private static JSONObject zip(JSONObject a) throws Exception {
        File src = new File(a.optString("path", ""));
        if (!src.exists()) {
            return new JSONObject().put("ok", false).put("error", "源不存在：" + src.getAbsolutePath());
        }
        // 判**原始参数**，不是 File 的绝对路径：`new File("").getAbsolutePath()`
        // 在 JVM 上返回进程 cwd，不是空串——所以 `getAbsolutePath().isEmpty()`
        // 永远为 false，那个检查形同不存在，zip 会静默写到 cwd 去。
        // 同一个坑在 Kotlin 侧 setWorkRoot 上踩过一次（那边用 isNotBlank 判原始值，
        // 所以是对的）。ZipToolsTest.missingOutFailsRatherThanWritingNowhere 实测抓到。
        String outPath = a.optString("out", "").trim();
        if (outPath.isEmpty()) {
            return new JSONObject().put("ok", false).put("error", "缺 out（zip 落到哪）");
        }
        File out = new File(outPath);
        File outParent = out.getParentFile();
        if (outParent != null) outParent.mkdirs();

        long[] files = {0};
        long[] bytes = {0};
        FileOutputStream fo = new FileOutputStream(out);
        java.util.zip.ZipOutputStream zo = new java.util.zip.ZipOutputStream(fo);
        try {
            // 目录本身也进条目：否则解出来是一堆散文件，原来的层级没了。
            zipInto(src, src.getName(), zo, files, bytes);
        } finally {
            zo.close();
            fo.close();
        }
        // 打进预算的是**源文件数与源字节数**，不是产物体积：额度衡量的是
        // 「这一轮从设备上带走了多少数据」，而 zip 只是换了一种带走的方式。
        // 记产物体积会让一个高压缩率的包记很少，正好绕开额度。
        //
        // 记账必须放在 return 之前：放在后面是不可达代码，javac 直接拒。
        charge(bytes[0], files[0], files[0]);
        return new JSONObject().put("ok", true)
                .put("zip", out.getAbsolutePath())
                .put("files", files[0])
                .put("bytes", bytes[0])
                .put("zip_bytes", out.length());
    }

    /** 递归写入。base 是条目名的前缀，用来保留相对层级。 */
    private static void zipInto(File f, String base,
                                java.util.zip.ZipOutputStream zo,
                                long[] files, long[] bytes) throws Exception {
        if (f.isDirectory()) {
            zo.putNextEntry(new java.util.zip.ZipEntry(base.endsWith("/") ? base : base + "/"));
            zo.closeEntry();
            File[] kids = f.listFiles();
            if (kids == null) return;
            // 排序让两次打包产出字节一致——否则没法比对「有没有多打了东西」。
            Arrays.sort(kids);
            for (File k : kids) {
                zipInto(k, base + "/" + k.getName(), zo, files, bytes);
            }
            return;
        }
        zo.putNextEntry(new java.util.zip.ZipEntry(base));
        FileInputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                zo.write(buf, 0, n);
                bytes[0] += n;
            }
        } finally {
            in.close();
        }
        zo.closeEntry();
        files[0] += 1;
    }

    private static JSONObject unzip(JSONObject a) throws Exception {
        File zipFile = new File(a.optString("path", ""));
        if (!zipFile.exists()) {
            return new JSONObject().put("ok", false).put("error", "zip 不存在：" + zipFile.getAbsolutePath());
        }
        // 同 zip：判原始参数。`new File("").getAbsolutePath()` 是 cwd 不是空串。
        String destPath = a.optString("dest", "").trim();
        if (destPath.isEmpty()) {
            return new JSONObject().put("ok", false).put("error", "缺 dest（解到哪）");
        }
        File dest = new File(destPath);
        if (!dest.exists() && !dest.mkdirs()) {
            return new JSONObject().put("ok", false).put("error", "建不了目标目录：" + dest.getAbsolutePath());
        }

        long[] files = {0};
        FileInputStream fi = new FileInputStream(zipFile);
        java.util.zip.ZipInputStream zi = new java.util.zip.ZipInputStream(fi);
        try {
            java.util.zip.ZipEntry e;
            while ((e = zi.getNextEntry()) != null) {
                File target = new File(dest, e.getName());
                // Zip Slip：条目名里带 ../ 就写到目标目录外面去。压缩包可能来自
                // 别人，这个检查不是可选项。
                //
                // 必须用**规范化**后的路径比。第一版用 getAbsolutePath()，而它
                // 不折叠 ".."：`new File(dest, "../x").getAbsolutePath()` 得到
                // "<dest>/../x"，这个串确实以 "<dest>/" 开头——于是检查放行了
                // 越界条目。ZipToolsTest 构造恶意条目时实测抓到。
                //
                // getCanonicalFile 会折叠 ".." 并解析符号链接，两边都用它，
                // 比出来的才是真实的包含关系。
                String destAbs;
                String tgtAbs;
                try {
                    destAbs = dest.getCanonicalFile().getAbsolutePath();
                    tgtAbs = target.getCanonicalFile().getAbsolutePath();
                } catch (java.io.IOException ioe) {
                    return new JSONObject().put("ok", false)
                            .put("error", "解压路径无法解析（" + e.getName() + "）：" + ioe.getMessage());
                }
                if (!tgtAbs.equals(destAbs) && !tgtAbs.startsWith(destAbs + File.separator)) {
                    return new JSONObject().put("ok", false)
                            .put("error", "拒绝解压：条目越出目标目录（" + e.getName() + "）");
                }
                if (e.isDirectory()) {
                    target.mkdirs();
                    zi.closeEntry();
                    continue;
                }
                File tp = target.getParentFile();
                if (tp != null) tp.mkdirs();
                FileOutputStream fo = new FileOutputStream(target);
                try {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = zi.read(buf)) > 0) fo.write(buf, 0, n);
                } finally {
                    fo.close();
                }
                zi.closeEntry();
                files[0] += 1;
            }
        } finally {
            zi.close();
            fi.close();
        }
        return new JSONObject().put("ok", true)
                .put("dest", dest.getAbsolutePath())
                .put("files", files[0]);
    }

    /**
     * exec：优先走 shell sidecar，其次 Shizuku，最后退回 App 自己的进程。
     *
     * WHY elevation exists at all. As its own uid (u0_a168) this app cannot run
     * {@code input}, {@code am}, {@code pm}, {@code cmd}, {@code content},
     * {@code settings} or {@code dumpsys} — they all fail on permission, so the
     * exec tool was largely nominal. Both elevated paths grant adb-shell
     * equivalence (uid 2000) without root, which is what makes those commands
     * real.
     *
     * WHY the sidecar comes first. It needs no second APK and no Shizuku
     * install: it is a class inside this very APK, started once by
     * {@code adb shell dalvikvm}. Shizuku is kept as the second choice for
     * anyone who already has it running.
     *
     * SAFETY CONSEQUENCE, stated plainly: elevation turns the safety floor from
     * a theoretical guard into a live one. {@code pm uninstall}, {@code setprop},
     * {@code reboot} and {@code dd if=} simply do not work as the app's uid, but
     * they DO work through either elevated path. LoopModes already refuses all
     * of them in every mode including bypass, so nothing is relaxed — but the
     * blast radius genuinely grows, which is why every result carries a
     * {@code via} field saying which path ran.
     *
     * @return never null. {@code via} is "sidecar", "shizuku" or "app".
     */
    public static JSONObject exec(String cmd, int timeoutSec) throws Exception {
        // 先按**上界**预留本轮预算，执行完再按实际用量结算并退回差额。
        //
        // 为什么：预检（preflightBytes）用固定上界 1.5MB 比，而计数原来只在执行**之后**
        // 按实际字节推进 —— 检查量纲与计数量纲不一致，于是「很多次小输出」的累加型导出
        // （拆成多次小请求把数据一批批拉走）永远触发不了 8MB 上限，而这正是这道预算
        // 要挡的形态。预留让「本轮最多能拿走多少」先占住额度，结算再把没用的退回去。
        final long reserved = (long) EXEC_STDOUT_MAX + (long) EXEC_STDERR_MAX;
        charge(reserved, 0, 0);
        JSONObject elevated = ShellSidecarClient.exec(cmd, "/sdcard", timeoutSec);
        if (elevated != null) {
            chargeExecOutput(elevated, reserved);
            return elevated;
        }
        JSONObject viaShizuku = execViaShizuku(cmd, timeoutSec);
        if (viaShizuku != null) {
            chargeExecOutput(viaShizuku, reserved);
            return viaShizuku;
        }
        JSONObject r = new JSONObject();
        ProcessBuilder pb = new ProcessBuilder("/system/bin/sh", "-c", cmd);
        pb.directory(new File("/sdcard"));
        final Process p = pb.start();
        final ByteArrayOutputStream out = new ByteArrayOutputStream();
        final ByteArrayOutputStream err = new ByteArrayOutputStream();
        Thread ot = pump(p.getInputStream(), out, EXEC_STDOUT_MAX);
        Thread et = pump(p.getErrorStream(), err, EXEC_STDERR_MAX);
        ot.start();
        et.start();
        long deadline = System.currentTimeMillis() + timeoutSec * 1000L;
        boolean done = false;
        while (System.currentTimeMillis() < deadline) {
            try { p.exitValue(); done = true; break; } catch (IllegalThreadStateException e) { Thread.sleep(50); }
        }
        if (!done) {
            try { p.destroy(); } catch (Throwable ignored) {}
            try { ot.join(200); et.join(200); } catch (Throwable ignored) {}
            synchronized (out) { r.put("out", out.toString("UTF-8")); }
            return r.put("ok", false).put("error", "timeout " + timeoutSec + "s").put("via", "app");
        }
        try { ot.join(500); et.join(500); } catch (Throwable ignored) {}
        int code = p.exitValue();
        synchronized (out) { r.put("out", out.toString("UTF-8")); }
        synchronized (err) { r.put("err", err.toString("UTF-8")); }
        // exec 的输出也要记进本轮预算，且要报截断。
        //
        // 原来这里只钳制不声明：pump 到 1MB/512KB 就停，而结果里没有任何标记，
        // 调用方以为拿到了全部输出。exec 是单次能带出数据最多的路径——
        // 它不报截断，字节预算就形同虚设。
        boolean outTrunc = out.size() >= EXEC_STDOUT_MAX;
        boolean errTrunc = err.size() >= EXEC_STDERR_MAX;
        long actual = (long) out.size() + (long) err.size();
        charge(actual, 0, 0);
        // 结算：把「预留上界 − 实际用量」的差额退回去（预留在 exec() 入口已计入）。
        refund(reserved - actual);
        return r.put("ok", code == 0).put("exit", code).put("via", "app")
                .put("truncated", outTrunc || errTrunc)
                .put("out_truncated", outTrunc)
                .put("err_truncated", errTrunc)
                .put("out_bytes", out.size())
                .put("err_bytes", err.size());
    }

    /**
     * Run one command through Shizuku when the channel is live.
     *
     * @return null when Shizuku is absent, unconnected or unauthorised — the
     *         caller then falls back to the app's own uid. A null return is the
     *         normal, expected outcome on a device without Shizuku and must not
     *         be treated as an error.
     */
    private static JSONObject execViaShizuku(String cmd, int timeoutSec) {
        try {
            Context c = ctx;
            if (c == null) {
                return null;
            }
            com.khyos.khy_os_client.ShizukuServiceManager.Status st =
                    com.khyos.khy_os_client.ShizukuServiceManager.ensureConnected(c);
            shizukuReady = st.getAvailable();
            shizukuWhy = st.getAvailable() ? "" : String.valueOf(st.getReason());
            if (!st.getAvailable()) {
                return null;
            }
            // Shizuku's own waitFor has no timeout, so bound it from the caller:
            // the existing exec contract promises a timeout and callers rely on
            // it (the bridge's exec timeout is what stops `sleep 300`).
            long budgetMs = Math.max(1000L, timeoutSec * 1000L);
            final String[] box = new String[] {null};
            Thread t = new Thread(new Runnable() {
                public void run() {
                    box[0] = runShizuku(c, cmd, budgetMs);
                }
            }, "shizuku-exec");
            t.setDaemon(true);
            t.start();
            t.join(budgetMs);
            if (box[0] == null) {
                // ⚠ 「超时」与「起不来」必须分开，原来没分：
                //   · 起不来（Shizuku 没装 / 没授权 / 线程立刻死）→ 返回 null，调用方退回
                //     App 自己那条路（这是设计好的降级）；
                //   · 超时（命令还在跑）→ **不能**返回 null：退回 App 路径会把**同一条命令
                //     再执行一遍**（一次提权 + 一次普通身份），副作用执行两次。
                //     这里直接报超时；提权侧那条命令由 ShizukuServiceManager 的同款预算
                //     负责杀掉，不会留下一个还在跑的进程。
                if (t.isAlive()) {
                    return new JSONObject()
                            .put("ok", false)
                            .put("exit", 124)
                            .put("out", "")
                            .put("err", "timeout " + (budgetMs / 1000) + "s")
                            .put("via", "shizuku");
                }
                return null; // 真的起不来 → 调用方退回 App 路径
            }
            JSONObject r = new JSONObject(box[0]);
            r.put("via", "shizuku");
            return r;
        } catch (Throwable bad) {
            return null; // Any failure degrades to the app-uid path.
        }
    }

    /**
     * 提权路径（sidecar / Shizuku）的 exec 输出同样要记进本轮预算，并报出截断。
     *
     * WHY this exists. 原来只有 App 自己那条路径 charge()：两条提权路径拿到结果就
     * 直接 return。可 sidecar 优先、Shizuku 次之——也就是**实际最常走的两条路从不计费**。
     * 于是本轮字节预算（8MB）对 exec 完全失效，而 exec 恰恰是单次能带出数据最多的工具
     * （stdout 1MB + stderr 512KB），可以反复调用把数据一批批拉出去。这条预算本来是
     * 「折成多轮小请求累积的，按累计规模判定」的唯一后盾。
     *
     * 计费口径必须与 App 路径一致（字节数，不是字符数）；截断标记同理：输出顶到上限
     * 就报 truncated —— 否则调用方以为拿到了全部输出。
     */
    private static void chargeExecOutput(JSONObject r, long reserved) {
        if (r == null) {
            return;
        }
        try {
            String out = r.optString("out", "");
            String err = r.optString("err", "");
            int outBytes = utf8Len(out);
            int errBytes = utf8Len(err);
            boolean outTrunc = outBytes >= EXEC_STDOUT_MAX;
            boolean errTrunc = errBytes >= EXEC_STDERR_MAX;
            long actual = (long) outBytes + (long) errBytes;
            // 结算：按实际用量计（与 App 路径同口径），并把「预留 − 实际」的差额退回去。
            charge(actual, 0, 0);
            refund(reserved - actual);
            r.put("out_bytes", outBytes);
            r.put("err_bytes", errBytes);
            r.put("out_truncated", outTrunc);
            r.put("err_truncated", errTrunc);
            if (outTrunc || errTrunc) {
                r.put("truncated", true);
            }
        } catch (Throwable ignored) {
            /* 计费失败不阻断执行——但结果里会缺截断标记，调用方按未截断处理 */
        }
    }

    /**
     * 退回「预留上界 − 实际用量」的差额。余额不会跌破 0。
     */
    private static void refund(long bytes) {
        if (bytes <= 0) {
            return;
        }
        long left = SESSION_BYTES.addAndGet(-bytes);
        if (left < 0) {
            SESSION_BYTES.set(0);
        }
    }

    /**
     * UTF-8 字节数，不分配新数组（{@code s.getBytes("UTF-8").length} 会为 1MB 输出
     * 再申请 1MB）。与 App 路径的 {@code out.size()} 同口径：字节，不是字符。
     */
    private static int utf8Len(String s) {
        if (s == null || s.isEmpty()) {
            return 0;
        }
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x80) {
                n += 1;
            } else if (c < 0x800) {
                n += 2;
            } else if (Character.isHighSurrogate(c) && i + 1 < s.length()
                    && Character.isLowSurrogate(s.charAt(i + 1))) {
                n += 4;
                i++;
            } else {
                n += 3;
            }
        }
        return n;
    }

    /**
     * The actual Shizuku call, on its own thread so the caller can bound it.
     *
     * @return the JSON envelope to hand back, or null when the channel is not
     *         usable. Kotlin's Triple exposes component1/2/3 as
     *         getFirst/getSecond/getThird, which is how it is read here.
     */
    private static String runShizuku(Context c, String cmd, long budgetMs) {
        try {
            // execViaShizuku returns Triple(out, err, exit) or null.
            // 预算与调用方一致：原来这里写死 120000L，于是调用方的 timeoutSec（如 20s）
            // 在提权侧**完全无效**——命令在提权侧可以跑到 120 秒。
            Object triple = com.khyos.khy_os_client.ShizukuServiceManager
                    .execViaShizuku(c, cmd, budgetMs);
            if (triple == null) {
                return null;
            }
            // Triple is a Kotlin data class; read it by reflection-free component
            // access through its toString is unreliable, so use the generated
            // getFirst/getSecond/getThird.
            String out = (String) triple.getClass().getMethod("getFirst").invoke(triple);
            String err = (String) triple.getClass().getMethod("getSecond").invoke(triple);
            int code = ((Number) triple.getClass().getMethod("getThird").invoke(triple)).intValue();
            return new JSONObject().put("ok", code == 0).put("exit", code)
                    .put("out", out == null ? "" : out)
                    .put("err", err == null ? "" : err).toString();
        } catch (Throwable bad) {
            return null;
        }
    }

    private static Thread pump(final InputStream is, final ByteArrayOutputStream sink, final int cap) {
        return new Thread(new Runnable() {
            public void run() {
                try {
                    byte[] b = new byte[4096];
                    int n;
                    while ((n = is.read(b)) > 0) {
                        synchronized (sink) {
                            if (sink.size() < cap) sink.write(b, 0, Math.min(n, cap - sink.size()));
                        }
                    }
                } catch (Throwable ignored) {}
            }
        });
    }

    private static boolean deleteTree(File f) {
        if (!f.exists()) return true;
        if (f.isDirectory()) {
            File[] cs = f.listFiles();
            if (cs != null) for (File c : cs) deleteTree(c);
        }
        return f.delete();
    }

    /**
     * 递归复制，带文件数上限。
     *
     * 原来是无限递归：`cp /sdcard/DCIM /data/x` 能把整个相册静默复制完毕，
     * 而调用方拿到的只有一个 `ok:true`——没有计数、没有截断标记、没有确认。
     * 它不"读出"数据，所以字节预算管不到它；文件数是唯一能事前约束的量。
     *
     * @param counter 1 元素的计数器，[copied, truncated]。复制中途达上限即停，
     *                并把 truncated 置 true——让调用方知道还有没复制的。
     * @param cap     本次允许复制的文件数上限。取单次上限与本轮剩余额度的较小者：
     *                只看单次上限时，本轮额度会被一次整树复制吃掉近两倍。
     */
    private static boolean copyTree(File s, File d, int[] counter, int cap) throws Exception {
        if (counter[1] != 0) return false; // 已截断，不再继续
        if (s.isDirectory()) {
            if (!d.exists() && !d.mkdirs()) return false;
            File[] cs = s.listFiles();
            if (cs != null) {
                for (File c : cs) {
                    if (counter[0] >= cap) {
                        counter[1] = 1; // truncated
                        return true;    // 已复制部分是有效的，不算失败
                    }
                    if (!copyTree(c, new File(d, c.getName()), counter, cap)) return false;
                }
            }
            return true;
        }
        File parent = d.getParentFile();
        if (parent != null) parent.mkdirs();
        FileInputStream in = new FileInputStream(s);
        FileOutputStream out = new FileOutputStream(d);
        byte[] b = new byte[65536];
        int n;
        while ((n = in.read(b)) > 0) out.write(b, 0, n);
        in.close();
        out.close();
        counter[0]++;
        return true;
    }
}
