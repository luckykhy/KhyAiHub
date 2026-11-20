// khy-canary: Khy-20261101-087-W4CCHJTP
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// 屏幕常亮的单一事实来源。
///
/// 为什么需要单例而不是每个页面各自 `window.addFlags`：熄屏是**窗口级**状态，
/// 而底部导航把四个页面的 State 同时活着。两个页面各自开关，后一个的 clearFlags
/// 会把前一个的 addFlags 抵消掉——表现为"我明明开着常亮，切个页面就灭了"，
/// 而这种 bug 在现场几乎复现不出来。
///
/// 一个可监听的单例让所有页面读同一个值，写入也只有一处。
class KeepAwake extends ChangeNotifier {
  KeepAwake._();
  static final KeepAwake instance = KeepAwake._();

  static const _channel = MethodChannel('com.khyos.khy_os_client/device');
  static const _method = 'keepAwake';

  bool _on = false;

  /// 当前是否常亮。UI 应读这个值，不要自己留一份。
  bool get on => _on;

  /// 切换。失败时保持原状——不假装切成功了。
  Future<void> toggle() => set(!_on);

  Future<void> set(bool value) async {
    if (value == _on) return;
    try {
      await _channel.invokeMethod(_method, {'on': value});
      _on = value;
      notifyListeners();
    } catch (e) {
      // 常亮开不起来不该崩，但必须让用户知道没成功：一个静默失败的开关比没有
      // 开关更糟——用户以为屏幕不会灭，于是走开，回来发现任务早断了。
      debugPrint('keepAwake set($value) failed: $e');
    }
  }
}
