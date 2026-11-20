import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/drivers/pc_bridge_driver.dart';

/// 假 SSE 网关：脚本化事件序列，不碰 Dio、不碰网络。
class _FakeGateway implements PcBridgeGateway {
  _FakeGateway(this.script);
  final List<Map<String, dynamic>> script;
  int calls = 0;
  Object? thrown;

  @override
  Stream<Map<String, dynamic>> streamChat({
    required String question,
    required List<Map<String, String>> history,
    String? sessionId,
  }) async* {
    calls++;
    if (thrown != null) throw thrown!;
    for (final e in script) {
      yield e;
    }
  }
}

void main() {
  // pc-bridge driver 的映射（§2.4）：SSE delta→DriverDelta、思维链→reasoning
  // delta、done→finished、error→DriverFailed。不新增端点这条约束的可执行
  // 部分：gateway 缝只有 streamChat 一个方法。
  group('PcBridgeDriver 事件映射', () {
    test('chunk 累加、reasoning 分开、done 收尾', () async {
      final gw = _FakeGateway(const [
        {'type': 'chunk', 'content': '你'},
        {'type': 'chunk', 'content': '好', 'reasoning': '想了想'},
        {'type': 'chunk', 'content': '世界'},
        {'type': 'done', 'content': '你好世界'},
      ]);
      final d = PcBridgeDriver(gateway: gw);

      final events = await d
          .send(const UserTurn(sessionId: 's', turnId: 't', text: '在吗'))
          .toList();

      final content = events.whereType<DriverDelta>().where((e) => e.kind == 'content').toList();
      final reasoning = events.whereType<DriverDelta>().where((e) => e.kind == 'reasoning').toList();
      expect(content.map((e) => e.text).join(), '你好世界');
      expect(reasoning.map((e) => e.text).join(), '想了想');
      expect(events.last, isA<DriverFinished>());
      expect(gw.calls, 1);
    });

    test('后端 error 事件转 DriverFailed，不吞', () async {
      final gw = _FakeGateway(const [
        {'type': 'chunk', 'content': '半句'},
        {'type': 'error', 'message': '后端炸了'},
      ]);
      final d = PcBridgeDriver(gateway: gw);
      final events = await d.send(const UserTurn(sessionId: 's', turnId: 't', text: 'q')).toList();

      final failed = events.whereType<DriverFailed>().single;
      expect(failed.retryable, true, reason: '网络/上游类失败可重试');
      expect(failed.error.toString(), contains('后端炸了'));
      expect(events.whereType<DriverFinished>().length, 0, reason: '失败不冒充完成');
      // 半句保留——崩前的内容不吞（同 registry 的边界语义）。
      expect(events.whereType<DriverDelta>().length, 1);
    });

    test('连接抛异常（未连接/断网）转 DriverFailed，不冒泡', () async {
      final gw = _FakeGateway(const [])..thrown = Exception('未连接到 khy-os 后端');
      final d = PcBridgeDriver(gateway: gw);
      final events = await d.send(const UserTurn(sessionId: 's', turnId: 't', text: 'q')).toList();
      expect(events.whereType<DriverFailed>().single.retryable, true);
    });

    test('发车前有 waiting 状态行（RUNTIME-002）', () async {
      final gw = _FakeGateway(const [{'type': 'done', 'content': 'x'}]);
      final d = PcBridgeDriver(gateway: gw);
      final events = await d.send(const UserTurn(sessionId: 's', turnId: 't', text: 'q')).toList();
      expect(events.first, isA<DriverStatus>());
    });

    test('禁用后 enabled=false', () {
      final d = PcBridgeDriver(
        gateway: _FakeGateway(const []),
        config: const AppConfigData(baseUrl: '', apiKey: '', model: 'm')
            .copyWith(disabledDrivers: const ['pc-bridge']),
      );
      expect(d.enabled, false);
    });
  });
}
