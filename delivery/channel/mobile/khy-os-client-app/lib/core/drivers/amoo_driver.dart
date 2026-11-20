// khy-canary: Khy-20261113-002-P2AMOO
import 'dart:async';

import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/services/amoo_chat_service.dart';

/// AmooChatService 三条通道的接缝。
///
/// 为什么要有这层：driver 的逐事件映射（§2.5）是纯逻辑，但它调的三条通道
/// 全在 MethodChannel 上——不抽接缝，测试就要 mock 整个平台通道，而映射
/// 规则一错就是「有时有回复有时没有」的幽灵，必须能在 VM 上钉死。
abstract class AmooGateway {
  const AmooGateway();

  Future<AmooAskOutcome> ask(String prompt, {int timeoutMs = 420000});
  Future<AmooAskOutcome> poll();
  Future<bool> stop();

  factory AmooGateway.live() => _LiveAmooGateway();
}

class _LiveAmooGateway implements AmooGateway {
  const _LiveAmooGateway();

  @override
  Future<AmooAskOutcome> ask(String prompt, {int timeoutMs = 420000}) =>
      AmooChatService.ask(prompt, timeoutMs: timeoutMs);

  @override
  Future<AmooAskOutcome> poll() => AmooChatService.poll();

  @override
  Future<bool> stop() => AmooChatService.stop();
}

/// amoo driver（§2.4/§2.5）。
///
/// 包的是本机反代三步协议：ask 发起 / poll 轮询 / stop 中断。HTTP 流式
/// 路径（KhyOsApi 三端点）由后续变更接入，届时只换 [AmooGateway] 的实现，
/// 映射表不变。
///
/// 铁律：请求未返回只发 DriverStatus，禁止用本地模型生成替代回答——
/// 所以失败路径上没有任何 content delta，一个都没有。
class AmooDriver implements Driver {
  AmooDriver({
    AppConfigData? config,
    AmooGateway? gateway,
    this.pollInterval = const Duration(milliseconds: 1500),
  })  : _config = config ?? const AppConfigData(baseUrl: '', apiKey: '', model: ''),
        _gateway = gateway ?? AmooGateway.live();

  final AppConfigData _config;
  final AmooGateway _gateway;
  final Duration pollInterval;

  DriverHealth _health = DriverHealth.ok;

  @override
  String get id => 'amoo';

  @override
  bool get enabled => !_config.isDriverDisabled('amoo');

  @override
  DriverHealth health() => _health;

  @override
  Future<void> openSession(String sessionId, SessionContext ctx) async {
    // 三步协议无会话态要建；保留签名是为统一接口（§2.2）。
  }

  @override
  Stream<DriverEvent> send(UserTurn turn) async* {
    yield DriverStatus(code: 'waiting', detail: '等待 amoo 回复', attempt: 0);

    final started = await _gateway.ask(turn.text);
    if (!started.ok) {
      _health = DriverHealth.down;
      yield DriverFailed(error: started.message, retryable: _retryable(started.code));
      return;
    }

    var attempt = 0;
    // 读屏提示只发一次：它是一次性事实（这一轮换了路），不是每拍都要重播的
    // 状态。缺这个旗标的话，1.5s 一轮的 poll 会把同一句话刷满状态行。
    var routeNoticeSent = false;
    while (true) {
      attempt++;
      final AmooAskOutcome s;
      try {
        s = await _gateway.poll();
      } catch (e) {
        // IPC 抛错（超时/壳太旧）：转失败事件，不冒泡、不代答。
        _health = DriverHealth.down;
        yield DriverFailed(error: e, retryable: true);
        return;
      }
      if (!s.ok) {
        _health = DriverHealth.down;
        yield DriverFailed(error: s.message, retryable: _retryable(s.code));
        return;
      }
      // 这一轮走在读屏路由上：把降级提示转成状态事件交出去（T15）。
      // code 用 route_degraded 而不是塞进 waiting 的 detail——后者会让
      // 「第 N 次轮询」这个进度信号贴在一条一次性提示上，两件事混排。
      // 渲染层 default 分支原样出 detail，新增 code 不加渲染分支（T16）。
      if (!routeNoticeSent && s.via == AmooTransport.screen) {
        routeNoticeSent = true;
        yield DriverStatus(code: 'route_degraded', detail: s.degradeNotice);
      }
      switch (s.state) {
        case AmooAskState.done:
          if (s.reply.isNotEmpty) {
            yield DriverDelta(kind: 'content', text: s.reply);
          }
          yield DriverFinished(turnId: turn.turnId, reason: 'completed');
          return;
        case AmooAskState.failed:
          _health = DriverHealth.down;
          yield DriverFailed(error: s.error, retryable: false);
          return;
        case AmooAskState.running:
        case AmooAskState.idle:
          if (s.reasoning.isNotEmpty) {
            yield DriverDelta(kind: 'reasoning', text: s.reasoning);
          }
          // 活动式等待（规则 3）：每次 poll 返回都是活动信号；预算由原生层
          // 夹持，这里不设硬 kill。attempt 计数就是给用户看的进度。
          yield DriverStatus(
            code: 'waiting',
            detail: 'amoo 思考中 · 第 $attempt 次轮询',
            attempt: attempt,
          );
          await Future.delayed(pollInterval);
      }
    }
  }

  @override
  Future<void> abort(String sessionId) => _gateway.stop();

  @override
  Future<void> dispose() async {}

  /// 重试这一句有没有意义。singleFlight/amooNotForeground/refused 的下一步
  /// 都不是「再发一次」——把它们标成 retryable，用户会被引导去反复撞同一堵墙。
  static bool _retryable(AmooAskFailure? code) {
    switch (code) {
      case AmooAskFailure.orphanCleared:
        return true; // 锁已释放，重发即可
      default:
        return false;
    }
  }
}
