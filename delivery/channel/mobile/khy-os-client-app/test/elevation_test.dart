import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/device_control.dart';

/// 提权通道（khyos 自带的 sidecar 代理）的契约测试。
///
/// 为什么只剩一条通道：2026-11-12 人裁决「完全移除第三方提权应用依赖」。
/// 提权由 khyos 自带的 uid 2000 代理提供，接口形状不变，所以这组断言
/// 改的是**语义**（通道标识是 sidecar，不是某个第三方版本号），不是契约。
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

  group('提权通道', () {
    test('代理在位且可用时，报 available', () async {
      mockChannel((call) {
        expect(call.method, 'elevationStatus');
        return {'installed': true, 'running': true, 'version': 'sidecar'};
      });
      final status = await DeviceControl.getElevationStatus();
      expect(status.available, true);
      expect(status.version, 'sidecar');
      expect(status.toString(), contains('已就绪'));
    });

    test('代理在位但不可用时，不算可用', () async {
      mockChannel((_) => {'installed': true, 'running': false, 'version': ''});
      final status = await DeviceControl.getElevationStatus();
      expect(status.installed, true);
      expect(status.available, false);
    });

    test('通道报错时降级为「不可用」而不是抛异常', () async {
      mockChannel((_) => throw PlatformException(code: 'no impl'));
      final status = await DeviceControl.getElevationStatus();
      expect(status.installed, false);
      expect(status.available, false);
    });

    test('execShellElevated 在代理可用时走提权通道', () async {
      var elevatedCalled = false;
      mockChannel((call) {
        switch (call.method) {
          case 'elevationStatus':
            return {'installed': true, 'running': true, 'version': 'sidecar'};
          case 'elevatedShell':
            elevatedCalled = true;
            return {
              'success': true,
              'stdout': 'ok',
              'stderr': '',
              'exitCode': 0,
              'via': 'sidecar',
            };
          default:
            return <Object?>{};
        }
      });
      final r = await DeviceControl.execShellElevated('dumpsys battery');
      expect(elevatedCalled, true);
      expect(r.success, true);
      expect(r.stdout, 'ok');
    });

    test('execShellElevated 在代理不可用时降级到普通 shell', () async {
      var plainCalled = false;
      mockChannel((call) {
        switch (call.method) {
          case 'elevationStatus':
            return {'installed': false, 'running': false, 'version': ''};
          case 'shell':
            plainCalled = true;
            return {
              'success': false,
              'stdout': '',
              'stderr': 'permission denied',
              'exitCode': 126,
            };
          default:
            return <Object?>{};
        }
      });
      final r = await DeviceControl.execShellElevated('screencap /sdcard/x.png');
      expect(plainCalled, true);
      expect(r.success, false);
      expect(r.stderr, contains('permission denied'));
    });

  });
}
