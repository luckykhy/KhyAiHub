package com.khyos.khy_os_client.bridge

import android.content.Context
import android.content.SharedPreferences

/**
 * Driver 禁用门（§5.1）。
 *
 * 两道消费方共用这一个判定：MainActivity 的 amoo 六方法路由（MethodChannel 入口）
 * 与 Tools.dispatch 的助手循环工具分支（桥 HTTP 入口）。此前只有 Flutter 侧
 * AppConfigData 记禁用，原生两道门各自为政——拨了开关原生照跑，就是这个类
 * 存在的原因。
 *
 * 键名字面值与 Dart 侧 driver_channel.dart 的 kDriverDisabledKeyPrefix 钉同一个串
 * （Dart/Kotlin 不通源码，只能两侧各定义一份 + 各写一条测试钉字面值）。
 *
 * 语义：键不存在 = 未禁用（fail-open 到功能可用）。禁用写入永远经
 * setDriverEnabled 显式发生，这里不做任何默认推断——「没写过」和「写着禁用」
 * 是两回事，把没写过推断成禁用会让全新安装的用户莫名其妙丢功能。
 */
object DriverGate {
    const val KEY_PREFIX = "driver_disabled_"

    private const val PREFS_NAME = "khy_driver_gates"

    fun keyFor(driverId: String): String = KEY_PREFIX + driverId

    /** 读单个键的判定。reader 抽出来是为了 JVM 测试不需要 Android 上下文。 */
    fun isDisabled(reader: (String) -> Boolean?, driverId: String): Boolean =
        reader(keyFor(driverId)) == true

    fun isDisabled(prefs: SharedPreferences, driverId: String): Boolean =
        prefs.getBoolean(keyFor(driverId), false)

    fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** 写禁用位。enabled=false 即写 true（禁用）。 */
    fun setEnabled(context: Context, driverId: String, enabled: Boolean) {
        prefs(context).edit().putBoolean(keyFor(driverId), !enabled).apply()
    }
}
