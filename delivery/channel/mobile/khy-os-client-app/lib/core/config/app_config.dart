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

  /// 新建对话默认是否把轮次写进电脑侧共享会话（`.khy/sessions`）。
  ///
  /// 这是**默认**，不是强制：单个对话可以在聊天页的同步面板里单独关掉。
  /// 默认开是因为用户选的就是"默认同步"；关掉它只停止后续写入，
  /// 电脑上已有的副本保留——本机无法删除远端，也不该假装删了。
  final bool sessionSyncEnabled;

  /// 被用户一键禁用的 driver id 列表（'amoo' / 'pc-bridge' / …）。
  ///
  /// 为什么禁用位落在配置里而不是各 driver 自己记：禁用是用户对**执行器**
  /// 的决定，不是对某个功能的心情——它该和 permissionMode 一样活过一次
  /// 重启还作数。默认空：没有任何 driver 被预禁用（不预置占位，§5.3）。
  final List<String> disabledDrivers;

  /// 任务悬浮胶囊开关（任务执行期间在系统悬浮窗里画进度胶囊）。
  ///
  /// 默认关：胶囊浮在所有应用之上，是常驻屏面的可见侵入——与
  /// ProcessTextEntry 同一条「决定权给用户」的理由。开与关都在设置页；
  /// Kotlin 侧画之前还会再查一次 canDrawOverlays，这里是第一道门。
  final bool floatingOverlayEnabled;

  /// 聊天页的「独立 / 远程」档位。
  ///
  /// 落在配置里而不是只活在 widget 状态：它与 [permissionMode] 同性质——用户
  /// 选的是一种执行归属，不是一次会话的心情。原来只存内存，冷启动后用户选过的
  /// 「独立」悄悄变回去，「Zen 免费档由手机直连」也跟着失效（2026-11-16 实机：
  /// 重启后模式回到远程，用户以为还在直连）。
  final bool remoteMode;

  /// 内置本地模型的下载源是否走国内镜像（ModelScope）。
  ///
  /// 与 [permissionMode] / [remoteMode] 同性质：用户对「从哪下 2.7 GB」做的
  /// 决定，要活过一次重启。null = 没表过态，跟随构建默认（`KHY_USE_CN_MIRROR`
  /// dart-define，默认官方源）；true/false 是用户在设置页显式按过开关。
  /// 判据见 `local_model_store.dart` 里 `useCnMirror` 的说明（`PROCESS-013`
  /// C4：镜像不得默认生效，但人的一次明确点击就是显式 opt-in）。
  final bool? localModelCnMirror;

  const AppConfigData({
    required this.baseUrl,
    required this.apiKey,
    required this.model,
    this.systemPrompt = '',
    this.visionBaseUrl = '',
    this.visionApiKey = '',
    this.visionModel = '',
    this.permissionMode = 'default',
    this.sessionSyncEnabled = true,
    this.disabledDrivers = const [],
    this.floatingOverlayEnabled = false,
    this.remoteMode = false,
    this.localModelCnMirror,
  });

  /// 这个 driver 是否被用户禁用。判定只有这一处，UI、registry、原生门
  /// 都读同一个答案——各自判一次必然分叉。
  bool isDriverDisabled(String driverId) => disabledDrivers.contains(driverId);

  /// True if the user has entered their own API key
  bool get hasUserKey => apiKey.isNotEmpty;

  /// True if a built-in key is available for this baseUrl
  bool get hasBuiltInKey => BuiltInKeys.hasBuiltInKey(baseUrl);

  /// 免费档（无需账号 key，bearer 是 `public`）。
  ///
  /// 与 [hasBuiltInKey] 分开：免费档确实"有密钥"，但那份密钥不是账号额度，
  /// 走的是上游的匿名共享池——池子空了就 429，且换 IP/模型/身份都无效
  /// （2026-11-17 实测）。界面据此把"已内置密钥"的绿条换成一句诚实的提醒。
  bool get isKeylessProvider {
    final name = BuiltInKeys.matchBaseUrl(baseUrl);
    if (name == null) return false;
    return BuiltInKeys.get(name)?.keyless ?? false;
  }

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
        'sessionSyncEnabled': sessionSyncEnabled,
        'disabledDrivers': disabledDrivers,
        'floatingOverlayEnabled': floatingOverlayEnabled,
        'remoteMode': remoteMode,
        'localModelCnMirror': localModelCnMirror,
      };

  factory AppConfigData.fromJson(Map<String, dynamic> json) {
    // disabledDrivers 坏值兜底：该是 List<String>，手改/写坏时按空处理——
    // 让整份配置因为一个键反序列化失败，用户会看到所有设置都空了。
    final rawDisabled = json['disabledDrivers'];
    final disabled = rawDisabled is List
        ? rawDisabled.whereType<String>().toList(growable: false)
        : const <String>[];
    return AppConfigData(
        baseUrl: json['baseUrl'] ?? '',
        apiKey: json['apiKey'] ?? '',
        model: json['model'] ?? '',
        systemPrompt: json['systemPrompt'] ?? '',
        visionBaseUrl: json['visionBaseUrl'] ?? '',
        visionApiKey: json['visionApiKey'] ?? '',
        visionModel: json['visionModel'] ?? '',
        permissionMode: json['permissionMode'] ?? 'default',
        // 缺键 = 升级前写下的配置，按默认开处理；非 bool 的坏值同样回到默认，
        // 而不是让整份配置反序列化失败（那时用户会看到所有设置都空了）。
        sessionSyncEnabled: json['sessionSyncEnabled'] is bool
            ? json['sessionSyncEnabled'] as bool
            : true,
        disabledDrivers: disabled,
        // 悬浮胶囊默认关：缺键（旧配置）与坏值都落到「不画」，侵入性的
        // 窗口不能靠默认值自己出现。
        floatingOverlayEnabled: json['floatingOverlayEnabled'] is bool
            ? json['floatingOverlayEnabled'] as bool
            : false,
        // 缺键 = 升级前的配置。默认「独立」：那是出厂档，也是不依赖电脑就能
        // 发请求的那一档；不能因为老配置没这个键就把人切到远程。
        remoteMode: json['remoteMode'] is bool ? json['remoteMode'] as bool : false,
        // 缺键 / 坏值都是「没表过态」→ null，让构建默认继续作数。写死 false
        // 会把一个编译期就开了镜像的构建悄悄关掉。
        localModelCnMirror: json['localModelCnMirror'] is bool
            ? json['localModelCnMirror'] as bool
            : null,
    );
  }

  AppConfigData copyWith(
      {String? baseUrl,
      String? apiKey,
      String? model,
      String? systemPrompt,
      String? visionBaseUrl,
      String? visionApiKey,
      String? visionModel,
      String? permissionMode,
      bool? sessionSyncEnabled,
      List<String>? disabledDrivers,
      bool? floatingOverlayEnabled,
      bool? remoteMode,
      bool? localModelCnMirror}) {
    return AppConfigData(
      baseUrl: baseUrl ?? this.baseUrl,
      apiKey: apiKey ?? this.apiKey,
      model: model ?? this.model,
      systemPrompt: systemPrompt ?? this.systemPrompt,
      visionBaseUrl: visionBaseUrl ?? this.visionBaseUrl,
      visionApiKey: visionApiKey ?? this.visionApiKey,
      visionModel: visionModel ?? this.visionModel,
      permissionMode: permissionMode ?? this.permissionMode,
      sessionSyncEnabled: sessionSyncEnabled ?? this.sessionSyncEnabled,
      disabledDrivers: disabledDrivers ?? this.disabledDrivers,
      floatingOverlayEnabled:
          floatingOverlayEnabled ?? this.floatingOverlayEnabled,
      remoteMode: remoteMode ?? this.remoteMode,
      localModelCnMirror: localModelCnMirror ?? this.localModelCnMirror,
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
        sessionSyncEnabled: sessionSyncEnabled,
        disabledDrivers: disabledDrivers,
        floatingOverlayEnabled: floatingOverlayEnabled,
        remoteMode: remoteMode,
        localModelCnMirror: localModelCnMirror,
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
      String? permissionMode,
      bool? sessionSyncEnabled,
      List<String>? disabledDrivers,
      bool? floatingOverlayEnabled,
      bool? remoteMode,
      bool? localModelCnMirror}) async {
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
      sessionSyncEnabled: sessionSyncEnabled ?? current.sessionSyncEnabled,
      disabledDrivers: disabledDrivers ?? current.disabledDrivers,
      floatingOverlayEnabled:
          floatingOverlayEnabled ?? current.floatingOverlayEnabled,
      remoteMode: remoteMode ?? current.remoteMode,
      localModelCnMirror: localModelCnMirror ?? current.localModelCnMirror,
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
