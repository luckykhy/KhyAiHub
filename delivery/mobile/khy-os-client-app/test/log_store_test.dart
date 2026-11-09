import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/log_store.dart';

void main() {
  group('LogEntry', () {
    test('json 往返保留全部字段', () {
      final entry = LogEntry(
        ts: DateTime(2026, 10, 23, 14, 22, 31, 123),
        seq: 7,
        level: LogLevel.error,
        category: LogCategory.network,
        message: '连接失败',
        code: ErrorCode.connection,
        context: const {'host': 'example', 'port': 3000},
        error: 'DioException',
        stack: '#0 frame',
        screen: 'AI',
      );

      final decoded = LogEntry.fromJson(
          jsonDecode(jsonEncode(entry.toJson())) as Map<String, dynamic>);

      expect(decoded, isNotNull);
      expect(decoded!.ts, entry.ts);
      expect(decoded.seq, 7);
      expect(decoded.level, LogLevel.error);
      expect(decoded.category, LogCategory.network);
      expect(decoded.message, '连接失败');
      expect(decoded.code, ErrorCode.connection);
      expect(decoded.context['host'], 'example');
      expect(decoded.error, 'DioException');
      expect(decoded.stack, '#0 frame');
      expect(decoded.screen, 'AI');
    });

    test('error 与 fatal 算错误，warn 不算', () {
      LogEntry at(LogLevel l) => LogEntry(
            ts: DateTime(2026, 10, 23),
            level: l,
            category: LogCategory.system,
            message: 'x',
          );
      expect(at(LogLevel.error).isError, isTrue);
      expect(at(LogLevel.fatal).isError, isTrue);
      expect(at(LogLevel.warn).isError, isFalse);
      expect(at(LogLevel.info).isError, isFalse);
    });

    test('一行摘要含时间、级别、分类、错误码', () {
      final line = LogEntry(
        ts: DateTime(2026, 10, 23, 9, 5, 1),
        level: LogLevel.fatal,
        category: LogCategory.system,
        message: '崩了',
        code: ErrorCode.crash,
      ).toLine();

      expect(line, contains('2026-10-23 09:05:01.000'));
      expect(line, contains('[FTL]'));
      expect(line, contains('[SYS]'));
      expect(line, contains('E601'));
      expect(line, contains('崩了'));
    });
  });

  group('错误码', () {
    test('HTTP 状态码映射', () {
      expect(ErrorCode.forHttpStatus(404), ErrorCode.http4xx);
      expect(ErrorCode.forHttpStatus(500), ErrorCode.http5xx);
      expect(ErrorCode.forHttpStatus(200), ErrorCode.unknown);
    });

    test('每个登记错误码都有中文含义', () {
      final codes = [
        ErrorCode.dns,
        ErrorCode.connection,
        ErrorCode.timeout,
        ErrorCode.http4xx,
        ErrorCode.http5xx,
        ErrorCode.auth,
        ErrorCode.param,
        ErrorCode.model,
        ErrorCode.rateLimit,
        ErrorCode.toolExec,
        ErrorCode.accessibility,
        ErrorCode.screenCapture,
        ErrorCode.shell,
        ErrorCode.permission,
        ErrorCode.configMissing,
        ErrorCode.storage,
        ErrorCode.unknown,
        ErrorCode.crash,
        ErrorCode.session,
        ErrorCode.capability,
        ErrorCode.localStore,
      ];
      for (final code in codes) {
        expect(ErrorCode.describe(code), isNot('未登记错误码'), reason: code);
      }
    });
  });

  group('LogStore', () {
    late Directory tempDir;
    late LogStore store;

    setUp(() async {
      tempDir = Directory.systemTemp.createTempSync('khy-log-store');
      store = LogStore(directoryPath: tempDir.path);
      await store.init();
    });

    tearDown(() {
      if (tempDir.existsSync()) tempDir.deleteSync(recursive: true);
    });

    test('写入后能按天读回，错误进错误投影文件', () async {
      final day = DateTime(2026, 10, 23, 10, 0);
      await store.append(LogEntry(
        ts: day,
        level: LogLevel.info,
        category: LogCategory.network,
        message: '正常请求',
      ));
      await store.append(LogEntry(
        ts: day,
        level: LogLevel.error,
        category: LogCategory.network,
        message: '连接失败',
        code: ErrorCode.connection,
      ));

      final entries = await store.readDay(day);
      final errors = await store.readErrors(day);

      expect(entries.length, 2);
      expect(errors.length, 1);
      expect(errors.first.code, ErrorCode.connection);
    });

    test('按天列表给出错误条数，最新在前', () async {
      await store.append(LogEntry(
        ts: DateTime(2026, 10, 21, 10),
        level: LogLevel.info,
        category: LogCategory.system,
        message: '旧的一天',
      ));
      await store.append(LogEntry(
        ts: DateTime(2026, 10, 22, 10),
        level: LogLevel.error,
        category: LogCategory.system,
        message: '新的一天出错了',
        code: ErrorCode.crash,
      ));

      final days = await store.listDays();

      expect(days.length, 2);
      expect(days.first.date, DateTime(2026, 10, 22));
      expect(days.first.errorCount, 1);
      expect(days.last.errorCount, 0);
    });

    test('错误码分布跨文件聚合', () async {
      await store.append(LogEntry(
        ts: DateTime(2026, 10, 22, 10),
        level: LogLevel.error,
        category: LogCategory.api,
        message: 'a',
        code: ErrorCode.auth,
      ));
      await store.append(LogEntry(
        ts: DateTime(2026, 10, 23, 10),
        level: LogLevel.fatal,
        category: LogCategory.api,
        message: 'b',
        code: ErrorCode.auth,
      ));

      final stats = await store.errorCodeStats();
      expect(stats[ErrorCode.auth], 2);
    });

    test('清空某天只影响那天', () async {
      await store.append(LogEntry(
        ts: DateTime(2026, 10, 22, 10),
        level: LogLevel.info,
        category: LogCategory.system,
        message: 'a',
      ));
      await store.append(LogEntry(
        ts: DateTime(2026, 10, 23, 10),
        level: LogLevel.info,
        category: LogCategory.system,
        message: 'b',
      ));

      await store.clearDay(DateTime(2026, 10, 22));

      expect(await store.readDay(DateTime(2026, 10, 22)), isEmpty);
      expect(await store.readDay(DateTime(2026, 10, 23)), hasLength(1));
    });

    test('超出保留期的日志文件被清掉', () async {
      final logsDir = Directory('${tempDir.path}/logs');
      final stale = File('${logsDir.path}/khy-os-2020-01-01.jsonl');
      stale.writeAsStringSync('{}\n');
      final fresh = File('${logsDir.path}/khy-os-2999-01-01.jsonl');
      fresh.writeAsStringSync('{}\n');

      await store.prune();

      expect(stale.existsSync(), isFalse);
      expect(fresh.existsSync(), isTrue);
    });
  });

  group('分析包', () {
    test('包含环境、错误总览、错误明细与当日日志', () {
      final day = DateTime(2026, 10, 23);
      final error = LogEntry(
        ts: DateTime(2026, 10, 23, 14, 0),
        level: LogLevel.error,
        category: LogCategory.network,
        message: '连接失败',
        code: ErrorCode.connection,
        context: const {'host': 'example'},
        error: 'DioException',
        stack: '#0 frame',
      );
      final info = LogEntry(
        ts: DateTime(2026, 10, 23, 13, 0),
        level: LogLevel.info,
        category: LogCategory.network,
        message: '正常请求',
      );

      final bundle = buildAnalysisBundle(
        generatedAt: DateTime(2026, 10, 23, 15, 0),
        appVersion: '1.1.17+2',
        platform: 'Android 14',
        device: 'linux 5.15',
        days: [day],
        entriesByDay: {
          day: [info, error],
        },
        errorsByDay: {
          day: [error],
        },
      );

      expect(bundle, contains('应用版本: 1.1.17+2'));
      expect(bundle, contains('运行平台: Android 14'));
      expect(bundle, contains('错误总数: 1'));
      expect(bundle, contains('| E102 | 1 | 连接失败 |'));
      expect(bundle, contains('### 1. [E102][ERR] 连接失败'));
      expect(bundle, contains('DioException'));
      expect(bundle, contains('正常请求'));
    });

    test('没有错误时如实说明没有错误', () {
      final bundle = buildAnalysisBundle(
        generatedAt: DateTime(2026, 10, 23),
        appVersion: '1.0.0',
        platform: 'Android',
        device: 'linux',
        days: const [],
        entriesByDay: const {},
        errorsByDay: const {},
      );

      expect(bundle, contains('本范围内没有错误条目'));
    });
  });
}
