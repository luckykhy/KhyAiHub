import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/usage_ledger.dart';
import 'package:khy_os_client/ui/screens/usage_screen.dart';

/// 用量页的测试。
///
/// 分两半，与 amoo_turn_test 同一纪律：
///   - 纯函数（视图模型、图表几何、紧凑计数）在主机上直接跑；
///   - 界面渲染走注入的 [UsageSnapshot]，绕开 sqflite——主机没有 sqlite3.dll。
///
/// 界面渲染重点钉三件事：空账时说人话不白屏（规则 2）、账本打不开时不说
/// 「还没有记录」、CSV 导出失败时给「问题 + 修复」而不是一个哑掉的按钮。
void main() {
  // 2026-11-04 是周三；本周一 = 2026-11-02，上周日 = 2026-11-01。
  final now = DateTime(2026, 11, 4, 15, 30);

  UsageEntry entry({
    required int month,
    required int day,
    int hour = 9,
    String model = 'claude-sonnet-5',
    String conversation = 'c1',
    int input = 1000,
    int output = 500,
  }) =>
      UsageEntry(
        ts: DateTime(2026, month, day, hour).millisecondsSinceEpoch,
        conversationId: conversation,
        model: model,
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
      );

  final entries = <UsageEntry>[
    entry(month: 11, day: 4, hour: 9, model: 'claude-sonnet-5',
        conversation: 'c1', input: 1000, output: 500),
    entry(month: 11, day: 4, hour: 10, model: 'glm-5.3',
        conversation: 'c1', input: 2000, output: 1000),
    entry(month: 11, day: 2, hour: 8, model: 'claude-sonnet-5',
        conversation: 'c2', input: 300, output: 150),
    entry(month: 11, day: 1, hour: 23, model: 'glm-5.3',
        conversation: 'c2', input: 100, output: 50),
    entry(month: 10, day: 20, hour: 12, model: 'glm-5.3',
        conversation: 'c1', input: 500, output: 250),
  ];

  group('buildUsageViewData', () {
    test('空账： isEmpty 且成本是 null 而不是 0', () {
      final view = buildUsageViewData(
        entries: const <UsageEntry>[],
        budget: 0,
        prices: const <String, ModelPrice>{},
        rangeDays: 30,
        now: now,
      );
      expect(view.isEmpty, true);
      expect(view.entryCount, 0);
      expect(view.month.isEmpty, true);
      expect(view.week.isEmpty, true);
      expect(view.costCny, isNull,
          reason: '0 会被读成「免费」；一个模型都没计价时必须给 null');
      expect(view.unpricedModels, isEmpty);
      expect(view.recordedDays, 0);
      expect(view.chartDays.every((b) => !b.hasRecords), true);
      expect(view.chartDays.length, 30);
    });

    test('本月/本周分开算，周日那笔只进本月不进本周', () {
      final view = buildUsageViewData(
        entries: entries,
        budget: 0,
        prices: const <String, ModelPrice>{},
        rangeDays: 30,
        now: now,
      );
      expect(view.month.totalTokens, 5100);
      expect(view.month.turns, 4);
      expect(view.week.totalTokens, 4950);
      expect(view.week.turns, 3);
      expect(view.entryCount, 5);
      // 90 天窗口内有记录的日子：11-04 / 11-02 / 11-01 / 10-20。
      expect(view.recordedDays, 4);
      expect(view.chartDays.last.key, '2026-11-04');
      expect(view.chartDays.last.totalTokens, 4500);
    });

    test('按模型降序，未计价模型逐个列出', () {
      final view = buildUsageViewData(
        entries: entries,
        budget: 0,
        prices: const <String, ModelPrice>{},
        rangeDays: 30,
        now: now,
      );
      expect(view.models.map((m) => m.model),
          <String>['glm-5.3', 'claude-sonnet-5']);
      expect(view.models.first.totals.totalTokens, 3900);
      expect(view.costCny, isNull);
      expect(view.unpricedModels.length, 2);
      expect(view.unpricedModels, contains('glm-5.3'));
      expect(view.unpricedModels, contains('claude-sonnet-5'));
    });

    test('空模型名在未计价列表里显示成「未知模型」', () {
      final view = buildUsageViewData(
        entries: <UsageEntry>[entry(month: 11, day: 4, model: '')],
        budget: 0,
        prices: const <String, ModelPrice>{},
        rangeDays: 7,
        now: now,
      );
      expect(view.unpricedModels, <String>['未知模型']);
    });

    test('有价目时按元 / 1M tokens 折算，全部计价则未计价列表为空', () {
      final view = buildUsageViewData(
        entries: entries,
        budget: 6000,
        prices: const <String, ModelPrice>{
          'claude-sonnet-5': ModelPrice(inputPer1M: 3, outputPer1M: 15),
          'glm-5.3': ModelPrice(inputPer1M: 2, outputPer1M: 8),
        },
        rangeDays: 7,
        now: now,
      );
      expect(view.costCny, closeTo(0.02925, 1e-9));
      expect(view.unpricedModels, isEmpty);
      expect(view.budget, 6000);
      expect(view.budgetUsedRatio, 85);
      expect(view.overBudget, false);
      expect(view.chartDays.length, 7);
      // 7 日窗口里有记录的是 11-04 / 11-02 / 11-01；10-20 那笔在窗口外。
      expect(view.chartDays.where((b) => b.hasRecords).length, 3);
    });

    test('超预算时比例进位、overBudget 为真', () {
      final view = buildUsageViewData(
        entries: entries,
        budget: 4000,
        prices: const <String, ModelPrice>{},
        rangeDays: 30,
        now: now,
      );
      expect(view.overBudget, true);
      expect(view.budgetUsedRatio, 128);
    });

    test('没设预算时 hasBudget 为假、比例 0', () {
      final view = buildUsageViewData(
        entries: entries,
        budget: 0,
        prices: const <String, ModelPrice>{},
        rangeDays: 30,
        now: now,
      );
      expect(view.hasBudget, false);
      expect(view.budgetUsedRatio, 0);
      expect(view.overBudget, false);
    });

    test('stamp 带可读时间戳', () {
      final view = buildUsageViewData(
        entries: entries,
        budget: 0,
        prices: const <String, ModelPrice>{},
        rangeDays: 30,
        now: now,
      );
      // formatLogTime 是全仓共用的日志时间格式，恒带毫秒；不为本页写第二种格式。
      expect(view.stamp, '2026-11-04 15:30:00.000');
    });
  });

  group('图表几何', () {
    test('niceCeilAxis 给不小于 max 的最小 nice 值', () {
      expect(niceCeilAxis(0), 1, reason: '非正输入不能炸也不能画假轴');
      expect(niceCeilAxis(-7), 1);
      expect(niceCeilAxis(87), 100);
      expect(niceCeilAxis(100), 100);
      expect(niceCeilAxis(101), 150);
      expect(niceCeilAxis(1200), 1500);
      expect(niceCeilAxis(3000), 3000);
      expect(niceCeilAxis(4096), 5000);
    });

    test('usageBarSegments 两段高之和等于当日总量的轴上高度', () {
      final day = UsageDayBucket(
        day: DateTime(2026, 11, 4),
        inputTokens: 300,
        outputTokens: 100,
        totalTokens: 400,
        turns: 1,
      );
      final segments = usageBarSegments(day, 1000, 100);
      expect(segments.length, 2);
      // 输入在上、输出在下（与桌面 usageCharts.tsx 同一摆法）。
      expect(segments[0].isInput, true);
      expect(segments[0].height, closeTo(30, 1e-9));
      expect(segments[0].y, closeTo(60, 1e-9));
      expect(segments[1].isInput, false);
      expect(segments[1].y, closeTo(90, 1e-9));
      expect(segments[1].height, closeTo(10, 1e-9));
      expect(segments[0].height + segments[1].height,
          closeTo(400 / 1000 * 100, 1e-9));
    });

    test('空桶不给段——Missing 态由调用方画 1px 基线', () {
      final day = UsageDayBucket(day: DateTime(2026, 11, 4));
      expect(usageBarSegments(day, 1000, 100), isEmpty);
      expect(
        usageBarSegments(
          UsageDayBucket(
            day: DateTime(2026, 11, 4),
            inputTokens: 10,
            totalTokens: 10,
            turns: 1,
          ),
          0,
          100,
        ),
        isEmpty,
        reason: '轴为 0 时不该除零炸出去',
      );
    });

    test('formatCompactNumber 与桌面 compactNumber.ts 同标度', () {
      expect(formatCompactNumber(0), '0');
      expect(formatCompactNumber(999), '999');
      expect(formatCompactNumber(1000), '1K');
      expect(formatCompactNumber(1500), '1.5K');
      expect(formatCompactNumber(999999), '1M',
          reason: '999.95K 要进位成 1M，不显示 1000K');
      expect(formatCompactNumber(1234567), '1.2M');
      expect(formatCompactNumber(1000000000), '1B');
      expect(formatCompactNumber(-1500), '-1.5K');
    });

    test('usageDayLabel / usageModelLabel', () {
      expect(usageDayLabel(DateTime(2026, 11, 4)), '11/4');
      expect(usageModelLabel('glm-5.3'), 'glm-5.3');
      expect(usageModelLabel(''), '未知模型',
          reason: '上游没给模型名时不能说成一片空白');
    });
  });

  group('界面渲染', () {
    Future<void> pumpUsage(
      WidgetTester tester, {
      Future<UsageSnapshot> Function()? loadUsage,
    }) async {
      await tester.pumpWidget(MaterialApp(
        home: UsageScreen(loadUsage: loadUsage),
      ));
      await tester.pumpAndSettle();
    }

    /// 规则 2：四态里任何一态都不许出现含糊措辞。
    void expectNoVagueTokens(WidgetTester tester) {
      final texts = find
          .byType(Text)
          .evaluate()
          .map((e) => (e.widget as Text).data ?? '')
          .where((s) => s.isNotEmpty);
      for (final token in const <String>[
        '处理中',
        '正在工作',
        '尝试连接',
        '请稍候',
        'Loading',
        'loading',
        'Connecting',
        'connecting',
        'Processing',
        'processing',
      ]) {
        expect(texts.any((t) => t.contains(token)), isFalse,
            reason: '状态文本命中含糊措辞「$token」');
      }
    }

    testWidgets('空账：给「还没有用量记录」人话，不白屏', (tester) async {
      await pumpUsage(tester, loadUsage: () async => const UsageSnapshot());
      expect(find.text('还没有用量记录'), findsOneWidget);
      expect(find.textContaining('账本只存本机'), findsOneWidget);
      expect(find.textContaining('不显示服务端配额'), findsOneWidget);
      expectNoVagueTokens(tester);
      // 没有可导出的东西时导出键必须是禁用的，而不是点了没反应。
      final exportButton = tester.widget<IconButton>(find.byTooltip('导出 CSV'));
      expect(exportButton.onPressed, isNull);
      expect(tester.takeException(), isNull);
    });

    testWidgets('账本打不开：说「读不到」，不说「没有记录」', (tester) async {
      await pumpUsage(
        tester,
        loadUsage: () async => const UsageSnapshot(available: false),
      );
      expect(find.text('用量账本不可用'), findsOneWidget);
      expect(find.textContaining('修复：'), findsOneWidget);
      expect(find.text('还没有用量记录'), findsNothing,
          reason: '把读不到显示成从没用过，是在骗用户');
      expectNoVagueTokens(tester);
    });

    testWidgets('有账：本月总量、每日柱、按模型、图例都渲染', (tester) async {
      final noon = DateTime(DateTime.now().year, DateTime.now().month,
          DateTime.now().day, 12);
      await pumpUsage(
        tester,
        loadUsage: () async => UsageSnapshot(
          entries: <UsageEntry>[
            UsageEntry(
              ts: noon.millisecondsSinceEpoch,
              conversationId: 'c1',
              model: 'claude-sonnet-5',
              inputTokens: 1000,
              outputTokens: 500,
              totalTokens: 1500,
            ),
            UsageEntry(
              ts: noon.add(const Duration(minutes: 5)).millisecondsSinceEpoch,
              conversationId: 'c1',
              model: 'glm-5.3',
              inputTokens: 2000,
              outputTokens: 1000,
              totalTokens: 3000,
            ),
          ],
        ),
      );
      expect(find.text('本月 tokens'), findsOneWidget);
      expect(find.text('本周'), findsOneWidget);
      expect(find.text('每日用量'), findsOneWidget);
      expect(find.byKey(const Key('usageDailyBars')), findsOneWidget);
      expect(find.textContaining('无记录（未记 ≠ 零用量）'), findsOneWidget);
      expect(find.text('按模型'), findsOneWidget);
      expect(find.text('glm-5.3'), findsOneWidget);
      expect(find.textContaining('数据截至'), findsOneWidget);
      expectNoVagueTokens(tester);
      expect(tester.takeException(), isNull);
    });

    testWidgets('切 7/30 日窗口不炸', (tester) async {
      final noon = DateTime(DateTime.now().year, DateTime.now().month,
          DateTime.now().day, 12);
      await pumpUsage(
        tester,
        loadUsage: () async => UsageSnapshot(
          entries: <UsageEntry>[
            UsageEntry(
              ts: noon.millisecondsSinceEpoch,
              model: 'glm-5.3',
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
            ),
          ],
        ),
      );
      await tester.tap(find.text('近 7 日'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('usageDailyBars')), findsOneWidget);
      await tester.tap(find.text('近 30 日'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('usageDailyBars')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('CSV 导出失败：问题 + 修复，不是一个哑按钮', (tester) async {
      // 主机没有 path_provider，写盘必然失败——正好钉住失败分支的文案。
      final noon = DateTime(DateTime.now().year, DateTime.now().month,
          DateTime.now().day, 12);
      await pumpUsage(
        tester,
        loadUsage: () async => UsageSnapshot(
          entries: <UsageEntry>[
            UsageEntry(
              ts: noon.millisecondsSinceEpoch,
              model: 'glm-5.3',
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
            ),
          ],
        ),
      );
      final exportButton = tester.widget<IconButton>(find.byTooltip('导出 CSV'));
      expect(exportButton.onPressed, isNotNull);
      await tester.tap(find.byTooltip('导出 CSV'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.textContaining('导出失败'), findsOneWidget);
      expect(find.textContaining('修复：'), findsOneWidget);
      // snackbar 的展示计时器不推过去，用例结束时会报 pending timer。
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
    });

    testWidgets('预算对话框：非法输入挡住保存，合法输入落到阈值条', (tester) async {
      final noon = DateTime(DateTime.now().year, DateTime.now().month,
          DateTime.now().day, 12);
      await pumpUsage(
        tester,
        loadUsage: () async => UsageSnapshot(
          entries: <UsageEntry>[
            UsageEntry(
              ts: noon.millisecondsSinceEpoch,
              model: 'glm-5.3',
              inputTokens: 3000,
              outputTokens: 1500,
              totalTokens: 4500,
            ),
          ],
        ),
      );

      await tester.tap(find.text('设置预算'));
      await tester.pumpAndSettle();
      expect(find.text('月度预算（token）'), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'abc');
      await tester.tap(find.text('保存'));
      await tester.pump();
      expect(find.text('填一个不小于 0 的整数（token）'), findsOneWidget);
      expect(find.text('月度预算（token）'), findsOneWidget,
          reason: '输入不合法时对话框不许关');

      await tester.enterText(find.byType(TextField), '6000');
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(find.text('本月 token 用量 / 自设上限'), findsOneWidget);
      expect(find.textContaining('（75%）'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
