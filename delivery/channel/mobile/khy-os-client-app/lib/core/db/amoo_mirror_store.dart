import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import '../mirror/amoo_mirror_cache.dart';
import '../mirror/amoo_mirror_models.dart';
import '../services/app_logger.dart';
import 'amoo_mirror_schema.dart';

/// The mirror's local cache. Sole implementation of AmooMirrorCache.
///
/// Failure strategy copied from AmooTurnStore (lib/core/db/amoo_turn_store.dart:19-21,
/// :31-33): no method throws (the caller is the sync loop and the UI), but every
/// failure leaves a log line — a silently dead persistence layer and a working
/// one look identical on screen, which is exactly the bug that is hardest to
/// find.
///
/// Read-only mirror discipline: there is no delete anywhere. A failed re-pull
/// must never be able to shorten what the user can still read from cache.
class AmooMirrorStore implements AmooMirrorCache {
  AmooMirrorStore._();
  static final AmooMirrorStore instance = AmooMirrorStore._();

  static final _log = AppLogger();

  Database? _db;
  bool _broken = false;

  @override
  bool get isAvailable => !_broken;

  /// Opening fails once → marked unusable, every later call no-ops.
  /// Why no retry: a failed open is disk or permissions, and retrying on the
  /// UI polling path only amplifies a stutter into a freeze.
  Future<Database?> _database() async {
    if (_broken) return null;
    if (_db != null) return _db;
    try {
      final dir = await getApplicationDocumentsDirectory();
      final db = await openDatabase(
        p.join(dir.path, AmooMirrorSchema.dbFileName),
        version: AmooMirrorSchema.version,
        onOpen: (db) async {
          await db.execute(AmooMirrorSchema.indexSessionsUpdated);
          await db.execute(AmooMirrorSchema.indexMessagesOrder);
        },
        onCreate: (db, version) async {
          await db.execute(AmooMirrorSchema.createSessionsTable);
          await db.execute(AmooMirrorSchema.createMessagesTable);
          await db.execute(AmooMirrorSchema.indexSessionsUpdated);
          await db.execute(AmooMirrorSchema.indexMessagesOrder);
        },
      );
      _db = db;
      return db;
    } catch (e, st) {
      _broken = true;
      _log.e(LogCategory.system, 'amoo 镜像库打开失败，本次运行缓存不可用',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return null;
    }
  }

  @override
  Future<List<AmooMirrorSession>> loadSessions(
      {int limit = kAmooMirrorSessionsLimit}) async {
    final db = await _database();
    if (db == null) return const <AmooMirrorSession>[];
    try {
      final rows = await db.query(
        AmooMirrorSchema.sessionsTable,
        orderBy: 'updated_at DESC',
        limit: limit,
      );
      final sessions = <AmooMirrorSession>[];
      for (final row in rows) {
        final session = AmooMirrorSession.fromRow(row);
        if (session != null) sessions.add(session);
      }
      return sessions;
    } catch (e, st) {
      _log.w(LogCategory.system, 'amoo 镜像会话列表读取失败，本次返回空列表',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return const <AmooMirrorSession>[];
    }
  }

  @override
  Future<AmooMirrorSession?> loadSession(String sessionId) async {
    final db = await _database();
    if (db == null) return null;
    try {
      final rows = await db.query(
        AmooMirrorSchema.sessionsTable,
        where: 'session_id = ?',
        whereArgs: <Object>[sessionId],
        limit: 1,
      );
      if (rows.isEmpty) return null;
      return AmooMirrorSession.fromRow(rows.first);
    } catch (e, st) {
      _log.w(LogCategory.system, 'amoo 镜像单会话读取失败',
          details: <String, dynamic>{'session_id': sessionId, 'error': '$e'},
          error: e, stackTrace: st);
      return null;
    }
  }

  @override
  Future<void> upsertSessions(List<AmooMirrorSession> sessions) async {
    if (sessions.isEmpty) return;
    final db = await _database();
    if (db == null) return;
    try {
      for (final session in sessions) {
        final row = session.toRow();
        final updated = await db.update(
          AmooMirrorSchema.sessionsTable,
          row,
          where: 'session_id = ?',
          whereArgs: <Object>[session.id],
        );
        if (updated == 0) {
          await db.insert(
            AmooMirrorSchema.sessionsTable,
            row,
            conflictAlgorithm: ConflictAlgorithm.ignore,
          );
        }
      }
    } catch (e, st) {
      // A lost merge round is recoverable (the next pull re-fetches), but it
      // must not be silent: the list would quietly show stale data.
      _log.w(LogCategory.system, 'amoo 镜像会话合并失败，本轮列表可能不是最新',
          details: <String, dynamic>{'count': sessions.length, 'error': '$e'},
          error: e, stackTrace: st);
    }
  }

  @override
  Future<String?> loadCursor(String sessionId) async {
    final db = await _database();
    if (db == null) return null;
    try {
      final rows = await db.query(
        AmooMirrorSchema.sessionsTable,
        columns: <String>['next_cursor'],
        where: 'session_id = ?',
        whereArgs: <Object>[sessionId],
        limit: 1,
      );
      if (rows.isEmpty) return null;
      final cursor = rows.first['next_cursor'];
      return cursor is String && cursor.isNotEmpty ? cursor : null;
    } catch (e, st) {
      _log.w(LogCategory.system, 'amoo 镜像游标读取失败，按全量重拉处理',
          details: <String, dynamic>{'session_id': sessionId, 'error': '$e'},
          error: e, stackTrace: st);
      return null;
    }
  }

  @override
  Future<void> saveCursor(String sessionId, String? cursor) async {
    final db = await _database();
    if (db == null) return;
    try {
      final updated = await db.update(
        AmooMirrorSchema.sessionsTable,
        <String, Object?>{'next_cursor': cursor},
        where: 'session_id = ?',
        whereArgs: <Object>[sessionId],
      );
      if (updated == 0) {
        // No stub row is inserted on purpose: a titleless row would surface in
        // the list as a blank session. Losing the cursor only costs one full
        // re-pull, and INSERT OR IGNORE makes that re-pull harmless.
        _log.w(LogCategory.system, 'amoo 镜像游标写入落空：会话行不存在',
            details: <String, dynamic>{'session_id': sessionId});
      }
    } catch (e, st) {
      _log.w(LogCategory.system, 'amoo 镜像游标写入失败，下次将全量重拉',
          details: <String, dynamic>{'session_id': sessionId, 'error': '$e'},
          error: e, stackTrace: st);
    }
  }

  @override
  Future<int> insertMessages(
      String sessionId, List<AmooMirrorMessage> messages) async {
    if (messages.isEmpty) return 0;
    final db = await _database();
    if (db == null) return 0;
    try {
      // Why select-then-insert instead of trusting the rawInsert rowid: sqflite
      // hands back whatever SQLiteStatement.executeInsert() returned
      // (sqflite_android-2.4.5 android/src/main/java/com/tekartik/sqflite/
      // Database.java:657-679), and that API's contract only defines the
      // inserted case — what an INSERT OR IGNORE that ignored yields is not
      // something to bet the "actually added" count on. One IN-query per page
      // is exact and 200 ids is far under SQLite's host-parameter ceiling.
      final existing = await db.query(
        AmooMirrorSchema.messagesTable,
        columns: <String>['message_id'],
        where: 'session_id = ? AND message_id IN (${_placeholders(messages.length)})',
        whereArgs: <Object>[
          sessionId,
          for (final m in messages) m.id,
        ],
      );
      final known = existing
          .map((row) => row['message_id'])
          .whereType<String>()
          .toSet();
      var added = 0;
      for (final message in messages) {
        if (known.contains(message.id)) continue;
        await db.insert(
          AmooMirrorSchema.messagesTable,
          message.toRow(),
          conflictAlgorithm: ConflictAlgorithm.ignore,
        );
        added++;
      }
      return added;
    } catch (e, st) {
      _log.w(LogCategory.system, 'amoo 镜像消息写入失败，本轮增量未落库',
          details: <String, dynamic>{
            'session_id': sessionId,
            'count': messages.length,
            'error': '$e',
          },
          error: e, stackTrace: st);
      return 0;
    }
  }

  @override
  Future<List<AmooMirrorMessage>> loadMessages(String sessionId) async {
    final db = await _database();
    if (db == null) return const <AmooMirrorMessage>[];
    try {
      final rows = await db.query(
        AmooMirrorSchema.messagesTable,
        where: 'session_id = ?',
        whereArgs: <Object>[sessionId],
        orderBy: 'timestamp ASC, message_id ASC',
      );
      final messages = <AmooMirrorMessage>[];
      for (final row in rows) {
        final message = AmooMirrorMessage.fromRow(row);
        if (message == null) {
          // One unreadable row is skipped, not rendered as an air bubble and
          // not thrown away wholesale (same boundary as
          // lib/core/db/amoo_turn.dart:66-68).
          _log.w(LogCategory.system, 'amoo 镜像消息行无法解析，已跳过',
              details: <String, dynamic>{
                'session_id': sessionId,
                'message_id': '${row['message_id']}',
              });
          continue;
        }
        messages.add(message);
      }
      return messages;
    } catch (e, st) {
      _log.w(LogCategory.system, 'amoo 镜像消息读取失败，本次返回空列表',
          details: <String, dynamic>{'session_id': sessionId, 'error': '$e'},
          error: e, stackTrace: st);
      return const <AmooMirrorMessage>[];
    }
  }

  /// Close. Tests only (same discipline as amoo_turn_store.dart:201-205).
  Future<void> close() async {
    await _db?.close();
    _db = null;
  }
}

String _placeholders(int count) =>
    List<String>.filled(count, '?').join(', ');
