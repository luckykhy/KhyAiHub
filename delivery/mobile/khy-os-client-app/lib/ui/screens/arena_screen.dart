import 'package:flutter/material.dart';

import '../../core/config/app_config.dart';
import '../../core/config/built_in_keys.dart';
import '../../core/config/model_registry.dart';
import '../../core/services/arena_runner.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import '../widgets/model_picker_sheet.dart';

/// 客户端竞技场：同一个 prompt 并行打给多个已配置的模型，横向对比。
///
/// 入口由接线阶段定（设置页的 _listTileAction → Navigator.push），本页不自己
/// 注册路由——go_router 版路由是全仓零引用的死代码，接进去反而进不来。
///
/// 不做的事（与桌面 arenaManager 的边界）：手机上不跑微调、不导出 GGUF、
/// 不注册 Ollama；评分只用确定性启发式（代码块/截断/密度），界面上永远标
/// 「启发式分数」——evals/index.js 那种 `Math.random()` 假分数不复制。
class ArenaScreen extends StatefulWidget {
  const ArenaScreen({super.key, this.loadCandidates});

  /// 目录取数注入用。为空时从本机已配置的提供商构建（需要安全存储，只在
  /// 真机上跑）；测试注入假目录。
  final Future<List<ArenaCandidate>> Function()? loadCandidates;

  @override
  State<ArenaScreen> createState() => _ArenaScreenState();
}

class _ArenaScreenState extends State<ArenaScreen> {
  final TextEditingController _promptController = TextEditingController();

  List<ArenaCandidate> _catalog = const [];
  final List<ArenaCandidate> _selected = [];

  bool _loadingCatalog = true;
  bool _running = false;
  int _settled = 0;
  int _total = 0;
  ArenaRun? _run;

  /// 目录读取失败的理由。null = 没失败。读取失败与「一个都没配」是两件事，
  /// 前者要说修复，后者说去哪配。
  String? _catalogError;

  @override
  void initState() {
    super.initState();
    _loadCatalog();
  }

  @override
  void dispose() {
    _promptController.dispose();
    super.dispose();
  }

  Future<void> _loadCatalog() async {
    setState(() {
      _loadingCatalog = true;
      _catalogError = null;
    });
    try {
      final candidates =
          await (widget.loadCandidates?.call() ?? _builtInCandidates());
      if (!mounted) return;
      setState(() {
        _catalog = candidates;
        _loadingCatalog = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _catalog = const [];
        _catalogError = '$e';
        _loadingCatalog = false;
      });
    }
  }

  /// 本机已配置的提供商 → 目录。判据与设置页一致：端点要在，钥匙要么内置
  /// 要么是用户给这个端点自备的那一把。
  Future<List<ArenaCandidate>> _builtInCandidates() async {
    final config = await AppConfig.loadEffective();
    final out = <ArenaCandidate>[];
    for (final entry in BuiltInKeys.providers.entries) {
      final provider = entry.value;
      if (!provider.endpointConfigured) continue;
      final userKeyForThisProvider =
          config.hasUserKey && config.baseUrl == provider.baseUrl;
      final key = userKeyForThisProvider
          ? config.apiKey
          : (provider.hasKey ? provider.apiKey : '');
      if (key.isEmpty) continue;
      for (final model in provider.models) {
        out.add(ArenaCandidate(
          provider: entry.key,
          model: model,
          baseUrl: provider.baseUrl,
          apiKey: key,
        ));
      }
    }
    return out;
  }

  Future<void> _pickModel() async {
    if (_catalog.isEmpty) return;
    final picked = await showModalBottomSheet<ModelInfo>(
      context: context,
      builder: (ctx) => ModelPickerSheet(
        models: _catalog
            .map((c) => ModelInfo(id: c.key, name: c.model, provider: c.provider))
            .toList(),
        currentId: _selected.isEmpty ? '' : _selected.first.key,
        palette: AppPalette.of(ctx),
      ),
    );
    if (picked == null || !mounted) return;
    ArenaCandidate? candidate;
    for (final c in _catalog) {
      if (c.key == picked.id) {
        candidate = c;
        break;
      }
    }
    // 面板打开期间目录可能已被重载，id 对不上就说清楚，不回退到第一个——
    // 那会对着一个用户没点的模型发请求。
    if (candidate == null) {
      _notice('模型列表刚变化过，请重新选择');
      return;
    }
    if (_selected.any((c) => c.key == candidate.key)) {
      _notice('${candidate.label} 已经在对比列表里了');
      return;
    }
    setState(() => _selected.add(candidate));
  }

  Future<void> _run() async {
    final prompt = _promptController.text.trim();
    if (prompt.isEmpty) {
      _notice('先输入要对比的 prompt');
      return;
    }
    if (_selected.length < 2) {
      _notice('至少选 2 个模型才能对比（现在选了 ${_selected.length} 个）');
      return;
    }
    setState(() {
      _running = true;
      _settled = 0;
      _total = _selected.length;
      _run = null;
    });
    try {
      final run = await const ArenaRunner().run(
        prompt,
        _selected.map((c) => c.toContestant()).toList(),
        onSettled: (settled, total) {
          if (!mounted) return;
          setState(() {
            _settled = settled;
            _total = total;
          });
        },
      );
      if (!mounted) return;
      setState(() {
        _run = run;
        _running = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _running = false);
      _notice('对比失败：$e。修复：重试；持续失败请查看「设置 → 诊断工具 → 日志」。');
    }
  }

  void _notice(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('模型竞技场')),
      body: SafeArea(
        child: _loadingCatalog
            ? _loadingState(palette)
            : _catalogError != null
                ? _catalogErrorState(palette)
                : _catalog.length < 2
                    ? _tooFewModelsState(palette)
                    : _content(palette),
      ),
    );
  }

  // ── 整页状态 ──

  Widget _loadingState(AppPalette palette) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '正在读取本机已配置的提供商（共 ${BuiltInKeys.providers.length} 个）…',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  /// 目录读取失败：与「一个都没配」分开说，并给重试入口。
  Widget _catalogErrorState(AppPalette palette) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 40, color: palette.error),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '读不到已配置的提供商',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '原因：${_catalogError}。\n修复：重试；持续失败请查看「设置 → 诊断工具 → 日志」。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpacing.dense),
            TextButton(
              onPressed: _loadCatalog,
              child: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }

  /// 可用模型不够两个时要说清差什么、去哪补——空白屏等于「功能坏了」。
  Widget _tooFewModelsState(AppPalette palette) {
    final count = _catalog.length;
    final detail = count == 0
        ? '现在一个提供商都没配好：没有端点或没有可用的 API Key。'
        : '现在只配好了 $count 个，不够开场。';
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.hub_outlined, size: 40, color: palette.textFaint),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '可用模型不足 2 个',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '$detail\n竞技场要把同一个 prompt 同时发给多个模型对比，至少需要 2 个。\n'
              '修复：去「设置」给至少两个提供商填好 API Key（或配好端点），再回到本页。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  // ── 主内容 ──

  Widget _content(AppPalette palette) {
    final run = _run;
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.page),
      children: [
        _promptCard(palette),
        const SizedBox(height: AppSpacing.cardGap),
        _selectionCard(palette),
        const SizedBox(height: AppSpacing.cardGap),
        _runButton(),
        if (_running) ...[
          const SizedBox(height: AppSpacing.cardGap),
          _progressCard(palette),
        ],
        if (run != null) ...[
          const SizedBox(height: AppSpacing.cardGap),
          _summaryCard(palette, run.summary),
          const SizedBox(height: AppSpacing.cardGap),
          _metricsCard(palette, run.summary),
          const SizedBox(height: AppSpacing.cardGap),
          _similarityCard(palette, run.summary),
          const SizedBox(height: AppSpacing.cardGap),
          _answersCard(palette, run),
        ],
      ],
    );
  }

  Widget _promptCard(AppPalette palette) {
    return _card(
      palette,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('要对比的 prompt',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
          const SizedBox(height: AppSpacing.dense),
          TextField(
            controller: _promptController,
            maxLines: 4,
            minLines: 3,
            decoration: const InputDecoration(
              hintText: '同一个问题会同时发给下面选中的每个模型',
              border: OutlineInputBorder(),
            ),
          ),
        ],
      ),
    );
  }

  Widget _selectionCard(AppPalette palette) {
    return _card(
      palette,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '参战模型（已选 ${_selected.length} 个，至少 2 个）',
                  style: AppText.cardTitle.copyWith(color: palette.textPrimary),
                ),
              ),
              TextButton.icon(
                onPressed: _running ? null : _pickModel,
                icon: const Icon(Icons.playlist_add, size: 18),
                label: const Text('添加模型'),
              ),
            ],
          ),
          if (_selected.isEmpty)
            Text(
              '从「添加模型」里挑：同一个 prompt 会并行发给每一个，谁失败都不影响其他。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            )
          else
            Wrap(
              spacing: AppSpacing.dense,
              runSpacing: AppSpacing.dense,
              children: [
                for (final candidate in _selected)
                  InputChip(
                    label: Text(candidate.label),
                    onDeleted: _running ? null : () => _remove(candidate),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  void _remove(ArenaCandidate candidate) {
    setState(() => _selected.removeWhere((c) => c.key == candidate.key));
  }

  Widget _runButton() {
    // 输入变化只重建这一个按钮：TextField 不会触发 setState，整页重建会让
    // 正在跑的进度条跟着闪。
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: _promptController,
      builder: (context, value, _) {
        final enabled = !_running &&
            value.text.trim().isNotEmpty &&
            _selected.length >= 2;
        return SizedBox(
          width: double.infinity,
          child: ElevatedButton.icon(
            onPressed: enabled ? _run : null,
            icon: const Icon(Icons.bolt_outlined, size: 18),
            label: Text(_running
                ? '正在对比 $_total 个模型（$_settled/$_total）…'
                : '开始对比（${_selected.length} 个模型）'),
          ),
        );
      },
    );
  }

  Widget _progressCard(AppPalette palette) {
    return _card(
      palette,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '正在并行请求 $_total 个模型（已完成 $_settled/$_total）…',
            style: AppText.secondary.copyWith(color: palette.textSecondary),
          ),
          const SizedBox(height: AppSpacing.dense),
          LinearProgressIndicator(
            value: _total == 0 ? null : _settled / _total,
            color: palette.primary,
            backgroundColor: palette.surfaceHigh,
          ),
        ],
      ),
    );
  }

  Widget _summaryCard(AppPalette palette, ArenaSummary summary) {
    return _card(
      palette,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('本场结果',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
          const SizedBox(height: AppSpacing.dense),
          Text(
            '共 ${summary.totalModels} 个模型：${summary.successCount} 个成功、'
            '${summary.failedCount} 个失败。'
            '${summary.fastest == null ? '' : '最快：${summary.fastest!.model}（${summary.fastest!.latencyMs}ms）。'}',
            style: AppText.secondary.copyWith(color: palette.textSecondary),
          ),
          for (final failure in summary.failed) ...[
            const SizedBox(height: AppSpacing.inner),
            Text(
              '${failure.contestant.label}：${failure.error}',
              style: AppText.secondary.copyWith(color: palette.error),
            ),
          ],
        ],
      ),
    );
  }

  Widget _metricsCard(AppPalette palette, ArenaSummary summary) {
    if (summary.metrics.isEmpty) {
      return _card(
        palette,
        Text(
          '没有一个模型返回成功，没有可对比的指标。',
          style: AppText.secondary.copyWith(color: palette.textSecondary),
        ),
      );
    }
    return _card(
      palette,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('指标对比',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
          const SizedBox(height: AppSpacing.dense),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: DataTable(
              headingRowHeight: 32,
              dataRowMinHeight: 32,
              dataRowMaxHeight: 44,
              columnSpacing: AppSpacing.inner,
              columns: const [
                DataColumn(label: Text('模型')),
                DataColumn(label: Text('延迟')),
                DataColumn(label: Text('字数')),
                DataColumn(label: Text('tokens')),
                DataColumn(label: Text('代码块')),
                DataColumn(label: Text('启发式分数')),
              ],
              rows: [
                for (final m in summary.metrics)
                  DataRow(cells: [
                    DataCell(Text(
                      m.model,
                      style: AppText.micro.copyWith(color: palette.textPrimary),
                    )),
                    DataCell(Text('${m.latencyMs}ms')),
                    DataCell(Text('${m.contentLength}')),
                    DataCell(Text(m.tokens == 0 ? '—' : '${m.tokens}')),
                    DataCell(Text('${m.codeBlockCount}')),
                    DataCell(Text('${m.heuristicScore}')),
                  ]),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.dense),
          Text(
            '「启发式分数」是确定性启发式（代码块闭合/是否截断/信息密度），'
            '不是质量评测，也不代表答案正确。',
            style: AppText.micro.copyWith(color: palette.textFaint),
          ),
        ],
      ),
    );
  }

  Widget _similarityCard(AppPalette palette, ArenaSummary summary) {
    if (summary.similarities.isEmpty) return const SizedBox.shrink();
    return _card(
      palette,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('回答相似度（Jaccard）',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
          const SizedBox(height: AppSpacing.dense),
          for (final pair in summary.similarities)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.inner),
              child: Text(
                '${pair.modelA} ↔ ${pair.modelB}：${pair.similarity}%',
                style: AppText.secondary.copyWith(color: palette.textSecondary),
              ),
            ),
        ],
      ),
    );
  }

  Widget _answersCard(AppPalette palette, ArenaRun run) {
    return _card(
      palette,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('各模型原文',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
          for (final result in run.results) ...[
            const SizedBox(height: AppSpacing.cardGap),
            Text(
              result.contestant.label,
              style: AppText.label.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: 2),
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 220),
              padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
              decoration: BoxDecoration(
                color: palette.surfaceHigh,
                borderRadius: BorderRadius.circular(AppRadius.medium),
                border: Border.all(color: palette.stroke, width: AppStroke.thin),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  result.ok
                      ? (result.content.isEmpty ? '（这个模型返回了空内容）' : result.content)
                      : '失败：${result.error}',
                  style: AppText.secondary.copyWith(
                    color: result.ok ? palette.textSecondary : palette.error,
                  ),
                ),
              ),
            ),
          ],
        ],
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
