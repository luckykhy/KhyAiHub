package com.khyos.khy_os_client.vfs

import java.io.File

/**
 * 加密 / 解密的前置校验判据。
 *
 * **为什么单独成 object**：[VfsCrypto] 的两个入口要 `Context`（做容器路径映射
 * 与存储权限判定）与 `MethodCall`（取参数），拖进 JVM 单测得 stub 一堆东西。
 * 但「参数不合法时该报哪个错误码」这件事本身是**通道契约**的一部分——
 * Dart 侧按错误码分支处理（「密码错了」和「文件没了」要给用户不同的提示），
 * 而这条契约在真机上验不到（密码对话框的往返随时被锁屏打断，见 §9.20.4 /
 * §9.21.5），于是它是目前**唯一能拿到硬证据的一层**。
 *
 * 抽出来的判据全是纯函数：只看「源在不在」「目标在不在」「密码空不空」，
 * 不碰 Android API。
 *
 * **错误码语义**（这层最要紧的是「不同的错要给不同的码」）：
 *  - 源不存在 → `not_found`：用户选的路径没了；
 *  - 口令为空 → `invalid_path`：调用方漏传参数，不是用户的密码错；
 *  - 目标已存在 → `conflict`：**且不覆盖**用户的旧文件；
 *  - 容器本身坏了 → `denied`（口令错 / 被截断都走这个码，见 [KhyEncContainer]）。
 */
internal object VfsCryptoGuard {

    /**
     * 校验一次加密 / 解密请求的前置条件。
     *
     * @param source 源文件（真实路径）。
     * @param target 目标文件（真实路径）。
     * @param password 口令。
     * @param sourceLabel 源路径的**虚拟**路径（错误消息里给用户看的是它）。
     * @param targetLabel 目标路径的虚拟路径。
     * @param action 动作名（「待加密」/「待解密」），只出现在消息里。
     * @throws VfsError 前置条件不满足时抛出，错误码按上面的语义。
     */
    fun requireReady(
        source: File,
        target: File,
        password: String,
        sourceLabel: String,
        targetLabel: String,
        action: String,
    ) {
        if (!source.exists()) {
            throw VfsError(VfsBridge.ERR_NOT_FOUND, "$action 的文件不存在：$sourceLabel")
        }
        if (password.isEmpty()) {
            // 空口令是调用方的错（漏传），不是用户密码输错——两个码分开，
            // Dart 侧才能给对提示。
            throw VfsError(VfsBridge.ERR_INVALID_PATH, "密码不能为空")
        }
        if (target.exists()) {
            // 不覆盖用户的旧文件：加密产物与解密产物都可能是用户手上还有用的东西。
            throw VfsError(VfsBridge.ERR_CONFLICT, "目标已存在：$targetLabel")
        }
    }

    /** 加密场景的动作名。 */
    const val ACTION_ENCRYPT = "待加密"

    /** 解密场景的动作名。 */
    const val ACTION_DECRYPT = "待解密"
}
