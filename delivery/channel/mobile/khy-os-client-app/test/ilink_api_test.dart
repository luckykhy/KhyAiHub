// Wire-level checks for IlinkApi: the auth triple, endpoint paths, the
// untrusted-baseurl fallback and structured exceptions. Extra to the four
// acceptance files — the auth triple is the kind of contract that silently
// rots, so it gets its own pins.

import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:khy_os_client/core/ilink/ilink_api.dart';
import 'package:khy_os_client/core/ilink/ilink_protocol.dart';
import 'package:khy_os_client/core/ilink/ilink_send_policy.dart';

void main() {
  group('IlinkApi auth triple (ilinkApi.js:8-11, 47-54)', () {
    test('Bearer + AuthorizationType + X-WECHAT-UIN on every request', () async {
      final seen = <http.Request>[];
      final client = MockClient((req) async {
        seen.add(req);
        return http.Response(jsonEncode(<String, dynamic>{'ret': 0}), 200);
      });
      final api = IlinkApi(botToken: 'tok-abc', client: client);
      await api.sendMessage(<String, dynamic>{'msg': <String, dynamic>{}});
      expect(seen, hasLength(1));
      expect(seen.single.url.toString(), endsWith('/ilink/bot/sendmessage'));
      expect(seen.single.headers['Authorization'], 'Bearer tok-abc');
      expect(seen.single.headers['AuthorizationType'], 'ilink_bot_token');
      final uin = seen.single.headers['X-WECHAT-UIN']!;
      expect(uin, isNotEmpty);
      // 4 random bytes → base64 length 8 with one '=' pad (or 7 without, but
      // always decodable to 4 bytes)
      expect(base64Decode(uin), hasLength(4));
    });

    test('UIN is stable for the instance lifetime, differs across instances', () async {
      final seen = <http.Request>[];
      final client = MockClient((req) async {
        seen.add(req);
        return http.Response('{}', 200);
      });
      final api = IlinkApi(botToken: 't', client: client, rng: RandomStub(7));
      await api.getUpdates(null);
      await api.getUpdates('cur');
      expect(seen[0].headers['X-WECHAT-UIN'], seen[1].headers['X-WECHAT-UIN']);

      final other = IlinkApi(botToken: 't', client: client, rng: RandomStub(8));
      await other.getUpdates(null);
      expect(other.uin, isNot(api.uin));
    });

    test('getupdates body carries the cursor when present, empty object otherwise', () async {
      final bodies = <String>[];
      final client = MockClient((req) async {
        bodies.add(req.body);
        return http.Response('{}', 200);
      });
      final api = IlinkApi(botToken: 't', client: client);
      await api.getUpdates(null);
      await api.getUpdates('cur-1');
      expect(bodies[0], '{}');
      expect(jsonDecode(bodies[1]), <String, dynamic>{'get_updates_buf': 'cur-1'});
    });
  });

  group('IlinkApi baseurl trust fallback (ilinkApi.js:39-43)', () {
    test('untrusted candidate falls back to the default endpoint and flags it',
        () async {
      final urls = <Uri>[];
      final client = MockClient((req) async {
        urls.add(req.url);
        return http.Response('{}', 200);
      });
      final api = IlinkApi(
        botToken: 't',
        baseUrl: 'http://evil.example.com',
        client: client,
      );
      await api.getUpdates(null);
      expect(api.baseUrlFellBack, isTrue);
      expect(urls.single.toString(), startsWith('$kIlinkBaseUrl/ilink/bot/'));
    });

    test('trusted candidate is used as-is (trailing slashes stripped)', () async {
      final urls = <Uri>[];
      final client = MockClient((req) async {
        urls.add(req.url);
        return http.Response('{}', 200);
      });
      final api = IlinkApi(
        botToken: 't',
        baseUrl: 'https://ilinkai.weixin.qq.com/',
        client: client,
      );
      await api.getUpdates(null);
      expect(api.baseUrlFellBack, isFalse);
      expect(urls.single.toString(),
          'https://ilinkai.weixin.qq.com/ilink/bot/getupdates');
    });
  });

  group('IlinkApi structured errors (ilinkApi.js:63-92)', () {
    test('non-2xx throws with status and clipped body', () async {
      final client = MockClient((req) async {
        return http.Response('boom', 503);
      });
      final api = IlinkApi(botToken: 't', client: client);
      await expectLater(
        api.getUpdates(null),
        throwsA(isA<IlinkApiException>()
            .having((e) => e.status, 'status', 503)
            .having((e) => e.message, 'message', contains('boom'))),
      );
    });

    test('2xx returns the decoded JSON map', () async {
      final client = MockClient((req) async {
        return http.Response(
            jsonEncode(<String, dynamic>{'ret': 0, 'msgs': <Object>[]}), 200);
      });
      final api = IlinkApi(botToken: 't', client: client);
      final resp = await api.getUpdates(null);
      expect(resp['ret'], 0);
    });

    test('getConfig and sendTyping hit their endpoints with typed bodies', () async {
      final seen = <http.Request>[];
      final client = MockClient((req) async {
        seen.add(req);
        return http.Response('{}', 200);
      });
      final api = IlinkApi(botToken: 't', client: client);
      await api.getConfig('peer-1', 'ctx-9');
      await api.sendTyping('peer-1', 'ticket-1', 1);
      expect(seen[0].url.path, endsWith('/ilink/bot/getconfig'));
      expect(jsonDecode(seen[0].body),
          <String, dynamic>{'ilink_user_id': 'peer-1', 'context_token': 'ctx-9'});
      expect(seen[1].url.path, endsWith('/ilink/bot/sendtyping'));
      expect(jsonDecode(seen[1].body), <String, dynamic>{
        'ilink_user_id': 'peer-1',
        'typing_ticket': 'ticket-1',
        'status': 1,
      });
    });
  });
}

/// Deterministic RNG so UIN assertions hold without flakes.
class RandomStub implements Random {
  RandomStub(int seed) : _state = seed;
  int _state;

  @override
  int nextInt(int max) {
    _state = (_state * 1103515245 + 12345) & 0x7fffffff;
    return _state % max;
  }

  @override
  bool nextBool() => nextInt(2) == 0;

  @override
  double nextDouble() => nextInt(1000000) / 1000000.0;
}
