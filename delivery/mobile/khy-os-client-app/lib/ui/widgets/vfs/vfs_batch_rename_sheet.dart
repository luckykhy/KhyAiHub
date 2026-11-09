// 批量重命名面板：规则 → 预览 → 执行。
//
// 面板的核心是**预览表**：规则一改就重算，改了什么、哪些会冲突、哪些不能执行，
// 全部摆在用户眼前。执行时只跑用户勾选且状态为「可执行」的项。
//
// 为什么不给「一键全改」：批量重命名是不可逆的，且目标名一旦写下去，
// 用户很难知道自己原来叫什么。预览 + 逐项勾选是这里唯一稳妥的形态。

import 'package:flutter/material.dart';

import '../../../core/vfs/batch_rename.dart';
import '../../../core/vfs/vfs_node.dart';
import '../../../core/vfs/vfs_service.dart';
import '../../theme/design_tokens.dart';

/// 批量重命名面板。
class VfsBatchRenameSheet extends StatefulWidget {
  /// 参与重命名的条目。
  final List<VfsNode> nodes;

  /// 所在目录已有的文件名（用于冲突预检）。
  final Set<String> existingNames;

  /// 执行回调：被勾选且可执行的条目。
  final ValueChanged<List<RenamePlanItem>> onApply;

  const VfsBatchRenameSheet({
    super.key,
    required this.nodes,
    required this.existingNames,
    required this.onApply,
  });

  /// 弹出面板。
  static Future<void> show(
    BuildContext context, {
    required List<VfsNode> nodes,
    required Set<String> existingNames,
    required ValueChanged<List<RenamePlanItem>> onApply,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext sheetContext) => VfsBatchRenameSheet(
        nodes: nodes,
        existingNames: existingNames,
        onApply: onApply,
      ),
    );
  }

  @override
  State<VfsBatchRenameSheet> createState() => _VfsBatchRenameSheetState();
}

class _VfsBatchRenameSheetState extends State<VfsBatchRenameSheet> {
  RenameRule _rule = const RenameRule();
  final Set<String> _selected = <String>{};
  List<RenamePlanItem> _items = const <RenamePlanItem>[];
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _recompute();
  }

  void _recompute() {
    final items = BatchRenamePlanner.plan(
      widget.nodes,
      _rule,
      existingNames: widget.existingNames,
    );
    setState(() {
      _items = items;
      // 默认勾上全部「可执行」项：有问题的项不勾，让用户先看见问题。
      _selected
        ..clear()
        ..addAll(items.where((RenamePlanItem item) => item.executable).map(
              (RenamePlanItem item) => item.source.path,
            ));
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);

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
                Icon(Icons.drive_file_rename_outline,
                    size: 18, color: palette.primary),
                const SizedBox(width: AppSpacing.inner),
                Expanded(
                  child: Text(
                    '批量重命名（${widget.nodes.length} 项）',
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
            const SizedBox(height: AppSpacing.cardGap),
            _ruleEditor(context),
            const SizedBox(height: AppSpacing.cardGap),
            _preview(context),
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
                    onPressed: _selected.isEmpty || _busy ? null : _apply,
                    child: Text('重命名 ${_selected.length} 项'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _ruleEditor(BuildContext context) {
    final palette = AppPalette.of(context);

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
          Row(
            children: <Widget>[
              _modeChip(context, RenameMode.template, '模板'),
              const SizedBox(width: AppSpacing.dense),
              _modeChip(context, RenameMode.regex, '正则'),
            ],
          ),
          const SizedBox(height: AppSpacing.cardGap),
          if (_rule.mode == RenameMode.template) ...<Widget>[
            _field(
              context,
              label: '模板',
              value: _rule.template,
              hint: '例：{name}_{n} 或 {date:yyyyMMdd}_{n}',
              onChanged: (String value) {
                setState(() => _rule = _rule.copyWith(template: value));
                _recompute();
              },
            ),
            Row(
              children: <Widget>[
                Expanded(
                  child: _numberField(
                    context,
                    label: '起始序号',
                    value: _rule.startIndex,
                    onChanged: (int value) {
                      setState(() => _rule = _rule.copyWith(startIndex: value));
                      _recompute();
                    },
                  ),
                ),
                const SizedBox(width: AppSpacing.cardGap),
                Expanded(
                  child: _numberField(
                    context,
                    label: '步长',
                    value: _rule.step,
                    onChanged: (int value) {
                      setState(() => _rule = _rule.copyWith(step: value));
                      _recompute();
                    },
                  ),
                ),
              ],
            ),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              value: _rule.keepExtension,
              onChanged: (bool value) {
                setState(() => _rule = _rule.copyWith(keepExtension: value));
                _recompute();
              },
              title: Text(
                '保留原扩展名',
                style: AppText.body.copyWith(color: palette.textPrimary),
              ),
            ),
          ] else ...<Widget>[
            _field(
              context,
              label: '查找',
              value: _rule.search,
              hint: '正则表达式',
              onChanged: (String value) {
                setState(() => _rule = _rule.copyWith(search: value));
                _recompute();
              },
            ),
            _field(
              context,
              label: '替换为',
              value: _rule.replace,
              hint: r'例：Photo_$1',
              onChanged: (String value) {
                setState(() => _rule = _rule.copyWith(replace: value));
                _recompute();
              },
            ),
          ],
        ],
      ),
    );
  }

  Widget _modeChip(BuildContext context, RenameMode mode, String label) {
    final palette = AppPalette.of(context);
    final active = _rule.mode == mode;
    return ChoiceChip(
      label: Text(label),
      selected: active,
      onSelected: (_) {
        setState(() => _rule = _rule.copyWith(mode: mode));
        _recompute();
      },
      selectedColor: palette.primary,
    );
  }

  Widget _field(
    BuildContext context, {
    required String label,
    required String value,
    required String hint,
    required ValueChanged<String> onChanged,
  }) {
    final palette = AppPalette.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.cardGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label,
            style: AppText.micro.copyWith(color: palette.textFaint),
          ),
          const SizedBox(height: 4),
          TextField(
            controller: TextEditingController(text: value)
              ..selection = TextSelection(
                baseOffset: 0,
                extentOffset: value.length,
              ),
            style: AppText.body.copyWith(color: palette.textPrimary),
            decoration: InputDecoration(
              isDense: true,
              hintText: hint,
              hintStyle: AppText.body.copyWith(color: palette.textFaint),
              filled: true,
              fillColor: palette.surface,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.cardPad,
                vertical: AppSpacing.dense,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: BorderSide(color: palette.stroke),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: BorderSide(color: palette.stroke),
              ),
            ),
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }

  Widget _numberField(
    BuildContext context, {
    required String label,
    required int value,
    required ValueChanged<int> onChanged,
  }) {
    final palette = AppPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(label, style: AppText.micro.copyWith(color: palette.textFaint)),
        const SizedBox(height: 4),
        TextFormField(
          initialValue: '$value',
          keyboardType: TextInputType.number,
          style: AppText.body.copyWith(color: palette.textPrimary),
          decoration: InputDecoration(
            isDense: true,
            filled: true,
            fillColor: palette.surface,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.cardPad,
              vertical: AppSpacing.dense,
            ),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: BorderSide(color: palette.stroke),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: BorderSide(color: palette.stroke),
            ),
          ),
          onChanged: (String text) {
            final parsed = int.tryParse(text.trim());
            if (parsed != null) onChanged(parsed);
          },
        ),
      ],
    );
  }

  Widget _preview(BuildContext context) {
    final palette = AppPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          '预览',
          style: AppText.label.copyWith(color: palette.textSecondary),
        ),
        const SizedBox(height: AppSpacing.dense),
        for (final item in _items)
          _previewRow(context, item),
      ],
    );
  }

  Widget _previewRow(BuildContext context, RenamePlanItem item) {
    final palette = AppPalette.of(context);
    final selected = _selected.contains(item.source.path);
    final statusColor = switch (item.status) {
      RenameItemStatus.ok => palette.success,
      RenameItemStatus.unchanged => palette.textFaint,
      _ => palette.warning,
    };

    return InkWell(
      onTap: () {
        if (!item.executable) return;
        setState(() {
          if (!_selected.remove(item.source.path)) {
            _selected.add(item.source.path);
          }
        });
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.dense),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Icon(
              selected ? Icons.check_box : Icons.check_box_outline_blank,
              size: 20,
              color: selected ? palette.primary : palette.textFaint,
            ),
            const SizedBox(width: AppSpacing.inner),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    item.sourceName,
                    style: AppText.body.copyWith(color: palette.textSecondary),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '→ ${item.targetName}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.body.copyWith(
                      color: item.executable
                          ? palette.textPrimary
                          : palette.textFaint,
                    ),
                  ),
                  if (item.reason.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 2),
                    Text(
                      item.reason,
                      style: AppText.micro.copyWith(color: statusColor),
                    ),
                  ],
                ],
              ),
            ),
            Text(
              item.status.label,
              style: AppText.micro.copyWith(color: statusColor),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _apply() async {
    final targets = _items
        .where((RenamePlanItem item) => _selected.contains(item.source.path))
        .toList();
    if (targets.isEmpty) return;
    setState(() => _busy = true);

    var done = 0;
    var failed = 0;
    for (final item in targets) {
      try {
        await VfsService.instance.rename(item.source.path, item.targetPath);
        done++;
      } catch (_) {
        failed++;
      }
    }
    if (!mounted) return;
    setState(() => _busy = false);
    widget.onApply(targets);
    // 失败项要单独说出来：只报「成功 N 项」会让人以为全部改完了。
    // 提示先弹后关——关掉之后这个 context 就不再有 ScaffoldMessenger 可用了。
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(failed > 0 ? '成功 $done 项，失败 $failed 项' : '成功 $done 项'),
      ),
    );
    Navigator.of(context).maybePop();
  }
}
