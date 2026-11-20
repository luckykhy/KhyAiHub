// khy-canary: Khy-20261101-084-GP167GZS
import 'dart:async';
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:khy_os_client/core/services/conversation_migrate.dart';

/// Simple conversation storage using SecureStorage
/// (Can be upgraded to SQLite later for larger datasets)
class ConversationDB {
  static const _prefix = 'conv_';
  static const _indexKey = 'conv_index';
  static const _storage = FlutterSecureStorage();

  /// 通用 JSONL 导出面（T4 产物）。与安全存储并存：活读取仍走安全存储
  /// （界面行为零回归），JSONL 是通用格式的导出/迁移面。
  static final ConversationJsonlStore jsonl = ConversationJsonlStore();

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
    // JSONL 同步不 await：保存是主路径，不该被盘上 IO 拖住；失败由 store
    // 自己抛，下一次保存还会再试（幂等重写）。
    unawaited(_syncJsonl(conv));
  }

  /// 把安全存储里的对话同步成通用 JSONL。
  ///
  /// meta 合并：既有行里记过的 driver 标记保留——重写不能以「这一次没带」
  /// 为由抹掉上一次记下的来源。同 id 的轮次内容以安全存储为准（那里是活数据）。
  ///
  /// 整体 try/catch：JSONL 是**导出面**，不是活存储——写不出去（无平台
  /// 实现的测试环境、盘满、目录建不了）都不该影响保存本身，更不该把异步
  /// 异常抛给调用方：unawaited 出去的 Future 一旦抛错，会被归到那个时刻
  /// 碰巧在跑的无关测试头上（实测污染过 reasoning_persist_wiring_test）。
  static Future<void> _syncJsonl(Conversation conv) async {
    try {
      final existing = await jsonl.read(conv.id);
      final metaById = {for (final t in existing) t.id: t.meta};
      final turns = ConversationMigrate.fromLegacyConversation(conv).map((t) {
        final prev = metaById[t.id];
        if (prev == null) return t;
        return ChatTurn(
          id: t.id,
          sessionId: t.sessionId,
          role: t.role,
          content: t.content,
          ts: t.ts,
          meta: {...prev, ...t.meta},
        );
      }).toList();
      await jsonl.write(conv.id, turns);
    } catch (_) {
      // 导出面失败：静默。下一次保存还会再试（幂等重写）。
    }
  }

  /// 导出会话 JSONL 的路径（T4 取证对象：外部工具直接读这个文件）。
  static Future<String> exportJsonl(String id) async => jsonl.exportPath(id);

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
          syncToDesktop: conv.syncToDesktop,
          syncState: conv.syncState,
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

  /// 这个对话是否同步到电脑。null = 没单独选过，跟随全局默认。
  ///
  /// 为什么允许 null 而不是在创建时就把全局值抄下来：用户后来改全局默认，
  /// 所有「没单独表过态」的对话都该跟着走。抄下来会让改全局只影响新对话，
  /// 而旧对话永远停在创建那天的默认上——那没人能解释。
  final bool? syncToDesktop;

  /// 最近一次同步的结果：'synced' / 'failed' / null（还没发过消息）。
  ///
  /// 存结果而不是存"应该同步"：同步是后端做的，本机只能记它实际回了什么。
  /// 存意图会让界面在一次失败之后继续显示"已同步"。
  final String? syncState;

  Conversation({
    required this.id,
    this.title = '',
    this.messages = const [],
    DateTime? createdAt,
    DateTime? updatedAt,
    this.workspaceRoot,
    this.syncToDesktop,
    this.syncState,
  })  : createdAt = createdAt ?? DateTime.now(),
        updatedAt = updatedAt ?? DateTime.now();

  Conversation copyWith({
    String? title,
    List<ChatMsg>? messages,
    String? workspaceRoot,
    bool clearWorkspaceRoot = false,
    bool? syncToDesktop,
    bool clearSyncOverride = false,
    String? syncState,
    bool clearSyncState = false,
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
        // 同 workspaceRoot：null 是"跟随全局"这个有意义的状态，不能被
        // `syncToDesktop ?? this.syncToDesktop` 覆盖掉，所以归位要显式标志。
        syncToDesktop:
            clearSyncOverride ? null : (syncToDesktop ?? this.syncToDesktop),
        syncState: clearSyncState ? null : (syncState ?? this.syncState),
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
    // 同 workspaceRoot：没表过态就不写键，老对话读出来仍是"跟随全局"。
    if (syncToDesktop != null) 'syncToDesktop': syncToDesktop,
    if (syncState != null) 'syncState': syncState,
  };

  factory Conversation.fromJson(Map<String, dynamic> json) {
    // 类型检查而不是硬转。这个值来自 FlutterSecureStorage，可能被手改或写坏，
    // 而 `as String?` 遇到 int 会抛——异常会一路穿过 load() 打到界面上，
    // 表现为"一开会话列表就白屏"。同层的 AmooTurnStore 的策略就是"不抛，
    // 留日志"，这里照做。
    final rawRoot = json['workspaceRoot'];
    final rawSync = json['syncToDesktop'];
    final rawState = json['syncState'];
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
      // 为什么 bool 也要 is 检查：JSON 里的 true 可能是数字 1 或字符串
      // "true"（外部工具改过、或别的语言写过这个键），`as bool?` 会抛，
      // 抛出去就是"一开会话列表就白屏"。
      syncToDesktop: rawSync is bool ? rawSync : null,
      syncState: rawState is String ? rawState : null,
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

  /// 这个对话是否同步到电脑（null = 跟随全局默认），以及最近一次结果。
  /// 摘要带它们的原因同 workspaceRoot：会话列表要能直接看出每条的状态。
  final bool? syncToDesktop;
  final String? syncState;

  const ConversationSummary({
    required this.id,
    required this.title,
    required this.messageCount,
    required this.createdAt,
    required this.updatedAt,
    this.workspaceRoot,
    this.syncToDesktop,
    this.syncState,
  });
}
