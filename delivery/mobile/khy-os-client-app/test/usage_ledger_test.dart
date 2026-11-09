import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/usage_ledger.dart';

/// 用量账本的纯逻辑测试。
///
/// 刻意不碰 sqflite：主机上没有 sqlite3.dll，`UsageLedger` 的读写只能在设备上
/// 跑（与 amoo_turn_test 同一纪律）。这里测的是不依赖原生库的那一半——行映射、
/// 四维聚合、CSV 口径、价目解析。而聚合口径恰是全部容易出错的地方：窗口边界
/// 差一天、月桶跨年、百分比分母选错，都不会抛异常，只会静静地算错。
void main() {
  // 2026-11-04 是周三；本周一 = 2026-11-02，上周日 = 2026-11-01。
  final now = DateTime(2026, 11, 4, 15, 30);

  UsageEntry turn({
    required int month,
    required int day,
    int hour = 9,
    String model = 'claude-sonnet-5',
    String conversation = 'c1',
    String provider = 'p1',
    int input = 100,
    int output = 50,
  }) =>
      UsageEntry(
        ts: DateTime(2026, month, day, hour).millisecondsSinceEpoch,
        conversationId: conversation,
        provider: provider,
        model: model,
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
      );

  group('UsageEntry 行映射', () {
    test('toRow/fromRow 往返保持每个字段', () {
      const entry = UsageEntry(
        id: 7,
        ts: 1730000000000,
        conversationId: 'conv-1',
        provider: 'Command Code',
        model: 'zai-org/GLM-5.3',
        inputTokens: 1234,
        outputTokens: 567,
        totalTokens: 1801,
      );
      final back = UsageEntry.fromRow(entry.toRow());
      expect(back.id, entry.id);
      expect(back.ts, entry.ts);
      expect(back.conversationId, entry.conversationId);
      expect(back.provider, entry.provider);
      expect(back.model, entry.model);
      expect(back.inputTokens, entry.inputTokens);
      expect(back.outputTokens, entry.outputTokens);
      expect(back.totalTokens, entry.totalTokens);
    });

    test('缺列给默认值而不是抛', () {
      // 这张表跨版本持久，老行没有新列是常态；`as int?` 遇到字符串会抛，
      // 而异常会一路打到界面上。
      final entry = UsageEntry.fromRow(<String, Object?>{'ts': 42});
      expect(entry.ts, 42);
      expect(entry.conversationId, '');
      expect(entry.provider, '');
      expect(entry.model, '');
      expect(entry.inputTokens, 0);
      expect(entry.totalTokens, 0);
    });

    test('日键按本地日归集，跨午夜不并桶', () {
      final beforeMidnight = turn(month: 11, day: 4, hour: 23);
      final afterMidnight = turn(month: 11, day: 5, hour: 0);
      expect(usageDayKey(beforeMidnight.at), '2026-11-04');
      expect(usageDayKey(afterMidnight.at), '2026-11-05');
    });

    test('asTotals 一回合计 1', () {
      final totals = turn(month: 11, day: 4).asTotals;
      expect(totals.turns, 1);
      expect(totals.totalTokens, 150);
    });
  });

  group('schema', () {
    test('DDL 覆盖全部字段', () {
      for (final col in const <String>[
        'id',
        'ts',
        'conversation_id',
        'provider',
        'model',
        'input_tokens',
        'output_tokens',
        'total_tokens',
      ]) {
        expect(UsageLedgerSchema.createTable, contains(col),
            reason: 'DDL 缺列 $col');
      }
    });

    test('索引名与表名不脱节', () {
      expect(UsageLedgerSchema.indexTs, contains(UsageLedgerSchema.table));
    });

    test('预算表把单行钉在存储层', () {
      expect(UsageLedgerSchema.createBudgetTable, contains('CHECK (id = 0)'));
      expect(UsageLedgerSchema.createBudgetTable, contains('monthly_tokens'));
    });
  });

  group('UsageTotals', () {
    test('相加逐字段累加', () {
      const a = UsageTotals(
          inputTokens: 1, outputTokens: 2, totalTokens: 3, turns: 1);
      const b = UsageTotals(
          inputTokens: 10, outputTokens: 20, totalTokens: 30, turns: 2);
      final sum = a + b;
      expect(sum.inputTokens, 11);
      expect(sum.outputTokens, 22);
      expect(sum.totalTokens, 33);
      expect(sum.turns, 3);
    });

    test('of 汇总一串行', () {
      final totals = UsageTotals.of(<UsageEntry>[
        turn(month: 11, day: 4, input: 100, output: 50),
        turn(month: 11, day: 3, input: 200, output: 100),
      ]);
      expect(totals.turns, 2);
      expect(totals.totalTokens, 450);
    });
  });

  group('usageByDay', () {
    test('近 N 日桶最旧在前，窗口内无记录的日补零桶', () {
      final buckets = usageByDay(
        <UsageEntry>[
          turn(month: 11, day: 4, input: 200, output: 100),
          turn(month: 11, day: 4, hour: 10, input: 300, output: 150),
          turn(month: 11, day: 2, input: 100, output: 50),
        ],
        days: 4,
        now: now,
      );
      expect(buckets.map((b) => b.key), <String>[
        '2026-11-01',
        '2026-11-02',
        '2026-11-03',
        '2026-11-04',
      ]);
      expect(buckets[0].hasRecords, false,
          reason: '未记的日子必须标出来，画成零柱等于说那天没用量');
      expect(buckets[1].totalTokens, 150);
      expect(buckets[1].turns, 1);
      expect(buckets[2].hasRecords, false);
      expect(buckets[3].totalTokens, 750);
      expect(buckets[3].inputTokens, 500);
      expect(buckets[3].outputTokens, 250);
      expect(buckets[3].turns, 2);
    });

    test('窗口外的行不进图', () {
      final buckets = usageByDay(
        <UsageEntry>[turn(month: 10, day: 1)],
        days: 4,
        now: now,
      );
      expect(buckets.length, 4);
      expect(buckets.every((b) => !b.hasRecords), true);
    });

    test('days <= 0 返回空', () {
      expect(usageByDay(<UsageEntry>[], days: 0, now: now), isEmpty);
    });
  });

  group('usageByMonth', () {
    test('近 N 个自然月最旧在前，含当月；更早的行忽略', () {
      final buckets = usageByMonth(
        <UsageEntry>[
          turn(month: 11, day: 4, input: 200, output: 100),
          turn(month: 10, day: 20, input: 100, output: 50),
          turn(month: 8, day: 1, input: 999, output: 999),
        ],
        months: 3,
        now: now,
      );
      expect(buckets.map((b) => b.key), <String>[
        '2026-09',
        '2026-10',
        '2026-11',
      ]);
      expect(buckets[0].hasRecords, false);
      expect(buckets[1].totalTokens, 150);
      expect(buckets[2].totalTokens, 300);
    });

    test('months = 1 就是本月桶', () {
      final buckets = usageByMonth(
        <UsageEntry>[
          turn(month: 11, day: 4, input: 200, output: 100),
          turn(month: 10, day: 20),
        ],
        months: 1,
        now: now,
      );
      expect(buckets.length, 1);
      expect(buckets.single.totalTokens, 300);
      expect(buckets.single.totals.turns, 1);
    });

    test('跨年时月份正确回卷', () {
      final buckets = usageByMonth(
        <UsageEntry>[turn(month: 11, day: 4)],
        months: 3,
        now: DateTime(2026, 1, 15, 8),
      );
      expect(buckets.map((b) => b.key),
          <String>['2025-11', '2025-12', '2026-01']);
    });
  });

  group('usageByModel', () {
    test('合计降序，百分比分母是窗口合计', () {
      final rows = usageByModel(<UsageEntry>[
        turn(month: 11, day: 4, model: 'glm-5.3', input: 2000, output: 1000),
        turn(month: 11, day: 3, model: 'claude-sonnet-5',
            input: 1000, output: 500),
        turn(month: 11, day: 2, model: 'glm-5.3', input: 300, output: 150),
      ]);
      expect(rows.map((r) => r.model),
          <String>['glm-5.3', 'claude-sonnet-5']);
      expect(rows[0].totals.totalTokens, 3450);
      expect(rows[1].totals.totalTokens, 1500);
      expect(rows[0].percentage, closeTo(3450 / 4950 * 100, 1e-9));
      expect(rows[1].percentage, closeTo(1500 / 4950 * 100, 1e-9));
    });

    test('合计为 0 时百分比是 0 而不是 NaN', () {
      final rows = usageByModel(<UsageEntry>[
        turn(month: 11, day: 4, input: 0, output: 0),
      ]);
      expect(rows.single.percentage, 0);
    });

    test('模型名原样归组，不做大小写合并', () {
      // 合并大小写是显示层的事；这里合并会让两个不同模型的账对不上。
      final rows = usageByModel(<UsageEntry>[
        turn(month: 11, day: 4, model: 'GLM-5.3'),
        turn(month: 11, day: 3, model: 'glm-5.3'),
      ]);
      expect(rows.length, 2);
    });
  });

  group('usageByConversation', () {
    test('按会话归组，合计降序', () {
      final rows = usageByConversation(<UsageEntry>[
        turn(month: 11, day: 4, conversation: 'c1', input: 100, output: 50),
        turn(month: 11, day: 3, conversation: 'c2', input: 500, output: 250),
        turn(month: 11, day: 2, conversation: 'c1', input: 100, output: 50),
      ]);
      expect(rows.map((r) => r.conversationId), <String>['c2', 'c1']);
      expect(rows[0].totals.totalTokens, 750);
      expect(rows[1].totals.turns, 2);
    });
  });

  group('usageWeekStart', () {
    test('周三回退到本周一零点', () {
      expect(usageWeekStart(now), DateTime(2026, 11, 2));
    });

    test('周一回退到当天零点（不再往前）', () {
      expect(usageWeekStart(DateTime(2026, 11, 2, 23, 59)),
          DateTime(2026, 11, 2));
    });

    test('周日回退到上一个周一', () {
      expect(usageWeekStart(DateTime(2026, 11, 1, 1)), DateTime(2026, 10, 26));
    });
  });

  group('buildUsageCsv', () {
    test('表头四行注记交代口径，缺一行数字就会被当成别的意思', () {
      final csv = buildUsageCsv(
        <UsageEntry>[turn(month: 11, day: 4)],
        stamp: '2026-11-04 15:30:00',
        windowDays: 90,
      );
      final lines = const LineSplitter().convert(csv);
      expect(lines[0], '# 数据截至: 2026-11-04 15:30:00');
      expect(lines[1], '# 统计窗口: 近 90 日');
      expect(lines[2], '# 本机账本：只含本机记录的助手回合，非全量历史');
      expect(lines[3], '# 合计 = 输入 + 输出，不含缓存读/写');
      expect(lines[4], usageCsvHeaders.join(','));
      expect(lines.length, 6, reason: '5 行表头 + 1 行数据');
      expect(lines[5], '2026-11-04T09:00:00.000,c1,p1,claude-sonnet-5,100,50,150');
    });

    test('空账本也有表头，不产出空文件', () {
      final csv = buildUsageCsv(<UsageEntry>[]);
      final lines = const LineSplitter().convert(csv);
      // 无 stamp / windowDays 时只有两行固定注记 + 表头；结尾 \n 不额外产一行。
      expect(lines.length, 3);
      expect(lines.last, usageCsvHeaders.join(','));
    });

    test('模型名带逗号或引号时按 RFC 4180 转义', () {
      // OpenRouter 的模型 id 就长这样，不转义会把这行顶成 8 列。
      final csv = buildUsageCsv(<UsageEntry>[
        UsageEntry(
          ts: DateTime(2026, 11, 4, 9).millisecondsSinceEpoch,
          model: 'a,b"c',
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        ),
      ]);
      final lines = const LineSplitter().convert(csv);
      expect(lines.last, '2026-11-04T09:00:00.000,,,"a,b""c",1,2,3');
    });

    test('stamp / windowDays 缺省时不写对应注记行', () {
      final lines = const LineSplitter().convert(buildUsageCsv(<UsageEntry>[]));
      expect(lines.where((l) => l.startsWith('# 数据截至')), isEmpty);
      expect(lines.where((l) => l.startsWith('# 统计窗口')), isEmpty);
    });
  });

  group('usageExportFileName', () {
    test('本地时间、零填充、.csv 结尾', () {
      expect(usageExportFileName(DateTime(2026, 11, 4, 9, 5, 1)),
          'usage-export-20261104-090501.csv');
    });
  });

  group('parseGatewayPricing', () {
    test('解析 modelPricing，模型名转小写', () {
      final prices = parseGatewayPricing(<String, dynamic>{
        'version': 1,
        'groups': <String, dynamic>{},
        'modelPricing': <String, dynamic>{
          'Claude-Sonnet-5': <String, dynamic>{'input': 3, 'output': 15},
        },
      });
      expect(prices.length, 1);
      expect(prices['claude-sonnet-5']!.inputPer1M, 3);
      expect(prices['claude-sonnet-5']!.outputPer1M, 15);
    });

    test('形状不对返回空表——空表让界面说未计价，伪造一张表会让每个数字像真的', () {
      expect(parseGatewayPricing(null), isEmpty);
      expect(parseGatewayPricing('nope'), isEmpty);
      expect(parseGatewayPricing(<String, dynamic>{'modelPricing': 'nope'}),
          isEmpty);
      expect(
        parseGatewayPricing(<String, dynamic>{
          'modelPricing': <String, dynamic>{'m': 'not-a-map'},
        }),
        isEmpty,
      );
    });

    test('非数值价格按 0 计，不抛', () {
      final prices = parseGatewayPricing(<String, dynamic>{
        'modelPricing': <String, dynamic>{
          'm': <String, dynamic>{'input': 'abc', 'output': -5},
        },
      });
      expect(prices['m']!.inputPer1M, 0);
      expect(prices['m']!.outputPer1M, 0);
    });
  });

  group('estimateCostCny', () {
    final prices = <String, ModelPrice>{
      'claude-sonnet-5':
          const ModelPrice(inputPer1M: 3, outputPer1M: 15),
    };

    test('按元 / 1M tokens 折算', () {
      expect(
        estimateCostCny(
          model: 'Claude-Sonnet-5',
          inputTokens: 1000000,
          outputTokens: 0,
          prices: prices,
        ),
        closeTo(3.0, 1e-9),
      );
      expect(
        estimateCostCny(
          model: 'claude-sonnet-5',
          inputTokens: 500000,
          outputTokens: 100000,
          prices: prices,
        ),
        closeTo(3.0, 1e-9),
      );
    });

    test('价目表里没有的模型返回 null——未计价不是免费', () {
      expect(
        estimateCostCny(
          model: 'glm-5.3',
          inputTokens: 1000,
          outputTokens: 1000,
          prices: prices,
        ),
        isNull,
      );
    });

    test('空模型名返回 null', () {
      expect(
        estimateCostCny(
          model: '',
          inputTokens: 1000,
          outputTokens: 1000,
          prices: prices,
        ),
        isNull,
      );
    });
  });
}
