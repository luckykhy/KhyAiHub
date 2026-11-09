// 批量重命名：规则 → 预览 → 执行。
//
// 核心是**预览先行**：重命名是不可逆的（尤其正则模式一次改几十个文件），所以规则
// 只负责算出「会变成什么」，界面把结果逐条摆出来让人确认，用户勾选后才执行。
//
// 两种模式：
//   - 模板模式：`{n}` `{name}` `{ext}` `{date}` `{date:yyyyMMdd}` `{time}` `{size}` `{parent}`
//   - 正则模式：正则查找替换，支持 `$1` 这类分组引用
//
// 为什么自己写而不用现成的批量重命名库：需求里的语义（保留扩展名、序号补零、
// 日期占位符、正则分组）在各库之间不统一，而且**预览必须和执行用同一套算式**——
// 预览和执行分两套算式是最常见的「预览说没问题、执行改错名」事故源。

import 'package:meta/meta.dart';

import 'vfs_node.dart';

/// 重命名模式。
enum RenameMode {
  /// 模板模式（占位符替换）。
  template,

  /// 正则模式（查找替换）。
  regex;

  static RenameMode parse(String? raw) =>
      raw == 'regex' ? RenameMode.regex : RenameMode.template;
}

/// 重命名规则。
@immutable
class RenameRule {
  final RenameMode mode;

  /// 模板模式的模板串。
  final String template;

  /// 正则模式的查找串。
  final String search;

  /// 正则模式的替换串。
  final String replace;

  /// 正则是否忽略大小写。
  final bool ignoreCase;

  /// 序号起始值。
  final int startIndex;

  /// 序号步长。
  final int step;

  /// 是否保留原扩展名（模板里没写 `{ext}` 时才生效）。
  final bool keepExtension;

  /// 日期占位符的默认格式。
  final String dateFormat;

  const RenameRule({
    this.mode = RenameMode.template,
    this.template = '{name}_{n}',
    this.search = '',
    this.replace = '',
    this.ignoreCase = false,
    this.startIndex = 1,
    this.step = 1,
    this.keepExtension = true,
    this.dateFormat = 'yyyyMMdd',
  });

  RenameRule copyWith({
    RenameMode? mode,
    String? template,
    String? search,
    String? replace,
    bool? ignoreCase,
    int? startIndex,
    int? step,
    bool? keepExtension,
    String? dateFormat,
  }) {
    return RenameRule(
      mode: mode ?? this.mode,
      template: template ?? this.template,
      search: search ?? this.search,
      replace: replace ?? this.replace,
      ignoreCase: ignoreCase ?? this.ignoreCase,
      startIndex: startIndex ?? this.startIndex,
      step: step ?? this.step,
      keepExtension: keepExtension ?? this.keepExtension,
      dateFormat: dateFormat ?? this.dateFormat,
    );
  }
}

/// 单条重命名结果的状态。
enum RenameItemStatus {
  /// 可执行。
  ok,

  /// 目标名非法（空、含分隔符、过长等）。
  invalid,

  /// 目标已存在。
  conflict,

  /// 批次内与别的条目重名。
  duplicate,

  /// 与原名相同（等于没改）。
  unchanged;

  String get label {
    switch (this) {
      case RenameItemStatus.ok:
        return '可执行';
      case RenameItemStatus.invalid:
        return '名称非法';
      case RenameItemStatus.conflict:
        return '目标已存在';
      case RenameItemStatus.duplicate:
        return '批次内重名';
      case RenameItemStatus.unchanged:
        return '名称未变';
    }
  }
}

/// 一条重命名预览。
@immutable
class RenamePlanItem {
  final VfsNode source;
  final String sourceName;
  final String targetName;

  /// 目标全路径。
  final String targetPath;

  final RenameItemStatus status;

  /// 不通过的原因（人话）。
  final String reason;

  const RenamePlanItem({
    required this.source,
    required this.sourceName,
    required this.targetName,
    required this.targetPath,
    required this.status,
    this.reason = '',
  });

  bool get executable => status == RenameItemStatus.ok;
}

/// 批量重命名规划器。
abstract final class BatchRenamePlanner {
  /// 按规则算出每个条目的目标名。
  ///
  /// [existingNames] 是目标目录下已存在的文件名（不含本批次），用来判「目标已存在」。
  /// [now] 是日期占位符的取值来源，测试时传固定值。
  static List<RenamePlanItem> plan(
    List<VfsNode> nodes,
    RenameRule rule, {
    Set<String> existingNames = const <String>{},
    DateTime? now,
  }) {
    final clock = now ?? DateTime.now();
    final items = <RenamePlanItem>[];
    final seen = <String, int>{};

    for (var index = 0; index < nodes.length; index++) {
      final node = nodes[index];
      final base = _splitName(node.name, node.path);
      final computed = _compute(rule, base, index, node, clock);
      final targetName = computed.trim();

      final problem = _validate(targetName);
      if (problem != null) {
        items.add(RenamePlanItem(
          source: node,
          sourceName: node.name,
          targetName: targetName,
          targetPath: _joinPath(node.path, targetName),
          status: RenameItemStatus.invalid,
          reason: problem,
        ));
        continue;
      }

      if (targetName == node.name) {
        items.add(RenamePlanItem(
          source: node,
          sourceName: node.name,
          targetName: targetName,
          targetPath: _joinPath(node.path, targetName),
          status: RenameItemStatus.unchanged,
          reason: '新名字与原名相同',
        ));
        continue;
      }

      if (existingNames.contains(targetName)) {
        items.add(RenamePlanItem(
          source: node,
          sourceName: node.name,
          targetName: targetName,
          targetPath: _joinPath(node.path, targetName),
          status: RenameItemStatus.conflict,
          reason: '目标目录已存在同名文件',
        ));
        continue;
      }

      final count = seen[targetName] ?? 0;
      seen[targetName] = count + 1;
      items.add(RenamePlanItem(
        source: node,
        sourceName: node.name,
        targetName: targetName,
        targetPath: _joinPath(node.path, targetName),
        status: count == 0
            ? RenameItemStatus.ok
            : RenameItemStatus.duplicate,
        reason: count == 0 ? '' : '批次内多个条目会变成同一个名字',
      ));
    }
    return items;
  }

  /// 按规则算目标名。
  static String _compute(
    RenameRule rule,
    _NameParts base,
    int index,
    VfsNode node,
    DateTime clock,
  ) {
    switch (rule.mode) {
      case RenameMode.template:
        final serial = rule.startIndex + index * rule.step;
        // `{date:格式}` 要先替换掉：它是带参数的占位符，而 `{date}` 是无参的，
        // 顺序反了的话 `{date:yyyyMMdd}` 会被当成 `{date}` 加一段后缀。
        final dated = rule.template.replaceAllMapped(
          RegExp(r'\{date:([^}]*)\}'),
          (Match match) => _formatDate(clock, match.group(1) ?? rule.dateFormat),
        );
        final text = dated
            .replaceAll('{n}', _pad(serial))
            .replaceAll('{name}', base.stem)
            .replaceAll('{ext}', base.extension)
            .replaceAll('{parent}', base.parent)
            .replaceAll('{size}', '${node.size}')
            .replaceAll('{date}', _formatDate(clock, rule.dateFormat))
            .replaceAll('{time}', _formatTime(clock));
        if (text.trim().isEmpty) return '';
        if (rule.keepExtension && base.extension.isNotEmpty &&
            !text.endsWith(base.extension)) {
          return '$text${base.extension}';
        }
        return text;
      case RenameMode.regex:
        try {
          final pattern = RegExp(
            rule.search,
            caseSensitive: !rule.ignoreCase,
            multiLine: true,
          );
          final replaced = node.name.replaceAllMapped(
            pattern,
            (Match match) => _expandGroups(match, rule.replace),
          );
          if (rule.keepExtension && base.extension.isNotEmpty &&
              !replaced.endsWith(base.extension)) {
            return '$replaced${base.extension}';
          }
          return replaced;
        } catch (_) {
          // 正则非法时返回原名——界面会把它标成「名称未变」而不是崩溃。
          return node.name;
        }
    }
  }

  /// 展开分组引用。
  ///
  /// 支持两种写法：`$1`（Dart 的 `replaceAll` 习惯）与 `\1`（Java/PCRE 习惯）。
  /// 两种都收是有原因的：用户在别处抄来的正则替换串多半是 `\1`，
  /// 只认一种的话用户会看到「替换串没生效」这种没法自查的现象。
  static String _expandGroups(Match match, String replacement) {
    final buffer = StringBuffer();
    for (var i = 0; i < replacement.length; i++) {
      final char = replacement[i];
      final isDollar = char == r'$';
      final isBackslash = char == r'\';
      if ((!isDollar && !isBackslash) || i + 1 >= replacement.length) {
        buffer.write(char);
        continue;
      }
      final next = replacement[i + 1];
      if (next == char) {
        buffer.write(next);
        i++;
        continue;
      }
      if (RegExp(r'[0-9]').hasMatch(next)) {
        final index = int.parse(next);
        buffer.write(match.group(index) ?? '');
        i++;
        continue;
      }
      buffer.write(char);
    }
    return buffer.toString();
  }

  /// 名称合法性检查。返回 null 表示合法，否则返回一句人话。
  static String? _validate(String name) {
    if (name.isEmpty) return '目标名为空';
    if (name == '.' || name == '..') return '目标名不能是 . 或 ..';
    if (name.contains('/') || name.contains(r'\')) {
      return '目标名不能包含路径分隔符';
    }
    for (final unit in name.codeUnits) {
      if (unit < 32) return '目标名不能包含控制字符';
    }
    if (name.length > 255) return '目标名过长（上限 255 字符）';
    return null;
  }

  static String _pad(int value) => value.toString().padLeft(3, '0');

  static String _formatDate(DateTime time, String format) {
    String two(int v) => v.toString().padLeft(2, '0');
    switch (format) {
      case 'yyyy-MM-dd':
        return '${time.year}-${two(time.month)}-${two(time.day)}';
      case 'yyyyMMdd':
        return '${time.year}${two(time.month)}${two(time.day)}';
      case 'yyyy-MM':
        return '${time.year}-${two(time.month)}';
      case 'MM-dd':
        return '${two(time.month)}-${two(time.day)}';
      default:
        return '${time.year}${two(time.month)}${two(time.day)}';
    }
  }

  static String _formatTime(DateTime time) {
    String two(int v) => v.toString().padLeft(2, '0');
    return '${two(time.hour)}${two(time.minute)}${two(time.second)}';
  }

  static _NameParts _splitName(String name, String path) {
    final index = name.lastIndexOf('.');
    final isExtension = index > 0 && index < name.length - 1;
    final stem = isExtension ? name.substring(0, index) : name;
    // 扩展名**带点**（".txt"）：模板里写 `{ext}` 时用户想要的就是能直接拼上去的形态，
    // 而 `keepExtension` 的判重也要拿它比对，两个用法同源，不用各记一套。
    final extension = isExtension ? '.${name.substring(index + 1)}' : '';
    final parentIndex = path.lastIndexOf('/');
    // path 是**文件自己的全路径**，所以要先砍掉文件名再取目录名——
    // 直接取最后一段会拿到文件名自己（'a.txt'），那不是「所在目录」。
    final dir = parentIndex > 0 ? path.substring(0, parentIndex) : '';
    final dirIndex = dir.lastIndexOf('/');
    final parent = dirIndex >= 0 ? dir.substring(dirIndex + 1) : '';
    return _NameParts(stem, extension, parent);
  }

  static String _joinPath(String path, String name) {
    final index = path.lastIndexOf('/');
    if (index < 0) return name;
    return '${path.substring(0, index)}/$name';
  }
}

class _NameParts {
  final String stem;
  final String extension;

  /// 父目录名（由调用方填，模板里的 `{parent}` 用）。
  final String parent;

  const _NameParts(this.stem, this.extension, this.parent);
}
