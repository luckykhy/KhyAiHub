/// Compile-time override key for the mirror base URL. Runtime changes go through
/// the settings page (secure storage); this is for CI / debug builds that must
/// point somewhere else without editing code.
const String kAmooMirrorBaseUrlDefineKey = 'KHY_AMOO_MIRROR_BASE_URL';

/// Value injected with `--dart-define=KHY_AMOO_MIRROR_BASE_URL=...`; empty when
/// not given.
final String kAmooMirrorBaseUrlDefine =
    String.fromEnvironment(kAmooMirrorBaseUrlDefineKey, defaultValue: '');

/// Precedence: user-entered (storage) > compile-time define > empty string.
///
/// Empty string = unconfigured: the UI says so explicitly instead of offering a
/// dead option that cannot connect (the established degradation path:
/// lib/core/config/app_config.dart:100-101, built_in_keys.dart:27-28).
String resolveAmooMirrorBaseUrl({
  required String stored,
  required String define,
}) {
  final trimmedStored = stored.trim();
  if (trimmedStored.isNotEmpty) return trimmedStored;
  return define.trim();
}
