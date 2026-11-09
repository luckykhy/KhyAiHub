// 长按菜单：文件管理器的主要操作入口。
//
// 为什么是长按而不是顶部按钮栏：专业文件管理器的操作密度高，一屏放不下十几个按钮。
// 长按菜单把「这一项能做什么」和「这一项」绑在一起——选中什么，可做的事就跟着变。
// 这也是 AI 融入的位置之一：菜单底部有「AI 建议」，和手动操作平级，不是另一个 App。

import 'package:flutter/material.dart';

import '../../../core/vfs/vfs_node.dart';
import '../../theme/design_tokens.dart';

/// 长按菜单项。
class VfsMenuAction {
  final String label;
  final IconData icon;

  /// 危险项（删除）画红。
  final bool destructive;

  const VfsMenuAction(this.label, this.icon, {this.destructive = false});
}

/// 长按菜单。
class VfsContextSheet extends StatelessWidget {
  final VfsNode node;

  /// 当前是否多选（多选时菜单只提供批量操作）。
  final bool multiSelect;

  /// 菜单项。
  final List<VfsMenuAction> actions;

  final ValueChanged<VfsMenuAction> onSelected;

  const VfsContextSheet({
    super.key,
    required this.node,
    required this.multiSelect,
    required this.actions,
    required this.onSelected,
  });

  /// 弹出菜单。
  static Future<VfsMenuAction?> show(
    BuildContext context, {
    required VfsNode node,
    required bool multiSelect,
    required List<VfsMenuAction> actions,
  }) {
    return showModalBottomSheet<VfsMenuAction>(
      context: context,
      useSafeArea: true,
      builder: (BuildContext sheetContext) {
        final palette = AppPalette.of(sheetContext);
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
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
                    Icon(
                      node.isDirectory
                          ? Icons.folder_outlined
                          : Icons.insert_drive_file_outlined,
                      size: 18,
                      color: palette.primary,
                    ),
                    const SizedBox(width: AppSpacing.inner),
                    Expanded(
                      child: Text(
                        node.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style:
                            AppText.cardTitle.copyWith(color: palette.textPrimary),
                      ),
                    ),
                  ],
                ),
              ),
              Divider(height: AppStroke.thin, color: palette.stroke),
              for (final action in actions)
                ListTile(
                  dense: true,
                  leading: Icon(
                    action.icon,
                    size: 20,
                    color: action.destructive
                        ? palette.error
                        : palette.textSecondary,
                  ),
                  title: Text(
                    action.label,
                    style: AppText.body.copyWith(
                      color: action.destructive
                          ? palette.error
                          : palette.textPrimary,
                    ),
                  ),
                  onTap: () => Navigator.of(sheetContext).pop(action),
                ),
              const SizedBox(height: AppSpacing.dense),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
