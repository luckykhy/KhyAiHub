import 'package:meta/meta.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import 'app_logger.dart';

/// 本机 token 用量账。
///
/// 为什么客户端要自建账：后端 done 事件一直在带 usage（routes/ai.js 的 sendEvent），
/// 而服务端 getRemainingQuota 绑 subscription tier、且只记 CLI/TUI 流量
/// （recordUsage 只在 aiChatCore 与 usageScan 被调）。把那个配额数字显示给手机
/// 用户，等于报一个与本机无关的假数。账记在本机，每一行都对得上一次真实回合，
/// 月度预算也由用户自设（token 量纲），不从服务端取。
///
/// 失败策略与 AmooTurnStore 相同：所有方法都不抛、但每次失败都留日志。
/// 用量账是增益不是前提——一次数据库抖动不该把用量页打穿；而一个静默失效的
/// 持久层和一个正常工作的持久层在界面上长得一模一样，那恰恰是最难发现的 bug。
class UsageLedger {
  UsageLedger._();
  static final UsageLedger instance = UsageLedger._();

  static final _log = AppLogger();

  Database? _db;
  bool _broken = false;

  /// 本机账本此刻是否可用。false = 打开失败过（磁盘/权限）。
  ///
  /// 为什么要暴露它：界面必须把「没有记录」和「读不到」分开说。读不到时显示
  /// 「还没有用量记录」，用户会以为自己从没用过这个 App——静默失效和正常
  /// 工作在界面上长得一模一样，那恰恰是最难发现的那类 bug。
  bool get isAvailable => !_broken;

  /// 打开失败一次就标记不可用，之后所有调用走 no-op。
  /// 不再重试的理由同 amoo 本地库：打不开通常是磁盘或权限问题，在 UI 路径上
  /// 每次重试只会把卡顿放大成卡死。
  Future<Database?> _database() async {
    if (_broken) return null;
    if (_db != null) return _db;
    try {
      final dir = await getApplicationDocumentsDirectory();
      final db = await openDatabase(
        p.join(dir.path, 'usage_ledger.db'),
        version: UsageLedgerSchema.version,
        onOpen: (db) async {
          await db.execute(UsageLedgerSchema.indexTs);
          await db.execute(UsageLedgerSchema.createBudgetTable);
        },
        onCreate: (db, version) async {
          await db.execute(UsageLedgerSchema.createTable);
          await db.execute(UsageLedgerSchema.indexTs);
          await db.execute(UsageLedgerSchema.createBudgetTable);
        },
      );
      _db = db;
      return db;
    } catch (e, st) {
      _broken = true;
      _log.e(LogCategory.system, '用量账本打开失败，本次运行用量统计不可用',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return null;
    }
  }

  /// 记一个助手回合。
  ///
  /// [totalTokens] 省略时按「输入 + 输出」计——与桌面 usageChartMath 的合计口径
  /// 一致（不含缓存读/写，那是独立累加器，加进来就是第三个总量口径）。
  ///
  /// 库不可用返回 -1：调用方照常继续（本地账是增益），但要清楚这一笔没有记录。
  Future<int> record({
    required int ts,
    required String conversationId,
    required String provider,
    required String model,
    required int inputTokens,
    required int outputTokens,
    int? totalTokens,
  }) async {
    final db = await _database();
    if (db == null) return -1;
    final entry = UsageEntry(
      // ts <= 0 落到 1970，会把这一行排到所有图的外面且再也看不见。上游是 SSE
      // 事件数据（系统边界），宁可在这里归一成当前时间。
      ts: ts > 0 ? ts : DateTime.now().millisecondsSinceEpoch,
      conversationId: conversationId,
      provider: provider,
      model: model,
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      totalTokens: totalTokens ?? inputTokens + outputTokens,
    );
    try {
      return await db.insert(UsageLedgerSchema.table, entry.toRow());
    } catch (e, st) {
      _log.e(LogCategory.system, '用量记账失败，这一回合没有本地记录',
          details: <String, dynamic>{
            'conversation_id': entry.conversationId,
            'model': entry.model,
            'error': '$e',
          },
          error: e,
          stackTrace: st);
      return -1;
    }
  }

  /// [fromMs, toMs] 闭区间窗口内的行，按时间正序（图要从旧画到新）。
  ///
  /// 聚合为什么在 Dart 而不是 SQL GROUP BY：主机没有 sqlite3.dll，写进 SQL 的
  /// 聚合一行都测不了；而手机上一段时间内的助手回合数是几百行量级，Dart 侧聚合
  /// 的代价看不出来。索引只保窗口扫描这一件事。
  Future<List<UsageEntry>> entriesBetween(int fromMs, int toMs) async {
    final db = await _database();
    if (db == null) return const <UsageEntry>[];
    try {
      final rows = await db.query(
        UsageLedgerSchema.table,
        where: 'ts >= ? AND ts <= ?',
        whereArgs: <Object>[fromMs, toMs],
        orderBy: 'ts ASC, id ASC',
      );
      return rows.map(UsageEntry.fromRow).toList(growable: false);
    } catch (e, st) {
      _log.w(LogCategory.system, '用量账读取失败，本次返回空列表',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return const <UsageEntry>[];
    }
  }

  /// 用户自设月度预算（token）。0 = 没设。
  ///
  /// 为什么预算和账本同一张库：本机没有第二个键值存储可用（SecureStorage 是给
  /// 凭据的，shared_preferences 要动 pubspec——那是接线阶段的文件），而预算本来
  /// 就是用量域的数据。
  Future<int> monthlyBudget() async {
    final db = await _database();
    if (db == null) return 0;
    try {
      final rows = await db.query(
        UsageLedgerSchema.budgetTable,
        where: 'id = 0',
        limit: 1,
      );
      if (rows.isEmpty) return 0;
      final value = rows.first['monthly_tokens'];
      return value is int ? value : 0;
    } catch (e, st) {
      _log.w(LogCategory.system, '月度预算读取失败，本次按未设置处理',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return 0;
    }
  }

  Future<void> setMonthlyBudget(int tokens) async {
    final db = await _database();
    if (db == null) return;
    try {
      await db.insert(
        UsageLedgerSchema.budgetTable,
        <String, Object?>{
          'id': 0,
          'monthly_tokens': tokens < 0 ? 0 : tokens,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    } catch (e, st) {
      _log.e(LogCategory.system, '月度预算写入失败，设置不会生效',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
    }
  }

  /// 关闭。仅用于测试。
  Future<void> close() async {
    await _db?.close();
    _db = null;
  }
}

/// 一条助手回合的 token 用量。不可变；行映射见 [toRow] / [fromRow]。
@immutable
class UsageEntry {
  const UsageEntry({
    this.id,
    required this.ts,
    this.conversationId = '',
    this.provider = '',
    this.model = '',
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.totalTokens = 0,
  });

  final int? id;

  /// epoch ms（本地时区解读）
  final int ts;
  final String conversationId;
  final String provider;
  final String model;
  final int inputTokens;
  final int outputTokens;
  final int totalTokens;

  DateTime get at => DateTime.fromMillisecondsSinceEpoch(ts);

  UsageTotals get asTotals => UsageTotals(
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        totalTokens: totalTokens,
        turns: 1,
      );

  Map<String, Object?> toRow() => <String, Object?>{
        'id': id,
        'ts': ts,
        'conversation_id': conversationId,
        'provider': provider,
        'model': model,
        'input_tokens': inputTokens,
        'output_tokens': outputTokens,
        'total_tokens': totalTokens,
      };

  /// 缺列给默认值而不是抛：这张表跨版本持久，老行没有新列是常态。
  static UsageEntry fromRow(Map<String, Object?> row) => UsageEntry(
        id: row['id'] as int?,
        ts: (row['ts'] as int?) ?? 0,
        conversationId: (row['conversation_id'] as String?) ?? '',
        provider: (row['provider'] as String?) ?? '',
        model: (row['model'] as String?) ?? '',
        inputTokens: (row['input_tokens'] as int?) ?? 0,
        outputTokens: (row['output_tokens'] as int?) ?? 0,
        totalTokens: (row['total_tokens'] as int?) ?? 0,
      );
}

/// 一段时间内的合计。[turns] 是助手回合数——用户问的是「跑了多少回」，
/// 不只是 token 数。
@immutable
class UsageTotals {
  const UsageTotals({
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.totalTokens = 0,
    this.turns = 0,
  });

  final int inputTokens;
  final int outputTokens;
  final int totalTokens;
  final int turns;

  UsageTotals operator +(UsageTotals other) => UsageTotals(
        inputTokens: inputTokens + other.inputTokens,
        outputTokens: outputTokens + other.outputTokens,
        totalTokens: totalTokens + other.totalTokens,
        turns: turns + other.turns,
      );

  static UsageTotals of(Iterable<UsageEntry> entries) =>
      entries.fold(const UsageTotals(), (sum, e) => sum + e.asTotals);

  bool get isEmpty => turns == 0 && totalTokens == 0;
}

/// 一个本地日的桶。
///
/// [hasRecords] 与 totalTokens > 0 是两件事：那天一条都没记时画 Missing 态，
/// 不画零柱——「未记」被读成「零用量」是这张图唯一不能犯的错。
@immutable
class UsageDayBucket {
  const UsageDayBucket({
    required this.day,
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.totalTokens = 0,
    this.turns = 0,
  });

  /// 本地零点
  final DateTime day;
  final int inputTokens;
  final int outputTokens;
  final int totalTokens;
  final int turns;

  String get key => usageDayKey(day);

  bool get hasRecords => turns > 0 || totalTokens > 0;

  UsageTotals get totals => UsageTotals(
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        totalTokens: totalTokens,
        turns: turns,
      );
}

/// 一个自然月的桶（每月 1 日重置，与桌面端同一口径）。
@immutable
class UsageMonthBucket {
  const UsageMonthBucket({
    required this.year,
    required this.month,
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.totalTokens = 0,
    this.turns = 0,
  });

  final int year;
  final int month;
  final int inputTokens;
  final int outputTokens;
  final int totalTokens;
  final int turns;

  String get key => usageMonthKey(DateTime(year, month));

  UsageTotals get totals => UsageTotals(
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        totalTokens: totalTokens,
        turns: turns,
      );
}

/// 按模型归组的一行。[percentage] 是占窗口内合计的百分比（0-100）。
@immutable
class UsageModelBucket {
  const UsageModelBucket({
    required this.model,
    required this.totals,
    required this.percentage,
  });

  final String model;
  final UsageTotals totals;
  final double percentage;
}

/// 按会话归组的一行。
@immutable
class UsageSessionBucket {
  const UsageSessionBucket({required this.conversationId, required this.totals});

  final String conversationId;
  final UsageTotals totals;
}

/// 日键（本地时区）。与 logDayKey 同一格式：图表横轴、CSV、月桶都对它。
String usageDayKey(DateTime dt) {
  String p2(int n) => n.toString().padLeft(2, '0');
  return '${dt.year}-${p2(dt.month)}-${p2(dt.day)}';
}

String usageMonthKey(DateTime dt) {
  String p2(int n) => n.toString().padLeft(2, '0');
  return '${dt.year}-${p2(dt.month)}';
}

/// 本周一零点（中文周历口径：周一起算）。
DateTime usageWeekStart(DateTime now) => _midnight(now).subtract(Duration(days: now.weekday - 1));

DateTime _midnight(DateTime dt) => DateTime(dt.year, dt.month, dt.day);

/// 近 [days] 日的日桶，**最旧在前**（图从左画到右）。
///
/// 窗口外的行直接不进图；窗口内没有记录的日补零桶并由 [UsageDayBucket.hasRecords]
/// 标出——补桶是为了横轴连续，不是把「没记」说成「没用」。
List<UsageDayBucket> usageByDay(
  List<UsageEntry> entries, {
  required int days,
  DateTime? now,
}) {
  if (days <= 0) return const <UsageDayBucket>[];
  final today = _midnight(now ?? DateTime.now());
  final dayByKey = <String, DateTime>{};
  final sums = <String, _UsageSum>{};
  for (var i = days - 1; i >= 0; i--) {
    final day = today.subtract(Duration(days: i));
    final key = usageDayKey(day);
    dayByKey[key] = day;
    sums[key] = _UsageSum();
  }
  for (final entry in entries) {
    final sum = sums[usageDayKey(entry.at)];
    if (sum == null) continue;
    sum.add(entry);
  }
  return <UsageDayBucket>[
    for (final key in dayByKey.keys)
      UsageDayBucket(
        day: dayByKey[key]!,
        inputTokens: sums[key]!.inputTokens,
        outputTokens: sums[key]!.outputTokens,
        totalTokens: sums[key]!.totalTokens,
        turns: sums[key]!.turns,
      ),
  ];
}

/// 近 [months] 个自然月的月桶，**最旧在前**，含当月。
List<UsageMonthBucket> usageByMonth(
  List<UsageEntry> entries, {
  int months = 6,
  DateTime? now,
}) {
  if (months <= 0) return const <UsageMonthBucket>[];
  final nowDate = now ?? DateTime.now();
  final monthByKey = <String, List<int>>{};
  final sums = <String, _UsageSum>{};
  for (var i = months - 1; i >= 0; i--) {
    // DateTime 会自行规约越界的月份（2026 年 0 月 = 2025 年 12 月）。
    final month = DateTime(nowDate.year, nowDate.month - i);
    final key = usageMonthKey(month);
    monthByKey[key] = <int>[month.year, month.month];
    sums[key] = _UsageSum();
  }
  for (final entry in entries) {
    final sum = sums[usageMonthKey(entry.at)];
    if (sum == null) continue;
    sum.add(entry);
  }
  return <UsageMonthBucket>[
    for (final key in monthByKey.keys)
      UsageMonthBucket(
        year: monthByKey[key]![0],
        month: monthByKey[key]![1],
        inputTokens: sums[key]!.inputTokens,
        outputTokens: sums[key]!.outputTokens,
        totalTokens: sums[key]!.totalTokens,
        turns: sums[key]!.turns,
      ),
  ];
}

/// 按模型归组，合计降序；合计为 0 的模型也列出来（它有过回合）。
List<UsageModelBucket> usageByModel(List<UsageEntry> entries) {
  final sums = <String, _UsageSum>{};
  for (final entry in entries) {
    (sums[entry.model] ??= _UsageSum()).add(entry);
  }
  final total = entries.fold<int>(0, (sum, e) => sum + e.totalTokens);
  final rows = <UsageModelBucket>[
    for (final mapEntry in sums.entries)
      UsageModelBucket(
        model: mapEntry.key,
        totals: mapEntry.value.asTotals,
        percentage: total <= 0 ? 0 : mapEntry.value.totalTokens / total * 100,
      ),
  ];
  rows.sort((a, b) {
    final byTotal = b.totals.totalTokens.compareTo(a.totals.totalTokens);
    // 合计相同时按模型名，否则同分模型的次序随建表顺序漂移。
    return byTotal != 0 ? byTotal : a.model.compareTo(b.model);
  });
  return rows;
}

/// 按会话归组，合计降序。
List<UsageSessionBucket> usageByConversation(List<UsageEntry> entries) {
  final sums = <String, _UsageSum>{};
  for (final entry in entries) {
    (sums[entry.conversationId] ??= _UsageSum()).add(entry);
  }
  final rows = <UsageSessionBucket>[
    for (final mapEntry in sums.entries)
      UsageSessionBucket(
        conversationId: mapEntry.key,
        totals: mapEntry.value.asTotals,
      ),
  ];
  rows.sort((a, b) {
    final byTotal = b.totals.totalTokens.compareTo(a.totals.totalTokens);
    return byTotal != 0 ? byTotal : a.conversationId.compareTo(b.conversationId);
  });
  return rows;
}

class _UsageSum {
  int inputTokens = 0;
  int outputTokens = 0;
  int totalTokens = 0;
  int turns = 0;

  void add(UsageEntry entry) {
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
    totalTokens += entry.totalTokens;
    turns += 1;
  }

  UsageTotals get asTotals => UsageTotals(
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        totalTokens: totalTokens,
        turns: turns,
      );
}

/// CSV 表头。与桌面 usageChartMath.CSV_HEADERS 同一口径：逐行恒同的注记必须
/// 显式写出，不写的话导出文件会被当成「纯本应用请求」。
const List<String> usageCsvHeaders = <String>[
  'ts',
  'conversation_id',
  'provider',
  'model',
  'input_tokens',
  'output_tokens',
  'total_tokens',
];

/// 由账本行拼 CSV。表头四行注记交代口径（窗口、合计怎么算、是不是全量），
/// 少一行，导出的数字就会被当成别的意思。
String buildUsageCsv(
  List<UsageEntry> entries, {
  String? stamp,
  int? windowDays,
}) {
  final lines = <String>[];
  if (stamp != null && stamp.isNotEmpty) lines.add('# 数据截至: $stamp');
  if (windowDays != null) lines.add('# 统计窗口: 近 $windowDays 日');
  lines.add('# 本机账本：只含本机记录的助手回合，非全量历史');
  lines.add('# 合计 = 输入 + 输出，不含缓存读/写');
  lines.add(usageCsvHeaders.join(','));
  for (final entry in entries) {
    final fields = <String>[
      entry.at.toIso8601String(),
      entry.conversationId,
      entry.provider,
      entry.model,
      '${entry.inputTokens}',
      '${entry.outputTokens}',
      '${entry.totalTokens}',
    ];
    lines.add(fields.map(csvField).join(','));
  }
  return '${lines.join('\n')}\n';
}

/// RFC 4180 的最小转义：含分隔符/引号/换行才加引号。模型名带逗号不是假设——
/// OpenRouter 的模型 id 就长那样。
String csvField(String value) {
  if (value.contains(',') ||
      value.contains('"') ||
      value.contains('\n') ||
      value.contains('\r')) {
    return '"${value.replaceAll('"', '""')}"';
  }
  return value;
}

/// 导出文件名（本地时间）。只在这里拼一次，界面与测试共用同一格式。
String usageExportFileName(DateTime now) {
  String p2(int n) => n.toString().padLeft(2, '0');
  return 'usage-export-${now.year}${p2(now.month)}${p2(now.day)}'
      '-${p2(now.hour)}${p2(now.minute)}${p2(now.second)}.csv';
}

/// 一个模型的价目。量纲与后端 pricingService.modelPricing 一致：**元 / 1M tokens**。
@immutable
class ModelPrice {
  const ModelPrice({required this.inputPer1M, required this.outputPer1M});

  final double inputPer1M;
  final double outputPer1M;
}

/// 解析 `GET /api/ai-gateway/pricing` 的载荷（pricingService.getState 的形状）。
///
/// 形状不对或没有 modelPricing 时返回**空表**：空表让界面说「未计价」，
/// 而伪造一张表会让上面每个数字都像真的。模型名一律转小写——后端
/// normalizeState 也这么做，两边不一致就等于没有价目。
Map<String, ModelPrice> parseGatewayPricing(Object? payload) {
  if (payload is! Map) return const <String, ModelPrice>{};
  final raw = payload['modelPricing'];
  if (raw is! Map) return const <String, ModelPrice>{};
  final prices = <String, ModelPrice>{};
  raw.forEach((key, value) {
    if (key is! String || key.isEmpty || value is! Map) return;
    prices[key.toLowerCase()] = ModelPrice(
      inputPer1M: _nonNegative(value['input']),
      outputPer1M: _nonNegative(value['output']),
    );
  });
  return prices;
}

double _nonNegative(Object? value) {
  final number = value is num
      ? value.toDouble()
      : double.tryParse('${value ?? ''}'.trim());
  if (number == null || !number.isFinite || number < 0) return 0;
  return number;
}

/// 单回合成本估计（元）。价目表里没有这个模型时返回 null——
/// 「未计价」与「免费」是两件事，后者不替用户断言。
double? estimateCostCny({
  required String model,
  required int inputTokens,
  required int outputTokens,
  required Map<String, ModelPrice> prices,
}) {
  if (model.isEmpty) return null;
  final price = prices[model.toLowerCase()];
  if (price == null) return null;
  return (inputTokens * price.inputPer1M + outputTokens * price.outputPer1M) /
      1000000;
}

/// 库结构。集中一处，迁移时只改这里。
abstract final class UsageLedgerSchema {
  static const String table = 'usage_entry';
  static const String budgetTable = 'usage_budget';

  static const String createTable = '''
CREATE TABLE IF NOT EXISTS $table (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  conversation_id TEXT    NOT NULL DEFAULT '',
  provider        TEXT    NOT NULL DEFAULT '',
  model           TEXT    NOT NULL DEFAULT '',
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0
)
''';

  /// 唯一的索引：用量页只做「窗口内全量取出、Dart 侧聚合」，需要的就是
  /// ts 范围扫描不是全表扫。model / conversation_id 上没有消费方，不建。
  static const String indexTs =
      'CREATE INDEX IF NOT EXISTS idx_${table}_ts ON $table (ts)';

  /// 用户自设月度预算。单行表，CHECK 把「只有一行」这条不变量钉在存储层——
  /// 预算出现两行的那天，界面读哪一行都是猜。
  static const String createBudgetTable = '''
CREATE TABLE IF NOT EXISTS $budgetTable (
  id             INTEGER PRIMARY KEY CHECK (id = 0),
  monthly_tokens INTEGER NOT NULL DEFAULT 0
)
''';

  static const int version = 1;
}
