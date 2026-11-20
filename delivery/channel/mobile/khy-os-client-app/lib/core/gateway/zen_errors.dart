import 'dart:convert';

import 'package:dio/dio.dart';

/// Zen 免费档的错误归类——电脑版 `services/cliErrorDescriptor.js` 识别码族的
/// 手机镜像。
///
/// 为什么单独一档：免费档的 401/403/429 里混着四种完全不同的病（客户端指纹
/// 没过、地区封锁、匿名免费池的额度用尽、模型下线），而手机侧原本对 403 只有一句
/// 「权限不足：该 API Key 无权访问此模型」。免费档根本没有账号密钥参与
/// （bearer 是 public），用户按那句话去换 key，换几次都不会变。
///
/// 正则与电脑版 `cliErrorDescriptor.js:499-503` 同源：上游的报错正文是
/// `FreeTierError` / `FreeUsageLimitError` / `RegionError` 这类机器可判的
/// 识别码，措辞稳定，比状态码本身信息量大得多。

enum ZenErrorKind {
  /// 匿名免费池的额度用尽。
  ///
  /// 2026-11-17 实机实测：换 session/project（全新身份）、换模型、换 IPv4/IPv6
  /// 出口、换设备、换网段，全部仍是 429；而真正的 opencode 客户端在同一台机器、
  /// 同一网络、未登录的情况下能正常回答。所以额度既不是按 IP 计，也不是按设备
  /// 身份计——它按客户端凭据发放。手机没有那份凭据，走的是匿名池。
  /// 填了账号 key（官网登录后只勾免费模型生成的）就会换到账号额度。
  freeUsageLimit,

  /// 免费层客户端校验未通过（指纹门）。换 key 无用。
  freeTier,

  /// 地区封锁（按出口 IP 判）。
  region,

  /// 模型已下线或不受免费层支持。
  modelUnsupported,

  /// 上游端点暂不可用（瞬态）。
  endpointUnavailable,

  auth,
  rateLimit,
  unknown,
}

class ZenErrorClass {
  final ZenErrorKind kind;

  /// 再发一次有没有意义。额度用尽不是重试能恢复的（换 IP/模型/身份都无效）；
  /// 指纹/地区同样不是重试能解决的。只有端点不可用是真瞬态。
  final bool transient;

  /// 「问题 + 原因 + 修复」一句话。不含上游原文——原文可能很长，且
  /// 出现在 UI 上不可折叠。
  final String message;

  const ZenErrorClass({
    required this.kind,
    required this.transient,
    required this.message,
  });
}

/// 2xx 才算成功。
///
/// 为什么需要这个函数：dio 的 `validateStatus: (s) => s < 500` 曾让 403 直接
/// 落到「连接成功」——两个连接测试按钮显示假成功，用户以为配好了。
bool isSuccessful(int? status) => status != null && status >= 200 && status < 300;

// 有序规则表：更具体的在前，命中即停。与电脑版 `_KIND_RULES` 同一顺序，
// 两边分开维护——手机不发同一份 JS，但改任一边时先看另一边是否同样适用。
final List<(ZenErrorKind, bool, RegExp)> _bodyRules = [
  (
    ZenErrorKind.freeUsageLimit,
    false,
    // 也认类名本身（`FreeUsageLimitError`）：上游有时只回类名，不带那句
    // "free usage limit"。电脑版的第一条正则少了这个空格容忍，实际靠后面
    // 的措辞兜底；手机这边没有第二层兜底，必须认得出类名。
    RegExp(
        r'free[\s_-]*usage[\s_-]*limite?rror|free[\s_-]*usage[\s_-]*limit|usage limit reached|quota exceeded|insufficient[_\s-]?quota',
        caseSensitive: false),
  ),
  (
    ZenErrorKind.freeTier,
    false,
    RegExp(r'freetiererror|free tier can only be used', caseSensitive: false),
  ),
  (
    ZenErrorKind.region,
    false,
    RegExp(r'regionerror|not available in your (?:country|region)',
        caseSensitive: false),
  ),
  (
    ZenErrorKind.modelUnsupported,
    false,
    RegExp(r'modelerror|is not supported|unsupported model',
        caseSensitive: false),
  ),
  (
    ZenErrorKind.endpointUnavailable,
    true,
    RegExp(r'endpoint is unavailable|upstream request failed',
        caseSensitive: false),
  ),
];

/// 把状态码 + 响应正文归类成用户能行动的一句话。
///
/// [body] 传上游响应正文的文本（先经 [bodyFromData] 物化）。这里只做识别，
/// 不回显原文；原文进日志由调用方决定。
ZenErrorClass classify(int? status, String body) {
  for (final (kind, transient, re) in _bodyRules) {
    if (re.hasMatch(body)) {
      return ZenErrorClass(kind: kind, transient: transient, message: _message(kind, status));
    }
  }

  if (status == 401 || status == 403) {
    return ZenErrorClass(
      kind: ZenErrorKind.auth,
      transient: false,
      message:
          '认证失败 ($status)：API key 无效或无权访问，请在设置里更新密钥',
    );
  }
  if (status == 429) {
    return ZenErrorClass(
      kind: ZenErrorKind.rateLimit,
      transient: true,
      message: '请求过频 (429)：请等待片刻再重试，或在设置里换用其它通道',
    );
  }
  if (status != null && status >= 500) {
    return ZenErrorClass(
      kind: ZenErrorKind.endpointUnavailable,
      transient: true,
      message: '上游异常 ($status)：模型服务暂不可用，请稍后重试',
    );
  }
  if (status == null) {
    return ZenErrorClass(
      kind: ZenErrorKind.unknown,
      transient: true,
      message: '请求失败：网络未连通，请检查网络后重试',
    );
  }
  return ZenErrorClass(
    kind: ZenErrorKind.unknown,
    transient: false,
    message: 'HTTP $status：上游拒绝请求，请检查模型名与端点，或换用其它通道',
  );
}

String _message(ZenErrorKind kind, int? status) {
  switch (kind) {
    case ZenErrorKind.freeUsageLimit:
      // 归因见枚举注释：换 IP / 换模型 / 换设备 / 重装都无效，唯一有效的动作
      // 是换成账号额度。文案必须给出这个动作，否则用户会去换网络白折腾。
      return '免费额度已用尽：这是未登录时的匿名共享池（换网络、换模型、重装都无效）。'
          '在设置里填入账号 Key（opencode 官网登录后只勾免费模型生成）即可走账号额度，'
          '或改用其它通道';
    case ZenErrorKind.freeTier:
      return '免费层客户端校验未通过 (403)：匿名请求未被识别为 OpenCode 客户端。'
          '填入账号 Key 后走账号额度、不再依赖这道校验；'
          '或确认端点是 opencode.ai/zen/v1';
    case ZenErrorKind.region:
      return '所在地区不可用 (403)：该模型按出口 IP 封锁，换 key 无用；'
          '请换用其它模型或通道';
    case ZenErrorKind.modelUnsupported:
      return '模型已下线或不受免费层支持：请在设置里换一个模型';
    case ZenErrorKind.endpointUnavailable:
      return '上游端点暂不可用：请稍后重试';
    case ZenErrorKind.auth:
      return '认证失败 ($status)：API key 无效或无权访问，请在设置里更新密钥';
    case ZenErrorKind.rateLimit:
      return '请求过频 (429)：请等待片刻再重试，或在设置里换用其它通道';
    case ZenErrorKind.unknown:
      return '请求失败：请检查网络后重试';
  }
}

/// 把 dio 拿到的响应体物化成文本，供 [classify] 识别。
///
/// ResponseBody（流式响应体）不在这里排干：排干要 await，而这个函数被
/// void 的错误处理器同步调用。Zen 路径上的流式错误体由
/// `ZenGate.materializeErrorBody` 在抛出前就换成字符串，
/// 到这里时 data 已经不是 ResponseBody 了。
String bodyFromData(dynamic data) {
  if (data is String) return data;
  if (data is Map || data is List) {
    try {
      return jsonEncode(data);
    } catch (_) {
      return data.toString();
    }
  }
  if (data == null) return '';
  return data.toString();
}

/// 排干一段响应体（错误正文通常是几百字节的小 JSON/HTML）。
///
/// 封顶 [maxBytes]：错误体不该把内存吃满，超限截断并注明——调用方拿它
/// 做的是正则识别，截断不影响命中。
Future<String> drainResponseBody(
  ResponseBody body, {
  int maxBytes = 64 * 1024,
}) async {
  final chunks = <int>[];
  var total = 0;
  var truncated = false;
  try {
    await for (final chunk in body.stream) {
      total += chunk.length;
      if (total > maxBytes) {
        final keep = chunk.length - (total - maxBytes);
        if (keep > 0) chunks.addAll(chunk.take(keep));
        truncated = true;
        break;
      }
      chunks.addAll(chunk);
    }
  } catch (_) {
    // 读了一半断掉也照常用已有的部分识别。
  }
  var text = utf8.decode(chunks, allowMalformed: true);
  if (truncated) text = '$text\n…(响应体超过 ${maxBytes ~/ 1024}KB，已截断)';
  return text;
}
