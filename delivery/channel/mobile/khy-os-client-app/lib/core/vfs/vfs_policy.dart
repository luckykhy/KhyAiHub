// VFS 相关的用户策略：安全模式、AI 强度、高级数据编辑、默认冲突策略。
//
// 为什么这些要落盘而不是留在内存：它们都是**决定**，不是当下的心情。「安全模式」
// 是排查故障时开的，「AI 强度」是用户对「这个 App 该多主动」的回答，「高级数据编辑」
// 是一次明确的授权。决定就该跨进程存活——否则用户重启一次 App，App 就当自己
// 又被授权了一遍，那等于没授权。

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// AI 辅助强度。
///
/// 四档而不是开关：开关只有「有 AI / 没 AI」两个世界，而真实用户要的是中间地带
/// ——「可以问我，但别自己动手」和「可以提建议，但要我点头」是两回事。
enum AiAssistLevel {
  /// 完全关闭。App 就是纯文件管理器，AI 入口不出现。
  off,

  /// 仅被动响应：只有用户主动唤起 AI 面板时才有反应。
  passive,

  /// 主动建议：进入目录、选中文件后主动给建议。
  suggest,

  /// 主动建议 + 可代执行（仍需逐项确认）。
  ///
  /// **这一档目前与 [suggest] 没有可观察差异**：[mayAct] 定义了但没有任何
  /// 消费点——`vfs_ai_sheet` 只读 [showsAssistant]，主动建议只读 [suggests]。
  /// 用户在设置里选到「主动建议并可代执行」，行为与「主动建议」完全一样。
  ///
  /// 这不是「先凑合」，是一个**已知的未接线项**，记在这里免得下一个人
  /// （人或 AI）以为它生效了。要接线得先定一件事：第三档的指令→计划入口
  /// 是收起来，还是留着但说明「当前档 AI 不替你组织操作」——那会影响
  /// 现有用户，所以等拍板，不擅自改行为。
  ///
  /// 相关判据已被 `test/vfs_policy_test.dart` 钉住（含「四档里只有三档
  /// 可观察」这个事实）。
  active;

  static AiAssistLevel parse(String? raw) {
    for (final level in AiAssistLevel.values) {
      if (level.name == raw) return level;
    }
    return AiAssistLevel.passive;
  }

  String get label {
    switch (this) {
      case AiAssistLevel.off:
        return '关闭';
      case AiAssistLevel.passive:
        return '仅被动响应';
      case AiAssistLevel.suggest:
        return '主动建议';
      case AiAssistLevel.active:
        return '主动建议并可代执行';
    }
  }

  String get description {
    switch (this) {
      case AiAssistLevel.off:
        return '不出现任何 AI 入口，App 就是专业文件管理器';
      case AiAssistLevel.passive:
        return '只有你主动唤起时 AI 才回应';
      case AiAssistLevel.suggest:
        return '进入目录或选中文件时主动给建议';
      case AiAssistLevel.active:
        return '除建议外还能替你组织操作，执行前仍需逐项确认';
    }
  }

  /// 是否显示 AI 入口。
  bool get showsAssistant => this != AiAssistLevel.off;

  /// 是否主动给建议。
  bool get suggests => this == AiAssistLevel.suggest || this == AiAssistLevel.active;

  /// 是否允许 AI 代为组织操作（仍需确认）。
  ///
  /// **尚未接线**：没有任何消费点。定义留着是为了让「计划要做但没做」这件
  /// 事在代码里可见，而不是靠人记得——见 [AiAssistLevel.active] 的说明。
  bool get mayAct => this == AiAssistLevel.active;
}

/// 冲突策略：目标已存在时怎么办。
enum VfsConflict {
  skip,
  overwrite,
  rename,
  merge;

  static VfsConflict parse(String? raw) {
    for (final policy in VfsConflict.values) {
      if (policy.name == raw) return policy;
    }
    return VfsConflict.rename;
  }

  String get label {
    switch (this) {
      case VfsConflict.skip:
        return '跳过';
      case VfsConflict.overwrite:
        return '覆盖';
      case VfsConflict.rename:
        return '重命名';
      case VfsConflict.merge:
        return '合并';
    }
  }
}

/// 策略快照。
class VfsPolicy {
  /// 安全模式：只保留基础文件管理。
  final bool safeMode;

  /// AI 强度。
  final AiAssistLevel aiLevel;

  /// 高级数据编辑模式：允许写入应用私有目录。
  ///
  /// 默认关闭。读私有目录要的是「看一眼」，写私有目录要的是「改别人的数据」——
  /// 这两件事的风险不是一个量级，所以默认口径必须不同。
  final bool advancedDataEdit;

  /// 默认冲突策略。
  final VfsConflict defaultConflict;

  /// 已经确认过风险的应用私有目录（包名）。
  ///
  /// 首次进入某个包的私有目录要弹一次风险提示并要求确认；确认过的记在这里，
  /// 之后不再重复打扰——每进一次弹一次，用户会直接关掉提示。
  final List<String> confirmedPrivatePackages;

  const VfsPolicy({
    this.safeMode = false,
    this.aiLevel = AiAssistLevel.passive,
    this.advancedDataEdit = false,
    this.defaultConflict = VfsConflict.rename,
    this.confirmedPrivatePackages = const <String>[],
  });

  VfsPolicy copyWith({
    bool? safeMode,
    AiAssistLevel? aiLevel,
    bool? advancedDataEdit,
    VfsConflict? defaultConflict,
    List<String>? confirmedPrivatePackages,
  }) {
    return VfsPolicy(
      safeMode: safeMode ?? this.safeMode,
      aiLevel: aiLevel ?? this.aiLevel,
      advancedDataEdit: advancedDataEdit ?? this.advancedDataEdit,
      defaultConflict: defaultConflict ?? this.defaultConflict,
      confirmedPrivatePackages:
          confirmedPrivatePackages ?? this.confirmedPrivatePackages,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'safeMode': safeMode,
        'aiLevel': aiLevel.name,
        'advancedDataEdit': advancedDataEdit,
        'defaultConflict': defaultConflict.name,
        'confirmedPrivatePackages': confirmedPrivatePackages,
      };

  factory VfsPolicy.fromJson(Map<String, dynamic> json) {
    final raw = json['confirmedPrivatePackages'];
    final confirmed = <String>[];
    if (raw is List) {
      for (final item in raw) {
        final text = item?.toString() ?? '';
        if (text.isNotEmpty) confirmed.add(text);
      }
    }
    return VfsPolicy(
      safeMode: json['safeMode'] == true,
      aiLevel: AiAssistLevel.parse(json['aiLevel'] as String?),
      advancedDataEdit: json['advancedDataEdit'] == true,
      defaultConflict: VfsConflict.parse(json['defaultConflict'] as String?),
      confirmedPrivatePackages: confirmed,
    );
  }
}

/// 策略存储。
class VfsPolicyStore {
  static const FlutterSecureStorage _storage = FlutterSecureStorage();
  static const String _key = 'vfs_policy';

  /// 读策略。读不到就用默认值——策略读不出来不该让 App 起不来。
  static Future<VfsPolicy> load() async {
    try {
      final raw = await _storage.read(key: _key);
      if (raw == null || raw.isEmpty) return const VfsPolicy();
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) return VfsPolicy.fromJson(decoded);
      return const VfsPolicy();
    } catch (_) {
      return const VfsPolicy();
    }
  }

  /// 写策略。
  static Future<void> save(VfsPolicy policy) async {
    try {
      await _storage.write(key: _key, value: jsonEncode(policy.toJson()));
    } catch (_) {
      // 写不进策略不该崩 App：策略缺失的后果是「回到默认」，不是「不能用」。
    }
  }
}
