// khy-canary: Khy-20261101-104-RDZMHK4E
import 'package:collection/collection.dart';

/// AI 消息角色
enum MessageRole {
  user,
  assistant,
  system,
  tool;

  String get value => name;

  static MessageRole fromString(String value) {
    return MessageRole.values.firstWhereOrNull((e) => e.name == value) ?? MessageRole.user;
  }
}

/// 聊天消息
class ChatMessage {
  final String id;
  final String conversationId;
  final MessageRole role;
  final String content;

  /// 思维链正文（reasoning / chain-of-thought）。null 或空 = 上游没给思维链，
  /// 界面就不渲染思维链块。
  ///
  /// 刻意是独立字段而不是拼进 [content]：混进正文的思维链会被当回答渲染出来，
  /// 还会随对话历史上传给下一轮请求，等于把"怎么想的"固化成"说过什么"。
  /// 两条内容在协议里本来就是两个键（content / reasoning_content），拆开只是
  /// 照原样保留。
  final String? reasoning;
  final List<MessageAttachment>? attachments;
  final List<ToolCall>? toolCalls;
  final TokenUsage? usage;
  final DateTime timestamp;

  const ChatMessage({
    required this.id,
    required this.conversationId,
    required this.role,
    required this.content,
    this.reasoning,
    this.attachments,
    this.toolCalls,
    this.usage,
    required this.timestamp,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'conversationId': conversationId,
        'role': role.value,
        'content': content,
        'reasoning': reasoning,
        'attachments': attachments?.map((e) => e.toJson()).toList(),
        'toolCalls': toolCalls?.map((e) => e.toJson()).toList(),
        'usage': usage?.toJson(),
        'timestamp': timestamp.toIso8601String(),
      };

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        id: json['id'] as String,
        conversationId: json['conversationId'] as String,
        role: MessageRole.fromString(json['role'] as String),
        content: json['content'] as String,
        // 这一个字段用类型检查而不是硬转，与同文件其余字段不一致是故意的：
        // 它是后加的，读到的 JSON 可能来自更早的版本、也可能被手改坏，而
        // `as String?` 遇到 int 会抛——异常会一路打到界面上。缺键 → null，
        // 与"从来没有思维链"是同一件事，老消息行为一字不变。
        reasoning: json['reasoning'] is String ? json['reasoning'] as String : null,
        attachments: (json['attachments'] as List?)
            ?.map((e) => MessageAttachment.fromJson(e as Map<String, dynamic>))
            .toList(),
        toolCalls: (json['toolCalls'] as List?)
            ?.map((e) => ToolCall.fromJson(e as Map<String, dynamic>))
            .toList(),
        usage: json['usage'] != null
            ? TokenUsage.fromJson(json['usage'] as Map<String, dynamic>)
            : null,
        timestamp: DateTime.parse(json['timestamp'] as String),
      );

  ChatMessage copyWith({
    String? id,
    String? conversationId,
    MessageRole? role,
    String? content,
    String? reasoning,
    List<MessageAttachment>? attachments,
    List<ToolCall>? toolCalls,
    TokenUsage? usage,
    DateTime? timestamp,
  }) {
    return ChatMessage(
      id: id ?? this.id,
      conversationId: conversationId ?? this.conversationId,
      role: role ?? this.role,
      content: content ?? this.content,
      reasoning: reasoning ?? this.reasoning,
      attachments: attachments ?? this.attachments,
      toolCalls: toolCalls ?? this.toolCalls,
      usage: usage ?? this.usage,
      timestamp: timestamp ?? this.timestamp,
    );
  }

  /// 图片附件；没有（字段本身可空）时是空列表。
  ///
  /// 发送链（`provider_adapter` 的多模态 content block）与消息行缩略图共用这
  /// 一个定义。两边各写一个 where 条件，就会出现「图上送了、行里不显示」或
  /// 反过来——而这种分叉没有任何症状，只是用户以为自己发出去的图模型没看到。
  ///
  /// 只收 [AttachmentType.image]：视频抽帧要原生工（Android 无 ffmpeg），
  /// 音频/文件当前也没有多模态通道，混进来只会造出发过去也没人读的块。
  List<MessageAttachment> get imageAttachments =>
      attachments?.where((a) => a.type == AttachmentType.image).toList() ??
      const [];
}

/// 消息附件
class MessageAttachment {
  final String id;
  final AttachmentType type;
  final String path;
  final String? mimeType;
  final int? size;

  const MessageAttachment({
    required this.id,
    required this.type,
    required this.path,
    this.mimeType,
    this.size,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'type': type.value,
        'path': path,
        'mimeType': mimeType,
        'size': size,
      };

  factory MessageAttachment.fromJson(Map<String, dynamic> json) =>
      MessageAttachment(
        id: json['id'] as String,
        type: AttachmentType.fromString(json['type'] as String),
        path: json['path'] as String,
        mimeType: json['mimeType'] as String?,
        size: json['size'] as int?,
      );
}

enum AttachmentType {
  image,
  file,
  audio,
  video;

  String get value => name;

  static AttachmentType fromString(String value) {
    return AttachmentType.values.firstWhere((e) => e.name == value);
  }
}

/// 工具调用
class ToolCall {
  final String id;
  final String name;
  final Map<String, dynamic> arguments;

  const ToolCall({
    required this.id,
    required this.name,
    required this.arguments,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'arguments': arguments,
      };

  factory ToolCall.fromJson(Map<String, dynamic> json) => ToolCall(
        id: json['id'] as String,
        name: json['name'] as String,
        arguments: json['arguments'] as Map<String, dynamic>,
      );
}

/// Token 用量
class TokenUsage {
  final int promptTokens;
  final int completionTokens;
  final int totalTokens;

  const TokenUsage({
    required this.promptTokens,
    required this.completionTokens,
    required this.totalTokens,
  });

  Map<String, dynamic> toJson() => {
        'promptTokens': promptTokens,
        'completionTokens': completionTokens,
        'totalTokens': totalTokens,
      };

  factory TokenUsage.fromJson(Map<String, dynamic> json) => TokenUsage(
        promptTokens: json['promptTokens'] as int,
        completionTokens: json['completionTokens'] as int,
        totalTokens: json['totalTokens'] as int,
      );
}

/// 对话
class Conversation {
  final String id;
  final String title;
  final String mode; // chat, agent, independent
  final String? providerId;
  final String? modelId;
  final DateTime createdAt;
  final DateTime updatedAt;
  final Map<String, dynamic>? metadata;

  const Conversation({
    required this.id,
    required this.title,
    this.mode = 'chat',
    this.providerId,
    this.modelId,
    required this.createdAt,
    required this.updatedAt,
    this.metadata,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'mode': mode,
        'providerId': providerId,
        'modelId': modelId,
        'createdAt': createdAt.toIso8601String(),
        'updatedAt': updatedAt.toIso8601String(),
        'metadata': metadata,
      };

  factory Conversation.fromJson(Map<String, dynamic> json) => Conversation(
        id: json['id'] as String,
        title: json['title'] as String,
        mode: json['mode'] as String? ?? 'chat',
        providerId: json['providerId'] as String?,
        modelId: json['modelId'] as String?,
        createdAt: DateTime.parse(json['createdAt'] as String),
        updatedAt: DateTime.parse(json['updatedAt'] as String),
        metadata: json['metadata'] as Map<String, dynamic>?,
      );
}

/// Provider 配置
class ProviderConfig {
  final String id;
  final String name;
  final String type; // openai, anthropic, deepseek, ollama, custom
  final String baseUrl;
  final String? apiKeyEncrypted;
  final List<String> models;
  final Map<String, String>? customHeaders;
  final bool enabled;
  final DateTime createdAt;

  const ProviderConfig({
    required this.id,
    required this.name,
    required this.type,
    required this.baseUrl,
    this.apiKeyEncrypted,
    this.models = const [],
    this.customHeaders,
    this.enabled = true,
    required this.createdAt,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'type': type,
        'baseUrl': baseUrl,
        'apiKeyEncrypted': apiKeyEncrypted,
        'models': models,
        'customHeaders': customHeaders,
        'enabled': enabled,
        'createdAt': createdAt.toIso8601String(),
      };

  factory ProviderConfig.fromJson(Map<String, dynamic> json) => ProviderConfig(
        id: json['id'] as String,
        name: json['name'] as String,
        type: json['type'] as String,
        baseUrl: json['baseUrl'] as String,
        apiKeyEncrypted: json['apiKeyEncrypted'] as String?,
        models: (json['models'] as List?)?.cast<String>() ?? [],
        customHeaders: (json['customHeaders'] as Map<String, dynamic>?)?.cast<String, String>(),
        enabled: json['enabled'] as bool? ?? true,
        createdAt: DateTime.parse(json['createdAt'] as String),
      );
}
