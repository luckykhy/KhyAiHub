// Knowledge base + session history sources for rag_retrieval.dart, plus the
// one-call assembler the chat screen uses.
//
// Why sqflite for the KB: imported knowledge is structured data that must
// survive restarts and be listed back in settings, and the repo already
// settled on sqflite + hand-written SQL over drift (see the note in
// pubspec.yaml and AmooTurnStore for why drift is not an option here).
//
// Why history reads conversation_db directly: the task spec forbids a second
// store for it. One full pass is unavoidable with the existing API — there
// is no bounded/recency listing, and updatedAt only exists inside the
// conversation itself.
//
// Failure strategy, same as AmooTurnStore: no method throws. Retrieval is a
// gain, not a precondition — a database hiccup must degrade to "no context",
// never break a chat send. Every failure logs, because a silently dead
// persistence layer and a working one look identical on screen.
import 'dart:convert';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import 'app_logger.dart';
import 'conversation_db.dart';
import 'rag_retrieval.dart';

abstract final class KnowledgeSchema {
  static const String table = 'knowledge';

  static const String createTable = '''
CREATE TABLE IF NOT EXISTS $table (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL,
  keywords   TEXT    NOT NULL DEFAULT '[]',
  category   TEXT    NOT NULL DEFAULT '',
  source     TEXT    NOT NULL DEFAULT 'learned',
  ts         INTEGER NOT NULL
)
''';

  /// Both the settings list and the retrieval fetch read newest-first, so
  /// neither should be a full table scan.
  static const String indexTs =
      'CREATE INDEX IF NOT EXISTS idx_${table}_ts ON $table (ts DESC)';

  static const int version = 1;
}

/// One knowledge row. [keywords] is stored as a JSON array text: keywords
/// may contain commas, so a joined string would need an escape rule nobody
/// could audit by eye in a sqlite shell.
class KnowledgeEntry {
  final int? id;
  final String title;
  final String content;
  final List<String> keywords;
  final String category;
  final String source;

  /// epoch ms
  final int ts;

  const KnowledgeEntry({
    this.id,
    required this.title,
    required this.content,
    this.keywords = const <String>[],
    this.category = '',
    this.source = 'learned',
    required this.ts,
  });

  /// Import-path normalization: trim everything, drop blank keywords. Blank
  /// keywords would inflate the keyword-score denominator (the platform
  /// counts them in `base`) without ever contributing a hit.
  factory KnowledgeEntry.fromImport({
    required String title,
    required String content,
    List<String> keywords = const <String>[],
    String category = '',
    String source = 'learned',
    int? ts,
  }) {
    final cleanSource = source.trim();
    return KnowledgeEntry(
      title: title.trim(),
      content: content.trim(),
      keywords: keywords
          .map((k) => k.trim())
          .where((k) => k.isNotEmpty)
          .toList(growable: false),
      category: category.trim(),
      source: cleanSource.isEmpty ? 'learned' : cleanSource,
      ts: ts ?? DateTime.now().millisecondsSinceEpoch,
    );
  }

  Map<String, Object?> toRow() => <String, Object?>{
        'id': id,
        'title': title,
        'content': content,
        'keywords': jsonEncode(keywords),
        'category': category,
        'source': source,
        'ts': ts,
      };

  static KnowledgeEntry fromRow(Map<String, Object?> row) {
    return KnowledgeEntry(
      id: row['id'] as int?,
      title: (row['title'] as String?) ?? '',
      content: (row['content'] as String?) ?? '',
      // Type-checked, not cast: the value sits in sqlite and may be
      // hand-edited or written by a future version, and a hard cast would
      // throw through the read path into the chat send. A row with broken
      // keywords still retrieves — keywords are one score term, not the row.
      keywords: _decodeKeywords(row['keywords']),
      category: (row['category'] as String?) ?? '',
      source: (row['source'] as String?) ?? 'learned',
      ts: (row['ts'] as int?) ?? 0,
    );
  }

  static List<String> _decodeKeywords(Object? raw) {
    if (raw is! String || raw.isEmpty) return const <String>[];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const <String>[];
      return decoded.whereType<String>().toList(growable: false);
    } catch (_) {
      return const <String>[];
    }
  }

  /// Retrieval's view of this row.
  KnowledgeItem toItem() => KnowledgeItem(
        title: title,
        content: content,
        keywords: keywords,
        category: category,
        source: source,
      );
}

class KnowledgeStore {
  KnowledgeStore._();
  static final KnowledgeStore instance = KnowledgeStore._();

  static final _log = AppLogger();

  Database? _db;
  bool _broken = false;

  /// Newest-first fetch bound for one retrieval pass. The scorer is O(rows)
  /// in Dart with no FTS prefilter (the platform's sessionSearchIndex does
  /// that job there), so the bound lives here rather than in the caller and
  /// cannot desync from the scorer.
  static const int _retrievalScanLimit = 500;

  /// Opening failed once means unavailable for this run. No retry on the chat
  /// send path: a disk or permission problem would turn every retry into a
  /// longer stall instead of a recovery.
  Future<Database?> _database() async {
    if (_broken) return null;
    if (_db != null) return _db;
    try {
      final dir = await getApplicationDocumentsDirectory();
      final db = await openDatabase(
        p.join(dir.path, 'knowledge.db'),
        version: KnowledgeSchema.version,
        onCreate: (db, version) async {
          await db.execute(KnowledgeSchema.createTable);
          await db.execute(KnowledgeSchema.indexTs);
        },
      );
      _db = db;
      return db;
    } catch (e, st) {
      _broken = true;
      _log.e(LogCategory.system, '知识库打开失败，本次运行检索不可用',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return null;
    }
  }

  /// Import one entry. Returns the new row id, or -1 when the content is
  /// empty or the write failed — the caller (kb_import tool, settings import
  /// entry) must say "没存进去" rather than assume success.
  Future<int> import(
    String title,
    String content, {
    List<String> keywords = const <String>[],
    String category = '',
    String source = 'learned',
  }) async {
    final entry = KnowledgeEntry.fromImport(
      title: title,
      content: content,
      keywords: keywords,
      category: category,
      source: source,
    );
    if (entry.content.isEmpty) return -1;
    final db = await _database();
    if (db == null) return -1;
    try {
      return await db.insert(KnowledgeSchema.table, entry.toRow());
    } catch (e, st) {
      _log.e(LogCategory.system, '知识库导入失败，这一条没有存进去',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return -1;
    }
  }

  /// Scored knowledge candidates for one query — what the kb_search tool
  /// shows. Empty on any failure: retrieval without the KB is still
  /// retrieval.
  Future<List<KnowledgeCandidate>> candidates(
    String query, {
    int limit = defaultKnowledgeTopK,
  }) async {
    final items = await itemsForRetrieval();
    if (items.isEmpty) return const <KnowledgeCandidate>[];
    return scoreKnowledge(query, items, limit: limit);
  }

  /// Bounded raw items for one retrieval pass.
  Future<List<KnowledgeItem>> itemsForRetrieval() async {
    final rows = await recent(limit: _retrievalScanLimit);
    if (rows.isEmpty) return const <KnowledgeItem>[];
    return rows.map((row) => row.toItem()).toList(growable: false);
  }

  /// Newest first. Also the settings list's data source.
  Future<List<KnowledgeEntry>> recent({int limit = 100}) async {
    final db = await _database();
    if (db == null) return const <KnowledgeEntry>[];
    try {
      final rows = await db.query(
        KnowledgeSchema.table,
        orderBy: 'ts DESC, id DESC',
        limit: limit,
      );
      return rows.map(KnowledgeEntry.fromRow).toList(growable: false);
    } catch (e, st) {
      _log.w(LogCategory.system, '知识库读取失败，本次返回空列表',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return const <KnowledgeEntry>[];
    }
  }

  /// Delete one entry. Without this the only correction for a bad import is
  /// dropping the whole KB, which no user will do to remove one row.
  Future<bool> delete(int id) async {
    final db = await _database();
    if (db == null) return false;
    try {
      final removed = await db.delete(
        KnowledgeSchema.table,
        where: 'id = ?',
        whereArgs: <Object>[id],
      );
      return removed > 0;
    } catch (e, st) {
      _log.w(LogCategory.system, '知识库删除失败，该条仍在库中',
          details: <String, dynamic>{'id': id, 'error': '$e'},
          error: e,
          stackTrace: st);
      return false;
    }
  }

  /// Close. Only for tests and app shutdown.
  Future<void> close() async {
    await _db?.close();
    _db = null;
  }
}

/// Session history as the second retrieval source.
class SessionHistorySource {
  SessionHistorySource._();
  static final SessionHistorySource instance = SessionHistorySource._();

  static final _log = AppLogger();

  /// Bound on how many of the newest messages get scored. Without the
  /// platform's FTS prefilter every message must be tokenized in Dart; 300
  /// recent messages covers weeks of chat and keeps one query bounded.
  static const int _maxScannedMessages = 300;

  /// Bounded raw rows, newest message first.
  Future<List<SessionRow>> recentRows() async {
    try {
      final ids = await ConversationDB.listIds();
      final rows = <SessionRow>[];
      for (final id in ids) {
        final conv = await ConversationDB.load(id);
        if (conv == null) continue;
        rows.addAll(rowsOf(conv));
      }
      rows.sort((a, b) => b.timestamp.compareTo(a.timestamp));
      return rows.take(_maxScannedMessages).toList(growable: false);
    } catch (e, st) {
      // ConversationDB reads secure storage and jsonDecodes what it finds;
      // one corrupt conversation must not take the chat send down with it.
      _log.w(LogCategory.system, '历史会话读取失败，本次检索只用知识库',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return const <SessionRow>[];
    }
  }

  /// Messages of one conversation as retrieval rows. Pure — the IO sits in
  /// [recentRows] — so the mapping is testable without secure storage.
  static List<SessionRow> rowsOf(Conversation conv) {
    final rows = <SessionRow>[];
    for (final msg in conv.messages) {
      final content = msg.content.trim();
      if (content.isEmpty) continue;
      rows.add(SessionRow(
        sessionId: conv.id,
        title: conv.title,
        role: msg.role,
        content: content,
        timestamp: msg.timestamp.millisecondsSinceEpoch,
      ));
    }
    return rows;
  }
}

/// One call for the chat screen: skip rules first (cheap), then both sources,
/// then the pure fusion. Both sources are contracted never to throw, so the
/// two futures below can be started together and awaited in sequence without
/// an unhandled-error path.
class RagRetriever {
  RagRetriever._();
  static final RagRetriever instance = RagRetriever._();

  Future<RagResult> retrieve(
    String query, {
    bool isFollowUp = false,
    bool enabled = true,
    int knowledgeTopK = defaultKnowledgeTopK,
    int sessionTopK = defaultSessionTopK,
    int totalTopK = defaultTotalTopK,
    int maxContextChars = defaultMaxContextChars,
    DateTime? now,
  }) async {
    if (!shouldRetrieve(query, isFollowUp: isFollowUp, enabled: enabled)) {
      return const RagResult.skipped();
    }
    final knowledgeFuture = KnowledgeStore.instance.itemsForRetrieval();
    final sessionFuture = SessionHistorySource.instance.recentRows();
    final knowledge = await knowledgeFuture;
    final sessions = await sessionFuture;
    return buildRetrievalContext(
      query,
      knowledge: knowledge,
      sessions: sessions,
      isFollowUp: isFollowUp,
      enabled: enabled,
      knowledgeTopK: knowledgeTopK,
      sessionTopK: sessionTopK,
      totalTopK: totalTopK,
      maxContextChars: maxContextChars,
      now: now,
    );
  }
}
