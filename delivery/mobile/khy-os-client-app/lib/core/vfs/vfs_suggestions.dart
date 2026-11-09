// 主动建议：本地启发式给「现在该做什么」的提示。
//
// 目标里给的例子是「检测到 3 个重复照片，是否清理？」——这类建议的关键不是 AI 有多聪明，
// 而是**它看见了什么**：当前目录里有哪些重复、哪些占地方、哪些是几个月前下载完就没再动过的。
//
// 所以这一层做的是**确定性启发式**，不是模型推断：
//   - 同名同大小 → 可能是重复
//   - 体积大 → 值得看一眼
//   - 很久没动 → 大概率是残留
//   - 安装包 / 临时文件 → 用完就该清
//
// 为什么不用模型去做这些判断：这些判断靠的是「算」而不是「猜」——同名同大小的两个文件
// 是不是真重复，模型只能猜，哈希才能确定；而这里的启发式要么给出可核查的线索
// （同名同大小），要么给出确定的元数据（大、久未动）。模型留给真正需要理解意图的地方
// （比如「把上周下载的 PDF 移到工作目录」）。
//
// 建议**只提示不自动执行**：清理是不可逆的，勾选与确认由人做。

import 'package:meta/meta.dart';

import 'vfs_node.dart';

/// 建议的种类。
enum SuggestionKind {
  /// 同名同大小的多份文件。
  duplicates,

  /// 体积很大的文件。
  largeFiles,

  /// 很久没动过的文件。
  staleFiles,

  /// 安装包。
  installPackages,

  /// 临时文件。
  tempFiles;

  String get label {
    switch (this) {
      case SuggestionKind.duplicates:
        return '疑似重复';
      case SuggestionKind.largeFiles:
        return '占地方';
      case SuggestionKind.staleFiles:
        return '很久没动';
      case SuggestionKind.installPackages:
        return '安装包';
      case SuggestionKind.tempFiles:
        return '临时文件';
    }
  }

  /// 图标名（界面用）。
  String get iconName {
    switch (this) {
      case SuggestionKind.duplicates:
        return 'content_copy';
      case SuggestionKind.largeFiles:
        return 'data_usage';
      case SuggestionKind.staleFiles:
        return 'history';
      case SuggestionKind.installPackages:
        return 'android';
      case SuggestionKind.tempFiles:
        return 'cleaning_services';
    }
  }
}

/// 一条建议。
@immutable
class VfsSuggestion {
  final String id;
  final SuggestionKind kind;
  final String title;

  /// 为什么提这条（可核查的线索，不是模型的猜测）。
  final String reason;

  /// 涉及的文件。
  final List<String> targets;

  /// 涉及的字节数（可回收的空间估计）。
  final int estimatedBytes;

  const VfsSuggestion({
    required this.id,
    required this.kind,
    required this.title,
    required this.reason,
    this.targets = const <String>[],
    this.estimatedBytes = 0,
  });
}

/// 建议生成器。
abstract final class VfsSuggestions {
  /// 大文件的阈值（100MB）。**严格超过**才算——刚好 100MB 不算「超过 100MB」。
  static const int largeFileBytes = 100 * 1024 * 1024;

  /// 「很久没动」的天数（90 天）。
  static const int staleDays = 90;

  /// 临时文件的扩展名。
  static const Set<String> tempExtensions = <String>{
    '.tmp',
    '.temp',
    '.part',
    '.crdownload',
    '.download',
  };

  /// 安装包的扩展名。
  static const Set<String> packageExtensions = <String>{'.apk', '.apkm', '.apks'};

  /// 对一个目录的条目生成建议。
  ///
  /// [now] 是「当前时间」，测试时传固定值。
  static List<VfsSuggestion> analyze(
    List<VfsNode> nodes, {
    DateTime? now,
  }) {
    final clock = now ?? DateTime.now();
    final suggestions = <VfsSuggestion>[];

    suggestions.addAll(_duplicates(nodes));
    suggestions.addAll(_largeFiles(nodes));
    suggestions.addAll(_staleFiles(nodes, clock));
    suggestions.addAll(_packages(nodes));
    suggestions.addAll(_tempFiles(nodes));

    // 大额的排前面——用户先看到最值得处理的那条。
    suggestions.sort((VfsSuggestion a, VfsSuggestion b) {
      final byBytes = b.estimatedBytes.compareTo(a.estimatedBytes);
      if (byBytes != 0) return byBytes;
      return a.title.compareTo(b.title);
    });
    return suggestions;
  }

  /// 同名同大小 → 疑似重复。
  ///
  /// 只给线索不给结论：同名同大小的两个文件**可能**是真重复（也可能是同尺寸的
  /// 不同文件）。要确证得比哈希，那是另一件事的成本。
  static List<VfsSuggestion> _duplicates(List<VfsNode> nodes) {
    final groups = <String, List<VfsNode>>{};
    for (final node in nodes) {
      if (node.isDirectory) continue;
      final key = '${node.name}#${node.size}';
      groups.putIfAbsent(key, () => <VfsNode>[]).add(node);
    }

    final suggestions = <VfsSuggestion>[];
    for (final group in groups.values) {
      if (group.length < 2) continue;
      // 重复文件里除了一份，其余都算可回收。
      final reclaim = group.skip(1).fold<int>(0, (int sum, VfsNode n) => sum + n.size);
      suggestions.add(VfsSuggestion(
        id: 'dup-${group.first.name}-${group.first.size}',
        kind: SuggestionKind.duplicates,
        title: '「${group.first.name}」有 ${group.length} 份同名同大小的文件',
        reason: '同名同大小，可能是重复；要确证需比哈希。可保留一份，其余可清理。',
        targets: group.map((VfsNode n) => n.path).toList(),
        estimatedBytes: reclaim,
      ));
    }
    return suggestions;
  }

  /// 大文件。
  static List<VfsSuggestion> _largeFiles(List<VfsNode> nodes) {
    final big = nodes
        .where((VfsNode n) => !n.isDirectory && n.size > largeFileBytes)
        .toList();
    if (big.isEmpty) return const <VfsSuggestion>[];
    final bytes = big.fold<int>(0, (int sum, VfsNode n) => sum + n.size);
    return <VfsSuggestion>[
      VfsSuggestion(
        id: 'large',
        kind: SuggestionKind.largeFiles,
        title: '${big.length} 个文件超过 100MB',
        reason: '大文件往往是最占空间的那批；看看是不是还能删或移到别处。',
        targets: big.map((VfsNode n) => n.path).toList(),
        estimatedBytes: bytes,
      ),
    ];
  }

  /// 很久没动过的文件。
  static List<VfsSuggestion> _staleFiles(List<VfsNode> nodes, DateTime now) {
    final cutoff = now.subtract(Duration(days: staleDays));
    final stale = nodes
        .where((VfsNode n) =>
            !n.isDirectory && n.modifiedMs > 0 &&
            n.modifiedMs < cutoff.millisecondsSinceEpoch)
        .toList();
    if (stale.isEmpty) return const <VfsSuggestion>[];
    final bytes = stale.fold<int>(0, (int sum, VfsNode n) => sum + n.size);
    return <VfsSuggestion>[
      VfsSuggestion(
        id: 'stale',
        kind: SuggestionKind.staleFiles,
        title: '${stale.length} 个文件超过 $staleDays 天没动过',
        reason: '很久没碰过的文件大概率是残留；确认一下还用不用。',
        targets: stale.map((VfsNode n) => n.path).toList(),
        estimatedBytes: bytes,
      ),
    ];
  }

  /// 安装包。
  static List<VfsSuggestion> _packages(List<VfsNode> nodes) {
    final packages = nodes
        .where((VfsNode n) =>
            !n.isDirectory && packageExtensions.contains(_extension(n.name)))
        .toList();
    if (packages.isEmpty) return const <VfsSuggestion>[];
    final bytes = packages.fold<int>(0, (int sum, VfsNode n) => sum + n.size);
    return <VfsSuggestion>[
      VfsSuggestion(
        id: 'packages',
        kind: SuggestionKind.installPackages,
        title: '${packages.length} 个安装包',
        reason: '装完就基本没用了；留着只是占空间。',
        targets: packages.map((VfsNode n) => n.path).toList(),
        estimatedBytes: bytes,
      ),
    ];
  }

  /// 临时文件。
  static List<VfsSuggestion> _tempFiles(List<VfsNode> nodes) {
    final temps = nodes
        .where((VfsNode n) =>
            !n.isDirectory && tempExtensions.contains(_extension(n.name)))
        .toList();
    if (temps.isEmpty) return const <VfsSuggestion>[];
    final bytes = temps.fold<int>(0, (int sum, VfsNode n) => sum + n.size);
    return <VfsSuggestion>[
      VfsSuggestion(
        id: 'temp',
        kind: SuggestionKind.tempFiles,
        title: '${temps.length} 个临时文件',
        reason: '下载中断留下的半成品一般可以直接删。',
        targets: temps.map((VfsNode n) => n.path).toList(),
        estimatedBytes: bytes,
      ),
    ];
  }

  static String _extension(String name) {
    final index = name.lastIndexOf('.');
    if (index <= 0 || index == name.length - 1) return '';
    return name.substring(index).toLowerCase();
  }
}
