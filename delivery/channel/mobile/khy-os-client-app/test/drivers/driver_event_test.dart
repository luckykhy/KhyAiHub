import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';

void main() {
  // DriverEvent 是 Render Layer 的唯一输入。这条组钉的是「事件词汇表是通用
  // 语义」：任何 driver 私有字段都不许出现在事件上——否则渲染层为了画某个
  // driver 的内容就得认识那个 driver，单向依赖当场破裂。
  group('DriverEvent 通用语义', () {
    test('七种事件可构造，且只带通用字段', () {
      final started = DriverStarted(sessionId: 's1', turnId: 't1');
      final delta = DriverDelta(kind: 'content', text: 'hello');
      final call = DriverToolCall(callId: 'c1', name: 'ls', args: {'path': '/sdcard'});
      final result = DriverToolResult(callId: 'c1', ok: true, summary: '3 entries');
      final status = DriverStatus(code: 'timed_out', detail: '等待 amoo 回复', attempt: 2);
      final finished = DriverFinished(turnId: 't1', reason: 'completed');
      final failed = DriverFailed(error: StateError('x'), retryable: true);

      expect(started.sessionId, 's1');
      expect(delta.text, 'hello');
      expect(call.args['path'], '/sdcard');
      expect(result.ok, true);
      // retryable 在 DriverFailed 上，DriverStatus 只有 code/detail/attempt
      // （§7 T7 判据按这个形状断言，改字段名会让判据失效）。
      expect(status.code, 'timed_out');
      expect(status.attempt, 2);
      expect(failed.retryable, true);
      expect(finished.reason, 'completed');
    });

    test('sealed 穷尽匹配覆盖全部七种', () {
      // 编译期保证：新增事件种类时所有 switch 都会被编译器点名。
      // 这条测试本身是运行期文档——它列出当前全集，加种类时这里编译失败，
      // 提醒作者同步渲染层。
      final events = <DriverEvent>[
        DriverStarted(sessionId: 's', turnId: 't'),
        DriverDelta(kind: 'content', text: 'x'),
        DriverToolCall(callId: 'c', name: 'n', args: {}),
        DriverToolResult(callId: 'c', ok: false, summary: ''),
        DriverStatus(code: 'waiting', detail: '', attempt: 0),
        DriverFinished(turnId: 't', reason: 'aborted'),
        DriverFailed(error: 'e', retryable: false),
      ];
      String kind(DriverEvent e) => switch (e) {
            DriverStarted() => 'started',
            DriverDelta() => 'delta',
            DriverToolCall() => 'tool_call',
            DriverToolResult() => 'tool_result',
            DriverStatus() => 'status',
            DriverFinished() => 'finished',
            DriverFailed() => 'failed',
          };
      expect(events.map(kind).toList(), [
        'started',
        'delta',
        'tool_call',
        'tool_result',
        'status',
        'finished',
        'failed',
      ]);
    });
  });
}
