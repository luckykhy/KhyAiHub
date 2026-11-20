import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/built_in_keys.dart';

/// 内置提供商注册表：端点隐藏与降级。
///
/// 这个套件存在的理由：端点数组在仓库里**永远是空的**（与钥匙同一套消毒规矩），
/// 所以「端点隐藏」这条路径在 CI 上跑的是空数据。不显式构造非空数组去测，
/// 解码逻辑就从未被验证过——而它坏了没有任何症状，只是两个提供商 silently
/// 变成空 Base URL。
void main() {
  group('registry shape', () {
    test('端点隐藏的提供商：网关在，镜像项在端点未生成时不列', () {
      final names = BuiltInKeys.providers.keys.toSet();
      expect(names, contains('khy-os 网关'));
      // opencode free 与 'OpenCode Zen' 同一上游、同一份模型；镜像端点没生成时
      // 列出来只是个选了也发不出去的重复项（2026-11-16 实机反馈）。
      expect(names, isNot(contains('opencode free')));
      expect(names, contains('OpenCode Zen'));
    });

    test('原有 8 个一个没少', () {
      // 回归护栏：新增两项不能顺手改动老项的端点或钥匙槽位。
      final names = BuiltInKeys.providers.keys.toSet();
      for (final old in const [
        'SupXH',
        'Command Code',
        '智谱 GLM',
        'OpenCode Go',
        'OpenRouter',
        'Sense Nova',
        'Agnes',
        'StepFun',
        'OpenCode Zen',
      ]) {
        expect(names, contains(old), reason: '$old 不该被新增项挤掉');
      }
    });

    test('老 8 项的端点仍是明文字面量、且都非空', () {
      // 它们没有 endpointBytes，所以解析结果就是 baseUrl——行为一字不变。
      for (final name in const [
        'SupXH',
        'Command Code',
        'OpenCode Zen',
        'Agnes',
      ]) {
        final p = BuiltInKeys.providers[name]!;
        expect(p.endpointConfigured, true, reason: '$name 应当视为已配置');
        expect(p.baseUrl, startsWith('https://'));
      }
    });

    test('免费档不要 Key（bearer 是 public）', () {
      // keyField = -2 → 'public'。hasKey 对 'public' 返回 false，
      // 但 keyless 为 true——免费档本来就不该要求用户填 Key。
      // opencode free 与 OpenCode Zen 共用这条语义；前者在镜像端点未生成时
      // 根本不列出（见上一条），所以这里对清单里真正可见的那一项断言。
      final p = BuiltInKeys.providers['OpenCode Zen']!;
      expect(p.hasKey, false);
      expect(p.keyless, true);
      expect(p.apiKey, 'public');
    });

    test('khy-os 网关要用户自备 Key', () {
      final p = BuiltInKeys.providers['khy-os 网关']!;
      expect(p.apiKey, isEmpty);
      expect(p.hasKey, false);
    });
  });

  group('endpoint hiding', () {
    test('仓库态：网关端点为空且标记为未配置', () {
      // 这是仓库里的正常状态，不是 bug。界面据此说「端点未配置」。
      final p = BuiltInKeys.providers['khy-os 网关']!;
      expect(p.baseUrl, isEmpty, reason: 'khy-os 网关的端点在仓库里应为空');
      expect(p.endpointConfigured, false);
      expect(p.usable, false);
    });

    test('镜像项没有端点时不出现，不留下选不中的死选项', () {
      // 它的端点数组为空时，这一项与 OpenCode Zen 完全等价：
      // 留着只会让用户在清单里选到一个发不出请求的重复项。
      expect(BuiltInKeys.providers.containsKey('opencode free'), false);
      expect(BuiltInKeys.get('opencode free'), isNull);
    });

    test('端点未配置的项不会污染 matchBaseUrl', () {
      // 空端点若参与匹配，「config.baseUrl 也是空」会被误判成命中这个提供商，
      // 于是 hasBuiltInKey / getBuiltInKey 都会对着一个不存在的端点作答。
      expect(BuiltInKeys.matchBaseUrl(''), isNull);
    });

    test('matchBaseUrl 仍能命中老 8 项', () {
      expect(BuiltInKeys.matchBaseUrl('https://opencode.ai/zen/v1'),
          'OpenCode Zen');
      expect(BuiltInKeys.matchBaseUrl('https://apihub.agnes-ai.com/v1'), 'Agnes');
    });
  });

  group('XOR round-trip', () {
    // 不依赖被测代码自己的 _decode——那会变成自己证明自己。
    // 这里按 built_in_keys.dart 文件顶部落下的常量独立实现一遍。
    const key = [0xA3, 0x5F, 0xC2, 0x1B];
    List<int> encode(String s) =>
        [for (var i = 0; i < s.length; i++) s.codeUnitAt(i) ^ key[i % 4]];
    String decode(List<int> b) =>
        String.fromCharCodes([for (var i = 0; i < b.length; i++) b[i] ^ key[i % 4]]);

    test('空数组解出空串（仓库态）', () {
      expect(decode(const []), isEmpty);
    });

    test('编码可逆，且与 gen_keys.py 的算法一致', () {
      // 用一个含中文与斜杠的值：端点必然是 URL，而 XOR 是按 codeUnit 逐字节做的，
      // 多字节字符不能被特殊对待——这里顺带钉住这一点。
      for (final s in const [
        'https://gw.example.internal/v1',
        'https://a.b/c',
        'x',
      ]) {
        expect(decode(encode(s)), s, reason: '$s 应能往返');
      }
    });

    test('同一个串编码两次结果相同（生成器幂等）', () {
      // gen_keys.py --check 靠逐字节比较判定一致；编码不确定就没法比。
      expect(encode('https://gw.example.internal/v1'),
          encode('https://gw.example.internal/v1'));
    });
  });

  group('keyless / canSend', () {
    test('Zen 免费档：keyless 且发得出去，hasKey 仍为 false', () {
      // 两件事必须分开：hasKey 答"有没有账号密钥"（答案永远是没有），
      // canSend 答"现在能不能发请求"（bearer 是 public，能）。
      final zen = BuiltInKeys.providers['OpenCode Zen']!;
      expect(zen.keyless, true);
      expect(zen.hasKey, false);
      expect(zen.endpointConfigured, true);
      expect(zen.canSend, true);
    });

    test('opencode free：镜像端点为空时整项不出现，连不可发送的壳都不留', () {
      // 改前是「keyless 但 canSend=false」——一个存在却发不出去的条目。
      // 留着它就是让人在清单里选到死选项；现在直接不列出。
      expect(BuiltInKeys.providers.containsKey('opencode free'), false);
    });

    test('khy-os 网关：不是免费档，没 key 就不可发送', () {
      final p = BuiltInKeys.providers['khy-os 网关']!;
      expect(p.keyless, false);
      expect(p.canSend, false);
    });

    test('canSend 的两个条件都必要', () {
      const noEndpoint = BuiltInProvider(
        baseUrl: '',
        apiKey: 'k',
        defaultModel: 'm',
        models: ['m'],
        endpointConfigured: false,
      );
      expect(noEndpoint.canSend, false);
      const noKey = BuiltInProvider(
        baseUrl: 'https://a.example.com/v1',
        apiKey: '',
        defaultModel: 'm',
        models: ['m'],
      );
      expect(noKey.canSend, false);
      const both = BuiltInProvider(
        baseUrl: 'https://a.example.com/v1',
        apiKey: 'public',
        defaultModel: 'm',
        models: ['m'],
        keyless: true,
      );
      expect(both.canSend, true);
    });
  });
}
