import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/drivers/driver_event.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import '../widgets/thinking_block.dart';
import 'content_tier.dart';
import 'envelope_render.dart';

/// 一轮结构化回复的渲染（A 阶段 T2/T3/T5）。
///
/// 块按 [EnvelopeTurn.blocks] 的数组原序画，一一对应，不重排；未知块折叠标注、
/// 原文保留；未知 proto_v 画版本不匹配角标、内容按最低兼容版本渲染；failed
/// 保留已收块并如实显示失败行。所有状态行都来自 [EnvelopeTurn.statusLine]
/// （RUNTIME-002），视图自己不拼状态文案。
class EnvelopeReplyView extends StatelessWidget {
  const EnvelopeReplyView({super.key, required this.turn});

  final EnvelopeTurn turn;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: turn.revision,
      builder: (context, _, _) {
        final palette = AppPalette.of(context);
        final children = <Widget>[];

        if (!turn.protoVSupported) {
          children.add(_badge(
            palette,
            Icons.error_outline,
            '协议版本不匹配 · 按最低兼容版本渲染',
            color: palette.warning,
          ));
        }
        if (turn.tier != null) {
          final label = switch (turn.tier!) {
            EnvelopeTier.l1Blocks => '结构化',
            EnvelopeTier.l2Fenced => '半结构化',
            EnvelopeTier.l3Plain => 'structured=false',
          };
          children.add(_badge(palette, Icons.data_object, label,
              color: palette.primary));
        }

        if (turn.state == TurnState.receiving && turn.blocks.isEmpty) {
          // 请求未返回只显示状态：不渲染任何占位正文。
          children.add(_statusRow(palette, turn.statusLine));
        }

        for (final b in turn.blocks) {
          children.add(_block(context, b, palette));
        }

        if (turn.tier != EnvelopeTier.l1Blocks &&
            turn.text != null &&
            turn.text!.isNotEmpty) {
          children.add(SelectableText(turn.text!, style: AppText.body));
        }

        if (turn.state == TurnState.failed ||
            (turn.state == TurnState.receiving && turn.blocks.isNotEmpty)) {
          children.add(_statusRow(palette, turn.statusLine));
        }

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final c in children)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.dense),
                child: c,
              ),
          ],
        );
      },
    );
  }

  Widget _badge(AppPalette palette, IconData icon, String text,
      {required Color color}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadius.pill),
        border: Border.all(color: color.withValues(alpha: 0.35),
            width: AppStroke.thin),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: color),
          const SizedBox(width: 4),
          Text(text,
              style: AppText.secondary
                  .copyWith(color: color, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }

  Widget _statusRow(AppPalette palette, String line) {
    return Row(
      children: [
        SizedBox(
          width: 12,
          height: 12,
          child: turn.state == TurnState.failed
              ? Icon(Icons.report_outlined,
                  size: 14, color: palette.error)
              : CircularProgressIndicator(
                  strokeWidth: 2, color: palette.primary),
        ),
        const SizedBox(width: AppSpacing.dense),
        Expanded(
          child: Text(line,
              style:
                  AppText.secondary.copyWith(color: palette.textSecondary)),
        ),
      ],
    );
  }

  Widget _block(BuildContext context, ReplyBlock b, AppPalette palette) {
    if (b is ReplyTextBlock) {
      return SelectableText(b.text, style: AppText.body);
    }
    if (b is ReplyReasoningBlock) {
      return ThinkingBlock(reasoning: b.text, streaming: false);
    }
    if (b is ReplyToolCallBlock) {
      return _panel(
        palette,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('调用 ${b.name}', style: AppText.body),
            const SizedBox(height: AppSpacing.dense / 2),
            Text('callId=${b.callId} args=${b.args}',
                style: AppText.secondary
                    .copyWith(color: palette.textSecondary)),
          ],
        ),
      );
    }
    if (b is ReplyToolResultBlock) {
      return _panel(
        palette,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(b.ok ? Icons.check : Icons.close,
                size: 14,
                color: b.ok ? palette.success : palette.error),
            const SizedBox(width: AppSpacing.dense / 2),
            Expanded(
              child: Text(b.summary, style: AppText.body),
            ),
          ],
        ),
      );
    }
    if (b is ReplyCodeBlock) {
      return _panel(
        palette,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (b.language != null)
              Text(b.language!,
                  style: AppText.secondary
                      .copyWith(color: palette.textSecondary)),
            const SizedBox(height: AppSpacing.dense / 2),
            Text(b.code,
                style: AppText.secondary.copyWith(
                    fontFamily: 'monospace',
                    color: palette.textPrimary)),
          ],
        ),
      );
    }
    if (b is ReplyImageBlock) {
      return _imageBlock(b.path, palette);
    }
    if (b is ReplyFileBlock) {
      return _panel(
        palette,
        child: Row(
          children: [
            const Icon(Icons.insert_drive_file_outlined, size: 14),
            const SizedBox(width: AppSpacing.dense / 2),
            Expanded(
              child: Text(
                b.size == null ? b.path : '${b.path} (${b.size} 字节)',
                style: AppText.body,
              ),
            ),
          ],
        ),
      );
    }
    if (b is ReplyTableBlock) {
      return _table(b, palette);
    }
    if (b is ReplyStatusBlock) {
      final line = driverStatusLine(DriverStatus(
        code: b.code,
        detail: b.detail,
        attempt: b.attempt,
      ));
      return Text(line.text, style: AppText.body);
    }
    if (b is ReplyUnknownBlock) {
      // 未知块：折叠标注 + 原文 JSON，展开可见（不丢内容）。
      return ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: 12),
        childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
        backgroundColor: palette.surfaceHigh,
        collapsedBackgroundColor: palette.surfaceHigh,
        title: Text('未知块类型 · 已折叠（降级为纯文本）',
            style: AppText.secondary.copyWith(color: palette.textSecondary)),
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: SelectableText(b.raw, style: AppText.secondary),
          ),
        ],
      );
    }
    // sealed 类到这里不可能到——保守兜一个空盒，不崩。
    return const SizedBox.shrink();
  }

  Widget _panel(AppPalette palette, {required Widget child}) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surfaceHigh,
        borderRadius: BorderRadius.circular(AppRadius.small),
        border:
            Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: child,
    );
  }

  Widget _imageBlock(String path, AppPalette palette) {
    Widget image = Icon(Icons.image_not_supported_outlined,
        size: 22, color: palette.textFaint);
    if (path.startsWith('http')) {
      image = Image.network(path, fit: BoxFit.cover,
          errorBuilder: (_, _, _) => image);
    } else {
      final file = File(path);
      if (file.existsSync()) {
        image = Image.file(file, fit: BoxFit.cover,
            errorBuilder: (_, _, _) =>
                Icon(Icons.image_not_supported_outlined,
                    size: 22, color: palette.textFaint));
      }
    }
    return _panel(
      palette,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(AppRadius.small),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 160),
              child: image,
            ),
          ),
          const SizedBox(height: AppSpacing.dense / 2),
          Text(path,
              style: AppText.secondary.copyWith(color: palette.textSecondary)),
        ],
      ),
    );
  }

  Widget _table(ReplyTableBlock b, AppPalette palette) {
    final headerStyle = AppText.secondary
        .copyWith(color: palette.textPrimary, fontWeight: FontWeight.w600);
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: Table(
        border: TableBorder.symmetric(
            inside: BorderSide(color: palette.stroke, width: AppStroke.thin)),
        children: [
          TableRow(
            decoration: BoxDecoration(color: palette.surfaceHigh),
            children: [
              for (final h in b.headers)
                Padding(
                  padding: const EdgeInsets.all(6),
                  child: Text('$h', style: headerStyle),
                ),
            ],
          ),
          for (final row in b.rows)
            TableRow(
              children: [
                for (final cell in row)
                  Padding(
                    padding: const EdgeInsets.all(6),
                    child: Text('$cell', style: AppText.body),
                  ),
              ],
            ),
        ],
      ),
    );
  }
}
