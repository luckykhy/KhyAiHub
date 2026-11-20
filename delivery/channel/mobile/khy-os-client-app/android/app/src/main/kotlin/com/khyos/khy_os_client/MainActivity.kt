package com.khyos.khy_os_client

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.WindowManager
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.MethodCall
import org.json.JSONArray
import org.json.JSONObject
import com.khyos.khy_os_client.bridge.KhyConsole
import com.khyos.khy_os_client.bridge.LoopModes
import com.khyos.khy_os_client.bridge.AmooLoop
import com.khyos.khy_os_client.bridge.BridgeOverlayService
import com.khyos.khy_os_client.bridge.BridgeService
import com.khyos.khy_os_client.bridge.BridgeLinkState
import com.khyos.khy_os_client.bridge.BridgeDriverState
import com.khyos.khy_os_client.bridge.DeviceIdentity
import com.khyos.khy_os_client.bridge.DriverGate
import com.khyos.khy_os_client.bridge.HttpBridge
import com.khyos.khy_os_client.bridge.NetCapture
import com.khyos.khy_os_client.bridge.ShellLevelPolicy
import com.khyos.khy_os_client.bridge.ShellSidecarClient
import com.khyos.khy_os_client.bridge.Tools
import com.khyos.khy_os_client.engine.LocalVisionServer
import com.khyos.khy_os_client.shell.ElevationBootstrap
import com.khyos.khy_os_client.shell.ElevationState
import com.khyos.khy_os_client.terminal.ShellRunner
import com.khyos.khy_os_client.terminal.TerminalShell
import com.khyos.khy_os_client.vfs.VfsBridge
import java.io.File
import java.util.concurrent.Executors

class MainActivity : FlutterActivity() {
    private val CHANNEL = "com.khyos.khy_os_client/device"
    /**
     * shell 执行池。
     *
     * 原来用 newCachedThreadPool()：**无上限**。每个 shell 任务都占着一条线程直到子进程
     * 结束（慢命令叠加时会无限增生），线程各带一个 Process 与两条管道缓冲，于是 App 被
     * 推进内存压力/ANR，而且没有任何背压。改成固定 4 条线程：超出部分排队（排队即背压），
     * 不会再无限开线程。
     */
    private val exec = Executors.newFixedThreadPool(4)

    // Shell command whitelist（AI 与设备控制通道）。改动这里必须保持行数不变：下方 amoo 冻结字面量块按行号登记，插一行整块就漂。
    private val SHELL_ALLOW = arrayOf(
        "am start ", "am force-stop ", "am kill ",
        "wm size", "wm density",
        "dumpsys ",
        "pm list packages", "pm path ", "pm dump ",
        "settings get ", "settings put ",
        "input tap ", "input swipe ", "input text ", "input keyevent ",
        "screencap ",
        "ls ", "cat ", "echo ", "mkdir ", "rm ", "mv ", "cp ",
        "ps ", "kill ", "logcat ", "getprop ", "ip addr show ",  // logcat/getprop/ip addr：android 工具的读日志、读属性、读网卡地址子命令，此前这些子命令在真机上被自家闸门拒
    )
    /**
     * 允许安装 APK 的根目录。
     *
     * 两个，对应两种来路：
     *   - Download：用户或 Agent 从浏览器/云端把 apk 放下来的地方
     *   - khy-os 工作空间：Agent 自己出包、自己装的自举闭环
     * 故意不含 /sdcard 根和 /data：前者太宽，后者是别人的私有目录。
     */
    private val APK_INSTALL_ROOTS = arrayOf(
        "/sdcard/Download",
        "/sdcard/khy-os"
    )

    private val SHELL_DENY = arrayOf(
        // rm 家族交给 [ShellCommandPolicy] 的形状层判：拼写层前缀太粗，"rm -rf /"
        // 会把 "rm -rf /storage/…/旧目录" 一并拒掉（主功能发不出去）。
        "shutdown", "reboot", "stop", "restart",
        "format", "mkfs", "dd if=", "iptables", "mount ", "umount ",
    )

    // ── 系统分享／选中文字入口 ──
    //
    // WHY A FIELD AND NOT AN INTENT EXTRA READ ON DEMAND. `launchMode` is
    // `singleTop` and `taskAffinity` is empty, so a second share into an
    // already-running activity arrives as `onNewIntent` rather than a fresh
    // `onCreate`. Reading `intent` lazily from the Flutter side would therefore
    // return the FIRST share's text forever — the second one would be silently
    // dropped, and the symptom is "I shared something and nothing happened".
    //
    // So the latest text is captured into a field by both entry points, and
    // `consumeSharedText` reads and clears it. "Consume" rather than "read"
    // because a share is an event, not a state: re-reading the same text on
    // every resume would replay an old share into whatever the user is doing
    // now.
    @Volatile
    private var sharedText: String? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        // Text shared into a cold app arrives on the launch intent, which is
        // already set by the time this runs. Capturing it here (rather than only
        // in onNewIntent) is what makes the FIRST share work; onNewIntent covers
        // every later one.
        captureIncomingText(intent)

        // 恢复用户上次挑的工作空间根。必须在任何文件工具被调用之前——
        // 恢复晚了，冷启动后第一次 list_files 会落在私有目录，而用户挑过的
        // 是别处，那种偏差没有任何报错。
        workRoot = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_WORK_ROOT, null)

        // 桥随 App 走：装了这个 App，PC 侧 khy-os 就能通过它操作手机。
        // 悬浮框连带拉起（BridgeService.onCreate），没有悬浮窗权限时悬浮框
        // 自己不画、桥照常工作——两者可各自存活。
        BridgeService.start(this)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                // --- App / URL ---
                "openApp" -> openApp(call.argument<String>("packageName") ?: "", result)
                "openUrl" -> openUrl(call.argument<String>("url") ?: "", result)
                "searchApps" -> searchApps(call.argument<String>("query") ?: "", result)
                "listApps" -> listApps(result)

                // --- Shared text (system share sheet / 选中文字菜单) ---
                "consumeSharedText" -> consumeSharedText(result)
                "consumePendingRoute" -> result.success(consumePendingRoute())
                "processTextEntryEnabled" -> processTextEntryEnabled(result)
                "setProcessTextEntryEnabled" -> setProcessTextEntryEnabled(
                    call.argument<Boolean>("enabled") == true, result)

                // --- Screenshot ---
                //
                // Two routes, deliberately both present. The accessibility one is
                // tried first by the caller because it needs no extra consent;
                // this one is the MediaProjection fallback for devices where
                // takeScreenshot is unavailable or fails.
                "a11yScreenshot" -> a11yScreenshot(result)

                // --- Clipboard ---
                "getClipboard" -> getClipboard(result)
                "setClipboard" -> setClipboard(call.argument<String>("text") ?: "", result)

                // --- Device ---
                "getDeviceInfo" -> getDeviceInfo(result)
                "vibrate" -> vibrate(call.argument<Int>("duration") ?: 200, result)
                "getInstalledPackages" -> getInstalledPackages(result)

                // --- Accessibility Service ---
                "isAccessibilityReady" -> result.success(mapOf("ready" to KhyAccessibilityService.isReady()))
                "openAccessibilitySettings" -> openAccessibilitySettings(result)
                // 一键开关。写 Settings.Secure 要 uid 2000，而 MethodChannel 的
                // handler 跑在主线程上——同步等会把 UI 占死（见下面 shell() 里
                // 同一段注释）。所以走 exec 线程池，回来再回主线程回话。
                "enableAccessibility" -> exec.execute {
                    // userConfirmed = true, and this is the ONLY call site that
                    // may pass it. The Dart settings screen shows a confirmation
                    // dialog spelling out what is granted and where to undo it
                    // before it invokes this channel; that dialog is what makes
                    // this a decision rather than a request. Every other caller
                    // (boot path, watchdog, bridge) restores a choice already
                    // made, and must not re-arm the consent flag — otherwise a
                    // silent restore would become a permanent grant.
                    val a = AccessibilitySetup.enable(this, true)
                    runOnUiThread {
                        result.success(mapOf(
                            "ok" to a.ok, "via" to a.via,
                            "already" to a.already, "reason" to a.reason))
                    }
                }
                "disableAccessibility" -> exec.execute {
                    val a = AccessibilitySetup.disable(this)
                    runOnUiThread {
                        result.success(mapOf(
                            "ok" to a.ok, "via" to a.via,
                            "already" to a.already, "reason" to a.reason))
                    }
                }
                // channelAdvice 读的是提权代理的缓存状态；和上面两个一样走
                // exec 线程池，不占住主线程。
                "accessibilitySetupAdvice" -> exec.execute {
                    val advice = AccessibilitySetup.channelAdvice(this)
                    runOnUiThread { result.success(mapOf("advice" to advice)) }
                }
                // 重装后自动恢复。读写的是同一个 SharedPreferences 键，
                // 原生侧 restoreIfConsented 也读它——两边必须是同一处，
                // 否则 UI 上显示「已开」而恢复逻辑看不到，用户白同意一场。
                "isA11yAutoRestoreOn" -> result.success(
                    mapOf("on" to AccessibilitySetup.isAutoRestore(this)))
                "setA11yAutoRestore" -> {
                    val on = call.argument<Boolean>("on") ?: false
                    val ok = AccessibilitySetup.setAutoRestore(this, on)
                    result.success(mapOf("ok" to ok))
                }
                "openDirectory" -> openDirectory(call.argument<String>("path") ?: "", result)
                "a11yTap" -> a11yTap(call.argument<Int>("x") ?: 0, call.argument<Int>("y") ?: 0, result)
                "a11ySwipe" -> a11ySwipe(
                    call.argument<Int>("x1") ?: 0, call.argument<Int>("y1") ?: 0,
                    call.argument<Int>("x2") ?: 0, call.argument<Int>("y2") ?: 0,
                    call.argument<Int>("durationMs") ?: 300, result)
                "a11yFindAndClick" -> a11yFindAndClick(call.argument<String>("query") ?: "", result)
                "a11yFindAndLongClick" -> a11yFindAndLongClick(call.argument<String>("query") ?: "", result)
                "a11yFindWithBounds" -> a11yFindWithBounds(call.argument<String>("query") ?: "", result)
                "a11yDumpUi" -> a11yDumpUi(result)
                "a11yListClickable" -> a11yListClickable(result)
                "a11yTypeText" -> a11yTypeText(call.argument<String>("text") ?: "", result)
                "a11yGlobalAction" -> a11yGlobalAction(call.argument<Int>("action") ?: 1, result)

                // --- Permissions ---
                "checkPermissions" -> checkPermissions(result)
                "requestNotifications" -> requestNotifications(result)
                "requestOverlay" -> requestOverlay(result)
                "requestAccessibility" -> requestAccessibility(result)

                // --- 电池白名单 / 后台运行引导 ---
                //
                // 这一族方法**只用于提示与引导**：返回值不进任何功能开关。
                // 无障碍掉线不该让 App 罢工，正确做法是把该放行的权限引导用户
                // 去放行，然后继续干活。
                "batteryStatus" -> result.success(
                    com.khyos.khy_os_client.battery.BatteryStatusInspector.inspect(this).toMap())
                "batteryGuideSteps" -> {
                    val st = com.khyos.khy_os_client.battery.BatteryStatusInspector.inspect(this)
                    result.success(
                        com.khyos.khy_os_client.battery.BatteryGuidance.stepsWithState(this, st))
                }
                "openBatteryGuideStep" -> {
                    val r = com.khyos.khy_os_client.battery.BatteryGuidance.openStep(
                        this, call.argument<String>("stepId") ?: "")
                    result.success(r)
                }
                "requestIgnoreBatteryOptimizations" -> {
                    val r = com.khyos.khy_os_client.battery.BatteryGuidance
                        .requestIgnoreBatteryOptimizations(this)
                    result.success(r)
                }
                "batteryPromptState" -> {
                    val st = com.khyos.khy_os_client.battery.BatteryStatusInspector.inspect(this)
                    val map = com.khyos.khy_os_client.battery.BatteryPromptStore.state(this)
                    map["shouldPrompt"] =
                        com.khyos.khy_os_client.battery.BatteryPromptStore.shouldPrompt(this, st)
                    map["status"] = st.toMap()
                    result.success(map)
                }
                "dismissBatteryPrompt" -> {
                    com.khyos.khy_os_client.battery.BatteryPromptStore.markDismissed(this)
                    result.success(mapOf("ok" to true))
                }
                "completeBatteryPrompt" -> {
                    com.khyos.khy_os_client.battery.BatteryPromptStore.markCompleted(this)
                    result.success(mapOf("ok" to true))
                }
                "clearBatteryPromptRecord" -> {
                    com.khyos.khy_os_client.battery.BatteryPromptStore.clear(this)
                    result.success(mapOf("ok" to true))
                }
                "markBatteryStepDone" -> {
                    com.khyos.khy_os_client.battery.BatteryPromptStore
                        .markStepDone(this, call.argument<String>("stepId") ?: "")
                    result.success(mapOf("ok" to true))
                }
                "clearBatteryStepDone" -> {
                    com.khyos.khy_os_client.battery.BatteryPromptStore
                        .clearStepDone(this, call.argument<String>("stepId") ?: "")
                    result.success(mapOf("ok" to true))
                }
                "openBatteryAppDetails" -> result.success(mapOf(
                    "opened" to com.khyos.khy_os_client.battery.BatteryGuidance
                        .startAppDetails(this)))

                // --- Screen Capture ---
                "isScreenCaptureReady" -> result.success(mapOf("ready" to ScreenCaptureService.isReady()))
                "startScreenCapture" -> startScreenCapture(result)
                "captureFrame" -> captureFrame(result)
                "getScreenMetrics" -> getScreenMetrics(result)
                "stopScreenCapture" -> stopScreenCapture(result)

                // --- Built-in inference engine (local vision, no Ollama) ---
                // Loading a 2.8 GB model takes seconds and must not block the
                // platform thread, so both of these go through the exec pool
                // like the shell and accessibility-elevation handlers above.
                "startLocalVision" -> exec.execute {
                    val a = startLocalVision(
                        call.argument<String>("modelPath") ?: "",
                        call.argument<String>("mmprojPath") ?: "",
                        call.argument<Int>("port") ?: 0)
                    runOnUiThread { result.success(a) }
                }
                "stopLocalVision" -> {
                    LocalVisionServer.get().stop()
                    result.success(mapOf("ok" to true))
                }
                "localVisionStatus" -> result.success(localVisionStatus())

                // --- Shell ---
                "shell" -> shell(
                    call.argument<String>("command") ?: "",
                    call.argument<Int>("timeout") ?: 30,
                    result
                )

                // --- 终端（人工命令区）---
                //
                // 单独一个入口，不复用上面的 shell：上面那条是 AI 与设备控制用的，
                // 白名单收得紧才安全；终端是人手动敲的，需要能敲 df -h、find . -name *.apk。
                // 共用一份白名单只有两种结局——终端像摆设（真机上 ls 都发不出去），
                // 或者把 AI 通道一起放宽。两边都不接受，所以拆开，策略各归各。
                "terminalShell" -> terminalShell(
                    call.argument<String>("command") ?: "",
                    call.argument<String>("cwd"),
                    call.argument<Int>("timeout") ?: 30,
                    result
                )

                // --- 提权（自有 uid-2000 代理，不依赖任何第三方提权应用） ---
                "elevationStatus" -> elevationStatus(result)
                "elevatedShell" -> elevatedShell(
                    call.argument<String>("command") ?: "",
                    call.argument<Int>("timeout") ?: 30,
                    result
                )
                "elevationBootstrap" -> elevationBootstrap(result)
                "elevationDiscover" -> elevationDiscover(result)
                "elevationEndpoint" -> elevationEndpoint(
                    call.argument<String>("endpoint"),
                    result
                )
                "elevationPair" -> elevationPair(
                    call.argument<String>("code") ?: "",
                    result
                )
                // 配对码走通知栏（实测 2026-11-18：一切回 App 配对弹窗就没了，
                // 通知栏不会）。这里只负责把那条带内联输入的通知发出去。
                "postPairingPrompt" -> postPairingPrompt(result)
                "elevationSetEnabled" -> elevationSetEnabled(
                    call.argument<Boolean>("enabled") ?: false,
                    result
                )
                // 提权自举的桥入口。与 Flutter 引导页共用 ElevationBootstrap 的
                // 同一份实现——UI 点得动、桥调得动，说的才是同一件事。
                "elevateTool" -> elevationTool(
                    call.argument<String>("op") ?: "status",
                    call.argument<String>("code") ?: "",
                    call.argument<String>("endpoint") ?: "",
                    result
                )
                "openWirelessDebuggingSettings" -> openWirelessDebuggingSettings(result)
                // 旧方法名：Flutter 侧未 rebuild 的老包仍在调它。留着转调，
                // 不然那边会静默收不到回执。
                "openDeveloperSettings" -> openWirelessDebuggingSettings(result)

                // --- File System ---
                "getWorkDir" -> result.success(workDirInfo())
                "setWorkRoot" -> setWorkRoot(call.argument<String>("path"), result)
                "fileList" -> result.success(fileList(call.argument<String>("path") ?: ""))
                "fileRead" -> result.success(fileRead(call.argument<String>("path") ?: ""))
                "fileWrite" -> fileWrite(
                    call.argument<String>("path") ?: "",
                    call.argument<String>("content") ?: "",
                    result
                )
                "fileCreateDir" -> result.success(fileCreateDir(call.argument<String>("path") ?: ""))
                "fileEdit" -> fileEdit(
                    call.argument<String>("path") ?: "",
                    call.argument<String>("oldText") ?: "",
                    call.argument<String>("newText") ?: "",
                    call.argument<Boolean>("replaceAll") ?: false,
                    result
                )
                "fileFind" -> result.success(fileFind(
                    call.argument<String>("dir") ?: "",
                    call.argument<String>("pattern") ?: "*",
                    call.argument<Int>("maxResults") ?: 50
                ))
                "fileGrep" -> result.success(fileGrep(
                    call.argument<String>("dir") ?: "",
                    call.argument<String>("regex") ?: "",
                    call.argument<String>("filePattern") ?: "",
                    call.argument<Int>("maxResults") ?: 30
                ))

                // --- khy-os 桥（原 StepBridge 并入本 App） ---
                "bridgeStatus" -> bridgeStatus(result)
                "bridgeStart" -> bridgeStart(result)
                "bridgeStop" -> bridgeStop(result)
                "overlayShow" -> overlayShow(result)
                "overlayHide" -> overlayHide(result)
                "requestAllFiles" -> requestAllFiles(result)
                // 出向链路（断点一）：Dart 侧持有 ws 客户端，原生侧只存「链路此刻
                // 什么状态」这一份事实，供 status.json / pc_reachable 读取。
                // 配置走文件（PC 侧写 link_target.txt），因为它是「PC 在哪」而不是
                // 凭据——凭据仍然只有 token 一处。
                "bridgeLinkConfig" -> bridgeLinkConfig(result)
                "bridgeLinkState" -> bridgeLinkState(result, call)

                // --- 断点五：抓包改写（仅调试菜单）---
                // 这三条是「人」的入口，不是 agent 的入口：解锁位只有这里能写，
                // 工具侧只读它。agent 调不动 debug_only 的判定，这是故意的。
                "netDebugState" -> result.success(mapOf(
                    "unlocked" to NetCapture.debugUnlocked(this),
                    "vpn_supported" to (Build.VERSION.SDK_INT >= 29),
                ))
                "netDebugUnlock" -> {
                    val want = call.argument<Boolean>("unlocked") ?: true
                    NetCapture.setDebugUnlocked(this, want)
                    result.success(mapOf("ok" to true,
                        "unlocked" to NetCapture.debugUnlocked(this)))
                }
                "netCaptureStart" -> netCaptureStart(call, result)
                "netCaptureStop" -> netCaptureReply(result) { NetCapture.stop("menu") }
                "netCaptureStatus" -> netCaptureReply(result) { NetCapture.status() }
                "netCaptureExport" -> netCaptureReply(result) { NetCapture.export() }
                // self+tls 档的证书出口。只写证书不写私钥，且只落到 Download——
                // 装不装是用户在系统设置里自己决定的事，我们从不代装（§10）。
                "netCaptureExportCa" -> netCaptureReply(result) { NetCapture.exportCa() }

                // --- 微信 bot 通道前台服务（保活壳，轮询在 Dart 侧） ---
                "wechatStart" -> wechatStart(result)
                "wechatStop" -> wechatStop(result)

                // --- amoo（本机 Intent；与 PC 的 khy-amoon-bridge 无关） ---
                "amooStatus" -> amooStatus(result)

                // 屏幕常亮手动开关。与反代提问期间自动加的那个 flag 是同一个
                // flag——所以手动开、提问期间自动保持、提问结束手动仍然有效，
                // 三者不会互相抵消。
                // 桥的工具清单。
                //
                // 为什么经通道取而不是在 Dart 里抄一份：Tools.NAMES 是契约，
                // 手抄的列表会在加工具的那一刻开始说谎，而失败模式很隐蔽——
                // 界面列出一个桥上没有的工具，用户点了才知道没有。
                // 让界面直接问桥要，就没有"抄"这个环节。
                "bridgeTools" -> {
                    result.success(mapOf(
                        "ok" to true,
                        "tools" to com.khyos.khy_os_client.bridge.Tools.NAMES.toList(),
                        "sidecar" to com.khyos.khy_os_client.bridge.ShellSidecarClient.ready(),
                        "sidecar_why" to com.khyos.khy_os_client.bridge.ShellSidecarClient.why(),
                    ))
                }

                "keepAwake" -> {
                    val on = call.argument<Boolean>("on") ?: false
                    runOnUiThread {
                        if (on) {
                            window.addFlags(
                                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        } else {
                            window.clearFlags(
                                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        }
                    }
                    result.success(mapOf("ok" to true, "on" to on))
                }

                // 安装 APK。单独一个入口而不是往 shell 白名单里加 "pm install"：
                // 白名单是前缀匹配，表达不了"只准 .apk、只准这两个根目录"，
                // 而放开前缀等于放开任意路径的任意安装。
                "installApk" -> installApk(call.argument<String>("path") ?: "", result)
                "sendToAmoo" -> sendToAmoo(call.argument<String>("text") ?: "", result)
                "openAmoo" -> openAmoo(result)

                // --- amoo 反代（桥的 ask/askResult/stop，异步：Amoo 一想约 6 分钟）---
                // 三条分开而不是一条阻塞调用：桥的 socket 超时 20s，等不到答案。
                "amooAsk" -> amooAsk(
                    call.argument<String>("prompt") ?: "",
                    (call.argument<Number>("timeoutMs"))?.toLong() ?: 420000L,
                    call.argument<String>("route") ?: "direct",
                    result
                )
                "amooAskResult" -> amooAskResult(result)
                "amooAskStop" -> amooAskStop(result)

                // --- 断点四：UI 选中的 driver 上报 ---
                // 只存不判：这一轮实际走哪条路由 CapabilitySnapshot.driver 报，
                // 两者分开才能看出「选的是 amoo、实际降级到 screen」。
                "driverSelect" -> {
                    BridgeDriverState.set(call.argument<String>("driverId") ?: "")
                    result.success(true)
                }

                // --- 控制台（本地命令通道；离线可用）---
                //
                // 解析、校验、执行、回显全在手机本地完成，不经过任何云端对话。
                // exec 最长可跑 120 秒，所以执行一律丢到后台线程，绝不占住主线程
                // ——否则界面会在命令跑完之前冻住。
                "consoleExec" -> consoleExec(call, result)
                "consoleTools" -> result.success(jsonToMap(KhyConsole.describeTools()))
                "consoleHistory" -> consoleHistory(call, result)
                "consoleExport" -> consoleExport(call, result)
                "consoleFavorites" -> consoleFavorites(call, result)
                "consoleClear" -> result.success(jsonToMap(KhyConsole.clearHistory()))
                "consolePending" -> result.success(jsonToMap(takePendingConsoleCmd()))
                // 令牌重置：走 exec 线程——它要写盘（.tmp + rename），平台主线程
                // 不能背这个 IO。回执只带指纹，见 KhyConsole.resetToken。
                "consoleResetToken" -> consoleResetToken(result)
                "amooSummon" -> amooSummon(call, result)

                // --- driver 禁用门（§5.1 第 4 条：Flutter→原生的写入通道）---
                //
                // 没有这一环，原生 SharedPreferences 里永远没有 driver_disabled_*
                // 键——设置里拨了开关，六方法照跑。BridgeOverlayService 的先例
                // 就是「被 Flutter 经 MethodChannel 显式调 setEnabled」。
                "setDriverEnabled" -> {
                    val id = call.argument<String>("driverId") ?: ""
                    val on = call.argument<Boolean>("enabled") ?: true
                    if (id.isEmpty()) {
                        result.success(mapOf("ok" to false, "message" to "driverId 为空"))
                    } else {
                        DriverGate.setEnabled(this, id, on)
                        result.success(mapOf("ok" to true, "driverId" to id, "enabled" to on))
                    }
                }

                // --- VFS（虚拟文件系统桥）---
                //
                // 走 VfsBridge.dispatch：它识别方法名、把阻塞 IO 丢到线程池、
                // 完成后回主线程。设备通道上不认识的方法仍然走 notImplemented，
                // 所以 device 通道的语义没有被改变。
                else -> if (!ZenDeviceSeed.dispatch(this, call, result)) VfsBridge.dispatch(this, call, result)
            }
        }

        // VFS 专用通道。名字与 Dart 侧 lib/core/vfs/vfs_channel.dart 里的
        // kVfsChannelName 一一对应——通道名不一致的话，Dart 侧每次调用都会
        // 撞 MissingPluginException，整套 VFS 形同虚设。
        val vfsChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, VfsBridge.CHANNEL)
        vfsChannel.setMethodCallHandler { call, result -> VfsBridge.dispatch(this, call, result) }
        // 目录事件监听要由原生往 Dart 推（vfsEvent），得先把通道句柄交给 VfsBridge。
        VfsBridge.bindChannel(vfsChannel)
    }

    // --- App / URL ---

    private fun openApp(packageName: String, result: MethodChannel.Result) {
        try {
            val pm = packageManager
            var intent = pm.getLaunchIntentForPackage(packageName)
            if (intent == null) {
                // App installed but getLaunchIntentForPackage missed it
                // (some OEM launchers): fall back to ACTION_MAIN.
                val main = Intent(Intent.ACTION_MAIN).apply {
                    setPackage(packageName)
                    addCategory(Intent.CATEGORY_LAUNCHER)
                }
                if (pm.queryIntentActivities(main, 0).isNotEmpty()) {
                    intent = main
                }
            }
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                result.success(mapOf("success" to true, "message" to "已启动 $packageName"))
            } else {
                result.success(mapOf("success" to false, "message" to "未找到应用: $packageName"))
            }
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to "启动失败: ${e.message}"))
        }
    }

    private fun openUrl(url: String, result: MethodChannel.Result) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            result.success(mapOf("success" to true, "message" to "已打开 $url"))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to "打开失败: ${e.message}"))
        }
    }

    private fun searchApps(query: String, result: MethodChannel.Result) {
        try {
            val pm = packageManager
            val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
            // Dedupe by package: an app may register multiple launcher activities
            val appLabels = mutableMapOf<String, String>()
            for (info in pm.queryIntentActivities(mainIntent, 0)) {
                val pkg = info.activityInfo.packageName
                appLabels.putIfAbsent(pkg, info.loadLabel(pm).toString())
            }
            val q = query.lowercase().trim()

            // Score-based matching: exact > contains
            data class ScoredApp(val score: Int, val label: String, val pkg: String)
            val scored = mutableListOf<ScoredApp>()

            for ((pkg, label) in appLabels) {
                val labelLc = label.lowercase()
                val pkgLc = pkg.lowercase()

                var score = 0
                if (q.isNotEmpty()) {
                    // Exact matches get highest score
                    if (labelLc == q) score += 100
                    if (pkgLc == q) score += 90
                    // Contains matches
                    if (labelLc.contains(q)) score += 30
                    if (pkgLc.contains(q)) score += 20
                } else {
                    score = 10 // No query, just list all
                }
                if (score > 0) {
                    scored.add(ScoredApp(score, label, pkg))
                }
            }

            scored.sortByDescending { it.score }
            val matched = scored.take(30).map {
                mapOf("label" to it.label, "package" to it.pkg)
            }
            result.success(mapOf("success" to true, "apps" to matched, "total" to scored.size))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "apps" to emptyList<Any>(), "message" to e.message))
        }
    }

    private fun listApps(result: MethodChannel.Result) {
        try {
            val pm = packageManager
            val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
            // Dedupe by package: an app may register multiple launcher activities
            val appLabels = mutableMapOf<String, String>()
            for (info in pm.queryIntentActivities(mainIntent, 0)) {
                appLabels.putIfAbsent(info.activityInfo.packageName, info.loadLabel(pm).toString())
            }
            val apps = appLabels.map { (pkg, label) ->
                mapOf(
                    "label" to label,
                    "package" to pkg
                )
            }
            result.success(mapOf("success" to true, "apps" to apps))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "apps" to emptyList<Any>(), "message" to e.message))
        }
    }

    // --- Clipboard ---

    private fun getClipboard(result: MethodChannel.Result) {
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = cm.primaryClip
            val text = clip?.getItemAt(0)?.text?.toString() ?: ""
            result.success(mapOf("success" to true, "text" to text))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "text" to "", "message" to e.message))
        }
    }

    private fun setClipboard(text: String, result: MethodChannel.Result) {
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("khy-os", text)
            cm.setPrimaryClip(clip)
            result.success(mapOf("success" to true, "message" to "已复制到剪贴板"))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to e.message))
        }
    }

    // --- Device ---

    private fun getDeviceInfo(result: MethodChannel.Result) {
        try {
            val pm = packageManager
            val pkgInfo = pm.getPackageInfo(packageName, 0)
            result.success(mapOf(
                "success" to true,
                "platform" to "android",
                "brand" to Build.BRAND,
                "model" to Build.MODEL,
                "sdkVersion" to Build.VERSION.SDK_INT,
                "releaseVersion" to Build.VERSION.RELEASE,
                "appVersion" to pkgInfo.versionName,
                "packageName" to packageName, "khyBuild" to khyBuildStamp() // deliberately one line: extra lines here shift the amoo frozen-literal block below
            ))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to e.message))
        }
    }

    private fun vibrate(duration: Int, result: MethodChannel.Result) {
        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as android.os.VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as android.os.Vibrator
            }
            @Suppress("DEPRECATION")
            vibrator.vibrate(duration.toLong())
            result.success(mapOf("success" to true))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to e.message))
        }
    }

    private fun getInstalledPackages(result: MethodChannel.Result) {
        try {
            val pm = packageManager
            val packages = pm.getInstalledPackages(0).map { pkg ->
                mapOf(
                    "label" to (pkg.applicationInfo?.loadLabel(pm)?.toString() ?: pkg.packageName),
                    "package" to pkg.packageName,
                    "versionName" to (pkg.versionName ?: ""),
                    "isSystem" to ((pkg.applicationInfo?.flags ?: 0) and android.content.pm.ApplicationInfo.FLAG_SYSTEM != 0)
                )
            }
            result.success(mapOf("success" to true, "packages" to packages))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "packages" to emptyList<Any>(), "message" to e.message))
        }
    }

    // --- Accessibility Service ---

    private fun openAccessibilitySettings(result: MethodChannel.Result) {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            result.success(mapOf("opened" to true))
        } catch (e: Exception) {
            result.error("ERROR", e.message, null)
        }
    }

    /**
     * 用文件管理器打开一个目录。
     *
     * 为什么是"尝试"而不是"打开"：Android 从来没有标准的"浏览目录" intent。
     * ACTION_VIEW 配 file:// 是能用的最接近形式，但大量文件管理器（尤其是
     * 国产那几套）只接自己 Scheme 下的文档 URI，对目录更是基本不接。所以这里
     * 区分三种结局并如实回报，让 Dart 侧能说人话，而不是把"没反应"当成成功：
     *   opened=true  —— 有 App 接了
     *   opened=false, noApp=true —— 没有任何 App 接这个 intent
     *   opened=false, noApp=false —— 起了 Activity 但立刻退了（App 不认目录）
     *
     * 用 FileProvider 而不是裸 file://：Android 7 起 StrictMode 的
     * FileUriExposedException 会让裸 file:// 直接崩，那会比"打不开"更糟。
     */
    private fun openDirectory(path: String, result: MethodChannel.Result) {
        if (path.isEmpty()) {
            result.success(mapOf("opened" to false, "noApp" to false, "reason" to "empty_path"))
            return
        }
        try {
            val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", java.io.File(path))
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "resource/folder")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            // 没有 App 接时 startActivity 会抛 ActivityNotFoundException，
            // 这是最常见的一种失败，单独一个码，别和别的异常混在一起。
            if (intent.resolveActivity(packageManager) == null) {
                result.success(mapOf("opened" to false, "noApp" to true))
                return
            }
            startActivity(intent)
            result.success(mapOf("opened" to true))
        } catch (e: ActivityNotFoundException) {
            result.success(mapOf("opened" to false, "noApp" to true))
        } catch (e: Exception) {
            result.success(mapOf("opened" to false, "noApp" to false, "reason" to (e.message ?: "unknown")))
        }
    }

    private fun a11yTap(x: Int, y: Int, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.tap(x, y) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "已点击 ($x, $y)" else "点击失败")))
    }

    private fun a11ySwipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.swipe(x1, y1, x2, y2, durationMs) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "已滑动" else "滑动失败")))
    }

    private fun a11yFindAndClick(query: String, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.findAndClick(query) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "已找到并点击" else "未找到匹配元素")))
    }

    private fun a11yFindAndLongClick(query: String, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.findAndLongClick(query) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "已长按" else "未找到或不可长按")))
    }

    private fun a11yFindWithBounds(query: String, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val bounds = KhyAccessibilityService.instance?.findCenterBounds(query)
        if (bounds != null) {
            result.success(mapOf(
                "success" to true,
                "x" to bounds[0], "y" to bounds[1],
                "w" to bounds[2], "h" to bounds[3]
            ))
        } else {
            result.success(mapOf("success" to false, "message" to "未找到 \"$query\""))
        }
    }

    private fun a11yDumpUi(result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "dump" to "", "message" to "无障碍服务未启用"))
            return
        }
        val dump = KhyAccessibilityService.instance?.dumpUi() ?: ""
        result.success(mapOf("success" to true, "dump" to dump))
    }

    private fun a11yListClickable(result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "items" to emptyList<Any>(), "message" to "无障碍服务未启用"))
            return
        }
        val items = KhyAccessibilityService.instance?.listClickable()?.map { row ->
            mapOf(
                "text" to (row[0].ifEmpty { "" }),
                "class" to (row[1].ifEmpty { "" }),
                "clickable" to (row[2] == "true"),
                "x" to (row[3].toIntOrNull() ?: 0),
                "y" to (row[4].toIntOrNull() ?: 0),
                "w" to (row[5].toIntOrNull() ?: 0),
                "h" to (row[6].toIntOrNull() ?: 0)
            )
        } ?: emptyList()
        result.success(mapOf("success" to true, "items" to items, "count" to items.size))
    }

    private fun a11yTypeText(text: String, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.typeText(text) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "已输入文字" else "输入失败")))
    }

    private fun a11yGlobalAction(action: Int, result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf("success" to false, "message" to "无障碍服务未启用"))
            return
        }
        val ok = KhyAccessibilityService.instance?.performGlobal(action) ?: false
        result.success(mapOf("success" to ok, "message" to (if (ok) "全局动作已执行" else "全局动作失败")))
    }

    // --- Screen Capture ---

    private fun startScreenCapture(result: MethodChannel.Result) {
        try {
            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val captureIntent = mpm.createScreenCaptureIntent()
            startActivityForResult(captureIntent, SCREEN_CAPTURE_REQUEST)
            // Note: result will be handled in onActivityResult
            result.success(mapOf("success" to true, "message" to "请在弹窗中授权屏幕捕获"))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to "启动屏幕捕获失败: ${e.message}"))
        }
    }

    private fun captureFrame(result: MethodChannel.Result) {
        if (!ScreenCaptureService.isReady()) {
            result.success(mapOf("success" to false, "data" to "", "message" to "屏幕捕获服务未就绪"))
            return
        }
        exec.execute {
            val frame = ScreenCaptureService.instance?.captureFrame()
            runOnUiThread {
                if (frame != null) {
                    result.success(mapOf("success" to true, "data" to frame))
                } else {
                    result.success(mapOf("success" to false, "data" to "", "message" to "截屏失败"))
                }
            }
        }
    }

    private fun stopScreenCapture(result: MethodChannel.Result) {
        val intent = Intent(this, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_STOP
        }
        startService(intent)
        result.success(mapOf("success" to true, "message" to "已停止屏幕捕获"))
    }

    /**
     * The projection's geometry, so the Dart side can turn a model's
     * coordinate into a pixel.
     *
     * This is a separate call from `captureFrame` rather than folded into its
     * result, because the two answer different questions at different times:
     * `captureFrame` says "here is what is on screen now", this says "what do
     * the pixels of that image mean". A caller that only wants to show the
     * screenshot should not pay for the geometry, and a caller that wants to
     * tap should be able to ask for the geometry without taking another
     * screenshot — the screen may have changed in between, which is precisely
     * when you do not want to re-capture.
     *
     * Deliberately succeeds even when the projection is down: a metrics call
     * that throws when the service is not ready teaches callers to treat
     * "no projection" as an error case, when it is a normal state that the
     * `source`/`stale` fields already describe.
     */
    private fun getScreenMetrics(result: MethodChannel.Result) {
        try {
            val m = ScreenCaptureService.instance?.getScreenMetrics()
                ?: mapOf("source" to "none", "img_w" to 0, "img_h" to 0, "stale" to true)
            result.success(mapOf("success" to true, "metrics" to m))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to "读取屏幕几何失败: ${e.message}"))
        }
    }

    // ── built-in inference engine ────────────────────────────────────────────

    /**
     * Load a model and start the loopback OpenAI-compatible endpoint.
     *
     * Returns {ok, port, url, message}. The URL is built here rather than on the
     * Dart side so there is exactly one place that knows the port and the `/v1`
     * suffix — the same reason `kDefaultOllamaVisionBaseUrl` composes its suffix
     * from a constant instead of repeating the literal.
     */
    private fun startLocalVision(modelPath: String, mmprojPath: String, wantPort: Int): Map<String, Any?> {
        if (modelPath.isBlank()) {
            return mapOf("ok" to false, "message" to "模型路径为空")
        }
        // applicationInfo.nativeLibraryDir is the app's own lib directory
        // (/data/app/<pkg>-1/lib/arm64). It is the one place the CPU-backend
        // modules are guaranteed to be, and the only public-API route to it —
        // see the note on KhyLlama.load's nativeLibDir parameter.
        val libDir = applicationInfo.nativeLibraryDir
        return try {
            val port = LocalVisionServer.get()
                .start(modelPath, mmprojPath, wantPort, libDir)
            mapOf(
                "ok" to true,
                "port" to port,
                "url" to "http://127.0.0.1:$port/v1",
                "model" to LocalVisionServer.DEFAULT_MODEL_NAME,
                "message" to "本地视觉模型已就绪（127.0.0.1:$port）"
            )
        } catch (e: Throwable) {
            // Throwable, not Exception: an UnsatisfiedLinkError or a native
            // crash surfacing as an Error is exactly the case that was invisible
            // before — it escaped both this catch and LocalVisionServer's, the
            // MethodChannel result was never sent, and the Dart side hung with
            // no message at all. That is worse than a wrong message.
            //
            // The class name is in the message on purpose. "启动失败" plus a
            // sentence is not enough to tell an IOException from an
            // UnsatisfiedLinkError from an OutOfMemoryError, and those three
            // have nothing in common in their fix.
            val detail = "${e.javaClass.name}: ${e.message}"
            Log.e("KhyLocalVision", "start failed model=$modelPath mmproj=$mmprojPath libDir=$libDir", e)
            mapOf("ok" to false, "message" to "启动失败：$detail")
        }
    }

    private fun localVisionStatus(): Map<String, Any?> {
        val s = LocalVisionServer.get()
        return mapOf(
            "running" to s.isRunning,
            "port" to s.port,
            "model" to LocalVisionServer.DEFAULT_MODEL_NAME
        )
    }

    /**
     * Hand back the most recent text shared into the app, and forget it.
     *
     * Returns an empty string rather than null when there is nothing: the Dart
     * side polls this on every resume, and "nothing to do" should be an
     * ordinary empty answer, not a nullable it has to reason about.
     */
    private fun consumeSharedText(result: MethodChannel.Result) {
        val t = sharedText
        sharedText = null
        result.success(t ?: "")
    }

    /**
     * Hand back the pending in-app route requested from outside the Flutter
     * tree (overlay's 「点此恢复」), and forget it. Empty string = nothing to do;
     * the Dart side polls this on resume, and "nothing" must be ordinary.
     *
     * Currently only "permission-center" is produced (BridgeOverlayService).
     * Unknown values are consumed and dropped by the Dart side — an old APK's
     * Flutter tree must not crash on a route name it doesn't know.
     */
    private fun consumePendingRoute(): String {
        val r = pendingRouteRequest
        pendingRouteRequest = null
        return r ?: ""
    }

    /**
     * Whether the 「选中文字后」 menu entry is currently installed.
     *
     * WHY THIS ASKS THE PACKAGE MANAGER RATHER THAN A STORED PREFERENCE. The
     * component's enabled state survives app restarts but not reinstalls, so a
     * preference would go stale exactly when the user does the one thing that
     * resets it — and then the settings screen would show a switch that is on
     * while the menu entry is absent. Asking the system is the only answer that
     * cannot disagree with what the user sees.
     *
     * `DEFAULT_DISABLED` (the manifest default) is reported as disabled, not as
     * an error: it is the shipped state, not a failure.
     */
    private fun processTextEntryEnabled(result: MethodChannel.Result) {
        try {
            val alias = ComponentName(this, "$packageName.ProcessTextEntry")
            val state = packageManager.getComponentEnabledSetting(alias)
            result.success(state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED)
        } catch (e: Exception) {
            result.success(false)
        }
    }

    /**
     * Turn the 「选中文字后」 menu entry on or off.
     *
     * WHY AN ALIAS RATHER THAN A FLAG. `ACTION_PROCESS_TEXT` puts khy-os in
     * every long-press selection menu on the device — a permanent, user-visible
     * intrusion that a single manifest line buys. So the default is off, and
     * the switch is the user's, not ours. Disabling the alias removes the entry
     * entirely rather than leaving a dead item that can still be tapped.
     *
     * `DONT_KILL_APP` because toggling a share entry should not restart the app
     * the user is looking at.
     */
    private fun setProcessTextEntryEnabled(enabled: Boolean, result: MethodChannel.Result) {
        try {
            val alias = ComponentName(this, "$packageName.ProcessTextEntry")
            packageManager.setComponentEnabledSetting(
                alias,
                if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP,
            )
            result.success(mapOf("success" to true, "enabled" to enabled))
        } catch (e: Exception) {
            result.success(mapOf("success" to false, "message" to "切换入口失败: ${e.message}"))
        }
    }

    /**
     * Capture text arriving from the share sheet or the selection menu.
     *
     * Called from both `onCreate` and `onNewIntent` because `launchMode` is
     * `singleTop`: the first share goes through `onCreate`, and every later one
     * into the running activity goes through `onNewIntent`. Handling only one of
     * them means the other case is silently dropped.
     */
    private fun captureIncomingText(intent: Intent?) {
        if (intent == null) return
        val text = when (intent.action) {
            Intent.ACTION_SEND ->
                intent.getStringExtra(Intent.EXTRA_TEXT)
            Intent.ACTION_PROCESS_TEXT ->
                // The selection menu passes the selected text here; it is
                // read-only by contract, so the app cannot replace the text in
                // place — it can only open a conversation with it.
                intent.getStringExtra(Intent.EXTRA_PROCESS_TEXT)
            else -> null
        } ?: return
        if (text.isNotBlank()) sharedText = text
    }

    /**
     * Screenshot through the accessibility service.
     *
     * WHY THIS SITS IN FRONT OF MediaProjection. MediaProjection pops a system
     * consent dialog every session. This path needs nothing beyond the
     * accessibility service — which the vision tools already require for the
     * tap, since `dispatchGesture` comes from the same service. So a caller
     * that can use either should try this first: it takes the vision feature
     * from two user consents down to one, and removes the dialog that blocked
     * it every single time.
     *
     * Not a consent bypass. The accessibility service is something the user
     * turned on explicitly, and `canTakeScreenshot` is declared in its config
     * where the user can see it. What is NOT done here is using the service to
     * click the system's own consent dialogs.
     *
     * Returns `success:false` rather than throwing when the service is off:
     * "accessibility not enabled" is a normal state the caller can act on, and
     * the message has to name the fix.
     */
    private fun a11yScreenshot(result: MethodChannel.Result) {
        if (!KhyAccessibilityService.isReady()) {
            result.success(mapOf(
                "success" to false,
                "message" to "无障碍服务未启用，用它截屏需要先开启",
            ))
            return
        }
        exec.execute {
            val shot = KhyAccessibilityService.instance?.screenshotB64(
                maxLongSide = 1280,
                quality = 85,
            )
            runOnUiThread {
                if (shot == null) {
                    result.success(mapOf(
                        "success" to false,
                        "message" to "无障碍截屏失败（服务可能被系统冻结，或本机不支持）",
                    ))
                } else {
                    result.success(mapOf(
                        "success" to true,
                        "b64" to shot["b64"],
                        "w" to shot["w"],
                        "h" to shot["h"],
                        "orig_w" to shot["orig_w"],
                        "orig_h" to shot["orig_h"],
                    ))
                }
            }
        }
    }

    /**
     * 冷启动也要接预填命令。
     *
     * 只挂在 onNewIntent 上是不够的：force-stop 之后 am start 是**新建**
     * Activity，走的是 onCreate，onNewIntent 根本不会被调用——于是冷启动
     * 时预填静默丢失，控制台输入框从头到尾只有 hintText。真机上测出来的
     * 样子是「点执行报先输入一条命令」，而字段里看着有东西（那是占位符）。
     */
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        capturePendingConsoleCmd(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // setIntent so a later `intent` read sees the new one too, and capture
        // so the Flutter side can pick it up.
        setIntent(intent)
        captureIncomingText(intent)
        capturePendingConsoleCmd(intent)
    }

    // ── 控制台：本地命令通道 ────────────────────────────────────────────────

    /**
     * 一条从外部带进来的命令，等控制台面板来取。
     *
     * 用途：快捷方式、通知、adb（自动化验收）都可以直接把一条 JSON 命令塞进
     * 控制台的输入框。它只是**预填**，不执行——执行永远要用户在面板上按一下，
     * 所以这不是一条绕过确认的通道。
     */
    private var pendingConsoleCmd: String? = null

    /** 从 intent 里接一条待预填的命令（只预填，不执行）。 */
    private fun capturePendingConsoleCmd(i: Intent?) {
        // 命令是 JSON，满是双引号；而 adb shell / am / 各厂家 launcher 的
        // 快捷方式语法都会把双引号当定界符吃掉，传进来的 JSON 就缺了引号。
        // 所以额外认一个 base64 形态：base64 只有字母数字和 +/=
        // 任何一层 shell 都动不了它。快捷方式、通知、adb 一律走这个形态。
        val plain = try {
            i?.getStringExtra("khy_console_cmd")
        } catch (_: Exception) {
            null
        }
        var cmd = if (!plain.isNullOrBlank()) plain else null
        val b64 = try {
            i?.getStringExtra("khy_console_cmd_b64")
        } catch (_: Exception) {
            null
        }
        if (cmd == null && !b64.isNullOrBlank()) {
            cmd = try {
                String(android.util.Base64.decode(b64, android.util.Base64.DEFAULT), Charsets.UTF_8)
            } catch (_: Exception) {
                null
            }
        }
        if (!cmd.isNullOrBlank()) {
            pendingConsoleCmd = cmd
        }
    }

    /** 取出并清空待预填命令。 */
    private fun takePendingConsoleCmd(): JSONObject {
        val cmd = pendingConsoleCmd ?: ""
        pendingConsoleCmd = null
        return JSONObject()
            .put("ok", true)
            .put("command", cmd)
            .put("pending", cmd.isNotEmpty())
    }

    private fun consoleExec(call: MethodCall, result: MethodChannel.Result) {
        val json = call.argument<String>("json") ?: ""
        val origin = call.argument<String>("origin") ?: KhyConsole.ORIGIN_MANUAL
        exec.execute {
            val out = try {
                KhyConsole.exec(origin, json)
            } catch (t: Throwable) {
                JSONObject()
                    .put("ok", false)
                    .put("status", KhyConsole.STATUS_EXEC_ERROR)
                    .put("error_class", KhyConsole.STATUS_EXEC_ERROR)
                    .put("error", "控制台内部异常：${t.javaClass.simpleName}: ${t.message}")
                    .put("tool", "")
                    .put("args", JSONObject())
                    .put("result", JSONObject())
            }
            runOnUiThread { result.success(jsonToMap(out)) }
        }
    }

    /**
     * 重置桥令牌（控制台面板的人工动作）。
     *
     * 与 consoleExec 一样走 exec 线程：resetToken 里有一次原子写盘，平台主线程
     * 不能背。回执只带新旧指纹，见 KhyConsole.resetToken 的契约。
     */
    private fun consoleResetToken(result: MethodChannel.Result) {
        exec.execute {
            val out = try {
                KhyConsole.resetToken()
            } catch (t: Throwable) {
                JSONObject()
                    .put("ok", false)
                    .put("reset", false)
                    .put("error", "控制台内部异常：${t.javaClass.simpleName}: ${t.message}")
            }
            runOnUiThread { result.success(jsonToMap(out)) }
        }
    }

    private fun consoleHistory(call: MethodCall, result: MethodChannel.Result) {
        val limit = (call.argument<Number>("limit"))?.toInt() ?: 100
        exec.execute {
            val out = KhyConsole.history(limit)
            runOnUiThread { result.success(jsonToMap(out)) }
        }
    }

    private fun consoleExport(call: MethodCall, result: MethodChannel.Result) {
        val path = call.argument<String>("path")
        exec.execute {
            val out = KhyConsole.export(path)
            runOnUiThread { result.success(jsonToMap(out)) }
        }
    }

    private fun consoleFavorites(call: MethodCall, result: MethodChannel.Result) {
        when (call.argument<String>("op") ?: "get") {
            "get" -> result.success(jsonToMap(KhyConsole.favorites()))
            "add" -> {
                val label = call.argument<String>("label") ?: ""
                val json = call.argument<String>("json") ?: ""
                exec.execute {
                    val out = KhyConsole.addFavorite(label, json)
                    runOnUiThread { result.success(jsonToMap(out)) }
                }
            }
            "remove" -> {
                val id = call.argument<String>("id") ?: ""
                exec.execute {
                    val out = KhyConsole.removeFavorite(id)
                    runOnUiThread { result.success(jsonToMap(out)) }
                }
            }
            else -> result.error("bad_op", "op 只能是 get / add / remove", null)
        }
    }

    /**
     * 按需唤起 Amoo，并让它产出的命令走同一条控制台通道。
     *
     * 顺序是有讲究的：先把拦截循环 arm 上，再打开 Amoo 的聊天页。反过来会漏掉
     * Amoo 已经开始输出的那一条——而漏掉的命令是最难查的一类故障，因为看起来
     * 像是「Amoo 什么都没说」。
     *
     * 上下文（当前命令与结果）默认带上：用户不必把刚跑过的事再描述一遍。
     * 只写进输入框、**不发送**——代用户按发送是一个决定，不是便利。
     */
    private fun amooSummon(call: MethodCall, result: MethodChannel.Result) {
        val withContext = call.argument<Boolean>("with_context") ?: true
        val modeName = (call.argument<String>("mode") ?: "bypass").uppercase()
        val mode = try {
            LoopModes.Mode.valueOf(modeName)
        } catch (_: IllegalArgumentException) {
            LoopModes.defaultMode()
        }
        exec.execute {
            val notes = ArrayList<String>()
            // 1) arm 循环
            //
            // start() 拒绝启动时**不抛异常**：无障碍没开它在内部直接 return，只把
            // running 置 false（AmooLoop.java:913-920）。而 running==false 同时
            // 也是「已经跑完」的样子——Tools.java 的 loop_start 早就为这件事专门
            // 回 ok:false + code:"refused"（UiAdviceTest
            // .loopStartAnswersWithAFailureCodeNotASuccessAndADeadLoop 钉住）。
            // 这里若照旧无条件上报「已启动」，用户就会在 Amoo 里敲命令然后毫无
            // 反应，而界面刚告诉他循环布防好了。
            var loopUp = false
            try {
                AmooLoop.start(mode, AmooLoop.Options())
                loopUp = AmooLoop.isRunning()
            } catch (t: Throwable) {
                notes.add("拦截循环启动失败：${t.javaClass.simpleName}")
            }
            if (!loopUp) {
                // 循环没起来就不开 Amoo：聊天页看着就绪，敲什么都不会被截获。
                // 开门见山说原因，别让用户去猜。
                val why = ArrayList<String>()
                why.add("本地拦截循环未能启动")
                why.add("无障碍服务未开启时读不到 Amoo 的屏幕，循环不会启动；开启后重试")
                val out = JSONObject()
                    .put("ok", false)
                    .put("loop_running", false)
                    .put("mode", mode.name)
                    .put("context_attached", false)
                    .put("notes", JSONArray(why))
                    .put("message", "未能唤起 Amoo：拦截循环未启动")
                runOnUiThread { result.success(jsonToMap(out)) }
                return@execute
            }
            notes.add("本地拦截循环已启动（${mode.name}）")
            // 2) 打开 amoo 聊天页（主线程）
            var opened = false
            runOnUiThread {
                try {
                    val chat = Intent(AMOON_OPEN_CHAT).apply {
                        setClassName(AMOON_PACKAGE, AMOON_CHAT_ACTIVITY)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(chat)
                    opened = true
                } catch (_: Exception) {
                    try {
                        val launch = packageManager.getLaunchIntentForPackage(AMOON_PACKAGE)
                        if (launch != null) {
                            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            startActivity(launch)
                            opened = true
                        }
                    } catch (_: Exception) {
                    }
                }
            }
            if (opened) notes.add("已打开 amoo 聊天页") else notes.add("未能打开 amoo（未安装或无法启动）")
            // 3) 把上下文写进 amoo 输入框（不发送）
            var contextAttached = false
            if (withContext && opened) {
                try {
                    Thread.sleep(1500L)
                    val ctx = KhyConsole.lastContext(800)
                    if (ctx.isNotEmpty()) {
                        val typed = AmooLoop.attachContext(ctx)
                        contextAttached = typed.optBoolean("ok", false)
                        if (contextAttached) {
                            notes.add("已把当前命令与结果写进 amoo 输入框（未发送）")
                        } else {
                            notes.add("上下文没能写进 amoo 输入框：${typed.optString("error", "未知")}")
                        }
                    } else {
                        notes.add("当前没有可带上的上下文")
                    }
                } catch (_: Exception) {
                }
            }
            val out = JSONObject()
                .put("ok", opened)
                .put("loop_running", AmooLoop.isRunning())
                .put("mode", mode.name)
                .put("context_attached", contextAttached)
                .put("notes", JSONArray(notes))
                .put("message", if (opened) "已唤起 amoo" else "未能唤起 amoo")
            runOnUiThread { result.success(jsonToMap(out)) }
        }
    }

    /** JSONObject → Map, recursively. Flutter's codec only speaks Map/List. */
    private fun jsonToMap(o: JSONObject): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        val it = o.keys()
        while (it.hasNext()) {
            val k = it.next()
            out[k] = jsonValue(o.opt(k))
        }
        return out
    }

    private fun jsonValue(v: Any?): Any? = when {
        v == null || v === JSONObject.NULL -> null
        v is JSONObject -> jsonToMap(v)
        v is JSONArray -> (0 until v.length()).map { jsonValue(v.opt(it)) }
        else -> v
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == SCREEN_CAPTURE_REQUEST) {
            if (resultCode == RESULT_OK && data != null) {
                val intent = Intent(this, ScreenCaptureService::class.java).apply {
                    action = ScreenCaptureService.ACTION_START
                    putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
                    putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
                }
                startForegroundService(intent)
            }
        }
        if (requestCode == REQ_VPN) {
            if (resultCode == RESULT_OK) {
                // 授权刚拿到：这时 prepare() 已返回 null，start() 会一并起代理与 VPN。
                val ttl = pendingVpnTtlMs
                val tls = pendingVpnTls
                pendingVpnTtlMs = 0L
                pendingVpnTls = false
                NetCapture.start(this, if (ttl > 0) ttl else null, tls)
            } else {
                // 拒绝授权就不开抓：开了也没有流量，只会让人以为「抓不到东西」。
                NetCapture.stop("vpn_denied")
            }
        }
    }

    // --- Shell ---

    private fun shell(command: String, timeoutSec: Int, result: MethodChannel.Result) {
        if (command.isEmpty()) {
            result.success(mapOf("success" to false, "stdout" to "", "stderr" to "空命令", "exitCode" to -1))
            return
        }
        if (!isCommandAllowed(command)) {
            // 拒绝必须说清"什么被允许"，否则调用方无从自救。
            //
            // 实测过这个坑：amoo 想装个夸克，发了 `pkg manager install <url>`，
            // 被这句"命令被拒绝（白名单/黑名单）"挡回来。它不知道允许清单里有
            // 什么，于是只能猜——pm install、pkg install、apt install 挨个试，
            // 每个都撞同一句话。一句不带允许清单的拒绝，等于让调用方 blind retry。
            //
            // 而且那条命令本身就是错的（见 AmooSelfDesc 的说明）：Android 的包
            // 管理器 CLI 是 pm 不是 pkg manager，且 pm install 只吃本地路径，
            // 吃不了 URL。所以真正该告诉它的是"先下载、再从本地路径装"。
            val allowed = SHELL_ALLOW.joinToString("、") { it.trim() }
            result.success(mapOf(
                "success" to false,
                "stdout" to "",
                "stderr" to "命令不在允许清单内。允许的前缀：$allowed。"
                    + "注意：安装 APK 要先把文件下载到本地，再用 pm install <本地.apk>；"
                    + "pm install 不能接 URL。"
                    + "另外：一条命令里不允许出现 shell 控制符（; & | ` > < 换行）与命令替换"
                    + "（`…` / $(…)）—— 白名单是按前缀匹配的，放任串联等于让一条被允许的命令"
                    + "夹带任意第二条命令。请把要做的事拆成多次调用。",
                "exitCode" to -1
            ))
            return
        }
        exec.execute {
            // input/am/pm 这类子命令在 App uid 下 exit 0 但不生效（「看起来成功」）。
            // 这条通道是 Dart exec_shell 的唯一入口，所以必须先给 sidecar 一次机会，
            // 拿不到就明确拒绝，不许落到 ShellRunner 去假成功。
            if (ShellLevelPolicy.requiresShell(command)) {
                val elevated = ShellSidecarClient.exec(command, "/sdcard", timeoutSec)
                val payload: Map<String, Any> = if (elevated != null) {
                    mapOf(
                        "success" to (elevated.optInt("exit", -1) == 0),
                        "stdout" to elevated.optString("out", ""),
                        "stderr" to elevated.optString("err", ""),
                        "exitCode" to elevated.optInt("exit", -1),
                        "via" to "sidecar",
                        "elevated" to "sidecar"
                    )
                } else {
                    mapOf(
                        "success" to false,
                        "stdout" to "",
                        "stderr" to ShellLevelPolicy.reason(command),
                        "exitCode" to 126,
                        "code" to ShellLevelPolicy.CODE,
                        "via" to "app",
                        "elevated" to "app"
                    )
                }
                runOnUiThread { result.success(payload) }
                return@execute
            }
            val r = ShellRunner.run(command, null, timeoutSec)
            runOnUiThread { result.success(r) }
        }
    }

    /**
     * 终端（人工命令区）执行一条命令。
     *
     * 与 [shell] 的区别在两处，且都是刻意分开的：
     *   1. 准入策略走 [TerminalShell]（人工命令区自己的清单），[shell] 那条严白名单
     *      原样留给 AI 与设备控制。
     *   2. cwd 单独作为参数传，**不**拼成 `cd <dir> && cmd`：命令体里出现 `&&`
     *      会被控制符禁令整体拒绝——真机实测，终端因此一条命令都发不出去。
     */
    private fun terminalShell(command: String, cwd: String?, timeoutSec: Int, result: MethodChannel.Result) {
        if (command.isEmpty()) {
            result.success(mapOf("success" to false, "stdout" to "", "stderr" to "空命令", "exitCode" to -1))
            return
        }
        if (!TerminalShell.isAllowed(command)) {
            // 拒绝要说清边界，否则用户只能挨个猜命令名。
            val allowed = TerminalShell.allowedSummary()
            result.success(mapOf(
                "success" to false,
                "stdout" to "",
                "stderr" to "命令不在终端允许清单内。允许的命令：$allowed。"
                    + "另外：一条命令里不允许出现 shell 控制符（; & | ` > < 换行）与命令替换"
                    + "（`…` / $(…)），也不允许 find -exec、解释器（sh/python/awk/sed…）"
                    + "与提权命令（su/chmod/chown/setprop）。",
                "exitCode" to -1
            ))
            return
        }
        // 工作目录不存在就明说，不要静默回落到 /——那会让用户以为在目录 A 里执行，
        // 实际命令跑在了别处，排查起来极难。
        if (!cwd.isNullOrBlank() && !File(cwd).isDirectory) {
            result.success(mapOf(
                "success" to false,
                "stdout" to "",
                "stderr" to "工作目录不存在或不可访问：$cwd",
                "exitCode" to -1
            ))
            return
        }
        exec.execute {
            val r = ShellRunner.run(command, cwd, timeoutSec)
            runOnUiThread { result.success(r) }
        }
    }

    /**
     * 安装一个 APK。窄口：只收 .apk，只收两个根目录下的路径。
     *
     * 为什么不走 [shell] 通道而是单独一个入口：
     *   1. [shell] 跑在 App 自己的 uid 上，没有 INSTALL_PACKAGES，装不了。
     *      这里走 [com.khyos.khy_os_client.bridge.Tools.exec]，那条路会依次试
     *      sidecar（uid 2000）→ App uid，第一级就能装。
     *   2. 白名单是前缀匹配，表达不了"只准 .apk、只准这两个根"。往白名单里加
     *      "pm install " 等于允许任意路径的任意安装，那不是收窄是放宽。
     *
     * 路径校验为什么必须是这三条而不是一条：
     *   - 后缀 .apk：挡住把别的文件当包装装
     *   - 根目录前缀：挡住 /data/data/<别人的包>/ 这类路径
     *   - 禁止 ".."：前缀检查挡不住 `/sdcard/Download/../../data/x.apk`
     * 三条少任何一条都能构造出越界路径。
     *
     * **不加人工确认是刻意的**（2026-10-25 裁决维持现状，见
     * works/record/evidence/01_人类贡献/决策记录.md D-批3 第 4 条 (d)）：
     * 这条窄口本身就是控制手段——只收 `.apk`、只收两个根目录、禁 `..`，
     * 三条叠起来已经把「装任意路径的任意包」关在门外。再加一道人工点确认，
     * 是形态变更而不是补洞，需要人另行拍板。
     */
    private fun installApk(rawPath: String, result: MethodChannel.Result) {
        val path = rawPath.trim()
        if (path.isEmpty()) {
            result.success(mapOf(
                "ok" to false, "code" to "empty_path",
                "error" to "路径为空"))
            return
        }
        if (!path.endsWith(".apk", ignoreCase = true)) {
            result.success(mapOf(
                "ok" to false, "code" to "not_apk",
                "error" to "只接受 .apk 文件：$path"))
            return
        }
        if (path.contains("..")) {
            result.success(mapOf(
                "ok" to false, "code" to "path_traversal",
                "error" to "路径不允许包含 ..：$path"))
            return
        }
        val underRoot = APK_INSTALL_ROOTS.any { root ->
            path == root || path.startsWith("$root/")
        }
        if (!underRoot) {
            result.success(mapOf(
                "ok" to false, "code" to "forbidden_scope",
                "error" to "只允许安装这两个目录下的 apk："
                    + "${APK_INSTALL_ROOTS.joinToString("、")}。"
                    + "先把 apk 下载到那里再装。"))
            return
        }
        exec.execute {
            try {
                // S5：先判签名再搬运。Download 里 debug/release 同包名同版本号
                // 的两个包肉眼看不出差别（实测 2026-11-17），装错只会得到一句
                // 不着边的 INSTALL_FAILED_UPDATE_INCOMPATIBLE。判据在纯函数
                // InstallGuard 里（JVM 单测钉死），这里只做两件 IO：读包与签名。
                val archive = packageManager.getPackageArchiveInfo(
                    path, android.content.pm.PackageManager.GET_SIGNATURES)
                val archivePkg: String? = archive?.applicationInfo?.packageName
                val archiveSig = archive?.signatures?.firstOrNull()?.toCharsString()
                val archiveSigSha256 = archiveSig?.let {
                    java.security.MessageDigest.getInstance("SHA-256")
                        .digest(it.toByteArray(Charsets.UTF_8))
                        .joinToString("") { b -> "%02x".format(b) }
                }
                val ownSigSha256 = runCatching {
                    val info = packageManager.getPackageInfo(packageName,
                        android.content.pm.PackageManager.GET_SIGNATURES)
                    val sig = info.signatures?.firstOrNull()?.toCharsString()
                    sig?.let {
                        java.security.MessageDigest.getInstance("SHA-256")
                            .digest(it.toByteArray(Charsets.UTF_8))
                            .joinToString("") { b -> "%02x".format(b) }
                    }
                }.getOrNull()
                val guard = com.khyos.khy_os_client.bridge.InstallGuard.evaluate(
                    archivePkg, packageName, archiveSigSha256, ownSigSha256)
                if (!guard.optBoolean("ok", true)) {
                    runOnUiThread {
                        result.success(guardToMap(guard, path))
                    }
                    return@execute
                }
                val sigVerified = guard.optString("code").isEmpty()
                // 必须先中转再装，不能把 /sdcard 路径直接交给 pm。
                //
                // 实测（2026-10-24）：`pm install /sdcard/Download/x.apk` 报
                //   avc: denied { read } scontext=u:r:system_server
                //        tcontext=u:object_r:fuse:s0
                // 也就是 SELinux 不许 system_server 读 /sdcard 上的 fuse 文件——
                // 这跟提权无关，uid 2000 也一样被挡。把文件复制到
                // /data/local/tmp/ 再装就绕过了（那正是 adb install 内部做的事：
                // 它先把 apk push 到 /data/local/tmp 再调 pm）。
                // 暂存名必须**每次唯一**。固定名（khyos-install.apk）在并发安装
                // 下会互相覆盖：A 刚 cp 完，B 用同名文件覆盖了它，A 的
                // `pm install -r` 于是装的是 B 的包，而且不报错；A 的收尾 rm
                // 还会把 B 正在用的文件删掉。唯一名让两个安装互不干扰，也让
                // 上一次崩溃残留的文件不会被下一次安装当成同名包——下面那句
                // 「下次同名安装会拿到上一个残留文件」正是固定名带来的坑。
                val staged = "/data/local/tmp/khyos-install-" +
                    java.util.UUID.randomUUID().toString() + ".apk"
                val cp = com.khyos.khy_os_client.bridge.Tools.exec(
                    "cp " + quote(path) + " " + quote(staged), 120)
                if (!cp.optBoolean("ok", false)) {
                    val why = cp.optString("error").ifEmpty {
                        cp.optString("err").ifEmpty { cp.optString("out") }
                    }
                    runOnUiThread {
                        result.success(mapOf(
                            "ok" to false, "code" to "stage_failed",
                            "error" to "无法把 apk 复制到临时目录：$why",
                            "via" to cp.optString("via", "app")))
                    }
                    return@execute
                }
                val r = com.khyos.khy_os_client.bridge.Tools.exec(
                    "pm install -r " + quote(staged), 180)
                val via = r.optString("via", "app")
                val out = r.optString("out", "")
                val err = r.optString("error", "")
                val ok = r.optBoolean("ok", false)
                // 装完就删。临时目录不留 apk：一是占空间，二是下次同名安装会
                // 拿到上一个残留文件——那会装错版本而不报错。
                com.khyos.khy_os_client.bridge.Tools.exec("rm -f " + quote(staged), 30)
                runOnUiThread {
                    result.success(mapOf(
                        "ok" to ok,
                        "via" to via,
                        "stdout" to out,
                        "stderr" to err,
                        // 提权层级要说清：via=app 意味着没提权，那种情况下
                        // "安装失败"不是命令错，是权限没到位，处理方式完全不同。
                        "elevated" to (via != "app"),
                        // S5：签名闸的结果要跟着回执走。signature_unknown =
                        // 闸没验证（读不出签名），不是通过。
                        "signature_check" to if (sigVerified) "passed" else "unknown",
                        "path" to path
                    ))
                }
            } catch (e: Exception) {
                runOnUiThread {
                    result.success(mapOf(
                        "ok" to false, "code" to "internal",
                        "error" to (e.message ?: "unknown")))
                }
            }
        }
    }

    /** InstallGuard 的回执原样转成 MethodChannel 的 Map（错误要带到前端）。 */
    private fun guardToMap(guard: org.json.JSONObject, path: String): Map<String, Any> {
        val out = LinkedHashMap<String, Any>()
        out["ok"] = guard.optBoolean("ok", false)
        out["code"] = guard.optString("code")
        if (guard.has("error")) out["error"] = guard.optString("error")
        if (guard.has("note")) out["note"] = guard.optString("note")
        if (guard.has("archive_signer")) out["archive_signer"] = guard.optString("archive_signer")
        if (guard.has("own_signer")) out["own_signer"] = guard.optString("own_signer")
        out["path"] = path
        return out
    }

    /**
     * 给 shell 命令参数加单引号。
     *
     * 路径来自 Agent，不是来自用户手输——而 Agent 会编东西（实测：它发明过
     * `pkg manager install <url>` 这种不存在的命令）。所以参数必须转义，
     * 不能让一个带空格或分号的路径变成两条命令。
     */
    private fun quote(arg: String): String {
        return "'" + arg.replace("'", "'\\''") + "'"
    }

    private fun isCommandAllowed(cmd: String): Boolean {
        // 这道闸门是原生侧的最后一道网：命令最终交给 `sh -c` 执行，而白名单是
        // **前缀**匹配 —— 「一条允许的命令 + 一条被禁的命令」拼成一条就能过闸
        // （`echo x;rm -rf /` 以 "echo " 开头 → 放行；分号后那条从未被看过）。
        // 同一道闸门还被 elevatedShell 复用，那里是**提权后**的 uid 2000，
        // 爆炸半径更大。
        //
        // 判据为什么搬到 [ShellCommandPolicy]：那边是纯函数，能被 JVM 单测用
        // **实测语料**钉死。放在 Activity 的私有方法里既测不到，也改不动
        // （每改一行都要重排下方 amoo 冻结字面量块）。
        //
        // 修法（控制符整体拒绝）为什么留着：白名单里没有需要它们的用法，而分段
        // 校验还要处理引号/替换/嵌套，比「直接不给 chaining」更容易漏。
        //
        // 拼写层之外还有一层**形状层**：deny 名单写的是 `rm -rf /`，前缀匹配管不到
        // 换了写法的那几种（`rm -r -f /`、`rm --recursive --force /`、`rm -rf ./`），
        // 却把 `rm -rf /storage/…/旧目录` 一并拒了——2026-11-10 实测：漏 4 条、
        // 误拦 1 条。形状层判的是「目标是不是根路径」，与写法无关；
        // 递归删**子目录**放行（主功能，用户确认在 Dart 侧做）。
        // 白名单与黑名单仍由本类持有——它们是**本 App 的准入策略**，不是通用判据。
        return ShellCommandPolicy.isAllowed(cmd, SHELL_ALLOW, SHELL_DENY)
    }

    // --- 提权通道（privilege without root） ---

    /**
     * Report the elevation channel's availability. `installed` is true when
     * the uid-2000 sidecar answers; `running` is the same probe (kept for the
     * older key name). When the sidecar is down everything degrades to "not
     * available" and callers fall back to the plain app-uid shell.
     *
     * `online` is the third state: the sidecar answered a PING but no exec has
     * proven it yet. `available` stays pessimistic on purpose (it gates the
     * direct elevated call path), so the UI needs `online` to tell "down"
     * from "up but unconfirmed" — otherwise it would grey out entries that
     * would in fact work.
     */
    private fun elevationStatus(result: MethodChannel.Result) {
        val status = ElevationManager.currentStatus(this)
        // 提权态真源（2026-11-17）：开关 + 当前层 + 设备授权态 + 最近配对时间。
        // enabled 是用户的意图；elevated 是设备的事实——开关开着而代理没起来时，
        // enabled=true 而 elevated=none，两 fields 各说各的，不许合成一个。
        // device_auth 与 last_pair_ms 是 T5 的判据：重启后状态自动恢复，以及
        // 「曾经配对过」的证据。
        val enabled = ElevationState.isEnabled(this)
        result.success(mapOf(
            "installed" to status.installed,
            "running" to status.connected,
            "version" to status.version,
            "reason" to status.reason,
            "available" to status.available,
            "online" to ShellSidecarClient.online(),
            "enabled" to enabled,
            "elevated" to (if (status.available) "shell" else "none"),
            "device_auth" to ElevationState.deviceAuth(this),
            "last_pair_ms" to ElevationState.lastPairMs(this),
            // 提权代理用这把公钥验「是谁在调用」（挑战应答）。公钥不是秘密，
            // 报出来是为了让 PC 侧兜底脚本能把它传给 launch 时的 --pub。
            "device_pub_b64" to DeviceIdentity.publicKeyB64(this),
        ))
    }


    /**
     * Raise the sidecar through the phone's OWN wireless-debugging endpoint.
     *
     * This is the "install it and it lifts itself" path: no second app, no PC
     * (after the one-time pairing), no root. It talks to the device's adbd
     * with the app's own adb identity and starts the sidecar from there.
     *
     * ⚠ Must run off the main thread: it opens a socket, waits for the
     * device's auth challenge, and runs a command over the wire. Same reason
     * as elevatedShell above.
     *
     * THE SWITCH IS CHECKED HERE TOO (it was not, measured 2026-11-17). This
     * is the path the「让手机自己拉起」button takes, and it called
     * [ElevationBootstrap.bootstrap] directly — so the UI could raise a
     * uid-2000 agent with the switch off, while the bridge tool's identical
     * action refused. That makes the guide's promise ("开关打开后还要再点一次
     * 「拉起」，两步都在你手上") false in exactly the direction that matters:
     * one入口 enforces the red line and the other does not.
     */
    private fun elevationBootstrap(result: MethodChannel.Result) {
        if (!ElevationState.isEnabled(this)) {
            result.success(mapOf(
                "ok" to false,
                "code" to com.khyos.khy_os_client.bridge.ShellLevelPolicy.CODE,
                "message" to com.khyos.khy_os_client.shell.ElevationBootstrap
                    .switchOffMessage(true),
            ))
            return
        }
        exec.execute {
            val outcome = ElevationBootstrap.bootstrap(this)
            runOnUiThread {
                result.success(mapOf(
                    "ok" to outcome.ok,
                    "message" to outcome.message,
                    "detail" to outcome.detail,
                    "endpoint" to ElevationBootstrap.endpoint(this),
                    "fingerprint" to ElevationBootstrap.keyFingerprint(this),
                ))
            }
        }
    }

    /**
     * Look for the device's own wireless-debugging endpoint over mDNS.
     *
     * The phone publishes it as `_adb-tls-connect._tcp`. When the device's
     * own mDNS stack hands it back, the user never has to read an IP and a
     * port off the settings screen.
     */
    private fun elevationDiscover(result: MethodChannel.Result) {
        exec.execute {
            val found = ElevationBootstrap.discoverEndpoint(this)
            runOnUiThread {
                result.success(mapOf("endpoint" to found))
            }
        }
    }

    /**
     * Read or write the remembered wireless-debugging endpoint ("ip:port").
     *
     * A null endpoint means "read"; a non-null one means "remember this".
     */
    private fun elevationEndpoint(endpoint: String?, result: MethodChannel.Result) {
        if (endpoint != null) {
            ElevationBootstrap.setEndpoint(this, endpoint)
        }
        result.success(mapOf(
            "endpoint" to ElevationBootstrap.endpoint(this),
            "fingerprint" to ElevationBootstrap.keyFingerprint(this),
        ))
    }

    /**
     * Jump to the system's developer-settings page, where the wireless
     * debugging switch lives.
     *
     * WHY ONLY A JUMP. Turning wireless debugging on (and opening the pairing
     * dialog) are system decisions; an app that could flip them silently would
     * be an app that could grant itself a shell silently. The task's red line
     * says exactly that: no silent elevation. So the app can take the user TO
     * the switch, and the user's own tap is the consent.
     */
    /**
     * Take the user to the wireless-debugging switch, as directly as this
     * device allows.
     *
     * WHY A CHAIN AND NOT ONE INTENT (measured 2026-11-18, on the real device).
     * The wireless-debugging page lives under `com.android.settings.SubSettings`
     * with a `:settings:show_fragment` extra — the only route that lands on the
     * page itself — but SubSettings requires `com.stepos.permission
     * .SEARCH_SETTINGS`, a StepOS-private permission a third-party app cannot
     * hold. So the chain is: try the direct page, and if the device refuses,
     * fall back to the developer-options page that CONTAINS it (verified to
     * work: `ACTION_APPLICATION_DEVELOPMENT_SETTINGS` lands on the page with
     * 「USB 调试」/「撤消 USB 调试授权」), and if even that is missing, the
     * settings root.
     *
     * The receipt says which of the three actually opened — "we tried the best
     * one" and "the best one opened" are different facts, and the guide's step 1
     * tells the user to look for 无线调试 on the page they land on.
     *
     * WHY ONLY A JUMP. Turning wireless debugging on (and opening the pairing
     * dialog) are system decisions; an app that could flip them silently would
     * be an app that could grant itself a shell silently. The task's red line
     * says exactly that: no silent elevation. So the app can take the user TO
     * the switch, and the user's own tap is the consent.
     */
    private fun openWirelessDebuggingSettings(result: MethodChannel.Result) {
        val attempts = mutableListOf<String>()
        for ((tag, intent) in wirelessDebuggingIntents()) {
            try {
                startActivity(intent)
                result.success(mapOf(
                    "ok" to true,
                    "message" to if (tag == "direct") {
                        "已打开无线调试页。"
                    } else {
                        "已打开开发者选项页——「无线调试」就在这一页里（可能要往下滚一点）。"
                    },
                    "detail" to "landed=$tag, tried=${attempts + tag}",
                ))
                return
            } catch (e: Throwable) {
                attempts += "$tag:${e.javaClass.simpleName}"
            }
        }
        result.success(mapOf(
            "ok" to false,
            "message" to "打不开无线调试页：请在系统设置里手动进入「开发者选项 → 无线调试」。",
            "detail" to attempts.joinToString(";"),
        ))
    }

    /**
     * The three jump targets, best first.
     *
     * `direct` is the wireless-debugging page itself; `development` is the page
     * that contains it; `root` is the last resort so the user at least lands
     * somewhere they can search from.
     */
    private fun wirelessDebuggingIntents(): List<Pair<String, android.content.Intent>> {
        val direct = android.content.Intent().apply {
            setClassName("com.android.settings", "com.android.settings.SubSettings")
            putExtra(":settings:show_fragment",
                "com.android.settings.development.WirelessDebuggingFragment")
            addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val development = android.content.Intent(
            android.provider.Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS,
        ).apply { addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK) }
        val root = android.content.Intent(android.provider.Settings.ACTION_SETTINGS)
            .apply { addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK) }
        return listOf("direct" to direct, "development" to development, "root" to root)
    }

    /**
     * Pair this app with its own phone, using the 6-digit code the user is
     * reading off the wireless-debugging dialog.
     *
     * The flow ([DESIGN-ARCH-212] 期 2): discover the pairing endpoint over
     * mDNS (it only exists while the dialog is up), run the SPAKE2 pairing
     * protocol ([AdbPairingClient]), and on success remember that the device
     * now knows our key. Pairing does NOT raise the sidecar by itself — the
     * caller follows with [elevationBootstrap] once pairing succeeded, so
     * that a pairing failure and a bootstrap failure report differently.
     *
     * The code NEVER lands in a log or a return value: the audit trail records
     * that a pairing was attempted and whether it succeeded, nothing more.
     */
    /**
     * The bridge-driven self-bootstrap.
     *
     * Same implementation as the Flutter guide sheet ([elevationPair] +
     * [elevationBootstrap]), reached through a different door. The pairing code
     * arrives as a string, goes into the SPAKE2 password, and is never logged
     * or echoed back — the reply carries the device GUID and the endpoint only.
     *
     * 开关默认关：`raise` 在开关关着时直接拒绝。任务书红线「提权默认关闭，
     * 开启需用户显式确认并知晓风险」没有静默提权的旁路。
     */
    private fun elevationTool(
        op: String,
        code: String,
        endpoint: String,
        result: MethodChannel.Result,
    ) {
        when (op) {
            "status" -> {
                result.success(mapOf(
                    "ok" to true,
                    "message" to "开关=${if (ElevationState.isEnabled(this)) "开" else "关"}"
                        + "，层=${if (ShellSidecarClient.ready()) "shell" else "none"}"
                        + "，授权=${ElevationState.deviceAuth(this)}",
                    "elevation_enabled" to ElevationState.isEnabled(this),
                    "elevated" to (if (ShellSidecarClient.ready()) "shell" else "none"),
                    "device_auth" to ElevationState.deviceAuth(this),
                    "last_pair_ms" to ElevationState.lastPairMs(this),
                ))
            }
            "on", "off" -> {
                if ("on" == op) {
                    ElevationState.setEnabled(this, true)
                    result.success(mapOf(
                        "ok" to true,
                        "elevation_enabled" to true,
                        "message" to "提权已开启；点「让手机自己拉起」启动代理。",
                    ))
                } else {
                    // 关开关要走同一条停止链，与桥工具共用一份：只翻开关不停代理，
                    // 就会出现「exec 已回落 App 层、而 info 还说 shell」两个答案。
                    val stop = com.khyos.khy_os_client.shell.ElevationBootstrap.stopSidecar(this)
                    result.success(mapOf(
                        "ok" to stop.ok,
                        "elevation_enabled" to false,
                        "message" to stop.message,
                        "detail" to stop.detail,
                    ))
                }
            }
            "pair" -> {
                if (code.length != 6 || code.any { !it.isDigit() }) {
                    result.success(mapOf(
                        "ok" to false,
                        "message" to "配对码是 6 位数字；填手机「使用配对码配对设备」弹窗里显示的那 6 位。",
                    ))
                    return
                }
                exec.execute {
                    val outcome = ElevationBootstrap.pairWithCode(this, code)
                    runOnUiThread {
                        result.success(mapOf(
                            "ok" to outcome.ok,
                            "message" to outcome.message,
                            "detail" to outcome.detail,
                            "endpoint" to outcome.endpoint,
                            "device_auth" to ElevationState.deviceAuth(this),
                            "last_pair_ms" to ElevationState.lastPairMs(this),
                        ))
                    }
                }
            }
            "raise" -> {
                if (!ElevationState.isEnabled(this)) {
                    result.success(mapOf(
                        "ok" to false,
                        "code" to com.khyos.khy_os_client.bridge.ShellLevelPolicy.CODE,
                        "message" to com.khyos.khy_os_client.shell.ElevationBootstrap
                            .switchOffMessage(true),
                    ))
                    return
                }
                exec.execute {
                    if (endpoint.isNotEmpty()) {
                        ElevationBootstrap.setEndpoint(this, endpoint)
                    }
                    val outcome = ElevationBootstrap.bootstrap(this)
                    runOnUiThread {
                        result.success(mapOf(
                            "ok" to outcome.ok,
                            "message" to outcome.message,
                            "detail" to outcome.detail,
                            "elevated" to (if (ShellSidecarClient.ready()) "shell" else "none"),
                        ))
                    }
                }
            }
            else -> result.success(mapOf(
                "ok" to false,
                "message" to "elevate 的 op 取值：status | pair | raise | on | off",
            ))
        }
    }

    /**
     * The bridge-driven self-bootstrap (Kotlin entry for the Dart side).
     *
     * Delegates to [ElevationBootstrap.pairWithCode] instead of repeating the
     * protocol. This used to be a second full copy of the flow, and it drifted
     * the moment the shared one learned to try every mDNS candidate — the
     * direction such drift always runs is "the UI pairs, the tool silently
     * doesn't", or the other way round.
     */
    private fun elevationPair(code: String, result: MethodChannel.Result) {
        exec.execute {
            val outcome = ElevationBootstrap.pairWithCode(this, code)
            runOnUiThread {
                result.success(mapOf(
                    "ok" to outcome.ok,
                    "message" to outcome.message,
                    "detail" to outcome.detail,
                    "endpoint" to outcome.endpoint,
                    "fingerprint" to ElevationBootstrap.keyFingerprint(this),
                ))
            }
        }
    }

    /**
     * Post the pairing prompt to the notification shade.
     *
     * The in-app code field cannot work on its own (measured 2026-11-18): the
     * pairing endpoint lives only while the「使用配对码配对设备」dialog is on
     * screen, and that dialog is gone by the time the user is back in this app
     * to type the code. The shade leaves it alive, so the input goes there —
     * an inline reply plus a shortcut to the wireless-debugging page.
     *
     * Reports whether the shade will actually show it: POST_NOTIFICATIONS is
     * the one permission this needs, and a silent no-op there looks exactly
     * like "I tapped it and nothing happened".
     */
    private fun postPairingPrompt(result: MethodChannel.Result) {
        val enabled = com.khyos.khy_os_client.bridge.BridgeService.notificationsEnabled()
        com.khyos.khy_os_client.bridge.BridgeService.notifyPairingPrompt()
        result.success(mapOf(
            "ok" to enabled,
            "message" to if (enabled) {
                "通知栏已发「输入配对码」。现在去开配对弹窗，然后在通知栏里填那 6 位、点发送。"
            } else {
                "通知栏权限没开——收不到配对码。请在系统设置里允许 khy-os 发通知。"
            },
        ))
    }

    /**
     * Turn the elevation switch on or off.
     *
     * OFF is the louder direction and does three things, in order: remember
     * the off state (so a restart does not silently re-raise), best-effort
     * kill the sidecar THROUGH the sidecar itself (the last thing a running
     * uid-2000 agent does is remove itself), and report honestly — the
     * process either confirmed its own death or it did not.
     *
     * ON only flips the flag; the sidecar comes up on the next bootstrap
     * (explicit tap or post-boot auto-raise). No sidecar is started from a
     * mere switch flip, because T1's contract is that elevation stays down
     * until the user asks for it twice: switch on, then raise.
     */
    private fun elevationSetEnabled(enabled: Boolean, result: MethodChannel.Result) {
        exec.execute {
            val outcome = if (enabled) {
                ElevationState.setEnabled(this, true)
                com.khyos.khy_os_client.shell.ElevationBootstrap.Result(
                    true,
                    "提权已开启；点「让手机自己拉起」启动代理。",
                )
            } else {
                // 与桥工具共用一份：两条路各写一遍，漂移方向是「UI 能停、工具停不了」。
                com.khyos.khy_os_client.shell.ElevationBootstrap.stopSidecar(this)
            }
            runOnUiThread {
                result.success(mapOf(
                    "ok" to true,
                    "enabled" to enabled,
                    "message" to outcome.message,
                ))
            }
        }
    }


    /**
     * Run a privileged command through the shell sidecar. The same whitelist
     * / blacklist applied to the plain shell is enforced here first, so the
     * elevation path can never bypass the safety gates.
     *
     * 没有 sidecar 就**明确失败**，不再退回普通 shell：这条通道的调用方要的是
     * 「以 uid 2000 执行」，退到 App 身份时命令要么无权限、要么退出 0 但什么
     * 都没做——把它当成成功正是这次改造要消灭的形态。
     */
    private fun elevatedShell(command: String, timeoutSec: Int, result: MethodChannel.Result) {
        if (command.isEmpty()) {
            result.success(mapOf("success" to false, "stdout" to "", "stderr" to "空命令", "exitCode" to -1, "via" to "none"))
            return
        }
        // Safety gate: enforce the same allow/deny rules as the plain shell.
        if (!isCommandAllowed(command)) {
            result.success(mapOf("success" to false, "stdout" to "", "stderr" to "命令被拒绝（白名单/黑名单）", "exitCode" to -1, "via" to "none"))
            return
        }

        // ⚠ 必须放到后台线程：MethodChannel 的 handler 跑在**主线程**上，而
        // execElevated 会阻塞到命令结束（远端 waitFor）。原来在这里同步等，一条
        // `sleep 300` 就能把主线程占住 300 秒 —— App 直接 ANR，看起来像「界面卡死」。
        // 后台执行 + runOnUiThread 回话，与下面 shell() 的做法一致。
        exec.execute {
            val out = ElevationManager.execElevated(
                this,
                command,
                Math.max(1, timeoutSec) * 1000L,
            )
            runOnUiThread {
                if (out != null && out.third != -1) {
                    result.success(mapOf(
                        "success" to (out.third == 0),
                        "stdout" to out.first,
                        "stderr" to out.second,
                        "exitCode" to out.third,
                        "via" to "sidecar"
                    ))
                    return@runOnUiThread
                }
                result.success(mapOf(
                    "success" to false,
                    "stdout" to "",
                    "stderr" to "提权代理未就绪，无法以 shell 身份执行；先运行一次提权代理启动命令。",
                    "exitCode" to 126,
                    "via" to "app",
                    "code" to com.khyos.khy_os_client.bridge.ShellLevelPolicy.CODE
                ))
            }
        }
    }

    // --- Permissions ---

    private fun checkPermissions(result: MethodChannel.Result) {
        val ctx = this
        val notifGranted = if (Build.VERSION.SDK_INT >= 33) {
            ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        val overlayGranted = if (Build.VERSION.SDK_INT >= 23) {
            Settings.canDrawOverlays(ctx)
        } else {
            true
        }
        val a11yGranted = KhyAccessibilityService.isReady()
        result.success(mapOf(
            "notifications" to notifGranted,
            "overlay" to overlayGranted,
            "accessibility" to a11yGranted
        ))
    }

    private fun requestNotifications(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(
                arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                REQ_NOTIF
            )
            result.success(mapOf("requested" to true))
        } else {
            result.success(mapOf("requested" to true, "message" to "Android < 13 无需请求"))
        }
    }

    private fun requestOverlay(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT >= 23) {
            try {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                )
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                result.success(mapOf("requested" to true))
            } catch (e: Exception) {
                result.success(mapOf("requested" to false, "message" to e.message))
            }
        } else {
            result.success(mapOf("requested" to true, "message" to "Android < 6 自动授予"))
        }
    }

    private fun requestAccessibility(result: MethodChannel.Result) {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            result.success(mapOf("requested" to true))
        } catch (e: Exception) {
            result.success(mapOf("requested" to false, "message" to e.message))
        }
    }

    // --- khy-os 桥（原 StepBridge 并入本 App） ---

    /**
     * 桥状态快照给 Dart 设置卡片用。令牌只回掩码——完整值在设备上
     * /sdcard/bridge-amoobridge/token.txt，PC 侧自己读。
     */
    private fun bridgeStatus(result: MethodChannel.Result) {
        // currentToken() does ZERO file IO. ensureToken() would resolve the token
        // and may read — or, when none exists yet, WRITE — the disk, which turns a
        // read-only status query into storage IO. That is the stall class the
        // per-request-IO ban exists to prevent. Empty means "not resolved yet".
        val token = HttpBridge.currentToken()
        val masked = when {
            token.isEmpty() -> "未启动"
            token.length > 8 -> token.substring(0, 4) + "…" + token.substring(token.length - 4)
            else -> token
        }
        result.success(mapOf(
            "online" to HttpBridge.healthy(),
            "port" to HttpBridge.port(),
            "tokenMasked" to masked,
            "tokenPersisted" to HttpBridge.persisted(),
            "uiReady" to Tools.uiReady(),
            "toolCount" to Tools.NAMES.size,
            "overlayRunning" to BridgeOverlayService.isRunning(),
            "overlayGranted" to (Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this)),
            "allFiles" to (Build.VERSION.SDK_INT < 30 || android.os.Environment.isExternalStorageManager()),
            // PC 最近是否在协作。false 表示手机在独立工作，不是故障。
            "pcReachable" to HttpBridge.pcReachable()
        ))
    }

    /**
     * 出向链路的配置：去哪、拿什么鉴权。
     *
     * <p>endpoint 从 /sdcard/bridge-amoobridge/link_target.txt 读——与 token.txt
     * 同一条「PC 侧写、设备侧读」的文件通道。它不落 SharedPreferences：那是
     * App 私有目录，PC 侧写不进去，而「PC 在哪」本来就是 PC 自己最清楚的事。
     *
     * <p>文件不存在 = 没有出向链路，返回空 endpoint，Dart 侧据此报 link=file。
     * 不内置任何默认地址：内置默认会在换机/换网时静默连到别人的机器上。
     */
    /**
     * 调试菜单的开抓入口。
     *
     * <p>VPN 授权只能由人在系统弹窗上点，adb 代不了。所以这条路径把「先授权再开」
     * 拆成两步：没有授权就只发 consent intent 并把 ttl 记在字段里，
     * onActivityResult 拿到 RESULT_OK 再真正 start。这样不会出现「核心已开、
     * 代理在听、但一条流量都没有」的半开状态——那种状态最难解释。
     */
    private fun netCaptureStart(call: MethodCall, result: MethodChannel.Result) {
        if (!NetCapture.debugUnlocked(this)) {
            result.success(mapOf("ok" to false, "code" to "debug_only",
                "error" to "先解锁调试菜单"))
            return
        }
        val ttlMs = (call.argument<Number>("ttlMs") ?: 0).toLong()
        // self+tls 是显式调试档：默认 false（不需要 CA、不解 TLS）。true 时代理会
        // 用调试 CA 签的叶证书尝试解密，对方不信任时逐条回「无法解密」。
        val tls = call.argument<Boolean>("tls") ?: false
        val consent = android.net.VpnService.prepare(this)
        if (consent != null) {
            pendingVpnTtlMs = ttlMs
            pendingVpnTls = tls
            try {
                startActivityForResult(consent, REQ_VPN)
                result.success(mapOf("ok" to true, "vpn" to "consent_requested"))
            } catch (e: Throwable) {
                result.success(mapOf("ok" to false, "code" to "consent_failed",
                    "error" to (e.message ?: "")))
            }
            return
        }
        netCaptureReply(result) { NetCapture.start(this, if (ttlMs > 0) ttlMs else null, tls) }
    }

    /**
     * 把 NetCapture 的 JSONObject 回执转成 MethodChannel 能序列化的 Map。
     *
     * WHY. MethodChannel 的标准编解码器只认 Map/List/String/数字/布尔；直接回
     * `org.json.JSONObject` 会在 native 侧抛
     * `IllegalArgumentException: Unsupported value ... of type 'class org.json.JSONObject'`，
     * Dart 侧只看到一句「Failed to handle method call」——面板拿不到状态，
     * 于是显示成「未开启」，即使抓包其实已经开着。
     * 这个假状态是 T17 实测时从 logcat 里抓到的（21:17:29 那条）。
     */
    private fun netCaptureReply(result: MethodChannel.Result, block: () -> JSONObject) {
        try {
            result.success(jsonToMap(block()))
        } catch (e: Throwable) {
            result.success(mapOf("ok" to false, "code" to "reply_failed",
                "error" to (e.message ?: e.javaClass.simpleName)))
        }
    }

    private fun bridgeLinkConfig(result: MethodChannel.Result) {
        var endpoint = ""
        try {
            val f = File(BridgeService.BRIDGE_DIR, "link_target.txt")
            if (f.isFile) {
                endpoint = f.readText(Charsets.UTF_8).trim().lineSequence().firstOrNull()
                    ?.trim() ?: ""
            }
        } catch (_: Throwable) {
            endpoint = ""
        }
        // 只接受 ws:// 或 wss://；其它形态（http、空串、乱码）一律当作没有配置，
        // 免得把一次配错变成一条永远在重连的链路。
        if (!(endpoint.startsWith("ws://") || endpoint.startsWith("wss://"))) endpoint = ""

        // 断点二：链路不再出示共享 token，改成「设备签名 + 服务端用公钥验签」。
        //
        // WHY：token 是同一个字符串既当「设备的身份」又当「服务端验它的凭据」，
        // 而它躺在 /sdcard 上——拿到它的人就能冒充这台设备。签名则不可转移：
        // 服务端手里只有公钥，伪造一次签名要解 ECDSA。
        //
        // 签名覆盖 deviceId|ts，服务端据此两件事：① 验签（这条确实来自持私钥
        // 的设备）；② 看 ts 偏差（超过窗口就是重放）。
        // DeviceIdentity 是 Java 类（全 static，构造私有）：Kotlin 不能把 Java 类名
        // 当表达式取值（它没有 companion），必须直接调 static。上一行
        // `val identity = ...DeviceIdentity` 编译报「does not have a companion
        // object」——语法修复，语义与原意一一对应，不加 import 以免顶移
        // companion 里被冻结表钉住行号的 AMOON_* 常量。
        val devId = com.khyos.khy_os_client.bridge.DeviceIdentity.ensureKeyPair(this)
            ?.let { com.khyos.khy_os_client.bridge.DeviceIdentity.deviceId() } ?: ""
        val ts = System.currentTimeMillis()
        val sig = if (devId.isEmpty()) "" else {
            com.khyos.khy_os_client.bridge.DeviceIdentity.signB64(this, "$devId|$ts")
        }

        result.success(mapOf(
            "endpoint" to endpoint,
            // token 字段保留但恒为空：Dart 侧与旧对端都按「空 = 无凭据」处理，
            // 直接删字段会让旧对端读到 null 后按空串拼帧，报错点跑到别处去。
            "token" to "",
            "deviceId" to devId,
            "publicKey" to com.khyos.khy_os_client.bridge.DeviceIdentity.publicKeyB64(this),
            "ts" to ts,
            "sig" to sig,
            "deviceName" to (Build.MODEL ?: ""),
            "platform" to "android",
            "heartbeatMs" to 15000,
            // Doze 下 pong 会迟到：窗口给到 3 拍，超了才算断。
            "pongWindowMs" to 45000
        ))
    }

    /**
     * Dart 侧回报链路状态。原生侧只存，不判断——判断在
     * {@link BridgeLinkState#alive()}，因为 status.json 与 pc_reachable 都在
     * 原生侧读，两份判断迟早不一致。
     */
    private fun bridgeLinkState(result: MethodChannel.Result, call: MethodCall) {
        try {
            BridgeLinkState.update(
                call.argument<Boolean>("connected") ?: false,
                (call.argument<Number>("lastPongMs") ?: 0).toLong(),
                (call.argument<Number>("reconnectCount") ?: 0).toLong(),
                call.argument<String>("endpoint") ?: "",
                // 断点二：鉴权结果必须跟着链路状态一起上报。缺了这两个字段，
                // 服务端回 auth:error 时设备侧仍会报 link=wss（实测过）。
                call.argument<String>("authState") ?: "none",
                call.argument<String>("authCode") ?: ""
            )
            result.success(true)
        } catch (e: Exception) {
            result.success(false)
        }
    }

    private fun bridgeStart(result: MethodChannel.Result) {
        try {
            BridgeService.start(this)
            result.success(mapOf("started" to true))
        } catch (e: Exception) {
            result.success(mapOf("started" to false, "message" to e.message))
        }
    }

    private fun bridgeStop(result: MethodChannel.Result) {
        try {
            BridgeService.stop(this)
            result.success(mapOf("stopped" to true))
        } catch (e: Exception) {
            result.success(mapOf("stopped" to false, "message" to e.message))
        }
    }

    // --- 微信 bot 通道（WeChatBotService 是保活壳；轮询/凭据全在 Dart 侧） ---

    private fun wechatStart(result: MethodChannel.Result) {
        try {
            WeChatBotService.start(this)
            result.success(mapOf("started" to true))
        } catch (e: Exception) {
            result.success(mapOf("started" to false, "message" to e.message))
        }
    }

    private fun wechatStop(result: MethodChannel.Result) {
        try {
            WeChatBotService.stop(this)
            result.success(mapOf("stopped" to true))
        } catch (e: Exception) {
            result.success(mapOf("stopped" to false, "message" to e.message))
        }
    }

    /**
     * 只显示悬浮框，不动桥。
     *
     * 必须先查权限再起服务：BridgeOverlayService.onCreate 在没有 SYSTEM_ALERT_WINDOW
     * 时会 running=false + stopSelf。不预查就会回 shown=true 而屏上什么都没有——
     * 状态位与事实分叉，比没有这个开关更糟。
     *
     * startForUser 标记「用户自己要的」：这一颗悬浮框此后不再随桥的停止而被收回
     * （见 BridgeOverlayService.stopWithBridge）。
     */
    private fun overlayShow(result: MethodChannel.Result) {
        try {
            if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
                result.success(mapOf("shown" to false, "message" to "没有悬浮窗权限"))
                return
            }
            BridgeOverlayService.setEnabled(this, true)
            BridgeOverlayService.startForUser(this)
            result.success(mapOf("shown" to true))
        } catch (e: Exception) {
            result.success(mapOf("shown" to false, "message" to e.message))
        }
    }

    /**
     * 只隐藏悬浮框，不停桥。
     *
     * 偏好写盘在 BridgeOverlayService.setEnabled 里走 SharedPreferences.apply()：
     * apply() 在后台线程落盘，这条 platform 主线程不等盘。用 commit() 就等于把一次
     * 同步 IO 加到方法通道上。
     *
     * 显式 stop 会清掉 userOwned：用户自己关的东西，桥下次重建时不该把它拉回来。
     */
    private fun overlayHide(result: MethodChannel.Result) {
        try {
            BridgeOverlayService.setEnabled(this, false)
            BridgeOverlayService.stop(this)
            result.success(mapOf("hidden" to true))
        } catch (e: Exception) {
            result.success(mapOf("hidden" to false, "message" to e.message))
        }
    }

    /** 打开「所有文件访问」设置页（桥的文件信箱与工作区同步需要）。 */
    private fun requestAllFiles(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                val intent = Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:$packageName")
                )
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                result.success(mapOf("requested" to true))
            } catch (e: Exception) {
                result.success(mapOf("requested" to false, "message" to e.message))
            }
        } else {
            result.success(mapOf("requested" to true, "message" to "Android < 11 安装即授权"))
        }
    }

    // --- amoo（本机 Intent；主路径不是 PC 桥） ---

    /**
     * amoo 安装/可解析状态。只读：resolveActivity 不启动任何东西。
     *
     * 与 PC 侧 bridge-tools.js:24-27 使用同一组常量。ShareActivity 声明了
     * ACTION_SEND text/plain；ChatMainActivity 只声明 OPEN_CHAT，不承诺接收文本。
     */
    private fun amooStatus(result: MethodChannel.Result) {
        if (amooDriverDisabled()) {
            result.success(mapOf(
                "installed" to false,
                "versionName" to "",
                "canShare" to false,
                "canOpenChat" to false,
                "packageName" to AMOON_PACKAGE,
                "disabled" to true,
                "message" to "amoo driver 已在设置中禁用",
            ))
            return
        }
        try {
            val pm = packageManager
            var installed = false
            var version = ""
            try {
                val info = pm.getPackageInfo(AMOON_PACKAGE, 0)
                installed = true
                version = info.versionName ?: ""
            } catch (_: PackageManager.NameNotFoundException) {
                installed = false
            }
            val share = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                setClassName(AMOON_PACKAGE, AMOON_SHARE_ACTIVITY)
            }
            val chat = Intent(AMOON_OPEN_CHAT).apply {
                setClassName(AMOON_PACKAGE, AMOON_CHAT_ACTIVITY)
            }
            result.success(mapOf(
                "installed" to installed,
                "versionName" to version,
                "canShare" to (pm.resolveActivity(share, PackageManager.MATCH_DEFAULT_ONLY) != null),
                "canOpenChat" to (pm.resolveActivity(chat, PackageManager.MATCH_DEFAULT_ONLY) != null),
                "packageName" to AMOON_PACKAGE,
            ))
        } catch (e: Exception) {
            result.success(mapOf(
                "installed" to false,
                "versionName" to "",
                "canShare" to false,
                "canOpenChat" to false,
                "packageName" to AMOON_PACKAGE,
                "message" to (e.message ?: "unknown"),
            ))
        }
    }

    /**
     * 把文本交给 amoo。永远不返回「已发送」：直接 startActivity 只代表
     * amoo 受理了 Intent。显式组件不可用时**只**退回一个限定包名的 chooser，
     * 不把文本暴露给任意应用。
     */
    private fun sendToAmoo(text: String, result: MethodChannel.Result) {
        if (amooDriverDisabled()) {
            result.success(mapOf(
                "ok" to false,
                "via" to "none",
                "code" to "driver_disabled",
                "message" to "amoo driver 已在设置中禁用",
            ))
            return
        }
        val body = text.trim()
        if (body.isEmpty()) {
            result.success(mapOf("ok" to false, "via" to "none", "message" to "内容为空，未发送"))
            return
        }
        val capped = if (body.length > 4000) body.substring(0, 4000) else body
        val truncated = body.length > 4000

        val direct = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            setClassName(AMOON_PACKAGE, AMOON_SHARE_ACTIVITY)
            putExtra(Intent.EXTRA_TEXT, capped)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(direct)
            result.success(mapOf(
                "ok" to true,
                "via" to "direct",
                "truncated" to truncated,
                "message" to "已交给 amoo 分享页（未确认送达）",
            ))
            return
        } catch (_: ActivityNotFoundException) {
            // 显式组件不存在或未导出 → 下一步只允许 amoo 的 chooser
        } catch (_: SecurityException) {
            // 同上
        }

        // 兜底也必须 package-scoped：文本不能出现在任意应用的分享目标里。
        val scoped = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            setPackage(AMOON_PACKAGE)
            putExtra(Intent.EXTRA_TEXT, capped)
        }
        if (packageManager.resolveActivity(scoped, PackageManager.MATCH_DEFAULT_ONLY) == null) {
            result.success(mapOf(
                "ok" to false,
                "via" to "none",
                "truncated" to truncated,
                "message" to "amoo 分享入口不可用（组件未导出或未注册），文本未发送",
            ))
            return
        }
        try {
            val chooser = Intent.createChooser(scoped, "发送到 amoo").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(chooser)
            result.success(mapOf(
                "ok" to true,
                "via" to "chooser",
                "truncated" to truncated,
                "message" to "已打开系统分享面板（仅 amoo），未确认送达",
            ))
        } catch (e: Exception) {
            result.success(mapOf(
                "ok" to false,
                "via" to "none",
                "truncated" to truncated,
                "message" to "无法打开分享面板：${e.message}",
            ))
        }
    }

    /** 打开 amoo 聊天页：OPEN_CHAT → 启动器入口 → 失败。不预填、不发送。 */
    /**
     * amoo 反代：发起一次提问。
     *
     * 为什么返回值要区分三种 null。AmooLoop.ask() 返回 null 有三种原因——已有任务在跑、
     * prompt 为空、Amoo 不在前台——而三者要的界面动作完全不同：第一种该显示「正在跑」，
     * 第二种是输入框问题，第三种必须弹「先去打开 amoo」。全折成一个 null 的话，界面只能
     * 显示一句没头没尾的失败，用户无从下手。
     *
     * ask() 是 synchronized 且起线程后立即返回，所以这里不会阻塞主线程。
     *
     * route 由调用方声明走哪条路："direct" = apex 直连（默认，也是除故障外唯一
     * 该走的一条），"screen" = 无障碍读屏。只有降级重发会传 screen。
     */
    /**
     * amoo driver 禁用门（§5.1）。六方法共用同一判定。
     *
     * 键不存在 = 未禁用（fail-open 到功能可用）：禁用写入永远经
     * setDriverEnabled 显式发生，不做任何默认推断。
     */
    private fun amooDriverDisabled(): Boolean =
        DriverGate.isDisabled(DriverGate.prefs(this), "amoo")

    private fun amooAsk(
        prompt: String,
        timeoutMs: Long,
        route: String,
        result: MethodChannel.Result
    ) {
        if (amooDriverDisabled()) {
            result.success(mapOf(
                "ok" to false,
                "code" to "driver_disabled",
                "message" to "amoo driver 已在设置中禁用",
            ))
            return
        }
        val trimmed = prompt.trim()
        // 读屏路由：apex 通道让出去，不起新任务。直连断了还再启动一遍 apex，
        // 是把同一故障重演；而不让出通道的话，上一次 apex 的失败终态会一直遮住
        // AmooLoop 的结果（AmooApexLink.result 只在 apexActive 时返回非 null，
        // 见那边 apexActive 的注释）。
        if (route == "screen") AmooApexLink.releaseChannel()
        val apexJob = if (route == "screen") null else AmooApexLink.ask(this, trimmed, timeoutMs)
        val job = apexJob ?: AmooLoop.ask(trimmed, timeoutMs)
        if (job != null) {
            result.success(mapOf("ok" to true, "job" to job, "state" to "running"))
            return
        }
        val why = AmooLoop.askResult().optString("error", "")
        val code = when {
            // 分档判据只有 AmooLoop.isForegroundRefusal 一处（S4）：前缀而不是
            // 整句相等——AmooLoop.ask 写的是一句带指引的长句，等值判断会整个
            // 失效，调用方重新落进 single_flight——而现场一个任务都没有。
            AmooLoop.isForegroundRefusal(why) -> "amoo_not_foreground"
            trimmed.isEmpty() -> "empty_prompt"
            // 预检拒绝（无障碍服务没开等）有它自己的理由，不能冒充「已有提问在进行中」。
            //
            // 判据与桥侧 Tools.ask 一致：why 非空且不是上面那一种 = 预检拒绝。
            // 漏掉这一支的后果是假的：条件没满足时这里报「已有提问在进行中」，
            // 而现场根本没有任务在跑——调用方（人或 Agent）以为要等，白等整个预算。
            // 桥侧那个同形缺陷已经被 UiAdviceTest 钉住（"THE BUG THIS GUARDS"），
            // 这一支是当时漏掉的另一半：桥修了，Flutter 通道没修。
            //
            // 孤儿自愈（上一笔提问超过最大预算仍未结束，askResult 把单飞锁放了）
            // 必须排在 refused 之前：它同样有一句非空的 why，落进 refused 桶的
            // 后果是用户看到「被拒绝」，于是去逐个检查权限——而权限一直是好的，
            // 真正发生的是上一笔卡死刚被释放，该做的只是再发一次。
            // 判据用前缀：后半句是给人读的，改措辞不该让它悄悄换桶。
            why.startsWith("orphaned_ask") -> "orphan_cleared"
            why.isNotEmpty() -> "refused"
            else -> "single_flight"
        }
        val message = when (code) {
            "amoo_not_foreground" -> "amoo 不在前台，先打开 amoo 再提问"
            "empty_prompt" -> "请输入内容"
            // 与 refused 同构：透传 healOrphanedAsk 写进 askError 的那句原话
            // （"orphaned_ask: …单飞锁已自动释放，可重试"）。这里原是一句自制罐头
            // 消息，Dart 侧的「原话优先」于是拿到一句原生从未说过的话——用户看到
            // 「已清理」，却不知道锁已经放了、现在就能重试。
            "orphan_cleared" -> why
            "refused" -> why
            else -> "已有提问在进行中"
        }
        result.success(mapOf("ok" to false, "code" to code, "message" to message))
    }

    /** amoo 反代：轮询一次结果。Dart 侧每 ~2s 调一次，不阻塞。apex 任务优先。 */
    private fun amooAskResult(result: MethodChannel.Result) {
        if (amooDriverDisabled()) {
            result.success(mapOf(
                "ok" to false,
                "code" to "driver_disabled",
                "message" to "amoo driver 已在设置中禁用",
            ))
            return
        }
        val apex = AmooApexLink.result()
        val r = apex ?: AmooLoop.askResult() ?: run {
            result.success(mapOf("ok" to false, "code" to "unavailable"))
            return
        }
        val state = r.optString("state", "").ifEmpty { "idle" }
        // 屏幕常亮由轮询自己维护：提问在跑就一直亮，一停就撤。
        //
        // 为什么必须有：回复是从 amoo 的无障碍树上读的，而熄屏后那棵树会过期。
        // 不保住屏幕的话，一轮 6 分钟的提问会在中途熄屏，然后读到一个空/旧的
        // 气泡，报"未拿到回复"——而 amoo 其实答得很好。
        //
        // 放在 result 里维护而不是在 ask 里设一次：任务可能失败、被中断、或
        // 等待器随进程死掉，只有轮询看得见真实状态。
        setKeepScreenOn(state == "running")
        // 这一轮是谁答的：apex 桥（直连）还是无障碍读屏。Dart 侧
        // （amoo_chat_service.dart 的 AmooAskOutcome.via）靠这个键把两条路的答案
        // 分开——不知道答案从哪条路来，界面就没法解释为什么这次快了/慢了，
        // 降级日志也没有可指的证据。键名两侧必须一致，缺一侧即红，判据由
        // B4 静态门（checks/B4_transport_via_wired.cmd）钉住。
        val via = if (apex != null) "direct" else "screen"
        val out = mutableMapOf<String, Any>("ok" to true, "state" to state, "via" to via)
        if (state == "failed") out["error"] = r.optString("error", "")
        if (state == "done") out["reply"] = r.optString("reply", "")
        result.success(out)
    }

    /**
     * 提问期间保持屏幕常亮。
     *
     * 只加 [WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON]，不碰 WakeLock：
     * 那个标志只在本窗口可见时生效，用户切走就自动失效，不需要我们记得撤；
     * 而 WakeLock 是进程级的，忘了释放就会一直亮着耗电。
     */
    private fun setKeepScreenOn(on: Boolean) {
        if (isFinishing) return
        runOnUiThread {
            if (on) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    /** amoo 反代：中断当前提问。两条路都停——没在跑的那条是空操作。 */
    private fun amooAskStop(result: MethodChannel.Result) {
        if (amooDriverDisabled()) {
            result.success(mapOf(
                "ok" to false,
                "code" to "driver_disabled",
                "message" to "amoo driver 已在设置中禁用",
            ))
            return
        }
        AmooApexLink.stopAsk(); AmooLoop.stopAsk()
        result.success(mapOf("ok" to true))
    }

    private fun openAmoo(result: MethodChannel.Result) {
        if (amooDriverDisabled()) {
            result.success(mapOf(
                "ok" to false,
                "code" to "driver_disabled",
                "message" to "amoo driver 已在设置中禁用",
            ))
            return
        }
        val chat = Intent(AMOON_OPEN_CHAT).apply {
            setClassName(AMOON_PACKAGE, AMOON_CHAT_ACTIVITY)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(chat)
            result.success(mapOf("ok" to true, "via" to "chat", "message" to "已打开 amoo 聊天页"))
            return
        } catch (_: ActivityNotFoundException) {
        } catch (_: SecurityException) {
        }

        val launch = packageManager.getLaunchIntentForPackage(AMOON_PACKAGE)
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                startActivity(launch)
                result.success(mapOf("ok" to true, "via" to "launcher", "message" to "已打开 amoo"))
                return
            } catch (_: Exception) {
            }
        }
        result.success(mapOf("ok" to false, "via" to "none", "message" to "未安装 amoo 或无法启动"))
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIF) {
            val granted = grantResults.isNotEmpty() &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED
            // The checkPermissions method will reflect this on next call
        }
    }

    // --- File System ---

    /// 用户挑的工作空间根。null = 没挑 = 用 App 既有的私有外部目录。
    ///
    /// 为什么放原生而不是 Dart：文件工具的路径解析全在这一层
    /// （resolvePath），containment 检查也在这里。根放在 Dart 侧就意味着
    /// 每次调用都要多传一个参数，而漏传一次就静默落回私有目录——那种 bug
    /// 在界面上看不出来，只会表现成"我明明选了目录，文件却不在那"。
    ///
    /// 落 SharedPreferences：进程被杀后重建时要能恢复，否则重启一次手机，
    /// 用户挑的目录就没了，而界面还显示着挑过。
    private var workRoot: String? = null
        get() = field
        set(value) {
            field = value?.takeIf { it.isNotBlank() }
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_WORK_ROOT, field)
                .apply()
        }

    private fun workBase(): java.io.File =
        workRoot?.let { java.io.File(it) } ?: (getExternalFilesDir(null) ?: filesDir)

    private fun workDirInfo(): Map<String, Any> {
        val base = workBase()
        return mapOf(
            "path" to base.absolutePath,
            "exists" to base.exists(),
            // 是不是 App 私有目录。界面据此说"文件管理器看不到"——这句话
            // 是用户找不到文件时的第一手线索，不能省略。
            "isAppPrivate" to (workRoot == null),
        )
    }

    private fun setWorkRoot(path: String?, result: MethodChannel.Result) {
        // 只接受绝对路径。相对路径会被解析到进程 cwd，那是个不确定的东西，
        // 而且 containment 检查会因此失去意义。
        if (path != null && path.isNotBlank() && !path.startsWith("/")) {
            result.success(mapOf("ok" to false, "error" to "工作目录必须是绝对路径"))
            return
        }
        workRoot = path
        result.success(mapOf("ok" to true, "path" to workBase().absolutePath))
    }

    private fun resolvePath(relative: String): java.io.File {
        val base = workBase()
        val target = base.resolve(relative).normalize()
        // Security: ensure path stays within base
        if (!target.absolutePath.startsWith(base.absolutePath)) {
            throw SecurityException("Path escapes working directory: $relative")
        }
        return target
    }

    /**
     * 工作区文件列举的上限。
     *
     * 原来没有上限——`dir.listFiles()` 全量返回。一个相册目录动辄几千项，
     * 全塞进一次 MethodChannel 结果里，既拖慢 UI 又把"批量导出"变成一次调用的事。
     *
     * Amoo 的红线（AMOO-GUIDELINES.md §4.6）禁止它用 ls/find 静默批量导出用户数据，
     * 而且明说"判定是最终读到了什么，不是调了哪个接口"。我们这边的工具替它执行，
     * 它的规则管不到我们的手——所以上限必须由我们自己设。
     *
     * 单次上限防不住"分很多次小列举累积成导出"，那需要任务级预算（规划层的职责）。
     */
    private val FILE_LIST_MAX = 200

    /** 单次读文件的上限（字节）。与桥的 READ_HARD_MAX 对齐。 */
    private val FILE_READ_MAX = 256 * 1024

    private fun fileList(relative: String): Map<String, Any> {
        return try {
            val dir = resolvePath(if (relative.isEmpty() || relative == ".") "" else relative)
            if (!dir.exists() || !dir.isDirectory) {
                mapOf("success" to false, "error" to "目录不存在: $relative")
            } else {
                val all = dir.listFiles() ?: emptyArray()
                val truncated = all.size > FILE_LIST_MAX
                // 截断必须显式回报。静默 break 会让调用方拿到一份看起来完整、
                // 实际被砍过的清单——而它无法知道。那比直接报错更糟：错误会促使
                // 排查，部分结果会被当成结论用。
                val entries = all.sortedBy { it.name }.take(FILE_LIST_MAX).map { f ->
                    mapOf(
                        "name" to f.name,
                        "isDir" to f.isDirectory,
                        "size" to (if (f.isFile) f.length() else 0L),
                    )
                }
                mapOf(
                    "success" to true,
                    "path" to relative,
                    "files" to entries,
                    "count" to entries.size,
                    "truncated" to truncated,
                    "total" to all.size,
                    "cap" to FILE_LIST_MAX,
                )
            }
        } catch (e: Exception) {
            mapOf("success" to false, "error" to (e.message ?: "unknown"))
        }
    }

    private fun fileRead(relative: String): Map<String, Any> {
        return try {
            val f = resolvePath(relative)
            if (!f.exists() || !f.isFile) {
                mapOf("success" to false, "error" to "文件不存在: $relative")
            } else {
                val bytes = f.readBytes()
                val truncated = bytes.size > FILE_READ_MAX
                val shown = if (truncated) bytes.copyOf(FILE_READ_MAX) else bytes
                mapOf(
                    "success" to true,
                    "content" to String(shown, Charsets.UTF_8),
                    "size" to bytes.size.toLong(),
                    "truncated" to truncated,
                    "cap" to FILE_READ_MAX,
                )
            }
        } catch (e: Exception) {
            mapOf("success" to false, "error" to (e.message ?: "unknown"))
        }
    }

    private fun fileWrite(relative: String, content: String, result: MethodChannel.Result) {
        exec.execute {
            try {
                val f = resolvePath(relative)
                f.parentFile?.mkdirs()
                // 卡片要画红绿 ± 行，需要改前的原文。超过读取上限就不回传 ——
                // 把截断的一半当原文去比对，画出来的红绿是错的，比没有更糟。
                val existed = f.exists() && f.isFile
                val before = if (existed && f.length() <= FILE_READ_MAX) f.readText() else null
                f.writeText(content)
                runOnUiThread {
                    result.success(mapOf(
                        "success" to true,
                        "path" to relative,
                        "size" to content.length,
                        "existed" to existed,
                        "before" to before,
                    ))
                }
            } catch (e: Exception) {
                runOnUiThread {
                    result.success(mapOf("success" to false, "error" to (e.message ?: "unknown")))
                }
            }
        }
    }

    private fun fileCreateDir(relative: String): Map<String, Any> {
        return try {
            val dir = resolvePath(relative)
            val ok = if (dir.exists()) true else dir.mkdirs()
            mapOf("success" to ok, "path" to relative)
        } catch (e: Exception) {
            mapOf("success" to false, "error" to (e.message ?: "unknown"))
        }
    }

    private fun fileEdit(path: String, oldText: String, newText: String, replaceAll: Boolean, result: MethodChannel.Result) {
        exec.execute {
            try {
                val f = resolvePath(path)
                if (!f.exists() || !f.isFile) {
                    runOnUiThread { result.success(mapOf("success" to false, "error" to "file not found: $path")) }
                    return@execute
                }
                val content = f.readText()
                val count = countOccurrences(content, oldText)
                if (count == 0) {
                    runOnUiThread { result.success(mapOf("success" to false, "error" to "oldText not found in $path")) }
                    return@execute
                }
                val updated = if (replaceAll) content.replace(oldText, newText)
                else content.replaceFirst(oldText, newText)
                f.writeText(updated)
                // 同 fileWrite：超限的原文不回传，宁可没有 diff 也不画一份错的。
                val snapshot = content.length <= FILE_READ_MAX && updated.length <= FILE_READ_MAX
                runOnUiThread {
                    result.success(mapOf(
                        "success" to true,
                        "replacements" to (if (replaceAll) count else 1),
                        "size" to updated.length,
                        "before" to (if (snapshot) content else null),
                        "after" to (if (snapshot) updated else null),
                    ))
                }
            } catch (e: Exception) {
                runOnUiThread { result.success(mapOf("success" to false, "error" to (e.message ?: "unknown"))) }
            }
        }
    }

    private fun fileFind(dir: String, pattern: String, maxResults: Int): Map<String, Any> {
        return try {
            val base = if (dir.isEmpty() || dir == ".") resolvePath("") else resolvePath(dir)
            if (!base.exists() || !base.isDirectory) {
                return mapOf("success" to false, "error" to "directory not found: $dir")
            }
            val results = mutableListOf<String>()
            base.walkTopDown().maxDepth(10).forEach { file ->
                if (results.size >= maxResults) return@forEach
                if (file.isFile) {
                    val name = file.name
                    val relPath = relativePath(base, file)
                    // Simple glob: * matches within filename, ** matches across dirs
                    val regex = globToRegex(pattern)
                    if (regex.matches(relPath) || regex.matches(name)) {
                        results.add(relPath)
                    }
                }
            }
            mapOf("success" to true, "files" to results, "count" to results.size, "truncated" to (results.size >= maxResults))
        } catch (e: Exception) {
            mapOf("success" to false, "error" to (e.message ?: "unknown"))
        }
    }

    private fun fileGrep(dir: String, regex: String, filePattern: String, maxResults: Int): Map<String, Any> {
        return try {
            val base = if (dir.isEmpty() || dir == ".") resolvePath("") else resolvePath(dir)
            if (!base.exists()) return mapOf("success" to false, "error" to "directory not found")
            if (regex.isEmpty()) return mapOf("success" to false, "error" to "empty regex")
            val pattern = try { Regex(regex) } catch (e: Exception) { return mapOf("success" to false, "error" to "invalid regex: ${e.message}") }
            val results = mutableListOf<Map<String, Any>>()
            base.walkTopDown().maxDepth(10).forEach { file ->
                if (results.size >= maxResults) return@forEach
                if (!file.isFile) return@forEach
                if (file.length() > 500_000) return@forEach // skip large files
                // If filePattern specified, filter
                if (filePattern.isNotEmpty()) {
                    val fRegex = try { Regex(filePattern) } catch (e: Exception) { null }
                    if (fRegex != null && !fRegex.matches(file.name)) return@forEach
                }
                try {
                    val lines = file.readLines()
                    for ((i, line) in lines.withIndex()) {
                        if (results.size >= maxResults) break
                        if (pattern.containsMatchIn(line)) {
                            results.add(mapOf(
                                "file" to relativePath(base, file),
                                "line" to (i + 1),
                                "text" to line.take(200)
                            ))
                        }
                    }
                } catch (_: Exception) { /* skip binary/unreadable */ }
            }
            mapOf("success" to true, "matches" to results, "count" to results.size)
        } catch (e: Exception) {
            mapOf("success" to false, "error" to (e.message ?: "unknown"))
        }
    }

    private fun countOccurrences(text: String, sub: String): Int {
        var count = 0
        var idx = text.indexOf(sub)
        while (idx != -1) {
            count++
            idx = text.indexOf(sub, idx + sub.length)
        }
        return count
    }

    private fun relativePath(baseDir: java.io.File, file: java.io.File): String {
        return file.absolutePath.removePrefix(baseDir.absolutePath + "/")
    }

    private fun globToRegex(glob: String): Regex {
        val sb = StringBuilder("^")
        for (c in glob) {
            when (c) {
                '*' -> sb.append(".*")
                '?' -> sb.append(".")
                '.' -> sb.append("\\.")
                '/' -> sb.append("/")
                else -> sb.append(c)
            }
        }
        sb.append("\$")
        return Regex(sb.toString())
    }

    companion object {
        private const val SCREEN_CAPTURE_REQUEST = 1001
        private const val REQ_NOTIF = 1002
        private const val REQ_VPN = 1003

        // VPN 授权弹窗返回时要用的 ttl。放静态字段是因为授权是跨 Activity
        // 生命周期的：弹窗期间本 Activity 可能被重建，实例字段会丢。
        @JvmField
        @Volatile
        var pendingVpnTtlMs: Long = 0L

        // 同上：self+tls 档的选择也要活过授权弹窗。默认 false——默认档不需要 CA。
        @JvmField
        @Volatile
        var pendingVpnTls: Boolean = false

        // 用户挑的工作空间根。放 SharedPreferences 而不是进程字段：进程被杀后
        // 重建时要恢复，否则重启一次手机用户挑的目录就没了，而界面还显示挑过。
        private const val PREFS_NAME = "khy_os_work"
        private const val KEY_WORK_ROOT = "work_root"

        // amoo：与 khy-amoon-bridge/lib/bridge-tools.js:24-27 同一组常量
        private const val AMOON_PACKAGE = "com.stepos.ailauncher"
        private const val AMOON_SHARE_ACTIVITY = "com.stepos.ailauncher.chat.activity.ShareActivity"
        private const val AMOON_CHAT_ACTIVITY = "com.stepos.ailauncher.chat.activity.ChatMainActivity"
        private const val AMOON_OPEN_CHAT = "com.stepos.ailauncher.action.OPEN_CHAT"

        // 悬浮窗等 App 外入口发来的「接下来要开哪一页」。事件不是状态：consume
        // 即清空（同 consumeSharedText 的契约），重放旧路由会把用户拽回他不想去
        // 的页。进程字段而非 intent extra：悬浮窗 service 与本 Activity 同进程，
        // 同进程内静态可靠；跨进程就走 intent 了。取值约定见 consumePendingRoute。
        // @JvmField：写入方是 Java（BridgeOverlayService），没有它 Kotlin companion
        // 属性在 Java 侧只能走 Companion.get/set，直呼 MainActivity.pendingRouteRequest
        // 会报 private 访问控制——上一轮编译就是被这个拦下的。
        @JvmField
        @Volatile
        var pendingRouteRequest: String? = null
    }

    // Delivery canary stamp, read from the "khy.build" meta-data the manifest
    // placeholder baked in as a literal. Defined below the companion object on
    // purpose: the amoo frozen table pins the AMOON_* constants by line number,
    // and anything added above them shifts every pinned coordinate.
    private fun khyBuildStamp(): String {
        return try {
            val ai = packageManager.getApplicationInfo(packageName, PackageManager.GET_META_DATA)
            ai.metaData?.getString("khy.build") ?: ""
        } catch (e: Exception) {
            ""
        }
    }
}
