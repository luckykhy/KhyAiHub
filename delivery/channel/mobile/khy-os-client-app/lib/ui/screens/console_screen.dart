import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/services/console_service.dart';
import '../../core/services/device_control.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import '../widgets/khy_brand_mark.dart';
import 'permission_center_screen.dart';

/// khy-os 本地控制台：输入一条 JSON 命令，本地解析 → 校验 → 执行 → 结果显示。
///
/// 定位：khy-os 先是通用执行器，对话只是它的一种用法。所以这一屏的入口是
/// 品牌标 + 命令输入区，Amoo 只是这里一个可选按钮，不是默认入口。
///
/// 三类失败在界面上必须看起来就不同，因为三者的处置完全不同：
/// 参数不合法 → 改命令；工具不可用 → 去授权；执行报错 → 读错误详情。
/// 混成一句「失败」，用户不知道该改哪边。
class ConsoleScreen extends StatefulWidget {
  const ConsoleScreen({super.key, this.visibleTick = 0});

  /// 宿主页签索引，见 [DeviceScreenNew.visibleTick] 的说明：IndexedStack 让
  /// 四个页签同时活着，切页只换谁被画、不重建子 State，所以「变成可见」必须
  /// 由宿主显式递数——授权位（无障碍）在权限中心/设置页/系统设置里改，
  /// 回到本页横幅不能再挂旧结论。
  final int visibleTick;

  @override
  State<ConsoleScreen> createState() => _ConsoleScreenState();
}

class _ConsoleScreenState extends State<ConsoleScreen>
    with WidgetsBindingObserver {
  final _input = TextEditingController();
  final _focus = FocusNode();
  final _scroll = ScrollController();

  List<ConsoleTool> _tools = const [];
  List<ConsoleEntry> _history = const [];
  List<ConsoleFavorite> _favorites = const [];

  /// 历史文件是否落在共享目录。false 表示已回退到 App 私有目录——
  /// 那时 Amoo 侧读不到这些记录，「两边同一份存储」已经不成立，必须让用户看见。
  bool _historyShared = true;
  String _historyPath = '';

  /// 工具面板是否展开。
  bool _showTools = false;
  /// 结果视图：true 显示 raw JSON。
  bool _rawView = false;
  /// 执行中：连点会重复执行，所以挡住。
  bool _running = false;
  /// 输入区下方的就地报错。
  String _localError = '';

  /// 上下键翻历史：已执行过的命令（旧→新），`_historyIndex` 指到哪一条。
  final List<String> _sentCommands = <String>[];
  int _historyIndex = -1;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadAll();
  }

  @override
  void didUpdateWidget(covariant ConsoleScreen old) {
    super.didUpdateWidget(old);
    // 宿主页签变了 → 本页刚变成用户正在看的那一页。授权位在别处被改过的话，
    // 只有这里有机会把横幅与工具灰显拉回现实。
    if (old.visibleTick != widget.visibleTick) {
      _loadTools();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 授权动作的完成地点在 App 之外（权限中心/设置页跳系统设置），回来必须
    // 复测工具可用位：旧代码只在 initState 装载一次，授权后横幅永远挂着
    // 「未授权无障碍」——IndexedStack 里这一页活着但没人喂它新状态。
    if (state == AppLifecycleState.resumed) {
      _loadTools();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _input.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  // ── 数据 ────────────────────────────────────────────────────────────────

  Future<void> _loadAll() async {
    await Future.wait([_loadTools(), _loadHistory(), _loadFavorites()]);
    // 外部（快捷方式 / adb）带进来的待预填命令，取一次就没了。
    final pending = await ConsoleService.pendingCommand();
    if (pending.isNotEmpty && mounted) {
      _input.text = pending;
      _focus.requestFocus();
    }
  }

  Future<void> _loadTools() async {
    final list = await ConsoleService.tools();
    if (!mounted) return;
    setState(() => _tools = list);
  }

  Future<void> _loadHistory() async {
    final page = await ConsoleService.historyPage(limit: 200);
    if (!mounted) return;
    setState(() {
      _history = page.entries;
      _historyShared = page.shared;
      _historyPath = page.path;
      // 新→旧排的执行历史，翻页时按这个方向取。List 才有 reversed。
      _sentCommands
        ..clear()
        ..addAll(page.entries
            .map((e) => e.raw)
            .where((s) => s.isNotEmpty)
            .toList()
            .reversed);
      if (_historyIndex >= _sentCommands.length) _historyIndex = -1;
    });
  }

  Future<void> _loadFavorites() async {
    final list = await ConsoleService.favorites();
    if (!mounted) return;
    setState(() => _favorites = list);
  }

  // ── 执行 ────────────────────────────────────────────────────────────────

  Future<void> _exec() async {
    final text = _input.text.trim();
    if (text.isEmpty) {
      setState(() => _localError =
          '先输入一条命令，例如 {"tool":"ls","args":{"path":"/sdcard"}}');
      return;
    }
    setState(() {
      _running = true;
      _localError = '';
    });
    final entry = await ConsoleService.exec(text);
    if (!mounted) return;
    setState(() => _running = false);
    if (entry == null) {
      // 通道本身断了，不是「命令失败」——两者的处置完全不同。
      setState(() => _localError =
          '控制台通道不可用：原生层没有响应（App 可能是旧版，重启后重试）');
      return;
    }
    await _loadHistory();
    if (!mounted) return;
    // 执行完必须把最新那条带到眼前。历史列表是「新的在前」，用户完全可能
    // 之前往下翻过——那时点执行，新卡片落在屏幕外，界面看着毫无变化，
    // 用户会以为没点上，于是重复点、重复执行。
    if (_scroll.hasClients) {
      _scroll.jumpTo(0);
    }
    // 执行完把输入框留着，用户常常要在这条上改一个参数再发。
    _focus.requestFocus();
  }

  // ── 上下键翻历史 ────────────────────────────────────────────────────────

  /// 方向键处理。
  ///
  /// ↑ 取更早一条，↓ 取更晚一条；到底时把输入框原样放回去。TextField 自己也要用
  /// 方向键移动光标，所以**没有在翻历史时**（`_historyIndex < 0`）只在光标停在
  /// 首/末行时才接管，否则光标挪不动会被当成坏键盘。
  ///
  /// 为什么正在翻历史时要全盘接管：曾经用「上键要求光标在开头、下键要求光标在
  /// 末尾」来分流，结果翻完一条把光标放在某一端，下一次按相反方向就撞上条件被
  /// 忽略——实测连续按时「按一半键没反应」，用户以为键盘粘键。而翻历史状态下
  /// 光标位置本来就没有意义（内容是刚放进去的历史条目，不是用户在编辑的文本），
  /// 所以这时候不该再看光标，直接按方向翻。
  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final up = event.logicalKey == LogicalKeyboardKey.arrowUp;
    final down = event.logicalKey == LogicalKeyboardKey.arrowDown;
    if (!up && !down) return KeyEventResult.ignored;

    final text = _input.text;
    final caret = _input.selection.baseOffset.clamp(0, text.length);
    // 正在翻历史：方向键全部归这里，不看光标位置（理由见上面注释）。
    if (_historyIndex < 0) {
      if (up && caret != 0) return KeyEventResult.ignored;
      if (down && caret != text.length) return KeyEventResult.ignored;
    }
    if (up && _historyIndex >= _sentCommands.length - 1) {
      return KeyEventResult.ignored;
    }
    if (down && _historyIndex < 0) return KeyEventResult.ignored;

    final next = up ? _historyIndex + 1 : _historyIndex - 1;
    final value = next < 0 ? '' : _sentCommands[next];
    setState(() {
      _historyIndex = next;
      _input.text = value;
      // 光标位置在翻历史时没有意义，但 TextField 自己要用它，所以仍然设一个
      // 确定值（开头），免得留下一个越界或随机的 offset。
      _input.selection = const TextSelection.collapsed(offset: 0);
    });
    return KeyEventResult.handled;
  }

  // ── 常用指令 ────────────────────────────────────────────────────────────

  Future<void> _saveFavorite() async {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    final item = await ConsoleService.addFavorite('', text);
    if (!mounted) return;
    setState(() => _localError = '');
    await _loadFavorites();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(item == null
            ? '存不进：这条命令跑不通（参数或工具不可用）'
            : '已存为常用「${item.label}」'),
      ),
    );
  }

  Future<void> _deleteFavorite(ConsoleFavorite f) async {
    if (!mounted) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除常用指令'),
        content: Text('确定删掉「${f.label.isEmpty ? f.tool : f.label}」？'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    await ConsoleService.removeFavorite(f.id);
    await _loadFavorites();
  }

  // ── 导出 / 清空 / 唤起 Amoo ─────────────────────────────────────────────

  Future<void> _export() async {
    final res = await ConsoleService.export();
    if (!mounted) return;
    final msg = res == null
        ? '导出失败：通道不可用'
        : res.ok
            ? '已导出 ${res.lines} 条 → ${res.path}'
            : '导出失败：${res.error}';
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _clear() async {
    if (!mounted) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('清空历史记录'),
        content: const Text('会删掉共享历史文件里的全部记录（Amoo 侧也读这一份）。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('清空')),
        ],
      ),
    );
    if (ok != true) return;
    final done = await ConsoleService.clearHistory();
    if (!mounted) return;
    if (done) {
      setState(() => _sentCommands.clear());
      await _loadHistory();
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(done ? '已清空' : '清空失败：通道不可用')));
  }

  Future<void> _summonAmoo() async {
    final res = await ConsoleService.summonAmoo();
    if (!mounted) return;
    if (res == null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('唤起失败：通道不可用')));
      return;
    }
    final notes = res.notes.isEmpty ? '' : '\n${res.notes.join('\n')}';
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('${res.ok ? '已唤起 Amoo' : '未能唤起 Amoo'}$notes'),
      ),
    );
  }

  /// 重置访问令牌。
  ///
  /// 先确认再动手：这一按会让 PC 侧手里那份 token.txt 立刻作废，而 PC 可能是
  /// 别人正在用着的。回执用对话框而不是 SnackBar——新旧指纹加落盘状态是用户要
  /// 留着对照的信息，SnackBar 两秒就没了。
  Future<void> _resetToken() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重置访问令牌'),
        content: const Text('旧令牌会立即失效，PC 侧需重读设备上的 token.txt'
            '（/sdcard/bridge-amoobridge/token.txt）后才能继续协作。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('重置')),
        ],
      ),
    );
    if (ok != true) return;
    final res = await ConsoleService.resetToken();
    if (!mounted) return;
    if (res == null) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('重置失败：通道不可用')));
      return;
    }
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('令牌已重置'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('旧令牌 ${res.oldFingerprint}…（生效于 ${res.oldTimeText}）'),
            Text('新令牌 ${res.newFingerprint}…（生效于 ${res.newTimeText}）'),
            const SizedBox(height: 8),
            Text(
              res.persisted
                  ? '新令牌已写入 token.txt，PC 侧重读即可接入。'
                  : '新令牌只在手机内存里（未落盘）：PC 侧拿到的还是盘上的旧值，'
                      '会持续 401。授予「所有文件访问」后，桥的自愈心跳会把它补写上去。',
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('知道了')),
        ],
      ),
    );
  }

  // ── 构建 ────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final uiBlocked = _tools.any((t) => t.needsA11y && !t.available);

    return Scaffold(
      appBar: AppBar(
        // 品牌块进 AppBar：控制台是 khy-os 的执行面，标题行就得带标。
        //
        // 形态与新版其他界面对齐：聊天页 AppBar 区（chat_screen_new.dart:1291）
        // 和抽屉头（:2469）、连接页、设置页用的都是 KhyBrandTile——墨黑圆角底 +
        // 琥珀主标，也就是 Web / 桌面端 / TUI 共用的同一枚主标与同一块墨黑底
        // （见 khy_brand_mark.dart 的类文档）。早先这里用裸 KhyBrandMark(22)，
        // 是新版六屏里唯一不带墨黑底的一处，标题行视觉上自成一档。
        // 尺寸取 28，与抽屉头一致：AppBar 标题行比 36 的页头轻一档，但不缩到
        // 22——那已经小过主标可读的下限。
        title: Row(
          children: [
            const KhyBrandTile(size: 28),
            const SizedBox(width: 8),
            const Text('控制台'),
          ],
        ),
        actions: [
          IconButton(
            tooltip: _rawView ? '切换到格式化视图' : '切换到 raw JSON',
            icon: Icon(_rawView ? Icons.list_alt : Icons.code),
            onPressed: () => setState(() => _rawView = !_rawView),
          ),
          IconButton(
            tooltip: '导出历史',
            icon: const Icon(Icons.file_download_outlined),
            onPressed: _export,
          ),
          IconButton(
            tooltip: '清空历史',
            icon: const Icon(Icons.delete_outline),
            onPressed: _clear,
          ),
          IconButton(
            tooltip: '唤起 Amoo（可选）',
            icon: const Icon(Icons.forum_outlined),
            onPressed: _summonAmoo,
          ),
          IconButton(
            tooltip: '重置访问令牌',
            icon: const Icon(Icons.vpn_key_outlined),
            onPressed: _resetToken,
          ),
        ],
      ),
      body: Column(
        children: [
          // 未授权无障碍只影响 ui_* 与 shot，别的能力照常可用——这句必须写在
          // 显眼处，否则用户会以为整个 App 都废了。
          if (uiBlocked) _a11yBanner(cs),
          // 共享目录不可写时原生侧会静默回退到 App 私有目录。不提示的话，
          // 用户以为 Amoo 也看得到这些记录，实际看不到——静默违背「同一份存储」。
          if (!_historyShared) _notSharedBanner(cs),
          _favoritesBar(cs),
          Expanded(
            child: _history.isEmpty
                ? _emptyState(cs)
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                    itemCount: _history.length,
                    itemBuilder: (_, i) => _entryCard(_history[i], cs),
                  ),
          ),
          if (_showTools) _toolPanel(cs),
          _inputArea(cs),
        ],
      ),
    );
  }

  /// 共享存储失效时的提示。
  ///
  /// 这不是「功能降级」，是「一个前提不成立了」：khy-os 与 Amoo 本该读写同一份
  /// 记录，现在各存一份。不告诉用户，他就会在 Amoo 侧找不到刚跑过的命令，
  /// 而且无从判断是没跑还是没同步。
  Widget _notSharedBanner(ColorScheme cs) {
    final palette = AppPalette.of(context);
    return Container(
      width: double.infinity,
      color: palette.error.withValues(alpha: 0.12),
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.folder_off_outlined, size: 18, color: palette.error),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '未使用共享存储：命令记录只存在本 App 内，Amoo 侧读不到',
                  style: TextStyle(
                      fontSize: 12, color: cs.onSurface, height: 1.3),
                ),
                if (_historyPath.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text('当前位置：$_historyPath',
                      style: TextStyle(
                          fontSize: 10,
                          fontFamily: 'monospace',
                          color: cs.onSurfaceVariant)),
                ],
                const SizedBox(height: 2),
                Text('授予「所有文件访问」后即可恢复与 Amoo 共用同一份记录',
                    style: TextStyle(
                        fontSize: 11,
                        color: cs.onSurfaceVariant,
                        height: 1.3)),
              ],
            ),
          ),
          TextButton(
            // 「去授权」统一跳权限中心（2026-11-15 收敛）：那里有全部授权位的
            // 状态灯与直达入口，不再散跳各自的系统页。
            onPressed: () => _openPermissionCenter(),
            child: const Text('去授权', style: TextStyle(fontSize: 12)),
          ),
        ],
      ),
    );
  }

  Widget _a11yBanner(ColorScheme cs) {
    final palette = AppPalette.of(context);
    return Container(
      width: double.infinity,
      color: palette.warning.withValues(alpha: 0.12),
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
      child: Row(
        children: [
          Icon(Icons.accessibility_new, size: 18, color: palette.warning),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '未授权无障碍：ui_* 与 shot 不可用，其余能力不受影响',
              style: TextStyle(fontSize: 12, color: cs.onSurface, height: 1.3),
            ),
          ),
          TextButton(
            onPressed: () => _openPermissionCenter(),
            child: const Text('去授权', style: TextStyle(fontSize: 12)),
          ),
        ],
      ),
    );
  }

  void _openPermissionCenter() {
    Navigator.push(context,
        MaterialPageRoute(builder: (_) => const PermissionCenterScreen()));
  }

  Widget _favoritesBar(ColorScheme cs) {
    if (_favorites.isEmpty) return const SizedBox.shrink();
    return SizedBox(
      height: 44,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        children: [
          for (final f in _favorites)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: GestureDetector(
                onTap: () {
                  _input.text = f.json;
                  _input.selection =
                      TextSelection.collapsed(offset: f.json.length);
                  _focus.requestFocus();
                },
                onLongPress: () => _deleteFavorite(f),
                child: Chip(
                  label: Text(f.label.isEmpty ? f.tool : f.label,
                      style: const TextStyle(fontSize: 12)),
                  visualDensity: VisualDensity.compact,
                  backgroundColor: cs.surfaceContainerHighest,
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _emptyState(ColorScheme cs) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          '这里输入一条 JSON 命令，本地解析、执行、显示结果。',
          style: AppText.cardTitleNarrow.copyWith(color: cs.onSurfaceVariant),
        ),
        const SizedBox(height: 8),
        Text(
          '形如 {"tool":"ls","args":{"path":"/sdcard"}}',
          style: TextStyle(
              fontSize: 12,
              fontFamily: 'monospace',
              color: cs.onSurfaceVariant),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: () => setState(() => _showTools = !_showTools),
          icon: const Icon(Icons.build_outlined, size: 18),
          label: const Text('看工具面板（点工具填模板）'),
        ),
      ],
    );
  }

  Widget _toolPanel(ColorScheme cs) {
    // 按 group 分组，和原生侧的分组口径一致（同一份 CATALOG）。
    final groups = <String, List<ConsoleTool>>{};
    for (final t in _tools) {
      groups.putIfAbsent(t.group, () => []).add(t);
    }
    return Container(
      constraints: const BoxConstraints(maxHeight: 260),
      decoration: BoxDecoration(
        color: AppPalette.of(context).surfaceHigh,
        border: Border(top: BorderSide(color: cs.outlineVariant)),
      ),
      child: Column(
        children: [
          ListTile(
            dense: true,
            title: const Text('工具面板', style: AppText.cardTitleNarrow),
            subtitle: Text('点工具填示例命令到输入框；灰=不可用',
                style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
            trailing: IconButton(
              icon: const Icon(Icons.close, size: 18),
              onPressed: () => setState(() => _showTools = false),
            ),
          ),
          Expanded(
            child: _tools.isEmpty
                // 通道取不到清单时不能只渲染一个空面板：用户点开却什么都没有，
                // 无从判断是「还在加载」还是「坏了」。说清楚，并给一条出路。
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.cloud_off_outlined,
                              size: 28, color: cs.onSurfaceVariant),
                          const SizedBox(height: 8),
                          Text('没拿到工具清单',
                              style: AppText.cardTitleNarrow
                                  .copyWith(color: cs.onSurface)),
                          const SizedBox(height: 4),
                          Text(
                              '原生层没有返回目录。命令仍可手动输入执行；'
                              '若持续如此，请重启 App 后重试。',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                  fontSize: 11,
                                  color: cs.onSurfaceVariant,
                                  height: 1.4)),
                        ],
                      ),
                    ),
                  )
                : ListView(
                    children: [
                      for (final entry in groups.entries)
                        _toolGroup(entry.key, entry.value, cs),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  Widget _toolGroup(
      String group, List<ConsoleTool> tools, ColorScheme cs) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
          child: Text(group,
              style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: cs.onSurfaceVariant)),
        ),
        for (final t in tools)
          ListTile(
            dense: true,
            // 置灰：半透明 + 禁止点击。只灰这一个工具，不牵连别的。
            title: Opacity(
              opacity: t.available ? 1.0 : 0.4,
              child: Text(t.name,
                  style: AppText.cardTitleNarrow
                      .copyWith(fontFamily: 'monospace')),
            ),
            subtitle: Opacity(
              opacity: t.available ? 1.0 : 0.4,
              child: Text(t.desc,
                  style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
            ),
            trailing: t.available ? null : const Icon(Icons.lock_outline, size: 14),
            onTap: t.available
                ? () {
                    _input.text = t.sample;
                    _input.selection =
                        TextSelection.collapsed(offset: t.sample.length);
                    _focus.requestFocus();
                  }
                : null,
          ),
      ],
    );
  }

  Widget _inputArea(ColorScheme cs) {
    // 外层 shell 是 extendBody: true——内容延伸到底部导航栏**底下**。
    // 宿主已把 body 的 padding.bottom 抬成底栏净高（NavigationBar 80 + 系统手势区；
    // 键盘弹出时归 0，键盘让位由宿主折进 body 高度，viewInsets 在 body 子树里恒为 0）。
    // 旧写法在这个值上再手动加 80，等于把底栏高度数了两遍——输入框和底栏之间
    // 隔出一整条空带，就是它。这里只补 8dp 呼吸缝。
    final navInset = MediaQuery.paddingOf(context).bottom;
    final palette = AppPalette.of(context);
    return Container(
      decoration: BoxDecoration(
        color: palette.surfaceHigh,
        border: Border(top: BorderSide(color: cs.outlineVariant)),
      ),
      padding: EdgeInsets.fromLTRB(12, 8, 12, 8 + navInset),
      child: Column(
        children: [
          Row(
            children: [
              IconButton(
                tooltip: _showTools ? '收起工具面板' : '展开工具面板',
                icon: const Icon(Icons.build_outlined, size: 20),
                onPressed: () => setState(() => _showTools = !_showTools),
              ),
              Expanded(
                child: Focus(
                  onKeyEvent: _onKey,
                  child: TextField(
                    controller: _input,
                    focusNode: _focus,
                    minLines: 1,
                    maxLines: 3,
                    textInputAction: TextInputAction.send,
                    style: AppText.cardTitleNarrow
                        .copyWith(fontFamily: 'monospace'),
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: '{"tool":"ls","args":{"path":"/sdcard"}}',
                      hintStyle: TextStyle(
                          fontSize: 12,
                          fontFamily: 'monospace',
                          color: cs.onSurfaceVariant.withValues(alpha: 0.6)),
                      border: OutlineInputBorder(
                          borderRadius:
                              BorderRadius.circular(AppRadius.medium)),
                      contentPadding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 10),
                    ),
                    onSubmitted: (_) => _exec(),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              _running
                  ? const SizedBox(
                      width: 24,
                      height: 24,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : IconButton.filled(
                      tooltip: '执行（↑↓ 翻历史）',
                      icon: const Icon(Icons.play_arrow, size: 20),
                      onPressed: _exec,
                    ),
              IconButton(
                tooltip: '存为常用',
                icon: const Icon(Icons.star_outline, size: 20),
                onPressed: _saveFavorite,
              ),
            ],
          ),
          if (_localError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6, left: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.error_outline, size: 14, color: palette.error),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(_localError,
                        style: TextStyle(fontSize: 11, color: palette.error)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  // ── 一条记录的卡片 ──────────────────────────────────────────────────────

  Widget _entryCard(ConsoleEntry e, ColorScheme cs) {
    final status = e.status;
    final color = _statusColor(status);
    final palette = AppPalette.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        side: BorderSide(color: color.withValues(alpha: AppAlpha.strokeWeak)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 头部：时间 / 来源 / 工具 / 分类标签
            Row(
              children: [
                Text(e.timeText,
                    style: TextStyle(
                        fontSize: 11, color: cs.onSurfaceVariant)),
                const SizedBox(width: 8),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: palette.primary
                        .withValues(alpha: AppAlpha.badgeFill),
                    borderRadius: BorderRadius.circular(AppRadius.pill),
                    border: Border.all(
                        color: palette.primary
                            .withValues(alpha: AppAlpha.strokeWeak),
                        width: AppStroke.thin),
                  ),
                  // Amoo 来源一眼可辨：它和手动敲的走同一条通道，记录得一样，
                  // 但用户得知道是谁发的。
                  child: Text(
                      e.isAmoo ? 'Amoo' : '手动',
                      style: AppText.secondary.copyWith(
                          fontWeight: FontWeight.w600,
                          color: e.isAmoo
                              ? palette.primary
                              : cs.onSurfaceVariant)),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(e.tool.isEmpty ? '（无工具名）' : e.tool,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppText.cardTitleNarrow
                          .copyWith(fontFamily: 'monospace')),
                ),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: AppAlpha.badgeFill),
                    borderRadius: BorderRadius.circular(AppRadius.pill),
                  ),
                  child: Text(status.label,
                      style: AppText.label.copyWith(color: color)),
                ),
              ],
            ),
            const SizedBox(height: 6),
            // 命令原文：复现与排查的唯一依据，原样保留。
            Text(e.raw,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: AppText.mono.copyWith(color: cs.onSurfaceVariant)),
            if (!status.isOk) ...[
              const SizedBox(height: 8),
              Text(e.error,
                  style: TextStyle(fontSize: 12, color: color, height: 1.35)),
              if (e.hint.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(e.hint,
                    style: TextStyle(
                        fontSize: 11, color: cs.onSurfaceVariant, height: 1.3)),
              ],
              const SizedBox(height: 2),
              // 处置建议：三类失败各自该做什么，写清楚，别让用户猜。
              Text(status.remedy,
                  style: TextStyle(
                      fontSize: 11, color: cs.onSurfaceVariant, height: 1.3)),
              if (e.needsAuth == 'accessibility')
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: TextButton.icon(
                    onPressed: () => DeviceControl.openAccessibilitySettings(),
                    icon: const Icon(Icons.accessibility_new, size: 16),
                    label: const Text('去开无障碍',
                        style: TextStyle(fontSize: 12)),
                  ),
                ),
            ],
            if (e.capabilityNote.isNotEmpty) ...[
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.info_outline, size: 14, color: palette.warning),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(e.capabilityNote,
                        style: TextStyle(
                            fontSize: 11,
                            color: palette.warning,
                            height: 1.35)),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 8),
            _rawView ? _rawBlock(e) : _formatted(e, cs),
          ],
        ),
      ),
    );
  }

  Widget _rawBlock(ConsoleEntry e) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: AppPalette.of(context).surfaceHigh,
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: SelectableText(e.rawJson, style: AppText.mono),
    );
  }

  Color _statusColor(ConsoleStatus s) {
    final palette = AppPalette.of(context);
    switch (s) {
      case ConsoleStatus.ok:
        return palette.success;
      case ConsoleStatus.invalidArgs:
        return palette.error;
      case ConsoleStatus.toolUnavailable:
        return palette.warning;
      case ConsoleStatus.execError:
        return palette.error;
      case ConsoleStatus.unknown:
        return palette.warning;
    }
  }

  // ── 格式化视图 ──────────────────────────────────────────────────────────

  Widget _formatted(ConsoleEntry e, ColorScheme cs) {
    final r = e.result;
    if (r.isEmpty) return const SizedBox.shrink();
    // exec 的结果按 stdout/stderr/退出码/通道分块，混在一行里读不了。
    if (r.containsKey('out') || r.containsKey('exit')) {
      return _execResult(r, cs);
    }
    if (r.containsKey('entries')) return _fileList(r, cs);
    if (r.containsKey('apps')) return _listResult(r, 'apps', cs);
    if (r.containsKey('xml')) return _xmlResult(r, cs);
    if (r.containsKey('content')) {
      return _textResult('content', r['content'], cs);
    }
    if (r.containsKey('items')) return _listResult(r, 'items', cs);
    return _kvResult(r, cs);
  }

  /// exec 结果里单个文本块的上限。
  ///
  /// Tools.exec 的 stdout 上限是 1MB，一条 `find /` 就能顶满。不限长就整个
  /// 塞进 SelectableText，界面直接卡死——而卡死的界面看起来像 App 坏了，
  /// 不像「这条命令输出太多了」。
  static const int _blockCap = 8000;

  Widget _execResult(Map<String, dynamic> r, ColorScheme cs) {
    final exit = r['exit'];
    final palette = AppPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _kvLine('退出码', '${exit ?? '-'}', cs,
            color: (exit is num && exit != 0) ? palette.error : null),
        if ((r['via'] ?? '').toString().isNotEmpty)
          _kvLine('执行通道', r['via'].toString(), cs),
        if (r['out'] != null && '${r['out']}'.isNotEmpty)
          _block('stdout', _capped(r['out'].toString()), cs),
        if (r['err'] != null && '${r['err']}'.isNotEmpty)
          _block('stderr', _capped(r['err'].toString()), cs,
              color: palette.warning),
      ],
    );
  }

  /// 超长文本截断，并说明截了多少——不说就等于偷偷改数据。
  String _capped(String s) {
    if (s.length <= _blockCap) return s;
    return '${s.substring(0, _blockCap)}\n…（共 ${s.length} 字符，仅显示前 $_blockCap；'
        '完整内容用 raw JSON 视图或导出查看）';
  }

  Widget _fileList(Map<String, dynamic> r, ColorScheme cs) {
    final entries = r['entries'];
    if (entries is! List) return const SizedBox.shrink();
    final total = entries.length;
    const shown = 50;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('共 $total 项${total > shown ? '，已显示前 $shown 项' : ''}',
            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
        const SizedBox(height: 4),
        for (var i = 0; i < total && i < shown; i++) _entryRow(entries[i], cs),
      ],
    );
  }

  Widget _entryRow(dynamic item, ColorScheme cs) {
    if (item is! Map) {
      return Text('$item', style: const TextStyle(fontSize: 11));
    }
    final m = Map<String, dynamic>.from(item);
    final isDir = m['dir'] == true;
    final name = (m['name'] ?? m['package'] ?? m['label'] ?? '').toString();
    final size = m['size'];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Icon(
              isDir
                  ? Icons.folder_outlined
                  : Icons.insert_drive_file_outlined,
              size: 13,
              color: cs.onSurfaceVariant),
          const SizedBox(width: 6),
          Expanded(
            child: Text(name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11)),
          ),
          if (size is num)
            Text('${size}B',
                style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant)),
        ],
      ),
    );
  }

  Widget _listResult(Map<String, dynamic> r, String key, ColorScheme cs) {
    final list = r[key];
    if (list is! List) return const SizedBox.shrink();
    final total = list.length;
    const shown = 50;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('共 $total 条${total > shown ? '，已显示前 $shown 条' : ''}',
            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
        const SizedBox(height: 4),
        for (var i = 0; i < total && i < shown; i++) _entryRow(list[i], cs),
      ],
    );
  }

  Widget _xmlResult(Map<String, dynamic> r, ColorScheme cs) {
    // ui_dump 的 xml 同样可能非常大（KhyUi 上限 5000 节点）。
    final xml = r['xml'].toString();
    final lines = xml.split('\n');
    const shown = 40;
    final truncated = lines.length > shown;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('${lines.length} 行${truncated ? '，已显示前 $shown 行' : ''}',
            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
        const SizedBox(height: 4),
        Container(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: AppPalette.of(context).surfaceHigh,
            borderRadius: BorderRadius.circular(AppRadius.small),
          ),
          child: SelectableText(
            lines.take(shown).join('\n'),
            style: const TextStyle(
                fontSize: 10, fontFamily: 'monospace', height: 1.25),
          ),
        ),
        if (truncated)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('完整内容用 raw JSON 视图或导出查看',
                style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant)),
          ),
      ],
    );
  }

  Widget _textResult(String label, dynamic text, ColorScheme cs) {
    final body = text?.toString() ?? '';
    final truncated = body.length > 4000;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('$label：${body.length} 字符${truncated ? '，已截断到前 4000' : ''}',
            style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
        const SizedBox(height: 4),
        _block(label, truncated ? body.substring(0, 4000) : body, cs),
      ],
    );
  }

  Widget _kvResult(Map<String, dynamic> r, ColorScheme cs) {
    final keys = r.keys.toList()..sort();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final k in keys) _kvLine(k, _short(r[k]), cs, maxLines: 3),
      ],
    );
  }

  Widget _kvLine(String k, String v, ColorScheme cs,
      {Color? color, int maxLines = 1}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 74,
            child: Text(k,
                style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
          ),
          Expanded(
            child: Text(v,
                maxLines: maxLines,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11, color: color ?? cs.onSurface)),
          ),
        ],
      ),
    );
  }

  Widget _block(String label, String body, ColorScheme cs, {Color? color}) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label,
              style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  color: color ?? cs.onSurfaceVariant)),
          const SizedBox(height: 2),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: AppPalette.of(context).surfaceHigh,
              borderRadius: BorderRadius.circular(AppRadius.small),
            ),
            child: SelectableText(body,
                style: const TextStyle(
                    fontSize: 11, fontFamily: 'monospace', height: 1.3)),
          ),
        ],
      ),
    );
  }

  /// 长值折成一行，避免键值视图被一个大字符串撑爆。
  String _short(dynamic v) {
    if (v == null) return 'null';
    String s;
    try {
      s = v is String ? v : jsonEncode(v);
    } catch (_) {
      s = '$v';
    }
    return s.length <= 200 ? s : '${s.substring(0, 200)}…';
  }
}
