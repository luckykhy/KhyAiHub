import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/checker_agent.dart';
import 'package:khy_os_client/core/agent/subagent_report.dart';

/// 检查子智能体的测试。
///
/// 这里每一条都对应一个真实发生过的事故形态。最要紧的是
/// `doneWithUnverifiedCommandsIsNotSuccess` 那条：amoo 发 `khy-done`
/// 声称完成，但命令没验证过——旧逻辑会把两者合并成"任务完成"，
/// 用户于是看到一个绿灯和一个实际上没做成的事。
void main() {
  const checker = CheckerAgent();

  CheckResult one(Map<String, dynamic>? evidence, {String claim = '做了'}) =>
      checker.check(ClaimedStep(claim: claim, evidence: evidence));

  group('单条判定', () {
    test('success=true 且无反证 → verified', () {
      final r = one({'success': true, 'path': '/a/b.txt', 'bytes': 12});
      expect(r.verdict, CheckVerdict.verified);
    });

    test('没有证据 → unverified，不是失败', () {
      // 未验证的含义是"不知道"，不是"错了"。把两者混同会让人
      // 去修一个没坏的东西。
      final r = one(null);
      expect(r.verdict, CheckVerdict.unverified);
      expect(r.detail, contains('没有任何证据'));
    });

    test('success=false → contradicted（比未验证更重）', () {
      final r = one({'success': false, 'error': '权限被拒'});
      expect(r.verdict, CheckVerdict.contradicted);
      expect(r.detail, contains('权限被拒'));
    });

    test('success=false 但无 error → 仍 contradicted，细节说清缺字段', () {
      final r = one({'success': false});
      expect(r.verdict, CheckVerdict.contradicted);
      expect(r.detail, contains('success=false'));
    });

    test('没有 success 字段 → unverified，并把键名列出来', () {
      // 列键名是为了让排查的人一眼看出回报形状不对，而不是判定逻辑错了。
      final r = one({'weird': 1, 'also': 2});
      expect(r.verdict, CheckVerdict.unverified);
      expect(r.detail, contains('weird'));
    });
  });

  group('success=true 也可能被推翻', () {
    test('同一份回报里有非空 error → contradicted', () {
      // 真实形态：上层捕获了异常、填了 error，但忘了把 success 改回 false。
      // 只信 success 就会把一个失败报成成功。
      final r = one({'success': true, 'error': 'INSTALL_FAILED_USER_RESTRICTED'});
      expect(r.verdict, CheckVerdict.contradicted);
      expect(r.detail, contains('error'));
    });

    test('空字符串 error 不算反证', () {
      // 有些工具无条件带一个空 error 字段。把它当反证会让几乎所有
      // 正常回报都亮红灯。
      final r = one({'success': true, 'error': ''});
      expect(r.verdict, CheckVerdict.verified);
    });

    test('非零 exitCode 算反证', () {
      final r = one({'success': true, 'exitCode': 1});
      expect(r.verdict, CheckVerdict.contradicted);
      expect(r.detail, contains('exitCode'));
    });

    test('exitCode=0 不算反证', () {
      final r = one({'success': true, 'exitCode': 0});
      expect(r.verdict, CheckVerdict.verified);
    });

    test('非 int 的 exitCode 不当反证', () {
      // 形状不定的字段宁可忽略，不能抛——检查器抛异常会让整条链断在这里。
      final r = one({'success': true, 'exitCode': '1'});
      expect(r.verdict, CheckVerdict.verified);
    });
  });

  group('批量核对', () {
    test('统计三类计数', () {
      final rep = checker.checkAll([
        const ClaimedStep(
            claim: 'a', evidence: {'success': true}),
        const ClaimedStep(
            claim: 'b', evidence: {'success': false, 'error': 'x'}),
        const ClaimedStep(claim: 'c', evidence: null),
        const ClaimedStep(claim: 'd', evidence: {'nope': 1}),
      ]);
      expect(rep.summary.total, 4);
      expect(rep.summary.verified, 1);
      expect(rep.summary.contradicted, 1);
      expect(rep.summary.unverified, 2);
      expect(rep.summary.severity, 2);
    });

    test('全 verified → severity 0', () {
      final rep = checker.checkAll([
        const ClaimedStep(claim: 'a', evidence: {'success': true}),
        const ClaimedStep(claim: 'b', evidence: {'success': true}),
      ]);
      expect(rep.summary.severity, 0);
      expect(rep.humanSummary, contains('均有证据支撑'));
    });

    test('只有未验证 → severity 1，措辞说清多少条没法验证', () {
      final rep = checker.checkAll([
        const ClaimedStep(claim: 'a', evidence: {'success': true}),
        const ClaimedStep(claim: 'b', evidence: null),
      ]);
      expect(rep.summary.severity, 1);
      expect(rep.humanSummary, contains('无法验证'));
    });

    test('有被推翻的 → severity 2，且 humanSummary 先报这个', () {
      final rep = checker.checkAll([
        const ClaimedStep(claim: 'a', evidence: {'success': true}),
        const ClaimedStep(
            claim: 'b', evidence: {'success': false, 'error': 'x'}),
      ]);
      expect(rep.summary.severity, 2);
      expect(rep.humanSummary, contains('被证据推翻'));
    });

    test('空列表 → total 0，不是 severity 0', () {
      // 空列表和"全绿"必须不同。前者是没核，后者是核过了。
      final rep = checker.checkAll(const []);
      expect(rep.summary.total, 0);
      expect(rep.summary.severity, 0);
      expect(rep.humanSummary, '没有可核对的步骤');
    });
  });

  group('与 SubAgentReport 对接', () {
    test('checkReport 把观察转成待核对项', () {
      final report = SubAgentReport(
        role: SubAgentRole.reader,
        ok: true,
        observations: [
          Observation.verified('读了', {'success': true}),
          Observation.unverified('没读到', why: '权限被拒'),
        ],
      );
      final rep = checker.checkReport(report);
      expect(rep.summary.total, 2);
      expect(rep.summary.verified, 1);
      expect(rep.summary.unverified, 1);
    });

    test('读取器抛异常产生的未验证项，检查器判为 unverified 而非失败', () {
      // 那条观察 evidence 是 null，所以走"没有任何证据"分支。
      final report = SubAgentReport(
        role: SubAgentRole.reader,
        ok: true,
        observations: [
          Observation.unverified('读了', why: '工具 read 抛出异常：StateError'),
        ],
      );
      final rep = checker.checkReport(report);
      expect(rep.summary.unverified, 1);
      expect(rep.summary.contradicted, 0);
    });
  });

  group('DONE 信号缺口', () {
    test('amoo 声称完成但命令未验证 → 不许记成成功', () {
      // 这条是整个检查器存在的理由。Java 侧 LoopState 把未验证计数
      // 带进 Verdict，Dart 侧这边负责在报告里如实呈现。
      final report = SubAgentReport(
        role: SubAgentRole.checker,
        ok: true,
        observations: [
          Observation.verified('命令 1 执行成功', {'success': true}),
          Observation.verified('命令 2 执行成功', {'success': true}),
          Observation.unverified('命令 3 声称执行成功', why: '回报缺失'),
        ],
      );
      final rep = checker.checkReport(report);
      expect(rep.summary.unverified, 1);
      expect(rep.humanSummary, contains('无法验证'));
      expect(rep.summary.nothingContradicted, isTrue,
          reason: '未验证不是被推翻，别把两者说成一件');
    });

    test('amoo 声称成功但证据显示失败 → contradicted', () {
      final report = SubAgentReport(
        role: SubAgentRole.checker,
        ok: true,
        observations: [
          Observation.fromToolResult(
              'amoo 说装好了', {'success': false, 'error': '签名不符'}),
        ],
      );
      final rep = checker.checkReport(report);
      expect(rep.summary.contradicted, 1);
      expect(rep.summary.nothingContradicted, isFalse);
    });
  });
}
