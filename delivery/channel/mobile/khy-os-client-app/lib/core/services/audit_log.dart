// 操作审计日志：谁动了这个设备、动了什么。
//
// 为什么它不在 VFS 层：审计的写入点必须落在**真正执行的那一层**。文件写操作的
// 唯一出口是 VfsService，设备命令的唯一出口是 DeviceControl.execShell —— 两边
// 要写**同一份**日志，日志模块就不能挂在其中一边之下（挂 VFS 下面，设备层就得
// 反向依赖 VFS；挂设备层下面，VFS 又得反向依赖设备层）。所以它下沉到
// core/services：这一层是两侧的公共下游，方向只有一条。
//
// 为什么值得单独写它：这一版 App 的核心承诺是「AI 是助手不是主角」。这句话要
// 能被**核查**，而不是靠嘴说。每条操作都带来源标记（用户手动 / AI 建议 / 脚本
// 执行 / 系统），用户能一眼看出哪些操作不是自己点的。少了设备侧那半边，这个
// 承诺就只覆盖了文件操作——而 AI 真正能伤到设备的地方，恰恰是命令。
//
// 落盘位置用 path_provider 解析应用支持目录，不写 cwd 相对路径——cwd 是调用方的
// 偶然状态，拿它当数据家的锚点，会让同一份代码在不同目录下写成不同结果。
// 目录仍叫 `vfs`（历史包袱）：里面已有的日志是老版本写的，改路径等于让用户
// 之前的记录凭空消失。

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:meta/meta.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// 操作来源。
enum AuditSource {
  /// 用户手动操作。
  user,

  /// AI 建议（经用户确认后执行）。
  ai,

  /// 脚本执行（自动化录制产物）。
  script,

  /// 系统自身（定时任务、恢复流程等）。
  system;

  static AuditSource parse(String? raw) {
    for (final source in AuditSource.values) {
      if (source.name == raw) return source;
    }
    return AuditSource.user;
  }

  String get label {
    switch (this) {
      case AuditSource.user:
        return '用户手动';
      case AuditSource.ai:
        return 'AI 建议';
      case AuditSource.script:
        return '脚本执行';
      case AuditSource.system:
        return '系统';
    }
  }
}

/// 一条审计记录。
class AuditEntry {
  final DateTime time;
  final AuditSource source;
  final String operation;

  /// 操作涉及的路径。设备级操作（跑命令）没有路径，这里是空串。
  final String path;

  /// 补充说明。文件操作里是「目标路径」，命令操作里是「命令原文」。
  final String detail;

  final bool ok;

  /// 跨权限标记。空串表示这次操作没有跨越权限档。
  final String crossTier;

  const AuditEntry({
    required this.time,
    required this.source,
    required this.operation,
    required this.path,
    this.detail = '',
    this.ok = true,
    this.crossTier = '',
  });

  /// 这次操作是否越过了权限边界。
  bool get isCrossTier => crossTier.isNotEmpty;

  /// 这次操作有没有文件路径。设备级操作没有——界面据此决定显示什么。
  bool get hasPath => path.isNotEmpty;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'time': time.millisecondsSinceEpoch,
        'source': source.name,
        'operation': operation,
        'path': path,
        'detail': detail,
        'ok': ok,
        'crossTier': crossTier,
      };

  factory AuditEntry.fromJson(Map<String, dynamic> json) => AuditEntry(
        time: DateTime.fromMillisecondsSinceEpoch(
          (json['time'] as num?)?.toInt() ?? 0,
        ),
        source: AuditSource.parse(json['source'] as String?),
        operation: (json['operation'] ?? '').toString(),
        path: (json['path'] ?? '').toString(),
        detail: (json['detail'] ?? '').toString(),
        ok: json['ok'] != false,
        crossTier: (json['crossTier'] ?? '').toString(),
      );
}

/// 审计日志。
class AuditLog {
  AuditLog._();

  static final AuditLog instance = AuditLog._();

  /// 最多保留多少条。超了从头截断——审计要的是「最近发生了什么」，
  /// 不是无限增长的本机账本。
  static const int maxEntries = 500;

  File? _file;

  /// 测试用的落盘目录。为空时走 path_provider 的生产路径。
  Directory? _overrideDir;

  final List<AuditEntry> _cache = <AuditEntry>[];
  bool _loaded = false;

  /// 监听者。操作录制器靠它把「用户刚做的操作」收集成自动化脚本。
  final List<void Function(AuditEntry entry)> _listeners =
      <void Function(AuditEntry entry)>[];

  /// 把落盘目录指到临时目录（测试用）。
  ///
  /// 为什么需要它：审计落盘走 path_provider，那是平台通道，单测里调不通。
  /// 没有这个口子就没法断言「真的写进去了」——只能断言内存里的列表，
  /// 那是另一回事。
  @visibleForTesting
  static void useDirectoryForTest(Directory? dir) {
    final log = instance;
    log._overrideDir = dir;
    log._file = null;
    log._cache.clear();
    log._loaded = false;
  }

  /// 注册监听者。
  void addListener(void Function(AuditEntry entry) listener) {
    _listeners.add(listener);
  }

  /// 注销监听者。
  void removeListener(void Function(AuditEntry entry) listener) {
    _listeners.remove(listener);
  }

  /// 记录一条操作。写盘失败不抛：审计写不进去不该阻断用户正在做的事。
  Future<void> record(
    AuditSource source,
    String operation,
    String path, {
    String detail = '',
    bool ok = true,
    String crossTier = '',
  }) async {
    final entry = AuditEntry(
      time: DateTime.now(),
      source: source,
      operation: operation,
      path: path,
      detail: detail,
      ok: ok,
      crossTier: crossTier,
    );
    _cache.add(entry);
    if (_cache.length > maxEntries) {
      _cache.removeRange(0, _cache.length - maxEntries);
    }
    // 通知监听者。监听者自己的异常不能影响记录本身——录制器挂了不该让
    // 用户的文件操作失败。
    for (final listener in List<void Function(AuditEntry)>.of(_listeners)) {
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
  Future<List<AuditEntry>> recent({int limit = 100}) async {
    if (!_loaded) await _load();
    final items = _cache.reversed.take(limit).toList();
    return items;
  }

  /// 按时间窗查审计记录（窗口两端闭合，新的在前）。
  ///
  /// 为什么不能拿 recent() 加过滤代替：recent() 答的是「最近若干条」，
  /// 上限 100 还先截断——一次要查昨天下午的操作，会得到「查不到」而不是
  /// 「那时候没有」。审计的意义是回答「某段时间里发生过什么」，这个答法
  /// 比不答更坏。
  ///
  /// 判据（contract K-83、B10 判据原文「审计可按时间查调用方与用途」）：
  /// 查到的一条必须答得出 source（谁）与 operation + detail（干什么）。
  /// 查询本身不改缓存、不动 recent() 的语义——新查询不许顺手改旧行为。
  Future<List<AuditEntry>> queryWindow({
    required DateTime from,
    required DateTime to,
  }) async {
    if (!_loaded) await _load();
    // from 晚于 to：答空，不答错。窗口是用户填的，填反了不是程序的错。
    if (to.isBefore(from)) return const <AuditEntry>[];
    final inWindow = _cache
        .where((e) => !e.time.isBefore(from) && !e.time.isAfter(to))
        .toList();
    return inWindow.reversed.toList();
  }

  /// 清空审计日志。
  Future<void> clear() async {
    _cache.clear();
    try {
      final file = await _resolveFile();
      if (await file.exists()) await file.delete();
    } catch (_) {}
  }

  /// 从文件回灌缓存。
  ///
  /// **为什么是「重建」而不是「追加」**：缓存里已经有本进程记过的条目，文件里
  /// 也有一份同样的——回灌时若只追加，同一条操作就会在日志里出现两次。
  /// 追加式回灌只在「先读后写」的顺序下碰巧不出错，而真实顺序是
  /// 「先操作、后打开日志」，那正是会翻车的顺序。所以这里清空重建：文件是
  /// 唯一真源（写盘失败是极少数情况，丢了那一条比重复显示要诚实）。
  Future<void> _load() async {
    _cache.clear();
    try {
      final file = await _resolveFile();
      if (!await file.exists()) {
        // 确实没有审计文件：空是**真实结论**，标记已加载，下次不再白跑一遍。
        _loaded = true;
        return;
      }
      final lines = await file.readAsLines();
      for (final line in lines) {
        if (line.trim().isEmpty) continue;
        try {
          final decoded = jsonDecode(line);
          if (decoded is Map<String, dynamic>) {
            _cache.add(AuditEntry.fromJson(decoded));
          }
        } catch (_) {
          // 坏行跳过：日志坏一行不该让整份日志读不出来。
        }
      }
      if (_cache.length > maxEntries) {
        _cache.removeRange(0, _cache.length - maxEntries);
      }
      _loaded = true;
    } catch (_) {
      // 读失败：**不**标记已加载，下一次 recent() 会重试。
      //
      // 原先 `_loaded = true` 写在 try 之前——一次瞬时失败（path_provider
      // 抽风、目录被临时占用）就会让整个进程生命周期内审计日志永远空白，
      // 而界面显示的是「没有操作记录」：把「读不到」演成了「没发生过」。
      // 审计日志的存在意义就是回答「发生过什么」，这个答法比不答更坏。
    }
  }

  Future<File> _resolveFile() async {
    final cached = _file;
    if (cached != null) return cached;
    final override = _overrideDir;
    final Directory dir;
    if (override != null) {
      dir = override;
    } else {
      final support = await getApplicationSupportDirectory();
      dir = Directory(p.join(support.path, 'vfs'));
    }
    if (!await dir.exists()) await dir.create(recursive: true);
    final file = File(p.join(dir.path, 'audit.jsonl'));
    _file = file;
    return file;
  }
}
