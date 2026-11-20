// khy-canary: Khy-20261101-096-E23HSRAS
import 'dart:async';
import 'dart:convert';

/// Permission levels for tool execution
enum PermissionLevel { auto, ask, deny }

/// Result of a tool execution
class ToolResult {
  final bool success;
  final String output;
  final Map<String, dynamic>? metadata;

  const ToolResult({required this.success, required this.output, this.metadata});

  factory ToolResult.ok(String output, {Map<String, dynamic>? metadata}) =>
      ToolResult(success: true, output: output, metadata: metadata);

  factory ToolResult.fail(String error) =>
      ToolResult(success: false, output: error);

  /// 这条结果被当成 tool 消息回灌给模型时用的正文。
  ///
  /// `writeDiff` 是给卡片画红绿 ± 行用的前后原文，一整份文件跟着每一次写盘
  /// 回灌就等于把同一份文件多发一遍（还占上下文）。卡片要它，模型不要它。
  String get jsonOutput {
    final meta = metadata;
    Map<String, dynamic>? sendable;
    if (meta != null) {
      sendable = Map<String, dynamic>.from(meta)..remove('writeDiff');
      if (sendable.isEmpty) sendable = null;
    }
    return jsonEncode({
      'success': success,
      'output': output,
      'metadata': ?sendable,
    });
  }
}

/// Tool definition
class ToolDef {
  final String name;
  final String description;
  final Map<String, dynamic> inputSchema;
  final PermissionLevel permission;
  final Future<ToolResult> Function(Map<String, dynamic> args) execute;
  final List<String> tags;

  const ToolDef({
    required this.name,
    required this.description,
    required this.inputSchema,
    required this.execute,
    this.permission = PermissionLevel.auto,
    this.tags = const [],
  });

  /// Convert to OpenAI function calling format
  Map<String, dynamic> toFunctionSchema() => {
    'type': 'function',
    'function': {
      'name': name,
      'description': description,
      'parameters': inputSchema,
    },
  };
}

/// Tool execution hook
typedef ToolHook = Future<void> Function(String toolName, Map<String, dynamic> args, ToolResult? result);

/// Zen body 门补的合成工具名 → 注册表里的真工具名。
///
/// 为什么要这张表：body 门（zen_gate.dart 的 applyBodyGate）给每个 Zen 请求
/// 补上名为 `bash` / `read` 的工具声明，而上游模型真去调时用的就是这两个名字，
/// 注册表里却只有 exec_shell / read_file。不映射的话模型每次调用都吃
/// 「工具不存在」，白烧五轮循环里的一轮。
///
/// 只换名字，不换权限：权限判定和钩子都按 canonical 名走，别名不能成为
/// 绕过 exec_shell 自身 permission 的口子。
const Map<String, String> kToolAliases = {
  'bash': 'exec_shell',
  'read': 'read_file',
};

/// 别名工具的参数键 → canonical 工具的参数键。上游按 body 门的 schema 传
/// `filePath`，而 read_file 收的是 `path`。
const Map<String, Map<String, String>> _aliasArgKeys = {
  'read': {'filePath': 'path', 'file_path': 'path'},
};

/// The tool engine: registry + execution + hooks + permissions
class ToolEngine {
  final Map<String, ToolDef> _tools = {};
  final Map<String, PermissionLevel> _permissions = {};
  final List<ToolHook> _beforeHooks = [];
  final List<ToolHook> _afterHooks = [];

  /// Register a tool
  void register(ToolDef tool) {
    _tools[tool.name] = tool;
  }

  /// Register multiple tools
  void registerAll(List<ToolDef> tools) {
    for (final t in tools) {
      _tools[t.name] = t;
    }
  }

  /// Get all registered tools
  List<ToolDef> get allTools => _tools.values.toList();

  /// Get tool by name
  ToolDef? getTool(String name) => _tools[name];

  /// Set permission for a tool
  void setPermission(String toolName, PermissionLevel level) {
    _permissions[toolName] = level;
  }

  /// Get permission for a tool
  ///
  /// Falls back to what the tool DECLARED, not to `auto`.
  ///
  /// This used to default to `PermissionLevel.auto`, which made every declared
  /// `ask` a lie: nothing ever called `setPermission`, so `getPermission` always
  /// returned `auto` and a tool marked `ask` ran without a prompt.
  /// `vision_tap` declares `ask` and was silently auto-approved for exactly this
  /// reason. The declaration is the tool author's statement about the tool, so
  /// it has to be the default — an explicit `setPermission` still overrides it.
  PermissionLevel getPermission(String toolName) {
    final explicit = _permissions[toolName];
    if (explicit != null) return explicit;
    return _tools[toolName]?.permission ?? PermissionLevel.auto;
  }

  /// Check if tool can execute
  bool canExecute(String toolName) =>
      getPermission(toolName) != PermissionLevel.deny;

  /// Add before-execution hook
  void addBeforeHook(ToolHook hook) => _beforeHooks.add(hook);

  /// Add after-execution hook
  void addAfterHook(ToolHook hook) => _afterHooks.add(hook);

  /// Execute a tool by name
  Future<ToolResult> execute(String toolName, Map<String, dynamic> args) async {
    final canonical = kToolAliases[toolName] ?? toolName;
    final tool = _tools[canonical];
    if (tool == null) {
      // Name what DOES exist.
      //
      // This used to be a bare "Tool not found: X", which is the single most
      // common way a hallucinated tool name surfaces. The model reads it, has no
      // idea whether it mistyped or invented the tool, and retries the same
      // name — or worse, concludes the capability is missing and tells the user
      // it cannot be done.
      //
      // Listing the real names costs one string and turns a dead end into a
      // correction. It also makes the planner sub-agent's validation partly
      // redundant for this one case, which is why that wiring was deferred
      // rather than done: the user-visible defect was closable in one line.
      final known = _tools.keys.toList(growable: false)..sort();
      return ToolResult.fail(
        '工具 "$toolName" 不存在。已注册的工具（${_tools.length} 个）：'
        '${known.join('、')}。请从这些名字里选一个，不要改用别的叫法。',
      );
    }

    if (!canExecute(canonical)) {
      return ToolResult.fail('Tool denied: $canonical');
    }

    final effectiveArgs = _canonicalArgs(toolName, canonical, args);

    // Before hooks
    for (final hook in _beforeHooks) {
      try {
        await hook(canonical, effectiveArgs, null);
      } catch (_) {}
    }

    // Execute
    ToolResult result;
    try {
      result = await tool.execute(effectiveArgs);
    } catch (e) {
      result = ToolResult.fail('Tool error: $e');
    }

    // After hooks
    for (final hook in _afterHooks) {
      try {
        await hook(canonical, effectiveArgs, result);
      } catch (_) {}
    }

    return result;
  }

  /// 把别名工具收到的参数改成 canonical 工具认的键名。
  ///
  /// 只在原键缺、目标键也没有时补；调用方已经传对（或两个都传）时不覆盖，
  /// 免得把显式参数改掉。
  static Map<String, dynamic> _canonicalArgs(
    String toolName,
    String canonical,
    Map<String, dynamic> args,
  ) {
    if (toolName == canonical) return args;
    final renames = _aliasArgKeys[toolName];
    if (renames == null || renames.isEmpty) return args;
    var changed = false;
    final out = Map<String, dynamic>.from(args);
    renames.forEach((from, to) {
      if (!out.containsKey(from)) return;
      if (!out.containsKey(to)) out[to] = out[from];
      if (from != to) out.remove(from);
      changed = true;
    });
    return changed ? out : args;
  }

  /// Generate OpenAI function schemas for all tools
  List<Map<String, dynamic>> toFunctionSchemas() =>
      _tools.values.map((t) => t.toFunctionSchema()).toList();

  /// Get tool names for system prompt
  String toolNamesString() =>
      _tools.keys.map((k) => '- $k').join('\n');

  /// Execute tool calls from OpenAI response
  Future<List<Map<String, dynamic>>> executeToolCalls(
    List<Map<String, dynamic>> toolCalls,
  ) async {
    final results = <Map<String, dynamic>>[];
    for (final tc in toolCalls) {
      final id = tc['id'] ?? '';
      final fn = tc['function'] ?? {};
      final name = fn['name'] ?? '';
      final argsStr = fn['arguments'] ?? '{}';

      Map<String, dynamic> args;
      try {
        args = jsonDecode(argsStr) as Map<String, dynamic>;
      } catch (_) {
        args = {};
      }

      final result = await execute(name, args);
      results.add({
        'tool_call_id': id,
        'role': 'tool',
        'content': result.jsonOutput,
      });
    }
    return results;
  }
}
