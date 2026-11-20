// FloatingTaskHub 信箱分派的组合测试：path_provider 打桩到临时目录，
// runnerFactory / controllerOverride 用单例既有注入点。验证文件即总线的
// 全链路：inbox.jsonl 的一行 → 分派 → 同一条本地任务管线。
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/floating/floating_status_controller.dart';
import 'package:khy_os_client/core/floating/floating_task_hub.dart';
import 'package:khy_os_client/core/floating/task_state.dart';
import 'package:khy_os_client/core/wechat/wechat_approval_bridge.dart';
import 'package:khy_os_client/core/wechat/wechat_task_runner.dart';

Future<void> waitUntil(bool Function() cond,
    {Duration timeout = const Duration(seconds: 6)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!cond()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('等待超时：条件未满足');
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

class _EmptyTransport implements WechatTransport {
  @override
  Stream<WechatInboundMessage> get inbound => const Stream.empty();

  @override
  Future<void> send(String contextToken, String text) async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tmp;
  late File inboxFile;
  FloatingTaskHub hub = FloatingTaskHub.instance;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('floating-hub-test');
    inboxFile = TaskStateStore.inboxInDocs(tmp.path);
    // path_provider 打桩：docs = tmp。hub 的控制器 / 信箱 / 截图目录全落这里。
    // 注意方法名是 getApplicationDocumentsDirectory（platform interface 的
    // 通道方法就叫这个，不带 Path 后缀）——名字错了桩不命中，hub 会静默
    // 起不来，信箱事件石沉大海。
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (call) async {
        if (call.method.startsWith('getApplicationDocuments')) return tmp.path;
        return null;
      },
    );
  });

  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
            const MethodChannel('plugins.flutter.io/path_provider'), null);
    await hub.setFloatingEnabled(false);
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  FloatingStatusController freshController() => FloatingStatusController(
        store: TaskStateStore(
            File('${tmp.path}/floating/${TaskStateStore.fileName}')),
      );

  void wireRunner(FloatingStatusController controller) {
    hub.controllerOverride = controller;
    hub.runnerFactory = (_) => WechatTaskRunner(
          transport: _EmptyTransport(),
          // 端口 1 的 loopback：连接立刻被拒，任务诚实地失败——分派测试只
          // 关心「指令进了同一条管线」，不关心模型说了什么。
          loadConfig: () async => AppConfigData(
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: 'test-key',
            model: 'test-model',
          ),
        );
  }

  Future<void> appendLine(String line) async {
    final dir = inboxFile.parent;
    if (!dir.existsSync()) dir.createSync(recursive: true);
    await inboxFile.writeAsString('$line\n',
        mode: FileMode.append, flush: true);
  }

  test('openStatus：信箱行 → handler 被调 → pending 消费即清', () async {
    final handlerCalls = <int>[];
    hub.openStatusHandler = () async {
      handlerCalls.add(1);
    };
    await hub.ensureStarted();

    await appendLine('{"cmd":"openStatus","atMs":1}');
    await waitUntil(() => handlerCalls.isNotEmpty);
    expect(hub.takePendingOpenStatus(), isTrue,
        reason: '分派应挂起一个导航请求给 UI 层消费');
    expect(hub.takePendingOpenStatus(), isFalse, reason: '消费即清');
  });

  test('text：信箱行 → submitLocal 同一条管线（受理→诚实失败→idle）', () async {
    final controller = freshController();
    wireRunner(controller);
    await hub.ensureStarted();

    await appendLine('{"text":"打开抖音看热搜","atMs":2}');
    await waitUntil(() => controller.current.phase != TaskPhase.idle ||
        controller.current.errorMessage.isNotEmpty);
    // 管线收尾（连接 127.0.0.1:1 被拒 → onRunFailed → idle 带错误说明）。
    await waitUntil(() => controller.current.errorMessage.isNotEmpty);
    expect(controller.current.source, TaskSource.local);
    await waitUntil(() => controller.current.phase == TaskPhase.idle);
  });

  test('approval：信箱回信按 id 落到 OverlayApprovalChannel', () async {
    final controller = freshController();
    wireRunner(controller);
    await hub.ensureStarted();
    final channel = hub.overlayApproval!;
    final answer = channel.request(
        toolName: 'vision_tap', params: {'target': '搜索按钮'});
    await waitUntil(() => channel.pendingId != null);

    await appendLine(
        '{"approval":"y","id":"${channel.pendingId}","atMs":3}');
    final decision = await answer;
    expect(decision, WechatApprovalDecision.allow);
    expect(controller.current.pendingApproval, isNull);
  });

  test('stop：信箱行 → 放弃等待不抛（当前无任务时如实返回 false）', () async {
    final controller = freshController();
    wireRunner(controller);
    await hub.ensureStarted();

    await appendLine('{"cmd":"stop","atMs":4}');
    await Future<void>.delayed(const Duration(milliseconds: 1300));
    expect(controller.current.phase, TaskPhase.idle);
  });
}
