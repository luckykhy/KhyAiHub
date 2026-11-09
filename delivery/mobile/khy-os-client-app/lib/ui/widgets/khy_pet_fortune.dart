import 'dart:convert';

/// Asset path of the pet's fortune data.
///
/// The JSON under `assets/brand/pet/` is the single source of truth shared by
/// the web, desktop and mobile ends. It is never edited per platform, and this
/// path is the only place the mobile app refers to it.
const String kPetFortuneAssetPath = 'assets/brand/pet/pet-fortune.json';

/// FNV-1a 32-bit hash over the UTF-8 bytes of [input].
///
/// The three ends must agree bit for bit, so the arithmetic is pinned here:
///
/// * `0xFFFFFFFF` masks keep the accumulator inside 32 bits.
/// * Dart integers are 64-bit, so `hash * 0x01000193` is exact and the mask
///   reproduces the 32-bit wrap. A JavaScript end has to use `Math.imul`
///   (`h * 0x01000193` in plain JS exceeds 2^53 and silently loses precision),
///   or BigInt.
int fnv1a32(String input) {
  var hash = 0x811c9dc5;
  for (final byte in utf8.encode(input)) {
    hash = (hash ^ byte) & 0xFFFFFFFF;
    hash = (hash * 0x01000193) & 0xFFFFFFFF;
  }
  return hash;
}

/// Local calendar day of [moment] as `YYYY-MM-DD`.
///
/// Local, not UTC: the fortune is a daily ritual of the person holding the
/// phone, and it must roll over at their midnight.
String dateKeyOf(DateTime moment) {
  final month = moment.month.toString().padLeft(2, '0');
  final day = moment.day.toString().padLeft(2, '0');
  return '${moment.year}-$month-$day';
}

/// One draw level (大吉 / 吉 / 小吉 / 平稳) with its weight and its hint.
class PetFortuneLevel {
  const PetFortuneLevel({
    required this.id,
    required this.label,
    required this.weight,
    required this.hint,
  });

  final String id;
  final String label;

  /// Relative weight of this level in the weighted draw.
  final int weight;
  final String hint;

  /// Placeholder used when the data source carries no level at all.
  static const PetFortuneLevel empty = PetFortuneLevel(
    id: '',
    label: '',
    weight: 0,
    hint: '',
  );

  factory PetFortuneLevel.fromJson(Map<String, dynamic> json) {
    return PetFortuneLevel(
      id: _stringOf(json['id']),
      label: _stringOf(json['label']),
      weight: _intOf(json['weight']),
      hint: _stringOf(json['hint']),
    );
  }
}

/// One lucky colour of the day.
class PetFortuneColor {
  const PetFortuneColor({required this.name, required this.hex});

  final String name;

  /// sRGB hex string, e.g. `#F0A868`.
  final String hex;

  factory PetFortuneColor.fromJson(Map<String, dynamic> json) {
    return PetFortuneColor(
      name: _stringOf(json['name']),
      hex: _stringOf(json['hex']),
    );
  }
}

/// One pet character with its idle and lucky lines.
class PetCharacter {
  const PetCharacter({
    required this.id,
    required this.name,
    required this.title,
    required this.idle,
    required this.lucky,
  });

  final String id;
  final String name;
  final String title;

  /// Lines shown when the pet is tapped.
  final List<String> idle;

  /// Lines shown right after a successful draw.
  final List<String> lucky;

  factory PetCharacter.fromJson(String id, Map<String, dynamic> json) {
    return PetCharacter(
      id: id,
      name: _stringOf(json['name']),
      title: _stringOf(json['title']),
      idle: _stringListOf(json['idle']),
      lucky: _stringListOf(json['lucky']),
    );
  }
}

/// The whole fortune data set, parsed from `pet-fortune.json`.
class PetFortune {
  const PetFortune({
    required this.version,
    required this.brandName,
    required this.brandTagline,
    required this.levels,
    required this.tips,
    required this.luckyColors,
    required this.characters,
    required this.actions,
  });

  final int version;
  final String brandName;
  final String brandTagline;
  final List<PetFortuneLevel> levels;
  final List<String> tips;
  final List<PetFortuneColor> luckyColors;

  /// Keyed by character id (`female` / `male`).
  final Map<String, PetCharacter> characters;

  /// Button labels of the data source (`draw`, `greet`, `hide`, `show`, ...).
  final Map<String, String> actions;

  /// Parses the raw JSON of [kPetFortuneAssetPath].
  ///
  /// Throws [FormatException] when the payload is not a JSON object; every
  /// other field degrades to an empty value so a partially broken data file
  /// cannot take the whole app down.
  factory PetFortune.parse(String raw) {
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('pet fortune payload is not a JSON object');
    }
    return PetFortune.fromJson(decoded);
  }

  factory PetFortune.fromJson(Map<String, dynamic> json) {
    final brand = _mapOf(json['brand']);
    final characters = <String, PetCharacter>{};
    final rawCharacters = _mapOf(json['characters']);
    for (final entry in rawCharacters.entries) {
      characters[entry.key] =
          PetCharacter.fromJson(entry.key, _mapOf(entry.value));
    }
    return PetFortune(
      version: _intOf(json['version']),
      brandName: _stringOf(brand['name']),
      brandTagline: _stringOf(brand['tagline']),
      levels: _listOf(json['levels'])
          .map((item) => PetFortuneLevel.fromJson(_mapOf(item)))
          .toList(growable: false),
      tips: _stringListOf(json['tips']),
      luckyColors: _listOf(json['luckyColors'])
          .map((item) => PetFortuneColor.fromJson(_mapOf(item)))
          .toList(growable: false),
      characters: Map<String, PetCharacter>.unmodifiable(characters),
      actions: Map<String, String>.unmodifiable(
        _stringMapOf(json['actions']),
      ),
    );
  }
}

/// The result of one draw.
class DailyFortune {
  const DailyFortune({
    required this.seed,
    required this.dateKey,
    required this.characterId,
    required this.level,
    required this.tip,
    required this.color,
  });

  /// The 32-bit seed the draw was made from.
  final int seed;

  /// `YYYY-MM-DD` of the draw.
  final String dateKey;

  final String characterId;
  final PetFortuneLevel level;

  /// The fortune text of the day.
  final String tip;

  /// Null only when the data source carries no colour at all.
  final PetFortuneColor? color;
}

/// Draws the fortune of [now] for [characterId].
///
/// The algorithm is the shared contract of the three ends:
///
/// ```text
/// seed  = fnv1a32(dateKey + ':' + characterId)
/// level = weightedPick(seed, levels)      // seed % totalWeight, then a
///                                          // cumulative walk in array order
/// tip   = tips[(seed >> 8) % tips.length]
/// color = luckyColors[(seed >> 16) % luckyColors.length]
/// ```
///
/// `>>>` in JavaScript is an unsigned shift, so `seed >> 8` becomes
/// `seed ~/ 256` here (the seed is a non-negative 32-bit value, so the
/// division floors exactly like the shift does).
DailyFortune dailyFortune(
  PetFortune data, {
  required DateTime now,
  required String characterId,
}) {
  final dateKey = dateKeyOf(now);
  final seed = fnv1a32('$dateKey:$characterId');

  final totalWeight =
      data.levels.fold<int>(0, (sum, level) => sum + level.weight);
  final remainder = totalWeight > 0 ? seed % totalWeight : 0;

  var level = PetFortuneLevel.empty;
  var accumulated = 0;
  for (final candidate in data.levels) {
    accumulated += candidate.weight;
    if (remainder < accumulated) {
      level = candidate;
      break;
    }
  }

  final tip = data.tips.isEmpty
      ? ''
      : data.tips[(seed ~/ 256) % data.tips.length];
  final color = data.luckyColors.isEmpty
      ? null
      : data.luckyColors[(seed ~/ 65536) % data.luckyColors.length];

  return DailyFortune(
    seed: seed,
    dateKey: dateKey,
    characterId: characterId,
    level: level,
    tip: tip,
    color: color,
  );
}

Map<String, dynamic> _mapOf(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return value.map((key, dynamic item) => MapEntry(key.toString(), item));
  }
  return const <String, dynamic>{};
}

Map<String, String> _stringMapOf(Object? value) {
  final source = _mapOf(value);
  final result = <String, String>{};
  for (final entry in source.entries) {
    result[entry.key] = _stringOf(entry.value);
  }
  return result;
}

List<Object?> _listOf(Object? value) {
  if (value is List) return value;
  return const <Object?>[];
}

List<String> _stringListOf(Object? value) {
  return _listOf(value).map(_stringOf).toList(growable: false);
}

String _stringOf(Object? value) {
  if (value is String) return value;
  if (value == null) return '';
  return value.toString();
}

int _intOf(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}
