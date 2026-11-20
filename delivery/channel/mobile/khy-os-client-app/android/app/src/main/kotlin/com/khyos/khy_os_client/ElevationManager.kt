// khy-canary: Khy-20261112-004-ELEVATION
package com.khyos.khy_os_client

import android.content.Context
import com.khyos.khy_os_client.bridge.ShellSidecarClient

/**
 * ElevationManager — khyos 自己的提权通道（uid 2000 shell）。
 *
 * 它接替的是原来的第三方提权适配层，但**底座换成了自己的东西**：提权由
 * [ShellSidecarClient] 提供——那是跑在 `dalvikvm` 下、以 adbd 授权的 uid 2000
 * 进程（见 `shell/ShellSidecar.java`）。因此：
 *
 *   · 本仓不再依赖、也不再捆绑任何第三方提权应用（**2026-11-12 人裁决：完全移除**）；
 *   · 权限级别不变：sidecar 以 **uid 2000** 运行；
 *   · 失败时诚实降级：代理没起来就说没起来，绝不假装成功。
 *
 * 与旧适配层的**形状保持一致**（installed / connected / version / reason），
 * 是为了让 VFS 状态、工具回执、UI 文案那几处的契约不必重写一遍；语义已经
 * 换成「自有提权代理在不在、在不在能用」。
 */
object ElevationManager {

    /** 提权通道的标识。会出现在工具回执的 `via` 字段里。 */
    const val CHANNEL_SIDECAR = "sidecar"

    /**
     * 提权通道状态。
     *
     * @param installed 提权代理是否**在位**（探活通过）
     * @param connected 是否**可用**（与 installed 同义，保留是为了旧契约兼容）
     * @param version 通道标识（可用时为 [CHANNEL_SIDECAR]）
     * @param reason 不可用的原因，中文；可用时为空
     */
    class Status(
        val installed: Boolean,
        val connected: Boolean,
        val version: String,
        val reason: String,
    ) {
        /** 提权通道是否可用。 */
        val available: Boolean get() = installed && connected

        override fun toString(): String = when {
            available -> "提权通道已就绪（$version）"
            else -> "提权通道不可用：$reason"
        }
    }

    /**
     * 查提权通道状态。
     *
     * **零 IO**：只读 [ShellSidecarClient] 的缓存（由探活或一次真实执行刷新）。
     * 这条路径在状态栏与浮窗的每帧刷新里都会走，不能在这里做网络/磁盘操作。
     */
    @JvmStatic
    fun currentStatus(context: Context): Status {
        val ready = ShellSidecarClient.ready()
        val why = ShellSidecarClient.why()
        return Status(
            installed = ready,
            connected = ready,
            version = if (ready) CHANNEL_SIDECAR else "",
            reason = if (ready) "" else why.ifEmpty { "提权代理未就绪" },
        )
    }

    /**
     * 用提权通道跑一条命令。
     *
     * @return (stdout, stderr, exitCode)；代理不可用时返回 **null**，调用方必须
     *         把它当成「没有提权」处理（可以降级到受限 shell，但要说清楚），
     *         绝不能把 null 当成空输出。
     */
    @JvmStatic
    fun execElevated(context: Context, command: String, timeoutMs: Long): Triple<String, String, Int>? {
        val timeoutSec = Math.max(1, Math.min(120, (timeoutMs / 1000L).toInt()))
        val result = try {
            ShellSidecarClient.exec(command, "/sdcard", timeoutSec)
        } catch (_: Throwable) {
            null
        } ?: return null
        return Triple(
            result.optString("out", ""),
            result.optString("err", ""),
            result.optInt("exit", -1),
        )
    }
}
