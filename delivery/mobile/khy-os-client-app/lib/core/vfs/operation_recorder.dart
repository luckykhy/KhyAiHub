// 操作录制器：把用户刚做的文件操作收集成自动化脚本。
//
// 为什么靠审计日志而不是另写一套钩子：审计日志已经是「所有写操作的单一出口」
// （VfsService 每做一次写操作都会记一条）。录制器再挂一份监听，就是**零额外
// 侵入**地拿到操作序列——如果另写一套钩子，就会有两处记录、两处可能漏。
//
// 只录用户手动做的操作，不录 AI 做的：录进来的脚本是「我刚做过这一串」，
// 混进 AI 的操作会让脚本语义变得没法预测。

import 'automation_script.dart';
import 'vfs_audit.dart';

/// 操作录制器。
class OperationRecorder {
  OperationRecorder._();

  static final OperationRecorder instance = OperationRecorder._();

  /// 会被录制的操作名。读操作不进脚本——脚本是「要重放的动作」，不是「看过什么」。
  static const Set<String> recordedOps = <String>{
    'copy',
    'move',
    'delete',
    'rename',
    'mkdir',
    'write',
  };

  bool _recording = false;
  final List<AutomationStep> _steps = <AutomationStep>[];

  /// 是否正在录制。
  bool get recording => _recording;

  /// 已录到的步骤。
  List<AutomationStep> get steps => List<AutomationStep>.unmodifiable(_steps);

  /// 开始录制。先清空上一轮。
  void start() {
    _steps.clear();
    _recording = true;
    VfsAuditLog.instance.addListener(_onEntry);
  }

  /// 停止录制。
  void stop() {
    _recording = false;
    VfsAuditLog.instance.removeListener(_onEntry);
  }

  /// 清空已录步骤。
  void clear() {
    _steps.clear();
  }

  /// 把已录步骤导出成脚本。
  ///
  /// [watchDir] 是脚本将来要监视的目录，默认取第一步的所在目录——
  /// 「当我动这个目录时就这样做」是这类脚本最常见的意图。
  AutomationScript? export(String name, {String? watchDir}) {
    if (_steps.isEmpty) return null;
    final dir = watchDir ?? _parentOf(_steps.first);
    return AutomationScript(
      id: 'script-${DateTime.now().millisecondsSinceEpoch}',
      name: name,
      trigger: dir.isEmpty
          ? AutomationTrigger.manual
          : AutomationTrigger.directoryEvent,
      watchDir: dir,
      steps: List<AutomationStep>.of(_steps),
    );
  }

  void _onEntry(VfsAuditEntry entry) {
    if (!_recording) return;
    if (entry.source != VfsSource.user) return;
    if (!recordedOps.contains(entry.operation)) return;
    final step = _toStep(entry);
    if (step != null) _steps.add(step);
  }

  AutomationStep? _toStep(VfsAuditEntry entry) {
    final path = entry.path;
    if (path.isEmpty) return null;
    switch (entry.operation) {
      case 'copy':
      case 'move':
        return AutomationStep(
          op: entry.operation,
          args: <String, dynamic>{'src': path, 'dst': entry.detail},
        );
      case 'rename':
        return AutomationStep(
          op: 'rename',
          args: <String, dynamic>{'src': path, 'to': entry.detail},
        );
      case 'delete':
      case 'mkdir':
      case 'write':
        return AutomationStep(
          op: entry.operation,
          args: <String, dynamic>{'path': path},
        );
    }
    return null;
  }

  static String _parentOf(AutomationStep step) {
    final raw = (step.args['src'] ?? step.args['path'] ?? '').toString();
    final index = raw.lastIndexOf('/');
    if (index <= 0) return '/';
    return raw.substring(0, index);
  }
}
