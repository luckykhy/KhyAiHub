import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/screens/settings_screen_new.dart';

/// The 「选中文字后」 menu-entry switch.
///
/// WHY THIS IS ITS OWN SUITE. This entry is the one place in the app where
/// something is OFF until the user asks for it, and the reason is specific:
/// `ACTION_PROCESS_TEXT` puts khy-os in every long-press selection menu on the
/// device. That is a permanent, user-visible intrusion bought with one manifest
/// line, so the default has to be off and the switch has to be the only thing
/// that turns it on.
///
/// Two properties are pinned here, and they are the two that would silently
/// regress:
///   1. the switch starts OFF, matching the manifest's `android:enabled="false"`
///      — a switch that starts on is the intrusion happening without consent;
///   2. the displayed value comes back from the system, not from what the user
///      tapped. A switch that shows "on" because the user tapped it, while the
///      component failed to enable, is lying about the state of the device.
void main() {
  const channel = MethodChannel('com.khyos.khy_os_client/device');

  /// Records every native call so "the switch moved" and "the component was
  /// actually enabled" can be told apart.
  List<String> nativeCalls() {
    final log = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      log.add(call.method);
      switch (call.method) {
        case 'processTextEntryEnabled':
          return false;
        case 'setProcessTextEntryEnabled':
          return <String, Object?>{
            'success': (call.arguments as Map)['enabled'] == true,
            'enabled': (call.arguments as Map)['enabled'] == true,
          };
        default:
          return null;
      }
    });
    return log;
  }

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'processTextEntryEnabled':
          return false;
        case 'setProcessTextEntryEnabled':
          return <String, Object?>{
            'success': true,
            'enabled': (call.arguments as Map)['enabled'] == true,
          };
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  /// The 入口 section sits between 视觉模型 and 系统能力.
  Future<void> openEntrySection(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: SettingsScreenNew()));
    await tester.pumpAndSettle();
    for (var i = 0; i < 40 && !tester.any(find.text('选中文字后')); i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -350));
      await tester.pumpAndSettle();
    }
    expect(tester.any(find.text('选中文字后')), isTrue,
        reason: '滚了 40 次还没见到「入口」区');
    await tester.ensureVisible(find.byKey(const Key('process-text-switch')));
    await tester.pumpAndSettle();
  }

  final entrySwitch = find.byKey(const Key('process-text-switch'));

  testWidgets('starts off, because the manifest ships it disabled', (tester) async {
    // The default IS the consent decision. Shipping this on would put khy-os in
    // every selection menu on the device before the user ever saw the setting.
    await openEntrySection(tester);
    final sw = tester.widget<Switch>(entrySwitch);
    expect(sw.value, false);
  });

  testWidgets('says what the entry does, not just that it exists',
      (tester) async {
    // The selection menu is cramped; the user reads one line there. If the
    // settings subtitle does not explain it, the first time they see it will be
    // in a context where nothing does.
    await openEntrySection(tester);
    expect(find.text('选中文字后'), findsOneWidget);
    expect(find.textContaining('「用 khy-os 处理…」'), findsOneWidget);
  });

  testWidgets('turning it on calls the native side with enabled=true',
      (tester) async {
    final log = nativeCalls();
    await openEntrySection(tester);

    await tester.tap(entrySwitch);
    await tester.pumpAndSettle();

    expect(log, contains('setProcessTextEntryEnabled'));
    expect(log, isNot(contains('enableAccessibility')),
        reason: '这是 App 自己的组件，不该走无障碍那条授权路');
  });

  testWidgets('a failed enable is reported, not silently shown as on',
      (tester) async {
    // The whole reason the value is read back from the system rather than
    // assumed: a switch that shows "on" while the component failed to enable
    // sends the user to long-press some text and find nothing there.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'processTextEntryEnabled':
          return false;
        case 'setProcessTextEntryEnabled':
          return <String, Object?>{'success': false, 'message': '切换入口失败'};
        default:
          return null;
      }
    });
    await openEntrySection(tester);

    await tester.tap(entrySwitch);
    await tester.pumpAndSettle();

    expect(find.text('切换入口失败'), findsOneWidget);
    expect(tester.widget<Switch>(entrySwitch).value, false,
        reason: '写失败了还显示「开着」，这个开关就是撒谎');
  });
}
