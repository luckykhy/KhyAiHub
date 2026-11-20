// 批量重命名的判据测试。
//
// 这里钉的是「算式」：预览和执行用的是同一套算式（[BatchRenamePlanner.plan]），
// 所以只要算式对，界面显示什么就等于会发生什么。算式错 = 用户看着预览点确认，
// 结果改出一堆错名——那是最不可接受的一类 bug。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/batch_rename.dart';
import 'package:khy_os_client/core/vfs/vfs_node.dart';

void main() {
  VfsNode node(String name, {int size = 100, String path = '/sd/Download/x'}) {
    return VfsNode(
      name: name,
      path: path.replaceAll('x', name),
      isDirectory: false,
      size: size,
    );
  }

  group('模板模式', () {
    test('序号补零并保留扩展名', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt'), node('b.txt')],
        const RenameRule(template: '{name}_{n}'),
        now: DateTime(2026, 11, 9),
      );
      expect(items[0].targetName, 'a_001.txt');
      expect(items[1].targetName, 'b_002.txt');
      expect(items.every((RenamePlanItem i) => i.executable), isTrue);
    });

    test('序号起始值与步长可调', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt'), node('b.txt'), node('c.txt')],
        const RenameRule(template: '{n}', startIndex: 10, step: 5),
        now: DateTime(2026, 11, 9),
      );
      expect(items[0].targetName, '010.txt');
      expect(items[1].targetName, '015.txt');
      expect(items[2].targetName, '020.txt');
    });

    test('模板里没写扩展名时自动补回', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('report.pdf')],
        const RenameRule(template: '扫描件'),
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.targetName, '扫描件.pdf');
    });

    test('显式写 {ext} 时不重复补', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt')],
        const RenameRule(template: '{name}_{ext}'),
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.targetName, 'a_.txt');
    });

    test('日期占位符按指定格式', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt')],
        const RenameRule(template: '{date:yyyy-MM-dd}_{n}'),
        now: DateTime(2026, 11, 9, 12, 30),
      );
      expect(items.first.targetName, '2026-11-09_001.txt');
    });

    test('默认日期格式是 yyyyMMdd', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt')],
        const RenameRule(template: '{date}'),
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.targetName, '20261109.txt');
    });

    test('{parent} 取所在目录名', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt', path: '/storage/emulated/0/Download/x')],
        const RenameRule(template: '{parent}_{n}'),
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.targetName, 'Download_001.txt');
    });
  });

  group('正则模式', () {
    test('查找替换', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('IMG_001.jpg'), node('IMG_002.jpg')],
        const RenameRule(
          mode: RenameMode.regex,
          search: 'IMG',
          replace: 'Photo',
        ),
        now: DateTime(2026, 11, 9),
      );
      expect(items[0].targetName, 'Photo_001.jpg');
      expect(items[1].targetName, 'Photo_002.jpg');
    });

    test(r'分组引用 $1', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('note_abc.txt')],
        const RenameRule(
          mode: RenameMode.regex,
          search: r'note_(\w+)',
          replace: r'\1-backup',
        ),
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.targetName, 'abc-backup.txt');
    });

    test('忽略大小写可开', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('img.jpg')],
        const RenameRule(
          mode: RenameMode.regex,
          search: 'IMG',
          replace: 'Photo',
          ignoreCase: true,
        ),
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.targetName, 'Photo.jpg');
    });

    test('非法正则不抛，标记为名称未变', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt')],
        const RenameRule(
          mode: RenameMode.regex,
          search: '([',
          replace: 'x',
        ),
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.status, RenameItemStatus.unchanged);
    });
  });

  group('冲突与合法性预检', () {
    test('目标已存在 → 冲突', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt')],
        const RenameRule(template: 'b'),
        existingNames: <String>{'b.txt'},
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.status, RenameItemStatus.conflict);
      expect(items.first.reason, contains('已存在'));
    });

    test('批次内重名 → 第二条标记重名', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt'), node('b.txt')],
        const RenameRule(template: 'same'),
        now: DateTime(2026, 11, 9),
      );
      expect(items[0].status, RenameItemStatus.ok);
      expect(items[1].status, RenameItemStatus.duplicate);
    });

    test('含路径分隔符的目标名 → 非法', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt')],
        const RenameRule(template: 'x/y'),
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.status, RenameItemStatus.invalid);
      expect(items.first.reason, contains('分隔符'));
    });

    test('空目标名 → 非法', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt')],
        const RenameRule(template: ''),
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.status, RenameItemStatus.invalid);
    });

    test('与原名相同 → 名称未变', () {
      final items = BatchRenamePlanner.plan(
        <VfsNode>[node('a.txt')],
        const RenameRule(template: '{name}'),
        now: DateTime(2026, 11, 9),
      );
      expect(items.first.status, RenameItemStatus.unchanged);
    });
  });
}
