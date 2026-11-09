// 与原生 VFS 桥对话的通道封装。
//
// 只做一件事：把一次调用变成一个 Map，并把「通道本身出问题」也变成一个**有结构的**
// 失败（ok=false + error + message），而不是把异常抛到界面上。
//
// 为什么通道错误要归一：`MethodChannel` 在没有原生实现时抛 PlatformException，
// 在 Dart 侧被 catch 住变成一次「操作失败」；如果不归一，界面上就会出现
// 「MissingPluginException」这种对用户毫无意义的话。

import 'package:flutter/services.dart';

/// 通道名。与原生 `MethodChannel("com.khyos.khy_os_client/vfs")` 一一对应。
const String kVfsChannelName = 'com.khyos.khy_os_client/vfs';

/// VFS 通道调用器。
class VfsChannel {
  static const MethodChannel _channel = MethodChannel(kVfsChannelName);

  /// 注册原生→Dart 的事件处理。
  ///
  /// 原生侧用同一个通道名反向调 Dart（比如目录事件 `vfsEvent`）。这里把处理器的
  /// 装卸收敛在一处，避免各处 `setMethodCallHandler` 互相覆盖——通道只有一个
  /// handler，后装的会把先装的顶掉。
  static void setEventHandler(
    Future<Object?> Function(MethodCall call)? handler,
  ) {
    _channel.setMethodCallHandler(handler);
  }

  /// 调用一次原生方法。无论成功失败都返回结构化 Map（至少含 `ok`）。
  static Future<Map<String, dynamic>> call(
    String method, [
    Map<String, dynamic>? args,
  ]) async {
    try {
      final result = await _channel.invokeMethod<Object?>(method, args);
      if (result is Map) {
        final map = result.map(
          (key, value) => MapEntry(key.toString(), value),
        );
        return map;
      }
      return <String, dynamic>{
        'ok': false,
        'error': 'unknown',
        'message': '原生返回了非预期结果',
      };
    } on PlatformException catch (error) {
      return <String, dynamic>{
        'ok': false,
        'error': 'unknown',
        'message': error.message ?? '原生调用失败：${error.code}',
      };
    } catch (error) {
      return <String, dynamic>{
        'ok': false,
        'error': 'unknown',
        'message': '原生调用失败：$error',
      };
    }
  }
}
