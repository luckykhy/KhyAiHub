// khy-canary: Khy-20261101-124-ZTHCC6KM
import 'package:flutter/material.dart';

import 'app_colors.dart';
import 'design_tokens.dart';

/// khy-os theme: colour, type and radius wiring from DESIGN-UI.md.
/// Both constructors keep the signatures the app already calls.
class AppTheme {
  static ThemeData light() => _build(AppPalette.light);

  static ThemeData dark() => _build(AppPalette.dark);

  static ThemeData _build(AppPalette p) {
    final isLight = p.brightness == Brightness.light;

    final scheme = ColorScheme(
      brightness: p.brightness,
      primary: p.primary,
      onPrimary: Colors.white,
      // Container tones are derived rather than stored: the 14% tint has to
      // follow whichever primary the brightness picked.
      primaryContainer: p.primary.withValues(alpha: 0.14),
      onPrimaryContainer: p.primary,
      secondary: p.accent,
      onSecondary: Colors.white,
      secondaryContainer: p.accent.withValues(alpha: 0.14),
      onSecondaryContainer: p.accent,
      tertiary: p.hot,
      onTertiary: Colors.white,
      tertiaryContainer: p.hot.withValues(alpha: 0.14),
      onTertiaryContainer: p.hot,
      error: p.error,
      onError: Colors.white,
      errorContainer: p.error.withValues(alpha: 0.12),
      onErrorContainer: p.error,
      surface: p.surface,
      onSurface: p.textPrimary,
      surfaceContainerHighest: p.surfaceHigh,
      onSurfaceVariant: p.textSecondary,
      outline: p.stroke,
      outlineVariant: p.stroke,
    );

    final textTheme = TextTheme(
      displaySmall: AppText.display.copyWith(color: p.textPrimary),
      titleLarge: AppText.title.copyWith(color: p.textPrimary),
      titleMedium: AppText.cardTitle.copyWith(color: p.textPrimary),
      bodyMedium: AppText.body.copyWith(color: p.textPrimary),
      bodySmall: AppText.secondary.copyWith(color: p.textSecondary),
      labelSmall: AppText.label.copyWith(color: p.textSecondary),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: p.brightness,
      colorScheme: scheme,
      textTheme: textTheme,
      // Four tabs share one backdrop; aurora screens paint their own base.
      scaffoldBackgroundColor: p.pageBg,

      appBarTheme: AppBarTheme(
        backgroundColor: p.pageBg,
        foregroundColor: p.textPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: AppText.title.copyWith(color: p.textPrimary),
      ),

      cardTheme: CardThemeData(
        color: p.surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.medium),
          side: BorderSide(color: p.stroke, width: AppStroke.thin),
        ),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: p.surfaceHigh,
        hintStyle: AppText.body.copyWith(color: p.textFaint),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.page,
          vertical: 14,
        ),
        border: _inputBorder(p.stroke),
        enabledBorder: _inputBorder(p.stroke),
        focusedBorder: _inputBorder(p.primary, width: AppStroke.focus),
      ),

      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: p.primary,
          foregroundColor: Colors.white,
          elevation: 0,
          shadowColor: Colors.transparent,
          textStyle: AppText.body.copyWith(fontWeight: FontWeight.w600),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.medium),
          ),
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.section,
            vertical: 12,
          ),
        ),
      ),

      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: p.primary,
          foregroundColor: Colors.white,
          textStyle: AppText.body.copyWith(fontWeight: FontWeight.w600),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.medium),
          ),
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.page,
            vertical: 12,
          ),
        ),
      ),

      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: p.primary,
          textStyle: AppText.label,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.pill),
          ),
        ),
      ),

      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          foregroundColor: p.textSecondary,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.small),
          ),
        ),
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: p.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.large),
        ),
        titleTextStyle: AppText.cardTitle.copyWith(color: p.textPrimary),
        contentTextStyle: AppText.body.copyWith(color: p.textSecondary),
      ),

      // Per-call success/error fills override the neutral surface below.
      snackBarTheme: SnackBarThemeData(
        backgroundColor: isLight ? const Color(0xFF1F2937) : p.surfaceHigh,
        contentTextStyle: AppText.secondary.copyWith(
          color: isLight ? Colors.white : p.textPrimary,
        ),
        actionTextColor: p.primary,
        elevation: 0,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.medium),
        ),
      ),

      dividerTheme: DividerThemeData(
        color: p.stroke,
        thickness: AppStroke.thin,
        space: AppStroke.thin,
      ),

      // The nav is the third glass surface; the blur itself lives in the shell.
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: p.surface.withValues(alpha: AppGlass.nav),
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        height: 64,
        indicatorColor: p.primary.withValues(alpha: 0.14),
        indicatorShape: const StadiumBorder(),
        labelTextStyle: WidgetStateProperty.resolveWith((states) {
          final selected = states.contains(WidgetState.selected);
          return AppText.label.copyWith(
            color: selected
                ? p.textPrimary
                : p.textSecondary.withValues(alpha: 0.7),
            fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
          );
        }),
        iconTheme: WidgetStateProperty.resolveWith((states) {
          final selected = states.contains(WidgetState.selected);
          return IconThemeData(
            size: 24,
            color: selected
                ? p.primary
                : p.textSecondary.withValues(alpha: 0.7),
          );
        }),
      ),

      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: p.primary,
        foregroundColor: Colors.white,
        elevation: 0,
        shape: const CircleBorder(),
      ),

      chipTheme: ChipThemeData(
        backgroundColor: p.surfaceHigh,
        selectedColor: p.primary.withValues(alpha: 0.14),
        labelStyle: AppText.label.copyWith(color: p.textPrimary),
        secondaryLabelStyle: AppText.label.copyWith(color: p.textSecondary),
        checkmarkColor: p.primary,
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.inner,
          vertical: 4,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.pill),
          side: BorderSide(color: p.stroke, width: AppStroke.thin),
        ),
      ),

      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((states) {
          return states.contains(WidgetState.selected)
              ? p.primary
              : p.textFaint;
        }),
        trackColor: WidgetStateProperty.resolveWith((states) {
          return states.contains(WidgetState.selected)
              ? p.primary.withValues(alpha: 0.3)
              : p.surfaceHigh;
        }),
        trackOutlineColor: WidgetStateProperty.resolveWith((states) {
          return states.contains(WidgetState.selected)
              ? Colors.transparent
              : p.stroke;
        }),
      ),
    );
  }

  static OutlineInputBorder _inputBorder(
    Color color, {
    double width = AppStroke.thin,
  }) {
    return OutlineInputBorder(
      borderRadius: BorderRadius.circular(AppRadius.medium),
      borderSide: BorderSide(color: color, width: width),
    );
  }
}
