import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/endpoint_defaults.dart';
import 'package:khy_os_client/core/gateway/zen_errors.dart';
import 'package:khy_os_client/core/gateway/zen_gate.dart';

/// Zen 线上契约（不碰网络）。
///
/// 为什么用伪造 adapter 而不是真打上游：这套头与 body 门是上游认不认你的唯一
/// 依据，而任何一条缺失或拼错都不会在本地报错——只会在真机上变成 403。
/// 这里把每一处可以静默漂移的地方钉死。
class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this.respond);

  final ResponseBody Function(RequestOptions options) respond;

  RequestOptions? lastOptions;
  String lastBody = '';

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    lastOptions = options;
    if (requestStream != null) {
      final bytes = <int>[];
      await for (final chunk in requestStream) {
        bytes.addAll(chunk);
      }
      lastBody = utf8.decode(bytes);
    } else {
      lastBody = '';
    }
    return respond(options);
  }

  @override
  void close({bool force = false}) {}
}

class _FixedSeed implements ZenSeedSource {
  _FixedSeed(this.value);
  final String? value;

  @override
  Future<String?> seed() async => value;
}

class _MemStore implements ZenIdentityStore {
  String? value;

  @override
  Future<String?> read() async => value;

  @override
  Future<void> write(String v) async => value = v;
}

ResponseBody _ok(String sse) => ResponseBody.fromString(sse, 200, headers: {
      Headers.contentTypeHeader: ['text/event-stream'],
    });

ResponseBody _err(String body, int status) =>
    ResponseBody.fromString(body, status, headers: {
      Headers.contentTypeHeader: ['application/json'],
    });

const _sseOk = 'data: {"id":"chatcmpl-test","model":"mimo-v2.6-flash-free",'
    '"choices":[{"delta":{"content":"你好"}}]}\n\n'
    'data: [DONE]\n\n';

Dio _dioWith(_FakeAdapter adapter) {
  final dio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 5),
    receiveTimeout: const Duration(seconds: 5),
  ));
  dio.httpClientAdapter = adapter;
  return dio;
}

Map<String, String> _lower(Map<String, dynamic> headers) =>
    {for (final e in headers.entries) e.key.toLowerCase(): '${e.value}'};

void main() {
  setUp(() {
    ZenGate.resetForTest(
      store: _MemStore(),
      seedSource: _FixedSeed(List.filled(64, 'a').join()),
    );
  });

  test('七个指纹头齐全，且 session 与 x-session-id 同值', () async {
    final adapter = _FakeAdapter((_) => _ok(_sseOk));
    final dio = _dioWith(adapter);

    await ZenGate.postChatCompletion(
      dio: dio,
      baseUrl: kOpencodeZenBaseUrl,
      apiKey: 'public',
      body: {
        'model': 'mimo-v2.6-flash-free',
        'messages': [
          {'role': 'user', 'content': 'hi'},
        ],
      },
    );

    final h = _lower(adapter.lastOptions!.headers);
    expect(h['user-agent'], kZenUserAgent);
    expect(h['x-opencode-client'], 'cli');
    expect(h['authorization'], 'Bearer public');
    expect(h['content-type'], contains('application/json'));
    expect(h['x-opencode-session'], startsWith('ses_'));
    expect(h['x-session-id'], h['x-opencode-session']);
    expect(
        RegExp(r'^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$')
            .hasMatch(h['x-opencode-session']!),
        isTrue);
    // request id 每请求一条，形态 msg_ + 12 hex + 14 base62。
    expect(RegExp(r'^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$').hasMatch(h['x-opencode-request']!),
        isTrue);
    expect(
        RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-'
                r'[0-9a-f]{12}$')
            .hasMatch(h['x-opencode-project']!),
        isTrue);
  });

  test('无调用方工具：stream:true + bash/read + tool_choice:none', () async {
    final adapter = _FakeAdapter((_) => _ok(_sseOk));
    await ZenGate.postChatCompletion(
      dio: _dioWith(adapter),
      baseUrl: kOpencodeZenBaseUrl,
      apiKey: 'public',
      body: {
        'model': 'mimo-v2.6-flash-free',
        'messages': [
          {'role': 'user', 'content': 'hi'},
        ],
      },
    );

    final sent = jsonDecode(adapter.lastBody) as Map<String, dynamic>;
    expect(sent['stream'], isTrue);
    final names = (sent['tools'] as List)
        .map((t) => (t as Map)['function']?['name'])
        .toList();
    expect(names, containsAll(['bash', 'read']));
    expect(sent['tool_choice'], 'none');
  });

  test('带调用方工具：保留原工具并追加 bash/read，不设 tool_choice', () async {
    final adapter = _FakeAdapter((_) => _ok(_sseOk));
    await ZenGate.postChatCompletion(
      dio: _dioWith(adapter),
      baseUrl: kOpencodeZenBaseUrl,
      apiKey: 'public',
      body: {
        'model': 'mimo-v2.6-flash-free',
        'messages': [
          {'role': 'user', 'content': 'hi'},
        ],
        'tools': [
          {
            'type': 'function',
            'function': {
              'name': 'grep',
              'parameters': {'type': 'object'},
            },
          },
        ],
      },
    );

    final sent = jsonDecode(adapter.lastBody) as Map<String, dynamic>;
    final names = (sent['tools'] as List)
        .map((t) => (t as Map)['function']?['name'])
        .toList();
    expect(names, containsAll(['grep', 'bash', 'read']));
    expect(sent.containsKey('tool_choice'), isFalse);
  });

  test('非 Zen 端点不发指纹、不过 body 门', () async {
    final adapter = _FakeAdapter((_) => ResponseBody.fromString(
        '{"id":"x","choices":[{"message":{"role":"assistant","content":"ok"}}]}',
        200,
        headers: {
          Headers.contentTypeHeader: ['application/json'],
        }));
    final data = await ZenGate.postChatCompletion(
      dio: _dioWith(adapter),
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-user',
      body: {
        'model': 'claude-x',
        'messages': [
          {'role': 'user', 'content': 'hi'},
        ],
      },
    );

    final h = _lower(adapter.lastOptions!.headers);
    expect(h['authorization'], 'Bearer sk-user');
    expect(h.containsKey('x-opencode-session'), isFalse);
    final sent = jsonDecode(adapter.lastBody) as Map<String, dynamic>;
    expect(sent.containsKey('stream'), isFalse);
    expect(data['choices'][0]['message']['content'], 'ok');
  });

  group('错误体物化', () {
    test('403 的流式错误体被排干成字符串', () async {
      final adapter = _FakeAdapter((_) => _err(
          '{"error":{"message":"FreeTierError: free tier can only be used from within OpenCode"}}',
          403));
      DioException? caught;
      try {
        await ZenGate.postChatCompletion(
          dio: _dioWith(adapter),
          baseUrl: kOpencodeZenBaseUrl,
          apiKey: 'public',
          body: {
            'model': 'mimo-v2.6-flash-free',
            'messages': [
              {'role': 'user', 'content': 'hi'},
            ],
          },
        );
      } on DioException catch (e) {
        caught = e;
      }

      expect(caught, isNotNull, reason: '403 必须抛异常，不能吞掉');
      expect(caught!.response!.statusCode, 403);
      // 关键：不是 ResponseBody 实例，而是可读正文。
      expect(caught.response!.data, isA<String>());
      final body = caught.response!.data as String;
      expect(body, contains('FreeTierError'));
      // 分类因此能命中。
      expect(classify(caught.response!.statusCode, body).kind,
          ZenErrorKind.freeTier);
    });

    test('429 FreeUsageLimitError 同样可分类且不可重试', () async {
      final adapter = _FakeAdapter((_) => _err(
          '{"error":{"message":"FreeUsageLimitError: free usage limit reached"}}',
          429));
      DioException? caught;
      try {
        await ZenGate.postChatCompletion(
          dio: _dioWith(adapter),
          baseUrl: kOpencodeZenBaseUrl,
          apiKey: 'public',
          body: {
            'model': 'mimo-v2.6-flash-free',
            'messages': [
              {'role': 'user', 'content': 'hi'},
            ],
          },
        );
      } on DioException catch (e) {
        caught = e;
      }

      final verdict =
          classify(caught!.response!.statusCode, bodyFromData(caught.response!.data));
      expect(verdict.kind, ZenErrorKind.freeUsageLimit);
      expect(verdict.transient, isFalse);
    });
  });
}
