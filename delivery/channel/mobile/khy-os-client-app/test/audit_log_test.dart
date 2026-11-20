import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/audit_log.dart';

/// 操作审计日志的行为。
///
/// 背景（§9.25）：这一版 App 的承诺是「AI 是助手不是主角」，而这句话要能被
/// **核查**才作数——每条操作都得带来源标记，用户能看出哪些不是自己点的。
/// 审计模块这一轮从 `core/vfs` 下沉到 `core/services`，因为设备命令和文件写
/// 操作要写**同一份**日志，写入点必须落在两侧的公共下游。
///
/// 这里钉的是审计本身的三件事：真的落盘、来源标记不丢、读回来不重复。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tmp;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('khy_audit_test');
    AuditLog.useDirectoryForTest(tmp);
  });

  tearDown(() {
    AuditLog.useDirectoryForTest(null);
    try {
      tmp.deleteSync(recursive: true);
    } catch (_) {}
  });

  test('记一条就真落盘一行 JSON', () async {
    await AuditLog.instance.record(
      AuditSource.ai,
      'shell',
      '',
      detail: 'ls -la /storage',
    );

    final file = File('${tmp.path}${Platform.pathSeparator}audit.jsonl');
    expect(file.existsSync(), isTrue, reason: '审计必须真的写到磁盘，不能只在内存里');

    final lines = file
        .readAsLinesSync()
        .where((String line) => line.trim().isNotEmpty)
        .toList();
    expect(lines.length, 1);

    final decoded = jsonDecode(lines.first) as Map<String, dynamic>;
    expect(decoded['source'], 'ai');
    expect(decoded['operation'], 'shell');
    expect(decoded['detail'], 'ls -la /storage');
    expect(decoded['ok'], isTrue);
  });

  test('先记后读不会把同一条算两遍', () async {
    // 回归点：回灌缓存时若只追加，文件里已有的三条会在内存里再叠一遍。
    // 真实顺序是「先操作、后打开日志」，那正是会翻车的顺序。
    for (var i = 0; i < 3; i++) {
      await AuditLog.instance.record(
        AuditSource.user,
        'copy',
        '/a/$i',
        detail: '/b/$i',
      );
    }
    final recent = await AuditLog.instance.recent();
    expect(recent.length, 3, reason: '三条操作就该是三条记录，不该重复');
  });

  test('读回来的顺序是新的在前', () async {
    await AuditLog.instance.record(AuditSource.user, 'copy', '/first');
    await AuditLog.instance.record(AuditSource.user, 'copy', '/second');
    final recent = await AuditLog.instance.recent();
    expect(recent.first.path, '/second');
    expect(recent.last.path, '/first');
  });

  test('来源标记能原样往返', () {
    final entry = AuditEntry(
      time: DateTime.fromMillisecondsSinceEpoch(1700000000000),
      source: AuditSource.script,
      operation: 'delete',
      path: '/x',
      ok: false,
    );
    final restored = AuditEntry.fromJson(entry.toJson());
    expect(restored.source, AuditSource.script);
    expect(restored.ok, isFalse);
    expect(restored.path, '/x');
  });

  test('未知来源按「用户手动」兜底', () {
    expect(AuditSource.parse('nonsense'), AuditSource.user);
    expect(AuditSource.parse(null), AuditSource.user);
  });

  test('设备级操作没有路径，文件级操作有', () {
    final shell = AuditEntry(
      time: DateTime.fromMillisecondsSinceEpoch(0),
      source: AuditSource.ai,
      operation: 'shell',
      path: '',
    );
    final copy = AuditEntry(
      time: DateTime.fromMillisecondsSinceEpoch(0),
      source: AuditSource.user,
      operation: 'copy',
      path: '/a',
    );
    expect(shell.hasPath, isFalse);
    expect(copy.hasPath, isTrue);
  });

  test('监听者收到每一条记录', () async {
    final seen = <AuditEntry>[];
    void listener(AuditEntry entry) => seen.add(entry);
    AuditLog.instance.addListener(listener);
    await AuditLog.instance.record(AuditSource.system, 'mkdir', '/z');
    AuditLog.instance.removeListener(listener);
    expect(seen.length, 1);
    expect(seen.first.source, AuditSource.system);
  });

  test('监听者自己抛异常不影响记录本身', () async {
    AuditLog.instance.addListener((_) => throw StateError('录制器挂了'));
    await AuditLog.instance.record(AuditSource.user, 'copy', '/a');
    final recent = await AuditLog.instance.recent();
    expect(recent.length, 1);
  });

  test('读失败后下一次会重试，不会把「读不到」演成「没发生过」', () async {
    // 构造一次瞬时失败：把 override 目录指到一个**文件**上，
    // 于是 _resolveFile 里 dir.create(recursive: true) 抛异常。
    final blocker = File('${tmp.path}/blocker');
    blocker.writeAsStringSync('i am a file, not a directory');
    AuditLog.useDirectoryForTest(Directory('${tmp.path}/blocker'));

    // 第一次读：内部抛异常被吞，返回空。
    final first = await AuditLog.instance.recent();
    expect(first, isEmpty);

    // 就地恢复：把占位文件删掉，建成真目录，并写一份含一条记录的审计文件。
    blocker.deleteSync();
    Directory('${tmp.path}/blocker').createSync(recursive: true);
    File('${tmp.path}/blocker/audit.jsonl').writeAsStringSync(
      '${jsonEncode(AuditEntry(
        time: DateTime.fromMillisecondsSinceEpoch(1700000000000),
        source: AuditSource.user,
        operation: 'copy',
        path: '/recovered',
      ).toJson())}\n',
    );

    // 第二次读：必须重试并读到那一条。
    // 修复前 _loaded 在 try 之前就置 true，这一次会直接返回空——
    // 于是一次瞬时失败让整个进程生命周期内审计日志永远空白，
    // 而界面显示的是「没有操作记录」。
    final second = await AuditLog.instance.recent();
    expect(
      second.length,
      1,
      reason: '读失败不该被当成「已加载」——否则审计日志会永久空白',
    );
    expect(second.single.path, '/recovered');
  });
}
