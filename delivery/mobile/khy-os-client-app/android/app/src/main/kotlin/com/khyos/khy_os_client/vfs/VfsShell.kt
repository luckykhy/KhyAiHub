package com.khyos.khy_os_client.vfs

import android.content.Context
import android.util.Base64
import com.khyos.khy_os_client.ShizukuServiceManager
import java.io.File

/**
 * shell 通道：所有需要提权才能看见的路径，都从这里走 Shizuku。
 *
 * 三条不可让步的规矩：
 *
 * 1. **Shizuku 不可用就明说，不退化成普通 shell。**
 *    普通 shell（uid 2000）看不见 /data/data、读不了系统分区。命令照样会「成功」
 *    ——返回空列表、权限错误——于是用户看到的是「这里没有文件」，而不是
 *    「你还差一步授权」。这两种失败必须长得不一样，否则用户会以为 App 坏了。
 *
 * 2. **路径必须转义后再拼进命令。**
 *    用户可以控制的路径会进到 `sh -c` 的命令行里。不转义就等于把 shell 给了用户：
 *    一个叫 `a; rm -rf /` 的目录名就是一次数据销毁。所以每个路径都过 [quote]，
 *    单引号包裹 + 内部单引号按 POSIX 方式转义。
 *
 * 3. **命令失败要说人话。**
 *    toybox 的 stderr 直接透给用户没有意义（"ls: /data/data/x: Permission denied"）。
 *    这里把它归到十个机器码里，让 Dart 侧能分「该授权」与「路径不对」。
 */
object VfsShell {

    /** 单次命令超时。找目录可能慢，但不能让界面无限转圈。 */
    private const val DEFAULT_TIMEOUT_MS = 30_000L

    /** 写文件的命令行长度上限：base64 之后还要塞进 argv。 */
    private const val WRITE_MAX_BYTES = 256 * 1024

    /** 批量 stat 的批大小。单条命令的 argv 有限度，批太大就换不来了。 */
    private const val STAT_BATCH = 50

    /**
     * POSIX 单引号转义。
     *
     * 单引号里不能含单引号，所以按 POSIX 的办法先闭合、插入转义的单引号、再重开：
     * `it's` → `'it'\''s'`。这是唯一能在 POSIX shell 里安全表达任意字符串的写法。
     */
    fun quote(path: String): String {
        val sb = StringBuilder()
        sb.append('\'')
        for (ch in path) {
            if (ch == '\'') {
                sb.append("'\\''")
            } else {
                sb.append(ch)
            }
        }
        sb.append('\'')
        return sb.toString()
    }

    /**
     * 跑一条命令。
     *
     * @return null 表示 Shizuku 不可用——调用方必须把它当成
     *         `shizuku_unavailable` 抛出去，**不能**退化成普通 shell。
     */
    private fun exec(context: Context, command: String, timeoutMs: Long = DEFAULT_TIMEOUT_MS):
            Triple<String, String, Int>? {
        return ShizukuServiceManager.execViaShizuku(context, command, timeoutMs)
    }

    /** 跑一条命令；Shizuku 不可用就抛 `shizuku_unavailable`。 */
    private fun execOrThrow(
        context: Context,
        command: String,
        timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    ): Triple<String, String, Int> {
        val result = exec(context, command, timeoutMs)
            ?: throw VfsError(
                VfsBridge.ERR_SHIZUKU_UNAVAILABLE,
                "Shizuku 未激活，无法访问该路径",
            )
        return result
    }

    /**
     * 把命令失败归一成机器码 + 中文说明。
     *
     * toybox 的错误信息对用户没有意义，但它的**关键词**是稳定的：
     * "Permission denied" / "No such file" / "Read-only file system" / "File exists"。
     * 按关键词归类，比按退出码归类准（toybox 的退出码在不同版本间不统一）。
     */
    private fun failure(stderr: String, exitCode: Int): VfsError {
        val text = stderr.trim()
        val lower = text.lowercase()
        return when {
            lower.contains("permission denied") || lower.contains("operation not permitted") ->
                VfsError(VfsBridge.ERR_DENIED, "权限不足：$text")
            lower.contains("read-only file system") ->
                VfsError(VfsBridge.ERR_READ_ONLY, "目标位于只读分区")
            lower.contains("no such file or directory") || lower.contains("not found") ->
                VfsError(VfsBridge.ERR_NOT_FOUND, "路径不存在")
            lower.contains("directory not empty") ->
                VfsError(VfsBridge.ERR_BUSY, "目录非空，需要递归删除")
            lower.contains("file exists") ->
                VfsError(VfsBridge.ERR_CONFLICT, "目标已存在")
            lower.contains("not a directory") ->
                VfsError(VfsBridge.ERR_INVALID_PATH, "路径不是目录")
            lower.contains("is a directory") ->
                VfsError(VfsBridge.ERR_INVALID_PATH, "路径是目录")
            exitCode == 124 ->
                VfsError(VfsBridge.ERR_BUSY, "命令超时，请稍后重试")
            else -> VfsError(VfsBridge.ERR_SHELL_FAILED, "命令执行失败：$text")
        }
    }

    // ------------------------------------------------------------------
    // list
    // ------------------------------------------------------------------

    /**
     * 列目录。
     *
     * 用 `ls -laZ`：一次拿到权限位、属主属组、大小、时间和 SELinux 标签。
     * 为什么要 `-Z`：文件管理器要显示「这个标签是什么上下文」，那只能在设备上问
     * 内核，普通 java.io.File 给不了。
     *
     * 输出形如：
     * `-rw-r--r-- 1 u0_a123 u0_a123 1234 2026-11-09 10:28 name.txt u:object_r:sdcardfs:s0`
     *
     * 解析要点：**文件名可能含空格**，所以不能简单 split 完事。做法是切掉固定的
     * 前缀字段（权限 10 字符 + 链接数 + owner + group + 大小 + 日期 + 时间），
     * 剩下的整体当文件名；只有末尾的 SELinux 上下文需要再切出来。
     */
    fun list(context: Context, vpath: String, real: String): Map<String, Any> {
        val (stdout, stderr, code) = execOrThrow(context, "ls -laZ -- ${quote(real)}")
        if (code != 0) throw failure(stderr, code)
        val nodes = ArrayList<Map<String, Any>>()
        for (line in stdout.split("\n")) {
            val entry = parseLsLine(line) ?: continue
            // . 与 .. 是目录自己，不是条目。
            if (entry.name == "." || entry.name == "..") continue
            nodes.add(
                mapOf(
                    "name" to entry.name,
                    "path" to joinPath(vpath, entry.name),
                    "isDirectory" to entry.isDirectory,
                    "size" to entry.size,
                    "modifiedMs" to entry.modifiedMs,
                    "mode" to entry.mode,
                    "owner" to entry.owner,
                    "group" to entry.group,
                    "selinux" to entry.selinux,
                    "mime" to VfsBridge.mimeOf(entry.name, entry.isDirectory),
                    "readOnly" to entry.readOnly,
                    "accessible" to true,
                    "reason" to "",
                    "linkTarget" to entry.linkTarget,
                )
            )
        }
        return mapOf("ok" to true, "nodes" to nodes)
    }

    /** `ls -laZ` 的一行。解析不出来就是 null——跳过这一行，不让整次 list 失败。 */
    private class LsEntry(
        val name: String,
        val isDirectory: Boolean,
        val size: Long,
        val modifiedMs: Long,
        val mode: String,
        val owner: String,
        val group: String,
        val selinux: String,
        val readOnly: Boolean,
        val linkTarget: String,
    )

    /**
     * `ls -laZ` 的一行。
     *
     * 用正则而不是 split，是因为 toybox 的日期有**两种**格式：
     *  - 近半年的文件：`2026-11-09 10:28`（两段）
     *  - 更早的文件：`Nov  9  2024`（三段，且没有时间）
     *  按固定字段数切分会在第二种格式上整体错位——文件名会被当成日期的一部分。
     *  所以日期段用「二选一」的模式匹配，两个可选分支各带自己的分组。
     */
    private val LS_LINE = Regex(
        "^([-bcdlps][-rwxXsStT]{9})\\s+(\\d+)\\s+(\\S+)\\s+(\\S+)\\s+(\\d+)\\s+" +
            "(?:(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{2}:\\d{2})" +
            "|([A-Za-z]{3})\\s+(\\d{1,2})\\s+(\\d{4}))" +
            "\\s+(.*)$"
    )

    private fun parseLsLine(line: String): LsEntry? {
        val trimmed = line.trim()
        // 首行是 "total N"，跳过。
        if (trimmed.isEmpty() || trimmed.startsWith("total ")) return null
        if (trimmed.startsWith("ls:")) return null

        val m = LS_LINE.find(trimmed) ?: return null
        val mode = m.groupValues[1]
        val owner = m.groupValues[3]
        val group = m.groupValues[4]
        val size = m.groupValues[5].toLongOrNull() ?: return null
        var rest = m.groupValues[11]

        // 顺序很重要：**先**剥掉末尾的 SELinux 上下文，**再**拆符号链接箭头。
        //
        // 符号链接那一行是 `name -> target u:object_r:...:s0`：上下文在最后。
        // 若先拆箭头，linkTarget 会把上下文一起吞进去。
        var selinux = ""
        val lastSpace = rest.lastIndexOf(' ')
        if (lastSpace > 0) {
            val tail = rest.substring(lastSpace + 1)
            if (looksLikeSelinux(tail)) {
                selinux = tail
                rest = rest.substring(0, lastSpace)
            }
        }

        var linkTarget = ""
        val arrow = rest.indexOf(" -> ")
        if (arrow >= 0) {
            linkTarget = rest.substring(arrow + 4)
            rest = rest.substring(0, arrow)
        }

        val modifiedMs = parseLsTime(m)
        // 权限位里没有 w（owner/group/other 三组都没有）就是只读。
        val readOnly = !mode.contains('w')
        return LsEntry(
            name = rest,
            isDirectory = mode[0] == 'd',
            size = size,
            modifiedMs = modifiedMs,
            mode = mode,
            owner = owner,
            group = group,
            selinux = selinux,
            readOnly = readOnly,
            linkTarget = linkTarget,
        )
    }

    /** SELinux 上下文的样子：`u:object_r:sdcardfs:s0`。 */
    private fun looksLikeSelinux(token: String): Boolean {
        if (!token.contains(':')) return false
        val parts = token.split(':')
        // 至少三段，且第一段是单个字符的域（u/c/r/z…）。
        if (parts.size < 3) return false
        if (parts[0].length != 1) return false
        return parts.all { it.isNotEmpty() }
    }

    /**
     * `ls -la` 的时间 → 毫秒时间戳。
     *
     * toybox 输出两种格式：近半年的文件是 "2026-11-09 10:28"，更早的是
     * "Nov  9  2024"。后者没有时间字段，就取当天 00:00。
     *
     * 解析不了就返回 0——时间显示不出来不是致命错误，编一个假时间才是
     * （那会让「按修改时间排序」排出一个看似合理、实则全错的顺序）。
     */
    private fun parseLsTime(match: MatchResult): Long {
        return try {
            val isoDate = match.groupValues[6]
            if (isoDate.isNotEmpty()) {
                val parts = isoDate.split("-")
                val year = parts[0].toInt()
                val month = parts[1].toInt()
                val day = parts[2].toInt()
                val timeParts = match.groupValues[7].split(":")
                val hour = timeParts[0].toInt()
                val minute = timeParts[1].toInt()
                val second = if (timeParts.size > 2) timeParts[2].toInt() else 0
                calendarOf(year, month, day, hour, minute, second)
            } else {
                // 月份名 → 月份序号。英文缩写固定 12 个，直接查表。
                val monthName = match.groupValues[8]
                val month = MONTH_NAMES[monthName.lowercase()] ?: return 0L
                val day = match.groupValues[9].toInt()
                val year = match.groupValues[10].toInt()
                calendarOf(year, month, day, 0, 0, 0)
            }
        } catch (e: Throwable) {
            0L
        }
    }

    private fun calendarOf(
        year: Int,
        month: Int,
        day: Int,
        hour: Int,
        minute: Int,
        second: Int,
    ): Long {
        return java.util.Calendar.getInstance().apply {
            clear()
            set(year, month - 1, day, hour, minute, second)
        }.timeInMillis
    }

    private val MONTH_NAMES = mapOf(
        "jan" to 1, "feb" to 2, "mar" to 3, "apr" to 4, "may" to 5, "jun" to 6,
        "jul" to 7, "aug" to 8, "sep" to 9, "oct" to 10, "nov" to 11, "dec" to 12,
    )

    /** 拼路径。根目录不产生双斜杠。 */
    private fun joinPath(base: String, name: String): String {
        if (base.endsWith("/")) return base + name
        return "$base/$name"
    }

    // ------------------------------------------------------------------
    // stat
    // ------------------------------------------------------------------

    /**
     * 单个文件属性。
     *
     * 用 `stat -c '%f|%s|%Y|%U|%G|%n'`：%f 是十六进制权限位、%s 大小、%Y mtime 秒、
     * %U/%G 属主属组、%n 名字。用 | 分隔是因为路径里可能有空格。
     */
    fun stat(context: Context, vpath: String, real: String): Map<String, Any> {
        val nodes = statMany(context, listOf(real))
        val node = nodes.firstOrNull()
            ?: throw VfsError(VfsBridge.ERR_NOT_FOUND, "路径不存在：$vpath")
        return mapOf("ok" to true, "node" to node)
    }

    /**
     * 批量 stat。
     *
     * 分批（≤ [STAT_BATCH]）是因为 argv 长度有限度；一次 stat 一百个路径，
     * 命令行就可能超限，返回的是空结果——那比报错更难查。
     */
    private fun statMany(context: Context, paths: List<String>): List<Map<String, Any>> {
        if (paths.isEmpty()) return emptyList()
        val result = ArrayList<Map<String, Any>>()
        var index = 0
        while (index < paths.size) {
            val batch = paths.subList(index, minOf(index + STAT_BATCH, paths.size))
            val command = "stat -c '%f|%s|%Y|%U|%G|%n' -- " +
                batch.joinToString(" ") { quote(it) }
            val (stdout, stderr, code) = execOrThrow(context, command)
            if (code != 0 && stdout.isBlank()) {
                // 整批都失败：路径大概率真不存在。
                throw failure(stderr, code)
            }
            // 批量里只要有一个不存在，整条命令就非零退出；但其余的路径是好的，
            // 所以这里逐行解析，能解析多少算多少。
            for (line in stdout.split("\n")) {
                val node = parseStatLine(context, line) ?: continue
                result.add(node)
            }
            index += STAT_BATCH
        }
        return result
    }

    /** 解析 `stat -c` 的一行。 */
    private fun parseStatLine(context: Context, line: String): Map<String, Any>? {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return null
        // limit=6：前 5 段按 | 切，第 6 段（路径）整段保留。
        // 不加 limit 的话，路径里含 | 会被切碎，名字与路径都错位。
        val parts = trimmed.split("|", limit = 6)
        if (parts.size < 6) return null
        val modeHex = parts[0].toLongOrNull() ?: return null
        val size = parts[1].toLongOrNull() ?: return null
        val mtimeSeconds = parts[2].toLongOrNull() ?: return null
        val owner = parts[3]
        val group = parts[4]
        // %n 是传进去的完整路径。
        val fullPath = parts[5]
        val name = fullPath.substringAfterLast('/')
        val mode = VfsBridge.modeString(modeHex.toInt())
        val isDir = VfsBridge.isDirectoryMode(modeHex.toInt())
        return mapOf(
            "name" to name,
            "path" to VfsBridge.toVirtual(context, fullPath),
            "isDirectory" to isDir,
            "size" to size,
            "modifiedMs" to mtimeSeconds * 1000L,
            "mode" to mode,
            "owner" to owner,
            "group" to group,
            "selinux" to "",
            "mime" to VfsBridge.mimeOf(name, isDir),
            "readOnly" to !mode.contains('w'),
            "accessible" to true,
            "reason" to "",
            "linkTarget" to "",
        )
    }

    // ------------------------------------------------------------------
    // read / write
    // ------------------------------------------------------------------

    /**
     * 读文件。
     *
     * `head -c <maxBytes> -- <path> | base64`：base64 是为了把**二进制**安全地
     * 穿过 stdout——直接回传原始字节会在非 UTF-8 时被截断成乱码。
     *
     * toybox 的 base64 输出带换行，取回后要去掉再解码。
     *
     * 先 stat 一次有两个好处：一是路径不存在时能给出 not_found 而不是空内容
     * （管道里 base64 的退出码会盖掉 head 的失败）；二是拿到真实大小，
     * truncated 才能判准。
     */
    fun read(context: Context, vpath: String, real: String, maxBytes: Int): Map<String, Any> {
        // 先 stat 一次有两个好处：一是路径不存在时能给出 not_found 而不是空内容
        // （管道里 base64 的退出码会盖掉 head 的失败）；二是拿到真实大小，
        // truncated 才能判准。
        val sizeResult = execOrThrow(context, "stat -c '%s' -- ${quote(real)}")
        if (sizeResult.third != 0) throw failure(sizeResult.second, sizeResult.third)
        val actualSize = sizeResult.first.trim().toLongOrNull()
        val command = "head -c $maxBytes -- ${quote(real)} | base64"
        val (stdout, stderr, code) = execOrThrow(context, command)
        if (code != 0) throw failure(stderr, code)
        val bytes = try {
            Base64.decode(stdout.replace("\n", "").replace("\r", "").trim(), Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            throw VfsError(VfsBridge.ERR_SHELL_FAILED, "读取结果解码失败")
        }
        // 截断标记只在确知文件比读到的多时才给。
        val truncated = actualSize != null && actualSize > bytes.size
        return if (VfsBridge.looksBinary(bytes)) {
            mapOf(
                "ok" to true,
                "content" to Base64.encodeToString(bytes, Base64.NO_WRAP),
                "binary" to true,
                "truncated" to truncated,
            )
        } else {
            mapOf(
                "ok" to true,
                "content" to String(bytes, Charsets.UTF_8),
                "binary" to false,
                "truncated" to truncated,
            )
        }
    }

    /**
     * 写文件。
     *
     * `printf '%s' '<base64>' | base64 -d > '<path>'`：走 base64 是为了不碰
     * 引号、换行、反斜杠这些在 shell 里要命的东西。
     *
     * 内容超过 256KB 直接拒绝：命令行长度有上限，超了 toybox 会截断或报
     * "Argument list too long"，而截断的写入**看起来是成功的**——那比失败更糟。
     */
    fun write(
        context: Context,
        vpath: String,
        real: String,
        content: String,
        binary: Boolean,
    ): Map<String, Any> {
        val raw = if (binary) {
            try {
                Base64.decode(content, Base64.DEFAULT)
            } catch (e: IllegalArgumentException) {
                throw VfsError(VfsBridge.ERR_INVALID_PATH, "base64 内容无法解码")
            }
        } else {
            content.toByteArray(Charsets.UTF_8)
        }
        if (raw.size > WRITE_MAX_BYTES) {
            throw VfsError(
                VfsBridge.ERR_SHELL_FAILED,
                "内容过大，请改用其它方式写入（上限 ${WRITE_MAX_BYTES / 1024}KB）",
            )
        }
        val encoded = Base64.encodeToString(raw, Base64.NO_WRAP)
        val command = "printf '%s' ${quote(encoded)} | base64 -d > ${quote(real)}"
        val (_, stderr, code) = execOrThrow(context, command)
        if (code != 0) throw failure(stderr, code)
        return mapOf("ok" to true, "message" to "已写入 ${raw.size} 字节")
    }

    // ------------------------------------------------------------------
    // mkdir / delete
    // ------------------------------------------------------------------

    /**
     * 建目录。
     *
     * parents=true 用 `mkdir -p`（沿途补齐）；false 用 `mkdir`（父目录不存在就失败），
     * 后者是有意义的：用户说「不要递归建」就是在说这件事。
     */
    fun mkdir(context: Context, vpath: String, real: String, parents: Boolean): Map<String, Any> {
        val command = if (parents) {
            "mkdir -p -- ${quote(real)}"
        } else {
            "mkdir -- ${quote(real)}"
        }
        val (_, stderr, code) = execOrThrow(context, command)
        if (code != 0) throw failure(stderr, code)
        return mapOf("ok" to true, "message" to "已创建目录：$vpath")
    }

    /**
     * 删除。
     *
     * recursive=false 且目标是目录时用 `rmdir`——它对非空目录会失败，
     * 这正好是「不要递归删」的语义。`rm -rf` 在这里绝不能默认使用：
     * 一个参数写错就是整棵目录树消失。
     */
    fun delete(context: Context, vpath: String, real: String, recursive: Boolean): Map<String, Any> {
        val isDirectory = isDirectory(context, real)
        val command = if (recursive) {
            "rm -rf -- ${quote(real)}"
        } else if (isDirectory) {
            "rmdir -- ${quote(real)}"
        } else {
            "rm -- ${quote(real)}"
        }
        val (_, stderr, code) = execOrThrow(context, command)
        if (code != 0) throw failure(stderr, code)
        return mapOf("ok" to true, "deleted" to 1)
    }

    /** 判断路径是不是目录。用 stat 而不是 ls——要的是属性，不是列表。 */
    private fun isDirectory(context: Context, real: String): Boolean {
        val (stdout, _, code) = execOrThrow(context, "stat -c '%F' -- ${quote(real)}")
        if (code != 0) return false
        return stdout.trim().startsWith("directory")
    }

    // ------------------------------------------------------------------
    // rename / copy / move
    // ------------------------------------------------------------------

    /**
     * 改名。
     *
     * overwrite=false 且目标已存在时返回 conflict——不静默覆盖。文件管理器的
     * 「改名」撞上同名文件时，覆盖是一个**决定**，不能由后端替用户做。
     */
    fun rename(
        context: Context,
        from: String,
        fromReal: String,
        to: String,
        toReal: String,
        overwrite: Boolean,
    ): Map<String, Any> {
        if (!overwrite && exists(context, toReal)) {
            throw VfsError(VfsBridge.ERR_CONFLICT, "目标已存在：$to")
        }
        val command = "mv -- ${quote(fromReal)} ${quote(toReal)}"
        val (_, stderr, code) = execOrThrow(context, command)
        if (code != 0) throw failure(stderr, code)
        return mapOf("ok" to true, "message" to "已重命名为：$to")
    }

    /**
     * 复制。冲突策略语义与 storage 通道一致。
     *
     * `cp -a` 保留属主/属组/时间戳，shell 通道下这是对的（用户要的是「复制过去
     * 还保持原样」）；`-a` 在某些分区上会失败（无法保留属主），这时退回 `cp -r`。
     */
    fun copy(
        context: Context,
        src: String,
        srcReal: String,
        dst: String,
        dstReal: String,
        conflict: String,
    ): Map<String, Any> {
        val plan = planTarget(context, srcReal, dstReal, conflict)
        if (plan.merged) {
            return mapOf("ok" to true, "skipped" to false, "message" to "已合并到：$dst")
        }
        val target = plan.path ?: return mapOf(
            "ok" to true,
            "skipped" to true,
            "message" to "目标已存在，已跳过",
        )
        val command = "cp -a -- ${quote(srcReal)} ${quote(target)}"
        val (_, stderr, code) = execOrThrow(context, command)
        if (code != 0) {
            // cp -a 在无法保留属主的分区上会失败，退回普通递归复制。
            val fallback = "cp -r -- ${quote(srcReal)} ${quote(target)}"
            val (_, stderr2, code2) = execOrThrow(context, fallback)
            if (code2 != 0) throw failure(stderr2, code2)
        }
        return mapOf("ok" to true, "skipped" to false, "message" to "已复制到：$dst")
    }

    /**
     * 移动。
     *
     * `mv` 在同一分区上是改名（快、原子），跨分区时 toybox 自己会退化成
     * 复制+删除，所以不需要我们再实现一遍「先试 renameTo 失败再复制」。
     */
    fun move(
        context: Context,
        src: String,
        srcReal: String,
        dst: String,
        dstReal: String,
        conflict: String,
    ): Map<String, Any> {
        val plan = planTarget(context, srcReal, dstReal, conflict)
        if (plan.merged) {
            // 合并的语义是「内容并进去」，源目录随后要删掉——移动就是把源搬走。
            execOrThrow(context, "rm -rf -- ${quote(srcReal)}")
            return mapOf("ok" to true, "skipped" to false, "message" to "已合并到：$dst")
        }
        val target = plan.path ?: return mapOf(
            "ok" to true,
            "skipped" to true,
            "message" to "目标已存在，已跳过",
        )
        val command = "mv -- ${quote(srcReal)} ${quote(target)}"
        val (_, stderr, code) = execOrThrow(context, command)
        if (code != 0) throw failure(stderr, code)
        return mapOf("ok" to true, "skipped" to false, "message" to "已移动到：$dst")
    }

    /**
     * 目标路径的规划结果。
     *
     * @property path 最终目标路径；null 表示应当跳过（skip 策略）。
     * @property merged 目标目录已经就地合并完成，无需再执行拷贝。
     */
    private class TargetPlan(val path: String?, val merged: Boolean = false)

    /**
     * 按冲突策略解析出最终目标路径。
     *
     * 「目标是已存在目录、源是文件」时把文件放进目录里（而不是删掉那个目录）——
     * 这与 storage 通道一致，也避免了 overwrite 策略把用户的整个目录删掉。
     */
    private fun planTarget(
        context: Context,
        srcReal: String,
        dstReal: String,
        conflict: String,
    ): TargetPlan {
        if (!exists(context, dstReal)) return TargetPlan(dstReal)
        val effective = if (!isDirectory(context, srcReal) && isDirectory(context, dstReal)) {
            "$dstReal/${File(srcReal).name}"
        } else {
            dstReal
        }
        if (!exists(context, effective)) return TargetPlan(effective)
        return when (conflict) {
            "skip" -> TargetPlan(null)
            "overwrite" -> {
                execOrThrow(context, "rm -rf -- ${quote(effective)}")
                TargetPlan(effective)
            }
            "rename" -> TargetPlan(uniqueTarget(context, effective))
            "merge" -> {
                // 目标是已存在目录时，把源目录的内容并进去。
                // 逐个子项处理而不是 cp -a src/. dst/，这样同名文件的处理
                // 与 storage 通道完全一致（同名文件按 overwrite 处理）。
                if (isDirectory(context, srcReal) && isDirectory(context, effective)) {
                    mergeInto(context, srcReal, effective)
                    TargetPlan(null, merged = true)
                } else {
                    execOrThrow(context, "rm -rf -- ${quote(effective)}")
                    TargetPlan(effective)
                }
            }
            else -> throw VfsError(VfsBridge.ERR_INVALID_PATH, "未知的冲突策略：$conflict")
        }
    }

    /** 把源目录内容并进目标目录；同名文件按 overwrite 处理。 */
    private fun mergeInto(context: Context, srcReal: String, dstReal: String) {
        val listing = execOrThrow(context, "ls -a -- ${quote(srcReal)}")
        for (name in listing.first.split("\n").map { it.trim() }.filter { it.isNotEmpty() }) {
            if (name == "." || name == "..") continue
            execOrThrow(context, "rm -rf -- ${quote("$dstReal/$name")}")
            execOrThrow(context, "cp -a -- ${quote("$srcReal/$name")} ${quote("$dstReal/$name")}")
        }
    }

    /** 找一个不存在的目标名：name (1).ext、name (2).ext…。 */
    private fun uniqueTarget(context: Context, target: String): String {
        val file = File(target)
        val parent = file.parent ?: "/"
        val name = file.name
        val dot = name.lastIndexOf('.')
        val hasExt = dot > 0 && dot < name.length - 1
        val stem = if (hasExt) name.substring(0, dot) else name
        val ext = if (hasExt) name.substring(dot) else ""
        for (i in 1..999) {
            val candidate = "$parent/$stem ($i)$ext"
            if (!exists(context, candidate)) return candidate
        }
        throw VfsError(VfsBridge.ERR_BUSY, "无法生成可用文件名：$name")
    }

    /** 路径是否存在。stat 成功即存在。 */
    private fun exists(context: Context, real: String): Boolean {
        val (_, _, code) = execOrThrow(context, "stat -c '%f' -- ${quote(real)}")
        return code == 0
    }

    // ------------------------------------------------------------------
    // search / hash / space
    // ------------------------------------------------------------------

    /**
     * 搜索。
     *
     * `find <dir> [-maxdepth 1] -name '<pattern>'`：模式是 shell 通配，不是正则。
     * 名字里带正则元字符也没关系，因为 find 自己处理 glob。
     *
     * 内容关键词在 shell 通道下不做：要在设备上 grep 几百个文件，
     * 每秒几次的往返会让界面卡住；这一档需求由 Dart 侧在拿到节点后自己读文件判断。
     */
    fun search(
        context: Context,
        dir: String,
        dirReal: String,
        query: String,
        namePattern: String,
        maxResults: Int,
        recursive: Boolean,
    ): Map<String, Any> {
        val depth = if (recursive) "" else " -maxdepth 1"
        val command = "find ${quote(dirReal)}$depth -name ${quote(namePattern)}"
        val (stdout, stderr, code) = execOrThrow(context, command)
        if (code != 0) throw failure(stderr, code)
        val paths = stdout.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        if (paths.isEmpty()) return mapOf("ok" to true, "nodes" to emptyList<Map<String, Any>>())
        // 只 stat 前 maxResults 条：stat 是往返密集的操作。
        val limited = paths.take(maxResults)
        val nodes = statMany(context, limited)
        return mapOf("ok" to true, "nodes" to nodes)
    }

    /**
     * 哈希。
     *
     * 用系统的 md5sum / sha256sum 而不是自己算：设备上算哈希是 native 的活，
     * 把几 GB 的文件搬进 JVM 再算会慢一个数量级，还占内存。
     */
    fun hash(context: Context, vpath: String, real: String, algorithm: String): Map<String, Any> {
        val command = if (algorithm == "md5") {
            "md5sum -- ${quote(real)}"
        } else {
            "sha256sum -- ${quote(real)}"
        }
        val (stdout, stderr, code) = execOrThrow(context, command)
        if (code != 0) throw failure(stderr, code)
        val digest = stdout.trim().split(" ").firstOrNull() ?: ""
        if (digest.isEmpty()) {
            throw VfsError(VfsBridge.ERR_SHELL_FAILED, "哈希计算失败")
        }
        return mapOf("ok" to true, "algorithm" to algorithm, "digest" to digest)
    }

    /**
     * 磁盘空间。
     *
     * `df -k` 给出 1K 块：total = blocks*1024，used = used*1024，
     * free = (blocks-used)*1024。
     */
    fun space(context: Context, vpath: String, real: String): Map<String, Any> {
        val (stdout, stderr, code) = execOrThrow(context, "df -k -- ${quote(real)}")
        if (code != 0) throw failure(stderr, code)
        val lines = stdout.split("\n").filter { it.isNotBlank() }
        // 第 1 行是表头，第 2 行是数据。
        if (lines.size < 2) {
            throw VfsError(VfsBridge.ERR_SHELL_FAILED, "无法读取磁盘空间")
        }
        val fields = lines[1].trim().split(" ").filter { it.isNotEmpty() }
        if (fields.size < 3) {
            throw VfsError(VfsBridge.ERR_SHELL_FAILED, "无法解析磁盘空间")
        }
        val blocks = fields[1].toLongOrNull()
            ?: throw VfsError(VfsBridge.ERR_SHELL_FAILED, "无法解析磁盘空间")
        val used = fields[2].toLongOrNull()
            ?: throw VfsError(VfsBridge.ERR_SHELL_FAILED, "无法解析磁盘空间")
        val total = blocks * 1024L
        val usedBytes = used * 1024L
        return mapOf(
            "ok" to true,
            "total" to total,
            "used" to usedBytes,
            "free" to ((blocks - used) * 1024L),
        )
    }
}
