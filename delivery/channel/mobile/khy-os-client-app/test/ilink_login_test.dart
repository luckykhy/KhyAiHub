// QR login state machine vectors, anchored to ilinkLogin.js:227-291 and the
// documented "pass the server's words through, never invent" contract.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:khy_os_client/core/ilink/ilink_login.dart';
import 'package:khy_os_client/core/ilink/ilink_stores.dart';

/// Account store stub: no platform channels in unit tests.
class FakeAccountStore implements IlinkAccountStore {
  IlinkAccount? saved;
  @override
  Future<void> clear() async {
    saved = null;
  }

  @override
  Future<IlinkAccount?> load() async => saved;

  @override
  Future<void> save(IlinkAccount account) async {
    saved = account;
  }
}

void main() {
  // http.Response(String) encodes as latin1 and THROWS on non-latin1 body
  // ("Contains invalid characters") — the wire is UTF-8, so every mock goes
  // through this helper.
  http.Response jsonResp(Map<String, dynamic> json, [int status = 200]) =>
      http.Response.bytes(utf8.encode(jsonEncode(json)), status,
          headers: <String, String>{
            'content-type': 'application/json; charset=utf-8',
          });

  group('accountFromConfirmed (ilinkLogin.js:107-120)', () {
    test('confirmed payload maps to the account blob', () {
      final a = accountFromConfirmed(<String, dynamic>{
        'bot_token': 'tok',
        'ilink_bot_id': 'bot-1',
        'ilink_user_id': 'me-1',
        'baseurl': 'https://ilinkai.weixin.qq.com',
      })!;
      expect(a.botToken, 'tok');
      expect(a.accountId, 'bot-1');
      expect(a.userId, 'me-1');
      expect(a.baseUrl, 'https://ilinkai.weixin.qq.com');
    });

    test('untrusted baseurl kept empty (api falls back to default)', () {
      final a = accountFromConfirmed(<String, dynamic>{
        'bot_token': 'tok',
        'ilink_bot_id': 'bot-1',
        'ilink_user_id': 'me-1',
        'baseurl': 'http://weixin.qq.com.evil.com',
      })!;
      expect(a.baseUrl, '');
    });

    test('missing any of the four required fields → null', () {
      expect(accountFromConfirmed(null), isNull);
      expect(accountFromConfirmed(<String, dynamic>{}), isNull);
      expect(accountFromConfirmed(<String, dynamic>{
        'ilink_bot_id': 'b',
        'ilink_user_id': 'u',
      }), isNull); // no bot_token
    });
  });

  group('requestQrCode (get_bot_qrcode?bot_type=3)', () {
    test('happy path returns id and url', () async {
      final client = MockClient((req) async {
        expect(req.url.toString(),
            contains('/ilink/bot/get_bot_qrcode?bot_type=3'));
        return jsonResp(<String, dynamic>{
          'ret': 0,
          'qrcode': 'qr-1',
          'qrcode_img_content': 'https://liteapp.weixin.qq.com/xyz',
        });
      });
      final r = await requestQrCode(client);
      expect(r.error, isNull);
      expect(r.qrcodeId, 'qr-1');
      expect(r.qrcodeUrl, 'https://liteapp.weixin.qq.com/xyz');
    });

    test('server failure passes ret/retmsg through verbatim', () async {
      final client = MockClient((req) async {
        return jsonResp(<String, dynamic>{'ret': -1, 'retmsg': '服务繁忙'});
      });
      final r = await requestQrCode(client);
      expect(r.error, '取二维码失败(ret=-1):服务繁忙');
    });
  });

  group('login state machine (ilinkLogin.js:227-291)', () {
    FakeAccountStore store = FakeAccountStore();

    setUp(() {
      store = FakeAccountStore();
    });

    MockClient scriptedClient(List<http.Response Function()> script) {
      var i = 0;
      return MockClient((req) async {
        if (i >= script.length) {
          // Script exhausted: hold the loop rather than loop forever.
          throw StateError('script exhausted at ${req.url}');
        }
        return script[i++]();
      });
    }

    test('wait → scaned → confirmed persists credentials and reports status',
        () async {
      final statuses = <String>[];
      final client = scriptedClient(<http.Response Function()>[
        () => jsonResp(<String, dynamic>{
              'ret': 0,
              'qrcode': 'qr-1',
              'qrcode_img_content': 'u1',
            }),
        () => jsonResp(<String, dynamic>{'status': 'wait'}),
        () => jsonResp(<String, dynamic>{'status': 'scaned'}),
        () => jsonResp(<String, dynamic>{
              'status': 'confirmed',
              'bot_token': 'tok',
              'ilink_bot_id': 'bot-1',
              'ilink_user_id': 'me-1',
              'baseurl': '',
            }),
      ]);
      final result = await login(
        client,
        accountStore: store,
        sleep: (_) async {},
        isCancelled: () => false,
        onStatus: statuses.add,
        pollIntervalMs: 1,
      );
      expect(result.ok, isTrue);
      expect(result.account!.accountId, 'bot-1');
      expect(result.isNew, isTrue);
      expect(store.saved, isNotNull);
      expect(statuses, contains('已扫码,请在手机上确认。'));
    });

    test('expired QR refreshes automatically (attempt 2 confirms)', () async {
      var qrFetches = 0;
      final client = MockClient((req) async {
        if (req.url.path.endsWith('get_bot_qrcode')) {
          qrFetches++;
          return jsonResp(<String, dynamic>{
            'ret': 0,
            'qrcode': 'qr-$qrFetches',
            'qrcode_img_content': 'u',
          });
        }
        // first code expires; second confirms
        if (qrFetches == 1) {
          return jsonResp(<String, dynamic>{'status': 'expired'});
        }
        return jsonResp(<String, dynamic>{
          'status': 'confirmed',
          'bot_token': 'tok',
          'ilink_bot_id': 'b',
          'ilink_user_id': 'u',
        });
      });
      final lines = <String>[];
      final result = await login(
        client,
        accountStore: store,
        sleep: (_) async {},
        isCancelled: () => false,
        onStatus: lines.add,
        pollIntervalMs: 1,
      );
      expect(result.ok, isTrue);
      expect(lines, contains('二维码已过期,正在换一张…'));
    });

    test('known failure status surfaces the server message verbatim', () async {
      final client = scriptedClient(<http.Response Function()>[
        () => jsonResp(<String, dynamic>{
              'ret': 0,
              'qrcode': 'qr-1',
              'qrcode_img_content': 'u',
            }),
        () => jsonResp(<String, dynamic>{
              'status': 'not_support',
              'retmsg': '当前微信版本不支持',
            }),
      ]);
      final result = await login(
        client,
        accountStore: store,
        sleep: (_) async {},
        isCancelled: () => false,
        pollIntervalMs: 1,
      );
      expect(result.ok, isFalse);
      expect(result.error, '扫码失败:当前微信版本不支持');
    });

    test('gives up after maxRefresh consecutive expirations', () async {
      var qrFetches = 0;
      final client = MockClient((req) async {
        if (req.url.path.endsWith('get_bot_qrcode')) {
          qrFetches++;
          return jsonResp(<String, dynamic>{
            'ret': 0,
            'qrcode': 'qr-$qrFetches',
            'qrcode_img_content': 'u',
          });
        }
        return jsonResp(<String, dynamic>{'status': 'expired'});
      });
      final result = await login(
        client,
        accountStore: store,
        sleep: (_) async {},
        isCancelled: () => false,
        pollIntervalMs: 1,
        maxRefresh: 3,
      );
      expect(result.ok, isFalse);
      expect(result.error, contains('3 次'));
      expect(qrFetches, 3);
    });

    test('cancellation between steps aborts with 已取消', () async {
      var cancelled = false;
      final client = scriptedClient(<http.Response Function()>[
        () => jsonResp(<String, dynamic>{
              'ret': 0,
              'qrcode': 'qr-1',
              'qrcode_img_content': 'u',
            }),
      ]);
      // flip cancel after the first poll so the inner while sees it
      final result = await login(
        client,
        accountStore: store,
        sleep: (_) async {
          cancelled = true;
        },
        isCancelled: () => cancelled,
        pollIntervalMs: 1,
      );
      expect(result.ok, isFalse);
      expect(result.error, '已取消');
    });

    test('confirmed but malformed payload fails honestly', () async {
      final client = scriptedClient(<http.Response Function()>[
        () => jsonResp(<String, dynamic>{
              'ret': 0,
              'qrcode': 'qr-1',
              'qrcode_img_content': 'u',
            }),
        () => jsonResp(<String, dynamic>{'status': 'confirmed'}),
      ]);
      final result = await login(
        client,
        accountStore: store,
        sleep: (_) async {},
        isCancelled: () => false,
        pollIntervalMs: 1,
      );
      expect(result.ok, isFalse);
      expect(result.error, '扫码已确认,但应答缺少必要字段');
    });
  });

  group('file-backed stores (cursor / ctx token / peers shapes)', () {
    late Directory tmp;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('ilink_store_test');
    });

    tearDown(() {
      tmp.deleteSync(recursive: true);
    });

    test('cursor set/get roundtrip and per-account isolation', () async {
      final store = IlinkCursorStore(ilinkFileStore(tmp.path, 'cursor.json'));
      await store.set('acc-1', 'buf-1');
      await store.set('acc-2', 'buf-2');
      expect(await store.get('acc-1'), 'buf-1');
      expect(await store.get('acc-2'), 'buf-2');
      await store.set('acc-1', '');
      expect(await store.get('acc-1'), '');
      expect(await store.get('acc-2'), 'buf-2');
    });

    test('context token nested map roundtrip', () async {
      final store = IlinkContextTokenStore(ilinkFileStore(tmp.path, 'ctx.json'));
      await store.set('acc-1', 'peer-1', 'tok-1');
      await store.set('acc-1', 'peer-2', 'tok-2');
      expect(await store.get('acc-1', 'peer-1'), 'tok-1');
      expect(await store.get('acc-1', 'peer-2'), 'tok-2');
      expect(await store.get('acc-2', 'peer-1'), '');
      await store.set('acc-1', 'peer-1', '');
      expect(await store.get('acc-1', 'peer-1'), '');
    });

    test('missing or corrupt file reads as empty (fail-soft)', () async {
      final store = IlinkCursorStore(ilinkFileStore(tmp.path, 'none.json'));
      expect(await store.get('acc-1'), '');
      final corrupt = File('${tmp.path}/ilink/broken.json');
      corrupt.parent.createSync(recursive: true);
      corrupt.writeAsStringSync('{not json', encoding: utf8);
      final broken = IlinkCursorStore(IlinkJsonFileStore(corrupt));
      expect(await broken.get('acc-1'), '');
    });
  });
}
