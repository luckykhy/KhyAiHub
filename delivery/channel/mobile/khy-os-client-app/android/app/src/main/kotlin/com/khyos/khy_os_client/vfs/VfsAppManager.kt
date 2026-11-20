package com.khyos.khy_os_client.vfs

import android.content.Context
import java.util.regex.Pattern

/**
 * 「系统管理」能力：卸载 / 禁用 / 启用应用。
 *
 * ## 为什么放在 VFS 层，而不是 AI 那条 shell 通道
 *
 * 2026-11-09 查出来的（§9.24）：`AppManager.uninstall` 把
 * `pm uninstall <pkg>` 拼成**命令串**，从 `DeviceControl.execShellElevated`
 * 发出去——那条通道的准入清单是 `MainActivity.SHELL_ALLOW`，它是一份
 * **前缀白名单**，里面只有 `pm list packages` / `pm path ` / `pm dump `，
 * **没有** `pm uninstall` / `pm disable-user` / `pm enable`。
 *
 * 于是 App 自己发的命令被自己的闸门挡回来：「卸载应用」「禁用应用」
 * 「启用应用」这三个功能在真机上**必然失败**——不是权限问题，是命令压根
 * 不在白名单里。文档里写的是「已落地」，指的是代码在，**不是它在设备上能用**。
 *
 * 三条理由让这件事该搬到这里：
 *
 *  1. **命令串通道不该承载破坏性操作。** 「卸载一个包」是一个**意图**，
 *     不是一条命令串。这里收的是「包名 + 动作」，包名先过严格校验再拼命令——
 *     用户可控的裸文本永远不进命令行。
 *  2. **显式操作注册表比前缀白名单强。** VFS 桥的每一个方法都是登记在册的
 *     一个动作，能做什么一目了然；而前缀白名单是「凡是 `pm ` 开头的都算」，
 *     加一条前缀就是把一类新能力放出去。
 *  3. **提权语义天然在这条路上。** 这里走 [VfsShell.execManaged]（shell sidecar，uid 2000），
 *     不是 App 自己 uid 的受限 shell；sidecar 没启动就明说
 *     `elevation_unavailable`，不退化成「假装成功」。
 */
object VfsAppManager {

    /**
     * 包名的合法形态。
     *
     * Android 包名只允许字母、数字、下划线与点。这里比系统宽松一点（允许数字
     * 开头、允许单段），但**绝不允许**空格、连字符、分号这些能改变命令结构的
     * 字符——校验过了也仍然加引号（[VfsShell.quote]）：校验是「一道」保障，
     * 引号是「另一道」，两道都不该省。
     */
    private val PKG_PATTERN = Pattern.compile("^[A-Za-z0-9_][A-Za-z0-9_.]*$")

    /**
     * 包名是否可以直接拼进命令行。
     *
     * 单独抽成纯函数是为了能测：校验漏一个字符，命令串通道就多一条注入路径，
     * 而这种洞在真机上表现为「偶发地卸错应用」——几乎不可能靠复现定位。
     */
    fun isValidPackageName(pkg: String): Boolean =
        pkg.isNotEmpty() && pkg.length <= 255 && PKG_PATTERN.matcher(pkg).matches()

    /** 包名不合法就抛错，不静默放过。 */
    private fun requirePackage(pkg: String): String {
        if (!isValidPackageName(pkg)) {
            throw VfsError(VfsBridge.ERR_INVALID_PATH, "包名不合法：$pkg")
        }
        return pkg
    }

    /**
     * 受控命令的拼装（纯逻辑，可单测）。
     *
     * 拼出来的东西必须**只有一条命令**：包名过了校验还加引号，所以无论
     * 调用方塞进来什么，它都只能是 `pm` 的一个参数。
     */
    internal fun buildCommand(action: String, pkg: String): String {
        val safe = requirePackage(pkg)
        return when (action) {
            "uninstall" -> "pm uninstall ${VfsShell.quote(safe)}"
            "disable" -> "pm disable-user --user 0 ${VfsShell.quote(safe)}"
            "enable" -> "pm enable ${VfsShell.quote(safe)}"
            else -> throw VfsError(VfsBridge.ERR_UNKNOWN, "未知的应用操作：$action")
        }
    }

    /**
     * 卸载一个应用。
     *
     * `pm uninstall` 的失败有两个形态，**都要看**：
     *  - 退出码非 0，stderr 有话；
     *  - 退出码 **0**，stdout 打「Failure [...]」——`pm` 的老毛病。
     * 只看退出码会把「卸载失败」报成「卸载成功」，而用户看到的是应用还在。
     */
    fun uninstall(context: Context, pkg: String): Map<String, Any> =
        run(context, "uninstall", pkg)

    /**
     * 禁用（冻结）一个应用。
     *
     * 用 `pm disable-user --user 0`：禁用后应用从桌面消失、数据仍在、
     * 随时能在系统设置里恢复——这正是「精简」这个诉求要的东西。
     * 真正不可逆的卸载永远单独走 [uninstall]。
     */
    fun disable(context: Context, pkg: String): Map<String, Any> =
        run(context, "disable", pkg)

    /** 启用（解冻）一个应用。 */
    fun enable(context: Context, pkg: String): Map<String, Any> =
        run(context, "enable", pkg)

    /** 三个动作共用的一条执行路径。 */
    private fun run(context: Context, action: String, pkg: String): Map<String, Any> {
        val command = buildCommand(action, pkg)
        val (stdout, stderr, _) = VfsShell.execManaged(context, command)
        val output = "$stdout\n$stderr".trim()
        pmFailure(output)?.let { throw it }
        return mapOf("ok" to true, "action" to action, "pkg" to pkg, "output" to output)
    }

    /**
     * `pm` 的失败 → 机器码。
     *
     * `pm` 的词表是稳定的（不同 Android 版本间一致），比按退出码归类准：
     *  - 「Unknown package」/「not installed」→ 应用不在了；
     *  - 「Permission Denial」/「SecurityException」→ 权限不够（多半是 sidecar
     *    没启动），引导用户去启动提权代理，而不是说「未知错误」；
     *  - 其余 → 执行失败，并把原文带出来（`pm` 的原文比玩具箱的命令更有用）。
     */
    internal fun pmFailure(output: String): VfsError? {
        val text = output.trim()
        if (text.isEmpty()) return null
        val lower = text.lowercase()
        // 先判「像不像失败」，再判「是哪一类失败」。两段必须都覆盖到：
        // 漏掉「Permission Denial」这一类，它会被当成成功——于是界面报「已冻结」，
        // 而应用根本没被冻结（这正是旧 Dart 实现的老毛病）。
        val looksFailed = text.contains("Failure") ||
            text.contains("Error") ||
            text.contains("Exception") ||
            lower.contains("unknown package") ||
            lower.contains("not installed") ||
            lower.contains("permission denial") ||
            lower.contains("securityexception")
        if (!looksFailed) return null
        return when {
            lower.contains("unknown package") || lower.contains("not installed") ->
                VfsError(VfsBridge.ERR_NOT_FOUND, "应用未安装：$text")
            lower.contains("permission denial") || lower.contains("securityexception") ->
                VfsError(VfsBridge.ERR_DENIED, "权限不足（提权代理未就绪）：$text")
            else -> VfsError(VfsBridge.ERR_SHELL_FAILED, "操作失败：$text")
        }
    }
}
