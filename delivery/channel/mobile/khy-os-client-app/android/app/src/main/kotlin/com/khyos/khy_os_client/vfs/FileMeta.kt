package com.khyos.khy_os_client.vfs

/**
 * 文件元信息的纯 JVM 格式化（权限位 → `rwxr-xr-x`、扩展名 → MIME）。
 *
 * ## 为什么单独成文件
 *
 * 这两个函数原先住在 [VfsBridge] 里。但 [VfsBridge] 是 `object`——它的静态初始化
 * 里有 `Handler(Looper.getMainLooper())` 与线程池，**任何一个成员被访问都会先跑
 * 整个 `<clinit>`**。于是纯 JVM 单元测试里调一下 `VfsBridge.mimeOf(...)`，
 * 就会撞上 Android stub 抛 `Method getMainLooper in android.os.Looper not mocked`。
 *
 * 这不是「先凑合」，是**测不了就等于没有**：归档内核 [ArchiveCore] 算条目名、
 * 算权限位、算 MIME 都要用这两个函数，一旦它们把 Android 拖进来，
 * 「tar 头解析对不对」「Zip Slip 拦没拦」这类问题就只能靠真机点菜单验——
 * 真机随时被锁屏打断，等于没有验证。
 *
 * 与 [ContainerRuntimeProbe] 同一个道理：判据与格式化搬成纯逻辑，才能在 JVM 上钉住。
 *
 * 真源仍是一份：[VfsBridge] 侧的 `mimeOf` / `modeString` 保留为**一行委托**，
 * 别的调用点（[VfsShell] 等）不用改，行为逐字节不变。
 */
internal object FileMeta {

    /**
     * st_mode → `rwxr-xr-x` 形式。
     *
     * 三组各 rwx，再补 setuid/setgid/sticky 位（s/S/t/T）。拿不到模式时给空串，
     * 而不是编一个假的 rwxr-xr-x 出来——界面上的只读标识是拿这个字段判的。
     */
    fun modeString(mode: Int): String {
        val perm = mode and 0xFFF
        val sb = StringBuilder()
        // owner
        sb.append(if (perm and 0x100 != 0) 'r' else '-')
        sb.append(if (perm and 0x080 != 0) 'w' else '-')
        val ownerExec = perm and 0x040 != 0
        val setuid = mode and 0x800 != 0
        sb.append(
            when {
                setuid && ownerExec -> 's'
                setuid -> 'S'
                ownerExec -> 'x'
                else -> '-'
            }
        )
        // group
        sb.append(if (perm and 0x020 != 0) 'r' else '-')
        sb.append(if (perm and 0x010 != 0) 'w' else '-')
        val groupExec = perm and 0x008 != 0
        val setgid = mode and 0x400 != 0
        sb.append(
            when {
                setgid && groupExec -> 's'
                setgid -> 'S'
                groupExec -> 'x'
                else -> '-'
            }
        )
        // other
        sb.append(if (perm and 0x004 != 0) 'r' else '-')
        sb.append(if (perm and 0x002 != 0) 'w' else '-')
        val otherExec = perm and 0x001 != 0
        val sticky = mode and 0x200 != 0
        sb.append(
            when {
                sticky && otherExec -> 't'
                sticky -> 'T'
                otherExec -> 'x'
                else -> '-'
            }
        )
        return sb.toString()
    }

    /** 按扩展名粗判 MIME。认不出就 octet-stream。 */
    fun mimeOf(name: String, isDirectory: Boolean): String {
        if (isDirectory) return "inode/directory"
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return "application/octet-stream"
        val ext = name.substring(dot + 1).lowercase()
        return MIME_BY_EXT[ext] ?: "application/octet-stream"
    }

    private val MIME_BY_EXT = mapOf(
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "gif" to "image/gif",
        "webp" to "image/webp",
        "bmp" to "image/bmp",
        "svg" to "image/svg+xml",
        "heic" to "image/heic",
        "pdf" to "application/pdf",
        "zip" to "application/zip",
        "gz" to "application/gzip",
        "tar" to "application/x-tar",
        "rar" to "application/vnd.rar",
        "7z" to "application/x-7z-compressed",
        "txt" to "text/plain",
        "log" to "text/plain",
        "md" to "text/markdown",
        "csv" to "text/csv",
        "html" to "text/html",
        "htm" to "text/html",
        "css" to "text/css",
        "js" to "text/javascript",
        "json" to "application/json",
        "xml" to "application/xml",
        "yml" to "application/yaml",
        "yaml" to "application/yaml",
        "mp4" to "video/mp4",
        "mkv" to "video/x-matroska",
        "mov" to "video/quicktime",
        "webm" to "video/webm",
        "avi" to "video/x-msvideo",
        "mp3" to "audio/mpeg",
        "wav" to "audio/wav",
        "ogg" to "audio/ogg",
        "flac" to "audio/flac",
        "m4a" to "audio/mp4",
        "aac" to "audio/aac",
        "apk" to "application/vnd.android.package-archive",
        "doc" to "application/msword",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" to "application/vnd.ms-excel",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" to "application/vnd.ms-powerpoint",
        "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "epub" to "application/epub+zip",
        "sh" to "application/x-sh",
        "so" to "application/octet-stream",
        "db" to "application/vnd.sqlite3",
        "sqlite" to "application/vnd.sqlite3",
    )
}
