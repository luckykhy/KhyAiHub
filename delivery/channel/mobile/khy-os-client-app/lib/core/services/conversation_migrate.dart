// khy-canary: Khy-20261113-001-P1MIG
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:khy_os_client/core/services/conversation_db.dart';

/// 通用会话轮次——T4 的 schema 真源。
///
/// 六字段：id / session_id / role / content / ts / meta。任何 driver 通用，
/// 不掺 amoo 专属必填字段；driver 来源在 meta['driver']，缺了照样读。
class ChatTurn {
  static const roleUser = 'user';
  static const roleAssistant = 'assistant';
  static const roleSystem = 'system';
  static const roleTool = 'tool';

  final String id;
  final String sessionId;
  final String role;
  final String content;
  final DateTime ts;
  final Map<String, Object?> meta;

  ChatTurn({
    required this.id,
    required this.sessionId,
    required this.role,
    required this.content,
    required this.ts,
    this.meta = const {},
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'session_id': sessionId,
        'role': role,
        'content': content,
        'ts': ts.toIso8601String(),
        'meta': meta,
      };

  /// 容错解析：值来自文件，可能被手改或写坏。`as` 强转会抛，异常穿过 load()
  /// 打到界面上就是「一开会话列表白屏」——同层 ChatMsg.fromJson 的策略是
  /// 不抛、按缺省走，这里照做。
  factory ChatTurn.fromJson(Map<String, dynamic> json) => ChatTurn(
        id: (json['id'] ?? '').toString(),
        sessionId: (json['session_id'] ?? '').toString(),
        role: (json['role'] ?? '').toString(),
        content: (json['content'] ?? '').toString(),
        ts: DateTime.tryParse((json['ts'] ?? '').toString()) ?? DateTime.now(),
        meta: json['meta'] is Map ? Map<String, Object?>.from(json['meta'] as Map) : const {},
      );
}

/// JSONL 编解码：一行一轮次。坏行跳过而不是毒化整份——T4 要求外部工具
/// 拿到残缺文件也能读出事发前的内容。
class ConversationTurnCodec {
  static String encodeJsonl(List<ChatTurn> turns) =>
      turns.map((t) => jsonEncode(t.toJson())).join('\n') + (turns.isEmpty ? '' : '\n');

  static List<ChatTurn> decodeJsonl(String text) {
    final out = <ChatTurn>[];
    for (final line in text.split('\n')) {
      if (line.trim().isEmpty) continue;
      try {
        final decoded = jsonDecode(line);
        if (decoded is Map) out.add(ChatTurn.fromJson(decoded.cast<String, dynamic>()));
      } catch (_) {
        // 坏行跳过。整份解析失败会让「读得出前 999 条」变成「一条都读不出」。
      }
    }
    return out;
  }
}

/// legacy 对话（ChatMsg）→ 通用轮次的一次性迁移。纯函数，幂等。
class ConversationMigrate {
  /// 迁移整条对话。session_id 用对话 id；ChatMsg 的 reasoning 进 meta，
  /// 不开新必填字段。legacy 消息没有 driver 信息——meta['driver'] 留空，
  /// 这正是「缺 amoo 专属字段不影响读取」的现状证据。
  static List<ChatTurn> fromLegacyConversation(Conversation conv) {
    return conv.messages.map((m) => fromLegacyMsg(m, sessionId: conv.id)).toList();
  }

  static ChatTurn fromLegacyMsg(ChatMsg m, {required String sessionId}) {
    return ChatTurn(
      // id 由 (session, ts, role) 决定而不是随机数：同一条 legacy 迁移两次
      // 得到同一个 id，重放/对账才不会每次都是新轮次。
      id: '${sessionId}_${m.timestamp.millisecondsSinceEpoch}_${m.role}',
      sessionId: sessionId,
      role: m.role,
      content: m.content,
      ts: m.timestamp,
      meta: {
        if (m.reasoning != null) 'reasoning': m.reasoning,
        if (m.toolCalls != null) 'tool_calls': m.toolCalls,
      },
    );
  }
}

/// JSONL 落盘：App 私有目录下的会话导出格式（T4 产物）。
///
/// root 可注入——测试用临时目录，真机用 ApplicationDocumentsDirectory。
/// 不预置占位文件：目录与文件都只在有内容要写时创建（§5.3）。
class ConversationJsonlStore {
  ConversationJsonlStore({Directory? root}) : _root = root;

  Directory? _root;

  /// 默认根：App 私有目录 conversations/。惰性解析，构造时不碰盘；
  /// 测试注入 root，永远走不到 path_provider（flutter_test 里它没有平台实现）。
  Future<Directory> _resolveRoot() async {
    final existing = _root;
    if (existing != null) return existing;
    final docs = await getApplicationDocumentsDirectory();
    final dir = Directory('${docs.path}/conversations');
    await dir.create(recursive: true);
    _root = dir;
    return dir;
  }

  Future<File> _fileFor(String sessionId) async {
    final root = await _resolveRoot();
    // sessionId 直接进文件名会被 '/' 之类劈开——先做一次目录安全规范化。
    final safe = sessionId.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
    return File('${root.path}/$safe.jsonl');
  }

  /// 整份重写。保留既有行里的 meta（driver 标记），内容以传入 turns 为准。
  Future<void> write(String sessionId, List<ChatTurn> turns) async {
    if (turns.isEmpty) return; // 空会话不落盘——不预置占位文件
    final file = await _fileFor(sessionId);
    await file.writeAsString(ConversationTurnCodec.encodeJsonl(turns));
  }

  Future<List<ChatTurn>> read(String sessionId) async {
    final file = await _fileFor(sessionId);
    if (!await file.exists()) return [];
    return ConversationTurnCodec.decodeJsonl(await file.readAsString());
  }

  /// 显式导出：返回导出文件路径（T4 判据的取证对象）。
  Future<String> exportPath(String sessionId) async => (await _fileFor(sessionId)).path;
}
