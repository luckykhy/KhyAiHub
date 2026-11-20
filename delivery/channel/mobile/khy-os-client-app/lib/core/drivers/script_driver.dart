// khy-canary: Khy-20261113-005-P4ASCRIPT
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:path_provider/path_provider.dart';

/// 一个脚本定义（用户放在 drivers/ 目录里的 JSON）。
///
/// 输入/输出约定与 DriverEvent 对齐：driver 产出的事件就是渲染层的唯一
/// 输入，脚本不需要知道任何渲染细节。
class ScriptDefinition {
  final String id;
  final String name;

  /// 'reply' = 固定回复；'echo' = 回显用户输入。
  final String mode;
  final String reply;

  const ScriptDefinition({
    required this.id,
    required this.name,
    this.mode = 'reply',
    this.reply = '',
  });

  static ScriptDefinition? fromJson(Map<String, dynamic> json) {
    final id = (json['id'] ?? '').toString().trim();
    if (id.isEmpty) return null; // 没有 id 的定义没法被会话引用
    return ScriptDefinition(
      id: id,
      name: (json['name'] ?? id).toString(),
      mode: (json['mode'] ?? 'reply').toString(),
      reply: (json['reply'] ?? '').toString(),
    );
  }
}

/// script driver（§2.4）：本地脚本自动化作为第 4 个 driver。
///
/// **本轮范围（如实标注）**：声明式脚本——读用户放在 drivers/ 目录里的
/// JSON 定义，按 mode 产出回复。任意脚本的沙箱执行是 [DESIGN-ARCH-195] T3
/// 的议题（按能力 manifest 授权），本设计不另起炉灶，也不假装能执行。
///
/// 目录来自 P1 的 ensureRuntimeDirs（首次运行自建，不预置占位文件）——
/// 空目录 = 没有脚本，driver 明确失败而不是静默空流转。
class ScriptDriver implements Driver {
  ScriptDriver({Future<List<ScriptDefinition>> Function()? source, AppConfigData? config})
      : _source = source ?? _readDefinitionsFromDisk,
        _config = config ?? const AppConfigData(baseUrl: '', apiKey: '', model: '');

  final Future<List<ScriptDefinition>> Function() _source;
  final AppConfigData _config;

  DriverHealth _health = DriverHealth.ok;

  @override
  String get id => 'script';

  @override
  bool get enabled => !_config.isDriverDisabled('script');

  @override
  DriverHealth health() => _health;

  @override
  Future<void> openSession(String sessionId, SessionContext ctx) async {
    // 无状态：脚本定义每次 send 现读（用户改完文件下一轮就生效，
    // 不需要重启 driver——「改了没生效」是这类功能最常见的抱怨）。
  }

  @override
  Stream<DriverEvent> send(UserTurn turn) async* {
    final List<ScriptDefinition> defs;
    try {
      defs = await _source();
    } catch (e) {
      _health = DriverHealth.down;
      yield DriverFailed(error: e, retryable: true);
      return;
    }
    if (defs.isEmpty) {
      _health = DriverHealth.down;
      yield DriverFailed(
        error: 'drivers/ 目录里没有脚本定义：放一个 JSON（id/name/mode/reply）再试',
        retryable: true,
      );
      return;
    }

    for (final def in defs) {
      yield DriverStarted(sessionId: turn.sessionId, turnId: '${turn.turnId}_${def.id}');
      final text = def.mode == 'echo' ? turn.text : def.reply;
      yield DriverDelta(kind: 'content', text: text);
      yield DriverFinished(turnId: '${turn.turnId}_${def.id}', reason: 'completed');
    }
  }

  @override
  Future<void> abort(String sessionId) async {
    // 声明式脚本无执行中状态，abort 是空操作。
  }

  @override
  Future<void> dispose() async {}

  /// 默认源：读 App 私有目录 drivers/ 下的 *.json。
  ///
  /// 路径与 main.dart 的 ensureRuntimeDirs 建的是同一个目录；测试注入
  /// source，永远走不到 path_provider（flutter_test 里它没有平台实现）。
  static Future<List<ScriptDefinition>> _readDefinitionsFromDisk() async {
    final docs = await getApplicationDocumentsDirectory();
    final dir = Directory('${docs.path}/drivers');
    if (!await dir.exists()) return const [];
    final out = <ScriptDefinition>[];
    await for (final entity in dir.list()) {
      if (entity is! File || !entity.path.endsWith('.json')) continue;
      try {
        final decoded = jsonDecode(await entity.readAsString());
        if (decoded is Map) {
          final def = ScriptDefinition.fromJson(decoded.cast<String, dynamic>());
          if (def != null) out.add(def);
        }
      } catch (_) {
        // 坏文件跳过：一个手写坏的 JSON 不该让整个 driver 不可用。
      }
    }
    return out;
  }
}
