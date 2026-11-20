// khy-canary: Khy-20261113-001-P1THC
import 'package:khy_os_client/core/tools/tool_engine.dart';

/// driver 请求了一个 Tool Host 里不存在的工具名。
///
/// 拒绝执行而不是降级到别的工具：降级会让「调用成功了」变成假象，
/// 而模型看到的失败反馈（含可用名字）才是它自我纠正的依据。
class UnregisteredCapabilityError extends Error {
  final String name;
  final List<String> known;
  UnregisteredCapabilityError(this.name, this.known);

  @override
  String toString() =>
      '能力 "$name" 未在 Tool Host 注册（已注册 ${known.length} 个）：${known.join('、')}';
}

/// 能力清单条目。UI 呈现、外部调用、判定脚本都读同一份（§3.1）。
class CapabilityEntry {
  final String name;
  final String description;
  const CapabilityEntry({required this.name, required this.description});
}

/// Driver → Tool Host 的唯一门（§2.1）。
///
/// driver 不得自维护工具清单：能力清单的唯一真相是这里的 capabilities()，
/// 它来自 Tool Host 注册表快照。
abstract class ToolHostClient {
  List<CapabilityEntry> capabilities();

  /// name 必须在 capabilities() 返回值内，否则抛 UnregisteredCapabilityError。
  Future<ToolResult> invoke(String name, Map<String, Object?> args, {String? callId});
}

/// 包既有 ToolEngine 的 ToolHostClient 实现。
///
/// 原生桥工具经 MethodChannel 到 Tools.dispatch，由各 driver 的实现内部
/// 经这个门发出——Dart 侧不直接 import 原生层。
class ToolEngineHostClient implements ToolHostClient {
  ToolEngineHostClient(this._engine);

  final ToolEngine _engine;

  @override
  List<CapabilityEntry> capabilities() {
    final entries = _engine.allTools
        .map((t) => CapabilityEntry(name: t.name, description: t.description))
        .toList();
    entries.sort((a, b) => a.name.compareTo(b.name));
    return entries;
  }

  @override
  Future<ToolResult> invoke(String name, Map<String, Object?> args, {String? callId}) async {
    final known = _engine.allTools.map((t) => t.name).toList()..sort();
    if (!known.contains(name)) throw UnregisteredCapabilityError(name, known);
    return _engine.execute(name, args.cast<String, dynamic>());
  }
}
