// AI 助手面板：上下文 + 指令 → 操作计划 → 执行。
//
// 这是「AI + 人工双模」的界面落点。三条硬规则在这一张面板上兑现：
//   1. AI 只产计划——**生成**与**执行**是两次动作，AI 自己不会落笔；
//   2. 逐项确认——高危项默认**不勾选**，用户要自己勾；
//   3. 手动等价——每一项都能在长按菜单里手动做，AI 只是省了手速。
//
// 反馈方式是**双模**的（目标里写明的「双模态反馈与确认机制」）：
//   - 简单操作（单文件重命名、建目录这类低风险项）：点一次「直接执行」就落笔，
//     结果用 toast 告诉用户。这类操作没有争议，逐条弹确认只是噪声。
//   - 复杂/高危操作：出清单、逐项勾选，「执行选中的 N 项」，高危默认不勾。
//   两种模式下计划清单都先摆给人看——人始终看得见 AI 打算做什么。
//
// 另外一条次要但重要的规则：被拒绝的项要**显示出来**。用户需要知道 AI 提了什么、
// 为什么没执行——「AI 悄悄少做了一件事」比「AI 明确说这条被拦了」更让人不放心。

import 'package:flutter/material.dart';

import '../../../core/vfs/ai_plan.dart';
import '../../../core/vfs/ai_plan_generator.dart';
import '../../../core/vfs/vfs_context.dart';
import '../../../core/vfs/vfs_service.dart';
import '../../theme/app_colors.dart';
import '../../theme/design_tokens.dart';

/// AI 面板。
class VfsAiSheet extends StatefulWidget {
  final VfsContext context;

  /// 操作落地用的执行器。**默认 null = 走真实的 VFS 通道**。
  ///
  /// 为什么留这个口子：面板要能测「点一下有没有结果」，而真实路径会落到审计落盘
  /// （真实文件 I/O）——widget 测试跑在 fake async 里，真实文件 I/O 不推进，
  /// 于是执行永远不返回、进度圈永远转、测试只能等到超时。那不是被测行为，是测试
  /// 环境不对。注入执行器让测试只盯**面板的接线**；生产路径是否仍然打到 VFS
  /// 通道，由 [AiPlanExecutor] 的默认路径用例单独守住。
  final AiOperationRunner? runner;

  const VfsAiSheet({
    super.key,
    required this.context,
    this.runner,
  });

  /// 弹出面板。返回执行结果（没执行过则返回 null）。
  ///
  /// 为什么用返回值而不是回调：反馈（toast）要在**面板关闭之后**弹，否则它会被
  /// 面板本身挡住；而回调是在面板还开着的时候触发的。真机上就撞过这个：面板里
  /// 弹一次、调用方再弹一次，两个 toast 互相顶掉，最后露出的是没有来源标记的那条。
  static Future<AiPlanResult?> show(
    BuildContext context, {
    required VfsContext vfsContext,
  }) {
    return showModalBottomSheet<AiPlanResult>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext sheetContext) => VfsAiSheet(
        context: vfsContext,
      ),
    );
  }

  @override
  State<VfsAiSheet> createState() => _VfsAiSheetState();
}

class _VfsAiSheetState extends State<VfsAiSheet> {
  final TextEditingController _instruction = TextEditingController();
  final Set<String> _selected = <String>{};

  /// 已经**单条执行过**的操作（id → 结果）。
  ///
  /// 为什么记着：用户可能先单独跑了第 1 项，再回头批量执行剩下的——批量时不能把
  /// 第 1 项再跑一遍（复制两遍、删两次）。所以批量要跳过已经跑过的。
  final Map<String, AiStepResult> _stepResults = <String, AiStepResult>{};
  final Set<String> _executed = <String>{};

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
                  borderRadius: BorderRadius.circular(AppRadius.medium),
                  borderSide: BorderSide(color: palette.stroke),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppRadius.medium),
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
      // 空路径时省掉这一行，与 toPrompt 同口径：没有当前路径就别告诉用户
      // （和模型）有一个。默认值就是空串，不是 '/'。
      if (widget.context.currentPath.isNotEmpty)
        '当前路径：${widget.context.currentPath}',
      if (widget.context.hasSelection)
        '已选 ${widget.context.selectedPaths.length} 项',
    ];
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surfaceHigh,
        borderRadius: BorderRadius.circular(AppRadius.small),
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
          borderRadius: BorderRadius.circular(AppRadius.small),
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
                child: Text(
                  // 双模态反馈：全是低风险项时给「直接执行」——点一下就落笔，
                  // 结果用 toast 告诉用户；只要有一项需要人逐项点头，就必须
                  // 走「执行选中的 N 项」，让人看得见自己批准了什么。
                  //
                  // 数字取**还没跑过**的项数：已经单条执行过的项会被跳过，
                  // 按钮上再写上总数就是在骗人。
                  plan.allLowRisk
                      ? '直接执行 ${_selected.difference(_executed).length} 项'
                      : '执行选中的 ${_selected.difference(_executed).length} 项',
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.dense),
        Text(
          plan.allLowRisk
              ? '都是低风险操作，点「直接执行」即可；每一步也都能在长按菜单里手动做。'
              : '每一步都能在文件管理器的长按菜单里手动执行；AI 只是替你把手速省下来。',
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
    final result = _stepResults[op.id];

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
                          borderRadius: BorderRadius.circular(AppRadius.small),
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
                  // 单条执行的结果就地显示：逐步执行要看得见每一步发生了什么。
                  if (result != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        result.ok ? '已执行' : '执行失败：${result.message}',
                        style: AppText.micro.copyWith(
                          color: result.ok ? palette.success : palette.error,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            // 「改」与「只执行这一条」：AI 的清单要能改、能一条一条来
            // （目标 §四：「均可编辑、拆解、逐步执行，不强制黑盒运行」）。
            IconButton(
              tooltip: '改这一项',
              onPressed: _busy ? null : () => _editOperation(op),
              icon: const Icon(Icons.edit_outlined, size: 16),
              color: palette.textSecondary,
            ),
            IconButton(
              tooltip: '只执行这一条',
              onPressed: _busy ? null : () => _runOne(op),
              icon: const Icon(Icons.play_arrow_outlined, size: 18),
              color: palette.primary,
            ),
          ],
        ),
      ),
    );
  }

  /// 改一项。
  ///
  /// 校验在对话框里做，失败就地把理由摆出来——改了没保存又不说为什么，用户只会
  /// 以为功能坏了。
  Future<void> _editOperation(AiOperation op) async {
    final plan = _plan;
    if (plan == null) return;
    final edited = await showDialog<AiOperationPlan>(
      context: context,
      builder: (BuildContext dialogContext) => _EditOperationDialog(
        plan: plan,
        operation: op,
      ),
    );
    if (!mounted || edited == null) return;
    setState(() {
      _plan = edited;
      // 改过的那一项**旧结果作废**：它现在是另一个操作了，之前那次的成败跟它无关。
      // 不清掉的话，界面会拿上一条的结果给改完的这一项背书——那是撒谎。
      _stepResults.remove(op.id);
      _executed.remove(op.id);
    });
  }

  /// 只执行这一条。
  ///
  /// 「逐步执行」：一次一条，结果就地显示，用户看着上一条的结果决定要不要继续。
  Future<void> _runOne(AiOperation op) async {
    setState(() => _busy = true);
    final result = await AiPlanExecutor.executeOne(op, runner: widget.runner);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _stepResults[op.id] = result;
      if (result.ok) _executed.add(op.id);
    });
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
    // 已经单条跑过的项不再跑一遍——复制两遍、删两次都是用户不愿意看到的结果。
    final pending = _selected.difference(_executed);
    if (pending.isEmpty) {
      Navigator.of(context).pop(AiPlanResult(_stepResults.values.toList()));
      return;
    }
    setState(() => _busy = true);
    final result = await AiPlanExecutor.execute(
      plan,
      selectedIds: pending,
      runner: widget.runner,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      for (final step in result.steps) {
        _stepResults[step.operationId] = step;
        if (step.ok) _executed.add(step.operationId);
      }
    });
    // 弹回去的结果要把**单条执行**过的那几条也算进去：调用方只弹一次提示，
    // 那一句话要覆盖这一轮的全部动作。
    Navigator.of(context).pop(AiPlanResult(_stepResults.values.toList()));
  }
}

/// 「改这一项」对话框。
///
/// 为什么单独一个 widget：控制器由**它自己**拥有、自己销毁。
/// 在 `showDialog` 返回后立刻 dispose 控制器是不行的——对话框的退场动画还在，
/// 那期间 TextField 还会重建一次，于是它摸到一个已销毁的控制器（真机上就是
/// 「保存完这一项，应用当场崩一下」）。这是 widget 测试替我抓出来的。
class _EditOperationDialog extends StatefulWidget {
  final AiOperationPlan plan;
  final AiOperation operation;

  const _EditOperationDialog({
    required this.plan,
    required this.operation,
  });

  @override
  State<_EditOperationDialog> createState() => _EditOperationDialogState();
}

class _EditOperationDialogState extends State<_EditOperationDialog> {
  late final TextEditingController _source;
  late final TextEditingController _target;
  late final TextEditingController _pattern;
  String? _error;

  @override
  void initState() {
    super.initState();
    final op = widget.operation;
    _source = TextEditingController(text: op.sourcePath);
    _target = TextEditingController(text: op.targetPath);
    _pattern = TextEditingController(text: op.pattern);
  }

  @override
  void dispose() {
    _source.dispose();
    _target.dispose();
    _pattern.dispose();
    super.dispose();
  }

  bool get _isSearch => widget.operation.kind == AiOpKind.search;

  bool get _isRename => widget.operation.kind == AiOpKind.rename;

  bool get _hasSource => !_isSearch;

  bool get _hasTarget =>
      widget.operation.kind == AiOpKind.copy ||
      widget.operation.kind == AiOpKind.move ||
      _isRename;

  void _save() {
    final edited = AiPlanEditor.edit(
      widget.plan,
      widget.operation.id,
      sourcePath: _hasSource ? _source.text : null,
      targetPath: _hasTarget ? _target.text : null,
      pattern: _isSearch ? _pattern.text : null,
    );
    if (!edited.ok) {
      // 校验没过就**留在对话框里**，把理由摆出来——关掉再让人重开是添乱。
      setState(() => _error = edited.error);
      return;
    }
    Navigator.of(context).pop(edited.plan);
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return AlertDialog(
      title: const Text('改这一项'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (_hasSource)
            TextField(
              controller: _source,
              style: AppText.body.copyWith(color: palette.textPrimary),
              decoration: InputDecoration(
                labelText: _isRename ? '源路径' : '路径',
              ),
            ),
          if (_hasTarget)
            TextField(
              controller: _target,
              style: AppText.body.copyWith(color: palette.textPrimary),
              decoration: InputDecoration(
                labelText: _isRename ? '新名字' : '目标路径',
              ),
            ),
          if (_isSearch)
            TextField(
              controller: _pattern,
              style: AppText.body.copyWith(color: palette.textPrimary),
              decoration: const InputDecoration(labelText: '匹配条件'),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.dense),
              child: Text(
                _error!,
                style: AppText.micro.copyWith(color: palette.error),
              ),
            ),
        ],
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _save,
          child: const Text('保存'),
        ),
      ],
    );
  }
}
