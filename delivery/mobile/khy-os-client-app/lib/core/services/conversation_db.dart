// khy-canary: Khy-20261101-084-GP167GZS
import 'dart:async';
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Simple conversation storage using SecureStorage
/// (Can be upgraded to SQLite later for larger datasets)
class ConversationDB {
  static const _prefix = 'conv_';
  static const _indexKey = 'conv_index';
  static const _storage = FlutterSecureStorage();

  /// Save a conversation
  static Future<void> save(Conversation conv) async {
    await _storage.write(
      key: _prefix + conv.id,
      value: jsonEncode(conv.toJson()),
    );
    // Update index
    final index = await listIds();
    if (!index.contains(conv.id)) {
      index.add(conv.id);
      await _storage.write(key: _indexKey, value: jsonEncode(index));
    }
  }

  /// Load a conversation
  static Future<Conversation?> load(String id) async {
    final raw = await _storage.read(key: _prefix + id);
    if (raw == null) return null;
    return Conversation.fromJson(jsonDecode(raw));
  }

  /// List all conversation IDs
  static Future<List<String>> listIds() async {
    final raw = await _storage.read(key: _indexKey);
    if (raw == null) return [];
    try {
      return (jsonDecode(raw) as List).cast<String>();
    } catch (_) {
      return [];
    }
  }

  /// List all conversations (summary)
  static Future<List<ConversationSummary>> listAll() async {
    final ids = await listIds();
    final summaries = <ConversationSummary>[];
    for (final id in ids.reversed) {
      final conv = await load(id);
      if (conv != null) {
        summaries.add(ConversationSummary(
          id: conv.id,
          title: conv.title,
          messageCount: conv.messages.length,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          workspaceRoot: conv.workspaceRoot,
        ));
      }
    }
    return summaries;
  }

  /// Delete a conversation
  static Future<void> delete(String id) async {
    await _storage.delete(key: _prefix + id);
    final index = await listIds();
    index.remove(id);
    await _storage.write(key: _indexKey, value: jsonEncode(index));
  }

  /// Clear all conversations
  static Future<void> clearAll() async {
    final index = await listIds();
    for (final id in index) {
      await _storage.delete(key: _prefix + id);
    }
    await _storage.delete(key: _indexKey);
  }
}

class Conversation {
  final String id;
  final String title;
  final List<ChatMsg> messages;
  final DateTime createdAt;
  final DateTime updatedAt;

  /// 这个对话的工作空间根。null / 空 = 用户没挑，用 App 既有默认。
  ///
  /// 为什么按对话而不是全局：一个对话在写游戏，另一个在整理下载目录，
  /// 共用一个根意味着前者的成果和后者的临时文件混在一起，而谁都不敢删。
  /// 粒度落到对话，"清理"才是有意义的操作。
  ///
  /// 存的是**校验并规范化之后**的值（见 ConversationWorkspace.check），
  /// 不是用户输进去的原样——原样可能带尾斜杠或重复斜杠，存原样会出现
  /// "界面上看着对、落盘差一点"。
  final String? workspaceRoot;

  Conversation({
    required this.id,
    this.title = '',
    this.messages = const [],
    DateTime? createdAt,
    DateTime? updatedAt,
    this.workspaceRoot,
  })  : createdAt = createdAt ?? DateTime.now(),
        updatedAt = updatedAt ?? DateTime.now();

  Conversation copyWith({
    String? title,
    List<ChatMsg>? messages,
    String? workspaceRoot,
    bool clearWorkspaceRoot = false,
  }) =>
      Conversation(
        id: id,
        title: title ?? this.title,
        messages: messages ?? this.messages,
        createdAt: createdAt,
        updatedAt: DateTime.now(),
        // 显式的 clear 标志，而不是用空串表示"清掉"：空串既是"没挑"也是
        // "挑了根目录"，用同一个值表达两种意思，调用方必然有一处会搞错。
        workspaceRoot:
            clearWorkspaceRoot ? null : (workspaceRoot ?? this.workspaceRoot),
      );

  Map<String, dynamic> toJson() => {
    'id': id,
    'title': title,
    'messages': messages.map((m) => m.toJson()).toList(),
    'createdAt': createdAt.toIso8601String(),
    'updatedAt': updatedAt.toIso8601String(),
    // 只在挑了的时候写。老对话反序列化时这个键不存在 → null → 行为不变，
    // 不需要迁移，也不需要版本号。
    if (workspaceRoot != null) 'workspaceRoot': workspaceRoot,
  };

  factory Conversation.fromJson(Map<String, dynamic> json) {
    // 类型检查而不是硬转。这个值来自 FlutterSecureStorage，可能被手改或写坏，
    // 而 `as String?` 遇到 int 会抛——异常会一路穿过 load() 打到界面上，
    // 表现为"一开会话列表就白屏"。同层的 AmooTurnStore 的策略就是"不抛，
    // 留日志"，这里照做。
    final rawRoot = json['workspaceRoot'];
    return Conversation(
      id: json['id'] ?? '',
      title: json['title'] ?? '',
      messages: (json['messages'] as List?)
              ?.map((m) => ChatMsg.fromJson(m))
              .toList() ??
          [],
      createdAt: DateTime.tryParse(json['createdAt'] ?? '') ?? DateTime.now(),
      updatedAt: DateTime.tryParse(json['updatedAt'] ?? '') ?? DateTime.now(),
      workspaceRoot: rawRoot is String ? rawRoot : null,
    );
  }
}

class ChatMsg {
  final String role; // user, assistant, system, tool
  final String content;
  final DateTime timestamp;
  final List<Map<String, dynamic>>? toolCalls;

  /// 这条 assistant 消息的思维链正文。null / 空 = 当时上游没给思维链。
  ///
  /// 与 [Conversation.workspaceRoot] 同一套无迁移写法：只在有值时写键，
  /// 老对话反序列化时键不存在 → null → 行为一字不变。这里存的是
  /// FlutterSecureStorage 里的 JSON 字符串，不是关系表，所以没有 schema
  /// 版本要管（对比 amoo 反代的 sqflite，那边加列必须补 onUpgrade）。
  final String? reasoning;

  ChatMsg({
    required this.role,
    required this.content,
    DateTime? timestamp,
    this.toolCalls,
    this.reasoning,
  }) : timestamp = timestamp ?? DateTime.now();

  Map<String, dynamic> toJson() => {
    'role': role,
    'content': content,
    'timestamp': timestamp.toIso8601String(),
    if (toolCalls != null) 'tool_calls': toolCalls,
    // 条件写而不是无条件写 null：无条件写会让每一笔历史会话的 JSON 都多一个
    // 空键，且反序列化时分不出「当时没有思维链」和「思维链是空串」。
    if (reasoning != null) 'reasoning': reasoning,
  };

  factory ChatMsg.fromJson(Map<String, dynamic> json) => ChatMsg(
    role: json['role'] ?? '',
    content: json['content'] ?? '',
    timestamp: DateTime.tryParse(json['timestamp'] ?? '') ?? DateTime.now(),
    toolCalls: json['tool_calls'] as List<Map<String, dynamic>>?,
    // 同 Conversation.fromJson 的理由：值来自 FlutterSecureStorage，可能被手改
    // 或写坏，`as String?` 遇到 int 会抛，而异常会穿过 load() 打到界面上，
    // 表现成"一开会话列表就白屏"。
    reasoning: json['reasoning'] is String ? json['reasoning'] as String : null,
  );
}

class ConversationSummary {
  final String id;
  final String title;
  final int messageCount;
  final DateTime createdAt;
  final DateTime updatedAt;

  /// 这个对话的工作空间根（null = 没挑）。
  ///
  /// 摘要带它，是为了让会话列表能显示"这个对话的文件落在哪"——用户找不着
  /// 文件时的第一念头就是回列表里看，那时看不见根就等于没有这个功能。
  final String? workspaceRoot;

  const ConversationSummary({
    required this.id,
    required this.title,
    required this.messageCount,
    required this.createdAt,
    required this.updatedAt,
    this.workspaceRoot,
  });
}
