// 文件管理器主界面。
//
// 这是这一版 App 的**主界面**——原来是对话。这一改动的含义是：用户打开 App 想的是
// 「我的文件在哪」，不是「我想问 AI 什么」。AI 退到右下角的悬浮按钮里，随时可唤、
// 随时可弃。
//
// 三条界面纪律：
//   1. 人工路径完整——浏览、复制、移动、删除、重命名、建目录、属性全部在这里，
//      不依赖 AI；
//   2. 权限透明——只读标识、灰态条目、Shizuku 未激活的引导都在界面上说清楚；
//   3. AI 平级——AI 在长按菜单和悬浮按钮里，和手动操作平级，不是另一个 App。

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/vfs/ai_plan.dart';
import '../../core/vfs/app_manager.dart';
import '../../core/vfs/automation_script.dart';
import '../../core/vfs/automation_scheduler.dart';
import '../../core/vfs/batch_rename.dart';
import '../../core/vfs/vfs_copy_task.dart';
import '../../core/vfs/operation_recorder.dart';
import '../../core/vfs/vfs_audit.dart';
import '../../core/vfs/vfs_archive.dart';
import '../../core/vfs/vfs_organization.dart';
import '../../core/vfs/vfs_suggestions.dart';
import '../../core/vfs/vfs_watcher.dart';
import '../../core/vfs/vfs_context.dart';
import '../../core/vfs/vfs_node.dart';
import '../../core/vfs/vfs_route.dart';
import '../../core/vfs/vfs_service.dart';
import '../theme/design_tokens.dart';
import '../widgets/vfs/vfs_address_bar.dart';
import '../widgets/vfs/vfs_archive_sheet.dart';
import '../widgets/vfs/vfs_ai_sheet.dart';
import '../widgets/vfs/vfs_batch_rename_sheet.dart';
import '../widgets/vfs/vfs_context_sheet.dart';
import '../widgets/vfs/vfs_copy_progress_sheet.dart';
import '../widgets/vfs/vfs_folder_picker.dart';
import '../widgets/vfs/vfs_node_tile.dart';
import '../widgets/vfs/vfs_sidebar.dart';
import '../widgets/vfs/vfs_suggestion_card.dart';
import '../widgets/vfs/vfs_terminal_drawer.dart';
import '../widgets/vfs/vfs_text_editor.dart';
import 'app_data_browser_screen.dart';
import 'app_manager_screen.dart';
import 'automation_scripts_screen.dart';
import 'container_apps_screen.dart';
import 'storage_analysis_screen.dart';
import 'tags_screen.dart';

/// 文件管理器页。
class FileManagerScreen extends StatefulWidget {
  /// AI 助手按钮的可见性回调。
  ///
  /// 按钮放在**外层** Scaffold（它才在玻璃底栏之上），所以「AI 关了要把按钮也收掉」
  /// 这件事得由本屏告诉外层。
  final ValueChanged<bool>? onAssistantVisibilityChanged;

  const FileManagerScreen({super.key, this.onAssistantVisibilityChanged});

  @override
  State<FileManagerScreen> createState() => FileManagerScreenState();
}

/// 文件管理器页的状态。
///
/// 状态类必须是**公开**的：外层 Scaffold 用 `GlobalKey<FileManagerScreenState>`
/// 调 [openAiPanel] 唤起 AI 面板。
class FileManagerScreenState extends State<FileManagerScreen> {
  /// 本屏 Scaffold 的句柄。
  ///
  /// 为什么不能直接用 `Scaffold.of(context)`：State 的 context 在**本屏 Scaffold
  /// 之上**，而这一屏又嵌在主 Scaffold（main.dart）里——`Scaffold.of(context)` 找到的
  /// 是**外层**那个没有抽屉的 Scaffold，于是 `openDrawer()` 作用了个寂寞：点了没反应。
  /// 真机验证时才发现的，所以这里用 GlobalKey 直接拿本屏的 ScaffoldState。
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  final VfsService _vfs = VfsService.instance;

  String _path = VfsRoots.storage;
  VfsListing _listing = VfsListing.empty;
  VfsStatus _status = const VfsStatus();
  VfsRoute _route = const VfsRoute.root();

  bool _loading = true;
  String? _error;
  final Set<String> _selected = <String>{};
  List<VfsBookmark> _bookmarks = const <VfsBookmark>[];
  List<VfsHistoryEntry> _history = const <VfsHistoryEntry>[];

  /// AI 主动建议（仅在 AI 强度为「主动建议」以上时计算）。
  List<VfsSuggestion> _suggestions = const <VfsSuggestion>[];
  bool _suggestionsDismissed = false;

  @override
  void initState() {
    super.initState();
    // 装上目录事件通路：原生监听 → 事件 → 绑定的脚本执行。
    // 装在文件管理器上是因为它是 App 的主界面，进程活着它就活着。
    VfsWatcherService.instance.start();
    VfsWatchTrigger.install();
    // 定时脚本的调度器也挂在主界面上：App 进程活着它才活着——
    // 没有前台服务的话，进程被杀后定时执行本来就不会继续，这一点在界面上写明。
    AutomationScheduler.instance.start();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await _vfs.loadPolicy();
    final status = await _vfs.status(refresh: true);
    final bookmarks = await VfsOrganizationStore.loadBookmarks();
    final history = await VfsOrganizationStore.loadHistory();
    if (!mounted) return;
    setState(() {
      _status = status;
      _bookmarks = bookmarks;
      _history = history;
    });
    widget.onAssistantVisibilityChanged?.call(_vfs.policy.aiLevel.showsAssistant);
    await _open(_path);
  }

  /// 供外层 Scaffold 调起 AI 面板。
  void openAiPanel() {
    _openAiPanel();
  }

  /// 重新读书签与历史（改过之后刷新侧栏）。
  Future<void> _reloadOrganization() async {
    final bookmarks = await VfsOrganizationStore.loadBookmarks();
    final history = await VfsOrganizationStore.loadHistory();
    if (!mounted) return;
    setState(() {
      _bookmarks = bookmarks;
      _history = history;
    });
  }

  Future<void> _open(String path) async {
    final normalized = VfsPath.normalize(path);

    // 首次进入某个应用的私有目录：弹一次风险提示并要求确认。
    // 确认过就记下来，之后不再重复弹——每次都弹，用户会直接把提示关掉，
    // 那等于没有提示。
    if (!await _confirmPrivateAccessIfNeeded(normalized)) return;

    setState(() {
      _loading = true;
      _error = null;
      _selected.clear();
    });
    try {
      final listing = await _vfs.list(normalized);
      final route = await _vfs.routeOf(normalized);
      // 记一次访问：最近访问列表是「我刚才去过哪」的客观记录，
      // 记在**打开成功**之后——打不开的目录不该出现在历史里。
      unawaited(VfsOrganizationStore.recordVisit(normalized));
      if (!mounted) return;
      setState(() {
        _path = normalized;
        _listing = listing;
        _route = route;
        _loading = false;
        _suggestionsDismissed = false;
      });
      _computeSuggestions();
    } on VfsException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = '$error';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);

    return CallbackShortcuts(
      // 快捷键唤起 AI 面板：目标里写了「悬浮按钮、长按菜单或快捷键」三种入口，
      // 这里补上第三种——已经盯着键盘的用户不该为了叫 AI 而去够屏幕角落。
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(LogicalKeyboardKey.keyK, control: true):
            _openAiPanel,
        const SingleActivator(LogicalKeyboardKey.keyI, control: true):
            _openAiPanel,
      },
      child: Scaffold(
        key: _scaffoldKey,
        drawer: VfsSidebar(
          currentPath: _path,
          status: _status,
          bookmarks: _bookmarks,
        history: _history,
        onNavigate: _open,
        onOpenAppManager: () {
          Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const AppManagerScreen()),
          );
        },
        onOpenStorageAnalysis: () {
          Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => StorageAnalysisScreen(path: _path),
            ),
          );
        },
        onOpenContainerApps: () {
          Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const ContainerAppsScreen()),
          );
        },
        onOpenAutomationScripts: () {
          Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => const AutomationScriptsScreen(),
            ),
          );
        },
        onOpenAppDataBrowser: () {
          Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => const AppDataBrowserScreen(),
            ),
          );
        },
        onOpenTags: () {
          Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => TagsScreen(onOpenPath: (String path) {
                Navigator.of(context).pop();
                _open(path);
              }),
            ),
          );
        },
      ),
      body: SafeArea(
        child: Column(
          children: <Widget>[
            _header(context),
            VfsAddressBar(
              path: _path,
              readOnly: _route.readOnly,
              onNavigate: _open,
              onUp: () {
                if (_path == '/') return;
                _open(VfsPath.parent(_path));
              },
            ),
            if (_route.readOnly) _readOnlyBanner(context),
            if (_suggestions.isNotEmpty && !_suggestionsDismissed)
              VfsSuggestionCard(
                suggestions: _suggestions,
                onTap: _handleSuggestion,
                onDismiss: () =>
                    setState(() => _suggestionsDismissed = true),
              ),
            Expanded(child: _body(context)),
          ],
        ),
      ),
      backgroundColor: palette.pageBg,
    ),
    );
  }

  Widget _header(BuildContext context) {
    final palette = AppPalette.of(context);
    final selecting = _selected.isNotEmpty;

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.page,
        AppSpacing.dense,
        AppSpacing.page,
        AppSpacing.dense,
      ),
      child: Row(
        children: <Widget>[
          IconButton(
            onPressed: () => _scaffoldKey.currentState?.openDrawer(),
            icon: const Icon(Icons.menu, size: 20),
            color: palette.textSecondary,
            tooltip: '位置',
          ),
          const SizedBox(width: AppSpacing.dense),
          // 标题必须留得住：真机上顶栏一挤，「文件」两个字会被压成竖排两行。
          // 所以标题用 Expanded 且不换行，剩下的操作收进溢出菜单。
          Expanded(
            child: Text(
              selecting ? '已选 ${_selected.length} 项' : '文件',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppText.title.copyWith(color: palette.textPrimary),
            ),
          ),
          IconButton(
            onPressed: _showSearch,
            icon: const Icon(Icons.search, size: 20),
            color: palette.textSecondary,
            tooltip: '搜索',
          ),
          IconButton(
            onPressed: _toggleBookmark,
            icon: Icon(
              _isBookmarked ? Icons.bookmark : Icons.bookmark_outline,
              size: 20,
            ),
            color: _isBookmarked ? palette.primary : palette.textSecondary,
            tooltip: _isBookmarked ? '取消书签' : '添加书签',
          ),
          PopupMenuButton<String>(
            onSelected: (String action) => _onOverflowAction(action),
            itemBuilder: (BuildContext context) => <PopupMenuEntry<String>>[
              const PopupMenuItem<String>(
                value: 'terminal',
                child: Text('终端'),
              ),
              const PopupMenuItem<String>(
                value: 'record',
                child: Text('录制操作为脚本'),
              ),
              const PopupMenuItem<String>(
                value: 'create',
                child: Text('新建'),
              ),
              const PopupMenuItem<String>(
                value: 'refresh',
                child: Text('刷新'),
              ),
            ],
            icon: Icon(Icons.more_vert, size: 20, color: palette.textSecondary),
            tooltip: '更多',
          ),
        ],
      ),
    );
  }

  /// 溢出菜单的动作。
  Future<void> _onOverflowAction(String action) async {
    switch (action) {
      case 'terminal':
        await _openTerminal();
      case 'record':
        await _toggleRecorder();
      case 'create':
        await _showCreateMenu();
      case 'refresh':
        await _open(_path);
    }
  }

  Widget _readOnlyBanner(BuildContext context) {
    final palette = AppPalette.of(context);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.page,
        AppSpacing.dense,
        AppSpacing.page,
        0,
      ),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.cardPadNarrow,
        vertical: AppSpacing.dense,
      ),
      decoration: BoxDecoration(
        color: palette.warning.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: palette.warning.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: <Widget>[
          Icon(Icons.lock_outline, size: 14, color: palette.warning),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Text(
              '只读模式：系统分区不能写入',
              style: AppText.micro.copyWith(color: palette.warning),
            ),
          ),
          // 挂载为可写需要 Root，当前版本不支持——按钮恒灰并说明原因，
          // 好过给一个点了没反应的死按钮。
          Tooltip(
            message: '挂载为可写需要 Root 权限，当前版本未支持',
            child: TextButton(
              onPressed: null,
              child: Text(
                '挂载为可写（需 Root）',
                style: AppText.micro.copyWith(color: palette.textFaint),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _body(BuildContext context) {
    final palette = AppPalette.of(context);

    if (_loading) {
      return Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: palette.primary,
          ),
        ),
      );
    }

    if (_error != null) {
      return _centered(
        Icons.error_outline,
        _error!,
        palette.error,
        '重试',
        () => _open(_path),
      );
    }

    if (_listing.locked) {
      return _centered(
        Icons.lock_outline,
        _listing.lockReason ?? '当前不可访问',
        palette.warning,
        '如何激活',
        _showShizukuGuide,
      );
    }

    if (_listing.nodes.isEmpty) {
      return _centered(
        Icons.folder_open_outlined,
        '这个目录是空的',
        palette.textFaint,
        null,
        null,
      );
    }

    return ListView.builder(
      itemCount: _listing.nodes.length,
      itemBuilder: (BuildContext context, int index) {
        final node = _listing.nodes[index];
        return VfsNodeTile(
          node: node,
          selected: _selected.contains(node.path),
          selectionMode: _selected.isNotEmpty,
          // 路径可拖到终端里补全——目标里写的「从文件管理器拖拽文件路径到终端」。
          dragPath: node.path,
          onTap: () => _onTapNode(node),
          onLongPress: () => _onLongPressNode(node),
        );
      },
    );
  }

  Widget _centered(
    IconData icon,
    String text,
    Color color,
    String? actionLabel,
    VoidCallback? onAction,
  ) {
    final palette = AppPalette.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, size: 32, color: color),
            const SizedBox(height: AppSpacing.cardGap),
            Text(
              text,
              textAlign: TextAlign.center,
              style: AppText.body.copyWith(color: palette.textSecondary),
            ),
            if (actionLabel != null && onAction != null) ...<Widget>[
              const SizedBox(height: AppSpacing.cardGap),
              OutlinedButton(onPressed: onAction, child: Text(actionLabel)),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _onTapNode(VfsNode node) async {
    if (_selected.isNotEmpty) {
      setState(() {
        if (!_selected.remove(node.path)) _selected.add(node.path);
      });
      return;
    }
    if (!node.accessible) {
      _toast(node.reason.isEmpty ? '当前不可访问' : node.reason);
      return;
    }
    if (node.isDirectory) {
      _open(node.path);
      return;
    }
    if (VfsArchive.isArchivePath(node.name)) {
      // 压缩包点开是「浏览包内清单」，不是文本预览——用户点压缩包时想看的是里面有什么。
      await VfsArchiveSheet.show(
        context,
        archivePath: node.path,
        parentDir: VfsPath.parent(node.path),
      );
      return;
    }
    if (VfsArchive.isEncryptedPath(node.name)) {
      // 加密包点开要先解密——直接预览只会得到一堆二进制乱码。
      await _decryptArchive(node);
      return;
    }
    await _showPreview(node);
  }

  Future<void> _onLongPressNode(VfsNode node) async {
    setState(() {
      _selected.add(node.path);
    });
    final multi = _selected.length > 1;
    final actions = <VfsMenuAction>[
      if (!node.isDirectory)
        const VfsMenuAction('预览', Icons.visibility_outlined),
      if (!node.isDirectory && _isEditable(node))
        const VfsMenuAction('编辑', Icons.edit_note),
      const VfsMenuAction('复制到…', Icons.copy_outlined),
      const VfsMenuAction('移动到…', Icons.drive_file_move_outlined),
      const VfsMenuAction('重命名', Icons.drive_file_rename_outline),
      const VfsMenuAction('压缩为 ZIP…', Icons.folder_zip_outlined),
      if (node.name.toLowerCase().endsWith('.zip'))
        const VfsMenuAction('加密归档…', Icons.lock_outline),
      if (VfsArchive.isEncryptedPath(node.name))
        const VfsMenuAction('解密归档…', Icons.lock_open_outlined),
      const VfsMenuAction('加标签…', Icons.label_outline),
      const VfsMenuAction('属性', Icons.info_outline),
      const VfsMenuAction('删除', Icons.delete_outline, destructive: true),
    ];

    // 多选时给一条批量入口：批量重命名只对手动挑出来的这一组有意义，
    // 放进菜单比放进顶栏更贴手（顶栏位置会被误触）。
    if (_selected.length > 1) {
      actions.insertAll(
        0,
        <VfsMenuAction>[
          const VfsMenuAction('批量重命名…', Icons.drive_file_rename_outline),
          const VfsMenuAction('批量移动…', Icons.drive_file_move_outlined),
          const VfsMenuAction('批量删除', Icons.delete_outline, destructive: true),
        ],
      );
    }

    // APK 额外挂「系统管理」那几项。包名只能从归档清单里读，所以先解析一次；
    // 解析不出来就不加这些项——给一个点了没用的选项比不给更糟。
    ApkInfo? apk;
    if (!node.isDirectory && node.name.toLowerCase().endsWith('.apk')) {
      apk = await AppManager.readApk(node.path);
      if (apk != null && apk.pkg.isNotEmpty) {
        actions.insertAll(
          actions.length - 1,
          <VfsMenuAction>[
            const VfsMenuAction('提取应用信息', Icons.manage_search_outlined),
            const VfsMenuAction('冻结应用', Icons.ac_unit_outlined),
            const VfsMenuAction('禁用应用', Icons.block_outlined),
            const VfsMenuAction('卸载应用', Icons.delete_forever_outlined,
                destructive: true),
          ],
        );
      }
    }
    if (!mounted) return;

    final action = await VfsContextSheet.show(
      context,
      node: node,
      multiSelect: multi,
      actions: actions,
    );
    if (!mounted || action == null) return;

    switch (action.label) {
      case '批量重命名…':
        await _openBatchRename();
      case '批量移动…':
        await _batchMove();
      case '批量删除':
        await _batchDelete();
      case '预览':
        await _showPreview(node);
      case '编辑':
        await VfsTextEditor.show(
          context,
          node: node,
          onSaved: (String path) {
            _toast('已保存 $path');
            _open(_path);
          },
        );
      case '复制到…':
        await _copyOrMove(node, move: false);
      case '移动到…':
        await _copyOrMove(node, move: true);
      case '重命名':
        await _rename(node);
      case '压缩为 ZIP…':
        await _compressNode(node);
      case '加密归档…':
        await _encryptArchive(node);
      case '解密归档…':
        await _decryptArchive(node);
      case '加标签…':
        await _tagNode(node);
      case '属性':
        await _showProperties(node);
      case '删除':
        await _delete(node);
      case '提取应用信息':
        await _showApkInfo(apk);
      case '冻结应用':
        await _appAction(apk, AppManager.disable);
      case '禁用应用':
        await _appAction(apk, AppManager.disable);
      case '卸载应用':
        await _uninstallApk(apk);
    }
    if (mounted) await _open(_path);
  }

  Future<void> _appAction(
    ApkInfo? apk,
    Future<AppActionResult> Function(String pkg) action,
  ) async {
    if (apk == null || apk.pkg.isEmpty) return;
    final result = await action(apk.pkg);
    if (!mounted) return;
    if (result.ok) {
      _toast(result.message);
      return;
    }
    _toast(result.needsPrivilege
        ? '需要 Shizuku 权限才能执行该操作，请先激活 Shizuku'
        : result.message);
  }

  Future<void> _uninstallApk(ApkInfo? apk) async {
    if (apk == null || apk.pkg.isEmpty) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('卸载应用'),
        content: Text('确定卸载「${apk.label.isEmpty ? apk.pkg : apk.label}」吗？'
            '应用数据会一并删除。'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('卸载'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;
    final result = await AppManager.uninstall(apk.pkg);
    if (!mounted) return;
    _toast(result.ok
        ? result.message
        : result.needsPrivilege
            ? '需要 Shizuku 权限才能卸载应用，请先激活 Shizuku'
            : result.message);
  }

  Future<void> _showApkInfo(ApkInfo? apk) async {
    if (apk == null) return;
    final palette = AppPalette.of(context);
    final rows = <List<String>>[
      <String>['包名', apk.pkg],
      <String>['应用名', apk.label],
      <String>['版本', apk.versionName],
      <String>['版本号', apk.versionCode.toString()],
      <String>['大小', '${apk.sizeBytes} B'],
      <String>['最低 SDK', apk.minSdk.toString()],
      <String>['目标 SDK', apk.targetSdk.toString()],
      <String>['权限数', apk.permissions.length.toString()],
    ];
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(apk.label.isEmpty ? apk.pkg : apk.label),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                for (final row in rows)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.dense),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          row[0],
                          style:
                              AppText.micro.copyWith(color: palette.textFaint),
                        ),
                        const SizedBox(height: 2),
                        SelectableText(
                          row[1],
                          style: AppText.secondary
                              .copyWith(color: palette.textPrimary),
                        ),
                      ],
                    ),
                  ),
                if (apk.permissions.isNotEmpty) ...<Widget>[
                  const SizedBox(height: AppSpacing.dense),
                  Text(
                    '声明的权限',
                    style: AppText.micro.copyWith(color: palette.textFaint),
                  ),
                  const SizedBox(height: 4),
                  SelectableText(
                    apk.permissions.join('\n'),
                    style:
                        AppText.micro.copyWith(color: palette.textSecondary),
                  ),
                ],
              ],
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  /// 把一个条目压成 ZIP。
  ///
  /// 目标名默认取原名 + `.zip`，落在同一目录——用户最常见的意图就是
  /// 「把这个打成一包放在旁边」。
  Future<void> _compressNode(VfsNode node) async {
    final suggested = '${node.name}.zip';
    final name = await _askName('压缩为', suggested);
    if (name == null || name.trim().isEmpty) return;

    final target = VfsPath.join(VfsPath.parent(node.path), name.trim());
    try {
      final path = await VfsArchive.create(
        target,
        <String>[node.path],
        format: 'zip',
      );
      _toast('已生成 $path');
    } on VfsException catch (error) {
      _toast(error.message);
    } catch (error) {
      _toast('$error');
    }
    if (mounted) await _open(_path);
  }

  /// 私有目录的首次访问风险确认。
  ///
  /// 返回 true 表示可以继续访问。这里只**读**也要确认——读别人的 App 数据
  /// 虽然不破坏什么，但「你在看别人的私有数据」这件事本身需要用户知情。
  Future<bool> _confirmPrivateAccessIfNeeded(String normalized) async {
    final pkg = VfsPrivate.packageOf(normalized);
    if (pkg == null) return true;
    if (_vfs.policy.confirmedPrivatePackages.contains(pkg)) return true;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('访问应用私有目录'),
        content: Text(
          '你正在查看 $pkg 的私有数据目录。\n\n'
          '这些是别的 App 的内部数据（偏好配置、数据库、缓存等）。'
          '浏览本身不会修改它们，但请不要随意改动或外传——'
          '改坏了可能导致那个 App 起不来。',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('我了解，继续'),
          ),
        ],
      ),
    );
    if (confirmed != true) return false;

    final packages = List<String>.of(_vfs.policy.confirmedPrivatePackages)
      ..add(pkg);
    await _vfs.applyPolicy(
      _vfs.policy.copyWith(confirmedPrivatePackages: packages),
    );
    return true;
  }

  /// 给条目打标签。
  ///
  /// 标签是跨路径的归类——同一个标签可以同时挂在 Download 与 Documents 里的
  /// 文件上，所以这里只问「叫什么」，不问「在哪」。
  Future<void> _tagNode(VfsNode node) async {
    final name = await _askName('加标签', '');
    if (name == null || name.trim().isEmpty) return;
    await VfsOrganizationStore.tagPath(name.trim(), node.path);
    _toast('已给 ${node.name} 打上标签「${name.trim()}」');
  }

  /// 当前选中的条目（按列表顺序）。
  List<VfsNode> get _selectedNodes => _listing.nodes
      .where((VfsNode node) => _selected.contains(node.path))
      .toList();

  /// 批量移动。
  ///
  /// 逐个移动而不是打包成一个操作：打包后一个失败就全不知道成没成；
  /// 逐个做能把「搬了 7 个，2 个失败」如实报出来。
  Future<void> _batchMove() async {
    final nodes = _selectedNodes;
    if (nodes.isEmpty) return;
    final target = await _askTargetDir('批量移动到', initial: _path);
    if (!mounted || target == null || target.trim().isEmpty) return;

    var done = 0;
    var failed = 0;
    for (final node in nodes) {
      try {
        await _vfs.move(node.path, VfsPath.join(target.trim(), node.name));
        done++;
      } catch (_) {
        failed++;
      }
    }
    if (!mounted) return;
    _toast(failed > 0 ? '已移动 $done 项，失败 $failed 项' : '已移动 $done 项');
    await _open(_path);
  }

  /// 批量删除。
  ///
  /// 确认框里**列出要删的东西**——批量删除是不可逆的，只说「确定删除 8 项吗」
  /// 不足以让人判断该不该删，列出来才看得出有没有选错。
  Future<void> _batchDelete() async {
    final nodes = _selectedNodes;
    if (nodes.isEmpty) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text('删除 ${nodes.length} 项'),
        content: SizedBox(
          width: double.maxFinite,
          height: 300,
          child: ListView(
            children: <Widget>[
              for (final node in nodes)
                ListTile(
                  dense: true,
                  leading: Icon(
                    node.isDirectory
                        ? Icons.folder_outlined
                        : Icons.insert_drive_file_outlined,
                    size: 18,
                  ),
                  title: Text(
                    node.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              const Divider(height: 1),
              Text(
                '目录会被连同内容一起删除，此操作不可撤销。',
                style: AppText.micro.copyWith(
                  color: AppPalette.of(dialogContext).warning,
                ),
              ),
            ],
          ),
        ),
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

    var done = 0;
    var failed = 0;
    for (final node in nodes) {
      try {
        await _vfs.delete(node.path, recursive: node.isDirectory);
        done++;
      } catch (_) {
        failed++;
      }
    }
    if (!mounted) return;
    _toast(failed > 0 ? '已删除 $done 项，失败 $failed 项' : '已删除 $done 项');
    await _open(_path);
  }

  /// 问一个密码。加密时要求输入两遍——手输密码打错一个字，
  /// 产出的包自己都解不开，所以宁可多按一次。
  Future<String?> _askPassword({bool confirmTwice = false}) async {
    final controller = TextEditingController();
    final confirmController = TextEditingController();
    String? error;

    final result = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => StatefulBuilder(
        builder: (BuildContext context, StateSetter setState) => AlertDialog(
          title: Text(confirmTwice ? '设置密码' : '输入密码'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              TextField(
                controller: controller,
                autofocus: true,
                obscureText: true,
                decoration: const InputDecoration(hintText: '密码'),
              ),
              if (confirmTwice) ...<Widget>[
                const SizedBox(height: AppSpacing.dense),
                TextField(
                  controller: confirmController,
                  obscureText: true,
                  decoration: const InputDecoration(hintText: '再输一遍'),
                ),
              ],
              if (error != null) ...<Widget>[
                const SizedBox(height: AppSpacing.dense),
                Text(
                  error!,
                  style: AppText.micro.copyWith(
                    color: AppPalette.of(context).error,
                  ),
                ),
              ],
            ],
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () {
                final value = controller.text;
                if (value.isEmpty) {
                  setState(() => error = '密码不能为空');
                  return;
                }
                if (confirmTwice && value != confirmController.text) {
                  setState(() => error = '两次输入不一致');
                  return;
                }
                Navigator.of(dialogContext).pop(value);
              },
              child: const Text('确定'),
            ),
          ],
        ),
      ),
    );
    return result;
  }

  /// 把 zip 加密成 .khyenc。
  Future<void> _encryptArchive(VfsNode node) async {
    final password = await _askPassword(confirmTwice: true);
    if (!mounted || password == null) return;

    final target = VfsPath.join(
      VfsPath.parent(node.path),
      '${node.name}${VfsArchive.encryptedExtension}',
    );
    try {
      final path = await VfsArchive.encrypt(node.path, target, password);
      _toast('已加密为 ${VfsPath.basename(path)}');
    } on VfsException catch (error) {
      _toast(error.message);
    } catch (error) {
      _toast('$error');
    }
    if (mounted) await _open(_path);
  }

  /// 解密 .khyenc，得到同目录下的 zip。
  Future<void> _decryptArchive(VfsNode node) async {
    final password = await _askPassword();
    if (!mounted || password == null) return;

    final target = VfsPath.join(
      VfsPath.parent(node.path),
      node.name.replaceAll(
        RegExp(r'\.khyenc$', caseSensitive: false),
        '.zip',
      ),
    );
    try {
      final path = await VfsArchive.decrypt(node.path, target, password);
      _toast('已解密为 ${VfsPath.basename(path)}');
    } on VfsException catch (error) {
      _toast(error.message);
      return;
    } catch (error) {
      _toast('$error');
      return;
    }
    if (mounted) await _open(_path);
  }

  /// 算 AI 建议。只有「主动建议」档才做——被动档不该在界面上主动说话。
  void _computeSuggestions() {
    if (!_vfs.policy.aiLevel.suggests) {
      if (_suggestions.isNotEmpty) {
        setState(() => _suggestions = const <VfsSuggestion>[]);
      }
      return;
    }
    final suggestions = VfsSuggestions.analyze(_listing.nodes);
    if (!mounted) return;
    setState(() => _suggestions = suggestions);
  }

  /// 处理一条建议：列出涉及的文件，让人决定删哪些。
  Future<void> _handleSuggestion(VfsSuggestion suggestion) async {
    final nodes = _listing.nodes
        .where((VfsNode node) => suggestion.targets.contains(node.path))
        .toList();
    if (nodes.isEmpty) return;

    final selected = <String>{};
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => StatefulBuilder(
        builder: (BuildContext context, StateSetter setState) => AlertDialog(
          title: Text(suggestion.title),
          content: SizedBox(
            width: double.maxFinite,
            height: 320,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  suggestion.reason,
                  style: AppText.micro.copyWith(
                    color: AppPalette.of(context).textFaint,
                  ),
                ),
                const SizedBox(height: AppSpacing.dense),
                Expanded(
                  child: ListView(
                    children: <Widget>[
                      for (final node in nodes)
                        CheckboxListTile(
                          dense: true,
                          value: selected.contains(node.path),
                          onChanged: (bool? value) {
                            setState(() {
                              if (value == true) {
                                selected.add(node.path);
                              } else {
                                selected.remove(node.path);
                              }
                            });
                          },
                          title: Text(
                            node.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: Text(node.readableSize),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: selected.isEmpty
                  ? null
                  : () => Navigator.of(dialogContext).pop(true),
              child: Text('清理选中的 ${selected.length} 项'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || confirmed != true) return;

    var deleted = 0;
    var failed = 0;
    for (final path in selected) {
      final node = nodes.firstWhere((VfsNode n) => n.path == path);
      try {
        await _vfs.delete(path, recursive: node.isDirectory);
        deleted++;
      } catch (_) {
        failed++;
      }
    }
    if (!mounted) return;
    _toast(failed > 0 ? '已清理 $deleted 项，失败 $failed 项' : '已清理 $deleted 项');
    await _open(_path);
  }

  Future<void> _openBatchRename() async {
    final targets = _listing.nodes
        .where((VfsNode node) => _selected.contains(node.path))
        .toList();
    if (targets.isEmpty) return;

    // 同目录里已有哪些名字——冲突预检要拿它当依据。
    final existing = _listing.nodes
        .map((VfsNode node) => node.name)
        .toSet();

    await VfsBatchRenameSheet.show(
      context,
      nodes: targets,
      existingNames: existing,
      onApply: (List<RenamePlanItem> items) {
        // 成功/失败的计数由面板自己报（它知道失败了几项），这里只负责刷新列表。
        _open(_path);
      },
    );
  }

  /// 当前目录是否已加书签。
  bool get _isBookmarked =>
      _bookmarks.any((VfsBookmark bookmark) => bookmark.path == _path);

  /// 加书签 / 取消书签。
  ///
  /// 书签的名字默认取目录名，用户可以在弹窗里改——同一个路径叫「项目A」和叫
  /// 「Download」在侧栏里是两种完全不同的可读性。
  Future<void> _toggleBookmark() async {
    if (_isBookmarked) {
      await VfsOrganizationStore.removeBookmark(_path);
      await _reloadOrganization();
      _toast('已取消书签');
      return;
    }
    final suggested = VfsPath.basename(_path);
    final name = await _askName('添加书签', suggested);
    if (name == null || name.trim().isEmpty) return;
    await VfsOrganizationStore.addBookmark(_path, name.trim());
    await _reloadOrganization();
    _toast('已添加书签');
  }

  Future<void> _openTerminal() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext sheetContext) => VfsTerminalDrawer(
        cwd: _path,
        onCwdChanged: (_) {},
        onClose: () => Navigator.of(sheetContext).maybePop(),
      ),
    );
  }

  Future<void> _toggleRecorder() async {
    final recorder = OperationRecorder.instance;
    if (recorder.recording) {
      recorder.stop();
      setState(() {});
      await _showRecordingResult();
      return;
    }
    recorder.start();
    setState(() {});
    _toast('开始录制：接下来的文件操作会被收集成自动化脚本');
  }

  /// 录完之后把步骤摆出来，并允许存成脚本。
  ///
  /// 步骤必须**摆出来**：脚本是用户的文件操作用户有权看，录完直接静默存盘
  /// 等于「黑盒录制」。
  Future<void> _showRecordingResult() async {
    final recorder = OperationRecorder.instance;
    final steps = recorder.steps;
    if (steps.isEmpty) {
      _toast('没有录到操作');
      return;
    }

    final name = await _askName('保存自动化脚本', '我的文件流程');
    if (name == null || name.trim().isEmpty) {
      recorder.clear();
      return;
    }
    final script = recorder.export(name.trim());
    recorder.clear();
    if (script == null) {
      _toast('没有录到操作');
      return;
    }

    final existing = await AutomationScriptStore.load();
    await AutomationScriptStore.saveAll(<AutomationScript>[
      ...existing,
      script,
    ]);

    if (!mounted) return;
    final palette = AppPalette.of(context);
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.page),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                '已保存脚本「${script.name}」',
                style: AppText.cardTitle.copyWith(color: palette.textPrimary),
              ),
              const SizedBox(height: AppSpacing.cardGap),
              for (final step in script.steps)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(
                    step.description,
                    style:
                        AppText.secondary.copyWith(color: palette.textSecondary),
                  ),
                ),
              const SizedBox(height: AppSpacing.cardGap),
              Text(
                '触发方式：${script.trigger.label}'
                '${script.watchDir.isEmpty ? '' : '（监视 ${script.watchDir}）'}',
                style: AppText.micro.copyWith(color: palette.textFaint),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _showCreateMenu() async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ListTile(
              dense: true,
              leading: const Icon(Icons.create_new_folder_outlined, size: 20),
              title: const Text('新建目录'),
              onTap: () => Navigator.of(sheetContext).pop('mkdir'),
            ),
            ListTile(
              dense: true,
              leading: const Icon(Icons.note_add_outlined, size: 20),
              title: const Text('新建文本文件'),
              onTap: () => Navigator.of(sheetContext).pop('file'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || action == null) return;

    if (action == 'mkdir') {
      final name = await _askName('新建目录', '');
      if (name == null || name.trim().isEmpty) return;
      await _guard(() => _vfs.mkdir(VfsPath.join(_path, name.trim())));
    } else {
      final name = await _askName('新建文本文件', '新建文件.txt');
      if (name == null || name.trim().isEmpty) return;
      await _guard(() => _vfs.write(VfsPath.join(_path, name.trim()), ''));
    }
    if (mounted) await _open(_path);
  }

  Future<void> _showSearch() async {
    final controller = TextEditingController();
    final pattern = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('在当前目录搜索'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '文件名包含…'),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(controller.text),
            child: const Text('搜索'),
          ),
        ],
      ),
    );
    if (!mounted || pattern == null || pattern.trim().isEmpty) return;

    List<VfsNode> results;
    try {
      results = await _vfs.search(
        _path,
        namePattern: '*${pattern.trim()}*',
        maxResults: 200,
      );
    } on VfsException catch (error) {
      _toast(error.message);
      return;
    }
    if (!mounted) return;
    if (results.isEmpty) {
      _toast('没有匹配的文件');
      return;
    }
    await _showResults(results);
  }

  Future<void> _showResults(List<VfsNode> results) {
    final palette = AppPalette.of(context);
    return showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (BuildContext sheetContext) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.6,
        builder: (BuildContext scrollContext, ScrollController controller) {
          return ListView.builder(
            controller: controller,
            itemCount: results.length,
            itemBuilder: (BuildContext context, int index) {
              final node = results[index];
              return ListTile(
                dense: true,
                leading: Icon(
                  node.isDirectory
                      ? Icons.folder_outlined
                      : Icons.insert_drive_file_outlined,
                  size: 18,
                  color: palette.textSecondary,
                ),
                title: Text(node.name),
                subtitle: Text(node.path),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  _open(node.isDirectory ? node.path : VfsPath.parent(node.path));
                },
              );
            },
          );
        },
      ),
    );
  }

  Future<void> _showPreview(VfsNode node) async {
    VfsContent content;
    try {
      content = await _vfs.read(node.path, maxBytes: 256 * 1024);
    } on VfsException catch (error) {
      _toast(error.message);
      return;
    }
    if (!mounted) return;

    // 图片走图片预览：读出来的是 base64（原生侧判定为二进制），解出来直接显示。
    if (node.mime.startsWith('image/')) {
      await _showImagePreview(node, content);
      return;
    }

    final palette = AppPalette.of(context);
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(node.name),
        content: SizedBox(
          width: double.maxFinite,
          height: 320,
          child: content.binary
              ? Text(
                  '二进制文件，无法以文本预览',
                  style:
                      AppText.body.copyWith(color: palette.textSecondary),
                )
              : SingleChildScrollView(
                  child: SelectableText(
                    content.text.isEmpty ? '（空文件）' : content.text,
                    style: AppText.secondary.copyWith(color: palette.textPrimary),
                  ),
                ),
        ),
        actions: <Widget>[
          if (_isEditable(node))
            TextButton(
              onPressed: () {
                Navigator.of(dialogContext).pop();
                VfsTextEditor.show(
                  context,
                  node: node,
                  onSaved: (String path) {
                    _toast('已保存 $path');
                    _open(_path);
                  },
                );
              },
              child: const Text('编辑'),
            ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  /// 图片预览。
  ///
  /// 图片是二进制，原生侧返回 base64，这里解出来直接渲染。
  /// 解不开就退回「无法预览」——不拿一个坏图标糊弄。
  Future<void> _showImagePreview(VfsNode node, VfsContent content) async {
    final palette = AppPalette.of(context);
    Uint8List? bytes;
    if (content.base64.isNotEmpty) {
      try {
        bytes = base64Decode(content.base64);
      } catch (_) {
        bytes = null;
      }
    }

    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(node.name),
        content: SizedBox(
          width: double.maxFinite,
          height: 320,
          child: bytes == null
              ? Text(
                  '这个图片读不出来',
                  style: AppText.body.copyWith(color: palette.error),
                )
              : InteractiveViewer(
                  maxScale: 5,
                  child: Center(
                    child: Image.memory(
                      bytes,
                      fit: BoxFit.contain,
                      errorBuilder: (BuildContext context, Object error, StackTrace? stack) =>
                          Text(
                            '这个图片解不开',
                            style:
                                AppText.body.copyWith(color: palette.error),
                          ),
                    ),
                  ),
                ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  /// 这个文件能不能用内置编辑器改。
  ///
  /// 判据是「内容是文本」：MIME 是 text/*，或者扩展名在已知清单里。
  /// 二进制文件不给编辑入口——给一个必然把文件改坏的功能，比不给更糟。
  static bool _isEditable(VfsNode node) {
    if (node.isDirectory) return false;
    if (node.mime.startsWith('text/')) return true;
    final lower = node.name.toLowerCase();
    const extensions = <String>{
      '.txt', '.log', '.json', '.xml', '.yaml', '.yml', '.conf', '.ini',
      '.properties', '.md', '.csv', '.sh', '.js', '.dart', '.kt', '.java',
      '.gradle', '.toml', '.env',
    };
    for (final extension in extensions) {
      if (lower.endsWith(extension)) return true;
    }
    return false;
  }

  Future<void> _showProperties(VfsNode node) async {
    final node0 = await _vfs.stat(node.path) ?? node;
    String digest = '';
    try {
      digest = await _vfs.hash(node.path, algorithm: 'sha256');
    } catch (_) {
      // 哈希失败不该挡住属性展示——属性本身已经拿到了。
    }
    if (!mounted) return;

    final palette = AppPalette.of(context);
    final rows = <List<String>>[
      <String>['路径', node0.path],
      <String>['类型', node0.isDirectory ? '目录' : '文件'],
      <String>['大小', node0.isDirectory ? '—' : node0.readableSize],
      <String>['权限', node0.mode.isEmpty ? '—' : node0.mode],
      <String>['属主', node0.owner.isEmpty ? '—' : '${node0.owner}:${node0.group}'],
      <String>['SELinux', node0.selinux.isEmpty ? '—' : node0.selinux],
      <String>['类型标识', node0.mime],
      <String>['SHA-256', digest.isEmpty ? '—' : digest],
    ];

    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(node0.name),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                for (final row in rows)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.dense),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          row[0],
                          style: AppText.micro.copyWith(color: palette.textFaint),
                        ),
                        const SizedBox(height: 2),
                        SelectableText(
                          row[1],
                          style: AppText.secondary
                              .copyWith(color: palette.textPrimary),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  /// 问一个目标目录。
  ///
  /// 输入框 + 「浏览」两条路：手打适合复制粘贴来的路径，浏览适合「上次那个目录」。
  /// 只给输入框的话，用户要么手打一长串绝对路径，要么放弃这个功能。
  Future<String?> _askTargetDir(
    String title, {
    String initial = '',
  }) async {
    final controller = TextEditingController(text: initial);
    final result = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(title),
        content: Row(
          children: <Widget>[
            Expanded(
              child: TextField(
                controller: controller,
                autofocus: true,
                decoration: const InputDecoration(hintText: '目标目录绝对路径'),
              ),
            ),
            const SizedBox(width: AppSpacing.dense),
            IconButton(
              onPressed: () async {
                final picked = await VfsFolderPicker.pick(
                  dialogContext,
                  initialPath: controller.text.isEmpty
                      ? VfsRoots.storage
                      : controller.text,
                  title: title,
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
            child: const Text('确定'),
          ),
        ],
      ),
    );
    return result;
  }

  Future<void> _copyOrMove(VfsNode node, {required bool move}) async {
    final target = await _askTargetDir(
      move ? '移动到' : '复制到',
      initial: VfsPath.parent(node.path),
    );
    if (!mounted || target == null || target.trim().isEmpty) return;

    final destination = VfsPath.join(target.trim(), node.name);
    if (!move) {
      // 复制走异步通道：目录大时是分钟级操作，用户要看得见进度、也要能停。
      final taskId = await VfsCopyTasks.instance.start(
        src: node.path,
        dst: destination,
        conflict: _vfs.policy.defaultConflict,
        resume: true,
      );
      if (!mounted) return;
      if (taskId == null) {
        _toast('复制失败：源不存在，或目标位置不可写');
        return;
      }
      await VfsCopyProgressSheet.show(
        context,
        taskId: taskId,
        onFinished: (CopyProgress progress) {
          if (progress.phase == 'done') {
            _toast('已复制到 $destination');
          } else if (progress.phase == 'cancelled') {
            _toast('已取消复制，下次可继续');
          } else if (progress.phase == 'error') {
            _toast('复制出错：${progress.current}');
          }
          _open(_path);
        },
      );
      return;
    }

    await _guard(() async {
      await _vfs.move(node.path, destination);
    });
  }

  Future<void> _rename(VfsNode node) async {
    final name = await _askName('重命名', node.name);
    if (name == null || name.trim().isEmpty) return;
    final target = VfsPath.join(VfsPath.parent(node.path), name.trim());
    await _guard(() => _vfs.rename(node.path, target));
  }

  Future<void> _delete(VfsNode node) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('删除'),
        content: Text('确定要删除「${node.name}」吗？此操作不可撤销。'),
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
    await _guard(
      () => _vfs.delete(node.path, recursive: node.isDirectory),
    );
  }

  Future<String?> _askName(String title, String initial) {
    final controller = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '名称'),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(controller.text),
            child: const Text('确定'),
          ),
        ],
      ),
    );
  }

  Future<void> _guard(Future<void> Function() action) async {
    try {
      await action();
    } on VfsException catch (error) {
      _toast(error.message);
    } catch (error) {
      _toast('$error');
    }
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  void _showShizukuGuide() {
    _toast('在设置里激活 Shizuku 后即可访问应用私有目录与系统分区');
  }

  Future<void> _openAiPanel() async {
    final recent = await VfsAuditLog.instance.recent(limit: 5);
    if (!mounted) return;
    await VfsAiSheet.show(
      context,
      vfsContext: VfsContext(
        currentPath: _path,
        selectedPaths: _selected.toList(),
        recentOps: recent,
      ),
      onExecuted: (AiPlanResult result) {
        _toast(result.allOk
            ? '已执行 ${result.steps.length} 项操作'
            : '${result.failedCount} 项执行失败');
        _open(_path);
      },
    );
  }
}
