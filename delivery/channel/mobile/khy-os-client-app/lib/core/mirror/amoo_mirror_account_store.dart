import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

final class AmooMirrorAccount {
  const AmooMirrorAccount({
    required this.baseUrl,
    required this.deviceToken,
    required this.pairedAt,
  });

  final String baseUrl;
  final String deviceToken;

  /// epoch ms. **Not part of the pairing judgement** — the gate looks only at
  /// whether a token exists; pairedAt=0 is not an unpairing.
  final int pairedAt;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'baseUrl': baseUrl,
        'deviceToken': deviceToken,
        'pairedAt': pairedAt,
      };

  /// A missing token = unpaired (same judgement as
  /// lib/core/ilink/ilink_stores.dart:50-61).
  static AmooMirrorAccount? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final token = raw['deviceToken'];
    if (token is! String || token.isEmpty) return null;
    final baseUrl = raw['baseUrl'];
    final pairedAt = raw['pairedAt'];
    return AmooMirrorAccount(
      baseUrl: baseUrl is String ? baseUrl : '',
      deviceToken: token,
      pairedAt: pairedAt is num ? pairedAt.toInt() : 0,
    );
  }
}

/// Deliberately NOT `final`: the synchronizer's tests subclass this to
/// pre-seed account JSON (the alternative is
/// FlutterSecureStorage.setMockInitialValues — an in-use precedent:
/// test/memory_store_test.dart:9-17, memory_distiller_test.dart:14,
/// reasoning_persist_wiring_test.dart:75/269/351).
///
/// One key, whole-account JSON blob — same shape as IlinkAccountStore
/// (lib/core/ilink/ilink_stores.dart:65-91).
class AmooMirrorAccountStore {
  AmooMirrorAccountStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  static const String storageKey = 'amoo_mirror_account';

  final FlutterSecureStorage _storage;

  /// fail-soft: unreadable / bad JSON → null (the sync layer then reports
  /// "unconfigured" instead of crashing on a corrupt blob).
  Future<AmooMirrorAccount?> load() async {
    try {
      final raw = await _storage.read(key: storageKey);
      if (raw == null) return null;
      return AmooMirrorAccount.fromJson(jsonDecode(raw));
    } catch (_) {
      return null;
    }
  }

  /// Throws on write failure — the caller is the settings screen, which has
  /// somewhere to show it (same contract as IlinkAccountStore.save).
  Future<void> save(AmooMirrorAccount account) async {
    await _storage.write(
      key: storageKey,
      value: jsonEncode(account.toJson()),
    );
  }

  Future<void> clear() async {
    try {
      await _storage.delete(key: storageKey);
    } catch (_) {}
  }
}
