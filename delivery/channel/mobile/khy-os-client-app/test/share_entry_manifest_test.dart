import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The share / selection-text entries must agree across three files.
///
/// WHY THIS TEST EXISTS. The 「选中文字后」 entry is an `<activity-alias>` that
/// ships disabled and gets switched on at runtime by name:
///
///   AndroidManifest.xml   declares `.ProcessTextEntry`, `android:enabled="false"`
///   MainActivity.kt       builds `ComponentName(this, "$packageName.ProcessTextEntry")`
///   strings.xml           supplies the label the user actually reads
///
/// None of those three is checked by the compiler. Rename the alias in the
/// manifest and `setComponentEnabledSetting` throws at runtime — but only when
/// the user taps the switch, and the catch turns it into a snackbar that says
/// "切换入口失败" without saying why. Rename it in Kotlin and the same thing
/// happens. The symptom is a switch that never works, on a device, after a
/// build, with no test that could have caught it.
///
/// The other half pinned here is the *default*. `android:enabled="false"` is not
/// a detail: `ACTION_PROCESS_TEXT` appears in every long-press selection menu on
/// the device, so shipping it enabled is a permanent intrusion the user never
/// asked for. If someone "helpfully" enables it, this fails.
void main() {
  const manifestPath = 'android/app/src/main/AndroidManifest.xml';
  const mainActivityPath =
      'android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt';
  const stringsPath = 'android/app/src/main/res/values/strings.xml';

  String read(String p) {
    final f = File(p);
    expect(f.existsSync(), true,
        reason: '$p 找不到——这条测试必须从 App 目录跑');
    return f.readAsStringSync();
  }

  group('share entries', () {
    test('ACTION_SEND is on MainActivity', () {
      final m = read(manifestPath);
      expect(m, contains('android.intent.action.SEND'));
      // The filter must sit inside the MainActivity element, not floating in
      // the manifest where it would attach to nothing.
      final activity = m.substring(
          m.indexOf('<activity'), m.indexOf('</activity>'));
      expect(activity, contains('android.intent.action.SEND'));
    });

    test('the PROCESS_TEXT alias exists and ships disabled', () {
      final m = read(manifestPath);
      expect(m, contains('android.intent.action.PROCESS_TEXT'));
      expect(m, contains('activity-alias'));
      expect(m, contains('android:name=".ProcessTextEntry"'));

      var alias = m.substring(m.indexOf('<activity-alias'));
      alias = alias.substring(0, alias.indexOf('/>') + 2);
      expect(alias, contains('android:enabled="false"'),
          reason: '「选中文字后」入口必须默认关闭——它出现在本机每一次长按选字的'
              '菜单里，那是永久且用户可见的侵入，默认开等于替用户做了决定');
      expect(alias, contains('android:targetActivity=".MainActivity"'),
          reason: 'alias 必须指向 MainActivity，否则点了没反应');
    });

    test('the alias name in Kotlin matches the manifest', () {
      // The single most breakable link in the chain, and the one with no
      // compile-time or test-time coverage before this file existed.
      final m = read(manifestPath);
      final k = read(mainActivityPath);
      expect(m, contains('android:name=".ProcessTextEntry"'));
      // The `$packageName` is Kotlin string interpolation, so it has to be
      // matched literally rather than as a Dart template.
      expect(k, contains(r'"$packageName.ProcessTextEntry"'),
          reason: 'MainActivity.kt 里拼的组件名和 manifest 的 alias 名不一致，'
              'setComponentEnabledSetting 会在用户点开关时才炸');
    });

    test('the alias has a user-facing label', () {
      // The selection menu is cramped; the user sees only this line. An
      // unlabelled alias shows the raw class name.
      final m = read(manifestPath);
      final s = read(stringsPath);
      expect(m, contains('@string/process_text_entry_label'));
      expect(s, contains('name="process_text_entry_label"'));
      expect(s, contains('用 khy-os 处理…'),
          reason: '标签要说清拿去干什么，只写「khy-os」用户不知道会发生什么');
    });
  });

  group('shared-text plumbing', () {
    test('the native side exposes consume and the enable/disable pair', () {
      final k = read(mainActivityPath);
      expect(k, contains('"consumeSharedText"'));
      expect(k, contains('"processTextEntryEnabled"'));
      expect(k, contains('"setProcessTextEntryEnabled"'));
    });

    test('both entry points capture the incoming text', () {
      // `launchMode` is `singleTop`, so the first share arrives on the launch
      // intent and every later one arrives as `onNewIntent`. Handling only one
      // of them silently drops the other, and the symptom is "I shared
      // something and nothing happened".
      final k = read(mainActivityPath);
      expect(k, contains('captureIncomingText(intent)'));
      expect(k, contains('override fun onNewIntent'));
      expect(k, contains('Intent.EXTRA_TEXT'));
      expect(k, contains('Intent.EXTRA_PROCESS_TEXT'));
    });

    test('the Dart side calls all three native methods', () {
      // Method names only, not the full call: `invokeMethod<String>(...)` and
      // `invokeMethod(...)` are both correct, and pinning the exact form would
      // make this test fail on a type annotation.
      final d = read('lib/core/services/device_control.dart');
      expect(d, contains("'consumeSharedText'"));
      expect(d, contains("'processTextEntryEnabled'"));
      expect(d, contains("'setProcessTextEntryEnabled'"));
    });
  });
}
