import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import 'khy_brand_mark.dart';
import 'khy_pet_fortune.dart';

/// Storage keys shared by the web, desktop and mobile ends.
///
/// The position key holds `{"left": <double>, "bottom": <double>}` in logical
/// pixels measured from the bottom-left of the screen.
class KhyPetKeys {
  static const String position = 'khy_pet_pos';
  static const String character = 'khy_pet_char';
  static const String hidden = 'khy_pet_hidden';
}

/// Where the pet rests when it has never been dragged.
///
/// Bottom-left, and 96dp above the bottom edge: the glass navigation bar
/// lives in the last ~80dp (plus the safe area), so a pet sitting on the
/// bottom edge would sit *on* the navigation and eat its taps.
class KhyPetAnchors {
  static const double defaultLeft = 12;
  static const double defaultBottom = 96;
}

/// Fixed geometry of the pet card.
///
/// The card height is a const expression so the drag clamp can keep the card
/// on screen without measuring it.
class KhyPetMetrics {
  static const double cardWidth = 136;
  static const double cardPadding = 8;
  static const double headerHeight = 28;
  static const double gap = 4;
  static const double actionGap = 6;
  static const double imageSize = 120;
  static const double buttonRowHeight = 30;
  static const double cardHeight = cardPadding * 2 +
      headerHeight +
      gap +
      imageSize +
      actionGap +
      buttonRowHeight;

  /// Diameter of the collapsed brand badge.
  static const double badgeSize = 32;

  /// Pointer travel (logical px) before a press turns into a drag.
  ///
  /// Below it the gesture stays a tap, so a slightly shaky finger greets the
  /// pet instead of moving it.
  static const double dragThreshold = 4;

  /// Smallest gap kept between the card and the screen edge.
  static const double edgeMargin = 8;

  /// How long a bubble and the lucky pose stay up.
  static const Duration bubbleDuration = Duration(milliseconds: 2500);
}

/// Widget keys of the pet, used by the contract tests.
class KhyPetWidgetKeys {
  static const Key card = Key('khy_pet_card');
  static const Key image = Key('khy_pet_image');
  static const Key bubble = Key('khy_pet_bubble');
  static const Key drawButton = Key('khy_pet_draw');
  static const Key switchButton = Key('khy_pet_switch');
  static const Key collapseButton = Key('khy_pet_collapse');
  static const Key badge = Key('khy_pet_badge');
}

/// Minimal persistence surface of the pet.
///
/// The production implementation is [SecurePetStorage]; the tests inject an
/// in-memory one so they never touch the platform keystore.
abstract class PetStorage {
  Future<String?> read(String key);

  Future<void> write(String key, String value);

  Future<void> delete(String key);
}

/// [PetStorage] on top of the app's existing `flutter_secure_storage`.
class SecurePetStorage implements PetStorage {
  const SecurePetStorage();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// Asset path of one pet pose.
///
/// The art ships as `khy-pet-<character>-<pose>.png` under
/// `assets/brand/pet/`; the poses are `idle` and `lucky`.
String petCharacterAsset(String characterId, {required bool lucky}) {
  return 'assets/brand/pet/khy-pet-$characterId-${lucky ? 'lucky' : 'idle'}.png';
}

/// The floating pet: a draggable card with a brand header, a character pose
/// and a small action row.
///
/// The widget occupies **its own box only**. The host puts it in a `Stack`
/// through a `Positioned`, so the layer never covers the page and never
/// swallows the taps of the screen underneath. Inside the card only the
/// character art and the buttons are hit-testable (the card background paints
/// but does not absorb pointers) — the same behaviour a web end gets from
/// `pointer-events: none` on the container and `auto` on the controls.
class KhyPetOverlay extends StatefulWidget {
  const KhyPetOverlay({
    super.key,
    this.storage,
    this.fortuneLoader,
    this.random,
  });

  /// Persistence; defaults to [SecurePetStorage].
  final PetStorage? storage;

  /// Loads the fortune data; defaults to `rootBundle` on
  /// [kPetFortuneAssetPath].
  final Future<PetFortune> Function()? fortuneLoader;

  /// Randomness for the idle lines; injectable so tests are deterministic.
  final math.Random? random;

  @override
  State<KhyPetOverlay> createState() => _KhyPetOverlayState();
}

class _KhyPetOverlayState extends State<KhyPetOverlay> {
  PetStorage _storage = const SecurePetStorage();
  math.Random _random = math.Random();

  PetFortune? _data;
  String _characterId = 'female';
  bool _hidden = false;
  bool _lucky = false;
  List<_BubbleLine>? _bubble;

  /// Absolute position of the card, in logical pixels from the screen edges.
  double _left = KhyPetAnchors.defaultLeft;
  double _bottom = KhyPetAnchors.defaultBottom;

  /// Index of the last idle line, so the next greeting is never the same one.
  int _lastIdleIndex = -1;

  Timer? _bubbleTimer;
  Timer? _luckyTimer;

  /// Pointer bookkeeping of the current press.
  bool _dragging = false;
  Offset _pressOrigin = Offset.zero;
  Offset _appliedDelta = Offset.zero;

  @override
  void initState() {
    super.initState();
    _storage = widget.storage ?? const SecurePetStorage();
    _random = widget.random ?? math.Random();
    unawaited(_bootstrap());
  }

  @override
  void dispose() {
    _bubbleTimer?.cancel();
    _luckyTimer?.cancel();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    final data = await _loadFortune();
    final storedCharacter = await _readValue(KhyPetKeys.character);
    final storedHidden = await _readValue(KhyPetKeys.hidden);
    final storedPosition = await _readValue(KhyPetKeys.position);
    if (!mounted) return;
    setState(() {
      _data = data;
      if (data != null) {
        _characterId = _resolveCharacter(data, storedCharacter);
      }
      _hidden = storedHidden == '1' || storedHidden == 'true';
      final position = _decodePosition(storedPosition);
      if (position != null) {
        _left = position.left;
        _bottom = position.bottom;
      }
    });
  }

  Future<PetFortune?> _loadFortune() async {
    try {
      final loader = widget.fortuneLoader;
      if (loader != null) return await loader();
      final raw = await rootBundle.loadString(kPetFortuneAssetPath);
      return PetFortune.parse(raw);
    } catch (_) {
      // The asset is baked into the bundle; if it cannot be read the pet
      // simply stays out of the way instead of breaking the app.
      return null;
    }
  }

  Future<String?> _readValue(String key) async {
    try {
      return await _storage.read(key);
    } catch (_) {
      // An unreadable slot means "not set yet", never a crash.
      return null;
    }
  }

  Future<void> _writeValue(String key, String value) async {
    try {
      await _storage.write(key, value);
    } catch (_) {
      // Persistence is a convenience: the pet still works without it.
    }
  }

  String _resolveCharacter(PetFortune data, String? stored) {
    if (stored != null && data.characters.containsKey(stored)) return stored;
    if (data.characters.containsKey('female')) return 'female';
    if (data.characters.isEmpty) return 'female';
    return data.characters.keys.first;
  }

  _PetPosition? _decodePosition(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final left = (decoded['left'] as num?)?.toDouble();
      final bottom = (decoded['bottom'] as num?)?.toDouble();
      if (left == null || bottom == null) return null;
      return _PetPosition(left, bottom);
    } catch (_) {
      return null;
    }
  }

  Future<void> _persistPosition() {
    final payload = jsonEncode(<String, double>{
      'left': _left,
      'bottom': _bottom,
    });
    return _writeValue(KhyPetKeys.position, payload);
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    if (data == null) return const SizedBox.shrink();
    if (_hidden) return _buildBadge(context);
    return _buildLayer(context, data);
  }

  Widget _buildLayer(BuildContext context, PetFortune data) {
    final character = data.characters[_characterId];
    if (character == null) return const SizedBox.shrink();

    // The host anchors the layer at the default spot; the drag offset is a
    // transform on top of it, so the layer's own box never grows and never
    // covers more of the page than the card does.
    final offset = Offset(
      _left - KhyPetAnchors.defaultLeft,
      KhyPetAnchors.defaultBottom - _bottom,
    );
    final reduced = MediaQuery.maybeOf(context)?.disableAnimations ?? false;

    return Transform.translate(
      offset: offset,
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Positioned(
            left: 0,
            right: 0,
            bottom: KhyPetMetrics.cardHeight + 8,
            child: AnimatedSwitcher(
              duration: reduced ? Duration.zero : AppDuration.micro,
              child: _bubble == null
                  ? const SizedBox.shrink()
                  : _buildBubble(context, _bubble!),
            ),
          ),
          _buildCard(context, character),
        ],
      ),
    );
  }

  Widget _buildCard(
    BuildContext context,
    PetCharacter character,
  ) {
    final palette = AppPalette.of(context);
    final reduced = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    final asset = petCharacterAsset(_characterId, lucky: _lucky);

    return Container(
      key: KhyPetWidgetKeys.card,
      width: KhyPetMetrics.cardWidth,
      height: KhyPetMetrics.cardHeight,
      padding: const EdgeInsets.all(KhyPetMetrics.cardPadding),
      decoration: BoxDecoration(
        color: palette.surface.withValues(alpha: 0.94),
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
        boxShadow: AppShadows.floating,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          SizedBox(
            height: KhyPetMetrics.headerHeight,
            child: _buildHeader(palette, character),
          ),
          const SizedBox(height: KhyPetMetrics.gap),
          SizedBox(
            width: KhyPetMetrics.imageSize,
            height: KhyPetMetrics.imageSize,
            child: _buildCharacter(reduced, asset),
          ),
          const SizedBox(height: KhyPetMetrics.actionGap),
          SizedBox(
            height: KhyPetMetrics.buttonRowHeight,
            child: _buildActions(palette),
          ),
        ],
      ),
    );
  }

  /// The brand header: the real trademark plus the wordmark.
  ///
  /// The mark is the shipped `khy-os-mark-256.png`, never a text
  /// approximation of the logo.
  Widget _buildHeader(
    AppPalette palette,
    PetCharacter character,
  ) {
    return Row(
      children: <Widget>[
        const KhyBrandMark(size: 16),
        const SizedBox(width: 4),
        Text(
          'Khy OS',
          style: AppText.label.copyWith(
            color: palette.textPrimary,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            character.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppText.micro.copyWith(color: palette.textSecondary),
          ),
        ),
        _buildIconButton(
          palette,
          icon: Icons.keyboard_arrow_down,
          buttonKey: KhyPetWidgetKeys.collapseButton,
          label: '收起桌宠',
          onTap: _collapse,
        ),
      ],
    );
  }

  Widget _buildCharacter(
    bool reduced,
    String asset,
  ) {
    return Listener(
      key: KhyPetWidgetKeys.image,
      behavior: HitTestBehavior.opaque,
      // Raw pointer events instead of a pan recognizer: the gesture arena
      // only hands the pan to us after ~36px, which would make the 4px drag
      // threshold unreachable and let a 10px wobble greet the pet instead of
      // moving it.
      onPointerDown: (event) => _pointerDown(event.position),
      onPointerMove: (event) => _pointerMove(event.position),
      onPointerUp: (event) => _pointerUp(),
      onPointerCancel: (event) => _pointerCancel(),
      child: AnimatedSwitcher(
        duration: reduced ? Duration.zero : AppDuration.micro,
        child: Image.asset(
          asset,
          key: ValueKey<String>(asset),
          width: KhyPetMetrics.imageSize,
          height: KhyPetMetrics.imageSize,
          fit: BoxFit.contain,
          errorBuilder: (context, error, stack) => const SizedBox(
            width: KhyPetMetrics.imageSize,
            height: KhyPetMetrics.imageSize,
          ),
        ),
      ),
    );
  }

  Widget _buildActions(AppPalette palette) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        // The omamori button carries the real trademark inside it.
        Semantics(
          button: true,
          label: '抽一签',
          child: GestureDetector(
            key: KhyPetWidgetKeys.drawButton,
            behavior: HitTestBehavior.opaque,
            onTap: _draw,
            child: Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                color: AppColors.brandInk,
                shape: BoxShape.circle,
                border: Border.all(
                  color: palette.primary.withValues(alpha: 0.45),
                  width: AppStroke.thin,
                ),
              ),
              child: const Center(child: KhyBrandMark(size: 16)),
            ),
          ),
        ),
        const SizedBox(width: AppSpacing.dense),
        Semantics(
          button: true,
          label: '切换角色',
          child: GestureDetector(
            key: KhyPetWidgetKeys.switchButton,
            behavior: HitTestBehavior.opaque,
            onTap: _switchCharacter,
            child: Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(
                  color: palette.stroke,
                  width: AppStroke.thin,
                ),
              ),
              child: Icon(
                Icons.swap_horiz,
                size: 16,
                color: palette.textSecondary,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildIconButton(
    AppPalette palette, {
    required IconData icon,
    required Key buttonKey,
    required String label,
    required VoidCallback onTap,
  }) {
    return Semantics(
      button: true,
      label: label,
      child: GestureDetector(
        key: buttonKey,
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Icon(icon, size: 18, color: palette.textSecondary),
      ),
    );
  }

  Widget _buildBubble(BuildContext context, List<_BubbleLine> lines) {
    final palette = AppPalette.of(context);
    // The KeyedSubtree carries the transition key (one per text) while the
    // container keeps the stable key the tests look for. Two bubble lines
    // share the headline style, so no line may own a repeated key.
    return KeyedSubtree(
      key: ValueKey<String>('khy_pet_bubble:${lines.first.text}'),
      child: Container(
        key: KhyPetWidgetKeys.bubble,
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.dense,
          vertical: 6,
        ),
        decoration: BoxDecoration(
          color: palette.surfaceHigh,
          borderRadius: BorderRadius.circular(AppRadius.small),
          border: Border.all(color: palette.stroke, width: AppStroke.thin),
          boxShadow: AppShadows.card,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            for (final line in lines)
              Text(
                line.text,
                style: (line.headline ? AppText.label : AppText.micro).copyWith(
                  color: line.headline
                      ? palette.textPrimary
                      : palette.textSecondary,
                  height: 1.5,
                  fontWeight: line.headline ? FontWeight.w700 : null,
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// The collapsed state: a 32dp brand badge that brings the pet back.
  Widget _buildBadge(BuildContext context) {
    final palette = AppPalette.of(context);
    return Semantics(
      button: true,
      label: '唤出桌宠',
      child: GestureDetector(
        key: KhyPetWidgetKeys.badge,
        behavior: HitTestBehavior.opaque,
        onTap: _restore,
        child: Container(
          width: KhyPetMetrics.badgeSize,
          height: KhyPetMetrics.badgeSize,
          decoration: BoxDecoration(
            color: AppColors.brandInk,
            shape: BoxShape.circle,
            border: Border.all(
              color: palette.primary.withValues(alpha: 0.5),
              width: AppStroke.thin,
            ),
            boxShadow: AppShadows.glowSoft,
          ),
          child: const Center(child: KhyBrandMark(size: 20)),
        ),
      ),
    );
  }

  // --- interactions -------------------------------------------------------

  void _pointerDown(Offset position) {
    _dragging = false;
    _pressOrigin = position;
    _appliedDelta = Offset.zero;
  }

  void _pointerMove(Offset position) {
    final total = position - _pressOrigin;
    if (!_dragging) {
      if (total.distance < KhyPetMetrics.dragThreshold) return;
      _dragging = true;
    }
    final delta = total - _appliedDelta;
    _appliedDelta = total;
    setState(() => _applyDrag(delta));
  }

  void _pointerUp() {
    if (_dragging) {
      _dragging = false;
      unawaited(_persistPosition());
    } else {
      _greet();
    }
  }

  void _pointerCancel() {
    _dragging = false;
  }

  void _applyDrag(Offset delta) {
    _left += delta.dx;
    _bottom -= delta.dy;

    final screen = MediaQuery.sizeOf(context);
    final maxLeft = math.max(
      KhyPetMetrics.edgeMargin,
      screen.width - KhyPetMetrics.cardWidth - KhyPetMetrics.edgeMargin,
    );
    final maxBottom = math.max(
      KhyPetMetrics.edgeMargin,
      screen.height - KhyPetMetrics.cardHeight - KhyPetMetrics.edgeMargin,
    );
    // The card never sinks into the glass navigation bar.
    final minBottom = math.min(KhyPetAnchors.defaultBottom, maxBottom);

    _left = _left.clamp(KhyPetMetrics.edgeMargin, maxLeft).toDouble();
    _bottom = _bottom.clamp(minBottom, maxBottom).toDouble();
  }

  /// Tap on the character: one idle line, never the same one twice in a row.
  void _greet() {
    final data = _data;
    if (data == null) return;
    final character = data.characters[_characterId];
    if (character == null) return;
    final lines = character.idle;
    if (lines.isEmpty) return;

    var index = _random.nextInt(lines.length);
    if (lines.length > 1 && index == _lastIdleIndex) {
      for (var attempt = 0; attempt < 8; attempt++) {
        final candidate = _random.nextInt(lines.length);
        if (candidate != _lastIdleIndex) {
          index = candidate;
          break;
        }
      }
      if (index == _lastIdleIndex) {
        index = (_lastIdleIndex + 1) % lines.length;
      }
    }
    _lastIdleIndex = index;
    _showBubble(<_BubbleLine>[_BubbleLine(lines[index])]);
  }

  /// Tap on the omamori: draw the fortune of the day.
  ///
  /// The result only depends on the date and the character, so the same day
  /// always draws the same fortune.
  void _draw() {
    final data = _data;
    if (data == null) return;
    final character = data.characters[_characterId];
    final fortune = dailyFortune(
      data,
      now: DateTime.now(),
      characterId: _characterId,
    );

    final lines = <_BubbleLine>[];
    if (character != null && character.lucky.isNotEmpty) {
      lines.add(
        _BubbleLine(
          character.lucky[_random.nextInt(character.lucky.length)],
          headline: true,
        ),
      );
    }
    lines.add(_BubbleLine('「${fortune.level.label}」签', headline: true));
    if (fortune.tip.isNotEmpty) {
      lines.add(_BubbleLine(fortune.tip));
    }
    if (fortune.level.hint.isNotEmpty) {
      lines.add(_BubbleLine(fortune.level.hint));
    }
    final color = fortune.color;
    if (color != null) {
      lines.add(_BubbleLine('幸运色：${color.name}'));
    }

    setState(() => _lucky = true);
    _showBubble(lines);
    _luckyTimer?.cancel();
    _luckyTimer = Timer(KhyPetMetrics.bubbleDuration, () {
      if (mounted) setState(() => _lucky = false);
    });
  }

  /// Switch between the characters; the lines and the fortune follow.
  void _switchCharacter() {
    final data = _data;
    if (data == null) return;
    final ids = data.characters.keys.toList(growable: false);
    if (ids.length < 2) return;

    final index = ids.indexOf(_characterId);
    final next = ids[(index + 1) % ids.length];
    setState(() {
      _characterId = next;
      _lastIdleIndex = -1;
      _lucky = false;
    });
    unawaited(_writeValue(KhyPetKeys.character, next));

    final character = data.characters[next];
    if (character == null) return;
    final line = character.idle.isNotEmpty
        ? character.idle[_random.nextInt(character.idle.length)]
        : character.name;
    _showBubble(<_BubbleLine>[
      _BubbleLine('${character.name} · ${character.title}', headline: true),
      _BubbleLine(line),
    ]);
  }

  void _collapse() {
    setState(() => _hidden = true);
    unawaited(_writeValue(KhyPetKeys.hidden, '1'));
  }

  void _restore() {
    setState(() => _hidden = false);
    unawaited(_writeValue(KhyPetKeys.hidden, '0'));
  }

  void _showBubble(List<_BubbleLine> lines) {
    setState(() => _bubble = lines);
    _bubbleTimer?.cancel();
    _bubbleTimer = Timer(KhyPetMetrics.bubbleDuration, () {
      if (mounted) setState(() => _bubble = null);
    });
  }
}

/// One line of the speech bubble.
class _BubbleLine {
  const _BubbleLine(this.text, {this.headline = false});

  final String text;

  /// Headline lines are larger and carry the accent colour.
  final bool headline;
}

/// Absolute position of the card on screen.
class _PetPosition {
  const _PetPosition(this.left, this.bottom);

  final double left;
  final double bottom;
}
