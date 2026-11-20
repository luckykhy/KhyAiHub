import 'dart:convert';

import 'package:meta/meta.dart';

// ── wire format table (shared single definition for all four owners;
//    transcribed from the task's "接口契约" section — the authoritative
//    contract document is NOT in this repo, see AMOO-MIRROR.md) ──────────
// Envelopes:
//   GET /sessions                → bare JSON array [{session}, ...] (no envelope key)
//   GET /sessions/{id}/messages  → {"items":[...], "nextCursor":"<ts>:<id>"|"", "hasMore":bool}
// session keys (camelCase): id, title, updatedAt (epoch ms), lastPreview,
//   messageCount, agentKey, compacted (bool)
// message keys (camelCase): id, parentId (nullable), timestamp (epoch ms int),
//   role ("user"|"assistant"), blocks (array)
// block discrimination: `type`. "text"→{type,text}; "tool"→{type,name,summary,
//   truncated(bool)}; unknown type drops THAT block; blocks missing or not an
//   array → the whole message returns null
// cursor: '<epoch_ms>:<id>', EXCLUSIVE (strictly after that point); hasMore=false
//   still returns the last message's <ts>:<id>; empty/missing = caught up
//   (stored as NULL on the client)
// **Ordering: /sessions by updatedAt DESC** — the contract promises NO order;
//   this is the assumption the client-side merge and the "latest 50" view rest
//   on (mock implements the same side). See AMOO-MIRROR.md.
// Unknown top-level fields: ignored, never a badResponse. Underscore keys are
// not part of the contract.

enum AmooMirrorRole {
  user,
  assistant;

  String get wire => name;

  /// Only 'user'/'assistant' are contract values; anything else (including a
  /// future third role) is unparseable rather than silently coerced — a
  /// mis-attributed bubble would put words in the wrong mouth.
  static AmooMirrorRole? parse(Object? raw) {
    if (raw is! String) return null;
    switch (raw) {
      case 'user':
        return AmooMirrorRole.user;
      case 'assistant':
        return AmooMirrorRole.assistant;
      default:
        return null;
    }
  }
}

sealed class AmooMirrorBlock {
  const AmooMirrorBlock();

  Map<String, Object?> toJson();
}

final class AmooMirrorTextBlock extends AmooMirrorBlock {
  const AmooMirrorTextBlock(this.text);

  final String text;

  @override
  Map<String, Object?> toJson() => <String, Object?>{'type': 'text', 'text': text};
}

final class AmooMirrorToolBlock extends AmooMirrorBlock {
  const AmooMirrorToolBlock({
    required this.name,
    required this.summary,
    this.truncated = false,
  });

  final String name;
  final String summary;

  /// Server-side "already truncated" flag. A separate fact from the client's
  /// 800-char cut — both labels exist because they answer different questions
  /// ("amoo cut it" vs "we cut it").
  final bool truncated;

  @override
  Map<String, Object?> toJson() => <String, Object?>{
        'type': 'tool',
        'name': name,
        'summary': summary,
        'truncated': truncated,
      };
}

/// Decodes the `blocks` value of one message.
///
/// Returns null = input is not a decoded List (dirty data); both [AmooMirrorMessage.fromJson]
/// and [AmooMirrorMessage.fromRow] then drop the whole message. It must never fall
/// back to an empty list — a zero-block "air bubble" reads as "amoo only replied
/// this much" (same honesty boundary as lib/core/db/amoo_turn.dart:66-68).
List<AmooMirrorBlock>? parseAmooMirrorBlocks(Object? decoded) {
  if (decoded is! List) return null;
  final blocks = <AmooMirrorBlock>[];
  for (final raw in decoded) {
    if (raw is! Map) continue;
    final type = raw['type'];
    if (type == 'text') {
      final text = raw['text'];
      if (text is String) blocks.add(AmooMirrorTextBlock(text));
    } else if (type == 'tool') {
      final name = raw['name'];
      final summary = raw['summary'];
      if (name is String && summary is String) {
        blocks.add(AmooMirrorToolBlock(
          name: name,
          summary: summary,
          truncated: raw['truncated'] == true,
        ));
      }
    }
    // Unknown block type: drop the block, keep the message.
  }
  return blocks;
}

@immutable
class AmooMirrorSession {
  const AmooMirrorSession({
    required this.id,
    required this.title,
    required this.updatedAt,
    this.lastPreview = '',
    this.messageCount = 0,
    this.agentKey = '',
    this.compacted = false,
  });

  final String id;
  final String title;

  /// epoch ms
  final int updatedAt;
  final String lastPreview;
  final int messageCount;
  final String agentKey;
  final bool compacted;

  /// Missing/empty id → null. A primary key squashed into a blank row would be
  /// silently eaten by INSERT OR IGNORE along with every other row of the batch.
  static AmooMirrorSession? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    if (id is! String || id.isEmpty) return null;
    final updatedAt = raw['updatedAt'];
    return AmooMirrorSession(
      id: id,
      title: raw['title'] is String ? raw['title'] as String : '',
      // A garbage timestamp sorts to the bottom instead of dropping the row:
      // the session exists on the server regardless of what its clock said.
      updatedAt: updatedAt is num ? updatedAt.toInt() : 0,
      lastPreview: raw['lastPreview'] is String ? raw['lastPreview'] as String : '',
      messageCount: raw['messageCount'] is num ? (raw['messageCount'] as num).toInt() : 0,
      agentKey: raw['agentKey'] is String ? raw['agentKey'] as String : '',
      compacted: raw['compacted'] == true,
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'title': title,
        'updatedAt': updatedAt,
        'lastPreview': lastPreview,
        'messageCount': messageCount,
        'agentKey': agentKey,
        'compacted': compacted,
      };

  /// snake_case column names. `next_cursor` is deliberately absent — the cursor
  /// is only written by the message-sync path (see AmooMirrorSchema).
  Map<String, Object?> toRow() => <String, Object?>{
        'session_id': id,
        'title': title,
        'updated_at': updatedAt,
        'last_preview': lastPreview,
        'message_count': messageCount,
        'agent_key': agentKey,
        'compacted': compacted ? 1 : 0,
      };

  static AmooMirrorSession? fromRow(Map<String, Object?> row) {
    final id = row['session_id'];
    if (id is! String || id.isEmpty) return null;
    return AmooMirrorSession(
      id: id,
      title: (row['title'] as String?) ?? '',
      updatedAt: (row['updated_at'] as int?) ?? 0,
      lastPreview: (row['last_preview'] as String?) ?? '',
      messageCount: (row['message_count'] as int?) ?? 0,
      agentKey: (row['agent_key'] as String?) ?? '',
      compacted: (row['compacted'] as int?) == 1,
    );
  }
}

@immutable
class AmooMirrorMessage {
  const AmooMirrorMessage({
    required this.id,
    required this.sessionId,
    this.parentId,
    required this.timestamp,
    required this.role,
    this.blocks = const <AmooMirrorBlock>[],
  });

  final String id;

  /// Not on the wire — it is the path parameter of the request that carried it.
  final String sessionId;

  /// Branch lineage is kept but never rendered as a tree (linear by timestamp).
  final String? parentId;

  /// epoch ms
  final int timestamp;
  final AmooMirrorRole role;
  final List<AmooMirrorBlock> blocks;

  /// Returns null when: id missing/empty, timestamp not a number, role
  /// unparseable, or the blocks key is missing / [parseAmooMirrorBlocks] says null.
  static AmooMirrorMessage? fromJson(Object? raw, {required String sessionId}) {
    if (raw is! Map) return null;
    final id = raw['id'];
    if (id is! String || id.isEmpty) return null;
    final timestamp = raw['timestamp'];
    if (timestamp is! num) return null;
    final role = AmooMirrorRole.parse(raw['role']);
    if (role == null) return null;
    if (!raw.containsKey('blocks')) return null;
    final blocks = parseAmooMirrorBlocks(raw['blocks']);
    if (blocks == null) return null;
    final parentId = raw['parentId'];
    return AmooMirrorMessage(
      id: id,
      sessionId: sessionId,
      parentId: parentId is String && parentId.isNotEmpty ? parentId : null,
      timestamp: timestamp.toInt(),
      role: role,
      blocks: blocks,
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'parentId': parentId,
        'timestamp': timestamp,
        'role': role.wire,
        'blocks': <Map<String, Object?>>[for (final b in blocks) b.toJson()],
      };

  /// The blocks column stores the server's original JSON text; sanitizing happens
  /// at render time, so the DB keeps the un-redacted原文 (the mirror is a cache
  /// of what amoo said, not an edited copy).
  Map<String, Object?> toRow() => <String, Object?>{
        'session_id': sessionId,
        'message_id': id,
        'parent_id': parentId,
        'timestamp': timestamp,
        'role': role.wire,
        'blocks': jsonEncode(<Map<String, Object?>>[
          for (final b in blocks) b.toJson()
        ]),
      };

  /// Bad blocks JSON text → null (drop the whole row). No fallback to an empty
  /// list — an air bubble would claim amoo replied nothing.
  static AmooMirrorMessage? fromRow(Map<String, Object?> row) {
    final id = row['message_id'];
    if (id is! String || id.isEmpty) return null;
    final sessionId = row['session_id'];
    if (sessionId is! String || sessionId.isEmpty) return null;
    final timestamp = row['timestamp'];
    if (timestamp is! int) return null;
    final role = AmooMirrorRole.parse(row['role']);
    if (role == null) return null;
    final blocksText = row['blocks'];
    if (blocksText is! String) return null;
    final List<AmooMirrorBlock>? blocks;
    try {
      blocks = parseAmooMirrorBlocks(jsonDecode(blocksText));
    } on FormatException {
      return null;
    }
    if (blocks == null) return null;
    final parentId = row['parent_id'];
    return AmooMirrorMessage(
      id: id,
      sessionId: sessionId,
      parentId: parentId is String && parentId.isNotEmpty ? parentId : null,
      timestamp: timestamp,
      role: role,
      blocks: blocks,
    );
  }
}

/// Incremental cursor `<epoch_ms>:<id>`, exclusive.
@immutable
class AmooMirrorCursor {
  const AmooMirrorCursor(this.timestamp, this.id);

  final int timestamp;
  final String id;

  /// Empty/malformed/no-colon/non-numeric timestamp → null (= full re-pull).
  static AmooMirrorCursor? parse(String? raw) {
    if (raw == null) return null;
    final trimmed = raw.trim();
    if (trimmed.isEmpty) return null;
    final sep = trimmed.indexOf(':');
    if (sep <= 0 || sep == trimmed.length - 1) return null;
    final ts = int.tryParse(trimmed.substring(0, sep));
    if (ts == null) return null;
    return AmooMirrorCursor(ts, trimmed.substring(sep + 1));
  }

  @override
  String toString() => '$timestamp:$id';
}

/// Groups sessions by agentKey. Group order is pinned: by the group's newest
/// updatedAt DESC (relies on Dart map literals preserving insertion order —
/// building the map in alphabetical order would also be legal but is NOT this
/// function's contract). Within a group: same order.
Map<String, List<AmooMirrorSession>> groupSessionsByAgent(
    List<AmooMirrorSession> sessions) {
  final groups = <String, List<AmooMirrorSession>>{};
  for (final s in sessions) {
    (groups[s.agentKey] ??= <AmooMirrorSession>[]).add(s);
  }
  for (final list in groups.values) {
    list.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  }
  final keys = groups.keys.toList()
    ..sort((a, b) {
      final byUpdated =
          groups[b]!.first.updatedAt.compareTo(groups[a]!.first.updatedAt);
      // Equal newest-timestamps fall back to the key so the order does not
      // drift with the input order.
      return byUpdated != 0 ? byUpdated : a.compareTo(b);
    });
  return <String, List<AmooMirrorSession>>{
    for (final key in keys) key: groups[key]!,
  };
}

/// Sessions page size. The contract has no total/offset — `hasMore` on the
/// sessions page is a client-side inference (see AmooMirrorApi.fetchSessions).
const int kAmooMirrorSessionsLimit = 50;

/// Messages page size for one incremental pull.
const int kAmooMirrorMessagesLimit = 200;
