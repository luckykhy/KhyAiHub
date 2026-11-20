package com.khyos.khy_os_client

/**
 * 原生 shell 通道的准入判据（纯函数，不依赖 Android）。
 *
 * 为什么把它从 `MainActivity` 里搬出来：
 *
 *  1. **可测**。Activity 的私有方法测不到——而这道闸门是原生侧的最后一道网，
 *     它的判据必须能被**实测语料**钉住，而不是靠人读代码确认「看着没问题」。
 *  2. **可改**。MainActivity 下方有 amoo 冻结字面量块（按行号登记），那边每改
 *     一行都要重排整块。判据放在独立文件里，改判据不碰行号。
 *
 * 判据分两层：
 *
 *  - **拼写层**（原样保留）：控制符一律拒绝、deny 名单、allow 前缀名单。
 *  - **形状层**（新增）：命令的**结构**危险，与写法无关。`rm -r -f /`、
 *    `rm -f -r /`、`rm --recursive --force /` 在拼写层是三种不同的写法，在形状层
 *    是同一件事——「递归删根路径」。2026-11-09 实测：原生那道拼写层把这三种放行了
 *    （`SHELL_DENY` 里写的是 `rm -rf /`，前缀匹配管不到换了写法的那几种）。
 */
object ShellCommandPolicy {

    /** 命令里出现这些字符就整体拒绝：一条允许的命令夹带第二条命令，是前缀白名单的根本漏洞。 */
    private val CONTROL_CHARS = listOf(";", "&", "|", "`", "$(", ">", "<", "\n", "\r")

    /** 会把命令包起来的程序：判定要看它们**里面**那条命令。 */
    private val SHELL_FAMILIES = setOf("sh", "bash", "zsh", "ash", "dash", "ksh")

    /** 其他包装器：只看它们**后面**那条命令。 */
    private val WRAPPERS = setOf(
        "sudo", "su", "env", "timeout", "nice", "nohup", "stdbuf", "setsid", "doas",
    )

    /**
     * 根路径的「像根」清单。
     *
     * 为什么这么保守：判错的方向不一样——把普通目录误当成根，会挡住正常操作；
     * 把根当成普通目录，是一次数据销毁。所以这份清单宁可多列几个系统根。
     *
     * 注意「整棵用户存储」也在列：`/storage/emulated/0` 与 `/sdcard` 是同一片地方，
     * 删掉它等于删掉用户的全部文件。
     */
    private val ROOT_LIKE = setOf(
        "/", "/*", ".", "./", "..", "../", "~", "~/",
        "/system", "/system/", "/data", "/data/", "/vendor", "/vendor/",
        "/boot", "/proc", "/proc/", "/sys", "/sys/", "/mnt", "/media",
        "/storage", "/storage/", "/sdcard", "/sdcard/",
        "/storage/emulated", "/storage/emulated/",
        "/storage/emulated/0", "/storage/emulated/0/",
        "/storage/self/primary", "/storage/self/primary/",
    )

    /** 归一化之后仍然算「根」的路径（POSIX 里 `//`、`/.` 都等于 `/`）。 */
    private val ROOT_ALIASES = setOf("/", ".", "..", "")

    /** 以 `~` 开头的路径：家目录，删掉它等于删掉用户全部文件。 */
    private const val HOME_PREFIX = "~"

    /**
     * 指向根的变量。
     *
     * 只收这几个：`$HOME`、`$ROOT` 这类在 `sh -c` 里会展开成根路径的变量。
     * `$file` 这种普通变量不收——它在 `sh -c` 里多半是空的，命令本身无害，
     * 拦它属于误伤。
     */
    private val DANGEROUS_VARS = setOf(
        "\$home", "\${home}", "\$root", "\${root}",
        "\$storage", "\${storage}", "\$sdcard", "\${sdcard}",
    )

    /** 系统分区：改它们的权限属于「动别人家的东西」。 */
    private val SYSTEM_PREFIXES = listOf(
        "/system", "/vendor", "/boot", "/proc", "/sys", "/data", "/",
    )

    /**
     * 一条命令准不准跑。
     *
     * @param allow 前缀白名单（App 的准入策略）。
     * @param deny 黑名单条目。
     */
    fun isAllowed(cmd: String, allow: Array<String>, deny: Array<String>): Boolean {
        for (ch in CONTROL_CHARS) {
            if (cmd.contains(ch)) return false
        }
        val lower = cmd.lowercase().trim()
        if (lower.isEmpty()) return false
        for (d in deny) {
            if (lower.startsWith(d) || lower.contains(" $d")) return false
        }
        if (dangerousShape(lower) != null) return false
        for (a in allow) {
            if (lower.startsWith(a)) return true
        }
        return false
    }

    /**
     * 形状判定：这条命令的**结构**危不危险。
     *
     * @return 拒绝理由；null 表示形状上没问题。
     */
    fun dangerousShape(lowerCmd: String): String? {
        val segments = splitSegments(lowerCmd)
        val effective = effectiveCommand(segments) ?: return null
        val program = effective.first
        val args = effective.second
        return when (program) {
            "rm" -> rmReason(args)
            "chmod" -> chmodReason(args)
            else -> null
        }
    }

    /**
     * 真正要跑的那条命令。
     *
     * 包装器要拆穿：`sh -c 'rm -rf /'` 里真正危险的是引号里的那条；`sudo rm -rf /`
     * 里真正危险的是 `sudo` 后面那条。不拆穿，形状判定就只看到了包装器。
     */
    private fun effectiveCommand(segments: List<String>): Pair<String, List<String>>? {
        var i = 0
        while (i < segments.size) {
            val seg = segments[i]
            if (seg in SHELL_FAMILIES && i + 1 < segments.size && segments[i + 1] == "-c") {
                val inner = unquote(segments.getOrElse(i + 2) { "" })
                val innerSegments = splitSegments(inner.lowercase().trim())
                return effectiveCommand(innerSegments)
            }
            if (seg in WRAPPERS) {
                i++
                // 跳过包装器自己的参数：选项、时长、数字、VAR=1。
                while (i < segments.size && isWrapperArgument(segments[i])) i++
                continue
            }
            return seg to segments.drop(i + 1)
        }
        return null
    }

    /** 包装器的参数（不是命令本身）。 */
    private fun isWrapperArgument(segment: String): Boolean {
        if (segment.startsWith("-")) return true
        if (segment.contains("=")) return true
        return segment.all { it.isDigit() } && segment.isNotEmpty()
    }

    /**
     * `rm` 的形状判定。
     *
     * 判的是**目标**，不是写法：只要目标是根路径（整棵用户存储也算），无论写成
     * `-rf`、`-r -f`、`-f -r`、`--recursive --force` 还是 `rm -fr /`，一律拒。
     *
     * 递归删**子目录**不拒——那是文件管理器的主功能（删一个文件夹），拦掉等于
     * 把主功能废了。用户确认那一步在 Dart 侧做（§9.23 的分级策略）。
     *
     * 这一层同时修掉了拼写层的一个**误拦**：deny 名单里的 `rm -rf /` 是前缀，
     * 它把 `rm -rf /storage/emulated/0/Download/旧目录` 一并拒了——递归删任何
     * 绝对路径都不许发（2026-11-10 实测）。
     */
    private fun rmReason(args: List<String>): String? {
        for (arg in args) {
            if (arg.startsWith("-")) continue
            val target = normalizePath(unquote(arg))
            if (target in ROOT_ALIASES || target in ROOT_LIKE) {
                return "rm 的目标是根路径（$target）"
            }
            if (target.startsWith(HOME_PREFIX)) {
                return "rm 的目标是家目录（$target）"
            }
            if (target in DANGEROUS_VARS) {
                return "rm 的目标是指向根的变量（$target）"
            }
        }
        return null
    }

    /**
     * 归一化路径：合并重复斜杠、去尾斜杠（`/` 本身除外）、把 `/.` 收成根。
     *
     * 为什么：POSIX 里 `//`、`/.`、`/./` 都等于 `/`。不归一化，`rm -rf //` 就是
     * 一个能绕过的写法。
     */
    private fun normalizePath(path: String): String {
        var p = path.trim()
        if (p.isEmpty()) return ""
        while (p.contains("//")) p = p.replace("//", "/")
        if (p.length > 1 && p.endsWith("/")) p = p.dropLast(1)
        if (p.length > 1 && p.endsWith("/.")) p = p.dropLast(1)
        return p
    }

    /**
     * `chmod` 的形状判定：把系统路径改成全局可写。
     *
     * 目标里写的是 §五 安全护栏点名的 `chmod 777 /system`。`chmod` 当前不在
     * allow 前缀名单里（拼写层就会拒），这道是为「白名单以后放行 chmod」预留的。
     */
    private fun chmodReason(args: List<String>): String? {
        var mode: String? = null
        val targets = mutableListOf<String>()
        for (arg in args) {
            if (arg.startsWith("-")) continue
            if (mode == null && arg.length in 3..4 && arg.all { it.isDigit() }) {
                mode = arg
                continue
            }
            targets.add(unquote(arg))
        }
        val digits = mode ?: return null
        // other 位（最后一位）是 7 就是「任何人可写」。
        if (digits.last() != '7') return null
        for (target in targets) {
            if (SYSTEM_PREFIXES.any { target == it || target.startsWith("$it/") }) {
                return "chmod 把系统路径改成全局可写（$target）"
            }
        }
        return null
    }

    /**
     * 按空白切分，但**引号里的空格不切**。
     *
     * 为什么：`sh -c 'rm -rf /'` 里的引号内容是一个整体，切散了形状判定就看不到
     * 那条真正的命令。切分保留引号，判定时再 [unquote]。
     */
    private fun splitSegments(cmd: String): List<String> {
        val out = mutableListOf<String>()
        val current = StringBuilder()
        var quoteChar = ' '
        var hasContent = false
        for (ch in cmd) {
            when {
                quoteChar != ' ' -> {
                    current.append(ch)
                    if (ch == quoteChar) quoteChar = ' '
                }
                ch == '\'' || ch == '"' -> {
                    quoteChar = ch
                    current.append(ch)
                    hasContent = true
                }
                ch.isWhitespace() -> {
                    if (hasContent) {
                        out.add(current.toString())
                        current.setLength(0)
                        hasContent = false
                    }
                }
                else -> {
                    current.append(ch)
                    hasContent = true
                }
            }
        }
        if (hasContent) out.add(current.toString())
        return out
    }

    /** 去掉外层引号。 */
    private fun unquote(value: String): String {
        if (value.length >= 2) {
            val first = value.first()
            val last = value.last()
            if ((first == '\'' && last == '\'') || (first == '"' && last == '"')) {
                return value.substring(1, value.length - 1)
            }
        }
        return value
    }
}
