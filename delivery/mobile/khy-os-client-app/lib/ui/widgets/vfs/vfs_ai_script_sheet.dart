// AI 生成脚本面板：描述需求 → 看脚本 → 存到指定位置。
//
// 流程的每一步都对应目标里的一句话：
//   - 「用户在对话框描述需求」→ 输入框；
//   - 「AI 输出脚本代码」→ 展开成可读的步骤列表（不是一堆 JSON）；
//   - 「用户确认后保存到指定位置」→ 选目录，存成 JSON 文件。
//
// 存成**文件**而不是只存进 App 内部：用户要能看见它、能改它、能拷走它。
// 脚本是用户的东西，不该锁在 App 的私有目录里。

import 'package:flutter/material.dart';

import '../../../core/vfs/ai_script_generator.dart';
import '../../../core/vfs/automation_script.dart';
import '../../../core/vfs/vfs_context.dart';
import '../../../core/vfs/vfs_route.dart';
import '../../../core/vfs/vfs_service.dart';
import '../../theme/design_tokens.dart';
import 'vfs_folder_picker.dart';

/// AI 生成脚本面板。
class VfsAiScriptSheet extends StatefulWidget {
  final VfsContext context;

  /// 保存完成回调（脚本与文件路径）。
  final ValueChanged<AutomationScript> onSaved;

  const VfsAiScriptSheet({
    super.key,
    required this.context,
    required this.onSaved,
  });

  /// 弹出面板。
  static Future<void> show(
    BuildContext context, {
    required VfsContext vfsContext,
    required ValueChanged<AutomationScript> onSaved,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext sheetContext) => VfsAiScriptSheet(
        context: vfsContext,
        onSaved: onSaved,
      ),
    );
  }

  @override
  State<VfsAiScriptSheet> createState() => _VfsAiScriptSheetState();
}

class _VfsAiScriptSheetState extends State<VfsAiScriptSheet> {
  final TextEditingController _requirement = TextEditingController();
  AiGeneratedScript? _result;
  bool _busy = false;

  @override
  void dispose() {
    _requirement.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final result = _result;

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
                    'AI 生成脚本',
                    style: AppText.title.copyWith(color: palette.textPrimary),
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
            TextField(
              controller: _requirement,
              minLines: 2,
              maxLines: 4,
              style: AppText.body.copyWith(color: palette.textPrimary),
              decoration: InputDecoration(
                hintText: '例如：把 Downloads 里的 apk 复制到 Safe 目录',
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
                label: Text(_busy ? '正在生成' : '生成脚本'),
              ),
            ),
            if (result != null) ...<Widget>[
              const SizedBox(height: AppSpacing.cardGap),
              if (result.error != null)
                Text(
                  result.error ?? '',
                  style: AppText.body.copyWith(color: palette.warning),
                )
              else
                _scriptPreview(context, result.script!),
            ],
          ],
        ),
      ),
    );
  }

  Widget _scriptPreview(BuildContext context, AutomationScript script) {
    final palette = AppPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          script.name,
          style: AppText.cardTitle.copyWith(color: palette.textPrimary),
        ),
        const SizedBox(height: 4),
        Text(
          '${script.trigger.label} · ${script.steps.length} 步',
          style: AppText.micro.copyWith(color: palette.textFaint),
        ),
        const SizedBox(height: AppSpacing.cardGap),
        Container(
          padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
          decoration: BoxDecoration(
            color: palette.surfaceHigh,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: palette.stroke),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              for (final step in script.steps)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(
                    '· ${step.description}',
                    style: AppText.micro.copyWith(color: palette.textSecondary),
                  ),
                ),
            ],
          ),
        ),
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
                onPressed: _save,
                child: const Text('保存脚本…'),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Future<void> _generate() async {
    setState(() => _busy = true);
    final result = await AiScriptGenerator.generate(
      requirement: _requirement.text,
      context: widget.context,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      _result = result;
    });
  }

  /// 保存：选目录 → 写成 JSON 文件 → 同时登记进脚本列表。
  Future<void> _save() async {
    final script = _result?.script;
    if (script == null) return;

    final dir = await VfsFolderPicker.pick(
      context,
      initialPath: VfsRoots.storage,
      title: '脚本保存到',
    );
    if (!mounted || dir == null || dir.isEmpty) return;

    final fileName = '${_safeName(script.name)}.json';
    final path = VfsPath.join(dir, fileName);
    try {
      await VfsService.instance.write(
        path,
        AutomationScriptStore.export(script),
      );
      final existing = await AutomationScriptStore.load();
      await AutomationScriptStore.saveAll(<AutomationScript>[
        ...existing.where((AutomationScript s) => s.id != script.id),
        script,
      ]);
      if (!mounted) return;
      widget.onSaved(script);
      Navigator.of(context).maybePop();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('保存失败：$error')),
      );
    }
  }

  /// 文件名安全化：脚本名是用户或模型给的，可能带斜杠。
  static String _safeName(String raw) {
    final cleaned = raw.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_').trim();
    return cleaned.isEmpty ? 'script' : cleaned;
  }
}
