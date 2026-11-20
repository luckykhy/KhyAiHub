// khy-canary: Khy-20261113-004-P4LOC
import 'dart:async';

import 'package:khy_os_client/core/agent/agent_loop.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';

/// 本地 AgentLoop 的缝。
///
/// 为什么要有它：[AgentLoop] 吃 Dio 和模型端点，VM 测试里一样都碰不到；
/// 而 local driver 的映射规则（plan/execute/reflect/complete → 事件）正是
/// 最容易错又最该被钉死的那一半。
abstract class LocalAgentRunner {
  Stream<AgentStep> run(String userMessage);
}

/// 真机实现：包既有 [AgentLoop]（本机 Qwen3-VL 主链路）。
class AgentLoopRunner implements LocalAgentRunner {
  AgentLoopRunner(this._loop);
  final AgentLoop _loop;

  @override
  Stream<AgentStep> run(String userMessage) => _loop.run(userMessage);
}

/// local driver（§2.4）：本机 Qwen3-VL 的 AgentLoop → DriverEvent。
///
/// 它是「必须联网不得作为启动前提」的兜底：完全离线可用，工具调用经
/// ToolHostClient 同一注册表（driver 不直接执行工具）。
///
/// 映射表：planning → DriverStatus(waiting)；executing → DriverToolCall；
/// reflecting → DriverToolResult；complete → DriverDelta(thought)+Finished；
/// error → DriverFailed。
class LocalDriver implements Driver {
  LocalDriver({LocalAgentRunner? runner, AppConfigData? config, AgentLoop? loop})
      : _runner = runner ?? (loop != null ? AgentLoopRunner(loop) : null),
        _config = config ?? const AppConfigData(baseUrl: '', apiKey: '', model: '');

  final LocalAgentRunner? _runner;
  final AppConfigData _config;

  DriverHealth _health = DriverHealth.ok;

  @override
  String get id => 'local';

  @override
  bool get enabled => !_config.isDriverDisabled('local');

  @override
  DriverHealth health() => _health;

  @override
  Future<void> openSession(String sessionId, SessionContext ctx) async {
    // 无预热：禁用的 driver 不走这里（registry 已拦）；启用了也不该在
    // 打开会话时就加载模型——那是数秒到数十秒的盘 IO，该发生在第一次
    // send 里，并由 DriverStatus 报告进度。
  }

  @override
  Stream<DriverEvent> send(UserTurn turn) async* {
    final runner = _runner;
    if (runner == null) {
      yield DriverFailed(error: StateError('local driver 未接 AgentLoop'), retryable: false);
      return;
    }
    yield DriverStatus(code: 'waiting', detail: '本机模型推理', attempt: 0);

    var callSeq = 0;
    try {
      await for (final step in runner.run(turn.text)) {
        switch (step.phase) {
          case AgentPhase.planning:
            yield DriverStatus(
              code: 'waiting',
              detail: '规划下一步（第 ${step.step + 1} 步）',
              attempt: step.step + 1,
            );
          case AgentPhase.executing:
            final callId = 'call_${turn.turnId}_${callSeq++}';
            yield DriverToolCall(
              callId: callId,
              name: step.toolName ?? '',
              args: step.toolArgs ?? const {},
            );
          case AgentPhase.reflecting:
            final r = step.toolResult;
            yield DriverToolResult(
              callId: 'call_${turn.turnId}_${callSeq - 1 < 0 ? 0 : callSeq - 1}',
              ok: r?.success ?? false,
              summary: r?.output ?? '',
            );
          case AgentPhase.complete:
            final thought = step.thought ?? '';
            if (thought.isNotEmpty) {
              yield DriverDelta(kind: 'content', text: thought);
            }
            yield DriverFinished(turnId: turn.turnId, reason: 'completed');
            return;
          case AgentPhase.error:
            _health = DriverHealth.down;
            yield DriverFailed(error: step.error ?? '本机推理失败', retryable: false);
            return;
        }
      }
      // 流自然结束没有 complete：不算成功（同 pc-bridge 的语义）。
      _health = DriverHealth.down;
      yield DriverFailed(error: '推理流中断：未收到完成步骤', retryable: true);
    } catch (e) {
      _health = DriverHealth.down;
      yield DriverFailed(error: e, retryable: false);
    }
  }

  @override
  Future<void> abort(String sessionId) async {
    // AgentLoop 无中断通道（Dio 请求不可取消到步）；丢弃监听即止。
  }

  @override
  Future<void> dispose() async {}
}
