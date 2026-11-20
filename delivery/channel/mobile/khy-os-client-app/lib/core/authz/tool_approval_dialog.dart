import 'package:flutter/material.dart';

import '../../ui/theme/app_colors.dart';
import '../../ui/theme/design_tokens.dart';

/// Confirmation dialog for screen-side gated tools (agent / longcat). These
/// faces had no approval surface before the broker gate; this is the
/// fail-closed prompt [DialogApprovalChannel] calls. Returns true only on an
/// explicit 批准 — cancel returns false, and the barrier is non-dismissible so
/// silence never becomes consent.
Future<bool> showToolApprovalDialog(
  BuildContext context, {
  required String toolName,
  required Map<String, dynamic> params,
}) {
  final cs = Theme.of(context).colorScheme;
  final detail = _toolDetail(params);
  return showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => AlertDialog(
      title: Row(
        children: [
          Icon(Icons.warning_amber_rounded, color: cs.error, size: 24),
          const SizedBox(width: 8),
          const Text('需要你的授权', style: AppText.cardTitle),
        ],
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('即将执行：$toolName',
              style: AppText.body.copyWith(color: cs.onSurface)),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: cs.error.withValues(alpha: AppAlpha.weakFill),
              borderRadius: BorderRadius.circular(AppRadius.small),
              border: Border.all(
                color: cs.error.withValues(alpha: AppAlpha.strokeWeak),
              ),
            ),
            child: Text(
              detail,
              style: AppText.cardTitleNarrow.copyWith(fontFamily: 'monospace'),
            ),
          ),
          const SizedBox(height: 8),
          Text('此操作可能影响系统，请确认你了解风险。',
              style: AppText.secondary.copyWith(
                  color: AppPalette.of(ctx).textSecondary)),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text('取消', style: TextStyle(color: cs.onSurfaceVariant)),
        ),
        ElevatedButton(
          onPressed: () => Navigator.pop(ctx, true),
          style: ElevatedButton.styleFrom(backgroundColor: cs.error),
          child: const Text('批准执行'),
        ),
      ],
    ),
  ).then((v) => v ?? false);
}

/// Pulls the command string out of the three shapes the shell tools use
/// (android `{cmd:'shell', command}`, exec_shell `{command}`,
/// exec_shell_elevated `{args:{command}}`); falls back to a short param summary
/// for non-shell ask tools such as vision_tap.
String _toolDetail(Map<String, dynamic> params) {
  final cmd = params['command']?.toString() ??
      params['args']?['command']?.toString() ??
      '';
  if (cmd.isNotEmpty) {
    return cmd.length > 200 ? '${cmd.substring(0, 200)}...' : cmd;
  }
  final entries = params.entries
      .where((e) => !e.key.startsWith('_'))
      .take(4)
      .map((e) => '${e.key}: ${e.value}')
      .join('\n');
  return entries.isEmpty ? '(无参数)' : entries;
}