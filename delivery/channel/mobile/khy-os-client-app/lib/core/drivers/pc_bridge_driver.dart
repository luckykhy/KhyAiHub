// khy-canary: Khy-20261113-004-P4PCB
import 'dart:async';

import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/gateway/khyos_api.dart';

/// pc-bridge 的网关缝。
///
/// 只有 streamChat 一个方法——「只用既有端点、不新增任何端点」这条约束的
/// 可执行部分：缝上多一个方法，就等于给了一条没人审计得完的新链路。
abstract class PcBridgeGateway {
  Stream<Map<String, dynamic>> streamChat({
    required String question,
    required List<Map<String, String>> history,
    String? sessionId,
  });
}

/// 真机实现：包既有 [KhyOsApi]（127.0.0.1 桥，凭据来自连接配置）。
class KhyOsApiGateway implements PcBridgeGateway {
  KhyOsApiGateway(this._api);
  final KhyOsApi _api;

  @override
  Stream<Map<String, dynamic>> streamChat({
    required String question,
    required List<Map<String, String>> history,
    String? sessionId,
  }) =>
      _api.streamChat(question: question, history: history, sessionId: sessionId);
}

/// pc-bridge driver（§2.4）：既有 127.0.0.1 桥的 SSE 流 → DriverEvent。
///
/// 映射表（§2.4 定死，不得自行发明）：
///   chunk（content 增量）  → DriverDelta(content)
///   thinking_content       → DriverDelta(reasoning)
///   done                   → DriverFinished
///   error                  → DriverFailed(retryable: true)
class PcBridgeDriver implements Driver {
  PcBridgeDriver({
    PcBridgeGateway? gateway,
    AppConfigData? config,
    KhyOsApi? api,
  })  : _gateway = gateway ?? (api != null ? KhyOsApiGateway(api) : null),
        _config = config ?? const AppConfigData(baseUrl: '', apiKey: '', model: '');

  final PcBridgeGateway? _gateway;
  final AppConfigData _config;

  DriverHealth _health = DriverHealth.ok;

  @override
  String get id => 'pc-bridge';

  @override
  bool get enabled => !_config.isDriverDisabled('pc-bridge');

  @override
  DriverHealth health() => _health;

  @override
  Future<void> openSession(String sessionId, SessionContext ctx) async {
    // SSE 无会话态要建；连接在 send 时按需建立（未连接会以 DriverFailed
    // 呈现，而不是在打开会话时就把用户拦下）。
  }

  @override
  Stream<DriverEvent> send(UserTurn turn) async* {
    final gw = _gateway;
    if (gw == null) {
      yield DriverFailed(error: StateError('pc-bridge driver 未接网关'), retryable: false);
      return;
    }
    yield DriverStatus(code: 'connecting', detail: 'khy-os 桥', attempt: 0);

    final content = StringBuffer();
    final reasoning = StringBuffer();
    try {
      await for (final event in gw.streamChat(
        question: turn.text,
        history: const [],
        sessionId: turn.sessionId,
      )) {
        switch (event['type']) {
          case 'done':
            // done 带全文：已累加的部分不动，只把差额补上——直接覆盖会
            // 丢掉 reasoning 那半句（done 事件没有 reasoning 键）。
            final full = (event['content'] ?? '').toString();
            if (full.length > content.length) {
              final delta = full.substring(content.length);
              content.write(delta);
              yield DriverDelta(kind: 'content', text: delta);
            }
            yield DriverFinished(turnId: turn.turnId, reason: 'completed');
            return;
          case 'error':
            _health = DriverHealth.down;
            yield DriverFailed(
              error: (event['message'] ?? '远程请求失败').toString(),
              retryable: true,
            );
            return;
          default:
            final deltaText = (event['content'] ?? '').toString();
            if (deltaText.isNotEmpty) {
              content.write(deltaText);
              yield DriverDelta(kind: 'content', text: deltaText);
            }
            final reasoningText = (event['reasoning'] ?? '').toString();
            if (reasoningText.isNotEmpty) {
              reasoning.write(reasoningText);
              yield DriverDelta(kind: 'reasoning', text: reasoningText);
            }
        }
      }
      // 流自然结束但没有 done：后端挂了不该算成功——说完成了而内容停在
      // 半句，是比报错更糟的假象。
      _health = DriverHealth.down;
      yield DriverFailed(error: '流中断：未收到完成事件', retryable: true);
    } catch (e) {
      _health = DriverHealth.down;
      yield DriverFailed(error: e, retryable: true);
    }
  }

  @override
  Future<void> abort(String sessionId) async {
    // SSE 是单向流，没有原生中断通道；丢弃监听即止。留方法是为统一接口。
  }

  @override
  Future<void> dispose() async {}
}
