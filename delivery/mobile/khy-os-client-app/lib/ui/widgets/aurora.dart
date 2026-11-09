// khy-canary: Khy-20261101-128-D9K5B9WY
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// Full-screen aurora backdrop.
///
/// The drift repaints through the painter's listenable, so the 40s loop never
/// rebuilds the subtree. Wrap the Scaffold and make it transparent, otherwise
/// the scaffold's own pageBg paints over the spots.
class AuroraBackground extends StatefulWidget {
  const AuroraBackground({super.key, required this.child});

  final Widget child;

  @override
  State<AuroraBackground> createState() => _AuroraBackgroundState();
}

class _AuroraBackgroundState extends State<AuroraBackground>
    with SingleTickerProviderStateMixin {
  late final AnimationController _drift =
      AnimationController(vsync: this, duration: AppDuration.drift);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Reduced motion stops the loop rather than slowing it: a slow loop is
    // still permanent movement, which is what the setting asks us to remove.
    final reduced = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (reduced) {
      _drift.stop();
    } else if (!_drift.isAnimating) {
      _drift.repeat();
    }
  }

  @override
  void dispose() {
    _drift.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: <Widget>[
        Positioned.fill(
          child: RepaintBoundary(
            child: SizedBox.expand(
              child: CustomPaint(
                painter: _AuroraPainter(
                  progress: _drift,
                  palette: AppPalette.of(context),
                ),
              ),
            ),
          ),
        ),
        widget.child,
      ],
    );
  }
}

class _AuroraPainter extends CustomPainter {
  _AuroraPainter({required this.progress, required this.palette})
      : _primary = _fade(palette.primary, palette.brightness),
        _accent = _fade(palette.accent, palette.brightness),
        _cyan = _fade(palette.cyan, palette.brightness),
        super(repaint: progress);

  final Animation<double> progress;
  final AppPalette palette;
  final _Fade _primary;
  final _Fade _accent;
  final _Fade _cyan;

  /// Three spots at 20% would wash out the deep base; light needs less still,
  /// or the page reads as tinted paper.
  static _Fade _fade(Color color, Brightness brightness) {
    final peak = brightness == Brightness.dark ? 0.20 : 0.09;
    return _Fade(color.withValues(alpha: peak), color.withValues(alpha: 0));
  }

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = palette.pageBg);

    final phase = progress.value * 2 * math.pi;
    final shortest = size.shortestSide;

    _spot(
      canvas,
      center: Offset(
        size.width * (0.18 + 0.05 * math.sin(phase)),
        size.height * (0.12 + 0.04 * math.cos(phase)),
      ),
      radius: shortest * 0.75,
      fade: _primary,
    );
    _spot(
      canvas,
      center: Offset(
        size.width * (0.86 + 0.04 * math.cos(phase * 0.8)),
        size.height * (0.28 + 0.05 * math.sin(phase * 0.8)),
      ),
      radius: shortest * 0.6,
      fade: _accent,
    );
    _spot(
      canvas,
      center: Offset(
        size.width * (0.4 + 0.05 * math.sin(phase * 0.6 + 1.7)),
        size.height * (0.95 + 0.03 * math.cos(phase * 0.6)),
      ),
      radius: shortest * 0.55,
      fade: _cyan,
    );
  }

  void _spot(
    Canvas canvas, {
    required Offset center,
    required double radius,
    required _Fade fade,
  }) {
    final paint = Paint()
      ..shader = ui.Gradient.radial(
        center,
        radius,
        <Color>[fade.peak, fade.clear],
        <double>[0, 1],
      );
    canvas.drawCircle(center, radius, paint);
  }

  @override
  bool shouldRepaint(_AuroraPainter oldDelegate) =>
      oldDelegate.palette != palette;
}

class _Fade {
  const _Fade(this.peak, this.clear);

  final Color peak;
  final Color clear;
}

/// Half-transparent panel for the three sanctioned glass surfaces: top bar,
/// quick-action dock, bottom navigation. Plain content cards do not use it.
class GlassCard extends StatelessWidget {
  const GlassCard({
    super.key,
    required this.child,
    this.onTap,
    this.padding,
    this.radius = AppRadius.medium,
    this.tint = AppGlass.bar,
  });

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry? padding;
  final double radius;

  /// Fill opacity; the spec assigns 0.72 / 0.82 / 0.88 to the three surfaces.
  final double tint;

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final borderRadius = BorderRadius.circular(radius);

    // The glow sits outside the clip; inside it would be clipped away.
    final card = Container(
      decoration: BoxDecoration(
        borderRadius: borderRadius,
        boxShadow: AppShadows.glowSoft,
      ),
      child: ClipRRect(
        borderRadius: borderRadius,
        child: BackdropFilter(
          filter: ui.ImageFilter.blur(
            sigmaX: AppGlass.sigma,
            sigmaY: AppGlass.sigma,
          ),
          child: Container(
            padding: padding ?? const EdgeInsets.all(AppSpacing.cardPad),
            decoration: BoxDecoration(
              color: palette.surface.withValues(alpha: tint),
              borderRadius: borderRadius,
              border: Border.all(
                color: palette.glassStroke,
                width: AppStroke.thin,
              ),
            ),
            child: child,
          ),
        ),
      ),
    );

    if (onTap == null) return card;
    return PressableScale(onTap: onTap, child: card);
  }
}

/// Gradient icon tile for the hero logo and the small brand marks.
///
/// Radius and glow follow the size because the spec pairs the 96dp hero with
/// xLarge + glowHero and the 36-48dp marks with small + glowSoft.
class GradientTile extends StatelessWidget {
  const GradientTile({
    super.key,
    required this.icon,
    this.size = 44,
    this.gradient = AppGradients.brand2,
  });

  final IconData icon;
  final double size;
  final Gradient gradient;

  @override
  Widget build(BuildContext context) {
    final hero = size >= 72;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: gradient,
        borderRadius:
            BorderRadius.circular(hero ? AppRadius.xLarge : AppRadius.small),
        boxShadow: hero ? AppShadows.glowHero : AppShadows.glowSoft,
      ),
      child: Icon(icon, size: size * 0.5, color: Colors.white),
    );
  }
}

/// Section header: icon in a 28dp disc, 15/w700 title, optional trailing action.
class SectionTitle extends StatelessWidget {
  const SectionTitle({
    super.key,
    required this.title,
    this.icon,
    this.trailing,
  });

  final String title;
  final IconData? icon;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return Row(
      children: <Widget>[
        if (icon != null) ...<Widget>[
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              color: palette.primary.withValues(alpha: 0.1),
              shape: BoxShape.circle,
            ),
            child: Icon(icon!, size: 18, color: palette.primary),
          ),
          const SizedBox(width: AppSpacing.dense),
        ],
        Expanded(
          child: Text(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppText.cardTitle.copyWith(
              color: palette.textPrimary.withValues(alpha: 0.85),
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        if (trailing != null) ...<Widget>[
          const SizedBox(width: AppSpacing.dense),
          trailing!,
        ],
      ],
    );
  }
}

enum StatusPillTone { success, warning, neutral }

/// Compact state badge: 12% tone fill, full-tone label, capsule radius.
class StatusPill extends StatelessWidget {
  const StatusPill({
    super.key,
    required this.label,
    this.tone = StatusPillTone.neutral,
  });

  final String label;
  final StatusPillTone tone;

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final color = switch (tone) {
      StatusPillTone.success => palette.success,
      StatusPillTone.warning => palette.warning,
      StatusPillTone.neutral => palette.textSecondary,
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadius.pill),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.dense,
          vertical: 2,
        ),
        child: Text(label, style: AppText.label.copyWith(color: color)),
      ),
    );
  }
}

/// Press squash for anything tappable that is not a Material button.
class PressableScale extends StatefulWidget {
  const PressableScale({
    super.key,
    required this.child,
    this.onTap,
    this.pressedScale = 0.97,
  });

  final Widget child;
  final VoidCallback? onTap;
  final double pressedScale;

  @override
  State<PressableScale> createState() => _PressableScaleState();
}

class _PressableScaleState extends State<PressableScale> {
  bool _down = false;

  void _setDown(bool value) {
    if (_down != value) setState(() => _down = value);
  }

  @override
  Widget build(BuildContext context) {
    // Without a handler this is layout-only; adding a recognizer would make it
    // compete with taps meant for the child.
    if (widget.onTap == null) return widget.child;

    final reduced = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onTap,
      onTapDown: (_) => _setDown(true),
      onTapUp: (_) => _setDown(false),
      onTapCancel: () => _setDown(false),
      child: AnimatedScale(
        scale: _down && !reduced ? widget.pressedScale : 1,
        duration: AppDuration.press,
        curve: AppCurves.press,
        child: widget.child,
      ),
    );
  }
}
