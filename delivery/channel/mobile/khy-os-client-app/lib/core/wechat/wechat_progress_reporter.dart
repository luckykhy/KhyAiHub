// WeChat-side narration of an agent run: one 动作+目标+进度 line per step,
// chunked delivery of the final text.
//
// Wording is held to engineering rule 2 (动作+目标+进度): every progress line
// names the action, the target and a step counter, and a step the checker
// overturned is never narrated as done — that distinction is why the reporter
// takes a ToolVerdict instead of re-deriving one.
import '../agent/agent_loop.dart';
import '../agent/checker_agent.dart';
import '../agent/tool_verdict.dart';

/// Outbound send primitive this layer pushes through. WS1's ilink facade
/// implements it over the real bot protocol; tests capture the calls.
typedef WechatSend = Future<void> Function(String contextToken, String text);

/// 2048 UTF-16 code units per outbound chunk — the plan's WeChat split size.
const int kWechatChunkSize = 2048;

/// Split [text] into WeChat-sized chunks without cutting a surrogate pair in
/// half: a lone half renders as U+FFFD and silently changes the message.
List<String> splitForWechat(String text) {
  if (text.isEmpty) return const <String>[];
  if (text.length <= kWechatChunkSize) return <String>[text];
  final out = <String>[];
  var start = 0;
  while (start < text.length) {
    var end = start + kWechatChunkSize;
    if (end >= text.length) {
      end = text.length;
    } else {
      final lead = text.codeUnitAt(end - 1);
      if (lead >= 0xD800 && lead <= 0xDBFF) end -= 1;
    }
    out.add(text.substring(start, end));
    start = end;
  }
  return out;
}

String _oneLine(String text, [int maxLen = 120]) {
  final t = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (t.length <= maxLen) return t;
  return '${t.substring(0, maxLen)}…(截断)';
}

class WechatProgressReporter {
  WechatProgressReporter({
    required this.send,
    this.minInterval = const Duration(seconds: 20),
    this.splitMessage = splitForWechat,
  });

  final WechatSend send;

  /// Floor between step messages. Reflecting (one message per step) always
  /// sends — the ask's throttle contract is "20s or one per step"; the final
  /// result and failures bypass the throttle entirely.
  final Duration minInterval;

  /// Injectable so the composition root can swap in WS1's own splitMessage;
  /// defaults to the local 2048 UTF-16 splitter.
  final List<String> Function(String) splitMessage;

  DateTime? _lastStepSentAt;

  bool _throttleAllows() {
    final last = _lastStepSentAt;
    if (last == null) return true;
    return DateTime.now().difference(last) >= minInterval;
  }

  Future<void> taskStarted(String contextToken, String taskText) async {
    await send(contextToken,
        '开始执行（最多 ${AgentLoop.maxSteps} 步）：${_oneLine(taskText)}');
    _lastStepSentAt = DateTime.now();
  }

  Future<void> onExecuting(
    String contextToken,
    AgentStep step, {
    required int stepNo,
  }) async {
    if (!_throttleAllows()) return;
    final args = step.toolArgs ?? const <String, dynamic>{};
    final summary = args.isEmpty ? '' : _oneLine(args.toString(), 80);
    await send(contextToken,
        '第 $stepNo/${AgentLoop.maxSteps} 步 · 调用 ${step.toolName}'
        '${summary.isEmpty ? '' : '（$summary）'}');
    _lastStepSentAt = DateTime.now();
  }

  Future<void> onReflecting(
    String contextToken,
    AgentStep step,
    ToolVerdict verdict, {
    required int stepNo,
  }) async {
    // 被推翻的步骤不得说成已完成：the verb follows the verdict, not the tool's
    // own success flag.
    final what = verdict.verdict == CheckVerdict.contradicted
        ? '${step.toolName} 被核对推翻'
        : '${step.toolName} 已回报（${verdict.userLabel}）';
    final output = step.toolResult?.output ?? '';
    await send(contextToken,
        '第 $stepNo/${AgentLoop.maxSteps} 步 · $what：${_oneLine(output)}');
    _lastStepSentAt = DateTime.now();
  }

  Future<void> onFinal(String contextToken, String text) async {
    final body =
        text.trim().isEmpty ? '（模型没有给出文本结果）' : text.trim();
    for (final chunk in splitMessage(body)) {
      await send(contextToken, chunk);
    }
    _lastStepSentAt = DateTime.now();
  }

  Future<void> onRunFailed(String contextToken, String reason) async {
    await send(contextToken,
        '任务执行失败：${_oneLine(reason, 160)}。可重发指令重试，或发「记录」查看已执行的步骤');
    _lastStepSentAt = DateTime.now();
  }
}
