package com.khyos.khy_os_client.vfs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「系统管理」受控操作的判据测试（[VfsAppManager]）。
 *
 * 为什么要有这个套件：这三件事（卸载 / 禁用 / 启用）此前**一行测试都没有**，
 * 而且它们在真机上是**死的**——命令串走的那条通道，其前缀白名单里没有
 * `pm uninstall` / `pm disable-user` / `pm enable`（§9.24）。
 *
 * 钉住的不变量：
 *  1. 包名校验：带命令结构的包名必须被拒（这是命令注入的唯一入口）；
 *  2. 拼出来的命令里**只有一条命令**，包名被引号包住；
 *  3. `pm` 的失败按词表翻译成机器码——尤其是「未知包」与「权限不够」
 *     要分开，前者让用户知道该刷新列表，后者让用户知道该去激活提权代理。
 */
class VfsAppManagerTest {

    @Test
    fun 合法包名通过校验() {
        for (pkg in arrayOf(
            "com.tencent.mm",
            "com.example.app",
            "a",
            "a.b",
            "com.example.app2",
            "com.example_app",
        )) {
            assertTrue(pkg, VfsAppManager.isValidPackageName(pkg))
        }
    }

    @Test
    fun 带命令结构的包名被拒() {
        // 这几种一旦放行，就是命令注入：它们能改变命令的结构。
        val bad = arrayOf(
            "",
            "com.foo;rm -rf /",
            "com.foo && id",
            "com.foo|id",
            "com.foo`id`",
            "com.foo\$(id)",
            "com.foo>out",
            "com.foo bar",
            "com.foo\nid",
            "-com.foo",
            ".com.foo",
            "com.foo;",
        )
        for (pkg in bad) {
            assertTrue(pkg, !VfsAppManager.isValidPackageName(pkg))
        }
    }

    @Test
    fun 超长包名被拒() {
        val tooLong = "a".repeat(256)
        assertTrue(!VfsAppManager.isValidPackageName(tooLong))
    }

    @Test
    fun 命令里只有一条命令且包名被引号包住() {
        assertEquals(
            "pm uninstall 'com.tencent.mm'",
            VfsAppManager.buildCommand("uninstall", "com.tencent.mm"),
        )
        assertEquals(
            "pm disable-user --user 0 'com.tencent.mm'",
            VfsAppManager.buildCommand("disable", "com.tencent.mm"),
        )
        assertEquals(
            "pm enable 'com.tencent.mm'",
            VfsAppManager.buildCommand("enable", "com.tencent.mm"),
        )
    }

    @Test
    fun 拼命令时包名不合法直接抛错() {
        val thrown = runCatching {
            VfsAppManager.buildCommand("uninstall", "com.foo;rm -rf /")
        }.exceptionOrNull()
        assertNotNull(thrown)
        assertEquals(VfsBridge.ERR_INVALID_PATH, (thrown as VfsError).code)
    }

    @Test
    fun 未知动作被拒() {
        val thrown = runCatching {
            VfsAppManager.buildCommand("destroy", "com.tencent.mm")
        }.exceptionOrNull()
        assertNotNull(thrown)
    }

    @Test
    fun pm的失败按词表翻译() {
        // 未知包 → not_found（用户该刷新列表，不是去激活权限）
        val unknown = VfsAppManager.pmFailure("Unknown package: com.nope")
        assertNotNull(unknown)
        assertEquals(VfsBridge.ERR_NOT_FOUND, unknown!!.code)

        // 权限不够 → denied（引导去激活提权代理）
        val denied = VfsAppManager.pmFailure("Permission Denial: pm uninstall")
        assertNotNull(denied)
        assertEquals(VfsBridge.ERR_DENIED, denied!!.code)

        // 其它 → shell_failed，原文要带出来
        val other = VfsAppManager.pmFailure("Error: something went wrong")
        assertNotNull(other)
        assertEquals(VfsBridge.ERR_SHELL_FAILED, other!!.code)
        assertTrue(other.message.contains("something went wrong"))
    }

    @Test
    fun 成功的输出不被当成失败() {
        // `pm` 成功时打的是 "Success" / "Package com.x new state: disabled-user"，
        // 里面没有 Failure / Error ——不能被误判成失败。
        assertNull(VfsAppManager.pmFailure("Success"))
        assertNull(VfsAppManager.pmFailure("Package com.tencent.mm new state: disabled-user"))
        assertNull(VfsAppManager.pmFailure(""))
    }
}
