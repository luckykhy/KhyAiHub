// khy-canary: Khy-20261101-073-EM0FMMSD
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'provider_adapter.dart';
import '../../data/models/models.dart';

/// AI 网关 - 统一管理所有 Provider
class AIGateway {
  final Map<String, ProviderAdapter> _providers = {};

  /// 注册 Provider
  void registerProvider(String id, ProviderAdapter provider) {
    _providers[id] = provider;
  }

  /// 获取 Provider
  ProviderAdapter? getProvider(String id) => _providers[id];

  /// 获取所有 Provider
  List<ProviderAdapter> get allProviders => _providers.values.toList();

  /// 获取可用 Provider
  List<ProviderAdapter> get availableProviders =>
      _providers.values.where((p) => p.isAvailable).toList();

  /// 智能路由 - 选择最佳 Provider
  ProviderAdapter? selectProvider(ChatRequest request) {
    final available = availableProviders;
    if (available.isEmpty) return null;

    switch (request.strategy) {
      case RoutingStrategy.specific:
        return request.providerId != null
            ? _providers[request.providerId]
            : available.first;
      case RoutingStrategy.capability:
        return _selectByCapability(available, request.requiredCapabilities);
      case RoutingStrategy.cost:
        return available.first; // 简化：返回第一个
      case RoutingStrategy.performance:
        return available.first; // 简化：返回第一个
    }
  }

  ProviderAdapter? _selectByCapability(
    List<ProviderAdapter> providers,
    List<Capability> capabilities,
  ) {
    for (final p in providers) {
      if (p.supports(capabilities)) return p;
    }
    return providers.first;
  }

  /// 聊天
  Future<ChatResponse> chat(ChatRequest request) async {
    final provider = selectProvider(request);
    if (provider == null) {
      throw Exception('No available AI provider');
    }
    return provider.chat(request);
  }

  /// 流式聊天
  ///
  /// 返回的是「一个 chunk 一个 delta」：每个 [ChatResponse] 的 content 与
  /// reasoning 都只是这一个 chunk 的增量，调用方要各自累加。
  ///
  /// 想要已经累加好的消息，用 [streamChatMessage]。
  Future<Stream<ChatResponse>> streamChat(ChatRequest request) async {
    final provider = selectProvider(request);
    if (provider == null) {
      throw Exception('No available AI provider');
    }
    return provider.streamChat(request);
  }

  /// 把流式回复折叠成一条**正在生长**的 assistant 消息。
  ///
  /// 每次 emit 的都是这条消息到目前为止的完整快照：content 是累计正文，
  /// reasoning 是累计思维链，两者各自独立累加，绝不互相拼串。调用方拿到直接
  /// 赋值给列表里那一项即可。
  ///
  /// 为什么单独开一个方法而不是改 [streamChat] 的语义：那个方法按 delta 返回，
  /// 已有调用方（`ui/screens/chat_screen.dart`）自己 `content + response.content`
  /// 累加；把它改成累计快照会让那个调用方把正文追加两遍。
  ///
  /// [seed] 提供 id / conversationId / role / timestamp，fold 过程中这几个都
  /// 不动，只推进 content / reasoning / usage。
  Stream<ChatMessage> streamChatMessage(
    ChatRequest request, {
    required ChatMessage seed,
  }) async* {
    final stream = await streamChat(request);
    var content = '';
    var reasoning = '';
    await for (final chunk in stream) {
      content += chunk.content;
      final delta = chunk.reasoning;
      if (delta != null && delta.isNotEmpty) {
        reasoning += delta;
      }
      yield seed.copyWith(
        content: content,
        // 空串折算成 null：UI 判的是「有没有思维链」，空串会让它渲染一个空块。
        reasoning: reasoning.isEmpty ? null : reasoning,
        usage: chunk.usage,
      );
    }
  }
}

/// Gateway Provider
final aiGatewayProvider = Provider<AIGateway>((ref) {
  return AIGateway();
});

/// 默认 Provider 配置
final defaultProviderConfigProvider = StateProvider<ProviderConfig?>((ref) {
  return null;
});
