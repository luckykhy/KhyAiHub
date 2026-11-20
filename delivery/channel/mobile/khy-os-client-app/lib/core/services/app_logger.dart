import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'log_store.dart';

export 'log_store.dart'
    show
        ErrorCode,
        LogCategory,
        LogDay,
        LogEntry,
        LogLevel,
        LogStore,
        buildAnalysisBundle,
        formatLogTime,
        logCategoryLabel,
        logDayKey,
        logLevelLabel;

/// 应用版本（Flutter 编译期注入）
const String kAppVersion = String.fromEnvironment(
  'FLUTTER_BUILD_NAME',
  defaultValue: 'unknown',
);

/// 构建号（Flutter 编译期注入）
const String kAppBuild = String.fromEnvironment(
  'FLUTTER_BUILD_NUMBER',
  defaultValue: 'unknown',
);

/// Delivery canary stamp injected by --dart-define=KHY_CANARY=... at build
/// time; empty for plain `flutter run`. Const keeps the value in the AOT
/// constant pool, so it stays in the shipped snapshot even when nothing logs
/// it.
const String kKhyCanary = String.fromEnvironment('KHY_CANARY');

/// ───────────────────────────────────────────────
/// khy-os 手机端日志服务 v3
///
/// 规范真源：docs/10_规范/其它规范/[DESIGN-LOG-002] 手机端日志规范.md
///
/// v3 相对 v2 的三处变化：
///   1. 按天分文件（原来单文件无限增长），保留 14 天；
///   2. 错误双写主文件与错误投影文件，跨天可检索；
///   3. 未捕获异常（FlutterError / 异步错误 / Zone 错误）必须落盘。
/// ───────────────────────────────────────────────

/// 结构化日志服务（单例）
class AppLogger {
  static final AppLogger _instance = AppLogger._internal();
  factory AppLogger() => _instance;
  AppLogger._internal();

  final LogStore _store = LogStore();

  /// 当前界面（写进每条日志，便于定位问题发生在哪个界面）
  String? _screen;

  /// 会话内序号
  int _seq = 0;

  // 错误去重：code + message 的组合，10 秒内不重复记录
  final Map<String, DateTime> _errorDedup = {};
  static const Duration _dedupWindow = Duration(seconds: 10);

  // 错误记录（内存中保留最近 100 条；跨天查询走磁盘上的错误投影文件）
  final List<LogEntry> _recentErrors = [];
  static const int _maxErrorRecords = 100;

  /// 初始化：建目录、清过期文件、写下会话起点
  Future<void> init() async {
    await _store.init();
    await _write(
      LogLevel.info,
      LogCategory.system,
      'khy-os 日志会话开始',
      details: <String, dynamic>{
        'platform':
            '${Platform.operatingSystem} ${Platform.operatingSystemVersion}',
        'version': kAppVersion,
        'build': kAppBuild,
        'canary': kKhyCanary,
        'spec': 'v3',
      },
    );
  }

  /// 记录当前所在界面
  void setScreen(String? screen) {
    _screen = screen;
  }

  // ─────────────────────────────────────────────
  // 核心写入
  // ─────────────────────────────────────────────

  Future<void> _write(
    LogLevel level,
    LogCategory category,
    String message, {
    Map<String, dynamic>? details,
    Object? error,
    StackTrace? stackTrace,
    String? code,
  }) async {
    if (level == LogLevel.debug && kReleaseMode) return;
    final entry = LogEntry(
      ts: DateTime.now(),
      seq: ++_seq,
      level: level,
      category: category,
      message: message,
      code: code,
      context: details ?? const <String, dynamic>{},
      error: error?.toString(),
      stack: stackTrace?.toString(),
      screen: _screen,
    );
    await _store.append(entry);
  }

  /// 通用日志
  void log(
    LogLevel level,
    LogCategory category,
    String message, {
    Map<String, dynamic>? details,
    Object? error,
    StackTrace? stackTrace,
    String? code,
  }) {
    unawaited(_write(
      level,
      category,
      message,
      details: details,
      error: error,
      stackTrace: stackTrace,
      code: code,
    ));
  }

  // ── 快捷方法 ──

  void d(LogCategory cat, String msg, {Map<String, dynamic>? details}) =>
      log(LogLevel.debug, cat, msg, details: details);

  /// 日志目录的绝对路径。
  ///
  /// 为什么要暴露它：用户说"日志在哪"是高频问题，而答案此前只能靠翻
  /// LogStore 源码。位置面板（长按会话项）直接把它显示出来，省掉这一步。
  ///
  /// 读不到时返回空串而不是抛：这个方法的调用方是 UI，一次取址失败不该
  /// 把整个面板打穿。
  Future<String> logDirectoryPath() async {
    try {
      return await _store.logDirectoryPath();
    } catch (_) {
      return '';
    }
  }

  void i(LogCategory cat, String msg, {Map<String, dynamic>? details}) =>
      log(LogLevel.info, cat, msg, details: details);

  void w(LogCategory cat, String msg,
          {Map<String, dynamic>? details,
          Object? error,
          StackTrace? stackTrace,
          String? code}) =>
      log(LogLevel.warn, cat, msg,
          details: details,
          error: error,
          stackTrace: stackTrace,
          code: code);

  /// 记一条错误。[severity] 决定最终级别（error / fatal），默认 error
  void e(LogCategory cat, String msg,
          {Map<String, dynamic>? details,
          Object? error,
          StackTrace? stackTrace,
          String? code,
          LogLevel severity = LogLevel.error}) {
    final level = switch (severity) {
      LogLevel.fatal => LogLevel.fatal,
      LogLevel.warn => LogLevel.warn,
      _ => LogLevel.error,
    };
    log(level, cat, msg,
        details: details,
        error: error,
        stackTrace: stackTrace,
        code: code);
  }

  void f(LogCategory cat, String msg,
          {Map<String, dynamic>? details,
          Object? error,
          StackTrace? stackTrace,
          String? code}) =>
      log(LogLevel.fatal, cat, msg,
          details: details,
          error: error,
          stackTrace: stackTrace,
          code: code);

  // ─────────────────────────────────────────────
  // 错误记录（去重 + 自动堆栈 + 上下文）
  // ─────────────────────────────────────────────

  /// 记录一个结构化错误（带去重、自动堆栈）
  ///
  /// [code]    错误码，如 ErrorCode.dns
  /// [message] 人类可读描述
  /// [category] 日志分类
  /// [context]  上下文（界面、模式、操作等）
  /// [exception] 原始异常对象
  /// [stack]   堆栈（null 则自动捕获）
  void recordError({
    required String code,
    required String message,
    required LogCategory category,
    Map<String, dynamic>? context,
    Object? exception,
    StackTrace? stack,
    LogLevel severity = LogLevel.error,
  }) {
    // 去重检查
    final dedupKey = '$code|$message';
    final now = DateTime.now();
    final lastTime = _errorDedup[dedupKey];
    if (lastTime != null && now.difference(lastTime) < _dedupWindow) {
      return; // 10 秒内同 code+message 不重复记录
    }
    _errorDedup[dedupKey] = now;

    // 自动捕获堆栈
    final autoStack = stack ?? StackTrace.current;

    final record = LogEntry(
      ts: now,
      seq: ++_seq,
      level: switch (severity) {
        LogLevel.fatal => LogLevel.fatal,
        LogLevel.warn => LogLevel.warn,
        _ => LogLevel.error,
      },
      category: category,
      message: message,
      code: code,
      context: context ?? const <String, dynamic>{},
      error: exception?.toString(),
      stack: autoStack.toString(),
      screen: _screen,
    );

    _recentErrors.add(record);
    if (_recentErrors.length > _maxErrorRecords) {
      _recentErrors.removeRange(0, _recentErrors.length - _maxErrorRecords);
    }

    unawaited(_store.append(record));
  }

  /// 便捷：网络错误
  void networkError({
    required String code,
    required String message,
    Map<String, dynamic>? context,
    Object? exception,
    LogLevel severity = LogLevel.error,
  }) =>
      recordError(
        code: code,
        message: message,
        category: LogCategory.network,
        context: context,
        exception: exception,
        severity: severity,
      );

  /// 便捷：API 错误
  void apiError({
    required String code,
    required String message,
    Map<String, dynamic>? context,
    Object? exception,
    LogLevel severity = LogLevel.error,
  }) =>
      recordError(
        code: code,
        message: message,
        category: LogCategory.api,
        context: context,
        exception: exception,
        severity: severity,
      );

  /// 便捷：工具错误
  void toolError({
    required String code,
    required String message,
    Map<String, dynamic>? context,
    Object? exception,
    LogLevel severity = LogLevel.error,
  }) =>
      recordError(
        code: code,
        message: message,
        category: LogCategory.tool,
        context: context,
        exception: exception,
        severity: severity,
      );

  /// 便捷：设备错误
  void deviceError({
    required String code,
    required String message,
    Map<String, dynamic>? context,
    Object? exception,
    LogLevel severity = LogLevel.error,
  }) =>
      recordError(
        code: code,
        message: message,
        category: LogCategory.device,
        context: context,
        exception: exception,
        severity: severity,
      );

  /// 便捷：系统错误
  void systemError({
    required String code,
    required String message,
    Map<String, dynamic>? context,
    Object? exception,
    LogLevel severity = LogLevel.error,
  }) =>
      recordError(
        code: code,
        message: message,
        category: LogCategory.system,
        context: context,
        exception: exception,
        severity: severity,
      );

  // ─────────────────────────────────────────────
  // 专用日志方法
  // ─────────────────────────────────────────────

  /// 网络请求
  void network({
    required String method,
    required String url,
    int? statusCode,
    int? durationMs,
    String? error,
    Map<String, dynamic>? extra,
  }) {
    final details = <String, dynamic>{
      'method': method,
      'url': url,
    };
    if (statusCode != null) details['status'] = statusCode;
    if (durationMs != null) details['duration'] = '${durationMs}ms';
    if (extra != null) details.addAll(extra);

    if (error != null) {
      final code = statusCode != null
          ? ErrorCode.forHttpStatus(statusCode)
          : ErrorCode.connection;
      recordError(
        code: code,
        message: '$method $url 失败 (HTTP ${statusCode ?? "?"})',
        category: LogCategory.network,
        context: details,
        exception: error,
      );
    } else {
      i(LogCategory.network, '$method $url', details: details);
    }
  }

  /// DNS 解析
  void dns({
    required String hostname,
    required bool success,
    List<String>? ips,
    String? error,
    String? dohServer,
    int? durationMs,
  }) {
    final details = <String, dynamic>{
      'hostname': hostname,
      'success': success,
    };
    if (ips != null) details['ips'] = ips.join(', ');
    if (dohServer != null) details['doh_server'] = dohServer;
    if (durationMs != null) details['duration'] = '${durationMs}ms';

    if (success) {
      i(LogCategory.dns, 'DNS 解析: $hostname', details: details);
    } else {
      recordError(
        code: ErrorCode.dns,
        message: 'DNS 解析失败: $hostname',
        category: LogCategory.dns,
        context: details,
        exception: error,
      );
    }
  }

  /// API 调用
  void api({
    required String provider,
    required String model,
    required String action,
    bool success = true,
    int? tokensIn,
    int? tokensOut,
    int? durationMs,
    String? error,
    int? statusCode,
  }) {
    final details = <String, dynamic>{
      'provider': provider,
      'model': model,
      'action': action,
    };
    if (tokensIn != null) details['tokens_in'] = tokensIn;
    if (tokensOut != null) details['tokens_out'] = tokensOut;
    if (durationMs != null) details['duration'] = '${durationMs}ms';
    if (statusCode != null) details['status'] = statusCode;

    if (success) {
      i(LogCategory.api, '$provider/$model $action', details: details);
    } else {
      final code = statusCode != null
          ? ErrorCode.forHttpStatus(statusCode)
          : ErrorCode.http4xx;
      recordError(
        code: code,
        message: '$provider/$model $action 失败',
        category: LogCategory.api,
        context: details,
        exception: error,
      );
    }
  }

  // ─────────────────────────────────────────────
  // 查询与导出
  // ─────────────────────────────────────────────

  /// 当天日志文件路径
  Future<String> get logFilePath async => _store.currentFilePath();

  /// 按天列出日志（有日志的日期，最新在前）
  Future<List<LogDay>> listDays() => _store.listDays();

  /// 读某天的全部条目
  Future<List<LogEntry>> readDay(DateTime day) => _store.readDay(day);

  /// 读某天的错误条目
  Future<List<LogEntry>> readDayErrors(DateTime day) => _store.readErrors(day);

  /// 读当天日志文本
  Future<String> readLogs() async {
    final entries = await _store.readDay(DateTime.now());
    if (entries.isEmpty) return '暂无日志';
    return entries.map((e) => e.toLine()).join('\n');
  }

  /// 读最近若干条日志
  Future<String> readRecentLogs([int lines = 100]) async {
    final entries = await _store.readDay(DateTime.now());
    if (entries.isEmpty) return '暂无日志';
    final start = entries.length > lines ? entries.length - lines : 0;
    return entries.sublist(start).map((e) => e.toLine()).join('\n');
  }

  /// 导出分析包（给智能体 / 维护者看的自足文本）
  Future<String> exportLogs({int days = 1}) async {
    final all = await _store.listDays();
    final picked = all.where((d) => !d.legacy).take(days).toList();
    final entriesByDay = <DateTime, List<LogEntry>>{};
    final errorsByDay = <DateTime, List<LogEntry>>{};
    for (final day in picked) {
      entriesByDay[day.date] = await _store.readDay(day.date);
      errorsByDay[day.date] = await _store.readErrors(day.date);
    }
    return _bundle(
      picked.map((d) => d.date).toList(),
      entriesByDay,
      errorsByDay,
    );
  }

  /// 导出某一天的分析包（详情页「复制分析包」用）
  Future<String> exportDay(DateTime day) async {
    final entries = await _store.readDay(day);
    final errors = await _store.readErrors(day);
    return _bundle(
      [day],
      {day: entries},
      {day: errors},
    );
  }

  String _bundle(
    List<DateTime> days,
    Map<DateTime, List<LogEntry>> entriesByDay,
    Map<DateTime, List<LogEntry>> errorsByDay,
  ) {
    return buildAnalysisBundle(
      generatedAt: DateTime.now(),
      appVersion: '$kAppVersion+$kAppBuild',
      platform:
          '${Platform.operatingSystem} ${Platform.operatingSystemVersion}',
      device: Platform.version,
      days: days,
      entriesByDay: entriesByDay,
      errorsByDay: errorsByDay,
    );
  }

  /// 清空全部日志
  Future<void> clearLogs() async {
    await _store.clearAll();
    _recentErrors.clear();
    _errorDedup.clear();
  }

  /// 清空某天
  Future<void> clearDay(DateTime day) async {
    await _store.clearDay(day);
  }

  /// 全部日志占用
  Future<String> getLogSize() async {
    final bytes = await _store.totalBytes();
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) {
      return '${(bytes / 1024).toStringAsFixed(1)} KB';
    }
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  /// 获取最近的错误记录
  List<LogEntry> get recentErrors => List.unmodifiable(_recentErrors);

  /// 全部保留期内日志的错误码分布（按天可查，跨重启不丢）
  Future<Map<String, int>> errorCodeStats() => _store.errorCodeStats();

  /// 迁移前的旧版日志文本
  Future<String?> readLegacyText() => _store.readLegacyText();

  /// 本次会话内最近错误的错误码分布
  Map<String, int> get recentErrorCodeStats {
    final stats = <String, int>{};
    for (final e in _recentErrors) {
      final code = e.code ?? '未标注';
      stats[code] = (stats[code] ?? 0) + 1;
    }
    return stats;
  }

  /// 获取错误统计（兼容旧接口）
  Future<Map<String, int>> getErrorStats() async {
    return recentErrorCodeStats;
  }
}

/// 兼容旧接口
typedef ApiConfig = AppLogger;
