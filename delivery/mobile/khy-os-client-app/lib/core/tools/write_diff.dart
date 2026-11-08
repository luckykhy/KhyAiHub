import 'dart:math' as math;

/// 红绿 ± 行模型 —— APK 端手写实现。
///
/// 后端 / 桌面端 / 网页端共用 `cli/writeDiffRows.buildWriteDiffRows` 的行契约
/// （kind = add | del | ctx | gap | more），APK 是独立进程、不连那条链，只能按同一份
/// 契约自己算一次。口径对齐处：3 行上下文、整段未改动折成一行 gap、先红后绿。
class WriteDiffRow {
  final String kind;
  final int? num;
  final int? numNew;
  final String text;

  const WriteDiffRow(this.kind, this.text, {this.num, this.numNew});
}

class WriteDiff {
  final String filePath;
  final List<WriteDiffRow> rows;
  final int added;
  final int removed;
  final bool truncated;

  const WriteDiff({
    required this.filePath,
    required this.rows,
    required this.added,
    required this.removed,
    required this.truncated,
  });
}

class _Op {
  /// equal | del | add
  final String kind;
  final int? oldNum;
  final int? newNum;
  final String text;

  const _Op(this.kind, this.text, {this.oldNum, this.newNum});
}

class WriteDiffBuilder {
  static const int _contextLines = 3;
  static const int _maxRows = 300;

  /// LCS 表的格数上限。超了就不算逐行差异，退回「整段删 + 整段加」并标记
  /// truncated —— 手机内存里铺一张 2000×2000 的 int 表不值得。
  static const int _maxLines = 1500;

  /// 从工具结果的 metadata 取出写入前后的原文（native 侧回传）。
  /// 拿不到原文（老版本 App、文件超限）就返回 null：宁可没有 diff，也不画错的。
  static WriteDiff? fromMetadata(Map<String, dynamic>? metadata) {
    final raw = metadata?['writeDiff'];
    if (raw is! Map) return null;
    final filePath = (raw['filePath'] ?? '').toString();
    final before = raw['before']?.toString() ?? '';
    final after = raw['after']?.toString() ?? '';
    return build(filePath: filePath, before: before, after: after);
  }

  static WriteDiff? build({
    required String filePath,
    required String before,
    required String after,
  }) {
    if (before == after) return null;
    final oldLines = _split(before);
    final newLines = _split(after);

    if (oldLines.isEmpty) {
      return _singleSided(filePath, newLines, added: true);
    }
    if (newLines.isEmpty) {
      return _singleSided(filePath, oldLines, added: false);
    }

    if (oldLines.length > _maxLines || newLines.length > _maxLines) {
      return WriteDiff(
        filePath: filePath,
        rows: [
          for (var i = 0; i < math.min(oldLines.length, _maxRows ~/ 2); i++)
            WriteDiffRow('del', oldLines[i], num: i + 1),
          for (var i = 0; i < math.min(newLines.length, _maxRows ~/ 2); i++)
            WriteDiffRow('add', newLines[i], num: i + 1, numNew: i + 1),
          const WriteDiffRow('more', '…… 文件过大，只显示开头部分'),
        ],
        added: newLines.length,
        removed: oldLines.length,
        truncated: true,
      );
    }

    // 自底向上的 LCS 长度表；回走时同长优先取「删」，得到「先红后绿」的整段顺序。
    final n = oldLines.length;
    final m = newLines.length;
    final dp = List<List<int>>.generate(
      n + 1,
      (_) => List<int>.filled(m + 1, 0),
      growable: false,
    );
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = oldLines[i] == newLines[j]
            ? dp[i + 1][j + 1] + 1
            : math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    final ops = <_Op>[];
    var i = 0;
    var j = 0;
    while (i < n && j < m) {
      if (oldLines[i] == newLines[j]) {
        ops.add(_Op('equal', oldLines[i], oldNum: i + 1, newNum: j + 1));
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.add(_Op('del', oldLines[i], oldNum: i + 1));
        i++;
      } else {
        ops.add(_Op('add', newLines[j], newNum: j + 1));
        j++;
      }
    }
    while (i < n) {
      ops.add(_Op('del', oldLines[i], oldNum: i + 1));
      i++;
    }
    while (j < m) {
      ops.add(_Op('add', newLines[j], newNum: j + 1));
      j++;
    }

    var added = 0;
    var removed = 0;
    for (final op in ops) {
      if (op.kind == 'add') added++;
      if (op.kind == 'del') removed++;
    }
    if (added == 0 && removed == 0) return null;

    final keep = List<bool>.filled(ops.length, false);
    for (var k = 0; k < ops.length; k++) {
      if (ops[k].kind == 'equal') continue;
      final from = math.max(0, k - _contextLines);
      final to = math.min(ops.length - 1, k + _contextLines);
      for (var c = from; c <= to; c++) {
        keep[c] = true;
      }
    }

    final rows = <WriteDiffRow>[];
    var k = 0;
    while (k < ops.length) {
      if (keep[k]) {
        final op = ops[k];
        rows.add(WriteDiffRow(
          op.kind == 'equal' ? 'ctx' : op.kind,
          op.text,
          num: op.oldNum,
          numNew: op.newNum,
        ));
        k++;
        continue;
      }
      // 不保留的只可能是「相同行」的连续段；数字是这段真实行数，不是估算。
      final start = k;
      while (k < ops.length && !keep[k]) {
        k++;
      }
      rows.add(WriteDiffRow('gap', '⋯ ${k - start} 行未改动'));
    }

    var truncated = false;
    if (rows.length > _maxRows) {
      final dropped = rows.length - _maxRows;
      rows.removeRange(_maxRows, rows.length);
      rows.add(WriteDiffRow('more', '…… 还有 $dropped 行未显示'));
      truncated = true;
    }

    return WriteDiff(
      filePath: filePath,
      rows: rows,
      added: added,
      removed: removed,
      truncated: truncated,
    );
  }

  static WriteDiff _singleSided(String filePath, List<String> lines, {required bool added}) {
    final keep = math.min(lines.length, _maxRows);
    return WriteDiff(
      filePath: filePath,
      rows: [
        for (var i = 0; i < keep; i++)
          added
              ? WriteDiffRow('add', lines[i], num: i + 1, numNew: i + 1)
              : WriteDiffRow('del', lines[i], num: i + 1),
        if (lines.length > keep)
          WriteDiffRow('more', '…… 还有 ${lines.length - keep} 行未显示'),
      ],
      added: added ? lines.length : 0,
      removed: added ? 0 : lines.length,
      truncated: lines.length > keep,
    );
  }

  static List<String> _split(String text) {
    final arr = text.split('\n');
    if (arr.isNotEmpty && arr.last.isEmpty) arr.removeLast();
    return arr;
  }
}
