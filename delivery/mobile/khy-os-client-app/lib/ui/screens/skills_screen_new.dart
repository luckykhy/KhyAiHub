// khy-canary: Khy-20261101-121-DWDDZ5A2
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/gateway/market_catalog.dart';
import '../../core/skills/local_skill_store.dart';
import '../../core/tools/skills.dart';
import '../../core/workspace/workspace_store.dart';
import '../../ui/screens/plugin_market_screen.dart';
import '../../ui/theme/app_colors.dart';
import '../../ui/theme/design_tokens.dart';
import '../../ui/widgets/aurora.dart';

/// 技能页：三个来源，一张表。
///
/// 内置技能与本地目录扫出来的技能注册进同一张 [builtinSkills]——SkillMatcher
/// 和 execute_skill 的 enum 都读它，分开两张表等于对模型藏起来一半。市场技能
/// 只展示后端编目的读数（可装/已安装/接入命令），安装动作在插件市场页执行：
/// 那边持有连接与登录状态机，在这里再拉一份快照就会出现两个"未登录"判定。
///
/// 入口由接线阶段挂到 tools_hub_screen 的第 5 个页签（本文件不自己改导航），
/// 在那之前用户还打不开这一页——这是已知的接线缺口，不是本页的逻辑分支。
class SkillsScreenNew extends StatefulWidget {
  const SkillsScreenNew({super.key, this.marketPayload});

  /// 市场编目快照（后端 `GET /api/eco-markets` 的 data）。
  ///
  /// 由外层注入；为空时本页如实说明未载入，并给一个去插件市场页的入口，
  /// 不假装市场是空的。
  final MarketCatalogPayload? marketPayload;

  @override
  State<SkillsScreenNew> createState() => _SkillsScreenNewState();
}

class _SkillsScreenNewState extends State<SkillsScreenNew> {
  LocalSkillScan? _scan;
  bool _scanning = false;
  int _scanDone = 0;
  int _scanTotal = 0;
  String? _scanError;

  /// 市场条目一次最多列几条，其余去插件市场页看——本页是读数不是第二份市场。
  static const int _marketPreview = 10;

  @override
  void initState() {
    super.initState();
    _scanLocal();
  }

  Future<void> _scanLocal() async {
    setState(() {
      _scanning = true;
      _scanError = null;
      _scanDone = 0;
      _scanTotal = 0;
    });
    try {
      final scan = await LocalSkillStore.instance.load(
        onProgress: (done, total) {
          if (!mounted) return;
          setState(() {
            _scanDone = done;
            _scanTotal = total;
          });
        },
      );
      if (!mounted) return;
      setState(() {
        _scan = scan;
        _scanning = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _scanning = false;
        _scanError = '扫描本地技能目录失败：$e。修复：重新进入本页或点右上角刷新重试。';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final scan = _scan;
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.page,
            AppSpacing.cardGap,
            AppSpacing.page,
            AppSpacing.section,
          ),
          children: [
            _header(palette, scan),
            const SizedBox(height: AppSpacing.cardGap),
            _builtinSection(palette),
            const SizedBox(height: AppSpacing.cardGap),
            _localSection(palette, scan),
            const SizedBox(height: AppSpacing.cardGap),
            _marketSection(palette, widget.marketPayload),
            const SizedBox(height: AppSpacing.cardGap),
            _note(
              palette,
              '内置与本地技能进同一张表：模型通过 execute_skill 调用。本地技能扫到即进表，'
              '但对话与智能体界面的 execute_skill 技能列表是打开时定稿的——装完之后要重开'
              '那些界面（或重启应用），模型才看得见新技能。',
            ),
          ],
        ),
      ),
    );
  }

  Widget _header(AppPalette palette, LocalSkillScan? scan) {
    final localCount = scan?.skills.length ?? 0;
    final marketCount = _marketSkillEntries(widget.marketPayload).length;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPad),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Row(
        children: [
          const GradientTile(icon: Icons.bolt, size: 36),
          const SizedBox(width: AppSpacing.inner),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '技能',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.title.copyWith(color: palette.textPrimary),
                ),
                Text(
                  '内置 ${builtinCoreSkills.length} 个 · 本地目录 $localCount 个 · 市场 $marketCount 条',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.secondary.copyWith(color: palette.textSecondary),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: '重新扫描本地技能目录',
            onPressed: _scanning ? null : _scanLocal,
            icon: _scanning
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh),
          ),
        ],
      ),
    );
  }

  Widget _builtinSection(AppPalette palette) {
    return _panel(
      palette,
      icon: Icons.bolt_outlined,
      title: '内置技能',
      trailing: Text('${builtinCoreSkills.length} 个',
          style: AppText.label.copyWith(color: palette.textSecondary)),
      child: GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        crossAxisSpacing: AppSpacing.cardGap,
        mainAxisSpacing: AppSpacing.cardGap,
        // Fixed cell height: childAspectRatio 1.2 left a dead zone under every
        // card.
        mainAxisExtent: 148,
        children: [
          for (final skill in builtinCoreSkills)
            _SkillCard(
              skill: skill,
              icon: _iconForSkill(skill),
              color: _colorForSkill(skill),
              onExecute: _executeSkill,
            ),
        ],
      ),
    );
  }

  Widget _localSection(AppPalette palette, LocalSkillScan? scan) {
    // 用户在设置里改过工作空间根：显示并扫描生效的那个根，不是编译期默认值。
    final dir = LocalSkillStore.skillsDirFor(WorkspaceStore.instance.effectiveRoot);
    return _panel(
      palette,
      icon: Icons.folder_open_outlined,
      title: '本地技能目录',
      trailing: _scanning
          ? Text(
              '已读 $_scanDone/$_scanTotal 个目录',
              style: AppText.label.copyWith(color: palette.textSecondary),
            )
          : TextButton(
              onPressed: _scanLocal,
              child: const Text('重新扫描'),
            ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText(
            dir,
            style: AppText.label.copyWith(color: palette.textSecondary),
          ),
          const SizedBox(height: AppSpacing.dense),
          if (_scanning)
            _note(palette, '正在扫描 $dir：已读 $_scanDone 个，共 $_scanTotal 个目录…')
          else if (_scanError != null)
            _banner(palette, _scanError!, tone: palette.error)
          else if (scan == null || scan.isEmpty)
            _note(
              palette,
              '目录为空或不存在：把 <技能名>/SKILL.md 放进去（frontmatter 至少写 name），'
              '再点「重新扫描」，模型即可通过 execute_skill 调用它。',
            )
          else ...[
            for (final warning in scan.warnings)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.dense),
                child: _banner(palette, warning, tone: palette.warning),
              ),
            for (final skill in scan.skills) _localSkillRow(palette, skill),
            if (scan.skipped.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.dense),
              _banner(
                palette,
                '跳过 ${scan.skipped.length} 个目录：${scan.skipped.join('；')}。'
                '修复：按各条原因补全 SKILL.md 或改名后重新扫描。',
                tone: palette.warning,
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _localSkillRow(AppPalette palette, Skill skill) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.dense),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  skill.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.body.copyWith(
                    fontWeight: FontWeight.w600,
                    color: palette.textPrimary,
                  ),
                ),
                Text(
                  skill.version.isEmpty ? skill.name : '${skill.name} · ${skill.version}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.label.copyWith(color: palette.textSecondary),
                ),
                Text(
                  skill.description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.secondary.copyWith(
                    color: palette.textSecondary,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.dense),
          TextButton(
            onPressed: () => _executeSkill(skill),
            child: const Text('执行'),
          ),
        ],
      ),
    );
  }

  Widget _marketSection(AppPalette palette, MarketCatalogPayload? payload) {
    final entries = _marketSkillEntries(payload);
    return _panel(
      palette,
      icon: Icons.storefront_outlined,
      title: '市场技能',
      trailing: entries.isEmpty
          ? null
          : Text('${entries.length} 条',
              style: AppText.label.copyWith(color: palette.textSecondary)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (payload == null)
            _note(palette, '市场编目未载入：本页不自己拉快照，打开插件市场页浏览与安装。')
          else if (entries.isEmpty)
            _note(palette, '后端编目里没有 khyosMarket=skill 的条目：看插件市场页的来源状态与警告。')
          else
            for (final entry in entries.take(_marketPreview)) _marketSkillRow(palette, entry),
          if (entries.length > _marketPreview) ...[
            const SizedBox(height: AppSpacing.dense),
            Text(
              '其余 ${entries.length - _marketPreview} 条在插件市场页查看。',
              style: AppText.label.copyWith(color: palette.textSecondary),
            ),
          ],
          const SizedBox(height: AppSpacing.dense),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton.icon(
              onPressed: _openMarket,
              icon: const Icon(Icons.open_in_new),
              label: const Text('打开插件市场'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _marketSkillRow(AppPalette palette, Map<String, dynamic> entry) {
    final mode = marketInstallMode(entry);
    final installed = entry['installed'] == true;
    final command = marketAccessCommand(entry);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.dense),
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
          if (_summaryOf(entry).isNotEmpty)
            Text(
              _summaryOf(entry),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: AppText.secondary.copyWith(
                color: palette.textSecondary,
                height: 1.5,
              ),
            ),
          const SizedBox(height: 4),
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: [
              _tag(palette, marketCategoryLabel(entry)),
              if (mode != null) _tag(palette, '可装 ${mode == 'mcp' ? 'MCP 服务器' : '技能'}'),
            ],
          ),
          if (command != null) ...[
            const SizedBox(height: 4),
            Row(
              children: [
                Expanded(
                  child: SelectableText(
                    command,
                    style: AppText.label.copyWith(color: palette.textSecondary),
                  ),
                ),
                IconButton(
                  tooltip: '复制接入命令',
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(Icons.copy, size: 16),
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: command));
                    if (!mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('已复制接入命令')),
                    );
                  },
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  List<Map<String, dynamic>> _marketSkillEntries(MarketCatalogPayload? payload) {
    if (payload == null) return const <Map<String, dynamic>>[];
    final out = <Map<String, dynamic>>[];
    for (final market in payload.ecosystems) {
      for (final entry in market.entries) {
        if (marketText(entry['khyosMarket']) == 'skill') out.add(entry);
      }
    }
    return out;
  }

  String _summaryOf(Map<String, dynamic> entry) {
    final what = marketText(entry['what']).trim();
    return what.isNotEmpty ? what : marketText(entry['compatNote']).trim();
  }

  Future<void> _openMarket() async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => const PluginMarketScreen()),
    );
    // 市场页可能装过技能：本地目录不会因此变化，但台账读数会，回来重扫一次
    // 本地目录没有代价，也能让「执行」按钮对新装的技能生效。
    if (mounted) await _scanLocal();
  }

  void _executeSkill(Skill skill) {
    SkillExecutor.execute(skill).then((result) {
      if (!mounted) return;
      // Prompt skills 由 AI 执行：把内部标记 [PROMPT_SKILL:xxx] 当成功消息
      // 显示只会让人以为点了一下就完成了什么。
      final text = result.isPrompt
          ? '「${skill.label}」由 AI 执行：在对话里提出对应需求即可'
          : (result.success ? result.message : '失败：${result.message}');
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(text, style: AppText.secondary),
          backgroundColor:
              result.success || result.isPrompt ? AppColors.success : AppColors.error,
          behavior: SnackBarBehavior.floating,
          margin: const EdgeInsets.all(AppSpacing.page),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.medium),
          ),
          duration: const Duration(seconds: 2),
        ),
      );
    });
  }

  Widget _tag(AppPalette palette, String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: palette.textSecondary.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(text, style: AppText.micro.copyWith(color: palette.textSecondary)),
    );
  }

  Widget _panel(
    AppPalette palette, {
    required IconData icon,
    required String title,
    required Widget child,
    Widget? trailing,
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
              if (trailing != null) trailing!,
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
      width: double.infinity,
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

  IconData _iconForSkill(Skill s) {
    if (s.name.contains('wechat') || s.name.contains('weixin')) {
      return Icons.chat;
    }
    if (s.name.contains('browser') || s.name.contains('baidu')) {
      return Icons.language;
    }
    if (s.name.contains('douyin') || s.name.contains('bilibili')) {
      return Icons.videocam;
    }
    if (s.name.contains('taobao') || s.name.contains('jd') || s.name.contains('pinduoduo')) {
      return Icons.shopping_cart;
    }
    if (s.name.contains('meituan')) {
      return Icons.restaurant;
    }
    if (s.name.contains('camera')) {
      return Icons.photo_camera;
    }
    if (s.name.contains('gallery') || s.name.contains('photos')) {
      return Icons.photo_library;
    }
    if (s.name.contains('phone') || s.name.contains('dialer')) {
      return Icons.phone;
    }
    if (s.name.contains('music')) {
      return Icons.music_note;
    }
    if (s.name.contains('maps') || s.name.contains('amap')) {
      return Icons.map;
    }
    if (s.name.contains('weather')) {
      return Icons.wb_sunny;
    }
    if (s.name.contains('settings')) {
      return Icons.settings;
    }
    if (s.name.contains('calculate') || s.name.contains('math')) {
      return Icons.calculate;
    }
    if (s.name.contains('screenshot')) {
      return Icons.screenshot;
    }
    if (s.name.contains('copy')) {
      return Icons.content_copy;
    }
    if (s.name.contains('home') || s.name.contains('back')) {
      return Icons.navigation;
    }
    if (s.name.contains('qq')) {
      return Icons.qr_code;
    }
    if (s.name.contains('dingtalk') || s.name.contains('feishu')) {
      return Icons.work;
    }
    if (s.name.contains('telegram') || s.name.contains('whatsapp')) {
      return Icons.message;
    }
    if (s.name.contains('weibo') || s.name.contains('xiaohongshu') || s.name.contains('zhihu')) {
      return Icons.public;
    }
    return Icons.star;
  }

  Color _colorForSkill(Skill s) {
    switch (s.name) {
      case 'open-wechat':
        return const Color(0xFF07C160);
      case 'open-browser':
      case 'open-baidu':
        return AppColors.primary;
      case 'open-douyin':
        return const Color(0xFFFE2C56);
      case 'open-bilibili':
        return const Color(0xFFFB7299);
      case 'open-taobao':
      case 'open-jd':
      case 'open-pinduoduo':
      case 'open-meituan':
        return AppColors.warning;
      case 'open-camera':
        return const Color(0xFF4FC3F7);
      case 'open-maps':
        return const Color(0xFF4285F4);
      case 'open-settings':
        return Colors.grey;
      default:
        return AppColors.accent;
    }
  }
}

/// One tappable skill cell: press squash, skill-coloured border while
/// pressed. Holds its own state because the pressed border needs to react
/// to the same gesture that PressableScale would otherwise swallow.
class _SkillCard extends StatefulWidget {
  const _SkillCard({
    required this.skill,
    required this.icon,
    required this.color,
    required this.onExecute,
  });

  final Skill skill;
  final IconData icon;
  final Color color;
  final void Function(Skill) onExecute;

  @override
  State<_SkillCard> createState() => _SkillCardState();
}

class _SkillCardState extends State<_SkillCard> {
  bool _down = false;

  void _setDown(bool value) {
    if (_down != value) setState(() => _down = value);
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    // Reduced motion keeps the border tint but drops the squash and the
    // 200ms transitions, same contract as PressableScale.
    final reduced = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    return GestureDetector(
      onTap: () => widget.onExecute(widget.skill),
      onTapDown: (_) => _setDown(true),
      onTapUp: (_) => _setDown(false),
      onTapCancel: () => _setDown(false),
      child: AnimatedScale(
        scale: _down && !reduced ? 0.97 : 1,
        duration: reduced ? Duration.zero : AppDuration.press,
        curve: AppCurves.press,
        child: AnimatedContainer(
          duration: reduced ? Duration.zero : AppDuration.micro,
          curve: AppCurves.standard,
          padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
          decoration: BoxDecoration(
            color: palette.surface,
            borderRadius: BorderRadius.circular(AppRadius.medium),
            border: Border.all(
              color: _down
                  ? widget.color.withValues(alpha: 0.45)
                  : palette.stroke,
              width: AppStroke.thin,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: widget.color.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(AppRadius.small),
                  border: Border.all(
                    color: widget.color.withValues(alpha: 0.18),
                    width: AppStroke.thin,
                  ),
                ),
                child: Icon(widget.icon, size: 20, color: widget.color),
              ),
              const SizedBox(height: AppSpacing.dense),
              Text(
                widget.skill.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppText.cardTitle.copyWith(color: palette.textPrimary),
              ),
              // Expanded instead of a bare Spacer: the fixed 148dp cell must
              // hold a two-line description, and this fades the text instead
              // of overflowing when the system font scale grows.
              Expanded(
                child: Text(
                  widget.skill.description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.secondary.copyWith(
                    color: palette.textSecondary,
                  ),
                ),
              ),
              Text(
                '执行 →',
                style: AppText.label.copyWith(color: palette.primary),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
