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
            val stdout = readAll(process.getInputStream())
            val stderr = readAll(process.getErrorStream())
            var exitCode = -1
            try {
                exitCode = process.waitFor()
            } catch (_: Throwable) {
                process.destroy()
            }
            Triple(stdout, stderr, exitCode)
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
