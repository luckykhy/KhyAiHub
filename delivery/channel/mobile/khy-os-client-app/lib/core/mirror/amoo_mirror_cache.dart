import 'amoo_mirror_models.dart';

/// The cache seam as the synchronizer sees it. [AmooMirrorStore] is the only
/// implementation; tests hand in an in-memory fake.
///
/// The entire local write surface of the read-only mirror converges on these
/// eight methods — there is deliberately no delete method anywhere: a failed
/// re-pull must never be able to shorten history (the 409 re-pull keeps every
/// local row).
///
/// **Implementation-side must-read: an abstract method's default value has to
/// be repeated in the implementing class.** Verified with dart.exe: abstract
/// `load({int limit = 50})` + implementation written as `{int limit}` →
/// error missing_default_value_for_parameter. Call sites without the argument
/// compile either way (no ambiguity there), but the three implementations —
/// AmooMirrorStore, the sync test's in-memory fake, the screens test's fake —
/// each need the repeated default; miss one and it fails to compile inside
/// someone else's file.
abstract class AmooMirrorCache {
  /// Newest first (updated_at DESC).
  Future<List<AmooMirrorSession>> loadSessions(
      {int limit = kAmooMirrorSessionsLimit});

  Future<AmooMirrorSession?> loadSession(String sessionId);

  /// ON CONFLICT(session_id) DO UPDATE touches the list columns only; it
  /// deliberately does NOT touch next_cursor (the cursor is written solely by
  /// the message-sync path).
  Future<void> upsertSessions(List<AmooMirrorSession> sessions);

  /// null = this session's messages were never synced (full pull).
  Future<String?> loadCursor(String sessionId);

  Future<void> saveCursor(String sessionId, String? cursor);

  /// INSERT OR IGNORE; returns the number of rows ACTUALLY added — the
  /// observable evidence of idempotency.
  Future<int> insertMessages(
      String sessionId, List<AmooMirrorMessage> messages);

  /// timestamp ASC, message_id ASC. Rows whose [AmooMirrorMessage.fromRow]
  /// returns null are skipped with one log line — no air bubbles.
  Future<List<AmooMirrorMessage>> loadMessages(String sessionId);

  /// Lets the UI tell "the persistence layer is broken" from "there is really
  /// no data" (same reason as lib/core/services/usage_ledger.dart:33).
  bool get isAvailable;
}
