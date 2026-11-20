// 自动化脚本：文件操作的录制产物。
//
// 形态是 JSON 文件而不是二进制 blob，理由很直接：脚本要能被**打开看、被手改、
// 被逐步执行**。这一版 App 的原则是「AI 不黑盒」，自动化脚本同理——一个看不懂
// 也改不了的文件，等于把用户的文件操作交给了一个没人能审计的东西。
//
// 触发器三选一：手动跑、定时跑、目录事件。三个都有执行器——手动是点「执行」，
// 定时走调度器，目录事件走原生 FileObserver → Dart 事件 → 绑定脚本。
// 脚本格式三种一致，将来加新触发器也不用改老脚本。

import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// 触发方式。
enum AutomationTrigger {
  /// 手动执行。
  manual,

  /// 定时执行。
  schedule,

  /// 目录事件（该目录新增/变更时触发）。
  directoryEvent;

  static AutomationTrigger parse(String? raw) {
    for (final trigger in AutomationTrigger.values) {
      if (trigger.name == raw) return trigger;
    }
    return AutomationTrigger.manual;
  }

  String get label {
    switch (this) {
      case AutomationTrigger.manual:
        return '手动执行';
      case AutomationTrigger.schedule:
        return '定时执行';
      case AutomationTrigger.directoryEvent:
        return '目录事件';
    }
  }
}

/// 这个触发方式的脚本能不能**手动**跑一次。
///
/// 只有**目录事件**不行，理由不是「没做出来」而是**会自己触发自己**：它的步骤要改
/// 监视目录里的东西，那本身又是一个目录事件 → 又触发这个脚本 → 脚本再改一次
/// → 无限循环（「复制 A 到 B」而 B 就在监视目录里时最明显）。
///
/// 定时触发器没有这个问题——它不在事件回路里，所以定时脚本**可以**手动跑。
/// （旧实现把定时和目录事件一起拦掉，还说成「触发器尚未接上执行器」，那时确实
/// 没接上；接上之后这句就一直没改，变成了假话。）
bool canRunManually(AutomationTrigger trigger) =>
    trigger != AutomationTrigger.directoryEvent;

/// 目录事件脚本不能手动跑时，给用户看的那句话。
///
/// 单独放成常量，是因为这句话要解释「**为什么不能**」，而不是「还没做出来」——
/// 后者已经不成立了，照抄旧话只会让人以为功能缺失。
const String kDirectoryEventManualRunHint =
    '「目录事件」脚本由目录变化自动触发。'
    '手动执行会自己触发自己——它改监视目录 → 又是一个目录事件。';

/// 脚本里的一步。
class AutomationStep {
  /// 操作名：copy / move / delete / rename / mkdir / write。
  final String op;

  /// 参数（路径等）。
  final Map<String, dynamic> args;

  const AutomationStep({required this.op, this.args = const <String, dynamic>{}});

  Map<String, dynamic> toJson() => <String, dynamic>{'op': op, 'args': args};

  factory AutomationStep.fromJson(Map<String, dynamic> json) {
    final raw = json['args'];
    final args = <String, dynamic>{};
    if (raw is Map) {
      raw.forEach((Object? key, Object? value) {
        args[key.toString()] = value;
      });
    }
    return AutomationStep(
      op: (json['op'] ?? '').toString(),
      args: args,
    );
  }

  /// 一句话描述（给界面看）。
  String get description {
    final source = (args['src'] ?? args['path'] ?? '').toString();
    final target = (args['dst'] ?? args['to'] ?? '').toString();
    switch (op) {
      case 'copy':
        return '复制「$source」→「$target」';
      case 'move':
        return '移动「$source」→「$target」';
      case 'delete':
        return '删除「$source」';
      case 'rename':
        return '重命名「$source」→「$target」';
      case 'mkdir':
        return '新建目录「$source」';
      case 'write':
        return '写入「$source」';
      default:
        return op;
    }
  }
}

/// 一个自动化脚本。
class AutomationScript {
  final String id;
  final String name;
  final AutomationTrigger trigger;

  /// 目录事件触发时监视的目录。
  final String watchDir;

  /// 定时触发的 cron 风格表达式（暂不解析，先存着）。
  final String schedule;

  final List<AutomationStep> steps;
  final bool enabled;

  const AutomationScript({
    required this.id,
    required this.name,
    this.trigger = AutomationTrigger.manual,
    this.watchDir = '',
    this.schedule = '',
    this.steps = const <AutomationStep>[],
    this.enabled = true,
  });

  AutomationScript copyWith({
    String? id,
    String? name,
    AutomationTrigger? trigger,
    String? watchDir,
    String? schedule,
    List<AutomationStep>? steps,
    bool? enabled,
  }) {
    return AutomationScript(
      id: id ?? this.id,
      name: name ?? this.name,
      trigger: trigger ?? this.trigger,
      watchDir: watchDir ?? this.watchDir,
      schedule: schedule ?? this.schedule,
      steps: steps ?? this.steps,
      enabled: enabled ?? this.enabled,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'name': name,
        'trigger': trigger.name,
        'watchDir': watchDir,
        'schedule': schedule,
        'enabled': enabled,
        'steps': steps.map((AutomationStep step) => step.toJson()).toList(),
      };

  factory AutomationScript.fromJson(Map<String, dynamic> json) {
    final rawSteps = json['steps'];
    final steps = <AutomationStep>[];
    if (rawSteps is List) {
      for (final item in rawSteps) {
        if (item is Map) {
          steps.add(AutomationStep.fromJson(
            item.map((Object? key, Object? value) =>
                MapEntry<String, dynamic>(key.toString(), value)),
          ));
        }
      }
    }
    return AutomationScript(
      id: (json['id'] ?? '').toString(),
      name: (json['name'] ?? '未命名脚本').toString(),
      trigger: AutomationTrigger.parse(json['trigger'] as String?),
      watchDir: (json['watchDir'] ?? '').toString(),
      schedule: (json['schedule'] ?? '').toString(),
      steps: steps,
      enabled: json['enabled'] != false,
    );
  }
}

/// 脚本仓库（存应用支持目录下的 `vfs/scripts.json`）。
abstract final class AutomationScriptStore {
  static File? _file;

  /// 读全部脚本。读不到就当空列表——脚本丢了不该让 App 起不来。
  static Future<List<AutomationScript>> load() async {
    try {
      final file = await _resolveFile();
      if (!await file.exists()) return const <AutomationScript>[];
      final raw = await file.readAsString();
      if (raw.trim().isEmpty) return const <AutomationScript>[];
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const <AutomationScript>[];
      final scripts = <AutomationScript>[];
      for (final item in decoded) {
        if (item is Map) {
          scripts.add(AutomationScript.fromJson(
            item.map((Object? key, Object? value) =>
                MapEntry<String, dynamic>(key.toString(), value)),
          ));
        }
      }
      return scripts;
    } catch (_) {
      return const <AutomationScript>[];
    }
  }

  /// 写回全部脚本。
  static Future<void> saveAll(List<AutomationScript> scripts) async {
    try {
      final file = await _resolveFile();
      await file.writeAsString(
        jsonEncode(
          scripts.map((AutomationScript script) => script.toJson()).toList(),
        ),
        flush: true,
      );
    } catch (_) {
      // 写不进去就把这件事吞掉：脚本没存上不该阻断用户正在做的文件操作。
    }
  }

  /// 导出单个脚本为 JSON 文本（便于分享、便于在文件管理器里直接查看）。
  static String export(AutomationScript script) =>
      const JsonEncoder.withIndent('  ').convert(script.toJson());

  static Future<File> _resolveFile() async {
    final cached = _file;
    if (cached != null) return cached;
    final support = await getApplicationSupportDirectory();
    final dir = Directory(p.join(support.path, 'vfs'));
    if (!await dir.exists()) await dir.create(recursive: true);
    final file = File(p.join(dir.path, 'scripts.json'));
    _file = file;
    return file;
  }
}
