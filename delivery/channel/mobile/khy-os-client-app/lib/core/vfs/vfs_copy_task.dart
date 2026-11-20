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
import 'vfs_exception.dart';
import 'vfs_policy.dart';
import 'vfs_route.dart';

/// 这对路径能不能走「多线程任务」通道。
///
/// 判据：两端的访问通道都必须是 storage（普通文件系统 IO）。
///
/// 为什么：多线程引擎跑在原生侧的 Java IO 上，够不到 提权代理 才能看的路径
/// （应用私有目录、系统分区）。这类移动必须走 shell 通道的同步实现——
/// 硬让它去试只会失败，把「移动」这个功能直接弄没了。
///
/// 参数可空：`via == null` 是虚拟根（不是真实路径），那种路径压根不该发移动，
/// 所以 null 一律判否。
///
/// 这是纯函数，所以能测：判据一旦悄悄放宽，移动私有目录就会从「能用」
/// 变成「报错」，而那种错法在界面上完全看不出原因。
bool canUseThreadedMove(VfsVia? srcVia, VfsVia? dstVia) =>
    srcVia == VfsVia.storage && dstVia == VfsVia.storage;

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

  /// 移动模式下**没删掉**的源文件数：目标搬过去了，但源还留在原地。
  /// 复制时恒为 0。
  final int moveLeft;

  /// 移动模式下源还在不在：源还在 = 没搬走（被冲突跳过，或还没搬完）。
  ///
  /// 为什么非要这个字段：目标已存在且策略是「跳过」时，任务状态也是 done，
  /// 但源根本没动。这时候报「移动完成」就是在骗人。调用方靠它区分「搬完了」
  /// 与「被跳过了，什么都没做」。
  final bool srcGone;

  const CopyProgress({
    required this.taskId,
    required this.phase,
    this.done = 0,
    this.total = 0,
    this.files = 0,
    this.current = '',
    this.moveLeft = 0,
    this.srcGone = false,
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
      moveLeft: _int(map['moveLeft']),
      srcGone: map['srcGone'] == true,
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

  /// 发起一次复制（或移动）。
  ///
  /// 返回 taskId；失败时**抛 [VfsException]，带着原生给的机器码与人话**。
  ///
  /// 为什么不返回 null：原生在 `ok:false` 时是带 `error` + `message` 的
  /// （`not_found` + 「源不存在」、`denied` + 「无权限写入」…）。返回 null
  /// 会把这俩字段丢在这儿，逼每个调用方自己猜一句「源不存在，或目标位置
  /// 不可写」——而原生的真话就在手上。猜的那句还会漏报（至少三种失败原因，
  /// 它只说了两种），用户照着一个不完整的清单排查。
  ///
  /// [move] 为 true 时是移动：搬走之后删源。删的是**搬走的那些**——
  /// 被冲突策略跳过的源文件留在原地，不会被顺手删掉。
  Future<String> start({
    required String src,
    required String dst,
    VfsConflict conflict = VfsConflict.rename,
    bool resume = true,
    int threads = 3,
    bool move = false,
  }) async {
    install();
    final result = await VfsChannel.call('copyStart', <String, dynamic>{
      'src': src,
      'dst': dst,
      'conflict': conflict.name,
      'resume': resume,
      'threads': threads,
      'move': move,
    });
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '发起复制失败').toString(),
      );
    }
    final id = (result['taskId'] ?? '').toString();
    if (id.isEmpty) {
      // ok:true 却不给 taskId，是原生侧的失约——同样不该由调用方猜。
      throw const VfsException('unknown', '原生未返回任务 ID');
    }
    return id;
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
