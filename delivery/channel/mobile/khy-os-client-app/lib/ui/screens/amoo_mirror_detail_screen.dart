import 'package:flutter/material.dart';

import '../../core/mirror/amoo_mirror_cache.dart';
import '../../core/mirror/amoo_mirror_models.dart';
import '../../core/mirror/amoo_mirror_sanitize.dart';
import '../../core/mirror/amoo_mirror_sync.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import '../widgets/aurora.dart';

/// Amoo 对话记录详情页：单个会话的只读镜像。
///
/// 与列表页共享同一份 cache 与 sync 实例（构造注入），因为「本地只有一份镜像」
/// 是这个功能的前提：两个 sync 实例会各拉一遍、各写一份游标，而列表页返回后
/// 看到的还是旧缓存。
///
/// 渲染前统一走 [amooMirrorSanitizeText] + [amooMirrorTruncate]——库里存的是
/// 服务端原文，脱敏只发生在这一层，不回写。
class AmooMirrorDetailScreen extends StatefulWidget {
  const AmooMirrorDetailScreen({
    super.key,
    required this.session,
    required this.cache,
    required this.sync,
  });

  /// 列表点进来的那一行（TrajectorySessionScreen 同款构造注入）。
  final AmooMirrorSession session;

  final AmooMirrorCache cache;

  final AmooMirrorSync sync;

  @override
  State<AmooMirrorDetailScreen> createState() => _AmooMirrorDetailScreenState();
}

class _AmooMirrorDetailScreenState extends State<AmooMirrorDetailScreen> {
  /// 展开态按「消息 id # 块序号」记。tool 块与超长正文各有一套，但共用一个集合：
  /// 两者都是「这一块现在显示完整内容」。
  final Set<String> _expanded = <String>{};

  List<AmooMirrorMessage> _messages = const <AmooMirrorMessage>[];
  bool _loading = true;

  /// null = 还没同步过（首帧）。详情页的横幅按它分，不按 sync 态——本页只关心
  /// 「这一次 syncMessages 的结果」。
  AmooMirrorSyncOutcome? _outcome;

  @override
  void initState() {
    super.initState();
    widget.sync.addListener(_onSyncState);
    _load();
  }

  @override
  void dispose() {
    widget.sync.removeListener(_onSyncState);
    super.dispose();
  }

  void _onSyncState() {
    if (mounted) setState(() {});
  }

  Future<void> _load({bool force = false}) async {
    setState(() => _loading = true);
    await widget.sync.ensureReady();
    final outcome = await widget.sync.syncMessages(widget.session.id, force: force);
    final messages = await widget.cache.loadMessages(widget.session.id);
    if (!mounted) return;
    setState(() {
      _messages = messages;
      _outcome = outcome;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final banner = _outcomeBanner(palette);
    return Scaffold(
      appBar: AppBar(
        title: Text(
          amooMirrorSanitizeText(widget.session.title),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        centerTitle: true,
      ),
      body: Column(
        children: <Widget>[
          if (widget.session.compacted)
            _banner(
              palette,
              palette.warning,
              Icons.compress_outlined,
              '服务端标注该会话历史已被压缩，以下为已缓存内容',
            ),
          ?banner,
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.cardGap,
              AppSpacing.dense,
              AppSpacing.cardGap,
              0,
            ),
            child: Row(
              children: <Widget>[
                Text(
                  '${widget.session.agentKey} · 已缓存 ${_messages.length} 条',
                  style: AppText.secondary.copyWith(color: palette.textSecondary),
                ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () => _load(force: true),
              child: _loading && _messages.isEmpty
                  ? ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: <Widget>[
                        const SizedBox(height: 160),
                        const Center(child: CircularProgressIndicator()),
                        const SizedBox(height: AppSpacing.dense),
                        Center(
                          child: Text(
                            '正在读取 Amoo 会话消息',
                            style: AppText.secondary.copyWith(
                              color: palette.textSecondary,
                            ),
                          ),
                        ),
                      ],
                    )
                  : _messages.isEmpty
                      ? ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          children: <Widget>[
                            const SizedBox(height: 200),
                            Center(
                              child: Text(
                                '没有可展示的消息',
                                style: AppText.secondary.copyWith(
                                  color: palette.textSecondary,
                                ),
                              ),
                            ),
                          ],
                        )
                      : ListView.builder(
                          padding: const EdgeInsets.fromLTRB(
                            AppSpacing.cardGap,
                            AppSpacing.dense,
                            AppSpacing.cardGap,
                            AppSpacing.section,
                          ),
                          itemCount: _messages.length,
                          itemBuilder: (_, i) => _messageBubble(
                            _messages[i],
                            palette,
                          ),
                        ),
            ),
          ),
        ],
      ),
    );
  }

  // ── 横幅 ────────────────────────────────────────────────────────────────

  /// 同步结果横幅。文案优先取 sync 侧的 [AmooMirrorSyncState.message]——那一句
  /// 与日志共用（amoo_mirror_errors.dart 的 describe 是它的素材），界面再写一
  /// 份就是两套措辞描述同一个状态。
  Widget? _outcomeBanner(AppPalette palette) {
    final syncMessage = widget.sync.state.message;
    switch (_outcome) {
      case null:
      case AmooMirrorSyncOutcome.ok:
        return null;
      case AmooMirrorSyncOutcome.unconfigured:
        return _banner(
          palette,
          palette.textSecondary,
          Icons.settings_outlined,
          '尚未配置对话记录服务：请在设置页填入 Base URL 与 device_token',
        );
      case AmooMirrorSyncOutcome.needsPairing:
        return _banner(
          palette,
          palette.warning,
          Icons.key_off_outlined,
          syncMessage ?? kAmooMirrorUnauthorizedBanner,
        );
      case AmooMirrorSyncOutcome.sessionGone:
        return _banner(
          palette,
          palette.textSecondary,
          Icons.delete_outline,
          '服务端已无此会话 (404)：以下为已缓存副本',
        );
      case AmooMirrorSyncOutcome.cursorStale:
        return _banner(
          palette,
          palette.warning,
          Icons.restore_outlined,
          syncMessage ?? kAmooMirrorCursorStaleGiveUp,
        );
      case AmooMirrorSyncOutcome.rateLimited:
        return _banner(
          palette,
          palette.warning,
          Icons.timer_outlined,
          syncMessage ?? kAmooMirrorRateLimitedBanner,
        );
      case AmooMirrorSyncOutcome.offline:
        return _banner(
          palette,
          palette.textSecondary,
          Icons.cloud_off_outlined,
          syncMessage ?? kAmooMirrorOfflineBanner,
        );
      case AmooMirrorSyncOutcome.storageUnavailable:
        return _banner(
          palette,
          palette.error,
          Icons.storage_outlined,
          '本地缓存不可用：对话记录库打不开，本次只能看服务端',
        );
    }
  }

  Widget _banner(
    AppPalette palette,
    Color color,
    IconData icon,
    String text,
  ) {
    return Container(
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.cardGap,
        AppSpacing.dense,
        AppSpacing.cardGap,
        0,
      ),
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

  // ── 消息渲染 ────────────────────────────────────────────────────────────

  Widget _messageBubble(AmooMirrorMessage message, AppPalette palette) {
    final isUser = message.role == AmooMirrorRole.user;
    return Align(
      // 分支消息只按 timestamp 线性展示；parentId 保留在模型里，不建树。
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        key: ValueKey('amoo-mirror-msg-${message.id}'),
        constraints: const BoxConstraints(maxWidth: 340),
        margin: const EdgeInsets.only(bottom: AppSpacing.dense),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.cardPadNarrow,
          vertical: AppSpacing.dense,
        ),
        decoration: BoxDecoration(
          color: isUser
              ? palette.primary.withValues(alpha: AppAlpha.weakFill)
              : palette.surface,
          borderRadius: BorderRadius.circular(AppRadius.medium),
          border: Border.all(
            color: isUser
                ? palette.primary.withValues(alpha: AppAlpha.strokeWeak)
                : palette.stroke,
            width: AppStroke.thin,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            for (var i = 0; i < message.blocks.length; i++)
              _block(message, i, palette),
          ],
        ),
      ),
    );
  }

  Widget _block(AmooMirrorMessage message, int index, AppPalette palette) {
    final block = message.blocks[index];
    return switch (block) {
      AmooMirrorTextBlock() => _textBlock(message, index, block, palette),
      AmooMirrorToolBlock() => _toolBlock(message, index, block, palette),
    };
  }

  Widget _textBlock(
    AmooMirrorMessage message,
    int index,
    AmooMirrorTextBlock block,
    AppPalette palette,
  ) {
    // 先脱敏再截断：截断在脱敏之后，占位符不会被算进 800 字符预算里反复变化。
    final safe = amooMirrorSanitizeText(block.text);
    final cut = amooMirrorTruncate(safe);
    final key = '${message.id}#$index';
    final showFull = _expanded.contains(key);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.micro),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            showFull ? safe : cut.text,
            style: AppText.body.copyWith(color: palette.textPrimary),
          ),
          if (cut.truncated && !showFull)
            GestureDetector(
              onTap: () => setState(() => _expanded.add(key)),
              child: Padding(
                padding: const EdgeInsets.only(top: AppSpacing.micro),
                child: Text(
                  '已截断 · 点击展开全文',
                  style: AppText.label.copyWith(color: palette.primary),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _toolBlock(
    AmooMirrorMessage message,
    int index,
    AmooMirrorToolBlock block,
    AppPalette palette,
  ) {
    final key = '${message.id}#$index';
    final expanded = _expanded.contains(key);
    final full = amooMirrorSanitizeText(block.summary);
    // 折叠行必须是一行：契约不保证 summary 单行，而多行会把列表布局撑炸。
    final oneLine = amooMirrorOneLine(full);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.micro),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          GestureDetector(
            onTap: () => setState(() {
              if (expanded) {
                _expanded.remove(key);
              } else {
                _expanded.add(key);
              }
            }),
            child: Container(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.dense,
                vertical: AppSpacing.micro,
              ),
              decoration: BoxDecoration(
                color: palette.surfaceHigh,
                borderRadius: BorderRadius.circular(AppRadius.small),
                border: Border.all(
                  color: palette.stroke,
                  width: AppStroke.thin,
                ),
              ),
              child: Row(
                children: <Widget>[
                  Icon(
                    expanded ? Icons.expand_less : Icons.expand_more,
                    size: 14,
                    color: palette.textSecondary,
                  ),
                  const SizedBox(width: AppSpacing.micro),
                  Expanded(
                    // ellipsis 而不是全量布局：summary 可能是几十 KB，折叠态只画
                    // 一行，展开才付全文的代价。
                    child: Text(
                      '工具 ${block.name} · $oneLine',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppText.mono.copyWith(color: palette.textSecondary),
                    ),
                  ),
                  if (block.truncated) ...<Widget>[
                    const SizedBox(width: AppSpacing.micro),
                    const StatusPill(
                      label: '服务端已截断',
                      tone: StatusPillTone.warning,
                    ),
                  ],
                ],
              ),
            ),
          ),
          if (expanded)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.micro),
              child: Text(
                full,
                style: AppText.mono.copyWith(color: palette.textPrimary),
              ),
            ),
        ],
      ),
    );
  }
}
