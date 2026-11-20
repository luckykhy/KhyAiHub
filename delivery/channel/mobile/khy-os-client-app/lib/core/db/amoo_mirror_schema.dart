/// 库结构。集中一处，迁移时只改这里。
///
/// Why its own DB file instead of folding into amoo_bridge.db: that one records
/// "which questions khy asked amoo" (lib/core/db/amoo_turn_store.dart:38-40) —
/// different ownership and lifecycle (initiating vs a read-only mirror cache).
/// Sharing one file would drag one side into every migration of the other.
///
/// next_cursor is a nullable column on sessions rather than a third table: the
/// cursor is 1:1 with a session, a third table only adds a join; and the upsert
/// path deliberately never updates this column — the cursor is written solely
/// by the message-sync path, so no orphan cursor combinations exist.
/// Semantics: NULL = never synced (full pull); `'<ts>:<id>'` = resume point.
abstract final class AmooMirrorSchema {
  static const String sessionsTable = 'amoo_mirror_sessions';
  static const String messagesTable = 'amoo_mirror_messages';

  static const String dbFileName = 'amoo_mirror.db';

  static const String createSessionsTable = '''
CREATE TABLE IF NOT EXISTS $sessionsTable (
  session_id    TEXT PRIMARY KEY,
  title         TEXT    NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL,
  last_preview  TEXT    NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  agent_key     TEXT    NOT NULL DEFAULT '',
  compacted     INTEGER NOT NULL DEFAULT 0,
  next_cursor   TEXT
)
''';

  /// The list page reads the latest N by updated_at DESC.
  static const String indexSessionsUpdated =
      'CREATE INDEX IF NOT EXISTS idx_${sessionsTable}_updated ON $sessionsTable (updated_at DESC)';

  /// PRIMARY KEY (session_id, message_id) is what makes INSERT OR IGNORE
  /// idempotent; blocks stores the server's original JSON text (sanitizing
  /// happens at render time, so the DB keeps the unedited原文).
  static const String createMessagesTable = '''
CREATE TABLE IF NOT EXISTS $messagesTable (
  session_id TEXT    NOT NULL,
  message_id TEXT    NOT NULL,
  parent_id  TEXT,
  timestamp  INTEGER NOT NULL,
  role       TEXT    NOT NULL,
  blocks     TEXT    NOT NULL,
  PRIMARY KEY (session_id, message_id)
)
''';

  /// The detail page reads one session's messages by timestamp ASC.
  static const String indexMessagesOrder =
      'CREATE INDEX IF NOT EXISTS idx_${messagesTable}_order ON $messagesTable (session_id, timestamp ASC)';

  static const int version = 1;
}
