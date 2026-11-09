// khy-canary: Khy-20261101-129-5TZCS1HH
import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// Khy OS 品牌主标（内核环）。
///
/// 形态：四段弧叶围成的光圈（= 四条主张）+ 中心菱形内核（= kernel / runtime），
/// 内核上刻一道 K 形负槽（= 品牌字母，可发现但不主导读感）。
///
/// 几何真源：`delivery/brand/khy-brand-geometry.js`；位图由
/// `node scripts/brand/build-brand-assets.js` 渲染进 `assets/brand/`。
/// **不要手改 assets/brand/ 下的 PNG** —— 改了会被下一次构建覆盖。
class KhyBrandMark extends StatelessWidget {
  const KhyBrandMark({super.key, this.size = 24});

  /// 主标边长（像素）。
  final double size;

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      'assets/brand/khy-os-mark-256.png',
      width: size,
      height: size,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.high,
      // 品牌资产是构建期落盘的，不随包下载；缺失时也不该把界面撑破。
      errorBuilder: (context, error, stack) => SizedBox(width: size, height: size),
    );
  }
}

/// 品牌块：墨黑圆角底 + 琥珀主标。
///
/// 旧版这里排版的是一个字母「K」，且底色是蓝→品红渐变（2023 年后 AI 产品的通用色系）。
/// 现在与 Web / 桌面端 / TUI 共用同一枚主标与同一块墨黑底。
class KhyBrandTile extends StatelessWidget {
  const KhyBrandTile({
    super.key,
    this.size = 48,
    this.radius = 12,
    this.markScale = 0.62,
  });

  /// 底板边长。
  final double size;

  /// 底板圆角。
  final double radius;

  /// 主标相对底板的比例。
  final double markScale;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: AppColors.brandInk,
        borderRadius: BorderRadius.circular(radius),
      ),
      child: Center(
        child: KhyBrandMark(size: size * markScale),
      ),
    );
  }
}
