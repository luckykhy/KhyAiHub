import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../db/amoo_mirror_store.dart';
import '../gateway/key_pool.dart';
import '../services/app_logger.dart';
import 'amoo_mirror_account_store.dart';
import 'amoo_mirror_api.dart';
import 'amoo_mirror_cache.dart';
import 'amoo_mirror_config.dart';
import 'amoo_mirror_errors.dart';
import 'amoo_mirror_models.dart';

/// 同步器：把服务端有的会话与消息搬进本地库，一行都不删。
///
/// 只读镜像的全部网络出口就是这两个方法。本类只 import HTTP 客户端、本地库与
/// 配置——没有任何向 Amoo 提交内容的路径，也没有任何把 Amoo 拉起到前台的路径
/// （那需要 device_control / amoo_driver，它们一个都不在这里出现）。
///
/// 失败策略：单次失败只挂横幅、缓存照常展示；连续失败到阈值才转 offline。
/// 401/404/409/429 是契约错误码，各有明确语义，不计入连续失败——把限频算进
/// 「网络坏了」会让一次退避把界面推成离线。
class AmooMirrorSync extends ChangeNotifier {
  AmooMirrorSync({
    required AmooMirrorCache cache,
    AmooMirrorAccountStore? accounts,
    http.Client? client,
    DateTime Function()? clock,
    Duration? transportRetryDelay,
  })  : _cache = cache,
        _accounts = accounts ?? AmooMirrorAccountStore(),
        _client = client,
        _clock = clock ?? DateTime.now,
        _transportRetryDelay = transportRetryDelay ??
            const Duration(milliseconds: kAmooMirrorTransportRetryDelayMs);

  final AmooMirrorCache _cache;

  /// 账号（device_token + baseUrl）的读取面。同步器每轮重解一次：端点热更与
  /// 「换一把 token 就自动开闸」都建立在「不缓存账号」上。
  final AmooMirrorAccountStore _accounts;

  /// 仅供测试注入脚本化假 client；不拥有、不关闭（纪律同
  /// lib/core/ilink/ilink_api.dart:59-61）。
  final http.Client? _client;
  final DateTime Function() _clock;
  final Duration _transportRetryDelay;

  static final _log = AppLogger();

  AmooMirrorSyncState _state = const AmooMirrorSyncState();

  AmooMirrorSyncState get state => _state;

  /// 401 记下的那把 token。非空且等于当前 token = 闸门关着：同一把 token 永不
  /// 重试（契约的「禁止静默重试」）。换一把 token 或 acknowledgePairing 开闸。
  String? _pairingToken;

  /// 429 守门：now < _notBeforeMs 时本轮不发请求（force 除外）。
  int? _notBeforeMs;

  AmooMirrorApi? _api;
  String _apiBaseUrl = '';

  /// 本轮解出的 token。api 实例按 baseUrl 缓存（换端点才重建，否则每改一次
  /// 配置就漏一个 socket），token 却必须每轮新——把 token 捕获进构造闭包会
  /// 让「换一把 token 自动开闸」之后仍然拿着旧 token 打请求。
  String _token = '';
  Future<AmooMirrorSyncOutcome>? _sessionsFlight;
  Future<AmooMirrorSyncOutcome>? _messagesFlight;

  /// 屏幕 initState 调它。三分支：没配端点 → unconfigured（零请求）；有端点没
  /// token → needsPairing（零请求）；两者皆有 → idle。
  ///
  /// 401 闸门关着时**保持** needsPairing：服务端刚刚拒绝过这把 token，把界面
  /// 显示成就绪会让用户以为再拉一次就有数据。
  Future<void> ensureReady() async {
    final endpoint = await _resolveEndpoint();
    if (_unreadyOutcome(endpoint) != null) return;
    if (_pairingGateClosed(endpoint.token)) {
      _emit(_bannerState(
        AmooMirrorSyncStatus.needsPairing,
        kAmooMirrorUnauthorizedBanner,
      ));
      return;
    }
    _emit(_bannerState(AmooMirrorSyncStatus.idle, null));
  }

  /// 列表页进入与下拉刷新。GET /sessions → upsert 合并不删行。
  ///
  /// 并发同轮合流：第二次调用（含 force）拿到的是**同一个** Future，不是新起
  /// 一轮——下拉刷新撞上 initState 那一轮时各发一个请求，服务端就白挨一半。
  Future<AmooMirrorSyncOutcome> syncSessions({bool force = false}) {
    final running = _sessionsFlight;
    if (running != null) return running;
    final flight = _syncSessions(force: force).whenComplete(() {
      _sessionsFlight = null;
    });
    _sessionsFlight = flight;
    return flight;
  }

  /// 详情页打开与下拉刷新。cursor 增量至 hasMore=false。
  Future<AmooMirrorSyncOutcome> syncMessages(
    String sessionId, {
    bool force = false,
  }) {
    final running = _messagesFlight;
    if (running != null) return running;
    final flight = _syncMessages(sessionId, force: force).whenComplete(() {
      _messagesFlight = null;
    });
    _messagesFlight = flight;
    return flight;
  }

  /// 显式开闸 hook：设置页保存新 token 后调。与「换一把 token 自动开闸」开的是
  /// 同一把锁——闸门不是 latch，两扇门必须同时打得开，否则用户改完 token 仍被
  /// 旧 token 的 401 关在门外。
  void acknowledgePairing() {
    _pairingToken = null;
    if (_state.status == AmooMirrorSyncStatus.needsPairing) {
      _emit(_bannerState(AmooMirrorSyncStatus.idle, null));
    } else {
      notifyListeners();
    }
  }

  Future<AmooMirrorSyncOutcome> _syncSessions({required bool force}) async {
    final endpoint = await _resolveEndpoint();
    final blocked = _unreadyOutcome(endpoint);
    if (blocked != null) return blocked;
    final api = await _apiFor(endpoint);
    final gated = _gateOutcome(endpoint.token, force: force);
    if (gated != null) return gated;
    _emit(_bannerState(AmooMirrorSyncStatus.syncing, null));
    try {
      final page = await _fetchWithTransportRetry(api.fetchSessions);
      await _cache.upsertSessions(page.sessions);
      _emit(_successState());
      return AmooMirrorSyncOutcome.ok;
    } on AmooMirrorApiException catch (e) {
      return _handleApiFailure(e, endpoint);
    }
  }

  Future<AmooMirrorSyncOutcome> _syncMessages(
    String sessionId, {
    required bool force,
  }) async {
    final endpoint = await _resolveEndpoint();
    final blocked = _unreadyOutcome(endpoint);
    if (blocked != null) return blocked;
    final api = await _apiFor(endpoint);
    final gated = _gateOutcome(endpoint.token, force: force);
    if (gated != null) return gated;
    _emit(_bannerState(AmooMirrorSyncStatus.syncing, null));

    var cursor = AmooMirrorCursor.parse(await _cache.loadCursor(sessionId));
    var stalePulls = 0;
    var pages = 0;
    var added = 0;
    while (true) {
      if (pages >= kAmooMirrorMaxPages) {
        // 服务端 hasMore 恒真时的诚实截断：不说「同步完成」，只说本轮到此为止。
        _log.w(LogCategory.network, 'amoo 镜像消息翻页达到上限，本轮到此为止',
            details: <String, dynamic>{
              'session_id': sessionId,
              'pages': pages,
            });
        break;
      }
      pages++;
      final AmooMirrorMessagesPage page;
      try {
        page = await _fetchWithTransportRetry(
          () => api.fetchMessages(sessionId, cursor: cursor),
        );
      } on AmooMirrorApiException catch (e) {
        if (e.kind == AmooMirrorErrorKind.cursorStale &&
            stalePulls < kAmooMirrorCursorStaleRetries) {
          stalePulls++;
          // 清 cursor 让下一轮不带游标从头拉。本地行一律不删，靠 INSERT OR IGNORE
          // 合并——「历史不回退」靠的是不删，不是靠服务端承诺。
          await _cache.saveCursor(sessionId, null);
          cursor = null;
          pages = 0;
          _log.i(LogCategory.network, 'amoo 镜像游标失效 (409)，整体重拉一次',
              details: <String, dynamic>{'session_id': sessionId});
          continue;
        }
        if (e.kind == AmooMirrorErrorKind.cursorStale) {
          _emit(_bannerState(
            AmooMirrorSyncStatus.ok,
            kAmooMirrorCursorStaleGiveUp,
          ));
          return AmooMirrorSyncOutcome.cursorStale;
        }
        return _handleApiFailure(e, endpoint, sessionId: sessionId);
      }
      added += await _cache.insertMessages(sessionId, page.items);
      // 先落消息再存游标：存了游标却丢消息才是真丢，反过来只是多拉一页。
      await _cache.saveCursor(sessionId, page.nextCursor?.toString());
      if (page.nextCursor == null) {
        if (page.hasMore) {
          _log.w(LogCategory.network, 'amoo 镜像服务端称还有更多却不给游标，本轮到此为止',
              details: <String, dynamic>{'session_id': sessionId});
        }
        break;
      }
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    _emit(_successState(lastAdded: added));
    return AmooMirrorSyncOutcome.ok;
  }

  /// 每轮重解一次账号。返回记录而不是私有类：两个字段，多一个类型就只是为了
  /// 起名。
  Future<({String baseUrl, String token})> _resolveEndpoint() async {
    final account = await _accounts.load();
    return (
      baseUrl: resolveAmooMirrorBaseUrl(
        stored: account?.baseUrl ?? '',
        define: kAmooMirrorBaseUrlDefine,
      ),
      token: (account?.deviceToken ?? '').trim(),
    );
  }

  /// 端点变了才重建（旧实例自建的 client 要关掉，否则每改一次端点就漏一个
  /// socket）。注入的 client 不归 api 所有，close() 对它无效。token 不走重建
  /// 路径——它在 [_token] 里每轮更新。
  Future<AmooMirrorApi> _apiFor(({String baseUrl, String token}) endpoint) async {
    _token = endpoint.token;
    if (_api == null || _apiBaseUrl != endpoint.baseUrl) {
      final stale = _api;
      final fresh = AmooMirrorApi(
        client: _client,
        baseUrl: endpoint.baseUrl,
        tokenProvider: () async => _token,
      );
      _api = fresh;
      _apiBaseUrl = endpoint.baseUrl;
      await stale?.close();
      return fresh;
    }
    return _api!;
  }

  /// 429 守门 + 401 闸门。返回非 null = 本轮不发请求，状态已 emit。
  ///
  /// force 只跳过 429 守门：它是用户主动拉的那一下，等退避期满反而像坏了。
  /// force 不跳过 401 闸门——同一把 token 永不重试，恢复只有换 token 或
  /// acknowledgePairing 两条路。
  AmooMirrorSyncOutcome? _gateOutcome(
    String token, {
    required bool force,
  }) {
    if (!force && _rateLimited()) {
      _emit(_bannerState(
        AmooMirrorSyncStatus.rateLimited,
        kAmooMirrorRateLimitedBanner,
      ));
      return AmooMirrorSyncOutcome.rateLimited;
    }
    if (_pairingGateClosed(token)) {
      _emit(_bannerState(
        AmooMirrorSyncStatus.needsPairing,
        kAmooMirrorUnauthorizedBanner,
      ));
      return AmooMirrorSyncOutcome.needsPairing;
    }
    return null;
  }

  bool _rateLimited() {
    final until = _notBeforeMs;
    return until != null && _nowMs() < until;
  }

  bool _pairingGateClosed(String token) {
    final pinned = _pairingToken;
    return pinned != null && pinned == token;
  }

  /// 传输层失败在本调用内重试一次（只重试传输与超时——5xx/坏响应重放一字不差
  /// 只会拖慢并刷日志，判据同 ilink_send_policy.dart:82-92）。
  Future<T> _fetchWithTransportRetry<T>(
    Future<T> Function() call,
  ) async {
    for (var attempt = 1;; attempt++) {
      try {
        return await call();
      } on AmooMirrorApiException catch (e) {
        final retryable = e.kind == AmooMirrorErrorKind.transport ||
            e.kind == AmooMirrorErrorKind.timeout;
        if (!retryable || attempt > kAmooMirrorTransportRetries) rethrow;
        _log.i(LogCategory.network, 'amoo 镜像请求传输失败，本轮内重试一次',
            details: <String, dynamic>{
              'attempt': attempt,
              'kind': e.kind.name,
            });
        await Future.delayed(_transportRetryDelay);
      }
    }
  }

  AmooMirrorSyncOutcome _handleApiFailure(
    AmooMirrorApiException e,
    ({String baseUrl, String token}) endpoint, {
    String? sessionId,
  }) {
    switch (e.kind) {
      case AmooMirrorErrorKind.unauthorized:
        // 只钉非空 token：空 token 时请求根本没带 Authorization，把它钉进闸门
        // 会让「没配 token」也变成「永不重试」。
        if (endpoint.token.isNotEmpty) _pairingToken = endpoint.token;
        _log.w(LogCategory.network,
            'amoo 镜像鉴权失败 (401)，进入配对态，本轮不再重试',
            details: <String, dynamic>{'session_id': sessionId ?? ''});
        _emit(_bannerState(
          AmooMirrorSyncStatus.needsPairing,
          describeAmooMirrorError(e),
        ));
        return AmooMirrorSyncOutcome.needsPairing;

      case AmooMirrorErrorKind.notFound:
        // 本地行不删：服务端没了，用户已缓存的副本仍可看。
        _emit(_bannerState(
          AmooMirrorSyncStatus.ok,
          describeAmooMirrorError(e),
        ));
        return AmooMirrorSyncOutcome.sessionGone;

      case AmooMirrorErrorKind.rateLimited:
        final now = _nowMs();
        final cooldown = e.retryAfter == null
            ? kBaseCooldownMs
            : parseRetryAfterCooldown(e.retryAfter!, nowMs: now);
        _notBeforeMs = now + cooldown;
        _log.i(LogCategory.network, 'amoo 镜像被限频 (429)，按 Retry-After 退避',
            details: <String, dynamic>{
              'retry_after': e.retryAfter ?? '',
              'cooldown_ms': cooldown,
            });
        _emit(_bannerState(
          AmooMirrorSyncStatus.rateLimited,
          describeAmooMirrorError(e),
        ));
        return AmooMirrorSyncOutcome.rateLimited;

      case AmooMirrorErrorKind.cursorStale:
      case AmooMirrorErrorKind.server:
      case AmooMirrorErrorKind.badResponse:
      case AmooMirrorErrorKind.transport:
      case AmooMirrorErrorKind.timeout:
        // 消息路径的 409 在翻页循环里就拦截了，走到这里的是会话路径上的怪 409，
        // 当普通失败计。
        return _countFailure(e);
    }
  }

  AmooMirrorSyncOutcome _countFailure(AmooMirrorApiException e) {
    final failures = _state.consecutiveFailures + 1;
    final offline = failures >= kAmooMirrorMaxConsecutiveFailures;
    _log.w(
      LogCategory.network,
      offline ? 'amoo 镜像连续同步失败，转离线并展示缓存' : 'amoo 镜像本轮同步失败，继续展示缓存',
      details: <String, dynamic>{
        'kind': e.kind.name,
        'status': e.status ?? 0,
        'consecutive': failures,
      },
    );
    _emit(AmooMirrorSyncState(
      status: offline ? AmooMirrorSyncStatus.offline : AmooMirrorSyncStatus.ok,
      consecutiveFailures: failures,
      notBeforeMs: _notBeforeMs,
      message: offline
          ? kAmooMirrorOfflineBanner
          : '同步失败，展示缓存（第 $failures/$kAmooMirrorMaxConsecutiveFailures 次）',
      lastSyncAt: _state.lastSyncAt,
      lastAdded: _state.lastAdded,
    ));
    return AmooMirrorSyncOutcome.offline;
  }

  /// 三个「不该发请求」的分支，外加一个存储分支。返回非 null 时状态已 emit。
  AmooMirrorSyncOutcome? _unreadyOutcome(({String baseUrl, String token}) endpoint) {
    if (!_cache.isAvailable) {
      _emit(_bannerState(
        AmooMirrorSyncStatus.offline,
        kAmooMirrorStorageBanner,
      ));
      return AmooMirrorSyncOutcome.storageUnavailable;
    }
    if (endpoint.baseUrl.isEmpty) {
      _emit(_bannerState(
        AmooMirrorSyncStatus.unconfigured,
        kAmooMirrorUnconfiguredBanner,
      ));
      return AmooMirrorSyncOutcome.unconfigured;
    }
    if (endpoint.token.isEmpty) {
      _emit(_bannerState(
        AmooMirrorSyncStatus.needsPairing,
        kAmooMirrorNoTokenBanner,
      ));
      return AmooMirrorSyncOutcome.needsPairing;
    }
    return null;
  }

  /// 只改状态与横幅，其余字段原样带过去（失败不清 lastSyncAt——上次成功的
  /// 时间点仍是界面上「更新于」的唯一诚实来源）。
  AmooMirrorSyncState _bannerState(
    AmooMirrorSyncStatus status,
    String? message,
  ) {
    return AmooMirrorSyncState(
      status: status,
      consecutiveFailures: _state.consecutiveFailures,
      notBeforeMs: _notBeforeMs,
      message: message,
      lastSyncAt: _state.lastSyncAt,
      lastAdded: _state.lastAdded,
    );
  }

  AmooMirrorSyncState _successState({int? lastAdded}) {
    _notBeforeMs = null;
    return AmooMirrorSyncState(
      status: AmooMirrorSyncStatus.ok,
      consecutiveFailures: 0,
      lastSyncAt: _nowMs(),
      lastAdded: lastAdded,
    );
  }

  void _emit(AmooMirrorSyncState next) {
    _state = next;
    notifyListeners();
  }

  int _nowMs() => _clock().millisecondsSinceEpoch;

  @override
  void dispose() {
    // 自建 client 的关闭在这里补上；注入的那个不归本类所有。
    unawaited(_api?.close());
    super.dispose();
  }
}

/// 同步态 → 界面横幅的映射钉死在这里，防同步器与界面各写一套：
///   idle→就绪 / syncing→同步中 / ok→就绪（带 lastSyncAt）/
///   rateLimited→不可达（附剩余秒数）/ offline→不可达（「离线，展示缓存」）/
///   needsPairing→需要配对 / unconfigured→未配置
///
/// lib/ui/widgets/amoo_mirror_config_section.dart 的 AmooMirrorReadiness 是
/// **探测派生**（它自己发一次 fetchSessions），与本表两套来源，不要混用。
enum AmooMirrorSyncStatus { idle, syncing, ok, rateLimited, offline, needsPairing, unconfigured }

final class AmooMirrorSyncState {
  const AmooMirrorSyncState({
    this.status = AmooMirrorSyncStatus.idle,
    this.consecutiveFailures = 0,
    this.notBeforeMs,
    this.message,
    this.lastSyncAt,
    this.lastAdded,
  });

  final AmooMirrorSyncStatus status;

  /// 连续传输/服务端失败次数。401/404/409/429 不计。
  final int consecutiveFailures;

  /// 限频退避截止（epoch ms）；null = 没有守门。
  final int? notBeforeMs;

  /// 中文状态行（规则 2.2 三段式）；null = 无需解释。
  final String? message;

  /// 上一次**成功**同步的时间（epoch ms）。失败不清它。
  final int? lastSyncAt;

  /// 上一轮实际新增的消息条数（幂等的可观察证据）。
  final int? lastAdded;
}

enum AmooMirrorSyncOutcome {
  ok,
  needsPairing,
  sessionGone,
  cursorStale,
  rateLimited,
  offline,
  unconfigured,
  storageUnavailable,
}

/// 连续失败几次后转「离线，展示缓存」。阈值引用
/// lib/core/ilink/ilink_send_policy.dart:10-18 的 kIlinkBackoffThreshold=3
/// （只引用值，不 import——core/ilink/* 不在本次只读白名单内）。
const int kAmooMirrorMaxConsecutiveFailures = 3;

/// 服务端 hasMore 恒真时的诚实截断。
const int kAmooMirrorMaxPages = 50;

/// 409 全量重拉上限；越界诚实上报，不无限重拉。
const int kAmooMirrorCursorStaleRetries = 1;

/// 传输/超时在本调用内的重试次数。
const int kAmooMirrorTransportRetries = 1;

/// 两次尝试之间的间隔。构造参数可覆盖（测试传 Duration.zero）。
const int kAmooMirrorTransportRetryDelayMs = 1500;

/// 与 describeAmooMirrorError 的 401/429 分支逐字一致：闸门关闭发生在**下一
/// 轮**，那时抛出异常的实例已经不在了，横幅不能因此换一句话。
const String kAmooMirrorUnauthorizedBanner =
    '未授权 (401)：设备令牌无效或过期，请在设置「对话记录」重新配对（粘贴 device_token）';
const String kAmooMirrorRateLimitedBanner = '限频 (429)：请求过于频繁，请稍后重试';
const String kAmooMirrorOfflineBanner = '离线，展示缓存';
const String kAmooMirrorNoTokenBanner = '尚未配对：请在设置「对话记录」粘贴 device_token';
const String kAmooMirrorUnconfiguredBanner =
    '尚未配置：请在设置「对话记录」填写 Amoo 对话记录服务地址';
const String kAmooMirrorStorageBanner =
    '本地缓存不可用：对话记录既读不出也写不进，请重启应用';
const String kAmooMirrorCursorStaleGiveUp =
    '服务端持续拒绝游标 (409)，已停止重拉：请下拉刷新重试';

/// 应用级单例。列表页与详情页必须共享同一个同步器：各构造一份会让 401 闸门与
/// 失败计数在两个页面间对不上（一个页面刚配对完，另一个还在 needsPairing）。
///
/// 不注册 ref.onDispose(sync.dispose)：ChangeNotifierProvider 自己会 dispose
/// 它创建的这个 notifier（flutter_riverpod-2.6.1
/// lib/src/change_notifier_provider/base.dart:231-237），再挂一个就是第二次
/// dispose——ChangeNotifier.debugAssertNotDisposed 会红。
final amooMirrorSyncProvider = ChangeNotifierProvider<AmooMirrorSync>((ref) {
  return AmooMirrorSync(cache: AmooMirrorStore.instance);
});
