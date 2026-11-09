// khy-canary: Khy-20261101-134-KBVE8YTS
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/services/file_service.dart';
import '../../core/workspace/workspace_choices.dart';

/// 位置面板里的一行。
class LocRow {
  final String label;
  final String value;

  /// 可复制的值。空串 = 这一行没有可复制的路径。
  final String copyable;

  /// 为什么不能复制；可复制时为 null。
  final String? copyHint;

  const LocRow({
    required this.label,
    required this.value,
    this.copyable = '',
    this.copyHint,
  });
}

/// 长按会话项弹出的位置面板。
///
/// 「跳转」做成尝试而不是承诺：绝大多数文件管理器不接收目录路径 intent，
/// 点了没反应是常态。所以每个可跳转的条目都带一个「用文件管理器打开」的
/// 次要动作，并在失败时明确说"请改用复制路径"——不让用户以为点了没坏
/// 就是成功了。
class LocationsSheet extends StatelessWidget {
  final List<LocRow> rows;

  const LocationsSheet({super.key, required this.rows});

  Future<void> _copy(BuildContext context, String value) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('路径已复制')),
    );
  }

  Future<void> _open(BuildContext context, String path) async {
    // 走原生 channel 而不是 url_launcher：App 已经用这条通道起过系统设置
    // （openAccessibilitySettings），而 url_launcher 不是本项目的依赖，
    // 为这一个按钮加一个包不划算。
    //
    // 原生侧区分"没有 App 接"和"起了但立刻退"，这两种失败原因不同、
    // 该给用户的提示也不同，不能混成一句"打开失败"。
    final res = await FileService.openDirectory(path);
    if (!context.mounted) return;
    final opened = res['opened'] == true;
    if (opened) return;
    final noApp = res['noApp'] == true;
    _fail(
      context,
      noApp
          ? '没有文件管理器能打开目录，请改用复制路径'
          : '文件管理器不接受这个目录，请改用复制路径',
    );
  }

  void _fail(BuildContext context, String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    // 高度上限是必须的，不是装饰。
    //
    // 原先这里只有 Column(mainAxisSize: min) + Flexible(ListView)，在 bottom
    // sheet 里直接溢出 99564 像素——mainAxisSize.min 让 Column 按内容 intrinsic
    // 高度收缩，而 Flexible(loose) 允许 ListView 要多少拿多少，两者相乘就炸了。
    // 给一个明确的 maxHeight，Flexible 才有东西可分配。
    final maxHeight = MediaQuery.of(context).size.height * 0.8;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('这个对话的位置',
                  style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: cs.onSurface)),
              const SizedBox(height: 4),
              Text('长按会话可随时回来看这些路径',
                  style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
              const SizedBox(height: 12),
              Flexible(
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: rows.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (ctx, i) {
                    final r = rows[i];
                    final canCopy = r.copyable.isNotEmpty;
                    final canOpen = canCopy && r.copyable.startsWith('/');
                    return ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      title: Text(r.label,
                          style: TextStyle(
                              fontSize: 12, color: cs.onSurfaceVariant)),
                      subtitle: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const SizedBox(height: 2),
                          // 可选中：路径长得都一样，不让用户全选复制太折磨。
                          SelectableText(r.value,
                              style:
                                  TextStyle(fontSize: 13, color: cs.onSurface)),
                          if (r.copyHint != null) ...[
                            const SizedBox(height: 2),
                            Text(r.copyHint!,
                                style: TextStyle(
                                    fontSize: 10, color: cs.onSurfaceVariant)),
                          ],
                        ],
                      ),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (canCopy)
                            IconButton(
                              tooltip: '复制',
                              icon: const Icon(Icons.copy, size: 16),
                              onPressed: () => _copy(ctx, r.copyable),
                            ),
                          if (canOpen)
                            IconButton(
                              tooltip: '用文件管理器打开',
                              icon: const Icon(Icons.folder_open, size: 16),
                              onPressed: () => _open(ctx, r.copyable),
                            ),
                        ],
                      ),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 新建对话时的工作目录选择器。
class WorkspacePickerSheet extends StatefulWidget {
  final List<DirChoice> choices;

  const WorkspacePickerSheet({super.key, required this.choices});

  @override
  State<WorkspacePickerSheet> createState() => _WorkspacePickerSheetState();
}

class _WorkspacePickerSheetState extends State<WorkspacePickerSheet> {
  final _manual = TextEditingController();
  String? _error;

  void _submit(String path) {
    // 校验只有一个真源：ConversationWorkspace.check。选择器自己再判一次，
    // 就会出现"选择器说行、存进去不行"。
    final check = WorkspaceChoices.checkManual(path);
    if (!check.ok) {
      setState(() => _error = check.reason);
      return;
    }
    Navigator.pop(context, check.normalized);
  }

  @override
  void dispose() {
    _manual.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    // 同 LocationsSheet：没有 maxHeight，mainAxisSize.min + Flexible 在 bottom
    // sheet 里会溢出。这里的列表可能更长（预设 + /sdcard 下扫描到的目录）。
    final maxHeight = MediaQuery.of(context).size.height * 0.85;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Padding(
          padding: EdgeInsets.fromLTRB(
              16, 12, 16, MediaQuery.of(context).viewInsets.bottom + 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('这个对话的文件放哪？',
                  style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: cs.onSurface)),
              const SizedBox(height: 4),
              const Text('不选就用 App 默认目录（文件管理器里看不到）',
                  style: TextStyle(fontSize: 11)),
              const SizedBox(height: 12),
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: widget.choices.length,
                  itemBuilder: (ctx, i) {
                    final c = widget.choices[i];
                    return ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(
                        c.recommended ? Icons.star : Icons.folder_open,
                        size: 18,
                        color: c.recommended ? cs.primary : cs.onSurfaceVariant,
                      ),
                      title: Text(c.label,
                          style: TextStyle(fontSize: 13, color: cs.onSurface)),
                      subtitle: Text('${c.path}\n${c.hint}',
                          style: TextStyle(
                              fontSize: 10, color: cs.onSurfaceVariant)),
                      isThreeLine: true,
                      onTap: () => _submit(c.path),
                    );
                  },
                ),
              ),
              const Divider(height: 20),
              Text('或者手动输入绝对路径',
                  style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
              const SizedBox(height: 6),
              TextField(
                controller: _manual,
                decoration: InputDecoration(
                  isDense: true,
                  hintText: '/sdcard/...',
                  errorText: _error,
                  suffixIcon: IconButton(
                    tooltip: '用这个路径',
                    icon: const Icon(Icons.check, size: 18),
                    onPressed: () => _submit(_manual.text),
                  ),
                ),
                onSubmitted: _submit,
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('跳过，用默认'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
