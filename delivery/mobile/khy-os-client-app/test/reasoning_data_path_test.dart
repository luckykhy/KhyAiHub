import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/ai_gateway.dart';
import 'package:khy_os_client/core/gateway/khyos_api.dart';
import 'package:khy_os_client/core/gateway/provider_adapter.dart';
import 'package:khy_os_client/core/services/conversation_db.dart';
import 'package:khy_os_client/data/models/models.dart' hide Conversation;
// models.dart 里也有一个同名的 Conversation（ ProviderConfig 那套，无 messages
// 字段），加前缀只为把名字让给它——本文件要测的是带 ChatMsg 的那个。
import 'package:khy_os_client/core/services/conversation_db.dart' as conv;

/// 把一段 SSE 文本喂给 Dio，省掉真网络。
///
/// 只为测**解析**：chunk 的形状才是容易错的那一半，而连不上会立刻抛，藏不住。
/// 占位 key 是假的，不涉及任何真凭证。
class _FakeHttpAdapter implements HttpClientAdapter {
  final String body;

  _FakeHttpAdapter(this.body);

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

Dio _dioWith(String sse) {
  final dio = Dio();
  dio.httpClientAdapter = _FakeHttpAdapter(sse);
  return dio;
}

/// 思维链数据链路的测试。
///
/// 覆盖五段路：模型字段、Provider SSE 解析、网关折叠、后端 SSE 折叠、会话持久化。
/// 五段的共同红线只有一条——**思维链永远不进 content**。它一旦混进正文，就会被当
/// 回答渲染出来，还会随对话历史上传给下一轮请求，等于把"怎么想的"固化成"说过
/// 什么"，而且事后没有任何办法把它拆回去。所以每个用例都两头断言：reasoning
/// 收到了，content 里没有那串字。
///
/// 只测不依赖设备的那一半：不碰 FlutterSecureStorage、不碰真网络、不碰 MethodChannel。
class _StubAdapter implements ProviderAdapter {
  final List<ChatResponse> chunks;

  _StubAdapter(this.chunks);

  @override
  String get id => 'stub';

  @override
  String get name => 'stub';

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

ChatMessage _seed() => ChatMessage(
      id: 'a1',
      conversationId: 'c1',
      role: MessageRole.assistant,
      content: '',
      timestamp: DateTime.utc(2026, 11, 2, 9),
    );

void main() {
  group('ChatMessage.reasoning 序列化', () {
    test('进 JSON，出来还在', () {
      final m = _seed().copyWith(content: '答案', reasoning: '先想一步');
      final back = ChatMessage.fromJson(m.toJson());
      expect(back.reasoning, '先想一步');
      expect(back.content, '答案');
    });

    test('没有思维链时键在但值是 null，读出来也是 null', () {
      // 与 ChatMsg 不同：这个模型的 toJson 本来就把可选字段写成 null
      // （attachments/toolCalls/usage 全是），reasoning 照此办理，不特殊。
      final m = _seed().copyWith(content: '答案');
      expect(m.toJson()['reasoning'], isNull);
      expect(ChatMessage.fromJson(m.toJson()).reasoning, isNull);
    });

    test('老消息的 JSON（没有 reasoning 键）读得出来，且是 null', () {
      // 升级路径：不抛、不默认成空串、行为一字不变。
      final legacy = ChatMessage.fromJson({
        'id': 'old',
        'conversationId': 'c',
        'role': 'assistant',
        'content': '以前说的话',
        'timestamp': '2026-10-01T00:00:00.000',
      });
      expect(legacy.content, '以前说的话');
      expect(legacy.reasoning, isNull);
    });

    test('reasoning 是错类型时按 null 处理，不炸', () {
      // 这个值来自可能被手改的 JSON；`as String?` 遇到 int 会抛，而异常会
      // 一路打到界面上。
      final m = ChatMessage.fromJson({
        'id': 'old',
        'conversationId': 'c',
        'role': 'assistant',
        'content': 'x',
        'reasoning': 12345,
        'timestamp': '2026-10-01T00:00:00.000',
      });
      expect(m.reasoning, isNull);
    });

    test('只改 content 时 reasoning 不能丢', () {
      // 流式期间上层每个 chunk 都在 copyWith(content: ...)。这里丢了的话，
      // 思维链会在第一个正文字节到达时凭空消失。
      final m = _seed().copyWith(content: '', reasoning: '想了一半');
      final next = m.copyWith(content: '${m.content}答');
      expect(next.reasoning, '想了一半');
      expect(next.content, '答');
    });
  });

  group('ChatMsg 持久化', () {
    test('有思维链：进 JSON，出来还在', () {
      final msg = ChatMsg(role: 'assistant', content: '答案', reasoning: '先想一步');
      final back = ChatMsg.fromJson(msg.toJson());
      expect(back.reasoning, '先想一步');
    });

    test('没思维链：JSON 里没有这个键（不写噪声），读出来是 null', () {
      // 只在有值时写键。老对话因此不需要迁移，也不需要版本号——复刻
      // workspaceRoot 的先例。
      final msg = ChatMsg(role: 'assistant', content: '答案');
      expect(msg.toJson().containsKey('reasoning'), false);
      expect(ChatMsg.fromJson(msg.toJson()).reasoning, isNull);
    });

    test('老对话的 JSON（没有 reasoning 键）读得出来，且不抛', () {
      final legacy = ChatMsg.fromJson({
        'role': 'assistant',
        'content': '以前说的话',
        'timestamp': '2026-10-01T00:00:00.000',
      });
      expect(legacy.content, '以前说的话');
      expect(legacy.reasoning, isNull);
    });

    test('reasoning 是错类型时按 null 处理，不炸', () {
      final m = ChatMsg.fromJson({
        'role': 'assistant',
        'content': 'x',
        'reasoning': 12345,
      });
      expect(m.reasoning, isNull);
    });

    test('Conversation 整包往返带上思维链', () {
      final c = conv.Conversation(
        id: 'c1',
        messages: [
          ChatMsg(role: 'user', content: '问'),
          ChatMsg(role: 'assistant', content: '答', reasoning: '想'),
        ],
      );
      final back = conv.Conversation.fromJson(c.toJson());
      expect(back.messages.length, 2);
      expect(back.messages[1].reasoning, '想');
      expect(back.messages[0].reasoning, isNull);
    });
  });

  group('网关：ChatResponse 带思维链增量', () {
    test('reasoningTextOf 认三种键名，认不出返回 null', () {
      expect(reasoningTextOf({'reasoning_content': 'a'}), 'a');
      expect(reasoningTextOf({'reasoning': 'b'}), 'b');
      expect(reasoningTextOf({'thinking': 'c'}), 'c');
      // 空串折算成 null：空串会被上层理解成"有思维链但内容为空"，
      // 于是渲染出一个空块。
      expect(reasoningTextOf({'reasoning_content': ''}), isNull);
      expect(reasoningTextOf({'content': '正文'}), isNull);
    });
  });

  group('Provider SSE 解析', () {
    test('OpenAI 兼容流：reasoning_content 与 content 分开', () async {
      // DeepSeek / GLM / OpenRouter 的 wire 形状：思维链在 delta.reasoning_content，
      // 与 delta.content 同级。老写法只读 delta.content，于是上游明明发了、
      // 屏幕上什么都没有——没有一方会报错。
      const sse = 'data: {"id":"1","choices":[{"delta":{"reasoning_content":"先想"}}]}\n'
          'data: {"id":"1","choices":[{"delta":{"content":"答"}}]}\n'
          'data: {"id":"1","choices":[{"delta":{"reasoning_content":"再想"}}]}\n'
          'data: {"id":"1","choices":[{"delta":{"content":"案"},"finish_reason":"stop"}]}\n'
          'data: [DONE]\n';
      final adapter = OpenAIAdapter(
        id: 'o',
        name: 'o',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'placeholder-not-a-real-key',
        model: 'm',
        dio: _dioWith(sse),
      );

      final chunks =
          await (await adapter.streamChat(const ChatRequest(messages: []))).toList();

      expect(chunks.map((c) => c.reasoning).toList(), ['先想', null, '再想', null]);
      expect(chunks.map((c) => c.content).toList(), ['', '答', '', '案']);
      // 红线：思维链一个字都不能漏进正文。
      expect(chunks.map((c) => c.content).join(), '答案');
    });

    test('Anthropic 流：thinking_delta 进 reasoning，text_delta 进 content', () async {
      // 思维链在 Anthropic 协议里是另一种 block。老写法对每个
      // content_block_delta 都读 json['delta']['text']，而 thinking_delta 的
      // delta 里没有 text；message_start / content_block_start / message_stop
      // 连 delta 都没有——老写法在它们上面会抛。
      const sse = 'data: {"type":"message_start","message":{"id":"m1"}}\n'
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n'
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想"}}\n'
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"再想"}}\n'
          'data: {"type":"content_block_stop","index":0}\n'
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n'
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答"}}\n'
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"案"}}\n'
          'data: {"type":"message_stop"}\n';
      final adapter = AnthropicAdapter(
        id: 'a',
        name: 'a',
        apiKey: 'placeholder-not-a-real-key',
        dio: _dioWith(sse),
      );

      final chunks =
          await (await adapter.streamChat(const ChatRequest(messages: []))).toList();

      // 九个事件一个不少地过完，没有一个抛。老写法会在 message_start /
      // content_block_start / content_block_stop 这种没有 delta 的事件上抛，
      // 也会把 thinking_delta 的正文读成空。
      expect(chunks.length, 9);
      expect(chunks.where((c) => c.reasoning != null).map((c) => c.reasoning).toList(),
          ['先想', '再想']);
      expect(chunks.map((c) => c.content).join(), '答案');
      // 老写法 json['message?']['id'] 键名多个问号，永远取不到值，取到 null
      // 后再下标还会抛。
      expect(chunks.first.id, 'm1');
      expect(chunks.last.done, true);
    });

    test('Ollama 流：message.thinking 进 reasoning', () async {
      const sse = '{"message":{"thinking":"先想"},"done":false}\n'
          '{"message":{"content":"答"},"done":false}\n'
          '{"message":{"content":"案"},"done":true}\n';
      final adapter = OllamaAdapter(id: 'l', name: 'l', dio: _dioWith(sse));

      final chunks =
          await (await adapter.streamChat(const ChatRequest(messages: []))).toList();

      expect(chunks.map((c) => c.reasoning).toList(), ['先想', null, null]);
      expect(chunks.map((c) => c.content).join(), '答案');
    });
  });

  group('AIGateway.streamChatMessage：折叠进 reasoning，不碰 content', () {
    test('含 thinking 的 chunk 序列 → 累加进 reasoning，content 不含思维链', () async {
      final gateway = AIGateway();
      gateway.registerProvider('stub', _StubAdapter([
        const ChatResponse(id: '1', content: '', reasoning: '第一步，'),
        const ChatResponse(id: '1', content: '答', reasoning: '第二步。'),
        const ChatResponse(id: '1', content: '案', done: true),
      ]));

      final emissions =
          await gateway.streamChatMessage(const ChatRequest(messages: []), seed: _seed()).toList();

      expect(emissions.length, 3);
      // 每一步都是累计快照，不是 delta。
      expect(emissions.map((e) => e.reasoning).toList(), ['第一步，', '第一步，第二步。', '第一步，第二步。']);
      expect(emissions.map((e) => e.content).toList(), ['', '答', '答案']);
      // 红线：思维链一个字都不能漏进正文。
      for (final e in emissions) {
        expect(e.content.contains('第一步'), false);
        expect(e.content.contains('第二步'), false);
      }
      // 折叠只推进 content/reasoning，seed 的 id/时间戳不动。
      expect(emissions.last.id, 'a1');
      expect(emissions.last.timestamp, DateTime.utc(2026, 11, 2, 9));
    });

    test('上游一个思维链 chunk 都不给 → reasoning 是 null 而不是空串', () async {
      // UI 判的是「有没有思维链」。给空串会让它渲染一个空块，比不渲染更难解释。
      final gateway = AIGateway();
      gateway.registerProvider('stub', _StubAdapter([
        const ChatResponse(id: '1', content: '答'),
        const ChatResponse(id: '1', content: '案', done: true),
      ]));

      final emissions =
          await gateway.streamChatMessage(const ChatRequest(messages: []), seed: _seed()).toList();
      expect(emissions.last.content, '答案');
      expect(emissions.last.reasoning, isNull);
    });
  });

  group('KhyOsApi：后端 SSE 事件', () {
    test('reasoningOf 只认思维链事件', () {
      expect(KhyOsStreamEvent.reasoningOf({'type': 'thinking_content', 'text': '想'}), '想');
      expect(KhyOsStreamEvent.reasoningOf({'type': 'chunk', 'content': '正文'}), isNull);
      // 兼容 reasoning/content 两个别名键。
      expect(KhyOsStreamEvent.reasoningOf({'type': 'thinking_content', 'reasoning': 'r'}), 'r');
      expect(KhyOsStreamEvent.reasoningOf({'type': 'thinking_content', 'content': 'c'}), 'c');
      // 空 text 返回 null，不返回空串。
      expect(KhyOsStreamEvent.reasoningOf({'type': 'thinking_content', 'text': ''}), isNull);
    });

    test('deltaOf 把正文和思维链分到两个字段', () {
      final c = KhyOsStreamEvent.deltaOf({'type': 'chunk', 'content': '答'});
      expect(c.content, '答');
      expect(c.reasoning, '');
      final t = KhyOsStreamEvent.deltaOf({'type': 'thinking_content', 'text': '想'});
      expect(t.reasoning, '想');
      expect(t.content, '');
      // 其余事件类型（start/status/heartbeat/control_request）不携带增量。
      final other = KhyOsStreamEvent.deltaOf({'type': 'status', 'text': '检索中'});
      expect(other.content, '');
      expect(other.reasoning, '');
    });

    test('foldEventStream：thinking_content 累加进 reasoning，content 干净', () async {
      final events = <Map<String, dynamic>>[
        {'type': 'start'},
        {'type': 'thinking_content', 'text': '先看'},
        {'type': 'thinking_content', 'text': '行情，'},
        {'type': 'chunk', 'content': '今天'},
        {'type': 'chunk', 'content': '涨了'},
        {'type': 'done', 'content': '今天涨了'},
      ];

      final emissions =
          await KhyOsApi.foldEventStream(Stream.fromIterable(events), _seed()).toList();

      final last = emissions.last;
      expect(last.content, '今天涨了');
      expect(last.reasoning, '先看行情，');
      // 红线：思维链一个字都不能漏进正文。
      expect(last.content.contains('先看'), false);
      expect(last.content.contains('行情'), false);
    });

    test('foldEventStream：done 带全文时按覆盖处理，不把正文写两遍', () async {
      // done.content 是整条回复而不是增量。按增量追加会把全文写两遍——
      // 症状是答案重复一遍，而没有任何一方会报错。
      final events = <Map<String, dynamic>>[
        {'type': 'chunk', 'content': '今天'},
        {'type': 'chunk', 'content': '涨了'},
        {'type': 'done', 'content': '今天涨了'},
      ];

      final emissions =
          await KhyOsApi.foldEventStream(Stream.fromIterable(events), _seed()).toList();
      expect(emissions.last.content, '今天涨了');
    });

    test('foldEventStream：dedup 命中时只有一个 chunk（那也是全文）', () async {
      // 后端在 result.deduplicated 时发一个带全文的 chunk + 一个 done。
      final events = <Map<String, dynamic>>[
        {'type': 'chunk', 'content': '缓存的答案'},
        {'type': 'done', 'content': '缓存的答案', 'deduplicated': true},
      ];

      final emissions =
          await KhyOsApi.foldEventStream(Stream.fromIterable(events), _seed()).toList();
      expect(emissions.last.content, '缓存的答案');
    });

    test('foldEventStream：error 事件抛出，不假装完成', () async {
      // 吞掉它的话，界面会停在一个"已完成"的假象上：转圈停了，内容停在半句。
      final events = <Map<String, dynamic>>[
        {'type': 'chunk', 'content': '半句'},
        {'type': 'error', 'message': '上游超时'},
      ];

      expect(
        KhyOsApi.foldEventStream(Stream.fromIterable(events), _seed()).toList(),
        throwsA(isA<KhyOsStreamException>()
            .having((e) => e.message, 'message', '上游超时')),
      );
    });

    test('foldEventStream：没有思维链事件时 reasoning 是 null', () async {
      final events = <Map<String, dynamic>>[
        {'type': 'chunk', 'content': '答'},
        {'type': 'done', 'content': '答'},
      ];

      final emissions =
          await KhyOsApi.foldEventStream(Stream.fromIterable(events), _seed()).toList();
      expect(emissions.last.reasoning, isNull);
    });
  });
}
