import 'dart:async';

import 'package:dio/dio.dart';

import '../gateway/khyos_api.dart';
import 'app_logger.dart';

/// 手机端「版本与更新」的只读探测。
///
/// WHY THIS EXISTS. 平台（khy-os 后端）的发布链是多渠道的——GitHub Releases /
/// PyPI / npm 三源并行，外加一个本地快照自愈源，逐源 env 门控。那条链的单一真源
/// 在后端（`latestVersionResolver` + `updateChannelRouter`）。手机**绝不**自己
/// 直连那三个仓库：那会是第三份探测实现、第三份凭据面（GitHub token / 代理），
/// 以及「后端说 1.2.1、手机说 1.1.7」这种没有症状、只是让用户的版本判断静默
/// 出错的分叉。手机只做两件事：把本机版本号报上去，把回来的读数**诚实**摆出来。
///
/// 什么算不诚实（后端红线，Dart 侧同样守）：
///   · 所有源都取不到时，**绝不**说「已是最新」——那是「查不到」，必须显示成
///     「查不到」，并给出每个源各自的原因（`latestVersionResolver` 的
///     `indeterminate` 就是这个意思，Dart 侧原样继承，不改写）；
///   · 一源被 env 关掉时说「已禁用」，不说「查不到」——两者对用户的下一步不同。
///
/// 纯函数部分（[compareVersions]、[numericVersion]、[classifyUpdateResult]、
/// [classifySourceOutcome]）不碰网络、不碰 channel，可单测；它们也是本文件唯一
/// 需要单测的部分——HTTP 行为要在真机上量，而那部分逻辑在后端。

/// 探测结论。**只有三态**，没有第四态，也没有「加载中」这种糊弄的中间态。
///
/// 三态各自对应用户能做的不同动作，混掉任何一个都会让用户做错下一步：
///   · [updateAvailable] → 去打开发布页；
///   · [upToDate] → 什么都不用做；
///   · [indeterminate] → 去看每个源的原因，或重试。
enum UpdateVerdict {
  /// 本机版本不低于最新发布版本。
  upToDate,

  /// 有更高的发布版本。
  updateAvailable,

  /// 判断不了。要么所有源都没取到，要么本机版本读不到——两种情况都不是
  /// 「已是最新」，UI 必须把 [UpdateCheckResult.indeterminateReason] 原样摆出来。
  indeterminate,
}

/// 单个更新源的结局。
///
/// 四态来自后端 `updateChannelRouter` 的级联语义：开着且取到 / 被 env 关掉 /
/// 开着但没取到 / 本地快照源（根本不是版本源，不参与比较）。
enum SourceOutcome {
  /// 取到了版本号。
  available,

  /// 渠道被 env 关掉（`KHY_SELF_UPDATE=0` 或 `KHY_UPDATE_ENABLE_<源>=0`）。
  /// 与 [missing] 分开：一个是「我们不查」，一个是「我们查了但没查到」。
  disabled,

  /// 渠道开着，但这次没取到版本。原因在 [UpdateSourceReading.error]。
  missing,

  /// 本地快照源。它不是版本源（它是安装态自愈源），所以既不报版本也不报失败。
  notAVersionSource,
}

/// 一个源的读数，与后端 `latestVersionResolver` 的 `sources[]` 元素一一对应。
class UpdateSourceReading {
  const UpdateSourceReading({
    required this.channel,
    required this.label,
    required this.enabled,
    required this.outcome,
    this.version,
    this.error,
  });

  final String channel;
  final String label;
  final bool enabled;
  final SourceOutcome outcome;

  /// 该源报出的版本号；取不到为 null。
  final String? version;

  /// 该源自己的失败原因；成功或被禁用时为 null。
  final String? error;

  /// 一行可读文本，形如 `PyPI v1.1.7` / `npm 请求超时` / `GitHub 渠道已禁用`。
  ///
  /// 在后端 `formatSources` 之上多覆盖一个本地快照源：后端那行只拼三个版本源，
  /// 直接用会把第四个源静默丢掉，而「本地快照没开」对用户是一件需要知道的事。
  String get readout {
    if (outcome == SourceOutcome.notAVersionSource) {
      return enabled ? '$label 不参与版本比较' : '$label 渠道已禁用';
    }
    if (version != null && version!.isNotEmpty) return '$label v$version';
    if (!enabled) return '$label 渠道已禁用';
    final why = (error ?? '').trim();
    return why.isEmpty ? '$label 未取到版本' : '$label $why';
  }
}

/// 一次探测的完整结果。UI 只读这个，不再自己判状态。
class UpdateCheckResult {
  const UpdateCheckResult({
    required this.verdict,
    required this.current,
    required this.latest,
    required this.sourceLabel,
    required this.indeterminateReason,
    required this.sources,
    required this.releasePage,
    required this.backendRunningVersion,
    required this.platformUpdateState,
    required this.releaseChannel,
  });

  /// 从后端 `GET /api/mobile-update/version` 的 data 解析而来。
  ///
  /// 解析失败一律返回 [UpdateVerdict.indeterminate] 而不是抛：这个方法的调用方
  /// 是 UI，一次形状不匹配应该显示「查不到 + 原因」，不该把整个设置页打穿。
  factory UpdateCheckResult.fromJson(
    Map<String, dynamic> data, {
    String current = kAppVersion,
  }) {
    final latest = _text(data['latest']);
    final indeterminate = data['indeterminate'] == true;
    final sources = _parseSources(data);
    final verdict = classifyUpdateResult(
      current: current,
      latest: latest,
      indeterminate: indeterminate,
    );
    final platformUpdate = data['platformUpdate'];
    final platformState =
        platformUpdate is Map ? _text(platformUpdate['state']) : '';
    final releaseChannel = _text(data['releaseChannel']);
    return UpdateCheckResult(
      verdict: verdict,
      current: current,
      latest: latest.isEmpty ? null : latest,
      sourceLabel: _text(data['sourceLabel']).isEmpty
          ? null
          : _text(data['sourceLabel']),
      indeterminateReason: _indeterminateReason(
        current: current,
        verdict: verdict,
        sources: sources,
      ),
      sources: sources,
      releasePage: _text(data['releasePage']).isEmpty
          ? null
          : _text(data['releasePage']),
      backendRunningVersion: _text(data['backendRunningVersion']).isEmpty
          ? null
          : _text(data['backendRunningVersion']),
      platformUpdateState:
          platformState.isEmpty ? null : platformState,
      // 缺省 stable 而不是空串：空串会让 UI 无法判断「后端没报轨道」和「轨道是
      // stable」，而这两件事对 preview 提示的显隐是相反的。
      releaseChannel: releaseChannel.isEmpty ? 'stable' : releaseChannel,
    );
  }

  final UpdateVerdict verdict;

  /// 本机版本（`kAppVersion`，编译期注入；调试构建可能是 'unknown'）。
  final String current;

  /// 取胜源报出的最新发布版本；[UpdateVerdict.indeterminate] 时为 null。
  final String? latest;

  /// 取胜源的显示名，如「PyPI」。
  final String? sourceLabel;

  /// 判不了的原因。只在 [UpdateVerdict.indeterminate] 时非空，UI 原样显示。
  final String? indeterminateReason;

  /// 四个源的读数，固定顺序：GitHub → PyPI → npm → 本地快照。
  final List<UpdateSourceReading> sources;

  /// 发布页地址；没配更新源时为 null（此时 UI 说「没有可打开的地址」）。
  final String? releasePage;

  /// 后端所在主机上正在运行的版本。**不参与判定**——手机端与平台是两条独立的
  /// 版本线（pubspec 1.1.x vs 后端 1.2.x），拿它比只会得到无意义的「你落后了」。
  final String? backendRunningVersion;

  /// 后端自己的更新状态（`updateCoordinator.readState().state`）。
  ///
  /// 它回答的是「后端自己那边有没有一个等着重启的新版本」，与手机要不要升级
  /// 是两件事。带上它是为了让设置页能解释一种 otherwise 很困惑的组合：发布链上
  /// 已经有新版，而后端还跑着旧的。
  final String? platformUpdateState;

  /// 后端采用的更新轨道：`stable` / `preview`。
  ///
  /// 带上它是为了把一件必须说出来的事说出来：**`preview` 目前不改变探测结果**。
  /// 后端 `latestVersionResolver` 按构造只取最高的非 prerelease 正式版，所以
  /// 选 preview 与选 stable 看到的是同一个版本号。不说，用户就会以为预览版已经
  /// 在生效——而那是一个没有任何症状的错误信念。
  final String releaseChannel;

  /// 每个源一行，拼成设置页里那行「诚实呈现」。
  String get sourceReadout => sources.map((s) => s.readout).join(' · ');
}

List<UpdateSourceReading> _parseSources(Map<String, dynamic> data) {
  final out = <UpdateSourceReading>[];
  final raw = data['sources'];
  if (raw is List) {
    for (final item in raw) {
      if (item is! Map) continue;
      final map = Map<String, dynamic>.from(item);
      final enabled = map['enabled'] != false;
      final version = _text(map['version']);
      final error = _text(map['error']);
      final label = _text(map['label']);
      final channel = _text(map['channel']);
      out.add(UpdateSourceReading(
        channel: channel,
        label: label.isEmpty ? channel : label,
        enabled: enabled,
        outcome: classifySourceOutcome(enabled: enabled, version: version),
        version: version.isEmpty ? null : version,
        error: error.isEmpty ? null : error,
      ));
    }
  }
  // 第四个源（本地快照）不在 latestVersionResolver 的 sources[] 里——它不是版本
  // 源。单独补上，否则设置页会漏掉「本地快照自愈没开」这条事实。放在循环外面，
  // 这样即使 sources 整个缺失，四个源的名额也还在。
  final localEnabled = data['localSourceEnabled'] != false;
  out.add(UpdateSourceReading(
    channel: 'local',
    label: '本地快照',
    enabled: localEnabled,
    outcome: SourceOutcome.notAVersionSource,
  ));
  return out;
}

/// 判不了时给用户看的那句话。verdict 不是 [UpdateVerdict.indeterminate] 时返回空。
///
/// 判据是 verdict 而不是后端那个 `indeterminate` 布尔：本机版本读不到时后端
/// 布尔是 false（它那一侧一切正常）， verdict 却是 indeterminate。只看布尔会把
/// 这句留空，UI 于是显示一句没有原因的「查不到」——正是这个功能要消灭的东西。
String _indeterminateReason({
  required String current,
  required UpdateVerdict verdict,
  required List<UpdateSourceReading> sources,
}) {
  if (verdict != UpdateVerdict.indeterminate) return '';
  if (!isComparableVersion(current)) {
    return '本机版本读不到（$current）：这是没有注入 FLUTTER_BUILD_NAME 的调试构建，'
        '无法与发布版本比较。装一个正式包即可看到结论。';
  }
  final tried = sources
      .where((s) => s.outcome != SourceOutcome.notAVersionSource)
      .map((s) => s.readout)
      .join('；');
  return '所有更新源都没取到版本，无法判断有没有新版${tried.isEmpty ? '' : '（$tried）'}。'
      '这不是「已是最新」。修复：确认电脑上的 khy-os 后端在跑，再点「重新检查」。';
}

/// 从版本串里取出可比较的数字核（`v1.2.3` → `1.2.3`）。
///
/// 与后端 `latestVersionResolver.numericVersion` 同义：发布链上的 tag 可能带
/// `v` 前缀或 prerelease 后缀，直接 split('.') 会把 `1.2.3-rc1` 的第三段变成
/// `3-rc1` 而悄悄判成 0。
String? numericVersion(String value) {
  final match = RegExp(r'\d+(?:\.\d+)*').firstMatch(value);
  return match == null ? null : match.group(0);
}

/// 版本号能否参与比较。'unknown' / 空串 / 取不出数字核 → false。
bool isComparableVersion(String value) {
  final core = numericVersion(value);
  return core != null && core.isNotEmpty;
}

/// 比较两个版本串。返回 >0 表示 a 更新，<0 表示 b 更新，0 表示相等。
///
/// 语义对齐后端 `versionService.compareVersions`（逐段比数字，缺段补 0），
/// 这样手机和后端对同一对版本不会给出不同答案。差别只有一处：后端 `Number()`
/// 遇到非数字段得到 NaN（于是整个比较静默变 NaN），这里把非数字段当 0，并在
/// [numericVersion] 一层就把非数字核剥掉。
int compareVersions(String a, String b) {
  final left = numericVersion(a) ?? '0';
  final right = numericVersion(b) ?? '0';
  final pa = left.split('.');
  final pb = right.split('.');
  for (var i = 0; i < (pa.length > pb.length ? pa.length : pb.length); i++) {
    final diff = _segment(pa, i) - _segment(pb, i);
    if (diff != 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

int _segment(List<String> parts, int index) {
  if (index >= parts.length) return 0;
  return int.tryParse(parts[index]) ?? 0;
}

/// 把一次探测归类成三态之一。纯函数。
UpdateVerdict classifyUpdateResult({
  required String current,
  String? latest,
  bool indeterminate = false,
}) {
  // 「所有源都没取到」和「本机版本读不到」都不是「已是最新」，都归 indeterminate，
  // 但原因不同（见 _indeterminateReason），不能合并成一句糊弄过去。
  if (indeterminate || latest == null || latest.isEmpty) {
    return UpdateVerdict.indeterminate;
  }
  if (!isComparableVersion(current)) return UpdateVerdict.indeterminate;
  return compareVersions(current, latest) >= 0
      ? UpdateVerdict.upToDate
      : UpdateVerdict.updateAvailable;
}

String _text(Object? value) => value == null ? '' : value.toString();

/// 把一个源的原始读数归类。纯函数，是「四源结果归类」单测的对象。
///
/// 与 [SourceOutcome] 的三分一一对应，之所以抽出来而不是内联进 [_parseSources]：
/// 「开着但没取到」和「被 env 关掉」在界面上是两句不同的话，而内联的三目运算符
/// 读不出这个区别，也就没法被单测钉住。
SourceOutcome classifySourceOutcome({
  required bool enabled,
  required String? version,
}) {
  if (!enabled) return SourceOutcome.disabled;
  if (version != null && version.isNotEmpty) return SourceOutcome.available;
  return SourceOutcome.missing;
}

/// 探测服务。HTTP 只有一条路：[KhyOsApi.apiFetch]。
///
/// 不复制 Dio：后端地址、Bearer 头、超时都只有一份实现，复制一份就意味着
/// 「改了连接配置而这里没跟着改」——那种漂移没有任何症状。
class UpdateCheckService {
  UpdateCheckService(this._api);

  final KhyOsApi _api;

  /// 挂载点由 `services/aiManagementServer.js` 的接线阶段统一办
  /// （authenticateToken + apiResponse 信封，与 `/api/eco-markets` 同款）。
  static const String path = '/api/mobile-update/version';

  /// 后端代查三个公共仓库。它们是**并行**探测（`latestVersionResolver.js:234` 的
  /// `Promise.all`），所以墙上时间约等于最慢那一个源的 8s
  /// （`UPDATE.PROBE_TIMEOUT_MS`），不是三个叠加。
  ///
  /// 25s 留了三倍余量，是**短生命周期网络请求**的超时（RUNTIME-003 合法例外）：
  /// 它防的是这个 HTTP 请求挂死，不是杀一个长时间运行的任务。真正在推进的活由
  /// 后端各自的 AbortController 管，这边只保证 UI 不会永远转下去。
  static const Duration timeout = Duration(seconds: 25);

  /// 探测一次。[current] 默认取编译期注入的 [kAppVersion]；[channel] 由调用方
  /// 从持久化配置传入（stable / preview，接线阶段接上 app_config 的渠道字段）。
  Future<UpdateCheckResult> check({
    String current = kAppVersion,
    String channel = 'stable',
  }) async {
    final response = await _api
        .apiFetch('$path?current=${Uri.encodeQueryComponent(current)}'
            '&channel=${Uri.encodeQueryComponent(channel)}')
        .timeout(timeout, onTimeout: () {
      throw const UpdateCheckException(
        '请求超时 (25s)：后端没有返回版本探测结果。'
        '修复：确认电脑上的 khy-os 后端仍在运行，再点「重新检查」。',
      );
    });

    final data = response.data;
    if (data is! Map) {
      throw const UpdateCheckException(
        '版本探测接口返回格式异常：缺少 data 对象。'
        '修复：确认手机连的是 khy-os 后端（不是管理页地址），或升级后端后重试。',
      );
    }
    final body = Map<String, dynamic>.from(data);
    if (body['success'] == false) {
      final error = body['error'];
      final message = error is Map ? _text(error['message']) : '';
      throw UpdateCheckException(message.isEmpty
          ? '版本探测失败：后端未提供原因。修复：重试，或在后端机器上跑 khy update --check 看具体哪个源不通。'
          : message);
    }
    final payload = body['data'];
    if (payload is! Map) {
      throw const UpdateCheckException(
        '版本探测接口返回格式异常：data 不是对象。'
        '修复：升级电脑上的 khy-os 后端到含移动端版本路由的版本后重试。',
      );
    }
    return UpdateCheckResult.fromJson(
      Map<String, dynamic>.from(payload),
      current: current,
    );
  }
}

/// 探测失败时抛给 UI 的一句话，已是「问题 + 原因 + 一行修复」。
class UpdateCheckException implements Exception {
  const UpdateCheckException(this.message);
  final String message;
  @override
  String toString() => message;
}
