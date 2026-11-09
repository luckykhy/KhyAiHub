// khy-canary: Khy-20261101-088-BJRHPH6S
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// ───────────────────────────────────────────────
/// khy-os 手机端日志规范 v3（见 docs/10_规范/其它规范/[DESIGN-LOG-002]）
///
/// 落盘形态：按天分文件，一行一条 JSON（JSONL）
///   logs/khy-os-YYYY-MM-DD.jsonl       当天全部条目
///   logs/khy-os-YYYY-MM-DD.err.jsonl   当天错误条目投影（error / fatal）
///
/// 错误双写的原因：主文件保上下文，错误文件让「按天查错」只读错误量，
/// 不必为了数错误而把整天的日志读进内存。
///
/// 迁移前的旧日志文件（文档目录下的 `khy-os.log`）保持可读，不做格式转换。
/// ───────────────────────────────────────────────

/// 日志级别
enum LogLevel { debug, info, warn, error, fatal }

/// 日志级别短标签
String logLevelLabel(LogLevel level) {
  switch (level) {
    case LogLevel.debug:
      return 'DBG';
    case LogLevel.info:
      return 'INF';
    case LogLevel.warn:
      return 'WRN';
    case LogLevel.error:
      return 'ERR';
    case LogLevel.fatal:
      return 'FTL';
  }
}

/// 日志分类
enum LogCategory {
  network, // 网络请求
  dns, // DNS 解析
  auth, // 认证
  ui, // 界面操作
  config, // 配置
  api, // API 调用
  tool, // 工具执行
  device, // 设备操作
  system, // 系统
  unknown, // 未分类
}

/// 日志分类短标签
String logCategoryLabel(LogCategory category) {
  switch (category) {
    case LogCategory.network:
      return 'NET';
    case LogCategory.dns:
      return 'DNS';
    case LogCategory.auth:
      return 'ATH';
    case LogCategory.ui:
      return 'UI';
    case LogCategory.config:
      return 'CFG';
    case LogCategory.api:
      return 'API';
    case LogCategory.tool:
      return 'TOL';
    case LogCategory.device:
      return 'DEV';
    case LogCategory.system:
      return 'SYS';
    case LogCategory.unknown:
      return 'UNK';
  }
}

/// 错误码常量。3 位数字，前 2 位表示域：
///   E1xx 网络  E101 DNS / E102 连接 / E103 超时 / E104 HTTP 4xx / E105 HTTP 5xx
///   E2xx API   E201 认证 / E202 参数 / E203 模型 / E204 限流
///   E3xx 工具  E301 工具执行 / E302 无障碍 / E303 截屏 / E304 Shell
///   E4xx 系统  E401 权限 / E402 配置 / E403 存储
///   E5xx 未知  E500
///   E6xx 客户端 E601 崩溃 / E602 会话失效 / E603 设备能力 / E604 本地存储
class ErrorCode {
  // ── E1xx 网络 ──
  static const String dns = 'E101';
  static const String connection = 'E102';
  static const String timeout = 'E103';
  static const String http4xx = 'E104';
  static const String http5xx = 'E105';

  // ── E2xx API ──
  static const String auth = 'E201';
  static const String param = 'E202';
  static const String model = 'E203';
  static const String rateLimit = 'E204';

  // ── E3xx 工具 ──
  static const String toolExec = 'E301';
  static const String accessibility = 'E302';
  static const String screenCapture = 'E303';
  static const String shell = 'E304';

  // ── E4xx 系统 ──
  static const String permission = 'E401';
  static const String configMissing = 'E402';
  static const String storage = 'E403';

  // ── E5xx 未知 ──
  static const String unknown = 'E500';

  // ── E6xx 客户端 ──
  static const String crash = 'E601';
  static const String session = 'E602';
  static const String capability = 'E603';
  static const String localStore = 'E604';

  /// 根据 HTTP 状态码返回错误码
  static String forHttpStatus(int code) {
    if (code >= 400 && code < 500) return http4xx;
    if (code >= 500) return http5xx;
    return unknown;
  }

  /// 错误码的中文含义（错误总览与导出包用）
  static String describe(String code) {
    switch (code) {
      case dns:
        return 'DNS 解析失败';
      case connection:
        return '连接失败';
      case timeout:
        return '请求超时';
      case http4xx:
        return 'HTTP 4xx 客户端错误';
      case http5xx:
        return 'HTTP 5xx 服务端错误';
      case auth:
        return '认证失败';
      case param:
        return '参数非法';
      case model:
        return '模型不可用';
      case rateLimit:
        return '被限流';
      case toolExec:
        return '工具执行失败';
      case accessibility:
        return '无障碍服务不可用';
      case screenCapture:
        return '截屏失败';
      case shell:
        return 'Shell 执行失败';
      case permission:
        return '权限被拒';
      case configMissing:
        return '配置缺失';
      case storage:
        return '存储不可写';
      case unknown:
        return '未归类错误';
      case crash:
        return '客户端崩溃';
      case session:
        return '会话失效';
      case capability:
        return '设备能力不可用';
      case localStore:
        return '本地存储失败';
      default:
        return '未登记错误码';
    }
  }
}

/// 两位补零
String _pad2(int n) => n.toString().padLeft(2, '0');

/// 日志时间戳（本地时区，毫秒精度）
String formatLogTime(DateTime dt) {
  return '${dt.year}-${_pad2(dt.month)}-${_pad2(dt.day)} '
      '${_pad2(dt.hour)}:${_pad2(dt.minute)}:${_pad2(dt.second)}.'
      '${dt.millisecond.toString().padLeft(3, '0')}';
}

/// 日键（文件名与日期匹配用）
String logDayKey(DateTime dt) =>
    '${dt.year}-${_pad2(dt.month)}-${_pad2(dt.day)}';

/// 单条日志
class LogEntry {
  const LogEntry({
    required this.ts,
    required this.level,
    required this.category,
    required this.message,
    this.code,
    this.context = const {},
    this.error,
    this.stack,
    this.screen,
    this.seq = 0,
  });

  final DateTime ts;
  final LogLevel level;
  final LogCategory category;
  final String message;
  final String? code;
  final Map<String, dynamic> context;
  final String? error;
  final String? stack;
  final String? screen;
  final int seq;

  /// 错误条目（错误是日志的重点，单独判定）
  bool get isError =>
      level == LogLevel.error || level == LogLevel.fatal;

  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'ts': ts.toIso8601String(),
      'seq': seq,
      'level': level.name,
      'cat': category.name,
      if (code != null) 'code': code,
      'msg': message,
      if (context.isNotEmpty) 'ctx': context,
      if (error != null) 'err': error,
      if (stack != null) 'stack': stack,
      if (screen != null) 'screen': screen,
    };
  }

  static LogEntry? fromJson(Map<String, dynamic> json) {
    final ts = DateTime.tryParse('${json['ts']}');
    if (ts == null) return null;
    final level = LogLevel.values.firstWhere(
      (l) => l.name == json['level'],
      orElse: () => LogLevel.info,
    );
    final category = LogCategory.values.firstWhere(
      (c) => c.name == json['cat'],
      orElse: () => LogCategory.unknown,
    );
    final rawCtx = json['ctx'];
    return LogEntry(
      ts: ts,
      level: level,
      category: category,
      message: '${json['msg'] ?? ''}',
      code: json['code'] is String ? json['code'] as String : null,
      context: rawCtx is Map
          ? Map<String, dynamic>.from(rawCtx)
          : const <String, dynamic>{},
      error: json['err'] is String ? json['err'] as String : null,
      stack: json['stack'] is String ? json['stack'] as String : null,
      screen: json['screen'] is String ? json['screen'] as String : null,
      seq: (json['seq'] as num?)?.toInt() ?? 0,
    );
  }

  /// 人类可读的一行（界面列表与文本导出共用）
  String toLine() {
    final buf = StringBuffer()
      ..write(formatLogTime(ts))
      ..write(' [')
      ..write(logLevelLabel(level))
      ..write('][')
      ..write(logCategoryLabel(category))
      ..write(']');
    if (code != null) buf.write('[$code] ');
    buf.write(message);
    return buf.toString();
  }
}

/// 一天日志的索引项
class LogDay {
  const LogDay({
    required this.date,
    this.errorCount = 0,
    this.bytes = 0,
    this.legacy = false,
  });

  final DateTime date;
  final int errorCount;
  final int bytes;

  /// 迁移前的旧版日志文件（文本格式，非 JSONL）
  final bool legacy;

  String get key => legacy ? 'legacy' : logDayKey(date);
}

/// 日志文件仓库：按天分文件，负责落盘、读取、留存与导出
class LogStore {
  LogStore({String? directoryPath}) : _dirOverride = directoryPath;

  /// 保留天数
  static const int retentionDays = 14;

  /// 单日文件体积上限，超过后只保留警告与错误条目
  static const int maxDayBytes = 8 * 1024 * 1024;

  static const String _filePrefix = 'khy-os-';
  static const String _fileSuffix = '.jsonl';
  static const String _errSuffix = '.err.jsonl';
  static const String _legacyName = 'khy-os.log';

  final String? _dirOverride;
  Directory? _dir;
  String? _basePath;
  bool _disabled = false;

  /// 串行化写盘：并发写入会打乱行序，链条保证同一文件内条目按时间排列
  Future<void> _writeChain = Future<void>.value();

  /// 定位日志目录。拿不到就禁用日志——日志是旁路，
  /// 不能因为存不了盘就把调用方一起拖垮。
  Future<Directory?> _resolveDir() async {
    if (_disabled) return null;
    final cached = _dir;
    if (cached != null) return cached;
    try {
      final base = _dirOverride != null
          ? Directory(_dirOverride)
          : await getApplicationDocumentsDirectory();
      _basePath = base.path;
      final dir = Directory(p.join(base.path, 'logs'));
      if (!await dir.exists()) await dir.create(recursive: true);
      _dir = dir;
      return dir;
    } catch (_) {
      _disabled = true;
      return null;
    }
  }

  File _dayFile(Directory dir, DateTime day) =>
      File(p.join(dir.path, '$_filePrefix${logDayKey(day)}$_fileSuffix'));

  File _errFile(Directory dir, DateTime day) =>
      File(p.join(dir.path, '$_filePrefix${logDayKey(day)}$_errSuffix'));

  /// 初始化：建目录、清过期文件
  Future<void> init() async {
    await _resolveDir();
    await prune();
  }

  /// 当前日志目录（界面与导出用）
  Future<String> logDirectoryPath() async =>
      (await _resolveDir())?.path ?? '';

  /// 当天日志文件路径
  Future<String> currentFilePath() async {
    final dir = await _resolveDir();
    if (dir == null) return '';
    return _dayFile(dir, DateTime.now()).path;
  }

  /// 写入一条日志
  Future<void> append(LogEntry entry) async {
    final dir = await _resolveDir();
    if (dir == null) return;
    final line = '${jsonEncode(entry.toJson())}\n';
    final isError = entry.isError;
    final keepOnOverflow =
        isError || entry.level == LogLevel.warn;

    _writeChain = _writeChain.then((_) async {
      final file = _dayFile(dir, entry.ts);
      var bytes = 0;
      if (await file.exists()) bytes = await file.length();
      // 单日文件超上限后丢弃普通条目，错误与警告必须留住
      if (bytes >= maxDayBytes && !keepOnOverflow) return;
      await file.writeAsString(line, mode: FileMode.append);
      if (isError) {
        await _errFile(dir, entry.ts)
            .writeAsString(line, mode: FileMode.append);
      }
    }).catchError((_) {
      // 写盘失败不能连带拖垮业务链路，日志是旁路
    });

    return _writeChain;
  }

  /// 读取某天的全部条目
  Future<List<LogEntry>> readDay(DateTime day) async {
    final dir = await _resolveDir();
    if (dir == null) return const <LogEntry>[];
    return _readEntries(_dayFile(dir, day));
  }

  /// 读取某天的错误条目
  Future<List<LogEntry>> readErrors(DateTime day) async {
    final dir = await _resolveDir();
    if (dir == null) return const <LogEntry>[];
    return _readEntries(_errFile(dir, day));
  }

  Future<List<LogEntry>> _readEntries(File file) async {
    if (!await file.exists()) return const <LogEntry>[];
    final out = <LogEntry>[];
    try {
      for (final line in await file.readAsLines()) {
        if (line.trim().isEmpty) continue;
        try {
          final decoded = jsonDecode(line);
          if (decoded is Map<String, dynamic>) {
            final entry = LogEntry.fromJson(decoded);
            if (entry != null) out.add(entry);
          }
        } catch (_) {
          // 一行坏数据不该毁掉整天日志，跳过继续
        }
      }
    } catch (_) {
      return out;
    }
    return out;
  }

  /// 按天列出日志（有日志的日期，最新在前）
  Future<List<LogDay>> listDays() async {
    final dir = await _resolveDir();
    if (dir == null) return <LogDay>[];
    if (!await dir.exists()) return <LogDay>[];

    final bytesByKey = <String, int>{};
    final dateByKey = <String, DateTime>{};

    await for (final entity in dir.list()) {
      if (entity is! File) continue;
      final name = p.basename(entity.path);
      if (!name.startsWith(_filePrefix) || !name.endsWith(_fileSuffix)) {
        continue;
      }
      final key = name.substring(
        _filePrefix.length,
        name.length - _fileSuffix.length,
      );
      // 同一天的两个文件（<日期>.jsonl 与 <日期>.err.jsonl）归到同一个 key：
      // 错误投影文件原来在 _parseDayKey 处 continue 掉了，于是它既不计入当天的字节数，
      // 也不会让当天出现在列表里——日志查看器少报了一天的体积与存在。
      final dayKey =
          key.endsWith('.err') ? key.substring(0, key.length - 4) : key;
      final date = _parseDayKey(dayKey);
      if (date == null) continue;
      dateByKey[dayKey] = date;
      bytesByKey[dayKey] = (bytesByKey[dayKey] ?? 0) + await entity.length();
    }

    final days = <LogDay>[];
    for (final key in dateByKey.keys) {
      final date = dateByKey[key]!;
      final errFile = _errFile(dir, date);
      var errorCount = 0;
      if (await errFile.exists()) {
        for (final line in await errFile.readAsLines()) {
          if (line.trim().isNotEmpty) errorCount++;
        }
      }
      days.add(LogDay(
        date: date,
        errorCount: errorCount,
        bytes: bytesByKey[key] ?? 0,
      ));
    }

    days.sort((a, b) => b.date.compareTo(a.date));

    final legacy = await readLegacyText();
    if (legacy != null) {
      days.add(LogDay(
        date: DateTime.now(),
        errorCount: 0,
        bytes: legacy.length,
        legacy: true,
      ));
    }

    return days;
  }

  /// 删除超出保留期的日志文件
  Future<void> prune() async {
    final dir = await _resolveDir();
    if (dir == null) return;
    if (!await dir.exists()) return;
    final now = DateTime.now();
    final cutoff = DateTime(now.year, now.month, now.day)
        .subtract(const Duration(days: retentionDays));

    await for (final entity in dir.list()) {
      if (entity is! File) continue;
      final name = p.basename(entity.path);
      if (!name.startsWith(_filePrefix) || !name.endsWith(_fileSuffix)) {
        continue;
      }
      final key = name.substring(
        _filePrefix.length,
        name.length - _fileSuffix.length,
      );
      // 错误投影文件（khy-os-<日期>.err.jsonl）的 key 尾巴上还挂着 ".err"，
      // _parseDayKey 解析不出日期 → 原来这里直接 continue，于是**错误投影文件永远
      // 不被清理**：「保留 N 天」这条策略对它不生效，文件只增不减。剥掉 .err 再解析。
      final date = _parseDayKey(
        key.endsWith('.err') ? key.substring(0, key.length - 4) : key,
      );
      if (date == null) continue;
      if (date.isBefore(cutoff)) {
        try {
          await entity.delete();
        } catch (_) {
          // 删不掉就留着，下轮再试
        }
      }
    }
  }

  /// 清空某天
  Future<void> clearDay(DateTime day) async {
    final dir = await _resolveDir();
    if (dir == null) return;
    for (final file in <File>[_dayFile(dir, day), _errFile(dir, day)]) {
      try {
        if (await file.exists()) await file.delete();
      } catch (_) {}
    }
  }

  /// 清空全部日志（含旧版文件）
  Future<void> clearAll() async {
    final dir = await _resolveDir();
    if (dir == null) return;
    if (await dir.exists()) {
      await for (final entity in dir.list()) {
        if (entity is! File) continue;
        final name = p.basename(entity.path);
        if (!name.startsWith(_filePrefix) || !name.endsWith(_fileSuffix)) {
          continue;
        }
        try {
          await entity.delete();
        } catch (_) {}
      }
    }
    final legacy = _legacyFile();
    try {
      if (await legacy.exists()) await legacy.delete();
    } catch (_) {}
  }

  /// 全部日志占用字节
  Future<int> totalBytes() async {
    final dir = await _resolveDir();
    if (dir == null) return 0;
    if (!await dir.exists()) return 0;
    var total = 0;
    await for (final entity in dir.list()) {
      if (entity is! File) continue;
      final name = p.basename(entity.path);
      if (!name.startsWith(_filePrefix) || !name.endsWith(_fileSuffix)) {
        continue;
      }
      total += await entity.length();
    }
    return total;
  }

  /// 全部保留期内日志的错误码分布（读错误投影文件，不读全量日志）
  Future<Map<String, int>> errorCodeStats() async {
    final dir = await _resolveDir();
    final stats = <String, int>{};
    if (dir == null) return stats;
    if (!await dir.exists()) return stats;
    await for (final entity in dir.list()) {
      if (entity is! File) continue;
      final name = p.basename(entity.path);
      if (!name.startsWith(_filePrefix) || !name.endsWith(_errSuffix)) {
        continue;
      }
      try {
        for (final line in await entity.readAsLines()) {
          if (line.trim().isEmpty) continue;
          final decoded = jsonDecode(line);
          if (decoded is! Map<String, dynamic>) continue;
          final code = decoded['code'];
          final key = code is String ? code : '未标注';
          stats[key] = (stats[key] ?? 0) + 1;
        }
      } catch (_) {
        // 单个文件读坏不影响其它天的统计
      }
    }
    return stats;
  }

  /// 迁移前的旧版日志文本；不存在返回 null
  Future<String?> readLegacyText() async {
    if (await _resolveDir() == null) return null;
    final file = _legacyFile();
    try {
      if (!await file.exists()) return null;
      final text = await file.readAsString();
      if (text.trim().isEmpty) return null;
      return text;
    } catch (_) {
      return null;
    }
  }

  /// 旧版日志文件（v2 文本格式，迁移前写在文档目录下）
  File _legacyFile() {
    final base = _basePath ?? _dirOverride ?? '';
    return File(p.join(base, _legacyName));
  }

  static DateTime? _parseDayKey(String key) {
    final parts = key.split('-');
    if (parts.length != 3) return null;
    final y = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    final d = int.tryParse(parts[2]);
    if (y == null || m == null || d == null) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return DateTime(y, m, d);
  }
}

/// 生成「给智能体 / 维护者」的分析包文本（纯函数，不碰 IO）
///
/// 判据：拿到这段文本的人，不需要再问任何问题就能开始定位问题——
/// 有什么、哪一天、多少条、哪些错误码、错在哪、上下文是什么。
///
/// 堆栈与绝对路径**在包内是判据的一部分，不是疏漏**：「错在哪」正是靠堆栈
/// 里的帧位置回答的，剥掉它这个包就只剩统计数字，收到的人还得再要一次日志。
/// 2026-10-25 裁决维持现状（见 works/record/evidence/01_人类贡献/决策记录.md
/// D-批3 第 4 条 (b)）。真要外传，先自己看一眼这个包的内容。
String buildAnalysisBundle({
  required DateTime generatedAt,
  required String appVersion,
  required String platform,
  required String device,
  required List<DateTime> days,
  required Map<DateTime, List<LogEntry>> entriesByDay,
  required Map<DateTime, List<LogEntry>> errorsByDay,
  int retentionDays = LogStore.retentionDays,
}) {
  final buffer = StringBuffer();

  final allErrors = <LogEntry>[];
  var totalEntries = 0;
  for (final day in days) {
    totalEntries += entriesByDay[day]?.length ?? 0;
    allErrors.addAll(errorsByDay[day] ?? const <LogEntry>[]);
  }
  allErrors.sort((a, b) => b.ts.compareTo(a.ts));

  final codeStats = <String, int>{};
  for (final e in allErrors) {
    final code = e.code ?? '未标注';
    codeStats[code] = (codeStats[code] ?? 0) + 1;
  }

  buffer.writeln('# khy-os 手机端日志分析包');
  buffer.writeln('');
  buffer.writeln('生成时间: ${formatLogTime(generatedAt)}');
  buffer.writeln('应用版本: $appVersion');
  buffer.writeln('运行平台: $platform');
  buffer.writeln('设备: $device');
  buffer.writeln(
    '日志范围: ${days.isEmpty ? '无' : days.map(logDayKey).join(' ~ ')}'
    '（保留 $retentionDays 天）',
  );
  buffer.writeln('条目总数: $totalEntries · 错误总数: ${allErrors.length}');
  buffer.writeln('');

  buffer.writeln('## 错误总览');
  buffer.writeln('');
  if (codeStats.isEmpty) {
    buffer.writeln('本范围内没有错误条目。');
  } else {
    buffer.writeln('| 错误码 | 条数 | 含义 |');
    buffer.writeln('|---|---|---|');
    final sorted = codeStats.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    for (final e in sorted) {
      buffer.writeln(
        '| ${e.key} | ${e.value} | ${ErrorCode.describe(e.key)} |',
      );
    }
  }
  buffer.writeln('');

  buffer.writeln('## 错误明细');
  buffer.writeln('');
  if (allErrors.isEmpty) {
    buffer.writeln('无。');
  } else {
    var index = 0;
    for (final day in days) {
      final errors = (errorsByDay[day] ?? const <LogEntry>[])
        ..sort((a, b) => b.ts.compareTo(a.ts));
      for (final e in errors) {
        index++;
        buffer.writeln(
          '### $index. [${e.code ?? '无码'}][${logLevelLabel(e.level)}] '
          '${e.message}',
        );
        buffer.writeln('- 时间: ${formatLogTime(e.ts)}');
        buffer.writeln('- 分类: ${logCategoryLabel(e.category)}');
        if (e.screen != null) buffer.writeln('- 界面: ${e.screen}');
        if (e.context.isNotEmpty) {
          buffer.writeln(
            '- 上下文: ${e.context.entries.map((c) => '${c.key}=${c.value}').join(' · ')}',
          );
        }
        if (e.error != null) buffer.writeln('- 错误: ${e.error}');
        if (e.stack != null) {
          buffer.writeln('- 堆栈:');
          for (final line in e.stack!.split('\n')) {
            if (line.trim().isNotEmpty) buffer.writeln('  ${line.trim()}');
          }
        }
        buffer.writeln('');
      }
    }
  }

  buffer.writeln('## 每日日志');
  buffer.writeln('');
  if (days.isEmpty) {
    buffer.writeln('无。');
  } else {
    for (final day in days) {
      final entries = entriesByDay[day] ?? const <LogEntry>[];
      final errors = errorsByDay[day] ?? const <LogEntry>[];
      buffer.writeln(
        '### ${logDayKey(day)}（错误 ${errors.length} / 共 ${entries.length} 条）',
      );
      for (final e in entries) {
        buffer.writeln(e.toLine());
      }
      buffer.writeln('');
    }
  }

  return buffer.toString();
}
