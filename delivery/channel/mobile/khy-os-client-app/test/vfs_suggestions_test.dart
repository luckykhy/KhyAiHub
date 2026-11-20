// AI 主动建议的判据测试。
//
// 建议引擎的价值全在「给的是线索还是结论」：
//   - 同名同大小 → **线索**（可能重复，不等于就是重复）；
//   - 大文件 / 久未动 / 安装包 / 临时文件 → **确定的元数据**。
// 测试要钉住这个区别：把线索说成结论，或把结论漏掉，都不行。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_node.dart';
import 'package:khy_os_client/core/vfs/vfs_suggestions.dart';

void main() {
  final now = DateTime(2026, 11, 9);

  VfsNode file(
    String name, {
    int size = 100,
    int daysAgo = 1,
    bool isDirectory = false,
  }) {
    return VfsNode(
      name: name,
      path: '/sdcard/$name',
      isDirectory: isDirectory,
      size: size,
      modifiedMs: now
          .subtract(Duration(days: daysAgo))
          .millisecondsSinceEpoch,
    );
  }

  VfsSuggestion? find(List<VfsSuggestion> list, SuggestionKind kind) {
    for (final item in list) {
      if (item.kind == kind) return item;
    }
    return null;
  }

  group('重复文件', () {
    test('同名同大小的多份会被提示，可回收空间按「少一份」算', () {
      final suggestions = VfsSuggestions.analyze(
        <VfsNode>[
          file('photo.jpg', size: 1000),
          file('photo.jpg', size: 1000),
          file('photo.jpg', size: 1000),
        ],
        now: now,
      );
      final duplicate = find(suggestions, SuggestionKind.duplicates);
      expect(duplicate, isNotNull);
      expect(duplicate!.title, contains('3 份'));
      expect(duplicate.estimatedBytes, 2000);
      expect(duplicate.targets, hasLength(3));
      // 说的是「疑似」，不是断言就是重复。
      expect(duplicate.reason, contains('可能'));
    });

    test('同名但大小不同不算重复', () {
      final suggestions = VfsSuggestions.analyze(
        <VfsNode>[
          file('photo.jpg', size: 1000),
          file('photo.jpg', size: 2000),
        ],
        now: now,
      );
      expect(find(suggestions, SuggestionKind.duplicates), isNull);
    });

    test('不同名同大小不算重复', () {
      final suggestions = VfsSuggestions.analyze(
        <VfsNode>[
          file('a.jpg', size: 1000),
          file('b.jpg', size: 1000),
        ],
        now: now,
      );
      expect(find(suggestions, SuggestionKind.duplicates), isNull);
    });
  });

  group('其它几类', () {
    test('超过 100MB 的文件被提示', () {
      final suggestions = VfsSuggestions.analyze(
        <VfsNode>[file('movie.mp4', size: 200 * 1024 * 1024)],
        now: now,
      );
      final large = find(suggestions, SuggestionKind.largeFiles);
      expect(large, isNotNull);
      expect(large!.estimatedBytes, 200 * 1024 * 1024);
    });

    test('刚好 100MB 不算大文件（阈值是「超过」）', () {
      final suggestions = VfsSuggestions.analyze(
        <VfsNode>[file('edge.bin', size: 100 * 1024 * 1024)],
        now: now,
      );
      expect(find(suggestions, SuggestionKind.largeFiles), isNull);
    });

    test('90 天没动过的文件被提示', () {
      final suggestions = VfsSuggestions.analyze(
        <VfsNode>[file('old.log', daysAgo: 120)],
        now: now,
      );
      expect(find(suggestions, SuggestionKind.staleFiles), isNotNull);
    });

    test('刚动过的文件不算残留', () {
      final suggestions = VfsSuggestions.analyze(
        <VfsNode>[file('new.log', daysAgo: 3)],
        now: now,
      );
      expect(find(suggestions, SuggestionKind.staleFiles), isNull);
    });

    test('安装包与临时文件分别被提示', () {
      final suggestions = VfsSuggestions.analyze(
        <VfsNode>[
          file('app.apk', size: 50 * 1024 * 1024),
          file('part.crdownload'),
        ],
        now: now,
      );
      expect(find(suggestions, SuggestionKind.installPackages), isNotNull);
      expect(find(suggestions, SuggestionKind.tempFiles), isNotNull);
    });

    test('目录不参与这些判断', () {
      final suggestions = VfsSuggestions.analyze(
        <VfsNode>[
          file('folder', size: 0, isDirectory: true),
        ],
        now: now,
      );
      expect(suggestions, isEmpty);
    });
  });

  group('排序与空输入', () {
    test('可回收空间大的排前面', () {
      final suggestions = VfsSuggestions.analyze(
        <VfsNode>[
          file('small.apk', size: 1024),
          file('big.apk', size: 80 * 1024 * 1024),
        ],
        now: now,
      );
      expect(suggestions, isNotEmpty);
      expect(suggestions.first.estimatedBytes,
          greaterThanOrEqualTo(suggestions.last.estimatedBytes));
    });

    test('空目录没有建议', () {
      expect(VfsSuggestions.analyze(const <VfsNode>[], now: now), isEmpty);
    });
  });
}
