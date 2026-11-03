// khy-canary: Khy-20261101-125-8Y73HMJZ
import 'package:flutter/material.dart';

import 'app_colors.dart';

/// The full role set for one brightness, plus the token scales of the design
/// language in `DESIGN-UI.md` §2-§5.
///
/// Raw pigments stay in app_colors.dart: dozens of screens import those names,
/// and a const alias has to point at a const literal rather than at an instance
/// field of [AppPalette.dark]. AppRadius, AppDuration and AppShadows stay there
/// for the same reason. Everything that used to have no home — the
/// brightness-aware roles, the type scale, spacing, strokes, curves — lands here.
///
/// A single `Color` constant cannot hold both the light and the dark value of a
/// role, which is why screens read a palette through [of] instead.
class AppPalette {
  const AppPalette({
    required this.brightness,
    required this.pageBg,
    required this.surface,
    required this.surfaceHigh,
    required this.reasoningSurface,
    required this.stroke,
    required this.strokeStrong,
    required this.textPrimary,
    required this.textSecondary,
    required this.textFaint,
    required this.primary,
    required this.accent,
    required this.hot,
    required this.cyan,
    required this.success,
    required this.warning,
    required this.error,
    required this.glassStroke,
  });

  final Brightness brightness;

  /// Scaffold background.
  final Color pageBg;

  /// Cards, bubbles, dialogs.
  final Color surface;

  /// Inputs, nested containers, quick-action tiles.
  final Color surfaceHigh;

  /// 思维链折叠块底色。比 [surface] 低半级：读作「正文之前的草稿」，
  /// 不是「另一条消息」，也不是输入框（[surfaceHigh] 那一档）。
  ///
  /// 对页面背景的 WCAG 对比度：暗 1.16:1、亮 1.12:1——同档既有卡片
  /// （[surface]）是 1.11 / 1.09，本设计语言靠描边与层级分块、不靠底色对比，
  /// 取值与之一致。块上文字只用 textPrimary / textSecondary（暗 14.61 / 6.55、
  /// 亮 13.46 / 4.62，均过 4.5:1）；**textFaint 在这两个底上只有 3.16 / 2.02，
  /// 禁止用于本块正文**。
  ///
  /// 亮侧 2026-11-03 由 #EBF0FC 改为 #E1E9F9：旧值与输入框 fill（亮侧
  /// [surfaceHigh] = AppColors.surfaceVariantLight #EBF0FC）是同一个值，
  /// CIELAB ΔE76 = 0，即「一字不差」，只靠左侧 1.5px 主色边分块，而那道边对
  /// #EBF0FC 只有 1.41:1。新值实算（Node，sRGB→XYZ D65→Lab，ΔE76）：
  /// - 与 fill 的 ΔE76 = 3.44（≥ 3，可感知）；
  /// - 对页面背景 1.12:1，仍在 1.09（亮卡片）～1.16（暗侧思维链）的同档区间；
  /// - textPrimary 13.46:1、textSecondary 4.62:1，均过 AA 4.5:1；
  /// - 未新增颜色常量，仍是同一族的低半级（CIELAB 色相 272.4°，fill 是 275.0°；
  ///   明度 L* 94.74 → 92.19）。
  ///
  /// 左侧主色描边对本底是 1.32:1（旧底 1.41:1）。换成 AppColors.primary
  /// #F0A868 可到 1.64:1，但那要么改 AppPalette.light.primary（亮主题全局主色，
  /// 按钮/焦点环/ColorScheme 全跟着变，非外科手术），要么改
  /// ThinkingBlock 的 stroke 取色（不在本次改动范围内），故未换令牌。
  final Color reasoningSurface;

  /// The one 1px border colour for standard cards.
  final Color stroke;

  /// Pressed borders and segmented-control outlines.
  final Color strokeStrong;

  final Color textPrimary;
  final Color textSecondary;
  final Color textFaint;

  final Color primary;
  final Color accent;
  final Color hot;
  final Color cyan;

  final Color success;
  final Color warning;
  final Color error;

  /// White 8% on dark, black 5% on light — the edge of a glass surface.
  final Color glassStroke;

  static const AppPalette dark = AppPalette(
    brightness: Brightness.dark,
    pageBg: AppColors.surfaceDark,
    surface: Color(0xFF121A30),
    surfaceHigh: AppColors.surfaceVariantDark,
    reasoningSurface: AppColors.reasoningSurfaceDark,
    stroke: AppColors.outlineDark,
    strokeStrong: Color(0xFF33406B),
    textPrimary: AppColors.onSurfaceDark,
    textSecondary: AppColors.onSurfaceVariantDark,
    textFaint: Color(0xFF5F6B8F),
    primary: AppColors.primary,
    accent: AppColors.accent,
    hot: AppColors.hot,
    cyan: AppColors.cyan,
    success: AppColors.success,
    warning: AppColors.warning,
    error: AppColors.error,
    glassStroke: Color(0x14FFFFFF),
  );

  static const AppPalette light = AppPalette(
    brightness: Brightness.light,
    pageBg: AppColors.surfaceLight,
    surface: Color(0xFFFFFFFF),
    surfaceHigh: AppColors.surfaceVariantLight,
    reasoningSurface: AppColors.reasoningSurfaceLight,
    stroke: AppColors.outlineLight,
    strokeStrong: Color(0xFFC9D4F0),
    textPrimary: AppColors.onSurfaceLight,
    textSecondary: AppColors.onSurfaceVariantLight,
    textFaint: Color(0xFF9AA5C0),
    // primaryStrong is the *lighter* brand tone (AppColors.primary #F0A868 对深空底
    // #0A0E1C 是 9.62:1，primaryStrong 是 11.96:1), which is exactly the light-theme
    // primary; sharing it keeps one literal for one colour.
    primary: AppColors.primaryStrong,
    accent: Color(0xFF7C4DFF),
    hot: Color(0xFFD946EF),
    cyan: Color(0xFF0891B2),
    success: Color(0xFF0E9F6E),
    warning: Color(0xFFDC6803),
    error: Color(0xFFE5484D),
    glassStroke: Color(0x0D000000),
  );

  static AppPalette of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}

/// Type scale. Colours are applied by the theme so one style serves both tones.
class AppText {
  static const TextStyle display = TextStyle(
    fontSize: 28,
    fontWeight: FontWeight.w800,
    height: 1.25,
    letterSpacing: -0.3,
  );

  static const TextStyle title = TextStyle(
    fontSize: 20,
    fontWeight: FontWeight.w800,
    height: 1.25,
    letterSpacing: -0.3,
  );

  static const TextStyle cardTitle = TextStyle(
    fontSize: 15,
    fontWeight: FontWeight.w600,
    height: 1.4,
  );

  static const TextStyle body = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w400,
    height: 1.5,
  );

  static const TextStyle secondary = TextStyle(
    fontSize: 12,
    fontWeight: FontWeight.w400,
    height: 1.4,
  );

  static const TextStyle label = TextStyle(
    fontSize: 11,
    fontWeight: FontWeight.w600,
    height: 1.4,
  );

  static const TextStyle micro = TextStyle(
    fontSize: 10,
    fontWeight: FontWeight.w500,
    height: 1.4,
  );
}

/// Only these gaps exist; 6/14/20/22 were the drift this scale replaces.
class AppSpacing {
  static const double page = 16;
  static const double section = 24;
  static const double cardGap = 12;
  static const double cardPad = 16;
  static const double cardPadNarrow = 12;
  static const double inner = 10;
  static const double dense = 8;
}

class AppStroke {
  static const double thin = 1;
  static const double focus = 1.5;
}

/// `BackdropFilter` is dart:ui built-in — no package is allowed for glass.
class AppGlass {
  static const double sigma = 18;

  /// Top bar and capability strip.
  static const double bar = 0.72;

  /// Quick-action dock and input area.
  static const double dock = 0.82;

  /// Bottom navigation.
  static const double nav = 0.88;
}

/// The only two gradients in the app: hero logo, primary action, user bubble.
class AppGradients {
  static const LinearGradient brand = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: <Color>[AppColors.primary, AppColors.accent, AppColors.hot],
  );

  static const LinearGradient brand2 = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: <Color>[AppColors.primary, AppColors.accent],
  );
}

/// Curves are paired with the durations in AppDuration.
class AppCurves {
  /// 120-200ms press squash.
  static const Curve press = Curves.easeOut;

  /// Colour, border and size micro-transitions.
  static const Curve standard = Curves.easeOutCubic;

  /// Tab icon and segmented-control thumb overshoot.
  static const Curve spring = Curves.easeOutBack;

  /// Looping states: breathing halo and the three-dot loader.
  static const Curve loop = Curves.easeInOutSine;
}
