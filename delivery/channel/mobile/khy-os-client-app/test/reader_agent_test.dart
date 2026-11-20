import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/reader_agent.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

/// 读取子智能体的测试。
///
/// 全部在主机上跑：工具调用是注入的，不需要设备。这一点是刻意的——
/// 一个只能连真机才能测的读取器等于没有测试，而它恰恰是
/// "不许凭空想象"这条约束的第一道执行面。
void main() {
  ToolResult ok(Map<String, dynamic> meta) =>
      ToolResult(success: true, output: 'ok', metadata: meta);
  ToolResult bad(String err) => ToolResult.fail(err);

  group('正常读取', () {
    test('每步都带回原始 JSON 作为证据', () async {
      final reader = ReaderAgent((tool, args) async {
        expect(tool, 'file_list');
        return ok({'success': true, 'entries': ['a.txt', 'b.txt']});
      });
      final r = await reader.read(ReaderRequest(
        goal: '看工作空间里有什么',
        steps: [
          ReaderStep(tool: 'file_list', claim: '工作空间可列出'),
        ],
      ));
      expect(r.ok, isTrue);
      expect(r.observations.single.verified, isTrue);
      expect(r.observations.single.evidence!['entries'], ['a.txt', 'b.txt']);
      expect(r.fullyVerified, isTrue);
    });

    test('按顺序执行，且每步的 claim 保留', () async {
      final seen = <String>[];
      final reader = ReaderAgent((tool, args) async {
        seen.add(tool);
        return ok({'success': true, 'tool': tool});
      });
      await reader.read(ReaderRequest(
        goal: '先列目录再读文件',
        steps: [
          ReaderStep(tool: 'ls', claim: '列了目录'),
          ReaderStep(tool: 'read', claim: '读了文件'),
          ReaderStep(tool: 'read', claim: '又读了一个'),
        ],
      ));
      expect(seen, ['ls', 'read', 'read']);
    });

    test('args 被拷贝后传入，调用方事后改不影响已跑的那步', () async {
      final args = <String, dynamic>{'path': 'a.txt'};
      Map<String, dynamic>? captured;
      final reader = ReaderAgent((tool, a) async {
        captured = Map<String, dynamic>.from(a);
        return ok({'success': true});
      });
      await reader.read(ReaderRequest(
        goal: 'g',
        steps: [ReaderStep(tool: 'read', args: args, claim: 'c')],
      ));
      args['path'] = '改了';
      expect(captured!['path'], 'a.txt');
    });
  });

  group('失败与异常', () {
    test('工具 success=false → contradicted，证据保留', () async {
      // 失败也是证据。最初这里把 success=false 归进"没证据"、把证据丢掉，
      // 于是检查子智能体只能判"无法验证"，明明手里攥着失败原因。
      final reader = ReaderAgent((tool, args) async => bad('权限被拒'));
      final r = await reader.read(ReaderRequest(
        goal: 'g',
        steps: [ReaderStep(tool: 'read', claim: '读了')],
      ));
      final o = r.observations.single;
      expect(o.verified, isFalse);
      expect(o.contradicted, isTrue);
      expect(o.why, contains('权限被拒'));
      expect(o.evidence, isNotNull);
    });

    test('工具抛异常 → 未验证，异常文本不当证据', () async {
      // 这条是关键：抛异常不等于"读到了负面结果"。它是什么都没读到。
      // 把异常消息塞进 evidence 会让检查子智能体以为那是工具回报。
      final reader = ReaderAgent((tool, args) async {
        throw StateError('炸了');
      });
      final r = await reader.read(ReaderRequest(
        goal: 'g',
        steps: [ReaderStep(tool: 'read', claim: '读了')],
      ));
      final o = r.observations.single;
      expect(o.verified, isFalse);
      expect(o.evidence, isNull);
      expect(o.why, contains('抛出异常'));
    });

    test('没有 metadata 时用 output+success 兜底，仍可判定', () async {
      final reader = ReaderAgent((tool, args) async =>
          const ToolResult(success: true, output: 'abc'));
      final r = await reader.read(ReaderRequest(
        goal: 'g',
        steps: [ReaderStep(tool: 'read', claim: '读了')],
      ));
      expect(r.observations.single.verified, isTrue);
      expect(r.observations.single.evidence!['output'], 'abc');
    });
  });

  group('预算', () {
    test('超出步数上限即停，并说清还剩几步', () async {
      final reader = ReaderAgent((tool, args) async => ok({'success': true}));
      final steps = List.generate(
        ReaderAgent.maxSteps + 3,
        (i) => ReaderStep(tool: 'read', claim: '第 $i 步'),
      );
      final r = await reader.read(ReaderRequest(goal: 'g', steps: steps));
      expect(r.data['executed'], ReaderAgent.maxSteps);
      expect(r.data['requested'], steps.length);
      // 静默截断读起来像"跑完了"，所以必须有一条观察说明被截断。
      expect(r.observations.last.why, contains('步数上限'));
      expect(r.observations.last.claim, contains('未执行'));
    });

    test('超出证据字节上限即停，且停在那一步之后', () async {
      var call = 0;
      final reader = ReaderAgent((tool, args) async {
        call++;
        return ok({'success': true, 'pad': 'x' * 20000});
      });
      // 步数必须少于 maxSteps，否则先撞步数上限、永远测不到字节那条。
      final steps = List.generate(
        6,
        (i) => ReaderStep(tool: 'read', claim: '第 $i 步'),
      );
      final r = await reader.read(ReaderRequest(goal: 'g', steps: steps));
      expect(call, lessThan(6));
      expect(r.observations.last.why, contains('字节'));
      expect(r.data['evidence_bytes'],
          greaterThan(ReaderAgent.maxEvidenceBytes));
    });
  });

  group('报告形态', () {
    test('data 里带 requested/executed/evidence_bytes', () async {
      final reader = ReaderAgent((tool, args) async => ok({'success': true}));
      final r = await reader.read(ReaderRequest(
        goal: '看看',
        steps: [ReaderStep(tool: 'ls', claim: 'c')],
      ));
      expect(r.data['goal'], '看看');
      expect(r.data['requested'], 1);
      expect(r.data['executed'], 1);
      expect(r.data['evidence_bytes'], greaterThanOrEqualTo(0));
    });

    test('空步骤列表 → 正常返回，零观察', () async {
      final reader = ReaderAgent((tool, args) async => ok({'success': true}));
      final r = await reader.read(ReaderRequest(goal: 'g'));
      expect(r.ok, isTrue);
      expect(r.observations, isEmpty);
      expect(r.fullyVerified, isFalse);
    });

    test('toJson 可序列化', () async {
      final reader = ReaderAgent((tool, args) async => ok({'success': true}));
      final r = await reader.read(ReaderRequest(
        goal: 'g',
        steps: [ReaderStep(tool: 'ls', claim: 'c')],
      ));
      expect(r.toJson()['role'], 'reader');
    });
  });
}
