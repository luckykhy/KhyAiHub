/// 密钥池（独立模式）。
///
/// 桌面 `runtime/node/backend/src/services/apiKeyPool.js` 的纯逻辑移植：同一
/// provider 多把 key、最高优先级组内 round-robin、429/403/401（或消息含
/// rate limit/quota）指数退避冷却并认 Retry-After。远程模式的路由由配对后端
/// 负责，这里不重复——桌面的 env 发现、文件热重载、并发槽三个 source 因此都
/// 不移植：手机一次只发一个请求，没有槽位争用可建模。
///
/// 持久化与 `app_config` 同一存储（FlutterSecureStorage），键
/// 'khyos_key_pool'，只存配置字段（key/endpoint/priority/label）；冷却与计数
/// 是运行时状态，重启不背锅——与桌面 save() 同一取舍。
///
/// 冷却参数真源是桌面 `constants/serviceDefaults.js` 的 API_KEY_POOL
/// （10s 起步 · 2^(level-1) · 封顶 300s · 级数上限 5）。手机侧没有 env 注入
/// 通道，四个数字以内联常量收口在这里，改参数必须两处一起改。
library;

import 'dart:convert';
import 'dart:math' as math;

import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 桌面 markFailure 的措辞判据：没有 429 状态码但消息说限流/配额时同样冷却。
final RegExp _rateLimitWording = RegExp(
  r'rate.?limit|quota|exceeded|too.?many|overloaded',
  caseSensitive: false,
);

const int kBaseCooldownMs = 10000;
const int kMaxCooldownMs = 300000;
const int kMaxBackoffLevel = 5;
const int kMaxRetryAfterMs = 600000;
const String kKeyPoolStorageKey = 'khyos_key_pool';

/// 用户自备 key 的默认优先级。内置 key 是 0（见 built_in_keys.dart 的
/// builtInPoolEntry）——用户 key 恒盖过内置，与 AppConfig.effectiveApiKey
/// 的取舍同序；否则老安装迁移后 pick() 会在两把 key 间轮换，而迁移前的请求
/// 从来只用用户那一把。
const int kUserKeyPriority = 10;

enum KeyStatus { active, cooldown, disabled }

String keyStatusLabel(KeyStatus status) {
  switch (status) {
    case KeyStatus.active:
      return '可用';
    case KeyStatus.cooldown:
      return '冷却中';
    case KeyStatus.disabled:
      return '已停用';
  }
}

class KeyPoolException implements Exception {
  final String message;
  const KeyPoolException(this.message);

  @override
  String toString() => message;
}

/// 池中一把 key 的完整记录。运行时字段（status/cooldownUntil/backoffLevel/
/// 计数/lastError）不落盘，重启后从零开始。
class KeyEntry {
  final String keyId;
  final String provider;
  final String key;
  final String endpoint;
  int priority;
  String label;
  KeyStatus status;
  int cooldownUntil; // epoch ms；0 = 不在冷却
  int backoffLevel;
  int totalRequests;
  int totalFailures;
  int lastUsedAt;
  String? lastError;

  KeyEntry({
    required this.keyId,
    required this.provider,
    required this.key,
    this.endpoint = '',
    this.priority = 0,
    this.label = '',
  })  : status = KeyStatus.active,
        cooldownUntil = 0,
        backoffLevel = 0,
        totalRequests = 0,
        totalFailures = 0,
        lastUsedAt = 0,
        lastError = null;
}

/// pick() 的选中结果。keyId 供 markSuccess/markFailure 回指。
class KeySelection {
  final String keyId;
  final String key;
  final String endpoint;
  final String label;

  const KeySelection({
    required this.keyId,
    required this.key,
    required this.endpoint,
    required this.label,
  });
}

/// 给界面看的池状态（密钥打码，与桌面 getPoolStatus 同形状）。
class KeyStatusView {
  final String keyId;
  final String keyPreview;
  final String label;
  final int priority;
  final KeyStatus status;
  final int cooldownRemainingSec;
  final int totalRequests;
  final int totalFailures;
  final String? lastError;

  const KeyStatusView({
    required this.keyId,
    required this.keyPreview,
    required this.label,
    required this.priority,
    required this.status,
    required this.cooldownRemainingSec,
    required this.totalRequests,
    required this.totalFailures,
    required this.lastError,
  });
}

/// keyId = md5(provider:key) 前 12 位十六进制，与桌面同一算法——同一把 key
/// 在两个设备上得到同一 id，跨端排查时对得上。它是查找句柄，不是安全原语，
/// 所以没有跟风换 SHA-256（crypto 依赖由接线阶段加入 pubspec）。
String keyIdFor(String provider, String key) =>
    md5.convert(utf8.encode('$provider:$key')).toString().substring(0, 12);

/// 桌面 maskKey：短 key 全遮，长 key 留头 6 尾 4。
String maskKey(String key) {
  if (key.isEmpty || key.length < 10) return '***';
  return '${key.substring(0, 6)}...${key.substring(key.length - 4)}';
}

/// 某一退避级数对应的冷却时长：10s 起步、2^(level-1) 放大、封顶 300s。
/// 单独暴露是因为级数上限 5 时指数最多到 160s，300s 那条夹子只有直接调它
/// 才验证得到（与桌面公式逐字节一致）。
int cooldownForBackoffLevel(int level) {
  final clamped = level < 1 ? 1 : level;
  final exponential = kBaseCooldownMs * math.pow(2, clamped - 1);
  return math.min(kMaxCooldownMs, exponential).toInt();
}

/// Retry-After → 冷却毫秒，钳在 [10s, 600s]。移植桌面
/// utils/parseRetryAfterCooldown：数字按秒；HTTP-date 形态 Dart 核心库不认
/// （只解析 ISO-8601），RFC 7231 的 'EEE, dd MMM yyyy HH:mm:ss GMT' 自己解；
/// 都不成 → 回退基础冷却。
int parseRetryAfterCooldown(String value, {required int nowMs}) {
  final trimmed = value.trim();
  if (trimmed.isEmpty) return kBaseCooldownMs;
  final seconds = double.tryParse(trimmed);
  if (seconds != null && seconds > 0) {
    return _clampRetryAfter((seconds * 1000).round());
  }
  final httpDateMs = _parseHttpDateMs(trimmed);
  if (httpDateMs != null) {
    return _clampRetryAfter(httpDateMs - nowMs);
  }
  return kBaseCooldownMs;
}

int _clampRetryAfter(int ms) =>
    ms.clamp(kBaseCooldownMs, kMaxRetryAfterMs).toInt();

final RegExp _httpDatePattern = RegExp(
  r'^[A-Za-z]{3},\s+(\d{2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT$',
);

const Map<String, int> _httpDateMonths = {
  'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
  'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12,
};

int? _parseHttpDateMs(String value) {
  final m = _httpDatePattern.firstMatch(value);
  if (m == null) return null;
  final month = _httpDateMonths[m.group(2)];
  if (month == null) return null;
  return DateTime.utc(
    int.parse(m.group(3)!),
    month,
    int.parse(m.group(1)!),
    int.parse(m.group(4)!),
    int.parse(m.group(5)!),
    int.parse(m.group(6)!),
  ).millisecondsSinceEpoch;
}

class KeyPool {
  final Map<String, List<KeyEntry>> _pool = {};
  final Map<String, KeyEntry> _byId = {};
  final Map<String, int> _cursors = {};
  final DateTime Function() _clock;
  final Future<String?> Function() _read;
  final Future<void> Function(String) _write;

  static const _storage = FlutterSecureStorage();

  /// clock/read/write 可注入：单测用假时钟与内存存储跑退避与落盘往返，
  /// 不走平台通道。
  KeyPool({
    DateTime Function()? clock,
    Future<String?> Function()? read,
    Future<void> Function(String)? write,
  })  : _clock = clock ?? (() => DateTime.now()),
        _read = read ?? _secureRead,
        _write = write ?? _secureWrite;

  static Future<String?> _secureRead() => _storage.read(key: kKeyPoolStorageKey);

  static Future<void> _secureWrite(String value) =>
      _storage.write(key: kKeyPoolStorageKey, value: value);

  int _nowMs() => _clock().millisecondsSinceEpoch;

  /// 从安全存储读池。存储不可读或 JSON 损坏都按空池起步——与 AppConfig.load
  /// 同一退路：启动不该被一份坏存档炸掉。
  Future<void> load() async {
    _pool.clear();
    _byId.clear();
    final String? raw;
    try {
      raw = await _read();
    } catch (_) {
      return;
    }
    if (raw == null || raw.trim().isEmpty) return;
    final Map<String, dynamic> data;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return;
      data = decoded;
    } catch (_) {
      return;
    }
    for (final group in data.entries) {
      final list = group.value;
      if (list is! List) continue;
      for (final item in list) {
        if (item is! Map) continue;
        final key = item['key']?.toString() ?? '';
        if (key.isEmpty) continue;
        _register(
          group.key,
          key: key,
          endpoint: item['endpoint']?.toString() ?? '',
          priority: (item['priority'] as num?)?.toInt() ?? 0,
          label: item['label']?.toString() ?? '',
        );
      }
    }
  }

  Future<KeyEntry> addKey(
    String provider, {
    required String key,
    String endpoint = '',
    int priority = kUserKeyPriority,
    String label = '',
  }) async {
    final trimmed = key.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError('API key 不能为空');
    }
    final existing = _pool[provider] ?? const [];
    if (existing.any((e) => e.key == trimmed)) {
      throw KeyPoolException('该密钥已存在于这个供应商的密钥池，无需重复添加');
    }
    final entry = _register(
      provider,
      key: trimmed,
      endpoint: endpoint,
      priority: priority,
      label: label,
    );
    await _persist();
    return entry;
  }

  Future<void> removeKey(String provider, String keyId) async {
    final entries = _pool[provider];
    if (entries == null) return;
    entries.removeWhere((e) => e.keyId == keyId);
    _byId.remove(keyId);
    if (entries.isEmpty) _pool.remove(provider);
    await _persist();
  }

  void disableKey(String keyId) {
    final entry = _byId[keyId];
    if (entry != null) entry.status = KeyStatus.disabled;
  }

  /// 重新启用：清退避与冷却——用户手动放行不该继续背上次的锅。
  void enableKey(String keyId) {
    final entry = _byId[keyId];
    if (entry == null) return;
    entry.status = KeyStatus.active;
    entry.backoffLevel = 0;
    entry.cooldownUntil = 0;
    entry.lastError = null;
  }

  /// 取下一把可用 key：最高优先级组内 round-robin。整池都在冷却/停用 →
  /// null（调用方据此跳过该 provider，不伪造请求）。
  ///
  /// 桌面在这里对底层数组原地排序（读路径顺手改了状态）；手机不跟——排序只
  /// 作用于本次副本，设置页的显示顺序保持用户添加顺序。
  KeySelection? pick(String provider) {
    final available = _availableEntries(provider);
    if (available.isEmpty) return null;
    available.sort((a, b) => b.priority.compareTo(a.priority));
    final topPriority = available.first.priority;
    final group = available.where((e) => e.priority == topPriority).toList();
    final cursor = (_cursors[provider] ?? 0) % group.length;
    _cursors[provider] = (cursor + 1) % group.length;
    final entry = group[cursor];
    entry.lastUsedAt = _nowMs();
    entry.totalRequests++;
    return KeySelection(
      keyId: entry.keyId,
      key: entry.key,
      endpoint: entry.endpoint,
      label: entry.label,
    );
  }

  /// 请求成功：退避级数衰减一级。桌面 markSuccess 不同步清 cooldownUntil
  /// ——状态置 active 即可再用，保持同一行为。
  void markSuccess(String keyId) {
    final entry = _byId[keyId];
    if (entry == null) return;
    if (entry.backoffLevel > 0) {
      entry.backoffLevel--;
    }
    entry.status = KeyStatus.active;
    entry.lastError = null;
  }

  /// 请求失败。仅 429/403/401 或消息含 rate limit/quota 类措辞才冷却；
  /// 429 有 Retry-After 时以服务端指定为准（钳在 [10s, 600s]），否则指数
  /// 退避。其余状态码只记失败不停 key——一次 500 不该把好 key 关掉。
  void markFailure(
    String keyId,
    int statusCode, {
    String errorMsg = '',
    String? retryAfter,
  }) {
    final entry = _byId[keyId];
    if (entry == null) return;

    entry.totalFailures++;
    entry.lastError = errorMsg.isNotEmpty ? errorMsg : 'HTTP $statusCode';

    final shouldCooldown = statusCode == 429 ||
        statusCode == 403 ||
        statusCode == 401 ||
        _rateLimitWording.hasMatch(errorMsg);

    if (!shouldCooldown) return;

    entry.backoffLevel = math.min(entry.backoffLevel + 1, kMaxBackoffLevel);
    final backoffMs = (statusCode == 429 && retryAfter != null && retryAfter.isNotEmpty)
        ? parseRetryAfterCooldown(retryAfter, nowMs: _nowMs())
        : cooldownForBackoffLevel(entry.backoffLevel);

    entry.cooldownUntil = _nowMs() + backoffMs;
    entry.status = KeyStatus.cooldown;
  }

  bool hasAvailableKeys(String provider) => _availableEntries(provider).isNotEmpty;

  List<String> get providers => _pool.keys.toList();

  /// 原始条目（含未打码 key）——逐 key 探测要从这里拿 key 与 endpoint。
  List<KeyEntry> entriesFor(String provider) =>
      List.unmodifiable(_pool[provider] ?? const []);

  List<KeyStatusView> statusFor(String provider) {
    final now = _nowMs();
    return entriesFor(provider).map((e) {
      if (e.status == KeyStatus.cooldown && e.cooldownUntil <= now) {
        e.status = KeyStatus.active;
      }
      return KeyStatusView(
        keyId: e.keyId,
        keyPreview: maskKey(e.key),
        label: e.label,
        priority: e.priority,
        status: e.status,
        cooldownRemainingSec: e.status == KeyStatus.cooldown
            ? ((e.cooldownUntil - now) / 1000).ceil()
            : 0,
        totalRequests: e.totalRequests,
        totalFailures: e.totalFailures,
        lastError: e.lastError,
      );
    }).toList();
  }

  List<KeyEntry> _availableEntries(String provider) {
    final entries = _pool[provider];
    if (entries == null || entries.isEmpty) return const [];
    final now = _nowMs();
    for (final e in entries) {
      if (e.status == KeyStatus.cooldown && e.cooldownUntil <= now) {
        e.status = KeyStatus.active;
      }
    }
    return entries.where((e) => e.status == KeyStatus.active).toList();
  }

  KeyEntry _register(
    String provider, {
    required String key,
    String endpoint = '',
    int priority = 0,
    String label = '',
  }) {
    final entry = KeyEntry(
      keyId: keyIdFor(provider, key),
      provider: provider,
      key: key,
      endpoint: endpoint,
      priority: priority,
      label: label,
    );
    // 手改过存储文件时可能出现同一把 key 两条记录；keyId 相同会让
    // markSuccess/markFailure 打到另一条上，这里按 id 去重。
    if (_byId.containsKey(entry.keyId)) return _byId[entry.keyId]!;
    _pool.putIfAbsent(provider, () => []).add(entry);
    _byId[entry.keyId] = entry;
    return entry;
  }

  Future<void> _persist() async {
    final data = <String, dynamic>{
      for (final group in _pool.entries)
        group.key: group.value
            .map((e) => {
                  'key': e.key,
                  'endpoint': e.endpoint,
                  'priority': e.priority,
                  'label': e.label,
                })
            .toList(),
    };
    try {
      await _write(jsonEncode(data));
    } catch (_) {
      // 写失败不抛：与 AppConfig 的 try/catch 读模式同源——设置页的一次点击
      // 不该被存储故障炸掉，池在内存里仍然可用，下次启动从盘上恢复。
    }
  }
}
