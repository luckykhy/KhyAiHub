// 归档浏览面板：看压缩包里面有什么，并选择性地解出来。
//
// 「浏览压缩包」是文件管理器的基本功——用户经常只想确认某个包里的某个文件在不在，
// 而不是整个解出来。所以这里默认**不解压**，先列清单，用户挑完再解。
//
// 解压目标默认是压缩包所在目录（用户最常见的意图），也允许改到别处。

import 'package:flutter/material.dart';

import '../../../core/vfs/vfs_archive.dart';
import '../../../core/vfs/vfs_service.dart';
import '../../theme/design_tokens.dart';
import 'vfs_folder_picker.dart';

/// 归档浏览面板。
class VfsArchiveSheet extends StatefulWidget {
  /// 归档文件的虚拟路径。
  final String archivePath;

  /// 归档所在目录（默认解压目标）。
  final String parentDir;

  const VfsArchiveSheet({
    super.key,
    required this.archivePath,
    required this.parentDir,
  });

  /// 弹出面板。
  static Future<void> show(
    BuildContext context, {
    required String archivePath,
    required String parentDir,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext sheetContext) => VfsArchiveSheet(
        archivePath: archivePath,
        parentDir: parentDir,
      ),
    );
  }

  @override
  State<VfsArchiveSheet> createState() => _VfsArchiveSheetState();
}

class _VfsArchiveSheetState extends State<VfsArchiveSheet> {
  ArchiveListing? _listing;
  final Set<String> _selected = <String>{};
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final listing = await VfsArchive.list(widget.archivePath);
    if (!mounted) return;
    setState(() {
      _listing = listing;
      _loading = false;
      _error = listing == null ? '无法读取这个压缩包（当前版本只支持 ZIP 与 TAR.GZ）' : null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final listing = _listing;

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
              Icon(Icons.folder_zip_outlined, size: 18, color: palette.primary),
              const SizedBox(width: AppSpacing.inner),
              Expanded(
                child: Text(
                  widget.archivePath.split('/').last,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
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
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.section),
              child: Text(
                _error!,
                style: AppText.body.copyWith(color: palette.warning),
              ),
            )
          else if (listing != null) ...<Widget>[
            Text(
              '共 ${listing.entries.length} 项 · ${listing.totalBytes} 字节'
              '（${listing.format}）',
              style: AppText.secondary.copyWith(color: palette.textFaint),
            ),
            const SizedBox(height: AppSpacing.cardGap),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: <Widget>[
                  for (final entry in listing.sorted)
                    _entryRow(context, entry),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.cardGap),
            Row(
              children: <Widget>[
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                    child: const Text('关闭'),
                  ),
                ),
                const SizedBox(width: AppSpacing.cardGap),
                Expanded(
                  child: FilledButton(
                    onPressed: _extract,
                    child: Text(
                      _selected.isEmpty ? '全部解压' : '解压 ${_selected.length} 项',
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _entryRow(BuildContext context, ArchiveEntry entry) {
    final palette = AppPalette.of(context);
    final selected = _selected.contains(entry.name);

    return InkWell(
      onTap: () {
        setState(() {
          if (!_selected.remove(entry.name)) _selected.add(entry.name);
        });
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.dense),
        child: Row(
          children: <Widget>[
            Icon(
              selected ? Icons.check_box : Icons.check_box_outline_blank,
              size: 20,
              color: selected ? palette.primary : palette.textFaint,
            ),
            const SizedBox(width: AppSpacing.inner),
            Icon(
              entry.isDirectory
                  ? Icons.folder_outlined
                  : Icons.insert_drive_file_outlined,
              size: 18,
              color: palette.textSecondary,
            ),
            const SizedBox(width: AppSpacing.inner),
            Expanded(
              child: Text(
                entry.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppText.body.copyWith(color: palette.textPrimary),
              ),
            ),
            Text(
              entry.readableSize,
              style: AppText.micro.copyWith(color: palette.textFaint),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _extract() async {
    final listing = _listing;
    if (listing == null) return;

    final controller = TextEditingController(text: widget.parentDir);
    final target = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('解压到'),
        content: Row(
          children: <Widget>[
            Expanded(
              child: TextField(
                controller: controller,
                autofocus: true,
                decoration:
                    const InputDecoration(hintText: '目标目录绝对路径'),
              ),
            ),
            const SizedBox(width: AppSpacing.dense),
            IconButton(
              onPressed: () async {
                final picked = await VfsFolderPicker.pick(
                  dialogContext,
                  initialPath: controller.text,
                  title: '解压到',
                );
                if (picked != null) controller.text = picked;
              },
              icon: const Icon(Icons.folder_open_outlined, size: 20),
              color: AppPalette.of(dialogContext).textSecondary,
              tooltip: '浏览目录',
            ),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(controller.text),
            child: const Text('解压'),
          ),
        ],
      ),
    );
    if (!mounted || target == null || target.trim().isEmpty) return;

    try {
      final result = await VfsArchive.extract(
        widget.archivePath,
        target.trim(),
        selected: _selected.toList(),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            result.message.isEmpty
                ? '已解压 ${result.count} 个文件到 ${target.trim()}'
                : '已解压 ${result.count} 个文件到 ${target.trim()}。${result.message}',
          ),
        ),
      );
    } on VfsException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.message)),
      );
    }
    if (mounted) Navigator.of(context).maybePop();
  }
}
