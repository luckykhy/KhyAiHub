// khy-canary: Khy-20261101-083-F8AF8X14
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 主输入框当前发给哪个 driver。
///
/// 为什么需要它：AI 页原来有两个输入框——amoo 反代卡一个、主对话一个。两个框
/// 并排摆在用户面前，第一件事就成了猜"我该敲哪个"，而它们的语义完全不同
/// （一个等 6 分钟，一个秒回）。
///
/// 合成一个：主输入框始终是那个输入框，加一个目标切换。选某个 driver 时，
/// 那个 driver 的状态面把自己的输入框收起来，只留状态和回复。
///
/// 做成全局可监听而不是传参：主输入框在 chat_screen_new，driver 状态面在
/// 各自的卡/widget，两者隔着几层 widget；而底部导航让四个页同时活着，
/// 用 InheritedWidget 反而要在每一层都挂上。
///
/// **为什么是 driverId 字符串而不是 enum**：amoo 只是 driver 之一，与
/// local / pc-bridge / script 并列。二值 enum 表达不了「第 4 个 driver
/// 加入」——每加一个 driver 都要改 enum 和全仓所有 switch，而那正是
/// 「执行器绑定某个助手」的结构根源。字符串 id 让新 driver 的接入停留在
/// 注册表里，不上升到类型系统。
class ActiveDriverNotifier extends ValueNotifier<String> {
  ActiveDriverNotifier({String initial = kAssistantDriverId}) : super(initial) {
    _report(initial);
  }

  /// 内置云助手（主对话链路）的 driver id。
  ///
  /// 它不在四个可插拔 driver 里——它是执行器的主对话路径本身。给它一个
  /// id 而不是特例分支：目标切换的判定因此只有一种形状
  /// （`value == id`），云助手和插件 driver 走同一套比较。
  static const String kAssistantDriverId = 'assistant';

  /// 把「选了什么」同步给原生，供 `info.driver_selected` 读。
  ///
  /// 只上报，不参与选择：这个字段是诊断用的，通道不可用（单测、壳太旧）时
  /// 静默跳过，绝不能让一次 select 因为上报失败而失败。
  /// 与 `info.driver`（这一轮实际走哪条）分开报——两者不同正是降级的现场。
  static const MethodChannel _channel =
      MethodChannel('com.khyos.khy_os_client/device');

  bool isDriver(String id) => value == id;

  void select(String id) {
    value = id;
    _report(id);
  }

  static Future<void> _report(String id) async {
    try {
      await _channel
          .invokeMethod('driverSelect', <String, Object?>{'driverId': id})
          .timeout(const Duration(seconds: 2));
    } catch (_) {
      // 诊断字段，失败不影响选择。
    }
  }
}

/// 兼容名：新代码用 [ActiveDriverNotifier]，旧的引用点逐步收敛。
typedef ChatTargetNotifier = ActiveDriverNotifier;
