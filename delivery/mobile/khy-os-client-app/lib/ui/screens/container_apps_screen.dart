// 容器应用分区。
//
// 「容器」是 App 内置的沙盒空间：克隆进来的应用与它自己的数据都住在
// `/khyos/container` 下面，与宿主文件系统**没有共享挂载点**——这是容器与宿主
// 之间的硬边界，也是「容器与宿主严格隔离」这条安全承诺的实现方式。
//
// 当前构建**没有内置容器运行时**（proot/chroot 那套）。所以这一页要做两件事：
//   1. 把容器空间摆出来——用户放进去的目录看得见、管得了；
//   2. 对需要运行时的动作（启动、内存扫描）**如实说做不到**，而不是给一个点了
//      没反应或者假装成功的按钮。
//
// 能真做的动作照做：数据导出（把容器目录复制到公共存储）、删除克隆。
// 「外部应用没有这个菜单项」这条规矩由入口位置保证——这一页只列容器里的东西。

import 'package:flutter/material.dart';

import '../../core/vfs/vfs_node.dart';
import '../../core/vfs/vfs_route.dart';
import '../../core/vfs/vfs_service.dart';
import '../theme/design_tokens.dart';

/// 容器应用分区页。
class ContainerAppsScreen extends StatefulWidget {
  const ContainerAppsScreen({super.key});

  @override
  State<ContainerAppsScreen> createState() => _ContainerAppsScreenState();
}

class _ContainerAppsScreenState extends State<ContainerAppsScreen> {
  VfsListing _listing = VfsListing.empty;
  bool _loading = true;
  bool _runtimeInstalled = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final status = await VfsService.instance.status(refresh: true);
    final listing = await VfsService.instance.list(VfsRoots.container);
    if (!mounted) return;
    setState(() {
      _runtimeInstalled = status.containerInstalled;
      _listing = listing;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final apps = _listing.nodes.where((VfsNode node) => node.isDirectory).toList();

    return Scaffold(
      appBar: AppBar(
        title: const Text('容器应用'),
        actions: <Widget>[
          IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: _loading
          ? Center(
              child: SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: palette.primary,
                ),
              ),
            )
          : apps.isEmpty
              ? _emptyState(context)
              : ListView.builder(
                  itemCount: apps.length,
                  itemBuilder: (BuildContext context, int index) {
                    final app = apps[index];
                    return ListTile(
                      leading: Icon(Icons.inventory_2_outlined,
                          size: 20, color: palette.primary),
                      title: Text(
                        app.name,
                        style: AppText.body.copyWith(color: palette.textPrimary),
                      ),
                      subtitle: Text(
                        app.path,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppText.micro.copyWith(color: palette.textFaint),
                      ),
                      trailing: PopupMenuButton<String>(
                        onSelected: (String action) => _onAction(app, action),
                        itemBuilder: (BuildContext context) =>
                            <PopupMenuEntry<String>>[
                          const PopupMenuItem<String>(
                            value: 'launch',
                            child: Text('启动'),
                          ),
                          const PopupMenuItem<String>(
                            value: 'scan',
                            child: Text('内存扫描'),
                          ),
                          const PopupMenuItem<String>(
                            value: 'export',
                            child: Text('数据导出'),
                          ),
                          const PopupMenuDivider(),
                          const PopupMenuItem<String>(
                            value: 'delete',
                            child: Text('删除克隆'),
                          ),
                        ],
                      ),
                    );
                  },
                ),
    );
  }

  Widget _emptyState(BuildContext context) {
    final palette = AppPalette.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.inventory_2_outlined, size: 32, color: palette.textFaint),
            const SizedBox(height: AppSpacing.cardGap),
            Text(
              _runtimeInstalled
                  ? '容器空间里还没有应用'
                  : '容器运行时未安装',
              style: AppText.body.copyWith(color: palette.textSecondary),
            ),
            const SizedBox(height: AppSpacing.dense),
            Text(
              _runtimeInstalled
                  ? '把应用克隆进容器后，它会出现在这里。'
                  : '容器运行时是独立插件，安装后即可把应用克隆进沙盒运行。',
              textAlign: TextAlign.center,
              style: AppText.micro.copyWith(color: palette.textFaint),
            ),
            const SizedBox(height: AppSpacing.cardGap),
            OutlinedButton(
              onPressed: _showRuntimeInfo,
              child: const Text('安装运行时'),
            ),
          ],
        ),
      ),
    );
  }

  void _showRuntimeInfo() {
    showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('容器运行时'),
        content: Text(
          '容器运行时是独立于本 App 的插件包：它提供 proot/chroot 环境，'
          '让应用能在沙盒里跑起来。\n\n'
          '当前构建没有内置运行时包，所以「启动」与「内存扫描」还不能用；'
          '容器目录本身是可以用的——你可以往里放文件，数据导出与删除克隆都能正常工作。\n\n'
          '运行时安装包到位后，这里会变成「下载并安装」的一键入口。',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('知道了'),
          ),
        ],
      ),
    );
  }

  Future<void> _onAction(VfsNode app, String action) async {
    switch (action) {
      case 'launch':
        _toast('容器运行时未安装，暂时无法启动容器内的应用');
      case 'scan':
        _toast('容器运行时未安装，暂时无法扫描容器内应用的内存');
      case 'export':
        await _export(app);
      case 'delete':
        await _delete(app);
    }
  }

  /// 把容器内的目录复制到公共存储。
  ///
  /// 这一步是**跨权限操作**（容器 → 公共存储），所以要用户确认目标位置；
  /// 操作本身会被审计日志记下来，来源标记为「用户手动」。
  Future<void> _export(VfsNode app) async {
    final controller = TextEditingController(text: VfsRoots.storage);
    final target = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('导出到'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '目标目录绝对路径'),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(controller.text),
            child: const Text('导出'),
          ),
        ],
      ),
    );
    if (!mounted || target == null || target.trim().isEmpty) return;

    final destination = VfsPath.join(target.trim(), app.name);
    try {
      await VfsService.instance.copy(app.path, destination);
      _toast('已导出到 $destination');
    } catch (error) {
      _toast('$error');
    }
  }

  Future<void> _delete(VfsNode app) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('删除克隆'),
        content: Text('确定删除容器内的「${app.name}」吗？该目录下的数据会一并删除。'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;
    try {
      await VfsService.instance.delete(app.path, recursive: true);
      _toast('已删除 ${app.name}');
    } catch (error) {
      _toast('$error');
    }
    await _load();
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }
}
