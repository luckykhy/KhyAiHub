import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/gateway/khyos_api.dart';
import '../../core/gateway/market_catalog.dart';
import '../../core/gateway/pairing.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import '../widgets/aurora.dart';
import 'qr_scan_screen.dart';

/// 插件市场（手机端可安装技能与 MCP 服务器）。
///
/// 数据来自后端 `GET /api/eco-markets`——与终端 `khy plugin market`、桌面端
/// 与网页版同一份装配结果，手机端不另算一份。安装/卸载走
/// `POST /api/skills/install|uninstall`，后端内部直调 marketInstallService：
/// 桌面 Electron IPC 调的是同一个服务、写同一个台账，手机端只是把同一执行面
/// 对 HTTP 暴露一次。任何「已安装」都是后端台账经编目装配后的真实读数，
/// 不是本页写下的。
///
/// 鉴权现实：配对二维码只带后端地址，不带令牌，而市场接口挂在
/// authenticateToken 后面。所以首次进入必然要在这里补一次 khy-os 账号登录，
/// 登录态过期时先静默续一次，续不上才让用户重登——不把 401 说成「网络错误」。
class PluginMarketScreen extends StatefulWidget {
  const PluginMarketScreen({super.key, this.api});

  /// 注入用。为空时本页自建一个并在 dispose 时释放。
  final KhyOsApi? api;

  @override
  State<PluginMarketScreen> createState() => _PluginMarketScreenState();
}

enum _MarketPhase { booting, needsAddress, needsLogin, loading, failed, ready }

class _PluginMarketScreenState extends State<PluginMarketScreen>
    with WidgetsBindingObserver {
  late final KhyOsApi _api;
  late final bool _ownsApi;
  late final MarketCatalogClient _client;

  final _addressController = TextEditingController();
  final _pairingController = TextEditingController();
  final _userController = TextEditingController();
  final _passwordController = TextEditingController();
  final _searchController = TextEditingController();

  _MarketPhase _phase = _MarketPhase.booting;
  MarketCatalogPayload? _payload;
  String? _error;
  String? _authError;
  bool _authBusy = false;
  bool _inFlight = false;
  bool _refreshing = false;
  bool _pollStopped = false;
  int _attempt = 0;
  int _pollCount = 0;
  Timer? _poll;

  String _query = '';
  String? _selectedEco;
  final Set<String> _expanded = <String>{};
  final Map<String, int> _limits = <String, int>{};

  static const int _pageSize = 25;
  static const int _maxPollAttempts = 60;

  @override
  void initState() {
    super.initState();
    _api = widget.api ?? KhyOsApi();
    _ownsApi = widget.api == null;
    _client = MarketCatalogClient(_api);
    WidgetsBinding.instance.addObserver(this);
    _boot();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _addressController.dispose();
    _pairingController.dispose();
    _userController.dispose();
    _passwordController.dispose();
    _searchController.dispose();
    if (_ownsApi) _api.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden) {
      _poll?.cancel();
      _poll = null;
      return;
    }
    if (state == AppLifecycleState.resumed && _phase == _MarketPhase.ready) {
      // 回前台时补一次：后台期间轮询已停，市场可能已经刷新完。
      _syncPolling();
      if (!_inFlight) _load();
    }
  }

  Future<void> _boot() async {
    try {
      final saved = await _api.loadConnection();
      if (saved != null) _addressController.text = saved.apiBaseUrl;
    } catch (_) {
      // 读不到安全存储不代表没配对过，下面按"没连过"处理并让用户重新填地址。
    }
    if (!mounted) return;
    final connection = _api.connection;
    if (connection == null || connection.apiBaseUrl.trim().isEmpty) {
      setState(() => _phase = _MarketPhase.needsAddress);
      return;
    }
    await _load();
  }

  /// 连接、读取、轮询三件事的共用入口。
  ///
  /// 只允许一个在途请求：下拉刷新与后台轮询撞在一起时，第二个请求会让
  /// 「第几次读取」与实际网络请求对不上，也会把旧响应覆盖到新响应上。
  Future<void> _load({bool force = false}) async {
    if (_inFlight) return;
    final connection = _api.connection;
    if (connection == null || connection.apiBaseUrl.trim().isEmpty) {
      if (mounted) setState(() => _phase = _MarketPhase.needsAddress);
      return;
    }

    _inFlight = true;
    _attempt += 1;
    if (mounted) {
      setState(() {
        _refreshing = force || _payload != null;
        _error = null;
        if (_payload == null) _phase = _MarketPhase.loading;
      });
    }

    try {
      MarketCatalogPayload payload;
      try {
        payload = await _client.load(force: force);
      } on DioException catch (e) {
        // 令牌过期是最常见的一种"突然全部失败"。静默续一次，续不上才让用户重登。
        if (e.response?.statusCode == 401 && await _client.refreshSession()) {
          payload = await _client.load(force: force);
        } else {
          rethrow;
        }
      }
      if (!mounted) return;
      setState(() {
        _payload = payload;
        _phase = _MarketPhase.ready;
        _error = null;
        _pollStopped = false;
        if (!payload.refreshing) _pollCount = 0;
      });
    } on DioException catch (e) {
      _handleLoadError(
        marketDescribeDioError(e, baseUrl: connection.apiBaseUrl),
        unauthorized: e.response?.statusCode == 401,
      );
    } on MarketCatalogException catch (e) {
      _handleLoadError(e.message, unauthorized: false);
    } catch (e) {
      _handleLoadError(
        '读取生态市场失败：$e。修复：点刷新重试；仍失败请查看后端日志。',
        unauthorized: false,
      );
    } finally {
      _inFlight = false;
      if (mounted) setState(() => _refreshing = false);
      _syncPolling();
    }
  }

  void _handleLoadError(String message, {required bool unauthorized}) {
    if (!mounted) return;
    setState(() {
      _error = message;
      if (unauthorized) {
        _phase = _MarketPhase.needsLogin;
        _authError = '登录态已失效 (401)：请用 khy-os 账号重新登录。';
        return;
      }
      // 有旧快照就留着旧快照并显示错误条；没有才退回整页错误。
      if (_payload == null) _phase = _MarketPhase.failed;
    });
  }

  /// 后端在后台装配实时来源时，`refreshing` 会保持 true。3 秒读一次直到它
  /// 变 false；60 次（约 3 分钟）后停手并说明读了多少次——不假装它完成了。
  void _syncPolling() {
    final shouldPoll =
        _payload?.refreshing == true && _phase == _MarketPhase.ready;
    if (!shouldPoll) {
      _poll?.cancel();
      _poll = null;
      return;
    }
    if (_poll != null) return;
    _pollCount = 0;
    _poll = Timer.periodic(const Duration(seconds: 3), (_) {
      if (_inFlight) return;
      if (_pollCount >= _maxPollAttempts) {
        _poll?.cancel();
        _poll = null;
        if (mounted) setState(() => _pollStopped = true);
        return;
      }
      _pollCount += 1;
      _load();
    });
  }

  Future<void> _connect() async {
    final raw = _addressController.text.trim().isNotEmpty
        ? _addressController.text.trim()
        : _pairingController.text.trim();
    if (raw.isEmpty) {
      setState(() {
        _phase = _MarketPhase.needsAddress;
        _error = '还没有后端地址：请填写电脑上 khy-os 的地址，或扫描 `khy mobile app` 的配对二维码。';
      });
      return;
    }

    final PairingPayload pairing;
    try {
      pairing = PairingPayloadParser.parse(raw);
    } on PairingParseException catch (e) {
      setState(() {
        _phase = _MarketPhase.needsAddress;
        _error = e.message;
      });
      return;
    }

    setState(() {
      _phase = _MarketPhase.loading;
      _error = null;
      _authError = null;
      _payload = null;
      _attempt = 0;
    });

    try {
      await _api.verifyAndSave(pairing.apiBaseUrl);
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _MarketPhase.needsAddress;
        _error = marketDescribeDioError(e, baseUrl: pairing.apiBaseUrl);
      });
      return;
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _MarketPhase.needsAddress;
        _error = '连接 ${pairing.apiBaseUrl} 失败：$e。修复：确认手机与电脑在同一局域网，'
            '且电脑上的 khy-os 后端已启动。';
      });
      return;
    }
    if (!mounted) return;
    await _load();
  }

  Future<void> _login() async {
    final username = _userController.text.trim();
    final password = _passwordController.text;
    if (username.isEmpty || password.isEmpty) {
      setState(() => _authError = '登录信息不完整：请填写用户名和密码后重试。');
      return;
    }
    setState(() {
      _authBusy = true;
      _authError = null;
    });
    try {
      await _client.signIn(username: username, password: password);
      if (!mounted) return;
      _passwordController.clear();
      setState(() {
        _phase = _MarketPhase.loading;
        _payload = null;
        _attempt = 0;
      });
      await _load();
    } on DioException catch (e) {
      if (!mounted) return;
      final status = e.response?.statusCode;
      setState(() {
        _authError = status == 401
            ? '认证失败 (401)：用户名或密码不正确。'
                '修复：确认是这台 khy-os 后端的账号（不是管理页或其它节点的），重新输入后重试。'
            : marketDescribeDioError(e, baseUrl: _api.connection?.apiBaseUrl);
      });
    } on MarketCatalogException catch (e) {
      if (mounted) setState(() => _authError = e.message);
    } catch (e) {
      if (mounted) {
        setState(() => _authError = '登录失败：$e。修复：确认后端仍在运行，稍后重试。');
      }
    } finally {
      if (mounted) setState(() => _authBusy = false);
    }
  }

  /// 安装/卸载共用：401 先静默续一次，续不上才把 Dio 错误翻译成
  /// 「问题 + 识别码 + 修复建议」。不把认证失败说成网络错误，也不把一次被拒的
  /// 安装说成"点刷新重试"——[action] 决定文案里的动词、端点与修复建议。
  Future<T> _withSessionRetry<T>(String action, Future<T> Function() call) async {
    try {
      return await call();
    } on DioException catch (e) {
      if (e.response?.statusCode == 401 && await _client.refreshSession()) {
        try {
          return await call();
        } on DioException catch (retry) {
          throw MarketCatalogException(
            marketDescribeDioError(retry, baseUrl: _api.connection?.apiBaseUrl, action: action),
          );
        }
      }
      throw MarketCatalogException(
        marketDescribeDioError(e, baseUrl: _api.connection?.apiBaseUrl, action: action),
      );
    }
  }

  Future<MarketInstallResult> _installEntry(
    Map<String, dynamic> entry, {
    Map<String, String> env = const <String, String>{},
    Map<String, String> headers = const <String, String>{},
  }) =>
      _withSessionRetry('安装', () => _client.install(entry, env: env, headers: headers));

  Future<MarketInstallResult> _uninstallEntry(Map<String, dynamic> entry) =>
      _withSessionRetry('卸载', () => _client.uninstall(entry));

  /// 安装/卸载结局的回执与刷新。
  ///
  /// 刷新用 force：台账在安装返回前就已落盘，但编目快照是上一次装配的副本，
  /// 「已安装」读数要等下一次装配才变。不假装它立刻变了——回执里说清楚。
  void _reportInstall(MarketInstallResult result) {
    if (!mounted) return;
    // 消息直接用后端原话：partial 的成败明细在里面，另加一句总结只会重复。
    final text = result.message.isEmpty ? '后端已完成操作。' : result.message;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(text, style: AppText.secondary),
        backgroundColor: result.partial ? AppColors.warning : AppColors.success,
        behavior: SnackBarBehavior.floating,
        margin: const EdgeInsets.all(AppSpacing.page),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.medium),
        ),
        duration: const Duration(seconds: 4),
      ),
    );
    _load(force: true);
  }

  Future<void> _switchAccount() async {
    final connection = _api.connection;
    if (connection == null) return;
    // copyWith 的 null 表示"不改"，所以清令牌要显式构造一个新连接。
    await _api.saveConnection(KhyOsConnection(apiBaseUrl: connection.apiBaseUrl));
    if (!mounted) return;
    _userController.clear();
    _passwordController.clear();
    setState(() {
      _phase = _MarketPhase.needsLogin;
      _payload = null;
      _authError = null;
      _error = null;
    });
  }

  void _toAddressPane() {
    setState(() {
      _phase = _MarketPhase.needsAddress;
      _error = null;
      _authError = null;
      _payload = null;
    });
  }

  Future<void> _scanQr() async {
    final result = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const QrScanScreen()),
    );
    if (!mounted || result == null || result.trim().isEmpty) return;
    _pairingController.text = result;
    setState(() => _error = null);
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    switch (_phase) {
      case _MarketPhase.booting:
        return _centeredNote(palette, '读取已保存的连接…');
      case _MarketPhase.needsAddress:
        return _addressPane(palette);
      case _MarketPhase.needsLogin:
        return _loginPane(palette);
      case _MarketPhase.failed:
        return _failedPane(palette);
      case _MarketPhase.loading:
        return _centeredNote(
          palette,
          _attempt <= 1 ? '读取生态市场编目（第 1 次）…' : '读取生态市场编目（第 $_attempt 次）…',
        );
      case _MarketPhase.ready:
        return _marketPane(palette);
    }
  }

  // ── 未连接：地址与配对 ────────────────────────────────────────────────────

  Widget _addressPane(AppPalette palette) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.page),
      children: [
        _panel(
          palette,
          icon: Icons.storefront_outlined,
          title: '插件市场',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '市场数据从电脑上的 khy-os 后端读取，与终端和桌面端是同一份编目。'
                '先连上你的节点；未连接时本页只读，连接并登录后技能与 MCP 条目可直接安装、卸载。',
                style: AppText.secondary
                    .copyWith(color: palette.textSecondary, height: 1.6),
              ),
              const SizedBox(height: AppSpacing.cardPad),
              TextField(
                controller: _addressController,
                keyboardType: TextInputType.url,
                autocorrect: false,
                decoration: const InputDecoration(
                  labelText: '后端地址',
                  hintText: '192.168.1.9:3000',
                  helperText: '可粘贴 `khy mobile app` 的配对内容，或直接填 host:port',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.link),
                ),
              ),
              const SizedBox(height: AppSpacing.cardGap),
              TextField(
                controller: _pairingController,
                maxLines: 3,
                minLines: 1,
                decoration: const InputDecoration(
                  labelText: '配对内容（可选）',
                  hintText: '{"apiBaseUrl":"http://192.168.1.9:3000"}',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.qr_code_2),
                ),
              ),
              const SizedBox(height: AppSpacing.cardGap),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _scanQr,
                      icon: const Icon(Icons.qr_code_scanner),
                      label: const Text('扫描配对码'),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.cardGap),
                  Expanded(
                    child: FilledButton(
                      onPressed: _connect,
                      child: const Text('连接并读取'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.cardGap),
              _note(
                palette,
                '扫 `khy mobile app` 生成的二维码。`khy mobile` 生成的是浏览器管理页地址，'
                '拿来当 API 根会 404，本页会直接拒绝。',
              ),
              if (_error != null) ...[
                const SizedBox(height: AppSpacing.cardGap),
                _banner(palette, _error!, tone: palette.error),
              ],
            ],
          ),
        ),
      ],
    );
  }

  // ── 已连接但未登录 ────────────────────────────────────────────────────────

  Widget _loginPane(AppPalette palette) {
    final base = _api.connection?.apiBaseUrl ?? '';
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.page),
      children: [
        _panel(
          palette,
          icon: Icons.lock_outline,
          title: '登录 khy-os',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '市场接口需要登录。后端：${base.isEmpty ? '（未知）' : base}',
                style: AppText.secondary
                    .copyWith(color: palette.textSecondary, height: 1.6),
              ),
              const SizedBox(height: AppSpacing.cardPad),
              TextField(
                controller: _userController,
                autocorrect: false,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(
                  labelText: '用户名',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.person_outline),
                ),
              ),
              const SizedBox(height: AppSpacing.cardGap),
              TextField(
                controller: _passwordController,
                obscureText: true,
                onSubmitted: (_) => _login(),
                decoration: const InputDecoration(
                  labelText: '密码',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.key_outlined),
                ),
              ),
              const SizedBox(height: AppSpacing.cardPad),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _authBusy ? null : _login,
                  child: _authBusy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('登录并读取市场'),
                ),
              ),
              if (_authError != null) ...[
                const SizedBox(height: AppSpacing.cardGap),
                _banner(palette, _authError!, tone: palette.error),
              ],
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: _toAddressPane,
                  child: const Text('改用其它后端地址'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  // ── 读取失败且没有旧快照 ──────────────────────────────────────────────────

  Widget _failedPane(AppPalette palette) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.page),
      children: [
        _panel(
          palette,
          icon: Icons.cloud_off_outlined,
          title: '读取市场失败',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _banner(palette, _error ?? '原因未知。', tone: palette.error),
              const SizedBox(height: AppSpacing.cardPad),
              Row(
                children: [
                  Expanded(
                    child: FilledButton(
                      onPressed: _load,
                      child: const Text('重试'),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.cardGap),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _toAddressPane,
                      child: const Text('改后端地址'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  // ── 市场主视图 ────────────────────────────────────────────────────────────

  Widget _marketPane(AppPalette palette) {
    final payload = _payload!;
    final totals = payload.effectiveTotals;
    final refreshing = payload.refreshing;
    final filtered = _visibleMarkets(payload);

    return RefreshIndicator(
      onRefresh: () => _load(force: true),
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.page),
        children: [
          _syncHeader(palette, payload, totals, refreshing),
          if (_error != null) ...[
            const SizedBox(height: AppSpacing.cardGap),
            _banner(palette, _error!, tone: palette.error),
          ],
          if (payload.degraded.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.cardGap),
            _banner(palette, '降级运行：${payload.degraded}', tone: palette.warning),
          ],
          if (payload.refreshError.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.cardGap),
            _banner(palette, '上次刷新失败：${payload.refreshError}', tone: palette.warning),
          ],
          if (payload.warnings.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.cardGap),
            _warningCard(palette, payload.warnings),
          ],
          const SizedBox(height: AppSpacing.cardGap),
          _sourcesCard(palette, payload),
          const SizedBox(height: AppSpacing.cardGap),
          TextField(
            controller: _searchController,
            onChanged: (value) => setState(() {
              _query = value;
              _limits.clear();
            }),
            decoration: InputDecoration(
              hintText: '搜索插件名、用途、作者或命令',
              border: const OutlineInputBorder(),
              prefixIcon: const Icon(Icons.search),
              suffixIcon: _query.isEmpty
                  ? null
                  : IconButton(
                      icon: const Icon(Icons.close),
                      onPressed: () {
                        _searchController.clear();
                        setState(() {
                          _query = '';
                          _limits.clear();
                        });
                      },
                    ),
            ),
          ),
          const SizedBox(height: AppSpacing.cardGap),
          if (payload.ecosystems.isEmpty)
            _emptyCard(palette)
          else ...[
            _ecoFilter(palette),
            const SizedBox(height: AppSpacing.cardGap),
            ..._resultBlocks(palette, filtered),
          ],
          const SizedBox(height: AppSpacing.section),
          _rulesCard(palette, payload),
        ],
      ),
    );
  }

  Widget _syncHeader(
    AppPalette palette,
    MarketCatalogPayload payload,
    MarketTotals totals,
    bool refreshing,
  ) {
    final user = _api.connection?.user;
    final username = user == null ? '' : marketText(user['username']);
    final synced = _formatTimestamp(payload.fetchedAt);
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPad),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const GradientTile(icon: Icons.storefront_outlined, size: 36),
              const SizedBox(width: AppSpacing.inner),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('插件市场',
                        style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
                    Text(
                      'khy-os 生态编目 · 只读'
                      '${username.isEmpty ? '' : ' · $username'}',
                      style: AppText.label.copyWith(color: palette.textSecondary),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: '刷新市场',
                onPressed: _inFlight || refreshing ? null : () => _load(force: true),
                icon: _refreshing
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.refresh),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.cardGap),
          Wrap(
            spacing: AppSpacing.dense,
            runSpacing: AppSpacing.dense,
            children: [
              _stat(palette, '生态', totals.ecosystems),
              _stat(palette, '条目', totals.entries),
              _stat(palette, '已安装', totals.installed),
              _stat(palette, '屏蔽', totals.blocked),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          Row(
            children: [
              Icon(
                refreshing ? Icons.sync : Icons.schedule,
                size: 14,
                color: refreshing ? palette.primary : palette.textSecondary,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  _freshnessLine(payload, refreshing, synced),
                  style: AppText.label.copyWith(color: palette.textSecondary),
                ),
              ),
            ],
          ),
          if (_pollStopped && refreshing) ...[
            const SizedBox(height: AppSpacing.dense),
            _banner(
              palette,
              '后端装配超过 $_maxPollAttempts 次自动重读（约 3 分钟），已停止自动刷新。'
              '市场可能仍在装配：下拉刷新重试，或查看后端日志。',
              tone: palette.warning,
            ),
          ],
          Align(
            alignment: Alignment.centerLeft,
            child: _api.connection?.isAuthenticated == true
                ? TextButton(
                    onPressed: _switchAccount,
                    child: const Text('切换账号'),
                  )
                : const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }

  String _freshnessLine(
    MarketCatalogPayload payload,
    bool refreshing,
    String synced,
  ) {
    if (refreshing) {
      final started = _formatTimestamp(payload.refreshStartedAt);
      final wait = started.isEmpty ? '' : '，开始于 $started';
      return '后台装配实时来源：第 ${_pollCount + 1} 次读取$wait';
    }
    if (synced.isEmpty) return '编目尚未同步';
    return '编目同步于 $synced';
  }

  Widget _stat(AppPalette palette, String label, int value) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.dense, vertical: 4),
      decoration: BoxDecoration(
        color: palette.surfaceHigh,
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Text(
        '$label $value',
        style: AppText.label.copyWith(color: palette.textPrimary),
      ),
    );
  }

  Widget _sourcesCard(AppPalette palette, MarketCatalogPayload payload) {
    if (payload.sources.isEmpty) {
      return _note(palette, '后端没有提供来源状态：只能确认编目存在，无法确认每个实时来源的新鲜度。');
    }
    return _panel(
      palette,
      icon: Icons.dns_outlined,
      title: '来源状态',
      child: Wrap(
        spacing: AppSpacing.dense,
        runSpacing: AppSpacing.dense,
        children: [
          for (final source in payload.sources)
            _sourceChip(palette, source),
        ],
      ),
    );
  }

  Widget _sourceChip(AppPalette palette, MarketSourceStatus source) {
    final tone = switch (source.status) {
      'ok' => palette.success,
      'stale' => palette.warning,
      'error' => palette.error,
      'pending' => palette.primary,
      'off' => palette.textSecondary,
      _ => source.kind == 'static' && source.status != 'error'
          ? palette.success
          : palette.error,
    };
    final label = marketSourceStatusText(source);
    final count = source.kind == 'static' ? '' : ' · ${source.entries} 条';
    final message = source.message.trim();
    return Tooltip(
      message: message.isEmpty ? '${source.label}：$label' : '${source.label}：$message',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.dense, vertical: 5),
        decoration: BoxDecoration(
          color: tone.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(AppRadius.small),
          border: Border.all(color: tone.withValues(alpha: 0.35), width: AppStroke.thin),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.circle, size: 6, color: tone),
            const SizedBox(width: 5),
            Text(
              '${source.label} · $label$count',
              style: AppText.label.copyWith(color: palette.textPrimary),
            ),
          ],
        ),
      ),
    );
  }

  Widget _warningCard(AppPalette palette, List<String> warnings) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.warning.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(
          color: palette.warning.withValues(alpha: 0.35),
          width: AppStroke.thin,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '来源警告 ${warnings.length} 条',
            style: AppText.cardTitle.copyWith(color: palette.warning),
          ),
          const SizedBox(height: 4),
          for (final warning in warnings)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '· $warning',
                style: AppText.secondary
                    .copyWith(color: palette.textPrimary, height: 1.5),
              ),
            ),
        ],
      ),
    );
  }

  Widget _ecoFilter(AppPalette palette) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          _filterChip(palette, null, '全部'),
          for (final market in _payload!.ecosystems) ...[
            const SizedBox(width: AppSpacing.dense),
            _filterChip(
              palette,
              market.eco,
              '${market.label} ${market.entries.length}',
            ),
          ],
        ],
      ),
    );
  }

  Widget _filterChip(AppPalette palette, String? eco, String label) {
    final selected = _selectedEco == eco;
    return ChoiceChip(
      label: Text(label, style: AppText.label),
      selected: selected,
      onSelected: (_) => setState(() {
        _selectedEco = selected ? null : eco;
        _limits.clear();
        if (eco != null) _expanded.add(eco);
      }),
      selectedColor: palette.primary.withValues(alpha: 0.18),
      labelStyle: AppText.label.copyWith(
        color: selected ? palette.primary : palette.textSecondary,
      ),
      side: BorderSide(
        color: selected ? palette.primary.withValues(alpha: 0.5) : palette.stroke,
        width: AppStroke.thin,
      ),
      showCheckmark: false,
      backgroundColor: palette.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.pill),
      ),
    );
  }

  List<EcoMarket> _visibleMarkets(MarketCatalogPayload payload) {
    final eco = _selectedEco;
    if (eco == null) return payload.ecosystems;
    return payload.ecosystems.where((market) => market.eco == eco).toList(growable: false);
  }

  List<Widget> _resultBlocks(AppPalette palette, List<EcoMarket> markets) {
    final query = _query.trim().toLowerCase();
    if (query.isNotEmpty) {
      final hits = <({EcoMarket market, Map<String, dynamic> entry})>[];
      for (final market in markets) {
        for (final entry in market.entries) {
          if (marketEntryHaystack(entry).contains(query)) {
            hits.add((market: market, entry: entry));
          }
        }
      }
      if (hits.isEmpty) {
        return [
          _note(
            palette,
            '没有匹配「$_query」的条目（已搜索 ${markets.fold<int>(0, (sum, m) => sum + m.entries.length)} 条）。'
            '换个关键词，或清空搜索看全部。',
          ),
        ];
      }
      final limit = _limits['__search'] ?? 30;
      final shown = hits.length > limit ? hits.sublist(0, limit) : hits;
      return [
        Text(
          '搜索「$_query」：${hits.length} 条',
          style: AppText.cardTitle.copyWith(color: palette.textPrimary),
        ),
        const SizedBox(height: AppSpacing.dense),
        for (final hit in shown) _entryTile(palette, hit.market, hit.entry),
        if (hits.length > shown.length)
          _moreButton(palette, '__search', shown.length, hits.length),
      ];
    }

    return [
      for (final market in markets) ...[
        _ecoCards(palette, market),
        const SizedBox(height: AppSpacing.cardGap),
      ],
    ];
  }

  Widget _ecoCards(AppPalette palette, EcoMarket market) {
    final expanded = _selectedEco == market.eco || _expanded.contains(market.eco);
    final limit = _limits[market.eco] ?? _pageSize;
    final shown = market.entries.length > limit
        ? market.entries.sublist(0, limit)
        : market.entries;
    return Container(
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(AppRadius.medium),
            onTap: () => setState(() {
              if (!_expanded.remove(market.eco)) _expanded.add(market.eco);
            }),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
              child: Row(
                children: [
                  Icon(
                    market.live ? Icons.bolt : Icons.inventory_2_outlined,
                    size: 18,
                    color: market.live ? palette.primary : palette.textSecondary,
                  ),
                  const SizedBox(width: AppSpacing.dense),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          market.label,
                          style: AppText.body.copyWith(
                            fontWeight: FontWeight.w600,
                            color: palette.textPrimary,
                          ),
                        ),
                        Text(
                          '${market.entries.length} 条'
                          '${market.blocked.isEmpty ? '' : ' · 屏蔽 ${market.blocked.length}'}'
                          '${market.live ? ' · 实时来源' : ' · 静态勘察'}',
                          style: AppText.label.copyWith(color: palette.textSecondary),
                        ),
                      ],
                    ),
                  ),
                  Icon(
                    expanded ? Icons.expand_less : Icons.expand_more,
                    color: palette.textSecondary,
                  ),
                ],
              ),
            ),
          ),
          if (expanded) ...[
            const Divider(height: 1),
            for (final entry in shown) _entryTile(palette, market, entry),
            if (market.entries.length > shown.length)
              _moreButton(palette, market.eco, shown.length, market.entries.length),
            if (market.entries.isEmpty)
              Padding(
                padding: const EdgeInsets.all(AppSpacing.cardPad),
                child: Text(
                  '这个生态返回了 0 个条目：看来源状态与警告判断是上游为空还是拉取失败。',
                  style: AppText.secondary.copyWith(color: palette.textSecondary),
                ),
              ),
            if (market.blocked.isNotEmpty) _blockedBlock(palette, market),
            if (market.uncertainties.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.cardPad,
                  AppSpacing.dense,
                  AppSpacing.cardPad,
                  AppSpacing.cardPad,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('不确定项', style: AppText.label.copyWith(color: palette.warning)),
                    for (final note in market.uncertainties)
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                          '· $note',
                          style: AppText.secondary.copyWith(
                            color: palette.textPrimary,
                            height: 1.5,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ],
        ],
      ),
    );
  }

  Widget _moreButton(AppPalette palette, String key, int shown, int total) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.dense),
        child: TextButton(
          onPressed: () => setState(() => _limits[key] = shown + _pageSize),
          child: Text('继续显示剩余 ${total - shown} 条'),
        ),
      ),
    );
  }

  Widget _blockedBlock(AppPalette palette, EcoMarket market) {
    return Container(
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.cardPadNarrow,
        0,
        AppSpacing.cardPadNarrow,
        AppSpacing.cardPadNarrow,
      ),
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.error.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(
          color: palette.error.withValues(alpha: 0.25),
          width: AppStroke.thin,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '屏蔽条目 ${market.blocked.length} 条（不能安装，保留原因便于核对）',
            style: AppText.label.copyWith(color: palette.error),
          ),
          const SizedBox(height: 4),
          for (final entry in market.blocked)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '· ${marketEntryName(entry)}'
                '${_reasonOf(entry).isEmpty ? '' : '：${_reasonOf(entry)}'}',
                style: AppText.secondary.copyWith(
                  color: palette.textPrimary,
                  height: 1.5,
                ),
              ),
            ),
        ],
      ),
    );
  }

  String _reasonOf(Map<String, dynamic> entry) {
    final reason = marketText(entry['reason']).trim();
    if (reason.isNotEmpty) return reason;
    return marketText(entry['compatNote']).trim();
  }

  Widget _entryTile(
    AppPalette palette,
    EcoMarket market,
    Map<String, dynamic> entry,
  ) {
    final installed = entry['installed'] == true;
    final meta = <String>[
      marketCategoryLabel(entry),
      _typeLabel(entry),
      if (marketText(entry['license']).isNotEmpty) marketText(entry['license']),
    ].where((part) => part.trim().isNotEmpty).join(' · ');

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () => _showEntry(entry),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.cardPad,
            AppSpacing.cardPadNarrow,
            AppSpacing.cardPad,
            AppSpacing.cardPadNarrow,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      marketEntryName(entry),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppText.body.copyWith(
                        fontWeight: FontWeight.w600,
                        color: palette.textPrimary,
                      ),
                    ),
                  ),
                  if (installed)
                    const Padding(
                      padding: EdgeInsets.only(left: AppSpacing.dense),
                      child: StatusPill(
                        label: '已安装',
                        tone: StatusPillTone.success,
                      ),
                    ),
                ],
              ),
              if (meta.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    meta,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.label.copyWith(color: palette.textSecondary),
                  ),
                ),
              if (_summaryOf(entry).isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    _summaryOf(entry),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.secondary.copyWith(
                      color: palette.textSecondary,
                      height: 1.5,
                    ),
                  ),
                ),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  _badge(palette, market, entry),
                  if (marketText(entry['khyosMarket']).isNotEmpty &&
                      marketText(entry['compat']) != 'covered')
                    _tag(palette, _routeLabel(entry)),
                  if (marketText(entry['compat']) == 'covered')
                    _tag(palette, '原生'),
                  if (marketInstallMode(entry) != null)
                    _tag(palette, '可装 ${_modeLabel(marketInstallMode(entry)!)}'),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _summaryOf(Map<String, dynamic> entry) {
    final what = marketText(entry['what']).trim();
    if (what.isNotEmpty) return what;
    return marketText(entry['compatNote']).trim();
  }

  String _typeLabel(Map<String, dynamic> entry) {
    final type = marketText(entry['type']).trim();
    const labels = <String, String>{
      'skill': '技能',
      'plugin': '插件',
      'agent': 'Agent',
      'experience': '经验',
      'trigger': '触发器',
      'connector': '通信器',
      'mcp': 'MCP',
    };
    if (type.isEmpty) return '';
    return labels[type] ?? type;
  }

  String _routeLabel(Map<String, dynamic> entry) {
    switch (marketText(entry['khyosMarket'])) {
      case 'skill':
        return 'Skill';
      case 'mcp':
        return 'MCP';
      case 'extension':
        return '拓展';
      case 'none':
        return '不路由';
      default:
        return marketText(entry['khyosMarket']);
    }
  }

  String _modeLabel(String mode) => mode == 'mcp' ? 'MCP 服务器' : '技能';

  Widget _badge(AppPalette palette, EcoMarket market, Map<String, dynamic> entry) {
    final compat = marketText(entry['compat']);
    switch (compat) {
      case 'direct':
        return _tag(palette, '直连', color: palette.success);
      case 'adapter-needed':
        return _tag(palette, '需适配', color: palette.warning);
      case 'covered':
        return _tag(palette, '已覆盖', color: palette.success);
      case 'blocked':
        return _tag(palette, '阻塞', color: palette.error);
      default:
        return _tag(palette, market.live ? '实时' : '静态');
    }
  }

  Widget _tag(AppPalette palette, String text, {Color? color}) {
    final tone = color ?? palette.textSecondary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(text, style: AppText.micro.copyWith(color: tone)),
    );
  }

  // ── 条目详情 ──────────────────────────────────────────────────────────────

  void _showEntry(Map<String, dynamic> entry) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (context) => _EntryDetailSheet(
        entry: entry,
        onInstall: (target, env, headers) async {
          final result = await _installEntry(target, env: env, headers: headers);
          _reportInstall(result);
          return result;
        },
        onUninstall: (target) async {
          final result = await _uninstallEntry(target);
          _reportInstall(result);
          return result;
        },
      ),
    );
  }

  // ── 页脚与通用块 ──────────────────────────────────────────────────────────

  Widget _rulesCard(AppPalette palette, MarketCatalogPayload payload) {
    final generated = _formatTimestamp(payload.generatedAt);
    return _panel(
      palette,
      icon: Icons.rule_outlined,
      title: '市场规则',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (payload.rules.isEmpty && payload.licenseGate.isEmpty)
            Text(
              '后端未提供市场规则与许可证闸信息。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
          for (final rule in payload.rules)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                '· $rule',
                style: AppText.secondary.copyWith(
                  color: palette.textPrimary,
                  height: 1.5,
                ),
              ),
            ),
          if (payload.licenseGate.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '许可证闸：${payload.licenseGate}',
                style: AppText.secondary.copyWith(color: palette.textSecondary),
              ),
            ),
          if (generated.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                '静态编目生成于 $generated',
                style: AppText.label.copyWith(color: palette.textSecondary),
              ),
            ),
        ],
      ),
    );
  }

  Widget _emptyCard(AppPalette palette) {
    return _panel(
      palette,
      icon: Icons.inbox_outlined,
      title: '市场为空',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '后端返回 0 个生态：可能是实时来源全部失败、或这台节点的市场根没有编目。'
            '先看上面的来源状态与警告，再点刷新重试。',
            style: AppText.secondary
                .copyWith(color: palette.textSecondary, height: 1.6),
          ),
          const SizedBox(height: AppSpacing.dense),
          OutlinedButton(
            onPressed: _inFlight ? null : () => _load(force: true),
            child: const Text('重新读取'),
          ),
        ],
      ),
    );
  }

  Widget _centeredNote(AppPalette palette, String text) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(height: AppSpacing.cardGap),
          Text(text, style: AppText.secondary.copyWith(color: palette.textSecondary)),
        ],
      ),
    );
  }

  Widget _panel(
    AppPalette palette, {
    required IconData icon,
    required String title,
    required Widget child,
  }) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPad),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: palette.primary),
              const SizedBox(width: AppSpacing.dense),
              Expanded(
                child: Text(
                  title,
                  style: AppText.cardTitle.copyWith(color: palette.textPrimary),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.cardGap),
          child,
        ],
      ),
    );
  }

  Widget _note(AppPalette palette, String text) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surfaceHigh.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: Text(
        text,
        style: AppText.secondary.copyWith(
          color: palette.textSecondary,
          height: 1.6,
        ),
      ),
    );
  }

  Widget _banner(AppPalette palette, String text, {required Color tone}) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(color: tone.withValues(alpha: 0.3), width: AppStroke.thin),
      ),
      child: Text(
        text,
        style: AppText.secondary.copyWith(color: tone, height: 1.5),
      ),
    );
  }
}

// ── 详情面板 ────────────────────────────────────────────────────────────────

class _EntryDetailSheet extends StatefulWidget {
  const _EntryDetailSheet({
    required this.entry,
    required this.onInstall,
    required this.onUninstall,
  });

  final Map<String, dynamic> entry;
  final Future<MarketInstallResult> Function(
    Map<String, dynamic> entry,
    Map<String, String> env,
    Map<String, String> headers,
  ) onInstall;
  final Future<MarketInstallResult> Function(Map<String, dynamic> entry) onUninstall;

  @override
  State<_EntryDetailSheet> createState() => _EntryDetailSheetState();
}

class _EntryDetailSheetState extends State<_EntryDetailSheet> {
  final Map<String, TextEditingController> _fields = <String, TextEditingController>{};
  String? _busy;
  String? _error;
  int _elapsed = 0;
  Timer? _tick;

  /// 详情面板的其余部分按字段读，保持原来的写法。
  Map<String, dynamic> get entry => widget.entry;

  @override
  void initState() {
    super.initState();
    for (final row in _requirementsOf(widget.entry)) {
      if (row['required'] == true) {
        _fields['${row['_group']}:${marketText(row['name'])}'] = TextEditingController();
      }
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    for (final controller in _fields.values) {
      controller.dispose();
    }
    super.dispose();
  }

  /// 必填项按「组:名」收值；可选项不收，留空即不提交，缺不缺由后端判。
  Map<String, String> _subset(String group) {
    final out = <String, String>{};
    for (final row in _requirementsOf(widget.entry)) {
      if (row['_group'] != group || row['required'] != true) continue;
      final value = _fields['${row['_group']}:${marketText(row['name'])}']?.text.trim() ?? '';
      if (value.isNotEmpty) out[marketText(row['name'])] = value;
    }
    return out;
  }

  String? _missingRequired() {
    for (final row in _requirementsOf(widget.entry)) {
      if (row['required'] != true) continue;
      final key = '${row['_group']}:${marketText(row['name'])}';
      if ((_fields[key]?.text.trim() ?? '').isEmpty) return marketText(row['name']);
    }
    return null;
  }

  Future<void> _install() async {
    final missing = _missingRequired();
    if (missing != null) {
      setState(() => _error = '缺少必填项 $missing：安装前需要这个值，填写后重试。');
      return;
    }
    setState(() {
      _busy = 'install';
      _error = null;
      _elapsed = 0;
    });
    _tick?.cancel();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _elapsed += 1);
    });
    try {
      await widget.onInstall(widget.entry, _subset('env'), _subset('headers'));
      if (!mounted) return;
      // 面板里的 entry 是打开时那份快照：装完之后"已安装"读数来自刷新后的
      // 编目，停在旧快照上只会显示一个还能再按一次的安装按钮。
      Navigator.of(context).pop();
    } on MarketCatalogException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '安装失败：$e。修复：确认后端仍在运行后重试；仍失败请查看后端日志。');
    } finally {
      _tick?.cancel();
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _uninstall() async {
    final name = marketEntryName(widget.entry);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('卸载确认'),
        content: Text(
          '卸载「$name」会移除后端安装的产物并更新安装台账，桌面端与终端的'
          '「已安装」读数随下一次编目装配刷新。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('卸载'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() {
      _busy = 'uninstall';
      _error = null;
      _elapsed = 0;
    });
    _tick?.cancel();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _elapsed += 1);
    });
    try {
      await widget.onUninstall(widget.entry);
      if (!mounted) return;
      Navigator.of(context).pop();
    } on MarketCatalogException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '卸载失败：$e。修复：确认后端仍在运行后重试；仍失败请查看后端日志。');
    } finally {
      _tick?.cancel();
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final spec = marketMap(entry['installSpec']);
    final requirements = _requirementsOf(entry);
    final accessCommand = marketAccessCommand(entry);
    final upstreamCommand = marketText(entry['command']).trim();
    final upstream = marketText(entry['upstreamUrl']).trim();
    final what = marketText(entry['what']).trim();
    final compatNote = marketText(entry['compatNote']).trim();
    final reason = marketText(entry['reason']).trim();
    final relationship = marketText(entry['relationship']).trim();
    final targetPath = marketText(entry['targetPath']).trim();
    final installedSummary = marketText(entry['installedSummary']).trim();
    final scope = marketStrings(entry['agentScope']);
    final protocol = marketMap(entry['protocol']);
    final adapter = marketText(protocol['adapter']).trim();
    final compat = marketText(entry['compat']);
    final mode = marketInstallMode(entry);

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.8,
      minChildSize: 0.4,
      maxChildSize: 0.96,
      builder: (context, controller) => Container(
        decoration: BoxDecoration(
          color: palette.pageBg,
          borderRadius: const BorderRadius.vertical(
            top: Radius.circular(AppRadius.large),
          ),
          border: Border.all(color: palette.stroke, width: AppStroke.thin),
        ),
        child: ListView(
          controller: controller,
          padding: const EdgeInsets.all(AppSpacing.page),
          children: [
            Center(
              child: Container(
                width: 36,
                height: 4,
                margin: const EdgeInsets.only(bottom: AppSpacing.cardPad),
                decoration: BoxDecoration(
                  color: palette.strokeStrong,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    marketEntryName(entry),
                    style: AppText.title.copyWith(color: palette.textPrimary),
                  ),
                ),
                IconButton(
                  tooltip: '关闭',
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close),
                ),
              ],
            ),
            if (_subtitle(entry).isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.dense),
                child: Text(
                  _subtitle(entry),
                  style: AppText.label.copyWith(color: palette.textSecondary),
                ),
              ),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                if (compat.isNotEmpty) _detailTag(palette, _compatLabel(compat)),
                if (mode != null) _detailTag(palette, '可装 ${mode == 'mcp' ? 'MCP 服务器' : '技能'}'),
                if (marketText(entry['khyosMarket']).isNotEmpty)
                  _detailTag(palette, _routeLabelOf(entry)),
                if (adapter.isNotEmpty) _detailTag(palette, '适配 $adapter'),
                if (entry['installed'] == true)
                  _detailTag(palette, '已安装', color: palette.success),
              ],
            ),
            const SizedBox(height: AppSpacing.cardPad),
            if (what.isNotEmpty) _section(palette, '是什么', what),
            if (compatNote.isNotEmpty) _section(palette, '兼容说明', compatNote),
            if (reason.isNotEmpty) _section(palette, '推荐理由', reason),
            if (compat == 'blocked' && reason.isEmpty && compatNote.isEmpty)
              _section(palette, '阻塞', '后端把这条标为阻塞，但没有给出原因。'),
            _metaBlock(palette, [
              if (marketText(entry['author']).isNotEmpty)
                ('作者', marketText(entry['author'])),
              if (marketText(entry['version']).isNotEmpty)
                ('版本', marketText(entry['version'])),
              if (entry['downloads'] is num)
                ('下载', '${marketInt(entry['downloads'])}'),
              if (marketText(entry['license']).isNotEmpty)
                ('许可证', marketText(entry['license'])),
              if (marketText(entry['type']).isNotEmpty)
                ('类型', _typeLabelOf(entry)),
              if (relationship.isNotEmpty) ('与上游关系', relationship),
              if (scope.isNotEmpty) ('适用范围', scope.join('、')),
              if (targetPath.isNotEmpty) ('落盘路径', targetPath),
              if (installedSummary.isNotEmpty) ('安装摘要', installedSummary),
            ]),
            if (upstream.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.cardPad),
              _copyRow(context, palette, '上游地址', upstream),
            ],
            if (upstreamCommand.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.dense),
              _copyRow(context, palette, '上游安装命令', upstreamCommand),
            ],
            if (accessCommand != null) ...[
              const SizedBox(height: AppSpacing.dense),
              _copyRow(context, palette, 'khy-os 接入命令', accessCommand),
            ],
            if (requirements.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.cardPad),
              Text(
                '安装前需要',
                style: AppText.cardTitle.copyWith(color: palette.textPrimary),
              ),
              const SizedBox(height: AppSpacing.dense),
              for (final row in requirements)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(
                    '· ${row['_group'] == 'headers' ? '请求头' : '环境变量'} '
                    '${marketText(row['name'])}'
                    '${row['required'] == true ? '（必填）' : '（可选）'}'
                    '${marketText(row['hint']).isEmpty ? '' : '：${marketText(row['hint'])}'}',
                    style: AppText.secondary.copyWith(
                      color: palette.textPrimary,
                      height: 1.5,
                    ),
                  ),
                ),
            ],
            if (spec.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.cardPad),
              Text(
                '安装规格',
                style: AppText.cardTitle.copyWith(color: palette.textPrimary),
              ),
              const SizedBox(height: AppSpacing.dense),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
                decoration: BoxDecoration(
                  color: palette.surfaceHigh,
                  borderRadius: BorderRadius.circular(AppRadius.small),
                  border: Border.all(color: palette.stroke, width: AppStroke.thin),
                ),
                child: SelectableText(
                  const JsonEncoder.withIndent('  ').convert(spec),
                  style: AppText.label.copyWith(
                    color: palette.textPrimary,
                    fontFamily: 'monospace',
                    height: 1.5,
                  ),
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.section),
            if (mode != null) _installSection(palette),
            _note(
              palette,
              mode == null
                  ? '该形态不在可安装范围（仅技能与 MCP 服务器可装）：复制上面的命令到电脑终端执行。'
                  : '安装与卸载由后端 marketInstallService 执行，与桌面端、终端写同一个台账；'
                      '「已安装」读数随编目装配刷新，不是本页写下的状态。',
            ),
          ],
        ),
      ),
    );
  }

  Widget _installSection(AppPalette palette) {
    final mode = marketInstallMode(widget.entry);
    if (mode == null) return const SizedBox.shrink();
    final installed = widget.entry['installed'] == true;
    final busy = _busy != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.cardGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            installed ? '卸载' : '安装',
            style: AppText.cardTitle.copyWith(color: palette.textPrimary),
          ),
          const SizedBox(height: AppSpacing.dense),
          for (final row in _requirementsOf(widget.entry))
            if (row['required'] == true)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.dense),
                child: TextField(
                  controller: _fields['${row['_group']}:${marketText(row['name'])}'],
                  enabled: !busy,
                  obscureText: row['_group'] == 'headers',
                  decoration: InputDecoration(
                    labelText: '${row['_group'] == 'headers' ? '请求头' : '环境变量'} '
                        '${marketText(row['name'])}（必填）',
                    helperText: marketText(row['hint']).isEmpty
                        ? '安装时随请求提交给后端，不落本机'
                        : marketText(row['hint']),
                    border: const OutlineInputBorder(),
                  ),
                ),
              ),
          if (_error != null) ...[
            _banner(palette, _error!, tone: palette.error),
            const SizedBox(height: AppSpacing.dense),
          ],
          SizedBox(
            width: double.infinity,
            child: installed
                ? OutlinedButton.icon(
                    onPressed: busy ? null : _uninstall,
                    icon: const Icon(Icons.delete_outline),
                    label: Text(_busy == 'uninstall'
                        ? '卸载 ${marketEntryName(widget.entry)}（已 ${_elapsed}s）…'
                        : '卸载'),
                  )
                : FilledButton.icon(
                    onPressed: busy ? null : _install,
                    icon: const Icon(Icons.download_outlined),
                    label: Text(_busy == 'install'
                        ? '安装 ${marketEntryName(widget.entry)}（已 ${_elapsed}s）…'
                        : '安装${mode == 'mcp' ? ' MCP 服务器' : ''}'),
                  ),
          ),
          const SizedBox(height: AppSpacing.dense),
          Text(
            installed
                ? '卸载后产物与台账记录一并移除，桌面端与终端的读数随编目装配刷新。'
                : '安装请求连同上面的必填项一起提交给后端执行，快则数秒、慢则取决于 git 拉取。',
            style: AppText.label.copyWith(color: palette.textSecondary),
          ),
        ],
      ),
    );
  }

  Widget _banner(AppPalette palette, String text, {required Color tone}) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(color: tone.withValues(alpha: 0.3), width: AppStroke.thin),
      ),
      child: Text(
        text,
        style: AppText.secondary.copyWith(color: tone, height: 1.5),
      ),
    );
  }

  String _subtitle(Map<String, dynamic> entry) {
    final parts = <String>[
      marketCategoryLabel(entry),
      marketText(entry['type']).isEmpty ? '' : _typeLabelOf(entry),
      marketText(entry['license']),
    ].where((part) => part.trim().isNotEmpty).toList(growable: false);
    return parts.join(' · ');
  }

  String _typeLabelOf(Map<String, dynamic> entry) {
    final type = marketText(entry['type']);
    const labels = <String, String>{
      'skill': '技能',
      'plugin': '插件',
      'agent': 'Agent',
      'experience': '经验',
      'trigger': '触发器',
      'connector': '通信器',
      'mcp': 'MCP',
    };
    return labels[type] ?? type;
  }

  String _compatLabel(String compat) {
    switch (compat) {
      case 'direct':
        return '直连';
      case 'adapter-needed':
        return '需适配';
      case 'covered':
        return '已覆盖';
      case 'blocked':
        return '阻塞';
      default:
        return compat;
    }
  }

  String _routeLabelOf(Map<String, dynamic> entry) {
    switch (marketText(entry['khyosMarket'])) {
      case 'skill':
        return 'Skill';
      case 'mcp':
        return 'MCP';
      case 'extension':
        return '拓展';
      case 'none':
        return '不路由';
      default:
        return marketText(entry['khyosMarket']);
    }
  }

  Widget _section(AppPalette palette, String title, String body) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.cardGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: AppText.label.copyWith(color: palette.textSecondary)),
          const SizedBox(height: 3),
          Text(
            body,
            style: AppText.body.copyWith(color: palette.textPrimary, height: 1.6),
          ),
        ],
      ),
    );
  }

  Widget _metaBlock(AppPalette palette, List<(String, String)> rows) {
    if (rows.isEmpty) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Column(
        children: [
          for (final row in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 76,
                    child: Text(
                      row.$1,
                      style: AppText.label.copyWith(color: palette.textSecondary),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      row.$2,
                      style: AppText.secondary.copyWith(
                        color: palette.textPrimary,
                        height: 1.5,
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _detailTag(AppPalette palette, String text, {Color? color}) {
    final tone = color ?? palette.textSecondary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: Text(text, style: AppText.label.copyWith(color: tone)),
    );
  }

  Widget _copyRow(
    BuildContext context,
    AppPalette palette,
    String label,
    String value,
  ) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: AppText.label.copyWith(color: palette.textSecondary)),
          const SizedBox(height: 4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: SelectableText(
                  value,
                  style: AppText.label.copyWith(
                    color: palette.textPrimary,
                    fontFamily: 'monospace',
                    height: 1.5,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.dense),
              _CopyLabelButton(value: value, palette: palette),
            ],
          ),
        ],
      ),
    );
  }

  Widget _note(AppPalette palette, String text) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surfaceHigh.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: Text(
        text,
        style: AppText.secondary.copyWith(
          color: palette.textSecondary,
          height: 1.6,
        ),
      ),
    );
  }

  List<Map<String, dynamic>> _requirementsOf(Map<String, dynamic> entry) {
    final requires = marketMap(entry['installRequires']);
    final rows = <Map<String, dynamic>>[];
    for (final group in const ['env', 'headers']) {
      for (final raw in marketList(requires[group])) {
        final item = marketMap(raw);
        if (marketText(item['name']).isEmpty) continue;
        rows.add(<String, dynamic>{...item, '_group': group});
      }
    }
    return rows;
  }
}

/// 复制按钮自带 1.5 秒的「已复制」回执。
///
/// 不用 SnackBar：详情页是底部弹层，SnackBar 会落在弹层后面，用户看不到
/// 自己刚点的那一下有没有生效。
class _CopyLabelButton extends StatefulWidget {
  const _CopyLabelButton({required this.value, required this.palette});

  final String value;
  final AppPalette palette;

  @override
  State<_CopyLabelButton> createState() => _CopyLabelButtonState();
}

class _CopyLabelButtonState extends State<_CopyLabelButton> {
  Timer? _reset;
  bool _copied = false;

  @override
  void dispose() {
    _reset?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.value));
    if (!mounted) return;
    setState(() => _copied = true);
    _reset?.cancel();
    _reset = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: _copy,
      style: TextButton.styleFrom(
        minimumSize: const Size(0, 32),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.dense),
        foregroundColor: widget.palette.primary,
      ),
      child: Text(_copied ? '已复制' : '复制'),
    );
  }
}

String _formatTimestamp(String iso) {
  if (iso.trim().isEmpty) return '';
  final parsed = DateTime.tryParse(iso);
  if (parsed == null) return iso;
  final local = parsed.toLocal();
  String two(int value) => value.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} '
      '${two(local.hour)}:${two(local.minute)}';
}
