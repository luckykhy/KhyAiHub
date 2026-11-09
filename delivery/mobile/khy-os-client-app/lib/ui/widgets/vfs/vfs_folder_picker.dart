// 目录选择器：在 VFS 里挑一个目标目录。
//
// 为什么不用「输入路径」：专业用户的目标目录往往是「上次那个」或「某个应用目录下的
// 某一级」——手打绝对路径既慢又容易打错，而挑错目录的代价是**文件被复制到别处**。
// 所以凡是「往哪儿放」的场景，都给一个能浏览的选择器，输入框只作为兜底。
//
// 选择器本身只列目录（不列文件）——这里要的是落点，不是选文件。

import 'package:flutter/material.dart';

import '../../../core/vfs/vfs_node.dart';
import '../../../core/vfs/vfs_route.dart';
import '../../../core/vfs/vfs_service.dart';
import '../../theme/design_tokens.dart';

/// 选择器的模式。
enum VfsPickMode {
  /// 选目录。
  folder,

  /// 选文件（目录仍可进入）。
  file,
}

/// 目录选择器。
class VfsFolderPicker extends StatefulWidget {
  /// 初始目录。
  final String initialPath;

  /// 标题。
  final String title;

  /// 模式：选目录还是选文件。
  final VfsPickMode mode;

  const VfsFolderPicker({
    super.key,
    required this.initialPath,
    this.title = '选择目标目录',
    this.mode = VfsPickMode.folder,
  });

  /// 弹出选择器。返回选中的目录绝对路径；取消返回 null。
  static Future<String?> pick(
    BuildContext context, {
    required String initialPath,
    String title = '选择目标目录',
    VfsPickMode mode = VfsPickMode.folder,
  }) async {
    return showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => Dialog(
        child: SizedBox(
          width: 420,
          height: 520,
          child: VfsFolderPicker(
            initialPath: initialPath,
            title: title,
            mode: mode,
          ),
        ),
      ),
    );
  }

  @override
  State<VfsFolderPicker> createState() => _VfsFolderPickerState();
}

class _VfsFolderPickerState extends State<VfsFolderPicker> {
  String _path = '/';
  List<VfsNode> _entries = const <VfsNode>[];
  bool _loading = true;
  String? _error;

  /// 选中的文件（文件模式下）。
  String? _selectedFile;

  @override
  void initState() {
    super.initState();
    _path = VfsPath.normalize(widget.initialPath);
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final listing = await VfsService.instance.list(_path);
      if (!mounted) return;
      setState(() {
        _entries = widget.mode == VfsPickMode.file
            ? listing.nodes
            : listing.nodes.where((VfsNode node) => node.isDirectory).toList();
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

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.page,
            AppSpacing.cardPad,
            AppSpacing.page,
            AppSpacing.dense,
          ),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  widget.title,
                  style: AppText.title.copyWith(color: palette.textPrimary),
                ),
              ),
              IconButton(
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(Icons.close, size: 18),
                color: palette.textSecondary,
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.page),
          child: Row(
            children: <Widget>[
              IconButton(
                onPressed: _path == '/' ? null : () => _go(VfsPath.parent(_path)),
                icon: const Icon(Icons.arrow_upward, size: 18),
                color: palette.textSecondary,
                tooltip: '上一级',
              ),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.cardPadNarrow,
                    vertical: AppSpacing.dense,
                  ),
                  decoration: BoxDecoration(
                    color: palette.surfaceHigh,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: palette.stroke),
                  ),
                  child: Text(
                    _path,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.secondary.copyWith(color: palette.textPrimary),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.dense),
        Expanded(
          child: _loading
              ? Center(
                  child: SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: palette.primary,
                    ),
                  ),
                )
              : _error != null
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(AppSpacing.page),
                        child: Text(
                          _error!,
                          textAlign: TextAlign.center,
                          style:
                              AppText.body.copyWith(color: palette.warning),
                        ),
                      ),
                    )
                  : _entries.isEmpty
                      ? Center(
                          child: Text(
                            '这里没有子目录',
                            style:
                                AppText.body.copyWith(color: palette.textFaint),
                          ),
                        )
                      : ListView.builder(
                          itemCount: _entries.length,
                          itemBuilder: (BuildContext context, int index) {
                            final node = _entries[index];
                            final selected = node.path == _selectedFile;
                            return ListTile(
                              dense: true,
                              selected: selected,
                              selectedTileColor: palette.surfaceHigh,
                              leading: Icon(
                                node.isDirectory
                                    ? Icons.folder_outlined
                                    : Icons.insert_drive_file_outlined,
                                size: 20,
                                color: node.isDirectory
                                    ? palette.primary
                                    : palette.textSecondary,
                              ),
                              title: Text(
                                node.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppText.body
                                    .copyWith(color: palette.textPrimary),
                              ),
                              onTap: () {
                                if (node.isDirectory) {
                                  _go(node.path);
                                  return;
                                }
                                // 文件模式下点文件即选中；目录模式下点文件无效。
                                if (widget.mode == VfsPickMode.file) {
                                  setState(() => _selectedFile = node.path);
                                }
                              },
                            );
                          },
                        ),
        ),
        Padding(
          padding: const EdgeInsets.all(AppSpacing.page),
          child: Row(
            children: <Widget>[
              OutlinedButton.icon(
                onPressed: _createFolder,
                icon: const Icon(Icons.create_new_folder_outlined, size: 16),
                label: const Text('新建目录'),
              ),
              const SizedBox(width: AppSpacing.cardGap),
              Expanded(
                child: OutlinedButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('取消'),
                ),
              ),
              const SizedBox(width: AppSpacing.cardGap),
              Expanded(
                child: FilledButton(
                  onPressed: () {
                    final picked = widget.mode == VfsPickMode.file
                        ? (_selectedFile ?? _path)
                        : _path;
                    Navigator.of(context).pop(picked);
                  },
                  child: Text(
                    widget.mode == VfsPickMode.file ? '用这个文件' : '用这个目录',
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  void _go(String path) {
    setState(() {
      _path = VfsPath.normalize(path);
      _selectedFile = null;
    });
    _load();
  }

  /// 在当前目录里新建一个子目录，然后走进去。
  ///
  /// 新建放在这里而不是让调用方实现，是因为「在哪建」这件事只有选择器知道——
  /// 调用方传的只是一个初始路径，不知道用户后来翻到了哪。
  Future<void> _createFolder() async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('新建目录'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '目录名'),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(controller.text),
            child: const Text('创建'),
          ),
        ],
      ),
    );
    if (name == null || name.trim().isEmpty || !mounted) return;

    final created = VfsPath.join(_path, name.trim());
    try {
      await VfsService.instance.mkdir(created, parents: true);
      if (!mounted) return;
      _go(created);
    } on VfsException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.message)),
      );
    }
  }
}
