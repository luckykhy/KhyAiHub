// khy-canary: Khy-20261113-001-P1REG
import 'dart:async';

import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';

/// Driver 注册表：注册 / 发现 / 启停 / 崩溃隔离 / 惰性重启。
///
/// 三层职责里它属于 Driver Layer 的门面：渲染层只跟它要 enabledDrivers，
/// 不认识任何具体 driver；Tool Host 不认识它。
class DriverRegistry {
  /// 被用户禁用的 driver id（来自 AppConfigData.disabledDrivers）。
  ///
  /// 禁用 = 不注册、不探测、不出现在列表，但**不从册上删掉**——否则重新
  /// 启用时要重启 App 才能找回这个 driver。
  final List<String> disabledIds;

  DriverRegistry({this.disabledIds = const []});

  final Map<String, Driver> _drivers = {};
  final Map<String, DriverHealth> _health = {};
  final Map<String, int> _crashCounts = {};

  void register(Driver d) {
    _drivers[d.id] = d;
    _health[d.id] = d.health();
  }

  void unregister(String id) {
    _drivers.remove(id);
    _health.remove(id);
    _crashCounts.remove(id);
  }

  Driver? get(String id) => _drivers[id];

  bool isDisabled(String id) => disabledIds.contains(id);

  /// 出场的 driver：在册 + 自身 enabled + 未被用户禁用。
  List<Driver> get enabledDrivers =>
      _drivers.values.where((d) => d.enabled && !disabledIds.contains(d.id)).toList();

  List<String> get enabledIds => enabledDrivers.map((d) => d.id).toList();

  int crashCount(String id) => _crashCounts[id] ?? 0;

  DriverHealth healthOf(String id) => _health[id] ?? DriverHealth.down;

  /// openSession 带崩溃隔离与惰性重启。
  ///
  /// 禁用的 driver 是 no-op——「禁用后其余 driver 照常可用」的启动路径证据
  /// 就是这里零探测（T1）。
  Future<void> openSession(String id, String sessionId, SessionContext ctx) async {
    final d = _drivers[id];
    if (d == null || !d.enabled || disabledIds.contains(id)) return;

    if (healthOf(id) == DriverHealth.down) {
      // 惰性重启：down 的下一次 openSession 尝试重建，无后台轮询。
      if (d is RecoverableDriver) {
        final recovered = await d.recover();
        if (!recovered) return; // 仍 down：不硬开，等下一次
        _health[id] = DriverHealth.ok;
      } else {
        // 没有 recover 能力的 driver：直接重新 openSession 即重启。
        _health[id] = DriverHealth.ok;
      }
    }

    try {
      await d.openSession(sessionId, ctx);
    } catch (_) {
      _markDown(id);
    }
  }

  /// send 的崩溃隔离边界：driver 抛错只变成该会话的 DriverFailed，
  /// 不冒泡到 UI、不杀进程、不影响其他 driver。
  ///
  /// 崩前已发出的事件保留——半句回复也是用户已经看到的东西，吞掉它比留着
  /// 它更糟（用户以为从没收到过）。
  Stream<DriverEvent> safeSend(String id, UserTurn turn) async* {
    final d = _drivers[id];
    if (d == null) {
      yield DriverFailed(
        error: StateError('driver "$id" 未注册'),
        retryable: false,
      );
      return;
    }
    if (!d.enabled || disabledIds.contains(id)) {
      yield DriverFailed(
        error: StateError('driver "$id" 已禁用'),
        retryable: false,
      );
      return;
    }

    Stream<DriverEvent> src;
    try {
      src = d.send(turn);
    } catch (e) {
      _markDown(id);
      yield DriverFailed(error: e, retryable: true);
      return;
    }

    try {
      await for (final ev in src) {
        yield ev;
        if (ev is DriverFailed) _markDown(id);
      }
    } catch (e) {
      _markDown(id);
      yield DriverFailed(error: e, retryable: true);
    }
  }

  void _markDown(String id) {
    final n = (_crashCounts[id] ?? 0) + 1;
    _crashCounts[id] = n;
    // 连续 3 次失败标 degraded：状态行如实显示「连续 N 次失败 · 可禁用或重试」，
    // 不静默继续试（RUNTIME-002）。
    _health[id] = n >= 3 ? DriverHealth.degraded : DriverHealth.down;
  }
}
