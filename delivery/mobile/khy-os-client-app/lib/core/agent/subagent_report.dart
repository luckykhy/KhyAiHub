// khy-canary: Khy-20261101-063-SFNCSPAA
/// 子智能体的回报格式——以及"不许凭空想象"这条约束的**执行面**。
///
/// 用户的要求原话：「khyos 中与 amoo 的互动包括 amoo 的互动必须依赖真实 Json 等
/// 结构化数据不得凭空想象」。这句话要落地，不能只靠提示词里写一句"请基于事实"，
/// 因为提示词拦不住幻觉——它只能提高概率，不能构成保证。
///
/// 构成保证的办法是让**类型本身**不允许无证据的断言：
/// [Observation.verified] 必须同时给出证据 JSON，拿不到证据就只能构造
/// [Observation.unverified]，而后者的 `verified` 恒为 false。于是一个
/// "已验证"的观察在编译期就必然带着证据，运行时也造不出不带证据的已验证观察。
///
/// 这不是风格选择。amoo 已经发生过它说"桥在手机侧是通的"而我这边还没接上的事——
/// 声明和事实是两件事，这个类型就是把两者的差别做成不可绕过的。
library;

import 'dart:convert';

import 'package:meta/meta.dart';

/// 四个子智能体的分工。取值同时上到线格式里，便于排查"这句话是谁说的"。
enum SubAgentRole {
  /// 读：只观察，不改变任何状态。
  reader,

  /// 写：只改工作空间内的东西，改完留证据。
  writer,

  /// 查：核对声明与证据，产出 verified/unverified 判定。
  checker,

  /// 划：把目标变成有序的、工具名都真实存在的步骤。
  planner;

  String get wire => name;
}

/// 一条观察：一句断言 + 支撑它的证据。
///
/// 不可变。构造只走三个工厂，因为 [verified] 和 [evidence] 的绑定关系
/// （有 verified 必有 evidence）是这个类型存在的全部理由——公开构造函数
/// 会让人写出 `Observation(claim: 'x', verified: true, evidence: null)`。
///
/// 三态而不是两态：verified / contradicted / unverified。
/// 中间那一态是后来加的，起因是一个真实缺陷——最初只有"有证据"和
/// "没证据"两种，于是 `success=false` 的回报被归进"没证据"，
/// 证据被整个丢掉。下游的检查子智能体拿到 `evidence: null`，
/// 只能判"无法验证"，明明手里就攥着一条"工具明确说失败"的证据却说不出话。
/// **失败也是证据**，丢掉它比没有它更糟：前者让人以为没查过。
@immutable
class Observation {
  /// 被断言的内容，人类可读。
  final String claim;

  /// 支撑断言的**真实工具回报**。null = 没有证据。
  ///
  /// 必须是结构化数据，不是把工具输出抄成的一句话。判定逻辑要能读它，
  /// 读不了就说明它没有被正确地传递。
  final Map<String, dynamic>? evidence;

  /// 证据是否支撑这条断言。
  ///
  /// 只有 [Observation.verified] 构造出来的才是 true，且那时 [evidence]
  /// 必然非 null。
  final bool verified;

  /// 证据是否**反对**这条断言。与 [verified] 互斥。
  ///
  /// 单独的标志位而不是塞进 why：界面要能把"被推翻"和"没法验证"
  /// 显示成不同的东西，而字符串解析做不到这一点。
  final bool contradicted;

  /// 未验证或被推翻的原因。verified 时为 null。
  ///
  /// 不写原因的项等于把问题藏起来——界面上它和已验证项长得一样，
  /// 直到有人去翻日志。原因必须在这。
  final String? why;

  const Observation._({
    required this.claim,
    required this.evidence,
    required this.verified,
    this.contradicted = false,
    this.why,
  });

  /// 一条被证据支撑的断言。
  ///
  /// 证据为空 Map 也算"有证据"：工具有时候就返回 `{}`，那是一个真实的空结果，
  /// 和"根本没调用"是两件事。后者由 [unverified] 表达。
  factory Observation.verified(String claim, Map<String, dynamic> evidence) {
    return Observation._(
      claim: claim,
      evidence: Map<String, dynamic>.from(evidence),
      verified: true,
    );
  }

  /// 一条被证据**反对**的断言。比未验证更重：不只是没证明，是被推翻。
  factory Observation.contradicted(
    String claim,
    Map<String, dynamic> evidence, {
    required String why,
  }) {
    return Observation._(
      claim: claim,
      evidence: Map<String, dynamic>.from(evidence),
      verified: false,
      contradicted: true,
      why: why,
    );
  }

  /// 一条没有证据支撑的断言。
  ///
  /// [why] 必填：调用方必须说清为什么没有证据（工具失败、超时、没配、
  /// 超出预算……）。允许省略的话，这里会变成所有偷懒的默认出口。
  factory Observation.unverified(String claim, {required String why}) {
    assert(why.trim().isNotEmpty, '未验证必须带原因');
    return Observation._(
      claim: claim,
      evidence: null,
      verified: false,
      why: why,
    );
  }

  /// 从工具回报直接构造。
  ///
  /// 判据只有一个：回报里 `success == true`。这不是因为工具一定对，
  /// 而是因为 `success` 是本项目所有工具回报的约定字段，读它就是读结构化数据。
  ///
  /// 三个分支都不猜：
  ///   - `success == true`  → verified
  ///   - `success == false` → contradicted，**证据留着**，因为那是工具
  ///     明确说没成，是最有价值的一类信息
  ///   - 字段缺失 / 回报为 null → unverified，证据留着（能读但读不出结论）
  factory Observation.fromToolResult(
    String claim,
    Map<String, dynamic>? result, {
    String? missingWhy,
  }) {
    if (result == null) {
      return Observation.unverified(
        claim,
        why: missingWhy ?? '工具没有返回任何数据',
      );
    }
    if (result['success'] == true) {
      return Observation.verified(claim, result);
    }
    if (result['success'] == false) {
      final err = result['error'];
      return Observation.contradicted(
        claim,
        result,
        why: err is String && err.trim().isNotEmpty
            ? '工具明确报告失败：$err'
            : '工具明确报告失败（success=false，无 error 字段）',
      );
    }
    return Observation._(
      claim: claim,
      evidence: Map<String, dynamic>.from(result),
      verified: false,
      why: '证据里没有 success 字段，无法判定（键：${result.keys.join(', ')}）',
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'claim': claim,
        'verified': verified,
        'contradicted': contradicted,
        if (evidence != null) 'evidence': evidence,
        if (why != null) 'why': why,
      };

  /// 给界面一行看完的形态。
  @override
  String toString() => verified
      ? '✓ $claim'
      : contradicted
          ? '✗ $claim（$why）'
          : '? $claim（$why）';
}

/// 一个子智能体跑完的完整回报。
///
/// [ok] **不**等于"事情办成了"。它只表示这个子智能体自己没出错。
/// 事情办没办成要看 [observations] 里有多少是未验证的——
/// 把两者合并是本项目反复在防的 fabrication：一次顺利跑完但什么都没验证的
/// 循环，和一次真正验证过的循环，在 UI 上必须能分辨。
@immutable
class SubAgentReport {
  final SubAgentRole role;

  /// 子智能体自身是否正常跑完（没抛、没断）。
  final bool ok;

  final List<Observation> observations;

  /// 角色相关的载荷。读=原始数据，写=落盘信息，查=判定统计，划=计划。
  final Map<String, dynamic> data;

  /// 子智能体级别的错误。ok 为 true 时为 null。
  final String? error;

  const SubAgentReport({
    required this.role,
    required this.ok,
    this.observations = const <Observation>[],
    this.data = const <String, dynamic>{},
    this.error,
  });

  factory SubAgentReport.failed(SubAgentRole role, String error) =>
      SubAgentReport(role: role, ok: false, error: error);

  /// 未验证的观察数。含被推翻的那些——两者都"未通过验证"。
  int get unverifiedCount =>
      observations.where((o) => !o.verified).length;

  /// 被证据推翻的观察数。比 [unverifiedCount] 更严重的一类。
  int get contradictedCount =>
      observations.where((o) => o.contradicted).length;

  /// 是否每一条都有证据支撑。
  bool get fullyVerified =>
      observations.isNotEmpty && observations.every((o) => o.verified);

  /// 证据总量（字符数）。用来在塞进上下文前决定要不要截断。
  int get evidenceBytes => observations
      .where((o) => o.evidence != null)
      .fold(0, (sum, o) => sum + jsonEncode(o.evidence).length);

  Map<String, dynamic> toJson() => <String, dynamic>{
        'role': role.wire,
        'ok': ok,
        'observations': observations.map((o) => o.toJson()).toList(),
        'unverified': unverifiedCount,
        'contradicted': contradictedCount,
        'data': data,
        if (error != null) 'error': error,
      };

  @override
  String toString() =>
      'SubAgentReport(${role.wire}, ok=$ok, '
      'verified=${observations.length - unverifiedCount}/${observations.length}'
      '${error == null ? '' : ', error=$error'})';
}
