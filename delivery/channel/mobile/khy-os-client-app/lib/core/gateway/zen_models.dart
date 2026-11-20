import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'zen_gate.dart';

/// 永久退役的 Zen 免费模型——电脑版 `services/zenRetiredModels.js:45-52` 的手机
/// 子集。
///
/// 为什么不照抄整张静态表：电脑版表里还带着 `unavailable` / `region` 的临时项，
/// 它们的 TTL 是 7 天，而探针时刻是 2026-10-09。照抄等于把已经过期的死数据
/// 打进出货包，用户看不到上游其实已经放回来的模型。临时退役只能来自**带新鲜
/// 时间戳**的调用时反馈，见 [ZenModelCatalog.recordFromUpstreamError]。
///
/// 只收永久项：`deprecated` / `unsupported`。
const Map<String, String> kZenPermanentlyRetired = {
  'exo-free': 'deprecated',
  'mimo-v2.5-free': 'unsupported',
  'deepseek-v4-flash-free': 'unsupported',
};

const Duration kZenTransientRetiredTtl = Duration(days: 7);

/// 退役账本的落盘位置。抽出来是为了单测不碰平台存储。
abstract class ZenRetiredStore {
  Future<String?> read();
  Future<void> write(String value);
}

class _SecureZenRetiredStore implements ZenRetiredStore {
  const _SecureZenRetiredStore();

  static const _storage = FlutterSecureStorage();
  static const _key = 'zen_retired_models_v1';

  @override
  Future<String?> read() => _storage.read(key: _key);

  @override
  Future<void> write(String value) => _storage.write(key: _key, value: value);
}

class ZenModelCatalog {
  ZenModelCatalog._();

  static ZenRetiredStore store = const _SecureZenRetiredStore();

  static Map<String, _Retired>? _cache;
  static Future<void>? _loading;

  /// 只清内存态，不动落盘账本（与 ZenGate.resetForTest 同语义）。
  static void resetForTest({ZenRetiredStore? store}) {
    _cache = null;
    _loading = null;
    if (store != null) ZenModelCatalog.store = store;
  }

  /// 只按静态永久表过滤，同步。随包清单（离线兜底）用这条——
  /// 账本里的临时项只对"刚从上游拿回来的列表"有意义。
  static List<String> filterFreeStatic(List<String> ids) => ids
      .where(isZenFreeModelId)
      .where((id) => !kZenPermanentlyRetired.containsKey(_norm(id)))
      .toList();

  /// 完整过滤：形状（[-free]/例外集）+ 永久退役 + 未过期的临时退役。
  static Future<List<String>> filterFree(List<String> ids) async {
    final ledger = await _ledger();
    final now = DateTime.now().millisecondsSinceEpoch;
    return ids
        .where(isZenFreeModelId)
        .where((id) => !kZenPermanentlyRetired.containsKey(_norm(id)))
        .where((id) => !_isRetired(ledger[_norm(id)], now))
        .toList();
  }

  /// 记一条退役。只该由 [recordFromUpstreamError] 调用——手工调用会绕过
  /// 「上游明文说下线」这道门，把一次 5xx 变成永久隐藏。
  static Future<void> markRetired(
    String id,
    String reason, {
    int? at,
  }) async {
    final key = _norm(id);
    if (key.isEmpty) return;
    final ledger = await _ledger();
    ledger[key] = _Retired(
      reason: reason.trim().toLowerCase(),
      at: at ?? DateTime.now().millisecondsSinceEpoch,
    );
    await _persist(ledger);
  }

  /// 上游明文说了「下线/不支持」且状态码属于 401/404/410 才记。
  ///
  /// 明确不认 403/429/5xx/超时（电脑版 `zenRetiredModels.js:246-247` 同一条门）：
  /// 那些是配额、地区封锁或瞬态故障，把它们记成下线会让模型永久消失。
  /// 返回是否真的记了，调用方据此决定要不要刷新列表。
  static Future<bool> recordFromUpstreamError({
    required int? status,
    required String body,
    required String modelId,
  }) async {
    if (status != 401 && status != 404 && status != 410) return false;
    final reason = _retireReasonFrom(body);
    if (reason == null) return false;
    await markRetired(modelId, reason);
    return true;
  }

  /// 清掉已过期的临时项。只影响账本，不改变判定结果（判定本来就带着 TTL）。
  static Future<void> prune() async {
    final ledger = await _ledger();
    final now = DateTime.now().millisecondsSinceEpoch;
    final before = ledger.length;
    ledger.removeWhere((_, rec) => !_isRetired(rec, now));
    if (ledger.length != before) await _persist(ledger);
  }

  static String? _retireReasonFrom(String body) {
    final text = body;
    if (RegExp(r'modeldeprecated|has been deprecated', caseSensitive: false)
        .hasMatch(text)) {
      return 'deprecated';
    }
    if (RegExp(r'is not supported|unsupported model', caseSensitive: false)
        .hasMatch(text)) {
      return 'unsupported';
    }
    return null;
  }

  static bool _isRetired(_Retired? rec, int nowMs) {
    if (rec == null) return false;
    if (_permanentReasons.contains(rec.reason)) return true;
    if (rec.at <= 0) return false;
    return nowMs - rec.at <= kZenTransientRetiredTtl.inMilliseconds;
  }

  static const _permanentReasons = {'deprecated', 'unsupported'};

  static String _norm(String id) => id.trim().toLowerCase();

  static Future<Map<String, _Retired>> _ledger() async {
    final cached = _cache;
    if (cached != null) return cached;
    final inflight = _loading;
    if (inflight != null) {
      await inflight;
      return _cache ?? <String, _Retired>{};
    }
    final future = _load();
    _loading = future;
    try {
      await future;
    } finally {
      _loading = null;
    }
    return _cache ?? <String, _Retired>{};
  }

  static Future<void> _load() async {
    final out = <String, _Retired>{};
    try {
      final raw = await store.read();
      if (raw != null && raw.isNotEmpty) {
        final decoded = jsonDecode(raw);
        if (decoded is Map) {
          decoded.forEach((key, value) {
            if (value is! Map) return;
            final reason = value['reason']?.toString() ?? '';
            final at = value['at'];
            out[key.toString().trim().toLowerCase()] = _Retired(
              reason: reason.trim().toLowerCase(),
              at: at is num ? at.toInt() : 0,
            );
          });
        }
      }
    } catch (_) {
      // 账本读不出来 = 当作空账本：类型过滤仍然生效，只是少了调用时反馈。
    }
    _cache = out;
  }

  static Future<void> _persist(Map<String, _Retired> ledger) async {
    _cache = ledger;
    try {
      await store.write(jsonEncode({
        for (final e in ledger.entries)
          e.key: {'reason': e.value.reason, 'at': e.value.at},
      }));
    } catch (_) {
      // 写不进去就只保内存：本次进程内仍然会隐藏它。
    }
  }
}

class _Retired {
  final String reason;
  final int at;

  const _Retired({required this.reason, required this.at});
}
