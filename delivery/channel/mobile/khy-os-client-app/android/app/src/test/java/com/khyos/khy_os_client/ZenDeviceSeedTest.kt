package com.khyos.khy_os_client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 设备种子派生（[ZenDeviceSeed]）。
 *
 * 为什么只测派生、不测 materialFor：后者要读 Settings.Secure，JVM 单测里没有
 * ContentResolver。而"同一设备恒定、异设备相异"这条判据全部落在 digest 上，
 * 它能被纯函数验完。
 *
 * 为什么不钉任何具体哈希值：那等于把一个写死的设备身份存进仓库，下一次谁改了
 * 派生串，测试会拦住他，但拦的理由会是"哈希对不上"，而不是"两台设备拿到同一身份"。
 */
class ZenDeviceSeedTest {

    @Test
    fun 同一素材派生恒定() {
        val a = ZenDeviceSeed.digest("android-id-sample")
        assertEquals(a, ZenDeviceSeed.digest("android-id-sample"))
    }

    @Test
    fun 不同素材派生出不同种子() {
        val a = ZenDeviceSeed.digest("android-id-sample")
        val b = ZenDeviceSeed.digest("android-id-samplf")
        assertNotEquals(a, b)
        assertEquals(64, a.length)
        assertEquals(64, b.length)
    }

    @Test
    fun 种子形态是六十四位小写十六进制() {
        // Dart 侧按 hex 当字符串用，长度或大小写变了不报错，只会让身份悄悄变一份。
        assertTrue(ZenDeviceSeed.digest("x").matches(Regex("^[0-9a-f]{64}$")))
        assertTrue(ZenDeviceSeed.digest("").matches(Regex("^[0-9a-f]{64}$")))
    }

    @Test
    fun 只认自己的方法名() {
        assertTrue(ZenDeviceSeed.handles("zenDeviceSeed"))
        assertFalse(ZenDeviceSeed.handles("vfsList"))
        assertFalse(ZenDeviceSeed.handles("shell"))
        assertFalse(ZenDeviceSeed.handles(""))
    }
}
