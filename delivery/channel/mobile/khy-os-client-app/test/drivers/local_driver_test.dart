import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/agent_loop.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/drivers/local_driver.dart';
import 'package:khy_os_client/core/toolhost/tool_host_client.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

/// 假 AgentLoop：脚本化步骤序列，不碰 Dio、不碰模型文件。
class _FakeRunner implements LocalAgentRunner {
  _FakeRunner(this.script);
  final List<AgentStep> script;
  int calls = 0;
  Object? thrown;

  @override
  Stream<AgentStep> run(String userMessage) async* {
    calls++;
    if (thrown != null) throw thrown!;
    for (final s in script) {
      yield s;
    }
  }
}

AgentStep _step(AgentPhase phase,
    {String? thought, String? toolName, Map<String, dynamic>? toolArgs, ToolResult? toolResult, String? error}) {
  // AgentStep 的字段集以 agent_loop.dart 为准；这里只摆映射用得到的几个。
  return AgentStep(
    step: 0,
    phase: phase,
    thought: thought,
    toolName: toolName,
    toolArgs: toolArgs,
    toolResult: toolResult,
    error: error,
  );
}

void main() {
  // local driver 的映射（§2.4）：AgentLoop 的 plan/execute/reflect/complete
  // → DriverEvent。local 是「必须联网不得作为启动前提」的兜底，它的会话
  // 路径因此必须与 amoo/pc-bridge 走同一份事件词汇表。
  group('LocalDriver 事件映射', () {
    test('工具调用与结果分别成事件，完成时正文收尾', () async {
      final runner = _FakeRunner([
        _step(AgentPhase.planning, thought: '先看看目录'),
        _step(AgentPhase.executing, thought: '先看看目录', toolName: 'ls', toolArgs: {'path': '/sdcard'}),
        _step(AgentPhase.reflecting, thought: '先看看目录', toolName: 'ls', toolArgs: {'path': '/sdcard'},
            toolResult: ToolResult.ok('3 entries')),
        _step(AgentPhase.complete, thought: '目录里有三个文件'),
      ]);
      final d = LocalDriver(runner: runner);

      final events = await d
          .send(const UserTurn(sessionId: 's', turnId: 't', text: '看看下载目录'))
          .toList();

      final calls = events.whereType<DriverToolCall>().toList();
      final results = events.whereType<DriverToolResult>().toList();
      expect(calls.length, 1);
      expect(calls.single.name, 'ls');
      expect(results.single.ok, true);
      expect(results.single.summary, contains('3 entries'));
      final content = events.whereType<DriverDelta>().where((e) => e.kind == 'content').toList();
      expect(content.single.text, '目录里有三个文件');
      expect(events.last, isA<DriverFinished>());
    });

    test('error 步骤转 DriverFailed，不冒泡', () async {
      final runner = _FakeRunner([
        _step(AgentPhase.planning),
        _step(AgentPhase.error, error: 'LLM 调用失败'),
      ]);
      final d = LocalDriver(runner: runner);
      final events = await d.send(const UserTurn(sessionId: 's', turnId: 't', text: 'q')).toList();
      final failed = events.whereType<DriverFailed>().single;
      expect(failed.error.toString(), contains('LLM 调用失败'));
      expect(events.whereType<DriverFinished>().length, 0);
    });

    test('跑到最大步数也算完成（complete 步骤带说明）', () async {
      final runner = _FakeRunner([
        _step(AgentPhase.complete, thought: '已达到最大步骤数 (15)，任务可能未完全完成。'),
      ]);
      final d = LocalDriver(runner: runner);
      final events = await d.send(const UserTurn(sessionId: 's', turnId: 't', text: 'q')).toList();
      expect(events.last, isA<DriverFinished>());
      final content = events.whereType<DriverDelta>().where((e) => e.kind == 'content').single;
      expect(content.text, contains('最大步骤数'));
    });

    test('禁用后 enabled=false，且 openSession 零调用 runner', () async {
      final runner = _FakeRunner(const []);
      final d = LocalDriver(
        runner: runner,
        config: const AppConfigData(baseUrl: '', apiKey: '', model: 'm')
            .copyWith(disabledDrivers: const ['local']),
      );
      expect(d.enabled, false);
      await d.openSession('s', SessionContext(tools: _StubHost()));
      expect(runner.calls, 0, reason: '禁用的 driver 不做任何预热（T1）');
    });
  });
}

class _StubHost implements ToolHostClient {
  @override
  List<CapabilityEntry> capabilities() => const [];
  @override
  Future<ToolResult> invoke(String name, Map<String, Object?> args, {String? callId}) async =>
      ToolResult.ok('');
}
