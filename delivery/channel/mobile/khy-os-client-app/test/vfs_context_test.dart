// 文件管理器上下文 → 给模型的 prompt 文本。
//
// 为什么值得测：这段文本就是**模型看到的全部事实**。它说错的每一句话，
// 都会变成模型一个错误的假设——而模型不会告诉你它假设过什么。
// 此前这段纯逻辑零覆盖。
//
// 钉四件事：
//   1. 没有当前路径时**整行省掉**，不退成 '/'（不给模型编造的事实）；
//   2. 选中项逐行列全，超过 20 项时如实报告「另有 N 项」；
//   3. 最近操作逐行列全（含来源标记），超过 5 条只取前 5 条；
//   4. 三者可以任意组合出现/不出现。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/audit_log.dart';
import 'package:khy_os_client/core/vfs/vfs_context.dart';

AuditEntry _op(
  String operation, {
  String path = '/a',
  AuditSource source = AuditSource.user,
}) =>
    AuditEntry(
      time: DateTime.fromMillisecondsSinceEpoch(1700000000000),
      source: source,
      operation: operation,
      path: path,
    );

void main() {
  group('当前路径', () {
    test('有路径时照实说', () {
      const ctx = VfsContext(currentPath: '/storage/emulated/0/Download');
      expect(ctx.toPrompt(), contains('当前路径：/storage/emulated/0/Download'));
    });

    test('空路径时整行省掉，不退成 /', () {
      // 自动化脚本生成那一类入口不在浏览任何目录。告诉模型「当前路径：/」
      // 是给它一个编造的事实——它会拿当线索（比如猜输出该放哪）。
      const ctx = VfsContext();
      final prompt = ctx.toPrompt();
      expect(prompt, isNot(contains('当前路径')));
      expect(prompt.trim(), isEmpty, reason: '三者都空时 prompt 应该是空的');
    });

    test('只有路径、没有选中项与操作时只出一行', () {
      const ctx = VfsContext(currentPath: '/tmp');
      expect(ctx.toPrompt().trim(), '当前路径：/tmp');
    });
  });

  group('选中项', () {
    test('hasSelection 与内容一致', () {
      const empty = VfsContext(currentPath: '/x');
      const some = VfsContext(currentPath: '/x', selectedPaths: <String>['/x/a']);
      expect(empty.hasSelection, isFalse);
      expect(some.hasSelection, isTrue);
    });

    test('逐行列全', () {
      const ctx = VfsContext(
        currentPath: '/x',
        selectedPaths: <String>['/x/a.txt', '/x/b.txt'],
      );
      final prompt = ctx.toPrompt();
      expect(prompt, contains('选中项：'));
      expect(prompt, contains('  - /x/a.txt'));
      expect(prompt, contains('  - /x/b.txt'));
    });

    test('超过 20 项时截断并如实报告另有几项', () {
      final many = List<String>.generate(25, (int i) => '/x/f$i');
      final ctx = VfsContext(currentPath: '/x', selectedPaths: many);
      final prompt = ctx.toPrompt();
      expect(prompt, contains('  - /x/f0'));
      expect(prompt, contains('  - /x/f19'));
      expect(prompt, isNot(contains('  - /x/f20')),
          reason: '第 21 项起不该逐条列出');
      expect(prompt, contains('  …… 另有 5 项'));
    });
  });

  group('最近操作', () {
    test('逐条列出，带来源标记', () {
      const ctx = VfsContext(
        currentPath: '/x',
        recentOps: <AuditEntry>[],
      );
      expect(ctx.toPrompt(), isNot(contains('最近操作')),
          reason: '空列表时不该出这一节');

      final withOps = VfsContext(
        currentPath: '/x',
        recentOps: <AuditEntry>[
          _op('copy', path: '/x/a', source: AuditSource.ai),
          _op('delete', path: '/x/b', source: AuditSource.user),
        ],
      );
      final prompt = withOps.toPrompt();
      expect(prompt, contains('最近操作：'));
      expect(prompt, contains('AI 建议：copy /x/a'));
      expect(prompt, contains('用户手动：delete /x/b'));
    });

    test('只取前 5 条（上下文要小）', () {
      final many = List<AuditEntry>.generate(
        9,
        (int i) => _op('op$i', path: '/x/$i'),
      );
      final ctx = VfsContext(currentPath: '/x', recentOps: many);
      final prompt = ctx.toPrompt();
      expect(prompt, contains('op0'));
      expect(prompt, contains('op4'));
      expect(prompt, isNot(contains('op5')), reason: '第 6 条起不该出现');
    });
  });

  group('组合', () {
    test('三段可以同时出现', () {
      final ctx = VfsContext(
        currentPath: '/x',
        selectedPaths: const <String>['/x/a'],
        recentOps: <AuditEntry>[_op('mkdir', path: '/x')],
      );
      final prompt = ctx.toPrompt();
      expect(prompt, contains('当前路径：/x'));
      expect(prompt, contains('选中项：'));
      expect(prompt, contains('最近操作：'));
    });

    test('有选中项但没有路径时也不会伪造路径', () {
      const ctx = VfsContext(selectedPaths: <String>['/a']);
      expect(ctx.toPrompt(), isNot(contains('当前路径')));
      expect(ctx.toPrompt(), contains('  - /a'));
    });
  });
}
