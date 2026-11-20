import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/audit_log.dart';
import 'package:khy_os_client/core/vfs/ai_plan.dart';
import 'package:khy_os_client/core/vfs/local_intent_parser.dart';
import 'package:khy_os_client/core/vfs/vfs_context.dart';
import 'package:khy_os_client/ui/theme/app_theme.dart';
import 'package:khy_os_client/ui/widgets/vfs/vfs_ai_sheet.dart';

/// AI 操作计划的「可编辑 / 逐步执行」。
///
/// 目标原文：「AI 生成的脚本、命令、操作序列均可**编辑**、拆解、逐步执行，不强制
/// 黑盒运行」。这一层管前两件里缺的那两件：
///   - 「编辑」= [AiPlanEditor]（改一项的路径 / 名字）；
///   - 「逐步执行」= [AiPlanExecutor.executeOne]（一条一条来，结果当场可见）。
/// 「拆解」已经有了——高危项默认不勾、逐项勾选。
///
/// 最要紧的一条约束：**编辑后的值走与生成时同一套校验**。用户改路径不能绕过
/// 护栏，否则「可编辑」就变成了「可绕过」。
void main() {
  AiOperationPlan copyPlan() =>
      LocalIntentParser.parse('复制 /sdcard/a.txt 到 /sdcard/b.txt').plan;

  AiOperationPlan renamePlan() =>
      LocalIntentParser.parse('把 /sdcard/a.txt 重命名为 b.txt').plan;

  AiOperationPlan deletePlan() =>
      LocalIntentParser.parse('删除 /sdcard/a.txt').plan;

  group('编辑计划里的一项', () {
    test('改目标路径：那一项变了，描述跟着变，原计划不动', () {
      final plan = copyPlan();
      final edited = AiPlanEditor.edit(plan, 'op1', targetPath: '/sdcard/c.txt');
      expect(edited.ok, isTrue);

      final op = edited.plan!.operations.first;
      // 归一化与解码器同款：/sdcard 与 /storage/emulated/0 是同一片地方。
      expect(op.targetPath, '/storage/emulated/0/c.txt');
      expect(op.title, contains('/storage/emulated/0/c.txt'),
          reason: '描述必须跟着改，否则界面显示的还是旧路径——那是撒谎');
      expect(plan.operations.first.targetPath, '/storage/emulated/0/b.txt', reason: '计划是不可变的：原计划记录着「AI 原本提议什么」，不能被改没');
    });

    test('改源路径：源与描述一起变', () {
      final plan = copyPlan();
      final edited = AiPlanEditor.edit(plan, 'op1', sourcePath: '/sdcard/other.txt');
      expect(edited.ok, isTrue);
      expect(edited.plan!.operations.first.sourcePath, '/storage/emulated/0/other.txt');
      expect(edited.plan!.operations.first.title, contains('/storage/emulated/0/other.txt'));
    });

    test('越界路径被拒，并给出理由', () {
      final edited = AiPlanEditor.edit(
        copyPlan(),
        'op1',
        targetPath: '/sdcard/../data/data',
      );
      expect(edited.ok, isFalse);
      expect(edited.plan, isNull);
      expect(edited.error, isNotEmpty);
    });

    test('写到系统分区被拒', () {
      final edited = AiPlanEditor.edit(
        copyPlan(),
        'op1',
        targetPath: '/system/app/evil',
      );
      expect(edited.ok, isFalse);
      expect(edited.error, isNotEmpty);
    });

    test('重命名的新名字不能带路径分隔符', () {
      final edited = AiPlanEditor.edit(renamePlan(), 'op1', targetPath: 'x/y.txt');
      expect(edited.ok, isFalse);
      expect(edited.error, isNotEmpty);
    });

    test('删除类操作改到系统分区被拒', () {
      final edited = AiPlanEditor.edit(
        deletePlan(),
        'op1',
        sourcePath: '/system/app/foo',
      );
      expect(edited.ok, isFalse);
    });

    test('编辑不存在的项给出理由', () {
      final edited = AiPlanEditor.edit(copyPlan(), 'op99', targetPath: '/sdcard/x');
      expect(edited.ok, isFalse);
      expect(edited.error, contains('不在当前计划'));
    });

    test('空值被拒', () {
      expect(AiPlanEditor.edit(copyPlan(), 'op1', targetPath: '  ').ok, isFalse);
    });

    test('编辑后的风险等级按新路径重算', () {
      // 往私有目录写 → 高危；往公共存储写 → 只是「需确认」。
      final plan = copyPlan();
      final toPrivate = AiPlanEditor.edit(plan, 'op1', targetPath: '/data/data/com.foo/f');
      expect(toPrivate.ok, isTrue);
      expect(toPrivate.plan!.operations.first.risk, AiRisk.destructive);
      final toPublic = AiPlanEditor.edit(plan, 'op1', targetPath: '/sdcard/f');
      expect(toPublic.plan!.operations.first.risk, AiRisk.caution);
    });
  });

  group('单条执行（逐步执行）', () {
    AiOperation op(String id) => AiOperation(
          id: id,
          kind: AiOpKind.copy,
          sourcePath: '/sdcard/$id.txt',
          targetPath: '/sdcard/$id-copy.txt',
          risk: AiRisk.safe,
          title: '测试 $id',
        );

    test('executeOne 只跑那一项', () async {
      final ran = <String>[];
      final result = await AiPlanExecutor.executeOne(
        op('op1'),
        runner: (AiOperation o) async => ran.add(o.id),
      );
      expect(ran, <String>['op1']);
      expect(result.ok, isTrue);
      expect(result.operationId, 'op1');
    });

    test('失败要带原因，不能只说「失败了」', () async {
      final result = await AiPlanExecutor.executeOne(
        op('op1'),
        runner: (AiOperation o) async => throw StateError('目标已存在'),
      );
      expect(result.ok, isFalse);
      expect(result.message, contains('目标已存在'));
    });

    test('批量执行只跑勾选的', () async {
      final plan = AiOperationPlan(operations: <AiOperation>[op('op1'), op('op2')]);
      final ran = <String>[];
      final result = await AiPlanExecutor.execute(
        plan,
        selectedIds: <String>{'op2'},
        runner: (AiOperation o) async => ran.add(o.id),
      );
      expect(ran, <String>['op2']);
      expect(result.steps, hasLength(1));
      expect(result.steps.first.operationId, 'op2');
    });

    test('批量里某一项失败，其余照常跑完', () async {
      final plan = AiOperationPlan(operations: <AiOperation>[op('op1'), op('op2')]);
      final ran = <String>[];
      final result = await AiPlanExecutor.execute(
        plan,
        selectedIds: <String>{'op1', 'op2'},
        runner: (AiOperation o) async {
          ran.add(o.id);
          if (o.id == 'op1') throw StateError('源不存在');
        },
      );
      expect(ran, <String>['op1', 'op2'], reason: '一项失败不该把后面的项一起掐掉');
      expect(result.failedCount, 1);
      expect(result.allOk, isFalse);
      expect(result.steps.first.message, contains('源不存在'));
    });

    test('不注入执行器时，默认路径真的打到 VFS 通道', () async {
      // 为什么要有这一条：面板为了能被 widget 测试测，给执行器留了注入缝隙。
      // 缝隙一旦顶替了生产行为（「面板里跑的不是真 VFS」），面板测试照样全绿——
      // 绿着骗人更糟。所以这里从**通道**那一侧验：默认路径必须真的发出调用。
      final calls = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
        const MethodChannel('com.khyos.khy_os_client/vfs'),
        (MethodCall call) async {
          calls.add(call.method);
          return <String, dynamic>{'ok': true};
        },
      );
      final tmp = Directory.systemTemp.createTempSync('khy_ai_plan_default');
      AuditLog.useDirectoryForTest(tmp);
      addTearDown(() {
        AuditLog.useDirectoryForTest(null);
        try {
          tmp.deleteSync(recursive: true);
        } catch (_) {}
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(
          const MethodChannel('com.khyos.khy_os_client/vfs'),
          null,
        );
      });

      final result = await AiPlanExecutor.executeOne(op('op1'));
      expect(result.ok, isTrue, reason: '默认路径要把操作真跑掉，不能只是返回成功');
      expect(calls, contains('copy'),
          reason: '默认路径必须打到 VFS 通道——注入缝隙不能顶替生产行为');
    });
  });

  group('面板上的「改」与「只执行这一条」', () {
    /// 把视口设成手机那种高瘦比。
    ///
    /// 为什么：默认 800×600 装不下这个面板的内容，会直接抛布局溢出——那不是被测
    /// 行为，是测试环境不对。真机是 1200×2670。
    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1200, 2670);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
    }

    /// 把 VFS 通道假成「什么都成功」。
    ///
    /// 为什么：单测环境里原生通道没有实现，调用**不会立刻失败**——请求发出去没人
    /// 回，面板就一直转圈（`_busy` 降不下来），`pumpAndSettle` 直接超时。
    /// 这里要测的是**面板的接线**（点一下有没有结果），不是原生 IO。
    void mockVfsChannel() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
        const MethodChannel('com.khyos.khy_os_client/vfs'),
        (MethodCall call) async => <String, dynamic>{'ok': true},
      );
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(
          const MethodChannel('com.khyos.khy_os_client/vfs'),
          null,
        );
      });
    }

    /// 造一个面板，执行器用注入的替身。
    ///
    /// 为什么必须注入：真实路径会落到审计落盘（真实文件 I/O），而 widget 测试跑在
    /// fake async 里——真实文件 I/O 不推进，执行永远不返回、进度圈永远转，测试只能
    /// 等到超时（实测 2 分 07 秒才超时）。那不是被测行为，是测试环境不对。
    Widget buildSheet(WidgetTester tester, AiOperationRunner runner) {
      return MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: VfsAiSheet(
            context: const VfsContext(currentPath: '/sdcard'),
            runner: runner,
          ),
        ),
      );
    }

    /// 走完全离线的本地解析，出一份「复制 a.txt 到 b.txt」的计划。
    Future<void> generateCopyPlan(WidgetTester tester) async {
      await tester.tap(find.text('只用本地解析（不联网）'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField).first,
        '复制 /sdcard/a.txt 到 /sdcard/b.txt',
      );
      await tester.tap(find.text('生成操作计划'));
      await tester.pumpAndSettle();
    }

    testWidgets('能只执行这一条，结果就地显示', (WidgetTester tester) async {
      usePhoneViewport(tester);
      mockVfsChannel();
      final ran = <String>[];
      await tester.pumpWidget(
        buildSheet(tester, (AiOperation o) async => ran.add(o.id)),
      );

      await generateCopyPlan(tester);

      expect(find.textContaining('复制'), findsWidgets);
      expect(find.byTooltip('只执行这一条'), findsOneWidget);
      expect(find.byTooltip('改这一项'), findsOneWidget);

      await tester.tap(find.byTooltip('只执行这一条'));
      await tester.pumpAndSettle();

      // 真机上这一步要么成功、要么失败带原因——两种都要**看得见**。
      final shown = find.textContaining('已执行').evaluate().isNotEmpty ||
          find.textContaining('执行失败').evaluate().isNotEmpty;
      expect(shown, isTrue, reason: '单条执行完必须就地给出结果，不能悄悄发生');
      expect(ran, hasLength(1), reason: '「只执行这一条」只能跑那一条，不能顺手把整批都跑了');
    });

    testWidgets('单条执行失败时也要看得见原因', (WidgetTester tester) async {
      usePhoneViewport(tester);
      mockVfsChannel();
      await tester.pumpWidget(
        buildSheet(tester, (AiOperation o) async => throw StateError('目标已存在')),
      );

      await generateCopyPlan(tester);
      await tester.tap(find.byTooltip('只执行这一条'));
      await tester.pumpAndSettle();

      expect(find.textContaining('执行失败'), findsWidgets,
          reason: '失败必须带原因，不能只说「失败了」');
      expect(find.textContaining('目标已存在'), findsWidgets);
    });

    testWidgets('单条跑过的项，批量执行时不再跑一遍', (WidgetTester tester) async {
      usePhoneViewport(tester);
      mockVfsChannel();
      final ran = <String>[];
      await tester.pumpWidget(
        buildSheet(tester, (AiOperation o) async => ran.add(o.id)),
      );

      await generateCopyPlan(tester);
      // 复制是「需确认」级，生成时**默认不勾**——逐项确认要真的逐项。
      await tester.tap(find.textContaining('复制「'));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('只执行这一条'));
      await tester.pumpAndSettle();
      expect(ran, hasLength(1));

      // 批量按钮上的数字取的是「还没跑过的项数」：这一项已经跑过，所以是 0。
      expect(find.text('执行选中的 0 项'), findsOneWidget,
          reason: '按钮上的数字必须是没跑过的项数——写着总数就是在骗人');
      await tester.tap(find.text('执行选中的 0 项'));
      await tester.pumpAndSettle();
      expect(ran, hasLength(1),
          reason: '已经跑过的那一项不能被批量再跑一遍——复制两遍是用户最不愿意看到的结果');
    });

    testWidgets('「改这一项」打开对话框，改完清单跟着变', (WidgetTester tester) async {
      usePhoneViewport(tester);
      mockVfsChannel();
      await tester.pumpWidget(
        buildSheet(tester, (AiOperation o) async {}),
      );

      await generateCopyPlan(tester);

      await tester.tap(find.byTooltip('改这一项'));
      await tester.pumpAndSettle();
      expect(find.text('改这一项'), findsOneWidget);

      final targetField = find.widgetWithText(TextField, '目标路径');
      expect(targetField, findsOneWidget);
      await tester.enterText(targetField, '/sdcard/c.txt');
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();

      expect(find.textContaining('/storage/emulated/0/c.txt'), findsWidgets,
          reason: '改完的清单要显示新路径');
    });

    testWidgets('改到不安全的地方会被挡下，并说清理由', (WidgetTester tester) async {
      usePhoneViewport(tester);
      mockVfsChannel();
      await tester.pumpWidget(
        buildSheet(tester, (AiOperation o) async {}),
      );

      await generateCopyPlan(tester);
      await tester.tap(find.byTooltip('改这一项'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextField, '目标路径'),
        '/system/app/evil',
      );
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();

      // 校验没过就留在对话框里，把理由摆出来——关掉再让人重开是添乱。
      expect(find.text('改这一项'), findsOneWidget);
      expect(find.textContaining('写操作'), findsWidgets,
          reason: '被挡下时必须说清为什么，不能只说「不行」');
    });
  });
}
