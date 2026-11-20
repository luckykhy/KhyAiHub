// Pure codecs for ilink wire messages, ported from ilinkMessageCodec.js.
// Zero IO, deterministic, never throws — every function takes a decoded JSON
// map of unknown shape and answers with a well-typed value or null.
//
// Text-only scope: image/file/voice items are parsed only enough to report an
// honest "unsupported" label; CDN media plumbing stays unported with media
// send/receive itself (out of MVP scope).

import 'ilink_protocol.dart';

/// Normalized inbound message (shape mirrors ilinkMessageCodec.js:174-203).
class IlinkInboundMessage {
  const IlinkInboundMessage({
    required this.channelId,
    required this.userId,
    required this.text,
    required this.unsupported,
    required this.threadId,
    required this.messageId,
    required this.timestamp,
    required this.raw,
  });

  /// Personal WeChat is 1:1 chat, so the conversation is the peer itself.
  final String channelId;
  final String userId;
  final String text;

  /// Chinese labels of non-text item types seen in this message, e.g.
  /// ['语音','文件'] — used to answer one honest "not supported" line.
  final List<String> unsupported;

  /// Inbound context_token; replies must carry it back unchanged so WeChat
  /// attaches the answer to the same conversation round.
  final String threadId;
  final int? messageId;
  final int timestamp;
  final Map<String, dynamic> raw;
}

/// Join every text item of an item_list. Judged by `text_item.text` being a
/// non-empty string, not by `type` — wire messages with a missing type field
/// have been seen in the wild (ilinkMessageCodec.js:100-112).
String extractText(Object? items) {
  if (items is! List) return '';
  final parts = <String>[];
  for (final item in items) {
    if (item is! Map) continue;
    final textItem = item['text_item'];
    final t = textItem is Map ? textItem['text'] : null;
    if (t is String && t.isNotEmpty) {
      parts.add(t);
    }
  }
  return parts.join('\n');
}

/// Count distinct non-text item types for one honest "unsupported" reply.
/// Label set mirrors the Node codec exactly (voice/file/video; images ride a
/// separate pipeline there, so they are not labeled here either) — a text-only
/// reply to an image-only message is handled by the caller seeing empty text.
List<String> describeUnsupportedItems(Object? items) {
  if (items is! List) return const <String>[];
  final labels = <String>{};
  for (final item in items) {
    if (item is! Map) continue;
    final type = item['type'];
    if (type == kIlinkItemTypeVoice || item.containsKey('voice_item')) {
      labels.add('语音');
    } else if (type == kIlinkItemTypeFile || item.containsKey('file_item')) {
      labels.add('文件');
    } else if (type == kIlinkItemTypeVideo || item.containsKey('video_item')) {
      labels.add('视频');
    }
  }
  return labels.toList();
}

/// Normalize one getupdates wire message for the dispatcher.
///
/// Returns null (drop) when: not USER direction (our own BOT echo), missing
/// from_user_id, or empty/absent item_list. A missing message_type is treated
/// as USER — lenient on purpose, the echo case always carries type BOT.
IlinkInboundMessage? parseInboundMessage(Object? msg) {
  if (msg is! Map) return null;
  // Only user-sent messages are processed; BOT direction is our own echo.
  final type = msg['message_type'];
  if (type != null && type != kIlinkMessageTypeUser) {
    return null;
  }
  final from = msg['from_user_id'];
  final userId = from == null || from == '' ? '' : from.toString();
  if (userId.isEmpty) {
    return null;
  }
  final items = msg['item_list'];
  if (items is! List || items.isEmpty) {
    return null;
  }

  final ctx = msg['context_token'];
  final messageId = msg['message_id'];
  final createMs = msg['create_time_ms'];
  return IlinkInboundMessage(
    channelId: userId,
    userId: userId,
    text: extractText(items).trim(),
    unsupported: describeUnsupportedItems(items),
    threadId: ctx == null || ctx == '' ? '' : ctx.toString(),
    messageId: messageId is int ? messageId : null,
    timestamp: createMs is int ? createMs : 0,
    raw: Map<String, dynamic>.from(msg),
  );
}

/// Outbound idempotency key. seq/now are injected to keep this pure and
/// testable (ilinkMessageCodec.js:211-213).
String buildClientId(int seq, int now) => 'khy-$now-$seq';

/// Plain-text item_list for outbound.
List<Map<String, dynamic>> buildTextItems(String text) => <Map<String, dynamic>>[
      <String, dynamic>{
        'type': kIlinkItemTypeText,
        'text_item': <String, dynamic>{'text': text},
      },
    ];

/// sendmessage body. from_user_id is the empty string — that is what the real
/// protocol expects when the bot sends; channel_version rides along in
/// base_info (ilinkMessageCodec.js:279-292).
Map<String, dynamic> buildOutboundMessage({
  required String toUserId,
  required String clientId,
  required String contextToken,
  required List<Map<String, dynamic>> items,
}) {
  return <String, dynamic>{
    'msg': <String, dynamic>{
      'from_user_id': '',
      'to_user_id': toUserId,
      'client_id': clientId,
      'message_type': kIlinkMessageTypeBot,
      'message_state': kIlinkMessageStateFinish,
      'context_token': contextToken,
      'item_list': items,
    },
    'base_info': <String, dynamic>{
      'channel_version': kIlinkChannelVersion,
    },
  };
}

/// Split a long reply into chunks of at most [maxLen] UTF-16 code units
/// (String.length on both Dart and JS — CJK counts 1, emoji 2).
///
/// Prefers cutting at the last newline within the cap so chunks read
/// naturally; when that newline sits too early (< maxLen · 0.3, which covers
/// "no newline at all" via -1) it hard-cuts to avoid confetti fragments. A
/// newline at the cut point is trimmed from the head of the next chunk so
/// blank lines do not pile up. Empty input returns [] and non-empty input
/// never yields zero chunks.
List<String> splitMessage(String? text, int? maxLen) {
  final s = text ?? '';
  final limit = (maxLen != null && maxLen > 0) ? maxLen : 2048;
  if (s.isEmpty) {
    return <String>[];
  }
  if (s.length <= limit) {
    return <String>[s];
  }

  final chunks = <String>[];
  var rest = s;
  while (rest.isNotEmpty) {
    if (rest.length <= limit) {
      chunks.add(rest);
      break;
    }
    var idx = rest.lastIndexOf('\n', limit);
    if (idx < limit * kIlinkSplitNewlineMinRatio) {
      idx = limit;
    }
    chunks.add(rest.substring(0, idx));
    // When the cut lands on a newline(s), strip them from the next chunk.
    rest = rest.substring(idx).replaceFirst(RegExp(r'^\n+'), '');
  }
  return chunks;
}
