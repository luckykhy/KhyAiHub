// AI 助手面板：上下文 + 指令 → 操作计划 → 逐项确认 → 执行。
//
// 这是「AI + 人工双模」的界面落点。三条硬规则在这一张面板上兑现：
//   1. AI 只产计划——面板里没有「AI 直接改文件」的按钮，只有「生成计划」；
//   2. 逐项确认——高危项默认**不勾选**，用户要自己勾；
//   3. 手动等价——每一项都能在长按菜单里手动做，AI 只是省了手速。
//
// 另外一条次要但重要的规则：被拒绝的项要**显示出来**。用户需要知道 AI 提了什么、
// 为什么没执行——「AI 悄悄少做了一件事」比「AI 明确说这条被拦了」更让人不放心。

import 'package:flutter/material.dart';

import '../../../core/vfs/ai_plan.dart';
import '../../../core/vfs/ai_plan_generator.dart';
import '../../../core/vfs/vfs_context.dart';
import '../../../core/vfs/vfs_service.dart';
import '../../theme/design_tokens.dart';

/// AI 面板。
class VfsAiSheet extends StatefulWidget {
  final VfsContext context;

  /// 执行结束回调（参数是执行结果）。
  final ValueChanged<AiPlanResult> onExecuted;

  const VfsAiSheet({
    super.key,
    required this.context,
    required this.onExecuted,
  });

  /// 弹出面板。
  static Future<void> show(
    BuildContext context, {
    required VfsContext vfsContext,
    required ValueChanged<AiPlanResult> onExecuted,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext sheetContext) => VfsAiSheet(
        context: vfsContext,
        onExecuted: onExecuted,
      ),
    );
  }

  @override
  State<VfsAiSheet> createState() => _VfsAiSheetState();
}

class _VfsAiSheetState extends State<VfsAiSheet> {
  final TextEditingController _instruction = TextEditingController();
  final Set<String> _selected = <String>{};

  AiOperationPlan? _plan;
  bool _busy = false;
  String? _message;

  /// 只用本地规则解析（完全不联网）。
  bool _offline = false;

  @override
  void dispose() {
    _instruction.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final policy = VfsService.instance.policy;

    if (!policy.aiLevel.showsAssistant) {
      return Padding(
        padding: const EdgeInsets.all(AppSpacing.page),
        child: Text(
          'AI 辅助已关闭。文件管理器的全部功能仍然可用。',
          style: AppText.body.copyWith(color: palette.textSecondary),
        ),
      );
    }

    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.page,
        right: AppSpacing.page,
        top: AppSpacing.page,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.page,
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.auto_awesome, size: 18, color: palette.primary),
                const SizedBox(width: AppSpacing.inner),
                Expanded(
                  child: Text(
                    'AI 助手',
                    style:
                        AppText.title.copyWith(color: palette.textPrimary),
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                  icon: const Icon(Icons.close, size: 18),
                  color: palette.textSecondary,
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.dense),
            _contextCard(context),
            const SizedBox(height: AppSpacing.cardGap),
            TextField(
              controller: _instruction,
              minLines: 1,
              maxLines: 3,
              style: AppText.body.copyWith(color: palette.textPrimary),
              decoration: InputDecoration(
                hintText: '例如：把上周下载的 PDF 全部移到 Documents/Work',
                hintStyle: AppText.body.copyWith(color: palette.textFaint),
                filled: true,
                fillColor: palette.surfaceHigh,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide(color: palette.stroke),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide(color: palette.stroke),
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.cardGap),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              value: _offline,
              onChanged: (bool value) => setState(() => _offline = value),
              title: Text(
                '只用本地解析（不联网）',
                style: AppText.body.copyWith(color: palette.textPrimary),
              ),
              subtitle: Text(
                _offline
                    ? '不调用模型，只认「移动/复制/删除/重命名/新建目录/搜索」这几种说法'
                    : '调用已配置的模型；调不通时自动落到本地规则',
                style: AppText.micro.copyWith(color: palette.textFaint),
              ),
            ),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _busy ? null : _generate,
                icon: _busy
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.auto_awesome, size: 16),
                label: Text(_busy ? '正在生成计划' : '生成操作计划'),
              ),
            ),
            if (_message != null) ...<Widget>[
              const SizedBox(height: AppSpacing.cardGap),
              Text(
                _message!,
                style: AppText.secondary.copyWith(color: palette.warning),
              ),
            ],
            if (_plan != null) ...<Widget>[
              const SizedBox(height: AppSpacing.section),
              _planCard(context),
            ],
          ],
        ),
      ),
    );
  }

  Widget _contextCard(BuildContext context) {
    final palette = AppPalette.of(context);
    final lines = <String>[
      '当前路径：${widget.context.currentPath}',
      if (widget.context.hasSelection)
        '已选 ${widget.context.selectedPaths.length} 项',
    ];
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surfaceHigh,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: palette.stroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          for (final line in lines)
            Text(
              line,
              style: AppText.micro.copyWith(color: palette.textSecondary),
            ),
        ],
      ),
    );
  }

  Widget _planCard(BuildContext context) {
    final palette = AppPalette.of(context);
    final plan = _plan!;

    if (plan.operations.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
        decoration: BoxDecoration(
          color: palette.surfaceHigh,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: palette.stroke),
        ),
        child: Text(
          plan.summary.isEmpty ? '没有可执行的操作' : plan.summary,
          style: AppText.body.copyWith(color: palette.textSecondary),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          plan.summary.isEmpty ? '操作计划' : plan.summary,
          style: AppText.cardTitle.copyWith(color: palette.textPrimary),
        ),
        const SizedBox(height: AppSpacing.dense),
        for (final op in plan.operations)
          _operationRow(context, op),
        if (plan.rejected.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.cardGap),
          Text(
            '被拦下的 ${plan.rejected.length} 项',
            style: AppText.label.copyWith(color: palette.warning),
          ),
          const SizedBox(height: AppSpacing.dense),
          for (final rejected in plan.rejected)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                '${rejected.reason}：${rejected.raw}',
                style: AppText.micro.copyWith(color: palette.textFaint),
              ),
            ),
        ],
        const SizedBox(height: AppSpacing.cardGap),
        Row(
          children: <Widget>[
            Expanded(
              child: OutlinedButton(
                onPressed: () => Navigator.of(context).maybePop(),
                child: const Text('取消'),
              ),
            ),
            const SizedBox(width: AppSpacing.cardGap),
            Expanded(
              child: FilledButton(
                onPressed: _selected.isEmpty ? null : _execute,
                child: Text('执行选中的 ${_selected.length} 项'),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.dense),
        Text(
          '每一步都能在文件管理器的长按菜单里手动执行；AI 只是替你把手速省下来。',
          style: AppText.micro.copyWith(color: palette.textFaint),
        ),
      ],
    );
  }

  Widget _operationRow(BuildContext context, AiOperation op) {
    final palette = AppPalette.of(context);
    final riskColor = switch (op.risk) {
      AiRisk.safe => palette.success,
      AiRisk.caution => palette.warning,
      AiRisk.destructive => palette.error,
    };

    return InkWell(
      onTap: () => setState(() {
        if (!_selected.remove(op.id)) _selected.add(op.id);
      }),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.dense),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Icon(
              _selected.contains(op.id)
                  ? Icons.check_box
                  : Icons.check_box_outline_blank,
              size: 20,
              color: _selected.contains(op.id)
                  ? palette.primary
                  : palette.textFaint,
            ),
            const SizedBox(width: AppSpacing.inner),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    op.title,
                    style: AppText.body.copyWith(color: palette.textPrimary),
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: <Widget>[
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.dense,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: riskColor.withValues(alpha: 0.16),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          op.risk.label,
                          style: AppText.micro.copyWith(color: riskColor),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.dense),
                      Expanded(
                        child: Text(
                          op.kind.label,
                          style:
                              AppText.micro.copyWith(color: palette.textFaint),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _generate() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    final plan = await AiPlanGenerator.generate(
      instruction: _instruction.text,
      context: widget.context,
      offline: _offline,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      _plan = plan;
      _selected.clear();
      // 低风险项默认勾上；高危项默认不勾——「逐项确认」要真的逐项。
      for (final op in plan.operations) {
        if (op.risk == AiRisk.safe) _selected.add(op.id);
      }
      if (plan.operations.isEmpty && plan.rejected.isNotEmpty) {
        _message = plan.summary;
      }
    });
  }

  Future<void> _execute() async {
    final plan = _plan;
    if (plan == null) return;
    setState(() => _busy = true);
    final result = await AiPlanExecutor.execute(
      plan,
      selectedIds: _selected,
    );
    if (!mounted) return;
    setState(() => _busy = false);
    widget.onExecuted(result);
    if (mounted) Navigator.of(context).maybePop();
  }
}
