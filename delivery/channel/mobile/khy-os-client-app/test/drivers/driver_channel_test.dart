import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:khy_os_client/core/drivers/driver_channel.dart';

void main() {
  // 禁用开关的 Dart 侧。这组测试钉三件事：禁用名单的纯函数语义、
  // 原生键名的字面值（与 Kotlin 侧 DriverGateTest 钉同一个串），
  // 以及 setDriverEnabled 真的经 MethodChannel 出去——少了这一环，
  // Flutter 侧开关永远不会在原生门上生效（§5.1 第 4 条）。
  group('toggleDisabled 纯函数', () {
    test('禁用 = 加入名单', () {
      expect(toggleDisabled(const ['local'], 'amoo', false), ['local', 'amoo']);
    });

    test('解除 = 移出名单', () {
      expect(toggleDisabled(const ['amoo', 'local'], 'amoo', true), ['local']);
    });

    test('重复禁用不产生重复项', () {
      expect(toggleDisabled(const ['amoo'], 'amoo', false), ['amoo']);
    });

    test('解除未禁用的 id 名单不变', () {
      expect(toggleDisabled(const ['local'], 'amoo', true), ['local']);
    });
  });

  group('原生键名（与 Kotlin 侧同一字面值）', () {
    test('前缀字面值', () {
      expect(kDriverDisabledKeyPrefix, 'driver_disabled_');
    });
  });

  group('DriverChannel.setDriverEnabled', () {
    testWidgets('调用经 device 通道发出，参数是 driverId+enabled', (tester) async {
      MethodCall? captured;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(DriverChannel.channel, (call) async {
        captured = call;
        return {'ok': true};
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(DriverChannel.channel, null));

      final ok = await DriverChannel.setDriverEnabled('amoo', false);
      expect(ok, true);
      expect(captured?.method, 'setDriverEnabled');
      expect(captured?.arguments, {'driverId': 'amoo', 'enabled': false});
    });

    testWidgets('通道抛错：返回 false，不静默吞掉', (tester) async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(DriverChannel.channel, (call) async {
        // 原生壳太旧（没实现）或调用失败都走这条路：返回 false 让调用方
        // 在界面上说「切换失败」，而不是显示一个拨了却没生效的开关。
        throw PlatformException(code: 'unimplemented', message: 'no such method');
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(DriverChannel.channel, null));

      expect(await DriverChannel.setDriverEnabled('amoo', false), false);
    });
  });
}
