// khy-canary: Khy-20261102-VERIFY-REASONING
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/ai_gateway.dart';
import 'package:khy_os_client/core/gateway/khyos_api.dart';
import 'package:khy_os_client/core/gateway/provider_adapter.dart';
import 'package:khy_os_client/core/services/conversation_db.dart';
import 'package:khy_os_client/data/models/models.dart' hide Conversation;

/// 独立复核用的思维链数据链路测试（与 reasoning_data_path_test.dart 各自成篇）。
///
/// 判据只有三条，逐条可机械验证：
///   1. 含 thinking/reasoning chunk 的流序列 → 累加进 `reasoning` 字段；
///   2. `content` 里不含思维链文本（思维链绝不进正文）；
///   3. 旧会话（没有该字段 / 字段类型不对）反序列化不抛。
class _SeqAdapter implements ProviderAdapter {
  final List<ChatResponse> chunks;
  _SeqAdapter(this.chunks);

  @override
  String get id => 'seq';
  @override
  String get name => 'seq';
  @override
  bool get isAvailable => true;
  @override
  bool supports(List<Capability> capabilities) => true;
  @override
  Future<ChatResponse> chat(ChatRequest request) async => chunks.last;
  @override
  Future<Stream<ChatResponse>> streamChat(ChatRequest request) async =>
      Stream.fromIterable(chunks);
}

class _SseAdapter implements HttpClientAdapter {
  final String body;
  _SseAdapter(this.body);

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async =>
      ResponseBody.fromString(body, 200, headers: {
        Headers.contentTypeHeader: [Headers.textPlainContentType],
      });

  @override
  void close({bool force = false}) {}
}

Dio _dio(String sse) {
  final dio = Dio();
  dio.httpClientAdapter = _SseAdapter(sse);
  return dio;
}

ChatMessage _seed() => ChatMessage(
      id: 'v1',
      conversationId: 'vc1',
      role: MessageRole.assistant,
      content: '',
      timestamp: DateTime.utc(2026, 11, 2, 12),
    );

// 思维链标记串：刻意与正文用完全不同的字，方便「content 不含思维链」的断言。
const _r1 = '内部推理甲';
const _r2 = '内部推理乙';
const _c1 = '可见正文一';
const _c2 = '可见正文二';

void main() {
  group('判据 1+2：流序列累加进 reasoning，content 不含思维链', () {
    test('网关折叠：reasoning/content 交错也各自累加', () async {
      final gateway = AIGateway();
      gateway.registerProvider('seq', _SeqAdapter([
        const ChatResponse(id: 'x', content: '', reasoning: _r1),
        const ChatResponse(id: 'x', content: _c1),
        const ChatResponse(id: 'x', content: '', reasoning: _r2),
        const ChatResponse(id: 'x', content: _c2, done: true),
      ]));

      final out = await gateway
          .streamChatMessage(const ChatRequest(messages: []), seed: _seed())
          .toList();

      final last = out.last;
      expect(last.reasoning, '$_r1$_r2');
      expect(last.content, '$_c1$_c2');
      expect(last.content.contains(_r1), false);
      expect(last.content.contains(_r2), false);
      // 快照语义：中间态也是累计值，不是 delta。
      expect(out.map((e) => e.content).toList(), ['', _c1, _c1, '$_c1$_c2']);
      expect(out.map((e) => e.reasoning).toList(),
          [_r1, _r1, '$_r1$_r2', '$_r1$_r2']);
    });

    test('真 wire 解析：OpenAI 兼容 SSE 的 reasoning_content 分到独立字段', () async {
      const sse = 'data: {"id":"1","choices":[{"delta":{"reasoning_content":"$_r1"}}]}\n'
          'data: {"id":"1","choices":[{"delta":{"content":"$_c1"}}]}\n'
          'data: {"id":"1","choices":[{"delta":{"reasoning_content":"$_r2"}}]}\n'
          'data: {"id":"1","choices":[{"delta":{"content":"$_c2"},"finish_reason":"stop"}]}\n'
          'data: [DONE]\n';
      final adapter = OpenAIAdapter(
        id: 'o',
        name: 'o',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'placeholder-not-a-real-key',
        model: 'm',
        dio: _dio(sse),
      );

      final chunks =
          await (await adapter.streamChat(const ChatRequest(messages: [])))
              .toList();

      final reasoning = chunks
          .where((c) => c.reasoning != null)
          .map((c) => c.reasoning!)
          .join();
      final content = chunks.map((c) => c.content).join();
      expect(reasoning, '$_r1$_r2');
      expect(content, '$_c1$_c2');
      expect(content.contains(_r1), false);
      expect(content.contains(_r2), false);
    });

    test('真 wire 解析：Anthropic thinking_delta 分到独立字段且不抛', () async {
      const sse = 'data: {"type":"message_start","message":{"id":"m1"}}\n'
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n'
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"$_r1"}}\n'
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"$_r2"}}\n'
          'data: {"type":"content_block_stop","index":0}\n'
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n'
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"$_c1"}}\n'
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"$_c2"}}\n'
          'data: {"type":"message_stop"}\n';
      final adapter = AnthropicAdapter(
        id: 'a',
        name: 'a',
        apiKey: 'placeholder-not-a-real-key',
        dio: _dio(sse),
      );

      final chunks =
          await (await adapter.streamChat(const ChatRequest(messages: [])))
              .toList();

      expect(chunks.length, 9); // 九个事件一个不丢，一个不抛
      final reasoning = chunks
          .where((c) => c.reasoning != null)
          .map((c) => c.reasoning!)
          .join();
      expect(reasoning, '$_r1$_r2');
      expect(chunks.map((c) => c.content).join(), '$_c1$_c2');
      expect(chunks.map((c) => c.content).join().contains(_r1), false);
    });

    test('后端 SSE 折叠：thinking_content 累加，done 覆盖不重复', () async {
      final events = <Map<String, dynamic>>[
        {'type': 'start'},
        {'type': 'status', 'text': '连接中'},
        {'type': 'thinking_content', 'text': _r1},
        {'type': 'chunk', 'content': _c1},
        {'type': 'thinking_content', 'text': _r2},
        {'type': 'chunk', 'content': _c2},
        {'type': 'done', 'content': '$_c1$_c2'},
      ];

      final out =
          await KhyOsApi.foldEventStream(Stream.fromIterable(events), _seed())
              .toList();

      final last = out.last;
      expect(last.reasoning, '$_r1$_r2');
      // done 带全文 → 覆盖语义，不能把正文写两遍。
      expect(last.content, '$_c1$_c2');
      expect(last.content.contains(_r1), false);
      expect(last.content.contains(_r2), false);
    });

    test('deltaOf 与 reasoningOf 认同一套键名（别名键不能被折叠丢成空）', () {
      // 复核中发现的既有分歧：reasoningOf 认 text/reasoning/content 三个别名，
      // 而 deltaOf 原先只读 text。同一个 thinking_content 事件，一个认得出来、
      // 一个读成空串——正是这段代码注释里要防的那种无声失败。
      for (final key in const ['text', 'reasoning', 'content']) {
        final ev = {'type': 'thinking_content', key: _r1};
        expect(KhyOsStreamEvent.reasoningOf(ev), _r1, reason: 'reasoningOf/$key');
        expect(KhyOsStreamEvent.deltaOf(ev).reasoning, _r1, reason: 'deltaOf/$key');
      }
      // 正文键不能被思维链路径吃掉。
      expect(KhyOsStreamEvent.deltaOf({'type': 'chunk', 'content': _c1}).reasoning, '');
    });
  });

  group('判据 3：旧会话无该字段不抛', () {
    test('ChatMsg：缺键 / 错类型 / 空值都读得出来', () {
      final legacy = ChatMsg.fromJson({
        'role': 'assistant',
        'content': '以前说的话',
        'timestamp': '2026-10-01T00:00:00.000',
      });
      expect(legacy.content, '以前说的话');
      expect(legacy.reasoning, isNull);

      final broken = ChatMsg.fromJson({
        'role': 'assistant',
        'content': 'x',
        'timestamp': '2026-10-01T00:00:00.000',
        'reasoning': 12345,
      });
      expect(broken.reasoning, isNull);
    });

    test('Conversation 整包：老 JSON 反序列化不抛且 reasoning 为 null', () {
      final c = Conversation.fromJson({
        'id': 'c-old',
        'title': '老会话',
        'createdAt': '2026-09-01T00:00:00.000',
        'updatedAt': '2026-09-02T00:00:00.000',
        'messages': [
          {'role': 'user', 'content': '问', 'timestamp': '2026-09-01T00:00:00.000'},
          {
            'role': 'assistant',
            'content': '老回答',
            'timestamp': '2026-09-01T00:00:01.000'
          },
        ],
      });
      expect(c.messages.length, 2);
      expect(c.messages.last.content, '老回答');
      expect(c.messages.last.reasoning, isNull);
      expect(c.messages.first.reasoning, isNull);
    });

    test('ChatMessage：缺键 / 错类型都不抛', () {
      final legacy = ChatMessage.fromJson({
        'id': 'old',
        'conversationId': 'c',
        'role': 'assistant',
        'content': '以前说的话',
        'timestamp': '2026-10-01T00:00:00.000',
      });
      expect(legacy.reasoning, isNull);

      final broken = ChatMessage.fromJson({
        'id': 'old',
        'conversationId': 'c',
        'role': 'assistant',
        'content': 'x',
        'timestamp': '2026-10-01T00:00:00.000',
        'reasoning': 12345,
      });
      expect(broken.reasoning, isNull);
    });
  });
}
