// VFS 事件总线：原生 → Dart 的**唯一**入口。
//
// 为什么需要它：MethodChannel 在 Dart 侧只有一个 method call handler。
// 现在原生会推两类事件——目录变化（`vfsEvent`）与复制进度（`vfsProgress`）——
// 各写各的 `setMethodCallHandler` 的话，后装的会把先装的**顶掉**，表现为
// 「监听偶尔不响」或「复制进度不动」这种极难查的偶发故障。
//
// 所以这里做一件事：装一次 handler，按方法名分发。谁要接事件就在这里注册，
// 不再直接碰通道。
//
// 分发时单条处理器的异常不影响其它处理器——一个订阅者挂了不该让整条总线哑掉。

import 'package:flutter/services.dart';

import 'vfs_channel.dart';

/// 事件总线。
class VfsEventBus {
  VfsEventBus._();

  static final VfsEventBus instance = VfsEventBus._();

  /// 方法名 → 处理器列表。
  final Map<String, List<void Function(Map<String, dynamic>)>> _handlers =
      <String, List<void Function(Map<String, dynamic>)>>{};

  bool _installed = false;

  /// 装上通道 handler。可以重复调用（会重装，但不会丢订阅）。
  void install() {
    VfsChannel.setEventHandler(_dispatch);
    _installed = true;
  }

  /// 是否已装。
  bool get installed => _installed;

  /// 订阅某个方法名的事件。
  void on(
    String method,
    void Function(Map<String, dynamic>) handler,
  ) {
    final list = _handlers.putIfAbsent(method, () => <void Function(Map<String, dynamic>)>[]);
    if (!list.contains(handler)) list.add(handler);
  }

  /// 退订。
  void off(
    String method,
    void Function(Map<String, dynamic>) handler,
  ) {
    _handlers[method]?.remove(handler);
  }

  Future<Object?> _dispatch(MethodCall call) async {
    final args = call.arguments;
    final map = args is Map
        ? args.map((Object? key, Object? value) =>
            MapEntry<String, dynamic>(key.toString(), value))
        : const <String, dynamic>{};
    final list = _handlers[call.method];
    if (list == null) return null;
    for (final handler in List<void Function(Map<String, dynamic>)>.of(list)) {
      try {
        handler(map);
      } catch (_) {
        // 一个订阅者出错不该影响其它订阅者。
      }
    }
    return null;
  }
}
