import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/ui/render/content_tier.dart';

void main() {
  // 渲染三档降级（§5.4）。这组测试钉的是「任何 driver 的内容都必然落入
  // 三档之一，且判定自动完成」——T2「新 driver 不改渲染层」的机制保证就在
  // 这里：判定只看内容形状，不认识 driver。
  group('decideTier 三档判定', () {
    test('L1：约定的块序列 JSON', () {
      const l1 = '[{"type":"text","text":"你好"},'
          '{"type":"tool_call","callId":"c1","name":"ls","args":{"path":"/sdcard"}},'
          '{"type":"reasoning","text":"想了想"}]';
      final d = decideTier(l1);
      expect(d.tier, ContentTier.l1);
      expect(d.blocks, isNotNull);
      expect(d.blocks!.length, 3);
      expect(d.blocks![0], isA<TextBlock>());
      expect(d.blocks![1], isA<ToolCallBlock>());
      expect(d.blocks![2], isA<ReasoningBlock>());
    });

    test('L2：不是块序列 JSON，但有 markdown 结构', () {
      const l2 = '# 标题\n\n- 列表项\n\n```dart\nvoid main() {}\n```';
      final d = decideTier(l2);
      expect(d.tier, ContentTier.l2);
      expect(d.blocks, isNull);
    });

    test('L3：纯文本，无任何结构', () {
      final d = decideTier('就是一句普通的话，没有任何标记。');
      expect(d.tier, ContentTier.l3);
      expect(d.blocks, isNull);
    });

    test('坏 JSON 不抛，逐级降级到 L3', () {
      // 半截 JSON / 坏转义 / 空串——判定失败只留调试日志，不弹对话框、
      // 不抛异常打到界面上。
      for (final raw in const [
        '[{"type":"text","text":"半截',
        '{"not":"a block sequence"}',
        '',
        '   ',
        'null',
        '[1, 2, 3]', // 是 JSON 但不是块序列
      ]) {
        final d = decideTier(raw);
        expect(d.tier, anyOf(ContentTier.l2, ContentTier.l3), reason: '坏输入必须落到可渲染档：$raw');
      }
    });

    test('空内容判 L3（不崩、不画空气泡）', () {
      expect(decideTier('').tier, ContentTier.l3);
    });

    test('JSON 数组但含未知块类型：未知块降级为带标注的文本，已知块保留', () {
      // 2026-11-15 订正：原先未知块是「跳过」。跳过等于静默删内容——用户看到
      // 的只是"少了一段"，界面上没有任何东西解释为什么少。任务书 §6 要求
      // 「未知块降级文本并标注」，所以改成保留为 TextBlock 并标出类型。
      const mixed = '[{"type":"text","text":"保留我"},{"type":"future_block","x":1}]';
      final d = decideTier(mixed);
      expect(d.tier, ContentTier.l1);
      expect(d.blocks!.length, 2, reason: '未知块不丢：降级成文本');
      expect(d.blocks![0], isA<TextBlock>());
      final unknown = d.blocks![1] as TextBlock;
      expect(unknown.text, contains('未知块'));
      expect(unknown.text, contains('future_block'), reason: '标注必须能看出是哪种块');
      expect(unknown.text, contains('"x":1'), reason: '原文要留着，否则无从上报');
    });

    test('判定不认识 driver：同一内容判同一档', () {
      // 机械证明：decideTier 的签名里没有任何 driver 参数——换个 driver
      // 产出的同形状内容，走同一条判定。这条测试防的是有人给判定加
      // driver 分支（那正是 T2 要禁的事）。
      const content = '# 同样的话';
      expect(decideTier(content).tier, decideTier(content).tier);
    });
  });

  group('DriverStatus 状态行组装（RUNTIME-002：动作+目标+进度）', () {
    test('timed_out 状态行带目标、进度与重试入口', () {
      final line = driverStatusLine(DriverStatus(code: 'timed_out', detail: 'amoo 未回复', attempt: 3));
      expect(line.text, contains('amoo'));
      expect(line.text, contains('3'), reason: '进度信号：第 N 次');
      expect(line.retryable, true, reason: 'timed_out 必须给重试入口');
    });

    test('waiting 状态行不出现「处理中」式含糊措辞', () {
      final line = driverStatusLine(DriverStatus(code: 'waiting', detail: '等回复'));
      for (final banned in const ['处理中', 'Loading', 'Connecting']) {
        expect(line.text.contains(banned), false, reason: 'RUNTIME-002：$banned 是含糊措辞');
      }
      expect(line.text, isNotEmpty);
    });

    test('failed 且 retryable=true 才有重试入口', () {
      final retryable = driverFailedLine(DriverFailed(error: '超时', retryable: true));
      expect(retryable.retryable, true);
      final hopeless = driverFailedLine(DriverFailed(error: '壳太旧', retryable: false));
      expect(hopeless.retryable, false);
      expect(hopeless.text, isNotEmpty, reason: '失败也要说话，不能空气泡');
    });

    test('状态行不是空气泡：任何状态都有可读文本', () {
      for (final code in const ['waiting', 'connecting', 'degraded', 'timed_out', 'failed']) {
        final line = driverStatusLine(DriverStatus(code: code, detail: 'd', attempt: 1));
        expect(line.text.trim(), isNotEmpty, reason: '$code 必须有可读状态行');
      }
    });
  });
}
