// khy-canary: Khy-20261101-064-FPGKCB8H
/// 工具调用的核对结论，以及"喂回模型时该怎么说"。
///
/// 为什么单独一个文件而不是在三个界面里各写一份：回喂点有五个
/// （chat_screen_new 两处、agent_screen_new 一处、longcat 两处），
/// 而这里要防的事正是"有的地方记了核对、有的地方没记"——
/// 那种不一致比不核对更难发现，因为界面看起来完全一样。
///
/// 它做的事只有一件：把 [CheckerAgent] 的判定变成
///   1. 一句给**模型**看的话，追加在工具结果后面
///   2. 一个给**人**看的标签
///
/// 第 1 项是重点。以前工具结果是裸的 `{"success":false,...}` 回去，
/// 模型读不读、读成什么，全看它自己。现在结论由代码写出来，
/// 模型没法把一次失败读成一次成功——这正是「不得凭空想象」
/// 在对话流里的落点。
library;

import '../tools/tool_engine.dart';
import '../tools/tool_protocol.dart';
import 'checker_agent.dart';

/// 一次工具调用的核对结论。
class ToolVerdict {
  /// 调的是哪个工具。只进日志和展示，不参与判定。
  final String tool;

  final CheckVerdict verdict;

  /// 判定依据，人类可读。
  final String detail;

  const ToolVerdict({
    required this.tool,
    required this.verdict,
    required this.detail,
  });

  /// 给界面的一行字。
  String get userLabel {
    switch (verdict) {
      case CheckVerdict.verified:
        return '已验证';
      case CheckVerdict.unverified:
        return '未验证';
      case CheckVerdict.contradicted:
        return '被推翻';
    }
  }

  /// 给界面的一行详述。
  String get userDetail => '$userLabel：$detail';

  /// 追加在工具结果后面、喂回模型的那句话。
  ///
  /// 三种结论措辞不同，且都不能省：
  ///   - verified：模型可以据此继续，但要知道这是核过的
  ///   - unverified：**不许**当成成功，也不许当成失败——是不知道
  ///   - contradicted：工具明确说没成，再说"已完成"就是 fabrication
  String get modelNote {
    switch (verdict) {
      case CheckVerdict.verified:
        return '【核对：工具回报 success=true，此结果可信】';
      case CheckVerdict.unverified:
        return '【核对：$detail。不要把它当作成功，也不要当作失败——'
            '它是没有结论。要么换一种方式确认，要么明确告诉用户这一步没验证。】';
      case CheckVerdict.contradicted:
        return '【核对：$detail。这一步没有成功，不要在后续任何叙述里'
            '把它说成已完成。】';
    }
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'tool': tool,
        'verdict': verdict.wire,
        'detail': detail,
      };

  @override
  String toString() => 'ToolVerdict($tool, ${verdict.wire}, $detail)';
}

/// 核对一次工具调用。
///
/// 纯函数，无 IO——[CheckerAgent] 只读 [ToolResult] 里的结构化字段。
/// 这也是它能在三个界面里共用的原因：不依赖任何界面状态。
class ToolVerdictFactory {
  const ToolVerdictFactory._();

  static const CheckerAgent _checker = CheckerAgent();

  /// 判定一次调用。
  ///
  /// [result] 必须是工具真实返回的那个对象。不接字符串、不接摘要——
  /// 接摘要就等于让调用方有机会在核对之前先把结论写好。
  static ToolVerdict of(String tool, ToolResult result) {
    final evidence = <String, dynamic>{
      'success': result.success,
      'output': result.output,
      if (result.metadata != null) ...result.metadata!,
    };
    // 失败时把 output 挪一份到 error 字段。
    //
    // ToolResult.fail(msg) 把原因放在 output 里——那是这个类的约定。
    // 不挪的话核对器只会说"工具明确报告失败（无 error 字段）"，
    // 把已经拿在手里的原因又丢了一遍，而那个原因正是人和模型
    // 唯一能用来决定下一步的东西。
    if (!result.success && evidence['error'] == null) {
      evidence['error'] = result.output;
    }
    final r = _checker.check(ClaimedStep(
      claim: '工具 $tool 执行成功',
      evidence: evidence,
      tool: tool,
    ));
    return ToolVerdict(tool: tool, verdict: r.verdict, detail: r.detail);
  }

  /// 拼出喂回模型的那条消息。
  ///
  /// 两种协议（原生 function calling / 文本协议）各有一种既有外壳，
  /// 这里一律沿用，只把核对结论追加在同一份内容后面——改外壳会让
  /// 三个界面里五处调用点各自漂移，而那正是这一个函数要避免的事。
  static Map<String, dynamic> toolMessage({
    required String tool,
    required ToolResult result,
    required bool useTextProtocol,
    String? callId,
  }) {
    final v = of(tool, result);
    final body = useTextProtocol
        ? ToolProtocol.formatToolResult(result)
        : result.jsonOutput;
    final content = '$body\n${v.modelNote}';
    if (useTextProtocol) {
      return <String, dynamic>{'role': 'user', 'content': content};
    }
    return <String, dynamic>{
      'tool_call_id': callId ?? '',
      'role': 'tool',
      'content': content,
    };
  }
}
