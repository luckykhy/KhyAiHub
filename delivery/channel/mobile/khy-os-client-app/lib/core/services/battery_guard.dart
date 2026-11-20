// khy-canary: Khy-1.1.47+32-202611152100-BATTERYGUARD
import 'package:flutter/services.dart';

/// 电池 / 后台运行状态的一次快照（来自原生层检测）。
///
/// 为什么不让 Dart 侧自己算：白名单、后台限制这类事实只有系统知道，Dart 侧
/// 拿不到也不该猜。这个类只是把原生返回的 Map 翻译成有字段名的对象。
class BatteryStatusInfo {
  const BatteryStatusInfo({
    required this.manufacturer,
    required this.isIgnoringBatteryOptimizations,
    required this.isBackgroundRestricted,
    required this.autostartState,
    required this.restrictedSettingsLikely,
    required this.lastCheckAt,
    required this.hasActionable,
  });

  /// 检测失败时的兜底：全绿 + 无动作项，界面据此显示"未知"而不是"未放行"。
  const BatteryStatusInfo.unknown()
      : manufacturer = '',
        isIgnoringBatteryOptimizations = false,
        isBackgroundRestricted = false,
        autostartState = 'unknown',
        restrictedSettingsLikely = false,
        lastCheckAt = 0,
        hasActionable = false;

  factory BatteryStatusInfo.fromMap(Map<Object?, Object?>? map) {
    if (map == null) return const BatteryStatusInfo.unknown();
    return BatteryStatusInfo(
      manufacturer: (map['manufacturer'] as String?) ?? '',
      isIgnoringBatteryOptimizations: map['isIgnoringBatteryOptimizations'] == true,
      isBackgroundRestricted: map['isBackgroundRestricted'] == true,
      autostartState: (map['autostartState'] as String?) ?? 'unknown',
      restrictedSettingsLikely: map['restrictedSettingsLikely'] == true,
      lastCheckAt: (map['lastCheckAt'] as num?)?.toInt() ?? 0,
      hasActionable: map['hasActionable'] == true,
    );
  }

  final String manufacturer;

  /// 是否已在系统电池优化白名单里。
  final bool isIgnoringBatteryOptimizations;

  /// 是否被系统限制后台运行。
  final bool isBackgroundRestricted;

  /// 自启动状态：allowed / denied / unknown。
  ///
  /// unknown 是绝大多数机型的常态——没有任何跨 ROM 的标准 API 能问这件事。
  /// 界面必须把它讲成"要去厂商页自己看一眼"，不能讲成"已关闭"。
  final String autostartState;

  /// 是否疑似处于 Android 13+ 的「受限设置」（侧载安装导致无障碍开关被置灰）。
  final bool restrictedSettingsLikely;

  /// 检测时间（epoch ms）。
  final int lastCheckAt;

  /// 是否有需要用户动手的项。
  final bool hasActionable;

  bool get autostartAllowed => autostartState == 'allowed';

  bool get autostartDenied => autostartState == 'denied';

  /// 自启动是否为"未知"。
  bool get autostartUnknown => autostartState == 'unknown';

  /// 自启动这一项的人话描述。
  String get autostartLabel {
    switch (autostartState) {
      case 'allowed':
        return '已允许自启动';
      case 'denied':
        return '已被禁止自启动';
      default:
        return '未知（需到厂商设置里确认）';
    }
  }
}

/// 一步厂商引导。
class BatteryGuideStep {
  const BatteryGuideStep({
    required this.id,
    required this.title,
    required this.why,
    required this.components,
    required this.actions,
    required this.fallback,
    required this.optional,
    required this.done,
    required this.doneBy,
  });

  factory BatteryGuideStep.fromMap(Map<Object?, Object?>? map) {
    if (map == null) {
      return const BatteryGuideStep(
        id: '',
        title: '',
        why: '',
        components: <String>[],
        actions: <String>[],
        fallback: 'none',
        optional: false,
        done: false,
        doneBy: '',
      );
    }
    final comps = (map['components'] as List?) ?? const [];
    final acts = (map['actions'] as List?) ?? const [];
    return BatteryGuideStep(
      id: (map['id'] as String?) ?? '',
      title: (map['title'] as String?) ?? '',
      why: (map['why'] as String?) ?? '',
      components: comps.map((e) => e.toString()).toList(),
      actions: acts.map((e) => e.toString()).toList(),
      fallback: (map['fallback'] as String?) ?? 'none',
      optional: map['optional'] == true,
      done: map['done'] == true,
      doneBy: (map['doneBy'] as String?) ?? '',
    );
  }

  /// 稳定 id（battery_optimization / autostart / background_run / restricted_settings）。
  final String id;

  /// 入口名称：用户在厂商设置里看到的那个名字。
  final String title;

  /// 为什么要设。原生侧写死了，不在 UI 层临场编。
  final String why;

  /// 候选组件（原生侧逐个尝试）。
  final List<String> components;

  /// 候选 action（与组件是两条不同的路：实测有些 ROM 只放行其中一条）。
  final List<String> actions;

  /// 兜底策略。
  final String fallback;

  /// 该 ROM 上没有这一步（原生 Android 的自启动等）。
  final bool optional;

  /// 是否已完成。
  final bool done;

  /// 完成来源：detected（系统状态查得到）/ manual（用户自己点的）/ 空。
  final String doneBy;

  bool get doneManually => doneBy == 'manual';
}

/// 一次"去设置"动作的结果。
class BatteryActionResult {
  const BatteryActionResult({
    required this.opened,
    required this.via,
    required this.message,
  });

  factory BatteryActionResult.fromMap(Map<Object?, Object?>? map) {
    if (map == null) {
      return const BatteryActionResult(opened: false, via: '', message: '原生侧没有返回结果');
    }
    return BatteryActionResult(
      opened: map['opened'] == true,
      via: (map['via'] as String?) ?? '',
      message: (map['message'] as String?) ?? '',
    );
  }

  /// 是否真的把用户送到了某个设置页。
  final bool opened;

  /// 走了哪条路（组件名 / 兜底页 / none）。
  final String via;

  /// 给用户看的中文说明。
  final String message;
}

/// 底部提示面板的本地状态（7 天冷却）。
class BatteryPromptState {
  const BatteryPromptState({
    required this.shouldPrompt,
    required this.dismissedAt,
    required this.completed,
    required this.cooldownDays,
    required this.nextPromptAt,
    this.status,
  });

  factory BatteryPromptState.fromMap(Map<Object?, Object?>? map) {
    if (map == null) {
      return const BatteryPromptState(
        shouldPrompt: false,
        dismissedAt: 0,
        completed: false,
        cooldownDays: 7,
        nextPromptAt: 0,
      );
    }
    final raw = map['status'];
    return BatteryPromptState(
      shouldPrompt: map['shouldPrompt'] == true,
      dismissedAt: (map['dismissedAt'] as num?)?.toInt() ?? 0,
      completed: map['completed'] == true,
      cooldownDays: (map['cooldownDays'] as num?)?.toInt() ?? 7,
      nextPromptAt: (map['nextPromptAt'] as num?)?.toInt() ?? 0,
      status: raw is Map
          ? BatteryStatusInfo.fromMap(raw.cast<Object?, Object?>())
          : null,
    );
  }

  /// 现在该不该弹面板。
  final bool shouldPrompt;

  /// 上次"以后再说"的时间（epoch ms，0 = 没按过）。
  final int dismissedAt;

  /// 用户是否已走完引导。
  final bool completed;

  /// 冷却天数（7）。
  final int cooldownDays;

  /// 下次可以再弹的时间（epoch ms，0 = 没冷却中）。
  final int nextPromptAt;

  /// 随面板一起带回来的状态快照（可省一次往返）。
  final BatteryStatusInfo? status;
}

/// 电池白名单 / 后台运行引导的 Dart 侧入口。
///
/// **这些接口只用于提示与引导**：本 App 不因为"没放行"而拒绝任何功能。
/// 掉线是用户的问题，不是本层该拦的事。
class BatteryGuard {
  static const _channel = MethodChannel('com.khyos.khy_os_client/device');

  /// 取一次状态快照。
  static Future<BatteryStatusInfo> status() async {
    try {
      final result = await _channel.invokeMethod('batteryStatus');
      if (result is Map) {
        return BatteryStatusInfo.fromMap(result.cast<Object?, Object?>());
      }
    } catch (e) {
      // 通道异常不外抛：调用方（界面）据此显示"未知"，而不是崩。
    }
    return const BatteryStatusInfo.unknown();
  }

  /// 取该机型的引导步骤清单（含每一步的完成状态）。
  static Future<List<BatteryGuideStep>> steps() async {
    try {
      final result = await _channel.invokeMethod('batteryGuideSteps');
      if (result is List) {
        return result
            .whereType<Map>()
            .map((e) => BatteryGuideStep.fromMap(e.cast<Object?, Object?>()))
            .toList();
      }
    } catch (e) {
    }
    return const <BatteryGuideStep>[];
  }

  /// 打开某一步的设置页。
  static Future<BatteryActionResult> openStep(String stepId) async {
    try {
      final result =
          await _channel.invokeMethod('openBatteryGuideStep', {'stepId': stepId});
      if (result is Map) {
        return BatteryActionResult.fromMap(result.cast<Object?, Object?>());
      }
    } catch (e) {
    }
    return const BatteryActionResult(opened: false, via: '', message: '打开失败');
  }

  /// 一键请求加入电池优化白名单（系统弹窗；被拦时自动退到应用列表）。
  static Future<BatteryActionResult> requestWhitelist() async {
    try {
      final result = await _channel.invokeMethod('requestIgnoreBatteryOptimizations');
      if (result is Map) {
        return BatteryActionResult.fromMap(result.cast<Object?, Object?>());
      }
    } catch (e) {
    }
    return const BatteryActionResult(opened: false, via: '', message: '请求失败');
  }

  /// 面板的本地状态。
  static Future<BatteryPromptState> promptState() async {
    try {
      final result = await _channel.invokeMethod('batteryPromptState');
      if (result is Map) {
        return BatteryPromptState.fromMap(result.cast<Object?, Object?>());
      }
    } catch (e) {
    }
    return const BatteryPromptState(
      shouldPrompt: false,
      dismissedAt: 0,
      completed: false,
      cooldownDays: 7,
      nextPromptAt: 0,
    );
  }

  /// 用户点了「以后再说」：7 天内不再自动弹。
  static Future<void> dismissPrompt() async {
    try {
      await _channel.invokeMethod('dismissBatteryPrompt');
    } catch (e) {
    }
  }

  /// 用户走完了引导：不再自动弹。
  static Future<void> completePrompt() async {
    try {
      await _channel.invokeMethod('completeBatteryPrompt');
    } catch (e) {
    }
  }

  /// 清掉冷却与完成记录（设置页里可清）。
  static Future<void> clearPromptRecord() async {
    try {
      await _channel.invokeMethod('clearBatteryPromptRecord');
    } catch (e) {
    }
  }

  /// 标记某一步已完成（只改提示层，不动任何系统设置）。
  static Future<void> markStepDone(String stepId) async {
    try {
      await _channel.invokeMethod('markBatteryStepDone', {'stepId': stepId});
    } catch (e) {
    }
  }

  /// 取消某一步的手动完成标记。
  static Future<void> clearStepDone(String stepId) async {
    try {
      await _channel.invokeMethod('clearBatteryStepDone', {'stepId': stepId});
    } catch (e) {
    }
  }

  /// 打开本 App 的应用详情页。
  static Future<bool> openAppDetails() async {
    try {
      final result = await _channel.invokeMethod('openBatteryAppDetails');
      if (result is Map) return result['opened'] == true;
    } catch (e) {
    }
    return false;
  }
}
