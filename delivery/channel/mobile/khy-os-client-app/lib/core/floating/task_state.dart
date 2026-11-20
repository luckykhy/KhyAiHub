// Task state snapshot: the file-as-bus contract between the Dart side and
// every status consumer (Android overlay polls it from Kotlin, the in-app
// status screen reads the same shape).
//
// The file is the ONLY cross-language channel here — no MethodChannel, no
// plugin. Kotlin's org.json parser and this model must therefore agree on
// field names byte for byte; a rename here silently breaks the capsule, so
// the toJson keys are the contract, not an implementation detail.
//
// Writes are atomic (tmp + rename, same shape as IlinkJsonFileStore) because
// the reader polls every second while the writer can emit several updates
// per second: a torn read would surface as a JSON parse failure on the
// Kotlin side and look like "the overlay froze".

import 'dart:convert';
import 'dart:io';

/// Task lifecycle phase. Wire names are the JSON values — keep them in sync
/// with TaskStatusOverlayService's expectations.
enum TaskPhase {
  idle,
  thinking,
  acting,
  reflecting,
  awaitingApproval,
  done,
  error;

  String get wire => switch (this) {
        TaskPhase.idle => 'idle',
        TaskPhase.thinking => 'thinking',
        TaskPhase.acting => 'acting',
        TaskPhase.reflecting => 'reflecting',
        TaskPhase.awaitingApproval => 'awaiting_approval',
        TaskPhase.done => 'done',
        TaskPhase.error => 'error',
      };

  static TaskPhase of(String wire) => TaskPhase.values
      .firstWhere((p) => p.wire == wire, orElse: () => TaskPhase.idle);
}

/// Where a task came from. The overlay and the status screen badge on it;
/// approval routing depends on it too (WeChat y/n only serves wechat tasks).
enum TaskSource {
  wechat,
  local;

  String get wire => this == TaskSource.wechat ? 'wechat' : 'local';

  /// 中文标签，给副屏的来源 chip 用。
  String get label => this == TaskSource.wechat ? '微信' : '悬浮窗';

  static TaskSource of(String? wire) =>
      wire == 'wechat' ? TaskSource.wechat : TaskSource.local;
}

/// One line in the running step list. [kind] separates what the model is
/// doing (act/think) from what a tool came back with (result) — the overlay
/// highlights the newest line differently depending on it.
enum TaskStepKind {
  act,
  think,
  result;

  String get wire => name;

  static TaskStepKind of(String? wire) => TaskStepKind.values
      .firstWhere((k) => k.wire == wire, orElse: () => TaskStepKind.think);
}

class TaskStepRecord {
  const TaskStepRecord({
    required this.text,
    required this.atMs,
    required this.kind,
  });

  /// 「动作 + 目标 + 进度」一句话，直接展示，不再加工。
  final String text;
  final int atMs;
  final TaskStepKind kind;

  Map<String, dynamic> toJson() =>
      <String, dynamic>{'text': text, 'atMs': atMs, 'kind': kind.wire};

  static TaskStepRecord? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final text = raw['text'];
    if (text is! String) return null;
    return TaskStepRecord(
      text: text,
      atMs: raw['atMs'] is int ? raw['atMs'] as int : 0,
      kind: TaskStepKind.of(raw['kind'] as String?),
    );
  }
}

/// A pending ask-level tool approval, addressed by [id] so the answer coming
/// back over the inbox (which may race other messages) cannot land on the
/// wrong question.
class PendingApprovalInfo {
  const PendingApprovalInfo({
    required this.id,
    required this.tool,
    required this.target,
  });

  final String id;
  final String tool;
  final String target;

  Map<String, dynamic> toJson() =>
      <String, dynamic>{'id': id, 'tool': tool, 'target': target};

  static PendingApprovalInfo? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final tool = raw['tool'];
    if (id is! String || tool is! String) return null;
    return PendingApprovalInfo(
      id: id,
      tool: tool,
      target: raw['target'] is String ? raw['target'] as String : '',
    );
  }
}

/// Immutable snapshot of the currently tracked task. `idle` snapshots are
/// written too (not just skipped): the Android overlay collapses on phase ==
/// idle, so the file must be able to say "nothing running" explicitly.
class TaskSnapshot {
  const TaskSnapshot({
    required this.phase,
    this.taskId = '',
    this.source = TaskSource.local,
    this.stepIndex = 0,
    this.totalSteps = 0,
    this.lastAction = '',
    this.thinkingHint = '',
    this.startedAtMs = 0,
    this.updatedAtMs = 0,
    this.steps = const <TaskStepRecord>[],
    this.pendingApproval,
    this.lastResultExcerpt = '',
    this.errorMessage = '',
    this.lastScreenshotPath = '',
    this.floatingEnabled = true,
  });

  final TaskPhase phase;
  final String taskId;
  final TaskSource source;
  final int stepIndex;
  final int totalSteps;

  /// 最近一条「动作+目标+进度」，折叠态胶囊显示的就是它。
  final String lastAction;

  /// thinking 时的「在想什么」提示（模型思考流尾部），副屏与展开态显示。
  final String thinkingHint;
  final int startedAtMs;
  final int updatedAtMs;

  /// 最近执行步骤，新在前，最多 8 条（由控制器截断）。
  final List<TaskStepRecord> steps;
  final PendingApprovalInfo? pendingApproval;

  /// 任务收尾时的结果摘录（done）。idle 快照保留它，让悬浮窗在收起前
  /// 还能读到最后一条结果。
  final String lastResultExcerpt;
  final String errorMessage;

  /// 最新一张屏幕截图缩略图的绝对路径（vision 工具每次截图后另存）。空 =
  /// 还没有截图（vision 未配置 / 尚未执行到截图工具），消费方自己摆占位。
  final String lastScreenshotPath;

  /// 悬浮窗开关镜像。Kotlin 双重门之一：文件里 phase != idle 且本值为 true
  /// 才画。开关关掉时 Dart 会把本值写 false 并写 idle；进程死掉留下的旧文件
  /// 也因此不会在重启后把胶囊拉回来。
  final bool floatingEnabled;

  bool get isIdle => phase == TaskPhase.idle;

  /// 折叠态胶囊的一行摘要：lastAction，空则回落任务 id。
  String get summary => lastAction.isNotEmpty ? lastAction : taskId;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'phase': phase.wire,
        'taskId': taskId,
        'source': source.wire,
        'stepIndex': stepIndex,
        'totalSteps': totalSteps,
        'lastAction': lastAction,
        'thinkingHint': thinkingHint,
        'startedAtMs': startedAtMs,
        'updatedAtMs': updatedAtMs,
        'steps': steps.map((s) => s.toJson()).toList(),
        'pendingApproval': pendingApproval?.toJson(),
        'lastResultExcerpt': lastResultExcerpt,
        'errorMessage': errorMessage,
        'lastScreenshotPath': lastScreenshotPath,
        'floating': floatingEnabled,
      };

  static TaskSnapshot fromJson(Object? raw) {
    if (raw is! Map) return const TaskSnapshot(phase: TaskPhase.idle);
    final stepsRaw = raw['steps'];
    final steps = stepsRaw is List
        ? stepsRaw.map(TaskStepRecord.fromJson).whereType<TaskStepRecord>()
        : const <TaskStepRecord>[];
    return TaskSnapshot(
      phase: TaskPhase.of(raw['phase'] as String? ?? 'idle'),
      taskId: raw['taskId'] is String ? raw['taskId'] as String : '',
      source: TaskSource.of(raw['source'] as String?),
      stepIndex: raw['stepIndex'] is int ? raw['stepIndex'] as int : 0,
      totalSteps: raw['totalSteps'] is int ? raw['totalSteps'] as int : 0,
      lastAction: raw['lastAction'] is String ? raw['lastAction'] as String : '',
      thinkingHint:
          raw['thinkingHint'] is String ? raw['thinkingHint'] as String : '',
      startedAtMs: raw['startedAtMs'] is int ? raw['startedAtMs'] as int : 0,
      updatedAtMs: raw['updatedAtMs'] is int ? raw['updatedAtMs'] as int : 0,
      steps: List<TaskStepRecord>.unmodifiable(steps),
      pendingApproval: PendingApprovalInfo.fromJson(raw['pendingApproval']),
      lastResultExcerpt: raw['lastResultExcerpt'] is String
          ? raw['lastResultExcerpt'] as String
          : '',
      errorMessage:
          raw['errorMessage'] is String ? raw['errorMessage'] as String : '',
      lastScreenshotPath: raw['lastScreenshotPath'] is String
          ? raw['lastScreenshotPath'] as String
          : '',
      floatingEnabled:
          raw['floating'] is bool ? raw['floating'] as bool : true,
    );
  }

  static TaskSnapshot parseJsonText(String text) =>
      TaskSnapshot.fromJson(jsonDecode(text));

  /// 收尾后的干净快照：无任务、无待批，但保留结果/错误让消费方还能读一眼。
  factory TaskSnapshot.idle({
    required TaskSnapshot from,
    required int nowMs,
  }) {
    return TaskSnapshot(
      phase: TaskPhase.idle,
      taskId: from.taskId,
      source: from.source,
      stepIndex: from.stepIndex,
      totalSteps: from.totalSteps,
      lastAction: from.lastAction,
      startedAtMs: from.startedAtMs,
      updatedAtMs: nowMs,
      steps: from.steps,
      lastResultExcerpt: from.lastResultExcerpt,
      errorMessage: from.errorMessage,
      lastScreenshotPath: from.lastScreenshotPath,
      floatingEnabled: from.floatingEnabled,
    );
  }
}

/// The bus leaf: `<docs>/floating/task_state.json`, atomic replace on write.
/// All failures fail-soft with a boolean — a status file that cannot be
/// written must never break the run it is reporting on.
class TaskStateStore {
  TaskStateStore(this.file);

  TaskStateStore.inDocs(String docsDir) : this(fileInDocs(docsDir));

  static const String dirName = 'floating';
  static const String fileName = 'task_state.json';

  /// 截图缩略图子目录（悬浮窗左列与副屏读的就是这里的最新一张）。
  static const String screenshotsDirName = 'screenshots';

  final File file;

  static File fileInDocs(String docsDir) =>
      File('$docsDir/$dirName/$fileName');

  static Directory screenshotsInDocs(String docsDir) =>
      Directory('$docsDir/$dirName/$screenshotsDirName');

  /// 原子写：tmp + rename（学 IlinkJsonFileStore / writeAtomic 的既有形态）。
  bool write(TaskSnapshot snapshot) {
    try {
      final dir = file.parent;
      if (!dir.existsSync()) dir.createSync(recursive: true);
      final tmp = File(
          '${file.path}.${DateTime.now().microsecondsSinceEpoch}.tmp');
      tmp.writeAsStringSync(jsonEncode(snapshot.toJson()), flush: true);
      tmp.renameSync(file.path);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 读不到 / 读坏都回 null，由调用方决定初始快照（缺文件 = 从未跑过任务）。
  TaskSnapshot? read() {
    try {
      if (!file.existsSync()) return null;
      final text = file.readAsStringSync();
      if (text.trim().isEmpty) return null;
      return TaskSnapshot.parseJsonText(text);
    } catch (_) {
      return null;
    }
  }

  /// 悬浮信箱：`<docs>/floating/inbox.jsonl`，悬浮窗追加、Dart 消费。
  static File inboxInDocs(String docsDir) =>
      File('$docsDir/$dirName/inbox.jsonl');
}
