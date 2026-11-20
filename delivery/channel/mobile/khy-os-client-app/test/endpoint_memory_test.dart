import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/endpoint_memory.dart';

/// 端点记忆的契约测试。
///
/// 承重的三件事：
///   * 连通过的新地址排最前（PC 的 IP 变了以后，最新的那个才是对的）；
///   * 记住的是**一串**而不是一个——只记一个的话，IP 换回去就得人管；
///   * 存坏了读不出来就当空——半截地址连出去只会给出莫名其妙的失败。
void main() {
  group('EndpointMemory.merge', () {
    test('新地址排最前', () {
      final merged = EndpointMemory.merge(
        ['http://192.168.1.11:3000', 'http://192.168.2.11:3000'],
        'http://192.168.3.11:3000',
      );
      expect(merged.first, 'http://192.168.3.11:3000');
      expect(merged.length, 3);
    });

    test('重复的地址只留一份，且位置提到最前', () {
      final merged = EndpointMemory.merge(
        ['http://a:1', 'http://b:2'],
        'http://b:2',
      );
      expect(merged, ['http://b:2', 'http://a:1']);
    });

    test('空地址不进来', () {
      expect(EndpointMemory.merge(['http://a:1'], '   '), ['http://a:1']);
    });

    test('超过上限时丢最久没用的那些', () {
      // 种子按「最近用过的在前」排：h0 最近、h7 最久。
      final seed = List.generate(8, (i) => 'http://h$i:1');
      final merged = EndpointMemory.merge(seed, 'http://new:1');
      expect(merged.length, EndpointMemory.maxEntries);
      expect(merged.first, 'http://new:1');
      expect(merged[1], 'http://h0:1', reason: '次新的要留下');
      expect(merged.contains('http://h7:1'), false, reason: '最久没用的那个被丢掉');
    });
  });

  group('EndpointMemory.parse / serialize', () {
    test('JSON 数组读回来', () {
      final parsed = EndpointMemory.parse('["http://a:1","http://b:2"]');
      expect(parsed, ['http://a:1', 'http://b:2']);
    });

    test('老格式（逗号分隔）也认', () {
      expect(
        EndpointMemory.parse('http://a:1,http://b:2'),
        ['http://a:1', 'http://b:2'],
      );
    });

    test('空与 null 都当空记忆', () {
      expect(EndpointMemory.parse(null), isEmpty);
      expect(EndpointMemory.parse('  '), isEmpty);
      expect(EndpointMemory.parse('[]'), isEmpty);
    });

    test('坏 JSON 不抛，也不给出半截地址', () {
      final parsed = EndpointMemory.parse('[unclosed');
      // 要么解析出完整地址，要么什么都没有——不能出现半截
      for (final entry in parsed) {
        expect(entry.startsWith('http'), true);
      }
    });

    test('存取往返：写进去再读出来是一样的', () {
      final list = ['http://192.168.2.11:3000', 'http://192.168.1.11:3000'];
      final round = EndpointMemory.parse(EndpointMemory.serialize(list));
      expect(round, list);
    });
  });

  group('EndpointMemory.ordered', () {
    test('去重、丢掉空串、保序', () {
      expect(
        EndpointMemory.ordered(['http://a:1', '', 'http://a:1', ' http://b:2 ']),
        ['http://a:1', 'http://b:2'],
      );
    });
  });
}
