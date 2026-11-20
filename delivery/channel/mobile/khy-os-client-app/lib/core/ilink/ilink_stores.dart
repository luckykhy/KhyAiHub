// Storage leaves for the ilink channel, mirroring the Node store split:
//
//   credentials  → FlutterSecureStorage, one key, whole-account JSON blob
//                  (same pattern as AppConfig in app_config.dart:246-289)
//   cursor       → docs/ilink/cursor.json        (high-frequency: every poll)
//   ctx tokens   → docs/ilink/context_tokens.json (per inbound message)
//
// Why the split (carried over from ilinkAccountStore.js:6-12): mixing the
// cursor with credentials would rewrite long-lived credentials every ~35s,
// needlessly widening the corruption window for the credential blob.
//
// Contract: read failures return empty; write failures are swallowed
// (fail-soft) — a lost cursor means one duplicated poll round at worst (the
// dedupe catches it), never a crashed channel.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Account blob saved after a confirmed QR login. baseUrl stays empty when the
/// server-sent value failed the trust check — IlinkApi then uses its default.
class IlinkAccount {
  const IlinkAccount({
    required this.botToken,
    required this.accountId,
    required this.userId,
    required this.baseUrl,
    required this.firstBoundAt,
  });

  final String botToken;
  final String accountId;
  final String userId;
  final String baseUrl;
  final String firstBoundAt;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'botToken': botToken,
        'accountId': accountId,
        'userId': userId,
        'baseUrl': baseUrl,
        'firstBoundAt': firstBoundAt,
      };

  static IlinkAccount? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final token = raw['botToken'];
    final accountId = raw['accountId'];
    final userId = raw['userId'];
    if (token is! String || token.isEmpty) return null;
    if (accountId is! String || accountId.isEmpty) return null;
    if (userId is! String || userId.isEmpty) return null;
    return IlinkAccount(
      botToken: token,
      accountId: accountId,
      userId: userId,
      baseUrl: raw['baseUrl'] is String ? raw['baseUrl'] as String : '',
      firstBoundAt: raw['firstBoundAt'] is String ? raw['firstBoundAt'] as String : '',
    );
  }
}

/// Credentials only touch disk on scan/logout (low-frequency).
class IlinkAccountStore {
  IlinkAccountStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  static const String _key = 'ilink_account';
  final FlutterSecureStorage _storage;

  Future<IlinkAccount?> load() async {
    try {
      final raw = await _storage.read(key: _key);
      if (raw == null) return null;
      return IlinkAccount.fromJson(jsonDecode(raw));
    } catch (_) {
      return null;
    }
  }

  Future<void> save(IlinkAccount account) async {
    await _storage.write(key: _key, value: jsonEncode(account.toJson()));
  }

  Future<void> clear() async {
    try {
      await _storage.delete(key: _key);
    } catch (_) {}
  }
}

/// JSON file KV keyed by accountId, atomic-replace via tmp+rename (same shape
/// as ilinkCursorStore.js:33-43).
class IlinkJsonFileStore {
  IlinkJsonFileStore(this.file);

  final File file;

  Map<String, dynamic> _readRaw() {
    try {
      if (!file.existsSync()) return <String, dynamic>{};
      final decoded = jsonDecode(file.readAsStringSync());
      if (decoded is Map) {
        return Map<String, dynamic>.from(decoded);
      }
    } catch (_) {}
    return <String, dynamic>{};
  }

  /// writeFileSync(tmp) + renameSync equivalent. Returns false on failure —
  /// callers treat that as "next round may duplicate", never as fatal.
  bool _writeRaw(Map<String, dynamic> all) {
    try {
      final dir = file.parent;
      if (!dir.existsSync()) {
        dir.createSync(recursive: true);
      }
      final tmp = File('${file.path}.${DateTime.now().microsecondsSinceEpoch}.tmp');
      tmp.writeAsStringSync(jsonEncode(all), flush: true);
      tmp.renameSync(file.path);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Root-level access for stores whose shape does not fit the
  /// bucket→key→value form (the peer allowlist keeps its own nested layout).
  Map<String, dynamic> readRoot() => _readRaw();

  bool writeRoot(Map<String, dynamic> all) => _writeRaw(all);

  String? getString(String bucket, String key) {
    if (key.isEmpty) return null;
    final v = _readRaw()[bucket];
    if (v is! Map) return null;
    final s = v[key];
    return s is String ? s : null;
  }

  bool setString(String bucket, String key, String? value) {
    if (key.isEmpty) return false;
    final all = _readRaw();
    final b = all[bucket];
    final map = b is Map ? Map<String, dynamic>.from(b) : <String, dynamic>{};
    if (value == null || value.isEmpty) {
      map.remove(key);
    } else {
      map[key] = value;
    }
    if (map.isEmpty) {
      all.remove(bucket);
    } else {
      all[bucket] = map;
    }
    return _writeRaw(all);
  }

  Map<String, String> getNested(String bucket) {
    final v = _readRaw()[bucket];
    if (v is! Map) return <String, String>{};
    return v.map((k, value) => MapEntry(k.toString(), value is String ? value : ''));
  }

  bool setNested(String bucket, String key, String? value) {
    if (key.isEmpty) return false;
    final all = _readRaw();
    final b = all[bucket];
    final outer = b is Map ? Map<String, dynamic>.from(b) : <String, dynamic>{};
    if (value == null || value.isEmpty) {
      outer.remove(key);
    } else {
      outer[key] = value;
    }
    if (outer.isEmpty) {
      all.remove(bucket);
    } else {
      all[bucket] = outer;
    }
    return _writeRaw(all);
  }
}

/// getupdates cursor store. High-frequency write (one per poll round).
class IlinkCursorStore {
  IlinkCursorStore(this._file);

  final IlinkJsonFileStore _file;

  Future<String> get(String accountId) async =>
      _file.getString('cursors', accountId) ?? '';

  Future<void> set(String accountId, String buf) async {
    _file.setString('cursors', accountId, buf);
  }
}

/// context_token store: the inbound token required by any proactive send.
/// Survives process restarts; lost tokens only downgrade proactive pushes.
class IlinkContextTokenStore {
  IlinkContextTokenStore(this._file);

  final IlinkJsonFileStore _file;

  Future<String> get(String accountId, String userId) async =>
      _file.getString(accountId, userId) ?? '';

  Future<void> set(String accountId, String userId, String token) async {
    _file.setString(accountId, userId, token);
  }
}

/// Resolve the docs/ilink directory holding the channel's file KV. The
/// directory parameter is injected so tests can point at a temp dir without
/// the path_provider plugin.
IlinkJsonFileStore ilinkFileStore(String docsDir, String fileName) =>
    IlinkJsonFileStore(File('$docsDir/ilink/$fileName'));
