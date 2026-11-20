package com.khyos.khy_os_client

import android.app.Activity
import android.provider.Settings
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 这台设备的 Zen 身份种子。
 *
 * 为什么需要：Zen 免费档按「一台设备一份、跨重启稳定」的身份判配额与信誉
 * （电脑版 services/zenIdentity.js）。手机侧原先只有一份安装期随机 UUID——
 * 卸载重装就变成上游眼里的另一台设备，而出口 IP 没变，正是反滥用模型里
 * 最像批量刷量的形态。电脑版用 hostname 做种子；手机上没有对应物，
 * 所以取 Settings.Secure.ANDROID_ID（每设备、同签名跨重装稳定）。
 *
 * 为什么不在原生层之外用原始标识符：ANDROID_ID 属于设备标识，能不出进程
 * 就不出。通道只交 64 位 hex 摘要，原始值不进日志、不进 Dart 堆。
 *
 * 为什么不做 Build.* 级回退：同型号同 ROM 的机器 Build 字段完全相同，
 * 回退过去等于让那批手机共用一套身份——比随机身份更糟。取不到就如实报
 * source=none，Dart 侧走安装期身份。
 */
object ZenDeviceSeed {
    const val METHOD = "zenDeviceSeed"

    /** 派生域串。与电脑版 `khy-zen-identity-v1` 不同的域：两边种子含义不同。 */
    private const val DOMAIN = "khyos-zen-device-seed-v1"

    /**
     * Android 8.0 之前的 ANDROID_ID 是一个所有设备共用的坏值
     * （9774d56d682e549c）。它不是"这台设备"，用它派生会让一批设备同身份。
     */
    private const val KNOWN_BAD_ANDROID_ID = "9774d56d682e549c"

    /** HMAC-SHA256(key = DOMAIN, data = material) 的 64 位小写 hex。 */
    fun digest(material: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(DOMAIN.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val bytes = mac.doFinal(material.toByteArray(Charsets.UTF_8))
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            out.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return out.toString()
    }

    /** 读设备的 ANDROID_ID；空值/坏值一律当"不可用"。 */
    fun materialFor(activity: Activity): String? {
        val id = try {
            Settings.Secure.getString(activity.contentResolver, Settings.Secure.ANDROID_ID)
        } catch (_: Throwable) {
            null
        }
        if (id.isNullOrBlank()) return null
        if (id.equals(KNOWN_BAD_ANDROID_ID, ignoreCase = true)) return null
        return id
    }

    fun handles(method: String): Boolean = method == METHOD

    /**
     * 处理 zenDeviceSeed；不是这个方法名就返回 false 交回调用方。
     *
     * 任何异常都收敛成 ok:false（只带 source），绝不把异常原文回给 Dart——
     * 那里面可能带着读设置时抛出的捆绑参数。种子本身也绝不打印。
     */
    fun dispatch(activity: Activity, call: MethodCall, result: MethodChannel.Result): Boolean {
        if (!handles(call.method)) return false
        val material = try {
            materialFor(activity)
        } catch (_: Throwable) {
            null
        }
        if (material == null) {
            result.success(mapOf("ok" to false, "source" to "none"))
            return true
        }
        try {
            result.success(
                mapOf("ok" to true, "seed" to digest(material), "source" to "android_id")
            )
        } catch (_: Throwable) {
            result.success(mapOf("ok" to false, "source" to "android_id"))
        }
        return true
    }

    private val HEX = "0123456789abcdef".toCharArray()
}
