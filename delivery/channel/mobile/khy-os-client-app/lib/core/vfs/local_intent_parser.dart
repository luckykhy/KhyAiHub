// 本地意图解析：没有模型时的离线兜底。
//
// 目标里写着「AI 云端调用：可选，本地模式完全离线」。所以 AI 面板在**没有配模型**
// 或**模型调不通**时，仍然要能做点事——否则「离线」只是没有云端就没有 AI，
// 那不叫离线，那叫没有这个功能。
//
// 这里用确定性的规则把几句常见中文/英文指令变成操作计划。它不是「小模型」，
// 它就是几条正则：能认就能做，认不了就说认不了——**不猜**。
//
// 两条硬规则：
//   1. **只认绝对路径**。相对路径会按「执行时的当前目录」解释，那说不清落点，
//      所以认不出来就返回「没认出来」，而不是猜一个。
//   2. **产出的计划复用 [AiPlanDecoder]**。本地解析只负责「从一句话里认出操作
//      类型和路径」，白名单校验、风险分级、越界拒绝全部走同一条路——
//      本地解析出来的计划不能绕过护栏。
//
// 风险分级对私有目录有个刻意的选择：删除私有目录里的文件**不算越界**，而是
// 「高危 + 要人确认」。理由是过滤器管「这件事该不该被提出来」，执行层
// （`VfsPolicy.advancedDataEdit`）管「它能不能执行」——两层各管一件事。

import 'dart:convert';

import 'ai_plan.dart';

/// 本地解析结果。
class LocalIntentResult {
  /// 认出来的计划（可能为空——没认出来就是没认出来）。
  final AiOperationPlan plan;

  /// 认出来的原始意图（给人看）。
  final String intent;

  const LocalIntentResult({required this.plan, required this.intent});
}

/// 离线意图解析器。
abstract final class LocalIntentParser {
  /// 解析一句指令。
  ///
  /// 返回的 plan 里 `operations` 为空表示没认出来；`rejected` 里会说明原因。
  static LocalIntentResult parse(String instruction) {
    final text = instruction.trim();
    if (text.isEmpty) {
      return LocalIntentResult(
        intent: text,
        plan: const AiOperationPlan(summary: '没有可解析的指令'),
      );
    }

    final operation = _detect(text);
    if (operation == null) {
      return LocalIntentResult(
        intent: text,
        plan: const AiOperationPlan(
          summary: '离线模式只认得几种固定说法（移动/复制/删除/重命名/新建目录/搜索）',
        ),
      );
    }

    // 交给统一解码器做白名单与风险判定——本地路径不能绕过护栏。
    final plan = AiPlanDecoder.decode(
      jsonEncode(<String, dynamic>{
        'summary': '离线解析',
        'operations': <dynamic>[operation],
      }),
    );

    return LocalIntentResult(intent: text, plan: plan);
  }

  /// 认出操作类型与参数。认不出来就返回 null。
  static Map<String, dynamic>? _detect(String text) {
    final normalized = text.replaceAll('：', ':').trim();

    // 源与目标分别抽。目标要「第二个绝对路径」——只有一个绝对路径时，
    // 目标走关键词兜底（「重命名为 b.txt」里的 b.txt 是名字，不是路径）。
    final source = _extractPath(normalized);
    final target = _extractPath(normalized, skipFirst: true);

    // 移动：「把 A 移到 B」/「将 A 移动到 B」/「move A to B」
    if (_matches(normalized, r'(移到|移动到|移动至|move\s)')) {
      if (source == null || target == null) return null;
      return <String, dynamic>{
        'op': 'move',
        'source': source,
        'target': target,
      };
    }

    // 复制：「把 A 复制到 B」/「复制 A 到 B」/「copy A to B」。
    // 「复制…到」中间可能隔着路径，所以用 `复制.*到` 而不是固定短语。
    if (_matches(normalized, r'(复制到|拷贝到|复制.*到|拷贝.*到|copy\s)')) {
      if (source == null || target == null) return null;
      return <String, dynamic>{
        'op': 'copy',
        'source': source,
        'target': target,
      };
    }

    // 删除：「删除 A」/「删掉 A」/「remove A」
    if (_matches(normalized, r'(删除|删掉|移除|delete\s|remove\s)')) {
      if (source == null) return null;
      return <String, dynamic>{'op': 'delete', 'source': source};
    }

    // 重命名：「把 A 重命名为 B」/「rename A to B」。
    // 目标是一个**新名字**，不是路径——落点由源路径决定。
    if (_matches(normalized, r'(重命名为|改名为|重命名|rename\s)')) {
      if (source == null) return null;
      final name = _extractName(normalized);
      if (name == null) return null;
      return <String, dynamic>{
        'op': 'rename',
        'source': source,
        'target': name,
      };
    }

    // 新建目录：「新建目录 A」/「创建文件夹 A」
    if (_matches(normalized, r'(新建目录|创建目录|新建文件夹|创建文件夹)')) {
      if (source == null) return null;
      return <String, dynamic>{'op': 'mkdir', 'source': source};
    }

    // 搜索：「查找 A」/「搜索 A」
    if (_matches(normalized, r'(查找|搜索|find\s)')) {
      if (source == null) return null;
      return <String, dynamic>{
        'op': 'search',
        'source': '/',
        'pattern': source,
      };
    }

    return null;
  }

  static bool _matches(String text, String pattern) =>
      RegExp(pattern).hasMatch(text);

  /// 抽「新名字」——重命名专用的那个片段。
  static String? _extractName(String text) {
    final match = RegExp(
      r'(重命名为|改名为|叫做|改成|名为)\s*([^\s，,。;；]+)',
    ).firstMatch(text);
    if (match != null) return match.group(2);
    // 「rename A to B」这类英文说法
    final english = RegExp(r'rename\s+\S+\s+to\s+(\S+)').firstMatch(text);
    if (english != null) return english.group(1);
    return null;
  }

  /// 从一句话里抽一个**绝对路径**。
  ///
  /// 抽不到绝对路径就返回 null——本地解析宁可「认不出来」，也不猜一个相对路径
  /// 去执行。引号里的优先（用户自己加了引号，说明那就是完整路径）。
  static String? _extractPath(String text, {bool skipFirst = false}) {
    final quoted = RegExp(
      '[\u300C\u300E\u201C\u2018\']([^\u300D\u300F\u201D\u2019\']+)[\u300D\u300F\u201D\u2019\']',
    ).firstMatch(text);
    if (quoted != null) {
      final inner = quoted.group(1)!.trim();
      // 引号里也可能是相对路径——那就不是路径。
      return inner.startsWith('/') ? inner : null;
    }

    final absolute = RegExp(r'(/[^\s，,。;；]+)').allMatches(text).toList();
    if (absolute.length > 1) {
      return absolute[skipFirst ? 1 : 0].group(1);
    }
    if (absolute.length == 1 && !skipFirst) {
      return absolute.first.group(1);
    }
    return null;
  }
}
