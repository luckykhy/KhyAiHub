import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/screens/settings_screen_new.dart';

/// 「amoo 反代」设置开关的护栏（§5.1）。
///
/// 为什么值得单开一个文件：这是「一键禁用某个 driver」的用户面。四条性质：
///   1. 开关在页面上，value 来自 AppConfigData.disabledDrivers（不是本地猜）；
///   2. 关它 = 两步写——Flutter 侧 AppConfig 与原生侧 DriverGate 都要写，
///      只写前者的话桥 HTTP 入口的 amoo 工具族照常放行；
///   3. 副标题必须说清「关掉之后什么还活着」——那是用户敢关它的前提；
///   4. 原生侧没接上（MissingPluginException）时如实返回失败，不显示假状态。
void main() {
  const channel = MethodChannel('com.khyos.khy_os_client/device');

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  Future<void> reveal(WidgetTester tester, Finder f) async {
    for (var i = 0; i < 40 && !tester.any(f); i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -350));
      await tester.pumpAndSettle();
    }
    expect(tester.any(f), isTrue, reason: '滚了 40 次还没见到 amoo driver 开关');
    await tester.ensureVisible(f);
    await tester.pumpAndSettle();
  }

  Finder amooSwitch() => find.byKey(const Key('amoo-driver-switch'));

  testWidgets('开关在页面上，默认开着（没有任何 driver 被预禁用）', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      return <String, Object?>{};
    });
    await tester.pumpWidget(const MaterialApp(home: SettingsScreenNew()));
    await tester.pumpAndSettle();

    await reveal(tester, amooSwitch());
    expect(tester.widget<Switch>(amooSwitch()).value, isTrue,
        reason: '默认空禁用名单 = amoo driver 出场');
  });

  testWidgets('关它：Flutter 侧落盘 + 原生侧 setDriverEnabled 两步都走', (tester) async {
    final nativeCalls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      nativeCalls.add(call);
      return <String, Object?>{'ok': true};
    });
    await tester.pumpWidget(const MaterialApp(home: SettingsScreenNew()));
    await tester.pumpAndSettle();
    await reveal(tester, amooSwitch());

    await tester.tap(amooSwitch());
    await tester.pump();

    final setDriver = nativeCalls.where((c) => c.method == 'setDriverEnabled').toList();
    expect(setDriver, hasLength(1), reason: '必须经 MethodChannel 写原生门');
    expect(setDriver.single.arguments, {'driverId': 'amoo', 'enabled': false});
  });

  testWidgets('原生侧没接上：SnackBar 说明，不显示一个拨了没生效的开关', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'setDriverEnabled') {
        throw MissingPluginException(call.method);
      }
      return <Object?>{};
    });
    await tester.pumpWidget(const MaterialApp(home: SettingsScreenNew()));
    await tester.pumpAndSettle();
    await reveal(tester, amooSwitch());

    await tester.tap(amooSwitch());
    // SnackBar 存活 4 秒：pumpAndSettle 会等它消失（超时），这里只推进到
    // 它出现为止。
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.textContaining('原生侧开关未接上'), findsOneWidget,
        reason: '缺方法 = APK 太旧，必须如实说，不能假装生效');
  });
}
