import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_api.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_models.dart';

/// Wire-level pins for AmooMirrorApi: bare-array vs envelope, URL shape,
/// the Bearer header, the four contract error codes, and the transport /
/// timeout / bad-JSON boundaries. The URL assertions double as the read-only
/// guard — a write verb appearing here would be a discipline violation.
///
/// Why the jsonOk helper instead of `http.Response(jsonEncode(...), 200)`:
/// package:http falls back to latin1 when no content-type is given
/// (http-1.6.0 lib/src/utils.dart:31-44), and latin1 cannot encode Chinese —
/// the constructor throws "Invalid argument (string)". Real servers send
/// application/json, so the helper mirrors that.
void main() {
  http.Response jsonOk(Object? body, int status,
      {Map<String, String>? headers}) {
    return http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      status,
      headers: <String, String>{
        'content-type': 'application/json; charset=utf-8',
        ...?headers,
      },
    );
  }

  AmooMirrorApi apiWith(
    http.Client client, {
    String token = 'mirror-device-token-0001',
    Duration? timeout,
    String baseUrl = 'http://127.0.0.1:8931',
  }) {
    return AmooMirrorApi(
      client: client,
      baseUrl: baseUrl,
      tokenProvider: () async => token,
      requestTimeout: timeout ?? const Duration(seconds: 10),
    );
  }

  group('fetchSessions', () {
    test('裸数组解析 + URL 逐字符对齐 + since=0&limit=50', () async {
      final seen = <http.Request>[];
      final client = MockClient((req) async {
        seen.add(req);
        return jsonOk(<dynamic>[
          <String, dynamic>{
            'id': 's-amoo-001',
            'title': '帮我修 bug',
            'updatedAt': 1730000000000,
            'lastPreview': '最后一句话',
            'messageCount': 4,
            'agentKey': 'amoo',
            'compacted': false,
          },
        ], 200);
      });
      final page = await apiWith(client).fetchSessions();
      expect(seen.single.url.toString(),
          'http://127.0.0.1:8931/sessions?since=0&limit=50');
      expect(seen.single.method, 'GET');
      expect(page.sessions, hasLength(1));
      expect(page.sessions.single.id, 's-amoo-001');
      expect(page.sessions.single.agentKey, 'amoo');
      expect(page.hasMore, isFalse);
    });

    test('只发 GET——任何写动词都是只读违纪', () async {
      final methods = <String>[];
      final client = MockClient((req) async {
        methods.add(req.method);
        return jsonOk(
          req.url.path.endsWith('/messages')
              ? <String, dynamic>{
                  'items': <dynamic>[],
                  'nextCursor': '',
                  'hasMore': false,
                }
              : <dynamic>[],
          200,
        );
      });
      await apiWith(client).fetchSessions();
      await apiWith(client).fetchMessages('s-1');
      expect(methods, <String>['GET', 'GET']);
    });

    test('Bearer 头带上 device_token', () async {
      final headers = <String, String>{};
      final client = MockClient((req) async {
        headers.addAll(req.headers);
        return jsonOk(<dynamic>[], 200);
      });
      await apiWith(client, token: 'tok-42').fetchSessions();
      expect(headers['Authorization'], 'Bearer tok-42');
    });

    test('token 为空时不发 Authorization 头（不伪造 Bearer 空串）', () async {
      final headers = <String, String>{};
      final client = MockClient((req) async {
        headers.addAll(req.headers);
        return jsonOk(<dynamic>[], 200);
      });
      await apiWith(client, token: '').fetchSessions();
      expect(headers.containsKey('Authorization'), isFalse);
    });

    test('满页 → hasMore=true（客户端推断）', () async {
      final client = MockClient((req) async => jsonOk(<dynamic>[
            for (var i = 0; i < 50; i++)
              <String, dynamic>{
                'id': 's-$i',
                'title': 't$i',
                'updatedAt': 1000 + i,
              },
          ], 200));
      final page = await apiWith(client).fetchSessions();
      expect(page.sessions, hasLength(50));
      expect(page.hasMore, isTrue);
    });

    test('未知顶层字段与脏行不判坏：忽略字段、丢掉坏行', () async {
      final client = MockClient((req) async => jsonOk(<dynamic>[
            <String, dynamic>{'id': 'ok', 'title': 't', 'updatedAt': 1},
            <String, dynamic>{'title': '没有 id', 'updatedAt': 2},
            <String, dynamic>{'id': '', 'title': '空 id', 'updatedAt': 3},
          ], 200));
      final page = await apiWith(client).fetchSessions();
      expect(page.sessions.map((s) => s.id), <String>['ok']);
    });

    test('顶层不是数组 → badResponse', () async {
      final client = MockClient((req) async =>
          jsonOk(<String, dynamic>{'items': <dynamic>[]}, 200));
      await expectLater(
        apiWith(client).fetchSessions(),
        throwsA(isA<AmooMirrorApiException>()
            .having((e) => e.kind, 'kind', AmooMirrorErrorKind.badResponse)),
      );
    });
  });

  group('fetchMessages', () {
    Object? envelope({
      String nextCursor = '1730000040000:m-002',
      bool hasMore = false,
    }) {
      return <String, dynamic>{
        'items': <dynamic>[
          <String, dynamic>{
            'id': 'm-003',
            'parentId': 'm-002',
            'timestamp': 1730000050000,
            'role': 'assistant',
            'blocks': <dynamic>[
              <String, dynamic>{'type': 'text', 'text': '好的'},
              <String, dynamic>{
                'type': 'tool',
                'name': 'read_file',
                'summary': '读取 lib/main.dart',
                'truncated': true,
              },
            ],
          },
        ],
        'nextCursor': nextCursor,
        'hasMore': hasMore,
      };
    }

    test('信封解析 + URL 逐字符对齐（cursor 与 limit 都在 query）', () async {
      final seen = <http.Request>[];
      final client = MockClient((req) async {
        seen.add(req);
        return jsonOk(envelope(), 200);
      });
      final page = await apiWith(client).fetchMessages(
        's-amoo-001',
        cursor: const AmooMirrorCursor(1730000040000, 'm-002'),
      );
      expect(seen.single.url.toString(),
          'http://127.0.0.1:8931/sessions/s-amoo-001/messages?limit=200&cursor=1730000040000%3Am-002');
      expect(page.items, hasLength(1));
      expect(page.items.single.id, 'm-003');
      expect(page.items.single.sessionId, 's-amoo-001');
      expect(page.items.single.blocks, hasLength(2));
      expect(page.nextCursor.toString(), '1730000040000:m-002');
      expect(page.hasMore, isFalse);
    });

    test('cursor 为 null 时不带 cursor 参数', () async {
      final seen = <http.Request>[];
      final client = MockClient((req) async {
        seen.add(req);
        return jsonOk(envelope(), 200);
      });
      await apiWith(client).fetchMessages('s-amoo-001');
      expect(seen.single.url.toString(),
          'http://127.0.0.1:8931/sessions/s-amoo-001/messages?limit=200');
    });

    test('nextCursor 空串 → null（追平）', () async {
      final client = MockClient((req) async =>
          jsonOk(envelope(nextCursor: ''), 200));
      final page = await apiWith(client).fetchMessages('s-amoo-001');
      expect(page.nextCursor, isNull);
    });

    test('hasMore=true 且 nextCursor 非空时照样给游标', () async {
      final client = MockClient(
          (req) async => jsonOk(envelope(hasMore: true), 200));
      final page = await apiWith(client).fetchMessages('s-amoo-001');
      expect(page.hasMore, isTrue);
      expect(page.nextCursor, isNotNull);
    });

    test('sessionId 需要 URL 编码时逐字符编码', () async {
      final seen = <http.Request>[];
      final client = MockClient((req) async {
        seen.add(req);
        return jsonOk(envelope(), 200);
      });
      await apiWith(client).fetchMessages('s a/b');
      expect(seen.single.url.path, '/sessions/s%20a%2Fb/messages');
    });

    test('坏行（缺 id / role 不可解析）丢弃，好行保留', () async {
      final client = MockClient((req) async => jsonOk(<String, dynamic>{
            'items': <dynamic>[
              <String, dynamic>{
                'timestamp': 1,
                'role': 'user',
                'blocks': <dynamic>[]
              },
              <String, dynamic>{
                'id': 'm-9',
                'timestamp': 2,
                'role': 'system',
                'blocks': <dynamic>[]
              },
              <String, dynamic>{
                'id': 'm-ok',
                'timestamp': 3,
                'role': 'user',
                'blocks': <dynamic>[]
              },
            ],
            'nextCursor': '',
            'hasMore': false,
          }, 200));
      final page = await apiWith(client).fetchMessages('s-1');
      expect(page.items.map((m) => m.id), <String>['m-ok']);
    });

    test('缺 items / 缺 hasMore → badResponse（不允许静默停止翻页）', () async {
      final noItems = MockClient((req) async => jsonOk(
          <String, dynamic>{'nextCursor': '', 'hasMore': false}, 200));
      await expectLater(
        apiWith(noItems).fetchMessages('s-1'),
        throwsA(isA<AmooMirrorApiException>()
            .having((e) => e.kind, 'kind', AmooMirrorErrorKind.badResponse)),
      );

      final noHasMore = MockClient((req) async => jsonOk(<String, dynamic>{
            'items': <dynamic>[],
            'nextCursor': '',
          }, 200));
      await expectLater(
        apiWith(noHasMore).fetchMessages('s-1'),
        throwsA(isA<AmooMirrorApiException>()
            .having((e) => e.kind, 'kind', AmooMirrorErrorKind.badResponse)),
      );
    });

    test('顶层不是对象 → badResponse', () async {
      final client = MockClient((req) async => jsonOk(<dynamic>[], 200));
      await expectLater(
        apiWith(client).fetchMessages('s-1'),
        throwsA(isA<AmooMirrorApiException>()
            .having((e) => e.kind, 'kind', AmooMirrorErrorKind.badResponse)),
      );
    });
  });

  group('错误码', () {
    Future<AmooMirrorApiException> catchOf(http.Client client) async {
      try {
        await apiWith(client).fetchSessions();
        fail('应当抛出 AmooMirrorApiException');
      } on AmooMirrorApiException catch (e) {
        return e;
      }
    }

    test('401/404/409/429 各自映射，Retry-After 原样带出', () async {
      for (final entry in <int, AmooMirrorErrorKind>{
        401: AmooMirrorErrorKind.unauthorized,
        404: AmooMirrorErrorKind.notFound,
        409: AmooMirrorErrorKind.cursorStale,
        429: AmooMirrorErrorKind.rateLimited,
      }.entries) {
        final client = MockClient((req) async => http.Response(
              'boom',
              entry.key,
              headers: <String, String>{'retry-after': '120'},
            ));
        final e = await catchOf(client);
        expect(e.kind, entry.value);
        expect(e.status, entry.key);
        expect(e.retryAfter, '120');
      }
    });

    test('5xx → server；其他 4xx → badResponse', () async {
      final server = MockClient((req) async => http.Response('x', 503));
      expect((await catchOf(server)).kind, AmooMirrorErrorKind.server);
      final other = MockClient((req) async => http.Response('x', 400));
      expect((await catchOf(other)).kind, AmooMirrorErrorKind.badResponse);
    });

    test('detail 只进日志不进用户文案：截断且不超长', () async {
      final client = MockClient((req) async => http.Response('z' * 5000, 500));
      final e = await catchOf(client);
      expect(e.detail.length, lessThanOrEqualTo(201));
    });
  });

  group('transport / timeout / 坏 JSON', () {
    test('SocketException → transport（无状态码）', () async {
      final client = MockClient((req) async =>
          throw const SocketException('connection refused'));
      try {
        await apiWith(client).fetchSessions();
        fail('应当抛出');
      } on AmooMirrorApiException catch (e) {
        expect(e.kind, AmooMirrorErrorKind.transport);
        expect(e.status, isNull);
      }
    });

    test('超时 → timeout，注入短 Duration 不真睡 10s', () async {
      final client = MockClient((req) async {
        await Future<void>.delayed(const Duration(milliseconds: 300));
        return jsonOk(<dynamic>[], 200);
      });
      try {
        await apiWith(client, timeout: const Duration(milliseconds: 50))
            .fetchSessions();
        fail('应当抛出');
      } on AmooMirrorApiException catch (e) {
        expect(e.kind, AmooMirrorErrorKind.timeout);
        expect(e.status, isNull);
      }
    });

    test('2xx 但 JSON 畸形 → badResponse 而不是 transport', () async {
      final client =
          MockClient((req) async => http.Response('{not json', 200));
      try {
        await apiWith(client).fetchSessions();
        fail('应当抛出');
      } on AmooMirrorApiException catch (e) {
        expect(e.kind, AmooMirrorErrorKind.badResponse);
      }
    });
  });

  group('close 纪律', () {
    test('注入的 client 不被关闭（归调用方所有）', () async {
      var closed = false;
      final client = _CloseSpyClient(() => closed = true);
      final api = AmooMirrorApi(
        client: client,
        baseUrl: 'http://127.0.0.1:8931',
        tokenProvider: () async => 't',
      );
      await api.close();
      expect(closed, isFalse);
    });
  });

  test('baseUrl 尾斜线被剥掉（不产生 //sessions）', () async {
    final seen = <http.Request>[];
    final client = MockClient((req) async {
      seen.add(req);
      return jsonOk(<dynamic>[], 200);
    });
    await apiWith(client, baseUrl: 'http://127.0.0.1:8931/').fetchSessions();
    expect(seen.single.url.toString(),
        'http://127.0.0.1:8931/sessions?since=0&limit=50');
  });
}

class _CloseSpyClient extends http.BaseClient {
  _CloseSpyClient(this.onClose);

  final void Function() onClose;

  @override
  void close() => onClose();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      throw UnimplementedError();
}
