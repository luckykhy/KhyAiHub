import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/amoo_chat_service.dart';
import 'package:khy_os_client/ui/screens/device_screen_new.dart';
import 'package:khy_os_client/ui/widgets/amoo_composer.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');
  final calls = <MethodCall>[];

  void mockChannel(Object? Function(MethodCall call) handler) {
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return handler(call);
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  Widget host({String initialText = ''}) {
    return MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (ctx) => Center(
            child: ElevatedButton(
              onPressed: () => showAmooComposer(ctx, initialText: initialText),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('composer：空/空白输入禁用；只有点击才发送；结果不承诺送达', (tester) async {
    mockChannel((call) {
      if (call.method == 'amooStatus') {
        return {
          'installed': true,
          'canShare': true,
          'canOpenChat': true,
          'versionName': '1.0',
        };
      }
      if (call.method == 'sendToAmoo') {
        return {
          'ok': true,
          'via': 'direct',
          'truncated': false,
          'message': '已交给 amoo 分享页（未确认送达）',
        };
      }
      return <String, Object?>{};
    });

    await tester.pumpWidget(host());
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    FilledButton button() => tester.widget<FilledButton>(find.byType(FilledButton));
    expect(button().onPressed, isNull, reason: '空输入应禁用');

    await tester.enterText(find.byType(TextField), '   ');
    await tester.pump();
    expect(button().onPressed, isNull, reason: '纯空白应禁用');
    expect(calls.where((c) => c.method == 'sendToAmoo'), isEmpty);

    await tester.enterText(find.byType(TextField), '你好 amoo');
    await tester.pump();
    expect(button().onPressed, isNotNull);

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();

    final sent = calls.where((c) => c.method == 'sendToAmoo').toList();
    expect(sent.length, 1);
    expect((sent.single.arguments as Map)['text'], '你好 amoo');
    expect(find.textContaining('未确认送达'), findsOneWidget);
  });

  testWidgets('composer：initialText 预填但不会自动发送', (tester) async {
    mockChannel((call) {
      if (call.method == 'amooStatus') {
        return {'installed': true, 'canShare': true, 'canOpenChat': true};
      }
      return <String, Object?>{};
    });
    await tester.pumpWidget(host(initialText: '预填内容'));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('预填内容'), findsOneWidget);
    expect(calls.where((c) => c.method == 'sendToAmoo'), isEmpty);
  });

  testWidgets('设备页 amoo 卡：显示解析结果，点击「分享」打开面板', (tester) async {
    mockChannel((call) {
      if (call.method == 'amooStatus') {
        return {
          'installed': true,
          'canShare': true,
          'canOpenChat': true,
          'versionName': '1.0',
        };
      }
      return <String, Object?>{};
    });

    await tester.pumpWidget(const MaterialApp(home: DeviceScreenNew()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('amoo'), findsOneWidget);
    expect(find.textContaining('启动未验证'), findsOneWidget);

    await tester.tap(find.text('分享'));
    await tester.pumpAndSettle();
    expect(find.text('分享到 amoo'), findsWidgets);

    // 释放设备页的 15s 轮询 Timer
    await tester.pumpWidget(const SizedBox());
  });

  test('源码契约：amoo 的四个入口由同一个判据 _amooAvailable 把守', () {
    final src = File('lib/ui/screens/chat_screen_new.dart').readAsStringSync();
    // 原断言「_quickBtn(Icons.forum_outlined, 'amoo' 恒在」已作废：Amoo 缺席时
    // 它是一个永远发不出去的入口，必须不渲染。
    expect(src.contains('bool _amooAvailable = false;'), isTrue);
    expect(src.contains('_amooAvailable = st.installed;'), isTrue,
        reason: '必须由 AmooService.status().installed 决定，unknown 按 false');
    expect(src.contains('if (_amooAvailable)'), isTrue);
    expect(src.contains("_quickBtn(Icons.forum_outlined, 'amoo'"), isTrue);
    expect(src.contains('showAmooComposer(context, initialText: _input.text)'), isTrue);
    expect(src.contains('SingleChildScrollView'), isTrue, reason: '快捷栏必须可横向滚动');
    // 目标切换在不可用时不能切：占位保留（布局不抖），onTap 置 null。
    expect(src.contains('onTap: _amooAvailable'), isTrue);
    // 探测回调里要把目标切回助手，且不能放在 build 里改 notifier。
    expect(src.contains('_chatTarget.value = ChatTarget.assistant;'), isTrue);
  });

  test('源码契约：消息列表 itemCount 与索引基准同步条件化', () {
    // 这条只能靠源码契约廉价守住，而它守的正是 RangeError 的根因。
    //
    // 漏改索引基准的后果不是「少一条」：Amoo 缺席时 i==0 会取 _msgs[-1]，
    // 而那条路径每次构建都走——整块 AI 页布不出来。
    //
    // 为什么不用 pump 型 widget 测试：ChatScreenNew 是 ConsumerStatefulWidget
    // （需要 ProviderScope），initState 还依次碰配置存储、会话库、系统分享通道、
    // addObserver，现有套件从未 pump 过它。见本轮方案对脚手架的说明。
    final src = File('lib/ui/screens/chat_screen_new.dart').readAsStringSync();
    expect(src.contains('(_amooAvailable ? 1 : 0)'), isTrue,
        reason: 'itemCount 必须把 amoo 卡那一格条件化');
    expect(src.contains('final j = i - (_amooAvailable ? 1 : 0);'), isTrue,
        reason: '索引基准必须与 itemCount 同步改，否则缺席时取 _msgs[-1]');
    expect(src.contains('if (_amooAvailable && i == 0)'), isTrue);
  });

  test('孤儿自愈：orphan_cleared 通道逐字透传原生原话', () async {
    // 这一条曾经只断源码里含 'orphan_cleared' 等三个字符串——那种契约连罐头
    // 消息冒充原话都拦不住：MainActivity 当时给的是自制句「上一笔提问已卡死并
    // 清理，重试即可」，failureDetail 照样非空、源码契约全绿，而用户永远看不到
    // 原生那句「单飞锁已自动释放，可重试」。
    //
    // 现在按真通道打：mock 原生层回 code=orphan_cleared + message，断言
    // failureDetail 交回来的就是 AmooLoop.healOrphanedAsk 写进 askError 的那句
    // 原话，逐字。句子真源在 AmooLoop.java 的 "orphaned_ask: …" 赋值处。
    const nativeWords = 'orphaned_ask: 上一笔提问超过最大预算仍未结束'
        '（无障碍 IPC 可能卡死），单飞锁已自动释放，可重试';
    mockChannel((call) {
      if (call.method == 'amooAsk') {
        return <String, Object?>{
          'ok': false,
          'code': 'orphan_cleared',
          'message': nativeWords,
        };
      }
      return <String, Object?>{};
    });

    final outcome = await AmooChatService.ask('上一笔卡死了吗');

    expect(outcome.ok, isFalse);
    expect(outcome.code, AmooAskFailure.orphanCleared);
    expect(outcome.failureDetail, nativeWords, reason: '必须是原生原话逐字');
    expect(outcome.failureDetail, isNot('上一笔提问已卡死并清理，重试即可'),
        reason: 'MainActivity 曾经的罐头消息不许再冒充原话');
  });

  test('孤儿自愈：桥侧 orphaned_ask 码走同一条透传', () async {
    // Tools.amooAsk 不回 orphan_cleared，直接回原生前缀 orphaned_ask。
    // 两个码必须同一句原话——漏一个就意味着同一种自愈在一条通道上有话可说，
    // 在另一条上被 Dart 兜底句顶替。
    const nativeWords = 'orphaned_ask: 上一笔提问超过最大预算仍未结束'
        '（无障碍 IPC 可能卡死），单飞锁已自动释放，可重试';
    mockChannel((call) {
      if (call.method == 'amooAsk') {
        return <String, Object?>{
          'ok': false,
          'code': 'orphaned_ask',
          'message': nativeWords,
        };
      }
      return <String, Object?>{};
    });

    final outcome = await AmooChatService.ask('桥侧通道');

    expect(outcome.code, AmooAskFailure.orphanCleared);
    expect(outcome.failureDetail, nativeWords);
  });

  test('孤儿自愈：原话缺席时才落到 Dart 兜底句', () async {
    // 透传是有条件的（message 非空），不是把兜底句写死。原生壳太旧、一个字节
    // 的原话都没给时，才用 Dart 自己那句——且要能看出它不是原话。
    mockChannel((call) {
      if (call.method == 'amooAsk') {
        return <String, Object?>{'ok': false, 'code': 'orphan_cleared'};
      }
      return <String, Object?>{};
    });

    final outcome = await AmooChatService.ask('老壳');

    expect(outcome.code, AmooAskFailure.orphanCleared);
    expect(outcome.failureDetail, AmooAskFailure.orphanCleared.hint);
    expect(outcome.failureDetail, isNot(contains('orphaned_ask')));
  });
}
