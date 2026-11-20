import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/amoo_driver.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/drivers/driver_registry.dart';
import 'package:khy_os_client/core/services/amoo_chat_service.dart';

/// 假网关：把 AmooChatService 的三条通道换成可编排的脚本。
///
/// 测的是「双路径到 send() Stream 的逐事件映射」（§2.5 的 MethodChannel
/// 路径），映射规则错一条，amoo 就退化成「有时有回复有时没有」的幽灵。
class _FakeGateway implements AmooGateway {
  _FakeGateway({this.askOutcome, this.pollScript = const []});

  AmooAskOutcome? askOutcome;
  /// 轮询脚本：按序消费；耗尽后重复最后一个（amoo 想多久都陪等）。
  final List<AmooAskOutcome> pollScript;
  int pollCalls = 0;
  int stopCalls = 0;
  Object? thrownByPoll;

  @override
  Future<AmooAskOutcome> ask(String prompt, {int timeoutMs = 420000}) async {
    return askOutcome ??
        const AmooAskOutcome(ok: true, job: 'job-1');
  }

  @override
  Future<AmooAskOutcome> poll() async {
    if (thrownByPoll != null) throw thrownByPoll!;
    if (pollScript.isEmpty) {
      return const AmooAskOutcome(ok: true, state: AmooAskState.running);
    }
    final i = pollCalls < pollScript.length ? pollCalls : pollScript.length - 1;
    pollCalls++;
    return pollScript[i];
  }

  @override
  Future<bool> stop() async {
    stopCalls++;
    return true;
  }
}

AmooAskOutcome _pollState(AmooAskState s, {String reply = '', String error = ''}) =>
    AmooAskOutcome(ok: true, state: s, reply: reply, error: error);

void main() {
  group('AmooDriver 逐事件映射', () {
    test('happy path：waiting → 轮询状态 → 回复 delta → finished', () async {
      final gw = _FakeGateway(pollScript: [
        _pollState(AmooAskState.running),
        _pollState(AmooAskState.running),
        _pollState(AmooAskState.done, reply: 'amoo 的回复'),
      ]);
      final d = AmooDriver(gateway: gw, pollInterval: Duration.zero);

      final events = await d
          .send(const UserTurn(sessionId: 's1', turnId: 't1', text: '你好'))
          .toList();

      expect(events.first, isA<DriverStatus>());
      expect((events.first as DriverStatus).code, 'waiting');
      final deltas = events.whereType<DriverDelta>().toList();
      expect(deltas.length, 1, reason: '回复只发一次——半句读两次就是重复内容');
      expect(deltas.single.text, 'amoo 的回复');
      expect(deltas.single.kind, 'content');
      expect(events.last, isA<DriverFinished>());
      expect((events.last as DriverFinished).reason, 'completed');
      expect(gw.pollCalls, 3);
    });

    test('思维链映射为 reasoning delta，不与正文混', () async {
      final gw = _FakeGateway(pollScript: [
        AmooAskOutcome(ok: true, state: AmooAskState.running, reasoning: '想了下'),
        _pollState(AmooAskState.done, reply: '答案'),
      ]);
      final d = AmooDriver(gateway: gw, pollInterval: Duration.zero);
      final events = await d.send(const UserTurn(sessionId: 's', turnId: 't', text: 'q')).toList();

      final reasoning = events.whereType<DriverDelta>().where((e) => e.kind == 'reasoning').toList();
      final content = events.whereType<DriverDelta>().where((e) => e.kind == 'content').toList();
      expect(reasoning.single.text, '想了下');
      expect(content.single.text, '答案');
    });

    test('提问被拒：DriverFailed，且全程零 content delta（不代答铁律）', () async {
      final gw = _FakeGateway(
        askOutcome: const AmooAskOutcome(
          ok: false,
          code: AmooAskFailure.refused,
          message: '提问被拒绝：前置条件没满足',
        ),
      );
      final d = AmooDriver(gateway: gw, pollInterval: Duration.zero);
      final events = await d.send(const UserTurn(sessionId: 's', turnId: 't', text: 'q')).toList();

      final failed = events.whereType<DriverFailed>().toList();
      expect(failed.length, 1);
      expect(failed.single.retryable, false, reason: 'refused 重试同一句没意义');
      expect(events.whereType<DriverDelta>().where((e) => e.kind == 'content').length, 0,
          reason: '禁止用本地模型生成替代回答——请求未返回只显示状态');
      expect(d.health(), DriverHealth.down);
    });

    test('orphan_cleared：锁已释放，重试有意义', () async {
      final gw = _FakeGateway(
        askOutcome: const AmooAskOutcome(
          ok: false,
          code: AmooAskFailure.orphanCleared,
          message: '上一笔卡死已清理',
        ),
      );
      final d = AmooDriver(gateway: gw, pollInterval: Duration.zero);
      final events = await d.send(const UserTurn(sessionId: 's', turnId: 't', text: 'q')).toList();
      expect(events.whereType<DriverFailed>().single.retryable, true);
    });

    test('单飞被拒：不可重试（要等，不是重发）', () async {
      final gw = _FakeGateway(
        askOutcome: const AmooAskOutcome(ok: false, code: AmooAskFailure.singleFlight, message: '已有提问在进行中'),
      );
      final d = AmooDriver(gateway: gw, pollInterval: Duration.zero);
      final events = await d.send(const UserTurn(sessionId: 's', turnId: 't', text: 'q')).toList();
      expect(events.whereType<DriverFailed>().single.retryable, false);
    });

    test('轮询抛异常（IPC 超时）：转 DriverFailed 且可重试，不冒泡', () async {
      final gw = _FakeGateway(pollScript: [_pollState(AmooAskState.running)])
        ..thrownByPoll = TimeoutException('poll');
      final d = AmooDriver(gateway: gw, pollInterval: Duration.zero);
      final events = await d.send(const UserTurn(sessionId: 's', turnId: 't', text: 'q')).toList();
      final failed = events.whereType<DriverFailed>().single;
      expect(failed.retryable, true);
      expect(events.whereType<DriverFinished>().length, 0, reason: '失败不冒充完成');
    });

    test('abort 调 stop 通道', () async {
      final gw = _FakeGateway();
      final d = AmooDriver(gateway: gw, pollInterval: Duration.zero);
      await d.abort('s1');
      expect(gw.stopCalls, 1);
    });
  });

  group('AmooDriver 可禁用', () {
    test('配置禁用后 enabled=false，registry 不出场', () {
      final cfg = const AppConfigData(baseUrl: '', apiKey: '', model: 'm')
          .copyWith(disabledDrivers: const ['amoo']);
      final d = AmooDriver(config: cfg, gateway: _FakeGateway());
      expect(d.enabled, false);

      final reg = DriverRegistry(disabledIds: cfg.disabledDrivers);
      reg.register(d);
      expect(reg.enabledIds, isEmpty, reason: '禁用后连探测都不该有（T1 启动路径）');
    });

    test('未禁用时 enabled=true', () {
      final d = AmooDriver(config: const AppConfigData(baseUrl: '', apiKey: '', model: 'm'));
      expect(d.enabled, true);
    });
  });
}
