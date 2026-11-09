import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:meta/meta.dart';
import 'package:uuid/uuid.dart';

import '../services/app_logger.dart';

/// Local memory store — the client half of the platform's memory engine.
///
/// WHY THIS EXISTS. The engine itself lives in the backend
/// (`services/domain/memory/memoryEngine`, `memoryTier`, `distiller`,
/// `services/memoryDreaming`), and until now no client surfaced it: the Web
/// memory card is a dead prop and the desktop only has CRUD. This file plus
/// `memory_recall.dart` / `memory_distiller.dart` / `memory_dreaming.dart` are
/// that client half — same semantics, ported, and running in parallel rather
/// than merged. `AmooMemory.json` (android `bridge/AmooMemory.java`, the 60-fact
/// file the desktop `amooSecretary.ts` and `AmooSecretaryMemory.tsx` consume) is
/// untouched and stays the only thing those two read.
///
/// WHY FlutterSecureStorage AND NOT sqflite. Both patterns already exist here
/// (`db/amoo_turn_store.dart` uses sqflite, `services/conversation_db.dart` uses
/// secure storage); this follows the second one because the record set is small
/// (tens of short documents), every read is "load them all and score in Dart",
/// and — decisively — sqflite needs a sqlite3.dll that this project's hosts do
/// not have, which is why `test/amoo_turn_test.dart` can only cover the pure half
/// of that store. Key-per-entry plus an index key is the same shape
/// `ConversationDB` already established, so there is no second storage engine to
/// reason about and the whole store is unit-testable off-device.
///
/// FAILURE POLICY. Nothing throws. A caller here is a UI list or a prompt
/// assembly path, and one storage hiccup must not take the screen down. Every
/// failure leaves a log line instead — a silently broken persistence layer and a
/// working one look identical on screen, which is the hardest kind of bug to
/// find.

/// Memory kind — the closed set behind memdir's frontmatter `type`.
///
/// Ported from the platform's `VALID_TYPES` so a memory written here means what
/// one written by `memdir.saveMemory` means. Adding a value here without adding
/// it there would quietly split the two stores.
enum MemoryType {
  user('user', '用户画像'),
  feedback('feedback', '协作偏好'),
  project('project', '项目背景'),
  reference('reference', '外部资源');

  const MemoryType(this.wire, this.label);

  final String wire;

  /// Chinese label for the recall box and the settings list.
  final String label;

  /// Parse a persisted `type`. Anything unreadable becomes [user].
  ///
  /// Failing toward retention is deliberate: [user] derives the permanent tier,
  /// so a mistyped record can never turn into a forget-eligible one. The other
  /// direction — guessing `reference` — is the one mistake that destroys data.
  static MemoryType parse(String? raw) {
    for (final v in MemoryType.values) {
      if (v.wire == raw) return v;
    }
    return MemoryType.user;
  }
}

/// Retention tier — the axis orthogonal to [MemoryType].
///
/// Ported from `services/memoryTier.js`. The invariant that matters: [permanent]
/// is never automatically forgotten. Anything else may be archived by the
/// distiller, by dreaming dedup, or by the user, and archiving is always
/// reversible (see [MemoryStore.restore]).
enum MemoryTier {
  shortTerm('short_term', '短期'),
  crossSession('cross_session', '跨会话'),
  permanent('permanent', '永久');

  const MemoryTier(this.wire, this.label);

  final String wire;

  /// Chinese badge for the settings list and the recall box.
  final String label;

  /// Null when the value is not one of the three tiers — the caller then omits
  /// the key rather than writing a bogus one.
  static MemoryTier? parse(String? raw) {
    for (final v in MemoryTier.values) {
      if (v.wire == raw) return v;
    }
    return null;
  }

  /// Tier for a memory that carries no explicit `tier`.
  ///
  /// `user` → permanent: an identity is not something time should wash away.
  /// Everything else → cross_session. No type derives to short_term — a memory
  /// that reached disk is by definition not session-only, so short_term can only
  /// be granted explicitly.
  static MemoryTier fromType(MemoryType type) =>
      type == MemoryType.user ? MemoryTier.permanent : MemoryTier.crossSession;

  /// One step up; already at the top ⇒ unchanged. Promotion is one-way, which is
  /// why [MemoryEntry.copyWith] has no way to clear a tier.
  MemoryTier get next => switch (this) {
        MemoryTier.shortTerm => MemoryTier.crossSession,
        MemoryTier.crossSession => MemoryTier.permanent,
        MemoryTier.permanent => MemoryTier.permanent,
      };

  /// Whether the distillation and dreaming layers may archive this tier.
  bool get autoForget => this != MemoryTier.permanent;
}

/// One remembered thing.
///
/// The JSON shape mirrors memdir's frontmatter keys (`name`, `description`,
/// `type`, `tier`, `updated`, `body`) so a record means the same thing on both
/// sides. `id` and `recallCount` are client-side additions: the platform keys its
/// files by filename and counts recalls in the dream store, which has no
/// frontmatter.
@immutable
class MemoryEntry {
  const MemoryEntry({
    required this.id,
    required this.name,
    required this.type,
    required this.body,
    this.description = '',
    this.tier,
    required this.updated,
    this.recallCount = 0,
  });

  /// Stable key. Doubles as the "source" label in the recall box.
  final String id;

  final String name;

  /// One-line summary used for relevance ranking. Falls back to [name] on save,
  /// exactly as memdir does.
  final String description;

  final MemoryType type;

  /// Explicit tier, or null when the writer left it out — readers then derive it
  /// from [type] (see [MemoryTier.fromType]). Written only when set, like
  /// memdir's frontmatter, so a record without it keeps its meaning with no
  /// migration.
  final MemoryTier? tier;

  final String body;

  /// Last write. UTC ISO-8601, the shape the platform's `updated` uses.
  final DateTime updated;

  /// How many times recall surfaced this entry. Feeds the dreaming phases.
  final int recallCount;

  MemoryTier get effectiveTier => tier ?? MemoryTier.fromType(type);

  /// False only for the permanent tier — the hard invariant.
  bool get forgetEligible => effectiveTier.autoForget;

  int get updatedMs => updated.millisecondsSinceEpoch;

  MemoryEntry copyWith({
    String? name,
    String? description,
    MemoryType? type,
    MemoryTier? tier,
    String? body,
    DateTime? updated,
    int? recallCount,
  }) {
    return MemoryEntry(
      id: id,
      name: name ?? this.name,
      description: description ?? this.description,
      type: type ?? this.type,
      tier: tier ?? this.tier,
      body: body ?? this.body,
      updated: updated ?? this.updated,
      recallCount: recallCount ?? this.recallCount,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'description': description,
        'type': type.wire,
        if (tier != null) 'tier': tier!.wire,
        'body': body,
        'updated': updated.toUtc().toIso8601String(),
        'recallCount': recallCount,
      };

  /// Reads back what [toJson] wrote, tolerating hand-edited or half-written
  /// bytes: every field is type-checked instead of cast, because `as String` on
  /// an int would throw and surface as a blank memory list rather than one bad
  /// entry.
  factory MemoryEntry.fromJson(Map<String, dynamic> json) {
    String str(String key) {
      final v = json[key];
      return v is String ? v : '';
    }

    int asInt(String key) {
      final v = json[key];
      return v is num ? v.toInt() : 0;
    }

    final tierRaw = json['tier'];
    return MemoryEntry(
      id: str('id'),
      name: str('name'),
      description: str('description'),
      type: MemoryType.parse(str('type')),
      tier: MemoryTier.parse(tierRaw is String ? tierRaw : null),
      body: str('body'),
      // An unreadable timestamp is treated as just-written, not ancient: the
      // safe direction is over-retention, and a memory nobody can surface is
      // indistinguishable from one that was deleted.
      updated: DateTime.tryParse(str('updated'))?.toUtc() ??
          DateTime.now().toUtc(),
      recallCount: asInt('recallCount'),
    );
  }
}

/// One archived ("forgotten") memory.
///
/// Nothing is ever hard-deleted: a forget moves the entry under an archive key
/// and records it here, so restore is a move back.
@immutable
class MemoryArchiveRecord {
  const MemoryArchiveRecord({
    required this.id,
    required this.archivedAs,
    required this.reason,
    required this.detail,
    required this.type,
    required this.archivedAt,
  });

  /// Original entry id — what [MemoryStore.restore] looks up.
  final String id;

  /// Storage key suffix the entry body lives under. Unique per archive event, so
  /// archiving twice never clobbers the earlier copy.
  final String archivedAs;

  /// Wire reason: 'empty' | 'duplicate' | 'stale' | 'manual'. The caller that
  /// decided to forget owns the vocabulary (see `DistillReason`);
  /// the store only carries it.
  final String reason;

  /// Human-readable, Chinese, composed by that caller — it knows *why* in words.
  final String detail;

  final MemoryType type;
  final DateTime archivedAt;

  Map<String, dynamic> toJson() => {
        'id': id,
        'archivedAs': archivedAs,
        'reason': reason,
        'detail': detail,
        'type': type.wire,
        'archivedAt': archivedAt.toUtc().toIso8601String(),
      };

  factory MemoryArchiveRecord.fromJson(Map<String, dynamic> json) {
    String str(String key) {
      final v = json[key];
      return v is String ? v : '';
    }

    return MemoryArchiveRecord(
      id: str('id'),
      archivedAs: str('archivedAs'),
      reason: str('reason'),
      detail: str('detail'),
      type: MemoryType.parse(str('type')),
      archivedAt:
          DateTime.tryParse(str('archivedAt'))?.toUtc() ?? DateTime.now().toUtc(),
    );
  }
}

/// The store itself.
class MemoryStore {
  MemoryStore._();

  static final MemoryStore instance = MemoryStore._();

  static final _log = AppLogger();
  static const _storage = FlutterSecureStorage();
  static const _uuid = Uuid();

  static const _entryPrefix = 'mem_entry_';
  static const _indexKey = 'mem_index';
  static const _archPrefix = 'mem_arch_';
  static const _archIndexKey = 'mem_arch_index';

  /// Write a new memory and return it.
  Future<MemoryEntry> remember({
    required MemoryType type,
    required String name,
    String description = '',
    required String body,
    MemoryTier? tier,
    DateTime? updated,
  }) async {
    final entry = MemoryEntry(
      id: _newId(type, name),
      name: name,
      description: description,
      type: type,
      tier: tier,
      body: body,
      updated: (updated ?? DateTime.now()).toUtc(),
    );
    await _writeEntry(entry);
    return entry;
  }

  /// Every live memory, newest write first. Never throws: a storage hiccup
  /// yields an empty list plus a log line, because the caller is a UI list and a
  /// blank list is recoverable while a crash is not.
  Future<List<MemoryEntry>> listAll() async {
    final index = await _readIndex();
    if (index.isEmpty) return const <MemoryEntry>[];
    final out = <MemoryEntry>[];
    for (final id in index) {
      final entry = await find(id);
      if (entry != null) out.add(entry);
    }
    out.sort((a, b) => b.updatedMs.compareTo(a.updatedMs));
    return out;
  }

  Future<MemoryEntry?> find(String id) async {
    if (id.isEmpty) return null;
    try {
      final raw = await _storage.read(key: _entryPrefix + id);
      if (raw == null) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      return MemoryEntry.fromJson(decoded);
    } catch (e, st) {
      _log.w(LogCategory.system, '记忆读取失败，这一条按不存在处理',
          details: <String, dynamic>{'id': id, 'error': '$e'},
          error: e,
          stackTrace: st);
      return null;
    }
  }

  /// Overwrite an existing entry.
  ///
  /// An id that is no longer live is dropped rather than re-inserted: the caller
  /// got the entry from [find], so a miss means it was archived meanwhile, and
  /// writing it back would resurrect a forget.
  Future<void> update(MemoryEntry entry) async {
    final live = await find(entry.id);
    if (live == null) {
      _log.w(LogCategory.system, '记忆更新被忽略：条目已不在库中',
          details: <String, dynamic>{'id': entry.id});
      return;
    }
    await _writeEntry(entry);
  }

  /// Count one recall per id. Best-effort — a miss is not an error, the entry may
  /// have been archived between ranking and counting.
  ///
  /// Deliberately does not touch `updated`: a recall is not a write, and letting
  /// it refresh the timestamp would make frequently-recalled old memories look
  /// freshly written and distort both the ranking and the staleness horizon.
  Future<void> noteRecall(List<String> ids) async {
    for (final id in ids) {
      final entry = await find(id);
      if (entry == null) continue;
      await _writeEntry(entry.copyWith(recallCount: entry.recallCount + 1));
    }
  }

  /// Raise one tier (short_term → cross_session → permanent).
  ///
  /// Returns the entry unchanged when it is already permanent, so the UI can say
  /// "已是永久层" without a second lookup, and null when the id is gone.
  Future<MemoryEntry?> promote(String id) async {
    final entry = await find(id);
    if (entry == null) return null;
    final raised = entry.copyWith(tier: entry.effectiveTier.next);
    await _writeEntry(raised);
    return raised;
  }

  /// Archive one entry. Reversible — see [restore].
  ///
  /// Returns the archive record, or null when the entry is gone. A permanent
  /// entry is refused and logged instead of archived: the distiller already
  /// respects that, but this is the last gate before bytes move, and an archived
  /// permanent memory is exactly the silent loss the tier model exists to
  /// prevent.
  Future<MemoryArchiveRecord?> forget(
    String id, {
    required String reason,
    String detail = '',
  }) async {
    final entry = await find(id);
    if (entry == null) return null;
    if (!entry.forgetEligible) {
      _log.w(LogCategory.system, '拒绝归档永久层记忆',
          details: <String, dynamic>{'id': id, 'tier': entry.effectiveTier.wire});
      return null;
    }

    final record = MemoryArchiveRecord(
      id: entry.id,
      archivedAs: '${entry.id}_${_uuid.v4().replaceAll('-', '').substring(0, 8)}',
      reason: reason,
      detail: detail,
      type: entry.type,
      archivedAt: DateTime.now().toUtc(),
    );

    try {
      // Archive first, delete second. A crash in between leaves both copies,
      // which restore refuses to merge (it will not overwrite a live entry) —
      // the opposite order could lose the body outright.
      await _storage.write(
        key: _archPrefix + record.archivedAs,
        value: jsonEncode(entry.toJson()),
      );
      final manifest = await _readArchiveIndex();
      manifest.add(record);
      await _storage.write(
        key: _archIndexKey,
        value: jsonEncode(manifest.map((r) => r.toJson()).toList()),
      );
      await _storage.delete(key: _entryPrefix + entry.id);
      final index = await _readIndex();
      index.remove(entry.id);
      await _writeIndex(index);
    } catch (e, st) {
      _log.e(LogCategory.system, '记忆归档失败，该条仍在库中',
          details: <String, dynamic>{'id': id, 'error': '$e'},
          error: e,
          stackTrace: st);
      return null;
    }
    return record;
  }

  /// Archived memories, newest first.
  Future<List<MemoryArchiveRecord>> listArchived() async {
    final manifest = await _readArchiveIndex();
    manifest.sort((a, b) => b.archivedAt.compareTo(a.archivedAt));
    return manifest;
  }

  /// Move one archived memory back into the live store.
  ///
  /// Null when nothing is archived under that id, or when a live entry already
  /// owns it — the latter keeps its manifest record rather than overwriting a
  /// memory the user wrote since.
  Future<MemoryEntry?> restore(String id) async {
    final manifest = await _readArchiveIndex();
    final at = manifest.indexWhere((r) => r.id == id);
    if (at < 0) return null;
    final record = manifest[at];

    try {
      final raw = await _storage.read(key: _archPrefix + record.archivedAs);
      if (raw == null) {
        _log.w(LogCategory.system, '归档正文缺失，无法恢复',
            details: <String, dynamic>{'id': id, 'archivedAs': record.archivedAs});
        return null;
      }
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final entry = MemoryEntry.fromJson(decoded);
      if (await find(entry.id) != null) {
        _log.w(LogCategory.system, '库中已有同 id 记忆，跳过恢复以免覆盖',
            details: <String, dynamic>{'id': id});
        return null;
      }
      await _writeEntry(entry);
      await _storage.delete(key: _archPrefix + record.archivedAs);
      manifest.removeAt(at);
      await _storage.write(
        key: _archIndexKey,
        value: jsonEncode(manifest.map((r) => r.toJson()).toList()),
      );
      return entry;
    } catch (e, st) {
      _log.e(LogCategory.system, '记忆恢复失败，归档保持不变',
          details: <String, dynamic>{'id': id, 'error': '$e'},
          error: e,
          stackTrace: st);
      return null;
    }
  }

  Future<void> _writeEntry(MemoryEntry entry) async {
    try {
      await _storage.write(
        key: _entryPrefix + entry.id,
        value: jsonEncode(entry.toJson()),
      );
      final index = await _readIndex();
      if (index.contains(entry.id)) return;
      index.add(entry.id);
      await _writeIndex(index);
    } catch (e, st) {
      _log.e(LogCategory.system, '记忆写入失败，这条没有本地记录',
          details: <String, dynamic>{'id': entry.id, 'error': '$e'},
          error: e,
          stackTrace: st);
    }
  }

  Future<List<String>> _readIndex() async {
    try {
      final raw = await _storage.read(key: _indexKey);
      if (raw == null) return <String>[];
      final decoded = jsonDecode(raw);
      // whereType rather than cast: a half-written index should lose the bad
      // entries, not take the whole list down.
      if (decoded is List) return decoded.whereType<String>().toList();
      return <String>[];
    } catch (e, st) {
      _log.w(LogCategory.system, '记忆索引读取失败，本次按空库处理',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return <String>[];
    }
  }

  Future<void> _writeIndex(List<String> ids) async {
    await _storage.write(key: _indexKey, value: jsonEncode(ids));
  }

  Future<List<MemoryArchiveRecord>> _readArchiveIndex() async {
    try {
      final raw = await _storage.read(key: _archIndexKey);
      if (raw == null) return <MemoryArchiveRecord>[];
      final decoded = jsonDecode(raw);
      if (decoded is! List) return <MemoryArchiveRecord>[];
      final out = <MemoryArchiveRecord>[];
      for (final item in decoded) {
        if (item is Map<String, dynamic>) {
          out.add(MemoryArchiveRecord.fromJson(item));
        }
      }
      return out;
    } catch (e, st) {
      _log.w(LogCategory.system, '归档清单读取失败，本次按空归档处理',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return <MemoryArchiveRecord>[];
    }
  }

  /// `<type>_<ascii-slug>_<8 hex>` — memdir's `_safeFilename` shape, so an id
  /// reads like a title in the recall box's "来源" line instead of a uuid.
  static String _newId(MemoryType type, String name) {
    var slug = name
        .toLowerCase()
        .replaceAll(RegExp(r'[^a-z0-9_\-\s]'), '')
        .replaceAll(RegExp(r'\s+'), '_');
    if (slug.length > 40) slug = slug.substring(0, 40);
    slug = slug.replaceAll(RegExp(r'^_+|_+$'), '');
    final rand = _uuid.v4().replaceAll('-', '').substring(0, 8);
    return slug.isEmpty ? '${type.wire}_$rand' : '${type.wire}_${slug}_$rand';
  }
}

/// Tokenize text for recall — a direct port of `memdir._tokenizeForRecall`.
///
/// Latin runs of [a-z0-9] of length ≥ 2, plus every CJK ideograph on its own.
/// There is no word segmentation on either side of the port, which is why the
/// bigram layer in `memory_recall.dart` exists. Lives here because both the
/// recall ranker and the distiller score against it, the same way memdir exports
/// it to both.
Set<String> tokenizeForRecall(String text) {
  final set = <String>{};
  final lower = text.toLowerCase();
  for (final m in RegExp(r'[a-z0-9]+').allMatches(lower)) {
    final token = m.group(0)!;
    if (token.length >= 2) set.add(token);
  }
  for (final m in RegExp(r'[\u4e00-\u9fff]').allMatches(lower)) {
    set.add(m.group(0)!);
  }
  return set;
}
