// TaskStateStore + TaskSnapshot 的契约测试：JSON 往返、步骤截断、原子写、
// 坏文件 fail-soft。全 fake——临时目录，不碰 path_provider。
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/floating/task_state.dart';

TaskSnapshot snapshotWithSteps(int n) => TaskSnapshot(
      phase: TaskPhase.acting,
      taskId: 't1',
      stepIndex: n,
      totalSteps: 15,
      lastAction: '调用 fetch（已处理 $n/15 步）',
      startedAtMs: 1000,
      updatedAtMs: 2000,
      steps: List.generate(
        n,
        (i) => TaskStepRecord(
            text: '步骤 $i', atMs: 1000 + i, kind: TaskStepKind.act),
      ),
    );

void main() {
  late Directory tmp;
  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('task-state-test');
  });
  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  group('TaskSnapshot JSON 往返', () {
    test('字段逐一对得上（含 pendingApproval 与 floating）', () {
      final s = TaskSnapshot(
        phase: TaskPhase.awaitingApproval,
        taskId: 'local-42',
        source: TaskSource.local,
        stepIndex: 3,
        totalSteps: 15,
        lastAction: '等待批准 vision_tap（目标：搜索框）',
        thinkingHint: '比较两种方案的优缺点',
        startedAtMs: 111,
        updatedAtMs: 222,
        steps: [
          const TaskStepRecord(
              text: '调用 vision_tap', atMs: 333, kind: TaskStepKind.act),
          const TaskStepRecord(
              text: 'vision_tap 已回报（已验证）', atMs: 444, kind: TaskStepKind.result),
        ],
        pendingApproval: const PendingApprovalInfo(
            id: 'ov-1', tool: 'vision_tap', target: '搜索框'),
        lastResultExcerpt: '',
        errorMessage: '',
        lastScreenshotPath: '/docs/floating/screenshots/shot-9.png',
        floatingEnabled: true,
      );
      final back = TaskSnapshot.parseJsonText(jsonEncode(s.toJson()));
      expect(back.phase, TaskPhase.awaitingApproval);
      expect(back.taskId, 'local-42');
      expect(back.source, TaskSource.local);
      expect(back.stepIndex, 3);
      expect(back.totalSteps, 15);
      expect(back.lastAction, s.lastAction);
      expect(back.thinkingHint, s.thinkingHint);
      expect(back.startedAtMs, 111);
      expect(back.updatedAtMs, 222);
      expect(back.steps, hasLength(2));
      expect(back.steps[0].kind, TaskStepKind.act);
      expect(back.steps[1].kind, TaskStepKind.result);
      expect(back.pendingApproval?.id, 'ov-1');
      expect(back.pendingApproval?.tool, 'vision_tap');
      expect(back.pendingApproval?.target, '搜索框');
      expect(back.lastScreenshotPath, '/docs/floating/screenshots/shot-9.png',
          reason: '缩略图路径是 Kotlin 侧 ImageView 与副屏 Image.file 的输入');
      expect(back.floatingEnabled, isTrue);
    });

    test('lastScreenshotPath 缺省为空串、旧快照没有该字段也能读', () {
      expect(const TaskSnapshot(phase: TaskPhase.idle).lastScreenshotPath, '');
      // 旧版本文件（补丁前写的）没有这个键：读回空，不抛。
      final back = TaskSnapshot.parseJsonText('{"phase":"acting","taskId":"t"}');
      expect(back.lastScreenshotPath, '');
      expect(back.phase, TaskPhase.acting);
    });

    test('wire 名稳定：phase/kind/source 的 JSON 值是消费方认的那个', () {
      // Kotlin 侧按字符串判：'idle' 收起、'floating' 门。改名 = 静默断链。
      expect(TaskPhase.idle.wire, 'idle');
      expect(TaskPhase.awaitingApproval.wire, 'awaiting_approval');
      expect(TaskStepKind.result.wire, 'result');
      expect(TaskSource.wechat.wire, 'wechat');
      expect(TaskSource.wechat.label, '微信');
    });

    test('坏输入不抛，回 idle 缺省', () {
      expect(TaskSnapshot.fromJson('not-a-map').phase, TaskPhase.idle);
      expect(TaskSnapshot.fromJson(null).phase, TaskPhase.idle);
      // 坏 JSON 的兜底在 store.read() 一层（catch 后回 null），见下面那组。
    });

    test('idle 工厂保留 steps 与结果摘录、清 pendingApproval', () {
      final running = snapshotWithSteps(2).copyWithStepsForTest(
        lastResultExcerpt: '热搜1；热搜2',
        errorMessage: '',
      );
      final idle = TaskSnapshot.idle(from: running, nowMs: 9999);
      expect(idle.phase, TaskPhase.idle);
      expect(idle.steps, hasLength(2));
      expect(idle.lastResultExcerpt, '热搜1；热搜2');
      expect(idle.pendingApproval, isNull);
      expect(idle.updatedAtMs, 9999);
    });
  });

  group('TaskStateStore 原子写', () {
    test('写后无 .tmp 残留、读回一致', () {
      final store = TaskStateStore(
          File('${tmp.path}/floating/${TaskStateStore.fileName}'));
      expect(store.write(snapshotWithSteps(3)), isTrue);
      expect(
          tmp.listSync(recursive: true).whereType<File>().map((f) => f.path),
          everyElement(endsWith('.json')),
          reason: '原子写不允许把 .tmp 留在总线上——Kotlin 每秒读它');
      final back = store.read();
      expect(back?.phase, TaskPhase.acting);
      expect(back?.steps, hasLength(3));
    });

    test('缺目录自动建；坏文件读回 null 不抛', () {
      final store = TaskStateStore(
          File('${tmp.path}/a/b/c/${TaskStateStore.fileName}'));
      expect(store.write(const TaskSnapshot(phase: TaskPhase.idle)), isTrue);
      store.file.writeAsStringSync('not json');
      expect(store.read(), isNull);
      expect(store.read(), isNull, reason: '连续读也不抛');
    });

    test('读不存在的文件回 null（悬浮窗据此不画）', () {
      final store = TaskStateStore(File('${tmp.path}/none.json'));
      expect(store.read(), isNull);
    });
  });
}

extension on TaskSnapshot {
  TaskSnapshot copyWithStepsForTest(
      {String? lastResultExcerpt, String? errorMessage}) {
    return TaskSnapshot(
      phase: phase,
      taskId: taskId,
      source: source,
      stepIndex: stepIndex,
      totalSteps: totalSteps,
      lastAction: lastAction,
      thinkingHint: thinkingHint,
      startedAtMs: startedAtMs,
      updatedAtMs: updatedAtMs,
      steps: steps,
      pendingApproval: pendingApproval,
      lastResultExcerpt: lastResultExcerpt ?? this.lastResultExcerpt,
      errorMessage: errorMessage ?? this.errorMessage,
      floatingEnabled: floatingEnabled,
    );
  }
}
