import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/memory/memory_dreaming.dart';
import 'package:khy_os_client/core/memory/memory_store.dart';

/// 做梦三相位测试：Light 本机去重、Deep/REM 的委托与诚实跳过。
///
/// 端口对象：`services/memoryDreaming.js`。
void main() {
  final now = DateTime.utc(2026, 11, 4, 12).millisecondsSinceEpoch;
  final hour = 3600000;

  MemoryEntry mem({
    required String id,
    required String name,
    required String body,
    int ageHours = 0,
    int recallCount = 0,
  }) {
    return MemoryEntry(
      id: id,
      name: name,
      description: '',
      type: MemoryType.project,
      body: body,
      updated: DateTime.fromMillisecondsSinceEpoch(now - ageHours * hour, isUtc: true),
      recallCount: recallCount,
    );
  }

  /// 两条近乎逐字相同的记忆（trigram Jaccard = 1）。
  List<MemoryEntry> duplicatePair() => <MemoryEntry>[
        mem(
          id: 'p_dup_low',
          name: '咖啡机',
          body: '办公室的咖啡机是意式半自动，每天早上都要用。',
          ageHours: 5,
          recallCount: 1,
        ),
        mem(
          id: 'p_dup_high',
          name: '咖啡机',
          body: '办公室的咖啡机是意式半自动，每天早上都要用。',
          ageHours: 1,
          recallCount: 4,
        ),
      ];

  group('Light 本机去重', () {
    test('命中：高度重复的两条并成一组，召回数高的留下', () {
      final plan = MemoryDreaming.planLightDedup(duplicatePair(), nowMs: now);
      expect(plan.isEmpty, isFalse);
      expect(plan.merged, 1);
      expect(plan.dropped, 1);
      expect(plan.kept, 1);
      expect(plan.considered, 2);

      final merge = plan.merges.single;
      expect(merge.keeper.id, 'p_dup_high');
      expect(merge.absorbed.single.id, 'p_dup_low');
      // 被合并进来的召回数并到保留者身上，不凭空清零
      expect(merge.mergedRecallCount, 5);
      expect(plan.absorbedIds, <String>['p_dup_low']);
    });

    test('不命中：内容不同的记忆各留一条', () {
      final entries = <MemoryEntry>[
        mem(id: 'a', name: '咖啡机', body: '办公室的咖啡机是意式半自动。', ageHours: 1),
        mem(id: 'b', name: 'git 回退', body: '提交历史可以通过 revert 命令回退。', ageHours: 2),
      ];
      final plan = MemoryDreaming.planLightDedup(entries, nowMs: now);
      expect(plan.isEmpty, isTrue);
      expect(plan.merged, 0);
      expect(plan.dropped, 0);
      expect(plan.kept, 2);
    });

    test('超过回看窗口的记忆不参与', () {
      // 窗口是 2 天；把两条重复记忆都推到 3 天前，就该一条都不动
      final entries = <MemoryEntry>[
        mem(id: 'old1', name: '咖啡机', body: '办公室的咖啡机是意式半自动。', ageHours: 72),
        mem(id: 'old2', name: '咖啡机', body: '办公室的咖啡机是意式半自动。', ageHours: 80),
      ];
      final plan = MemoryDreaming.planLightDedup(entries, nowMs: now);
      expect(plan.considered, 0);
      expect(plan.isEmpty, isTrue);
    });

    test('少于两条无事可做', () {
      final entries = <MemoryEntry>[
        mem(id: 'only', name: '咖啡机', body: '办公室的咖啡机是意式半自动。'),
      ];
      final plan = MemoryDreaming.planLightDedup(entries, nowMs: now);
      expect(plan.considered, 1);
      expect(plan.isEmpty, isTrue);
    });

    test('阈值可注入：把相似度抬到 1.01 就没有任何合并', () {
      final plan = MemoryDreaming.planLightDedup(
        duplicatePair(),
        nowMs: now,
        similarity: 1.01,
      );
      expect(plan.isEmpty, isTrue);
      expect(plan.kept, 2);
    });
  });

  group('相位到期判断', () {
    test('从没跑过的相位立即到期', () {
      for (final phase in DreamPhase.values) {
        expect(MemoryDreaming.isDue(phase, 0, now), isTrue);
      }
    });

    test('Light 6 小时边界', () {
      expect(MemoryDreaming.isDue(DreamPhase.light, now - 5 * hour, now), isFalse);
      expect(MemoryDreaming.isDue(DreamPhase.light, now - 6 * hour, now), isTrue);
      expect(MemoryDreaming.isDue(DreamPhase.deep, now - 6 * hour, now), isFalse);
      expect(MemoryDreaming.isDue(DreamPhase.deep, now - 24 * hour, now), isTrue);
      expect(MemoryDreaming.isDue(DreamPhase.rem, now - 24 * hour, now), isFalse);
      expect(MemoryDreaming.isDue(DreamPhase.rem, now - 7 * 24 * hour, now), isTrue);
    });

    test('相位中文标签与线串可往返', () {
      expect(DreamPhase.parse('light'), DreamPhase.light);
      expect(DreamPhase.parse('rem'), DreamPhase.rem);
      expect(DreamPhase.parse('别的'), DreamPhase.light);
      expect(DreamPhase.deep.label, '深度固化');
    });
  });

  group('Deep：委托或明确不做', () {
    List<MemoryEntry> candidates() => <MemoryEntry>[
          mem(id: 'c1', name: '编辑器', body: '用户主力编辑器是 VS Code。', recallCount: 3),
          mem(id: 'c2', name: '主题', body: '用户喜欢深色主题。', recallCount: 5),
          mem(id: 'c3', name: '冷淡', body: '这条只被召回过一次。', recallCount: 1),
        ];

    test('未连接 AI 网关时不跑，并说明候选原样保留', () async {
      final report = await MemoryDreaming.runDeep(candidates(), nowMs: now);
      expect(report.ran, isFalse);
      expect(report.synthesis, isNull);
      // 达到召回门槛的两条仍是候选
      expect(report.candidates.length, 2);
      expect(report.note, contains('未连接 AI 网关或后端'));
      expect(report.note, contains('不执行深度固化'));
      expect(report.note, contains('2 条候选'));
    });

    test('连上时执行，产出交给调用方决定是否入库', () async {
      final seen = <String>[];
      final report = await MemoryDreaming.runDeep(
        candidates(),
        nowMs: now,
        synthesizer: (prompt) async {
          seen.add(prompt);
          return '  用户偏好 VS Code 与深色主题。  ';
        },
      );
      expect(report.ran, isTrue);
      expect(report.synthesis, '用户偏好 VS Code 与深色主题。');
      expect(report.note, contains('2 条候选'));
      // 提示词里带着候选记忆本身，模型才有的可综合
      expect(seen.single, contains('用户主力编辑器是 VS Code'));
      expect(seen.single, contains('Recalls:5'));
    });

    test('没有候选时不调用模型', () async {
      var called = false;
      final report = await MemoryDreaming.runDeep(
        candidates(),
        nowMs: now,
        synthesizer: (prompt) async {
          called = true;
          return 'x';
        },
        minRecallCount: 99,
      );
      expect(called, isFalse);
      expect(report.ran, isFalse);
      expect(report.note, contains('无事可做'));
    });

    test('模型抛异常时不假装成功', () async {
      final report = await MemoryDreaming.runDeep(
        candidates(),
        nowMs: now,
        synthesizer: (prompt) async => throw Exception('网关 502'),
      );
      expect(report.ran, isFalse);
      expect(report.synthesis, isNull);
      expect(report.note, contains('失败'));
      expect(report.note, contains('未改动'));
    });

    test('模型返回空内容时不写入', () async {
      final report = await MemoryDreaming.runDeep(
        candidates(),
        nowMs: now,
        synthesizer: (prompt) async => '   ',
      );
      expect(report.ran, isFalse);
      expect(report.note, contains('未写入任何记忆'));
    });
  });

  group('REM：模式提取', () {
    List<MemoryEntry> sources() => <MemoryEntry>[
          mem(id: 's1', name: '编辑器', body: '用户主力编辑器是 VS Code。'),
          mem(id: 's2', name: '主题', body: '用户喜欢深色主题。'),
          mem(id: 's3', name: '快捷键', body: '用户习惯用快捷键而不是菜单。'),
        ];

    test('未连接时不跑，来源原样保留', () async {
      final report = await MemoryDreaming.runRem(sources(), nowMs: now);
      expect(report.ran, isFalse);
      expect(report.patterns, isEmpty);
      expect(report.sources.length, 3);
      expect(report.note, contains('未连接 AI 网关或后端'));
      expect(report.note, contains('不执行模式提取'));
    });

    test('来源不足三条时不跑', () async {
      final report = await MemoryDreaming.runRem(
        sources().take(2).toList(),
        nowMs: now,
      );
      expect(report.ran, isFalse);
      expect(report.note, contains('不足 3 条'));
    });

    test('连上时提取，并按强度阈值过滤', () async {
      final report = await MemoryDreaming.runRem(
        sources(),
        nowMs: now,
        synthesizer: (prompt) async => '''
```json
[
  {"description": "偏好效率工具", "strength": 0.9},
  {"description": "噪声模式", "strength": 0.2}
]
```
''',
      );
      expect(report.ran, isTrue);
      expect(report.patterns.length, 1);
      expect(report.patterns.single.description, '偏好效率工具');
      expect(report.note, contains('1 条模式'));
    });

    test('模型没给出达标模式时不写入', () async {
      final report = await MemoryDreaming.runRem(
        sources(),
        nowMs: now,
        synthesizer: (prompt) async => '[{"description": "弱信号", "strength": 0.1}]',
      );
      expect(report.ran, isTrue);
      expect(report.patterns, isEmpty);
      expect(report.note, contains('未写入任何记忆'));
    });
  });

  group('模式解析', () {
    test('裸 JSON 数组', () {
      final patterns = MemoryDreaming.parsePatterns(
          '[{"description":"a","strength":0.8},{"description":"b","strength":1.4}]');
      expect(patterns.length, 2);
      expect(patterns[1].strength, 1.0);
    });

    test('围栏与夹在散文里的 JSON 都能解', () {
      final fenced = MemoryDreaming.parsePatterns('''```
[{"description":"a","strength":0.9}]
```''');
      expect(fenced.single.description, 'a');

      final prose = MemoryDreaming.parsePatterns('好的，结果如下：[{"description":"b","strength":0.75}] 完毕');
      expect(prose.single.description, 'b');
    });

    test('包在 patterns 键里的对象也认', () {
      final patterns = MemoryDreaming.parsePatterns(
          '{"patterns":[{"description":"c","strength":0.5}]}');
      expect(patterns.single.description, 'c');
    });

    test('解不出来时一条都不给，不猜', () {
      expect(MemoryDreaming.parsePatterns('完全不是 JSON'), isEmpty);
      expect(MemoryDreaming.parsePatterns(''), isEmpty);
      expect(MemoryDreaming.parsePatterns('[{"strength":0.9}]'), isEmpty);
      expect(MemoryDreaming.parsePatterns('["不是对象"]'), isEmpty);
    });

    test('提示词带着记忆内容', () {
      final sources = <MemoryEntry>[
        mem(id: 's1', name: '编辑器', body: '用户主力编辑器是 VS Code。'),
      ];
      expect(MemoryDreaming.buildPatternPrompt(sources), contains('VS Code'));
      expect(MemoryDreaming.buildDeepSynthesisPrompt(sources), contains('VS Code'));
    });
  });
}
