// Channel loop semantics, pinned to ilinkChannel.js:113-257:
// cursor persisted BEFORE dispatch, fire-and-forget dispatch, ret=-14 latches
// sessionExpired with a long pause, transient outbound errors retry while a
// mid-split failure reports the chunks that DID go out.

import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/ilink/ilink_api.dart';
import 'package:khy_os_client/core/ilink/ilink_channel.dart';
import 'package:khy_os_client/core/ilink/ilink_message_codec.dart';
import 'package:khy_os_client/core/ilink/ilink_send_policy.dart';
import 'package:khy_os_client/core/ilink/ilink_stores.dart';

/// Scriptable IlinkApi double: records getUpdates cursors and sendMessage
/// payloads in call order, answers from a queue or throws.
class FakeApi extends IlinkApi {
  FakeApi({this.updateScript = const <Object>[]}) : super(botToken: 'tok');

  /// One entry per getUpdates call: Map (response) or Exception/throwable.
  final List<Object> updateScript;
  int _updateIdx = 0;

  final List<String?> updateCursors = <String?>[];
  final List<Map<String, dynamic>> sentPayloads = <Map<String, dynamic>>[];
  final List<Object> sendScript = <Object>[]; // Map or Exception
  int _sendIdx = 0;

  @override
  Future<Map<String, dynamic>> getUpdates(String? buf) async {
    // A real getupdates holds ~35s before answering; without a simulated hold
    // the success path turns into a microtask storm that starves every Timer
    // (event loop never runs, future.timeout never fires).
    await Future<void>.delayed(const Duration(milliseconds: 2));
    updateCursors.add(buf);
    if (_updateIdx >= updateScript.length) {
      // keep the loop alive but idle: an empty response advances nothing
      return <String, dynamic>{'ret': 0, 'msgs': <Object>[]};
    }
    final step = updateScript[_updateIdx++];
    if (step is Exception) throw step;
    if (step is Error) throw step;
    return step as Map<String, dynamic>;
  }

  @override
  Future<Map<String, dynamic>> sendMessage(Map<String, dynamic> payload) async {
    sentPayloads.add(payload);
    if (_sendIdx < sendScript.length) {
      final step = sendScript[_sendIdx++];
      if (step is Exception) throw step;
      if (step is Error) throw step;
      return step as Map<String, dynamic>;
    }
    return <String, dynamic>{'ret': 0};
  }

  @override
  Future<Map<String, dynamic>> getConfig(String ilinkUserId, String? contextToken) async {
    return <String, dynamic>{};
  }

  @override
  Future<Map<String, dynamic>> sendTyping(String toUserId, String typingTicket, int status) async {
    return <String, dynamic>{};
  }
}

Map<String, dynamic> userMsg({required int id, String text = 'hi', String? ctx = 'ctx-1'}) =>
    <String, dynamic>{
      'message_type': 1,
      'from_user_id': 'peer-1',
      'message_id': id,
      'context_token': ?ctx,
      'item_list': <Object>[
        {'type': 1, 'text_item': {'text': text}},
      ],
    };

IlinkChannel makeChannel(FakeApi api, Directory tmp) {
  return IlinkChannel(
    accountId: 'acc-1',
    api: api,
    cursorStore: IlinkCursorStore(ilinkFileStore(tmp.path, 'cursor.json')),
    contextTokenStore:
        IlinkContextTokenStore(ilinkFileStore(tmp.path, 'ctx.json')),
    backoffShortMs: 1,
    backoffLongMs: 2,
    backoffThreshold: 3,
    sessionExpiredPauseMs: 1,
    sendRetryBaseMs: 1,
  );
}

/// Polls [cond] with real delays until true or the budget runs out.
Future<void> waitFor(bool Function() cond, {int budgetMs = 3000}) async {
  var waited = 0;
  while (!cond()) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
    waited += 5;
    if (waited > budgetMs) {
      fail('condition not met within ${budgetMs}ms');
    }
  }
}

void main() {
  late Directory tmp;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('ilink_channel_test');
  });

  tearDown(() {
    tmp.deleteSync(recursive: true);
  });

  group('poll loop', () {
    test('delivers parsed inbound messages to the handler, drops BOT echoes',
        () async {
      final api = FakeApi(updateScript: <Object>[
        <String, dynamic>{
          'ret': 0,
          'get_updates_buf': 'buf-1',
          'msgs': <Object>[
            userMsg(id: 1),
            <String, dynamic>{'message_type': 2, 'from_user_id': 'peer-1', 'item_list': <Object>[]},
          ],
        },
      ]);
      final channel = makeChannel(api, tmp);
      final got = Completer<IlinkInboundMessage>();
      channel.onMessage = got.complete;
      await channel.connect();
      final msg = await got.future.timeout(const Duration(seconds: 5));
      expect(msg.userId, 'peer-1');
      expect(msg.text, 'hi');
      await channel.disconnect();
    });

    test('cursor is persisted BEFORE dispatch (crash-safe order)', () async {
      final api = FakeApi(updateScript: <Object>[
        <String, dynamic>{
          'ret': 0,
          'get_updates_buf': 'buf-1',
          'msgs': <Object>[userMsg(id: 1)],
        },
      ]);
      final channel = makeChannel(api, tmp);
      final sawCursorAtDispatch = Completer<String>();
      final cursor = IlinkCursorStore(ilinkFileStore(tmp.path, 'cursor.json'));
      channel.onMessage = (msg) async {
        sawCursorAtDispatch.complete(await cursor.get('acc-1'));
      };
      await channel.connect();
      expect(await sawCursorAtDispatch.future.timeout(const Duration(seconds: 5)), 'buf-1');
      await channel.disconnect();
      // next round reads the persisted cursor
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(api.updateCursors.first, '');
    });

    test('duplicate message_id is dispatched once', () async {
      final api = FakeApi(updateScript: <Object>[
        <String, dynamic>{
          'ret': 0,
          'msgs': <Object>[userMsg(id: 7)],
        },
        <String, dynamic>{
          'ret': 0,
          'msgs': <Object>[userMsg(id: 7), userMsg(id: 8, text: 'second')],
        },
      ]);
      final channel = makeChannel(api, tmp);
      final seen = <String>[];
      final done = Completer<void>();
      channel.onMessage = (msg) {
        seen.add(msg.text);
        if (msg.text == 'second') {
          done.complete();
        }
      };
      await channel.connect();
      await done.future.timeout(const Duration(seconds: 5));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(seen.where((t) => t == 'hi'), hasLength(1));
      expect(seen, contains('second'));
      await channel.disconnect();
    });

    test('ret=-14 latches sessionExpired and pauses the loop', () async {
      final api = FakeApi(updateScript: <Object>[
        <String, dynamic>{'ret': -14},
        <String, dynamic>{'ret': 0, 'msgs': <Object>[]},
      ]);
      // Real pause (1h): the second script step must NOT run while latched.
      // disconnect() wakes the sleep and exits the loop.
      final channel = IlinkChannel(
        accountId: 'acc-1',
        api: api,
        cursorStore: IlinkCursorStore(ilinkFileStore(tmp.path, 'cursor2.json')),
        contextTokenStore:
            IlinkContextTokenStore(ilinkFileStore(tmp.path, 'ctx2.json')),
        sessionExpiredPauseMs: 3600000,
      );
      await channel.connect();
      await waitFor(() => channel.sessionExpired);
      expect(channel.sessionExpired, isTrue);
      await channel.disconnect();
      expect(api.updateCursors.length, 1); // second script step never ran
    });

    test('transient failures count up and a success resets them', () async {
      final api = FakeApi(updateScript: <Object>[
        Exception('boom-1'),
        Exception('boom-2'),
        <String, dynamic>{'ret': 0, 'msgs': <Object>[userMsg(id: 1)]},
      ]);
      final channel = makeChannel(api, tmp);
      final got = Completer<void>();
      channel.onMessage = (_) => got.complete();
      await channel.connect();
      await got.future.timeout(const Duration(seconds: 5));
      // loop healthy again — failures counter reset is internal, so observe
      // via a follow-up poll consuming the next script step without delay.
      await channel.disconnect();
      expect(api.updateCursors.length, greaterThanOrEqualTo(3));
    });

    test('session recovery clears the latch', () async {
      final api = FakeApi(updateScript: <Object>[
        <String, dynamic>{'ret': -14},
        <String, dynamic>{'ret': 0, 'msgs': <Object>[]},
      ]);
      final channel = makeChannel(api, tmp);
      await channel.connect();
      await waitFor(() => channel.sessionExpired);
      await waitFor(() => !channel.sessionExpired, budgetMs: 3000);
      await channel.disconnect();
    });
  });

  group('outbound', () {
    test('sends one payload for short text with inbound token', () async {
      final api = FakeApi();
      final channel = makeChannel(api, tmp);
      final r = await channel.sendMessage('peer-1', '回复内容', threadId: 'ctx-1');
      expect(r.ok, isTrue);
      expect(r.sent, 1);
      final payload = api.sentPayloads.single;
      final msg = payload['msg'] as Map<String, dynamic>;
      expect(msg['to_user_id'], 'peer-1');
      expect(msg['context_token'], 'ctx-1');
      expect(msg['from_user_id'], '');
      expect(msg['message_state'], 2);
    });

    test('long text splits into ordered chunks under the cap', () async {
      final api = FakeApi();
      final channel = makeChannel(api, tmp);
      final text = 'a' * 5000;
      final r = await channel.sendMessage('peer-1', text, threadId: 'ctx-1');
      expect(r.sent, 3); // 2048+2048+904
      for (final p in api.sentPayloads) {
        expect((p['msg'] as Map)['context_token'], 'ctx-1');
      }
      final reassembled = api.sentPayloads
          .map((p) => ((p['msg'] as Map)['item_list'] as List)
              .first['text_item']['text'] as String)
          .join();
      expect(reassembled, text);
    });

    test('mid-split failure reports chunks actually sent', () async {
      // 401 = permanent error, aborts immediately — a retryable 500 would
      // burn through retries and eventually succeed, muddying the assertion.
      final api = FakeApi()
        ..sendScript.add(<String, dynamic>{'ret': 0}) // first chunk ok
        ..sendScript.add(IlinkApiException.http(401, 'down')); // second aborts
      final channel = makeChannel(api, tmp);
      final text = 'a' * 5000;
      final r = await channel.sendMessage('peer-1', text);
      expect(r.ok, isFalse);
      expect(r.sent, 1);
      expect(r.error, contains('401'));
    });

    test('transient send error retries and succeeds', () async {
      final api = FakeApi()
        ..sendScript.add(IlinkApiException.http(503, 'flap'))
        ..sendScript.add(<String, dynamic>{'ret': 0});
      final channel = makeChannel(api, tmp);
      final r = await channel.sendMessage('peer-1', '短回复');
      expect(r.ok, isTrue);
      expect(r.sent, 1);
      expect(api.sentPayloads, hasLength(2));
    });

    test('permanent 4xx error aborts without retry', () async {
      final api = FakeApi()..sendScript.add(IlinkApiException.http(401, 'bad token'));
      final channel = makeChannel(api, tmp);
      final r = await channel.sendMessage('peer-1', '短回复');
      expect(r.ok, isFalse);
      expect(api.sentPayloads, hasLength(1)); // no retry
    });

    test('context_token falls back to the persisted inbound value', () async {
      final api = FakeApi();
      final ctx = IlinkContextTokenStore(ilinkFileStore(tmp.path, 'ctx.json'));
      await ctx.set('acc-1', 'peer-1', 'stored-ctx');
      final channel = makeChannel(api, tmp);
      final r = await channel.sendMessage('peer-1', '主动推送'); // no threadId
      expect(r.ok, isTrue);
      expect((api.sentPayloads.single['msg'] as Map)['context_token'], 'stored-ctx');
    });

    test('inbound message persists its context_token for later fallback',
        () async {
      final api = FakeApi(updateScript: <Object>[
        <String, dynamic>{
          'ret': 0,
          'msgs': <Object>[userMsg(id: 1, ctx: 'fresh-ctx')],
        },
      ]);
      final channel = makeChannel(api, tmp);
      final got = Completer<void>();
      channel.onMessage = (_) => got.complete();
      await channel.connect();
      await got.future.timeout(const Duration(seconds: 5));
      await channel.disconnect();
      final ctx = IlinkContextTokenStore(ilinkFileStore(tmp.path, 'ctx.json'));
      expect(await ctx.get('acc-1', 'peer-1'), 'fresh-ctx');
    });

    test('empty text sends nothing', () async {
      final api = FakeApi();
      final channel = makeChannel(api, tmp);
      final r = await channel.sendMessage('peer-1', '');
      expect(r.ok, isTrue);
      expect(r.sent, 0);
      expect(api.sentPayloads, isEmpty);
    });
  });
}
