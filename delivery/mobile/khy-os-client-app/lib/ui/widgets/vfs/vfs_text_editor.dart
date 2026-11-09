// 轻量文本编辑器。
//
// 定位：**能改**的小编辑器，不是 IDE。它服务的是「改个配置、看个日志尾部、
// 补一句备注」这类操作——这些操作用系统记事本要切出去，用 IDE 太重。
//
// 三条边界写在这里：
//   1. 只处理文本；二进制文件不给开（界面上就不会出现「编辑」入口）。
//   2. 大文件不进编辑器（超过上限只读），因为把几 MB 文本塞进 TextField
//      会让输入卡成幻灯片。
//   3. 保存是**整文件覆写**，不是增量补丁——所以保存前会提示文件已被外部改动
//      （读入时的字节数与当前不一致），避免把别人刚写的改动抹掉。

import 'package:flutter/material.dart';

import '../../../core/vfs/vfs_node.dart';
import '../../../core/vfs/vfs_service.dart';
import '../../theme/design_tokens.dart';

/// 文本编辑器面板。
class VfsTextEditor extends StatefulWidget {
  final VfsNode node;

  /// 保存成功回调。
  final ValueChanged<String> onSaved;

  const VfsTextEditor({super.key, required this.node, required this.onSaved});

  /// 弹出编辑器。
  static Future<void> show(
    BuildContext context, {
    required VfsNode node,
    required ValueChanged<String> onSaved,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext sheetContext) => VfsTextEditor(
        node: node,
        onSaved: onSaved,
      ),
    );
  }

  @override
  State<VfsTextEditor> createState() => _VfsTextEditorState();
}

class _VfsTextEditorState extends State<VfsTextEditor> {
  final TextEditingController _controller = TextEditingController();

  String _original = '';
  bool _loading = true;
  bool _saving = false;
  bool _tooLarge = false;
  String? _error;

  /// 读入时的字节数——用来判断文件在编辑期间有没有被别处改过。
  int _loadedBytes = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final content = await VfsService.instance.read(
        widget.node.path,
        maxBytes: 512 * 1024,
      );
      if (!mounted) return;
      final text = content.text;
      setState(() {
        _original = text;
        _loadedBytes = widget.node.size;
        _tooLarge = content.truncated;
        _controller.text = text;
        _loading = false;
      });
    } on VfsException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final dirty = _controller.text != _original;

    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.page,
        right: AppSpacing.page,
        top: AppSpacing.page,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.page,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.edit_note, size: 18, color: palette.primary),
              const SizedBox(width: AppSpacing.inner),
              Expanded(
                child: Text(
                  widget.node.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.title.copyWith(color: palette.textPrimary),
                ),
              ),
              if (dirty)
                Text(
                  '未保存',
                  style: AppText.micro.copyWith(color: palette.warning),
                ),
              IconButton(
                onPressed: () => Navigator.of(context).maybePop(),
                icon: const Icon(Icons.close, size: 18),
                color: palette.textSecondary,
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          if (_loading)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.section),
              child: Center(
                child: SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: palette.primary,
                  ),
                ),
              ),
            )
          else if (_error != null)
            Text(
              _error!,
              style: AppText.body.copyWith(color: palette.error),
            )
          else if (_tooLarge)
            Text(
              '文件太大（超过 512KB），编辑器只打开了开头一部分。'
              '完整内容请用外部编辑器打开。',
              style: AppText.body.copyWith(color: palette.warning),
            )
          else
            Flexible(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 320),
                child: TextField(
                  controller: _controller,
                  maxLines: null,
                  expands: true,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 13,
                    height: 1.4,
                  ),
                  decoration: InputDecoration(
                    filled: true,
                    fillColor: palette.surfaceHigh,
                    contentPadding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                      borderSide: BorderSide(color: palette.stroke),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                      borderSide: BorderSide(color: palette.stroke),
                    ),
                  ),
                  onChanged: (_) => setState(() {}),
                ),
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
                  onPressed: (_loading || _error != null || _tooLarge || !dirty)
                      ? null
                      : _save,
                  child: Text(_saving ? '保存中' : '保存'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      // 覆写前先看一眼文件有没有被别人改过——大小变了就说明变了。
      final current = await VfsService.instance.stat(widget.node.path);
      if (!mounted) return;
      if (current != null && current.size != _loadedBytes) {
        final proceed = await showDialog<bool>(
          context: context,
          builder: (BuildContext dialogContext) => AlertDialog(
            title: const Text('文件已被改动'),
            content: const Text(
              '这个文件在你编辑期间被别处改动过。继续保存会覆盖那些改动。',
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(false),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(dialogContext).pop(true),
                child: const Text('仍然覆盖'),
              ),
            ],
          ),
        );
        if (proceed != true) {
          if (mounted) setState(() => _saving = false);
          return;
        }
      }

      await VfsService.instance.write(widget.node.path, _controller.text);
      if (!mounted) return;
      setState(() {
        _original = _controller.text;
        _saving = false;
      });
      widget.onSaved(widget.node.path);
      if (mounted) Navigator.of(context).maybePop();
    } catch (error) {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('保存失败：$error')),
      );
    }
  }
}
