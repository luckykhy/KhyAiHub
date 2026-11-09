// AI 操作计划：自然语言 → 结构化计划 → 人确认 → 执行。
//
// **AI 不直接写盘。** AI 产出的永远是「计划」（结构化数据），执行必须经过人确认。
// 这不是流程洁癖，是这一版 App 的核心承诺：AI 是助手不是主角。助手可以提议，
// 但落笔的是人。
//
// 计划用结构化数据而不是命令串，有三个好处：
//   1. 能逐项渲染成可勾选清单——「逐项确认」需要能单独拒绝其中一项；
//   2. 能按项算风险等级——命令串算不出「这一项是删私有目录」；
//   3. 能在执行前做白名单校验——未知操作类型直接丢弃，不进执行队列。

import 'dart:convert';

import 'package:meta/meta.dart';

import 'ai_safety.dart';
import 'vfs_audit.dart';
import 'vfs_route.dart';
import 'vfs_service.dart';

/// 计划里允许出现的操作类型。**白名单**：不在表里的一律拒绝。
///
/// 这张表就是「AI 能做什么」的边界。往里加一类 = 给 AI 开一类能力，必须是有意为之。
enum AiOpKind {
  copy,
  move,
  delete,
  rename,
  mkdir,
  search;

  static AiOpKind? parse(String? raw) {
    final normalized = (raw ?? '').trim().toLowerCase();
    for (final kind in AiOpKind.values) {
      if (kind.name == normalized) return kind;
    }
    // 常见同义词。模型爱说 move_file / rm / make_dir，收着点比每家模型各写一套
    // 归一化便宜。
    switch (normalized) {
      case 'rm':
      case 'remove':
      case 'unlink':
        return AiOpKind.delete;
      case 'mv':
      case 'move_file':
      case 'movefile':
        return AiOpKind.move;
      case 'cp':
      case 'copy_file':
      case 'copyfile':
        return AiOpKind.copy;
      case 'mk':
      case 'mkdir':
      case 'make_dir':
      case 'createdir':
        return AiOpKind.mkdir;
      case 'rename_file':
      case 'renamefile':
      case 'mv_name':
        return AiOpKind.rename;
      case 'find':
      case 'grep':
      case 'lookup':
        return AiOpKind.search;
    }
    return null;
  }

  String get label {
    switch (this) {
      case AiOpKind.copy:
        return '复制';
      case AiOpKind.move:
        return '移动';
      case AiOpKind.delete:
        return '删除';
      case AiOpKind.rename:
        return '重命名';
      case AiOpKind.mkdir:
        return '新建目录';
      case AiOpKind.search:
        return '搜索';
    }
  }
}

/// 风险等级。
enum AiRisk {
  /// 安全：单文件重命名、建目录。
  safe,

  /// 需确认：移动、覆盖、跨分区复制。
  caution,

  /// 高危：删除、批量、涉及私有目录。
  destructive;

  String get label {
    switch (this) {
      case AiRisk.safe:
        return '低风险';
      case AiRisk.caution:
        return '需确认';
      case AiRisk.destructive:
        return '高危';
    }
  }

  /// 是否必须逐项确认。高危项默认不勾选。
  bool get requiresExplicitConfirm =>
      this == AiRisk.caution || this == AiRisk.destructive;
}

/// 计划中的一步操作。
@immutable
class AiOperation {
  final String id;
  final AiOpKind kind;

  /// 源路径（删除/重命名/移动/复制时是操作对象）。
  final String sourcePath;

  /// 目标路径。
  final String targetPath;

  /// 搜索模式（仅 search）。
  final String pattern;

  /// 是否递归。
  final bool recursive;

  /// 风险等级。
  final AiRisk risk;

  /// 面向用户的一句话描述。
  final String title;

  const AiOperation({
    required this.id,
    required this.kind,
    required this.sourcePath,
    this.targetPath = '',
    this.pattern = '',
    this.recursive = false,
    required this.risk,
    required this.title,
  });

  /// 该项操作涉及的路径（用于执行）。
  String get primaryPath => sourcePath.isNotEmpty ? sourcePath : targetPath;
}

/// 被拒绝的项。拒绝也要有记录——用户要能知道 AI 提了什么、被挡在哪。
@immutable
class AiRejectedItem {
  final String raw;
  final String reason;

  const AiRejectedItem(this.raw, this.reason);
}

/// 一个操作计划。
@immutable
class AiOperationPlan {
  /// 通过校验的操作。
  final List<AiOperation> operations;

  /// 被白名单或安全校验拒绝的项。
  final List<AiRejectedItem> rejected;

  /// 计划的一句话摘要。
  final String summary;

  const AiOperationPlan({
    this.operations = const <AiOperation>[],
    this.rejected = const <AiRejectedItem>[],
    this.summary = '',
  });

  bool get isEmpty => operations.isEmpty;

  /// 最高风险。
  AiRisk get maxRisk {
    if (operations.any((op) => op.risk == AiRisk.destructive)) {
      return AiRisk.destructive;
    }
    if (operations.any((op) => op.risk == AiRisk.caution)) return AiRisk.caution;
    return AiRisk.safe;
  }

  /// 高危项数量——界面要单独把高危项标红并默认不勾选。
  int get destructiveCount =>
      operations.where((op) => op.risk == AiRisk.destructive).length;

  /// 计划里提到的所有路径。
  List<String> get touchedPaths {
    final paths = <String>[];
    for (final op in operations) {
      if (op.sourcePath.isNotEmpty) paths.add(op.sourcePath);
      if (op.targetPath.isNotEmpty) paths.add(op.targetPath);
    }
    return paths;
  }
}

/// 计划解析器。
///
/// 输入可以是 `{"operations":[...]}` 或直接一个数组。每一项都要过三道闸：
///   1. 操作类型在白名单内；
///   2. 路径过安全校验（绝对路径、无 `..`、写操作不碰危险根）；
///   3. 风险等级可算出来。
///
/// 任何一道不过，这一项被**丢弃并记录原因**，其余项照常进入计划——
/// 一个坏项不该让整份计划作废，但坏项也绝不能被执行。
abstract final class AiPlanDecoder {
  /// 解析 AI 返回的原始文本。
  static AiOperationPlan decode(String raw) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) {
      return const AiOperationPlan(summary: 'AI 没有给出可执行的内容');
    }

    // 模型有时会在 JSON 外面裹一层 ```json 代码块；剥掉再试。
    final cleaned = _stripCodeFence(trimmed);
    Object? decoded;
    try {
      decoded = _decodeJson(cleaned);
    } catch (_) {
      decoded = null;
    }
    if (decoded == null) {
      return const AiOperationPlan(summary: '无法把 AI 的回复解析成操作计划');
    }

    List<dynamic> rawItems;
    String summary = '';
    if (decoded is List) {
      rawItems = decoded;
    } else if (decoded is Map) {
      final ops = decoded['operations'];
      rawItems = ops is List ? ops : const <dynamic>[];
      final rawSummary = decoded['summary'];
      summary = rawSummary is String ? rawSummary : '';
    } else {
      return const AiOperationPlan(summary: 'AI 的回复不是操作计划');
    }

    final operations = <AiOperation>[];
    final rejected = <AiRejectedItem>[];
    var index = 0;
    for (final item in rawItems) {
      index++;
      if (item is! Map) {
        rejected.add(AiRejectedItem('$item', '第 $index 项不是对象'));
        continue;
      }
      final map = item.map((key, value) => MapEntry(key.toString(), value));
      final kind = AiOpKind.parse(_pickString(map, const ['op', 'kind', 'action', 'type']));
      if (kind == null) {
        rejected.add(AiRejectedItem(
          _pickString(map, const ['op', 'kind', 'action', 'type']) ?? '$item',
          '第 $index 项的操作类型不在白名单内',
        ));
        continue;
      }

      final source = _pickString(map, const ['source', 'src', 'from', 'path', 'target']);
      final target = _pickString(map, const ['target', 'dst', 'to', 'destination']);
      final pattern = _pickString(map, const ['pattern', 'query', 'name']) ?? '';
      final recursive = map['recursive'] == true;

      if (kind != AiOpKind.search && (source ?? '').isEmpty) {
        rejected.add(AiRejectedItem('$item', '第 $index 项缺少目标路径'));
        continue;
      }

      // 「写操作」只约束**会被写入的路径**。
      //
      // 复制与移动在这里不一样：复制是从源读、往目标写，所以源不受写白名单约束
      // （导出私有目录到公共存储正是产品明确要支持的动作）；移动会把源从原处
      // 摘走，那是写源，所以要约束。
      final writesSource = kind == AiOpKind.move ||
          kind == AiOpKind.delete ||
          kind == AiOpKind.rename ||
          kind == AiOpKind.mkdir;
      final writesTarget = kind != AiOpKind.search && target != null;

      final sourceVerdict = (writesSource && kind != AiOpKind.search)
          ? AiSafetyFilter.checkPath(source ?? '', forWrite: true)
          : const SafetyVerdict.allow();
      if (!sourceVerdict.allowed) {
        rejected.add(AiRejectedItem(source ?? '', sourceVerdict.reason ?? '路径不安全'));
        continue;
      }
      if (writesTarget && target.isNotEmpty) {
        // 重命名的目标是一个**新名字**，不是路径——它的落点由源路径决定。
        // 所以它按「名字」校验（不能带分隔符），其余操作的目标按「路径」校验
        //（必须是绝对路径且不碰系统分区）。
        final targetVerdict = kind == AiOpKind.rename
            ? _checkName(target)
            : AiSafetyFilter.checkPath(target, forWrite: true);
        if (!targetVerdict.allowed) {
          rejected.add(
            AiRejectedItem(target, targetVerdict.reason ?? '目标路径不安全'),
          );
          continue;
        }
      }

      final normalizedSource = source == null || source.isEmpty
          ? ''
          : VfsPath.normalize(source);
      // 重命名的目标保持原样（新名字），其余按路径归一。
      final normalizedTarget =
          target == null || target.isEmpty ? '' : VfsPath.normalize(target);

      operations.add(
        AiOperation(
          id: 'op$index',
          kind: kind,
          sourcePath: normalizedSource,
          targetPath: normalizedTarget,
          pattern: pattern,
          recursive: recursive,
          risk: _classifyRisk(
            kind,
            normalizedSource,
            normalizedTarget,
            recursive,
          ),
          title: _describe(kind, normalizedSource, normalizedTarget, pattern),
        ),
      );
    }

    return AiOperationPlan(
      operations: operations,
      rejected: rejected,
      summary: summary.isEmpty ? _summarize(operations) : summary,
    );
  }

  /// 名字（重命名目标）的合法性。返回 null 表示合法。
  static String? _nameProblem(String name) {
    if (name.trim().isEmpty) return '新名字为空';
    if (name == '.' || name == '..') return '新名字不能是 . 或 ..';
    if (name.contains('/') || name.contains(r'\')) {
      return '新名字不能包含路径分隔符';
    }
    return null;
  }

  static SafetyVerdict _checkName(String name) {
    final problem = _nameProblem(name);
    if (problem == null) return const SafetyVerdict.allow();
    return SafetyVerdict.deny(problem);
  }

  /// 风险判定。
  ///
  /// 判据只有三条，都是「出事了代价最大」导向的：
  ///   - 删除一律高危；
  ///   - 涉及应用私有目录的写操作一律高危（那是在改别的 App 的数据）；
  ///   - 递归的批量操作一律高危。
  static AiRisk _classifyRisk(
    AiOpKind kind,
    String source,
    String target,
    bool recursive,
  ) {
    if (kind == AiOpKind.delete) return AiRisk.destructive;
    if (kind == AiOpKind.search) return AiRisk.safe;
    if (recursive) return AiRisk.destructive;

    final touchesPrivate = _isPrivate(source) || _isPrivate(target);
    if (touchesPrivate) return AiRisk.destructive;
    if (kind == AiOpKind.copy || kind == AiOpKind.move) return AiRisk.caution;
    return AiRisk.safe;
  }

  static bool _isPrivate(String path) {
    if (path.isEmpty) return false;
    return VfsPath.isUnderAny(path, VfsRoots.privatePrefixes);
  }

  static String _describe(
    AiOpKind kind,
    String source,
    String target,
    String pattern,
  ) {
    switch (kind) {
      case AiOpKind.copy:
        return '复制「$source」到「$target」';
      case AiOpKind.move:
        return '移动「$source」到「$target」';
      case AiOpKind.delete:
        return '删除「$source」';
      case AiOpKind.rename:
        return '把「$source」重命名为「$target」';
      case AiOpKind.mkdir:
        return '新建目录「$source」';
      case AiOpKind.search:
        return '搜索「$pattern」';
    }
  }

  static String _summarize(List<AiOperation> operations) {
    if (operations.isEmpty) return '没有可执行的操作';
    final counts = <String, int>{};
    for (final op in operations) {
      counts[op.kind.label] = (counts[op.kind.label] ?? 0) + 1;
    }
    final parts = counts.entries.map((entry) => '${entry.key} ${entry.value} 项');
    return parts.join('，');
  }

  static String? _pickString(Map<String, dynamic> map, List<String> keys) {
    for (final key in keys) {
      final value = map[key];
      if (value is String && value.trim().isNotEmpty) return value.trim();
    }
    return null;
  }

  static String _stripCodeFence(String raw) {
    if (!raw.startsWith('```')) return raw;
    final lines = raw.split('\n');
    if (lines.length < 2) return raw;
    return lines.sublist(1, lines.length - 1).join('\n').trim();
  }

  static Object? _decodeJson(String text) {
    // 直接解一次；失败再截取第一段花括号内容试一次——模型常在 JSON 前后加话。
    try {
      return _jsonDecode(text);
    } catch (_) {
      final start = text.indexOf('{');
      final end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return _jsonDecode(text.substring(start, end + 1));
      }
      final arrayStart = text.indexOf('[');
      final arrayEnd = text.lastIndexOf(']');
      if (arrayStart >= 0 && arrayEnd > arrayStart) {
        return _jsonDecode(text.substring(arrayStart, arrayEnd + 1));
      }
      rethrow;
    }
  }

  static Object? _jsonDecode(String text) {
    // 单独包一层是为了让上面的「先直解、失败再截取花括号」逻辑集中在一处，
    // 后面要换解析策略只改这里。
    return jsonDecode(text);
  }
}

/// 单项执行结果。
@immutable
class AiStepResult {
  final String operationId;
  final bool ok;
  final String message;

  const AiStepResult({
    required this.operationId,
    required this.ok,
    this.message = '',
  });
}

/// 计划执行结果。
@immutable
class AiPlanResult {
  final List<AiStepResult> steps;

  const AiPlanResult(this.steps);

  bool get allOk => steps.every((step) => step.ok);

  int get failedCount => steps.where((step) => !step.ok).length;
}

/// 计划执行器。
///
/// 执行时来源标记为 [VfsSource.ai]，审计日志里能看出这一批操作是 AI 干的。
abstract final class AiPlanExecutor {
  /// 执行计划中已被勾选的操作。
  ///
  /// [selectedIds] 是被勾选的项；没勾的一律不执行——「逐项确认」要真的逐项，
  /// 不能是「全选/全不选」的假象。
  static Future<AiPlanResult> execute(
    AiOperationPlan plan, {
    required Set<String> selectedIds,
    VfsService? service,
  }) async {
    final vfs = service ?? VfsService.instance;
    final steps = <AiStepResult>[];
    for (final op in plan.operations) {
      if (!selectedIds.contains(op.id)) continue;
      try {
        await _executeOne(vfs, op);
        steps.add(AiStepResult(operationId: op.id, ok: true));
      } on VfsException catch (error) {
        steps.add(
          AiStepResult(operationId: op.id, ok: false, message: error.message),
        );
      } catch (error) {
        steps.add(
          AiStepResult(operationId: op.id, ok: false, message: '$error'),
        );
      }
    }
    return AiPlanResult(steps);
  }

  static Future<void> _executeOne(VfsService vfs, AiOperation op) async {
    switch (op.kind) {
      case AiOpKind.copy:
        await vfs.copy(op.sourcePath, op.targetPath, source: VfsSource.ai);
      case AiOpKind.move:
        await vfs.move(op.sourcePath, op.targetPath, source: VfsSource.ai);
      case AiOpKind.delete:
        await vfs.delete(
          op.sourcePath,
          recursive: op.recursive,
          source: VfsSource.ai,
        );
      case AiOpKind.rename:
        await vfs.rename(op.sourcePath, op.targetPath, source: VfsSource.ai);
      case AiOpKind.mkdir:
        await vfs.mkdir(op.sourcePath, source: VfsSource.ai);
      case AiOpKind.search:
        // 搜索没有副作用，不需要写审计；只跑一次让用户看到结果。
        await vfs.search(
          op.sourcePath.isEmpty ? '/' : op.sourcePath,
          namePattern: op.pattern.isEmpty ? '*' : op.pattern,
        );
    }
  }
}

/// `dart:convert` 的薄封装。单独放一个函数是为了让上面那个「试两次」的逻辑
/// 不被 import 淹没，也方便测试替身。
Object? jsonDecodeCompat(String text) => jsonDecode(text);
