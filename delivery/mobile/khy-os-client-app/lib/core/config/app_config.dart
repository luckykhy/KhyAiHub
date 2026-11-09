// khy-canary: Khy-20261101-066-KZ7C8AWE
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'built_in_keys.dart';
class AppConfigData {
  final String baseUrl;
  final String apiKey; // User-entered key (may be empty)
  final String model;
  final String systemPrompt;

  // ── Vision sub-model (for screenshot analysis) ──
  final String visionBaseUrl;
  final String visionApiKey;
  final String visionModel;

  /// Tool-permission mode. Wire name, see `PermissionMode`.
  ///
  /// Persisted rather than kept in widget state because it is a decision, not a
  /// session mood: choosing 「一律不问」 should survive killing the app, and a
  /// user who set it should not be re-asked after a restart as though they had
  /// not.
  final String permissionMode;

  const AppConfigData({
    required this.baseUrl,
    required this.apiKey,
    required this.model,
    this.systemPrompt = '',
    this.visionBaseUrl = '',
    this.visionApiKey = '',
    this.visionModel = '',
    this.permissionMode = 'default',
  });

  /// True if the user has entered their own API key
  bool get hasUserKey => apiKey.isNotEmpty;

  /// True if a built-in key is available for this baseUrl
  bool get hasBuiltInKey => BuiltInKeys.hasBuiltInKey(baseUrl);

  /// The effective API key to use for requests:
  /// - If user entered a key, use that
  /// - Otherwise, use the built-in key for this baseUrl
  /// - If neither, return empty
  String get effectiveApiKey {
    if (hasUserKey) return apiKey;
    if (hasBuiltInKey) return BuiltInKeys.getBuiltInKey(baseUrl);
    return '';
  }

  /// Whether the config is usable (has a baseUrl + effective key)
  bool get isConfigured =>
      baseUrl.isNotEmpty && effectiveApiKey.isNotEmpty;

  /// Whether we're using a built-in (non-user) key
  bool get usingBuiltInKey => !hasUserKey && hasBuiltInKey;

  /// Masked version of the effective key for display
  String get maskedEffectiveKey {
    final key = effectiveApiKey;
    if (key.length <= 16) return key;
    return '${key.substring(0, 8)}...${key.substring(key.length - 4)}';
  }

  /// Masked user key for display (in settings)
  String get maskedApiKey {
    if (apiKey.isEmpty) return '';
    if (apiKey.length <= 16) return apiKey;
    return '${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}';
  }

  // ── Vision model accessors ──

  /// True if a vision model is configured
  bool get hasVisionConfig =>
      visionBaseUrl.isNotEmpty && visionModel.isNotEmpty;

  /// True when the vision endpoint is on this device's own loopback.
  ///
  /// WHY THIS EXISTS. The vision model reads screenshots, and a screenshot is
  /// the most sensitive thing the app produces — it is whatever was on screen,
  /// which may be a chat, a code, an account page. So "where does the
  /// screenshot go" is not a detail, it is the privacy property of the whole
  /// feature, and there has to be one place that answers it.
  ///
  /// That one place is here, and it is consumed by a hard gate rather than by
  /// wording: background WeChat sync refuses to start unless this is true. A
  /// timer that uploads the user's chat screen to a third-party endpoint every
  /// fifteen minutes is the worst outcome this feature could produce, and a
  /// sentence in the UI saying "we only use local models" is not a defence
  /// against it.
  ///
  /// WHY ONLY LOOPBACK COUNTS. A LAN address is not this device. Ollama running
  /// on the user's PC is not the phone, and the plan for this feature says so
  /// plainly: choosing it trades away "the data never leaves the device" for
  /// "the model is fast enough", and that trade must be visible in the settings
  /// text rather than implied by a config field. Hence localhost / 127.0.0.1 /
  /// ::1 and nothing else.
  ///
  /// WHY THE HOST IS PARSED RATHER THAN PREFIX-MATCHED. The obvious
  /// `visionBaseUrl.startsWith('http://localhost')` is wrong in the one
  /// direction that matters: it also accepts `http://localhost.example.com`,
  /// which is somebody else's machine. A false negative here only stops the
  /// sync from starting (safe); a false positive sends the user's chat screen
  /// to a remote host while every part of the app believes it stayed on the
  /// device. So parse, and compare the host exactly.
  ///
  /// The default endpoint lives in `endpoint_defaults.dart`
  /// (`kDefaultOllamaVisionBaseUrl`), not here — this file only classifies
  /// whatever the user has typed.
  bool get visionIsLocal {
    final u = Uri.tryParse(visionBaseUrl);
    if (u == null || !u.hasAuthority) return false;
    switch (u.host.toLowerCase()) {
      case 'localhost':
      case '127.0.0.1':
      case '::1':
        return true;
      default:
        return false;
    }
  }

  /// Effective vision API key.
  ///
  /// Local endpoints get no key at all — not even the fallback. Sending a real
  /// credential to a loopback address is exposure without benefit: the only
  /// parties that could read it are ones that already have the device, and
  /// Ollama ignores the header anyway. So the fallback below applies to remote
  /// endpoints only.
  String get effectiveVisionKey {
    if (visionApiKey.isNotEmpty) return visionApiKey;
    if (visionIsLocal) return '';
    return effectiveApiKey; // fallback to main provider's key
  }

  Map<String, dynamic> toJson() => {
        'baseUrl': baseUrl,
        'apiKey': apiKey,
        'model': model,
        'systemPrompt': systemPrompt,
        'visionBaseUrl': visionBaseUrl,
        'visionApiKey': visionApiKey,
        'visionModel': visionModel,
        'permissionMode': permissionMode,
      };

  factory AppConfigData.fromJson(Map<String, dynamic> json) => AppConfigData(
        baseUrl: json['baseUrl'] ?? '',
        apiKey: json['apiKey'] ?? '',
        model: json['model'] ?? '',
        systemPrompt: json['systemPrompt'] ?? '',
        visionBaseUrl: json['visionBaseUrl'] ?? '',
        visionApiKey: json['visionApiKey'] ?? '',
        visionModel: json['visionModel'] ?? '',
        permissionMode: json['permissionMode'] ?? 'default',
      );

  AppConfigData copyWith(
      {String? baseUrl,
      String? apiKey,
      String? model,
      String? systemPrompt,
      String? visionBaseUrl,
      String? visionApiKey,
      String? visionModel,
      String? permissionMode}) {
    return AppConfigData(
      baseUrl: baseUrl ?? this.baseUrl,
      apiKey: apiKey ?? this.apiKey,
      model: model ?? this.model,
      systemPrompt: systemPrompt ?? this.systemPrompt,
      visionBaseUrl: visionBaseUrl ?? this.visionBaseUrl,
      visionApiKey: visionApiKey ?? this.visionApiKey,
      visionModel: visionModel ?? this.visionModel,
      permissionMode: permissionMode ?? this.permissionMode,
    );
  }

  /// Auto-fill: if no user key, fill in built-in defaults
  AppConfigData get effective {
    if (hasUserKey) return this;
    final builtIn = BuiltInKeys.getBuiltInKey(baseUrl);
    if (builtIn.isNotEmpty) {
      return copyWith(apiKey: builtIn);
    }
    // No user key and no built-in → try the default provider
    final def = BuiltInKeys.defaultProvider;
    if (def.hasKey) {
      return AppConfigData(
        baseUrl: def.baseUrl,
        apiKey: def.apiKey,
        model: def.defaultModel,
        systemPrompt: systemPrompt,
        visionBaseUrl: visionBaseUrl,
        visionApiKey: visionApiKey,
        visionModel: visionModel,
        permissionMode: permissionMode,
      );
    }
    return this;
  }
}
class AppConfig {
  static const _storage = FlutterSecureStorage();
  static const _keyConfig = 'app_config';

  static Future<AppConfigData> load() async {
    try {
      final raw = await _storage.read(key: _keyConfig);
      if (raw != null) {
        return AppConfigData.fromJson(jsonDecode(raw));
      }
    } catch (_) {}
    return const AppConfigData(baseUrl: '', apiKey: '', model: '');
  }

  static Future<void> save(
      {String? baseUrl,
      String? apiKey,
      String? model,
      String? systemPrompt,
      String? visionBaseUrl,
      String? visionApiKey,
      String? visionModel,
      String? permissionMode}) async {
    final current = await load();
    final updated = current.copyWith(
      baseUrl: baseUrl ?? current.baseUrl,
      apiKey: apiKey ?? current.apiKey,
      model: model ?? current.model,
      systemPrompt: systemPrompt ?? current.systemPrompt,
      visionBaseUrl: visionBaseUrl ?? current.visionBaseUrl,
      visionApiKey: visionApiKey ?? current.visionApiKey,
      visionModel: visionModel ?? current.visionModel,
      permissionMode: permissionMode ?? current.permissionMode,
    );
    await _storage.write(key: _keyConfig, value: jsonEncode(updated.toJson()));
  }

  static Future<void> reset() async {
    await _storage.delete(key: _keyConfig);
  }

  /// Load and apply built-in key fallback
  /// Returns config with effective keys filled in
  static Future<AppConfigData> loadEffective() async {
    final config = await load();
    return config.effective;
  }
}

// Alias for backward compatibility
typedef ApiConfig = AppConfigData;
