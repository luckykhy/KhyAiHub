import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/subagent_report.dart';

/// 反 fabrication 数据模型的测试。
///
/// 这里钉的是**类型层面的保证**：一个"已验证"的观察不可能没有证据。
/// 这条是整个子智能体层的地基——如果它能被绕过，读取器/写入器带回的
/// "已验证"就只是一句话，检查子智能体也就无从核起。
void main() {
  group('Observation 的证据绑定', () {
    test('verified 一定带证据', () {
      final o = Observation.verified('写好了', {'success': true, 'bytes': 12});
      expect(o.verified, isTrue);
      expect(o.evidence, isNotNull);
      expect(o.evidence!['bytes'], 12);
    });

    test('unverified 一定没证据，且必须带原因', () {
      final o = Observation.unverified('写好了', why: '磁盘满了');
      expect(o.verified, isFalse);
      expect(o.evidence, isNull);
      expect(o.why, '磁盘满了');
    });

    test('空 Map 也算有证据——那是真实的空结果，不是没调用', () {
      // 区分"工具返回了 {}"和"工具没被调用"很重要：前者是一个事实，
      // 后者是缺失。混为一谈会让所有空回报都被当成失败。
      final o = Observation.verified('查完了', <String, dynamic>{});
      expect(o.verified, isTrue);
      expect(o.evidence, isNotNull);
      expect(o.evidence, isEmpty);
    });

    test('没有公开构造路径能造出"无证据的已验证"', () {
      // 靠工厂而不是公开构造函数。这条测试的价值在于：将来若有人
      // 把构造函数改成 public，这里会提醒他重新考虑。
      final all = <Observation>[
        Observation.verified('a', {'success': true}),
        Observation.unverified('b', why: 'x'),
        Observation.contradicted('c', {'success': false}, why: '工具说失败'),
        Observation.fromToolResult('d', null),
        Observation.fromToolResult('e', {'success': false, 'error': 'e'}),
        Observation.fromToolResult('f', {'success': true}),
        Observation.fromToolResult('g', {'weird': 1}),
      ];
      for (final o in all) {
        if (o.verified) expect(o.evidence, isNotNull);
        if (o.verified) expect(o.contradicted, isFalse);
      }
    });

    test('contradicted 与 unverified 互斥', () {
      final c = Observation.contradicted('a', {'success': false}, why: 'x');
      final u = Observation.unverified('b', why: 'x');
      expect(c.contradicted, isTrue);
      expect(c.verified, isFalse);
      expect(u.contradicted, isFalse);
      expect(u.verified, isFalse);
    });

    test('contradicted 保留证据——失败也是证据', () {
      // 这条钉的是一个真实缺陷：最初 success=false 被归进"没证据"，
      // 证据整个丢掉，下游只能说"无法验证"，明明手里攥着"工具明确说失败"。
      final o = Observation.contradicted(
        '装好了',
        {'success': false, 'error': 'INSTALL_FAILED_USER_RESTRICTED'},
        why: '工具明确报告失败',
      );
      expect(o.evidence, isNotNull);
      expect(o.evidence!['error'], 'INSTALL_FAILED_USER_RESTRICTED');
    });

    test('构造时拷贝证据，外部改动不影响已建观察', () {
      final ev = <String, dynamic>{'success': true};
      final o = Observation.verified('x', ev);
      ev['success'] = false;
      expect(o.evidence!['success'], isTrue);
    });
  });

  group('Observation.fromToolResult 的判定', () {
    test('success=true → verified', () {
      final o = Observation.fromToolResult('装好了', {
        'success': true,
        'package': 'com.tencent.mm',
      });
      expect(o.verified, isTrue);
      expect(o.evidence!['package'], 'com.tencent.mm');
    });

    test('success=false → contradicted，证据保留', () {
      final o = Observation.fromToolResult('装好了', {
        'success': false,
        'error': 'INSTALL_FAILED_USER_RESTRICTED',
      });
      expect(o.verified, isFalse);
      expect(o.contradicted, isTrue);
      expect(o.evidence!['error'], 'INSTALL_FAILED_USER_RESTRICTED');
      expect(o.why, contains('INSTALL_FAILED_USER_RESTRICTED'));
    });

    test('success=false 但没有 error 字段 → 不能留空原因', () {
      final o = Observation.fromToolResult('装好了', {'success': false});
      expect(o.verified, isFalse);
      expect(o.contradicted, isTrue);
      expect(o.why, isNotNull);
      expect(o.why!.trim(), isNotEmpty);
    });

    test('没有 success 字段 → unverified，不猜', () {
      // 渠道层偶尔会返回形状不定的东西。读不出结论就说读不出，
      // 不能因为"看起来像成功"就记成已验证。
      final o = Observation.fromToolResult('装好了', {'weird': 1});
      expect(o.verified, isFalse);
    });

    test('null 回报 → unverified，原因可自定义', () {
      final o = Observation.fromToolResult('装好了', null, missingWhy: '渠道未就绪');
      expect(o.verified, isFalse);
      expect(o.why, '渠道未就绪');
    });
  });

  group('SubAgentReport', () {
    test('ok 与 fullyVerified 是两件事', () {
      // 这条是整个设计的要点：一次顺利跑完但什么都没验证的循环，
      // 和一次真正验证过的循环，在数据上必须能分辨。
      final report = SubAgentReport(
        role: SubAgentRole.reader,
        ok: true,
        observations: [
          Observation.unverified('读了', why: '超时'),
          Observation.unverified('又读了', why: '没权限'),
        ],
      );
      expect(report.ok, isTrue);
      expect(report.fullyVerified, isFalse);
      expect(report.unverifiedCount, 2);
    });

    test('空观察列表不算 fullyVerified', () {
      // 什么都没干不该算"全部验证通过"——那会让一个空转的子智能体
      // 在 UI 上显示成绿灯。
      final report = SubAgentReport(role: SubAgentRole.reader, ok: true);
      expect(report.fullyVerified, isFalse);
      expect(report.unverifiedCount, 0);
    });

    test('toJson 带出未验证与被推翻计数', () {
      final report = SubAgentReport(
        role: SubAgentRole.checker,
        ok: true,
        observations: [
          Observation.verified('a', {'success': true}),
          Observation.unverified('b', why: '无证据'),
          Observation.contradicted('c', {'success': false}, why: '工具说失败'),
        ],
      );
      final j = report.toJson();
      expect(j['unverified'], 2);
      expect(j['contradicted'], 1);
      expect((j['observations'] as List).length, 3);
      expect(j['role'], 'checker');
    });

    test('failed 工厂不带观察', () {
      final r = SubAgentReport.failed(SubAgentRole.writer, '路径越界');
      expect(r.ok, isFalse);
      expect(r.error, '路径越界');
      expect(r.observations, isEmpty);
    });

    test('四个角色的 wire 值互不相同', () {
      final wires = SubAgentRole.values.map((r) => r.wire).toSet();
      expect(wires.length, SubAgentRole.values.length);
    });

    test('evidenceBytes 只数有证据的那些', () {
      final r = SubAgentReport(
        role: SubAgentRole.reader,
        ok: true,
        observations: [
          Observation.verified('a', {'success': true, 'pad': 'xxxxxx'}),
          Observation.unverified('b', why: 'x'),
        ],
      );
      expect(r.evidenceBytes, greaterThan(0));
    });
  });
}
