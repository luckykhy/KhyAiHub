// 地址栏：面包屑 + 可直接输入的路径。
//
// 为什么地址栏要能直接输入任意路径：专业用户要能「跳到我知道的地方」，而不是
// 一层层点进去。侧栏给的是常用入口，地址栏给的是**任意位置**——两者缺一不可。
//
// 面包屑保留是因为人脑记路径靠的是「根 → 一段 → 一段」，不是一整串斜杠。

import 'package:flutter/material.dart';

import '../../../core/vfs/vfs_route.dart';
import '../../theme/design_tokens.dart';

/// 地址栏。
class VfsAddressBar extends StatelessWidget {
  final String path;

  /// 提交一个新路径。
  final ValueChanged<String> onNavigate;

  /// 向上一级。
  final VoidCallback onUp;

  /// 只读提示（系统分区）。
  final bool readOnly;

  const VfsAddressBar({
    super.key,
    required this.path,
    required this.onNavigate,
    required this.onUp,
    this.readOnly = false,
  });

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final controller = TextEditingController(text: path);
    controller.selection = TextSelection(
      baseOffset: 0,
      extentOffset: path.length,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        SizedBox(
          height: 40,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.page),
            children: _crumbs(context),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.page,
            AppSpacing.dense,
            AppSpacing.page,
            0,
          ),
          child: Row(
            children: <Widget>[
              IconButton(
                onPressed: onUp,
                icon: const Icon(Icons.arrow_upward, size: 18),
                tooltip: '上一级',
                color: palette.textSecondary,
              ),
              Expanded(
                child: TextField(
                  controller: controller,
                  style: AppText.body.copyWith(color: palette.textPrimary),
                  onSubmitted: onNavigate,
                  textInputAction: TextInputAction.go,
                  decoration: InputDecoration(
                    isDense: true,
                    hintText: '输入路径',
                    hintStyle:
                        AppText.body.copyWith(color: palette.textFaint),
                    prefixIcon: Icon(Icons.search, size: 18, color: palette.textFaint),
                    suffixIcon: readOnly
                        ? Icon(Icons.lock_outline,
                            size: 16, color: palette.warning)
                        : null,
                    filled: true,
                    fillColor: palette.surfaceHigh,
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
                      borderSide: BorderSide(color: palette.stroke),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  List<Widget> _crumbs(BuildContext context) {
    final palette = AppPalette.of(context);
    final segments = VfsPath.segments(path);
    final crumbs = <Widget>[];
    var accumulated = '';
    for (final segment in segments) {
      accumulated = '$accumulated/$segment';
      final target = accumulated;
      crumbs.add(
        InkWell(
          onTap: () => onNavigate(target),
          borderRadius: BorderRadius.circular(6),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.dense,
              vertical: AppSpacing.dense,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  segment,
                  style: AppText.secondary.copyWith(color: palette.primary),
                ),
                Icon(Icons.chevron_right,
                    size: 14, color: palette.textFaint),
              ],
            ),
          ),
        ),
      );
    }
    if (crumbs.isEmpty) {
      crumbs.add(
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.dense,
            vertical: AppSpacing.dense,
          ),
          child: Text(
            '全部位置',
            style: AppText.secondary.copyWith(color: palette.textSecondary),
          ),
        ),
      );
    }
    return crumbs;
  }
}
