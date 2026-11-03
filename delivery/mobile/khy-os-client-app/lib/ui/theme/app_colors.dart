// khy-canary: Khy-20261101-123-KRDTD58B
import 'package:flutter/material.dart';

/// Colour constants that screens reference directly.
///
/// Every name here is imported by dozens of files, so it stays even where the
/// new palette expresses the same idea differently (tertiary, accentMid, the
/// Light/Dark surface pairs). Brightness-aware role names live in AppPalette
/// (design_tokens.dart) — one Color constant cannot carry both tones.
/// The values below are the dark-side brand set, because the app's base is the
/// deep-space glass one.
class AppColors {
  // Brand trio plus the fourth accent. The one gradient is identity, not a
  // theme accent, so these do not shift with brightness.
  //
  // 2026-10-25：品牌主色由「蓝→紫→品红」整族换成**琥珀族**
  // （真源 delivery/brand/khy-brand-geometry.js 的 PALETTE）。旧值是 2023 年后
  // AI 产品的通用色系，五端各画各的；现在四端（Web / 桌面 / TUI / 移动）同源。
  // 本 App 的底色是深空系（surfaceDark #0A0E1C），故主色取暗底上的文本安全值
  // #f0a868（对 #0A0E1C 约 9.62:1）。
  static const Color primary = Color(0xFFF0A868);
  static const Color primaryStrong = Color(0xFFFFC078);
  static const Color accent = Color(0xFFE2703A);
  static const Color hot = Color(0xFFFFC078);
  static const Color cyan = Color(0xFF67E8F9);

  /// 品牌底板（墨黑）：品牌块、启动画面的底色。与 Web / 桌面端同一取值。
  static const Color brandInk = Color(0xFF14110E);

  static const Color onPrimary = Color(0xFFFFFFFF);
  static const Color primaryContainer = Color(0x244D7CFF);
  static const Color onPrimaryContainer = primary;

  static const Color secondary = accent;
  static const Color onSecondary = Color(0xFFFFFFFF);
  static const Color secondaryContainer = Color(0x248B5CF6);
  static const Color onSecondaryContainer = accent;

  static const Color tertiary = hot;
  static const Color onTertiary = Color(0xFFFFFFFF);
  static const Color tertiaryContainer = Color(0x24E363F9);
  static const Color onTertiaryContainer = hot;

  static const Color error = Color(0xFFFF6B6B);
  static const Color onError = Color(0xFFFFFFFF);
  static const Color errorContainer = Color(0x1FFF6B6B);
  static const Color onErrorContainer = error;

  static const Color success = Color(0xFF3DDC97);
  static const Color onSuccess = Color(0xFFFFFFFF);

  static const Color warning = Color(0xFFFFB74A);
  static const Color onWarning = Color(0xFF171E38);

  static const Color surfaceLight = Color(0xFFF2F5FE);
  static const Color onSurfaceLight = Color(0xFF171E38);
  static const Color surfaceVariantLight = Color(0xFFEBF0FC);
  static const Color onSurfaceVariantLight = Color(0xFF5C6784);
  static const Color outlineLight = Color(0xFFDFE6F8);
  // One stroke colour per tone: the lighter second border was where the
  // 0.2-0.4 alpha outlines came from.
  static const Color outlineVariantLight = outlineLight;

  /// 思维链折叠块底色（亮）。比气泡 surface 低半级，读作「正文之前的草稿」而
  /// 不是「另一条消息」。
  ///
  /// 2026-11-03：旧值与输入框 fill（[surfaceVariantLight]）是**同一个值**
  /// #EBF0FC，CIELAB ΔE76 = 0，用户看到的是「两块一样底」，只靠左侧 1.5px 主色边
  /// 区分，而那道边亮色下仅 1.41:1。现取 #E1E9F9，与 fill 的 ΔE76 = 3.44（可感知），
  /// 对页面背景（surfaceLight #F2F5FE）1.12:1，仍落在既有同档区间内（亮卡片 1.09 /
  /// 暗侧思维链 1.16）。块上文字 contrast 与描边 contrast 的完整数字见
  /// design_tokens.dart 的 reasoningSurface。
  static const Color reasoningSurfaceLight = Color(0xFFE1E9F9);

  static const Color surfaceDark = Color(0xFF0A0E1C);
  static const Color onSurfaceDark = Color(0xFFEBF0FF);
  static const Color surfaceVariantDark = Color(0xFF1A2342);
  static const Color onSurfaceVariantDark = Color(0xFF96A2C5);
  static const Color outlineDark = Color(0xFF263153);
  static const Color outlineVariantDark = outlineDark;

  /// 思维链折叠块底色（暗）。取 surface(#121A30) 与 surfaceHigh(#1A2342) 之间
  /// 那一级——surfaceHigh 是输入框 fill，思维链不能读成可编辑区。
  static const Color reasoningSurfaceDark = Color(0xFF141D38);

  /// Midpoint for callers that still interpolate primary to accent by hand.
  static const Color accentMid = Color(0xFF6D5EFC);
}

/// Values only, names unchanged: every screen already calls these.
class AppRadius {
  /// Chips, icon containers, small badges.
  static const double small = 12;

  /// Standard cards, inputs, buttons, dialogs.
  static const double medium = 16;

  /// Welcome cards, permission cards, large containers.
  static const double large = 20;

  /// Hero logo and launch tile.
  static const double xLarge = 28;

  /// Capsules: pill buttons, segmented controls, badges.
  static const double pill = 999;
}

/// Motion durations. Every animation that loops must also honour
/// `MediaQuery.disableAnimations`.
class AppDuration {
  /// Press squash. The spec's 120ms read too snappy once the scale sat on
  /// glass surfaces, so the 180-220ms band was chosen.
  static const Duration press = Duration(milliseconds: 200);

  /// Colour, border and state switches.
  static const Duration micro = Duration(milliseconds: 200);

  /// Route and drawer transitions.
  static const Duration page = Duration(milliseconds: 300);

  /// Legacy name for [page].
  static const Duration pageTransition = page;

  /// First-screen fade plus 12dp rise.
  static const Duration enter = Duration(milliseconds: 280);

  /// Tab icon and segmented-control overshoot.
  static const Duration spring = Duration(milliseconds: 300);

  /// One hop of the three-dot loader.
  static const Duration dots = Duration(milliseconds: 400);

  /// Half of the running halo breath.
  static const Duration breathe = Duration(milliseconds: 1600);

  /// One full aurora drift; slow enough to read as light, not as motion.
  static const Duration drift = Duration(seconds: 40);

  static const Duration overlay = Duration(milliseconds: 150);
  static const Duration progress = Duration(milliseconds: 500);
}

/// Depth and glow. Glow is reserved for tappable focus and running state —
/// static text and lists never carry a shadow.
class AppShadows {
  static const List<BoxShadow> card = <BoxShadow>[
    BoxShadow(color: Color(0x1F000000), blurRadius: 24, offset: Offset(0, 8)),
  ];

  static const List<BoxShadow> floating = <BoxShadow>[
    BoxShadow(color: Color(0x29000000), blurRadius: 32, offset: Offset(0, 12)),
  ];

  static const List<BoxShadow> dialog = <BoxShadow>[
    BoxShadow(color: Color(0x73000000), blurRadius: 40, offset: Offset(0, 14)),
  ];

  /// Primary and send buttons.
  static const List<BoxShadow> glowPrimary = <BoxShadow>[
    BoxShadow(color: Color(0x4D4D7CFF), blurRadius: 20, offset: Offset(0, 6)),
  ];

  /// 36dp logo tiles and capsule buttons.
  static const List<BoxShadow> glowSoft = <BoxShadow>[
    BoxShadow(color: Color(0x294D7CFF), blurRadius: 14, offset: Offset(0, 4)),
  ];

  /// 96dp hero logo and launch tile.
  static const List<BoxShadow> glowHero = <BoxShadow>[
    BoxShadow(color: Color(0x5C4D7CFF), blurRadius: 32, offset: Offset(0, 10)),
  ];

  /// Legacy name for [glowPrimary].
  static const List<BoxShadow> primaryGlow = glowPrimary;

  /// Running-state halo for the one card that is allowed to glow.
  /// [t] runs 0..1 across [AppDuration.breathe].
  static List<BoxShadow> breathe(double t) => <BoxShadow>[
        BoxShadow(
          color: AppColors.primary.withValues(alpha: 0.18 + 0.2 * t),
          blurRadius: 16,
        ),
      ];
}
