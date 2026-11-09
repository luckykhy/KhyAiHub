// 文件管理器侧栏：快捷入口。
//
// 为什么侧栏是「文件管理器形态」的关键而不是装饰：VFS 把四棵权限不同的树并到了一起
// （公共存储 / 私有目录 / 系统分区 / 容器），用户必须随时知道**自己在哪一棵树里**、
// 哪些能进哪些进不去。侧栏就是这张地图：入口固定、状态可见、点一下就到。
//
// 入口的可见性跟着权限走：Shizuku 没激活时「应用数据」仍然显示，但画成灰态并
// 标出原因——藏起来等于让用户以为这个功能不存在。

import 'package:flutter/material.dart';

import '../../../core/vfs/vfs_route.dart';
import '../../../core/vfs/vfs_organization.dart';
import '../../../core/vfs/vfs_service.dart';
import '../../theme/design_tokens.dart';

/// 侧栏里的一个快捷入口。
class VfsShortcut {
  final String label;
  final String path;
  final IconData icon;

  /// 这一档需要的权限（用于说明「凭什么能进」）。
  final VfsTier tier;

  const VfsShortcut({
    required this.label,
    required this.path,
    required this.icon,
    required this.tier,
  });
}

/// 预置快捷入口。
const List<VfsShortcut> kVfsShortcuts = <VfsShortcut>[
  VfsShortcut(
    label: '内部存储',
    path: VfsRoots.storage,
    icon: Icons.sd_storage_outlined,
    tier: VfsTier.basic,
  ),
  VfsShortcut(
    label: '应用数据',
    path: '/data/data',
    icon: Icons.apps_outlined,
    tier: VfsTier.privateData,
  ),
  VfsShortcut(
    label: '系统目录',
    path: '/system',
    icon: Icons.security_outlined,
    tier: VfsTier.systemRead,
  ),
  VfsShortcut(
    label: '容器空间',
    path: VfsRoots.container,
    icon: Icons.inventory_2_outlined,
    tier: VfsTier.container,
  ),
];

/// 侧栏。
class VfsSidebar extends StatelessWidget {
  final String currentPath;
  final VfsStatus status;
  final ValueChanged<String> onNavigate;

  /// 打开「系统应用管理」面板。空则不显示这一项。
  final VoidCallback? onOpenAppManager;

  /// 打开「存储分析」。空则不显示这一项。
  final VoidCallback? onOpenStorageAnalysis;

  /// 打开「容器应用」分区。空则不显示这一项。
  final VoidCallback? onOpenContainerApps;

  /// 打开「自动化脚本」。空则不显示这一项。
  final VoidCallback? onOpenAutomationScripts;

  /// 打开「应用数据浏览器」。空则不显示这一项。
  final VoidCallback? onOpenAppDataBrowser;

  /// 打开「标签」。空则不显示这一项。
  final VoidCallback? onOpenTags;

  /// 书签列表。
  final List<VfsBookmark> bookmarks;

  /// 最近访问。
  final List<VfsHistoryEntry> history;

  const VfsSidebar({
    super.key,
    required this.currentPath,
    required this.status,
    required this.onNavigate,
    this.onOpenAppManager,
    this.onOpenStorageAnalysis,
    this.onOpenContainerApps,
    this.onOpenAutomationScripts,
    this.onOpenAppDataBrowser,
    this.onOpenTags,
    this.bookmarks = const <VfsBookmark>[],
    this.history = const <VfsHistoryEntry>[],
  });

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return Drawer(
      backgroundColor: palette.surface,
      child: SafeArea(
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.dense),
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.page,
                AppSpacing.inner,
                AppSpacing.page,
                AppSpacing.dense,
              ),
              child: Row(
                children: <Widget>[
                  Icon(Icons.folder_special_outlined,
                      size: 20, color: palette.primary),
                  const SizedBox(width: AppSpacing.inner),
                  Expanded(
                    child: Text(
                      '位置',
                      style: AppText.title.copyWith(color: palette.textPrimary),
                    ),
                  ),
                ],
              ),
            ),
            for (final shortcut in kVfsShortcuts)
              _ShortcutTile(
                shortcut: shortcut,
                currentPath: currentPath,
                status: status,
                onTap: () {
                  Navigator.of(context).maybePop();
                  onNavigate(shortcut.path);
                },
              ),
            const Divider(height: AppSpacing.section),
            if (bookmarks.isNotEmpty) ...<Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.page,
                  AppSpacing.dense,
                  AppSpacing.page,
                  0,
                ),
                child: Text(
                  '书签',
                  style: AppText.label.copyWith(color: palette.textFaint),
                ),
              ),
              for (final bookmark in bookmarks)
                ListTile(
                  dense: true,
                  leading: Icon(Icons.bookmark_outline,
                      size: 20, color: palette.textSecondary),
                  title: Text(
                    bookmark.name.isEmpty ? bookmark.path : bookmark.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.body.copyWith(color: palette.textPrimary),
                  ),
                  onTap: () {
                    Navigator.of(context).maybePop();
                    onNavigate(bookmark.path);
                  },
                ),
              const Divider(height: AppSpacing.section),
            ],
            if (history.isNotEmpty) ...<Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.page,
                  AppSpacing.dense,
                  AppSpacing.page,
                  0,
                ),
                child: Text(
                  '最近访问',
                  style: AppText.label.copyWith(color: palette.textFaint),
                ),
              ),
              for (final entry in history.take(8))
                ListTile(
                  dense: true,
                  leading: Icon(Icons.history, size: 20, color: palette.textFaint),
                  title: Text(
                    entry.path,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.body.copyWith(color: palette.textSecondary),
                  ),
                  onTap: () {
                    Navigator.of(context).maybePop();
                    onNavigate(entry.path);
                  },
                ),
              const Divider(height: AppSpacing.section),
            ],
            if (onOpenTags != null)
              ListTile(
                dense: true,
                leading:
                    Icon(Icons.label_outline, size: 20, color: palette.textSecondary),
                title: Text(
                  '标签',
                  style: AppText.body.copyWith(color: palette.textPrimary),
                ),
                subtitle: Text(
                  '跨目录的归类',
                  style: AppText.micro.copyWith(color: palette.textFaint),
                ),
                onTap: () {
                  Navigator.of(context).maybePop();
                  onOpenTags!();
                },
              ),
            if (onOpenAppDataBrowser != null)
              ListTile(
                dense: true,
                leading:
                    Icon(Icons.data_object_outlined, size: 20, color: palette.textSecondary),
                title: Text(
                  '应用数据浏览器',
                  style: AppText.body.copyWith(color: palette.textPrimary),
                ),
                subtitle: Text(
                  '把偏好与配置解析成表格',
                  style: AppText.micro.copyWith(color: palette.textFaint),
                ),
                onTap: () {
                  Navigator.of(context).maybePop();
                  onOpenAppDataBrowser!();
                },
              ),
            if (onOpenAutomationScripts != null)
              ListTile(
                dense: true,
                leading:
                    Icon(Icons.bolt_outlined, size: 20, color: palette.textSecondary),
                title: Text(
                  '自动化脚本',
                  style: AppText.body.copyWith(color: palette.textPrimary),
                ),
                subtitle: Text(
                  '录下来的操作流程',
                  style: AppText.micro.copyWith(color: palette.textFaint),
                ),
                onTap: () {
                  Navigator.of(context).maybePop();
                  onOpenAutomationScripts!();
                },
              ),
            if (onOpenContainerApps != null)
              ListTile(
                dense: true,
                leading: Icon(Icons.inventory_2_outlined,
                    size: 20, color: palette.textSecondary),
                title: Text(
                  '容器应用',
                  style: AppText.body.copyWith(color: palette.textPrimary),
                ),
                subtitle: Text(
                  '沙盒内的应用与数据',
                  style: AppText.micro.copyWith(color: palette.textFaint),
                ),
                onTap: () {
                  Navigator.of(context).maybePop();
                  onOpenContainerApps!();
                },
              ),
            if (onOpenStorageAnalysis != null)
              ListTile(
                dense: true,
                leading: Icon(Icons.pie_chart_outline,
                    size: 20, color: palette.textSecondary),
                title: Text(
                  '存储分析',
                  style: AppText.body.copyWith(color: palette.textPrimary),
                ),
                subtitle: Text(
                  '空间被什么占了',
                  style: AppText.micro.copyWith(color: palette.textFaint),
                ),
                onTap: () {
                  Navigator.of(context).maybePop();
                  onOpenStorageAnalysis!();
                },
              ),
            if (onOpenAppManager != null)
              ListTile(
                dense: true,
                leading: Icon(Icons.apps_outlined, size: 20, color: palette.textSecondary),
                title: Text(
                  '系统应用管理',
                  style: AppText.body.copyWith(color: palette.textPrimary),
                ),
                subtitle: Text(
                  '查看、冻结与卸载应用',
                  style: AppText.micro.copyWith(color: palette.textFaint),
                ),
                onTap: () {
                  Navigator.of(context).maybePop();
                  onOpenAppManager!();
                },
              ),
            _StatusTile(status: status),
          ],
        ),
      ),
    );
  }
}

class _ShortcutTile extends StatelessWidget {
  final VfsShortcut shortcut;
  final String currentPath;
  final VfsStatus status;
  final VoidCallback onTap;

  const _ShortcutTile({
    required this.shortcut,
    required this.currentPath,
    required this.status,
    required this.onTap,
  });

  /// 这个入口当前能不能进。
  ///
  /// 判据与路由一致：基础档看存储权限，私有/系统档看 Shizuku，容器档恒可进。
  bool get _available {
    switch (shortcut.tier) {
      case VfsTier.basic:
        return status.storageGranted;
      case VfsTier.privateData:
      case VfsTier.systemRead:
        return status.shizukuAvailable;
      case VfsTier.container:
        return true;
      case VfsTier.elevated:
        return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final available = _available;
    final active = VfsPath.isUnder(currentPath, shortcut.path);
    final color = available
        ? (active ? palette.primary : palette.textSecondary)
        : palette.textFaint;

    return ListTile(
      dense: true,
      selected: active,
      selectedTileColor: palette.surfaceHigh,
      leading: Icon(shortcut.icon, size: 20, color: color),
      title: Text(
        shortcut.label,
        style: AppText.body.copyWith(
          color: available ? palette.textPrimary : palette.textFaint,
        ),
      ),
      subtitle: available
          ? null
          : Text(
              shortcut.tier == VfsTier.basic ? '缺少存储权限' : '需激活 Shizuku',
              style: AppText.micro.copyWith(color: palette.textFaint),
            ),
      trailing: shortcut.tier == VfsTier.systemRead
          ? Icon(Icons.lock_outline, size: 14, color: palette.textFaint)
          : null,
      onTap: onTap,
    );
  }
}

/// 侧栏底部的环境状态。
class _StatusTile extends StatelessWidget {
  final VfsStatus status;

  const _StatusTile({required this.status});

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final shizukuText = status.shizukuAvailable
        ? 'Shizuku 已就绪${status.shizukuVersion.isEmpty ? '' : ' v${status.shizukuVersion}'}'
        : status.shizukuInstalled
            ? 'Shizuku 已安装但未连接'
            : '未安装 Shizuku';
    final shizukuColor =
        status.shizukuAvailable ? palette.success : palette.textFaint;

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.page,
        AppSpacing.dense,
        AppSpacing.page,
        AppSpacing.page,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.shield_outlined, size: 14, color: shizukuColor),
              const SizedBox(width: AppSpacing.dense),
              Expanded(
                child: Text(
                  shizukuText,
                  style: AppText.micro.copyWith(color: shizukuColor),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          Row(
            children: <Widget>[
              Icon(
                status.storageGranted
                    ? Icons.check_circle_outline
                    : Icons.error_outline,
                size: 14,
                color: status.storageGranted ? palette.success : palette.warning,
              ),
              const SizedBox(width: AppSpacing.dense),
              Expanded(
                child: Text(
                  status.storageGranted ? '存储权限已授予' : '缺少存储权限',
                  style: AppText.micro.copyWith(
                    color: status.storageGranted
                        ? palette.success
                        : palette.warning,
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
