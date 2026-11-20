// khy-canary: Khy-20261113-002-P2CHAN
import 'package:flutter/services.dart';

/// 原生侧 driver 禁用键的前缀（键名 = 前缀 + driverId）。
///
/// 与 Kotlin 侧 DriverGate.KEY_PREFIX 钉同一个字面值——两侧各定义一份
/// （Dart/Kotlin 不通源码），字面值分叉的后果是 Flutter 写一个键、原生读
/// 另一个键：开关拨了永远不生效，而这种分叉在单侧测试里都是绿的。
/// 两侧各有一条测试钉这个串（driver_channel_test / DriverGateTest）。
const kDriverDisabledKeyPrefix = 'driver_disabled_';

/// Flutter → 原生的禁用写入通道（§5.1 第 4 条）。
///
/// 缺了这一环，原生 SharedPreferences 里永远没有这个键——BridgeOverlayService
/// 的先例就是「被 Flutter 经 MethodChannel 显式调 setEnabled」，不是原生猜的。
class DriverChannel {
  static const channel = MethodChannel('com.khyos.khy_os_client/device');
  static const methodSetDriverEnabled = 'setDriverEnabled';

  /// enabled=false = 禁用该 driver。返回 false = 原生侧没接上这个方法
  /// （APK 太旧），调用方应当把开关拨回去并如实说明，不能显示假状态。
  static Future<bool> setDriverEnabled(String driverId, bool enabled) async {
    try {
      final r = await channel.invokeMethod(methodSetDriverEnabled, {
        'driverId': driverId,
        'enabled': enabled,
      });
      return r is Map && r['ok'] == true;
    } on MissingPluginException {
      return false;
    } catch (_) {
      return false;
    }
  }
}

/// 禁用名单的纯函数变换。
///
/// 纯函数而不是散在 UI 里：名单的增删语义（重复禁用不重复、解除未禁用的
/// 不变）要在 VM 上钉死，而 UI 状态机做不到可测。
List<String> toggleDisabled(List<String> current, String driverId, bool enabled) {
  final next = List<String>.of(current);
  if (enabled) {
    next.remove(driverId);
  } else if (!next.contains(driverId)) {
    next.add(driverId);
  }
  return next;
}
