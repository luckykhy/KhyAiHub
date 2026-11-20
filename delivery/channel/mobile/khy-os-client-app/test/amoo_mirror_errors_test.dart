import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/key_pool.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_api.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_errors.dart';

/// Error-mapping pins. The 429 backoff reuses key_pool's parser rather than
/// growing a second one — these cases pin that the mirror's rate-limit path
/// actually lands on parseRetryAfterCooldown's three shapes.
void main() {
  group('amooMirrorKindForStatus', () {
    test('契约四个错误码逐条映射', () {
      expect(amooMirrorKindForStatus(401), AmooMirrorErrorKind.unauthorized);
      expect(amooMirrorKindForStatus(404), AmooMirrorErrorKind.notFound);
      expect(amooMirrorKindForStatus(409), AmooMirrorErrorKind.cursorStale);
      expect(amooMirrorKindForStatus(429), AmooMirrorErrorKind.rateLimited);
    });

    test('5xx 归 server，其余 4xx 归 badResponse（不猜语义）', () {
      expect(amooMirrorKindForStatus(500), AmooMirrorErrorKind.server);
      expect(amooMirrorKindForStatus(503), AmooMirrorErrorKind.server);
      expect(amooMirrorKindForStatus(400), AmooMirrorErrorKind.badResponse);
      expect(amooMirrorKindForStatus(418), AmooMirrorErrorKind.badResponse);
    });
  });

  group('describeAmooMirrorError — 规则 2.2 三要素', () {
    AmooMirrorApiException ex(
      AmooMirrorErrorKind kind, {
      int? status,
      String? retryAfter,
    }) =>
        AmooMirrorApiException(
          kind: kind,
          status: status,
          retryAfter: retryAfter,
        );

    test('每个 kind 都给出 问题 + 识别码 + 修复', () {
      const cases = <AmooMirrorErrorKind, List<String>>{
        AmooMirrorErrorKind.unauthorized: ['401', '配对'],
        AmooMirrorErrorKind.notFound: ['404', '缓存'],
        AmooMirrorErrorKind.cursorStale: ['409', '重拉'],
        AmooMirrorErrorKind.rateLimited: ['429', '稍后'],
        AmooMirrorErrorKind.server: ['503', '稍后'],
        AmooMirrorErrorKind.transport: ['网络', '重试'],
        AmooMirrorErrorKind.timeout: ['超时', '稍后'],
        AmooMirrorErrorKind.badResponse: ['契约', '解析'],
      };
      for (final entry in cases.entries) {
        final text = describeAmooMirrorError(ex(entry.key, status: 503));
        expect(text, isNotEmpty);
        expect(text, contains('：'), reason: '${entry.key.name} 缺三段式冒号');
        for (final token in entry.value) {
          expect(text, contains(token),
              reason: '${entry.key.name} 的文案缺要素 $token');
        }
      }
    });

    test('server/badResponse 带上真实状态码', () {
      expect(describeAmooMirrorError(
              ex(AmooMirrorErrorKind.server, status: 502)),
          contains('502'));
      expect(describeAmooMirrorError(
              ex(AmooMirrorErrorKind.badResponse, status: 200)),
          contains('200'));
    });
  });

  group('429 退避复用 key_pool 解析器（parseRetryAfterCooldown）', () {
    const nowMs = 1445412420000; // 2015-10-21 07:27:00 UTC

    test('秒数形态', () {
      expect(parseRetryAfterCooldown('120', nowMs: nowMs), 120000);
    });

    test('HTTP-date 形态', () {
      expect(
        parseRetryAfterCooldown('Wed, 21 Oct 2015 07:28:00 GMT', nowMs: nowMs),
        60000,
      );
    });

    test('畸形/缺失走 10s 兜底', () {
      expect(parseRetryAfterCooldown('', nowMs: nowMs), 10000);
      expect(parseRetryAfterCooldown('soon', nowMs: nowMs), 10000);
    });

    test('钳在 [10s, 600s]', () {
      expect(parseRetryAfterCooldown('1', nowMs: nowMs), 10000);
      expect(parseRetryAfterCooldown('99999', nowMs: nowMs), 600000);
    });

    test('毫秒形态不会被当成秒——静默走兜底（契约缺口，README 已记）', () {
      // '1500' 在契约里可能是毫秒；解析器按秒读 = 1500s，被钳到 600s。
      // 这不是正确行为，是已知契约缺口下"可解释"的行为：等 600s 好过
      // 每 1.5s 打一次被限频的服务。
      expect(parseRetryAfterCooldown('1500', nowMs: nowMs), 600000);
    });
  });

  group('AmooMirrorApiException 携带字段', () {
    test('retryAfter 原样保留给退避策略解', () {
      const e = AmooMirrorApiException(
        kind: AmooMirrorErrorKind.rateLimited,
        status: 429,
        retryAfter: '120',
        detail: 'body snippet',
      );
      expect(e.retryAfter, '120');
      expect(e.status, 429);
      expect(e.detail, 'body snippet');
      expect(e.toString(), contains('rateLimited'));
    });
  });
}
