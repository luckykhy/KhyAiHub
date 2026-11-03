// khy-canary: Khy-20261101-076-6PEXK67M
import 'dart:convert';
import 'package:dio/dio.dart';
import '../../data/models/models.dart';
import '../config/endpoint_defaults.dart';

/// AI Provider 能力
enum Capability {
  chat,
  vision,
  toolCall,
  streaming,
  imageGeneration,
}

/// 路由策略
enum RoutingStrategy {
  cost,       // 成本优先
  performance, // 性能优先
  capability,  // 能力优先
  specific,    // 指定模型
}

/// 聊天请求
class ChatRequest {
  final List<ChatMessage> messages;
  final String? model;
  final double temperature;
  final int? maxTokens;
  final bool stream;
  final List<Capability> requiredCapabilities;
  final RoutingStrategy strategy;
  final String? providerId;
  final List<Map<String, dynamic>>? tools;

  const ChatRequest({
    required this.messages,
    this.model,
    this.temperature = 0.7,
    this.maxTokens,
    this.stream = false,
    this.requiredCapabilities = const [],
    this.strategy = RoutingStrategy.performance,
    this.providerId,
    this.tools,
  });
}

/// 聊天响应
class ChatResponse {
  final String id;
  final String content;

  /// 思维链增量（reasoning / chain-of-thought）。null = 这个 chunk 不带思维链。
  ///
  /// 与 [content] 同语义：都是**单个 delta**，不是累计值。调用方要各自累加，
  /// 且必须分开累加——把 reasoning 拼进 content 会让思维链被当回答渲染。
  final String? reasoning;
  final MessageRole role;
  final TokenUsage? usage;
  final String? model;
  final bool done;

  const ChatResponse({
    required this.id,
    required this.content,
    this.reasoning,
    this.role = MessageRole.assistant,
    this.usage,
    this.model,
    this.done = true,
  });
}

/// 从一份上游 JSON 里取思维链正文。
///
/// 认不出返回 null 而不是空串：空串会被上层理解成"有思维链但内容为空"，
/// 于是渲染出一个空块——比不渲染更难解释。
///
/// 三个键名都认是因为各家叫法不同：OpenAI 兼容系（DeepSeek / GLM /
/// OpenRouter）发 `reasoning_content`，另一些发 `reasoning`，Ollama 的
/// /api/chat 与 Anthropic 的 thinking_delta 发 `thinking`。
String? reasoningTextOf(Map<String, dynamic> source) {
  for (final key in const ['reasoning_content', 'reasoning', 'thinking']) {
    final value = source[key];
    if (value is String && value.isNotEmpty) return value;
  }
  return null;
}

/// Provider 适配器接口
abstract class ProviderAdapter {
  String get id;
  String get name;
  bool get isAvailable;

  bool supports(List<Capability> capabilities);
  Future<ChatResponse> chat(ChatRequest request);
  Future<Stream<ChatResponse>> streamChat(ChatRequest request);
}

/// OpenAI 兼容适配器
class OpenAIAdapter implements ProviderAdapter {
  @override
  final String id;
  @override
  final String name;
  final String baseUrl;
  final String apiKey;
  final String model;
  final Dio _dio;

  @override
  bool get isAvailable => apiKey.isNotEmpty;

  OpenAIAdapter({
    required this.id,
    required this.name,
    required this.baseUrl,
    required this.apiKey,
    required this.model,
    Dio? dio,
  }) : _dio = dio ?? Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 30),
          receiveTimeout: const Duration(seconds: 60),
        ));

  @override
  bool supports(List<Capability> capabilities) {
    return true; // OpenAI 兼容 API 支持所有能力
  }

  @override
  Future<ChatResponse> chat(ChatRequest request) async {
    final response = await _dio.post(
      '$baseUrl/chat/completions',
      data: {
        'model': request.model ?? model,
        'messages': _buildMessages(request.messages),
        'temperature': request.temperature,
        'max_tokens': request.maxTokens,
        'tools': request.tools,
      },
      options: Options(headers: {
        'Authorization': 'Bearer $apiKey',
        'Content-Type': 'application/json',
      }),
    );

    final data = response.data;
    final choice = data['choices'][0];
    final message = choice['message'];

    return ChatResponse(
      id: data['id'] ?? '',
      content: message['content'] ?? '',
      // 非流式路径同样有思维链：DeepSeek/GLM 这类在 message 里一并给
      // reasoning_content。不读的话，接一个会吐思维链的模型也永远看不到。
      reasoning: reasoningTextOf(message),
      role: MessageRole.assistant,
      usage: data['usage'] != null
          ? TokenUsage(
              promptTokens: data['usage']['prompt_tokens'] ?? 0,
              completionTokens: data['usage']['completion_tokens'] ?? 0,
              totalTokens: data['usage']['total_tokens'] ?? 0,
            )
          : null,
      model: data['model'],
    );
  }

  @override
  Future<Stream<ChatResponse>> streamChat(ChatRequest request) async {
    final response = await _dio.post(
      '$baseUrl/chat/completions',
      data: {
        'model': request.model ?? model,
        'messages': _buildMessages(request.messages),
        'temperature': request.temperature,
        'max_tokens': request.maxTokens,
        'stream': true,
        'tools': request.tools,
      },
      options: Options(
        headers: {
          'Authorization': 'Bearer $apiKey',
          'Content-Type': 'application/json',
        },
        responseType: ResponseType.stream,
      ),
    );

    // 两处都是修这条链上真实存在的类型错误：`response.data` 是 dynamic，于是
    // `.stream` 拿到 `Stream<Uint8List>`，而 `utf8.decoder` 的类型是
    // `StreamTransformer<List<int>, String>`——invariance 让它不是
    // `StreamTransformer<Uint8List, …>` 的子类型。静态检查被 dynamic 一路绕过，
    // 于是一 listen 就抛 TypeError：这三个 streamChat 从来没被真正跑通过。
    //
    // `.cast` 之后必须落进一个有标注的局部变量：整条链都是 dynamic 的话，
    // 末尾 `.map(...)` 的运行时类型是 `Stream<dynamic>`，从
    // `Future<Stream<ChatResponse>>` 里 return 它还要再抛一次。
    //
    // 顺带它也挡住了思维链：chunk 解析就在这条链的末端。
    final Stream<List<int>> bytes = response.data.stream.cast<List<int>>();
    return bytes
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .where((line) => line.startsWith('data: ') && line != 'data: [DONE]')
        .map((line) {
      final json = jsonDecode(line.substring(6));
      final choice = json['choices'][0];
      final delta = choice['delta'];

      return ChatResponse(
        id: json['id'] ?? '',
        content: delta['content'] ?? '',
        // 思维链走的是 delta 里的另一个键，不是一个带 type 标签的 chunk 类型。
        // 老写法只读 delta['content']，于是 reasoning_content / thinking
        // 被静默丢掉——上游明明发了，屏幕上什么都没有。
        reasoning: reasoningTextOf(delta),
        role: MessageRole.assistant,
        done: choice['finish_reason'] != null,
        model: json['model'],
      );
    });
  }

  List<Map<String, dynamic>> _buildMessages(List<ChatMessage> messages) {
    return messages.map((m) => {
      'role': m.role == MessageRole.tool ? 'tool' : m.role.name,
      'content': m.content,
    }).toList();
  }
}

/// DeepSeek 适配器 (OpenAI 兼容)
class DeepSeekAdapter extends OpenAIAdapter {
  DeepSeekAdapter({
    required super.id,
    required super.name,
    required super.apiKey,
    required super.model,
    super.dio,
  }) : super(
          baseUrl: 'https://api.deepseek.com/v1',
        );
}

/// Anthropic Claude 适配器
class AnthropicAdapter implements ProviderAdapter {
  @override
  final String id;
  @override
  final String name;
  final String apiKey;
  final String model;
  final Dio _dio;

  @override
  bool get isAvailable => apiKey.isNotEmpty;

  AnthropicAdapter({
    required this.id,
    required this.name,
    required this.apiKey,
    this.model = 'claude-sonnet-4-20250514',
    Dio? dio,
  }) : _dio = dio ?? Dio(BaseOptions(
          baseUrl: 'https://api.anthropic.com/v1',
          connectTimeout: const Duration(seconds: 30),
          receiveTimeout: const Duration(seconds: 120),
        ));

  @override
  bool supports(List<Capability> capabilities) => true;

  @override
  Future<ChatResponse> chat(ChatRequest request) async {
    final response = await _dio.post(
      '/messages',
      data: {
        'model': request.model ?? model,
        'max_tokens': request.maxTokens ?? 4096,
        'messages': request.messages.map((m) => {
          'role': m.role.name,
          'content': m.content,
        }).toList(),
      },
      options: Options(headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      }),
    );

    final data = response.data;
    final content = data['content'][0]['text'];

    return ChatResponse(
      id: data['id'] ?? '',
      content: content,
      usage: data['usage'] != null
          ? TokenUsage(
              promptTokens: data['usage']['input_tokens'] ?? 0,
              completionTokens: data['usage']['output_tokens'] ?? 0,
              totalTokens: (data['usage']['input_tokens'] ?? 0) +
                  (data['usage']['output_tokens'] ?? 0),
            )
          : null,
      model: data['model'],
    );
  }

  @override
  Future<Stream<ChatResponse>> streamChat(ChatRequest request) async {
    final response = await _dio.post(
      '/messages',
      data: {
        'model': request.model ?? model,
        'max_tokens': request.maxTokens ?? 4096,
        'messages': request.messages.map((m) => {
          'role': m.role.name,
          'content': m.content,
        }).toList(),
        'stream': true,
      },
      options: Options(
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        responseType: ResponseType.stream,
      ),
    );

    // .cast 的原因见 OpenAIAdapter.streamChat 里的同一段注释。
    final Stream<List<int>> bytes = response.data.stream.cast<List<int>>();
    return bytes
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .where((line) => line.startsWith('data: '))
        .map((line) {
      final json = jsonDecode(line.substring(6));
      // 思维链在 Anthropic 协议里是**另一种 block**，不是 content 的另一种
      // 形状：content_block_start 先报一个 type=thinking 的块，随后每个
      // content_block_delta 带 type=thinking_delta 与 delta.thinking。
      //
      // 所以这里必须按 delta 自己的 type 分派，而不能像老写法那样对每个
      // content_block_delta 都读 json['delta']['text']——thinking_delta 的
      // delta 里没有 text 键，且 message_start / content_block_start /
      // message_stop 这些事件根本没有 delta，老写法在它们上面会抛。
      String content = '';
      String? reasoning;
      final type = json['type'];
      final delta = json['delta'];
      if (type == 'content_block_delta' && delta is Map) {
        if (delta['type'] == 'thinking_delta') {
          reasoning = reasoningTextOf(delta.cast<String, dynamic>());
        } else {
          content = delta['text'] ?? '';
        }
      }
      return ChatResponse(
        // 老写法是 json['message?']['id'] —— 键名多个问号，永远取不到值，
        // 取到 null 后再下标还会抛。改成安全取法：message 段只在
        // message_start / message_delta 上有，其余事件本来就没有 id。
        id: (json['message'] as Map?)?['id'] ?? '',
        content: content,
        reasoning: reasoning,
        done: type == 'message_stop',
      );
    });
  }
}

/// Ollama 本地适配器
class OllamaAdapter implements ProviderAdapter {
  @override
  final String id;
  @override
  final String name;
  final String baseUrl;
  final String model;
  final Dio _dio;

  @override
  bool get isAvailable => true;

  OllamaAdapter({
    required this.id,
    required this.name,
    this.baseUrl = kDefaultOllamaBaseUrl,
    this.model = kDefaultOllamaModel,
    Dio? dio,
  }) : _dio = dio ?? Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 120),
        ));

  @override
  bool supports(List<Capability> capabilities) {
    return true;
  }

  @override
  Future<ChatResponse> chat(ChatRequest request) async {
    final response = await _dio.post(
      '$baseUrl/api/chat',
      data: {
        'model': request.model ?? model,
        'messages': request.messages.map((m) => {
          'role': m.role.name,
          'content': m.content,
        }).toList(),
        'stream': false,
        'options': {
          'temperature': request.temperature,
        },
      },
      options: Options(headers: {
        'Content-Type': 'application/json',
      }),
    );

    final data = response.data;

    return ChatResponse(
      id: '',
      content: data['message']['content'] ?? '',
      // Ollama 的 /api/chat 对 thinking 模型在 message.thinking 里给思维链，
      // 与 content 同级。不读的话本地模型吐了思维链也看不见。
      reasoning: reasoningTextOf(data['message']),
      model: data['model'],
      done: true,
    );
  }

  @override
  Future<Stream<ChatResponse>> streamChat(ChatRequest request) async {
    final response = await _dio.post(
      '$baseUrl/api/chat',
      data: {
        'model': request.model ?? model,
        'messages': request.messages.map((m) => {
          'role': m.role.name,
          'content': m.content,
        }).toList(),
        'stream': true,
        'options': {
          'temperature': request.temperature,
        },
      },
      options: Options(
        headers: {
          'Content-Type': 'application/json',
        },
        responseType: ResponseType.stream,
      ),
    );

    // .cast 的原因见 OpenAIAdapter.streamChat 里的同一段注释。
    final Stream<List<int>> bytes = response.data.stream.cast<List<int>>();
    return bytes
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .where((line) => line.isNotEmpty)
        .map((line) {
      final json = jsonDecode(line);
      return ChatResponse(
        id: '',
        content: json['message']['content'] ?? '',
        reasoning: reasoningTextOf(json['message']),
        done: json['done'] ?? false,
        model: json['model'],
      );
    });
  }

  /// 检查 Ollama 是否运行
  Future<bool> checkAvailable() async {
    try {
      final response = await _dio.get('$baseUrl/api/tags');
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// 获取可用模型列表
  Future<List<String>> listModels() async {
    try {
      final response = await _dio.get('$baseUrl/api/tags');
      final models = response.data['models'] as List?;
      return models?.map((m) => m['name'] as String).toList() ?? [];
    } catch (_) {
      return [];
    }
  }
}
