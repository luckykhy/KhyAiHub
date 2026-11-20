// khy-canary: Khy-20261113-006-P4REG
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/amoo_driver.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_registry.dart';
import 'package:khy_os_client/core/drivers/local_driver.dart';
import 'package:khy_os_client/core/drivers/pc_bridge_driver.dart';
import 'package:khy_os_client/core/drivers/script_driver.dart';
import 'package:khy_os_client/core/toolhost/tool_host_client.dart';

/// 执行器的 driver 装配单例。
///
/// 为什么需要它：driver 清单的权威在注册表，UI（模型选择器的 driver 组、
/// 目标切换）必须读同一份——把 amoo 写进 UI 的 drivers 列表，就等于每加
/// 一个 driver 都要改渲染层，那正是 T2 要禁的事。
///
/// 禁用位每次构造时从 [AppConfigData] 读：用户在设置里拨开关后，下一次
/// 装配（重启/切 tab）即生效——不在运行中热改，避免「拨了没生效」与
/// 「拨了立即断掉正在进行的会话」两种抱怨二选一。
class AppDriverRegistry {
  AppDriverRegistry._();

  static final AppDriverRegistry instance = AppDriverRegistry._();

  DriverRegistry? _cached;
  List<String>? _cachedDisabled;

  /// 当前生效的注册表。disabled 变化才重建，否则返回缓存。
  DriverRegistry registryFor(AppConfigData config, ToolHostClient host) {
    final disabled = List<String>.of(config.disabledDrivers)..sort();
    final same = _cachedDisabled != null &&
        _cachedDisabled!.length == disabled.length &&
        _cachedDisabled!.every(disabled.contains);
    if (_cached != null && same) return _cached!;

    final reg = DriverRegistry(disabledIds: config.disabledDrivers);
    // 全部注册（含被禁用的）：禁用 = 不出场，不是不在册——从册上删掉的话，
    // 重新启用要等下一次装配，而用户刚拨的开关看起来就像没生效。
    // 出场过滤由 DriverRegistry.enabledDrivers 自己做（disabled + enabled）。
    for (final d in _allDrivers(config)) {
      reg.register(d);
    }
    _cached = reg;
    _cachedDisabled = disabled;
    return reg;
  }

  /// 全部 driver 实现（含被禁用的——在册才能重新启用）。
  List<Driver> _allDrivers(AppConfigData config) => [
        AmooDriver(config: config),
        LocalDriver(config: config),
        PcBridgeDriver(config: config),
        ScriptDriver(config: config),
      ];

  /// driver 的展示名。UI 只读这一张表，不自己拼名字。
  static String displayName(String driverId) => switch (driverId) {
        'amoo' => 'Amoo · 本机助手',
        'local' => '本机模型',
        'pc-bridge' => '电脑桥',
        'script' => '本地脚本',
        _ => driverId,
      };

  /// 这个 driver 是否有独立状态面（目前只有 amoo 有任务卡）。
  static bool hasStatusCard(String driverId) => driverId == 'amoo';
}
