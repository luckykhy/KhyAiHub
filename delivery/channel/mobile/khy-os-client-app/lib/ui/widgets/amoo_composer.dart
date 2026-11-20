// khy-canary: Khy-20261101-126-2DZ4GHQP
import 'package:flutter/material.dart';
import '../../core/services/amoo_service.dart';
import '../../core/services/console_service.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// amoo 发送面板（设备页卡片与聊天页快捷动作共用）。
///
/// 交互约束：
///   - 只有点「分享到 amoo」才调用 Intent；回车只换行，不发送
///   - 结果只显示「已交给 amoo / 已打开系统分享面板」，不显示「已发送」
///   - 不读取 amoo 的回复（没有可信回执通道），因此也没有「最近回复」区
///
/// JSON 直显：粘进来的是控制台命令（`{"tool":…,"args":{…}}`）时，面板**不跳
/// amoo**，改为就地经 ConsoleService.exec 跑掉，并把结果渲染成一张结构化卡片。
/// 判据 [looksLikeConsoleCommand] 与原生侧 AmooLoop.looksLikeCommand 同形。
Future<void> showAmooComposer(BuildContext context, {String initialText = ''}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (ctx) => _AmooComposer(initialText: initialText),
  );
}

class _AmooComposer extends StatefulWidget {
  final String initialText;
  const _AmooComposer({required this.initialText});

  @override
  State<_AmooComposer> createState() => _AmooComposerState();
}

class _AmooComposerState extends State<_AmooComposer> {
  late final TextEditingController _input =
      TextEditingController(text: widget.initialText);
  AmooStatus _status = const AmooStatus();
  bool _loading = true;
  bool _sending = false;
  AmooSendResult? _result;

  /// 就地执行一条命令后拿到的记录。null = 还没走过本地执行这条路。
  ///
  /// 与 [_result] 分开存而不是塞进同一个字段：两者答的不是同一个问题——
  /// [_result] 说的是「有没有交给 amoo」，这个说的是「在本机跑成了没有」。
  /// 混在一起，界面就得靠猜来分辩该显示哪一句。
  ConsoleEntry? _local;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final s = await AmooService.status();
    if (mounted) {
      setState(() {
        _status = s;
        _loading = false;
      });
    }
  }

  /// 命令走本机，别的话走 amoo。分叉只此一处。
  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    if (looksLikeConsoleCommand(text)) {
      await _execLocally(text);
      return;
    }
    setState(() {
      _sending = true;
      _result = null;
    });
    final r = await AmooService.shareText(text);
    if (mounted) {
      setState(() {
        _sending = false;
        _result = r;
      });
      if (r.ok) {
        _input.clear();
      }
    }
  }

  /// 就地执行：解析、校验、执行、落共享历史全在原生侧，这里只翻译。
  ///
  /// 输入框**不清**：执行结果常常要求人改一个参数再发一次，把原文收掉等于
  /// 让他重新粘一遍。
  Future<void> _execLocally(String text) async {
    setState(() {
      _sending = true;
      _result = null;
      _local = null;
    });
    final entry = await ConsoleService.exec(text);
    if (!mounted) return;
    setState(() => _sending = false);
    if (entry == null) {
      // 通道断了，不是「命令失败」——两者的处置完全不同。
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('控制台通道不可用：原生层没有响应（App 可能是旧版，重启后重试）')),
      );
      return;
    }
    setState(() => _local = entry);
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final count = _input.text.length;
    // 命令不经过 amoo，所以「amoo 分享入口不可用」不该把命令也一起禁掉——
    // 那正是 JSON 直显要消除的一种「明明能跑却不让你跑」。
    final isCommand = looksLikeConsoleCommand(_input.text);
    final canSend = isCommand || (!_loading && _status.canShare);

    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.page,
        right: AppSpacing.page,
        top: 4,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.page,
      ),
      // 键盘 + 结果条 + 多行输入在小屏会超过 sheet 高度：整块可滚动，避免 overflow。
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(Icons.forum_outlined, size: 18, color: palette.primary),
                const SizedBox(width: AppSpacing.dense),
                Expanded(
                  child: Text(
                    '分享到 amoo',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.cardTitle.copyWith(
                      color: palette.textPrimary,
                    ),
                  ),
                ),
                if (_status.installed)
                  TextButton.icon(
                    onPressed: () async {
                      final ok = await AmooService.openChat();
                      if (!ok && context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('无法打开 amoo')),
                        );
                      }
                    },
                    icon: const Icon(Icons.open_in_new, size: 16),
                    label: const Text('打开 amoo'),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              _loading ? '正在检测 amoo 安装状态…' : _status.summary,
              style: AppText.secondary.copyWith(
                color: _status.installed
                    ? palette.textSecondary
                    : palette.error,
              ),
            ),
            const SizedBox(height: AppSpacing.cardGap),
            // 这句话会去哪里。判定与发送时的分叉同一处（looksLikeConsoleCommand），
            // 这里只把它显示出来：两条路一个是跳去 amoo 等约 6 分钟，一个是就地
            // 返回，按钮上却写着同一个词。不写清楚，用户会以为卡死。
            Text(
              looksLikeConsoleCommand(_input.text)
                  ? '识别为本地命令：将在这台手机上执行，不跳 amoo'
                  : '将作为文本分享给 amoo',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
            TextField(
              controller: _input,
              enabled: canSend && !_sending,
              minLines: 3,
              maxLines: 6,
              maxLength: 4000,
              decoration: InputDecoration(
                hintText: isCommand
                    ? '{"tool":"ls","args":{"path":"/sdcard"}}'
                    : canSend
                        ? '输入要分享给 amoo 的文本…'
                        : 'amoo 分享入口不可用',
                // 主题只接管 enabled/focused 描边，disabled 态会退回这个
                // decoration.border（默认 4 圆角），钉成 medium 与主题一致。
                border: const OutlineInputBorder(
                  borderRadius: BorderRadius.all(
                    Radius.circular(AppRadius.medium),
                  ),
                ),
                counterText: '$count/4000',
              ),
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) {
                // 回车不发送：避免误触把半句话投出去
              },
            ),
            const SizedBox(height: 4),
            FilledButton.icon(
              onPressed: !_sending && _input.text.trim().isNotEmpty
                  ? _send
                  : null,
              icon: _sending
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send, size: 16),
              label: Text(_sendLabel),
            ),
            const SizedBox(height: AppSpacing.dense),
            Text(
              looksLikeConsoleCommand(_input.text)
                  ? '命令由本机执行并落进控制台历史；下面的卡片就是结果。'
                  : 'amoo 是否真正读取或回复无法确认；本页不读取回执，请在 amoo 中查看回复。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
            if (_local != null) ...[
              const SizedBox(height: AppSpacing.inner),
              _localCard(_local!, palette),
            ],
            if (_result != null) ...[
              const SizedBox(height: AppSpacing.inner),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.cardPadNarrow,
                  vertical: AppSpacing.inner,
                ),
                decoration: BoxDecoration(
                  color: (_result!.ok ? palette.success : palette.error)
                      .withValues(alpha: AppAlpha.weakFill),
                  borderRadius: BorderRadius.circular(AppRadius.small),
                  border: Border.all(
                    color: (_result!.ok ? palette.success : palette.error)
                        .withValues(alpha: AppAlpha.strokeWeak),
                    width: AppStroke.thin,
                  ),
                ),
                child: Text(
                  _result!.displayMessage,
                  style: AppText.secondary.copyWith(
                    color: _result!.ok ? palette.textPrimary : palette.error,
                  ),
                  maxLines: 6,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// 按钮文案跟着路由走。同一颗按钮标同一个词，人就只能靠猜。
  String get _sendLabel {
    if (_sending) {
      return looksLikeConsoleCommand(_input.text) ? '正在本机执行…' : '正在交给 amoo…';
    }
    return looksLikeConsoleCommand(_input.text) ? '在本机执行' : '分享到 amoo';
  }

  /// 就地执行的结果卡片：字段而不是一段话。
  ///
  /// 三类失败在原生侧就已经分开（invalid_args / tool_unavailable /
  /// exec_error），这里照原样显示，不重新判断——重新判断就等于有两份规则。
  /// 完整记录在控制台历史里，卡片只放当场要看的几项。
  Widget _localCard(ConsoleEntry e, AppPalette palette) {
    final ok = e.status.isOk;
    final color = ok ? palette.success : palette.error;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.cardPadNarrow,
        vertical: AppSpacing.inner,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: AppAlpha.weakFill),
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(
          color: color.withValues(alpha: AppAlpha.strokeWeak),
          width: AppStroke.thin,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(ok ? Icons.check_circle_outline : Icons.error_outline,
                  size: 16, color: color),
              const SizedBox(width: AppSpacing.dense),
              Text(e.tool.isEmpty ? '（无工具名）' : e.tool,
                  style: AppText.secondary.copyWith(
                    color: palette.textPrimary,
                    fontWeight: FontWeight.w700,
                  )),
              const SizedBox(width: AppSpacing.dense),
              Text(e.timeText, style: AppText.secondary),
            ],
          ),
          if (!ok && e.error.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(e.error,
                style: AppText.secondary.copyWith(color: color, height: 1.3)),
          ],
          if (e.hint.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(e.hint, style: AppText.secondary.copyWith(height: 1.3)),
          ],
          const SizedBox(height: 2),
          Text('状态 ${e.statusRaw} · 完整记录见控制台历史',
              style: AppText.secondary.copyWith(color: palette.textSecondary)),
        ],
      ),
    );
  }
}
