// khy-canary: Khy-20261101-058-DNE3XK6M
/// 检查子智能体——「不要全信 amoo」这句话的执行面。
///
/// 它只做判定，不改状态、不发请求。给它一句声明和一份证据，它回答三件事之一：
/// 撑得住、撑不住、没法判。
///
/// 为什么单独一个类而不是在 UI 里 if-else：
/// 判定规则是会被反复修改的东西（今天按 `success` 判，明天要按别的字段判），
/// 而它是**唯一**挡住"amoo 说完成了"直接变成"任务完成了"的那道闸。
/// 把闸的规则散在界面代码里，下次改界面时就会有人顺手改坏它。
library;

import 'subagent_report.dart';

/// 一次判定的结果。
enum CheckVerdict {
  /// 证据支撑这句声明。
  verified,

  /// 没有证据，或证据不支持。**这不是"失败"，是"不知道"**——
  /// 把未验证说成失败会让人去修一个没坏的东西。
  unverified,

  /// 证据明确反对这句声明。比未验证更严重：不只是没证明，是被推翻。
  contradicted;

  String get wire => name;
}

/// 一条待核对的声明 + 它声称对应的那次调用。
class ClaimedStep {
  /// 声明内容，人类可读。
  final String claim;

  /// 那次工具调用的原始回报。null = 没调到，或调用方根本没给。
  final Map<String, dynamic>? evidence;

  /// 调的是哪个工具。只进日志，判定不依赖它——按工具名判定
  /// （"这个工具一向靠谱"）正是要防的那种凭空相信。
  final String? tool;

  const ClaimedStep({required this.claim, this.evidence, this.tool});

  Map<String, dynamic> toJson() => <String, dynamic>{
        'claim': claim,
        if (tool != null) 'tool': tool,
        if (evidence != null) 'evidence': evidence,
      };
}

/// 一次核对的汇总。
class CheckSummary {
  final int total;
  final int verified;
  final int unverified;
  final int contradicted;

  const CheckSummary({
    required this.total,
    required this.verified,
    required this.unverified,
    required this.contradicted,
  });

  /// 没有任何一条被证据推翻时才是 true。
  ///
  /// 注意判据是 contradicted 而不是 unverified：未验证是常态（工具会失败、
  /// 会超时），被推翻才是异常。把判据设成"全部已验证"会让几乎每个任务
  /// 都亮红灯，然后所有人学会忽略红灯。
  bool get nothingContradicted => contradicted == 0;

  /// 需要人看一眼的程度。供界面决定要不要弹确认。
  ///
  /// 0 = 没事，1 = 有没验证的，2 = 有被推翻的。
  int get severity {
    if (contradicted > 0) return 2;
    if (unverified > 0) return 1;
    return 0;
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'total': total,
        'verified': verified,
        'unverified': unverified,
        'contradicted': contradicted,
        'severity': severity,
      };

  @override
  String toString() =>
      'CheckSummary(verified=$verified unverified=$unverified '
      'contradicted=$contradicted / $total)';
}

class CheckerAgent {
  const CheckerAgent();

  /// 判定单条。
  ///
  /// 规则刻意只有三条，且都只读证据本身：
  ///   1. 没证据 → unverified。不猜"大概是成功了"。
  ///   2. `success != true` → unverified；`success == false` → contradicted。
  ///      区分这两级：`false` 是工具明确说没成，那声明就是错的；
  ///      而字段缺失只是读不出结论。
  ///   3. 证据里有 `success == true` 之外的反证字段 → 见 [_contradictionHint]。
  CheckResult check(ClaimedStep step) {
    final ev = step.evidence;
    if (ev == null) {
      return CheckResult(
        claim: step.claim,
        verdict: CheckVerdict.unverified,
        detail: '没有任何证据：这次调用没有回报，或调用方没有提供',
      );
    }
    final success = ev['success'];
    if (success == true) {
      // 即使 success=true 也再看两眼。
      //
      // 第一眼：工具自己声明"我没能证明这件事"（`verified: false`）。
      //
      // 为什么需要这个字段：`install_apk` 在 pm install 退出码为 0 且无输出时
      // 返回的是一个成功形态——"命令跑通了"。但跑通不等于装上。工具比任何人都
      // 清楚自己有没有做事后查询，所以让它自己说，比让核对器去猜输出文本可靠。
      // 这是被 refutation Case 3 点名的形状，也是这里三态中 unverified 的
      // 主要来源。
      if (ev['verified'] == false) {
        final why = ev['verify_why'];
        return CheckResult(
          claim: step.claim,
          verdict: CheckVerdict.unverified,
          detail: why is String && why.trim().isNotEmpty
              ? why
              : '工具自己报告未能验证其结果',
        );
      }
      // 第二眼：同一份回报里有和 success=true 打架的字段。
      // 一个回报同时说 success=true 和 error="权限被拒" 是可能的
      // （上层捕获了异常但没改 success），那时 success 不能单独采信。
      final hint = _contradictionHint(ev);
      if (hint != null) {
        return CheckResult(
          claim: step.claim,
          verdict: CheckVerdict.contradicted,
          detail: hint,
        );
      }
      return CheckResult(
        claim: step.claim,
        verdict: CheckVerdict.verified,
        detail: '工具回报 success=true',
      );
    }
    if (success == false) {
      final err = ev['error'];
      return CheckResult(
        claim: step.claim,
        verdict: CheckVerdict.contradicted,
        detail: err is String && err.trim().isNotEmpty
            ? '工具明确报告失败：$err'
            : '工具明确报告失败（success=false，无 error 字段）',
      );
    }
    return CheckResult(
      claim: step.claim,
      verdict: CheckVerdict.unverified,
      detail: '证据里没有 success 字段，无法判定（键：${ev.keys.join(', ')}）',
    );
  }

  /// 证据里和 success=true 打架的字段。
  ///
  /// 只看两个：非空 `error`、非零 `exitCode`。只查这两个是因为它们在本项目
  /// 的回报里语义固定（见 `MainActivity.installApk` / `Tools.exec`），
  /// 不是通用启发式——通用的那种会把一堆正常回报误判成矛盾。
  String? _contradictionHint(Map<String, dynamic> ev) {
    final err = ev['error'];
    if (err is String && err.trim().isNotEmpty) {
      return 'success=true 但同一份回报里有 error：$err';
    }
    final code = ev['exitCode'];
    if (code is int && code != 0) {
      return 'success=true 但 exitCode=$code（非零通常表示失败）';
    }
    return null;
  }

  /// 核对一批，返回汇总 + 逐条结果。
  CheckReport checkAll(List<ClaimedStep> steps) {
    final results = steps.map(check).toList(growable: false);
    final summary = CheckSummary(
      total: results.length,
      verified: results.where((r) => r.verdict == CheckVerdict.verified).length,
      unverified:
          results.where((r) => r.verdict == CheckVerdict.unverified).length,
      contradicted:
          results.where((r) => r.verdict == CheckVerdict.contradicted).length,
    );
    return CheckReport(results: results, summary: summary);
  }

  /// 核对一个 [SubAgentReport]——把读取器/写入器的产出直接喂进来。
  ///
  /// 这一步是把两个子智能体接起来的地方：读取器只负责带出证据，
  /// 判定交给检查器，于是"谁读的"和"谁判的"分开，不会自己读自己信。
  CheckReport checkReport(SubAgentReport report) {
    return checkAll(report.observations
        .map((o) => ClaimedStep(
              claim: o.claim,
              evidence: o.evidence,
              tool: report.role.wire,
            ))
        .toList(growable: false));
  }
}

/// 单条判定结果。
class CheckResult {
  final String claim;
  final CheckVerdict verdict;
  final String detail;

  const CheckResult({
    required this.claim,
    required this.verdict,
    required this.detail,
  });

  Map<String, dynamic> toJson() => <String, dynamic>{
        'claim': claim,
        'verdict': verdict.wire,
        'detail': detail,
      };

  @override
  String toString() => '${verdict.wire}: $claim（$detail）';
}

/// 一批判定的结果。
class CheckReport {
  final List<CheckResult> results;
  final CheckSummary summary;

  const CheckReport({required this.results, required this.summary});

  /// 给人看的一句话。宁可说得难听也不要说得好听——
  /// 「全部核过」和「一条都没核」在用户眼里必须不同。
  String get humanSummary {
    if (summary.total == 0) return '没有可核对的步骤';
    if (summary.contradicted > 0) {
      return '${summary.contradicted}/${summary.total} 条被证据推翻，'
          '${summary.unverified} 条无法验证';
    }
    if (summary.unverified > 0) {
      return '${summary.verified}/${summary.total} 条有证据支撑，'
          '${summary.unverified} 条无法验证';
    }
    return '${summary.total}/${summary.total} 条均有证据支撑';
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'summary': summary.toJson(),
        'results': results.map((r) => r.toJson()).toList(),
      };
}
