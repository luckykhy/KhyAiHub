// khy-canary: Khy-20261112-010-BOOTSTRAP
package com.khyos.khy_os_client.shell

import android.content.Context
import android.content.SharedPreferences
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import com.khyos.khy_os_client.bridge.DeviceIdentity
import com.khyos.khy_os_client.bridge.ShellSidecarClient
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * ElevationBootstrap — khyos raising its OWN privileged agent, with no PC.
 *
 * WHAT THIS IS. The app talks to the phone's own wireless-debugging endpoint
 * with its own adb identity, gets a uid-2000 shell, and starts the sidecar
 * from there. After that, every privileged command the app runs is a shell
 * command — the same privilege level a uid-2000 shell agent has, reached
 * without a second app, without root, and without a computer in the loop.
 *
 * THE ONE STEP THAT STILL NEEDS A HUMAN (and only once). The platform only
 * grants a shell to an adb key it has already authorized, and authorizing a
 * key means going through the pairing flow — which the platform implements in
 * native code (see [DESIGN-ARCH-212] §2.6 for what the decompiled pairing
 * client actually does). So:
 *
 *   1. the app generates an RSA keypair and shows its fingerprint;
 *   2. the user runs ONE command on a computer, which registers that key with
 *      the device (the pairing code on the phone's own screen is what makes
 *      it work — the same code the phone shows for any wireless debugger);
 *   3. from then on, the app raises the sidecar by itself, after every
 *      reboot, with nobody at a keyboard.
 *
 * Step 2 is a platform fact, not a khyos limitation, and this class does not
 * pretend otherwise: [bootstrap] reports it honestly instead of hanging.
 *
 * WHY THE SIDECAR IS STARTED FROM THE APP'S OWN APK. The sidecar class ships
 * inside this APK, so the device already has the exact code that has to run.
 * Starting it with `CLASSPATH=<own apk> app_process` means there is nothing
 * to upload, nothing to keep in sync, and no second copy of the app's code on
 * the device — the "one APK" property survives the bootstrap.
 */
object ElevationBootstrap {

    /**
     * What a bootstrap attempt produced.
     *
     * @JvmField so the Java-side bridge tool reads these as fields; Kotlin's
     * default property getters are not visible to Java callers.
     */
    class Result(
        /** True when the sidecar is up and answering. */
        @JvmField val ok: Boolean,
        /** One line, in Chinese, for the user. */
        @JvmField val message: String,
        /** The technical detail (an error message, a log line). Not for users. */
        @JvmField val detail: String = "",
    )

    /** The sidecar's class, as it is named inside this APK. */
    const val SIDECAR_CLASS = "com.khyos.khy_os_client.shell.ShellSidecar"

    /**
     * What to do when the switch is off — for the person tapping the button.
     *
     * The UI and the bridge tool have different audiences: one has a switch on
     * the same screen, the other has a command to run. Telling the UI user to
     * run `elevate op=on` is how "self-elevation failed" gets reported when
     * nothing is actually broken (measured 2026-11-17: the guide's four steps
     * never mention the switch, it defaults to off, and the refusal named a
     * command that exists nowhere in the UI).
     *
     * "本页上方" is not filler: the switch sits above a long sheet, and a user
     * who has scrolled down to the buttons cannot see it.
     */
    const val SWITCH_OFF_NEXT_UI =
        "先在本页上方把「启用提权」开关打开（默认关闭），再点「让手机自己拉起」。"

    /** The same next step, for a caller that drives the bridge tool. */
    const val SWITCH_OFF_NEXT_TOOL = "先用 elevate op=on 打开，再拉起代理。"

    /** Why this step refuses instead of lifting quietly. Shared by both. */
    const val SWITCH_OFF_WHY = "开关默认关是红线，这一步没有静默提权的路。"

    /** The full refusal sentence, aimed at [forUi] or at a tool caller. */
    @JvmStatic
    fun switchOffMessage(forUi: Boolean): String =
        "提权开关是关的。${if (forUi) SWITCH_OFF_NEXT_UI else SWITCH_OFF_NEXT_TOOL}——$SWITCH_OFF_WHY"

    /**
     * What to say when the app has no pairing on this device.
     *
     * Split out of [bootstrap] so it is testable without a Context, and so the
     * sentence has one home. The point of the sentence is that filling in the
     * endpoint does NOT substitute for the one-time pairing — measured
     * 2026-11-18, a user typed the right address, got "端口可能已经过期", and went
     * to change the one thing that was already correct.
     *
     * @param auth the value of [ElevationState.deviceAuth], reported so the
     *        caller can see which of the two un-paired-ish states it was.
     */
    @JvmStatic
    fun notPairedMessage(auth: String): String =
        "本 App 还没和这台手机配对过（授权态：$auth），设备不认它的钥匙——连上也会被踢掉。" +
            "先按引导页第 2、3 步做一次配对：开「使用配对码配对设备」弹窗，把那 6 位填进输入框点「配对」，" +
            "再回来点「让手机自己拉起」。配对只需做一次，填端点代替不了它。"

    /** Where the sidecar's log goes. The PC-side script uses the same path. */
    const val SIDECAR_LOG = "/data/local/tmp/sidecar.log"

    /**
     * Where the sidecar's pid is remembered, so the next launch can aim at it.
     *
     * Needed because the obvious `pkill -f <class>` kills the shell running the
     * launch line itself — the class name is in that line. See [raiseSidecar].
     */
    const val SIDECAR_PID = "/data/local/tmp/sidecar.pid"

    /**
     * The plain-TCP adbd port on the device's own loopback.
     *
     * `adb tcpip 5555` opens it; the one-time host setup does that, and the
     * App then keeps it open across reboots by pinning
     * `persist.adb.tcp.port`. With it open, the App can raise the sidecar on
     * its own — no PC, no TLS, no second app.
     */
    const val LOOPBACK_PORT = 5555

    /** The prefs file that remembers the endpoint and the key. */
    private const val PREFS = "khy_elevation"

    private const val PREF_ENDPOINT = "endpoint"

    /** The app's private directory for its adb identity. */
    private const val KEY_FILE = "elevation/adb_key.pem"

    /**
     * The remembered wireless-debugging endpoint, "ip:port".
     *
     * Empty when the user has never typed one in.
     */
    fun endpoint(context: Context): String =
        prefs(context).getString(PREF_ENDPOINT, "") ?: ""

    /** Remember the endpoint. An empty value clears it. */
    fun setEndpoint(context: Context, value: String) {
        prefs(context).edit().putString(PREF_ENDPOINT, value.trim()).apply()
    }

    /** A short fingerprint of the app's adb identity, for the user to compare. */
    fun keyFingerprint(context: Context): String = try {
        key(context).fingerprint
    } catch (e: Throwable) {
        ""
    }

    /**
     * The app's adb identity.
     *
     * Generated on first use and kept in the app's private storage. It is the
     * identity the device authorizes during the one-time pairing, so it has to
     * SURVIVE app restarts — a new key every launch would mean a new pairing
     * every launch, which would make the whole thing useless.
     */
    @Synchronized
    fun key(context: Context): AdbAuthKey {
        val file = File(context.filesDir, KEY_FILE)
        if (file.isFile) {
            val pem = file.readText(Charsets.UTF_8)
            if (pem.isNotBlank()) {
                try {
                    return AdbAuthKey.fromPrivateKeyPem(pem)
                } catch (e: Throwable) {
                    // A damaged key file must not brick the feature: fall
                    // through and make a new one.
                }
            }
        }
        val generated = AdbAuthKey.generate()
        file.parentFile?.mkdirs()
        file.writeText(generated.toPrivateKeyPem(), Charsets.UTF_8)
        return generated
    }

    // exportKeyForHost() USED TO LIVE HERE — removed 2026-11-17 under T6.
    //
    // It copied the PRIVATE key into the app's external files directory, which
    // lives under /sdcard, so the PC-side `pair-khyos-key.ps1` could pull it and
    // hand it to `adb pair`. In-app pairing ([AdbPairingClient]) made that route
    // obsolete, and the task's red line is explicit: pairing keys live ONLY in
    // the app's private directory, with zero residue on /sdcard. A private key
    // on shared storage readable by any app with storage permission was the
    // exact thing the bridge's own credential work removed; this was the last
    // copy of that mistake. The PC fallback (provision-shell-sidecar.ps1) does
    // not need it — it raises the sidecar with the PC's OWN adb key.
    //
    // Kept as a comment rather than deleted outright so the next person who
    // reaches for "just write the key out for the PC" finds this first.

    /**
     * Raise the sidecar through the phone's own adbd.
     *
     * THREE ROUTES, TRIED IN ORDER — and the first that answers wins:
     *
     * 1. **The remembered wireless-debugging endpoint** (TLS). What the user
     *    typed in once, or what discovery found last time. This is the
     *    computer-free route: adbd is already listening on it because the
     *    phone's own wireless debugging is on.
     * 2. **The same endpoint, found by mDNS** (`_adb-tls-connect._tcp`). Saves
     *    the user from reading an IP and a rotating port off the settings
     *    screen — the port changes every time wireless debugging is toggled,
     *    so a remembered one is often stale.
     * 3. **The plain-TCP adbd on loopback** (`127.0.0.1:5555`). The PC-side
     *    fallback: it needs someone to have run `adb tcpip 5555` once, and it
     *    survives reboots when pinned with `persist.adb.tcp.port`. Kept
     *    because it is the route that works when wireless debugging is off —
     *    it is a fallback, not a claim that the feature needs a computer.
     *
     * A route that fails reports its own failure; none of them pretends.
     *
     * NOT PAIRED IS CHECKED FIRST, and that ordering is the whole point
     * (measured 2026-11-18). A freshly installed app has no pairing, so adbd
     * accepts the TLS handshake and then drops the connection the moment it
     * sees an unauthorized key — which used to surface as "连不上本机的无线调试
     * 端口…端口可能已经过期". The user had typed the right address and still got
     * told the address was wrong, so they went and changed the one thing that
     * was already right. Filling in the endpoint is not a substitute for the
     * one-time pairing, and the receipt has to say so.
     */
    @JvmStatic
    fun bootstrap(context: Context): Result {
        // 1. Is it already up? A bootstrap that starts a second sidecar would
        //    fight the first one for the port, and the loser fails silently.
        ShellSidecarClient.probe()
        if (ShellSidecarClient.ready()) {
            return Result(true, "提权代理已经在运行。")
        }

        // 2. Pairing first. Without it every route below fails the same way —
        //    the device hangs up on a key it never authorized — and that
        //    failure is indistinguishable from a wrong port.
        val auth = ElevationState.deviceAuth(context)
        if (auth != ElevationState.AUTH_PAIRED) {
            return Result(false, notPairedMessage(auth), "device_auth=$auth")
        }

        // 3. The endpoints the phone is advertising for wireless debugging.
        //    More than one can be published at once (the old port lingers
        //    after the port rotates), so each is tried in turn — see
        //    [discoverEndpoints]. The one the user typed comes first: it is
        //    the only endpoint that was chosen deliberately.
        val remembered = endpoint(context)
        val discovered = discoverEndpoints(context)
        if (remembered.isEmpty() && discovered.isNotEmpty()) {
            setEndpoint(context, discovered.first())
        }
        val candidates = (listOf(remembered) + discovered).filter { it.isNotEmpty() }.distinct()
        // What the wireless-debugging route said when it failed. A fallback
        // that hides the reason of the route it replaced is how "it doesn't
        // work" turns into "we don't know why".
        val failures = mutableListOf<String>()
        for (candidate in candidates) {
            val separator = candidate.lastIndexOf(':')
            if (separator <= 0) continue
            val host = candidate.substring(0, separator).trim()
            val port = candidate.substring(separator + 1).trim().toIntOrNull()
            if (host.isEmpty() || port == null || port !in 1..65535) {
                failures += "无线调试端点的地址读不出来（$candidate）。"
                continue
            }
            val attempt = connectAndRaise(context, host, port, tls = true)
            if (attempt.ok) return attempt
            failures += "${attempt.message}（${attempt.detail}）"
        }

        // 3. The plain-TCP adbd on loopback.
        val loopback = connectAndRaise(context, "127.0.0.1", LOOPBACK_PORT, tls = false)
        if (loopback.ok) return loopback
        // 面向用户的那句保持一句：每条路「为什么没连上」全部进 detail。把三条路
        // 的原始异常拼进 message，得到的是一堵墙，而墙里没有一句是可执行的。
        val message = if (failures.isEmpty()) {
            loopback.message
        } else {
            "无线调试端点试了 ${candidates.size} 个都没连上。${loopback.message}"
        }
        // 已配对却仍然连不上时，最可能是设备撤销了授权——从外面看，那和端口不对
        // 一模一样（都是连上后被踢）。所以这里补一句，让人先去重配对，而不是去
        // 改那个本来没错的地址（实测 2026-11-18：用户就是被上一条回执指错方向）。
        val withAuthHint = message + " 若地址没错，可能是设备撤销了对本 App 的授权——" +
            "重开一次「使用配对码配对设备」再配一次即可。"
        return Result(false, withAuthHint, (failures + loopback.detail).joinToString("；"))
    }

    /**
     * Turn the elevation switch OFF and stop the sidecar.
     *
     * THE ONLY WAY TO STOP IT IS TO ASK IT (measured 2026-11-17). The sidecar
     * runs as uid 2000 and this app is uid 10xxx, so `Process.killProcess` on
     * it is not available — the only lever is a command the sidecar itself
     * executes. Which means the receipt can never arrive: the process dies in
     * the middle of answering. So the sequence is "order it, then verify with a
     * PING", and the message says which of the three things actually happened
     * rather than pretending the reply came back.
     *
     * Aim at the pidfile, never at the class name: `pkill -f <class>` also
     * matches the shell that is running the command (the class name is in that
     * command line), which is the same trap the launch line had.
     */
    @JvmStatic
    fun stopSidecar(context: Context): Result {
        ElevationState.setEnabled(context, false)
        ShellSidecarClient.probe()
        val wasUp = ShellSidecarClient.online()
        if (wasUp) {
            ShellSidecarClient.exec("kill \$(cat $SIDECAR_PID) 2>/dev/null", "/sdcard", 5)
            // Give the kernel a moment: the PING below must not race the kill.
            Thread.sleep(400)
            ShellSidecarClient.probe()
        }
        val stillUp = ShellSidecarClient.online()
        return Result(
            !stillUp,
            when {
                !wasUp -> "提权代理本就没在运行。后续命令全部以 App 身份执行。"
                stillUp -> "已关提权开关，但代理进程还在跑（它没有让自己停下）。" +
                    "后续命令仍全部以 App 身份执行——开关是 exec 的门，这一条已经生效。"
                else -> "提权代理已停止。后续命令全部以 App 身份执行。"
            },
            "wasUp=$wasUp stillUp=$stillUp",
        )
    }

    /**
     * Connect to one endpoint and start the sidecar through it.
     */
    private fun connectAndRaise(
        context: Context,
        host: String,
        port: Int,
        tls: Boolean,
    ): Result {
        val client = try {
            AdbClient.connect(host, port, key(context), CONNECT_TIMEOUT_MS, tls = tls)
        } catch (e: Throwable) {
            return Result(
                false,
                if (tls) {
                    "连不上本机的无线调试端口（$host:$port）。确认手机上的「无线调试」还开着——" +
                        "每次开关它端口都会变，所以记住的端口可能已经过期；" +
                        "再不行就重开一次配对弹窗旁边的连接端口，或手动填一次。"
                } else {
                    "连不上本机的 adbd 明文端口（127.0.0.1:$LOOPBACK_PORT）。" +
                        "这个端口需要电脑侧先执行一次 `adb tcpip $LOOPBACK_PORT`。"
                },
                causeChain(e),
            )
        }
        return client.use { raiseSidecar(context, it) }
    }

    /**
     * Start the sidecar over an already-authenticated shell.
     *
     * The sidecar class ships inside this APK, so the device already has the
     * exact code that has to run: `CLASSPATH=<own apk> app_process …` runs it
     * from the installed package. That keeps the "one APK" property intact
     * through the bootstrap — nothing is uploaded, so nothing can go stale.
     *
     * TWO THINGS ABOUT THE LAUNCH LINE THAT ARE EASY TO GET WRONG (both
     * measured 2026-11-17, on a real Android 16 device):
     *
     * 1. `pkill -f <class>` kills the shell that is running this very command
     *    line, because the class name is in the line. The kill lands before the
     *    rest of the line runs, so the sidecar never starts and the log keeps
     *    whatever an earlier run left in it — which reads exactly like "it
     *    started". A pidfile is the only way to aim at the right process.
     * 2. The sidecar needs the app's PUBLIC key to authenticate callers
     *    (challenge-response, see [ShellSidecar]); without it every request is
     *    denied and the port sits there looking alive.
     */
    private fun raiseSidecar(context: Context, client: AdbClient): Result {
        val apk = context.applicationInfo.sourceDir
        val callerKey = DeviceIdentity.publicKeyB64(context)
        val start = StringBuilder()
        // Kill by pidfile, never by name: the name is in our own command line.
        start.append("kill $(cat ").append(SIDECAR_PID).append(" 2>/dev/null) 2>/dev/null; ")
        start.append("rm -f ").append(SIDECAR_PID).append("; ")
        // Truncate first, as its own command: if the launch below never runs,
        // the log must be empty rather than last run's, or a stale "listening"
        // line is indistinguishable from a fresh one.
        start.append(": > ").append(SIDECAR_LOG).append("; ")
        start.append("CLASSPATH=").append(apk)
        start.append(" setsid app_process /system/bin ")
        start.append(SIDECAR_CLASS)
        start.append(" --port ").append(ShellSidecarClient.PORT)
        if (callerKey.isNotEmpty()) {
            start.append(" --pub '").append(callerKey).append("'")
        }
        start.append(" >>").append(SIDECAR_LOG).append(" 2>&1 </dev/null &")
        start.append(" echo $! > ").append(SIDECAR_PID)
        // One second later, leave a liveness marker in the log. Measured
        // 2026-11-17: the launch can succeed as a shell command (the pidfile
        // gets written) while the sidecar itself dies without a word, and an
        // empty log then looks identical to "the command never ran". This
        // marker separates the two, and it does not contain "listening",
        // "Exception" or "Error", so it cannot satisfy the poll below.
        start.append("; sleep 1; echo \"[raise] pid=\$(cat ").append(SIDECAR_PID)
        start.append(") alive=\$(ls -d /proc/\$(cat ").append(SIDECAR_PID)
        start.append(") 2>/dev/null || echo GONE)\" >> ").append(SIDECAR_LOG)
        val started = client.exec(start.toString(), EXEC_TIMEOUT_MS)
        if (started.error.isNotEmpty() || started.exitCode != 0) {
            // Never looked at before, and that is how a refused launch read as
            // "the sidecar did not come up": exec() puts the reason in error,
            // raiseSidecar only ever read output.
            return Result(
                false,
                "拉起提权代理失败：这条启动命令没有正常跑完（exit=${started.exitCode}）。",
                "err=${started.error.take(300)} out=${started.output.take(200)}",
            )
        }
        if (started.output.contains("Permission denied") ||
            started.output.contains("not found")
        ) {
            return Result(
                false,
                "拉起提权代理失败：设备不让这条命令跑。",
                started.output.take(400),
            )
        }

        // Wait for the sidecar to say it is listening. The log is the sidecar's
        // own word, not our guess.
        var log = ""
        for (i in 0 until 12) {
            Thread.sleep(500)
            log = client.exec("cat " + SIDECAR_LOG + " 2>/dev/null", EXEC_TIMEOUT_MS).output
            if (log.contains("listening")) break
            if (log.contains("Exception") || log.contains("Error")) break
        }
        if (!log.contains("listening")) {
            return Result(
                false,
                "提权代理没有起来。设备侧日志：",
                log.take(600).ifEmpty { started.output.take(400) },
            )
        }

        // Confirm it with a REAL command, not with a handshake. `ready()` is
        // deliberately pessimistic — it only turns true after an exec has
        // actually run — so checking it here reported "起来了，但连不上" for a
        // sidecar that was listening fine (measured 2026-11-17). The check
        // that answers the question the user asked is "does it run a command
        // as shell", so that is what we run, and the uid in the answer is the
        // evidence rather than the number we expected.
        val probe = ShellSidecarClient.exec("id -u", "/sdcard", 10)
        val uid = probe?.optString("out")?.trim()
        if (probe == null || probe.optString("via") != "sidecar" || uid.isNullOrEmpty()) {
            return Result(
                false,
                "提权代理起来了，但本 App 使唤不动它。",
                (ShellSidecarClient.why() + " / " + log.take(300)),
            )
        }
        ShellSidecarClient.probe()
        return Result(true, "提权代理已就绪（uid $uid）。", log.take(200))
    }

    /**
     * The first wireless-debugging endpoint mDNS hands back, as "ip:port".
     *
     * For the UI's "fill the field for me" button. It can be a STALE port —
     * the phone keeps old registrations after the port rotates, and "first
     * found" is a coin flip. [bootstrap] does not rely on this: it tries every
     * candidate, so a stale guess costs one refused connection, not the
     * feature.
     */
    fun discoverEndpoint(context: Context, timeoutMs: Long = 3000L): String =
        discoverAll(context, SERVICE_TYPE_CONNECT, timeoutMs).firstOrNull() ?: ""

    /**
     * Every wireless-debugging endpoint the phone is advertising right now.
     *
     * MEASURED 2026-11-17: the phone keeps OLD registrations alive after the
     * port rotates (toggling wireless debugging, or a reconnect, moves the
     * port). On the test device two `_adb-tls-connect._tcp` instances were
     * published at once — 43699 (live) and 36973 (refused) — and taking the
     * first one found is a coin flip that fails with ECONNREFUSED. So
     * discovery returns all of them and the caller tries each.
     */
    fun discoverEndpoints(context: Context, timeoutMs: Long = CONNECT_DISCOVERY_TIMEOUT_MS): List<String> =
        discoverAll(context, SERVICE_TYPE_CONNECT, timeoutMs)

    /**
     * Try to find the device's own PAIRING endpoint by mDNS.
     *
     * The pairing endpoint only exists while the phone is showing the
     * "pair device with pairing code" dialog — the platform registers
     * `_adb-tls-pairing._tcp` for exactly that window ([DESIGN-ARCH-212] §2.3).
     * The 6-digit code is NOT in the mDNS TXT record (AOSP's `adb_mdns.h`
     * advertises only `v=1`), so the user still has to read the code off the
     * screen; what discovery saves is typing the IP and port.
     */
    fun discoverPairingEndpoints(
        context: Context,
        timeoutMs: Long = PAIRING_DIALOG_TIMEOUT_MS,
    ): List<String> = discoverAll(context, SERVICE_TYPE_PAIRING, timeoutMs)

    /**
     * One mDNS discovery, collecting every endpoint it resolves.
     *
     * The whole window is waited out on purpose: a registration that has not
     * arrived yet is indistinguishable from one that does not exist, and
     * stopping at the first answer is what picked the stale port.
     *
     * The String overload of [NsdManager.discoverServices] works on every API
     * level this app supports (it is merely deprecated from API 34 — the
     * int-protocol overload that replaced it needs API 34+). An earlier
     * revision returned "" below API 34 here, which silently broke discovery
     * on Android 11–13, the very versions where this feature matters.
     */
    private fun discoverAll(context: Context, serviceType: String, timeoutMs: Long): List<String> {
        val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return emptyList()
        val found = LinkedHashSet<String>()
        val latch = CountDownLatch(1)
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (!serviceInfo.serviceType.contains(serviceType.trimEnd('.'))) return
                nsd.resolveService(
                    serviceInfo,
                    object : NsdManager.ResolveListener {
                        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                            latch.countDown()
                        }

                        override fun onServiceResolved(info: NsdServiceInfo) {
                            val host = info.host?.hostAddress
                            if (!host.isNullOrBlank()) {
                                found.add("$host:${info.port}")
                            }
                        }
                    },
                )
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
            override fun onDiscoveryStopped(serviceType: String) {
                latch.countDown()
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                latch.countDown()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                latch.countDown()
            }
        }
        return try {
            nsd.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
            found.toList()
        } catch (e: Throwable) {
            emptyList()
        } finally {
            try {
                nsd.stopServiceDiscovery(listener)
            } catch (_: Throwable) {
                // Nothing to stop if discovery never started.
            }
        }
    }

    /** How long to wait for the TCP+TLS connection to adbd. */
    private const val CONNECT_TIMEOUT_MS = 8000

    /**
     * The mDNS service the phone publishes its wireless-debugging endpoint as.
     *
     * The trailing dot is the fully-qualified form DNS-SD expects.
     */
    private const val SERVICE_TYPE_CONNECT = "_adb-tls-connect._tcp."

    /**
     * The mDNS service the phone publishes its PAIRING endpoint as — only
     * while the pairing dialog is on screen.
     */
    private const val SERVICE_TYPE_PAIRING = "_adb-tls-pairing._tcp."

    /** How long to wait for one shell command to come back. */
    private const val EXEC_TIMEOUT_MS = 6000

    /** How long the pairing code dialog usually stays open on the phone. */
    private const val PAIRING_DIALOG_TIMEOUT_MS = 4000L

    /**
     * How long to hunt for the phone's own connect endpoint by mDNS.
     *
     * Longer than the pairing dialog's budget on purpose: the pairing endpoint
     * only exists for a few seconds (the dialog closes it), while the connect
     * endpoint stays published for as long as wireless debugging is on, so a
     * slightly longer wait is worth it. It still has to stay short — this runs
     * on the UI thread's caller, and the user is waiting for a sidecar.
     */
    private const val CONNECT_DISCOVERY_TIMEOUT_MS = 6000L

    /**
     * Pair this app with its own phone using the 6-digit code.
     *
     * Split out of MainActivity so the bridge tool `elevate` and the Flutter UI
     * share ONE implementation — the pairing flow is subtle enough (code goes
     * into a SPAKE2 password and nowhere else; the endpoint only exists while
     * the dialog is up) that two copies would drift, and the direction they
     * drift in is "the UI works, the tool silently doesn't".
     *
     * @JvmField because the bridge is Java and reads these directly; the
     * default Kotlin property getters are private to the JVM view.
     *
     * @param code the 6-digit code from the phone's pairing dialog.
     * @return a human-readable outcome. `ok` false means pairing did not
     *   happen; the message says what to do next in Chinese.
     */
    class PairOutcome(
        @JvmField val ok: Boolean,
        @JvmField val message: String,
        @JvmField val detail: String = "",
        @JvmField val endpoint: String = "",
    )

    @JvmStatic
    fun pairWithCode(context: Context, code: String): PairOutcome {
        if (code.length != 6 || code.any { !it.isDigit() }) {
            return PairOutcome(
                false,
                "配对码是 6 位数字；请填手机「使用配对码配对设备」弹窗里显示的那 6 位。",
                "code length=${code.length}",
            )
        }
        val discovered = discoverPairingEndpoints(context, PAIRING_DIALOG_TIMEOUT_MS)
        val candidates = (listOf(endpoint(context)) + discovered).filter { it.isNotEmpty() }.distinct()
        android.util.Log.w("ElevationBootstrap",
            "pair: code 已收到，发现 ${discovered.size} 个配对端点 $discovered，候选=$candidates")
        if (candidates.isEmpty()) {
            return PairOutcome(
                false,
                "找不到本机的配对端点。先在系统设置 → 开发者选项 → 无线调试里"
                    + "点「使用配对码配对设备」，保持弹窗开着再试一次。",
                "mdns=empty, remembered endpoint=empty",
            )
        }
        var lastFailure = ""
        var refused = false
        for (candidate in candidates) {
            val separator = candidate.lastIndexOf(':')
            if (separator <= 0) {
                lastFailure = "unparsable endpoint: $candidate"
                continue
            }
            val host = candidate.substring(0, separator)
            val port = candidate.substring(separator + 1).toIntOrNull()
            if (host.isEmpty() || port == null || port !in 1..65535) {
                lastFailure = "unparsable endpoint: $candidate"
                continue
            }
            val outcome = try {
                android.util.Log.w("ElevationBootstrap", "pair: 开始连 $candidate")
                AdbPairingClient(key(context), code, host, port).use { it.pair() }
            } catch (e: Throwable) {
                android.util.Log.w("ElevationBootstrap", "pair: $candidate 抛异常 ${causeChain(e)}")
                lastFailure = causeChain(e)
                continue
            }
            android.util.Log.w("ElevationBootstrap",
                "pair: $candidate 返回 ${outcome?.deviceGuid ?: "null(被拒)"}")
            if (outcome == null) {
                lastFailure = "pairing protocol refused or dropped"
                refused = true
                continue
            }
            ElevationState.markPaired(context, System.currentTimeMillis(), keyFingerprint(context))
            return PairOutcome(
                true,
                "配对成功，设备已信任本 App 的密钥。现在可以拉起提权代理了。",
                "guid=${outcome.deviceGuid}",
                candidate,
            )
        }
        return PairOutcome(
            false,
            if (refused) {
                "配对被设备拒绝：多半是配对码不对或已过期。重开配对弹窗，用新弹出的 6 位码再试。"
            } else {
                "连不上配对端点（${candidates.first()}）。配对弹窗关了端口就没了——重开弹窗再试一次。"
            },
            lastFailure,
        )
    }

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * The throwable and each of its causes, flattened into one line.
     *
     * A pairing failure is always wrapped (a TLS alert becomes an IOException
     * becomes a reflective InvocationTargetException), and only the outer
     * message survives `Throwable.message` — reporting that alone is how a
     * clear root cause turns into "连不上".
     */
    private fun causeChain(e: Throwable): String =
        generateSequence(e as Throwable?) { it.cause }
            .take(4)
            .joinToString(" ← ") { "${it.javaClass.name}: ${it.message}" }
}
