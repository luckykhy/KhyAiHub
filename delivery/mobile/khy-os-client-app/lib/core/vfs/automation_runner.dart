// 自动化脚本的执行器。
//
// 脚本是「一串文件操作」，执行器负责把它跑完并**逐项报结果**。
// 关键设计：执行时来源标记为 [VfsSource.script]，所以审计日志里能看出
// 「这一串改动是脚本干的」——用户能分辨「我自己点的」和「脚本替我做的」。
//
// 脚本里出现的路径一律先过安全校验：脚本是**文件**，用户可能手改过它，
// 也可能从别处拷进来。一个被改坏的脚本不该有能力去删系统目录。

import 'vfs_audit.dart';
import 'vfs_route.dart';
import 'vfs_service.dart';
import 'automation_script.dart';

/// 一步的执行结果。
class AutomationRunStep {
  final String op;
  final bool ok;
  final String message;

  const AutomationRunStep({
    required this.op,
    required this.ok,
    this.message = '',
  });
}

/// 一次运行的结果。
class AutomationRunResult {
  final List<AutomationRunStep> steps;

  const AutomationRunResult(this.steps);

  bool get allOk => steps.every((AutomationRunStep step) => step.ok);

  int get failedCount => steps.where((AutomationRunStep step) => !step.ok).length;

  int get doneCount => steps.length - failedCount;
}

/// 脚本执行器。
abstract final class AutomationRunner {
  /// 执行一个脚本。
  ///
  /// 遇错继续跑后面的步骤——脚本是一串独立操作，前面一步失败不代表后面几步
  /// 无意义。全部结果在最后一次性汇报。
  static Future<AutomationRunResult> run(
    AutomationScript script, {
    VfsService? service,
  }) async {
    final vfs = service ?? VfsService.instance;
    final steps = <AutomationRunStep>[];

    for (final step in script.steps) {
      try {
        await _runStep(vfs, step);
        steps.add(AutomationRunStep(op: step.op, ok: true));
      } on VfsException catch (error) {
        steps.add(AutomationRunStep(
          op: step.op,
          ok: false,
          message: error.message,
        ));
      } catch (error) {
        steps.add(AutomationRunStep(
          op: step.op,
          ok: false,
          message: '$error',
        ));
      }
    }
    return AutomationRunResult(steps);
  }

  static Future<void> _runStep(VfsService vfs, AutomationStep step) async {
    final source = step.args['src'] ?? step.args['path'] ?? '';
    final target = step.args['dst'] ?? step.args['to'] ?? '';

    switch (step.op) {
      case 'copy':
        _guard(source);
        _guard(target);
        await vfs.copy('$source', '$target', source: VfsSource.script);
      case 'move':
        _guard(source);
        _guard(target);
        await vfs.move('$source', '$target', source: VfsSource.script);
      case 'delete':
        _guard(source);
        await vfs.delete('$source', source: VfsSource.script);
      case 'rename':
        _guard(source);
        _guard(target);
        await vfs.rename('$source', '$target', source: VfsSource.script);
      case 'mkdir':
        _guard(source);
        await vfs.mkdir('$source', source: VfsSource.script);
      case 'write':
        _guard(source);
        await vfs.write('$source', '', source: VfsSource.script);
      default:
        throw VfsException('invalid_path', '脚本里有不认识的步骤：${step.op}');
    }
  }

  /// 路径护栏：必须是绝对路径、不能带 `..`、不能碰系统分区。
  ///
  /// 脚本可能被手改过，所以这里重新判一遍——不能因为「脚本是自己录的」就放行。
  static void _guard(String path) {
    if (path.isEmpty) {
      throw const VfsException('invalid_path', '脚本步骤缺少路径');
    }
    if (!VfsPath.isAbsolute(path)) {
      throw VfsException('invalid_path', '脚本里的路径必须是绝对路径：$path');
    }
    if (path.contains('..')) {
      throw VfsException('invalid_path', '脚本里的路径不能包含 ..：$path');
    }
    if (VfsPath.isUnderAny(path, VfsRoots.systemPartitions)) {
      throw VfsException('read_only', '脚本不能改动系统分区：$path');
    }
  }
}
