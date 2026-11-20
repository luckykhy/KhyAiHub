import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/drivers/driver_registry.dart';
import 'package:khy_os_client/core/toolhost/tool_host_client.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

class _FakeDriver implements Driver {
  _FakeDriver(this.id, {this.enabled = true, this.throwOnSend = false});

  @override
  final String id;
  @override
  bool enabled;
  bool throwOnSend;
  int opened = 0;

  DriverHealth _health = DriverHealth.ok;

  @override
  DriverHealth health() => _health;

  @override
  Future<void> openSession(String sessionId, SessionContext ctx) async {
    opened++;
  }

  @override
  Stream<DriverEvent> send(UserTurn turn) async* {
    if (throwOnSend) throw StateError('boom');
    yield DriverDelta(kind: 'content', text: 'reply');
  }

  @override
  Future<void> abort(String sessionId) async {}

  @override
  Future<void> dispose() async {}
}

class _RecoverableFake extends _FakeDriver implements RecoverableDriver {
  _RecoverableFake(super.id, {super.enabled, super.throwOnSend});
  int recovered = 0;

  @override
  Future<bool> recover() async {
    recovered++;
    return true;
  }
}

ToolHostClient _fakeHost() => _FakeHostClient();

class _FakeHostClient implements ToolHostClient {
  @override
  List<CapabilityEntry> capabilities() => const [];
  @override
  Future<ToolResult> invoke(String name, Map<String, Object?> args, {String? callId}) async =>
      ToolResult.ok('');
}

void main() {
  group('DriverRegistry 启停与禁用', () {
    test('禁用的 driver 不出现在 enabledDrivers，但仍在册', () {
      final reg = DriverRegistry(disabledIds: const ['amoo']);
      reg.register(_FakeDriver('amoo'));
      reg.register(_FakeDriver('local'));

      expect(reg.get('amoo'), isNotNull, reason: '在册才能重新启用，不是删掉');
      expect(reg.enabledIds, ['local']);
      expect(reg.isDisabled('amoo'), true);
      expect(reg.isDisabled('local'), false);
    });

    test('driver 自身 enabled=false 同样不出场', () {
      final reg = DriverRegistry();
      reg.register(_FakeDriver('script', enabled: false));
      expect(reg.enabledIds, isEmpty);
    });

    test('重复注册同一 id 后者覆盖前者', () {
      final reg = DriverRegistry();
      reg.register(_FakeDriver('a', enabled: true));
      reg.register(_FakeDriver('a', enabled: false));
      expect(reg.enabledIds, isEmpty);
    });

    test('unregister 后 get 返回 null', () {
      final reg = DriverRegistry();
      reg.register(_FakeDriver('a'));
      reg.unregister('a');
      expect(reg.get('a'), isNull);
    });
  });

  group('DriverRegistry 崩溃隔离', () {
    test('driver 抛错只变成该会话的 DriverFailed，不冒泡', () async {
      final reg = DriverRegistry();
      reg.register(_FakeDriver('bad', throwOnSend: true));
      reg.register(_FakeDriver('good'));

      final events = await reg.safeSend('bad', const UserTurn(sessionId: 's', turnId: 't', text: 'hi')).toList();
      expect(events.whereType<DriverFailed>().length, 1);
      expect(events.whereType<DriverDelta>().length, 0);
    });

    test('崩过的 driver 标记 down 且计数，其余 driver 不受影响', () async {
      final reg = DriverRegistry();
      reg.register(_FakeDriver('bad', throwOnSend: true));
      reg.register(_FakeDriver('good'));

      await reg.safeSend('bad', const UserTurn(sessionId: 's', turnId: 't', text: 'hi')).drain<Object?>();
      await reg.safeSend('bad', const UserTurn(sessionId: 's', turnId: 't', text: 'hi')).drain<Object?>();

      expect(reg.crashCount('bad'), 2);
      expect(reg.healthOf('bad'), DriverHealth.down);
      expect(reg.healthOf('good'), DriverHealth.ok);

      final ok = await reg.safeSend('good', const UserTurn(sessionId: 's', turnId: 't', text: 'hi')).toList();
      expect(ok.whereType<DriverDelta>().length, 1);
    });

    test('流中间抛错也隔离：已发出的事件保留，末尾补 DriverFailed', () async {
      final reg = DriverRegistry();
      reg.register(_MidThrowDriver());

      final events = await reg.safeSend('mid', const UserTurn(sessionId: 's', turnId: 't', text: 'hi')).toList();
      expect(events.whereType<DriverDelta>().length, 1, reason: '崩前的内容不能吞');
      expect(events.whereType<DriverFailed>().length, 1, reason: '崩后必须显式失败事件');
    });

    test('连续 3 次失败标记 degraded', () async {
      final reg = DriverRegistry();
      reg.register(_FakeDriver('bad', throwOnSend: true));
      for (var i = 0; i < 3; i++) {
        await reg.safeSend('bad', const UserTurn(sessionId: 's', turnId: 't', text: 'hi')).drain<Object?>();
      }
      expect(reg.healthOf('bad'), DriverHealth.degraded);
    });

    test('未注册或已禁用的 id：显式 DriverFailed，不静默空流', () async {
      final reg = DriverRegistry(disabledIds: const ['off']);
      reg.register(_FakeDriver('off'));

      final missing = await reg.safeSend('nope', const UserTurn(sessionId: 's', turnId: 't', text: 'hi')).toList();
      expect(missing.whereType<DriverFailed>().length, 1);

      final disabled = await reg.safeSend('off', const UserTurn(sessionId: 's', turnId: 't', text: 'hi')).toList();
      expect(disabled.whereType<DriverFailed>().length, 1);
    });
  });

  group('DriverRegistry 惰性重启', () {
    test('down 的 driver 下次 openSession 先尝试 recover', () async {
      final reg = DriverRegistry();
      final d = _RecoverableFake('amoo', throwOnSend: true);
      reg.register(d);

      // 先经公开行为把它弄 down：safeSend 捕获抛错并标记 health
      await reg.safeSend('amoo', const UserTurn(sessionId: 's1', turnId: 't1', text: 'hi')).drain<Object?>();
      expect(reg.healthOf('amoo'), DriverHealth.down);
      expect(d.recovered, 0, reason: 'send 路径不做重启，重启只发生在 openSession');

      d.throwOnSend = false;
      await reg.openSession('amoo', 's2', SessionContext(tools: _fakeHost()));
      expect(d.recovered, 1, reason: 'down 的下一次 openSession 必须尝试自恢复');
      expect(reg.healthOf('amoo'), DriverHealth.ok);
      expect(d.opened, 1);
    });

    test('没有 recover 能力的 driver：down 后 openSession 直接重新初始化', () async {
      final reg = DriverRegistry();
      final d = _FakeDriver('plain', throwOnSend: true);
      reg.register(d);

      await reg.safeSend('plain', const UserTurn(sessionId: 's1', turnId: 't1', text: 'hi')).drain<Object?>();
      expect(reg.healthOf('plain'), DriverHealth.down);

      d.throwOnSend = false;
      await reg.openSession('plain', 's1', SessionContext(tools: _fakeHost()));
      expect(d.opened, 1);
      expect(reg.healthOf('plain'), DriverHealth.ok);
    });

    test('禁用的 driver openSession 是 no-op', () async {
      final reg = DriverRegistry(disabledIds: const ['amoo']);
      final d = _FakeDriver('amoo');
      reg.register(d);

      await reg.openSession('amoo', 's1', SessionContext(tools: _fakeHost()));
      expect(d.opened, 0, reason: '禁用后零探测——T1 的启动路径证据');
    });
  });
}

class _MidThrowDriver implements Driver {
  @override
  String get id => 'mid';
  @override
  bool get enabled => true;
  @override
  DriverHealth health() => DriverHealth.ok;
  @override
  Future<void> openSession(String sessionId, SessionContext ctx) async {}
  @override
  Stream<DriverEvent> send(UserTurn turn) async* {
    yield DriverDelta(kind: 'content', text: 'half');
    throw StateError('mid-boom');
  }

  @override
  Future<void> abort(String sessionId) async {}
  @override
  Future<void> dispose() async {}
}
