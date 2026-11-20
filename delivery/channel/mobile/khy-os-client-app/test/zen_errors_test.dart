import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/zen_errors.dart';

/// Zen 错误归类：四类病在 UI 上不能被说成同一句话。
void main() {
  group('classify', () {
    test('429 + FreeUsageLimitError → 匿名池用尽，且不再错说是出口 IP', () {
      final v = classify(429, '{"error":{"message":"FreeUsageLimitError"}}');
      expect(v.kind, ZenErrorKind.freeUsageLimit);
      expect(v.transient, isFalse);
      expect(v.message, contains('额度'));
      // 2026-11-17 实测推翻了"按出口 IP 计"：换网络/换模型/换设备都无效，
      // 文案不能再把人往换网络上引。
      expect(v.message, isNot(contains('出口 IP')));
      expect(v.message, contains('匿名'));
      // 唯一有效的动作要能照做：填账号 Key。
      expect(v.message, contains('账号 Key'));
    });

    test('403 + FreeTierError → 客户端校验未过，且指向账号 Key', () {
      final v = classify(
          403, 'FreeTierError: free tier can only be used from within OpenCode');
      expect(v.kind, ZenErrorKind.freeTier);
      expect(v.transient, isFalse);
      // 账号 Key 走账号额度、不再依赖客户端校验——这条是 2026-11-17 补上的事实，
      // 旧文案写的"换 key 无用"会把唯一的路挡掉。
      expect(v.message, isNot(contains('换 key 无用')));
      expect(v.message, contains('账号 Key'));
    });

    test('403 + region → 地区封锁', () {
      final v = classify(403, 'RegionError: not available in your region');
      expect(v.kind, ZenErrorKind.region);
      expect(v.message, contains('地区'));
    });

    test('404/410 + is not supported → 模型下线', () {
      for (final status in [404, 410]) {
        final v = classify(status, 'ModelError: model is not supported');
        expect(v.kind, ZenErrorKind.modelUnsupported, reason: '$status');
        expect(v.message, contains('换一个模型'));
      }
    });

    test('400 裸码 / 5xx 各归其类', () {
      final bad = classify(400, '{"error":"bad request"}');
      expect(bad.kind, ZenErrorKind.unknown);
      expect(bad.message, contains('400'));

      final upstream = classify(503, 'upstream request failed');
      expect(upstream.kind, ZenErrorKind.endpointUnavailable);
      expect(upstream.transient, isTrue);
    });

    test('普通 429（没有免费额度识别码）仍是可退避的限流', () {
      final v = classify(429, '');
      expect(v.kind, ZenErrorKind.rateLimit);
      expect(v.transient, isTrue);
    });

    test('401/403 无识别码 → auth', () {
      expect(classify(401, '').kind, ZenErrorKind.auth);
      expect(classify(403, 'forbidden').kind, ZenErrorKind.auth);
    });

    test('文案不回显原始 body', () {
      const body = 'FreeUsageLimitError traceId=abc123 SECRET-LEAK';
      final v = classify(429, body);
      expect(v.message.contains('traceId'), isFalse);
      expect(v.message.contains('SECRET-LEAK'), isFalse);
    });
  });

  group('isSuccessful', () {
    test('只认 2xx', () {
      expect(isSuccessful(200), isTrue);
      expect(isSuccessful(204), isTrue);
      expect(isSuccessful(403), isFalse);
      expect(isSuccessful(500), isFalse);
      expect(isSuccessful(null), isFalse);
    });
  });

  group('bodyFromData', () {
    test('String / Map / null', () {
      expect(bodyFromData('x'), 'x');
      expect(bodyFromData({'error': 'bad'}), contains('bad'));
      expect(bodyFromData(null), '');
    });
  });
}
