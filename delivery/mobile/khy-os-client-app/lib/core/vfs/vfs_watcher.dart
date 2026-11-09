// 目录事件监听：Dart 侧的事件接收与脚本触发。
//
// 闭环是这样：原生用 FileObserver 盯着目录 → 目录里有文件进出 → 原生把事件推给
// Dart → Dart 找到绑定在这个目录上的脚本 → 脚本跑起来。
//
// 典型场景就是需求里那句「当 Downloads 新增 APK 时自动扫描病毒并移动到 Safe 文件夹」。
//
// **限制要如实说**：
//   - 监听随 App 进程存活，App 被杀掉就没了（不是后台常驻服务）；
//   - 只监听一层目录，不递归；
//   - 只监听公共存储这类 App 自己能读的目录（私有目录要 Shizuku 的目录收不到
//     FileObserver 事件，原生侧会直接拒绝这类监听）。
//
// 事件去抖在原生侧做（800ms 窗口 + create/delete 合并），Dart 这边不再重复去抖——
// 两边都去抖会让「等一下再触发」变得不可预期。

import 'dart:async';

import 'automation_runner.dart';
import 'automation_script.dart';
import 'vfs_channel.dart';
import 'vfs_event_bus.dart';

/// 一个原生推来的目录事件。
class VfsWatchEvent {
  /// `created` / `modified` / `deleted`。
  final String type;

  /// 发生变化的目录（虚拟路径）。
  final String dir;

  /// 受影响的条目路径（虚拟路径）。
  final String path;

  /// 条目名。
  final String name;

  const VfsWatchEvent({
    required this.type,
    required this.dir,
    required this.path,
    required this.name,
  });

  factory VfsWatchEvent.fromMap(Map<String, dynamic> map) => VfsWatchEvent(
        type: (map['type'] ?? '').toString(),
        dir: (map['dir'] ?? '').toString(),
        path: (map['path'] ?? '').toString(),
        name: (map['name'] ?? '').toString(),
      );

  @override
  String toString() => 'VfsWatchEvent($type $path)';
}

/// 一个正在监听的目录。
class VfsWatch {
  final String watchId;
  final String dir;
  final String scriptId;

  const VfsWatch({
    required this.watchId,
    required this.dir,
    this.scriptId = '',
  });

  factory VfsWatch.fromMap(Map<String, dynamic> map) => VfsWatch(
        watchId: (map['watchId'] ?? '').toString(),
        dir: (map['dir'] ?? '').toString(),
        scriptId: (map['scriptId'] ?? '').toString(),
      );
}

/// 开始监听的结果。
///
/// 失败时**带上原因**：路径写错了和「这个目录要 Shizuku 才能读」是两回事，
/// 用户看到的提示必须不同——笼统一句「无法监听」会让人以为自己操作错了。
class WatchStartResult {
  final bool ok;
  final String watchId;

  /// 机器码（not_found / denied / …）。
  final String error;

  /// 人话说明。
  final String message;

  const WatchStartResult({
    required this.ok,
    this.watchId = '',
    this.error = '',
    this.message = '',
  });

  /// 失败时给用户看的那句话。
  String get displayMessage => message.isEmpty ? '无法监听该目录' : message;
}

/// 目录事件监听服务。
class VfsWatcherService {
  VfsWatcherService._();

  static final VfsWatcherService instance = VfsWatcherService._();

  final List<void Function(VfsWatchEvent event)> _listeners =
      <void Function(VfsWatchEvent event)>[];

  bool _handlerInstalled = false;

  /// 装上原生→Dart 的事件处理器。
  ///
  /// 走 [VfsEventBus] 而不是直接占通道：通道的 Dart 侧 handler 只有一个，
  /// 复制进度也要用同一个通道——各装各的会互相顶掉。
  void start() {
    VfsEventBus.instance.install();
    VfsEventBus.instance.on('vfsEvent', _onEvent);
    _handlerInstalled = true;
  }

  /// 事件处理器是否已装。
  bool get handlerInstalled => _handlerInstalled;

  void _onEvent(Map<String, dynamic> args) {
    final event = VfsWatchEvent.fromMap(args);
    _dispatch(event);
  }

  /// 注册事件监听者。
  void addListener(void Function(VfsWatchEvent event) listener) {
    _listeners.add(listener);
  }

  void removeListener(void Function(VfsWatchEvent event) listener) {
    _listeners.remove(listener);
  }

  /// 开始监听一个目录。
  ///
  /// 失败时返回带原因的结果（路径不存在 / 需要 Shizuku / 系统分区……）。
  Future<WatchStartResult> watch(String dir, {String scriptId = ''}) async {
    start();
    final result = await VfsChannel.call('watchStart', <String, dynamic>{
      'dir': dir,
      'scriptId': scriptId,
    });
    if (result['ok'] != true) {
      return WatchStartResult(
        ok: false,
        error: (result['error'] ?? 'unknown').toString(),
        message: (result['message'] ?? '无法监听该目录').toString(),
      );
    }
    final id = (result['watchId'] ?? '').toString();
    if (id.isEmpty) {
      return const WatchStartResult(
        ok: false,
        error: 'unknown',
        message: '原生没有返回监听标识',
      );
    }
    return WatchStartResult(ok: true, watchId: id);
  }

  /// 停止监听。
  Future<void> stop(String watchId) async {
    await VfsChannel.call('watchStop', <String, dynamic>{
      'watchId': watchId,
    });
  }

  /// 列出正在监听的目录。
  Future<List<VfsWatch>> list() async {
    final result = await VfsChannel.call('watchList');
    final raw = result['watches'];
    final watches = <VfsWatch>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          watches.add(VfsWatch.fromMap(
            item.map((Object? key, Object? value) =>
                MapEntry<String, dynamic>(key.toString(), value)),
          ));
        }
      }
    }
    return watches;
  }

  /// 把一个脚本绑到它的监视目录上。
  ///
  /// 脚本的触发方式必须是 `directoryEvent` 且有监视目录——其它触发方式不归这里管。
  /// 失败时返回原因（目录不存在 / 要 Shizuku / 系统分区……）。
  Future<WatchStartResult> bindScript(AutomationScript script) async {
    if (script.trigger != AutomationTrigger.directoryEvent) {
      return const WatchStartResult(
        ok: false,
        error: 'invalid_path',
        message: '这个脚本的触发方式不是「目录事件」，不用监听',
      );
    }
    if (script.watchDir.isEmpty) {
      return const WatchStartResult(
        ok: false,
        error: 'invalid_path',
        message: '脚本没有设置要监视的目录',
      );
    }
    return watch(script.watchDir, scriptId: script.id);
  }

  void _dispatch(VfsWatchEvent event) {
    for (final listener in List<void Function(VfsWatchEvent)>.of(_listeners)) {
      try {
        listener(event);
      } catch (_) {
        // 一个监听者出错不该影响其它监听者。
      }
    }
  }
}

/// 事件 → 脚本执行的粘合。
///
/// 放在这里而不是 UI 里，是因为「事件来了要跑脚本」这件事与界面无关：
/// 界面上关掉了 App 的这一页，监听也该继续（只要进程还在）。
abstract final class VfsWatchTrigger {
  /// 装上「收到事件 → 找绑定脚本 → 执行」的通路。
  ///
  /// 返回一个停止函数。
  static void Function() install({
    Future<void> Function(AutomationRunResult result)? onRun,
  }) {
    final service = VfsWatcherService.instance;
    service.start();

    void listener(VfsWatchEvent event) {
      unawaited(_runBoundScript(event, onRun));
    }

    service.addListener(listener);
    return () => service.removeListener(listener);
  }

  static Future<void> _runBoundScript(
    VfsWatchEvent event,
    Future<void> Function(AutomationRunResult result)? onRun,
  ) async {
    final scripts = await AutomationScriptStore.load();
    AutomationScript? matched;
    for (final script in scripts) {
      if (script.trigger != AutomationTrigger.directoryEvent) continue;
      if (script.watchDir.isEmpty) continue;
      if (script.watchDir != event.dir) continue;
      matched = script;
      break;
    }
    if (matched == null) return;

    final result = await AutomationRunner.run(matched);
    if (onRun != null) await onRun(result);
  }
}
