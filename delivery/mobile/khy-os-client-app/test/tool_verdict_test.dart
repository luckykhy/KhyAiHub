import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/checker_agent.dart';
import 'package:khy_os_client/core/agent/tool_verdict.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

/// 工具核对收口的测试。
///
/// 这一层是「不得凭空想象」在对话流里的落点：以前工具结果是裸 JSON 回去，
/// 模型读成什么全看它自己；现在结论由代码写在结果后面，模型没法把一次失败
/// 读成一次成功。
///
/// 三条最要紧的断言：
///   1. 失败必须写成 contradicted，且措辞明确说"不要在后续叙述里说成已完成"
///   2. install_apk 的空输出形态必须判成 unverified 而不是 verified——
///      这是 refutation Case 3 点名的形状
///   3. 用户拒绝也必须带结论，否则模型会重试或者当成成功继续
void main() {
  group('判定', () {
    test('成功 → verified', () {
      final v = ToolVerdictFactory.of('open_app', ToolResult.ok('已打开微信'));
      expect(v.verdict, CheckVerdict.verified);
      expect(v.userLabel, '已验证');
      expect(v.modelNote, contains('success=true'));
    });

    test('失败 → contradicted，措辞禁止模型说成已完成', () {
      final v = ToolVerdictFactory.of('install_apk', ToolResult.fail('签名不符'));
      expect(v.verdict, CheckVerdict.contradicted);
      expect(v.userLabel, '被推翻');
      expect(v.detail, contains('签名不符'));
      expect(v.modelNote, contains('没有成功'));
      expect(v.modelNote, contains('已完成'));
    });

    test('install_apk 空输出 → unverified，不是 verified', () {
      // refutation Case 3：`pm install` 退出码 0 且无输出，返回的是一个
      // 成功形态但零验证的结果。工具自己在 metadata 里声明了这一点，
      // 核对器必须读它——否则 UI 上"已装好"和"没验证"长得一模一样。
      final v = ToolVerdictFactory.of('install_apk', ToolResult.ok(
        '安装命令已执行（无输出）',
        metadata: <String, dynamic>{
          'via': 'sidecar',
          'elevated': true,
          'verified': false,
          'verify_why': '未做事后查询，无法确认装上',
        },
      ));
      expect(v.verdict, CheckVerdict.unverified);
      expect(v.userLabel, '未验证');
      expect(v.detail, contains('未做事后查询'));
      // 关键措辞：不许当成成功，也不许当成失败。
      expect(v.modelNote, contains('不要把它当作成功'));
      expect(v.modelNote, contains('也不要当作失败'));
    });

    test('exitCode 非零压过 success=true', () {
      final v = ToolVerdictFactory.of('exec_shell', ToolResult.ok(
        '跑完了',
        metadata: <String, dynamic>{'exitCode': 1},
      ));
      expect(v.verdict, CheckVerdict.contradicted);
      expect(v.detail, contains('exitCode'));
    });

    test('用户拒绝也是失败，且必须让模型知道', () {
      final v = ToolVerdictFactory.of('write_file',
          ToolResult.fail('用户拒绝了该操作'));
      expect(v.verdict, CheckVerdict.contradicted);
      expect(v.modelNote, contains('没有成功'));
    });

    test('metadata 为 null 也能判', () {
      final v = ToolVerdictFactory.of('calc', const ToolResult(success: true, output: '4'));
      expect(v.verdict, CheckVerdict.verified);
    });
  });

  group('喂回消息的两种协议', () {
    test('原生协议用 role:tool，并追加核对结论', () {
      final m = ToolVerdictFactory.toolMessage(
        tool: 'open_app',
        result: ToolResult.ok('已打开'),
        useTextProtocol: false,
        callId: 'abc',
      );
      expect(m['role'], 'tool');
      expect(m['tool_call_id'], 'abc');
      expect(m['content'], contains('已打开'));
      expect(m['content'], contains('【核对'));
    });

    test('文本协议用 role:user，沿用 ToolProtocol 外壳', () {
      final m = ToolVerdictFactory.toolMessage(
        tool: 'open_app',
        result: ToolResult.ok('已打开'),
        useTextProtocol: true,
      );
      expect(m['role'], 'user');
      expect(m['content'], contains('【核对'));
      // 外壳必须还是 ToolProtocol 的格式，不能自己发明一种。
      expect(m['content'], contains('TOOL_RESULT'));
    });

    test('结论一定在场——空结论等于没收口', () {
      for (final r in <ToolResult>[
        ToolResult.ok('x'),
        ToolResult.fail('y'),
        const ToolResult(success: true, output: 'z'),
      ]) {
        final m = ToolVerdictFactory.toolMessage(
          tool: 't', result: r, useTextProtocol: false);
        expect(m['content'], contains('【核对'));
      }
    });
  });

  group('toJson', () {
    test('三种结论都能序列化', () {
      for (final r in <ToolResult>[
        ToolResult.ok('x'),
        ToolResult.fail('y'),
        ToolResult.ok('z', metadata: <String, dynamic>{'verified': false}),
      ]) {
        final j = ToolVerdictFactory.of('t', r).toJson();
        expect(j['tool'], 't');
        expect(j['verdict'], isNotNull);
      }
    });
  });
}
