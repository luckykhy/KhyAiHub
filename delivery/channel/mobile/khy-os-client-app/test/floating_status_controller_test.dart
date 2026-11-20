// 状态机 + 信箱测试。全 fake：注入固定时钟与临时目录，不碰 path_provider、
// 不开真定时器以外的任何 IO（Timer.periodic 的 10ms 档在测试里很快）。
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/agent_loop.dart';
import 'package:khy_os_client/core/agent/tool_verdict.dart';
import 'package:khy_os_client/core/floating/floating_status_controller.dart';
import 'package:khy_os_client/core/floating/overlay_task_sink.dart';
import 'package:khy_os_client/core/floating/task_state.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

/// 固定时钟：每读一次 +1ms，保证 updatedAtMs 严格递增（轮询流的变化判据）。
class TickingClock {
  int _ms = 1_000_000;
  DateTime call() => DateTime.fromMillisecondsSinceEpoch(_ms += 1);
}

FloatingStatusController newController(TaskStateStore store) =>
    FloatingStatusController(store: store, now: TickingClock().call);

Future<void> waitUntil(bool Function() cond,
    {Duration timeout = const Duration(seconds: 5)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!cond()) {
    if (DateTime.now().isAfter(deadline)) fail('等待超时：条件未满足');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  late Directory tmp;
  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('floating-ctrl-test');
  });
  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  TaskStateStore storeOf(String name) =>
      TaskStateStore(File('${tmp.path}/$name/${TaskStateStore.fileName}'));

  group('FloatingStatusController 状态机', () {
    test('idle→thinking→acting→reflecting→done→idle 全迁移，文件跟着走',
        () async {
      final store = storeOf('s1');
      final c = newController(store);
      final seen = <TaskPhase>[];
      final sub = c.stream.listen((s) {
        if (seen.isEmpty || seen.last != s.phase) seen.add(s.phase);
      });

      c.taskStarted(
          taskId: 'local-1',
          source: TaskSource.local,
          lastAction: '开始执行（最多 15 步）：打开抖音看热搜');
      expect(c.current.phase, TaskPhase.thinking);
      c.acting(stepNo: 1, lastAction: '调用 fetch_hot_list（src=抖音）');
      expect(c.current.phase, TaskPhase.acting);
      c.reflecting(stepNo: 1, lastAction: '第 1/15 步 · fetch_hot_list 已回报（已验证）');
      expect(c.current.phase, TaskPhase.reflecting);
      c.finish(resultExcerpt: '热搜1；热搜2');
      expect(c.current.phase, TaskPhase.idle,
          reason: '收尾写 idle——悬浮窗靠它收起');

      final onDisk = store.read();
      expect(onDisk?.phase, TaskPhase.idle);
      expect(onDisk?.lastResultExcerpt, '热搜1；热搜2');
      expect(onDisk?.steps, isNotEmpty, reason: 'idle 保留最近步骤供收起前最后一眼');
      await sub.cancel();
      await c.dispose();
    });

    test('error 收尾与 abandoned 都写诚实文案后转 idle', () async {
      final store = storeOf('s2');
      final c = newController(store);
      c.taskStarted(taskId: 'local-2', source: TaskSource.local, lastAction: '开跑');
      c.finish(errorMessage: 'LLM 调用失败');
      expect(c.current.phase, TaskPhase.idle);
      expect(store.read()?.errorMessage, 'LLM 调用失败');

      c.taskStarted(taskId: 'local-3', source: TaskSource.local, lastAction: '再跑');
      c.abandoned();
      expect(c.current.phase, TaskPhase.idle);
      expect(store.read()?.errorMessage, contains('已放弃等待，任务未真正终止'));
      expect(store.read()?.errorMessage, contains('AgentLoop 不支持中断'));
      await c.dispose();
    });

    test('审批挂起→清除；thinking 提示可更新', () async {
      final store = storeOf('s3');
      final c = newController(store);
      c.taskStarted(taskId: 'local-4', source: TaskSource.local, lastAction: '开跑');
      c.acting(stepNo: 2, lastAction: '调用 vision_tap');
      c.approvalRequested(const PendingApprovalInfo(
          id: 'ov-9', tool: 'vision_tap', target: '搜索按钮'));
      expect(c.current.phase, TaskPhase.awaitingApproval);
      expect(c.current.pendingApproval?.id, 'ov-9');
      expect(store.read()?.pendingApproval?.tool, 'vision_tap');
      expect(c.current.lastAction, contains('vision_tap'));

      c.approvalResolved();
      expect(c.current.phase, TaskPhase.acting);
      expect(c.current.pendingApproval, isNull);

      c.thinking(hint: '比较两种方案的优缺点');
      expect(c.current.phase, TaskPhase.thinking);
      expect(c.current.thinkingHint, '比较两种方案的优缺点');
      await c.dispose();
    });

    test('steps 截断到 8 条、新在前', () async {
      final store = storeOf('s4');
      final c = newController(store);
      c.taskStarted(taskId: 'local-5', source: TaskSource.local, lastAction: '开跑');
      for (var i = 1; i <= 10; i++) {
        c.acting(stepNo: i, lastAction: '调用 tool_$i');
      }
      expect(c.current.steps, hasLength(FloatingStatusController.maxSteps));
      expect(c.current.steps.first.text, contains('tool_10'),
          reason: '最新在最前');
      expect(c.current.steps.last.text, contains('tool_3'),
          reason: '10 步只留最近 8 条（tool_1/2 被截掉）');
      await c.dispose();
    });

    test('floating 开关镜像进文件', () async {
      final store = storeOf('s5');
      final c = newController(store);
      c.setFloatingEnabled(false);
      c.idle();
      expect(store.read()?.floatingEnabled, isFalse);
      c.setFloatingEnabled(true);
      expect(c.current.floatingEnabled, isTrue);
      await c.dispose();
    });

    test('setScreenshot 更新快照与文件；同路径与空路径不空转', () async {
      final store = storeOf('s6');
      final c = newController(store);
      c.taskStarted(taskId: 'local-6', source: TaskSource.local, lastAction: '开跑');
      final seen = <String?>[];
      final sub = c.stream.listen((s) => seen.add(s.lastScreenshotPath));

      c.setScreenshot('${store.file.parent.path}/screenshots/shot-1.png');
      expect(c.current.lastScreenshotPath, endsWith('shot-1.png'));
      expect(store.read()?.lastScreenshotPath, endsWith('shot-1.png'));

      final stamp = c.current.updatedAtMs;
      c.setScreenshot(c.current.lastScreenshotPath);
      expect(c.current.updatedAtMs, stamp, reason: '同路径不刷新时间戳');
      c.setScreenshot('');
      expect(c.current.lastScreenshotPath, isNot(''),
          reason: '空路径不动已有值——空的含义是「还没有截图」，不是「清掉」');

      await sub.cancel();
      await c.dispose();
    });
  });

  group('FilePollTaskStateFeed', () {
    test('文件变化才发、idle 也发（悬浮窗收起靠它）', () async {
      final store = storeOf('poll');
      final file = store.file;
      final feed = FilePollTaskStateFeed(file, interval: const Duration(milliseconds: 10));
      final seen = <TaskSnapshot>[];
      final sub = feed.stream.listen(seen.add);
      feed.start();

      await waitUntil(() => false, timeout: const Duration(milliseconds: 30))
          .catchError((_) {});
      expect(seen, isEmpty, reason: '没文件时静默');

      store.write(TaskSnapshot(
        phase: TaskPhase.acting,
        taskId: 't',
        updatedAtMs: 100,
        lastAction: '调用 a',
      ));
      await waitUntil(() => seen.isNotEmpty);
      expect(seen.single.phase, TaskPhase.acting);

      // 同一 updatedAtMs 再写也不重发（内容没变）
      store.write(TaskSnapshot(
        phase: TaskPhase.acting,
        taskId: 't',
        updatedAtMs: 100,
        lastAction: '调用 a',
      ));
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(seen, hasLength(1));

      store.write(TaskSnapshot(
        phase: TaskPhase.idle,
        taskId: 't',
        updatedAtMs: 200,
      ));
      await waitUntil(() => seen.length == 2);
      expect(seen.last.phase, TaskPhase.idle);
      await sub.cancel();
      await feed.dispose();
    });
  });

  group('FloatingInboxWatcher 信箱', () {
    test('text/stop/approval 分派正确；同签名行去重', () async {
      final inbox = File('${tmp.path}/inbox-w/${TaskStateStore.dirName}/${TaskStateStore.fileName}inbx.jsonl');
      await inbox.parent.create(recursive: true);
      final watcher = FloatingInboxWatcher(inbox,
          interval: const Duration(milliseconds: 10));
      final events = <FloatingInboxEvent>[];
      final sub = watcher.events.listen(events.add);
      watcher.start();

      await inbox.writeAsString(
          '{"text":"打开抖音看热搜","atMs":1}\n', flush: true);
      await waitUntil(() => events.isNotEmpty);
      expect(events.single, isA<FloatingInboxText>());
      expect((events.single as FloatingInboxText).text, '打开抖音看热搜');

      // 同一行补写第二遍：offset 之后没有新字节→不发；整文件重写→签名去重。
      await inbox.writeAsString(
          '{"text":"打开抖音看热搜","atMs":1}\n', mode: FileMode.append, flush: true);
      await inbox.writeAsString(
          '{"text":"打开抖音看热搜","atMs":1}\n', mode: FileMode.append, flush: true);
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(events, hasLength(1), reason: '同签名行重复追加只算一次');

      await inbox.parent.parent
          .create(recursive: true); // noop，保目录存在好读
      await inbox.writeAsString(
          '{"cmd":"stop","atMs":2}\n'
          '{"approval":"y","id":"ov-7","atMs":3}\n'
          '{"approval":"n","id":"ov-7","atMs":4}\n'
          '{"cmd":"openStatus","atMs":5}\n',
          mode: FileMode.append,
          flush: true);
      await waitUntil(() => events.length >= 5);
      expect(events[1], isA<FloatingInboxStop>());
      expect((events[2] as FloatingInboxApproval).allow, isTrue);
      expect((events[3] as FloatingInboxApproval).allow, isFalse);
      expect(events[4], isA<FloatingInboxOpenStatus>(),
          reason: '页脚「打开任务副屏」的信箱命令要能被认出来');
      await sub.cancel();
      await watcher.dispose();
    });

    test('整文件截断重写：offset 回退 + 签名去重不重放旧事件', () async {
      final inbox = File('${tmp.path}/inbox-t/state.jsonl');
      await inbox.parent.create(recursive: true);
      final watcher = FloatingInboxWatcher(inbox,
          interval: const Duration(milliseconds: 10));
      final events = <FloatingInboxEvent>[];
      final sub = watcher.events.listen(events.add);
      watcher.start();

      await inbox.writeAsString('{"text":"第一条","atMs":1}\n', flush: true);
      await waitUntil(() => events.isNotEmpty);

      // 消费方吃掉旧行后整文件重写（模拟收摊清理后重建）：旧行不许再触发。
      await inbox.writeAsString('{"text":"第二条","atMs":2}\n', flush: true);
      await waitUntil(() => events.length == 2);
      expect((events[1] as FloatingInboxText).text, '第二条');
      await sub.cancel();
      await watcher.dispose();
    });

    test('坏行与空 text 不产生事件', () async {
      final inbox = File('${tmp.path}/inbox-b/state.jsonl');
      await inbox.parent.create(recursive: true);
      final watcher = FloatingInboxWatcher(inbox,
          interval: const Duration(milliseconds: 10));
      final events = <FloatingInboxEvent>[];
      final sub = watcher.events.listen(events.add);
      watcher.start();
      await inbox.writeAsString(
          'not json\n{"text":"  "}\n{"approval":"y"}\n{"text":"好","atMs":9}\n',
          flush: true);
      await waitUntil(() => events.isNotEmpty);
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(events, hasLength(1));
      expect((events.single as FloatingInboxText).text, '好');
      await sub.cancel();
      await watcher.dispose();
    });
  });

  group('OverlayTaskSink（本地任务的进度面）', () {
    test('taskStarted→acting→reflecting 写出「动作+目标+进度」', () async {
      final store = storeOf('sink');
      final c = newController(store);
      final sink = OverlayTaskSink(c);

      await sink.taskStarted('打开抖音，把热搜前 10 发我');
      expect(c.current.phase, TaskPhase.thinking);
      expect(c.current.source, TaskSource.local);
      expect(c.current.taskId, startsWith('local-'));
      expect(c.current.totalSteps, AgentLoop.maxSteps);
      expect(c.current.lastAction, contains('打开抖音'));

      await sink.onExecuting(
        const AgentStep(
            step: 0,
            phase: AgentPhase.executing,
            toolName: 'fetch_hot_list',
            toolArgs: {'src': '抖音'}),
        stepNo: 1,
      );
      expect(c.current.phase, TaskPhase.acting);
      expect(c.current.lastAction, contains('调用 fetch_hot_list'));
      expect(c.current.lastAction, contains('抖音'));
      expect(c.current.stepIndex, 1);
      expect(c.current.steps.first.kind, TaskStepKind.act);

      final verdict = ToolVerdictFactory.of(
          'fetch_hot_list', const ToolResult(success: true, output: '热搜1；热搜2'));
      await sink.onReflecting(
        AgentStep(
            step: 0,
            phase: AgentPhase.reflecting,
            toolName: 'fetch_hot_list',
            toolArgs: const {'src': '抖音'},
            toolResult: const ToolResult(success: true, output: '热搜1；热搜2')),
        verdict,
        stepNo: 1,
      );
      expect(c.current.phase, TaskPhase.reflecting);
      expect(c.current.lastAction, contains('已回报'));
      expect(c.current.steps.first.kind, TaskStepKind.result);

      await sink.onFinal('榜单：热搜1、热搜2');
      expect(c.current.phase, TaskPhase.idle);
      expect(c.current.lastResultExcerpt, '榜单：热搜1、热搜2');
      await c.dispose();
    });

    test('审批目标挑选：target 优先于 command，长值截断', () {
      expect(approvalTarget({'target': '搜索框', 'command': 'ls'}), '搜索框');
      expect(approvalTarget({'command': 'ls -la /data'}), 'ls -la /data');
      expect(approvalTarget({}), '');
      expect(approvalTarget({'other': 'x'}), '{other: x}');
      expect(approvalTarget({'target': '长' * 100}), endsWith('…'));
    });
  });
}
