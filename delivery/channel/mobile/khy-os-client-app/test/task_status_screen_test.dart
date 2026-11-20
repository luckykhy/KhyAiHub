// TaskStatusScreen widget 测试：fake feed 注入，不碰 FloatingTaskHub、
// 不碰 path_provider。spinner 是永转动画——断言用 pump 定帧，不用
// pumpAndSettle（那要等动画停，等不到）。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/floating/floating_status_controller.dart';
import 'package:khy_os_client/core/floating/task_state.dart';
import 'package:khy_os_client/ui/screens/task_status_screen.dart';

class FakeFeed implements TaskStateFeed {
  final controller = StreamController<TaskSnapshot>.broadcast();

  @override
  Stream<TaskSnapshot> get stream => controller.stream;

  void emit(TaskSnapshot s) => controller.add(s);
}

/// 1x1 PNG：Image.file 要的是真可解的图，不是占位字节。
const _tinyPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

Future<void> pumpScreen(WidgetTester tester, FakeFeed feed,
    {Future<String> Function(String)? onSubmit,
    Future<bool> Function(String, bool)? onApproval}) async {
  await tester.pumpWidget(MaterialApp(
    home: TaskStatusScreen(feed: feed, onSubmit: onSubmit, onApproval: onApproval),
  ));
  await tester.pump();
}

void main() {
  late Directory tmp;
  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('task-status-screen-test');
  });
  tearDown(() {
    // Image.file 的在途真实读取偶尔仍攥着文件句柄（Windows 上句柄没关就
    // 删不掉）——尽力删，删不掉留给系统清 %TEMP%，不影响断言。
    try {
      if (tmp.existsSync()) tmp.deleteSync(recursive: true);
    } on FileSystemException {
      // 留待系统清理。
    }
  });

  testWidgets('acting：手搓 spinner 与 第 n/N 步可见', (tester) async {
    final feed = FakeFeed();
    await pumpScreen(tester, feed);
    feed.emit(const TaskSnapshot(
      phase: TaskPhase.acting,
      taskId: 'local-1',
      source: TaskSource.local,
      stepIndex: 3,
      totalSteps: 15,
      lastAction: '调用 fetch_hot_list（已处理 3/15 步）',
      startedAtMs: 1,
      updatedAtMs: 2,
    ));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('第 3/15 步'), findsOneWidget);
    expect(find.byType(CustomPaint), findsWidgets,
        reason: 'spinner 是 AnimationController + CustomPaint，不引第三方包');
  });

  testWidgets('收尾后：输入可用、停止按钮禁用、结果展示', (tester) async {
    final feed = FakeFeed();
    await pumpScreen(tester, feed);
    feed.emit(const TaskSnapshot(
      phase: TaskPhase.idle,
      taskId: 'local-2',
      source: TaskSource.local,
      lastResultExcerpt: '热搜1；热搜2',
    ));
    await tester.pumpAndSettle();
    expect(find.text('热搜1；热搜2'), findsOneWidget);
    expect(
        tester.widget<TextField>(find.byKey(const Key('task-input'))).enabled,
        isTrue);
    expect(
        tester
            .widget<IconButton>(find.byKey(const Key('task-submit')))
            .onPressed,
        isNotNull);
    expect(
        tester
            .widget<TextButton>(find.byKey(const Key('task-stop')))
            .onPressed,
        isNull,
        reason: '没有任务时停止按钮不可用');
    expect(find.textContaining('放弃等待'), findsOneWidget,
        reason: '停止的诚实语义直接写在按钮文案里');
  });

  testWidgets('pendingApproval：批准/拒绝按钮出现并回传决策', (tester) async {
    final feed = FakeFeed();
    final decisions = <String>[];
    await pumpScreen(
        tester,
        feed,
        onApproval: (id, allow) async {
          decisions.add('$id:$allow');
          return true;
        },
        onSubmit: (t) async => '');
    feed.emit(const TaskSnapshot(
      phase: TaskPhase.awaitingApproval,
      taskId: 'local-3',
      source: TaskSource.local,
      pendingApproval:
          PendingApprovalInfo(id: 'ov-42', tool: 'vision_tap', target: '搜索框'),
    ));
    // awaitingApproval 也画 spinner（永转动画）——不能用 pumpAndSettle。
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.textContaining('vision_tap'), findsWidgets);
    expect(find.textContaining('120 秒'), findsOneWidget,
        reason: '超时自动拒必须提前说清');

    await tester.tap(find.byKey(const Key('approval-allow')));
    await tester.pump(const Duration(milliseconds: 100));
    expect(decisions, ['ov-42:true']);
  });

  testWidgets('screenshot：文件在时渲染，缺失时占位不崩', (tester) async {
    final feed = FakeFeed();
    final shot = File('${tmp.path}/shot-1.png');
    // 真实文件 IO 在测试 binding 的 fake-async 区里要用 runAsync 走真钟，
    // 否则完成回调永远不来，await 就挂在 10 分钟超时上。
    await tester.runAsync(() async {
      await shot.writeAsBytes(base64Decode(_tinyPngBase64));
    });
    await pumpScreen(tester, feed, onSubmit: (t) async => '');

    feed.emit(TaskSnapshot(
      phase: TaskPhase.acting,
      taskId: 'local-4',
      source: TaskSource.local,
      stepIndex: 1,
      totalSteps: 15,
      lastAction: '调用 vision_tap',
      startedAtMs: 1,
      updatedAtMs: 2,
      lastScreenshotPath: shot.path,
    ));
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('当前画面'), findsOneWidget);
    expect(find.byType(Image), findsOneWidget);

    // 5 张清理把文件删了：真实读取失败 → errorBuilder 摆占位，页面不崩。
    feed.emit(TaskSnapshot(
      phase: TaskPhase.acting,
      taskId: 'local-4',
      source: TaskSource.local,
      stepIndex: 1,
      totalSteps: 15,
      lastAction: '调用 vision_tap',
      startedAtMs: 1,
      updatedAtMs: 3,
      lastScreenshotPath: '${tmp.path}/gone.png',
    ));
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 150));
    });
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('截图还在路上（或已被清出保留窗口）'), findsOneWidget);

    // 收尾前给真钟留一拍，让在途的真实图片读取跑完、句柄落地，
    // 否则 tearDown 删临时目录会撞锁（Windows）。
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pump(const Duration(milliseconds: 50));
  });

  testWidgets('提交走注入的 onSubmit，拒绝文案就地显示', (tester) async {
    final feed = FakeFeed();
    final submitted = <String>[];
    await pumpScreen(
        tester,
        feed,
        onSubmit: (t) async {
          submitted.add(t);
          return '已有任务在跑：慢任务A';
        },
        onApproval: (id, allow) async => true);
    // 通知条渲染在快照列表里：App 真路径下状态层启动即写 idle，这里对齐。
    feed.emit(const TaskSnapshot(
      phase: TaskPhase.idle,
      taskId: '',
      source: TaskSource.local,
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('task-input')), '打开抖音');
    await tester.tap(find.byKey(const Key('task-submit')));
    await tester.pumpAndSettle();
    expect(submitted, ['打开抖音']);
    expect(find.text('已有任务在跑：慢任务A'), findsOneWidget,
        reason: '锁冲突的拒绝不能静默——就地给用户看');
    expect(find.text('打开抖音'), findsOneWidget,
        reason: '被拒的输入不清空，用户不用重打');
  });
}
