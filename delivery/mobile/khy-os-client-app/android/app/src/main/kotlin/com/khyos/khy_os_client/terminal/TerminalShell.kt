package com.khyos.khy_os_client.terminal

/**
 * 终端（人工命令区）的命令准入策略。
 *
 * 为什么单独一份策略，不复用 MainActivity 的 SHELL_ALLOW：
 *   - SHELL_ALLOW 是 **AI 与设备控制** 通道的白名单，收得紧是刻意的：Agent 会编
 *     命令（实测它发明过 `pkg manager install <url>` 这种不存在的命令），放宽等于
 *     把手机遥控器交给它。
 *   - 终端是**人手动敲**的命令，语义完全不同：人想敲 `df -h`、`find . -name *.apk`、
 *     `grep -r foo .`。这些在 AI 白名单里一条都不允许。硬套 AI 白名单的结果是
 *     「终端像个摆设」——真机实测：连 `ls` 都发不出去。
 *
 * 仍然保留的硬边界（人工终端也不能突破）：
 *   1. shell 控制符一律禁（; & | ` > < 换行）——白名单是前缀匹配的，放任串联等于
 *      一条被允许的命令夹带任意第二条命令。
 *   2. 命令替换禁（`…` 与 $(…)）——同上，替换能凭空造出命令。
 *   3. deny 清单：解释器（sh/python/perl/awk/sed/ruby/node…）、提权
 *      （su/chmod/chown/setprop）、系统动作（reboot/mount/dd…）全禁——它们能把
 *      「一条白名单命令」变成「任意程序」。
 *   4. find 的 -exec/-execdir 单独禁：它同样能执行任意程序，且**不带任何控制符**，
 *      光靠第 1、2 条挡不住。
 */
object TerminalShell {

    /**
     * 允许的只读查询与常规文件操作前缀。
     *
     * 末尾的空格是有意义的：它要求后面必须跟参数，从而避免 `lsof` 这类
     * 「以 ls 开头」的别的命令蹭进来。裸命令（ls、pwd、id…）用无尾空格的形式，
     * 判定时以「等于前缀去掉空格」来匹配。
     */
    private val ALLOW = arrayOf(
        // 目录与元信息
        "ls ", "pwd", "tree ", "stat ", "file ", "realpath ", "readlink ",
        // 查找与文本
        "find ", "grep ", "which ", "cat ", "head ", "tail ", "wc ",
        "sort ", "uniq ", "cut ", "diff ",
        // 磁盘
        "df ", "du ",
        // 系统信息
        "uname ", "id", "whoami", "date", "env", "ps ", "getprop ",
        // 文件操作（与文件管理器的能力同源，都落在 App uid 权限范围内）
        "echo ", "mkdir ", "touch ", "cp ", "mv ", "rm ", "ln ",
        "md5sum ", "sha1sum ", "sha256sum ",
        // 只读的包查询：装包/卸包不在终端里做，终端不是安装器
        "pm list packages",
    )

    /**
     * deny：只按**前缀**匹配（命令一开头就是它就拒）。
     *
     * 解释器与提权类走这一组，因为它们一旦被允许，「一条白名单命令」就等价于
     * 「任意程序」：`sh -c ...`、`python -c ...`、`awk 'BEGIN{system("x")}'`。
     */
    private val DENY_PREFIX = arrayOf(
        "sh ", "bash ", "zsh ", "ksh ", "dash ", "ash ",
        "python", "perl ", "ruby ", "node ", "php ", "lua ", "tclsh ",
        "awk ", "sed ", "xargs", "eval", "exec", "system", "source ",
        "su ", "chmod ", "chown ", "setprop ", "setenforce ",
        "kill ", "killall", "pkill",
        "insmod", "modprobe", "rmmod",
        "run-as", "app_process", "dalvikvm", "toybox ",
        "pm install", "pm uninstall", "pm clear", "pm disable", "pm enable",
        "settings put", "settings delete",
        "dd", "mount ", "umount ", "iptables", "ip6tables",
        "reboot", "shutdown", "halt", "poweroff", "stop", "restart",
        "format", "mkfs", "fdisk", "parted",
    )

    /**
     * deny：前缀、或「空格 + 该短语」出现在命令里，都拒。
     *
     * 只收真正的高危组合。像 "stop"、"restart" 这种词若放进本组，会误伤
     * `grep stop log`——宁可漏拦一个词，也不能让常用查询命令莫名其妙被拒。
     */
    private val DENY_PHRASE = arrayOf(
        "rm -rf /", "rm -rf /*", "rm /system", "rm /data",
    )

    /**
     * 判断一条人工终端命令是否可以执行。
     */
    fun isAllowed(command: String): Boolean {
        val cmd = command.trim()
        if (cmd.isEmpty()) return false

        // 控制符与命令替换：一条命令里不允许出现它们。
        for (ch in listOf(";", "&", "|", "`", "$(", ">", "<", "\n", "\r")) {
            if (cmd.contains(ch)) return false
        }
        // find 的 -exec/-execdir 能执行任意程序，且不带任何控制符，得单独禁。
        if (cmd.contains("-exec")) return false

        val lower = cmd.lowercase()
        for (deny in DENY_PREFIX) {
            if (lower.startsWith(deny)) return false
        }
        for (deny in DENY_PHRASE) {
            if (lower.startsWith(deny) || lower.contains(" $deny")) return false
        }
        for (allow in ALLOW) {
            if (lower == allow.trim() || lower.startsWith(allow)) return true
        }
        return false
    }

    /**
     * 拒绝时给用户看的「允许什么」清单。
     *
     * 拒绝必须说清边界，否则调用方只能盲试——这是从 AI 通道那道闸门上学来的：
     * 一句不带允许清单的拒绝，等于让人挨个猜命令名。
     */
    fun allowedSummary(): String = ALLOW.joinToString("、") { it.trim() }
}
