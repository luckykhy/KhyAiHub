// WeChat task orchestration: inbound text in, AgentLoop run, honest progress
// out, every tool step into the trajectory store.
//
// The runner consumes the transport facade (WS1's lib/core/ilink/ bot protocol
// layer implements it; until that lands the composition root wires a fake or
// the real one into the same three-member contract below). Everything here is
// transport-agnostic on purpose.
import 'dart:async';
import 'dart:collection';

import '../agent/agent_loop.dart';
import '../agent/checker_agent.dart';
import '../agent/execution_log.dart';
import '../agent/tool_verdict.dart';
import '../config/app_config.dart';
import '../services/trajectory_store.dart';
import '../tools/builtin_tools.dart';
import '../tools/vision_tools.dart';
import '../trajectory/trace_envelope.dart';
import 'wechat_approval_bridge.dart';
import 'wechat_command_router.dart';
import 'wechat_progress_reporter.dart';

/// One inbound WeChat text message.
class WechatInboundMessage {
  final String contextToken;

  /// ilink account of the sender — the allowlist key.
  final String senderId;
  final String messageId;
  final String text;
  final DateTime receivedAt;

  const WechatInboundMessage({
    required this.contextToken,
    required this.senderId,
    required this.messageId,
    required this.text,
    required this.receivedAt,
  });
}

/// The transport facade this layer consumes. Kept to three members so WS1's
/// real protocol layer can drop in without touching anything above it.
abstract class WechatTransport {
  /// Inbound text messages in arrival order.
  Stream<WechatInboundMessage> get inbound;

  /// Push one message to the conversation the token names.
  Future<void> send(String contextToken, String text);
}

/// 进度/结果/审批事件的去处。抽这个口子的原因：本地任务（悬浮窗/副屏提交）
/// 与微信任务共用同一条 AgentLoop 管线与同一把锁，但播报面不同——微信走
/// WechatProgressReporter（20s 节流 + 2048 分块），本地写 task_state.json
/// （OverlayTaskSink，lib/core/floating/）。_execute 只认本接口。
abstract class TaskSink {
  Future<void> taskStarted(String taskText);

  Future<void> onExecuting(AgentStep step, {required int stepNo});

  Future<void> onReflecting(AgentStep step, ToolVerdict verdict,
      {required int stepNo});

  Future<void> onFinal(String text);

  Future<void> onRunFailed(String reason);

  /// 用户放弃等待（AgentLoop 无中断通道，语义=放弃等待而非终止）。
  /// 微信侧不再多嘴（router 已回过话），本地侧要把诚实说明写进状态文件。
  Future<void> onAbandoned();
}

/// WeChat 来源的 TaskSink：把 _execute 的事件原样转给 reporter。
/// 行为零变化——分块、节流与措辞都还在 reporter 里，这里只转发。
class WechatTaskSink implements TaskSink {
  WechatTaskSink(this._reporter, this._contextToken);

  final WechatProgressReporter _reporter;
  final String _contextToken;

  @override
  Future<void> taskStarted(String taskText) =>
      _reporter.taskStarted(_contextToken, taskText);

  @override
  Future<void> onExecuting(AgentStep step, {required int stepNo}) =>
      _reporter.onExecuting(_contextToken, step, stepNo: stepNo);

  @override
  Future<void> onReflecting(AgentStep step, ToolVerdict verdict,
          {required int stepNo}) =>
      _reporter.onReflecting(_contextToken, step, verdict, stepNo: stepNo);

  @override
  Future<void> onFinal(String text) => _reporter.onFinal(_contextToken, text);

  @override
  Future<void> onRunFailed(String reason) =>
      _reporter.onRunFailed(_contextToken, reason);

  @override
  Future<void> onAbandoned() async {
    // router 的 /stop 回执已经说过「后台步骤可能仍在跑」，不重复。
  }
}

/// Process-wide single-task lock, aligned with the PC daemon's
/// ilinkExecutionLock.js (module singleton, one holder at a time). Unlike the
/// PC queue it refuses instead of FIFO-queueing: a WeChat user sitting in a
/// silent queue cannot tell their message was swallowed, so the runner replies
/// with the current progress and takes nothing new.
class WechatExecutionLock {
  static final WechatExecutionLock instance = WechatExecutionLock._();

  WechatExecutionLock._();

  WechatRunHandle? _holder;

  bool get isBusy => _holder != null;

  bool tryAcquire(WechatRunHandle handle) {
    if (_holder != null) return false;
    _holder = handle;
    return true;
  }

  void release(WechatRunHandle handle) {
    if (identical(_holder, handle)) _holder = null;
  }
}

/// One admitted task, from admit to release. The runner and the router read it
/// for /status and busy replies.
class WechatRunHandle {
  final String conversationId;
  final String contextToken;
  final String taskText;

  /// 0-based loop iteration; displayed +1 against maxSteps.
  int currentStep = 0;
  String? lastTool;
  bool abandoned = false;
  bool finished = false;

  WechatRunHandle({
    required this.conversationId,
    required this.contextToken,
    required this.taskText,
  });
}

class WechatTaskRunner {
  WechatTaskRunner({
    required WechatTransport transport,
    required Future<AppConfigData> Function() loadConfig,
    this.allowedSenders = const <String>{},
    WechatApprovalBridge? approvalBridge,
    ApprovalGatedToolEngine Function(ApprovalChannel approval)?
        engineFactory,
    this.trajectoryStore,
    WechatProgressReporter? reporter,
    WechatCommandRouter? router,
    int recentLogCapacity = 10,
  })  : transport = transport,
        _configLoader = loadConfig,
        approvalBridge = approvalBridge ??
            WechatApprovalBridge(
              sendPrompt: (token, text) => transport.send(token, text),
            ),
        reporter = reporter ??
            WechatProgressReporter(
              send: (token, text) => transport.send(token, text),
            ),
        router = router ??
            WechatCommandRouter(
              send: (token, text) => transport.send(token, text),
            ),
        _maxRecentLogs = recentLogCapacity {
    _engineFactory = engineFactory ?? _defaultEngineFactory;
    // `router` here is the nullable parameter (it shadows the field); the
    // wiring must land on the field regardless of which one was constructed.
    this.router.statusSnapshot ??= _statusLine;
    this.router.stopCurrent ??= _stopCurrent;
    this.router.recentSummaries ??= _recordSummaries;
  }

  final WechatTransport transport;
  final Set<String> allowedSenders;
  final WechatApprovalBridge approvalBridge;
  final TrajectoryStore? trajectoryStore;
  final WechatProgressReporter reporter;
  final WechatCommandRouter router;

  final Future<AppConfigData> Function() _configLoader;
  final int _maxRecentLogs;

  late final ApprovalGatedToolEngine Function(ApprovalChannel)
      _engineFactory;

  StreamSubscription<WechatInboundMessage>? _inboundSub;
  WechatRunHandle? _current;
  final Queue<ExecutionLog> _recentLogs = Queue<ExecutionLog>();

  /// The runner's tool face: the builtin tools plus the vision tools, all
  /// registered into the gating engine so ask-level declarations actually ask.
  static ApprovalGatedToolEngine _defaultEngineFactory(
      ApprovalChannel approval) {
    final engine = ApprovalGatedToolEngine(approval: approval);
    engine.registerAll(createBuiltinTools());
    engine.registerAll(createVisionTools());
    return engine;
  }

  void start() {
    _inboundSub ??= transport.inbound.listen(_enqueue);
  }

  Future<void> dispose() async {
    await _inboundSub?.cancel();
    _inboundSub = null;
  }

  // ── inbound plumbing ──────────────────────────────────────────────────────

  final Queue<WechatInboundMessage> _inbox = Queue<WechatInboundMessage>();
  bool _draining = false;

  /// Inbound is processed strictly one at a time. Without this, a second
  /// message delivered while the first is still awaiting its command probe
  /// could slip past the busy check and start a second concurrent run.
  void _enqueue(WechatInboundMessage msg) {
    _inbox.add(msg);
    if (_draining) return;
    _draining = true;
    unawaited(_drain());
  }

  Future<void> _drain() async {
    try {
      while (_inbox.isNotEmpty) {
        final msg = _inbox.removeFirst();
        await _onMessage(msg);
      }
    } finally {
      _draining = false;
    }
  }

  Future<void> _onMessage(WechatInboundMessage msg) async {
    if (!allowedSenders.contains(msg.senderId)) {
      // Strict mode, same default as the PC daemon: unlisted peers are refused
      // outright (ilinkDispatcher.js:685 — ILINK_ALLOW_UNLISTED defaults off).
      await transport.send(msg.contextToken, '本账号不在允许名单，已拒绝执行');
      return;
    }
    if (approvalBridge.resolveInbound(msg.text)) return;
    if (parsePermissionReply(msg.text) != null) {
      await transport.send(msg.contextToken, '当前没有待批准的操作');
      return;
    }
    if (await router.handle(msg.contextToken, msg.text)) return;

    final lock = WechatExecutionLock.instance;
    if (lock.isBusy) {
      await transport.send(msg.contextToken, _busyReply());
      return;
    }
    _admit(msg);
  }

  void _admit(WechatInboundMessage msg) {
    final handle = WechatRunHandle(
      conversationId: 'wechat-${msg.senderId}-${msg.messageId}',
      contextToken: msg.contextToken,
      taskText: msg.text,
    );
    if (!WechatExecutionLock.instance.tryAcquire(handle)) {
      unawaited(transport.send(msg.contextToken, _busyReply()));
      return;
    }
    _current = handle;
    approvalBridge.activeContextToken = msg.contextToken;
    unawaited(_execute(
        handle, WechatTaskSink(reporter, msg.contextToken), approvalBridge));
  }

  // ── 本地任务入口（悬浮窗/副屏提交，不占微信通道） ─────────────────────────

  /// 本地来源任务与微信任务共用同一条管线与同一把进程级锁。锁被占时返回
  /// 诚实的拒绝文案（含当前进度摘要），不排队——理由与微信忙时拒收相同：
  /// 静默排队等于吞掉用户的指令。返回空串 = 已受理，进度走 [sink]。
  Future<String> submitLocal(
    String text, {
    required TaskSink sink,
    required ApprovalChannel approval,
  }) async {
    final task = text.trim();
    if (task.isEmpty) return '指令是空的，先写点什么再发送';
    final handle = WechatRunHandle(
      conversationId: 'local-${DateTime.now().millisecondsSinceEpoch}',
      contextToken: '',
      taskText: task,
    );
    if (!WechatExecutionLock.instance.tryAcquire(handle)) {
      return _localBusyReply();
    }
    _current = handle;
    unawaited(_execute(handle, sink, approval));
    return '';
  }

  String _localBusyReply() {
    final status = _statusLine();
    return '已有任务在跑${status == null ? '' : '：$status'}。'
        '等它结束或先停止当前任务，再发新的';
  }

  /// 放弃等待当前任务（微信 /stop 与悬浮窗/副屏停止按钮共用）。
  /// AgentLoop 没有中断通道：这只放弃等待，不终止——各入口的文案自己说清。
  Future<bool> stopCurrentTask() => _stopCurrent();

  // ── the run itself ────────────────────────────────────────────────────────

  Future<void> _execute(
      WechatRunHandle handle, TaskSink sink, ApprovalChannel approval) async {
    final execLog = ExecutionLog(
      conversationId: handle.conversationId,
      userMessage: handle.taskText,
    );
    var contradictedCount = 0;
    var sawTerminal = false;
    StreamIterator<AgentStep>? iterator;
    try {
      final config = await _configLoader();
      final engine = _engineFactory(approval);
      final loop = AgentLoop(engine: engine, config: config);
      // Pull-based iteration, not await-for: the abandon flag has to be
      // checked between steps, because /stop can only drop the listening side
      // (AgentLoop has no interrupt; local_driver.dart's abort says the same).
      iterator = StreamIterator<AgentStep>(loop.run(handle.taskText));
      await sink.taskStarted(handle.taskText);

      var more = true;
      while (more && !handle.abandoned) {
        more = await iterator.moveNext();
        if (!more) break;
        final step = iterator.current;
        handle.currentStep = step.step;

        switch (step.phase) {
          case AgentPhase.planning:
            break;
          case AgentPhase.executing:
            execLog.addStep(
                step.toolName ?? 'unknown', step.toolArgs ?? const {});
            handle.lastTool = step.toolName;
            await sink.onExecuting(step, stepNo: step.step + 1);
            break;
          case AgentPhase.reflecting:
            final idx = execLog.steps.length - 1;
            final execStep = idx >= 0 ? execLog.steps[idx] : null;
            final result = step.toolResult;
            if (execStep != null && result != null) {
              if (result.success) {
                execStep.complete(result.output);
              } else {
                execStep.fail(result.output);
              }
            }
            final verdict = (result != null && step.toolName != null)
                ? ToolVerdictFactory.of(step.toolName!, result)
                : null;
            if (verdict != null) {
              if (verdict.verdict == CheckVerdict.contradicted) {
                contradictedCount++;
              }
              await sink.onReflecting(step, verdict, stepNo: step.step + 1);
            }
            await _appendStepTrajectory(
                handle, execLog, execStep, engine, step);
            break;
          case AgentPhase.complete:
            sawTerminal = true;
            var finalText = (step.thought ?? '').trim();
            if (finalText.isEmpty) finalText = '（模型没有给出文本结果）';
            if (contradictedCount > 0) {
              // The checker's rule, carried into the narration: an overturned
              // step must not read as done even when the model says so.
              finalText = '$finalText\n'
                  '注意：$contradictedCount 步被核对推翻，未计入已完成。';
            }
            execLog.finish(finalText);
            _rememberLog(execLog);
            await sink.onFinal(finalText);
            break;
          case AgentPhase.error:
            sawTerminal = true;
            final reason = step.error ?? '未知错误';
            execLog.fail(reason);
            _rememberLog(execLog);
            await sink.onRunFailed(reason);
            break;
        }
      }
      if (handle.abandoned) {
        // The wechat narration already happened in the router; the local sink
        // still needs the honest note written into the bus file.
        execLog.fail('用户放弃等待');
        _rememberLog(execLog);
        await sink.onAbandoned();
        sawTerminal = true;
      } else if (!sawTerminal) {
        execLog.fail('执行流中断');
        _rememberLog(execLog);
        await sink.onRunFailed('执行流中断');
      }
    } catch (e) {
      execLog.fail('执行异常: $e');
      _rememberLog(execLog);
      await sink.onRunFailed('执行异常: $e');
    } finally {
      final it = iterator;
      if (it != null) {
        if (handle.abandoned) {
          // Drop the listener without waiting for the in-flight step to
          // unwind, and free the lock at once so the next task is not held
          // hostage by a run nobody is watching any more.
          unawaited(it.cancel());
        } else {
          await it.cancel();
        }
      }
      WechatExecutionLock.instance.release(handle);
      _current = null;
      approvalBridge.activeContextToken = null;
      handle.finished = true;
    }
  }

  Future<void> _appendStepTrajectory(
    WechatRunHandle handle,
    ExecutionLog execLog,
    ExecutionStep? execStep,
    ApprovalGatedToolEngine engine,
    AgentStep step,
  ) async {
    final store = trajectoryStore;
    if (store == null || execStep == null) return;
    // One append per step: one JSONL line plus one chain link. Steps the gate
    // held are recorded quarantined — the store's contract for gate-held steps.
    final perStep = ExecutionLog(
      conversationId: handle.conversationId,
      userMessage: handle.taskText,
    );
    perStep.steps.add(execStep);
    final trust = engine.heldByGate(step.toolName ?? '')
        ? TraceTrust.quarantined
        : TraceTrust.verified;
    await store.appendExecutionLog(perStep, trust: trust);
  }

  void _rememberLog(ExecutionLog log) {
    while (_recentLogs.length >= _maxRecentLogs) {
      _recentLogs.removeFirst();
    }
    _recentLogs.addLast(log);
  }

  // ── router lookups ────────────────────────────────────────────────────────

  String? _statusLine() {
    final h = _current;
    if (h == null || h.finished) return null;
    final action =
        h.lastTool == null ? '正在规划下一步动作' : '上一个动作 ${h.lastTool}';
    return '第 ${h.currentStep + 1}/${AgentLoop.maxSteps} 步 · $action';
  }

  String _busyReply() {
    final status = _statusLine();
    return '已有任务在跑${status == null ? '' : '：$status'}。'
        '发 /stop 放弃等待当前任务，或等它结束后再发新任务';
  }

  Future<bool> _stopCurrent() async {
    final h = _current;
    if (h == null || h.finished) return false;
    h.abandoned = true;
    return true;
  }

  List<String> _recordSummaries(int max) {
    final out = <String>[];
    for (final log in _recentLogs.toList().reversed.take(max)) {
      out.add(router.clipSummary(log.toText()));
    }
    return out;
  }
}
