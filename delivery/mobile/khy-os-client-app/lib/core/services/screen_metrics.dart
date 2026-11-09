// khy-canary: Khy-20261101-089-PSN7EHKB
import 'dart:math' as math;

/// Screen geometry: what the pixels of a screenshot mean.
///
/// WHY THIS EXISTS. Two different screenshot paths in this app report their
/// geometry in two different vocabularies, and one of them reports none at
/// all:
///
///   · `ScreenCaptureService` (MediaProjection) used to return a JPEG and
///     nothing else — the caller had no idea what scale it was at.
///   · `KhyUi.shot` (accessibility screenshot) returns `orig_w`/`orig_h` plus
///     `w`/`h`/`scale`.
///
/// Both describe the same thing. A caller that has to know which one it got
/// will eventually get it wrong, and the failure is silent: a coordinate
/// converted with the wrong ratio lands near the target instead of on it, and
/// nothing in any log says why.
///
/// So this class is the ONE reader of both vocabularies. Everything downstream
/// asks it for pixels.
///
/// CONTRACT: pure, no Flutter, no plugins — so the whole conversion table is
/// testable on the host JVM without a device. [fromMap] never throws on
/// malformed input; it produces an unusable object with a [whyUnusable] that
/// says what was missing, because a crash here would take down the tool call
/// that asked a perfectly reasonable question.
class ScreenMetrics {
  /// The display's real size — the space `dispatchGesture` addresses.
  final int dispW;
  final int dispH;

  /// The size the projection was *requested* at. Usually equal to [dispW].
  final int screenW;
  final int screenH;

  /// The actual dimensions of the JPEG in hand.
  final int imgW;
  final int imgH;

  /// `Surface.rotation`, 0-3. -1 when unknown.
  final int rotation;

  /// The rotation the projection was created under. -1 when there is none.
  final int setupRotation;

  /// True when the image space and the gesture space have diverged.
  final bool stale;

  final int densityDpi;

  /// Where the geometry came from: `projection`, `a11y`, or `none`.
  final String source;

  const ScreenMetrics({
    required this.dispW,
    required this.dispH,
    required this.screenW,
    required this.screenH,
    required this.imgW,
    required this.imgH,
    required this.rotation,
    required this.setupRotation,
    required this.stale,
    required this.densityDpi,
    required this.source,
  });

  /// An object that cannot convert anything, with the reason why.
  factory ScreenMetrics.none([String why = '没有屏幕几何信息']) =>
      _NoneMetrics(why);

  /// True when a coordinate can be converted and trusted.
  bool get usable =>
      imgW > 0 &&
      imgH > 0 &&
      gestureW > 0 &&
      gestureH > 0 &&
      !stale;

  /// The width to divide by when converting to gesture pixels.
  int get gestureW => dispW > 0 ? dispW : screenW;
  int get gestureH => dispH > 0 ? dispH : screenH;

  /// Why this cannot be used, in Chinese, or null when it can.
  ///
  /// Every branch names a *different* fix, which is the point: "no projection"
  /// means start screen capture, "stale" means rotate back or re-capture, and
  /// "no image yet" means take a screenshot first. Collapsing them into one
  /// "screenshot failed" would send the caller down the wrong path.
  ///
  /// WHY THE IMAGE CHECK COMES FIRST. The native side reports
  /// `source:'none', stale:true` together when the projection is down — there
  /// is no geometry, so nothing could have rotated. Reporting the rotation
  /// message there would name a fix for a problem that does not exist while
  /// the real one (no projection) goes unmentioned. A live projection that
  /// rotated still has `imgW > 0` and so still reaches the stale branch.
  String? get whyUnusable {
    if (imgW <= 0 || imgH <= 0) {
      if (source == 'none' || source.isEmpty) {
        return '还没有可用的截图通道；先开启屏幕捕获（MediaProjection）或无障碍截图';
      }
      return '还没有截到图；先调一次截图再换算坐标';
    }
    if (stale) {
      return '屏幕旋转过，截图坐标系和手势坐标系已经不一致；转回原来的方向或重新截一次';
    }
    if (gestureW <= 0 || gestureH <= 0) {
      return '读不到屏幕尺寸';
    }
    return null;
  }

  /// Image pixel → screen pixel.
  ///
  /// Both axes scale independently because a JPEG need not preserve the
  /// screen's aspect ratio — `KhyUi.shot` rounds the height when it scales the
  /// width, so the two ratios genuinely differ by a pixel or two.
  double imgToPixelsX(double x) => x / imgW * gestureW;
  double imgToPixelsY(double y) => y / imgH * gestureH;

  /// Normalised 0-1000 → screen pixel, for models that report that space.
  double normToPixelsX(double x) => x / 1000.0 * gestureW;
  double normToPixelsY(double y) => y / 1000.0 * gestureH;

  /// The ratio the caller would use if it naively divided image by screen.
  ///
  /// Exposed so the caller can log it when a tap misses: knowing the ratio is
  /// the difference between "the model was wrong" and "we converted wrong".
  double get scaleX => imgW == 0 ? 0 : gestureW / imgW;
  double get scaleY => imgH == 0 ? 0 : gestureH / imgH;

  /// Clamp a pixel coordinate into the touchable area.
  ///
  /// A model asked to point at the top edge sometimes answers 0, and a
  /// gesture at exactly 0 is dropped by the input system on some devices.
  /// Nudging inward by one pixel is not a correctness hack — it is the
  /// difference between a tap that registers and one that does not.
  ({int x, int y}) clampPixels(double x, double y) =>
      (x: _clampAxis(x, gestureW), y: _clampAxis(y, gestureH));

  /// One axis of [clampPixels].
  ///
  /// `num.clamp` is not used directly because it returns `num` and because it
  /// propagates NaN rather than containing it. A non-finite coordinate from a
  /// model lands in the middle of the axis instead: tapping the centre is a
  /// recoverable outcome, and NaN reaching the platform channel is not.
  static int _clampAxis(double v, int extent) {
    if (!v.isFinite) return extent <= 0 ? 0 : extent ~/ 2;
    final lo = 1;
    final hi = math.max(lo, extent - 1);
    final r = v.round();
    if (r < lo) return lo;
    if (r > hi) return hi;
    return r;
  }

  /// Read either vocabulary.
  ///
  /// Accepts the projection's keys (`screen_w`/`disp_w`/`img_w`), the
  /// accessibility path's keys (`orig_w`/`w`), and the nested
  /// `{metrics: {...}}` envelope the MethodChannel wraps them in.
  ///
  /// Unknown or wrong-typed values become 0/false rather than throwing: this
  /// runs on data that crossed a platform channel, and a `TypeError` here
  /// would surface as a red screen in the middle of a tool call.
  factory ScreenMetrics.fromMap(Map<dynamic, dynamic> raw) {
    Map inner = raw;
    final nested = raw['metrics'];
    if (nested is Map) inner = nested;

    int pickInt(List<String> keys) {
      for (final k in keys) {
        final v = inner[k];
        if (v is int) return v;
        if (v is num) return v.toInt();
        if (v is String) {
          final p = int.tryParse(v);
          if (p != null) return p;
        }
      }
      return 0;
    }

    bool pickBool(List<String> keys) {
      for (final k in keys) {
        final v = inner[k];
        if (v is bool) return v;
        if (v is num) return v != 0;
        if (v is String) return v == 'true';
      }
      return false;
    }

    String pickStr(List<String> keys, [String dflt = '']) {
      for (final k in keys) {
        final v = inner[k];
        if (v is String && v.isNotEmpty) return v;
      }
      return dflt;
    }

    // Two vocabularies for the same two quantities. `orig_w` is the full
    // display (the accessibility screenshot is not downscaled before the
    // caller sees the original), so it maps to disp, not to screen.
    final dispW = pickInt(['disp_w', 'orig_w', 'display_w']);
    final dispH = pickInt(['disp_h', 'orig_h', 'display_h']);
    final screenW = pickInt(['screen_w']);
    final screenH = pickInt(['screen_h']);
    final imgW = pickInt(['img_w', 'w']);
    final imgH = pickInt(['img_h', 'h']);

    var source = pickStr(['source']);
    if (source.isEmpty) {
      // The accessibility path does not label itself; infer it from which
      // vocabulary showed up, so `whyUnusable` can name the right fix.
      source = dispW > 0 ? 'a11y' : 'none';
    }

    final rotation = pickInt(['rotation']);
    // Presence-checked rather than defaulted to 0. `setup_rotation: 0` is a
    // real and common value (most devices sit in portrait), so "absent" must
    // not be spelled the same way — otherwise every portrait device looks
    // like it rotated, and the guard fires on the one orientation that is
    // actually the norm. -1 means "no setup rotation recorded", which the
    // accessibility path legitimately has.
    var setupRotation = -1;
    final rawSetup = inner['setup_rotation'];
    if (rawSetup is int) setupRotation = rawSetup;
    if (rawSetup is num) setupRotation = rawSetup.toInt();

    // A caller may pass `stale` explicitly (the projection path does). When it
    // does not, derive it: rotation changed since the geometry was captured.
    var stale = pickBool(['stale']);
    if (!inner.containsKey('stale')) {
      stale = setupRotation >= 0 && rotation >= 0 && rotation != setupRotation;
    }

    return ScreenMetrics(
      dispW: dispW,
      dispH: dispH,
      screenW: screenW > 0 ? screenW : dispW,
      screenH: screenH > 0 ? screenH : dispH,
      imgW: imgW,
      imgH: imgH,
      rotation: rotation,
      setupRotation: setupRotation,
      stale: stale,
      densityDpi: pickInt(['density_dpi']),
      source: source,
    );
  }

  Map<String, dynamic> toJson() => {
        'disp_w': dispW,
        'disp_h': dispH,
        'screen_w': screenW,
        'screen_h': screenH,
        'img_w': imgW,
        'img_h': imgH,
        'rotation': rotation,
        'setup_rotation': setupRotation,
        'stale': stale,
        'density_dpi': densityDpi,
        'source': source,
        'usable': usable,
      };

  @override
  String toString() =>
      'ScreenMetrics{img=${imgW}x$imgH gesture=${gestureW}x$gestureH '
      'rot=$rotation/$setupRotation stale=$stale source=$source}';
}

/// The unusable case, as a subclass so `none()` stays a one-liner.
class _NoneMetrics extends ScreenMetrics {
  final String why;
  _NoneMetrics([this.why = '没有屏幕几何信息'])
      : super(
          dispW: 0,
          dispH: 0,
          screenW: 0,
          screenH: 0,
          imgW: 0,
          imgH: 0,
          rotation: -1,
          setupRotation: -1,
          stale: true,
          densityDpi: 0,
          source: 'none',
        );

  @override
  String? get whyUnusable => why;
}
