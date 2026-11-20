import 'package:flutter/material.dart';

import '../../core/db/amoo_mirror_store.dart';
import '../../core/mirror/amoo_mirror_cache.dart';
import '../../core/mirror/amoo_mirror_models.dart';
import '../../core/mirror/amoo_mirror_sanitize.dart';
import '../../core/mirror/amoo_mirror_sync.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import '../widgets/aurora.dart';
import 'amoo_mirror_detail_screen.dart';

/// Amoo 对话记录列表页：按 agentKey 分组的只读镜像。
///
/// 入口在设置页「诊断工具」（与执行记录/日志查看同一节）。全程不拉起 Amoo：
/// 数据只从 HTTP 镜像端点来，页面没有任何跳转 Amoo 的动作。
class AmooMirrorListScreen extends StatefulWidget {
  const AmooMirrorListScreen({super.key, this.cache, this.sync});

  /// 测试注入假件；缺省用真实单例。
  final AmooMirrorCache? cache;

  final AmooMirrorSync? sync;

  @override
  State<AmooMirrorListScreen> createState() => _AmooMirrorListScreenState();
}

class _AmooMirrorListScreenState extends State<AmooMirrorListScreen> {
  late final AmooMirrorCache _cache = widget.cache ?? AmooMirrorStore.instance;

  /// 与详情页共享同一个实例：详情页 required 注入的就是它。
  late final AmooMirrorSync _sync = widget.sync ?? AmooMirrorSync(cache: _cache);

  List<AmooMirrorSession> _sessions = const <AmooMirrorSession>[];
  bool _loading = true;

  /// null = 还没同步过。空态三分的判据之一：真的没有会话，与没拿到，是两件事。
  AmooMirrorSyncOutcome? _outcome;

  @override
  void initState() {
    super.initState();
    _sync.addListener(_onSyncState);
    _load();
  }

  @override
  void dispose() {
    _sync.removeListener(_onSyncState);
    super.dispose();
  }

  void _onSyncState() {
    if (mounted) setState(() {});
  }

  /// 列表页进入、下拉刷新、从详情页返回都走这里。
  ///
  /// [force] 只跳过节流与缓存短路，从不清游标——全量重拉只由「从未同步」与
  /// 409 触发，所以从详情页返回后的 force 重同步不会把增量历史洗一遍。
  Future<void> _load({bool force = false}) async {
    setState(() => _loading = true);
    await _sync.ensureReady();
    final outcome = await _sync.syncSessions(force: force);
    final sessions = await _cache.loadSessions();
    if (!mounted) return;
    setState(() {
      _sessions = sessions;
      _outcome = outcome;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final banner = _statusBanner(palette);
    return Scaffold(
      appBar: AppBar(
        title: const Text('对话记录'),
        centerTitle: true,
      ),
      body: RefreshIndicator(
        onRefresh: () => _load(force: true),
        child: _loading && _sessions.isEmpty
            ? ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                children: <Widget>[
                  const SizedBox(height: 200),
                  const Center(child: CircularProgressIndicator()),
                  const SizedBox(height: AppSpacing.dense),
                  Center(
                    child: Text(
                      '正在读取 Amoo 对话记录缓存',
                      style: AppText.secondary.copyWith(
                        color: palette.textSecondary,
                      ),
                    ),
                  ),
                ],
              )
            : ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.cardGap,
                  AppSpacing.cardGap,
                  AppSpacing.cardGap,
                  AppSpacing.section,
                ),
                children: <Widget>[
                  ?banner,
                  if (_sessions.isEmpty)
                    _emptyState(palette)
                  else ...<Widget>[
                    for (final group in groupSessionsByAgent(_sessions).entries)
                      ...<Widget>[
                        _groupHeader(palette, group.key, group.value.length),
                        for (final session in group.value)
                          _sessionCard(palette, session),
                      ],
                  ],
                  if (_sessions.length >= kAmooMirrorSessionsLimit)
                    _moreHint(palette),
                ],
              ),
      ),
    );
  }

  // ── 状态横幅 ────────────────────────────────────────────────────────────

  /// sync 态 → 横幅。文案取 sync 侧的 message（与日志共用一句），状态色按映射表。
  Widget? _statusBanner(AppPalette palette) {
    final state = _sync.state;
    final message = state.message;
    switch (state.status) {
      case AmooMirrorSyncStatus.idle:
      case AmooMirrorSyncStatus.ok:
        // 单次失败时同步器保持 ok 但带 message（缓存照常展示）——先看 message，
        // 否则「更新于 HH:mm」会把「刚才没同步上」盖掉。
        if (message != null) {
          return _banner(
            palette,
            palette.textSecondary,
            Icons.cloud_off_outlined,
            message,
          );
        }
        if (state.lastSyncAt == null) return null;
        final added = state.lastAdded;
        final tail = added != null && added > 0 ? '，新增 $added 条' : '';
        return _banner(
          palette,
          palette.success,
          Icons.cloud_done_outlined,
          '更新于 ${_clock(state.lastSyncAt!)}$tail',
        );
      case AmooMirrorSyncStatus.syncing:
        return _banner(
          palette,
          palette.textSecondary,
          Icons.cloud_sync_outlined,
          '同步中 · Amoo 对话记录',
        );
      case AmooMirrorSyncStatus.rateLimited:
        return _banner(
          palette,
          palette.warning,
          Icons.timer_outlined,
          _rateLimitText(state),
        );
      case AmooMirrorSyncStatus.offline:
        return _banner(
          palette,
          palette.textSecondary,
          Icons.cloud_off_outlined,
          // 兜底文案直接引用同步器那几句：横幅与日志必须说同一句话。
          message ?? kAmooMirrorOfflineBanner,
        );
      case AmooMirrorSyncStatus.needsPairing:
        return _banner(
          palette,
          palette.warning,
          Icons.key_off_outlined,
          message ?? kAmooMirrorUnauthorizedBanner,
        );
      case AmooMirrorSyncStatus.unconfigured:
        return _banner(
          palette,
          palette.textSecondary,
          Icons.settings_outlined,
          message ?? kAmooMirrorUnconfiguredBanner,
        );
    }
  }

  String _rateLimitText(AmooMirrorSyncState state) {
    final base = state.message ?? kAmooMirrorRateLimitedBanner;
    final notBefore = state.notBeforeMs;
    if (notBefore == null) return base;
    final remainMs = notBefore - DateTime.now().millisecondsSinceEpoch;
    if (remainMs <= 0) return base;
    return '$base（${(remainMs / 1000).ceil()} 秒后可重试）';
  }

  Widget _banner(
    AppPalette palette,
    Color color,
    IconData icon,
    String text,
  ) {
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.cardGap),
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: color.withValues(alpha: AppAlpha.weakFill),
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(
          color: color.withValues(alpha: AppAlpha.strokeWeak),
          width: AppStroke.thin,
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(icon, size: 16, color: color),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Text(
              text,
              style: AppText.secondary.copyWith(color: palette.textPrimary),
            ),
          ),
        ],
      ),
    );
  }

  // ── 空态三分 ────────────────────────────────────────────────────────────

  /// 三种空态必须分开：把「我们没拿到」显示成「本来就没有」，用户会以为历史丢了
  /// 也不报警；而「未配置」给的是另一个动作（去填端点），不是重试。
  Widget _emptyState(AppPalette palette) {
    final status = _sync.state.status;
    if (status == AmooMirrorSyncStatus.unconfigured) {
      return _empty(
        palette,
        Icons.settings_outlined,
        '尚未配置对话记录服务',
        '填入 Base URL 与 device_token 后才能查看 Amoo 的历史会话。',
        '去配置',
        () => Navigator.pop(context),
      );
    }
    if (status == AmooMirrorSyncStatus.needsPairing) {
      return _empty(
        palette,
        Icons.key_off_outlined,
        '未授权，且没有可展示的缓存',
        '设备令牌无效或过期。在设置页重新粘贴 device_token 后可恢复同步。',
        '去重新配对',
        () => Navigator.pop(context),
      );
    }
    if (!_cache.isAvailable ||
        (_outcome != null && _outcome != AmooMirrorSyncOutcome.ok)) {
      return _empty(
        palette,
        Icons.cloud_off_outlined,
        '同步失败，暂无可展示的缓存',
        '这次没有从服务端拿到数据，本地也没有历史副本。稍后下拉刷新重试。',
        '重试',
        () => _load(force: true),
      );
    }
    return _empty(
      palette,
      Icons.forum_outlined,
      '没有会话记录',
      '服务端返回了空的会话列表。Amoo 上有新对话后，下拉刷新即可看到。',
      '刷新',
      () => _load(force: true),
    );
  }

  Widget _empty(
    AppPalette palette,
    IconData icon,
    String title,
    String body,
    String action,
    VoidCallback onAction,
  ) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.section),
      child: Column(
        children: <Widget>[
          Icon(icon, size: 36, color: palette.textFaint),
          const SizedBox(height: AppSpacing.dense),
          Text(
            title,
            style: AppText.cardTitle.copyWith(color: palette.textPrimary),
          ),
          const SizedBox(height: AppSpacing.micro),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.cardGap),
            child: Text(
              body,
              textAlign: TextAlign.center,
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
          ),
          const SizedBox(height: AppSpacing.cardGap),
          OutlinedButton(
            onPressed: onAction,
            style: OutlinedButton.styleFrom(
              foregroundColor: palette.primary,
              side: BorderSide(
                color: palette.primary.withValues(alpha: AppAlpha.strokeWeak),
              ),
            ),
            child: Text(action),
          ),
        ],
      ),
    );
  }

  Widget _moreHint(AppPalette palette) {
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.dense),
      child: Text(
        '仅显示最近 $kAmooMirrorSessionsLimit 个会话',
        textAlign: TextAlign.center,
        style: AppText.micro.copyWith(color: palette.textFaint),
      ),
    );
  }

  // ── 分组与会话卡 ────────────────────────────────────────────────────────

  Widget _groupHeader(AppPalette palette, String agentKey, int count) {
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.dense, bottom: AppSpacing.micro),
      child: Row(
        children: <Widget>[
          Text(
            agentKey,
            style: AppText.label.copyWith(color: palette.primary),
          ),
          const SizedBox(width: AppSpacing.micro),
          Text(
            '$count',
            style: AppText.label.copyWith(color: palette.textFaint),
          ),
        ],
      ),
    );
  }

  Widget _sessionCard(AppPalette palette, AmooMirrorSession session) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.dense),
      child: Material(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadius.medium),
          onTap: () async {
            await Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => AmooMirrorDetailScreen(
                  session: session,
                  cache: _cache,
                  sync: _sync,
                ),
              ),
            );
            // 返回后重载并 force 重同步：别处可能刚追加过消息，而缓存还停在进入
            // 详情页之前。force 不清游标，只跳过节流。
            await _load(force: true);
          },
          child: Container(
            padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppRadius.medium),
              border: Border.all(
                color: palette.stroke,
                width: AppStroke.thin,
              ),
            ),
            child: Row(
              children: <Widget>[
                Icon(
                  Icons.forum_outlined,
                  size: 20,
                  color: palette.textSecondary,
                ),
                const SizedBox(width: AppSpacing.dense),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        amooMirrorSanitizeText(session.title),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppText.cardTitle.copyWith(
                          color: palette.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${_clock(session.updatedAt)} · ${session.messageCount} 条 · '
                        '${amooMirrorOneLine(amooMirrorSanitizeText(session.lastPreview))}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppText.secondary.copyWith(
                          color: palette.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                if (session.compacted) ...<Widget>[
                  const SizedBox(width: AppSpacing.dense),
                  const StatusPill(
                    label: '已压缩',
                    tone: StatusPillTone.warning,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

String _clock(int epochMs) {
  final dt = DateTime.fromMillisecondsSinceEpoch(epochMs);
  String p2(int n) => n.toString().padLeft(2, '0');
  return '${dt.month}-${p2(dt.day)} ${p2(dt.hour)}:${p2(dt.minute)}';
}
