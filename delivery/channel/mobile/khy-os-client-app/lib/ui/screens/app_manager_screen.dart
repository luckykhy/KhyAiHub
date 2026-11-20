// 系统应用管理面板。
//
// 这是「系统管理」能力在文件管理器里的落点：不是独立模块，而是文件管理器侧栏里
// 的一个入口——因为用户通常是从「这个 APK 是谁的 / 能不能卸」这个问题走进来的。
//
// 权限现实写在界面上：冻结 / 启用 / 卸载 / 提取信息都要以 uid 2000 执行
// （pm / dumpsys），所以提权代理不可用时这些入口**先置灰**，并在列表上方给出
// 激活引导；只有「启动」这类纯应用层操作始终可点。失败兜底文案仍保留——置灰
// 挡的是"点了才知道不行"，挡不住探测之后状态又变了。

import 'package:flutter/material.dart';

import '../../core/services/device_control.dart';
import '../../core/vfs/app_manager.dart';
import '../theme/design_tokens.dart';
import '../widgets/vfs/vfs_elevation_guide.dart';

/// 应用列表筛选。
enum _AppFilter {
  all('全部'),
  user('用户应用'),
  system('系统应用');

  const _AppFilter(this.label);
  final String label;
}

/// 系统应用管理页。
class AppManagerScreen extends StatefulWidget {
  const AppManagerScreen({super.key});

  @override
  State<AppManagerScreen> createState() => _AppManagerScreenState();
}

class _AppManagerScreenState extends State<AppManagerScreen> {
  final TextEditingController _search = TextEditingController();
  List<ManagedApp> _apps = const <ManagedApp>[];
  _AppFilter _filter = _AppFilter.all;
  bool _loading = true;

  /// 精简模式：按安装包体积排系统应用，勾选后一键禁用。
  bool _cleanupMode = false;
  List<ManagedAppSize> _cleanupApps = const <ManagedAppSize>[];
  final Set<String> _cleanupSelected = <String>{};

  /// 提权代理当前是否值得一试（available || online）。
  ///
  /// 初值 false：探测回来之前宁可先灰着——反过来的话，用户点下去那一刻
  /// 正好撞上"探测还没回来"，又退回"点了才报错"。
  bool _canElevate = false;

  @override
  void initState() {
    super.initState();
    _load();
    _loadElevation();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final apps = await AppManager.list(
      query: _search.text.trim(),
      onlySystem: _filter == _AppFilter.system,
      onlyUser: _filter == _AppFilter.user,
    );
    if (!mounted) return;
    setState(() {
      _apps = apps;
      _loading = false;
    });
  }

  /// 读一次提权状态。原生侧读的是缓存（零 IO），不会在这次调用里再去提权。
  Future<void> _loadElevation() async {
    final status = await DeviceControl.getElevationStatus();
    if (!mounted) return;
    setState(() => _canElevate = status.canAttempt);
  }

  /// 刷新按钮：应用列表与提权状态一起重读。
  Future<void> _refresh() async {
    await Future.wait(<Future<void>>[
      _loadElevation(),
      _cleanupMode ? _loadCleanup() : _load(),
    ]);
  }

  /// 打开提权激活引导；引导关掉后重读状态——用户可能刚在里面拉起了代理。
  Future<void> _openElevationGuide() async {
    await VfsElevationGuideSheet.show(context);
    if (!mounted) return;
    await _loadElevation();
  }

  /// 载入精简清单。
  ///
  /// 按**安装包体积**排，不是按使用频率。
  ///
  /// 为什么不是使用频率：那要读 `dumpsys usagestats`，走 提权代理 提权通道——
  /// **不是做不到，是本版没做**（解析那份输出的工作量不小，而「按体积排」
  /// 已经能回答「哪些系统应用最占地方」这个主问题）。提权代理 未激活时
  /// 连体积也排不出来，那时按名字排。
  ///
  /// 原先这里写的是「那要 Usage Access 系统权限，普通应用拿不到」——
  /// 那句话过于绝对：本 App 已经要求 提权代理，`dumpsys ` 也在原生白名单里。
  /// 把条件性能力说成不可能，会让后人不再考虑这条路。
  Future<void> _loadCleanup() async {
    setState(() => _loading = true);
    final apps = await AppManager.listSystemAppsBySize();
    if (!mounted) return;
    setState(() {
      _cleanupApps = apps;
      _loading = false;
    });
  }

  /// 切换精简模式。
  void _toggleCleanup() {
    setState(() {
      _cleanupMode = !_cleanupMode;
      _cleanupSelected.clear();
    });
    if (_cleanupMode) _loadCleanup();
  }

  /// 禁用所选的系统应用。
  Future<void> _disableSelected() async {
    final targets = _cleanupApps
        .where((ManagedAppSize item) => _cleanupSelected.contains(item.app.pkg))
        .toList();
    if (targets.isEmpty) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text('禁用 ${targets.length} 个应用'),
        content: SizedBox(
          width: double.maxFinite,
          height: 260,
          child: ListView(
            children: <Widget>[
              for (final item in targets)
                ListTile(
                  dense: true,
                  title: Text(item.app.displayName),
                  subtitle: Text(item.app.pkg),
                ),
              const Divider(height: 1),
              Text(
                '禁用后应用不会出现在桌面上，数据仍保留；可以在系统设置里恢复。',
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
            child: const Text('禁用'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;

    var done = 0;
    var failed = 0;
    for (final item in targets) {
      final result = await AppManager.disable(item.app.pkg);
      if (result.ok) {
        done++;
      } else {
        failed++;
      }
    }
    if (!mounted) return;
    _toast(failed > 0 ? '已禁用 $done 个，失败 $failed 个' : '已禁用 $done 个');
    await _loadCleanup();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_cleanupMode ? '精简' : '应用管理'),
        actions: <Widget>[
          IconButton(
            onPressed: _toggleCleanup,
            icon: Icon(_cleanupMode ? Icons.list_alt : Icons.cleaning_services_outlined),
            tooltip: _cleanupMode ? '返回应用列表' : '精简',
          ),
          IconButton(
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          if (!_canElevate) _elevationHint(context),
          Expanded(
            child: _cleanupMode ? _cleanupBody(context) : _listBody(context),
          ),
        ],
      ),
    );
  }

  /// 提权代理不可用时，压在列表上方的替代提示。
  ///
  /// 这一条替代的是过去那句"需要 提权代理 权限才能执行该操作，请先激活 提权代理"——
  /// 那句话只在失败之后出现，用户得先点一次错的入口。
  Widget _elevationHint(BuildContext context) {
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
        horizontal: AppSpacing.cardGap,
        vertical: AppSpacing.dense,
      ),
      decoration: BoxDecoration(
        color: palette.surfaceHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: palette.stroke),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(Icons.lock_outline, size: 16, color: palette.textFaint),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Text(
              '冻结 / 启用 / 卸载 / 提取信息 需要 uid 2000（提权代理），当前不可用，'
              '这些入口已置灰。「启动」不受影响。',
              style: AppText.micro.copyWith(color: palette.textSecondary),
            ),
          ),
          TextButton(
            onPressed: _openElevationGuide,
            child: const Text('如何激活'),
          ),
        ],
      ),
    );
  }

  /// 常规应用列表。
  Widget _listBody(BuildContext context) {
    final palette = AppPalette.of(context);
    return Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.page,
              AppSpacing.cardGap,
              AppSpacing.page,
              AppSpacing.dense,
            ),
            child: TextField(
              controller: _search,
              decoration: const InputDecoration(
                isDense: true,
                hintText: '搜索应用名或包名',
                prefixIcon: Icon(Icons.search, size: 18),
              ),
              onSubmitted: (_) => _load(),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.page),
            child: Row(
              children: <Widget>[
                for (final filter in _AppFilter.values)
                  Padding(
                    padding: const EdgeInsets.only(right: AppSpacing.dense),
                    child: ChoiceChip(
                      label: Text(filter.label),
                      selected: _filter == filter,
                      onSelected: (_) {
                        setState(() => _filter = filter);
                        _load();
                      },
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.cardGap),
          Expanded(
            child: _loading
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
                : _apps.isEmpty
                    ? Center(
                        child: Text(
                          '没有匹配的应用',
                          style:
                              AppText.body.copyWith(color: palette.textFaint),
                        ),
                      )
                    : ListView.builder(
                        itemCount: _apps.length,
                        itemBuilder: (BuildContext context, int index) {
                          final app = _apps[index];
                          return ListTile(
                            dense: true,
                            leading: CircleAvatar(
                              radius: 16,
                              backgroundColor: palette.surfaceHigh,
                              child: Icon(
                                Icons.android,
                                size: 18,
                                color: app.isSystem
                                    ? palette.textFaint
                                    : palette.primary,
                              ),
                            ),
                            title: Text(
                              app.displayName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AppText.body
                                  .copyWith(color: palette.textPrimary),
                            ),
                            subtitle: Text(
                              app.pkg,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style:
                                  AppText.micro.copyWith(color: palette.textFaint),
                            ),
                            trailing: PopupMenuButton<String>(
                              onSelected: (String action) =>
                                  _onAction(app, action),
                              itemBuilder: (BuildContext context) =>
                                  <PopupMenuEntry<String>>[
                                const PopupMenuItem<String>(
                                  value: 'launch',
                                  child: Text('启动'),
                                ),
                                PopupMenuItem<String>(
                                  value: 'disable',
                                  enabled: _canElevate,
                                  child: const Text('冻结'),
                                ),
                                PopupMenuItem<String>(
                                  value: 'enable',
                                  enabled: _canElevate,
                                  child: const Text('启用'),
                                ),
                                PopupMenuItem<String>(
                                  value: 'info',
                                  enabled: _canElevate,
                                  child: const Text('提取信息'),
                                ),
                                const PopupMenuDivider(),
                                PopupMenuItem<String>(
                                  value: 'uninstall',
                                  enabled: _canElevate,
                                  child: const Text('卸载'),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
          ),
        ],
      );
  }

  /// 精简视图：系统应用按安装包体积排序，勾选后一键禁用。
  Widget _cleanupBody(BuildContext context) {
    final palette = AppPalette.of(context);
    return Column(
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.page,
            AppSpacing.cardGap,
            AppSpacing.page,
            AppSpacing.dense,
          ),
          child: Text(
            '按安装包体积排序的系统应用。'
            '（按使用频率排序需要读取系统 usage 统计，本版未提供。）',
            style: AppText.micro.copyWith(color: palette.textFaint),
          ),
        ),
        Expanded(
          child: _loading
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
              : _cleanupApps.isEmpty
                  ? Center(
                      child: Text(
                        '没有可精简的系统应用',
                        style:
                            AppText.body.copyWith(color: palette.textFaint),
                      ),
                    )
                  : ListView.builder(
                      itemCount: _cleanupApps.length,
                      itemBuilder: (BuildContext context, int index) {
                        final item = _cleanupApps[index];
                        final selected =
                            _cleanupSelected.contains(item.app.pkg);
                        return CheckboxListTile(
                          dense: true,
                          value: selected,
                          onChanged: (bool? value) {
                            setState(() {
                              if (value == true) {
                                _cleanupSelected.add(item.app.pkg);
                              } else {
                                _cleanupSelected.remove(item.app.pkg);
                              }
                            });
                          },
                          title: Text(
                            item.app.displayName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style:
                                AppText.body.copyWith(color: palette.textPrimary),
                          ),
                          subtitle: Text(
                            '${_readable(item.apkBytes)} · ${item.app.pkg}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppText.micro
                                .copyWith(color: palette.textFaint),
                          ),
                        );
                      },
                    ),
        ),
        if (_cleanupSelected.isNotEmpty)
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.page),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _canElevate ? _disableSelected : null,
                  child: Text('禁用所选 ${_cleanupSelected.length} 个'),
                ),
              ),
            ),
          ),
      ],
    );
  }

  static String _readable(int bytes) {
    if (bytes <= 0) return '体积未知';
    if (bytes < 1024) return '$bytes B';
    const units = <String>['KB', 'MB', 'GB'];
    var value = bytes / 1024;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return '${value.toStringAsFixed(value >= 100 ? 0 : 1)} ${units[unit]}';
  }

  Future<void> _onAction(ManagedApp app, String action) async {
    switch (action) {
      case 'launch':
        final result = await AppManager.launch(app.pkg);
        _toast(result.message);
      case 'disable':
        final result = await AppManager.disable(app.pkg);
        _toast(result.ok ? result.message : _explain(result));
      case 'enable':
        final result = await AppManager.enable(app.pkg);
        _toast(result.ok ? result.message : _explain(result));
      case 'uninstall':
        final confirmed = await _confirmUninstall(app);
        if (!confirmed) return;
        final result = await AppManager.uninstall(app.pkg);
        _toast(result.ok ? result.message : _explain(result));
        await _load();
      case 'info':
        final info = await AppManager.dumpInfo(app.pkg);
        await _showInfo(app, info);
    }
  }

  /// 失败原因要说人话。
  ///
  /// 权限不足是最常见的一种，单独提示「需要 提权代理」比把英文 Permission Denial
  /// 甩给用户有用得多。
  String _explain(AppActionResult result) {
    if (result.needsPrivilege) {
      return '需要 提权代理 权限才能执行该操作，请先激活 提权代理';
    }
    return result.message;
  }

  Future<bool> _confirmUninstall(ManagedApp app) async {
    final answer = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('卸载应用'),
        content: Text('确定卸载「${app.displayName}」吗？应用数据会一并删除。'),
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
    return answer == true;
  }

  Future<void> _showInfo(ManagedApp app, String info) async {
    final palette = AppPalette.of(context);
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: Text(app.displayName),
        content: SizedBox(
          width: double.maxFinite,
          height: 360,
          child: SingleChildScrollView(
            child: SelectableText(
              info.isEmpty ? '没有取到信息' : info,
              style: AppText.micro.copyWith(color: palette.textSecondary),
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

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }
}
