import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/memory/memory_recall.dart';
import 'package:khy_os_client/core/memory/memory_store.dart';

/// 主动召回的排序与框式渲染测试。
///
/// 端口对象：`domain/memory/memoryEngine/scoring.js` 的 degrade 路径
/// （keywordScore × recency，无向量）与 `index.js` 的 `formatProactiveContext`。
void main() {
  final now = DateTime.utc(2026, 11, 4, 12).millisecondsSinceEpoch;
  final day = 86400000;

  MemoryEntry mem({
    required String id,
    required String name,
    required String body,
    String description = '',
    MemoryType type = MemoryType.project,
    MemoryTier? tier,
    int ageDays = 0,
    int recallCount = 0,
  }) {
    return MemoryEntry(
      id: id,
      name: name,
      description: description,
      type: type,
      tier: tier,
      body: body,
      updated: DateTime.fromMillisecondsSinceEpoch(now - ageDays * day, isUtc: true),
      recallCount: recallCount,
    );
  }

  group('no-op 契约', () {
    test('没有记忆时返回 null，不硬塞空段', () {
      expect(MemoryRecall.buildSection('咖啡机', const <MemoryEntry>[]), isNull);
    });

    test('查询没有任何可匹配 token 时返回 null', () {
      final entries = <MemoryEntry>[
        mem(id: 'p1', name: '咖啡机', body: '办公室的咖啡机是意式半自动。'),
      ];
      // 纯标点、纯单字母、空串都产出空 token 集
      expect(MemoryRecall.buildSection('。。。', entries), isNull);
      expect(MemoryRecall.buildSection('a b c', entries), isNull);
      expect(MemoryRecall.buildSection('   ', entries), isNull);
    });

    test('有记忆但零重叠时返回 null', () {
      final entries = <MemoryEntry>[
        mem(id: 'p1', name: '咖啡机', body: '办公室的咖啡机是意式半自动。'),
      ];
      expect(MemoryRecall.buildSection('git 提交历史怎么回退', entries), isNull);
    });
  });

  group('overlap × 时间衰减排序', () {
    // 三条记忆共享「咖啡」词根，但新鲜度与层级不同：
    //   stale  — 关键词最强，但已 60 天（跨会话层半衰期 30 天 → 衰减到 1/4）
    //   fresh  — 关键词弱，但刚写（不衰减）
    //   perm   — 关键词最强且 60 天，但永久层不衰减
    final stale = mem(
      id: 'project_stale',
      name: '咖啡机',
      body: '办公室的咖啡机是意式半自动，每天早上都要用。',
      ageDays: 60,
    );
    final fresh = mem(
      id: 'project_fresh',
      name: '咖啡豆',
      body: '咖啡豆买的中深烘，拼配比例是一比一。',
      ageDays: 0,
    );
    final perm = mem(
      id: 'project_perm',
      name: '咖啡机',
      body: '办公室的咖啡机是意式半自动，每天早上都要用。',
      tier: MemoryTier.permanent,
      ageDays: 60,
    );

    test('强重叠被时间衰减反超，永久层不被衰减', () {
      final ranked = MemoryRecall.rank('咖啡机怎么用', <MemoryEntry>[stale, fresh, perm],
          nowMs: now);
      final ids = ranked.map((h) => h.entry.id).toList();
      // perm 的关键词分最高且不衰减 → 第一；fresh 弱但新鲜 → 第二；
      // stale 关键词与 perm 相同却老了三倍半衰期 → 掉到最后。
      expect(ids, <String>['project_perm', 'project_fresh', 'project_stale']);
      expect(ranked.first.recency, 1.0);
      expect(ranked.last.recency, closeTo(0.25, 0.0001));
    });

    test('同分时新者优先，再同分按 id 定序（确定性）', () {
      final a = mem(id: 'b_second', name: '咖啡', body: '一杯咖啡。', ageDays: 10);
      final b = mem(id: 'a_first', name: '咖啡', body: '一杯咖啡。', ageDays: 10);
      final ranked = MemoryRecall.rank('咖啡', <MemoryEntry>[a, b], nowMs: now);
      expect(ranked.map((h) => h.entry.id).toList(), <String>['a_first', 'b_second']);
    });

    test('recencyMultiplier 在半衰期处恰好是 0.5，永久层恒为 1', () {
      final at = now - 30 * day;
      expect(
        MemoryRecall.recencyMultiplier(at, now, MemoryTier.crossSession),
        closeTo(0.5, 0.0001),
      );
      expect(
        MemoryRecall.recencyMultiplier(at, now, MemoryTier.permanent),
        1.0,
      );
      // 短期层半衰期 1 天：一天后就只剩一半
      expect(
        MemoryRecall.recencyMultiplier(now - day, now, MemoryTier.shortTerm),
        closeTo(0.5, 0.0001),
      );
      // 未来的时间戳不产生负衰减
      expect(
        MemoryRecall.recencyMultiplier(now + day, now, MemoryTier.crossSession),
        1.0,
      );
    });
  });

  group('类型过滤', () {
    final entries = <MemoryEntry>[
      mem(id: 'user_1', name: '咖啡', body: '用户喜欢喝咖啡。', type: MemoryType.user),
      mem(id: 'project_1', name: '咖啡', body: '项目里要做咖啡订购模块。', type: MemoryType.project),
    ];

    test('限定类型只召回那一类', () {
      final ranked = MemoryRecall.rank('咖啡', entries,
          types: <MemoryType>{MemoryType.user}, nowMs: now);
      expect(ranked.length, 1);
      expect(ranked.single.entry.id, 'user_1');
    });

    test('不传类型时两类都参与', () {
      final ranked = MemoryRecall.rank('咖啡', entries, nowMs: now);
      expect(ranked.length, 2);
    });
  });

  group('框式渲染', () {
    final entry = mem(
      id: 'user_vscode_ab12cd34',
      name: '常用编辑器',
      description: '主力编辑器是 VS Code',
      body: '装在 D 盘，插件约三十个， nightly 通道。',
      type: MemoryType.user,
    );

    test('框含「我记得你之前提到过」开头', () {
      final section = MemoryRecall.buildSection('编辑器', <MemoryEntry>[entry], nowMs: now)!;
      expect(section.text, startsWith('我记得你之前提到过'));
    });

    test('框内含来源、层级与种类徽标', () {
      final section = MemoryRecall.buildSection('编辑器', <MemoryEntry>[entry], nowMs: now)!;
      expect(section.text, contains('来源：本地记忆 user_vscode_ab12cd34'));
      expect(section.text, contains('(用户画像·永久)'));
      expect(section.text, contains('常用编辑器'));
      // 有 description 时用它做摘要，不截正文
      expect(section.text, contains('主力编辑器是 VS Code'));
      expect(section.text, isNot(contains('插件约三十个')));
    });

    test('没有 description 时回落到正文，超长截断', () {
      final long = mem(
        id: 'p_long',
        name: '长记忆',
        body: '咖啡' * 200,
      );
      final section = MemoryRecall.buildSection('咖啡', <MemoryEntry>[long], nowMs: now)!;
      expect(section.text, contains('…'));
      expect(section.text.length, lessThan(400));
    });

    test('hits 与正文一一对应，供调用方记召回数', () {
      final section = MemoryRecall.buildSection('编辑器', <MemoryEntry>[entry], nowMs: now)!;
      expect(section.hits.length, 1);
      expect(section.ids, <String>['user_vscode_ab12cd34']);
    });

    test('maxChars 一条都放不下时返回 null', () {
      expect(
        MemoryRecall.buildSection('编辑器', <MemoryEntry>[entry], maxChars: 20, nowMs: now),
        isNull,
      );
    });

    test('maxChars 截断后只保留放得下的条目', () {
      final entries = <MemoryEntry>[
        mem(id: 'a1', name: '咖啡机', body: '办公室的咖啡机。', ageDays: 0),
        mem(id: 'a2', name: '咖啡豆', body: '中深烘咖啡豆。', ageDays: 1),
        mem(id: 'a3', name: '咖啡馆', body: '楼下新开的咖啡馆。', ageDays: 2),
      ];
      final full = MemoryRecall.buildSection('咖啡', entries, maxChars: 900, nowMs: now)!;
      expect(full.hits.length, 3);

      final tight = MemoryRecall.buildSection('咖啡', entries, maxChars: 120, nowMs: now)!;
      expect(tight.hits.length, lessThan(3));
      expect(tight.hits.length, greaterThanOrEqualTo(1));
      // 放不下的不出现在正文里
      for (final hit in tight.hits) {
        expect(tight.text, contains(hit.entry.id));
      }
      expect(tight.text.split('\n').length, tight.hits.length + 1);
    });

    test('limit 截断命中数', () {
      final entries = <MemoryEntry>[
        mem(id: 'a1', name: '咖啡机', body: '咖啡。', ageDays: 0),
        mem(id: 'a2', name: '咖啡豆', body: '咖啡。', ageDays: 1),
        mem(id: 'a3', name: '咖啡馆', body: '咖啡。', ageDays: 2),
      ];
      final ranked = MemoryRecall.rank('咖啡', entries, limit: 2, nowMs: now);
      expect(ranked.length, 2);
    });
  });
}
