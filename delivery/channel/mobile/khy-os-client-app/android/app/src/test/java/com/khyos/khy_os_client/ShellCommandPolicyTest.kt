package com.khyos.khy_os_client

import java.io.File

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 原生 shell 闸门的判据测试（[ShellCommandPolicy]）。
 *
 * 为什么要有这个套件：这道闸门是原生侧的最后一道网，而它原先住在 Activity 的
 * 私有方法里——**测不到**。2026-11-10 先用探针把改造前的逻辑原样搬出来喂语料，
 * 实测结果是：**漏 4 条、误拦 1 条**：
 *
 *  - 漏：`rm -r -f /`、`rm -f -r /`、`rm --recursive --force /`、`rm -rf ./`
 *    （deny 名单写的是 `rm -rf /`，前缀匹配管不到换了写法的那几种）
 *  - 误拦：`rm -rf /storage/emulated/0/Download/old` —— 同一个前缀把**递归删
 *    任何绝对路径**都拒了，文件管理器的主功能在这条通道上发不出去
 *
 * 判据搬成纯函数之后，这套测试把它钉死：语料是语料，不再靠「读代码看着没问题」。
 */
class ShellCommandPolicyTest {

    /** 与 `MainActivity.SHELL_ALLOW` 一致（2026-11-10 实测时的快照）。 */
    private val allow = arrayOf(
        "am start ", "am force-stop ", "am kill ",
        "wm size", "wm density",
        "dumpsys ",
        "pm list packages", "pm path ", "pm dump ",
        "settings get ", "settings put ",
        "input tap ", "input swipe ", "input text ", "input keyevent ",
        "screencap ",
        "ls ", "cat ", "echo ", "mkdir ", "rm ", "mv ", "cp ",
        "ps ", "kill ", "logcat ", "getprop ", "ip addr show ",
    )

    /** 与 `MainActivity.SHELL_DENY` 一致（rm 家族已移交给形状层）。 */
    private val deny = arrayOf(
        "shutdown", "reboot", "stop", "restart",
        "format", "mkfs", "dd if=", "iptables", "mount ", "umount ",
    )

    private fun allowed(cmd: String): Boolean =
        ShellCommandPolicy.isAllowed(cmd, allow, deny)

    @Test
    fun 危险的命令被拒() {
        // 语料来自第十八轮对 Dart 侧过滤器的那 27 条。
        //
        // 与 Dart 侧 `shell_command_guard_test.dart` 的「漏网 13 条」**不是同一份 13**：
        // 那边收的是旧版过滤器真放行了的 13 条（含 `mount /system`，不含 `rm -rf /`），
        // 这边收的是「换了写法也要拦住」的 13 条（含 `rm -rf /`，不含 `mount /system`）。
        // 两边各有一条对方没有的，这是**有意的**：原生多测一条前缀最直的写法，Dart
        // 多测一条旧版真放行过的。不要把两边改成一样——改了就看不出各自在守什么。
        for (cmd in arrayOf(
            "rm -rf /",
            "rm -r -f /",
            "rm -f -r /",
            "rm --recursive --force /",
            "rm -rf /storage/emulated/0",
            "rm -rf ./",
            "rm -rf /system",
            "rm -rf /data",
            "chmod 7777 /x",
            "chmod 0777 /x",
            "mount /dev/block/sda /mnt",
            "sh -c 'rm -rf /'",
            "echo \$(rm -rf /)",
        )) {
            assertFalse(cmd, allowed(cmd))
        }
    }

    @Test
    fun 正常的命令放行() {
        for (cmd in arrayOf(
            "ls -la /storage/emulated/0",
            "getprop ro.build.version.sdk",
            "pm list packages",
            "dumpsys meminfo com.example",
            "settings get global airplane_mode_on",
            "am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p com.example",
            "input tap 100 200",
            "screencap -p /sdcard/x.png",
            "cat /sdcard/a.txt",
            "echo hi",
            "rm /sdcard/a.txt",
            "mkdir /sdcard/newdir",
            // 提到危险命令但只是**说明**它，不该被当成执行。
            "echo 'rm -rf / is dangerous'",
        )) {
            assertTrue(cmd, allowed(cmd))
        }
    }

    @Test
    fun 递归删子目录放行_主功能不能被闸门废了() {
        // 这一条在改造前被**误拦**（deny 名单的 "rm -rf /" 前缀把它一起拒了）。
        assertTrue(allowed("rm -rf /storage/emulated/0/Download/old"))
        assertTrue(allowed("rm -rf /sdcard/DCIM"))
    }

    @Test
    fun 根路径的各种写法都被拒() {
        for (cmd in arrayOf(
            "rm -rf //",
            "rm -rf /.",
            "rm -rf /storage/emulated/0/",
            "rm -rf ~",
            "rm -rf ~/",
            "rm -rf \$HOME",
            "rm -rf \${HOME}",
            "rm -fr /",
            "rm --no-preserve-root -rf /",
            "sudo rm -rf /",
            "sh -c 'rm -rf /'",
            "rm -rf '/'",
        )) {
            assertFalse(cmd, allowed(cmd))
        }
    }

    @Test
    fun 包装器挡不住形状判定() {
        // 包装器后面那条命令才是真正要跑的。
        assertNotNull(ShellCommandPolicy.dangerousShape("sudo rm -rf /"))
        assertNotNull(ShellCommandPolicy.dangerousShape("sh -c 'rm -rf /'"))
        assertNotNull(ShellCommandPolicy.dangerousShape("env FOO=1 rm -rf /"))
        assertNull(ShellCommandPolicy.dangerousShape("ls -la /storage"))
    }

    @Test
    fun 控制符一律拒绝() {
        for (cmd in arrayOf(
            "echo x;rm -rf /",
            "echo x && rm -rf /",
            "echo x | rm -rf /",
            "echo `rm -rf /`",
            "echo \$(rm -rf /)",
            "echo x > /sdcard/a.txt",
            "echo x\nrm -rf /",
        )) {
            assertFalse(cmd, allowed(cmd))
        }
    }

    @Test
    fun 形状判定与白名单无关() {
        // 形状层只看命令结构：即使某个前缀在白名单里，形状危险照样拒。
        val customAllow = arrayOf("rm ")
        val customDeny = emptyArray<String>()
        assertFalse(ShellCommandPolicy.isAllowed("rm -rf /", customAllow, customDeny))
        assertTrue(ShellCommandPolicy.isAllowed("rm -rf /tmp/scratch", customAllow, customDeny))
    }

    @Test
    fun 空命令被拒() {
        assertFalse(allowed(""))
        assertFalse(allowed("   "))
    }

    // ── 快照与生产真源的一致性 ──
    //
    // 为什么单独立这一条：上面 8 条测的是**这份手抄的快照**，而生产里真正生效的是
    // `MainActivity.SHELL_ALLOW` / `SHELL_DENY`——`isCommandAllowed` 把自己的私有名单
    // 传给 [ShellCommandPolicy]，白名单是**本 App 的准入策略**，本来就该由 Activity 持有。
    // 两份名单 2026-11-10 实测时逐条相同，但没有任何东西保证它们明天还相同：改原生
    // 名单的人不会知道测试里存在一份复印件。
    //
    // 漏掉的后果不是「测试不准」，而是**假绿**：快照绿着，生产行为却已经变了，而唯一
    // 该发现这件事的人正在看一份绿灯。所以这里把复印件钉回真源。
    //
    // 纪律与 Dart 侧 `vfs_channel_wiring_test.dart` 相同：**解析不到就不通过，不跳过**。
    // 扫不到比没有更糟——门读到的是绿灯。

    @Test
    fun 快照与_MainActivity_的名单逐条一致() {
        val source = readMainActivity()
        val nativeAllow = arrayEntries(source, "SHELL_ALLOW")
        val nativeDeny = arrayEntries(source, "SHELL_DENY")

        // 空名单会让下面的集合比对「意外」成立（两边都空），所以先判非空。
        assertTrue("从 MainActivity.kt 解析不到 SHELL_ALLOW——数组写法可能变了", nativeAllow.isNotEmpty())
        assertTrue("从 MainActivity.kt 解析不到 SHELL_DENY——数组写法可能变了", nativeDeny.isNotEmpty())

        val snapshotAllow = allow.toSet()
        val snapshotDeny = deny.toSet()
        assertEquals(
            "SHELL_ALLOW 与快照不一致（生产已经变了，快照没跟上）：\n" +
                "  原生有、快照没有 = ${nativeAllow.toSet() - snapshotAllow}\n" +
                "  快照有、原生没有 = ${snapshotAllow - nativeAllow.toSet()}\n" +
                "修法：改快照，或改原生——两边必须同一份准入策略。",
            snapshotAllow,
            nativeAllow.toSet(),
        )
        assertEquals(
            "SHELL_DENY 与快照不一致（生产已经变了，快照没跟上）：\n" +
                "  原生有、快照没有 = ${nativeDeny.toSet() - snapshotDeny}\n" +
                "  快照有、原生没有 = ${snapshotDeny - nativeDeny.toSet()}",
            snapshotDeny,
            nativeDeny.toSet(),
        )
    }

    /**
     * 读 `MainActivity.kt` 源文本。
     *
     * 路径按 JVM 单测的工作目录解析（2026-11-10 实测 = `android/app`），另外留两个
     * 候选目录兜底。全都找不到就**失败**，不返回空串——空串会让调用方的解析静默
     * 返回空名单，而空名单在这条测试里等于「两边都空、比对通过」。
     */
    private fun readMainActivity(): String {
        val relative = "src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt"
        val file = listOf(relative, "../$relative", "android/app/$relative")
            .map(::File)
            .firstOrNull { it.isFile }
        assertNotNull(
            "读不到 MainActivity.kt（工作目录=${System.getProperty("user.dir")}）。\n" +
                "这条测试要把快照钉回生产真源，读不到就只能判不通过；跳过它，上面 8 条\n" +
                "会继续在一份可能已经过期的复印件上假绿。",
            file,
        )
        return file!!.readText()
    }

    /**
     * 从 Kotlin 源文本里取出 `private val <valName> = arrayOf(...)` 的全部字符串条目。
     *
     * 为什么按字符扫而不是一条正则抓完：数组里可能带行注释，注释里也可能出现引号，
     * 正则分不清「字符串里的引号」和「注释里的引号」。按字符扫才能把两者分开，
     * 并且对换行/缩进的改动不敏感——只有 `arrayOf(` 的配对 `)` 与声明本身才算锚点。
     */
    private fun arrayEntries(source: String, valName: String): List<String> {
        val anchor = "private val $valName = arrayOf("
        val declared = source.indexOf(anchor)
        if (declared < 0) return emptyList()
        var i = source.indexOf('(', declared) + 1
        val out = mutableListOf<String>()
        while (i < source.length) {
            when {
                source[i] == '"' -> {
                    val text = StringBuilder()
                    i++
                    while (i < source.length) {
                        val c = source[i]
                        if (c == '\\' && i + 1 < source.length) {
                            // 转义：取被转义的那个字符本身（`\"` → `"`）。
                            text.append(source[i + 1])
                            i += 2
                            continue
                        }
                        if (c == '"') {
                            i++
                            break
                        }
                        text.append(c)
                        i++
                    }
                    out.add(text.toString())
                }
                // 行注释：整行跳过，注释里的引号不是字符串定界符。
                source[i] == '/' && i + 1 < source.length && source[i + 1] == '/' -> {
                    while (i < source.length && source[i] != '\n') i++
                }
                // 与 arrayOf( 配对的右括号：名单结束。
                source[i] == ')' -> return out
                else -> i++
            }
        }
        return out
    }
}
