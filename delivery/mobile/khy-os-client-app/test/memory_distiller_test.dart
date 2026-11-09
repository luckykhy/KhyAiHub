import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/memory/memory_distiller.dart';
import 'package:khy_os_client/core/memory/memory_store.dart';

/// 蒸馏的 analyze / 归档 / 恢复测试。
///
/// 端口对象：`domain/memory/memoryEngine/distiller.js`。
void main() {
  final now = DateTime.utc(2026, 11, 4, 12).millisecondsSinceEpoch;
  final day = 86400000;

  setUp(() {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
  });

  MemoryEntry mem({
    required String id,
    required String name,
    required String body,
    MemoryType type = MemoryType.project,
    MemoryTier? tier,
    int ageDays = 0,
  }) {
    return MemoryEntry(
      id: id,
      name: name,
      description: '',
      type: type,
      tier: tier,
      body: body,
      updated: DateTime.fromMillisecondsSinceEpoch(now - ageDays * day, isUtc: true),
    );
  }

  group('analyze 是纯的', () {
    test('同样的输入得到同样的计划，且不碰存储', () async {
      final store = MemoryStore.instance;
      final e = await store.remember(
        type: MemoryType.project,
        name: '短正文',
        body: '太短',
        updated: DateTime.utc(2026, 11, 4),
      );
      final entries = await store.listAll();

      final a = MemoryDistiller.analyze(entries, nowMs: now);
      final b = MemoryDistiller.analyze(entries, nowMs: now);

      expect(a.stats.total, b.stats.total);
      expect(a.stats.forget, b.stats.forget);
      expect(a.forget.single.entry.id, b.forget.single.entry.id);

      // dry-run 一个字节都没落盘
      expect((await store.listAll()).length, 1);
      expect((await store.listAll()).single.id, e.id);
      expect(await store.listArchived(), isEmpty);
    });

    test('没有可整理内容时计划为空', () {
      final entries = <MemoryEntry>[
        mem(id: 'p1', name: '咖啡机', body: '办公室的咖啡机是意式半自动，每天早上都要用。'),
      ];
      final plan = MemoryDistiller.analyze(entries, nowMs: now);
      expect(plan.isEmpty, isTrue);
      expect(plan.keep.length, 1);
      expect(plan.stats.forget, 0);
    });
  });

  group('该忘记什么', () {
    test('正文过短进 forget，理由为空记忆', () {
      final entries = <MemoryEntry>[
        mem(id: 'p_short', name: '短', body: '嗯'),
        mem(id: 'p_long', name: '长', body: '这是一条足够长的记忆正文，用来对照。'),
      ];
      final plan = MemoryDistiller.analyze(entries, nowMs: now);
      expect(plan.forget.length, 1);
      expect(plan.forget.single.entry.id, 'p_short');
      expect(plan.forget.single.reason, DistillReason.empty);
      expect(plan.forget.single.detail, contains('1 字符'));
      expect(plan.keep.map((k) => k.entry.id), <String>['p_long']);
    });

    test('permanent 记忆正文再短也不被忘记', () {
      // 硬不变量：派生（type=user）与显式两条路都免疫。
      final entries = <MemoryEntry>[
        mem(id: 'user_1', name: '身份', body: '短', type: MemoryType.user),
        mem(id: 'p_perm', name: '显式永久', body: '短',
            tier: MemoryTier.permanent),
      ];
      final plan = MemoryDistiller.analyze(entries, nowMs: now);
      expect(plan.forget, isEmpty);
      expect(plan.keep.length, 2);
    });

    test('近重复保留价值高的一条，另一条进 forget 并记入合并组', () {
      final entries = <MemoryEntry>[
        mem(id: 'p_old', name: '咖啡机', body: '办公室的咖啡机是意式半自动。', ageDays: 90),
        mem(id: 'p_new', name: '咖啡机', body: '办公室的咖啡机是意式半自动。', ageDays: 1),
      ];
      final plan = MemoryDistiller.analyze(entries, nowMs: now);
      expect(plan.forget.length, 1);
      expect(plan.forget.single.entry.id, 'p_old');
      expect(plan.forget.single.reason, DistillReason.duplicate);
      expect(plan.forget.single.detail, contains('咖啡机'));

      expect(plan.merge.length, 1);
      expect(plan.merge.single.survivorId, 'p_new');
      expect(plan.merge.single.absorbedIds, <String>['p_old']);
      expect(plan.keep.map((k) => k.entry.id), <String>['p_new']);
    });

    test('permanent 的近重复也保留，两条都在', () {
      final entries = <MemoryEntry>[
        mem(id: 'p_new', name: '咖啡机', body: '办公室的咖啡机是意式半自动。', ageDays: 1),
        mem(id: 'p_old_perm', name: '咖啡机', body: '办公室的咖啡机是意式半自动。',
            tier: MemoryTier.permanent, ageDays: 90),
      ];
      final plan = MemoryDistiller.analyze(entries, nowMs: now);
      expect(plan.forget, isEmpty);
      expect(plan.keep.length, 2);
    });

    test('超过类型保鲜期进 forget，user 类型不会', () {
      final entries = <MemoryEntry>[
        mem(id: 'p_stale', name: '旧项目', body: '这个项目已经收尾两个月了，不再需要。', ageDays: 200),
        mem(id: 'user_old', name: '老偏好', body: '用户很多年前说过喜欢深色主题，一直没变。',
            type: MemoryType.user, ageDays: 200),
      ];
      final plan = MemoryDistiller.analyze(entries, nowMs: now);
      expect(plan.forget.length, 1);
      expect(plan.forget.single.entry.id, 'p_stale');
      expect(plan.forget.single.reason, DistillReason.stale);
      expect(plan.forget.single.detail, contains('保鲜期'));
      expect(plan.keep.map((k) => k.entry.id), <String>['user_old']);
    });

    test('阈值可注入，一条规则也能被单独触发', () {
      final entries = <MemoryEntry>[
        mem(id: 'p_recent', name: '刚写的项目', body: '昨天才写的项目背景，还在用。', ageDays: 3),
      ];
      // 默认 180 天保鲜期下它很新鲜
      expect(MemoryDistiller.analyze(entries, nowMs: now).forget, isEmpty);
      // 把保鲜期压到 1 天，同一条立刻变陈旧
      final tight = MemoryDistiller.analyze(
        entries,
        nowMs: now,
        thresholds: const DistillThresholds(staleDaysProject: 1),
      );
      expect(tight.forget.single.reason, DistillReason.stale);
    });

    test('优先级：先空正文，再重复，再陈旧', () {
      final entries = <MemoryEntry>[
        mem(id: 'a_empty', name: '空', body: '短'),
        mem(id: 'b_dup_old', name: '咖啡机', body: '办公室的咖啡机是意式半自动。', ageDays: 90),
        mem(id: 'c_dup_new', name: '咖啡机', body: '办公室的咖啡机是意式半自动。', ageDays: 1),
        mem(id: 'd_stale', name: '陈旧', body: '早就收尾的项目背景，不再需要上下文。', ageDays: 400),
      ];
      final plan = MemoryDistiller.analyze(entries, nowMs: now);
      expect(plan.stats.total, 4);
      expect(plan.stats.forget, 3);
      expect(plan.stats.mergeGroups, 1);
      expect(plan.stats.byReason[DistillReason.empty], 1);
      expect(plan.stats.byReason[DistillReason.duplicate], 1);
      expect(plan.stats.byReason[DistillReason.stale], 1);
      // 同一个条目不会被两条规则同时记一次
      final ids = plan.forget.map((f) => f.entry.id).toList();
      expect(ids.toSet().length, ids.length);
    });
  });

  group('归档与恢复', () {
    test('dry-run 之后由调用方归档，可逐条恢复', () async {
      final store = MemoryStore.instance;
      final short = await store.remember(
        type: MemoryType.project,
        name: '短',
        body: '嗯',
        updated: DateTime.fromMillisecondsSinceEpoch(now, isUtc: true),
      );
      final stale = await store.remember(
        type: MemoryType.project,
        name: '旧项目',
        body: '早就收尾的项目背景，不再需要上下文。',
        updated: DateTime.fromMillisecondsSinceEpoch(now - 400 * day, isUtc: true),
      );
      final live = await store.remember(
        type: MemoryType.project,
        name: '还在用的项目',
        body: '这个项目这周还在改，不能归档。',
        updated: DateTime.fromMillisecondsSinceEpoch(now - day, isUtc: true),
      );

      final plan = MemoryDistiller.analyze(<MemoryEntry>[short, stale, live], nowMs: now);
      expect(plan.forget.length, 2);

      // dry-run 阶段：库里一条没少，归档是空的
      expect((await store.listAll()).length, 3);
      expect(await store.listArchived(), isEmpty);

      for (final f in plan.forget) {
        final record = await store.forget(f.entry.id, reason: f.reason.wire, detail: f.detail);
        expect(record, isNotNull, reason: '${f.entry.id} 应可归档');
      }

      expect((await store.listAll()).length, 1);
      final archived = await store.listArchived();
      expect(archived.length, 2);
      expect(archived.map((r) => r.reason).toSet(), <String>{'empty', 'stale'});

      for (final f in plan.forget) {
        final back = await store.restore(f.entry.id);
        expect(back, isNotNull, reason: '${f.entry.id} 应可恢复');
      }
      expect((await store.listAll()).length, 3);
      expect(await store.listArchived(), isEmpty);
    });

    test('permanent 条目连手动归档也过不了存储这道闸', () async {
      final store = MemoryStore.instance;
      final e = await store.remember(
        type: MemoryType.user,
        name: '用户身份',
        body: '永久层记忆，任何归档都不得碰它。',
      );
      expect(await store.forget(e.id, reason: 'manual', detail: '试一下'), isNull);
      expect(await store.find(e.id), isNotNull);
      expect(await store.listArchived(), isEmpty);
    });
  });

  group('报告与周期', () {
    test('报告列出每条决定与理由', () {
      final entries = <MemoryEntry>[
        mem(id: 'a_empty', name: '空记忆', body: '短'),
        mem(id: 'b_stale', name: '陈旧项目', body: '早就收尾的项目背景，不再需要上下文。', ageDays: 400),
        mem(id: 'c_live', name: '活跃项目', body: '这周还在改的项目背景。'),
      ];
      final report = MemoryDistiller.formatReport(
          MemoryDistiller.analyze(entries, nowMs: now));
      expect(report, contains('共 3 条记忆'));
      expect(report, contains('建议忘记 2'));
      expect(report, contains('[空记忆] 空记忆'));
      expect(report, contains('[陈旧] 陈旧项目'));
      expect(report, contains('归档，可恢复'));
      expect(report, contains('活跃项目'));
    });

    test('周期跑默认 report-only', () {
      const policy = DistillPolicy();
      expect(policy.mode, DistillAutoMode.report);
      final run = policy.decide(now, lastRunMs: now - 30 * day);
      expect(run.run, isTrue);
      expect(run.apply, isFalse);
      expect(run.note, contains('不动任何记忆'));
    });

    test('未满周期不跑，并说明差多少', () {
      const policy = DistillPolicy();
      final run = policy.decide(now, lastRunMs: now - 2 * day);
      expect(run.run, isFalse);
      expect(run.apply, isFalse);
      expect(run.note, contains('2 天'));
      expect(run.note, contains('7 天周期'));
    });

    test('archive 模式才允许真的归档', () {
      const policy = DistillPolicy(mode: DistillAutoMode.archive);
      final run = policy.decide(now, lastRunMs: now - 30 * day);
      expect(run.run, isTrue);
      expect(run.apply, isTrue);
    });

    test('off 模式直接不跑', () {
      const policy = DistillPolicy(mode: DistillAutoMode.off);
      final run = policy.decide(now, force: true);
      expect(run.run, isFalse);
      expect(run.note, contains('已关闭'));
    });

    test('force 跳过周期判断', () {
      const policy = DistillPolicy();
      expect(policy.decide(now, lastRunMs: now, force: true).run, isTrue);
    });

    test('模式串解析不了时回落到 report', () {
      expect(DistillAutoMode.parse('archive'), DistillAutoMode.archive);
      expect(DistillAutoMode.parse('off'), DistillAutoMode.off);
      expect(DistillAutoMode.parse('随便'), DistillAutoMode.report);
      expect(DistillAutoMode.parse(null), DistillAutoMode.report);
    });
  });
}
