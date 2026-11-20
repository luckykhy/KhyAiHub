// 文件操作审计日志。
//
// 为什么要有它：这一版 App 的核心承诺是「AI 是助手不是主角」。这句话要能被**核查**，
// 而不是靠嘴说。操作日志给每一条写操作打上来源标记（用户手动 / AI 建议 / 脚本执行），
// 用户能一眼看出哪些操作不是自己点的。
//
// 没有它，「AI 只是辅助」就只是一句宣传语。
//
// 落盘位置用 path_provider 解析应用支持目录，不写 cwd 相对路径——cwd 是调用方的
// 偶然状态，拿它当数据家的锚点，会让同一份代码在不同目录下写成不同结果。

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// 操作来源。
enum VfsSource {
  /// 用户手动操作。
  user,

  /// AI 建议（经用户确认后执行）。
  ai,

  /// 脚本执行（自动化录制产物）。
  script,

  /// 系统自身（定时任务、恢复流程等）。
  system;

  static VfsSource parse(String? raw) {
    for (final source in VfsSource.values) {
      if (source.name == raw) return source;
    }
    return VfsSource.user;
  }

  String get label {
    switch (this) {
      case VfsSource.user:
        return '用户手动';
      case VfsSource.ai:
        return 'AI 建议';
      case VfsSource.script:
        return '脚本执行';
      case VfsSource.system:
        return '系统';
    }
  }
}

/// 一条审计记录。
class VfsAuditEntry {
  final DateTime time;
  final VfsSource source;
  final String operation;
  final String path;
  final String detail;
  final bool ok;

  const VfsAuditEntry({
    required this.time,
    required this.source,
    required this.operation,
    required this.path,
    this.detail = '',
    this.ok = true,
  });

  Map<String, dynamic> toJson() => <String, dynamic>{
        'time': time.millisecondsSinceEpoch,
        'source': source.name,
        'operation': operation,
        'path': path,
        'detail': detail,
        'ok': ok,
      };

  factory VfsAuditEntry.fromJson(Map<String, dynamic> json) => VfsAuditEntry(
        time: DateTime.fromMillisecondsSinceEpoch(
          (json['time'] as num?)?.toInt() ?? 0,
        ),
        source: VfsSource.parse(json['source'] as String?),
        operation: (json['operation'] ?? '').toString(),
        path: (json['path'] ?? '').toString(),
        detail: (json['detail'] ?? '').toString(),
        ok: json['ok'] != false,
      );
}

/// 审计日志。
class VfsAuditLog {
  VfsAuditLog._();

  static final VfsAuditLog instance = VfsAuditLog._();

  /// 最多保留多少条。超了从头截断——审计要的是「最近发生了什么」，
  /// 不是无限增长的本机账本。
  static const int maxEntries = 500;

  File? _file;
  final List<VfsAuditEntry> _cache = <VfsAuditEntry>[];
  bool _loaded = false;

  /// 监听者。操作录制器靠它把「用户刚做的操作」收集成自动化脚本。
  final List<void Function(VfsAuditEntry entry)> _listeners =
      <void Function(VfsAuditEntry entry)>[];

  /// 注册监听者。
  void addListener(void Function(VfsAuditEntry entry) listener) {
    _listeners.add(listener);
  }

  /// 注销监听者。
  void removeListener(void Function(VfsAuditEntry entry) listener) {
    _listeners.remove(listener);
  }

  /// 记录一条操作。写盘失败不抛：审计写不进去不该阻断用户正在做的事。
  Future<void> record(
    VfsSource source,
    String operation,
    String path, {
    String detail = '',
    bool ok = true,
  }) async {
    final entry = VfsAuditEntry(
      time: DateTime.now(),
      source: source,
      operation: operation,
      path: path,
      detail: detail,
      ok: ok,
    );
    _cache.add(entry);
    if (_cache.length > maxEntries) {
      _cache.removeRange(0, _cache.length - maxEntries);
    }
    // 通知监听者。监听者自己的异常不能影响记录本身——录制器挂了不该让
    // 用户的文件操作失败。
    for (final listener in List<void Function(VfsAuditEntry)>.of(_listeners)) {
      try {
        listener(entry);
      } catch (_) {}
    }
    try {
      final file = await _resolveFile();
      await file.writeAsString(
        '${jsonEncode(entry.toJson())}\n',
        mode: FileMode.append,
        flush: true,
      );
    } catch (_) {
      // 审计落盘失败：记录已经在内存里，界面上仍能看到来源标记。
    }
  }

  /// 读回最近若干条（新的在前）。
  Future<List<VfsAuditEntry>> recent({int limit = 100}) async {
    if (!_loaded) await _load();
    final items = _cache.reversed.take(limit).toList();
    return items;
  }

  /// 清空审计日志。
  Future<void> clear() async {
    _cache.clear();
    try {
      final file = await _resolveFile();
      if (await file.exists()) await file.delete();
    } catch (_) {}
  }

  Future<void> _load() async {
    _loaded = true;
    try {
      final file = await _resolveFile();
      if (!await file.exists()) return;
      final lines = await file.readAsLines();
      for (final line in lines) {
        if (line.trim().isEmpty) continue;
        try {
          final decoded = jsonDecode(line);
          if (decoded is Map<String, dynamic>) {
            _cache.add(VfsAuditEntry.fromJson(decoded));
          }
        } catch (_) {
          // 坏行跳过：日志坏一行不该让整份日志读不出来。
        }
      }
      if (_cache.length > maxEntries) {
        _cache.removeRange(0, _cache.length - maxEntries);
      }
    } catch (_) {}
  }

  Future<File> _resolveFile() async {
    final cached = _file;
    if (cached != null) return cached;
    final support = await getApplicationSupportDirectory();
    final dir = Directory(p.join(support.path, 'vfs'));
    if (!await dir.exists()) await dir.create(recursive: true);
    final file = File(p.join(dir.path, 'audit.jsonl'));
    _file = file;
    return file;
  }
}
