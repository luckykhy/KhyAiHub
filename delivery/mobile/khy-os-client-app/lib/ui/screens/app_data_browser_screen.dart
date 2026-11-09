// 应用数据浏览器：私有目录的结构化视图。
//
// 三层导航：应用列表 → 某个包的文件 → 单个文件的结构化内容。
// 「结构化」是关键——SharedPreferences 给键值表、JSON 给展开的键值表、
// SQLite 给表与行，其它给文本预览。用户要看的是「里面有什么」，不是一坨二进制。
//
// 权限现实写在界面上：私有目录要 Shizuku。没激活时这一层显示灰色占位符 +
// 「点击激活访问」引导，和 VFS 其它地方一致。

import 'package:flutter/material.dart';

import '../../core/vfs/app_data_browser.dart';
import '../../core/vfs/sqlite_inspector.dart';
import '../../core/vfs/vfs_node.dart';
import '../../core/vfs/vfs_policy.dart';
import '../../core/vfs/vfs_route.dart';
import '../../core/vfs/vfs_service.dart';
import '../theme/design_tokens.dart';
import '../widgets/vfs/vfs_folder_picker.dart';

/// 应用数据浏览器页。
class AppDataBrowserScreen extends StatefulWidget {
  const AppDataBrowserScreen({super.key});

  @override
  State<AppDataBrowserScreen> createState() => _AppDataBrowserScreenState();
}

class _AppDataBrowserScreenState extends State<AppDataBrowserScreen> {
  /// 导航栈：每一项是一个「层」。
  final List<_DataLevel> _stack = <_DataLevel>[];

  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadPackages();
  }

  Future<void> _loadPackages() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final packages = await AppDataBrowser.listPackages();
      if (!mounted) return;
      setState(() {
        _stack
          ..clear()
          ..add(_DataLevel.packages(packages));
        _loading = false;
      });
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

  Future<void> _openPackage(VfsNode pkg) async {
    setState(() => _loading = true);
    try {
      final files = await AppDataBrowser.listAppFiles(pkg.name);
      if (!mounted) return;
      setState(() {
        _stack.add(_DataLevel.files(pkg, files));
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
    final level = _stack.isEmpty ? null : _stack.last;

    return Scaffold(
      appBar: AppBar(
        title: Text(level?.title ?? '应用数据'),
        leading: _stack.length > 1
            ? IconButton(
                onPressed: () => setState(() => _stack.removeLast()),
                icon: const Icon(Icons.arrow_back),
              )
            : null,
        actions: <Widget>[
          IconButton(
            onPressed: _loadPackages,
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
          : _error != null
              ? _message(_error!, palette.error, '重试', _loadPackages)
              : level == null
                  ? _message('没有可浏览的应用数据', palette.textFaint, null, null)
                  : _buildLevel(context, level),
    );
  }

  Widget _buildLevel(BuildContext context, _DataLevel level) {
    switch (level.kind) {
      case _DataLevelKind.packages:
        return _packageList(context, level);
      case _DataLevelKind.files:
        return _fileList(context, level);
      case _DataLevelKind.detail:
        return _detail(context, level);
    }
  }

  Widget _packageList(BuildContext context, _DataLevel level) {
    final palette = AppPalette.of(context);
    final packages = level.packages;
    if (packages.isEmpty) {
      return _message(
        '这里没有应用数据（可能需要 Shizuku 才能看到私有目录）',
        palette.textFaint,
        null,
        null,
      );
    }
    return ListView.builder(
      itemCount: packages.length,
      itemBuilder: (BuildContext context, int index) {
        final pkg = packages[index];
        return ListTile(
          dense: true,
          leading: Icon(Icons.apps_outlined, size: 20, color: palette.primary),
          title: Text(
            pkg.name,
            style: AppText.body.copyWith(color: palette.textPrimary),
          ),
          onTap: () => _openPackage(pkg),
        );
      },
    );
  }

  Widget _fileList(BuildContext context, _DataLevel level) {
    final palette = AppPalette.of(context);
    final files = level.files;
    if (files.isEmpty) {
      return _message('这个包的私有目录是空的', palette.textFaint, null, null);
    }
    return ListView.builder(
      itemCount: files.length,
      itemBuilder: (BuildContext context, int index) {
        final node = files[index];
        final kind = AppDataBrowser.classify(node, level.pkg?.name ?? '');
        return ListTile(
          dense: true,
          leading: Icon(
            node.isDirectory
                ? Icons.folder_outlined
                : kind == AppDataKind.sqlite
                    ? Icons.storage_outlined
                    : Icons.description_outlined,
            size: 20,
            color: palette.textSecondary,
          ),
          title: Text(
            node.name,
            style: AppText.body.copyWith(color: palette.textPrimary),
          ),
          subtitle: Text(
            node.isDirectory ? '目录' : kind.label,
            style: AppText.micro.copyWith(color: palette.textFaint),
          ),
          trailing: node.isDirectory
              ? null
              : Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    IconButton(
                      onPressed: () => _importOverwrite(node),
                      icon: const Icon(Icons.file_present_outlined, size: 18),
                      color: palette.textFaint,
                      tooltip: '从公共存储导入覆盖',
                    ),
                    IconButton(
                      onPressed: () => _export(node),
                      icon: const Icon(Icons.download_outlined, size: 18),
                      color: palette.textFaint,
                      tooltip: '导出到公共存储',
                    ),
                  ],
                ),
          onTap: node.isDirectory ? null : () => _openDetail(node, kind),
        );
      },
    );
  }

  Widget _detail(BuildContext context, _DataLevel level) {
    final palette = AppPalette.of(context);
    final entries = level.entries;
    if (entries == null) {
      return _message(
        level.detailMessage.isEmpty ? '无法解析这个文件' : level.detailMessage,
        palette.warning,
        null,
        null,
      );
    }
    if (entries.isEmpty) {
      return _message('这个文件里没有可展示的键值', palette.textFaint, null, null);
    }
    return ListView.builder(
      itemCount: entries.length,
      itemBuilder: (BuildContext context, int index) {
        final entry = entries[index];
        return ListTile(
          dense: true,
          title: Text(
            entry.key,
            style: AppText.body.copyWith(color: palette.textPrimary),
          ),
          subtitle: SelectableText(
            entry.value.isEmpty ? '（空）' : entry.value,
            style: AppText.micro.copyWith(color: palette.textSecondary),
          ),
          trailing: Text(
            entry.type,
            style: AppText.micro.copyWith(color: palette.textFaint),
          ),
        );
      },
    );
  }

  Widget _message(
    String text,
    Color color,
    String? actionLabel,
    VoidCallback? onAction,
  ) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              text,
              textAlign: TextAlign.center,
              style: AppText.body.copyWith(color: color),
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

  /// 打开单个文件，解析成结构化内容。
  Future<void> _openDetail(VfsNode node, AppDataKind kind) async {
    // 敏感子目录（偏好配置、数据库）要二次确认：这些是别的 App 的运行状态，
    // 看一眼和改一下不是一回事——多一道确认，让人知道自己正在碰哪类数据。
    if (kind == AppDataKind.sharedPreferences ||
        kind == AppDataKind.sqlite) {
      final ok = await _confirmSensitive(node);
      if (!ok || !mounted) return;
    }

    setState(() => _loading = true);

    List<ConfigEntry>? entries;
    var message = '';

    try {
      switch (kind) {
        case AppDataKind.sharedPreferences:
          final content = await VfsService.instance.read(node.path);
          entries = AppDataBrowser.parseSharedPreferences(content.text);
        case AppDataKind.json:
          final content = await VfsService.instance.read(node.path);
          entries = AppDataBrowser.parseJsonConfig(content.text);
          if (entries.isEmpty) message = '这个 JSON 里没有可展示的键值';
        case AppDataKind.sqlite:
          final tables = await SqliteInspector.inspect(node.path);
          if (tables.isEmpty) {
            message = '打不开这个数据库（或里面没有表）';
          } else {
            entries = _tablesAsEntries(tables);
          }
        case AppDataKind.text:
        case AppDataKind.binary:
        case AppDataKind.directory:
          final content = await VfsService.instance.read(node.path);
          entries = <ConfigEntry>[
            ConfigEntry(key: node.name, value: content.text, type: 'text'),
          ];
      }
    } catch (error) {
      message = '$error';
      entries = null;
    }

    if (!mounted) return;
    setState(() {
      _stack.add(_DataLevel.detail(node, entries, message));
      _loading = false;
    });
  }

  /// 敏感子目录的二次确认。
  Future<bool> _confirmSensitive(VfsNode node) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('打开敏感数据'),
        content: Text(
          '「${node.name}」属于该 App 的敏感数据'
          '（偏好配置 / 数据库）。\n\n'
          '这里只做只读查看，不会修改原文件；但请不要把里面的内容外传。',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('只读查看'),
          ),
        ],
      ),
    );
    return result == true;
  }

  /// 把数据库的表与行展平成键值列表。
  ///
  /// 展平成「表名.列名 → 值」的扁平结构，是为了复用同一张表来展示——
  /// 结构化视图的价值在于「能一眼扫」，不是在于保留嵌套。
  static List<ConfigEntry> _tablesAsEntries(List<SqliteTable> tables) {
    final entries = <ConfigEntry>[];
    for (final table in tables) {
      for (var i = 0; i < table.rows.length; i++) {
        final row = table.rows[i];
        for (var c = 0; c < row.length; c++) {
          final column = c < table.columns.length
              ? table.columns[c]
              : 'col$c';
          entries.add(ConfigEntry(
            key: '${table.name}[$i].$column',
            value: row[c]?.toString() ?? 'null',
            type: row[c]?.runtimeType.toString() ?? 'null',
          ));
        }
      }
    }
    return entries;
  }

  /// 提示条。
  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  /// 从公共存储导入覆盖一个私有目录里的文件。
  ///
  /// 方向与导出相反：公共存储 → 私有目录。这是**跨权限写**——写的是别的 App 的
  /// 数据，所以要 Shizuku、要用户明确选源文件、还要再确认一次覆盖。
  /// 三道关卡少一道都可能把那个 App 的配置改坏。
  Future<void> _importOverwrite(VfsNode node) async {
    final source = await VfsFolderPicker.pick(
      context,
      initialPath: VfsRoots.storage,
      title: '选择要导入的文件',
      mode: VfsPickMode.file,
    );
    if (!mounted || source == null || source.isEmpty) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('导入并覆盖'),
        content: Text(
          '用「${VfsPath.basename(source)}」覆盖\n'
          '「${node.name}」？\n\n'
          '这会改写该 App 的私有数据，可能让它起不来。',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('覆盖'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;

    try {
      await VfsService.instance.copy(
        source,
        node.path,
        conflict: VfsConflict.overwrite,
      );
      if (!mounted) return;
      _toast('已导入并覆盖 ${node.name}');
      await _openDetail(node, AppDataBrowser.classify(node, ''));
    } catch (error) {
      if (!mounted) return;
      _toast('导入失败：$error');
    }
  }

  /// 导出到公共存储——跨权限操作，要用户选目标目录。
  Future<void> _export(VfsNode node) async {
    final controller = TextEditingController(text: VfsRoots.storage);
    final target = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('导出到公共存储'),
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
                  title: '导出到',
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
            child: const Text('导出'),
          ),
        ],
      ),
    );
    if (!mounted || target == null || target.trim().isEmpty) return;

    try {
      final path = await AppDataBrowser.exportTo(node.path, target.trim());
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已导出到 $path')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('导出失败：$error')),
      );
    }
  }
}

/// 导航层种类。
enum _DataLevelKind { packages, files, detail }

/// 一层导航。
class _DataLevel {
  final _DataLevelKind kind;
  final String title;
  final List<VfsNode> packages;
  final List<VfsNode> files;
  final VfsNode? pkg;
  final List<ConfigEntry>? entries;
  final String detailMessage;

  _DataLevel.packages(List<VfsNode> items)
      : kind = _DataLevelKind.packages,
        title = '应用数据',
        packages = items,
        files = const <VfsNode>[],
        pkg = null,
        entries = null,
        detailMessage = '';

  _DataLevel.files(VfsNode owner, List<VfsNode> items)
      : kind = _DataLevelKind.files,
        title = owner.name,
        packages = const <VfsNode>[],
        files = items,
        pkg = owner,
        entries = null,
        detailMessage = '';

  _DataLevel.detail(VfsNode node, List<ConfigEntry>? items, String message)
      : kind = _DataLevelKind.detail,
        title = node.name,
        packages = const <VfsNode>[],
        files = const <VfsNode>[],
        pkg = null,
        entries = items,
        detailMessage = message;
}
