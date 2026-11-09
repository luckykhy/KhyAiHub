import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/screens/device_screen_new.dart';
import 'package:khy_os_client/ui/screens/settings_screen_new.dart';

/// 页签切回时必须重读「App 之外决定的状态」。
///
/// WHY THIS FILE EXISTS. `main.dart` hosts the four tabs in an `IndexedStack`,
/// which keeps every child alive and only repaints on switch — a State object
/// is never rebuilt, so `initState` runs exactly once per process. The
/// accessibility and screen-capture switches are decided OUTSIDE the app (the
/// system accessibility page, the MediaProjection grant), so they were only
/// re-read on `AppLifecycleState.resumed`.
///
/// Measured on the phone on 2026-10-27: with 无障碍服务 already enabled at the
/// OS level, the 设备 tab said 「已启用」 while the 设置 tab's switch still said
/// off — both screens call the same `DeviceControl.isAccessibilityReady()`. The
/// 设置 tab had simply been built earlier and never re-read. A toggle that
/// contradicts reality is worse than no toggle: the user taps it expecting
/// "off → on" and gets a confirmation dialog about writing a setting that is
/// already written.
///
/// The host now passes its tab index down as `visibleTick`, and each screen
/// re-reads in `didUpdateWidget` when it changes. These tests pin that, because
/// the failure mode is invisible in code review — nothing looks broken.
void main() {
  const channel = MethodChannel('com.khyos.khy_os_client/device');

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'isAccessibilityReady':
          return <String, Object?>{'ready': false};
        case 'isScreenCaptureReady':
          return <String, Object?>{'ready': false};
        case 'accessibilitySetupAdvice':
          return <String, Object?>{'advice': '一键需要 sidecar 或 Shizuku'};
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  /// 把无障碍服务的就绪态翻过来，模拟用户在别的页面/系统设置里开了它。
  void mockA11yReady(bool ready) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'isAccessibilityReady':
          return <String, Object?>{'ready': ready};
        case 'isScreenCaptureReady':
          return <String, Object?>{'ready': false};
        case 'accessibilitySetupAdvice':
          return <String, Object?>{'advice': '一键需要 sidecar 或 Shizuku'};
        default:
          return null;
      }
    });
  }

  Finder a11ySwitch() => find.byKey(const Key('a11y-switch'));

  /// 滚到「系统能力」区。要什么就滚到什么——见 accessibility_one_tap_test.dart
  /// 里对 ensureVisible 在「还没建出来」时会报错指错方向的说明。
  Future<void> scrollToSwitch(WidgetTester tester) async {
    for (var i = 0; i < 40 && !tester.any(a11ySwitch()); i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -350));
      await tester.pumpAndSettle();
    }
    expect(tester.any(a11ySwitch()), isTrue,
        reason: '滚了 40 次还没见到无障碍开关');
    await tester.ensureVisible(a11ySwitch());
    await tester.pumpAndSettle();
  }

  bool switchIsOn(WidgetTester tester) =>
      tester.widget<Switch>(a11ySwitch()).value;

  testWidgets('设置页：切回本页会重读，开关不再和现实反着', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: SettingsScreenNew(visibleTick: 0),
    ));
    await tester.pumpAndSettle();
    await scrollToSwitch(tester);
    expect(switchIsOn(tester), isFalse, reason: '初始 mock 就是关');

    // 用户在系统设置里把无障碍打开了（App 全程在前台，没有生命周期事件）。
    mockA11yReady(true);

    // 宿主页签索引变了 → 本页刚变成用户正在看的那一页。
    await tester.pumpWidget(const MaterialApp(
      home: SettingsScreenNew(visibleTick: 1),
    ));
    await tester.pumpAndSettle();

    expect(switchIsOn(tester), isTrue,
        reason: '切回设置页却没有重读，开关就会一直显示相反的答案');
  });

  testWidgets('设备页：切回本页同样重读', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: DeviceScreenNew(visibleTick: 3),
    ));
    await tester.pumpAndSettle();
    expect(find.textContaining('未启用'), findsOneWidget,
        reason: '初始 mock 就是关');

    mockA11yReady(true);

    await tester.pumpWidget(const MaterialApp(
      home: DeviceScreenNew(visibleTick: 2),
    ));
    await tester.pumpAndSettle();

    expect(find.textContaining('未启用'), findsNothing,
        reason: '切回设备页却没有重读，卡片会说反话');
    expect(find.textContaining('已启用'), findsWidgets);
  });

  testWidgets('tick 不变就不重读：刷新由「变成可见」驱动，不是每次重建',
      (tester) async {
    // 这条不是钉 bug，是钉语义：如果哪天改成每次 build 都回读，这个测试会
    // 失败，而那是一个需要被讨论的决定（每次重建都打 MethodChannel），
    // 不是可以悄悄发生的重构。
    await tester.pumpWidget(const MaterialApp(
      home: SettingsScreenNew(visibleTick: 0),
    ));
    await tester.pumpAndSettle();
    await scrollToSwitch(tester);
    expect(switchIsOn(tester), isFalse);

    mockA11yReady(true);

    await tester.pumpWidget(const MaterialApp(
      home: SettingsScreenNew(visibleTick: 0),
    ));
    await tester.pumpAndSettle();

    expect(switchIsOn(tester), isFalse,
        reason: 'tick 没变说明本页没有变成可见，此时重读是无谓的 IPC');
  });
}
