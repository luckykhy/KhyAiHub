// Vectors pinned to ilinkSendPolicy.js behaviors. parsePermissionReply is the
// shared approval vocabulary with the Node channel (WS2 consumes it) — the
// word list itself is part of the contract.

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/ilink/ilink_protocol.dart';
import 'package:khy_os_client/core/ilink/ilink_send_policy.dart';

void main() {
  group('decideBackoffMs (3s / 30s / threshold 3)', () {
    test('short hop below threshold', () {
      expect(decideBackoffMs(0), 3000);
      expect(decideBackoffMs(1), 3000);
      expect(decideBackoffMs(2), 3000);
    });

    test('long hop from threshold on', () {
      expect(decideBackoffMs(3), 30000);
      expect(decideBackoffMs(10), 30000);
    });

    test('config overrides', () {
      expect(decideBackoffMs(1, shortMs: 1, longMs: 5, threshold: 2), 1);
      expect(decideBackoffMs(2, shortMs: 1, longMs: 5, threshold: 2), 5);
    });
  });

  group('isSessionExpired', () {
    test('ret=-14 is the session-expired signal', () {
      expect(isSessionExpired(<String, dynamic>{'ret': kIlinkRetSessionExpired}), isTrue);
      expect(isSessionExpired(<String, dynamic>{'ret': -1}), isFalse);
      expect(isSessionExpired(<String, dynamic>{}), isFalse);
      expect(isSessionExpired(null), isFalse);
    });
  });

  group('IlinkDedupe (message_id, evict half at capacity)', () {
    test('accepts new ids, rejects repeats', () {
      final d = IlinkDedupe();
      expect(d.accept(1), isTrue);
      expect(d.accept(1), isFalse);
      expect(d.accept(2), isTrue);
      expect(d.size, 2);
    });

    test('null id always passes (no id → cannot dedupe, prefer duplicate over loss)', () {
      final d = IlinkDedupe();
      expect(d.accept(null), isTrue);
      expect(d.accept(null), isTrue);
    });

    test('at capacity the oldest half is evicted (insertion order)', () {
      final d = IlinkDedupe(max: 4);
      for (var i = 1; i <= 4; i++) {
        expect(d.accept(i), isTrue);
      }
      expect(d.size, 4);
      // next accept overflows: cap=4 → floor(4/2)=2 oldest (1,2) dropped
      expect(d.accept(5), isTrue);
      expect(d.size, 3);
      // 1 was evicted → accepted again as new; the overflow cascade stops
      // here (another insert would evict again), so no further assertions.
      expect(d.accept(1), isTrue);
      expect(d.accept(3), isFalse);
    });

    test('bogus max falls back to 1000', () {
      final d = IlinkDedupe(max: 0);
      expect(d.cap, 1000);
    });
  });

  group('parsePermissionReply (y/n zh+en vocabulary)', () {
    test('allow words', () {
      for (final w in <String>['y', 'yes', '是', '好', '允许', '同意', ' Y ', 'Yes。', '是.']) {
        expect(parsePermissionReply(w), 'allow', reason: 'word: $w');
      }
    });

    test('deny words', () {
      for (final w in <String>['n', 'no', '否', '不', '拒绝', '不允许', ' N ', 'No!']) {
        expect(parsePermissionReply(w), 'deny', reason: 'word: $w');
      }
    });

    test('anything else is null (falls through to prompt handling)', () {
      expect(parsePermissionReply('ok'), isNull);
      expect(parsePermissionReply('好的没问题'), isNull);
      expect(parsePermissionReply(''), isNull);
      expect(parsePermissionReply(null), isNull);
      expect(parsePermissionReply('y yes'), isNull); // not an exact word
    });
  });

  group('isRetryableSendError', () {
    test('timeout is retryable', () {
      expect(isRetryableSendError(IlinkApiException.timeout('getupdates', 35000)), isTrue);
    });

    test('429 and 5xx retryable', () {
      expect(isRetryableSendError(IlinkApiException.http(429, '')), isTrue);
      expect(isRetryableSendError(IlinkApiException.http(500, '')), isTrue);
      expect(isRetryableSendError(IlinkApiException.http(599, '')), isTrue);
    });

    test('4xx (except 429) aborts immediately', () {
      expect(isRetryableSendError(IlinkApiException.http(400, '')), isFalse);
      expect(isRetryableSendError(IlinkApiException.http(401, '')), isFalse);
      expect(isRetryableSendError(IlinkApiException.http(404, '')), isFalse);
    });

    test('transport errors (no status) retryable', () {
      expect(isRetryableSendError(IlinkApiException.transport('SocketException')), isTrue);
      expect(isRetryableSendError(Exception('anything')), isTrue);
    });
  });

  group('sendBackoffMs (800ms · 2^n capped at 8s)', () {
    test('exponential sequence', () {
      expect(sendBackoffMs(1), 800);
      expect(sendBackoffMs(2), 1600);
      expect(sendBackoffMs(3), 3200);
      expect(sendBackoffMs(4), 6400);
    });

    test('cap at 8000', () {
      expect(sendBackoffMs(5), 8000);
      expect(sendBackoffMs(20), 8000);
    });

    test('bogus attempt treated as 1', () {
      expect(sendBackoffMs(0), 800);
      expect(sendBackoffMs(-3), 800);
    });
  });

  group('IlinkApiException message shapes (structured, not regex-guessed)', () {
    test('http error carries status and clipped body', () {
      final e = IlinkApiException.http(500, 'x' * 300);
      expect(e.status, 500);
      expect(e.isTimeout, isFalse);
      expect(e.message.length < 300, isTrue);
      expect(e.message.startsWith('HTTP 500'), isTrue);
    });

    test('timeout error carries path and ms', () {
      final e = IlinkApiException.timeout('ilink/bot/getupdates', 35000);
      expect(e.status, isNull);
      expect(e.isTimeout, isTrue);
      expect(e.message, contains('getupdates'));
      expect(e.message, contains('35000'));
    });
  });
}
