// Protocol constants for the WeChat ilink bot channel, ported 1:1 from
// runtime/node/backend/src/services/domain/messaging/messaging/ilinkProtocol.js.
// Single source for every timeout / limit / endpoint literal in lib/core/ilink/,
// so a server-side change never forks into per-file copies (the App has no env
// layer; Node's serviceDefaults.js role is played by this file inside the app).

/// Message direction. Inbound handling only accepts USER; BOT echoes are
/// messages this client sent itself coming back through getupdates.
const int kIlinkMessageTypeUser = 1;
const int kIlinkMessageTypeBot = 2;

/// item_list item types. Media types are parsed only to label an honest
/// "unsupported" reply — media send/receive is out of MVP scope.
const int kIlinkItemTypeText = 1;
const int kIlinkItemTypeImage = 2;
const int kIlinkItemTypeVoice = 3;
const int kIlinkItemTypeFile = 4;
const int kIlinkItemTypeVideo = 5;

/// Outbound always FINISH: this channel has no streaming (WeChat does not
/// render incremental updates).
const int kIlinkMessageStateFinish = 2;

/// getupdates session-expired code. Requires a fresh QR login; the poll loop
/// must pause long instead of hammering the endpoint.
const int kIlinkRetSessionExpired = -14;

/// When splitting long replies, give up on "split at newline" if the last
/// newline sits before this fraction of the cap (hard cut instead).
const double kIlinkSplitNewlineMinRatio = 0.3;

/// Cap for outbound retry backoff so exponential growth never reaches
/// minute-scale and makes the reply pointless.
const int kIlinkSendBackoffMaxMs = 8000;

/// Channel plugin version carried in outbound base_info. Protocol constant,
/// not a host/port — required by the server, missing means send fails.
const String kIlinkChannelVersion = '1.0.0';

/// Third-party bot form id (ClawBot-style), fixed by the QR login endpoint.
const int kIlinkBotType = 3;

/// Give up after the QR code expires this many times in a row, so an
/// unattended device does not spin on QR refresh forever.
const int kIlinkMaxQrRefresh = 3;

// ── App-side defaults (values from Node serviceDefaults.js:315-429) ──────────
// The App has no env layer, so these are consts; tuning knobs stay in one
// place exactly because nobody should hunt them across files later.

/// Default API endpoint. Overridden only by a server-sent baseurl that passes
/// the https + allowlist check in [isTrustedIlinkBaseUrl].
const String kIlinkBaseUrl = 'https://ilinkai.weixin.qq.com';

/// Hosts a server-sent baseurl may point at. The QR response is trusted data
/// from the wire — never blind-trusted (see ilinkApi.js:39-43).
const List<String> kIlinkAllowedHosts = <String>['weixin.qq.com', 'wechat.com'];

/// Long-poll: the server holds the request up to this long.
const int kIlinkGetUpdatesTimeoutMs = 35000;

/// Regular request timeout (sendmessage / QR fetch).
const int kIlinkRequestTimeoutMs = 15000;

const int kIlinkGetConfigTimeoutMs = 10000;
const int kIlinkSendTypingTimeoutMs = 5000;

/// QR status polling interval / per-request timeout.
const int kIlinkQrPollIntervalMs = 3000;
const int kIlinkQrPollTimeoutMs = 60000;

/// Poll failure backoff: short hop first, long hop once past the threshold.
const int kIlinkBackoffShortMs = 3000;
const int kIlinkBackoffLongMs = 30000;
const int kIlinkBackoffThreshold = 3;

/// After ret=-14 the session is dead until a human re-scans; retrying fast is
/// pointless, so the loop sleeps an hour instead.
const int kIlinkSessionExpiredPauseMs = 3600000;

/// Outbound text chunk cap in UTF-16 code units (Dart String.length and JS
/// String.length count the same thing — CJK is 1, emoji is 2).
const int kIlinkMaxMessageLength = 2048;

/// Inbound dedupe capacity; at overflow the oldest half is evicted.
const int kIlinkDedupeMax = 1000;

/// Outbound retry: transient errors back off base·2^n capped at
/// [kIlinkSendBackoffMaxMs]; 4xx (except 429) aborts immediately.
const int kIlinkSendMaxRetries = 2;
const int kIlinkSendRetryBaseMs = 800;

/// Base URL trust check, ported from ilinkCore.js:106-117. A server-sent
/// baseurl is only accepted when https and on the allowlist (exact host or
/// subdomain); anything else falls back to [kIlinkBaseUrl].
bool isTrustedIlinkBaseUrl(String baseUrl, List<String> allowedHosts) {
  final Uri? u = Uri.tryParse(baseUrl.trim());
  if (u == null || u.scheme != 'https' || u.host.isEmpty) {
    return false;
  }
  // JS new URL lowercases the hostname; Dart Uri keeps case. Match JS so a
  // mixed-case baseurl from the wire is judged the same on both ends.
  final String host = u.host.toLowerCase();
  return allowedHosts.any(
    (String h) => host == h || host.endsWith('.$h'),
  );
}
