// Composition root for the floating status feature: builds the controller,
// the runner and the inbox dispatch in one place, behind a process-wide
// singleton the UI can reach without constructor plumbing.
//
// WHY A SINGLETON. The entry points are spread out (settings toggle, status
// screen navigation, main() cold start) and none of them owns the other;
// threading a controller through all three would be plumbing without a
// seam. The runner itself stays injectable for tests via [runnerFactory].
//
// WeChat transport is deliberately NOT wired here: WS2 (ilink facade →
// runner) has not landed, and wiring it would change WeChat behaviour from
// "执行端尚未接线" to "开始执行" — a scope this round does not own. Local
// tasks never touch the transport; the placeholder below only satisfies the
// runner's constructor.

import 'dart:async';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../config/app_config.dart';
import '../services/app_logger.dart';
import '../services/trajectory_store.dart';
import '../tools/vision_tools.dart';
import '../wechat/wechat_task_runner.dart';
import 'floating_status_controller.dart';
import 'overlay_task_sink.dart';
import 'screenshot_thumbnails.dart';
import 'task_state.dart';

/// 微信传输占位。runner 的构造要求一个 WechatTransport，而 WS2 未落地——
/// 没有任何微信消息会进 runner，[send] 不会被调。接线落地时把真实 facade
/// 换进 [FloatingTaskHub.runnerFactory]，本类随之删除。
class _UnwiredWechatTransport implements WechatTransport {
  @override
  Stream<WechatInboundMessage> get inbound => const Stream.empty();

  @override
  Future<void> send(String contextToken, String text) async {}
}

class FloatingTaskHub {
  FloatingTaskHub._();

  static final FloatingTaskHub instance = FloatingTaskHub._();

  final _log = AppLogger();

  /// 测试注入点：默认 null 走真实组合。
  WechatTaskRunner Function(FloatingStatusController controller)?
      runnerFactory;
  FloatingStatusController? controllerOverride;

  FloatingStatusController? _controller;
  WechatTaskRunner? _runner;
  OverlayApprovalChannel? _overlayApproval;
  FloatingInboxWatcher? _watcher;
  StreamSubscription<FloatingInboxEvent>? _inboxSub;
  bool _starting = false;
  bool _started = false;

  /// 「打开任务副屏」的导航回调，由 UI 层（main.dart）注册——hub 在 core，
  /// 不该 import ui；副屏还没可导航时（App 冷启动中），pending 由
  /// [takePendingOpenStatus] 留给 UI 恢复后再取。
  Future<void> Function()? openStatusHandler;
  bool _pendingOpenStatus = false;

  /// 取走挂着的 openStatus 请求（消费即清）。副屏 resume 时轮询一次即可。
  bool takePendingOpenStatus() {
    final p = _pendingOpenStatus;
    _pendingOpenStatus = false;
    return p;
  }

  /// 副屏的数据源。未启动（开关关）时为 null，副屏自己摆出诚实空态。
  TaskStateFeed? get feed {
    final c = _controller;
    return c == null ? null : DirectTaskStateFeed(c.stream);
  }

  FloatingStatusController? get controller => _controller;
  OverlayApprovalChannel? get overlayApproval => _overlayApproval;
  bool get started => _started;

  /// 开关开 → 起控制器与信箱监听，并写一份 idle 快照（悬浮窗知道当前没任务）。
  /// 开关关 → 不启动 / 收摊。任何失败只记日志，不拖住调用方（启动路径）。
  Future<void> ensureStarted() async {
    if (_started || _starting) return;
    _starting = true;
    try {
      final controller = controllerOverride ??
          FloatingStatusController(
            store: TaskStateStore.inDocs((await _docsDir()).path),
          );
      _controller = controller;
      _overlayApproval =
          OverlayApprovalChannel(controller: controller);
      _runner = runnerFactory != null
          ? runnerFactory!(controller)
          : WechatTaskRunner(
              transport: _UnwiredWechatTransport(),
              loadConfig: AppConfig.loadEffective,
              trajectoryStore: TrajectoryStore(),
            );
      final watcher = FloatingInboxWatcher(
        TaskStateStore.inboxInDocs((await _docsDir()).path),
      );
      _watcher = watcher;
      final thumbs = ScreenshotThumbnailStore(
          TaskStateStore.screenshotsInDocs((await _docsDir()).path));
      // vision 工具的截图旁路：任务跑着的时候悬浮窗左列才有的画面。
      // fire-and-forget——缩略失败只表现为「截图列空着」，不影响工具本身。
      visionScreenshotObserver = (b64) async {
        final path = await thumbs.saveFromBase64(b64);
        if (path != null) _controller?.setScreenshot(path);
      };
      _inboxSub = watcher.events.listen(_dispatch,
          onError: (Object e) =>
              _log.w(LogCategory.system, '悬浮信箱流错误: $e'));
      watcher.start();
      // 开局写 idle：悬浮窗（或重装后残留的旧文件）从此有据可依地不画。
      controller.setFloatingEnabled(true);
      controller.idle();
      _started = true;
    } catch (e) {
      _log.w(LogCategory.system, '悬浮状态层启动失败（不阻塞 App）: $e');
    } finally {
      _starting = false;
    }
  }

  /// 设置页开关。关 = 立即写一份 floating=false 的 idle，把残留的悬浮窗收下去。
  Future<void> setFloatingEnabled(bool on) async {
    if (on) {
      await ensureStarted();
      return;
    }
    final c = _controller;
    if (c == null) return;
    c.setFloatingEnabled(false);
    c.idle();
    await _teardown();
  }

  Future<void> _teardown() async {
    await _inboxSub?.cancel();
    _inboxSub = null;
    await _watcher?.dispose();
    _watcher = null;
    visionScreenshotObserver = null;
    await _controller?.dispose();
    _controller = null;
    _overlayApproval = null;
    _runner = null;
    _started = false;
  }

  /// 悬浮窗/副屏提交。返回空串 = 受理；非空 = 诚实拒绝文案。
  Future<String> submitLocal(String text) async {
    await ensureStarted();
    final runner = _runner;
    final controller = _controller;
    final approval = _overlayApproval;
    if (runner == null || controller == null || approval == null) {
      return '悬浮状态层未就绪，无法提交任务';
    }
    return runner.submitLocal(
      text,
      sink: OverlayTaskSink(controller),
      approval: approval,
    );
  }

  /// 停止按钮（副屏/悬浮窗共用语义）：放弃等待。控制器立即写诚实说明——
  /// runner 在当前步收尾后还会经 sink.onAbandoned 再写一遍（幂等）。
  Future<bool> stopCurrent() async {
    final runner = _runner;
    if (runner == null) return false;
    final stopped = await runner.stopCurrentTask();
    if (stopped) _controller?.abandoned();
    return stopped;
  }

  /// 批准/拒绝一个挂起的 ask 工具调用（副屏按钮与信箱回信同走这里）。
  Future<bool> resolveApproval(String id, bool allow) async {
    final channel = _overlayApproval;
    if (channel == null || channel.pendingId != id) return false;
    channel.resolve(id, allow);
    return true;
  }

  Future<Directory> _docsDir() => getApplicationDocumentsDirectory();

  void _dispatch(FloatingInboxEvent event) {
    switch (event) {
      case FloatingInboxText(:final text):
        unawaited(() async {
          final refusal = await submitLocal(text);
          if (refusal.isNotEmpty) {
            // 悬浮窗没有回执面（phase=idle 不画）；拒绝原因记日志，正在跑的
            // 任务摘要本身就画在胶囊上。
            _log.i(LogCategory.system, '悬浮信箱指令被拒：$refusal');
          }
        }());
      case FloatingInboxStop():
        unawaited(stopCurrent());
      case FloatingInboxApproval(:final id, :final allow):
        unawaited(resolveApproval(id, allow));
      case FloatingInboxOpenStatus():
        // 原生已把 App 带到前台；导航到副屏由 UI 层的 handler 完成。handler
        // 还没注册（App 尚在启动）就先挂着，resume 后 UI 主动来取。
        _pendingOpenStatus = true;
        final handler = openStatusHandler;
        if (handler != null) unawaited(handler());
    }
  }
}
