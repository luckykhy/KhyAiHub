import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/screens/chat_screen_new.dart';

/// 历史压缩的回归锁。
///
/// 2026-11-16 实机：对话到第 9 条时发消息必现
/// `RangeError (start): Invalid value: Not in inclusive range 0..3: -1`。
/// 路径是 `_compactHistory` → 历史 9 条 → `older` 恰好 3 条 →
/// `older.sublist(3 - 4)`。这里钉住「不足 4 条不许越界」，也钉住摘要仍然只取尾部。
void main() {
  List<Map<String, dynamic>> history(int n) => [
        for (var i = 0; i < n; i++)
          {'role': i.isEven ? 'user' : 'assistant', 'content': 'm$i'},
      ];

  group('summarizeHistoryTail', () {
    test('0 / 1 / 3 条都不抛（第 9 条消息时的 older 就是 3 条）', () {
      expect(() => summarizeHistoryTail(history(0)), returnsNormally);
      expect(() => summarizeHistoryTail(history(1)), returnsNormally);
      expect(() => summarizeHistoryTail(history(3)), returnsNormally);
      expect(summarizeHistoryTail(history(3)).split('\n').length, 3);
    });

    test('4 条全要，5 条只取最后 4 条', () {
      expect(summarizeHistoryTail(history(4)).split('\n').length, 4);
      final five = summarizeHistoryTail(history(5));
      expect(five.split('\n').length, 4);
      expect(five.contains('m0'), false, reason: '最早那条应被丢掉');
      expect(five.contains('m4'), true);
    });

    test('长内容截断到 100 字符并留省略号', () {
      final long = 'x' * 300;
      final out = summarizeHistoryTail([
        {'role': 'user', 'content': long},
      ]);
      expect(out.contains('...'), true);
      expect(out.length < 300, true);
    });
  });
}
