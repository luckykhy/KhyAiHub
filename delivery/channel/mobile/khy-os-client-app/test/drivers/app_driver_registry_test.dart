import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/app_driver_registry.dart';
import 'package:khy_os_client/core/drivers/driver_registry.dart';
import 'package:khy_os_client/core/toolhost/tool_host_client.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

void main() {
  // registryFor 是「UI 与判定脚本读同一份 driver 清单」的机制面：
  // 禁用一个 driver，UI 的 driver 组与 registry 的出场名单必须同时变。
  group('AppDriverRegistry', () {
    ToolHostClient host() => ToolEngineHostClient(ToolEngine());

    test('默认四 driver 全部出场', () {
      final reg = AppDriverRegistry.instance.registryFor(
        const AppConfigData(baseUrl: '', apiKey: '', model: 'm'),
        host(),
      );
      expect(reg.enabledIds.toSet(), {'amoo', 'local', 'pc-bridge', 'script'});
    });

    test('禁用一个只少一个，其余照常', () {
      final reg = AppDriverRegistry.instance.registryFor(
        const AppConfigData(baseUrl: '', apiKey: '', model: 'm')
            .copyWith(disabledDrivers: const ['amoo']),
        host(),
      );
      expect(reg.enabledIds.contains('amoo'), false);
      expect(reg.enabledIds.toSet(), {'local', 'pc-bridge', 'script'});
      // 在册才能重新启用（禁用不是删除）。
      expect(reg.get('amoo'), isNotNull);
    });

    test('同一禁用位复用缓存；禁用位变化才重建', () {
      final a = AppDriverRegistry.instance.registryFor(
        const AppConfigData(baseUrl: '', apiKey: '', model: 'm'),
        host(),
      );
      final b = AppDriverRegistry.instance.registryFor(
        const AppConfigData(baseUrl: '', apiKey: '', model: 'm'),
        host(),
      );
      expect(identical(a, b), true, reason: '禁用位没变就该复用，重建会丢健康态');
      final c = AppDriverRegistry.instance.registryFor(
        const AppConfigData(baseUrl: '', apiKey: '', model: 'm')
            .copyWith(disabledDrivers: const ['amoo']),
        host(),
      );
      expect(identical(a, c), false);
      expect(c.enabledIds.contains('amoo'), false);
    });

    test('displayName 有全部四个 driver 的展示名', () {
      expect(AppDriverRegistry.displayName('amoo'), isNotEmpty);
      expect(AppDriverRegistry.displayName('local'), isNotEmpty);
      expect(AppDriverRegistry.displayName('pc-bridge'), isNotEmpty);
      expect(AppDriverRegistry.displayName('script'), isNotEmpty);
    });

    test('registry 实例本身仍是 DriverRegistry（隔离语义不变）', () {
      final reg = AppDriverRegistry.instance.registryFor(
        const AppConfigData(baseUrl: '', apiKey: '', model: 'm'),
        host(),
      );
      expect(reg, isA<DriverRegistry>());
    });
  });
}
