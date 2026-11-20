package com.khyos.khy_os_client

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Base64
import android.util.Log

import com.khyos.khy_os_client.bridge.AmooLoop

import org.json.JSONObject

import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AmooApexLink — khy-os 侧的 apex 视图桥客户端。
 *
 * 它和 [AmooLoop]（无障碍反代）是**同一条业务协议的两种传输**：都是 ask/askResult/stop
 * 三步、都是单飞、都是 15s..1800s 预算。差别只在底下那一层：
 *
 *   · AmooLoop 走无障碍服务，要求 Amoo 在前台，且要用户手动开无障碍；
 *   · 本类走 StepOSViewContentUtils.apexRequest，由独立 app com.khyos.amoomitm
 *     （targetSdk 26）代为 invoke——hidden API 对 targetSdk>=28 是拒的，而 khy-os
 *     自己 targetSdk 33，所以在自己进程里调不了。
 *
 * 运输层为什么是 ContentProvider 而不是广播：StepOS 在**入队时**就丢掉「第三方 app →
 * 后台第三方 app」的广播，接收方挂前台服务也不豁免（dumpsys activity broadcasts 原话：
 * `skipped by policy at enqueue: Background execution not allowed 3rd app`）。
 * adb shell 发的广播带一个 shell 专有 flag 所以能过——这就是 PC 驱动
 * （tools/khy-bridge/amoo-apex.js）能用、而 App 内这条路径静默失败的原因。
 * ContentProvider 是唯一不在该策略管辖范围内的跨 App IPC。
 *
 * 另外：apex 的捕获管理器取的是当前焦点窗口，所以 Amoo 必须占着前台；而 StepOSFreeze
 * 会在 amoomitm 失去前台约 6 秒后把它冻住。一次 apex 调用只要一秒量级，所以每步一个
 * provider 调用、步与步之间由本类轮询（本进程有前台服务撑着，不会被打断）。
 *
 * 放在 com.khyos.khy_os_client 包而不是 bridge 包：MainActivity 的 amoo 冻结字面量块
 * 按行号登记，加一个 import 会把整块推下去。
 */
object AmooApexLink {

    private const val TAG = "AmooApexLink"

    /** provider 没起来时 tickOnce 返回的哨兵。见 tickOnce 的注释。 */
    private val ERR_PROVIDER: JSONObject by lazy {
        JSONObject().put("ok", false).put("error", ERR_PROVIDER_ERROR)
    }
    private const val ERR_PROVIDER_ERROR = "apex-bridge-provider-down"

    private const val APEX_PKG = "com.khyos.amoomitm"

    // 与 MainActivity 的 AMOON_* 同组常量（那边按行号冻结，不能加行）。
    private const val AMOON_PACKAGE = "com.stepos.ailauncher"
    private const val AMOON_CHAT_ACTIVITY = "com.stepos.ailauncher.chat.activity.ChatMainActivity"
    private const val AMOO_OPEN_CHAT = "com.stepos.ailauncher.action.OPEN_CHAT"

    /**
     * com.khyos.amoomitm 里 TickProvider 的 authority。两边必须一致，而它跨进程序列，
     * 所以这里写字面量并在注释里点名另一侧的文件——没有编译期保证，改一侧漏另一侧
     * 的表现是「provider 调用失败」，日志里能看到。
     */
    private val TICK_URI = android.net.Uri.parse("content://com.khyos.amoomitm.tick")

    /**
     * 两次读气泡之间的间隔。
     *
     * 4s → 2.5s（2026-11-11）：一轮 apex 调用本身约 2.6s，其中 1.5s 是
     * ApexHost.tick 里的固定 sleep，所以 4s 间隔里真正在等 Amoo 的只有不到 1s。
     * 降到 2.5s 后长回复的首字到达时间大致减半，而「读到半句」的风险没变——
     * 防半句靠的是取最长版本，不是靠间隔。
     */
    private const val READ_INTERVAL_MS = 2_500L

    private const val MIN_BUDGET_MS = 15_000L
    private const val MAX_BUDGET_MS = 1_800_000L

    /**
     * 提问前的基线采样次数。
     *
     * 1 → 2（2026-11-16）：apex 读一次并不稳定，同一轮里可能返回最新气泡也可能返回
     * 更旧的那个。单次采样漏掉后一种，循环就会把更旧的残留当成新回复放行。
     * 代价是每轮提问多 2.5s（相对于 10s 量级的首字到达可忽略）。
     */
    private const val PRE_READS = 2

    /**
     * provider 没起来时的重试次数与每次间隔。
     *
     * 0→3 次、2.5s→3s（2026-11-16）：那个 app 没有任何常驻 activity，进程随时可能被
     * 系统回收；而 `startActivity` 之后 provider 的发布**不是瞬时的**——实测拉起后
     * 立刻调用仍报 `Unknown authority com.khyos.amoomitm.tick`，隔几秒才通。
     * 单次 2.5s 重试不够，表现就是「明明刚把桥拉起来，这一轮仍然失败」。
     */
    private const val BRIDGE_UP_RETRIES = 3
    private const val BRIDGE_UP_WAIT_MS = 3_000L

    @Volatile private var appContext: Context? = null

    @Volatile private var job: String? = null

    /**
     * 当前这一轮是不是走在 apex 上。
     *
     * 为什么必须有它：[result] 只在 apex 有任务时返回非 null，好让 MainActivity 的
     * `AmooApexLink.result() ?: AmooLoop.askResult()` 在该走无障碍时落到无障碍。
     * 只靠 `job != null` 判断是不够的：任务结束后 job 不清零（轮询方还要读那个
     * done/failed 终态），于是上一次 apex 的终态会一直挂在那里，把之后每一次
     * 无障碍提问的结果全遮住——用户看到的是上一个问题的答案。
     * 所以每次 ask() 一进来先把它置 false，真正启动 apex 时才置 true。
     */
    @Volatile private var apexActive = false

    @Volatile private var state: String = "idle"
    @Volatile private var reply: String = ""
    @Volatile private var error: String = ""
    @Volatile private var startedAt = 0L
    @Volatile private var budgetMs = 0L
    @Volatile private var stopped = false

    private val running = AtomicBoolean(false)

    fun isInstalled(ctx: Context): Boolean = try {
        val pi = ctx.packageManager.getPackageInfo(APEX_PKG, 0)
        // 装了但被停用 = 不可用。getPackageInfo 不看 enabled 状态，停用的包照样
        // 查得到——只看"查得到"就会把 amoo-direct 报成可用，而实际上一次都调不通。
        // 2026-11-15 T13 实测：pm disable-user com.khyos.amoomitm 之后
        // info.driver 仍然报 amoo-direct，正是这个原因。停用态必须算不可用，
        // 否则 info.driver 就从"事实"退化成了"包名存在性"。
        pi.applicationInfo?.enabled == true
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    /**
     * 发起一次提问。返回 job id，或 null。
     *
     * null 的三种含义由调用方（MainActivity.amooAsk）用既有判据分开：prompt 为空、
     * apex app 没装（→ 回退无障碍）、已有任务在跑（→ 单飞）。之所以能复用那套判据，
     * 是因为这三种情况下 AmooLoop 侧都没有任务，`AmooLoop.askResult()` 返回 null，
     * 既有的 `why` 判据自然会落到对应的桶里。
     */
    fun ask(ctx: Context, prompt: String, timeoutMs: Long): String? {
        val body = prompt.trim()
        // 本方法没真正启动 apex 任务，就把 apex 通道让出去。见 apexActive 的注释：
        // 不清的话，残留的 apex 终态会一直遮蔽无障碍路径的结果。
        apexActive = false
        if (body.isEmpty()) return null
        if (!running.compareAndSet(false, true)) return null
        if (!isInstalled(ctx)) {
            running.set(false)
            return null
        }
        appContext = ctx.applicationContext
        val id = "khy-" + UUID.randomUUID().toString()
        job = id
        apexActive = true
        // 两个「只试一次」的标志按轮重置。
        //
        // 它们原本是进程级一次性：第一轮 ask 触发过拉前台（foregroundedOnce）或拉桥
        // （apexActivityStarted）之后，后续每一轮都不再尝试——Amoo 的聊天页再被系统清出
        // 返回栈时，所有 ask 都以固定文案失败，直到 khy-os 进程重启。2026-11-16 实测：
        // 第一轮短回复能通，之后「找不到 Amoo 的窗口」「apex 桥没在运行」交替出现，
        // 手动把桥拉起来才能再通一次。类注释写明的意图是「Amoo 被清掉后的一次」，
        // 即按轮，不是按进程。
        foregroundedOnce = false
        apexActivityStarted = false
        state = "running"
        reply = ""
        error = ""
        stopped = false
        startedAt = System.currentTimeMillis()
        budgetMs = timeoutMs.coerceIn(MIN_BUDGET_MS, MAX_BUDGET_MS)
        Thread({
            try {
                runAsk(id, body)
            } catch (t: Throwable) {
                fail("apex 桥异常: " + t.javaClass.simpleName)
            } finally {
                running.set(false)
            }
        }, "amoo-apex-ask").apply { isDaemon = true }.start()
        return id
    }

    /**
     * 轮询一次。没有 apex 任务时返回 null，让调用方回落到 [AmooLoop.askResult]。
     *
     * 形状与 AmooLoop.askResult() 一致（ok/state/ms/reply|error），所以
     * MainActivity.amooAskResult 那段解析一行都不用改。
     */
    fun result(): JSONObject? {
        if (!apexActive) return null
        val out = JSONObject()
        out.put("ok", true)
        out.put("state", state)
        out.put("ms", if (startedAt > 0) System.currentTimeMillis() - startedAt else 0)
        if (state == "failed") out.put("error", error)
        if (state == "done") out.put("reply", reply)
        return out
    }

    /**
     * 把 apex 通道让出去，不起新任务。
     *
     * 降级重发用：Dart 侧直连断了改走读屏（MainActivity.amooAsk 的 route="screen"）
     * 时，这一轮不能再占着 apex 通道——[result] 只在 apexActive 时返回非 null，
     * 不清的话上一次 apex 的失败终态会一直遮住 AmooLoop 的结果（见 apexActive
     * 的注释）。而直接调 [ask] 会把 apex 任务真再启动一遍，等于把同一故障重演。
     */
    fun releaseChannel() {
        apexActive = false
    }

    /** 中断。已经发出去的提问收不回来，所以只把状态打到 failed。 */
    fun stopAsk() {
        if (job == null) return
        stopped = true
        state = "failed"
        error = "aborted"
    }

    // ── 内部 ────────────────────────────────────────────────────────────────

    /**
     * 窗口读不到时的错误文案。
     *
     * 注意这个文案说的「之后就能在后台用」是有条件的：Amoo 的聊天页只要还被系统留着
     * （刚开过、没被清出返回栈），apex 就确实能读到，不需要它在前台。但 Amoo 被杀过
     * 之后就不行了——那种情况本类会拉一次前台（见 [bringAmooForeground]）。
     */
    private fun amooWindowGone(): String =
        "读不到 Amoo 的窗口：它的聊天页已被系统清出返回栈。已尝试把它拉到前台重试；" +
            "若仍未成功，请手动打开 amoo 的聊天页后再提问。"

    /** apex 桥 app 自己没起来时的错误。和「读不到 Amoo」是两件事，处置也不同。 */
    private fun apexBridgeDown(): String =
        "apex 桥（com.khyos.amoomitm）没在运行，已尝试把它拉起。若仍不行，" +
            "请手动打开一次「AmooMITM」这个 app。"

    /**
     * 把 Amoo 的聊天页拉到前台。**整个 ask 期间最多一次。**
     *
     * 为什么需要它：apex 的捕获管理器要的是 Amoo 的**活窗口**。Amoo 刚退到后台时窗口
     * 还在，读得到；等系统把它的 activity 清出返回栈，就什么都读不到了——三次 apex
     * 调用全部 12s 超时，且 Amoo 进程里没有任何 ApexTarget 日志。
     *
     * 为什么只拉一次：用户明确要求过 Amoo 不要被反复弹到前台。所以这里是"先试后台，
     * 真读不到才打扰一次"——打扰次数从"每次提问"降到"Amoo 被清掉后的一次"。
     *
     * 为什么由本进程做而不是 amoomitm：那是个后台 app（只有 provider + 前台服务，
     * 没有可见 activity），Android 10+ 禁止后台 app 启动 activity，它内部那次
     * startActivity 是静默失败的。本 App 持有 SYSTEM_ALERT_WINDOW，从前台发得起。
     */
    private fun bringAmooForeground(ctx: Context) {
        if (foregroundedOnce) return
        foregroundedOnce = true
        try {
            val i = Intent(AMOO_OPEN_CHAT)
            i.setClassName(AMOON_PACKAGE, AMOON_CHAT_ACTIVITY)
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(i)
            Log.e(TAG, "amoo window unreachable, brought it to front once")
        } catch (t: Throwable) {
            Log.e(TAG, "cannot bring Amoo to front: $t")
        }
    }

    /** 这一轮是否已经拉过一次前台。只拉一次：反复拉就等于把 Amoo 一直挂在最前面。 */
    private var foregroundedOnce = false

    private fun runAsk(id: String, prompt: String) {
        val ctx = appContext ?: run {
            fail("apex 桥没有 Context")
            return
        }
        // 前言与无障碍路径同源：AmooLoop.buildAskPreamble()。复制一份会让两条路漂，
        // 而漂了的前言要等 Amoo 开始拿你当陌生人说话时才被发现。
        val preamble = AmooLoop.buildAskPreamble()
        val text = if (preamble.isNotEmpty()) "$preamble\n\n$prompt" else prompt

        // 先试后台（不打扰）。只有确实拿不到 Amoo 的窗口时才拉一次前台重试。
        //
        // 提问前先采样当前聊天块，作为「旧内容」基线集。没有它，下面的读循环会把
        // 旧会话残留当成这一问的回复——2026-11-16 实测：问「从1数到60」，14 秒后
        // 拿到的是上一轮对话里的 {"tool":"ping"} +「换一个」，两次读取相等即交付
        // （stable>=1），用户看到的就是错内容。
        //
        // 为什么采样两次：apex 读一次并不稳定——同一轮里它有时返回最新气泡、有时
        // 返回更旧的那个（2026-11-16 复验：问 C 的循环读到比基线更旧的气泡，与基线
        // 不同于是被当成新内容放行）。采两份让「提问前就存在」的文本有更高概率被
        // 收进基线集。采样失败时基线集为空，那一轮退化成改动前的行为（不新增失败模式）。
        val baseline = LinkedHashSet<String>()
        for (i in 0 until PRE_READS) {
            if (i > 0) sleepQuietly(READ_INTERVAL_MS)
            val pre = tickOnce(ctx, "amoo_read", null, prompt, "$id#pre$i")
            if (pre != null && pre.optString("pkg") == AMOON_PACKAGE && pre.optBoolean("ok", false)) {
                val v = pre.optString("reply", "").trim()
                if (v.isNotEmpty()) baseline.add(v)
                // 诊断：apex 响方的完整形状只有这里能看见（apex app 的源码不在本仓），
                // 每轮只打第一次，便于判断响应里有没有比 reply 更可靠的「是不是这一问」
                // 信号可用。不打全文就会有下一个修法只能靠猜。
                if (i == 0) Log.i(TAG, "apex read shape: " + pre.toString().take(400))
            }
        }
        var sent = tickOnce(ctx, "amoo_send", text, null, "$id#send")
        if (isProviderDown(sent)) {
            // 不是 Amoo 的问题，是 apex 桥自己没起来。拉起来多重试几次再放弃，
            // 别让「刚拉起来、provider 还没发布」这一小段时间变成整轮失败。
            for (attempt in 1..BRIDGE_UP_RETRIES) {
                ensureApexBridgeUp(ctx)
                sleepQuietly(BRIDGE_UP_WAIT_MS)
                sent = tickOnce(ctx, "amoo_send", text, null, "$id#send")
                if (!isProviderDown(sent)) break
            }
        }
        if (sent == null || !sent.optBoolean("sent", false)) {
            bringAmooForeground(ctx)
            sent = tickOnce(ctx, "amoo_send", text, null, "$id#send")
        }
        if (sent == null || !sent.optBoolean("ok", false)) {
            return fail(if (isProviderDown(sent)) apexBridgeDown() else amooWindowGone())
        }
        if (!sent.optBoolean("sent", false)) {
            return fail("Amoo 窗口里没有输入框或发送钮（hasInput="
                + sent.optBoolean("hasInput", false)
                + ", hasSend="
                + sent.optBoolean("hasSend", false) + "）")
        }

        var prev = ""
        var stable = 0
        var missed = 0
        var best = ""
        while (!stopped && System.currentTimeMillis() - startedAt < budgetMs) {
            Thread.sleep(READ_INTERVAL_MS)
            var r = tickOnce(ctx, "amoo_read", null, prompt, "$id#read")
            // 读不到窗口：空回复不算（Amoo 还在想时 reply 本来就是空的），只有 apex 超时
            // 或窗口是别人的才算。攒够两次就拉一次前台重试，而不是直接判失败。
            if (r == null || r.optString("pkg") != AMOON_PACKAGE) {
                // provider 没起来：先把 amoomitm 拉起来重试。这不是 Amoo 的问题，
                // 不计入 missed，更不该去拉 Amoo 前台——那就白扰用户一次。
                if (isProviderDown(r)) {
                    // 同发送侧：拉起后 provider 不是瞬时发布的，多重试几次。
                    for (attempt in 1..BRIDGE_UP_RETRIES) {
                        ensureApexBridgeUp(ctx)
                        sleepQuietly(BRIDGE_UP_WAIT_MS)
                        r = tickOnce(ctx, "amoo_read", null, prompt, "$id#read")
                        if (!isProviderDown(r)) break
                    }
                    if (isProviderDown(r)) return fail(apexBridgeDown())
                    missed = if (r != null && r.optString("pkg") == AMOON_PACKAGE) 0 else missed + 1
                } else {
                    missed++
                }
                // 攒够两次真读不到，才拉一次 Amoo 前台重试
                if (missed >= 2) {
                    bringAmooForeground(ctx)
                    r = tickOnce(ctx, "amoo_read", null, prompt, "$id#read")
                    if (r == null || r.optString("pkg") != AMOON_PACKAGE) {
                        return fail(amooWindowGone())
                    }
                    missed = 0
                } else {
                    continue
                }
            }
            missed = 0
            if (!r.optBoolean("ok", false)) continue
            val cur = r.optString("reply", "").trim()
            if (cur.isEmpty()) continue
            // 与提问前采样一致 = 这一问还没开始答。旧会话残留正是这样被误当成回复的
            // （见 runAsk 开头 baseline 的注释）。
            if (baseline.isNotEmpty() && baseline.contains(cur)) continue
            // 取「见过最长的版本」。Amoo 的回复流式写进同一个气泡，而读的是可见
            // 区域——长回复滚动后前面会掉出视野，某一次 poll 可能比上一次读到得更少。
            // 不取最长的话，已经拿到手的后半句又被弄丢，用户看到的就是半截答案。
            if (cur.length > best.length) best = cur
            if (cur == prev) stable++ else {
                stable = 0
                prev = cur
            }
            if (stable >= 1) {
                done(best)
                return
            }
        }
        if (stopped) fail("aborted")
        else if (best.isEmpty() && baseline.isNotEmpty()) {
            // 读到的始终是提问前那一份：Amoo 没开始答，或窗口里停在一个旧会话上。
            // 说清「没拿到新内容」，别让它听起来像超时——两者的下一步动作不同。
            fail("回复未出现：读到的内容与提问前相同（Amoo 尚未开始回答，或窗口停在旧会话上）")
        } else fail("超时（${budgetMs}ms 内没拿到稳定回复）")
    }

    /**
     * 发一次广播并等它的结果回来。
     *
     * job 必须逐次不同：结果文件是共享存储上的一個固定路径，PC 驱动也在写它。
     * 不按 job 匹配就会把上一次（或 PC 那一次）的答案当成自己的。
     */
    /**
     * 发一次 apex 调用并等结果回来。
     *
     * 走 ContentProvider 而不是广播：StepOS 在**入队时**就丢掉「第三方 app → 后台第三方
     * app」的广播（dumpsys activity broadcasts 里原话是
     * `skipped by policy at enqueue: Background execution not allowed 3rd app`），
     * 接收方挂前台服务也不豁免。adb shell 发的广播带一个 shell 专有 flag 所以能过——
     * 这就是 PC 驱动能用、而 App 内这条路径静默失败的原因。
     * ContentProvider 是唯一不在该策略管辖范围内的跨 App IPC，所以运输层放在那里。
     *
     * 同步返回，所以没有结果文件、没有 job 匹配、也不会和 PC 驱动抢同一个文件。
     *
     * **返回值区分两种失败**，因为它们的处置完全不同：
     *   · [ERR_PROVIDER] —— provider 没起来（amoomitm 进程死了）。这不是 Amoo 的问题，
     *     拉 Amoo 前台没用，该做的是把 amoomitm 拉起来。
     *   · null —— provider 活着但这次 apex 没成功（超时 / 窗口不是 Amoo 的）。
     *     2026-11-12 实测：amoomitm 进程死时 provider 不发布，call() 直接返回 null，
     *     于是被误判成"读不到 Amoo 的窗口"，接着去拉 Amoo 前台——白扰一次用户还没修好。
     */
    private fun tickOnce(
        ctx: Context,
        op: String,
        text: String?,
        prompt: String?,
        job: String
    ): JSONObject? {
        val extras = Bundle()
        if (text != null) extras.putString("b64text", b64(text))
        if (prompt != null) extras.putString("b64prompt", b64(prompt))
        return try {
            val res = ctx.contentResolver.call(TICK_URI, op, job, extras)
            val json = res?.getString("json")
            if (json.isNullOrEmpty()) ERR_PROVIDER else JSONObject(json)
        } catch (t: Throwable) {
            Log.e(TAG, "provider call failed: $t")
            ERR_PROVIDER
        }
    }

    private fun isProviderDown(r: JSONObject?): Boolean =
        r != null && r.optString("error") == ERR_PROVIDER_ERROR

    /**
     * 把 amoomitm 拉起来，让它的 TickProvider 重新发布。
     *
     * 为什么需要：那个 app 没有任何常驻 activity，进程随时可能被系统回收。进程一死，
     * provider 就不发布，khy-os 这边所有调用全部返回 null——而这是可以自愈的，
     * 不该让用户看到一句"读不到 Amoo 的窗口"然后手动去开 app。
     *
     * **先发广播，不起 Activity**（2026-11-16 改）。amoomitm 的清单里有一个 exported 的
     * `.TickReceiver`，监听 `com.khyos.amoomitm.TICK`；adb 实测：桥进程死掉之后
     * `am broadcast -n com.khyos.amoomitm/.TickReceiver -a com.khyos.amoomitm.TICK`
     * 能把它拉起来（pid 从空到有，provider 随之发布）。这条路**不把任何 Activity
     * 搬到前台**，因此也不受 Android 10+「后台 app 不得启动 Activity」的限制——
     * 之前只靠 startActivity 的那一版，在 khy-os 处于后台时静默失败，重试多少次
     * 都一样（复验 4：重试跑了三次，bridge pid 始终为空）。
     *
     * 广播每次都发：它幂等（收到就把进程拉起来），而进程起来到 provider 发布有
     * 几百毫秒到几秒的延迟，多重发几次比只发一次管用。Activity 仍然保留为兜底，
     * 但只试一次——它在前台时才发得起，且会打扰用户。
     */
    private fun ensureApexBridgeUp(ctx: Context) {
        tickBridge(ctx)
        if (apexActivityStarted) return
        apexActivityStarted = true
        try {
            val i = Intent(Intent.ACTION_MAIN)
            i.setClassName(APEX_PKG, "$APEX_PKG.MainActivity")
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(i)
            Log.e(TAG, "apex bridge tick did not revive it, started com.khyos.amoomitm activity")
        } catch (t: Throwable) {
            Log.e(TAG, "cannot start com.khyos.amoomitm: $t")
        }
    }

    /**
     * 向 amoomitm 的 TickReceiver 发一次唤起广播。
     *
     * flag 都是**发送侧**声明，不需要任何权限：
     *   · FLAG_INCLUDE_STOPPED_PACKAGES（公开常量）—— 让广播抵达被 force-stop 置为
     *     stopped 的 app（不带的话，stopped 应用的 manifest receiver 收不到任何广播）；
     *   · 0x01000000 —— 即 Intent.FLAG_RECEIVER_INCLUDE_BACKGROUND，让它在后台广播
     *     限额下仍然投递（StepOS 对「第三方 → 后台第三方」的广播有入队时丢弃的策略）。
     *     这个常量在 SDK 里是 @hide，按名字引用编译不过，所以写字面值并在这里点名。
     * 显式指定组件：receiver 是 exported 的，且显式广播本就不受隐式广播限制管辖。
     */
    private fun tickBridge(ctx: Context): Boolean {
        return try {
            val i = Intent("$APEX_PKG.TICK")
            i.component = ComponentName(APEX_PKG, "$APEX_PKG.TickReceiver")
            i.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
            i.addFlags(0x01000000) // Intent.FLAG_RECEIVER_INCLUDE_BACKGROUND (@hide)
            ctx.sendBroadcast(i)
            Log.i(TAG, "sent TICK to amoomitm.TickReceiver")
            true
        } catch (t: Throwable) {
            Log.e(TAG, "tick broadcast failed: $t")
            false
        }
    }

    /** Activity 兜底启动是否已试过。广播每次都会发，这条路只试一次。 */
    private var apexActivityStarted = false

    /** 等一会，让被拉起的进程把 provider 发布出来。 */
    private fun sleepQuietly(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    /**
     * base64 是必须的：跨进程序列化的内容本身不会被改，但这条链上的任何一环（日志、
     * adb 重放）按空格分词都会把中文 payload 截成第一个词。PC 驱动实测过：发中文前言
     * 只送出「你是」两个字。 provider 这条路不经过 shell，但仍然编码—— payload 的
     * 形状不该取决于当前选中的是哪条运输层。
     */
    private fun b64(s: String): String =
        Base64.encodeToString(s.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

    private fun done(r: String) {
        reply = r
        error = ""
        state = "done"
    }

    private fun fail(why: String) {
        reply = ""
        error = why
        state = "failed"
    }
}
