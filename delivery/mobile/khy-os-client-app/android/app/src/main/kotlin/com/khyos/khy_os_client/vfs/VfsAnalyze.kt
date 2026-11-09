package com.khyos.khy_os_client.vfs

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import io.flutter.plugin.common.MethodCall
import java.io.File

/**
 * 存储占用分析：扫一棵目录树，回答「空间去哪了」。
 *
 * 三个刻意的取舍：
 *
 * 1. **只读、只统计，不删不改。** 分析是给用户做决定用的，替用户删东西不在
 *    这个能力的职责里，也不该由它替用户做决定。
 *
 * 2. **有上限，且上限会说出来。** 深度上限（[MAX_DEPTH_HARD]）与条目上限
 *    （[MAX_ENTRIES]）都不是「保护自己」的小事：扫一个几万文件的目录会让
 *    界面长时间转圈，用户无法区分「正在扫」与「卡死了」。所以触顶时结果里
 *    会带一句「已截断」——宁可给一份不完整但**说清楚不完整**的数据，
 *    也不给一份看起来完整的错数据。
 *
 * 3. **符号链接不下钻。** 链接指向的目录可能构成环（a → b → a），
 *    下钻就是无限递归；而且链接指向的目标往往在别的目录里，算进来会
 *    重复统计同一份字节。链接本身按自己的大小计入。
 *
 * 全部 IO 都在 [VfsBridge] 的 IO 线程池上跑（handle() 就在那儿被调用），
 * 本类不自己起线程。
 */
object VfsAnalyze {

    /** maxDepth 缺省值。 */
    private const val MAX_DEPTH_DEFAULT = 6

    /** maxDepth 硬上限。超过就按这个值截断。 */
    private const val MAX_DEPTH_HARD = 12

    /** 一次扫描最多访问的条目数。 */
    private const val MAX_ENTRIES = 20_000

    /** byFolder 与 largest 各自的条数上限。 */
    private const val MAX_ROWS = 20

    /** 类型分类的中文名。与 Dart 侧的展示分类一一对应。 */
    private const val TYPE_IMAGE = "图片"
    private const val TYPE_VIDEO = "视频"
    private const val TYPE_AUDIO = "音频"
    private const val TYPE_DOC = "文档"
    private const val TYPE_ARCHIVE = "压缩包"
    private const val TYPE_INSTALLER = "安装包"
    private const val TYPE_CODE = "代码"
    private const val TYPE_OTHER = "其它"

    /**
     * 分析入口。
     *
     * args: `{path, maxDepth}`
     * 返回: `{ok, totalBytes, fileCount, dirCount, byType[], byFolder[], largest[], byMonth[]}`。
     */
    fun analyze(context: Context, call: MethodCall): Map<String, Any> {
        val vpath = VfsBridge.requirePath(call, "path")
        val maxDepth = clampDepth(call.argument<Int>("maxDepth"))
        val real = VfsBridge.toReal(context, vpath)
        VfsBridge.requireStoragePermission(context, real)

        val root = File(real)
        if (!root.exists()) throw VfsError(VfsBridge.ERR_NOT_FOUND, "路径不存在：$vpath")
        if (!root.isDirectory) {
            // 单文件也给出结果：用户点开一个 4GB 的视频问「占多大」，
            // 得到的应该是答案而不是一句「这是目录」。
            return analyzeSingleFile(context, root)
        }

        val state = ScanState()
        scanDirectory(context, root, 0, maxDepth, null, state)

        val typeRows = state.byType.entries
            .map { (type, acc) ->
                mapOf(
                    "type" to type,
                    "bytes" to acc.bytes,
                    "count" to acc.count,
                )
            }
            .sortedWith(compareByDescending<Map<String, Any>> { it["bytes"] as Long }
                .thenBy { it["type"] as String })

        val folderRows = state.byFolder.entries
            .map { (_, acc) ->
                mapOf(
                    "path" to VfsBridge.toVirtual(context, acc.realPath),
                    "bytes" to acc.bytes,
                )
            }
            .sortedWith(compareByDescending<Map<String, Any>> { it["bytes"] as Long }
                .thenBy { it["path"] as String })
            .take(MAX_ROWS)

        val largestRows = state.largest
            .sortedWith(compareByDescending<FolderBytes> { it.bytes }.thenBy { it.realPath })
            .take(MAX_ROWS)
            .map {
                mapOf(
                    "path" to VfsBridge.toVirtual(context, it.realPath),
                    "bytes" to it.bytes,
                )
            }

        val monthRows = state.byMonth.entries
            .map { (month, bytes) ->
                mapOf(
                    "month" to month,
                    "bytes" to bytes,
                )
            }
            .sortedBy { it["month"] as String }

        val message = if (state.truncated) {
            "扫描条目已达上限 ${state.visited}，结果已截断"
        } else {
            ""
        }

        return mapOf(
            "ok" to true,
            "totalBytes" to state.totalBytes,
            "fileCount" to state.fileCount,
            "dirCount" to state.dirCount,
            "byType" to typeRows,
            "byFolder" to folderRows,
            "largest" to largestRows,
            "byMonth" to monthRows,
            "message" to message,
        )
    }

    /** maxDepth 缺省 6，硬上限 12。 */
    private fun clampDepth(requested: Int?): Int {
        if (requested == null || requested <= 0) return MAX_DEPTH_DEFAULT
        return if (requested > MAX_DEPTH_HARD) MAX_DEPTH_HARD else requested
    }

    /** 单个文件的一行统计。 */
    private fun analyzeSingleFile(context: Context, file: File): Map<String, Any> {
        val size = sizeOf(file)
        val type = typeOf(file.name)
        val month = monthOf(file.lastModified())
        return mapOf(
            "ok" to true,
            "totalBytes" to size,
            "fileCount" to 1,
            "dirCount" to 0,
            "byType" to listOf(
                mapOf(
                    "type" to type,
                    "bytes" to size,
                    "count" to 1,
                )
            ),
            "byFolder" to emptyList<Map<String, Any>>(),
            "largest" to listOf(
                mapOf(
                    "path" to VfsBridge.toVirtual(context, file.absolutePath),
                    "bytes" to size,
                )
            ),
            "byMonth" to listOf(
                mapOf(
                    "month" to month,
                    "bytes" to size,
                )
            ),
            "message" to "",
        )
    }

    /**
     * 扫描状态。整个过程只往这里累加，最后一次性折成返回值。
     */
    private class ScanState {
        /** 累加出来的总字节。 */
        var totalBytes = 0L

        /** 文件数。 */
        var fileCount = 0

        /** 目录数。 */
        var dirCount = 0

        /** 已访问的条目数（用于触顶判断）。 */
        var visited = 0

        /** 是否因为触顶而提前收工。 */
        var truncated = false

        /** 按类型聚合。 */
        val byType = LinkedHashMap<String, TypeAccumulator>()

        /** 按根的**直接子目录**聚合（这是 byFolder 的语义）。 */
        val byFolder = LinkedHashMap<String, FolderAccumulator>()

        /** 最大的若干文件（先攒着，最后统一排序截断）。 */
        val largest = ArrayList<FolderBytes>()

        /** 按 mtime 的 yyyy-MM 聚合。 */
        val byMonth = LinkedHashMap<String, Long>()
    }

    /** 类型聚合器。 */
    private class TypeAccumulator {
        var bytes = 0L
        var count = 0
    }

    /** 直接子目录的聚合器。 */
    private class FolderAccumulator {
        var bytes = 0L
        var realPath = ""
    }

    /** 单个文件的字节与真实路径。 */
    private class FolderBytes(val realPath: String, val bytes: Long)

    /**
     * 递归扫一个目录。
     *
     * @param depth 当前目录的深度（根为 0）。
     * @param bucket 归属的「根的直接子目录」聚合器；null 表示这个目录就是根，
     *               它下面的文件不计入任何 byFolder 条目（byFolder 只列子目录）。
     */
    private fun scanDirectory(
        context: Context,
        dir: File,
        depth: Int,
        maxDepth: Int,
        bucket: FolderAccumulator?,
        state: ScanState,
    ) {
        val children = dir.listFiles()
        if (children == null) {
            // 目录读不到（权限/已消失）：这一支放弃，不让整次扫描失败。
            return
        }
        for (child in children) {
            if (state.visited >= MAX_ENTRIES) {
                state.truncated = true
                return
            }
            state.visited += 1

            val stat = lstatOf(child)
            // 链接不下钻：可能成环，也可能与别处重复统计同一份字节。
            val isLink = stat != null && VfsBridge.isSymlinkMode(stat.st_mode)
            val isDirectory = !isLink && (stat?.let { VfsBridge.isDirectoryMode(it.st_mode) }
                ?: child.isDirectory)
            val size = sizeOf(child, stat)

            state.totalBytes += size
            bucket?.let { it.bytes += size }

            if (isDirectory) {
                state.dirCount += 1
                // 直接子目录自己成为一档；更深的目录并入其祖先档。
                val childBucket = if (depth == 0) {
                    FolderAccumulator().also {
                        it.realPath = child.absolutePath
                        // 目录自身那条目录项的大小算它自己的占用——
                        // 根目录不是 byFolder 的一档，不能只挂在 totalBytes 上。
                        it.bytes += size
                        state.byFolder[child.absolutePath] = it
                    }
                } else {
                    bucket
                }
                // 深度到顶就不再下钻，但这个目录本身的大小已经计入父目录占用。
                if (depth + 1 < maxDepth) {
                    scanDirectory(context, child, depth + 1, maxDepth, childBucket, state)
                }
                continue
            }

            state.fileCount += 1
            val type = typeOf(child.name)
            val acc = state.byType.getOrPut(type) { TypeAccumulator() }
            acc.bytes += size
            acc.count += 1

            state.largest.add(FolderBytes(child.absolutePath, size))

            val month = monthOf(child.lastModified())
            state.byMonth[month] = (state.byMonth[month] ?: 0L) + size
        }
    }

    /**
     * 条目大小。
     *
     * 目录给的是它自己那条目录项的大小（不是内容总大小）——内容总大小要递归
     * 才知道，那正是 byFolder 要干的事，在这里重复算一遍既慢又和 byFolder 口径不一致。
     */
    private fun sizeOf(file: File, stat: android.system.StructStat? = null): Long {
        if (stat != null) return stat.st_size
        return try {
            file.length()
        } catch (e: Throwable) {
            0L
        }
    }

    /** lstat：取链接自身的属性，不跟随链接。 */
    private fun lstatOf(file: File): android.system.StructStat? {
        return try {
            Os.lstat(file.absolutePath)
        } catch (e: ErrnoException) {
            null
        } catch (e: Throwable) {
            null
        }
    }

    // ------------------------------------------------------------------
    // 分类
    // ------------------------------------------------------------------

    /**
     * 按扩展名归类。
     *
     * 没有扩展名的文件归「其它」而不是「文档」：一个叫 `README` 的文件和一个
     * 叫 `notes.txt` 的文件，性质并不相同，把前者算作文档会虚增文档占比。
     */
    fun typeOf(name: String): String {
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return TYPE_OTHER
        val ext = name.substring(dot + 1).lowercase()
        return TYPE_BY_EXT[ext] ?: TYPE_OTHER
    }

    private val TYPE_BY_EXT = mapOf(
        // 图片
        "jpg" to TYPE_IMAGE,
        "jpeg" to TYPE_IMAGE,
        "png" to TYPE_IMAGE,
        "gif" to TYPE_IMAGE,
        "webp" to TYPE_IMAGE,
        "bmp" to TYPE_IMAGE,
        "svg" to TYPE_IMAGE,
        "heic" to TYPE_IMAGE,
        "heif" to TYPE_IMAGE,
        "ico" to TYPE_IMAGE,
        // 视频
        "mp4" to TYPE_VIDEO,
        "mkv" to TYPE_VIDEO,
        "mov" to TYPE_VIDEO,
        "webm" to TYPE_VIDEO,
        "avi" to TYPE_VIDEO,
        "flv" to TYPE_VIDEO,
        "wmv" to TYPE_VIDEO,
        "m4v" to TYPE_VIDEO,
        "3gp" to TYPE_VIDEO,
        // 音频
        "mp3" to TYPE_AUDIO,
        "wav" to TYPE_AUDIO,
        "ogg" to TYPE_AUDIO,
        "oga" to TYPE_AUDIO,
        "flac" to TYPE_AUDIO,
        "m4a" to TYPE_AUDIO,
        "aac" to TYPE_AUDIO,
        "amr" to TYPE_AUDIO,
        "wma" to TYPE_AUDIO,
        "opus" to TYPE_AUDIO,
        // 文档
        "pdf" to TYPE_DOC,
        "txt" to TYPE_DOC,
        "md" to TYPE_DOC,
        "markdown" to TYPE_DOC,
        "csv" to TYPE_DOC,
        "rtf" to TYPE_DOC,
        "doc" to TYPE_DOC,
        "docx" to TYPE_DOC,
        "xls" to TYPE_DOC,
        "xlsx" to TYPE_DOC,
        "ppt" to TYPE_DOC,
        "pptx" to TYPE_DOC,
        "odt" to TYPE_DOC,
        "ods" to TYPE_DOC,
        "epub" to TYPE_DOC,
        // 压缩包
        "zip" to TYPE_ARCHIVE,
        "tar" to TYPE_ARCHIVE,
        "gz" to TYPE_ARCHIVE,
        "tgz" to TYPE_ARCHIVE,
        "bz2" to TYPE_ARCHIVE,
        "xz" to TYPE_ARCHIVE,
        "7z" to TYPE_ARCHIVE,
        "rar" to TYPE_ARCHIVE,
        "jar" to TYPE_ARCHIVE,
        // 安装包
        "apk" to TYPE_INSTALLER,
        "apkm" to TYPE_INSTALLER,
        "aab" to TYPE_INSTALLER,
        "ipa" to TYPE_INSTALLER,
        "dmg" to TYPE_INSTALLER,
        "deb" to TYPE_INSTALLER,
        "rpm" to TYPE_INSTALLER,
        "exe" to TYPE_INSTALLER,
        "msi" to TYPE_INSTALLER,
        "pkg" to TYPE_INSTALLER,
        // 代码
        "kt" to TYPE_CODE,
        "kts" to TYPE_CODE,
        "java" to TYPE_CODE,
        "js" to TYPE_CODE,
        "mjs" to TYPE_CODE,
        "cjs" to TYPE_CODE,
        "ts" to TYPE_CODE,
        "tsx" to TYPE_CODE,
        "jsx" to TYPE_CODE,
        "py" to TYPE_CODE,
        "dart" to TYPE_CODE,
        "c" to TYPE_CODE,
        "cpp" to TYPE_CODE,
        "cc" to TYPE_CODE,
        "h" to TYPE_CODE,
        "hpp" to TYPE_CODE,
        "go" to TYPE_CODE,
        "rs" to TYPE_CODE,
        "rb" to TYPE_CODE,
        "php" to TYPE_CODE,
        "swift" to TYPE_CODE,
        "sh" to TYPE_CODE,
        "bash" to TYPE_CODE,
        "sql" to TYPE_CODE,
        "html" to TYPE_CODE,
        "htm" to TYPE_CODE,
        "css" to TYPE_CODE,
        "scss" to TYPE_CODE,
        "json" to TYPE_CODE,
        "yaml" to TYPE_CODE,
        "yml" to TYPE_CODE,
        "xml" to TYPE_CODE,
        "toml" to TYPE_CODE,
        "gradle" to TYPE_CODE,
        "properties" to TYPE_CODE,
    )

    /**
     * mtime → `yyyy-MM`。
     *
     * 手写格式化而不引入 SimpleDateFormat：SimpleDateFormat 不是线程安全的，
     * 而这里跑在池化的 IO 线程上；而且用 `Locale.US` 才不会被设备 locale
     * 影响出别的历法（有些 locale 的默认历法不是 ISO）。
     */
    private fun monthOf(mtimeMs: Long): String {
        if (mtimeMs <= 0L) return "未知"
        val cal = java.util.Calendar.getInstance()
        cal.timeInMillis = mtimeMs
        val year = cal.get(java.util.Calendar.YEAR)
        val month = cal.get(java.util.Calendar.MONTH) + 1
        return String.format(java.util.Locale.US, "%04d-%02d", year, month)
    }
}
