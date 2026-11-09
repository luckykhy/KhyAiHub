import 'package:dio/dio.dart';

import 'khyos_api.dart';

/// 生态市场接口返回的失败（格式不对、后端拒绝、缺少 data）。
///
/// 与 DioException 分开：后者是"没连上/HTTP 非 2xx"，前者是"连上了、但这份
/// 载荷不能当市场用"。界面对两者的下一步不同，混成一种就分不出该重连还是该
/// 升级后端。
class MarketCatalogException implements Exception {
  final String message;

  const MarketCatalogException(this.message);

  @override
  String toString() => message;
}

String marketText(Object? value) => value is String ? value : '';

List<dynamic> marketList(Object? value) => value is List ? value : const <dynamic>[];

Map<String, dynamic> marketMap(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : const <String, dynamic>{};

int marketInt(Object? value) {
  if (value is num) return value.toInt();
  return int.tryParse('${value ?? ''}') ?? 0;
}

List<String> marketStrings(Object? value) => marketList(value)
    .map((item) => marketText(item))
    .where((item) => item.isNotEmpty)
    .toList(growable: false);

/// 一个生态分组的编目。entries/blocked 保持原始 Map：不同上游的字段差异很大
/// （阶跃带作者/头像/下载量，静态编目带兼容说明），在这里逐字段建模会把
/// "上游新增一个字段"变成"手机端解析失败"。
class EcoMarket {
  final String eco;
  final String title;
  final bool live;
  final String surveyedAt;
  final List<Map<String, dynamic>> entries;
  final List<Map<String, dynamic>> blocked;
  final List<Map<String, dynamic>> marketplaces;
  final List<String> uncertainties;
  final Map<String, int> counts;

  const EcoMarket({
    required this.eco,
    required this.title,
    required this.live,
    required this.surveyedAt,
    required this.entries,
    required this.blocked,
    required this.marketplaces,
    required this.uncertainties,
    required this.counts,
  });

  factory EcoMarket.fromJson(Map<String, dynamic> json) {
    final counts = <String, int>{};
    final rawCounts = marketMap(json['counts']);
    rawCounts.forEach((key, value) => counts[key] = marketInt(value));
    return EcoMarket(
      eco: marketText(json['eco']),
      title: marketText(json['title']),
      live: json['live'] == true,
      surveyedAt: marketText(json['surveyedAt']),
      entries: marketList(json['entries'])
          .map(marketMap)
          .where((entry) => entry.isNotEmpty)
          .toList(growable: false),
      blocked: marketList(json['blocked'])
          .map(marketMap)
          .where((entry) => entry.isNotEmpty)
          .toList(growable: false),
      marketplaces: marketList(json['marketplaces'])
          .map(marketMap)
          .where((source) => source.isNotEmpty)
          .toList(growable: false),
      uncertainties: marketStrings(json['uncertainties']),
      counts: counts,
    );
  }

  String get label => title.isNotEmpty ? title : eco;
}

/// 单个上游来源的新鲜度记录（marketCatalog 的 sources 记录）。
class MarketSourceStatus {
  final String id;
  final String title;
  final String kind;
  final String status;
  final String eco;
  final int entries;
  final int blocked;
  final String fetchedAt;
  final String message;

  const MarketSourceStatus({
    required this.id,
    required this.title,
    required this.kind,
    required this.status,
    required this.eco,
    required this.entries,
    required this.blocked,
    required this.fetchedAt,
    required this.message,
  });

  factory MarketSourceStatus.fromJson(Map<String, dynamic> json) => MarketSourceStatus(
        id: marketText(json['id']),
        title: marketText(json['title']),
        kind: marketText(json['kind']),
        status: marketText(json['status']),
        eco: marketText(json['eco']),
        entries: marketInt(json['entries']),
        blocked: marketInt(json['blocked']),
        fetchedAt: marketText(json['fetchedAt']),
        message: marketText(json['message']),
      );

  String get label => title.isNotEmpty ? title : id;
}

class MarketTotals {
  final int ecosystems;
  final int entries;
  final int blocked;
  final int installed;
  final int live;

  const MarketTotals({
    required this.ecosystems,
    required this.entries,
    required this.blocked,
    required this.installed,
    required this.live,
  });

  factory MarketTotals.fromJson(Map<String, dynamic> json) => MarketTotals(
        ecosystems: marketInt(json['ecosystems']),
        entries: marketInt(json['entries']),
        blocked: marketInt(json['blocked']),
        installed: marketInt(json['installed']),
        live: marketInt(json['live']),
      );
}

/// `GET /api/eco-markets` 的 data 载荷。
///
/// 计数、新鲜度和来源状态都由后端装配；手机端只格式化，不重新计算总数
/// （覆盖 totals 的只有"后端没给"这一种情况）。
class MarketCatalogPayload {
  final List<EcoMarket> ecosystems;
  final List<String> rules;
  final String licenseGate;
  final String generatedAt;
  final String fetchedAt;
  final bool refreshing;
  final String refreshStartedAt;
  final String refreshError;
  final List<MarketSourceStatus> sources;
  final MarketTotals? totals;
  final String degraded;
  final List<String> warnings;

  const MarketCatalogPayload({
    required this.ecosystems,
    required this.rules,
    required this.licenseGate,
    required this.generatedAt,
    required this.fetchedAt,
    required this.refreshing,
    required this.refreshStartedAt,
    required this.refreshError,
    required this.sources,
    required this.totals,
    required this.degraded,
    required this.warnings,
  });

  factory MarketCatalogPayload.fromJson(Map<String, dynamic> json) {
    final rawTotals = json['totals'];
    return MarketCatalogPayload(
      ecosystems: marketList(json['ecosystems'])
          .map(marketMap)
          .where((market) => market.isNotEmpty && marketText(market['eco']).isNotEmpty)
          .map(EcoMarket.fromJson)
          .toList(growable: false),
      rules: marketStrings(json['rules']),
      licenseGate: marketText(json['licenseGate']),
      generatedAt: marketText(json['generatedAt']),
      fetchedAt: marketText(json['fetchedAt']),
      refreshing: json['refreshing'] == true,
      refreshStartedAt: marketText(json['refreshStartedAt']),
      refreshError: marketText(json['refreshError']),
      sources: marketList(json['sources'])
          .map(marketMap)
          .where((source) => source.isNotEmpty)
          .map(MarketSourceStatus.fromJson)
          .toList(growable: false),
      totals: rawTotals is Map ? MarketTotals.fromJson(marketMap(rawTotals)) : null,
      degraded: marketText(json['degraded']),
      warnings: marketStrings(json['warnings']),
    );
  }

  MarketTotals get effectiveTotals {
    final given = totals;
    if (given != null) return given;
    var entries = 0;
    var blocked = 0;
    var installed = 0;
    var live = 0;
    for (final market in ecosystems) {
      entries += market.entries.length;
      blocked += market.blocked.length;
      installed += market.entries.where((entry) => entry['installed'] == true).length;
      if (market.live) live += 1;
    }
    return MarketTotals(
      ecosystems: ecosystems.length,
      entries: entries,
      blocked: blocked,
      installed: installed,
      live: live,
    );
  }
}

// ── 纯函数：搜索、命令、标签 ────────────────────────────────────────────────
// 这些是载荷形状的读法，和业务装配无关；放在这里是为了能用普通单测钉住，
// 而不是每改一次界面就得跑一遍真机。

String marketEntryName(Map<String, dynamic> entry) {
  final name = marketText(entry['name']).trim();
  return name.isEmpty ? '未命名条目' : name;
}

String marketEntryHaystack(Map<String, dynamic> entry) {
  const keys = <String>[
    'name',
    'what',
    'compatNote',
    'reason',
    'type',
    'license',
    'author',
    'command',
    'khyCommand',
  ];
  return keys
      .map((key) => marketText(entry[key]))
      .where((value) => value.isNotEmpty)
      .join(' ')
      .toLowerCase();
}

/// 市场条目的上游安装命令，或 KhyOS 侧的接入命令。
///
/// 与桌面端 accessCommand 同一判据：实时来源自带 khyCommand 时优先用它；
/// 静态编目只有"直连"条目能由 upstreamUrl 推出命令，其余必须看详情里的说明。
String? marketAccessCommand(Map<String, dynamic> entry) {
  final khyCommand = marketText(entry['khyCommand']).trim();
  if (khyCommand.isNotEmpty) return khyCommand;
  final upstream = marketText(entry['upstreamUrl']).trim();
  if (upstream.isEmpty) return null;
  if (marketText(entry['compat']) != 'direct') return null;
  switch (marketText(entry['khyosMarket'])) {
    case 'skill':
      return 'khy skill add $upstream';
    case 'extension':
      return 'khy ext install $upstream';
    default:
      return null;
  }
}

const Map<String, String> marketCategoryLabels = <String, String>{
  'office': '办公效率',
  'dev': '开发工具',
  'data': '数据与分析',
  'web': '搜索与浏览',
  'design': '设计媒体',
  'comm': '沟通协作',
  'ops': '系统运维',
  'security': '安全合规',
  'ai': 'AI 与模型',
  'other': '其他',
};

String marketCategoryLabel(Map<String, dynamic> entry) {
  final label = marketText(entry['categoryLabel']).trim();
  if (label.isNotEmpty) return label;
  return marketCategoryLabels[marketText(entry['category'])] ?? '其他';
}

String? marketInstallMode(Map<String, dynamic> entry) {
  final spec = marketMap(entry['installSpec']);
  final mode = marketText(spec['mode']);
  if (mode != 'skill' && mode != 'mcp') return null;
  final compat = marketText(entry['compat']);
  if (compat == 'blocked' || compat == 'covered') return null;
  return mode;
}

String marketEntryKey(Map<String, dynamic> entry, String eco) {
  final marketId = marketText(entry['marketId']).trim();
  if (marketId.isNotEmpty) return marketId;
  final scope = marketList(entry['agentScope']);
  final owner = scope.isNotEmpty ? marketText(scope.first) : eco;
  return '$owner:${marketText(entry['name'])}';
}

/// 一次安装/卸载的结局，透传后端 marketInstallService 的返回形状。
///
/// [partial] 必须单独一个字段：多技能仓库装上一半时后端返回 ok=true，
/// 把这种情况显示成"已安装"会让用户去找一个并不存在的技能。
class MarketInstallResult {
  final bool ok;
  final String mode;
  final bool partial;
  final String message;
  final List<String> artifacts;

  const MarketInstallResult({
    required this.ok,
    this.mode = '',
    this.partial = false,
    this.message = '',
    this.artifacts = const <String>[],
  });

  factory MarketInstallResult.fromJson(Map<String, dynamic> json) {
    final installed = marketList(json['installed'])
        .map(marketMap)
        .map((item) => marketText(item['name']).trim())
        .where((name) => name.isNotEmpty);
    final removed = marketList(json['removed'])
        .map(marketText)
        .map((name) => name.trim())
        .where((name) => name.isNotEmpty);
    return MarketInstallResult(
      ok: json['ok'] == true,
      mode: marketText(json['mode']),
      partial: json['partial'] == true,
      message: marketText(json['message']),
      artifacts: <String>{...installed, ...removed}.toList(growable: false),
    );
  }
}

/// 安装请求体：条目原样 + 表单收集的 env/headers。
///
/// 条目整体传给后端而不是挑字段：桌面端 Electron IPC 传的就是同一个 entry
/// 对象，手机端只是把同一执行面对 HTTP 暴露一次。在手机侧重建成一份字段，
/// 两边就会慢慢对不上，而那种分歧没有任何一方会报错。
Map<String, dynamic> marketInstallPayload(
  Map<String, dynamic> entry, {
  Map<String, String> env = const <String, String>{},
  Map<String, String> headers = const <String, String>{},
}) {
  return <String, dynamic>{
    'entry': entry,
    'values': <String, dynamic>{'env': env, 'headers': headers},
  };
}

String marketSourceStatusText(MarketSourceStatus source) {
  if (source.kind == 'static') return source.status == 'error' ? '读取失败' : '已载入';
  switch (source.status) {
    case 'ok':
      return '实时';
    case 'stale':
      return '缓存';
    case 'error':
      return '失败';
    case 'pending':
      return '拉取中';
    case 'off':
      return '已关闭';
    default:
      return source.status.isEmpty ? '未知' : source.status;
  }
}

// ── HTTP 客户端 ────────────────────────────────────────────────────────────

/// 生态市场的读取、登录与安装/卸载。
///
/// 只包一层，不复制 Dio：所有请求都走 [KhyOsApi.apiFetch]，这样后端地址、
/// 超时和 Bearer 头仍然只有一份实现。安装/卸载内部直调后端
/// marketInstallService——桌面 Electron IPC 调的是同一个服务、写同一个
/// 台账，手机端只是把同一执行面对 HTTP 暴露一次。
class MarketCatalogClient {
  final KhyOsApi api;

  const MarketCatalogClient(this.api);

  /// 快照本身是「立即返回 + 后台装配」，30 秒足够覆盖慢局域网；卡住不返回
  /// 通常意味着后端线程被别的东西占住，继续等不会自己好。
  static const Duration snapshotTimeout = Duration(seconds: 30);

  /// 安装/卸载端点（routes/skills.js）。与 /api/eco-markets 同级、同样挂在
  /// authenticateToken 后面；挂载由后端接线阶段统一办，这里不写第二处地址。
  static const String installPath = '/api/skills/install';
  static const String uninstallPath = '/api/skills/uninstall';

  Future<MarketCatalogPayload> load({bool force = false}) async {
    final response = await api
        .apiFetch('/api/eco-markets${force ? '?refresh=1' : ''}')
        .timeout(
          snapshotTimeout,
          onTimeout: () => throw const MarketCatalogException(
            '请求超时 (30s)：后端在 30 秒内没有返回市场快照。'
            '修复：确认电脑上的 khy-os 后端仍在运行，再点刷新重试。',
          ),
        );
    final data = _unwrap(response.data);
    if (data == null) {
      throw const MarketCatalogException(
        '生态市场接口返回格式异常：缺少 data 对象。'
        '修复：确认手机连的是 khy-os 后端（不是管理页地址），或升级后端后重试。',
      );
    }
    return MarketCatalogPayload.fromJson(data);
  }

  /// 用 khy-os 账号登录并把令牌写回连接配置。
  ///
  /// `/api/eco-markets` 挂在 authenticateToken 后面，配对二维码只带地址不带
  /// 令牌，所以第一次打开市场必然要在这里补一次登录。
  Future<void> signIn({required String username, required String password}) async {
    final connection = api.connection;
    if (connection == null) {
      throw const MarketCatalogException('尚未连接 khy-os 后端：请先填写后端地址并连接。');
    }
    final response = await api
        .apiFetch(
          '/api/auth/login',
          method: 'POST',
          data: <String, dynamic>{'username': username, 'password': password},
          auth: false,
        )
        .timeout(
          snapshotTimeout,
          onTimeout: () => throw const MarketCatalogException(
            '登录超时 (30s)：后端在 30 秒内没有回应。'
            '修复：确认后端仍在运行，手机与电脑在同一局域网，再重试。',
          ),
        );
    final data = _unwrap(response.data);
    if (data == null) {
      throw const MarketCatalogException('登录接口返回格式异常：缺少登录凭据。修复：升级后端后重试。');
    }
    final access = marketText(data['accessToken']).trim().isNotEmpty
        ? marketText(data['accessToken']).trim()
        : marketText(data['token']).trim();
    if (access.isEmpty) {
      throw const MarketCatalogException('登录成功但后端未返回访问令牌：请升级 khy-os 后端后重试。');
    }
    final refresh = marketText(data['refreshToken']).trim();
    final user = data['user'] is Map ? marketMap(data['user']) : null;
    await api.saveConnection(
      connection.copyWith(
        accessToken: access,
        refreshToken: refresh.isEmpty ? null : refresh,
        user: user,
      ),
    );
  }

  /// 登录态过期时静默续一次；没有刷新令牌或续期失败返回 false。
  Future<bool> refreshSession() async {
    final connection = api.connection;
    final refreshToken = connection?.refreshToken ?? '';
    if (connection == null || refreshToken.isEmpty) return false;
    try {
      final response = await api
          .apiFetch(
            '/api/auth/refresh',
            method: 'POST',
            data: <String, dynamic>{'refreshToken': refreshToken},
            auth: false,
          )
          .timeout(const Duration(seconds: 15));
      final data = _unwrap(response.data);
      final access = marketText(data?['accessToken']).trim();
      if (access.isEmpty) return false;
      final nextRefresh = marketText(data?['refreshToken']).trim();
      await api.saveConnection(
        connection.copyWith(
          accessToken: access,
          refreshToken: nextRefresh.isEmpty ? null : nextRefresh,
        ),
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  /// 安装一个市场条目（仅 skill / mcp 两种 mode，由后端 installSpec 决定）。
  ///
  /// 与 [load]/[signIn] 同一条传输路径：地址、超时与 Bearer 头只有
  /// [KhyOsApi.apiFetch] 一份实现，这里不再造第二个 Dio。超时取快照同一个
  /// 30s——它掐的是这次 HTTP 请求，后端安装（git 拉取）不会因为客户端不等了
  /// 就停：超时后要看「已安装」读数确认结局，别当成失败重装。
  Future<MarketInstallResult> install(
    Map<String, dynamic> entry, {
    Map<String, String> env = const <String, String>{},
    Map<String, String> headers = const <String, String>{},
  }) async {
    final response = await api
        .apiFetch(
          installPath,
          method: 'POST',
          data: marketInstallPayload(entry, env: env, headers: headers),
        )
        .timeout(
          snapshotTimeout,
          onTimeout: () => throw const MarketCatalogException(
            '安装请求超时 (30s)：后端在 30 秒内没有返回安装结果，安装可能仍在执行。'
            '修复：稍后刷新编目看该条目的「已安装」读数，再决定是否重试。',
          ),
        );
    final data = _unwrap(response.data, what: '安装接口');
    if (data == null) {
      throw const MarketCatalogException(
        '安装接口返回格式异常：缺少 data 对象。修复：升级 khy-os 后端后重试。',
      );
    }
    return MarketInstallResult.fromJson(data);
  }

  /// 卸载一个市场条目。后端按 market-installed.json 台账找到产物再删，
  /// 没有台账记录的条目会以失败信封返回，界面上是一条可读的拒绝原因。
  Future<MarketInstallResult> uninstall(Map<String, dynamic> entry) async {
    final response = await api
        .apiFetch(
          uninstallPath,
          method: 'POST',
          data: <String, dynamic>{'entry': entry},
        )
        .timeout(
          snapshotTimeout,
          onTimeout: () => throw const MarketCatalogException(
            '卸载请求超时 (30s)：后端在 30 秒内没有返回卸载结果。'
            '修复：稍后刷新编目确认「已安装」读数是否已消失，再重试。',
          ),
        );
    final data = _unwrap(response.data, what: '卸载接口');
    if (data == null) {
      throw const MarketCatalogException(
        '卸载接口返回格式异常：缺少 data 对象。修复：升级 khy-os 后端后重试。',
      );
    }
    return MarketInstallResult.fromJson(data);
  }

  Map<String, dynamic>? _unwrap(Object? body, {String what = '生态市场接口'}) {
    if (body is! Map) return null;
    final map = Map<String, dynamic>.from(body);
    if (map['success'] == false) {
      final error = map['error'];
      final message = error is Map
          ? marketText(error['message'])
          : marketText(map['message']);
      throw MarketCatalogException(
        message.isEmpty ? '$what 返回失败：后端未提供原因。' : message,
      );
    }
    final data = map['data'];
    return data is Map ? Map<String, dynamic>.from(data) : null;
  }
}

/// 把 Dio 错误翻译成"问题 + 识别码 + 修复建议"（规则 2.2）。
///
/// [action] 是正在做的那个动作（"读取生态市场"/"安装"/"卸载"）。同一个 404 或
/// 400 对读取和安装是两件事：读不到可以点刷新，一次被拒的安装刷新修不好；
/// 缺的接口也不是同一个（/api/eco-markets 与 /api/skills/install）。动词和
/// 端点都按动作选，否则用户会照着一条用不了的修复建议去做。
String marketDescribeDioError(DioException error, {String? baseUrl, String action = '读取生态市场'}) {
  final status = error.response?.statusCode;
  final data = error.response?.data;
  final reading = action == '读取生态市场';
  final retryHint = reading ? '再点刷新重试' : '再重试';
  var backendMessage = '';
  if (data is Map) {
    final envelope = Map<String, dynamic>.from(data);
    final detail = envelope['error'];
    if (detail is Map) backendMessage = marketText(detail['message']);
    if (backendMessage.isEmpty) backendMessage = marketText(envelope['message']);
  }
  switch (status) {
    case 401:
      final suffix = backendMessage.isEmpty ? '' : '（$backendMessage）';
      return '认证失败 (401)：未登录或登录态已失效$suffix。修复：在本页用 khy-os 账号登录后重试。';
    case 403:
      return '权限不足 (403)：当前账号无权$action。修复：换用管理员账号，或联系后端维护者分配权限。';
    case 404:
      // 安装/卸载的 404 只有一个成因：后端没挂载 routes/skills.js 这个命名空间。
      final endpoint = reading ? '/api/eco-markets' : '/api/skills/install 与 /api/skills/uninstall';
      return '接口不存在 (404)：后端没有 $endpoint。'
          '修复：确认连的是 khy-os 后端（不是 /admin/ 管理页），并把后端升级到包含'
          '${reading ? '统一市场装配' : '市场安装入口（routes/skills.js 挂载）'}的版本。';
    case 503:
      final reason = backendMessage.isEmpty ? '服务暂不可用' : backendMessage;
      return '服务暂不可用 (503)：$reason。修复：稍后$retryHint；仍失败请查看后端日志。';
  }
  switch (error.type) {
    case DioExceptionType.connectionTimeout:
    case DioExceptionType.receiveTimeout:
    case DioExceptionType.sendTimeout:
      return '请求超时：后端在等待时间内未响应'
          '${baseUrl == null ? '' : '（$baseUrl）'}。'
          '修复：确认电脑上的 khy-os 后端仍在运行、手机与电脑在同一网络，$retryHint。';
    case DioExceptionType.connectionError:
      return '网络连接失败：无法连到后端'
          '${baseUrl == null ? '' : '（$baseUrl）'}。'
          '修复：检查后端地址与端口，确认手机与电脑在同一局域网；关掉代理/VPN 后$retryHint。';
    default:
      final code = status == null ? '' : ' (HTTP $status)';
      final reason = backendMessage.isEmpty
          ? (error.message ?? '网络层未提供原因')
          : backendMessage;
      return '$action失败$code：$reason。修复：按上述原因处理后$retryHint；仍失败请查看后端日志。';
  }
}
