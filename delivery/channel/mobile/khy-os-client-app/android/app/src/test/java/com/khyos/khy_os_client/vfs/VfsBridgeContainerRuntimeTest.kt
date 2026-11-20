package com.khyos.khy_os_client.vfs

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 容器运行时判据的回归测试。
 *
 * 为什么要有这个：判据原本是「容器根存在且非空」。可容器目录是**用户的数据区**——
 * 把手机里的文件拷进去它就非空了。于是用户只拷过一个文件，界面就不再显示
 * 「容器运行时未安装 + 安装运行时」那个空状态（目标 §五 明文要求容器未装时
 * 要有这个入口），而是显示「容器空间里还没有应用」。
 *
 * 这类错法不会报错、不会崩，只是让承诺悄悄失效：用户既不知道该装运行时，
 * 也以为功能坏了。所以判据必须有测试守着，尤其是「用户数据不算运行时」这一条。
 */
class VfsBridgeContainerRuntimeTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `容器目录里只有用户数据时不算运行时已安装`() {
        val root = temp.newFolder("container")
        File(root, "photos").mkdirs()
        File(root, "photos/a.jpg").writeText("x")
        assertFalse(ContainerRuntimeProbe.installed(root.absolutePath))
    }

    @Test
    fun `容器目录为空时不算运行时已安装`() {
        val root = temp.newFolder("container")
        assertFalse(ContainerRuntimeProbe.installed(root.absolutePath))
    }

    @Test
    fun `存在运行时标记文件才算已安装`() {
        val root = temp.newFolder("container")
        File(root, "runtime").mkdirs()
        File(root, "runtime/proot").writeText("#!/system/bin/sh")
        assertTrue(ContainerRuntimeProbe.installed(root.absolutePath))
    }

    @Test
    fun `容器根不存在时不算已安装`() {
        val missing = File(temp.root, "no-such-container").absolutePath
        assertFalse(ContainerRuntimeProbe.installed(missing))
    }
}
