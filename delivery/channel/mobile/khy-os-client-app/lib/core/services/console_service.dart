import 'dart:convert';

import 'package:flutter/services.dart';

/// 控制台状态：一条命令的结局。
///
/// 三类失败各有各的文案与处置，不混成「失败」——用户需要知道该改哪边：
/// 参数不合法 → 改命令；工具不可用 → 去授权；执行报错 → 读错误详情。
enum ConsoleStatus {
  ok,
  invalidArgs,
  toolUnavailable,
  execError,
  unknown;

  static ConsoleStatus parse(String? raw) {
    switch (raw) {
      case 'ok':
        return ConsoleStatus.ok;
      case 'invalid_args':
        return ConsoleStatus.invalidArgs;
      case 'tool_unavailable':
        return ConsoleStatus.toolUnavailable;
      case 'exec_error':
        return ConsoleStatus.execError;
      default:
        return ConsoleStatus.unknown;
    }
  }

  /// 顶部分类标签。
  String get label {
    switch (this) {
      case ConsoleStatus.ok:
        return '成功';
      case ConsoleStatus.invalidArgs:
        return '参数不合法';
      case ConsoleStatus.toolUnavailable:
        return '工具不可用';
      case ConsoleStatus.execError:
        return '执行报错';
      case ConsoleStatus.unknown:
        return '未知状态';
    }
  }

  /// 分类决定用户该做什么。
  String get remedy {
    switch (this) {
      case ConsoleStatus.ok:
        return '';
      case ConsoleStatus.invalidArgs:
        return '命令本身有问题：改参数后重发';
      case ConsoleStatus.toolUnavailable:
        return '命令没问题，但这里跑不了：补授权或换工具';
      case ConsoleStatus.execError:
        return '命令跑了但失败：看上面的错误详情';
      case ConsoleStatus.unknown:
        return '状态未知，原样保留供排查';
    }
  }

  bool get isOk => this == ConsoleStatus.ok;
}

/// 命令来源。手动敲的和 Amoo 产出的走同一条通道，记录里用这个区分。
const String kConsoleOriginManual = 'manual';
const String kConsoleOriginAmoo = 'amoo';

/// 服务端经出向链路（`BridgeLink`）下发的一条指令。
///
/// WHY 单独一个取值而不是并进 manual：`console_history.jsonl` 是共享历史，
/// 「这条是谁按下的」必须一眼可辨。把远程下发的指令记成「手动」，事后追责时
/// 分不清是人敲的还是 PC 推的。
const String kConsoleOriginLink = 'link';

/// 可空是因为这个值来自原生响应里的一个字段：字段缺失时它是 null，
/// 而那正是最需要给出一个确定答案的时刻。
String consoleOriginLabel(String? origin) {
  if (origin == kConsoleOriginAmoo) return 'Amoo';
  if (origin == kConsoleOriginLink) return '链路';
  return '手动';
}

/// 这段文本是一条本地命令，而不是一句给 amoo 的话吗？
///
/// 判据与原生侧 `AmooLoop.looksLikeCommand` 逐条对应（那边问的是
/// `KhyConsole.prepare` 有没有认出 tool 字段）： trim 后以 `{` 开头、能解析成
/// 对象、且 `tool` 是非空字符串。三缺一即「不是命令」。
///
/// 为什么值得在 Dart 侧也判一次：聊天页的 amoo 发送面板原来把任何文本都
/// `shareText` 出去，于是粘进来的 JSON 命令会跳去 amoo 的分享页——它本来在
/// 本机就能跑，跑完还该以卡片形式回到控制台里。判定必须发生在**跳之前**，
/// 而跳是 Dart 侧发起的。
///
/// 保守方向选「不像命令」：一句以 `{` 开头的人话不会被误判成命令，最多多跳
/// 一次；而反过来会把一句提问送去执行，那是拿用户的话当命令跑。
bool looksLikeConsoleCommand(String text) {
  final t = text.trim();
  if (t.isEmpty || !t.startsWith('{')) return false;
  try {
    final v = jsonDecode(t);
    if (v is! Map) return false;
    final tool = v['tool'];
    return tool is String && tool.trim().isNotEmpty;
  } catch (_) {
    return false;
  }
}

/// 一条命令的完整记录：请求 + 响应 + 结局。
class ConsoleEntry {
  final String id;
  final int ts;
  final String origin;
  final String tool;
  final String raw;
  final Map<String, dynamic> args;
  final String statusRaw;
  final String error;
  final String hint;
  final String needsAuth;
  final String capabilityNote;
  final Map<String, dynamic> result;

  const ConsoleEntry({
    required this.id,
    required this.ts,
    required this.origin,
    required this.tool,
    required this.raw,
    required this.args,
    required this.statusRaw,
    required this.error,
    required this.hint,
    required this.needsAuth,
    required this.capabilityNote,
    required this.result,
  });

  factory ConsoleEntry.fromMap(Map<String, dynamic> m) {
    return ConsoleEntry(
      id: (m['id'] ?? '').toString(),
      ts: (m['ts'] is num) ? (m['ts'] as num).toInt() : 0,
      origin: (m['origin'] ?? kConsoleOriginManual).toString(),
      tool: (m['tool'] ?? '').toString(),
      raw: (m['raw'] ?? '').toString(),
      args: _mapOf(m['args']),
      statusRaw: (m['status'] ?? 'unknown').toString(),
      error: (m['error'] ?? '').toString(),
      hint: (m['hint'] ?? '').toString(),
      needsAuth: (m['needs_auth'] ?? '').toString(),
      capabilityNote: (m['capability_note'] ?? '').toString(),
      result: _mapOf(m['result']),
    );
  }

  ConsoleStatus get status => ConsoleStatus.parse(statusRaw);
  bool get isAmoo => origin == kConsoleOriginAmoo;

  /// 时间戳 → 「14:03:22」。
  String get timeText {
    final d = DateTime.fromMillisecondsSinceEpoch(ts);
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(d.hour)}:${two(d.minute)}:${two(d.second)}';
  }

  /// 原始响应，raw JSON 视图直接用它。
  String get rawJson {
    final buf = StringBuffer();
    try {
      buf.writeln(jsonEncode({
        'id': id,
        'ts': ts,
        'origin': origin,
        'tool': tool,
        'args': args,
        'status': statusRaw,
        'error': error,
        'hint': hint,
        'needs_auth': needsAuth,
        'capability_note': capabilityNote,
        'result': result,
      }));
    } catch (_) {
      buf.writeln('{}');
    }
    return buf.toString().trimRight();
  }

  static Map<String, dynamic> _mapOf(dynamic v) {
    if (v is Map) return Map<String, dynamic>.from(v);
    return <String, dynamic>{};
  }
}

/// 工具面板里的一项。
class ConsoleTool {
  final String name;
  final String desc;
  final String group;
  final List<String> required;
  final List<List<String>> optional;
  final List<String> oneOf;
  final bool needsA11y;
  final bool available;

  const ConsoleTool({
    required this.name,
    required this.desc,
    required this.group,
    required this.required,
    required this.optional,
    required this.oneOf,
    required this.needsA11y,
    required this.available,
  });

  factory ConsoleTool.fromMap(Map<String, dynamic> m) {
    // required 与 optional 都是 [name, type] 二元组：原生的 schema 给必填参数
    // 也带了类型，少了类型就没法在调用前挡住「数字传给了字符串参数」。
    List<String> reqNames(dynamic v) {
      if (v is! List) return const <String>[];
      final out = <String>[];
      for (final e in v) {
        if (e is List && e.isNotEmpty) {
          out.add(e[0].toString());
        } else if (e != null) {
          out.add(e.toString());
        }
      }
      return out;
    }

    final opt = <List<String>>[];
    final rawOpt = m['optional'];
    if (rawOpt is List) {
      for (final e in rawOpt) {
        if (e is List && e.isNotEmpty) {
          opt.add([e[0].toString(), e.length > 1 ? e[1].toString() : 'any']);
        }
      }
    }
    return ConsoleTool(
      name: (m['name'] ?? '').toString(),
      desc: (m['desc'] ?? '').toString(),
      group: (m['group'] ?? '').toString(),
      required: reqNames(m['required']),
      optional: opt,
      oneOf: reqNames(m['one_of']),
      needsA11y: m['needs_a11y'] == true,
      available: m['available'] != false,
    );
  }

  /// 一条可以直接粘进输入框的示例命令。
  String get sample {
    final args = <String, dynamic>{};
    for (final r in required) {
      args[r] = _sampleFor(r);
    }
    if (required.isEmpty && oneOf.isNotEmpty) {
      args[oneOf.first] = _sampleFor(oneOf.first);
    }
    return jsonEncode({'tool': name, 'args': args});
  }

  /// 示例取值。坐标类给数字、其余给字符串——给错了类型反而误导。
  Object _sampleFor(String arg) {
    switch (arg) {
      case 'path':
        return '/sdcard/khy-os';
      case 'dest':
        return '/sdcard/khy-os/copy.txt';
      case 'out':
        return '/sdcard/khy-os/out.zip';
      case 'cmd':
        return 'echo hello';
      case 'text':
        return '你好';
      case 'content':
        return 'hello';
      case 'url':
        return 'https://example.com';
      case 'package':
        return 'com.stepos.ailauncher';
      case 'name':
        return 'demo';
      case 'value':
        return 'demo-value';
      case 'code':
        return '000000';
      case 'prompt':
        return '现在手机电量多少？';
      case 'x':
      case 'y':
      case 'x1':
      case 'y1':
      case 'x2':
      case 'y2':
        return 100;
      default:
        return '';
    }
  }
}

/// 一条常用指令。
class ConsoleFavorite {
  final String id;
  final String label;
  final String json;
  final String tool;

  const ConsoleFavorite({
    required this.id,
    required this.label,
    required this.json,
    required this.tool,
  });

  factory ConsoleFavorite.fromMap(Map<String, dynamic> m) => ConsoleFavorite(
        id: (m['id'] ?? '').toString(),
        label: (m['label'] ?? '').toString(),
        json: (m['json'] ?? '').toString(),
        tool: (m['tool'] ?? '').toString(),
      );
}

/// 导出结果。
class ConsoleExport {
  final bool ok;
  final String path;
  final int lines;
  final String error;

  const ConsoleExport({
    required this.ok,
    required this.path,
    required this.lines,
    required this.error,
  });

  factory ConsoleExport.fromMap(Map<String, dynamic> m) => ConsoleExport(
        ok: m['ok'] == true,
        path: (m['path'] ?? '').toString(),
        lines: (m['lines'] is num) ? (m['lines'] as num).toInt() : 0,
        error: (m['error'] ?? '').toString(),
      );
}

/// 唤起 Amoo 的结果。
class AmooSummonResult {
  final bool ok;
  final bool loopRunning;
  final bool contextAttached;
  final List<String> notes;

  const AmooSummonResult({
    required this.ok,
    required this.loopRunning,
    required this.contextAttached,
    required this.notes,
  });

  factory AmooSummonResult.fromMap(Map<String, dynamic> m) {
    final notes = <String>[];
    final raw = m['notes'];
    if (raw is List) {
      for (final e in raw) {
        notes.add(e.toString());
      }
    }
    return AmooSummonResult(
      ok: m['ok'] == true,
      loopRunning: m['loop_running'] == true,
      contextAttached: m['context_attached'] == true,
      notes: notes,
    );
  }
}

/// 重置令牌的回执。
///
/// 只有指纹（前 8 位 + 生效时间戳）过这条通道——完整令牌只存在于设备上的
/// token.txt，PC 侧自己读。把全文送进界面或日志，等于给截图和日志 readers
/// 发一份凭证。
class ConsoleTokenReset {
  final bool ok;
  final String oldFingerprint;
  final String newFingerprint;
  final int oldFpAt;
  final int newFpAt;
  final int oldAgeMs;

  /// 新令牌是否落盘。false = 只在手机内存里，PC 侧拿到的还是盘上的旧值。
  final bool persisted;
  final String error;

  const ConsoleTokenReset({
    required this.ok,
    required this.oldFingerprint,
    required this.newFingerprint,
    required this.oldFpAt,
    required this.newFpAt,
    required this.oldAgeMs,
    required this.persisted,
    required this.error,
  });

  factory ConsoleTokenReset.fromMap(Map<String, dynamic> m) => ConsoleTokenReset(
        ok: m['ok'] == true,
        oldFingerprint: (m['old_fingerprint'] ?? '').toString(),
        newFingerprint: (m['new_fingerprint'] ?? '').toString(),
        oldFpAt: (m['old_fp_at'] is num) ? (m['old_fp_at'] as num).toInt() : 0,
        newFpAt: (m['new_fp_at'] is num) ? (m['new_fp_at'] as num).toInt() : 0,
        oldAgeMs: (m['old_age_ms'] is num) ? (m['old_age_ms'] as num).toInt() : -1,
        persisted: m['persisted'] == true,
        error: (m['error'] ?? '').toString(),
      );

  String get oldTimeText => _fmt(oldFpAt);
  String get newTimeText => _fmt(newFpAt);

  static String _fmt(int ms) {
    if (ms <= 0) return '未知';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(d.hour)}:${two(d.minute)}:${two(d.second)}';
  }
}

/// 一页历史记录，连同它的存储位置一起返回。///
/// 为什么要把 path/shared 带出来：共享目录（/sdcard/bridge-amoobridge）不可写时，
/// 原生侧会静默回退到 App 私有目录。那时「khy-os 与 Amoo 读写同一份记录」这个
/// 前提已经不成立，而界面上看不出任何差别——正是最难查的那类静默失败。
/// 所以这两个字段必须原样送到界面，让用户能看见。
class ConsoleHistoryPage {
  final List<ConsoleEntry> entries;

  /// 历史文件的实际绝对路径。
  final String path;

  /// 是否落在共享目录（false = 已回退到 App 私有目录，Amoo 侧读不到）。
  final bool shared;

  const ConsoleHistoryPage({
    required this.entries,
    required this.path,
    required this.shared,
  });
}

/// 控制台服务：本地命令通道的 Dart 一侧。
///
/// 通道全部走本机 MethodChannel（`com.khyos.khy_os_client/device`），不经过任何
/// 云端：解析、校验、执行、回显都在手机上完成，断网可用是硬要求。
///
/// 三类失败在原生侧就已分好类，这里只做翻译，不重新判断——重新判断就等于
/// 有两份规则，迟早会不一致。
class ConsoleService {
  static const MethodChannel _channel =
      MethodChannel('com.khyos.khy_os_client/device');

  // ── 调用 ────────────────────────────────────────────────────────────────

  /// 执行一条命令。原生侧负责解析、校验、执行、落盘。
  ///
  /// 返回 null 表示通道本身断了（原生层不存在或抛异常）——那不是「命令失败」，
  /// 是「控制台不可用」，两者的处置完全不同。
  static Future<ConsoleEntry?> exec(String json,
      {String origin = kConsoleOriginManual}) async {
    try {
      final res = await _channel.invokeMethod('consoleExec', {
        'json': json,
        'origin': origin,
      });
      if (res is Map) return ConsoleEntry.fromMap(Map<String, dynamic>.from(res));
      return null;
    } catch (_) {
      return null;
    }
  }

  /// 工具清单（含每个工具是否可用、是否需要无障碍）。
  static Future<List<ConsoleTool>> tools() async {
    try {
      final res = await _channel.invokeMethod('consoleTools');
      final out = <ConsoleTool>[];
      if (res is Map) {
        final list = res['tools'];
        if (list is List) {
          for (final e in list) {
            if (e is Map) {
              out.add(ConsoleTool.fromMap(Map<String, dynamic>.from(e)));
            }
          }
        }
      }
      return out;
    } catch (_) {
      return const [];
    }
  }

  /// 最近的历史记录（新的在前）。
  static Future<List<ConsoleEntry>> history({int limit = 100}) async {
    return (await historyPage(limit: limit)).entries;
  }

  /// 历史记录连同存储位置一起取。
  static Future<ConsoleHistoryPage> historyPage({int limit = 100}) async {
    try {
      final res = await _channel.invokeMethod('consoleHistory', {'limit': limit});
      final out = <ConsoleEntry>[];
      var path = '';
      var shared = true;
      if (res is Map) {
        final m = Map<String, dynamic>.from(res);
        path = (m['path'] ?? '').toString();
        shared = m['shared'] != false;
        final list = m['entries'];
        if (list is List) {
          for (final e in list) {
            if (e is Map) {
              out.add(ConsoleEntry.fromMap(Map<String, dynamic>.from(e)));
            }
          }
        }
      }
      return ConsoleHistoryPage(entries: out, path: path, shared: shared);
    } catch (_) {
      return const ConsoleHistoryPage(
        entries: [],
        path: '',
        shared: false,
      );
    }
  }

  /// 历史文件落在哪里（共享目录 / 应用私有目录）。
  static Future<String> historyPath() async {
    try {
      final res = await _channel.invokeMethod('consoleHistory', {'limit': 1});
      if (res is Map) return (res['path'] ?? '').toString();
      return '';
    } catch (_) {
      return '';
    }
  }

  static Future<bool> clearHistory() async {
    try {
      final res = await _channel.invokeMethod('consoleClear');
      return res is Map && res['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  /// 导出历史到文件。
  static Future<ConsoleExport?> export({String? path}) async {
    try {
      final res = await _channel.invokeMethod('consoleExport', {
        if (path != null && path.isNotEmpty) 'path': path,
      });
      if (res is Map) return ConsoleExport.fromMap(Map<String, dynamic>.from(res));
      return null;
    } catch (_) {
      return null;
    }
  }

  /// 常用指令。
  static Future<List<ConsoleFavorite>> favorites() async {
    try {
      final res = await _channel.invokeMethod('consoleFavorites', {'op': 'get'});
      final out = <ConsoleFavorite>[];
      if (res is Map) {
        final list = res['items'];
        if (list is List) {
          for (final e in list) {
            if (e is Map) {
              out.add(ConsoleFavorite.fromMap(Map<String, dynamic>.from(e)));
            }
          }
        }
      }
      return out;
    } catch (_) {
      return const [];
    }
  }

  /// 存一条常用指令。原生侧会先校验，跑不通的存不进去。
  static Future<ConsoleFavorite?> addFavorite(String label, String json) async {
    try {
      final res = await _channel.invokeMethod('consoleFavorites', {
        'op': 'add',
        'label': label,
        'json': json,
      });
      if (res is Map && res['ok'] == true) {
        final item = res['item'];
        if (item is Map) {
          return ConsoleFavorite.fromMap(Map<String, dynamic>.from(item));
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  static Future<bool> removeFavorite(String id) async {
    try {
      final res = await _channel.invokeMethod('consoleFavorites', {
        'op': 'remove',
        'id': id,
      });
      return res is Map && res['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  /// 取一条外部带进来的待预填命令（intent extra `khy_console_cmd_b64`）。
  ///
  /// 只预填、不执行：执行永远要用户在面板上按一下，所以这不是一条绕过确认的
  /// 通道。它存在是为了快捷方式 / 通知 / 自动化验收能直接落到控制台里。
  static Future<String> pendingCommand() async {
    try {
      final res = await _channel.invokeMethod('consolePending');
      if (res is Map) return (res['command'] ?? '').toString();
      return '';
    } catch (_) {
      return '';
    }
  }

  /// 按需唤起 Amoo：打开它的聊天页，并让它产出的命令走同一条控制台通道。
  ///
  /// [withContext] 为真时会把当前命令与结果写进 Amoo 的输入框（不发送）。
  static Future<AmooSummonResult?> summonAmoo({
    bool withContext = true,
    String mode = 'bypass',
  }) async {
    try {
      final res = await _channel.invokeMethod('amooSummon', {
        'with_context': withContext,
        'mode': mode,
      });
      if (res is Map) {
        return AmooSummonResult.fromMap(Map<String, dynamic>.from(res));
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /// 重置桥的访问令牌。旧令牌即刻失效，新令牌铸成并尝试落盘。
  ///
  /// 返回 null 表示通道本身断了（原生层不存在或抛异常）——与 exec 的语义一致：
  /// 那是「控制台不可用」，不是「重置失败」。
  static Future<ConsoleTokenReset?> resetToken() async {
    try {
      final res = await _channel.invokeMethod('consoleResetToken');
      if (res is Map) {
        return ConsoleTokenReset.fromMap(Map<String, dynamic>.from(res));
      }
      return null;
    } catch (_) {
      return null;
    }
  }
}
