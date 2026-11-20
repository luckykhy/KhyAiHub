package com.khyos.khy_os_client.vfs

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
 * 归档内核：ZIP 与 TAR.GZ 的创建与提取、格式识别、条目名与落点的安全判据
 * （**纯 JVM，无 Android 依赖**）。
 *
 * ## 为什么要抽出来
 *
 * 目标 §二 明写「原生支持 ZIP/RAR/7Z/TAR.GZ 等格式的浏览、提取、创建、加密」。此前
 * 这些能力**一行测试都没有**——代码住在 [VfsArchive] 里，而那个文件的入口挂着
 * `Context` 与 `MethodCall`（路径映射、权限、通道回执全在里面），JVM 单测拖不动；
 * 真机能验，但真机随时被锁屏打断。
 *
 * 抽出来之后，「创建一个 ZIP 再用生产代码解回来，内容逐字节相同」这种**往返**可以在
 * JVM 上验——那是用户真正在做的事，也是唯一能证伪「ZIP 写得对不对」的方式。
 *
 * ## 边界（哪些搬过来了，哪些没搬）
 *
 * 搬过来的是**格式内核**：ZIP 与 tar 的写与读、格式识别、条目预览、条目名归一、
 * 落点是否越界、单条目与整包两道闸。没搬的是**通道层**：虚拟路径映射、权限检查、
 * 结果回执——那些属于 [VfsArchive] 与 [VfsBridge]。
 *
 * ## 为什么连 MIME 与权限位格式化也搬了
 *
 * 因为 [VfsBridge] 是 `object`：它的静态初始化里有 `Handler(Looper.getMainLooper())`
 * 与线程池，**访问任何一个成员都会先跑整个 `<clinit>`**。本文件要用 MIME 与权限位，
 * 若直接调 `VfsBridge.mimeOf(...)`，纯 JVM 单测会撞上 Android stub 抛
 * `not mocked`——于是「tar 头解析对不对」只能靠真机验。两者的格式化搬进
 * [FileMeta]（纯 JVM）后，判据与格式化都在 JVM 上钉得住，而真源仍是一份
 * （[VfsBridge] 侧保留一行委托）。
 *
 * 本文件里 `extracted` 记的是**真实路径**（不是虚拟路径）：虚拟路径要按容器映射，
 * 那是通道层的事。调用方拿到真实路径后再统一映射一次——比在解包循环里每个条目映射
 * 一次更省，也少一处「有的条目记虚拟路径、有的记真实路径」的不一致。
 */
internal object ArchiveCore {

    /**
     * 单条目上限。
     *
     * 逐条目设上限比只设总量上限更准——总量上限会把「一个大视频 + 许多小文件」
     * 这种正常包也拦掉。
     */
    const val MAX_ENTRY_BYTES = 512L * 1024L * 1024L

    /**
     * ZIP 格式标识。
     *
     * 真源放在这里（纯 JVM 的格式内核）而不是 [VfsArchive]：格式识别与格式
     * 常量是一回事，分开放就会出现「识别认得、比对认不得」的漂移。
     */
    const val FORMAT_ZIP = "zip"

    /** TAR.GZ 格式标识。真源见 [FORMAT_ZIP] 的说明。 */
    const val FORMAT_TAR_GZ = "tar.gz"

    /** 解包过程中累计的结果与跳过计数。 */
    class ExtractOutcome {
        /** 已落盘条目的**真实路径**（虚拟路径由调用方映射）。 */
        val extracted = ArrayList<String>()

        /** 因目标已存在而跳过。 */
        var skippedExisting = 0

        /** 因路径越界（Zip Slip）而跳过。 */
        var skippedUnsafe = 0

        /** 因超过单条目上限而跳过。 */
        var skippedTooLarge = 0

        /**
         * 因数据被截断（归档损坏）而跳过。
         *
         * 与 [skippedTooLarge] 分开记：那是「这条太大，正常跳过」，
         * 这是「包坏了」。后者得让用户知道「重下这个包」，
         * 前者只需要知道「有条没解出来」。
         */
        var skippedDamaged = 0

        /**
         * 是否因为条目数超过上限而提前停了。
         *
         * 与 [skippedTooLarge] 分开：那是「这一条太大」，这是「这个包太多条」。
         */
        var stoppedByEntryBudget = false

        /**
         * 是否因为整包解压总量超过上限而提前停了。
         *
         * 这是最要紧的一种停：包里每一条单独看都合规，是**加起来**把磁盘写满。
         */
        var stoppedByTotalBytes = false
    }

    /**
     * 写 ZIP 包。目录递归，条目名用 "/" 分隔。返回写入的条目数。
     */
    fun createZip(target: File, sources: List<File>): Int {
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

    /**
     * 解一个 ZIP 包到 targetDir。
     *
     * 跳过而不是整体失败：
     *  - 目标已存在且 overwrite=false → 跳过该条目；
     *  - 条目名逃出 targetDir（Zip Slip）→ 跳过该条目；
     *  - 条目解压后超过 [MAX_ENTRY_BYTES] → 跳过该条目；
     *  - 包内条目数或整包解压量超上限 → **停下**，并如实记下是哪一种。
     */
    fun extractZip(
        file: File,
        targetDir: File,
        selected: List<String>,
        overwrite: Boolean,
    ): ExtractOutcome {
        val outcome = ExtractOutcome()
        val budget = ArchiveExtractBudget.Tracker()
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
                // 条目数闸只统计**真正要写的**条目：没选中的条目不写盘，
                // 不该消耗额度——否则用户在一个大包里只选 1 个文件，也会被
                // 「包里条目多」为由提前停掉，那是可用性回归而不是防护。
                if (!budget.acceptEntry()) {
                    outcome.stoppedByEntryBudget = true
                    break
                }
                val target = resolveInside(targetDir, name)
                if (target == null) {
                    outcome.skippedUnsafe += 1
                    continue
                }
                if (entry.isDirectory || rawName.endsWith("/")) {
                    target.mkdirs()
                    outcome.extracted.add(target.absolutePath)
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
                val result = try {
                    zip.getInputStream(entry).use { input ->
                        copyBounded(input, target, budget)
                    }
                } catch (e: SecurityException) {
                    throw VfsError(VfsBridge.ERR_DENIED, "无权限写入：${target.name}")
                } catch (e: IOException) {
                    // 一个条目读不出来（条目本身损坏）：**跳过这一条**，
                    // 不要连累整个包。整体失败会让用户只能从头再来。
                    target.delete()
                    outcome.skippedDamaged += 1
                    continue
                }
                when (result) {
                    CopyOutcome.OK -> Unit
                    CopyOutcome.TOO_LARGE -> {
                        // 到底是「这条太大」还是「这个包总量满了」，两者要分开记：
                        // 前者是这一条的问题，后者是整个包的问题。
                        if (budget.bytesExceeded) {
                            outcome.stoppedByTotalBytes = true
                            break
                        }
                        outcome.skippedTooLarge += 1
                        continue
                    }
                    CopyOutcome.TRUNCATED -> {
                        outcome.skippedDamaged += 1
                        continue
                    }
                }
                outcome.extracted.add(target.absolutePath)
            }
        }
        return outcome
    }

    /**
     * 一次条目拷贝的结果。
     *
     * 为什么不用 Boolean：`false` 同时表示「这条太大」和「这条被截断」，
     * 而这两件事给用户看的说法完全不同——前者是「超过 512MB 上限」，
     * 后者是「归档已损坏」。混在一起报，界面就在说假话。
     */
    enum class CopyOutcome {
        /** 完整写完。 */
        OK,

        /** 触到单条目上限或整包总量上限（主动停）。 */
        TOO_LARGE,

        /** 源数据提前结束——归档被截断。 */
        TRUNCATED,
    }

    /**
     * 带上限地拷贝一个条目。
     *
     * 两道闸：单条目上限（[MAX_ENTRY_BYTES]）与整包总量上限
     * （[ArchiveExtractBudget]）。前者拦「一个条目就是炸弹」，后者拦
     * 「每个条目都合规但加起来把磁盘写满」。
     *
     * 半截文件一律删除：用户会以为解开了。
     */
    fun copyBounded(
        input: InputStream,
        target: File,
        budget: ArchiveExtractBudget.Tracker,
    ): CopyOutcome {
        var total = 0L
        var outcome = CopyOutcome.OK
        val buffer = ByteArray(64 * 1024)
        target.outputStream().use { out ->
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                total += n
                if (total > MAX_ENTRY_BYTES) {
                    outcome = CopyOutcome.TOO_LARGE
                    break
                }
                // 整包总量闸：超了就停在这一条，别把它写完。
                if (!budget.acceptBytes(n.toLong())) {
                    outcome = CopyOutcome.TOO_LARGE
                    break
                }
                out.write(buffer, 0, n)
            }
        }
        if (outcome != CopyOutcome.OK) {
            target.delete()
            return outcome
        }
        return CopyOutcome.OK
    }

    /** selectedNames 为空表示全选；命中原始名或规范化名都算选中。 */
    fun isSelected(selected: List<String>, rawName: String, name: String): Boolean {
        if (selected.isEmpty()) return true
        return selected.contains(rawName) || selected.contains(name)
    }

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
    fun resolveInside(targetDir: File, entryName: String): File? {
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
    fun normalizeEntryName(name: String): String {
        var out = name.replace('\\', '/')
        while (out.startsWith("./")) out = out.substring(2)
        while (out.endsWith("/")) out = out.dropLast(1)
        return out
    }

    /** tar 的块大小。所有头与数据都按 512 字节对齐。 */
    const val TAR_BLOCK = 512

    /** tar 长文件名记录的长度上限。长名记录本来就是短名字，超过就是坏包。 */
    const val MAX_LONG_NAME_BYTES = 64L * 1024L

    /** tar 的魔术字段偏移（"ustar\0"）。 */
    const val TAR_MAGIC_OFFSET = 257

    /** tar 的 ustar 前缀字段偏移（长路径的第二段）。 */
    const val TAR_PREFIX_OFFSET = 345

    // ------------------------------------------------------------------
    // TAR.GZ
    // ------------------------------------------------------------------

    fun extractTarGz(
        file: File,
        targetDir: File,
        selected: List<String>,
        overwrite: Boolean,
    ): ArchiveCore.ExtractOutcome {
        val outcome = ArchiveCore.ExtractOutcome()
        val budget = ArchiveExtractBudget.Tracker()
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
                val name = ArchiveCore.normalizeEntryName(rawName)
                if (name.isEmpty()) {
                    skipFully(input, size)
                    continue
                }
                // "." 指向目标目录自身：跳过即可，不该算成「越界」。
                if (name == ".") {
                    skipFully(input, size)
                    continue
                }
                if (!ArchiveCore.isSelected(selected, rawName, name)) {
                    skipFully(input, size)
                    continue
                }
                // 条目数闸只统计真正要写的条目（理由同 zip 路径）。
                if (!budget.acceptEntry()) {
                    outcome.stoppedByEntryBudget = true
                    break
                }
                val target = ArchiveCore.resolveInside(targetDir, name)
                if (target == null) {
                    outcome.skippedUnsafe += 1
                    skipFully(input, size)
                    continue
                }
                if (typeFlag == '5' || rawName.endsWith("/")) {
                    target.mkdirs()
                    outcome.extracted.add(target.absolutePath)
                    skipFully(input, size)
                    continue
                }
                if (size > ArchiveCore.MAX_ENTRY_BYTES) {
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
                val result = copyExactly(input, target, size, budget)
                when (result) {
                    CopyOutcome.OK -> Unit
                    CopyOutcome.TOO_LARGE -> {
                        if (budget.bytesExceeded) {
                            outcome.stoppedByTotalBytes = true
                            break
                        }
                        outcome.skippedTooLarge += 1
                        continue
                    }
                    CopyOutcome.TRUNCATED -> {
                        // 数据不够 = 归档被截断。这是「包坏了」，不是「这条太大」，
                        // 分开记，否则界面会对着一个坏包说「有条超过 512MB」。
                        outcome.skippedDamaged += 1
                        continue
                    }
                }
                outcome.extracted.add(target.absolutePath)
            }
        }
        return outcome
    }

    /** 写 TAR.GZ 包。tar 头是手写的 512 字节块。 */
    fun createTarGz(target: File, sources: List<File>): Int {
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
        return FileMeta.modeString(perms or typeBits)
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
     * 从 tar 流里精确读出 size 字节并落盘，随后跳过对齐填充。
     *
     * **为什么 size 只是提示、不是上限**：tar 头里的 size 字段是**归档作者
     * 自己写的**，可以随便填。填一个很小的 size、实际塞几百 MB 数据进去，
     * 就会被「读满 size 就当读完」骗过去，后面的数据被当成下一个条目的头
     * 去解析——轻则乱码报错，重则把别的文件内容写进当前文件。
     *
     * 所以这里在**流式读**的同时数着实际写出的字节，超过单条目上限就停：
     * 声明的 size 只用来决定「最多读多少」，实际量出来的才算数。
     */
    private fun copyExactly(
        input: InputStream,
        target: File,
        size: Long,
        budget: ArchiveExtractBudget.Tracker,
    ): CopyOutcome {
        var remaining = size
        var written = 0L
        var outcome = CopyOutcome.OK
        val buffer = ByteArray(64 * 1024)
        target.outputStream().use { out ->
            while (remaining > 0) {
                val want = minOf(buffer.size.toLong(), remaining).toInt()
                val n = input.read(buffer, 0, want)
                if (n < 0) break
                remaining -= n
                written += n
                if (written > ArchiveCore.MAX_ENTRY_BYTES) {
                    outcome = CopyOutcome.TOO_LARGE
                    break
                }
                if (!budget.acceptBytes(n.toLong())) {
                    outcome = CopyOutcome.TOO_LARGE
                    break
                }
                out.write(buffer, 0, n)
            }
        }
        if (outcome != CopyOutcome.OK) {
            // 半截文件比什么都不写更糟：用户会以为解开了。
            target.delete()
            return outcome
        }
        if (remaining > 0) {
            // 归档被截断：数据不够。留下半截文件比什么都不写更糟。
            //
            // 这一条**不是**「太大」——它是被截断了。两者混在一起报，
            // 界面就会对用户说「这条超过 512MB」，而真相是「包坏了」。
            target.delete()
            return CopyOutcome.TRUNCATED
        }
        skipPadding(input, size)
        return CopyOutcome.OK
    }

    /** zip 不携带 unix 权限位，只能给一个约定值。 */
    private const val ZIP_DEFAULT_FILE_MODE = "rw-r--r--"
    private const val ZIP_DEFAULT_DIR_MODE = "rwxr-xr-x"

    // ------------------------------------------------------------------
    // 格式识别与预览
    // ------------------------------------------------------------------

    /**
     * 判定归档格式：ZIP 还是 TAR.GZ。
     *
     * 先看扩展名，再看文件头魔数（`PK` = zip，`1f 8b` = gzip）——
     * 只看扩展名的话，一个被改名为 `.zip` 的 tar 包会被当成 zip 去解，
     * 结果就是「解不出来」这种没法自证的失败。
     *
     * `.rar` / `.7z` **不假装支持**：直接抛 not_found，并把「当前版本只支持
     * ZIP 与 TAR.GZ」写进消息里。假装能读然后在解压到一半时炸掉，比明说不支持
     * 坏得多。
     */
    fun detectFormat(file: File): String {
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
    fun listZip(file: File): List<Map<String, Any>> {
        val entries = ArrayList<Map<String, Any>>()
        ZipFile(file).use { zip ->
            val it = zip.entries()
            while (it.hasMoreElements()) {
                val entry = it.nextElement()
                val isDirectory = entry.isDirectory || entry.name.endsWith("/")
                entries.add(
                    entryMap(
                        name = ArchiveCore.normalizeEntryName(entry.name),
                        isDirectory = isDirectory,
                        size = entry.size.coerceAtLeast(0L),
                        compressedSize = entry.compressedSize.coerceAtLeast(0L),
                        modifiedMs = if (entry.time > 0L) entry.time else 0L,
                        // zip 格式不保存 unix 权限位，给一个约定值而不是编一个假的。
                        mode = if (isDirectory) ZIP_DEFAULT_DIR_MODE else ZIP_DEFAULT_FILE_MODE,
                        mime = FileMeta.mimeOf(entry.name, isDirectory),
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
    fun listTarGz(file: File): List<Map<String, Any>> {
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
                        name = ArchiveCore.normalizeEntryName(name),
                        isDirectory = isDirectory,
                        size = size,
                        compressedSize = 0L,
                        modifiedMs = parseOctal(header, 136, 12) * 1000L,
                        mode = mode,
                        mime = FileMeta.mimeOf(name, isDirectory),
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
}
