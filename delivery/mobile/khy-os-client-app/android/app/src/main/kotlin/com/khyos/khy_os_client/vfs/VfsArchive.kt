package com.khyos.khy_os_client.vfs

import android.content.Context
import io.flutter.plugin.common.MethodCall
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/**
 * 归档（压缩包）能力：列包、解包、打包。
 *
 * **格式边界**：只支持 ZIP 与 TAR.GZ，用的是 JDK 自带的 `java.util.zip`
 * （ZipFile / ZipOutputStream / GZIPInputStream / GZIPOutputStream）加上手写的
 * tar 头解析。刻意不引第三方依赖（zip4j / commons-compress）——App 的体积与
 * 依赖面是产品决策，不该由一个「列个包」的功能顺带决定。
 *
 * 遇到 `.rar` / `.7z` **不假装支持**：直接返回 not_found，并把「当前版本只支持
 * ZIP 与 TAR.GZ」写进消息里。假装能读然后在解压到一半时炸掉，比明说不支持坏得多。
 *
 * 三道安全闸（都在这里，不在调用方）：
 *  1. **Zip Slip**：归档内条目名解析后必须仍在 targetDir 之内，否则跳过并报告；
 *  2. **压缩炸弹**：单个条目解压后超过 512MB 就跳过，不写盘；
 *  3. **写操作护栏**：目标路径照 VfsBridge 的规则过一遍（禁 `..`、禁受保护路径、
 *     禁系统分区）。护栏真源在 [VfsBridge]（`guardDestructive` /
 *     `requireStoragePermission` / `requirePath`），本文件不再复刻一份。
 *
 * 所有阻塞 IO 都在调用方（[VfsBridge]）的 IO 线程池上跑——本类不自己起线程，
 * 也不碰主线程。
 */
object VfsArchive {

    /** ZIP 格式标识。 */
    const val FORMAT_ZIP = "zip"

    /** TAR.GZ 格式标识。 */
    const val FORMAT_TAR_GZ = "tar.gz"

    /**
     * 单条目解压后的大小上限：512MB。
     *
     * 为什么要有：压缩炸弹（一个几 KB 的包里塞几个 GB 的内容）在解包时会把
     * 设备内存吃光，表现为 App 被系统杀掉，用户只看到「点了解压就闪退」。
     * 逐条目设上限比设总量上限更准——总量上限会把「一个大视频 + 许多小文件」
     * 这种正常包也拦掉。
     */
    private const val MAX_ENTRY_BYTES = 512L * 1024L * 1024L

    /** tar 的块大小。所有头与数据都按 512 字节对齐。 */
    private const val TAR_BLOCK = 512

    /** tar 长文件名记录的长度上限。长名记录本来就是短名字，超过就是坏包。 */
    private const val MAX_LONG_NAME_BYTES = 64L * 1024L

    /** tar 的魔术字段偏移（"ustar\0"）。 */
    private const val TAR_MAGIC_OFFSET = 257

    /** tar 的 ustar 前缀字段偏移（长路径的第二段）。 */
    private const val TAR_PREFIX_OFFSET = 345

    /** zip 不携带 unix 权限位，只能给一个约定值。 */
    private const val ZIP_DEFAULT_FILE_MODE = "rw-r--r--"
    private const val ZIP_DEFAULT_DIR_MODE = "rwxr-xr-x"

    // ------------------------------------------------------------------
    // 入口：archiveList
    // ------------------------------------------------------------------

    /**
     * 列归档内容。
     *
     * args: `{path}`（虚拟路径）
     * 返回: `{ok, format, entries[]}`，entries 每项：
     * `{name, path, isDirectory, size, compressedSize, modifiedMs, mode, mime}`。
     *
     * `path` 与 `name` 同值：归档内的条目没有「真实路径」这个概念，它只存在于
     * 包内。给一个看似真实但其实是拼出来的路径，只会让 Dart 侧拿它去 stat 然后
     * 得到一个莫名其妙的 not_found。
     */
    fun list(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = VfsBridge.requirePath(call, "path")
        val real = VfsBridge.toReal(context, vpath)
        VfsBridge.requireStoragePermission(context, real)
        val file = File(real)
        if (!file.exists()) throw VfsError(VfsBridge.ERR_NOT_FOUND, "归档不存在：$vpath")
        if (!file.isDirectory && !file.isFile) {
            throw VfsError(VfsBridge.ERR_INVALID_PATH, "不是普通文件：$vpath")
        }
        val format = detectFormat(file)
        val entries = try {
            when (format) {
                FORMAT_ZIP -> listZip(file)
                else -> listTarGz(file)
            }
        } catch (e: IOException) {
            throw VfsError(VfsBridge.ERR_UNKNOWN, "归档已损坏或无法读取：${file.name}")
        }
        return mapOf(
            "ok" to true,
            "format" to format,
            "entries" to entries,
        )
    }

    /**
     * 判定归档格式。
     *
     * 先看扩展名，再看魔数：扩展名不可靠（用户可能把 zip 改名成 .data），
     * 但魔数也可能对不上（流式写入的半截包）。两条都判不出来就明说「不认识」，
     * 不猜。
     */
    private fun detectFormat(file: File): String {
        val name = file.name.lowercase()
        if (name.endsWith(".rar") || name.endsWith(".7z")) {
            throw VfsError(
                VfsBridge.ERR_NOT_FOUND,
                "当前版本只支持 ZIP 与 TAR.GZ，无法打开：${file.name}",
            )
        }
        if (name.endsWith(".zip")) return FORMAT_ZIP
        if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) return FORMAT_TAR_GZ
        return when (sniffMagic(file)) {
            'P' -> FORMAT_ZIP
            'G' -> FORMAT_TAR_GZ
            else -> throw VfsError(
                VfsBridge.ERR_NOT_FOUND,
                "当前版本只支持 ZIP 与 TAR.GZ，无法识别该文件：${file.name}",
            )
        }
    }

    /** 读文件头 4 字节判魔数：PK 是 zip，1f 8b 是 gzip。 */
    private fun sniffMagic(file: File): Char {
        return try {
            FileInputStream(file).use { input ->
                val head = ByteArray(4)
                val n = input.read(head)
                if (n < 2) return '?'
                if (head[0] == 'P'.code.toByte() && head[1] == 'K'.code.toByte()) return 'P'
                if ((head[0].toInt() and 0xFF) == 0x1f && (head[1].toInt() and 0xFF) == 0x8b) return 'G'
                '?'
            }
        } catch (e: Throwable) {
            '?'
        }
    }

    /**
     * 读 ZIP 的条目表。
     *
     * 用 [ZipFile]（随机访问）而不是把整包读进内存：一个大包的中央目录可能
     * 有几万条，整包进内存就是一次 OOM。
     */
    private fun listZip(file: File): List<Map<String, Any>> {
        val entries = ArrayList<Map<String, Any>>()
        ZipFile(file).use { zip ->
            val it = zip.entries()
            while (it.hasMoreElements()) {
                val entry = it.nextElement()
                val isDirectory = entry.isDirectory || entry.name.endsWith("/")
                entries.add(
                    entryMap(
                        name = normalizeEntryName(entry.name),
                        isDirectory = isDirectory,
                        size = entry.size.coerceAtLeast(0L),
                        compressedSize = entry.compressedSize.coerceAtLeast(0L),
                        modifiedMs = if (entry.time > 0L) entry.time else 0L,
                        // zip 格式不保存 unix 权限位，给一个约定值而不是编一个假的。
                        mode = if (isDirectory) ZIP_DEFAULT_DIR_MODE else ZIP_DEFAULT_FILE_MODE,
                        mime = VfsBridge.mimeOf(entry.name, isDirectory),
                    )
                )
            }
        }
        return entries
    }

    /**
     * 读 TAR.GZ 的条目表。
     *
     * tar 没有中央目录，只能从头顺序扫：GZIPInputStream 解压 → 逐个 512 字节
     * 头块 → 跳过数据区。逐项的压缩后大小拿不到（gzip 是整体压缩的），填 0。
     */
    private fun listTarGz(file: File): List<Map<String, Any>> {
        val entries = ArrayList<Map<String, Any>>()
        GZIPInputStream(BufferedInputStream(FileInputStream(file))).use { input ->
            var pendingName: String? = null
            while (true) {
                val header = readBlock(input) ?: break
                if (isZeroBlock(header)) break
                val typeFlag = header[156].toInt().toChar()
                val size = parseOctal(header, 124, 12)
                if (typeFlag == 'L' || typeFlag == 'K') {
                    // GNU 长文件名：内容是**下一个**条目的名字。
                    pendingName = readText(input, size)
                    continue
                }
                if (typeFlag == 'x' || typeFlag == 'g') {
                    // pax 扩展头：内容是元数据，这里不解析，跳过即可。
                    skipFully(input, size)
                    continue
                }
                val name = pendingName ?: tarName(header)
                pendingName = null
                skipFully(input, size)
                val isDirectory = typeFlag == '5' || name.endsWith("/")
                val mode = tarMode(header, typeFlag)
                entries.add(
                    entryMap(
                        name = normalizeEntryName(name),
                        isDirectory = isDirectory,
                        size = size,
                        compressedSize = 0L,
                        modifiedMs = parseOctal(header, 136, 12) * 1000L,
                        mode = mode,
                        mime = VfsBridge.mimeOf(name, isDirectory),
                    )
                )
            }
        }
        return entries
    }

    /** 组装一个归档条目。字段名与 Dart 侧逐字对齐。 */
    private fun entryMap(
        name: String,
        isDirectory: Boolean,
        size: Long,
        compressedSize: Long,
        modifiedMs: Long,
        mode: String,
        mime: String,
    ): Map<String, Any> = mapOf(
        "name" to name,
        "path" to name,
        "isDirectory" to isDirectory,
        "size" to size,
        "compressedSize" to compressedSize,
        "modifiedMs" to modifiedMs,
        "mode" to mode,
        "mime" to mime,
    )

    // ------------------------------------------------------------------
    // 入口：archiveExtract
    // ------------------------------------------------------------------

    /**
     * 解包。
     *
     * args: `{path, targetDir, selectedNames, overwrite}`
     * 返回: `{ok, extracted[], count, message}`。
     *
     * `extracted` 里是**写到磁盘后的路径**：按虚拟路径给出（容器里的东西回到
     * `/khyos/container/...`），因为 Dart 侧的路由器只认识虚拟路径——给它
     * `/data/user/0/<pkg>/files/...` 会在下一次导航时被判成「路径不存在」。
     *
     * 跳过而不是整体失败：
     *  - 目标已存在且 overwrite=false → 跳过该条目（记进 message）；
     *  - 条目名逃出 targetDir（Zip Slip）→ 跳过该条目（记进 message）；
     *  - 条目解压后超过 512MB → 跳过该条目（记进 message）。
     * 三种都是「这一条不行」，不是「这个包不行」——整体失败会让用户只能重来。
     */
    fun extract(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = VfsBridge.requirePath(call, "path")
        val targetV = VfsBridge.requirePath(call, "targetDir")
        val selected = call.argument<List<String>>("selectedNames") ?: emptyList()
        val overwrite = call.argument<Boolean>("overwrite") == true
        val real = VfsBridge.toReal(context, vpath)
        val targetReal = VfsBridge.toReal(context, targetV)
        VfsBridge.requireStoragePermission(context, real)
        VfsBridge.requireStoragePermission(context, targetReal)
        // 护栏真源在 VfsBridge。这里按 shell 那一档传，是为了让「系统分区只读」
        // 这道判定照旧生效——本文件原先复刻的护栏是无条件挡系统分区的，收拢到
        // VfsBridge 后按 storage 档会把这道判定漏掉，行为就变了。
        VfsBridge.guardDestructive(context, targetV, targetReal, VfsBridge.VIA_SHELL)

        val file = File(real)
        if (!file.exists()) throw VfsError(VfsBridge.ERR_NOT_FOUND, "归档不存在：$vpath")
        if (!file.isFile) throw VfsError(VfsBridge.ERR_INVALID_PATH, "不是文件：$vpath")
        val format = detectFormat(file)

        val targetDir = File(targetReal)
        if (!targetDir.exists() && !targetDir.mkdirs()) {
            throw VfsError(VfsBridge.ERR_UNKNOWN, "无法创建目标目录：$targetV")
        }
        if (!targetDir.isDirectory) {
            throw VfsError(VfsBridge.ERR_CONFLICT, "目标已存在且不是目录：$targetV")
        }

        val outcome = try {
            when (format) {
                FORMAT_ZIP -> extractZip(context, file, targetDir, selected, overwrite)
                else -> extractTarGz(context, file, targetDir, selected, overwrite)
            }
        } catch (e: IOException) {
            throw VfsError(VfsBridge.ERR_UNKNOWN, "归档已损坏或无法读取：${file.name}")
        }

        val parts = ArrayList<String>()
        parts.add("已解出 ${outcome.extracted.size} 个条目")
        if (outcome.skippedExisting > 0) {
            parts.add("跳过 ${outcome.skippedExisting} 个已存在的条目")
        }
        if (outcome.skippedUnsafe > 0) {
            parts.add("拒绝 ${outcome.skippedUnsafe} 个越界条目（路径逃出目标目录）")
        }
        if (outcome.skippedTooLarge > 0) {
            parts.add("跳过 ${outcome.skippedTooLarge} 个超过 ${MAX_ENTRY_BYTES / 1024 / 1024}MB 的条目")
        }
        return mapOf(
            "ok" to true,
            "extracted" to outcome.extracted,
            "count" to outcome.extracted.size,
            "message" to parts.joinToString("，"),
        )
    }

    /** 解包过程中累计的结果与跳过计数。 */
    private class ExtractOutcome {
        /** 已落盘条目的虚拟路径。 */
        val extracted = ArrayList<String>()

        /** 因目标已存在而跳过。 */
        var skippedExisting = 0

        /** 因路径越界（Zip Slip）而跳过。 */
        var skippedUnsafe = 0

        /** 因超过单条目上限而跳过。 */
        var skippedTooLarge = 0
    }

    private fun extractZip(
        context: Context,
        file: File,
        targetDir: File,
        selected: List<String>,
        overwrite: Boolean,
    ): ExtractOutcome {
        val outcome = ExtractOutcome()
        ZipFile(file).use { zip ->
            val it = zip.entries()
            while (it.hasMoreElements()) {
                val entry = it.nextElement()
                val rawName = entry.name
                val name = normalizeEntryName(rawName)
                if (name.isEmpty()) continue
                // "." 指向目标目录自身：跳过即可，不该算成「越界」——
                // 越界计数要如实反映真的有人想往目标目录外写。
                if (name == ".") continue
                if (!isSelected(selected, rawName, name)) continue
                val target = resolveInside(targetDir, name)
                if (target == null) {
                    outcome.skippedUnsafe += 1
                    continue
                }
                if (entry.isDirectory || rawName.endsWith("/")) {
                    target.mkdirs()
                    outcome.extracted.add(VfsBridge.toVirtual(context, target.absolutePath))
                    continue
                }
                // 压缩炸弹闸：声明大小已经超限就直接跳过，不开流。
                if (entry.size > MAX_ENTRY_BYTES) {
                    outcome.skippedTooLarge += 1
                    continue
                }
                if (target.exists() && !overwrite) {
                    outcome.skippedExisting += 1
                    continue
                }
                target.parentFile?.mkdirs()
                val ok = try {
                    zip.getInputStream(entry).use { input ->
                        copyBounded(input, target)
                    }
                } catch (e: SecurityException) {
                    throw VfsError(VfsBridge.ERR_DENIED, "无权限写入：${target.name}")
                }
                if (!ok) {
                    outcome.skippedTooLarge += 1
                    continue
                }
                outcome.extracted.add(VfsBridge.toVirtual(context, target.absolutePath))
            }
        }
        return outcome
    }

    private fun extractTarGz(
        context: Context,
        file: File,
        targetDir: File,
        selected: List<String>,
        overwrite: Boolean,
    ): ExtractOutcome {
        val outcome = ExtractOutcome()
        GZIPInputStream(BufferedInputStream(FileInputStream(file))).use { input ->
            var pendingName: String? = null
            while (true) {
                val header = readBlock(input) ?: break
                if (isZeroBlock(header)) break
                val typeFlag = header[156].toInt().toChar()
                val size = parseOctal(header, 124, 12)
                if (typeFlag == 'L' || typeFlag == 'K') {
                    pendingName = readText(input, size)
                    continue
                }
                if (typeFlag == 'x' || typeFlag == 'g') {
                    skipFully(input, size)
                    continue
                }
                val rawName = pendingName ?: tarName(header)
                pendingName = null
                val name = normalizeEntryName(rawName)
                if (name.isEmpty()) {
                    skipFully(input, size)
                    continue
                }
                // "." 指向目标目录自身：跳过即可，不该算成「越界」。
                if (name == ".") {
                    skipFully(input, size)
                    continue
                }
                if (!isSelected(selected, rawName, name)) {
                    skipFully(input, size)
                    continue
                }
                val target = resolveInside(targetDir, name)
                if (target == null) {
                    outcome.skippedUnsafe += 1
                    skipFully(input, size)
                    continue
                }
                if (typeFlag == '5' || rawName.endsWith("/")) {
                    target.mkdirs()
                    outcome.extracted.add(VfsBridge.toVirtual(context, target.absolutePath))
                    skipFully(input, size)
                    continue
                }
                if (size > MAX_ENTRY_BYTES) {
                    outcome.skippedTooLarge += 1
                    skipFully(input, size)
                    continue
                }
                if (target.exists() && !overwrite) {
                    outcome.skippedExisting += 1
                    skipFully(input, size)
                    continue
                }
                target.parentFile?.mkdirs()
                val ok = copyExactly(input, target, size)
                if (!ok) {
                    outcome.skippedTooLarge += 1
                    continue
                }
                outcome.extracted.add(VfsBridge.toVirtual(context, target.absolutePath))
            }
        }
        return outcome
    }

    /** selectedNames 为空表示全选；命中原始名或规范化名都算选中。 */
    private fun isSelected(selected: List<String>, rawName: String, name: String): Boolean {
        if (selected.isEmpty()) return true
        return selected.contains(rawName) || selected.contains(name)
    }

    // ------------------------------------------------------------------
    // 入口：archiveCreate
    // ------------------------------------------------------------------

    /**
     * 打包。
     *
     * args: `{targetPath, sourcePaths[], format}`
     * 返回: `{ok, path, count}`。
     *
     * `targetPath` 已存在 → conflict（不静默覆盖用户的旧包）。
     * 目录递归打包，条目名是相对路径（目录自身作为一级条目）。
     */
    fun create(context: Context, call: MethodCall): Map<String, Any> {
        val targetV = VfsBridge.requirePath(call, "targetPath")
        val sources = call.argument<List<String>>("sourcePaths") ?: emptyList()
        val format = (call.argument<String>("format") ?: FORMAT_ZIP).lowercase()
        if (format != FORMAT_ZIP && format != FORMAT_TAR_GZ) {
            throw VfsError(
                VfsBridge.ERR_INVALID_PATH,
                "不支持的归档格式：$format（只支持 zip 与 tar.gz）",
            )
        }
        if (sources.isEmpty()) {
            throw VfsError(VfsBridge.ERR_INVALID_PATH, "sourcePaths 不能为空")
        }
        val targetReal = VfsBridge.toReal(context, targetV)
        VfsBridge.requireStoragePermission(context, targetReal)
        // 同上：按 shell 档保留「系统分区只读」这道判定（原先复刻的护栏无条件挡）。
        VfsBridge.guardDestructive(context, targetV, targetReal, VfsBridge.VIA_SHELL)

        val target = File(targetReal)
        if (target.exists()) {
            throw VfsError(VfsBridge.ERR_CONFLICT, "目标已存在：$targetV")
        }

        // 源先全部校验：源不存在就不该留下一个半截的包。
        val realSources = ArrayList<File>()
        for (v in sources) {
            val real = VfsBridge.toReal(context, v)
            VfsBridge.requireStoragePermission(context, real)
            val file = File(real)
            if (!file.exists()) throw VfsError(VfsBridge.ERR_NOT_FOUND, "源不存在：$v")
            realSources.add(file)
        }

        target.parentFile?.mkdirs()
        val count = try {
            when (format) {
                FORMAT_ZIP -> createZip(target, realSources)
                else -> createTarGz(target, realSources)
            }
        } catch (e: IOException) {
            // 写失败时把半截的包删掉：留一个坏文件比没有文件更难解释。
            target.delete()
            throw VfsError(VfsBridge.ERR_UNKNOWN, "写入归档失败：${target.name}")
        }
        return mapOf(
            "ok" to true,
            "path" to VfsBridge.toVirtual(context, target.absolutePath),
            "count" to count,
        )
    }

    /** 写 ZIP 包。目录递归，条目名用 "/" 分隔。 */
    private fun createZip(target: File, sources: List<File>): Int {
        var count = 0
        ZipOutputStream(BufferedOutputStream(FileOutputStream(target))).use { zos ->
            for (source in sources) {
                if (source.isDirectory) {
                    count += addZipDirectory(zos, source, source.name)
                } else {
                    zos.putNextEntry(zipEntry(source.name, source.lastModified(), isDirectory = false))
                    source.inputStream().use { input ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            zos.write(buffer, 0, n)
                        }
                    }
                    zos.closeEntry()
                    count += 1
                }
            }
        }
        return count
    }

    /** 把一个目录递归写进 ZIP。 */
    private fun addZipDirectory(zos: ZipOutputStream, dir: File, prefix: String): Int {
        var count = 0
        zos.putNextEntry(zipEntry("$prefix/", dir.lastModified(), isDirectory = true))
        zos.closeEntry()
        count += 1
        val kids = dir.listFiles() ?: return count
        for (kid in kids) {
            if (kid.isDirectory) {
                count += addZipDirectory(zos, kid, "$prefix/${kid.name}")
            } else {
                zos.putNextEntry(zipEntry("$prefix/${kid.name}", kid.lastModified(), isDirectory = false))
                kid.inputStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        zos.write(buffer, 0, n)
                    }
                }
                zos.closeEntry()
                count += 1
            }
        }
        return count
    }

    private fun zipEntry(name: String, timeMs: Long, isDirectory: Boolean): ZipEntry {
        // 目录条目用名字尾部的 "/" 标记：java.util.zip 没有目录标志位，
        // 这是 ZIP 格式本身的约定（Info-ZIP 起的通用做法）。
        val entry = ZipEntry(if (isDirectory && !name.endsWith("/")) "$name/" else name)
        if (timeMs > 0L) entry.time = timeMs
        return entry
    }

    /** 写 TAR.GZ 包。tar 头是手写的 512 字节块。 */
    private fun createTarGz(target: File, sources: List<File>): Int {
        var count = 0
        GZIPOutputStream(BufferedOutputStream(FileOutputStream(target))).use { gz ->
            for (source in sources) {
                if (source.isDirectory) {
                    count += addTarDirectory(gz, source, source.name)
                } else {
                    addTarFile(gz, source, source.name)
                    count += 1
                }
            }
            // 归档以两个空块结束。缺了它们，某些 tar 实现会报「意外 EOF」。
            gz.write(ByteArray(TAR_BLOCK * 2))
        }
        return count
    }

    private fun addTarDirectory(out: OutputStream, dir: File, prefix: String): Int {
        var count = 0
        writeTarEntry(out, "$prefix/", mode = 0x1ED, size = 0L, mtimeSec = dir.lastModified() / 1000L, typeFlag = '5')
        count += 1
        val kids = dir.listFiles() ?: return count
        for (kid in kids) {
            if (kid.isDirectory) {
                count += addTarDirectory(out, kid, "$prefix/${kid.name}")
            } else {
                addTarFile(out, kid, "$prefix/${kid.name}")
                count += 1
            }
        }
        return count
    }

    /** 写一个文件条目：头 + 数据 + 512 对齐填充。 */
    private fun addTarFile(out: OutputStream, file: File, name: String) {
        val size = file.length()
        writeTarEntry(out, name, mode = 0x1A4, size = size, mtimeSec = file.lastModified() / 1000L, typeFlag = '0')
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            var remaining = size
            while (remaining > 0) {
                val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                if (n < 0) break
                out.write(buffer, 0, n)
                remaining -= n
            }
            // 补齐到 512 的整数倍（按原始 size 算，不是按剩余量）。
            val pad = paddingOf(size)
            if (pad > 0) out.write(ByteArray(pad))
        }
    }

    /**
     * 写一个 tar 头块。
     *
     * 字段布局（512 字节）：
     *   0..100 name / 100..108 mode / 108..116 uid / 116..124 gid /
     *   124..136 size / 136..148 mtime / 148..156 chksum / 156 typeflag /
     *   157..257 linkname / 257..263 magic / 263..265 version /
     *   329..337 devmajor / 337..345 devminor / 345..500 prefix。
     *
     * 名字超过 100 字节时，先写一条 GNU 的 'L' 长名字记录（内容是完整名字），
     * 再写真正的头——这是 GNU tar 的标准做法，兼容性好。
     */
    private fun writeTarEntry(
        out: OutputStream,
        name: String,
        mode: Int,
        size: Long,
        mtimeSec: Long,
        typeFlag: Char,
    ) {
        val nameBytes = name.toByteArray(StandardCharsets.UTF_8)
        if (nameBytes.size > 100) {
            val longName = nameBytes + 0.toByte()
            writeTarBlock(out, tarHeaderBytes("././@LongLink", 0x1A4, longName.size.toLong(), 0L, 'L'))
            out.write(longName)
            val pad = paddingOf(longName.size.toLong())
            if (pad > 0) out.write(ByteArray(pad))
        }
        val shortName = if (nameBytes.size > 100) {
            String(nameBytes.copyOfRange(0, 100), StandardCharsets.UTF_8)
        } else {
            name
        }
        writeTarBlock(out, tarHeaderBytes(shortName, mode, size, mtimeSec, typeFlag))
    }

    /** 组装 512 字节的 tar 头。 */
    private fun tarHeaderBytes(
        name: String,
        mode: Int,
        size: Long,
        mtimeSec: Long,
        typeFlag: Char,
    ): ByteArray {
        val block = ByteArray(TAR_BLOCK)
        writeAscii(block, 0, 100, name)
        writeOctal(block, 100, 8, mode.toLong())
        writeOctal(block, 108, 8, 0L)
        writeOctal(block, 116, 8, 0L)
        writeOctal(block, 124, 12, size)
        writeOctal(block, 136, 12, mtimeSec)
        // 校验和字段在计算时必须当成 8 个空格。
        for (i in 148 until 156) block[i] = ' '.code.toByte()
        block[156] = typeFlag.code.toByte()
        writeAscii(block, TAR_MAGIC_OFFSET, 6, "ustar")
        block[263] = '0'.code.toByte()
        block[264] = '0'.code.toByte()
        writeOctal(block, 329, 8, 0L)
        writeOctal(block, 337, 8, 0L)
        // prefix 留空（长名字走 'L' 扩展，不走 ustar 的 prefix 拆分）。
        var sum = 0L
        for (b in block) sum += (b.toInt() and 0xFF)
        val digits = String.format(java.util.Locale.US, "%06o", sum).toByteArray(StandardCharsets.US_ASCII)
        System.arraycopy(digits, 0, block, 148, minOf(6, digits.size))
        block[154] = 0
        block[155] = ' '.code.toByte()
        return block
    }

    private fun writeTarBlock(out: OutputStream, block: ByteArray) {
        out.write(block)
    }

    /** 写 ASCII 字符串到块的指定区，NUL 补齐，超长截断。 */
    private fun writeAscii(block: ByteArray, offset: Int, length: Int, text: String) {
        val bytes = text.toByteArray(StandardCharsets.UTF_8)
        val n = minOf(bytes.size, length)
        System.arraycopy(bytes, 0, block, offset, n)
    }

    /** 写八进制数字字段：零填充到 length-1 位 + NUL。 */
    private fun writeOctal(block: ByteArray, offset: Int, length: Int, value: Long) {
        val text = String.format(java.util.Locale.US, "%0" + (length - 1) + "o", value)
        val bytes = text.toByteArray(StandardCharsets.US_ASCII)
        val n = minOf(bytes.size, length - 1)
        System.arraycopy(bytes, 0, block, offset, n)
        block[offset + n] = 0
    }

    // ------------------------------------------------------------------
    // tar 读取原语
    // ------------------------------------------------------------------

    /** 读一个 512 字节头块；到 EOF 返回 null，半块则判定为损坏。 */
    private fun readBlock(input: InputStream): ByteArray? {
        val block = ByteArray(TAR_BLOCK)
        var read = 0
        while (read < TAR_BLOCK) {
            val n = input.read(block, read, TAR_BLOCK - read)
            if (n < 0) {
                if (read == 0) return null
                throw VfsError(VfsBridge.ERR_UNKNOWN, "归档已损坏：tar 块不完整")
            }
            read += n
        }
        return block
    }

    /** 全零块 = 归档结束。 */
    private fun isZeroBlock(block: ByteArray): Boolean {
        for (b in block) {
            if (b.toInt() != 0) return false
        }
        return true
    }

    /** 条目名：ustar 的 prefix + name。 */
    private fun tarName(header: ByteArray): String {
        val name = parseString(header, 0, 100)
        val prefix = parseString(header, TAR_PREFIX_OFFSET, 155)
        return if (prefix.isEmpty()) name else "$prefix/$name"
    }

    /** 条目权限 → `rwxr-xr-x` 形式。tar 头里的 mode 只含权限位，类型位由 typeflag 决定。 */
    private fun tarMode(header: ByteArray, typeFlag: Char): String {
        val perms = parseOctal(header, 100, 8).toInt() and 0xFFF
        val typeBits = when (typeFlag) {
            '5' -> 0x4000
            '2' -> 0xA000
            else -> 0x8000
        }
        return VfsBridge.modeString(perms or typeBits)
    }

    /** 解析 NUL 结尾的字符串字段。 */
    private fun parseString(block: ByteArray, offset: Int, length: Int): String {
        var end = offset
        val limit = offset + length
        while (end < limit && block[end].toInt() != 0) end++
        return String(block, offset, end - offset, StandardCharsets.UTF_8)
    }

    /**
     * 解析八进制数字字段。
     *
     * 兼容 GNU 的 base-256 编码：高位 bit 置 1 时整个字段是大端二进制数，
     * 用于超过 8GB 的 size。
     */
    private fun parseOctal(block: ByteArray, offset: Int, length: Int): Long {
        if (length <= 0) return 0L
        if ((block[offset].toInt() and 0x80) != 0) {
            var value = block[offset].toLong() and 0x7FL
            for (i in 1 until length) {
                value = (value shl 8) or (block[offset + i].toLong() and 0xFF)
            }
            return value
        }
        var value = 0L
        var started = false
        for (i in 0 until length) {
            val b = block[offset + i].toInt()
            if (b == 0 || b == ' '.code) {
                if (started) break
                continue
            }
            if (b < '0'.code || b > '7'.code) break
            started = true
            value = value * 8 + (b - '0'.code)
        }
        return value
    }

    /** 读 n 字节文本（GNU 长名记录的内容），并跳过 512 对齐填充。 */
    private fun readText(input: InputStream, size: Long): String {
        if (size <= 0L) return ""
        // 长名记录不会有很长，但归档里的 size 字段是**作者写的**，不能信。
        // 不设上限的话，一个声明 size=2GB 的坏包能让这里直接 OOM。
        if (size > MAX_LONG_NAME_BYTES) {
            throw VfsError(VfsBridge.ERR_UNKNOWN, "归档已损坏：长文件名长度异常")
        }
        val bytes = ByteArray(size.toInt())
        var read = 0
        while (read < bytes.size) {
            val n = input.read(bytes, read, bytes.size - read)
            if (n < 0) break
            read += n
        }
        val text = String(bytes, 0, read, StandardCharsets.UTF_8).trimEnd(' ', '\u0000')
        skipPadding(input, size)
        return text
    }

    /** 跳过 n 字节的数据 + 512 对齐填充。 */
    private fun skipFully(input: InputStream, size: Long) {
        if (size <= 0L) return
        var remaining = size
        val scratch = ByteArray(64 * 1024)
        while (remaining > 0) {
            val n = input.read(scratch, 0, minOf(scratch.size.toLong(), remaining).toInt())
            if (n < 0) break
            remaining -= n
        }
        skipPadding(input, size)
    }

    /** 跳过 512 对齐填充。 */
    private fun skipPadding(input: InputStream, size: Long) {
        val pad = paddingOf(size)
        if (pad <= 0) return
        var remaining = pad
        val scratch = ByteArray(pad)
        while (remaining > 0) {
            val n = input.read(scratch, 0, remaining)
            if (n < 0) break
            remaining -= n
        }
    }

    /** 512 对齐需要补的字节数。 */
    private fun paddingOf(size: Long): Int {
        val rest = size % TAR_BLOCK
        return if (rest == 0L) 0 else (TAR_BLOCK - rest).toInt()
    }

    // ------------------------------------------------------------------
    // 写入原语
    // ------------------------------------------------------------------

    /**
     * 流式拷贝一个条目，带解压大小上限。
     *
     * @return false 表示超过上限（半截文件已删除）。
     */
    private fun copyBounded(input: InputStream, target: File): Boolean {
        var total = 0L
        var overflow = false
        val buffer = ByteArray(64 * 1024)
        target.outputStream().use { out ->
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                total += n
                if (total > MAX_ENTRY_BYTES) {
                    overflow = true
                    break
                }
                out.write(buffer, 0, n)
            }
        }
        if (overflow) {
            target.delete()
            return false
        }
        return true
    }

    /** 从 tar 流里精确读出 size 字节并落盘，随后跳过对齐填充。 */
    private fun copyExactly(input: InputStream, target: File, size: Long): Boolean {
        var remaining = size
        val buffer = ByteArray(64 * 1024)
        target.outputStream().use { out ->
            while (remaining > 0) {
                val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                if (n < 0) break
                out.write(buffer, 0, n)
                remaining -= n
            }
        }
        if (remaining > 0) {
            // 归档被截断：留下半截文件比什么都不写更糟。
            target.delete()
            return false
        }
        skipPadding(input, size)
        return true
    }

    // ------------------------------------------------------------------
    // 路径与条目名
    // ------------------------------------------------------------------

    /**
     * 把归档内的条目名解析到 targetDir 之内。
     *
     * **Zip Slip 防护**：归档里的条目名完全由归档作者控制，`../../etc/passwd`
     * 这种名字如果直接拼到 targetDir 后面就能写到目标目录之外。所以这里用
     * canonicalPath 规范化后**再**判断是否仍在 targetDir 之下——规范化会把
     * `..` 折叠掉，逃逸的路径规范化后就不在根目录下了，于是被拒。
     *
     * @return 目标文件；null 表示越界（应当跳过）。
     */
    private fun resolveInside(targetDir: File, entryName: String): File? {
        val root = try {
            targetDir.canonicalFile
        } catch (e: Throwable) {
            targetDir.absoluteFile
        }
        val candidate = try {
            File(root, entryName).canonicalFile
        } catch (e: Throwable) {
            File(root, entryName).absoluteFile
        }
        val rootPath = root.path
        val path = candidate.path
        if (path == rootPath) return null
        if (!path.startsWith(rootPath + File.separator)) return null
        return candidate
    }

    /** 规范化条目名：去掉结尾的 "/" 与开头的 "./"。 */
    private fun normalizeEntryName(name: String): String {
        var out = name.replace('\\', '/')
        while (out.startsWith("./")) out = out.substring(2)
        while (out.endsWith("/")) out = out.dropLast(1)
        return out
    }
}