package com.khyos.khy_os_client.vfs

import android.content.Context
import io.flutter.plugin.common.MethodCall
import java.io.File
import java.io.IOException

/**
 * 归档（压缩包）能力的**通道层**：列包、解包、打包。
 *
 * **格式边界**：只支持 ZIP 与 TAR.GZ，用的是 JDK 自带的 `java.util.zip`（ZipFile /
 * ZipOutputStream / GZIPInputStream / GZIPOutputStream）加上手写的 tar 头解析。刻意不引
 * 第三方依赖（zip4j / commons-compress）——App 的体积与依赖面是产品决策，不该由一个
 * 「列个包」的功能顺带决定。
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
 *
 * **本文件只管通道**：写包、解包、条目名归一、落点判定（Zip Slip 防护）、格式识别
 * 与条目预览都在 [ArchiveCore]——它们是**纯文件系统逻辑**，与 `Context`、通道、权限
 * 无关，搬出去才能在 JVM 上钉住。留在本文件里的话，「ZIP 写得对不对」「tar 头骗人
 * 怎么办」这两类问题一行测试都写不了，只能靠真机点菜单验。
 */
object VfsArchive {

    /**
     * ZIP 格式标识。
     *
     * 真源在 [ArchiveCore]（纯 JVM 的格式内核）：格式识别与格式常量是一回事，
     * 分开放就会出现「识别认得、比对认不得」的漂移。这里转一道是为了让
     * 通道层对外的常量名不变（[VfsCrypto] 等调用点不用改）。
     */
    const val FORMAT_ZIP: String = ArchiveCore.FORMAT_ZIP

    /** TAR.GZ 格式标识。真源见 [FORMAT_ZIP] 的说明。 */
    const val FORMAT_TAR_GZ: String = ArchiveCore.FORMAT_TAR_GZ

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
        val format = ArchiveCore.detectFormat(file)
        val entries = try {
            when (format) {
                FORMAT_ZIP -> ArchiveCore.listZip(file)
                else -> ArchiveCore.listTarGz(file)
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
        val format = ArchiveCore.detectFormat(file)

        val targetDir = File(targetReal)
        if (!targetDir.exists() && !targetDir.mkdirs()) {
            throw VfsError(VfsBridge.ERR_UNKNOWN, "无法创建目标目录：$targetV")
        }
        if (!targetDir.isDirectory) {
            throw VfsError(VfsBridge.ERR_CONFLICT, "目标已存在且不是目录：$targetV")
        }

        val outcome = try {
            when (format) {
                FORMAT_ZIP -> ArchiveCore.extractZip(file, targetDir, selected, overwrite)
                else -> ArchiveCore.extractTarGz(file, targetDir, selected, overwrite)
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
            parts.add("跳过 ${outcome.skippedTooLarge} 个超过 ${ArchiveCore.MAX_ENTRY_BYTES / 1024 / 1024}MB 的条目")
        }
        if (outcome.skippedDamaged > 0) {
            // 损坏的条目与「太大」的条目要分开说：前者得让用户重下这个包，
            // 后者只需要知道有条没解出来。
            parts.add("跳过 ${outcome.skippedDamaged} 个已损坏的条目（归档数据不完整）")
        }
        if (outcome.stoppedByTotalBytes) {
            parts.add("已停止：整包解压量超过 ${ArchiveExtractBudget.MAX_TOTAL_BYTES / 1024 / 1024 / 1024}GB 上限")
        }
        if (outcome.stoppedByEntryBudget) {
            parts.add("已停止：包内条目数超过 ${ArchiveExtractBudget.MAX_ENTRIES} 上限")
        }
        // 真实路径 → 虚拟路径：容器里的东西要回到 `/khyos/container/...`，
        // 因为 Dart 侧的路由器只认识虚拟路径——给它真实路径会在下一次导航时
        // 被判成「路径不存在」。统一在这里映射一次，而不是在解包循环里
        // 每个条目映射一次（少一处「有的记真实路径、有的记虚拟路径」的不一致）。
        val virtual = outcome.extracted.map { VfsBridge.toVirtual(context, it) }
        return mapOf(
            "ok" to true,
            "extracted" to virtual,
            "count" to virtual.size,
            "message" to parts.joinToString("，"),
        )
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
                FORMAT_ZIP -> ArchiveCore.createZip(target, realSources)
                else -> ArchiveCore.createTarGz(target, realSources)
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

    // ------------------------------------------------------------------
    // 格式内核
    // ------------------------------------------------------------------
    //
    // 写包、解包、条目名归一、落点判定（Zip Slip 防护）、格式识别与条目预览
    // 全在 [ArchiveCore] 里——它们是**纯文件系统逻辑**，与通道无关，搬出去
    // 才能在 JVM 上钉住。留在本文件里的话，「ZIP 写得对不对」「tar 头骗人
    // 怎么办」这两类问题一行测试都写不了，只能靠真机点菜单验。
    //
    // 本文件只剩三个通道入口：list / extract / create。
}
