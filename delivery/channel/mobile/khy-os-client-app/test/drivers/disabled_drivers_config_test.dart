import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';

void main() {
  // disabledDrivers 是「一键禁用某个 driver」的持久化位。这组测试钉的是
  // 缺键/坏值的兜底（老配置升级上来的第一现场）与「禁用是用户决定，
  // 序列化回来不许变回启用」。
  group('disabledDrivers 配置', () {
    test('默认空：没有任何 driver 被预禁用', () {
      const cfg = AppConfigData(baseUrl: '', apiKey: '', model: 'm');
      expect(cfg.disabledDrivers, isEmpty);
      expect(cfg.isDriverDisabled('amoo'), false);
    });

    test('禁用状态序列化往返不丢', () {
      final cfg = const AppConfigData(baseUrl: '', apiKey: '', model: 'm')
          .copyWith(disabledDrivers: const ['amoo']);
      final back = AppConfigData.fromJson(cfg.toJson());
      expect(back.disabledDrivers, ['amoo']);
      expect(back.isDriverDisabled('amoo'), true);
      expect(back.isDriverDisabled('local'), false);
    });

    test('老配置没这个键：按空处理，其余字段照常', () {
      final legacy = AppConfigData.fromJson({
        'baseUrl': 'https://a.com',
        'apiKey': 'k',
        'model': 'm',
      });
      expect(legacy.disabledDrivers, isEmpty);
      expect(legacy.baseUrl, 'https://a.com');
    });

    test('坏类型不毒化整份配置', () {
      final broken = AppConfigData.fromJson({
        'baseUrl': 'https://a.com',
        'apiKey': 'k',
        'model': 'm',
        'disabledDrivers': 'amoo', // 应是 List<String>
      });
      expect(broken.disabledDrivers, isEmpty);
      expect(broken.apiKey, 'k');
    });

    test('copyWith 显式置空可解除禁用', () {
      final cfg = const AppConfigData(baseUrl: '', apiKey: '', model: 'm')
          .copyWith(disabledDrivers: const ['amoo', 'script']);
      final reEnabled = cfg.copyWith(disabledDrivers: const ['script']);
      expect(reEnabled.disabledDrivers, ['script']);
    });

    test('effective 分支不丢禁用位', () {
      const cfg = AppConfigData(
        baseUrl: 'https://unknown.example.com/v1',
        apiKey: '',
        model: 'm',
        disabledDrivers: ['amoo'],
      );
      expect(cfg.effective.disabledDrivers, ['amoo']);
    });
  });
}
