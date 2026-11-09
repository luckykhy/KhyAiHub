// 让模型把一句人话变成操作计划。
//
// 关键设计：**模型不被允许直接执行**。它只能吐一段 JSON，JSON 还要过
// [AiPlanDecoder] 的白名单与安全校验。模型说「删掉 /data」——那会被解码器丢掉，
// 并在「被拒绝的项」里留下记录，用户看得见。
//
// 提示词里把白名单直接写给模型看，是为了**降低**模型越界的概率，而不是依赖它
// 守规矩。守规矩是解码器的活；提示词只是让模型少写废话。

import 'dart:async';

import 'package:dio/dio.dart';

import '../config/app_config.dart';
import 'ai_plan.dart';
import 'local_intent_parser.dart';
import 'vfs_context.dart';

/// 计划生成器。
abstract final class AiPlanGenerator {
  /// 生成一份操作计划。
  ///
  /// 失败时返回的 plan 里 [AiOperationPlan.rejected] 会带原因，`operations` 为空——
  /// 调用方据此提示用户，而不是抛异常。
  ///
  /// [offline] 为 true 时**完全不联网**，只用本地规则解析。
  /// 云端调不通时也会自动落到本地规则，并在 summary 里说明——
  /// 「离线」必须是真的离线，不是「没网就没有 AI」。
  static Future<AiOperationPlan> generate({
    required String instruction,
    required VfsContext context,
    AppConfigData? config,
    bool offline = false,
  }) async {
    final trimmed = instruction.trim();
    if (trimmed.isEmpty) {
      return const AiOperationPlan(summary: '没有可执行的指令');
    }

    if (offline) {
      return LocalIntentParser.parse(trimmed).plan;
    }

    final cfg = config ?? await AppConfig.loadEffective();
    if (!cfg.isConfigured) {
      final local = LocalIntentParser.parse(trimmed);
      if (local.plan.operations.isNotEmpty) {
        return AiOperationPlan(
          operations: local.plan.operations,
          rejected: local.plan.rejected,
          summary: '未配置模型，已用离线规则解析',
        );
      }
      return const AiOperationPlan(
        summary: '未配置模型，无法生成操作计划',
        rejected: <AiRejectedItem>[
          AiRejectedItem('模型未配置', '请先在设置里配置模型，或用离线规则'),
        ],
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
            <String, dynamic>{'role': 'user', 'content': _userPrompt(context, trimmed)},
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
        return const AiOperationPlan(summary: '模型返回了无法识别的内容');
      }
      final choices = data['choices'];
      if (choices is! List || choices.isEmpty) {
        return const AiOperationPlan(summary: '模型没有给出回复');
      }
      final first = choices.first;
      if (first is! Map) {
        return const AiOperationPlan(summary: '模型没有给出回复');
      }
      final message = first['message'];
      final content = message is Map ? (message['content'] ?? '') : '';
      if (content is! String || content.trim().isEmpty) {
        return const AiOperationPlan(summary: '模型没有给出可解析的内容');
      }
      return AiPlanDecoder.decode(content);
    } on DioException catch (error) {
      final detail = error.message ?? '网络异常';
      final local = LocalIntentParser.parse(trimmed);
      if (local.plan.operations.isNotEmpty) {
        return AiOperationPlan(
          operations: local.plan.operations,
          rejected: local.plan.rejected,
          summary: '模型调不通（$detail），已用离线规则解析',
        );
      }
      return AiOperationPlan(
        summary: '调用模型失败：$detail',
        rejected: <AiRejectedItem>[AiRejectedItem(trimmed, detail)],
      );
    } catch (error) {
      final local = LocalIntentParser.parse(trimmed);
      if (local.plan.operations.isNotEmpty) {
        return AiOperationPlan(
          operations: local.plan.operations,
          rejected: local.plan.rejected,
          summary: '模型调用出错，已用离线规则解析',
        );
      }
      return AiOperationPlan(
        summary: '调用模型失败：$error',
        rejected: <AiRejectedItem>[AiRejectedItem(trimmed, '$error')],
      );
    }
  }

  /// 系统提示词：只教一件事——把指令变成白名单内的 JSON 计划。
  static const String _systemPrompt = '''
你是一个文件管理器的操作规划器。用户会给你一句中文指令，你要把它拆成文件操作计划。

只输出 JSON，不要输出解释文字。格式：
{"summary": "一句话概括", "operations": [{"op": "copy", "source": "/abs/path", "target": "/abs/path"}]}

允许的 op 只有这五个：copy、move、delete、rename、mkdir。
- copy：source 与 target 都要给
- move：source 与 target 都要给
- delete：给 source
- rename：source 给原路径，target 给新名字
- mkdir：source 给要创建的目录路径

约束：
- 路径必须是绝对路径，不能包含 ..
- 只处理用户当前所在目录及其子目录内的路径；需要访问别处时在 source 里写明完整绝对路径
- 不要输出任何命令（不要出现 rm、mv、cp 等 shell 命令），只输出结构化操作
- 数量多时最多输出 20 条操作
- 如果指令本身不涉及文件操作（例如闲聊），输出 {"summary": "...", "operations": []}
''';

  /// 用户提示词：上下文 + 指令。
  static String _userPrompt(VfsContext context, String instruction) {
    return '''
当前文件管理器上下文：
${context.toPrompt()}
用户指令：
$instruction
''';
  }
}
