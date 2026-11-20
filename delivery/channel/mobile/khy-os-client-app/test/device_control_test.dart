import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:khy_os_client/core/services/audit_log.dart';
import 'package:khy_os_client/core/services/device_control.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');

  void mockChannel(Object? Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      return handler(call);
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('openApp / openUrl', () {
    test('openApp success', () async {
      mockChannel((call) {
        expect(call.method, 'openApp');
        return {'success': true};
      });
      expect(await DeviceControl.openApp('com.tencent.mm'), true);
    });

    test('openApp failure', () async {
      mockChannel((_) => {'success': false});
      expect(await DeviceControl.openApp('com.unknown'), false);
    });

    test('openApp exception returns false', () async {
      mockChannel((_) => throw PlatformException(code: 'err'));
      expect(await DeviceControl.openApp('com.x'), false);
    });

    test('openUrl success', () async {
      mockChannel((call) {
        expect(call.method, 'openUrl');
        return {'success': true};
      });
      expect(await DeviceControl.openUrl('https://example.com'), true);
    });

    test('openUrl exception returns false', () async {
      mockChannel((_) => throw PlatformException(code: 'err'));
      expect(await DeviceControl.openUrl('https://x.com'), false);
    });
  });

  group('Clipboard', () {
    test('getClipboard returns text', () async {
      mockChannel((call) {
        expect(call.method, 'getClipboard');
        return {'text': 'hello world'};
      });
      expect(await DeviceControl.getClipboard(), 'hello world');
    });

    test('getClipboard missing key returns empty', () async {
      mockChannel((_) => <Object?>{});
      expect(await DeviceControl.getClipboard(), '');
    });

    test('setClipboard success', () async {
      mockChannel((call) {
        expect(call.method, 'setClipboard');
        return {'success': true};
      });
      expect(await DeviceControl.setClipboard('data'), true);
    });
  });

  group('searchApps / findApp', () {
    test('searchApps maps results', () async {
      mockChannel((call) {
        expect(call.method, 'searchApps');
        return {
          'success': true,
          'apps': [
            {'label': 'Chrome', 'package': 'com.android.chrome'},
            {'label': 'DingTalk', 'package': 'com.alibaba.android.rimet'},
          ],
        };
      });
      final apps = await DeviceControl.searchApps('browser');
      expect(apps.length, 2);
      expect(apps[0].label, 'Chrome');
      expect(apps[0].packageName, 'com.android.chrome');
    });

    test('searchApps not-success returns empty', () async {
      mockChannel((_) => {'success': false});
      expect(await DeviceControl.searchApps('x'), isEmpty);
    });

    test('searchApps exception returns empty', () async {
      mockChannel((_) => throw PlatformException(code: 'err'));
      expect(await DeviceControl.searchApps('x'), isEmpty);
    });

    test('findApp returns null when no confident match (no random fallback)', () async {
      mockChannel((_) => {
        'success': true,
        'apps': [
          {'label': 'Some App', 'package': 'com.example.app'},
        ],
      });
      final found = await DeviceControl.findApp('completely unrelated');
      expect(found, isNull);
    });

    test('findApp matches installed semantic app by Chinese label', () async {
      mockChannel((call) {
        switch (call.method) {
          case 'listApps':
            return {
              'success': true,
              'apps': [
                {'label': '微信', 'package': 'com.tencent.mm'},
                {'label': 'Other', 'package': 'com.example.other'},
              ],
            };
          case 'searchApps':
            return {'success': true, 'apps': <Object?>[]};
          default:
            return <Object?>{};
        }
      });
      final found = await DeviceControl.findApp('微信');
      expect(found, isNotNull);
      expect(found!.packageName, 'com.tencent.mm');
    });

    test('findApp returns null for semantic app that is not installed', () async {
      mockChannel((call) {
        switch (call.method) {
          case 'listApps':
            return {
              'success': true,
              'apps': [
                {'label': 'Other', 'package': 'com.example.other'},
              ],
            };
          case 'searchApps':
            return {'success': true, 'apps': <Object?>[]};
          default:
            return <Object?>{};
        }
      });
      final found = await DeviceControl.findApp('微信');
      expect(found, isNull);
    });

    test('findApp empty query returns null', () async {
      mockChannel((_) => {'success': true, 'apps': <Object?>[]});
      expect(await DeviceControl.findApp(''), isNull);
      expect(await DeviceControl.findApp('  '), isNull);
    });
  });

  group('Accessibility', () {
    test('isAccessibilityReady true', () async {
      mockChannel((call) {
        expect(call.method, 'isAccessibilityReady');
        return {'ready': true};
      });
      expect(await DeviceControl.isAccessibilityReady(), true);
    });

    test('isAccessibilityReady false', () async {
      mockChannel((_) => {'ready': false});
      expect(await DeviceControl.isAccessibilityReady(), false);
    });

    test('a11yTap passes coordinates', () async {
      mockChannel((call) {
        expect(call.method, 'a11yTap');
        expect(call.arguments['x'], 100);
        expect(call.arguments['y'], 200);
        return {'success': true};
      });
      expect(await DeviceControl.a11yTap(100, 200), true);
    });

    test('a11yGlobalAction HOME', () async {
      mockChannel((call) {
        expect(call.method, 'a11yGlobalAction');
        expect(call.arguments['action'], 2);
        return {'success': true};
      });
      expect(await DeviceControl.a11yGlobalAction(DeviceControl.globalActionHome), true);
    });
  });

  group('Screen Capture', () {
    test('isScreenCaptureReady', () async {
      mockChannel((call) {
        expect(call.method, 'isScreenCaptureReady');
        return {'ready': true};
      });
      expect(await DeviceControl.isScreenCaptureReady(), true);
    });

    test('captureFrame returns data', () async {
      mockChannel((_) => {'success': true, 'data': 'iVBORw0KGgo='});
      expect(await DeviceControl.captureFrame(), 'iVBORw0KGgo=');
    });

    test('captureFrame not-success returns null', () async {
      mockChannel((_) => {'success': false});
      expect(await DeviceControl.captureFrame(), isNull);
    });
  });

  group('execShell', () {
    test('success with stdout', () async {
      mockChannel((call) {
        expect(call.method, 'shell');
        expect(call.arguments['command'], 'echo hi');
        return {'success': true, 'stdout': 'hi\n', 'stderr': '', 'exitCode': 0};
      });
      final r = await DeviceControl.execShell('echo hi');
      expect(r.success, true);
      expect(r.stdout, 'hi\n');
      expect(r.exitCode, 0);
    });

    test('failure with stderr', () async {
      mockChannel((_) => {'success': false, 'stdout': '', 'stderr': 'Permission denied', 'exitCode': 126});
      final r = await DeviceControl.execShell('rm /');
      expect(r.success, false);
      expect(r.stderr, 'Permission denied');
      expect(r.exitCode, 126);
    });

    test('exception returns failure', () async {
      mockChannel((_) => throw PlatformException(code: 'timeout'));
      final r = await DeviceControl.execShell('hang');
      expect(r.success, false);
      expect(r.exitCode, -1);
    });

    // 这一组钉的是「护栏真的接在会执行的入口上」，不是「判定函数本身对不对」。
    // 判定对但没接线，等于守空气——2026-11-09 实测过：
    // AiSafetyFilter.checkCommand 当时在生产代码里**一个调用点都没有**。
    test('危险命令在到达原生之前就被拒', () async {
      var reachedNative = false;
      mockChannel((_) {
        reachedNative = true;
        return {'success': true, 'stdout': 'should not happen', 'stderr': '', 'exitCode': 0};
      });
      final r = await DeviceControl.execShell('rm -r -f /');
      expect(r.success, false);
      expect(r.stderr, contains('安全护栏'));
      expect(reachedNative, false, reason: '危险命令不该下发到原生');
    });

    test('普通命令照常下发', () async {
      var reachedNative = false;
      mockChannel((_) {
        reachedNative = true;
        return {'success': true, 'stdout': 'ok', 'stderr': '', 'exitCode': 0};
      });
      final r = await DeviceControl.execShell('ls -la /storage');
      expect(r.success, true);
      expect(reachedNative, true);
    });

    // §3.2：B 类命令被原生拒绝时，调用方要能分辨「根本没跑」和「跑了但失败」。
    // 这两种的处理方式不同——前者该去启动 sidecar，后者该去看 stderr。
    test('原生结构化拒绝的 code 要带回调用方', () async {
      mockChannel((_) => {
            'success': false,
            'stdout': '',
            'stderr': 'input 需要 shell 层（uid 2000）',
            'exitCode': 126,
            'code': 'needs_shell',
          });
      final r = await DeviceControl.execShell('input tap 10 10');
      expect(r.success, false);
      expect(r.code, 'needs_shell');
      expect(r.exitCode, 126);
    });

    test('普通成功不带 code', () async {
      mockChannel((_) => {'success': true, 'stdout': 'hi\n', 'stderr': '', 'exitCode': 0});
      final r = await DeviceControl.execShell('echo hi');
      expect(r.code, isEmpty);
    });
  });

  group('execShellElevated', () {
    test('危险命令连 提权代理 状态都不查', () async {
      var askedStatus = false;
      mockChannel((call) {
        if (call.method == 'elevationStatus') askedStatus = true;
        return {'success': true, 'stdout': '', 'stderr': '', 'exitCode': 0};
      });
      final r = await DeviceControl.execShellElevated('rm -r -f /');
      expect(r.success, false);
      expect(r.stderr, contains('安全护栏'));
      expect(askedStatus, false, reason: '判定必须发生在提权之前');
    });
  });

  // 这一组钉的是「命令执行真的留痕」。
  //
  // 为什么值得单独钉：AI 能伤到设备的地方就在命令上，而命令是散落在各个工具里
  // 的。审计只有落在 shell 通道的**汇聚点**上才收得住——散点式地让每个工具自己
  // 记，漏一个就是漏一个，而漏掉的那些恰恰是最危险的调用点。
  group('shell 通道的审计', () {
    late Directory tmp;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('khy_shell_audit');
      AuditLog.useDirectoryForTest(tmp);
    });

    tearDown(() {
      AuditLog.useDirectoryForTest(null);
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {}
    });

    test('AI 发的命令进审计，来源标成「AI 建议」', () async {
      mockChannel((_) => {'success': true, 'stdout': 'ok', 'stderr': '', 'exitCode': 0});
      await DeviceControl.execShell('ls /storage');

      final entries = await AuditLog.instance.recent();
      expect(entries.length, 1);
      expect(entries.first.source, AuditSource.ai);
      expect(entries.first.operation, 'shell');
      expect(entries.first.detail, contains('ls /storage'));
      expect(entries.first.ok, isTrue);
      expect(entries.first.hasPath, isFalse, reason: '命令操作没有文件路径');
    });

    test('用户手动触发的调用标成「用户手动」', () async {
      mockChannel((_) => {'success': true, 'stdout': '', 'stderr': '', 'exitCode': 0});
      await DeviceControl.execShell('dumpsys package com.x', source: AuditSource.user);

      final entries = await AuditLog.instance.recent();
      expect(entries.length, 1);
      expect(entries.first.source, AuditSource.user);
    });

    test('被护栏拦下的命令也留痕，且标成失败', () async {
      var reachedNative = false;
      mockChannel((_) {
        reachedNative = true;
        return {'success': true, 'stdout': 'should not happen', 'stderr': '', 'exitCode': 0};
      });
      final r = await DeviceControl.execShell('rm -r -f /');
      expect(r.success, false);
      expect(reachedNative, false);

      final entries = await AuditLog.instance.recent();
      expect(entries.length, 1);
      expect(entries.first.ok, isFalse);
      expect(entries.first.detail, contains('rm -r -f /'));
      expect(entries.first.detail, contains('安全护栏'),
          reason: '被拦下的原因要写进去，否则用户只看到「失败」，看不到「差点干了什么」');
    });

    test('提权降级时同一条命令只记一次', () async {
      mockChannel((call) {
        if (call.method == 'elevationStatus') {
          return {'installed': false, 'running': false, 'version': ''};
        }
        return {'success': true, 'stdout': 'ok', 'stderr': '', 'exitCode': 0};
      });
      final r = await DeviceControl.execShellElevated('ls /data');
      expect(r.success, isTrue);

      final entries = await AuditLog.instance.recent();
      expect(entries.length, 1, reason: '降级路径不能再走一遍带审计的入口');
      expect(entries.first.operation, 'shell.elevated');
    });

    test('提权走通时记的是提权那一条', () async {
      mockChannel((call) {
        switch (call.method) {
          case 'elevationStatus':
            return {'installed': true, 'running': true, 'version': '13'};
          case 'elevatedShell':
            return {'success': true, 'stdout': 'ok', 'stderr': '', 'exitCode': 0, 'via': 'elevation'};
          default:
            return <Object?>{};
        }
      });
      final r = await DeviceControl.execShellElevated('ls /data');
      expect(r.success, isTrue);

      final entries = await AuditLog.instance.recent();
      expect(entries.length, 1);
      expect(entries.first.operation, 'shell.elevated');
      expect(entries.first.ok, isTrue);
    });
  });

  group('checkPermissions', () {
    test('all granted', () async {
      mockChannel((call) {
        expect(call.method, 'checkPermissions');
        return {'notifications': true, 'overlay': true, 'accessibility': true};
      });
      final status = await DeviceControl.checkPermissions();
      expect(status.allGranted, true);
      expect(status.missingList, isEmpty);
    });

    test('some missing', () async {
      mockChannel((_) => {'notifications': true, 'overlay': false, 'accessibility': false});
      final status = await DeviceControl.checkPermissions();
      expect(status.allGranted, false);
      expect(status.anyMissing, true);
      expect(status.missingList.length, 2);
    });

    test('exception returns all-false', () async {
      mockChannel((_) => throw PlatformException(code: 'err'));
      final status = await DeviceControl.checkPermissions();
      expect(status.notifications, false);
      expect(status.overlay, false);
      expect(status.accessibility, false);
      expect(status.missingList.length, 3);
    });
  });

  group('getDeviceInfo', () {
    test('returns map', () async {
      mockChannel((call) {
        expect(call.method, 'getDeviceInfo');
        return {'manufacturer': 'Google', 'model': 'Pixel 8', 'sdk': 34};
      });
      final info = await DeviceControl.getDeviceInfo();
      expect(info['manufacturer'], 'Google');
      expect(info['model'], 'Pixel 8');
    });

    test('exception returns empty map', () async {
      mockChannel((_) => throw PlatformException(code: 'err'));
      expect(await DeviceControl.getDeviceInfo(), isEmpty);
    });
  });
}
