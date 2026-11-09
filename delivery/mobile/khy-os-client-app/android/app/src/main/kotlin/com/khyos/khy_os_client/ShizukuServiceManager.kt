// khy-canary: Khy-20261101-024-ZG5TSYAC
package com.khyos.khy_os_client

import android.content.Context
import android.os.ParcelFileDescriptor
import moe.shizuku.server.IRemoteProcess
import moe.shizuku.server.IShizukuService
import rikka.shizuku.Shizuku
import java.io.FileInputStream

/**
 * Thin wrapper over the Shizuku AIDL runtime for running privileged shell
 * commands without root on a non-rooted phone.
 *
 * The class owns the IPC lifecycle:
 *  - [connectShizukuService] returns the remote [IShizukuService] stub, or
 *    null when Shizuku is not installed / not started / not granted.
 *  - [execViaShizuku] runs a command via [IShizukuService.newProcess] when
 *    the channel is up, returns null otherwise so callers degrade to the
 *    plain restricted shell.
 *
 * Defensive by design: any AIDL / version mismatch surfaces as `null`
 * rather than an exception, so the app keeps working on devices that never
 * install Shizuku.
 */
object ShizukuServiceManager {

    const val SHIZUKU_PACKAGE = "moe.shizuku.server"

    /** Availability of the Shizuku channel. */
    class Status(
        val installed: Boolean,
        val connected: Boolean,
        val version: String,
        val reason: String,
    ) {
        val available: Boolean get() = installed && connected

        override fun toString(): String = when {
            available -> "Shizuku v$version 已就绪"
            installed -> "Shizuku 已安装 (v$version) 但未连接：请启动 Shizuku ($reason)"
            else -> "未安装 Shizuku。请安装 Shizuku 以获取免 root 提权 ($reason)"
        }
    }

    /**
     * Resolve + (if needed) start the Shizuku binder and report availability.
     * Non-blocking; safe to call on every elevated shell request.
     */
    // @JvmStatic: the bridge's Java side (Tools.java) calls these statically on
    // the class — a Kotlin object exposes them only via INSTANCE without it.
    @JvmStatic
    fun ensureConnected(context: Context): Status {
        val installed = try {
            context.packageManager.getPackageInfo(SHIZUKU_PACKAGE, 0)
            true
        } catch (_: Exception) {
            false
        }
        if (!installed) return Status(false, false, "", "未找到 Shizuku 应用")

        val version = try {
            context.packageManager.getPackageInfo(SHIZUKU_PACKAGE, 0).versionName ?: ""
        } catch (_: Exception) {
            ""
        }

        // 1. Ask Shizuku to start its service. `getBinder()` returns the
        //    remote binder; if the Shizuku app is not running yet the user
        //    must start it (the `running` flag below tells the UI layer).
        //    We intentionally do not try to launch it ourselves — that
        //    requires the Shizuku launcher intent and user consent.

        // 2. Confirm the channel is actually live.
        val connected = try {
            connectShizukuService() != null
        } catch (_: Throwable) {
            false
        }
        if (connected && Shizuku.checkSelfPermission() != 0) {
            // Authorization denied: report connected=false so Status.available is
            // honest (installed && connected) and execViaShizuku short-circuits.
            return Status(installed, false, version, "此 App 未获得 Shizuku 授权，请在 Shizuku 中授权")
        }
        return Status(installed, connected, version, if (connected) "" else "IPC 未建立")
    }

    /**
     * Return a live [IShizukuService] remote stub, or null when the channel
     * is unavailable. The binder handshake is performed lazily on first
     * call.
     */
    fun connectShizukuService(): IShizukuService? {
        return try {
            val binder = Shizuku.getBinder()
            if (binder == null) return null
            val svc = IShizukuService.Stub.asInterface(binder)
            if (svc == null) null else svc
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * Execute a privileged shell command via Shizuku.
     * @return Triple(stdout, stderr, exitCode), or null when the channel is
     *         unavailable / not granted (callers fall back to plain shell).
     */
    @JvmStatic
    fun execViaShizuku(context: Context, command: String, timeoutMs: Long = 30_000): Triple<String, String, Int>? {
        val status = ensureConnected(context)
        if (!status.available) return null
        val svc = connectShizukuService() ?: return null
        return try {
            // newProcess(args, envp, cwd) — the AIDL signature.
            val process: IRemoteProcess = svc.newProcess(
                arrayOf("sh", "-c", command),
                arrayOf(),
                null,
            )

            // stdout 与 stderr 必须**并发**抽干。
            //
            // 原来先 readAll(stdout) 再 readAll(stderr)：子进程若先把 stderr 写满管道
            // （Linux 管道缓冲 64KB）就会阻塞在它自己的 stderr 写上，stdout 于是永远不
            // 关闭 —— 读 stdout 这一步等不到 EOF，两条管道互相等死（经典双管道死锁）。
            val outBuf = StringBuilder()
            val errBuf = StringBuilder()
            val outThread = Thread { outBuf.append(readAll(process.getInputStream())) }
            val errThread = Thread { errBuf.append(readAll(process.getErrorStream())) }
            outThread.isDaemon = true
            errThread.isDaemon = true
            outThread.start()
            errThread.start()

            // IRemoteProcess.waitFor() 是阻塞的，且**没有**带超时的重载，所以超时只能
            // 在这里自己兜：waitFor 放到独立线程，等它 timeoutMs；到期就 destroy。
            //
            // 原来 timeoutMs 这个参数**整个没被用过** —— 命令可以一直挂着，调用方
            // （MainActivity.shizukuShell）是在主线程上等它的，App 直接卡成 ANR。
            val exitBox = intArrayOf(-1)
            val waitThread = Thread {
                try {
                    exitBox[0] = process.waitFor()
                } catch (_: Throwable) {
                    try { process.destroy() } catch (_: Throwable) {}
                }
            }
            waitThread.isDaemon = true
            waitThread.start()
            waitThread.join(timeoutMs)

            var timedOut = false
            if (waitThread.isAlive) {
                timedOut = true
                try { process.destroy() } catch (_: Throwable) {}
                waitThread.join(500)
            }
            outThread.join(500)
            errThread.join(500)

            if (timedOut) {
                // 124 = 约定的超时退出码（与 sidecar 路径一致）
                Triple(outBuf.toString(), errBuf.toString() + "\n[timeout ${timeoutMs}ms]", 124)
            } else {
                Triple(outBuf.toString(), errBuf.toString(), exitBox[0])
            }
        } catch (e: Throwable) {
            Triple("", "Shizuku 执行失败: ${e.message}", -1)
        }
    }

    /** Read an entire [ParcelFileDescriptor] pipe to end. */
    private fun readAll(fd: ParcelFileDescriptor): String {
        return try {
            FileInputStream(fd.fileDescriptor).use { stream ->
                val sb = StringBuilder()
                val buf = ByteArray(4096)
                var n = stream.read(buf)
                while (n > 0) {
                    sb.append(String(buf, 0, n))
                    n = stream.read(buf)
                }
                sb.toString()
            }
        } catch (_: Throwable) {
            ""
        }
    }
}
