/// 逐 key 健康探测（独立模式）。
///
/// 桌面 `apps/khyos-desktop/src/main/keyManager/health.ts` probeOne 的移植：
/// GET '<endpoint>/models'——与 chat_screen_new._testConn 同一 URL 与请求
/// 形状（Bearer 头、10s 超时）。分类：2xx/404/405→ok（端点能应答即算可达，
/// 404 只是没有 /models 这条路）、401/403→auth、429→rate、5xx→upstream、
/// 超时→timeout。单项 10s、并发 4。
///
/// 10s 单项超时是 RUNTIME-003 的合法短 I/O 例外：它防的是挂死的连接，不是杀
/// 一个活跃的长任务；整批没有墙钟上限，慢的一项只占住一个 worker，不会阻塞
/// 其余（与桌面 probeAll 的并发 fan-out 同一结构）。
library;

import 'dart:math' as math;

import 'package:dio/dio.dart';

const Duration kProbeTimeout = Duration(seconds: 10);
const int kProbeConcurrency = 4;

/// 模型坏标记的保留时长。手机不常驻、探活由用户手动触发，所以这个账本只在
/// 进程内有效：重启后重新试一次模型，代价是一次 404，不值得为它再开一个
/// 存储键。
const Duration kBrokenModelTtl = Duration(minutes: 30);

enum HealthStatus { ok, auth, rate, upstream, timeout }

class HealthResult {
  final String keyId;
  final String provider;
  final String endpoint;
  final HealthStatus status;
  final String detail;
  final int latencyMs;

  const HealthResult({
    required this.keyId,
    required this.provider,
    required this.endpoint,
    required this.status,
    required this.detail,
    required this.latencyMs,
  });
}

class ProbeTarget {
  final String keyId;
  final String provider;
  final String endpoint;
  final String key;

  const ProbeTarget({
    required this.keyId,
    required this.provider,
    required this.endpoint,
    required this.key,
  });
}

/// 分类与桌面 health.ts classify 逐分支一致：404/405 及其他 4xx 归 ok——
/// 端点回答了就证明可达，错误在 key 或模型上，不在通不通。
HealthStatus classifyProbeStatus(int statusCode) {
  if (statusCode >= 200 && statusCode < 300) return HealthStatus.ok;
  if (statusCode == 401 || statusCode == 403) return HealthStatus.auth;
  if (statusCode == 429) return HealthStatus.rate;
  if (statusCode >= 500) return HealthStatus.upstream;
  return HealthStatus.ok;
}

/// 文案直接沿用规则 2.2 模板（问题+原因+一行修复），与
/// chat_screen_new._describeHttpStatus 同款措辞，不另造。
String healthStatusHint(HealthStatus status) {
  switch (status) {
    case HealthStatus.ok:
      return '可用';
    case HealthStatus.auth:
      return '认证失败 (401/403)：密钥无效或过期，请在设置中更新';
    case HealthStatus.rate:
      return '限流 (429)：请求过多，稍后重试';
    case HealthStatus.upstream:
      return '上游异常 (5xx)：模型服务暂不可用，请稍后重试';
    case HealthStatus.timeout:
      return '请求超时：网络或服务响应慢，请稍后重试';
  }
}

String probeHostLabel(String endpoint) {
  final host = Uri.tryParse(endpoint.trim())?.host ?? '';
  return host.isEmpty ? '(端点无效)' : host;
}

/// '探测 2/5：api.deepseek.com' —— 动作+目标+进度，供进度回调直接展示。
String probeLabel(int done, int total, ProbeTarget target) =>
    '探测 $done/$total：${probeHostLabel(target.endpoint)}';

Future<HealthResult> probeOne(
  ProbeTarget target, {
  Duration timeout = kProbeTimeout,
}) async {
  final dio = Dio(BaseOptions(
    connectTimeout: timeout,
    receiveTimeout: timeout,
    sendTimeout: timeout,
    // 探测要看到 5xx 本身：dio 默认把 5xx 变成异常，上游信号就丢了。
    validateStatus: (_) => true,
  ));
  final sw = Stopwatch()..start();
  try {
    final resp = await dio.get(
      '${target.endpoint}/models',
      options: Options(headers: {
        if (target.key.isNotEmpty) 'Authorization': 'Bearer ${target.key}',
      }),
    );
    final code = resp.statusCode;
    final status =
        code == null ? HealthStatus.upstream : classifyProbeStatus(code);
    return HealthResult(
      keyId: target.keyId,
      provider: target.provider,
      endpoint: target.endpoint,
      status: status,
      detail: healthStatusHint(status),
      latencyMs: sw.elapsedMilliseconds,
    );
  } on DioException catch (e) {
    final timedOut = e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.receiveTimeout ||
        e.type == DioExceptionType.sendTimeout;
    return HealthResult(
      keyId: target.keyId,
      provider: target.provider,
      endpoint: target.endpoint,
      status: timedOut ? HealthStatus.timeout : HealthStatus.upstream,
      detail: timedOut
          ? healthStatusHint(HealthStatus.timeout)
          : '网络连接失败：请检查网络代理设置',
      latencyMs: sw.elapsedMilliseconds,
    );
  }
}

/// 并发受限的扇出。每项各自带 10s 短 I/O 超时；整批无墙钟 kill——一个卡住
/// 的端点只会占住一个 worker，其余继续。
Future<List<HealthResult>> probeAll(
  List<ProbeTarget> targets, {
  Duration timeout = kProbeTimeout,
  int concurrency = kProbeConcurrency,
  void Function(int done, int total, String label)? onProgress,
}) async {
  final results = List<HealthResult?>.filled(targets.length, null);
  var next = 0;
  var done = 0;

  Future<void> worker() async {
    while (true) {
      if (next >= targets.length) return;
      final idx = next;
      next += 1;
      final target = targets[idx];
      results[idx] = await probeOne(target, timeout: timeout);
      done += 1;
      onProgress?.call(done, targets.length, probeLabel(done, targets.length, target));
    }
  }

  await Future.wait(
      List.generate(math.min(concurrency, targets.length), (_) => worker()));
  return results.cast<HealthResult>().toList();
}

/// 被标记为坏掉的 (provider, model)。expiresAt 后自动放行。
class BrokenModel {
  final String provider;
  final String model;
  final DateTime expiresAt;

  const BrokenModel({
    required this.provider,
    required this.model,
    required this.expiresAt,
  });
}

/// 模型健康账本（缩小版）。
///
/// 只收 permanent 坏标记：404 且响应体明说模型不存在（见
/// isPermanentModelError）。transient 滑动窗口与 probe-due 复活不移植——
/// 手机非常驻，探活由用户手动触发，那两套机制在桌面是为长驻进程准备的。
class ModelHealthLedger {
  final DateTime Function() _clock;
  final Map<String, BrokenModel> _broken = {};

  ModelHealthLedger({DateTime Function()? clock})
      : _clock = clock ?? (() => DateTime.now());

  static String _ledgerKey(String provider, String model) =>
      '$provider\u0000$model';

  void markBroken(String provider, String model) {
    final p = provider.trim();
    final m = model.trim();
    if (p.isEmpty || m.isEmpty) return;
    _broken[_ledgerKey(p, m)] = BrokenModel(
      provider: p,
      model: m,
      expiresAt: _clock().add(kBrokenModelTtl),
    );
  }

  bool isBroken(String provider, String model) {
    _expire();
    return _broken.containsKey(_ledgerKey(provider.trim(), model.trim()));
  }

  void clear(String provider, String model) {
    _broken.remove(_ledgerKey(provider.trim(), model.trim()));
  }

  List<BrokenModel> get broken {
    _expire();
    return _broken.values.toList(growable: false);
  }

  void _expire() {
    final now = _clock();
    _broken.removeWhere((_, entry) => !entry.expiresAt.isAfter(now));
  }
}

/// 只有「404 + 响应体明说模型不存在」算永久坏：一次 404 可能只是 URL 打错，
/// 误标会把一个好模型关半小时。措辞覆盖 OpenAI 的 model_not_found、各家
/// 兼容层常见的 does not exist / no such model，以及中文「模型不存在」。
final RegExp _modelNotFoundWording = RegExp(
  r'model[_\s.-]?not[_\s.-]?found|does not exist|no such model|模型.{0,6}不存在|模型不可用',
  caseSensitive: false,
);

bool isPermanentModelError(int? statusCode, String body) =>
    statusCode == 404 && _modelNotFoundWording.hasMatch(body);
