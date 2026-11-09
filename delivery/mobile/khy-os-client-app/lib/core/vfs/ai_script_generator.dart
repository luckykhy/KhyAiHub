// AI 辅助生成自动化脚本。
//
// 目标里原话：「AI 可辅助生成脚本：用户在对话框描述需求，AI 输出脚本代码，
// 用户确认后保存到指定位置」。
//
// 三层信任关系，每层各管一件事：
//   1. **模型**：只产出 JSON 文本。它说什么不算数。
//   2. **解码器**：把 JSON 变成脚本，并校验每一步的操作类型与路径
//      （白名单 + 绝对路径 + 不碰系统分区）。不合规的步骤被丢弃并记录原因。
//   3. **人**：看到展开成步骤的预览，逐条看过，确认后才让脚本落盘。
//
// 「保存到指定位置」是字面意思：脚本存成**文件**（JSON），放在用户选的位置，
// 而不是只存在 App 私有存储里——用户要能看见它、能改它、能拷走它。

import 'dart:convert';

import 'package:dio/dio.dart';

import '../config/app_config.dart';
import 'ai_safety.dart';
import 'automation_script.dart';
import 'vfs_context.dart';

/// 生成结果。
class AiGeneratedScript {
  /// 解析并校验后的脚本（不合规时可能没有步骤）。
  final AutomationScript? script;

  /// 模型给的原始 JSON（给用户看、给用户改）。
  final String rawJson;

  /// 失败原因。
  final String? error;

  const AiGeneratedScript({this.script, this.rawJson = '', this.error});

  bool get ok => script != null && script!.steps.isNotEmpty;
}

/// 脚本生成器。
abstract final class AiScriptGenerator {
  /// 生成一份脚本。
  static Future<AiGeneratedScript> generate({
    required String requirement,
    required VfsContext context,
    AppConfigData? config,
  }) async {
    final text = requirement.trim();
    if (text.isEmpty) {
      return const AiGeneratedScript(error: '没有可执行的描述');
    }

    final cfg = config ?? await AppConfig.loadEffective();
    if (!cfg.isConfigured) {
      return const AiGeneratedScript(
        error: '未配置模型，无法生成脚本。请先在设置里配置模型。',
      );
    }

    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 20),
      receiveTimeout: const Duration(seconds: 60),
      sendTimeout: const Duration(seconds: 20),
    ));

    try {
      final response = await dio.post(
        '${cfg.baseUrl}/chat/completions',
        data: <String, dynamic>{
          'model': cfg.model,
          'messages': <Map<String, dynamic>>[
            <String, dynamic>{'role': 'system', 'content': _systemPrompt},
            <String, dynamic>{
              'role': 'user',
              'content': _userPrompt(context, text),
            },
          ],
          'temperature': 0,
          'max_tokens': 1024,
        },
        options: Options(
          headers: <String, dynamic>{
            'Authorization': 'Bearer ${cfg.effectiveApiKey}',
            'Content-Type': 'application/json',
          },
        ),
      );
      final data = response.data;
      if (data is! Map) {
        return const AiGeneratedScript(error: '模型返回了无法识别的内容');
      }
      final choices = data['choices'];
      if (choices is! List || choices.isEmpty) {
        return const AiGeneratedScript(error: '模型没有给出回复');
      }
      final first = choices.first;
      if (first is! Map) {
        return const AiGeneratedScript(error: '模型没有给出回复');
      }
      final message = first['message'];
      final content = message is Map ? (message['content'] ?? '') : '';
      if (content is! String || content.trim().isEmpty) {
        return const AiGeneratedScript(error: '模型没有给出可解析的内容');
      }
      return parse(content);
    } on DioException catch (error) {
      return AiGeneratedScript(error: '调用模型失败：${error.message ?? '网络异常'}');
    } catch (error) {
      return AiGeneratedScript(error: '调用模型失败：$error');
    }
  }

  /// 解析模型给的 JSON 文本并校验。
  ///
  /// 公开出来是为了能单独测：解析与校验是这段逻辑的全部价值，
  /// 不该只能通过「真的调一次模型」来验证。
  static AiGeneratedScript parse(String raw) {
    final cleaned = _stripFence(raw.trim());
    Object? decoded;
    try {
      decoded = jsonDecode(cleaned);
    } catch (_) {
      // 模型有时在 JSON 前后加话；截取花括号再试一次。
      final start = cleaned.indexOf('{');
      final end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          decoded = jsonDecode(cleaned.substring(start, end + 1));
        } catch (_) {
          decoded = null;
        }
      }
    }
    if (decoded is! Map) {
      return const AiGeneratedScript(error: '模型给的内容不是脚本 JSON');
    }

    final script = AutomationScript.fromJson(
      decoded.map((Object? key, Object? value) =>
          MapEntry<String, dynamic>(key.toString(), value)),
    );

    // 每一步都要过安全校验——模型说什么不算数。
    final rejected = <String>[];
    final steps = <AutomationStep>[];
    for (final step in script.steps) {
      final verdict = _checkStep(step);
      if (!verdict.allowed) {
        rejected.add('${step.op}：${verdict.reason ?? '不合规'}');
        continue;
      }
      steps.add(step);
    }

    if (steps.isEmpty) {
      return AiGeneratedScript(
        rawJson: raw,
        error: rejected.isEmpty
            ? '模型没有给出任何步骤'
            : '模型给的步骤都不合规：${rejected.join('；')}',
      );
    }

    return AiGeneratedScript(
      script: AutomationScript(
        id: script.id.isEmpty
            ? 'script-${DateTime.now().millisecondsSinceEpoch}'
            : script.id,
        name: script.name.isEmpty ? 'AI 生成脚本' : script.name,
        trigger: script.trigger,
        watchDir: script.watchDir,
        schedule: script.schedule,
        steps: steps,
        enabled: script.enabled,
      ),
      rawJson: raw,
    );
  }

  /// 单步校验：操作类型在白名单内、路径是绝对路径、不碰系统分区。
  static SafetyVerdict _checkStep(AutomationStep step) {
    const allowed = <String>{'copy', 'move', 'delete', 'rename', 'mkdir', 'write'};
    if (!allowed.contains(step.op)) {
      return SafetyVerdict.deny('操作类型「${step.op}」不在白名单内');
    }
    final source = (step.args['src'] ?? step.args['path'] ?? '').toString();
    final target = (step.args['dst'] ?? step.args['to'] ?? '').toString();

    if (step.op == 'rename') {
      // 重命名的目标是一个**新名字**，不是路径。
      if (target.isEmpty) return const SafetyVerdict.deny('缺少新名字');
      if (target.contains('/')) {
        return const SafetyVerdict.deny('新名字不能包含路径分隔符');
      }
      if (source.isEmpty) return const SafetyVerdict.deny('缺少源路径');
      return AiSafetyFilter.checkPath(source, forWrite: true);
    }

    if (source.isEmpty) return const SafetyVerdict.deny('缺少源路径');
    final sourceVerdict = AiSafetyFilter.checkPath(source, forWrite: true);
    if (!sourceVerdict.allowed) return sourceVerdict;
    if (target.isNotEmpty) {
      final targetVerdict = AiSafetyFilter.checkPath(target, forWrite: true);
      if (!targetVerdict.allowed) return targetVerdict;
    }
    return const SafetyVerdict.allow();
  }

  static String _stripFence(String raw) {
    if (!raw.startsWith('```')) return raw;
    final lines = raw.split('\n');
    if (lines.length < 2) return raw;
    return lines.sublist(1, lines.length - 1).join('\n').trim();
  }

  static const String _systemPrompt = '''
你是一个文件管理器的自动化脚本生成器。用户描述一个文件操作流程，你要把它写成脚本。

只输出 JSON，不要输出解释。格式：
{
  "name": "脚本名",
  "trigger": "manual",
  "watchDir": "",
  "schedule": "",
  "steps": [
    {"op": "copy", "args": {"src": "/绝对路径/源", "dst": "/绝对路径/目标"}}
  ]
}

规则：
- op 只能是 copy / move / delete / rename / mkdir / write
- copy / move / delete / write / mkdir 用 args.src（rename 用 args.src + args.to）
- rename 的 args.to 是**新名字**（不含路径分隔符），不是路径
- 所有路径必须是绝对路径，不能包含 ..
- trigger 只能是 manual / schedule / directoryEvent
- directoryEvent 时 watchDir 填要监视的目录；schedule 时 schedule 填 "every 15m" 或 "daily 08:00"
- 不要输出任何 shell 命令
- 步骤最多 10 条
''';

  static String _userPrompt(VfsContext context, String requirement) {
    return '''
当前文件管理器上下文：
${context.toPrompt()}
用户要的流程：
$requirement
''';
  }
}
