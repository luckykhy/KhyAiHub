// khy-canary: Khy-20261101-126-2DZ4GHQP
import 'package:flutter/material.dart';
import '../../core/services/amoo_service.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// amoo 发送面板（设备页卡片与聊天页快捷动作共用）。
///
/// 交互约束：
///   - 只有点「分享到 amoo」才调用 Intent；回车只换行，不发送
///   - 结果只显示「已交给 amoo / 已打开系统分享面板」，不显示「已发送」
///   - 不读取 amoo 的回复（没有可信回执通道），因此也没有「最近回复」区
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

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
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

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final canSend = !_loading && _status.canShare;
    final count = _input.text.length;

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
            TextField(
              controller: _input,
              enabled: canSend && !_sending,
              minLines: 3,
              maxLines: 6,
              maxLength: 4000,
              decoration: InputDecoration(
                hintText: canSend ? '输入要分享给 amoo 的文本…' : 'amoo 分享入口不可用',
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
              onPressed: canSend && !_sending && _input.text.trim().isNotEmpty
                  ? _send
                  : null,
              icon: _sending
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send, size: 16),
              label: Text(_sending ? '正在交给 amoo…' : '分享到 amoo'),
            ),
            const SizedBox(height: AppSpacing.dense),
            Text(
              'amoo 是否真正读取或回复无法确认；本页不读取回执，请在 amoo 中查看回复。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
            if (_result != null) ...[
              const SizedBox(height: AppSpacing.inner),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.cardPadNarrow,
                  vertical: AppSpacing.inner,
                ),
                decoration: BoxDecoration(
                  color: (_result!.ok ? palette.primary : palette.error)
                      .withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(AppRadius.small),
                  border: Border.all(
                    color: (_result!.ok ? palette.primary : palette.error)
                        .withValues(alpha: 0.35),
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
}
