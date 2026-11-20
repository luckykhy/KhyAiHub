// Pure policy for polling backoff / outbound retry / approval replies, ported
// from ilinkSendPolicy.js. Zero IO, deterministic. parsePermissionReply is
// also the shared vocabulary for the WS2 approval bridge — keep the word list
// byte-identical to ilinkSendPolicy.js:88-103.

import 'ilink_protocol.dart';

/// Backoff after poll failures: short hop until [consecutiveFailures] reaches
/// [threshold], then the long hop (ilinkSendPolicy.js:25-31).
int decideBackoffMs(
  int consecutiveFailures, {
  int shortMs = kIlinkBackoffShortMs,
  int longMs = kIlinkBackoffLongMs,
  int threshold = kIlinkBackoffThreshold,
}) {
  final n = consecutiveFailures <= 0 ? 0 : consecutiveFailures;
  return n >= threshold ? longMs : shortMs;
}

/// Whether a getupdates response means "session expired, re-scan required".
bool isSessionExpired(Map<String, dynamic>? resp) =>
    resp != null && resp['ret'] == kIlinkRetSessionExpired;

/// Inbound dedupe on message_id only. At capacity the oldest half is evicted
/// (insertion-ordered). Messages without an id cannot be deduped and are
/// always accepted — better a duplicate than a lost message.
class IlinkDedupe {
  IlinkDedupe({int max = kIlinkDedupeMax})
      : cap = max > 0 ? max : 1000;

  final int cap;
  final Set<int> _seen = <int>{};

  /// true = new (process it); false = duplicate (skip).
  bool accept(int? messageId) {
    if (messageId == null) {
      return true;
    }
    if (_seen.contains(messageId)) {
      return false;
    }
    _seen.add(messageId);
    if (_seen.length > cap) {
      final dropCount = cap ~/ 2;
      var removed = 0;
      final doomed = <int>[];
      for (final v in _seen) {
        if (removed >= dropCount) break;
        doomed.add(v);
        removed++;
      }
      _seen.removeAll(doomed);
    }
    return true;
  }

  int get size => _seen.length;
}

/// Is this text an approval reply? Chinese/English vocabulary is a hard
/// contract shared with the Node channel — never extend one end without the
/// other (ilinkSendPolicy.js:88-103).
String? parsePermissionReply(Object? text) {
  final raw = (text ?? '').toString().trim().toLowerCase();
  final t = raw.replaceFirst(RegExp(r'[。．.!!]+$'), '');
  if (t.isEmpty) return null;
  if (t == 'y' || t == 'yes' || t == '是' || t == '好' || t == '允许' || t == '同意') {
    return 'allow';
  }
  if (t == 'n' || t == 'no' || t == '否' || t == '不' || t == '拒绝' || t == '不允许') {
    return 'deny';
  }
  return null;
}

/// Should this outbound failure be retried? Same semantics as
/// msgSender._isRetryable but judged on the structured fields the API layer
/// attaches (status / isTimeout), never by regex-guessing the message:
/// retryable = transport error (no status), timeout, 429, 5xx;
/// abort = other 4xx — payload/auth problems replay identically and only slow
/// the reply down and spam logs.
bool isRetryableSendError(Object err) {
  if (err is IlinkApiException) {
    if (err.isTimeout) return true;
    final status = err.status;
    if (status == null) return true;
    if (status == 429) return true;
    return status >= 500 && status <= 599;
  }
  // Transport-layer errors (socket/DNS/reset) carry no status.
  return true;
}

/// Backoff before retry attempt [attempt] (1-based): base·2^(attempt-1),
/// capped at kIlinkSendBackoffMaxMs.
int sendBackoffMs(int attempt, {int baseMs = kIlinkSendRetryBaseMs}) {
  final b = baseMs > 0 ? baseMs : 800;
  final n = attempt < 1 ? 1 : attempt;
  var v = b;
  for (var i = 1; i < n; i++) {
    v *= 2;
    if (v >= kIlinkSendBackoffMaxMs) break;
  }
  return v > kIlinkSendBackoffMaxMs ? kIlinkSendBackoffMaxMs : v;
}

/// Structured error thrown by the API layer on non-2xx / timeout. Carries the
/// HTTP status so retry decisions read a field instead of parsing text.
class IlinkApiException implements Exception {
  IlinkApiException.http(this.status, String body)
      : isTimeout = false,
        message = 'HTTP $status${body.isEmpty ? '' : ': ${_clip(body)}'}';

  IlinkApiException.timeout(String apiPath, int timeoutMs)
      : status = null,
        isTimeout = true,
        message = '请求 $apiPath 超时($timeoutMs ms)';

  IlinkApiException.transport(this.message)
      : status = null,
        isTimeout = false;

  final int? status;
  final bool isTimeout;
  final String message;

  static String _clip(String s) =>
      s.length <= 200 ? s : s.substring(0, 200);

  @override
  String toString() => message;
}
