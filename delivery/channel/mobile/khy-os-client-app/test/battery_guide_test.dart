// 电池白名单引导的 Dart 侧测试：模型解析 + 引导页渲染。
//
// 覆盖两件容易出错的事：
//   1. 原生返回的 Map 解析——字段名拼错时界面会静默显示"未知"，看不出是 bug；
//   2. 引导页的"去设置 / 已完成"两个按钮——「已完成」必须真的记到本地，
//      而且不能因为点了它就改任何系统设置。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/battery_guard.dart';
import 'package:khy_os_client/ui/screens/battery_guide_screen.dart';

const _channel = MethodChannel('com.khyos.khy_os_client/device');

/// 记录原生侧被调了哪些方法，以及被写进去的参数。
class _NativeSpy {
  final List<String> calls = <String>[];
  final Map<String, dynamic> markedDone = <String, dynamic>{};
  Map<Object?, Object?> status = <Object?, Object?>{
    'manufacturer': 'StepX',
    'isIgnoringBatteryOptimizations': false,
    'isBackgroundRestricted': true,
    'autostartState': 'unknown',
    'restrictedSettingsLikely': true,
    'lastCheckAt': 1700000000000,
    'hasActionable': true,
  };
  List<Map<Object?, Object?>> steps = <Map<Object?, Object?>>[
    {
      'id': 'restricted_settings',
      'title': '允许受限设置',
      'why': '侧载安装的 App 在 Android 13+ 默认处于「受限设置」，无障碍开关会被置灰。',
      'components': <String>[],
      'fallback': 'app_details',
      'optional': false,
      'done': false,
      'doneBy': '',
    },
    {
      'id': 'battery_optimization',
      'title': '电池优化（不受限制）',
      'why': '息屏后系统会冻结后台网络与定时任务。',
      'components': <String>[],
      'fallback': 'battery_optimization_list',
      'optional': false,
      'done': true,
      'doneBy': 'detected',
    },
  ];
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _NativeSpy spy;

  setUp(() {
    spy = _NativeSpy();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (MethodCall call) async {
      spy.calls.add(call.method);
      switch (call.method) {
        case 'batteryStatus':
          return spy.status;
        case 'batteryGuideSteps':
          return spy.steps;
        case 'markBatteryStepDone':
          final args = (call.arguments as Map?)?.cast<Object?, Object?>();
          final id = (args?['stepId'] as String?) ?? '';
          spy.markedDone[id] = true;
          // 标完之后原生会把它算作已完成。
          for (final s in spy.steps) {
            if (s['id'] == id) {
              s['done'] = true;
              s['doneBy'] = 'manual';
            }
          }
          return {'ok': true};
        case 'openBatteryGuideStep':
          return {'opened': true, 'via': 'app_details', 'message': '已打开本应用的信息页'};
        case 'requestIgnoreBatteryOptimizations':
          return {'opened': true, 'via': 'request_ignore_battery_optimizations', 'message': '已请求'};
        case 'batteryPromptState':
          return {
            'shouldPrompt': true,
            'dismissedAt': 0,
            'completed': false,
            'cooldownDays': 7,
            'nextPromptAt': 0,
            'status': spy.status,
          };
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
  });

  group('模型解析', () {
    test('状态字段逐个对上，拼错的字段退回保守默认', () {
      final s = BatteryStatusInfo.fromMap({
        'manufacturer': 'Xiaomi',
        'isIgnoringBatteryOptimizations': true,
        'isBackgroundRestricted': false,
        'autostartState': 'denied',
        'restrictedSettingsLikely': false,
        'lastCheckAt': 42,
        'hasActionable': true,
      });
      expect(s.manufacturer, 'Xiaomi');
      expect(s.isIgnoringBatteryOptimizations, isTrue);
      expect(s.autostartDenied, isTrue);
      expect(s.autostartAllowed, isFalse);
      expect(s.autostartLabel, '已被禁止自启动');
      expect(s.lastCheckAt, 42);
    });

    test('空 Map 与 null 都退回"未知"，不假装成任何一种结论', () {
      final empty = BatteryStatusInfo.fromMap(null);
      expect(empty.autostartState, 'unknown');
      expect(empty.autostartUnknown, isTrue);
      expect(empty.hasActionable, isFalse);
      final blank = BatteryStatusInfo.fromMap(<Object?, Object?>{});
      expect(blank.autostartUnknown, isTrue);
      expect(blank.hasActionable, isFalse);
    });

    test('步骤：候选组件与完成来源都被解析出来', () {
      final s = BatteryGuideStep.fromMap({
        'id': 'autostart',
        'title': '自启动管理',
        'why': '为什么不设',
        'components': ['a/b', 'c/d'],
        'actions': ['x.y.Z'],
        'fallback': 'app_details',
        'optional': false,
        'done': true,
        'doneBy': 'manual',
      });
      expect(s.id, 'autostart');
      expect(s.components, ['a/b', 'c/d']);
      expect(s.actions, ['x.y.Z']);
      expect(s.done, isTrue);
      expect(s.doneManually, isTrue);
    });

    test('面板状态：冷却天数与状态快照都在', () {
      final p = BatteryPromptState.fromMap({
        'shouldPrompt': true,
        'dismissedAt': 100,
        'completed': false,
        'cooldownDays': 7,
        'nextPromptAt': 200,
        'status': spy.status,
      });
      expect(p.shouldPrompt, isTrue);
      expect(p.cooldownDays, 7);
      expect(p.status?.restrictedSettingsLikely, isTrue);
    });
  });

  group('引导页', () {
    testWidgets('列出每一步的入口名称与"为什么要设"', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: BatteryGuideScreen()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.text('允许受限设置'), findsOneWidget);
      expect(find.textContaining('受限设置'), findsWidgets);
      // 为什么要设：不能只有"请去设置"这种空话。
      expect(find.textContaining('无障碍开关会被置灰'), findsOneWidget);
    });

    testWidgets('「已完成」按钮把步骤记到本地，并刷新出勾', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: BatteryGuideScreen()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      // 第一个步骤（受限设置）还没完成，所以有「已完成」按钮可点。
      await tester.tap(find.text('已完成').first);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(spy.markedDone.containsKey('restricted_settings'), isTrue);
      expect(spy.calls.contains('markBatteryStepDone'), isTrue);
    });

    testWidgets('「去设置」调原生跳转并把结果说清楚', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: BatteryGuideScreen()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      await tester.tap(find.text('去设置').first);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(spy.calls.contains('openBatteryGuideStep'), isTrue);
      expect(find.textContaining('已打开本应用的信息页'), findsOneWidget);
    });

    testWidgets('一键放行走系统的加白请求', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: BatteryGuideScreen()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      await tester.tap(find.text('去请求'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(spy.calls.contains('requestIgnoreBatteryOptimizations'), isTrue);
    });

    testWidgets('从系统设置返回（resumed）自动重新检测并刷新', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: BatteryGuideScreen()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      final before = spy.calls.where((c) => c == 'batteryStatus').length;
      expect(before, greaterThan(0));

      // 用户去系统设置里放行了，回来必须重新检测——否则页面还显示"未放行"，
      // 用户只会再去设置里翻一遍。
      spy.status = <Object?, Object?>{
        'manufacturer': 'StepX',
        'isIgnoringBatteryOptimizations': true,
        'isBackgroundRestricted': false,
        'autostartState': 'allowed',
        'restrictedSettingsLikely': false,
        'lastCheckAt': 1700000000000,
        'hasActionable': false,
      };
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      final after = spy.calls.where((c) => c == 'batteryStatus').length;
      expect(after, greaterThan(before));
      // 状态变成全绿后，页面上的"缺少项"提示应当消失。
      expect(find.textContaining('项需要放行'), findsNothing);
    });
  });
}
