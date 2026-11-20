// Local-task face of the floating layer: OverlaySink (progress into the bus
// file) and OverlayApprovalChannel (ask-level approvals answered from the
// floating window / status screen instead of WeChat).
//
// WHY THE APPROVAL CHANNEL MUST BE SEPARATE. A local task's vision_tap has
// no WeChat conversation to ask in — routing its approval through the
// WeChat bridge would wait 120s for a y/n that nobody on that surface knows
// to give, then auto-deny: a manufactured failure. The channel is chosen
// per task source in the runner; WeChat tasks keep their bridge untouched.

import 'dart:async';

import '../../core/agent/agent_loop.dart';
import '../../core/agent/checker_agent.dart';
import '../../core/agent/tool_verdict.dart';
import '../../core/wechat/wechat_approval_bridge.dart';
import '../../core/wechat/wechat_task_runner.dart';
import 'floating_status_controller.dart';
import 'task_state.dart';

/// 从工具参数里挑一个人能读懂的目标词。vision_tap 是 target，exec_shell 是
/// command，顺序即优先级——第一个命中的就是「在批准什么」的答案。
const List<String> kApprovalTargetKeys = [
  'target',
  'command',
  'file_path',
  'filePath',
  'path',
  'url',
  'pattern',
  'query',
];

String approvalTarget(Map<String, dynamic> params, {int maxLen = 60}) {
  for (final k in kApprovalTargetKeys) {
    final v = params[k];
    if (v is String && v.trim().isNotEmpty) {
      final s = v.trim().replaceAll(RegExp(r'\s+'), ' ');
      return s.length <= maxLen ? s : '${s.substring(0, maxLen)}…';
    }
  }
  if (params.isEmpty) return '';
  final s = params.toString();
  return s.length <= maxLen ? s : '${s.substring(0, maxLen)}…';
}

String _oneLine(String text, [int maxLen = 90]) {
  final t = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (t.length <= maxLen) return t;
  return '${t.substring(0, maxLen)}…';
}

/// 本地任务（悬浮窗/副屏提交）的进度去处：每一步写 task_state.json。
/// 与 WechatTaskSink 同一契约（TaskSink），微信路径不经此类。
class OverlayTaskSink implements TaskSink {
  OverlayTaskSink(this._controller, {DateTime Function()? clock})
      : _clock = clock ?? FloatingStatusController.defaultClock;

  final FloatingStatusController _controller;
  final DateTime Function() _clock;

  int _localSeq = 0;

  @override
  Future<void> taskStarted(String taskText) async {
    _localSeq += 1;
    _controller.taskStarted(
      taskId: 'local-${_clock().millisecondsSinceEpoch}-$_localSeq',
      source: TaskSource.local,
      totalSteps: AgentLoop.maxSteps,
      lastAction: '开始执行（最多 ${AgentLoop.maxSteps} 步）：${_oneLine(taskText, 60)}',
    );
  }

  @override
  Future<void> onExecuting(AgentStep step, {required int stepNo}) async {
    final args = step.toolArgs ?? const <String, dynamic>{};
    final summary = args.isEmpty ? '' : _oneLine(args.toString(), 60);
    final action =
        '调用 ${step.toolName}${summary.isEmpty ? '' : '（$summary）'}';
    _controller.acting(stepNo: stepNo, lastAction: action);
  }

  @override
  Future<void> onReflecting(AgentStep step, ToolVerdict verdict,
      {required int stepNo}) async {
    final what = verdict.verdict == CheckVerdict.contradicted
        ? '${step.toolName} 被核对推翻'
        : '${step.toolName} 已回报（${verdict.userLabel}）';
    final output = _oneLine(step.toolResult?.output ?? '');
    _controller.reflecting(
      stepNo: stepNo,
      lastAction: '第 $stepNo/${AgentLoop.maxSteps} 步 · $what',
      stepText: '$what：$output',
    );
  }

  @override
  Future<void> onFinal(String text) async {
    _controller.finish(resultExcerpt: text);
  }

  @override
  Future<void> onRunFailed(String reason) async {
    _controller.finish(errorMessage: reason);
  }

  @override
  Future<void> onAbandoned() async {
    _controller.abandoned();
  }
}

/// 悬浮信箱审批通道：请求写进 task_state.json 的 pendingApproval，答案从
/// inbox.jsonl 回来（悬浮窗/副屏按钮）。120s 超时自动拒——与微信通道同一
/// 时限，沉默不能变成同意。超时对外回 timeout 而不是 deny：引擎给两者的
/// 文案不同（「等待授权超时已自动拒」vs「用户拒绝了」），没人回答时把话说
/// 成「用户拒绝」是在替用户签名。
class OverlayApprovalChannel implements ApprovalChannel {
  OverlayApprovalChannel({
    required FloatingStatusController controller,
    Duration timeout = kWechatPermissionTimeout,
  })  : _controller = controller,
        _timeout = timeout;

  final FloatingStatusController _controller;
  final Duration _timeout;

  Completer<WechatApprovalDecision>? _pending;
  String? _pendingId;

  /// 当前挂起的审批 id（副屏按钮与信箱回信都要带上它）。
  String? get pendingId => _pendingId;

  /// 信箱 {"approval":"y"|"n","id":...} 的落点。id 不匹配直接忽略——
  /// 悬浮窗上的旧回信不能落到新问题上。
  void resolve(String id, bool allow) {
    final pending = _pending;
    if (pending == null || id != _pendingId) return;
    _pending = null;
    _pendingId = null;
    _controller.approvalResolved();
    pending.complete(
        allow ? WechatApprovalDecision.allow : WechatApprovalDecision.deny);
  }

  @override
  Future<WechatApprovalDecision> request({
    required String toolName,
    required Map<String, dynamic> params,
    String? reasoning,
  }) async {
    if (_pending != null) return WechatApprovalDecision.deny;
    final completer = Completer<WechatApprovalDecision>();
    final id = 'ov-${DateTime.now().microsecondsSinceEpoch}';
    late final Timer timer;
    timer = Timer(_timeout, () {
      if (!identical(_pending, completer)) return;
      _pending = null;
      _pendingId = null;
      _controller.approvalResolved();
      if (!completer.isCompleted) {
        completer.complete(WechatApprovalDecision.timeout);
      }
    });
    _pending = completer;
    _pendingId = id;
    _controller.approvalRequested(PendingApprovalInfo(
      id: id,
      tool: toolName,
      target: approvalTarget(params),
    ));
    final decision = await completer.future;
    timer.cancel();
    return decision;
  }
}
