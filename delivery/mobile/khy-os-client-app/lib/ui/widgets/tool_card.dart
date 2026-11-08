// khy-canary: Khy-20261101-132-VPGJTW20
import 'package:flutter/material.dart';
import '../../core/tools/tool_engine.dart';
import '../../core/tools/write_diff.dart';
import '../../core/agent/execution_log.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// Structured data for a single tool execution card.
/// Immutable value object — create a new instance on every state transition.
class ToolCardData {
  /// Step index in the execution sequence (1-based)
  final int index;

  /// Raw tool name as registered in the engine (e.g. "exec_shell")
  final String toolName;

  /// Human-readable "verb + target" label for display (e.g. "执行命令: ls -la")
  final String label;

  /// Input arguments (displayed truncated in the card body)
  final Map<String, dynamic> args;

  /// Current execution state
  final ExecState state;

  /// Result output (populated on success)
  final String? output;

  /// Error message (populated on failure)
  final String? error;

  /// Execution duration in ms (null while running/queued)
  final int? durationMs;

  /// When this step started
  final DateTime timestamp;

  /// 写入/编辑类工具的红绿 ± 行；拿不到改动原文时为 null（卡片只说结果）。
  final WriteDiff? diff;

  const ToolCardData({
    required this.index,
    required this.toolName,
    required this.label,
    required this.state,
    this.args = const {},
    this.output,
    this.error,
    this.durationMs,
    required this.timestamp,
    this.diff,
  });

  // ─── Factories ─────────────────────────────────────────────────────

  /// Create a card in "running" state
  static ToolCardData running({
    required int index,
    required String toolName,
    required String label,
    required Map<String, dynamic> args,
    DateTime? at,
  }) {
    return ToolCardData(
      index: index,
      toolName: toolName,
      label: label,
      args: args,
      state: ExecState.running,
      timestamp: at ?? DateTime.now(),
    );
  }

  /// Create a card in "success" state
  static ToolCardData success({
    required int index,
    required String toolName,
    required String label,
    required Map<String, dynamic> args,
    required String output,
    required int durationMs,
    WriteDiff? diff,
    DateTime? at,
  }) {
    return ToolCardData(
      index: index,
      toolName: toolName,
      label: label,
      args: args,
      state: ExecState.success,
      output: output,
      durationMs: durationMs,
      timestamp: at ?? DateTime.now(),
      diff: diff,
    );
  }

  /// Create a card in "failed" state
  static ToolCardData failed({
    required int index,
    required String toolName,
    required String label,
    required Map<String, dynamic> args,
    required String error,
    required int durationMs,
    DateTime? at,
  }) {
    return ToolCardData(
      index: index,
      toolName: toolName,
      label: label,
      args: args,
      state: ExecState.failed,
      error: error,
      durationMs: durationMs,
      timestamp: at ?? DateTime.now(),
    );
  }

  /// Create a card in "timeout" state
  static ToolCardData timeout({
    required int index,
    required String toolName,
    required String label,
    required Map<String, dynamic> args,
    required int durationMs,
    DateTime? at,
  }) {
    return ToolCardData(
      index: index,
      toolName: toolName,
      label: label,
      args: args,
      state: ExecState.timeout,
      error: '执行超时',
      durationMs: durationMs,
      timestamp: at ?? DateTime.now(),
    );
  }

  /// Create from an [ExecutionStep]
  static ToolCardData fromStep(ExecutionStep step, String label) {
    final data = ToolCardData(
      index: step.index,
      toolName: step.toolName,
      label: label,
      args: step.args,
      state: step.state,
      output: step.output,
      error: step.error,
      timestamp: step.startTime,
    );
    return data.copyWith(durationMs: step.durationMs);
  }

  // ─── Immutability helpers ──────────────────────────────────────────

  ToolCardData copyWith({
    int? index,
    String? toolName,
    String? label,
    Map<String, dynamic>? args,
    ExecState? state,
    String? output,
    String? error,
    int? durationMs,
    DateTime? timestamp,
    WriteDiff? diff,
  }) {
    return ToolCardData(
      index: index ?? this.index,
      toolName: toolName ?? this.toolName,
      label: label ?? this.label,
      args: args ?? this.args,
      state: state ?? this.state,
      output: output ?? this.output,
      error: error ?? this.error,
      durationMs: durationMs ?? this.durationMs,
      timestamp: timestamp ?? this.timestamp,
      diff: diff ?? this.diff,
    );
  }

  bool get isCompleted =>
      state == ExecState.success ||
      state == ExecState.failed ||
      state == ExecState.timeout;

  bool get isRunning => state == ExecState.running;

  /// Status badge text
  String get statusText {
    switch (state) {
      case ExecState.queued:
        return '排队中';
      case ExecState.running:
        return '执行中';
      case ExecState.success:
        return '${durationMs ?? 0}ms';
      case ExecState.failed:
        return '失败';
      case ExecState.timeout:
        return '超时';
    }
  }

  // ─── Serialization ────────────────────────────────────────────────

  Map<String, dynamic> toJson() => {
        'index': index,
        'tool': toolName,
        'label': label,
        'args': args,
        'state': state.name,
        if (output != null) 'output': output,
        if (error != null) 'error': error,
        if (durationMs != null) 'duration_ms': durationMs,
        'timestamp': timestamp.toIso8601String(),
      };

  factory ToolCardData.fromJson(Map<String, dynamic> json) {
    return ToolCardData(
      index: json['index'] as int? ?? 0,
      toolName: json['tool'] as String? ?? '',
      label: json['label'] as String? ?? json['tool'] as String? ?? '',
      args: (json['args'] as Map<String, dynamic>?) ?? {},
      state: ExecState.values.firstWhere(
        (e) => e.name == json['state'],
        orElse: () => ExecState.queued,
      ),
      output: json['output'] as String?,
      error: json['error'] as String?,
      durationMs: json['duration_ms'] as int?,
      timestamp:
          json['timestamp'] != null
              ? DateTime.parse(json['timestamp'] as String)
              : DateTime.now(),
    );
  }

  @override
  String toString() =>
      'ToolCardData(#$index $toolName $state ${durationMs ?? '-'}ms)';
}

// ═══════════════════════════════════════════════════════════════════════
// Widget
// ═══════════════════════════════════════════════════════════════════════

/// A structured card that displays a single tool execution.
///
/// Usage:
/// ```
/// ToolCard(data: ToolCardData.running(index: 1, ...))
/// ```
class ToolCard extends StatelessWidget {
  final ToolCardData data;
  final bool expandable;

  const ToolCard({
    super.key,
    required this.data,
    this.expandable = true,
  });

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final body = data.isCompleted;

    final card = AnimatedContainer(
      duration: AppDuration.micro,
      curve: AppCurves.standard,
      width: double.infinity,
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(
          color: _borderColor(palette),
          width: AppStroke.thin,
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ── Header row ──
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.cardPadNarrow,
              vertical: AppSpacing.inner,
            ),
            child: Row(
              children: [
                _statusIcon(data.state, palette),
                const SizedBox(width: AppSpacing.dense),
                Expanded(
                  child: Text(
                    data.label,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: palette.textPrimary,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: AppSpacing.dense),
                // Duration / status badge
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.dense,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: _badgeColor(data.state, palette)
                        .withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(AppRadius.pill),
                  ),
                  child: Text(
                    data.statusText,
                    style: AppText.label.copyWith(
                      color: _badgeColor(data.state, palette),
                    ),
                  ),
                ),
                if (expandable && body) ...[
                  const SizedBox(width: 4),
                  Icon(Icons.expand_more, size: 16, color: palette.textFaint),
                ],
              ],
            ),
          ),

          // ── Body (args + output/error) ──
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.cardPadNarrow,
              0,
              AppSpacing.cardPadNarrow,
              AppSpacing.inner,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (data.args.isNotEmpty) _argsRow(data.args, palette),
                // 红绿 ± 行：写入/编辑类工具把改了什么直接摊开，不再只剩一句
                // 「已写入 x」。拿不到改动原文时这里是空的，卡片照常显示结果。
                if (data.diff != null) _diffSection(data.diff!, palette),
                if (data.output != null && data.state == ExecState.success)
                  _outputSection(data.output!, palette),
                if (data.error != null) _errorSection(data.error!, palette),
                if (data.isRunning) _runningIndicator(palette),
              ],
            ),
          ),
        ],
      ),
    );

    // 运行态是全 app 唯一发光的卡：光晕只在 running 挂载，节奏在 _BreatheHalo。
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.dense),
      child: data.isRunning ? _BreatheHalo(child: card) : card,
    );
  }

  // ── Status icon ───────────────────────────────────────────────────

  Widget _statusIcon(ExecState state, AppPalette palette) {
    switch (state) {
      case ExecState.queued:
        return Icon(Icons.schedule, size: 18, color: palette.textFaint);
      case ExecState.running:
        return SizedBox(
          width: 18,
          height: 18,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: palette.primary,
          ),
        );
      case ExecState.success:
        return Icon(Icons.check_circle, size: 18, color: palette.success);
      case ExecState.failed:
        return Icon(Icons.error, size: 18, color: palette.error);
      case ExecState.timeout:
        return Icon(Icons.timer_off, size: 18, color: palette.warning);
    }
  }

  // ── Args row ──────────────────────────────────────────────────────

  Widget _argsRow(Map<String, dynamic> args, AppPalette palette) {
    final text = args.entries
        .map((e) => '${e.key}: ${e.value}')
        .join('  ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        text.length > 80 ? '${text.substring(0, 80)}...' : text,
        style: AppText.secondary.copyWith(color: palette.textSecondary),
      ),
    );
  }

  // ── Diff section ──────────────────────────────────────────────────

  Widget _diffSection(WriteDiff diff, AppPalette palette) {
    final mono = AppText.secondary.copyWith(
      fontFamily: 'monospace',
      fontSize: 11,
      height: 1.45,
    );
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: palette.surface,
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            color: palette.surfaceHigh,
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    diff.filePath.isEmpty ? '改动' : diff.filePath,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.label.copyWith(color: palette.textSecondary),
                  ),
                ),
                if (diff.added > 0)
                  Text(
                    '+${diff.added}',
                    style: AppText.label.copyWith(color: palette.success),
                  ),
                if (diff.added > 0 && diff.removed > 0) const SizedBox(width: 6),
                if (diff.removed > 0)
                  Text(
                    '-${diff.removed}',
                    style: AppText.label.copyWith(color: palette.error),
                  ),
              ],
            ),
          ),
          for (final row in diff.rows) _diffRow(row, mono, palette),
        ],
      ),
    );
  }

  Widget _diffRow(WriteDiffRow row, TextStyle mono, AppPalette palette) {
    if (row.kind == 'add' || row.kind == 'del' || row.kind == 'ctx') {
      final isAdd = row.kind == 'add';
      final isDel = row.kind == 'del';
      final num = isAdd ? (row.numNew ?? row.num) : row.num;
      return Container(
        color: isAdd
            ? palette.success.withValues(alpha: 0.10)
            : isDel
                ? palette.error.withValues(alpha: 0.10)
                : null,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 34,
              child: Text(
                num == null ? '' : '$num',
                textAlign: TextAlign.right,
                style: mono.copyWith(color: palette.textFaint),
              ),
            ),
            SizedBox(
              width: 12,
              child: Text(
                isAdd ? '+' : (isDel ? '-' : ' '),
                style: mono.copyWith(
                  color: isAdd
                      ? palette.success
                      : (isDel ? palette.error : palette.textFaint),
                ),
              ),
            ),
            Expanded(
              child: Text(
                row.text.isEmpty ? ' ' : row.text,
                style: mono.copyWith(color: palette.textPrimary),
              ),
            ),
          ],
        ),
      );
    }
    // gap / more / meta：不参与红绿，灰字一行。
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      child: Text(row.text, style: mono.copyWith(color: palette.textFaint)),
    );
  }

  // ── Output section ────────────────────────────────────────────────

  Widget _outputSection(String output, AppPalette palette) {
    final truncated =
        output.length > 200 ? output.substring(0, 200) + '…' : output;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: double.infinity),
      child: Text(
        truncated,
        style: AppText.secondary.copyWith(
          color: palette.textPrimary.withValues(alpha: 0.75),
          height: 1.4,
          fontFamily: 'monospace',
        ),
        maxLines: 4,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }

  // ── Error section ─────────────────────────────────────────────────

  Widget _errorSection(String error, AppPalette palette) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.dense),
      margin: const EdgeInsets.only(top: 4),
      decoration: BoxDecoration(
        color: palette.error.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: Text(
        error.length > 200 ? '${error.substring(0, 200)}…' : error,
        style: AppText.secondary.copyWith(
          color: palette.error,
          height: 1.4,
        ),
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }

  // ── Running indicator ─────────────────────────────────────────────

  Widget _runningIndicator(AppPalette palette) {
    return Row(
      children: [
        SizedBox(
          width: 12,
          height: 12,
          child:
              CircularProgressIndicator(strokeWidth: 2, color: palette.primary),
        ),
        const SizedBox(width: AppSpacing.inner),
        Text(
          '执行中 · 第 ${data.index} 步',
          style: AppText.label.copyWith(color: palette.textSecondary),
        ),
      ],
    );
  }

  // ── Colors ────────────────────────────────────────────────────────

  Color _borderColor(AppPalette palette) {
    switch (data.state) {
      case ExecState.running:
        // 运行中是唯一实色描边 + 呼吸光晕的卡，其余态走状态色 35%。
        return palette.primary;
      case ExecState.success:
        return palette.success.withValues(alpha: 0.35);
      case ExecState.failed:
        return palette.error.withValues(alpha: 0.35);
      case ExecState.timeout:
        return palette.warning.withValues(alpha: 0.35);
      case ExecState.queued:
        return palette.stroke;
    }
  }

  Color _badgeColor(ExecState state, AppPalette palette) {
    switch (state) {
      case ExecState.success:
        return palette.success;
      case ExecState.failed:
        return palette.error;
      case ExecState.timeout:
        return palette.warning;
      case ExecState.running:
        return palette.primary;
      case ExecState.queued:
        return palette.textSecondary;
    }
  }
}

/// 运行态呼吸光晕：primary 0.18↔0.38，半程 [AppDuration.breathe]；
/// 系统减弱动效时停在中点，保留「运行中」的静态信号不闪动。
class _BreatheHalo extends StatefulWidget {
  const _BreatheHalo({required this.child});

  final Widget child;

  @override
  State<_BreatheHalo> createState() => _BreatheHaloState();
}

class _BreatheHaloState extends State<_BreatheHalo>
    with SingleTickerProviderStateMixin {
  late final AnimationController _breathe =
      AnimationController(vsync: this, duration: AppDuration.breathe);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduced = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (reduced) {
      _breathe.stop();
      _breathe.value = 0.5;
    } else if (!_breathe.isAnimating) {
      _breathe.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _breathe.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = AppCurves.loop.transform(_breathe.value);
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        boxShadow: AppShadows.breathe(t),
      ),
      child: widget.child,
    );
  }
}

/// A summary strip showing the overall execution progress.
/// Displays above the individual cards when multiple tools are running.
class ToolExecutionSummary extends StatelessWidget {
  final List<ToolCardData> cards;

  const ToolExecutionSummary({super.key, required this.cards});

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    if (cards.isEmpty) return const SizedBox.shrink();

    final total = cards.length;
    final done = cards.where((c) => c.isCompleted).length;
    final failed = cards.where((c) => c.state == ExecState.failed).length;
    final running = cards.any((c) => c.isRunning);

    final totalMs =
        cards.map((c) => c.durationMs ?? 0).fold<int>(0, (a, b) => a + b);

    // 底色随整体态势走，跟单卡（surface 底 + 状态描边）拉开层次。
    final Color tone = running
        ? palette.primary
        : failed > 0
            ? palette.error
            : palette.success;

    return AnimatedContainer(
      duration: AppDuration.micro,
      curve: AppCurves.standard,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.cardPadNarrow,
        vertical: AppSpacing.dense,
      ),
      margin: const EdgeInsets.only(bottom: AppSpacing.dense),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Row(
        children: [
          if (running)
            SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: palette.primary,
              ),
            )
          else
            Icon(
              failed > 0 ? Icons.error_outline : Icons.check_circle_outline,
              size: 14,
              color: tone,
            ),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Text(
              '工具执行 $done/$total${failed > 0 ? ' · $failed 失败' : ''}',
              style: AppText.secondary.copyWith(
                color: palette.textPrimary.withValues(alpha: 0.85),
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (!running && total > 0) ...[
            const SizedBox(width: AppSpacing.dense),
            Text(
              '${totalMs ~/ 1000}.${(totalMs % 1000) ~/ 100}s',
              style: AppText.micro.copyWith(color: palette.textFaint),
            ),
          ],
        ],
      ),
    );
  }
}
