import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../../core/gateway/khyos_api.dart';
import '../../core/services/app_logger.dart' show formatLogTime;
import '../../core/services/usage_ledger.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import '../widgets/aurora.dart' show SectionTitle;

/// 用量与成本。
///
/// 入口由接线阶段定（设置页「诊断工具」分组后的 _listTileAction），本页不自己
/// 注册路由。
///
/// 与桌面 UsageSettings.tsx / usageCharts.tsx 同口径：图表手画、零图表库；
/// 量纲是 token（成本在主路径上恒取不到价目，画金额条会是假零条）；预算由用户
/// 自设，不显示服务端配额（getRemainingQuota 绑 subscription tier 且只记
/// CLI/TUI 流量，报给手机用户是假数）。
///
/// 取数经 [UsageSnapshot]：为空时走本机账本 UsageLedger.instance。这一层接缝
/// 让「空账」与「账本打不开」在测试里都能真的渲染出来——两者说的话不同。
class UsageScreen extends StatefulWidget {
  const UsageScreen({super.key, this.api, this.loadUsage});

  /// 注入用。为空时本页自建一个，并在 dispose 时释放（价目表走它的 apiFetch，
  /// 后端地址只从连接配置来，本页不碰主机名）。
  final KhyOsApi? api;

  /// 取数注入用。为空时走本机账本。
  final Future<UsageSnapshot> Function()? loadUsage;

  @override
  State<UsageScreen> createState() => _UsageScreenState();
}

/// 一次取数的结果。
@immutable
class UsageSnapshot {
  const UsageSnapshot({
    this.entries = const <UsageEntry>[],
    this.budget = 0,
    this.available = true,
  });

  final List<UsageEntry> entries;

  /// 用户自设月度预算（token）。0 = 没设。
  final int budget;

  /// false = 本机账本打不开（磁盘/权限）。此时「没有记录」与「读不到」必须
  /// 分开说：把读不到显示成从没用过，是在骗用户。
  final bool available;
}

/// 账本的取数窗口。滚动窗口而非全量：与桌面端一致，页脚要写明它不是全量历史。
const int _kWindowDays = 90;

/// 价目表单次请求超时。一次性 GET，防的是挂死的 I/O，不是长任务
/// （RUNTIME-003 的短生命周期网络请求例外）。
const Duration _kPricingTimeout = Duration(seconds: 15);

class _UsageScreenState extends State<UsageScreen> {
  late final KhyOsApi _api;
  late final bool _ownsApi;
  final UsageLedger _ledger = UsageLedger.instance;

  bool _loading = true;
  bool _available = true;
  List<UsageEntry> _entries = const <UsageEntry>[];
  int _budget = 0;
  Map<String, ModelPrice> _prices = const <String, ModelPrice>{};
  DateTime _loadedAt = DateTime.now();
  int _rangeDays = 30;

  /// 取数的真实步号。两步都真的顺序发生（先账本行、后后端价目表），
  /// 所以进度条上的「第 n/2 步」不是装饰——写一个没人推进的 0/90
  /// 才是装饰（规则 2 要的是可量化推进，不是看起来像进度的字）。
  int _loadStep = 1;

  @override
  void initState() {
    super.initState();
    _api = widget.api ?? KhyOsApi();
    _ownsApi = widget.api == null;
    _load();
  }

  @override
  void dispose() {
    if (_ownsApi) _api.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadStep = 1;
    });
    final snapshot = await (widget.loadUsage?.call() ?? _loadUsage());
    if (!mounted) return;
    setState(() => _loadStep = 2);
    final prices = await _loadPricing();
    if (!mounted) return;
    setState(() {
      _available = snapshot.available;
      _entries = snapshot.entries;
      _budget = snapshot.budget;
      _prices = prices;
      _loadedAt = DateTime.now();
      _loading = false;
    });
  }

  Future<UsageSnapshot> _loadUsage() async {
    final now = DateTime.now();
    final from =
        DateTime(now.year, now.month, now.day).subtract(const Duration(days: _kWindowDays - 1));
    final entries = await _ledger.entriesBetween(
      from.millisecondsSinceEpoch,
      now.millisecondsSinceEpoch,
    );
    // 顺序有所谓：entriesBetween 先触发开库，isAvailable 读的才是这一次的结果。
    final budget = await _ledger.monthlyBudget();
    return UsageSnapshot(
      entries: entries,
      budget: budget,
      available: _ledger.isAvailable,
    );
  }

  /// 价目表走后端 `GET /api/ai-gateway/pricing`（经 apiFetch，地址不硬编码）。
  ///
  /// 取不到就返回空表：界面照常出 token 数，成本那一行说「未计价」。
  /// 计价是增益，不是用量页的前提——为了有数看而伪造一张价目表，比没有更糟。
  Future<Map<String, ModelPrice>> _loadPricing() async {
    try {
      final response = await _api
          .apiFetch('/api/ai-gateway/pricing')
          .timeout(_kPricingTimeout);
      return parseGatewayPricing(response.data);
    } catch (_) {
      return const <String, ModelPrice>{};
    }
  }

  UsageViewData get _view => buildUsageViewData(
        entries: _entries,
        budget: _budget,
        prices: _prices,
        rangeDays: _rangeDays,
        now: _loadedAt,
      );

  void _notice(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  /// 导出 CSV：落盘到应用文档目录并告知路径。
  ///
  /// 系统分享入口（share_plus 或既有 Android share entry）由接线阶段定，
  /// 这里不引第二个分享实现；测试环境没有 path_provider，失败走修复建议。
  Future<void> _exportCsv() async {
    final view = _view;
    if (view.isEmpty) return;
    final csv = buildUsageCsv(_entries, stamp: view.stamp, windowDays: _kWindowDays);
    try {
      final dir = await getApplicationDocumentsDirectory();
      final name = usageExportFileName(DateTime.now());
      final file = File(p.join(dir.path, name));
      await file.writeAsString(csv);
      _notice('已导出：$name（${file.path}）');
    } catch (e) {
      _notice('导出失败：写入没成功（$e）。修复：确认手机存储空间充足后重试；'
          '仍失败请查看运行日志。');
    }
  }

  Future<void> _editBudget() async {
    final controller = TextEditingController(text: _budget > 0 ? '$_budget' : '');
    var invalid = false;
    final saved = await showDialog<int>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('月度预算（token）'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: controller,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: '每月 token 上限',
                  errorText: invalid ? '填一个不小于 0 的整数（token）' : null,
                ),
              ),
              const SizedBox(height: AppSpacing.dense),
              Text(
                '每月 1 日重置；填 0 表示不设预算。量纲是 token——成本在主路径上取不到价目，画金额条会是假零条。',
                style: AppText.secondary,
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () {
                final value = int.tryParse(controller.text.trim());
                if (value == null || value < 0) {
                  setDialogState(() => invalid = true);
                  return;
                }
                Navigator.pop(ctx, value);
              },
              child: const Text('保存'),
            ),
          ],
        ),
      ),
    );
    controller.dispose();
    if (saved == null) return;
    await _ledger.setMonthlyBudget(saved);
    if (!mounted) return;
    setState(() => _budget = saved);
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final view = _view;
    return Scaffold(
      appBar: AppBar(
        title: const Text('用量与成本'),
        actions: [
          IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
          IconButton(
            onPressed: view.isEmpty ? null : _exportCsv,
            icon: const Icon(Icons.file_download_outlined),
            tooltip: '导出 CSV',
          ),
        ],
      ),
      body: SafeArea(
        child: _loading
            ? _loadingState(palette)
            : !_available
                ? _ledgerDownState(palette)
                : view.isEmpty
                    ? _emptyState(palette)
                    : _content(palette, view),
      ),
    );
  }

  // ── 四种整页状态 ──

  Widget _loadingState(AppPalette palette) {
    // 第 1 步读账本行、第 2 步取后端价目表——两步都真的会发生，步号随之前进。
    final target = _loadStep == 1 ? '账本行' : '后端价目表';
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '正在读取本机用量账（第 $_loadStep/2 步：$target）…',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  Widget _ledgerDownState(AppPalette palette) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.storage_outlined, size: 40, color: palette.error),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '用量账本不可用',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '本机存储读取失败，本次运行看不到用量记录。'
              '修复：重启应用再试；仍不行请查看「设置 → 诊断工具 → 日志」里的错误。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  Widget _emptyState(AppPalette palette) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.bar_chart_outlined, size: 40, color: palette.textFaint),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '还没有用量记录',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '在本机发一条 AI 对话后，每个助手回合的 token 用量会记到这里。'
              '账本只存本机，不上传，也不显示服务端配额。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  // ── 主内容 ──

  Widget _content(AppPalette palette, UsageViewData view) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.page),
      children: [
        _summaryCard(palette, view),
        const SizedBox(height: AppSpacing.cardGap),
        Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: _statTile(palette, '本周', view.week)),
            const SizedBox(width: AppSpacing.cardGap),
            Expanded(child: _statTile(palette, '本月', view.month)),
          ],
        ),
        const SizedBox(height: AppSpacing.cardGap),
        _budgetCard(palette, view),
        const SizedBox(height: AppSpacing.cardGap),
        _chartCard(palette, view),
        const SizedBox(height: AppSpacing.cardGap),
        const SectionTitle(title: '按模型', icon: Icons.hub_outlined),
        const SizedBox(height: AppSpacing.dense),
        _modelCard(palette, view),
        const SizedBox(height: AppSpacing.section),
        Text(
          '数据截至 ${view.stamp}',
          style: AppText.micro.copyWith(color: palette.textFaint),
        ),
        Text(
          '近 $_kWindowDays 日为滚动窗口，非全量历史',
          style: AppText.micro.copyWith(color: palette.textFaint),
        ),
      ],
    );
  }

  Widget _summaryCard(AppPalette palette, UsageViewData view) {
    return _card(
      palette,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('本月 tokens',
              style: AppText.secondary.copyWith(color: palette.textSecondary)),
          const SizedBox(height: 2),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                formatCompactNumber(view.month.totalTokens),
                style: AppText.display.copyWith(color: palette.textPrimary),
              ),
              const SizedBox(width: AppSpacing.dense),
              Text('tokens',
                  style: AppText.secondary.copyWith(color: palette.textSecondary)),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          Text(
            '${view.month.turns} 个助手回合 · 近 $_kWindowDays 日内 '
            '${view.recordedDays} 天有记录',
            style: AppText.secondary.copyWith(color: palette.textSecondary),
          ),
          const SizedBox(height: 2),
          Text(
            _costLine(view),
            style: AppText.secondary.copyWith(color: palette.textFaint),
          ),
        ],
      ),
    );
  }

  /// 成本行。三条分支都不说「免费」：未接入计价、部分模型未计价、全计价。
  String _costLine(UsageViewData view) {
    final cost = view.costCny;
    if (cost == null) {
      return '成本估计：价目表未取到，暂不估计（预算以 token 计）';
    }
    if (view.unpricedModels.isEmpty) {
      return '成本估计：¥${cost.toStringAsFixed(2)}（按后端价目表折算）';
    }
    return '成本估计：¥${cost.toStringAsFixed(2)}'
        '（${view.unpricedModels.length} 个模型未计价）';
  }

  Widget _statTile(AppPalette palette, String label, UsageTotals totals) {
    return _card(
      palette,
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label,
              style: AppText.secondary.copyWith(color: palette.textSecondary)),
          const SizedBox(height: 2),
          Text('合计 ${formatCompactNumber(totals.totalTokens)}',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
          const SizedBox(height: 2),
          Text(
            '输入 ${formatCompactNumber(totals.inputTokens)} · '
            '输出 ${formatCompactNumber(totals.outputTokens)}',
            style: AppText.micro.copyWith(color: palette.textFaint),
          ),
          Text(
            '${totals.turns} 个回合',
            style: AppText.micro.copyWith(color: palette.textFaint),
          ),
        ],
      ),
    );
  }

  Widget _budgetCard(AppPalette palette, UsageViewData view) {
    if (!view.hasBudget) {
      return _card(
        palette,
        Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('月度预算',
                      style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
                  const SizedBox(height: 2),
                  Text('还没设预算：设一个 token 上限，超了会在本页提醒。',
                      style: AppText.secondary.copyWith(color: palette.textSecondary)),
                ],
              ),
            ),
            TextButton(
              onPressed: _editBudget,
              child: const Text('设置预算'),
            ),
          ],
        ),
      );
    }
    final ratio = view.budgetUsedRatio;
    final over = view.overBudget;
    return _card(
      palette,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text('本月 token 用量 / 自设上限',
                    style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
              ),
              TextButton(
                onPressed: _editBudget,
                child: const Text('修改'),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          Text(
            '${formatCompactNumber(view.month.totalTokens)} / '
            '${formatCompactNumber(view.budget)}（$ratio%）',
            style: AppText.secondary.copyWith(
              color: over ? palette.error : palette.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.dense),
          _ratioBar(
            palette,
            ratio: ratio / 100,
            color: over ? palette.error : palette.primary,
            label: '本月 token 用量 ${view.month.totalTokens}，'
                '自设上限 ${view.budget}，占比 $ratio%',
          ),
          const SizedBox(height: AppSpacing.dense),
          Text(
            over ? '已超过自设上限' : '每月 1 日重置 · 合计 = 输入 + 输出',
            style: AppText.micro.copyWith(
              color: over ? palette.error : palette.textFaint,
            ),
          ),
        ],
      ),
    );
  }

  Widget _chartCard(AppPalette palette, UsageViewData view) {
    final buckets = view.chartDays;
    final peak = buckets.fold<int>(
      0,
      (max, b) => b.totalTokens > max ? b.totalTokens : max,
    );
    final axisMax = niceCeilAxis(peak);
    final recorded = buckets.where((b) => b.hasRecords).length;
    return _card(
      palette,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text('每日用量',
                    style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
              ),
              SegmentedButton<int>(
                segments: const [
                  ButtonSegment<int>(value: 7, label: Text('近 7 日')),
                  ButtonSegment<int>(value: 30, label: Text('近 30 日')),
                ],
                selected: <int>{_rangeDays},
                onSelectionChanged: (picked) =>
                    setState(() => _rangeDays = picked.first),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          if (recorded == 0)
            SizedBox(
              height: 96,
              child: Center(
                child: Text(
                  '近 ${buckets.length} 日内没有用量记录',
                  style: AppText.secondary.copyWith(color: palette.textSecondary),
                ),
              ),
            )
          else ...[
            SizedBox(
              height: 140,
              child: Semantics(
                label: '每日用量堆叠柱图，近 ${buckets.length} 日，'
                    '其中 $recorded 天有记录',
                child: CustomPaint(
                  key: const Key('usageDailyBars'),
                  painter: _DailyBarsPainter(
                    buckets: buckets,
                    axisMax: axisMax,
                    inputColor: palette.primary,
                    outputColor: palette.cyan,
                    missingColor: palette.textFaint,
                    baselineColor: palette.stroke,
                  ),
                ),
              ),
            ),
            _dayLabels(palette, buckets),
            const SizedBox(height: AppSpacing.dense),
            _chartLegend(palette, axisMax),
          ],
        ],
      ),
    );
  }

  Widget _dayLabels(AppPalette palette, List<UsageDayBucket> buckets) {
    // 30 根柱子放不下 30 个日期，只留首尾；7 根才全显示。
    final showAll = buckets.length <= 10;
    final shown =
        showAll ? buckets : <UsageDayBucket>[buckets.first, buckets.last];
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          for (final bucket in shown)
            Text(
              usageDayLabel(bucket.day),
              style: AppText.micro.copyWith(color: palette.textFaint),
            ),
        ],
      ),
    );
  }

  Widget _chartLegend(AppPalette palette, int axisMax) {
    final faint = AppText.micro.copyWith(color: palette.textFaint);
    return Wrap(
      spacing: AppSpacing.inner,
      runSpacing: 4,
      children: [
        _legendDot(palette.primary, faint, '输入'),
        _legendDot(palette.cyan, faint, '输出'),
        _legendDot(palette.textFaint, faint, '无记录（未记 ≠ 零用量）'),
        Text(
          '纵轴上限 ${formatCompactNumber(axisMax)} tokens',
          style: faint,
        ),
      ],
    );
  }

  Widget _legendDot(Color color, TextStyle labelStyle, String label) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(label, style: labelStyle),
      ],
    );
  }

  Widget _modelCard(AppPalette palette, UsageViewData view) {
    // 能走到这里说明窗口内有行，models 不可能为空（空账在整页状态就拦下了）。
    final models = view.models;
    return _card(
      palette,
      Column(
        children: [
          for (final row in models.asMap().entries)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.inner),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          color: _modelColor(palette, row.key),
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: AppSpacing.dense),
                      Expanded(
                        child: Text(
                          usageModelLabel(row.value.model),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppText.secondary
                              .copyWith(color: palette.textPrimary),
                        ),
                      ),
                      Text(
                        '${formatCompactNumber(row.value.totals.totalTokens)} tokens',
                        style: AppText.micro
                            .copyWith(color: palette.textSecondary),
                      ),
                      const SizedBox(width: AppSpacing.dense),
                      SizedBox(
                        width: 40,
                        child: Text(
                          '${row.value.percentage.toStringAsFixed(0)}%',
                          textAlign: TextAlign.right,
                          style: AppText.micro
                              .copyWith(color: palette.textSecondary),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  _ratioBar(
                    palette,
                    ratio: math.min(1, row.value.percentage / 100),
                    color: _modelColor(palette, row.key),
                    label: '${usageModelLabel(row.value.model)}：'
                        '${row.value.totals.totalTokens} tokens，'
                        '占 ${row.value.percentage.toStringAsFixed(0)}%',
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Color _modelColor(AppPalette palette, int index) {
    final colors = <Color>[
      palette.primary,
      palette.accent,
      palette.cyan,
      palette.success,
      palette.warning,
      palette.hot,
    ];
    return colors[index % colors.length];
  }

  Widget _ratioBar(
    AppPalette palette, {
    required double ratio,
    required Color color,
    required String label,
  }) {
    return Semantics(
      label: label,
      child: SizedBox(
        height: 6,
        child: Stack(
          children: [
            Container(
              decoration: BoxDecoration(
                color: palette.surfaceHigh,
                borderRadius: BorderRadius.circular(AppRadius.pill),
              ),
            ),
            FractionallySizedBox(
              // clamp 在 num 上返回 num，这里要 double，用 min/max 兜住。
              widthFactor: math.min(1.0, math.max(0.0, ratio)),
              child: Container(
                decoration: BoxDecoration(
                  color: color,
                  borderRadius: BorderRadius.circular(AppRadius.pill),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _card(
    AppPalette palette,
    Widget child, {
    EdgeInsetsGeometry padding = const EdgeInsets.all(AppSpacing.cardPad),
  }) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: child,
    );
  }
}

// ───────────────────────────────────────────────
// 视图模型：纯函数。账本行 → 界面要显示的一切。
// 与桌面 shared/usageChartMath.ts 同一分工：几何与口径写在这里才能不靠设备测。
// ───────────────────────────────────────────────

@immutable
class UsageViewData {
  const UsageViewData({
    required this.month,
    required this.week,
    required this.chartDays,
    required this.models,
    required this.costCny,
    required this.unpricedModels,
    required this.budget,
    required this.rangeDays,
    required this.recordedDays,
    required this.stamp,
    required this.entryCount,
  });

  /// 本月（自然月，每月 1 日重置）
  final UsageTotals month;

  /// 本周（周一起算）
  final UsageTotals week;

  /// 图表窗口的日桶，最旧在前
  final List<UsageDayBucket> chartDays;

  /// 全窗口按模型，合计降序
  final List<UsageModelBucket> models;

  /// 成本合计（元）。null = 一个模型都没取到价目——「未计价」不是「免费」。
  final double? costCny;

  /// 没有价目的模型名（已去重、已把空名换成「未知模型」）
  final List<String> unpricedModels;

  /// 用户自设月度预算（token）。0 = 没设。
  final int budget;

  final int rangeDays;
  final int recordedDays;
  final String stamp;
  final int entryCount;

  bool get isEmpty => entryCount == 0;

  bool get hasBudget => budget > 0;

  int get budgetUsedRatio =>
      budget <= 0 ? 0 : (month.totalTokens / budget * 100).round();

  bool get overBudget => budget > 0 && month.totalTokens > budget;
}

UsageViewData buildUsageViewData({
  required List<UsageEntry> entries,
  required int budget,
  required Map<String, ModelPrice> prices,
  required int rangeDays,
  DateTime? now,
}) {
  final nowDate = now ?? DateTime.now();
  final months = usageByMonth(entries, months: 1, now: nowDate);
  final month = months.isEmpty ? const UsageTotals() : months.last.totals;
  final weekStart = usageWeekStart(nowDate);
  final week = UsageTotals.of(entries.where((e) => !e.at.isBefore(weekStart)));
  final window = usageByDay(entries, days: _kWindowDays, now: nowDate);

  var cost = 0.0;
  var pricedTurns = 0;
  final unpriced = <String>{};
  for (final entry in entries) {
    final turn = estimateCostCny(
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      prices: prices,
    );
    if (turn == null) {
      unpriced.add(usageModelLabel(entry.model));
      continue;
    }
    cost += turn;
    pricedTurns += 1;
  }

  return UsageViewData(
    month: month,
    week: week,
    chartDays: usageByDay(entries, days: rangeDays, now: nowDate),
    models: usageByModel(entries),
    costCny: pricedTurns == 0 ? null : cost,
    unpricedModels: unpriced.toList(growable: false),
    budget: budget,
    rangeDays: rangeDays,
    recordedDays: window.where((b) => b.hasRecords).length,
    stamp: formatLogTime(nowDate),
    entryCount: entries.length,
  );
}

/// 模型名的界面写法。空串不显示成一行空白——上游没给模型名时要说「未知」。
String usageModelLabel(String model) => model.isEmpty ? '未知模型' : model;

/// 「11/4」。图表横轴与图例共用。
String usageDayLabel(DateTime day) => '${day.month}/${day.day}';

/// 紧凑计数（K/M/B/T）。与桌面 shared/compactNumber.ts 同一标度：
/// 999.95K 要进位成 1M，而不是显示 1000K。
String formatCompactNumber(int input) {
  if (input.abs() < 1000) return input.toString();
  const units = <(int, String)>[
    (1000000000000, 'T'),
    (1000000000, 'B'),
    (1000000, 'M'),
    (1000, 'K'),
  ];
  for (var i = 0; i < units.length; i += 1) {
    final (value, symbol) = units[i];
    if (input.abs() < value) continue;
    final scaled = input / value;
    final digits = scaled.abs() >= 100 ? 0 : 1;
    if (double.parse(scaled.toStringAsFixed(digits)).abs() >= 1000 && i > 0) {
      final (nextValue, nextSymbol) = units[i - 1];
      return _formatScaled(input / nextValue, nextSymbol);
    }
    return _formatScaled(scaled, symbol);
  }
  final (topValue, topSymbol) = units.first;
  return _formatScaled(input / topValue, topSymbol);
}

String _formatScaled(double scaled, String symbol) {
  final digits = scaled.abs() >= 100 ? 0 : 1;
  var text = scaled.toStringAsFixed(digits);
  if (text.endsWith('.0')) text = text.substring(0, text.length - 2);
  return '$text$symbol';
}

/// 线性轴的 nice-number 序列。**只适用于线性标度**——与桌面 usageChartMath
/// 同一判据：nice-number 是线性刻度技巧，用在非线性轴上会让每个标签说谎。
const List<double> _kNiceSteps = <double>[1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];

/// 线性轴上限：不小于 max 的最小 nice 值。非正输入回 1（不炸不画假轴）。
int niceCeilAxis(int max) {
  if (max <= 0) return 1;
  final value = max.toDouble();
  final exponent = (math.log(value) / math.ln10).floor();
  final pow = math.pow(10, exponent).toDouble();
  for (final step in _kNiceSteps) {
    final candidate = step * pow;
    if (candidate >= value - 1e-9) return candidate.round();
  }
  return (10 * pow).round();
}

/// 一根柱子的两段几何。y 向下，相对柱区顶部。
///
/// 段高之和恒等于该日 inputTokens + outputTokens——图上不存在第三个「总量」
/// 口径。空桶返回空列表，由调用方画 Missing 态 1px 基线。
@immutable
class UsageBarSegment {
  const UsageBarSegment({required this.isInput, required this.y, required this.height});

  final bool isInput;
  final double y;
  final double height;
}

List<UsageBarSegment> usageBarSegments(
  UsageDayBucket day,
  int axisMax,
  double plotHeight,
) {
  if (!day.hasRecords) return const <UsageBarSegment>[];
  final total = day.inputTokens + day.outputTokens;
  if (total <= 0 || axisMax <= 0 || plotHeight <= 0) {
    return const <UsageBarSegment>[];
  }
  final inputHeight = day.inputTokens / axisMax * plotHeight;
  final outputHeight = day.outputTokens / axisMax * plotHeight;
  final outputY = plotHeight - outputHeight;
  return <UsageBarSegment>[
    UsageBarSegment(
      isInput: true,
      y: outputY - inputHeight,
      height: inputHeight,
    ),
    UsageBarSegment(isInput: false, y: outputY, height: outputHeight),
  ];
}

/// 每日堆叠柱：输入在上、输出在下，与桌面 usageCharts.tsx 同一摆法。
///
/// 空桶画 1px 基线且用第三色（与两段真实数据必须不同）——同色会把「那天没记」
/// 读成「那天没量」。
class _DailyBarsPainter extends CustomPainter {
  const _DailyBarsPainter({
    required this.buckets,
    required this.axisMax,
    required this.inputColor,
    required this.outputColor,
    required this.missingColor,
    required this.baselineColor,
  });

  final List<UsageDayBucket> buckets;
  final int axisMax;
  final Color inputColor;
  final Color outputColor;
  final Color missingColor;
  final Color baselineColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (buckets.isEmpty) return;
    final baselineY = size.height - 1;
    canvas.drawLine(
      Offset(0, baselineY),
      Offset(size.width, baselineY),
      Paint()
        ..color = baselineColor
        ..strokeWidth = 1,
    );

    final slot = size.width / buckets.length;
    final barWidth = math.max(1.0, math.min(18.0, slot * 0.7));
    // 柱区比整块矮 2px：1px 基线自身 + 1px 呼吸，最高那根不顶到框外。
    final plotHeight = size.height - 2;
    for (var i = 0; i < buckets.length; i += 1) {
      final bucket = buckets[i];
      final left = i * slot + (slot - barWidth) / 2;
      if (!bucket.hasRecords) {
        canvas.drawRect(
          Rect.fromLTWH(left, baselineY - 1, barWidth, 1),
          Paint()..color = missingColor.withValues(alpha: 0.5),
        );
        continue;
      }
      for (final segment in usageBarSegments(bucket, axisMax, plotHeight)) {
        canvas.drawRect(
          Rect.fromLTWH(
            left,
            segment.y + 1,
            barWidth,
            math.max(1.0, segment.height),
          ),
          Paint()..color = segment.isInput ? inputColor : outputColor,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_DailyBarsPainter oldDelegate) =>
      oldDelegate.axisMax != axisMax ||
      !listEquals(oldDelegate.buckets, buckets) ||
      oldDelegate.inputColor != inputColor ||
      oldDelegate.outputColor != outputColor ||
      oldDelegate.missingColor != missingColor ||
      oldDelegate.baselineColor != baselineColor;
}
