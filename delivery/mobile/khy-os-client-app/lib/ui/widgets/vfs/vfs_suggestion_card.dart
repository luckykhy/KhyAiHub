// 建议卡片：AI 主动建议的呈现。
//
// 三条纪律：
//   1. **只提示不自动执行**。清理是不可逆的，勾选与确认由人做。
//   2. **说清依据**。每条建议都带「为什么」——同名同大小、超过 100MB、90 天没动，
//      都是可核查的线索，不是模型的断言。
//   3. **给出空间量级**。用户决定要不要处理，靠的是「能腾出多少」。

import 'package:flutter/material.dart';

import '../../../core/vfs/vfs_suggestions.dart';
import '../../theme/design_tokens.dart';

/// 建议卡片。
class VfsSuggestionCard extends StatelessWidget {
  final List<VfsSuggestion> suggestions;

  /// 点某条建议。
  final ValueChanged<VfsSuggestion> onTap;

  /// 收起。
  final VoidCallback onDismiss;

  const VfsSuggestionCard({
    super.key,
    required this.suggestions,
    required this.onTap,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    if (suggestions.isEmpty) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.page,
        AppSpacing.dense,
        AppSpacing.page,
        0,
      ),
      decoration: BoxDecoration(
        color: palette.surfaceHigh,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: palette.stroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.cardPadNarrow,
              AppSpacing.cardPadNarrow,
              AppSpacing.dense,
              AppSpacing.dense,
            ),
            child: Row(
              children: <Widget>[
                Icon(Icons.auto_awesome, size: 16, color: palette.primary),
                const SizedBox(width: AppSpacing.dense),
                Expanded(
                  child: Text(
                    'AI 建议（${suggestions.length}）',
                    style: AppText.label.copyWith(color: palette.textSecondary),
                  ),
                ),
                IconButton(
                  onPressed: onDismiss,
                  icon: const Icon(Icons.close, size: 14),
                  color: palette.textFaint,
                  tooltip: '收起',
                ),
              ],
            ),
          ),
          for (final suggestion in suggestions)
            InkWell(
              onTap: () => onTap(suggestion),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.cardPadNarrow,
                  0,
                  AppSpacing.cardPadNarrow,
                  AppSpacing.cardPadNarrow,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            suggestion.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: AppText.body
                                .copyWith(color: palette.textPrimary),
                          ),
                        ),
                        const SizedBox(width: AppSpacing.dense),
                        if (suggestion.estimatedBytes > 0)
                          Text(
                            _readable(suggestion.estimatedBytes),
                            style: AppText.micro
                                .copyWith(color: palette.warning),
                          ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      suggestion.reason,
                      style: AppText.micro.copyWith(color: palette.textFaint),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  static String _readable(int bytes) {
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
}
