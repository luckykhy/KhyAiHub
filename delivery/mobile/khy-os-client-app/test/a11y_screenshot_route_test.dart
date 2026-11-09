import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The accessibility-screenshot route.
///
/// WHY THIS FILE EXISTS. The vision tools used to take every screenshot through
/// MediaProjection, which pops a system consent dialog on every session. That
/// dialog is what stopped the feature from ever working unattended — measured on
/// device 2026-10-27: `vision_locate` was called, and it failed with
/// 「屏幕捕获未就绪」 because the dialog had been dismissed without consent.
///
/// The accessibility service can take screenshots too (`canTakeScreenshot` is
/// already in its config), and the vision tools already need that service for
/// the tap. So routing the screenshot through it takes the feature from two
/// user consents down to one, and the dialog never appears.
///
/// What is deliberately NOT here, and not in the implementation: using the
/// accessibility service to click the system's own consent dialogs. That would
/// be a consent bypass, and it is a different thing from reusing a consent the
/// user already gave.
///
/// These are plumbing tests — they check the three files agree on the method
/// name and that the route is preferred. The behaviour itself is verified on
/// device, because "does takeScreenshot work on this phone" is not answerable
/// from a JVM.
void main() {
  const mainActivityPath =
      'android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt';
  const servicePath =
      'android/app/src/main/kotlin/com/khyos/khy_os_client/KhyAccessibilityService.kt';
  const configPath = 'android/app/src/main/res/xml/accessibility_service_config.xml';
  const visionToolsPath = 'lib/core/tools/vision_tools.dart';
  const deviceControlPath = 'lib/core/services/device_control.dart';

  String read(String p) {
    final f = File(p);
    expect(f.existsSync(), true,
        reason: '$p 找不到——这条测试必须从 App 目录跑');
    return f.readAsStringSync();
  }

  group('the accessibility service can take screenshots', () {
    test('the service config declares canTakeScreenshot', () {
      // Without this the whole route is unavailable, and the failure is a
      // runtime SecurityException rather than a compile error.
      expect(read(configPath), contains('android:canTakeScreenshot="true"'));
    });

    test('the service exposes screenshotB64 and reports the screen geometry', () {
      final s = read(servicePath);
      expect(s, contains('fun screenshotB64('));
      // orig_w/orig_h are load-bearing: they are the display size the caller
      // needs to convert coordinates. Without them the caller has to guess a
      // ratio, and the symptom of a wrong guess is a tap that lands near the
      // target with nothing in any log to explain it.
      expect(s, contains('"orig_w"'));
      expect(s, contains('"orig_h"'));
      expect(s, contains('"w"'));
      expect(s, contains('"h"'));
    });

    test('it returns null rather than throwing when the service is off', () {
      // "Service not connected" is a normal state the caller must be able to
      // fall back from. Throwing would turn a routine degradation into a crash
      // in the middle of a tool call.
      final s = read(servicePath);
      expect(s, contains('val svc = instance ?: return null'));
    });
  });

  group('the plumbing agrees across the three files', () {
    test('MainActivity handles a11yScreenshot', () {
      expect(read(mainActivityPath), contains('"a11yScreenshot"'));
    });

    test('device_control calls it', () {
      expect(read(deviceControlPath), contains("'a11yScreenshot'"));
    });

    test('vision_tools tries the accessibility route before MediaProjection', () {
      // The order is the whole point of the change. Reversed, the dialog is
      // back and the feature is blocked again — and no test that only checks
      // "both paths exist" would notice.
      final v = read(visionToolsPath);
      final a11yAt = v.indexOf('DeviceControl.a11yScreenshot()');
      final mpAt = v.indexOf('DeviceControl.captureFrame()');
      expect(a11yAt, greaterThanOrEqualTo(0), reason: 'vision_tools 没有走无障碍截屏');
      expect(mpAt, greaterThan(a11yAt),
          reason: '无障碍截屏必须排在 MediaProjection 之前，否则弹窗照样挡路');
    });
  });

  group('the boundary is stated where it will be read', () {
    test('the comment says what is NOT done', () {
      // A reader who finds this code later will reasonably ask "why not just
      // auto-click the dialog too?". The answer belongs next to the code, not
      // in a commit message nobody reads.
      final v = read(visionToolsPath);
      expect(v, contains('is not done'));
      final m = read(mainActivityPath);
      expect(m, contains('is NOT done here'));
    });
  });
}
