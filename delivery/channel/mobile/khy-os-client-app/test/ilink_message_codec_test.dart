// Test vectors pinned to ilinkProtocol.test.js assertions and the documented
// behaviors in ilinkMessageCodec.js comments. acceptance[2]: splitMessage /
// buildOutboundMessage / parseInboundMessage must produce the same output as
// the Node codec for the same input.

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/ilink/ilink_message_codec.dart';
import 'package:khy_os_client/core/ilink/ilink_protocol.dart';

void main() {
  group('protocol constants (ilinkProtocol.test.js vectors)', () {
    test('platform id and channel version are byte-fixed', () {
      expect(kIlinkChannelVersion, '1.0.0');
    });

    test('message/item/state enums equal wire numbers', () {
      expect(kIlinkMessageTypeUser, 1);
      expect(kIlinkMessageTypeBot, 2);
      expect(kIlinkItemTypeText, 1);
      expect(kIlinkItemTypeVoice, 3);
      expect(kIlinkItemTypeFile, 4);
      expect(kIlinkItemTypeVideo, 5);
      expect(kIlinkMessageStateFinish, 2);
    });

    test('session expired code is -14', () {
      expect(kIlinkRetSessionExpired, -14);
    });

    test('split ratio and backoff cap are literal constants', () {
      expect(kIlinkSplitNewlineMinRatio, 0.3);
      expect(kIlinkSendBackoffMaxMs, 8000);
    });

    test('trust check accepts allowlisted https hosts and subdomains only', () {
      expect(isTrustedIlinkBaseUrl('https://ilinkai.weixin.qq.com', kIlinkAllowedHosts), isTrue);
      expect(isTrustedIlinkBaseUrl('https://novac2c.cdn.weixin.qq.com/c2c', kIlinkAllowedHosts), isTrue);
      expect(isTrustedIlinkBaseUrl('https://evil.example.com', kIlinkAllowedHosts), isFalse);
      // allowlist-suffix spoof must fail
      expect(isTrustedIlinkBaseUrl('https://weixin.qq.com.evil.com', kIlinkAllowedHosts), isFalse);
      // plain http is never trusted
      expect(isTrustedIlinkBaseUrl('http://ilinkai.weixin.qq.com', kIlinkAllowedHosts), isFalse);
      expect(isTrustedIlinkBaseUrl('', kIlinkAllowedHosts), isFalse);
      expect(isTrustedIlinkBaseUrl('not a url', kIlinkAllowedHosts), isFalse);
    });
  });

  group('extractText', () {
    test('joins multiple text items with newline', () {
      final items = <Object>[
        {'type': 1, 'text_item': {'text': '第一段'}},
        {'type': 1, 'text_item': {'text': '第二段'}},
      ];
      expect(extractText(items), '第一段\n第二段');
    });

    test('judges by text_item.text, not by type field (missing type seen in the wild)', () {
      final items = <Object>[
        {'text_item': {'text': '无类型'}},
      ];
      expect(extractText(items), '无类型');
    });

    test('non-list and empty cases return empty string', () {
      expect(extractText(null), '');
      expect(extractText('nope'), '');
      expect(extractText(<Object>[]), '');
    });
  });

  group('parseInboundMessage', () {
    final base = <String, dynamic>{
      'message_type': 1,
      'from_user_id': 'peer-1',
      'context_token': 'ctx-42',
      'message_id': 7,
      'create_time_ms': 1700000000000,
      'item_list': <Object>[
        {'type': 1, 'text_item': {'text': '你好'}},
      ],
    };

    test('normalizes a USER message; context_token echoed back untouched', () {
      final m = parseInboundMessage(base)!;
      expect(m.userId, 'peer-1');
      expect(m.channelId, 'peer-1');
      expect(m.text, '你好');
      expect(m.threadId, 'ctx-42');
      expect(m.messageId, 7);
      expect(m.timestamp, 1700000000000);
      expect(m.unsupported, isEmpty);
    });

    test('drops BOT echoes (message_type=2)', () {
      final echo = Map<String, dynamic>.from(base)
        ..['message_type'] = kIlinkMessageTypeBot;
      expect(parseInboundMessage(echo), isNull);
    });

    test('missing message_type is treated as USER (lenient)', () {
      final noType = Map<String, dynamic>.from(base)..remove('message_type');
      expect(parseInboundMessage(noType), isNotNull);
    });

    test('drops missing from_user_id', () {
      final noFrom = Map<String, dynamic>.from(base)..remove('from_user_id');
      expect(parseInboundMessage(noFrom), isNull);
      expect(parseInboundMessage(<String, dynamic>{}), isNull);
      expect(parseInboundMessage(null), isNull);
    });

    test('drops empty or missing item_list', () {
      final emptyItems = Map<String, dynamic>.from(base)
        ..['item_list'] = <Object>[];
      expect(parseInboundMessage(emptyItems), isNull);
      final noItems = Map<String, dynamic>.from(base)..remove('item_list');
      expect(parseInboundMessage(noItems), isNull);
    });

    test('labels voice/file/video items as unsupported', () {
      final media = Map<String, dynamic>.from(base)
        ..['item_list'] = <Object>[
          {'type': kIlinkItemTypeVoice, 'voice_item': <String, dynamic>{}},
        ];
      expect(parseInboundMessage(media)!.unsupported, <String>['语音']);
    });

    test('non-int message_id falls back to null (dedupe then passes it through)', () {
      final strId = Map<String, dynamic>.from(base)..['message_id'] = '7';
      expect(parseInboundMessage(strId)!.messageId, isNull);
    });
  });

  group('buildOutboundMessage', () {
    test('from_user_id is the empty string, state FINISH, token echoed', () {
      final payload = buildOutboundMessage(
        toUserId: 'peer-1',
        clientId: 'khy-1-2',
        contextToken: 'ctx-42',
        items: buildTextItems('回复'),
      );
      final msg = payload['msg'] as Map<String, dynamic>;
      expect(msg['from_user_id'], '');
      expect(msg['to_user_id'], 'peer-1');
      expect(msg['client_id'], 'khy-1-2');
      expect(msg['message_type'], kIlinkMessageTypeBot);
      expect(msg['message_state'], kIlinkMessageStateFinish);
      expect(msg['context_token'], 'ctx-42');
      expect(
        msg['item_list'],
        <Object>[
          {'type': 1, 'text_item': {'text': '回复'}},
        ],
      );
      expect(
        payload['base_info'],
        <String, dynamic>{'channel_version': '1.0.0'},
      );
    });
  });

  group('buildClientId', () {
    test('khy-<now>-<seq> shape', () {
      expect(buildClientId(3, 1700000000000), 'khy-1700000000000-3');
    });
  });

  group('splitMessage (codec header behaviors, ilinkMessageCodec.js:305-331)', () {
    test('empty input returns []', () {
      expect(splitMessage('', 100), <String>[]);
    });

    test('short text returns one chunk unchanged', () {
      expect(splitMessage('短消息', 100), <String>['短消息']);
    });

    test('hard cut when no newline; chunks each ≤ limit', () {
      final s = 'a' * 250;
      final chunks = splitMessage(s, 100);
      expect(chunks.length, 3);
      expect(chunks[0], 'a' * 100);
      expect(chunks[1], 'a' * 100);
      expect(chunks[2], 'a' * 50);
      expect(chunks.join(), s);
    });

    test('cuts at the last newline when it is past 30% of the cap', () {
      // 60 chars, newline at index 39 (>= 30% of 50)
      final a39 = 'a' * 39;
      final b20 = 'b' * 20;
      final s = '$a39\n$b20';
      final chunks = splitMessage(s, 50);
      expect(chunks, <String>[a39, b20]);
    });

    test('hard cut when the newline is too early (< 30%)', () {
      // newline at index 5 (10% of 50)
      final s = '${'a' * 5}\n${'b' * 54}';
      final chunks = splitMessage(s, 50);
      expect(chunks[0].length, 50);
      expect(chunks.join(), s);
    });

    test('newline at the cut point is trimmed from the next chunk head', () {
      // Two adjacent newlines at 39/40: lastIndexOf lands on 40, so chunk one
      // keeps the first newline (matches JS lastIndexOf semantics exactly),
      // while the next chunk's LEADING newline is stripped.
      final s = '${'a' * 39}\n\n${'b' * 40}';
      final chunks = splitMessage(s, 50);
      expect(chunks[1].startsWith('\n'), isFalse);
      expect(chunks.join(), '${'a' * 39}\n${'b' * 40}');
    });

    test('UTF-16 counting: CJK is 1, emoji is 2 (same as JS String.length)', () {
      // 1500 CJK chars = 1500 UTF-16 units, fits in one 2048 chunk
      final cjk = '汉' * 1500;
      expect(splitMessage(cjk, 2048).length, 1);
      // 1500 emoji (surrogate pairs) = 3000 UTF-16 units → 2 chunks
      final emoji = '🙂' * 1500;
      final emojiChunks = splitMessage(emoji, 2048);
      expect(emojiChunks.length, 2);
      expect(emojiChunks[0].length, 2048);
      expect(emojiChunks[0].length.isEven, isTrue); // never splits a surrogate pair mid-way? — hard cut CAN, asserted below
    });

    test('hard cut may split a surrogate pair — count contract is code units, not graphemes', () {
      // 2048 units of 🙂 = 1024 emojis + limit 2047 → odd cut inside a pair
      final emoji = '🙂' * 1024;
      final chunks = splitMessage(emoji, 2047);
      expect(chunks[0].length, 2047);
    });

    test('default cap is 2048 when maxLen is null or bogus', () {
      final s = 'a' * 2500;
      expect(splitMessage(s, null)[0].length, 2048);
      expect(splitMessage(s, 0)[0].length, 2048);
      expect(splitMessage(s, -5)[0].length, 2048);
    });

    test('long multi-line text never loses content', () {
      final line = '内容行,带一点中文和 ascii。';
      final s = List<String>.filled(200, line).join('\n');
      final chunks = splitMessage(s, 512);
      expect(chunks.first.isEmpty, isFalse);
      final rejoined = chunks.join('\n');
      final originalWithoutLeadingNewlines = s;
      expect(rejoined.replaceAll('\n', ''), originalWithoutLeadingNewlines.replaceAll('\n', ''));
    });
  });
}
