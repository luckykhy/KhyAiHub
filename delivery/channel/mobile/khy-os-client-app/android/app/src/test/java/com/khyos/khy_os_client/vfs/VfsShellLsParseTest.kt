// khy-canary: Khy-20261118-002-LSZ
package com.khyos.khy_os_client.vfs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * VfsShellLsParseTest — `ls -laZ` 的两种列序都要能解析。
 *
 * WHY THIS TEST EXISTS (measured 2026-11-18, on the real device). The elevated
 * path works — `ls -laZ -- /system` through the sidecar returns 21 lines — but
 * the file manager showed「这个目录是空的」. The parser expected the SELinux
 * column at the END of the line; this device's toybox puts it BEFORE the size:
 *
 *   这台设备：drwxr-xr-x 15 root root  u:object_r:system_file:s0   341 2009-01-01 08:00 .
 *   另一些构建：-rw-r--r-- 1 u0_a123 u0_a123 1234 2026-11-09 10:28 name.txt u:object_r:sdcardfs:s0
 *
 * With the old regex the size group `(\d+)` ran into `u:object_r:…`, the whole
 * line failed to match, and every entry was skipped — so a directory that
 * plainly has content renders as empty. A working elevation that displays
 * nothing is worse than a broken one: it looks like the feature never worked.
 *
 * The samples below are copied from the device's own output, not invented.
 */
class VfsShellLsParseTest {

    @Test
    fun selinuxBeforeSizeIsParsed() {
        // 真机实测：/system 的第 3 行
        val e = VfsShell.parseLsLine(
            "drwxr-xr-x  2 root root  u:object_r:system_file:s0       1419 2009-01-01 08:00 apex"
        )
        requireNotNull(e)
        assertEquals("apex", e!!.name)
        assertTrue("应当是目录", e.isDirectory)
        assertEquals(1419L, e.size)
        assertEquals("root", e.owner)
        assertEquals("root", e.group)
        assertEquals("u:object_r:system_file:s0", e.selinux)
        assertEquals("drwxr-xr-x", e.mode)
    }

    @Test
    fun selinuxAtLineEndIsParsed() {
        // 另一种 toybox 的列序（原实现只认这一种）
        val e = VfsShell.parseLsLine(
            "-rw-r--r-- 1 u0_a123 u0_a123 1234 2026-11-09 10:28 name.txt u:object_r:sdcardfs:s0"
        )
        requireNotNull(e)
        assertEquals("name.txt", e!!.name)
        assertEquals(1234L, e.size)
        assertEquals("u:object_r:sdcardfs:s0", e.selinux)
    }

    @Test
    fun noSelinuxColumnStillParses() {
        // 没有 -Z（或标签被吞）时也不能瞎：大小与名字要照常对。
        val e = VfsShell.parseLsLine(
            "-rw-r--r-- 1 u0_a123 u0_a123 1234 2026-11-09 10:28 plain.txt"
        )
        requireNotNull(e)
        assertEquals("plain.txt", e!!.name)
        assertEquals(1234L, e.size)
        assertEquals("", e.selinux)
    }

    @Test
    fun symlinkLineKeepsTargetAndDropsTheTrailingLabel() {
        // 符号链接 + 行尾标签：linkTarget 不许把上下文一起吞进去
        val e = VfsShell.parseLsLine(
            "lrw-r--r-- 1 root shell  u:object_r:system_file:s0  20 2026-11-09 10:28 bin -> /system/bin u:object_r:system_file:s0"
        )
        requireNotNull(e)
        assertEquals("bin", e!!.name)
        assertEquals("/system/bin", e.linkTarget)
        assertEquals("u:object_r:system_file:s0", e.selinux)
    }

    @Test
    fun symlinkLineWithPrefixLabelKeepsTarget() {
        // 同一种链接行，但标签在前缀位——旧逻辑会在这里把箭头后的目标当标签剥掉
        val e = VfsShell.parseLsLine(
            "lrw-r--r-- 1 root shell  u:object_r:system_file:s0  20 2026-11-09 10:28 bin -> /system/bin"
        )
        requireNotNull(e)
        assertEquals("bin", e!!.name)
        assertEquals("/system/bin", e.linkTarget)
        assertEquals("u:object_r:system_file:s0", e.selinux)
    }

    @Test
    fun oldDateFormatStillParses() {
        // 半年外的文件：`Nov  9  2024`，没有时间字段
        val e = VfsShell.parseLsLine(
            "-rw-r--r-- 1 root root  u:object_r:system_file:s0  99 Nov  9  2024 old.bin"
        )
        requireNotNull(e)
        assertEquals("old.bin", e!!.name)
        assertEquals(99L, e.size)
    }

    @Test
    fun totalHeaderAndJunkAreSkipped() {
        assertNull(VfsShell.parseLsLine("total 128"))
        assertNull(VfsShell.parseLsLine("ls: /nope: No such file or directory"))
        assertNull(VfsShell.parseLsLine(""))
    }

    private fun requireNotNull(e: VfsShell.LsEntry?) {
        assertTrue("这一行必须解析成功（解析失败 = 目录显示为空）", e != null)
    }
}
