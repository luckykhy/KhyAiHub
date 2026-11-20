import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 通道**字段**契约：Dart 从原生回执里读的每个键，原生必须真的写。
///
/// ## 为什么要有这个套件（与 `vfs_channel_wiring_test` 是同一类问题）
///
/// 那个套件盯**方法名**，这个盯**字段名**。两者的失败形态一样安静：
///
/// - 原生把 `"size" to n` 改成 `"sizeBytes" to n`；
/// - Dart 的 `fromMap` 读不到 `size`，落默认值 `0`；
/// - 界面显示「0 B」，**不报错、不抛异常、日志里什么都没有**。
///
/// 单测更抓不到：Dart 单测 mock 掉通道，回执是测试作者手写的 map——
/// 手写的那份自然对得上测试作者心里那个字段名，两边一起错就一起绿。
///
/// ## 判据的方向性
///
/// 只钉 **Dart 读 ⊆ Kotlin 写**。反方向（Kotlin 多写）是良性的：
/// Dart 的 `fromMap` 本来就允许原生少给/多给字段（`map['x'] ?? 默认值`），
/// 多写的字段只是线上格式的兼容余量。
///
/// 实例：`ArchiveCore.entryMap` 写 8 个键（含 `path`），Dart 的
/// `ArchiveEntry.fromMap` 只读 7 个——`path` 与 `name` 同值，而
/// `VfsArchive` 的文档明说「归档内的条目没有真实路径这个概念」，
/// 所以 Dart 不读它是**刻意的**，不是漏的。
void main() {
  group('VFS 通道字段契约', () {
    test('VfsNode：Dart 读的每个字段，原生 toMap 都写', () {
      final dartReads = _dartReadsIn(
        'lib/core/vfs/vfs_node.dart',
        'factory VfsNode.fromMap',
      );
      final kotlinWrites = _kotlinWritesIn(
        'android/app/src/main/kotlin/com/khyos/khy_os_client/vfs/VfsBridge.kt',
        'fun toMap()',
      );

      expect(dartReads, isNotEmpty, reason: 'Dart 侧 VfsNode.fromMap 读不到字段');
      expect(kotlinWrites, isNotEmpty, reason: '原生侧 VfsNode.toMap 写不到字段');

      final missing = dartReads.where((k) => !kotlinWrites.contains(k)).toList();
      expect(
        missing,
        isEmpty,
        reason: '这些字段 Dart 在读，原生却不写——\n'
            '真机上每一项都会落默认值（size=0 / mode="" / mime=octet-stream），\n'
            '界面照常显示，只是数字是假的：\n'
            '  ${missing.join('\n  ')}',
      );
    });

    test('ArchiveEntry：Dart 读的每个字段，原生 entryMap 都写', () {
      final dartReads = _dartReadsIn(
        'lib/core/vfs/vfs_archive.dart',
        'factory ArchiveEntry.fromMap',
      );
      final kotlinWrites = _kotlinWritesIn(
        'android/app/src/main/kotlin/com/khyos/khy_os_client/vfs/ArchiveCore.kt',
        'private fun entryMap(',
      );

      expect(dartReads, isNotEmpty, reason: 'Dart 侧 ArchiveEntry.fromMap 读不到字段');
      expect(kotlinWrites, isNotEmpty, reason: '原生侧 ArchiveCore.entryMap 写不到字段');

      final missing = dartReads.where((k) => !kotlinWrites.contains(k)).toList();
      expect(
        missing,
        isEmpty,
        reason: '这些字段 Dart 在读，原生却不写——\n'
            '归档列表会显示 0 字节 / 空 MIME，而且不报错：\n'
            '  ${missing.join('\n  ')}',
      );
    });

    test('存储分析：Dart 读的每个字段，原生 analyze 都写', () {
      // 四个结构体（StorageTypeStat / StorageFolderStat / StorageFileStat /
      // StorageMonthStat）+ 顶层 StorageAnalysis。任一处字段名漂移，
      // 界面上的那一维就静默变成 0——而用户看到的是一个「看起来正常」的统计。
      //
      // 这里整文件扫而不是按函数体扫：StorageAnalysis.fromMap 里有一个局部
      // 函数 parse<T>()，它的右花括号会提前命中「函数体结束」的判据。
      final allDartReads = _dartReadsInFile('lib/core/vfs/vfs_analysis.dart');

      final kotlinWrites = _kotlinWritesIn(
        'android/app/src/main/kotlin/com/khyos/khy_os_client/vfs/VfsAnalyze.kt',
        'fun analyze(context: Context, call: MethodCall)',
      );

      expect(allDartReads, isNotEmpty, reason: 'Dart 侧一个字段都读不到');
      expect(kotlinWrites, isNotEmpty, reason: '原生侧 analyze 回执写不到字段');

      // `notice` 是 Dart 侧的旧叫法，`fromMap` 里 `map['message'] ?? map['notice']`
      // 先读原生写的 `message`，`notice` 只是给老数据兜底——不是漂移，排除掉。
      const legacyAliases = <String>{'notice'};
      final missing = allDartReads
          .where((k) => !legacyAliases.contains(k) && !kotlinWrites.contains(k))
          .toList();
      expect(
        missing,
        isEmpty,
        reason: '这些字段 Dart 在读，原生却不写——\n'
            '存储分析的那一维会静默显示 0，而用户看到一个「看起来正常」的统计：\n'
            '  ${missing.join('\n  ')}',
      );
    });
  });
}

/// Dart 侧：从 [path] 里 [anchor] 标注的函数体中，收集 `map['key']` 的键名。
Set<String> _dartReadsIn(String path, String anchor) {
  final file = File(path);
  if (!file.existsSync()) return const <String>{};
  final lines = file.readAsLinesSync();

  final out = <String>{};
  var inBody = false;
  for (final line in lines) {
    if (!inBody) {
      if (line.contains(anchor)) inBody = true;
      continue;
    }
    // 函数体到右花括号结束（这些 fromMap 都是单层花括号）。
    if (RegExp(r'^\s*\}\s*;?\s*$').hasMatch(line)) break;
    final m = RegExp(r'''map\[['"]([A-Za-z0-9_]+)['"]\]''').firstMatch(line);
    if (m != null) out.add(m.group(1)!);
  }
  return out;
}

/// Dart 侧：整个文件里所有 `map['key']` 的键名。
Set<String> _dartReadsInFile(String path) {
  final file = File(path);
  if (!file.existsSync()) return const <String>{};
  final out = <String>{};
  for (final match in RegExp(r'''map\[['"]([A-Za-z0-9_]+)['"]\]''').allMatches(
    file.readAsStringSync(),
  )) {
    out.add(match.group(1)!);
  }
  return out;
}

/// Kotlin 侧：从 [path] 里 [anchor] 标注的函数体中，收集 `"key" to value` 的键名。
///
/// 终止符按**函数体形态**选，不能一律用「单独一行的 `)`」：
///  - 表达式体（`... = mapOf(` … `)`）→ 终止于单独一行的 `)`；
///  - 花括号体（`... {` … `}`）→ 终止于缩进 ≤ 4 的 `}`（即这个成员自己的收尾）。
///
/// 为什么不能一律用 `)`：`VfsAnalyze.analyze` 的回执是
/// `state.byType.entries.map { (t, acc) -> mapOf( ... ) }` 这种**嵌套 lambda**，
/// 里面第一个 `mapOf(` 的收尾 `)` 远早于函数结束——一律用 `)` 只会收到 3 个键
/// 就停，然后所有顶层字段都被误判成「Dart 读而 Kotlin 不写」。
Set<String> _kotlinWritesIn(String path, String anchor) {
  final file = File(path);
  if (!file.existsSync()) return const <String>{};
  final lines = file.readAsLinesSync();

  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].contains(anchor)) {
      start = i;
      break;
    }
  }
  if (start < 0) return const <String>{};

  // 锚点行以 `{` 结尾 → 花括号体；否则是表达式体。
  final blockBody = lines[start].trimRight().endsWith('{');
  final end = blockBody
      ? RegExp(r'^\s{0,4}\}\s*$')
      : RegExp(r'^\s*\)\s*$');

  final out = <String>{};
  for (var i = start + 1; i < lines.length; i++) {
    if (end.hasMatch(lines[i])) break;
    final m = RegExp(r'"([A-Za-z0-9_]+)"\s+to\s+').firstMatch(lines[i]);
    if (m != null) out.add(m.group(1)!);
  }
  return out;
}
