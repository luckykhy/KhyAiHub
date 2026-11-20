package com.khyos.khy_os_client.vfs

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 加密 / 解密的前置校验判据测试（[VfsCryptoGuard]）。
 *
 * 为什么要有这个套件：这一层是**通道契约**——Dart 侧按错误码分支给用户不同
 * 提示（「文件没了」和「密码错了」不该说同一句话）。而这条契约在真机上验不到：
 * 密码对话框的往返要十几步交互，还随时被锁屏打断（§9.20.4 / §9.21.5 记了这个
 * 障碍）。判据抽成纯逻辑后，这是目前唯一能拿到硬证据的一层。
 *
 * 钉住的不变量：
 *  1. **不同的错给不同的码**：源不存在 → `not_found`；口令为空 → `invalid_path`；
 *     目标已存在 → `conflict`；
 *  2. 口令为空是**调用方的错**（漏传参数），不是用户密码输错——所以不能给
 *     `denied`；
 *  3. 目标已存在时**不覆盖**用户的旧文件；
 *  4. 错误消息里**不含口令**；
 *  5. 消息里的路径用的是**虚拟路径**（用户看得懂的那个），不是真实路径。
 */
class VfsCryptoGuardTest {

    @get:Rule
    val temp = TemporaryFolder()

    private fun source(name: String = "src.zip", create: Boolean = true): File {
        val file = File(temp.root, name)
        if (create) file.writeBytes(byteArrayOf(1, 2, 3))
        return file
    }

    private fun target(name: String = "out.khyenc", create: Boolean = false): File {
        val file = File(temp.root, name)
        if (create) file.writeBytes(byteArrayOf(9))
        return file
    }

    private fun expectCode(
        expected: String,
        source: File,
        target: File,
        password: String,
        action: String = VfsCryptoGuard.ACTION_ENCRYPT,
    ) {
        try {
            VfsCryptoGuard.requireReady(
                source = source,
                target = target,
                password = password,
                sourceLabel = "/storage/emulated/0/${source.name}",
                targetLabel = "/storage/emulated/0/${target.name}",
                action = action,
            )
            fail("应当抛出 VfsError")
        } catch (e: VfsError) {
            assertEquals(expected, e.code)
        }
    }

    @Test
    fun `一切正常时不抛异常`() {
        VfsCryptoGuard.requireReady(
            source = source(),
            target = target(),
            password = "pw",
            sourceLabel = "/storage/emulated/0/src.zip",
            targetLabel = "/storage/emulated/0/out.khyenc",
            action = VfsCryptoGuard.ACTION_ENCRYPT,
        )
    }

    @Test
    fun `源不存在报 not_found`() {
        expectCode(
            VfsBridge.ERR_NOT_FOUND,
            source = source(create = false),
            target = target(),
            password = "pw",
        )
    }

    @Test
    fun `口令为空报 invalid_path 而不是 denied`() {
        // 口令为空是调用方漏传参数，不是用户密码输错——给错码会让 Dart 侧
        // 对着「密码错了，请重试」弹窗，而用户其实没输错任何东西。
        expectCode(
            VfsBridge.ERR_INVALID_PATH,
            source = source(),
            target = target(),
            password = "",
        )
    }

    @Test
    fun `目标已存在报 conflict`() {
        expectCode(
            VfsBridge.ERR_CONFLICT,
            source = source(),
            target = target(create = true),
            password = "pw",
        )
    }

    @Test
    fun `目标已存在时旧文件不被覆盖`() {
        val existing = target(create = true)
        existing.writeBytes(byteArrayOf(9))
        expectCode(
            VfsBridge.ERR_CONFLICT,
            source = source(),
            target = existing,
            password = "pw",
        )
        // 内容必须原样还在——护栏不是「报个错但还是写了」。
        assertEquals(1, existing.length())
        assertEquals(9.toByte(), existing.readBytes()[0])
    }

    @Test
    fun `错误消息里不含口令`() {
        try {
            VfsCryptoGuard.requireReady(
                source = source(),
                target = target(create = true),
                password = "SuperSecret123",
                sourceLabel = "/storage/emulated/0/src.zip",
                targetLabel = "/storage/emulated/0/out.khyenc",
                action = VfsCryptoGuard.ACTION_ENCRYPT,
            )
            fail("应当抛出 VfsError")
        } catch (e: VfsError) {
            assertTrue(
                "错误消息泄露了口令：${e.message}",
                !e.message.orEmpty().contains("SuperSecret123"),
            )
        }
    }

    @Test
    fun `消息里给的是虚拟路径而不是真实路径`() {
        try {
            VfsCryptoGuard.requireReady(
                source = source(create = false),
                target = target(),
                password = "pw",
                sourceLabel = "/storage/emulated/0/src.zip",
                targetLabel = "/storage/emulated/0/out.khyenc",
                action = VfsCryptoGuard.ACTION_ENCRYPT,
            )
            fail("应当抛出 VfsError")
        } catch (e: VfsError) {
            // 真实路径在设备上是 /data/user/0/<pkg>/… 这种用户看不懂的东西。
            assertTrue(e.message.orEmpty().contains("/storage/emulated/0/src.zip"))
        }
    }

    @Test
    fun `加密与解密的动作名分别出现在自己的消息里`() {
        try {
            VfsCryptoGuard.requireReady(
                source = source(create = false),
                target = target(),
                password = "pw",
                sourceLabel = "/storage/emulated/0/src.zip",
                targetLabel = "/storage/emulated/0/out.zip",
                action = VfsCryptoGuard.ACTION_DECRYPT,
            )
            fail("应当抛出 VfsError")
        } catch (e: VfsError) {
            assertTrue(e.message.orEmpty().contains("待解密"))
            // 消息里不该出现另一个动作名——「解密一个刚加密出来的文件」这种
            // 提示会让用户以为自己操作错了顺序。
            assertTrue(!e.message.orEmpty().contains("待加密"))
        }
    }
}
