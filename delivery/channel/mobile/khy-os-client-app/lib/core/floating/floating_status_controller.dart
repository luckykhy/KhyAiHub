// Floating status controller: the state machine + broadcaster for the
// currently tracked task, plus the floating mailbox consumer.
//
// Three consumers, one snapshot:
//   - the Android overlay (TaskStatusOverlayService) polls the JSON file;
//   - the in-app status screen subscribes to the direct feed (same isolate,
//     no file round-trip);
//   - tests inject fakes through TaskStateFeed, never the real filesystem.
//
// The inbox (`floating/inbox.jsonl`) is the reverse direction: the overlay
// appends lines, Dart tails them by byte offset. Tailing — not re-reading —
// is the primary dedupe: a line consumed once is below the offset forever.
// The atMs+kind signature set is the second guard for truncated rewrites,
// where offsets reset but old lines must not re-fire.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../core/agent/agent_loop.dart';
import 'task_state.dart';

/// The status screen's data source.
abstract class TaskStateFeed {
  Stream<TaskSnapshot> get stream;
}

/// 直接推流：控制器每次落盘的同时把快照推给订阅者。副屏在主 isolate 里
/// 用它——文件轮询只服务于跨语言消费方（Kotlin）与降级场景。
class DirectTaskStateFeed implements TaskStateFeed {
  DirectTaskStateFeed(Stream<TaskSnapshot> source) : _source = source;

  final Stream<TaskSnapshot> _source;

  @override
  Stream<TaskSnapshot> get stream => _source;
}

/// 文件轮询流：1s 一拍读 task_state.json，updatedAtMs 没变不发。没有文件时
/// 静默。给测试与副屏降级路径用（真悬浮窗在 Kotlin 侧读同一个文件）。
class FilePollTaskStateFeed implements TaskStateFeed {
  FilePollTaskStateFeed(File file,
      {this.interval = const Duration(seconds: 1)})
      : _store = TaskStateStore(file);

  final TaskStateStore _store;
  final Duration interval;

  Timer? _timer;
  int? _lastUpdatedAtMs;
  final _controller = StreamController<TaskSnapshot>.broadcast();

  @override
  Stream<TaskSnapshot> get stream => _controller.stream;

  void start() {
    _timer ??= Timer.periodic(interval, (_) => _tick());
  }

  Future<void> dispose() async {
    _timer?.cancel();
    _timer = null;
    await _controller.close();
  }

  void _tick() {
    final snap = _store.read();
    if (snap == null) return;
    if (_lastUpdatedAtMs != null && snap.updatedAtMs == _lastUpdatedAtMs) {
      return;
    }
    _lastUpdatedAtMs = snap.updatedAtMs;
    if (!_controller.isClosed) _controller.add(snap);
  }
}

/// One consumed inbox line, already classified.
sealed class FloatingInboxEvent {
  const FloatingInboxEvent();
}

class FloatingInboxText extends FloatingInboxEvent {
  const FloatingInboxText(this.text);
  final String text;
}

class FloatingInboxStop extends FloatingInboxEvent {
  const FloatingInboxStop();
}

/// 悬浮窗页脚「打开任务副屏」的信号。原生的 startActivity 只负责把 App 带
/// 到前台；导航到副屏这一步由 Dart 侧完成（hub 的 handler），否则 Kotlin
/// 就得知道 Flutter 的页面栈——那不是它的职责。
class FloatingInboxOpenStatus extends FloatingInboxEvent {
  const FloatingInboxOpenStatus();
}

class FloatingInboxApproval extends FloatingInboxEvent {
  const FloatingInboxApproval({required this.id, required this.allow});
  final String id;
  final bool allow;
}

/// Tails `<docs>/floating/inbox.jsonl`. The overlay appends
/// `{"text":...}` / `{"cmd":"stop"}` / `{"approval":"y"|"n","id":...}` lines;
/// this watcher turns new bytes into [FloatingInboxEvent]s.
class FloatingInboxWatcher {
  FloatingInboxWatcher(this.file, {this.interval = const Duration(seconds: 1)});

  final File file;
  final Duration interval;

  Timer? _timer;
  int _offset = 0;
  final Set<String> _seenSignatures = <String>{};
  final _controller = StreamController<FloatingInboxEvent>.broadcast();

  Stream<FloatingInboxEvent> get events => _controller.stream;

  void start() {
    _timer ??= Timer.periodic(interval, (_) => _tick());
  }

  Future<void> dispose() async {
    _timer?.cancel();
    _timer = null;
    await _controller.close();
  }

  void _tick() {
    List<String> lines;
    try {
      if (!file.existsSync()) return;
      final bytes = file.readAsBytesSync();
      if (bytes.length < _offset) {
        // 整文件被重写（截断替换）：从头再来，签名集兜底去重。
        _offset = 0;
        if (_seenSignatures.length > 64) _seenSignatures.clear();
      } else if (bytes.length == _offset) {
        return;
      }
      final chunk = utf8.decode(bytes.sublist(_offset), allowMalformed: true);
      _offset = bytes.length;
      lines = chunk.split('\n');
    } catch (_) {
      return;
    }
    for (var line in lines) {
      final t = line.trim();
      if (t.isEmpty) continue;
      final event = _parse(t);
      if (event != null && !_controller.isClosed) _controller.add(event);
    }
  }

  FloatingInboxEvent? _parse(String line) {
    Object? raw;
    try {
      raw = jsonDecode(line);
    } catch (_) {
      return null;
    }
    if (raw is! Map) return null;
    // 签名去重：同一行被写两遍（悬浮窗补写、offset 回退重放）只算一次。
    final sig = '${raw['cmd'] ?? raw['approval'] ?? 't'}|${raw['atMs'] ?? ''}'
        '|${raw['id'] ?? ''}|${raw['text'] ?? ''}';
    if (!_seenSignatures.add(sig)) return null;

    if (raw['cmd'] == 'stop') return const FloatingInboxStop();
    if (raw['cmd'] == 'openStatus') return const FloatingInboxOpenStatus();
    final approval = raw['approval'];
    if (approval is String && approval.isNotEmpty) {
      final id = raw['id'];
      if (id is! String || id.isEmpty) return null;
      return FloatingInboxApproval(
        id: id,
        allow: approval == 'y' || approval == 'Y',
      );
    }
    final text = raw['text'];
    if (text is String && text.trim().isNotEmpty) {
      return FloatingInboxText(text.trim());
    }
    return null;
  }
}

/// The controller: owns the current snapshot, persists every transition to
/// the bus file and pushes it to the direct feed. A status write that fails
/// is swallowed here — never thrown into the run it is describing.
class FloatingStatusController {
  FloatingStatusController(
      {required TaskStateStore store, DateTime Function()? now})
      : _store = store,
        _now = now ?? defaultClock;

  /// 缺省时钟单独命名，不写成 `?? () => ...`：初始化列表里那个形式
  /// Dart 3.13 解析不出来（`() =>` 会被当成构造器的 return）。
  static DateTime defaultClock() => DateTime.now();

  /// 步骤列表上限。Maeve 参考效果里展开态只留最近几步，8 条一屏可读。
  static const int maxSteps = 8;

  /// 结果摘录上限：文件是悬浮窗每秒读的，结果再长也只进这一段。
  static const int resultExcerptMax = 600;

  final TaskStateStore _store;
  final DateTime Function() _now;

  TaskSnapshot _current = const TaskSnapshot(phase: TaskPhase.idle);

  final _streamController = StreamController<TaskSnapshot>.broadcast();

  /// 直接推流（副屏订阅）。不订阅也照常落盘——文件才是悬浮窗的总线。
  Stream<TaskSnapshot> get stream => _streamController.stream;

  /// 测试与副屏降级用：不经流、直接读当前快照。
  TaskSnapshot get current => _current;

  Future<void> dispose() async {
    await _streamController.close();
  }

  void _emit(TaskSnapshot next) {
    _current = next;
    _store.write(next);
    if (!_streamController.isClosed) _streamController.add(next);
  }

  /// 落一份新快照：只换 phase 与时间戳，其余字段原样。
  TaskSnapshot _bump(TaskPhase phase) {
    final c = _current;
    return TaskSnapshot(
      phase: phase,
      taskId: c.taskId,
      source: c.source,
      stepIndex: c.stepIndex,
      totalSteps: c.totalSteps,
      lastAction: c.lastAction,
      thinkingHint: c.thinkingHint,
      startedAtMs: c.startedAtMs,
      updatedAtMs: _stamp(),
      steps: c.steps,
      pendingApproval: c.pendingApproval,
      lastResultExcerpt: c.lastResultExcerpt,
      errorMessage: c.errorMessage,
      lastScreenshotPath: c.lastScreenshotPath,
      floatingEnabled: c.floatingEnabled,
    );
  }

  /// 任务开始。上一份 idle 快照里留给悬浮窗看的结果摘录在此清零。
  void taskStarted({
    required String taskId,
    required TaskSource source,
    int totalSteps = AgentLoop.maxSteps,
    required String lastAction,
    String? thinkingHint,
  }) {
    final now = _stamp();
    _emit(TaskSnapshot(
      phase: TaskPhase.thinking,
      taskId: taskId,
      source: source,
      totalSteps: totalSteps,
      lastAction: lastAction,
      thinkingHint: thinkingHint ?? '',
      startedAtMs: now,
      updatedAtMs: now,
    ));
  }

  /// 模型在规划/思考。hint 取模型思考流尾部（「在想下一步」的实感来源）。
  void thinking({String? hint}) {
    final c = _current;
    final next = _bump(TaskPhase.thinking);
    _emit(TaskSnapshot(
      phase: TaskPhase.thinking,
      taskId: next.taskId,
      source: next.source,
      stepIndex: next.stepIndex,
      totalSteps: next.totalSteps,
      lastAction: next.lastAction,
      thinkingHint: (hint == null || hint.isEmpty) ? c.thinkingHint : hint,
      startedAtMs: next.startedAtMs,
      updatedAtMs: next.updatedAtMs,
      steps: next.steps,
      pendingApproval: next.pendingApproval,
      lastResultExcerpt: next.lastResultExcerpt,
      errorMessage: next.errorMessage,
      lastScreenshotPath: next.lastScreenshotPath,
      floatingEnabled: next.floatingEnabled,
    ));
  }

  void acting({
    required int stepNo,
    required String lastAction,
    String? stepText,
  }) {
    final steps = _withStep(TaskStepRecord(
        text: stepText ?? lastAction, atMs: _stamp(), kind: TaskStepKind.act));
    _emit(_replace(phase: TaskPhase.acting,
        stepIndex: stepNo, lastAction: lastAction, steps: steps));
  }

  void reflecting({
    required int stepNo,
    required String lastAction,
    String? stepText,
  }) {
    final steps = _withStep(TaskStepRecord(
        text: stepText ?? lastAction,
        atMs: _stamp(),
        kind: TaskStepKind.result));
    _emit(_replace(phase: TaskPhase.reflecting,
        stepIndex: stepNo, lastAction: lastAction, steps: steps));
  }

  /// ask 工具要批准。答案经信箱回来（悬浮窗/副屏的批准与拒绝按钮）。
  void approvalRequested(PendingApprovalInfo approval) {
    _emit(_replace(
      phase: TaskPhase.awaitingApproval,
      lastAction: '等待批准 ${approval.tool}（目标：${approval.target}）',
      pendingApproval: approval,
    ));
  }

  void approvalResolved() {
    // 显式构造而不是走 _replace：那里对 pendingApproval 是「不传就保留」，
    // 只有这里需要真的清空。
    final c = _current;
    _emit(TaskSnapshot(
      phase: TaskPhase.acting,
      taskId: c.taskId,
      source: c.source,
      stepIndex: c.stepIndex,
      totalSteps: c.totalSteps,
      lastAction: c.lastAction,
      thinkingHint: c.thinkingHint,
      startedAtMs: c.startedAtMs,
      updatedAtMs: _stamp(),
      steps: c.steps,
      pendingApproval: null,
      lastResultExcerpt: c.lastResultExcerpt,
      errorMessage: c.errorMessage,
      lastScreenshotPath: c.lastScreenshotPath,
      floatingEnabled: c.floatingEnabled,
    ));
  }

  /// 正常收尾（done / error）。写终态后立刻补一份 idle——「收尾写 idle」，
  /// 悬浮窗靠它收起；副屏在流上先看到 done/error 再看到 idle。
  void finish({String? resultExcerpt, String? errorMessage}) {
    final excerpt = _clip(resultExcerpt ?? '', resultExcerptMax);
    final failed = errorMessage != null && errorMessage.isNotEmpty;
    _emit(_replace(
      phase: failed ? TaskPhase.error : TaskPhase.done,
      lastResultExcerpt: excerpt,
      errorMessage: errorMessage ?? '',
      lastAction: failed ? '任务失败' : '任务完成',
    ));
    idle();
  }

  /// 用户放弃等待（stop）。AgentLoop 没有中断通道，文案必须说真话：
  /// 放弃的是等待，不是任务。
  void abandoned() {
    _emit(_replace(
      phase: TaskPhase.error,
      errorMessage: '已放弃等待，任务未真正终止（AgentLoop 不支持中断，后台步骤可能仍在跑）',
      lastAction: '已放弃等待',
    ));
    idle();
  }

  /// 回到 idle（悬浮窗收起）。保留 steps 与结果摘录，供收起前最后一眼。
  void idle() {
    final c = _current;
    _emit(TaskSnapshot(
      phase: TaskPhase.idle,
      taskId: c.taskId,
      source: c.source,
      stepIndex: c.stepIndex,
      totalSteps: c.totalSteps,
      lastAction: c.lastAction,
      startedAtMs: c.startedAtMs,
      updatedAtMs: _stamp(),
      steps: c.steps,
      lastResultExcerpt: c.lastResultExcerpt,
      errorMessage: c.errorMessage,
      lastScreenshotPath: c.lastScreenshotPath,
      floatingEnabled: c.floatingEnabled,
    ));
  }

  /// 最新截图缩略图落盘后由悬浮层回填路径。fire-and-forget：写失败不影响任务。
  void setScreenshot(String path) {
    if (path.isEmpty || path == _current.lastScreenshotPath) return;
    _emit(_replace(lastScreenshotPath: path));
  }

  /// 开关镜像变化（设置页切换悬浮开关时）。
  void setFloatingEnabled(bool enabled) {
    final c = _current;
    _emit(TaskSnapshot(
      phase: c.phase,
      taskId: c.taskId,
      source: c.source,
      stepIndex: c.stepIndex,
      totalSteps: c.totalSteps,
      lastAction: c.lastAction,
      thinkingHint: c.thinkingHint,
      startedAtMs: c.startedAtMs,
      updatedAtMs: _stamp(),
      steps: c.steps,
      pendingApproval: c.pendingApproval,
      lastResultExcerpt: c.lastResultExcerpt,
      errorMessage: c.errorMessage,
      lastScreenshotPath: c.lastScreenshotPath,
      floatingEnabled: enabled,
    ));
  }

  /// 在当前快照上改若干字段、刷新时间戳后落盘。
  TaskSnapshot _replace({
    TaskPhase? phase,
    int? stepIndex,
    String? lastAction,
    String? thinkingHint,
    List<TaskStepRecord>? steps,
    PendingApprovalInfo? pendingApproval,
    String? lastResultExcerpt,
    String? errorMessage,
    String? lastScreenshotPath,
  }) {
    final c = _current;
    return TaskSnapshot(
      phase: phase ?? c.phase,
      taskId: c.taskId,
      source: c.source,
      stepIndex: stepIndex ?? c.stepIndex,
      totalSteps: c.totalSteps,
      lastAction: lastAction ?? c.lastAction,
      thinkingHint: thinkingHint ?? c.thinkingHint,
      startedAtMs: c.startedAtMs,
      updatedAtMs: _stamp(),
      steps: steps ?? c.steps,
      // 不传就保留：待批问题挂起期间其它字段照常更新，不能被顺手清掉。
      pendingApproval: pendingApproval ?? c.pendingApproval,
      lastResultExcerpt: lastResultExcerpt ?? c.lastResultExcerpt,
      errorMessage: errorMessage ?? c.errorMessage,
      lastScreenshotPath: lastScreenshotPath ?? c.lastScreenshotPath,
      floatingEnabled: c.floatingEnabled,
    );
  }

  /// 新步骤插到最前、截到 maxSteps。展开态从上往下读=最新在上。
  List<TaskStepRecord> _withStep(TaskStepRecord step) {
    final next = List<TaskStepRecord>.from(_current.steps)..insert(0, step);
    if (next.length > maxSteps) return next.sublist(0, maxSteps);
    return next;
  }

  int _stamp() => _now().millisecondsSinceEpoch;

  static String _clip(String s, int max) =>
      s.length <= max ? s : '${s.substring(0, max)}…(截断)';
}
