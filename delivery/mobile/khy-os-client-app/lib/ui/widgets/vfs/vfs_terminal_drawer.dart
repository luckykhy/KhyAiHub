// 终端抽屉：文件管理器的 Linux 侧入口。
//
// 定位要讲清楚：**这是命令控制台，不是完整 PTY**。每次执行是「以当前目录为 cwd
// 跑一条命令，把输出一次性取回来」，没有交互式会话、没有 Ctrl-C、没有 vim。
// 目标不是替代 Termux，而是让「看一眼文件结构」「跑一条转换命令」「把输出存成文件」
// 这三件事不必切出 App。
//
// 权限现实：以 App 自己的 uid 执行，看得见公共存储与自己的私有目录，看不见别的
// App 的私有目录与系统分区（那需要 Shizuku，而 Shizuku 通道由 VFS 负责）。
// 执行失败时原样显示 stderr——用户要能区分「命令写错了」和「权限不够」。
//
// 安全边界：这里执行的是**用户自己敲的命令**。若将来把 AI 产出的命令接进来，
// 必须先过 [AiSafetyFilter.checkCommand]——那条护栏拦的是 `rm -rf /` 一类东西。

import 'package:flutter/material.dart';

import '../../../core/services/shell_executor.dart';
import '../../../core/vfs/vfs_service.dart';
import '../../../core/vfs/vfs_terminal_command.dart';
import '../../theme/design_tokens.dart';

/// 终端抽屉。
class VfsTerminalDrawer extends StatefulWidget {
  /// 文件浏览器当前所在的目录（终端的 cwd 与它同步）。
  final String cwd;

  /// 用户点「在终端中打开当前目录」时通知外部（用来更新显示的 cwd）。
  final ValueChanged<String> onCwdChanged;

  /// 关闭抽屉。
  final VoidCallback onClose;

  const VfsTerminalDrawer({
    super.key,
    required this.cwd,
    required this.onCwdChanged,
    required this.onClose,
  });

  @override
  State<VfsTerminalDrawer> createState() => _VfsTerminalDrawerState();
}

class _VfsTerminalDrawerState extends State<VfsTerminalDrawer> {
  final TextEditingController _input = TextEditingController();
  final List<_TerminalEntry> _entries = <_TerminalEntry>[];

  String _cwd = '/';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _cwd = widget.cwd;
  }

  @override
  void didUpdateWidget(VfsTerminalDrawer oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 文件浏览器换了目录，终端的 cwd 跟着走——这是「文件与终端联动」的核心：
    // 用户在文件管理器里走，终端里看到的就是同一个地方。
    if (widget.cwd != oldWidget.cwd) {
      setState(() => _cwd = widget.cwd);
    }
  }

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);

    return Container(
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
        border: Border(top: BorderSide(color: palette.stroke)),
      ),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.page,
        AppSpacing.cardPad,
        AppSpacing.page,
        AppSpacing.page,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.terminal, size: 18, color: palette.primary),
              const SizedBox(width: AppSpacing.inner),
              Expanded(
                child: Text(
                  _cwd,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.cardTitle.copyWith(color: palette.textPrimary),
                ),
              ),
              IconButton(
                onPressed: () => setState(_entries.clear),
                icon: const Icon(Icons.clear_all, size: 18),
                color: palette.textSecondary,
                tooltip: '清空',
              ),
              IconButton(
                onPressed: () => Navigator.of(context).maybePop(),
                icon: const Icon(Icons.close, size: 18),
                color: palette.textSecondary,
                tooltip: '关闭',
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.cardGap),
          Flexible(
            child: Container(
              constraints: const BoxConstraints(maxHeight: 220),
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
              decoration: BoxDecoration(
                color: palette.surfaceHigh,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: palette.stroke),
              ),
              child: _entries.isEmpty
                  ? Text(
                      '在当前目录执行命令，输出会显示在这里。',
                      style: AppText.secondary.copyWith(color: palette.textFaint),
                    )
                  : ListView(
                      reverse: true,
                      children: <Widget>[
                        for (final entry in _entries.reversed)
                          Padding(
                            padding:
                                const EdgeInsets.only(bottom: AppSpacing.dense),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Text(
                                  // 必须写 ${entry.command}：Dart 的插值只取标识符，
                                  // `$entry.command` 会被解析成「$entry 的 toString()
                                  // 后面接字面量 .command」——真机上回显成
                                  // "Instance of '_TerminalEntry'.command"。
                                  '\$ ${entry.command}',
                                  style: AppText.micro
                                      .copyWith(color: palette.primary),
                                ),
                                const SizedBox(height: 2),
                                if (entry.output.isNotEmpty)
                                  SelectableText(
                                    entry.output,
                                    style: AppText.micro.copyWith(
                                      color: entry.ok
                                          ? palette.textSecondary
                                          : palette.error,
                                    ),
                                  ),
                                if (entry.output.isNotEmpty)
                                  Align(
                                    alignment: Alignment.centerRight,
                                    child: TextButton(
                                      onPressed: () => _saveOutput(entry),
                                      child: const Text('存为文件'),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                      ],
                    ),
            ),
          ),
          const SizedBox(height: AppSpacing.cardGap),
          Row(
            children: <Widget>[
              Expanded(
                // 拖拽目标：把文件管理器里的路径拖进来就补全。
                // 带空格的路径自动加引号——不加的话命令会因为路径被拆成两段而跑飞。
                child: DragTarget<String>(
                  onWillAcceptWithDetails: (DragTargetDetails<String> details) =>
                      true,
                  onAcceptWithDetails: (DragTargetDetails<String> details) {
                    final path = details.data;
                    final quoted = path.contains(' ') ? "'$path'" : path;
                    final current = _input.text;
                    final next = current.isEmpty || current.endsWith(' ')
                        ? '$current$quoted'
                        : '$current $quoted';
                    _input.text = next;
                    _input.selection = TextSelection.collapsed(
                      offset: next.length,
                    );
                  },
                  builder: (
                    BuildContext context,
                    List<String?> candidates,
                    List<dynamic> rejected,
                  ) {
                    final hovering = candidates.isNotEmpty;
                    return TextField(
                      controller: _input,
                      style: AppText.body.copyWith(color: palette.textPrimary),
                      textInputAction: TextInputAction.go,
                      onSubmitted: (_) => _run(),
                      decoration: InputDecoration(
                        isDense: true,
                        hintText: hovering ? '松手插入路径' : '输入命令',
                        hintStyle: AppText.body.copyWith(
                          color: hovering ? palette.primary : palette.textFaint,
                        ),
                        prefixText: '\$ ',
                        prefixStyle:
                            AppText.body.copyWith(color: palette.textFaint),
                        filled: true,
                        fillColor: hovering
                            ? palette.primary.withValues(alpha: 0.12)
                            : palette.surfaceHigh,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.cardPad,
                          vertical: AppSpacing.dense,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: BorderSide(color: palette.stroke),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: BorderSide(
                            color: hovering ? palette.primary : palette.stroke,
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(width: AppSpacing.dense),
              FilledButton(
                onPressed: _busy ? null : _run,
                child: Text(_busy ? '执行中' : '执行'),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          Row(
            children: <Widget>[
              TextButton.icon(
                onPressed: () {
                  setState(() => _cwd = widget.cwd);
                  widget.onCwdChanged(widget.cwd);
                },
                icon: const Icon(Icons.folder_open, size: 16),
                label: const Text('在终端中打开当前目录'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _run() async {
    final raw = _input.text.trim();
    if (raw.isEmpty || _busy) return;
    setState(() => _busy = true);
    _input.clear();

    // `cd` 是 shell 内建，不在原生的允许清单里，所以在 Dart 侧就地处理成
    // 「换 cwd」——顺带把目标路径归一化，让顶栏显示的 cwd 与实际落点一致。
    final parsed = parseTerminalCommand(raw);
    if (parsed.changesDirectory) {
      final target = resolveTerminalPath(_cwd, parsed.targetDirectory ?? '');
      final enterable = await _isDirectory(target);
      if (!mounted) return;
      setState(() {
        _busy = false;
        if (enterable) {
          _cwd = target;
          _entries.add(_TerminalEntry(
            command: raw,
            output: '工作目录已切换到 $target',
            ok: true,
          ));
        } else {
          _entries.add(_TerminalEntry(
            command: raw,
            output: '无法切换到 $target：目录不存在或不可访问',
            ok: false,
          ));
        }
      });
      return;
    }

    // cwd 用**独立参数**传，不拼成 `cd <dir> && cmd`：命令体里出现 `&&` 会被
    // 原生的控制符禁令整体拒绝——真机实测，终端因此一条命令都发不出去。
    final result = await ShellExecutor.execTerminal(
      parsed.shellCommand,
      cwd: _cwd,
    );

    if (!mounted) return;
    setState(() {
      _busy = false;
      _entries.add(_TerminalEntry(
        command: parsed.shellCommand,
        output: '${result.stdout}${result.stderr}'.trim(),
        ok: result.success,
      ));
    });
  }

  /// 目标是不是一个能进的目录。
  ///
  /// 为什么要验：终端顶栏显示的 cwd 决定下一条命令的落点。显示一个进不去的目录，
  /// 下一条命令就会在别处跑——用户看到的是「目录不对」，却查不出错在哪。
  Future<bool> _isDirectory(String path) async {
    try {
      final node = await VfsService.instance.stat(path);
      return node != null && node.isDirectory;
    } catch (_) {
      return false;
    }
  }

  /// 把一段输出存成文件，落在当前目录——存完就能在文件管理器里直接打开。
  Future<void> _saveOutput(_TerminalEntry entry) async {
    final stamp = DateTime.now().millisecondsSinceEpoch;
    final name = 'terminal-$stamp.txt';
    try {
      await VfsService.instance.write('$_cwd/$name', entry.output);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已保存为 $name')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('保存失败：$error')),
      );
    }
  }
}

class _TerminalEntry {
  final String command;
  final String output;
  final bool ok;

  const _TerminalEntry({
    required this.command,
    required this.output,
    required this.ok,
  });
}
