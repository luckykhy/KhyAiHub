// khy-canary: Khy-20261113-001-P1DRVIF
import 'dart:async';

import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/toolhost/tool_host_client.dart';

/// Driver 健康态。状态行与自恢复决策读它。
enum DriverHealth { ok, degraded, down }

/// 一次会话的上下文。driver 拿它访问 Tool Host，不自己持有工具清单。
class SessionContext {
  final ToolHostClient tools;
  final Map<String, Object?> extra;
  const SessionContext({required this.tools, this.extra = const {}});
}

/// 一轮用户输入。sessionId/turnId 由调用方分配，driver 不得改。
class UserTurn {
  final String sessionId;
  final String turnId;
  final String text;
  final List<Map<String, Object?>>? attachments;
  const UserTurn({
    required this.sessionId,
    required this.turnId,
    required this.text,
    this.attachments,
  });
}

/// 统一 Driver 接口（§2.2）。
///
/// 新增一个 driver 的手续：实现这四个方法 → 在 DriverRegistry 登记 id 与
/// enabled 条件 → 跑 flutter test test/drivers/。不需要改渲染层（T2 判据）
/// 与工具清单（工具属 Tool Host）。
abstract class Driver {
  /// 'amoo' | 'local' | 'pc-bridge' | 'script' …
  String get id;

  /// 是否可出场。受设置开关 + driver 自身能力共同决定；false 时 registry
  /// 不注册、不探测、不出现在任何列表。
  bool get enabled;

  DriverHealth health();

  Future<void> openSession(String sessionId, SessionContext ctx);

  /// 发送一轮用户输入，返回流式事件。
  ///
  /// driver 内部禁止写 UI、禁止直接碰设备文件与无障碍——那些是 Tool Host
  /// 的职责，driver 只发语义调用（§1.1 铁律 1）。
  Stream<DriverEvent> send(UserTurn turn);

  Future<void> abort(String sessionId);

  Future<void> dispose();
}

/// 崩溃后可自恢复的 driver 选配接口。
///
/// registry 的惰性重启（§5.2）：down 的 driver 在下一次 openSession 时，
/// 实现了这个接口就先 recover()，否则直接重新 openSession。
mixin RecoverableDriver on Driver {
  /// 返回 true = 已恢复（health 归 ok）；false = 仍 down。
  Future<bool> recover() async => false;
}
