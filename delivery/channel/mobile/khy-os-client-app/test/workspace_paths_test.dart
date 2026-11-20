import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/workspace/workspace_paths.dart';

/// 工作空间路径文法的测试。
///
/// 全在主机上跑：这一层不碰盘（`dart:io` 的活儿在 WorkspaceStore，需要设备）。
/// 而最容易错的部分恰好都在这里——尤其是 slug 校验，那不是"名字好不好看"，
/// 是目录逃逸。
void main() {
  group('路径文法', () {
    test('通用工作空间落在 <root>/workspace', () {
      final ws = WorkspacePaths(root: '/sdcard/khy-os');
      expect(ws.dir, '/sdcard/khy-os/workspace');
      expect(ws.tmpDir, '/sdcard/khy-os/workspace/tmp');
      expect(ws.kindLabel, '通用任务工作空间');
    });

    test('专用工作空间落在 <root>/tasks/<slug>', () {
      final ws = WorkspacePaths(
        root: '/sdcard/khy-os',
        kind: WorkspaceKind.dedicated,
        slug: 'weixin-export',
      );
      expect(ws.dir, '/sdcard/khy-os/tasks/weixin-export');
      expect(ws.tmpDir, '/sdcard/khy-os/tasks/weixin-export/tmp');
      expect(ws.kindLabel, '专用任务工作空间');
    });

    test('默认根在共享存储上，用户和文件管理器都看得见', () {
      // 这是设计前提：工作空间放进 App 私有目录就谁也看不见了，等于没建。
      expect(WorkspaceLayout.defaultRoot, '/sdcard/khy-os');
    });

    test('两种 kind 的 wire 值可往返', () {
      for (final k in WorkspaceKind.values) {
        expect(WorkspaceKind.parse(k.wire), k);
      }
    });

    test('未知 kind 退回通用而不是专用', () {
      // 反过来的话，一个拼错的 kind 会把文件写进一个凭空捏造的专用任务目录，
      // 用户永远找不到。
      expect(WorkspaceKind.parse('typo'), WorkspaceKind.general);
      expect(WorkspaceKind.parse(null), WorkspaceKind.general);
    });

    test('相等性按 root+kind+slug', () {
      const a = WorkspacePaths(root: '/r', kind: WorkspaceKind.general);
      const b = WorkspacePaths(root: '/r', kind: WorkspaceKind.general);
      const c = WorkspacePaths(root: '/r', kind: WorkspaceKind.general, slug: 'x');
      expect(a, b);
      expect(a.hashCode, b.hashCode);
      expect(a == c, false);
    });

    test('copy 构造保持三个字段', () {
      const src = WorkspacePaths(
        root: '/r',
        kind: WorkspaceKind.dedicated,
        slug: 't',
      );
      final cp = WorkspacePaths.copy(src);
      expect(cp.root, src.root);
      expect(cp.kind, src.kind);
      expect(cp.slug, src.slug);
    });
  });

  group('slug 校验：目录逃逸是这里唯一要紧的事', () {
    test('拒绝能跳出工作空间的名字', () {
      for (final bad in <String>[
        '..',
        '.',
        '../../..',
        'a/../../b',
        '/etc/passwd',
        'a/b',
        'a\\b',
      ]) {
        expect(WorkspaceSlug.validate(WorkspaceSlug.normalize(bad)), isNotNull,
            reason: '$bad 必须被拒绝');
      }
    });

    test('拒绝保留字', () {
      for (final r in WorkspaceLayout.reservedSlugs) {
        expect(WorkspaceSlug.validate(r), isNotNull, reason: '$r 是保留字');
      }
    });

    test('拒绝空、过长、非法字符、危险首尾', () {
      expect(WorkspaceSlug.validate(''), isNotNull);
      expect(WorkspaceSlug.validate('a' * 65), isNotNull);
      expect(WorkspaceSlug.validate('a b'), isNotNull); // 未规整的空格
      expect(WorkspaceSlug.validate('任务名'), isNotNull); // 非 ASCII
      expect(WorkspaceSlug.validate('-lead'), isNotNull);
      expect(WorkspaceSlug.validate('.hidden'), isNotNull);
      expect(WorkspaceSlug.validate('trail.'), isNotNull);
      expect(WorkspaceSlug.validate('trail-'), isNotNull);
      expect(WorkspaceSlug.validate('a..b'), isNotNull);
    });

    test('接受合理的名字', () {
      for (final ok in <String>[
        'weixin-export',
        'task_1',
        'a.b.c',
        'v1.2.3',
        'a' * 64,
        'x',
      ]) {
        expect(WorkspaceSlug.validate(ok), isNull, reason: '$ok 应当合法');
      }
    });

    test('normalize 只做无语义损失的规整', () {
      expect(WorkspaceSlug.normalize('  WeChat Export  '), 'wechat-export');
      expect(WorkspaceSlug.normalize('A_B'), 'a_b');
    });

    test('normalize 不会把非法字符洗成合法——洗过也还是非法', () {
      // 关键：如果 normalize 顺手把中文或 / 替换掉，校验就永远发现不了问题，
      // 于是"拒绝"这道防线形同不存在。这里确认它不替用户猜。
      final n = WorkspaceSlug.normalize('任务/名');
      expect(WorkspaceSlug.validate(n), isNotNull);
    });

    test('canonical 合法时返回规整名', () {
      expect(WorkspaceSlug.canonical('  WeChat Export '), 'wechat-export');
    });

    test('canonical 非法时抛 ArgumentError 且带上理由', () {
      expect(
        () => WorkspaceSlug.canonical('../escape'),
        throwsA(isA<ArgumentError>().having(
          (e) => e.message,
          'message',
          // `../escape` 先撞上分隔符检查，两者都是逃逸专用的话——只要报的是
          // 逃逸而不是泛泛的字符集，方向就是对的。
          contains('跳出工作空间'),
        )),
      );
    });

    test('没有分隔符的 .. 也报逃逸', () {
      expect(
        () => WorkspaceSlug.canonical('a..b'),
        throwsA(isA<ArgumentError>().having(
          (e) => e.message,
          'message',
          allOf(contains('..'), contains('跳出工作空间')),
        )),
      );
    });

    test('路径分隔符也报逃逸，不报字符集', () {
      expect(
        () => WorkspaceSlug.canonical('a/b'),
        throwsA(isA<ArgumentError>().having(
          (e) => e.message,
          'message',
          allOf(contains('路径分隔符'), contains('跳出工作空间')),
        )),
      );
    });
  });

  group('保留时间', () {
    test('默认 24 小时', () {
      expect(WorkspaceLayout.tmpRetention, const Duration(hours: 24));
    });

    test('保留时间必须长于最长合法任务', () {
      // 判据写进测试：amoo 一轮提问约 6 分钟。保留时间必须明显长于它，
      // 否则扫孤儿会删掉还在跑的任务的中间产物。
      const longestTask = Duration(minutes: 6);
      expect(WorkspaceLayout.tmpRetention > longestTask * 10, true,
          reason: '保留时间必须至少是最长任务的 10 倍');
    });

    test('slug 上限是正数且合理', () {
      expect(WorkspaceLayout.maxSlugLength, greaterThan(0));
      expect(WorkspaceLayout.maxSlugLength, lessThanOrEqualTo(255));
    });
  });
}
