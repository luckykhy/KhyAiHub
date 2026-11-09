// 异步复制：进度、取消、断点续传的 Dart 侧。
//
// 为什么复制要单独走一套接口：一次复制几万个文件是**分钟级**的操作，
// 用同步接口干等，用户既看不到进度也停不下来——这是「专业文件管理器」
// 与「能复制文件的 App」之间最明显的差别。
//
// 断点续传的判定在原生侧（它才有文件大小的真相）：每个文件先写
// `<目标>.khy-part`，写完再改名；`.khy-part` 与它的 meta 旁文件一起构成
// 「未完成」的标记，中断后下一次可以接着写。
//
// Dart 这一侧只做三件事：发起、看进度、取消。

import 'dart:async';

import 'package:meta/meta.dart';

import 'vfs_channel.dart';
import 'vfs_event_bus.dart';
import 'vfs_policy.dart';

/// 复制进度。
@immutable
class CopyProgress {
  final String taskId;

  /// `copying` / `done` / `cancelled` / `error`。
  final String phase;

  /// 已完成字节。
  final int done;

  /// 总字节。
  final int total;

  /// 已完成的文件数。
  final int files;

  /// 当前处理的文件。
  final String current;

  const CopyProgress({
    required this.taskId,
    required this.phase,
    this.done = 0,
    this.total = 0,
    this.files = 0,
    this.current = '',
  });

  factory CopyProgress.fromMap(Map<String, dynamic> map) {
    // 原生有两套词：进度事件用 `phase`（copying/done/cancelled/error），
    // 状态查询用 `state`（running/done/cancelled/error）。这里统一成 phase，
    // 并把 running 归一成 copying——否则「查状态」回来的进度永远显示不出
    // 「进行中」，也永远等不到结束。
    final raw = (map['phase'] ?? map['state'] ?? '').toString();
    final phase = raw == 'running' ? 'copying' : raw;
    return CopyProgress(
      taskId: (map['taskId'] ?? '').toString(),
      phase: phase,
      done: _int(map['done']),
      total: _int(map['total']),
      files: _int(map['files']),
      current: (map['current'] ?? '').toString(),
    );
  }

  static int _int(Object? value) {
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value) ?? 0;
    return 0;
  }

  /// 进度比例（0~1）。总量未知时返回 0。
  double get ratio => total <= 0 ? 0 : (done / total).clamp(0.0, 1.0);

  bool get finished =>
      phase == 'done' || phase == 'cancelled' || phase == 'error';

  /// 可读的处理量。
  String get readableDone => readableBytes(done);

  /// 字节数的可读形式。
  static String readableBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    const units = <String>['KB', 'MB', 'GB'];
    var value = bytes / 1024;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return '${value.toStringAsFixed(value >= 100 ? 0 : 1)} ${units[unit]}';
  }
}

/// 复制任务管理。
class VfsCopyTasks {
  VfsCopyTasks._();

  static final VfsCopyTasks instance = VfsCopyTasks._();

  final StreamController<CopyProgress> _controller =
      StreamController<CopyProgress>.broadcast();

  bool _subscribed = false;

  /// 进度流。
  ///
  /// 取流即装事件处理器——「订了流却没收到事件」这种故障很难查，
  /// 所以订阅这件事本身就该完成注册。
  Stream<CopyProgress> get progress {
    install();
    return _controller.stream;
  }

  /// 订阅原生推来的进度事件。
  void install() {
    // 通道 handler 每次都重装：别处（测试收尾、其它模块）把它卸掉之后，
    // 靠「装过就不装」的标记会导致事件再也收不到——静默失效最难查。
    VfsEventBus.instance.install();
    if (_subscribed) return;
    _subscribed = true;
    VfsEventBus.instance.on('vfsProgress', (Map<String, dynamic> args) {
      _controller.add(CopyProgress.fromMap(args));
    });
  }

  /// 发起一次复制。
  ///
  /// 返回 taskId；失败（源不存在等）返回 null。
  Future<String?> start({
    required String src,
    required String dst,
    VfsConflict conflict = VfsConflict.rename,
    bool resume = true,
    int threads = 3,
  }) async {
    install();
    final result = await VfsChannel.call('copyStart', <String, dynamic>{
      'src': src,
      'dst': dst,
      'conflict': conflict.name,
      'resume': resume,
      'threads': threads,
    });
    if (result['ok'] != true) return null;
    final id = (result['taskId'] ?? '').toString();
    return id.isEmpty ? null : id;
  }

  /// 取消复制。已复制的部分保留在 `.khy-part` 里，下次可续。
  Future<void> cancel(String taskId) async {
    await VfsChannel.call('copyCancel', <String, dynamic>{'taskId': taskId});
  }

  /// 查任务状态。
  Future<CopyProgress?> status(String taskId) async {
    final result = await VfsChannel.call('copyStatus', <String, dynamic>{
      'taskId': taskId,
    });
    if (result['ok'] != true) return null;
    return CopyProgress.fromMap(result);
  }
}
