// khy-canary: Khy-20261101-061-CVQY184E
/// 读取子智能体。
///
/// 职责只有一件：**把手机上的真实状态读出来，并且只报读到的**。
/// 它不改任何东西，也不替任何结论背书——一个工具没返回，它就说没返回，
/// 不会补一句"应该是成功了"。
///
/// 为什么要有这个而不是让模型自己调工具：
/// 1. **预算**。一次读最多 [maxSteps] 个工具调用、[maxEvidenceBytes] 字节证据。
///    超了就停，并在报告里说清停了——静默截断会让下游以为看的是全量。
/// 2. **可核**。每条观察都带着原始 JSON，检查子智能体因此有事可做；
///    没有证据的观察在类型上就造不出来（见 `subagent_report.dart`）。
/// 3. **有序**。读有顺序依赖（先 ls 再 read），顺序在请求里显式声明，
///    不靠模型每次重新推断。
library;

import 'dart:convert';

import 'subagent_report.dart';
import '../tools/tool_engine.dart';

/// 一次工具调用。注入而不是直接用 [ToolEngine]，是为了测试能喂假回报——
/// 一个只能连真机才能测的读取器，等于没有测试。
typedef ToolInvoker = Future<ToolResult> Function(
  String tool,
  Map<String, dynamic> args,
);

/// 读一步：调哪个工具、传什么、想用它的结果证明什么。
class ReaderStep {
  final String tool;
  final Map<String, dynamic> args;

  /// 这一步要证成什么。会变成观察的 claim，所以必须是可验证的陈述句，
  /// 不是"看一下"这种没法验证的话。
  final String claim;

  const ReaderStep({
    required this.tool,
    required this.claim,
    this.args = const <String, dynamic>{},
  });

  Map<String, dynamic> toJson() => <String, dynamic>{
        'tool': tool,
        'args': args,
        'claim': claim,
      };
}

/// 一次读取任务。
class ReaderRequest {
  /// 这次读取是为了什么。进日志和报告，便于复盘。
  final String goal;

  final List<ReaderStep> steps;

  const ReaderRequest({required this.goal, this.steps = const <ReaderStep>[]});
}

class ReaderAgent {
  final ToolInvoker _invoke;

  const ReaderAgent(this._invoke);

  /// 直接拿 [ToolEngine] 构造。生产路径用这个。
  factory ReaderAgent.engine(ToolEngine engine) =>
      ReaderAgent(engine.execute);

  /// 一步都不许多跑。超出即停并报告——不是"尽量跑完"。
  ///
  /// 8 的依据：本机一次 ls 就能列出工作空间，一次 read 读一个文件，
  /// 真正的读取任务很少超过 5 步。给到 8 是留余量，不是纵容。
  static const int maxSteps = 8;

  /// 证据总字节上限。超出即停止后续步骤。
  ///
  /// 与 Java 侧 `Tools` 的每轮字节预算同一意图：限住"总共能往上下文里塞多少"。
  /// 那边拦的是 shell，这边拦的是 Flutter 侧的工具回报，两头都要有——
  /// 只有一头的话，另一头就是免费通道。
  static const int maxEvidenceBytes = 64 * 1024;

  Future<SubAgentReport> read(ReaderRequest req) async {
    final observations = <Observation>[];
    final raw = <Map<String, dynamic>>[];
    var spent = 0;

    for (var i = 0; i < req.steps.length; i++) {
      if (i >= maxSteps) {
        // 说清还剩几步没跑。静默截断读起来像"跑完了"。
        observations.add(Observation.unverified(
          '读取在第 $i 步被预算截断，还剩 ${req.steps.length - i} 步未执行',
          why: '超出单次读取步数上限（$maxSteps）',
        ));
        break;
      }

      final step = req.steps[i];
      Map<String, dynamic>? result;
      try {
        final r = await _invoke(step.tool, Map<String, dynamic>.from(step.args));
        // 拼一份结构化的证据，而不是把 output 当证据。
        //
        // 三条规则：
        //   1. metadata 优先——工具自己给的字段比我们补的更准。
        //   2. `success` 以 ToolResult.success 为真源，metadata 里那个只作补充。
        //   3. **失败时把 output 挪到 error 字段**。ToolResult.fail(msg) 的
        //      output 装的就是失败原因，不挪的话下游只会看到
        //      "工具明确报告失败（无 error 字段）"——把已经拿到的原因又丢了一遍。
        //      这是被 reader_agent_test 抓出来的。
        final m = <String, dynamic>{'output': r.output};
        if (r.metadata != null) m.addAll(r.metadata!);
        m['success'] = r.success;
        if (m['success'] != true && m['error'] == null) {
          m['error'] = r.output;
        }
        result = m;
      } catch (e) {
        // 工具抛异常不算"读到了负面结果"。它是什么都没读到，
        // 所以这里必须是未验证，不能拿异常文本冒充证据。
        observations.add(Observation.unverified(
          step.claim,
          why: '工具 $step.tool 抛出异常：$e',
        ));
        continue;
      }

      final obs = Observation.fromToolResult(step.claim, result);
      observations.add(obs);
      raw.add(<String, dynamic>{'step': i, 'result': result});

      spent += _jsonLen(result);
      if (spent > maxEvidenceBytes) {
        observations.add(Observation.unverified(
          '读取在第 $i 步后触达证据字节上限，还剩 ${req.steps.length - i - 1} 步未执行',
          why: '证据已达 $spent 字节，上限 $maxEvidenceBytes',
        ));
        break;
      }
    }

    return SubAgentReport(
      role: SubAgentRole.reader,
      // 读取器自身没抛就算 ok；读得好不好看 observations。
      ok: true,
      observations: observations,
      data: <String, dynamic>{
        'goal': req.goal,
        'requested': req.steps.length,
        'executed': raw.length,
        'evidence_bytes': spent,
        'results': raw,
      },
    );
  }

  static int _jsonLen(Object? v) {
    if (v == null) return 0;
    try {
      return jsonEncode(v).length;
    } catch (_) {
      // 编码不了的东西（循环引用、NaN 等）按 0 计：宁可低估也不抛，
      // 读取器抛异常会让整个任务断在这里，而它只是个预算估算。
      return 0;
    }
  }
}
