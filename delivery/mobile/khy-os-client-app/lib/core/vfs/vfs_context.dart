// 文件管理器上下文：AI 看得到什么。
//
// AI 的建议要「针对性」，前提是它知道用户此刻在哪、选了什么、刚做过什么。
// 没有上下文，AI 只能给泛泛而谈的废话（「建议定期清理」），那种建议对专业用户
// 是噪音——他们自己能做，缺的只是「现在该做什么」。
//
// 上下文要**小**：只放当前路径、选中项、最近几条操作。放太多反而稀释重点，
// 而且选中项的路径可能带敏感信息，不该整目录塞给模型。

import 'package:meta/meta.dart';

import 'vfs_audit.dart';

/// 一次文件操作上下文。
@immutable
class VfsContext {
  /// 当前所在路径。
  final String currentPath;

  /// 当前选中的条目路径。
  final List<String> selectedPaths;

  /// 最近的操作（新的在前）。
  final List<VfsAuditEntry> recentOps;

  const VfsContext({
    this.currentPath = '/',
    this.selectedPaths = const <String>[],
    this.recentOps = const <VfsAuditEntry>[],
  });

  bool get hasSelection => selectedPaths.isNotEmpty;

  /// 上下文摘要。给模型看的就是这段文本——短、准、可核查。
  String toPrompt() {
    final buffer = StringBuffer();
    buffer.writeln('当前路径：${currentPath.isEmpty ? '/' : currentPath}');
    if (selectedPaths.isNotEmpty) {
      buffer.writeln('选中项：');
      for (final path in selectedPaths.take(20)) {
        buffer.writeln('  - $path');
      }
      if (selectedPaths.length > 20) {
        buffer.writeln('  …… 另有 ${selectedPaths.length - 20} 项');
      }
    }
    if (recentOps.isNotEmpty) {
      buffer.writeln('最近操作：');
      for (final op in recentOps.take(5)) {
        buffer.writeln('  - ${op.source.label}：${op.operation} ${op.path}');
      }
    }
    return buffer.toString();
  }
}
