// 文件列表里的一行。
//
// 一行要说清四件事：这是什么（图标）、叫什么（名称）、多大/什么时候（副标题）、
// 现在能不能用（灰态与锁标）。少了第四件，用户点进去才发现打不开——
// 那是把「权限问题」伪装成「功能坏了」。
//
// 多选用长按进多选模式后显示复选框：单选是「打开」，多选是「批量操作」，
// 两种意图不该共用一个控件。

import 'package:flutter/material.dart';

import '../../../core/vfs/vfs_node.dart';
import '../../theme/design_tokens.dart';

/// 列表行。
class VfsNodeTile extends StatelessWidget {
  final VfsNode node;
  final bool selected;
  final bool selectionMode;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  const VfsNodeTile({
    super.key,
    required this.node,
    required this.selected,
    required this.selectionMode,
    required this.onTap,
    required this.onLongPress,
  });

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final dim = !node.accessible;

    final icon = node.isDirectory
        ? Icons.folder_outlined
        : _iconForMime(node.mime);

    return InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.page,
          vertical: AppSpacing.cardPadNarrow,
        ),
        decoration: BoxDecoration(
          color: selected ? palette.surfaceHigh : null,
          border: Border(
            bottom: BorderSide(color: palette.stroke, width: AppStroke.thin),
          ),
        ),
        child: Row(
          children: <Widget>[
            if (selectionMode)
              Padding(
                padding: const EdgeInsets.only(right: AppSpacing.inner),
                child: Icon(
                  selected
                      ? Icons.check_circle
                      : Icons.radio_button_unchecked,
                  size: 20,
                  color: selected ? palette.primary : palette.textFaint,
                ),
              ),
            Icon(
              icon,
              size: 22,
              color: dim
                  ? palette.textFaint
                  : node.isDirectory
                      ? palette.primary
                      : palette.textSecondary,
            ),
            const SizedBox(width: AppSpacing.cardPad),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    node.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.body.copyWith(
                      color: dim ? palette.textFaint : palette.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _subtitle(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.micro.copyWith(color: palette.textFaint),
                  ),
                ],
              ),
            ),
            if (node.readOnly)
              Padding(
                padding: const EdgeInsets.only(left: AppSpacing.dense),
                child: Icon(Icons.lock_outline,
                    size: 14, color: palette.textFaint),
              ),
          ],
        ),
      ),
    );
  }

  String _subtitle() {
    if (!node.accessible) {
      return node.reason.isEmpty ? '当前不可访问' : node.reason;
    }
    final parts = <String>[];
    if (node.isDirectory) {
      parts.add('目录');
    } else if (node.readableSize.isNotEmpty) {
      parts.add(node.readableSize);
    }
    if (node.modifiedMs > 0) {
      parts.add(_formatTime(node.modifiedMs));
    }
    if (node.owner.isNotEmpty && node.owner != '?') {
      parts.add(node.owner);
    }
    if (parts.isEmpty) return node.mime;
    return parts.join(' · ');
  }

  static String _formatTime(int millis) {
    final time = DateTime.fromMillisecondsSinceEpoch(millis);
    final now = DateTime.now();
    final sameYear = time.year == now.year;
    String two(int value) => value.toString().padLeft(2, '0');
    if (sameYear) {
      return '${two(time.month)}-${two(time.day)} ${two(time.hour)}:${two(time.minute)}';
    }
    return '${time.year}-${two(time.month)}-${two(time.day)}';
  }

  static IconData _iconForMime(String mime) {
    if (mime.startsWith('image/')) return Icons.image_outlined;
    if (mime.startsWith('video/')) return Icons.movie_outlined;
    if (mime.startsWith('audio/')) return Icons.audiotrack_outlined;
    if (mime.startsWith('text/')) return Icons.description_outlined;
    if (mime.contains('pdf')) return Icons.picture_as_pdf_outlined;
    if (mime.contains('zip') || mime.contains('tar')) {
      return Icons.folder_zip_outlined;
    }
    if (mime.contains('apk')) return Icons.android_outlined;
    if (mime.contains('json') || mime.contains('xml')) {
      return Icons.data_object_outlined;
    }
    return Icons.insert_drive_file_outlined;
  }
}
