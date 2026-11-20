package com.khyos.khy_os_client.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * DriverGate 的键名与判定（§5.1）。
 *
 * 键名字面值与 Dart 侧 driver_channel.dart 的 kDriverDisabledKeyPrefix 钉同一个串：
 * 两侧各定义一份（Dart/Kotlin 不通源码），字面值分叉的后果是 Flutter 写一个键、
 * 原生读另一个键——开关拨了永远不生效，而这种分叉在单侧测试里都是绿的。
 */
class DriverGateTest {
    @Test
    fun `keyFor prefixes driver id`() {
        assertEquals("driver_disabled_amoo", DriverGate.keyFor("amoo"))
        assertEquals("driver_disabled_pc-bridge", DriverGate.keyFor("pc-bridge"))
    }

    @Test
    fun `missing key means not disabled`() {
        // 键不存在 = 未禁用（fail-open 到功能可用）。禁用写入永远经
        // setDriverEnabled 显式发生，不做任何默认推断。
        val prefs = mapOf<String, Boolean>()
        assertFalse(DriverGate.isDisabled(prefs::get, "amoo"))
    }

    @Test
    fun `explicit false is not disabled either`() {
        val prefs = mapOf("driver_disabled_amoo" to false)
        assertFalse(DriverGate.isDisabled(prefs::get, "amoo"))
    }

    @Test
    fun `explicit true is disabled`() {
        val prefs = mapOf("driver_disabled_amoo" to true)
        assertTrue(DriverGate.isDisabled(prefs::get, "amoo"))
    }

    @Test
    fun `one driver's gate does not gate another`() {
        val prefs = mapOf("driver_disabled_amoo" to true)
        assertTrue(DriverGate.isDisabled(prefs::get, "amoo"))
        assertFalse(DriverGate.isDisabled(prefs::get, "local"))
    }
}
