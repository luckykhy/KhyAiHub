// khy-canary: Khy-20261101-099-R96CCS5T
import 'dart:convert';

/// Which coordinate space a vision model's answer was in.
///
/// The names are part of the tool's output contract: a caller (human or model)
/// reading `coord_space` can tell whether the heuristic guessed, and a wrong
/// guess that is *recorded* is diagnosable while a wrong guess that is hidden
/// is not.
enum CoordSpace {
  /// 0-1000 in both axes — the space the prompt asks for.
  norm1000('norm1000'),

  /// 0.0-1.0 in both axes.
  unit('unit'),

  /// 0-100 in both axes.
  percent('percent'),

  /// Raw image pixels, already converted using the reported image size.
  pixels('pixels'),

  /// No coordinates were produced at all.
  none('none');

  const CoordSpace(this.wire);
  final String wire;

  static CoordSpace fromWire(String? s) {
    for (final v in CoordSpace.values) {
      if (v.wire == s) return v;
    }
    return CoordSpace.none;
  }
}

/// A vision model's answer to "where is X on this screen".
///
/// WHY THIS IS A TYPE AND NOT A MAP. The failure mode being defended against
/// is a model that answers in prose when it was asked for JSON. The tempting
/// handling is to shrug and return `{found: false}` — at which point the
/// caller cannot distinguish "the model looked and it is not there" from "the
/// model did not answer the question", and those need completely different
/// follow-ups. So the two are separate fields, and [unparsable] is the one
/// that says the contract was broken.
class LocateResponse {
  /// True when the model claims to have located the target.
  final bool found;

  /// Normalised 0-1000 coordinates. Null unless [found] and parsed.
  final double? normX;
  final double? normY;

  /// What the model says it found, in its own words. May be null.
  final String? what;

  /// Which space the raw numbers were in, and therefore which heuristic ran.
  final CoordSpace coordSpace;

  /// True when a coordinate was out of 0-1000 and had to be clamped.
  ///
  /// Reported rather than applied silently: a clamp means the model's answer
  /// was outside the space it was asked for, which is itself a signal that
  /// the prompt or the model needs attention.
  final bool clamped;

  /// The model's own explanation — used both for "not there" and for prose
  /// that was not JSON.
  final String? reason;

  /// True when the answer did not follow the JSON contract at all.
  ///
  /// This is the field that keeps an honest failure honest. Without it,
  /// "model rambled" and "model says the element is absent" collapse into the
  /// same `found:false`, and the caller starts reporting the first as the
  /// second.
  final bool unparsable;

  const LocateResponse({
    required this.found,
    this.normX,
    this.normY,
    this.what,
    this.coordSpace = CoordSpace.none,
    this.clamped = false,
    this.reason,
    this.unparsable = false,
  });

  /// A clean "not there".
  const LocateResponse.notFound([String? why])
      : found = false,
        normX = null,
        normY = null,
        what = null,
        coordSpace = CoordSpace.none,
        clamped = false,
        reason = why,
        unparsable = false;

  /// The model did not answer in the expected shape.
  ///
  /// Not a `const` constructor because [reason] is truncated, and truncation
  /// is a runtime decision about the length of a string that arrived over the
  /// network.
  factory LocateResponse.unparsableResponse(String raw) =>
      LocateResponse(
        found: false,
        reason: _trim(raw),
        unparsable: true,
      );

  /// True when this carries a coordinate that can be converted to a pixel.
  bool get hasCoordinates => found && normX != null && normY != null;

  Map<String, dynamic> toJson() => {
        'found': found,
        if (normX != null) 'x': normX!.round(),
        if (normY != null) 'y': normY!.round(),
        if (what != null) 'what': what,
        'coord_space': coordSpace.wire,
        'clamped': clamped,
        if (reason != null) 'reason': reason,
        if (unparsable) 'unparsable_response': true,
      };

  static String _trim(String s, [int max = 400]) {
    final t = s.trim();
    return t.length <= max ? t : '${t.substring(0, max)}…';
  }
}

/// Parse a vision model's locate answer.
///
/// THE EIGHT SHAPES THIS HANDLES, and why each exists:
///
///   1. a bare JSON object — the contract;
///   2. JSON inside a ```` ```json ```` fence — most models add one unless
///      told not to, and telling them not to does not reliably work;
///   3. JSON embedded in prose — "Sure! I found it: {…}" is common;
///   4. prose with no JSON — the honest failure;
///   5. coordinates in 0.0-1.0 — a model that ignored "0-1000" and used the
///      convention it was trained on;
///   6. coordinates in 0-100 — a model that read "0-1000" as "percent";
///   7. coordinates outside 0-1000 — clamped, and *marked* as clamped;
///   8. coordinates in image-pixel units — a model that answered in the pixels
///      of the image it was shown.
///
/// 5-8 are guesses. That is the reason [LocateResponse.coordSpace] exists and
/// the reason it is always populated: a recorded guess can be corrected, a
/// hidden one cannot, and the symptom of a wrong one (a tap slightly off) is
/// indistinguishable from the model being wrong.
class LocateResponseParser {
  const LocateResponseParser._();

  /// Keys a model might use for the horizontal coordinate, in preference order.
  static const _xKeys = ['x', 'px', 'left', 'cx', 'col', 'x1'];

  /// Same for the vertical.
  static const _yKeys = ['y', 'py', 'top', 'cy', 'row', 'y1'];

  /// Keys for "what is it".
  static const _whatKeys = ['what', 'label', 'target', 'element', 'description'];

  /// Keys for the model's own explanation.
  static const _reasonKeys = ['reason', 'why', 'note', 'message', 'explanation'];

  /// Keys for the model's own "I could not find it".
  static const _foundKeys = ['found', 'located', 'present', 'exists'];

  /// Parse [raw].
  ///
  /// [imgW]/[imgH] are the dimensions of the image that was sent, needed only
  /// to interpret a pixel-space answer. Pass 0 when unknown; a pixel-space
  /// answer then cannot be converted and is reported as such rather than
  /// silently treated as 0-1000.
  static LocateResponse parse(String raw, {int imgW = 0, int imgH = 0}) {
    final text = raw.trim();
    if (text.isEmpty) {
      return LocateResponse.unparsableResponse('(空响应)');
    }

    final obj = _extractJsonObject(text);
    if (obj == null) {
      // Shape 4. Note this is NOT the same as "not found": the contract was
      // broken, and the caller needs to know that so it can retry or tell the
      // user the model misbehaved, rather than reporting an absent element.
      return LocateResponse.unparsableResponse(text);
    }

    final x = _pickNum(obj, _xKeys);
    final y = _pickNum(obj, _yKeys);

    if (x == null || y == null) {
      // JSON, but no coordinates. The model may have answered
      // {"found": false, "reason": "..."} — which is a legitimate negative —
      // or it may have returned some other object entirely.
      final found = _pickBool(obj, _foundKeys);
      final reason = _pickStr(obj, _reasonKeys);
      if (found == false) {
        return LocateResponse.notFound(reason ?? '模型报告未找到');
      }
      return LocateResponse.unparsableResponse(text);
    }

    final found = _pickBool(obj, _foundKeys);
    if (found == false) {
      // Coordinates AND found:false. Believe the flag: the model is saying
      // "here is roughly where it would be, but I am not confident it is
      // there", and a confident tap on an unconfirmed coordinate is worse
      // than no tap.
      return LocateResponse.notFound(_pickStr(obj, _reasonKeys) ?? '模型自己报告未找到');
    }

    final what = _pickStr(obj, _whatKeys);
    final space = _classify(x, y, imgW, imgH);

    // Above 1000 with no image size to check against: this is either a pixel
    // answer or a model that overflowed the space it was asked for, and the
    // two need opposite handling. Guessing is silent in both directions —
    // converting puts the tap somewhere arbitrary, clamping puts it at an edge
    // that was never claimed. So name the missing input instead.
    if (space == CoordSpace.none && (x.abs() > 1000 || y.abs() > 1000)) {
      return LocateResponse(
        found: true,
        what: what,
        coordSpace: CoordSpace.none,
        reason: '坐标超出 0-1000，且不知道图像尺寸，无法判断它是像素坐标还是越界',
      );
    }

    var cx = x, cy = y;
    var clamped = false;

    switch (space) {
      case CoordSpace.unit:
        cx = x * 1000;
        cy = y * 1000;
        break;
      case CoordSpace.percent:
        cx = x * 10;
        cy = y * 10;
        break;
      case CoordSpace.pixels:
        cx = x / imgW * 1000;
        cy = y / imgH * 1000;
        break;
      case CoordSpace.norm1000:
      case CoordSpace.none:
        break;
    }

    // Clamp last, so it covers every conversion above.
    if (cx < 0 || cx > 1000 || cy < 0 || cy > 1000) {
      cx = cx.clamp(0.0, 1000.0);
      cy = cy.clamp(0.0, 1000.0);
      clamped = true;
    }

    return LocateResponse(
      found: true,
      normX: cx,
      normY: cy,
      what: what,
      coordSpace: space,
      clamped: clamped,
      reason: _pickStr(obj, _reasonKeys),
    );
  }

  /// Decide which space the raw numbers are in.
  ///
  /// The thresholds are chosen so the documented space wins whenever it is
  /// plausible: a coordinate of 500 is 0-1000, not 50% of something, because
  /// the prompt asked for 0-1000 and a model answering that should not be
  /// second-guessed.
  ///
  /// WHY ABOVE-1000 IS NOT SIMPLY "PIXELS". A value of 1500 could be an image
  /// pixel (a 1080-wide screenshot's long side is 2400) or it could be a model
  /// that overflowed the space it was asked for. Those need opposite
  /// handling — convert, or clamp — and guessing wrong is silent in both
  /// directions. So the image size decides: a coordinate counts as pixels only
  /// when it actually fits inside the image, and a negative value rules pixels
  /// out outright because pixel coordinates are never negative.
  ///
  /// [CoordSpace.none] is returned for "above 1000 and no image to check
  /// against" — genuinely unclassifiable, which the caller reports rather than
  /// resolves.
  static CoordSpace _classify(double x, double y, int imgW, int imgH) {
    final m = [x.abs(), y.abs()].reduce((a, b) => a > b ? a : b);
    if (m > 1000) {
      final fitsImage = imgW > 0 &&
          imgH > 0 &&
          x >= 0 &&
          y >= 0 &&
          x <= imgW &&
          y <= imgH;
      if (fitsImage) return CoordSpace.pixels;
      // A negative coordinate cannot be a pixel coordinate whatever the image
      // size is, so it is an overflow of the 0-1000 space and can be clamped
      // without knowing anything else.
      if (x < 0 || y < 0) return CoordSpace.norm1000;
      if (imgW <= 0 || imgH <= 0) return CoordSpace.none;
      return CoordSpace.norm1000;
    }
    if (m > 100) return CoordSpace.norm1000;
    if (m > 1) return CoordSpace.percent;
    // 0..1. A fractional value can only be the 0-1 space; an integral 0 or 1
    // is the 0-1000 space, where 0 and 1 both mean "the very edge" and map to
    // the same pixel either way.
    final fractional = x != x.roundToDouble() || y != y.roundToDouble();
    return fractional ? CoordSpace.unit : CoordSpace.norm1000;
  }

  /// Find the outermost balanced JSON object in [text].
  ///
  /// Brace-balanced rather than regex because a regex cannot cope with nested
  /// objects or with braces inside strings — and a model that writes
  /// `{"what":"{ok}"}` would break one, silently returning no match.
  ///
  /// Returns the first candidate that actually parses, trying each `{` in
  /// turn, so prose that happens to contain an unbalanced `{` before the real
  /// object does not defeat the scan.
  static Map<String, dynamic>? _extractJsonObject(String text) {
    final stripped = _stripFence(text);
    final candidates = <int>[];
    for (var i = 0; i < stripped.length; i++) {
      if (stripped[i] == '{') candidates.add(i);
    }
    for (final start in candidates) {
      final end = _balancedEnd(stripped, start);
      if (end < 0) continue;
      final slice = stripped.substring(start, end + 1);
      try {
        final d = jsonDecode(slice);
        if (d is Map) return d.map((k, v) => MapEntry(k.toString(), v));
      } catch (_) {
        // Not this one; try the next opening brace.
      }
    }
    return null;
  }

  /// Remove a leading/trailing markdown fence if present.
  static String _stripFence(String text) {
    var t = text.trim();
    if (t.startsWith('```')) {
      final nl = t.indexOf('\n');
      if (nl >= 0) {
        t = t.substring(nl + 1);
        final close = t.lastIndexOf('```');
        if (close >= 0) t = t.substring(0, close);
      }
    }
    return t;
  }

  /// Index of the `}` matching the `{` at [start], or -1.
  ///
  /// Tracks string state so a brace inside a JSON string is not counted, and
  /// handles backslash escapes inside strings.
  static int _balancedEnd(String s, int start) {
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = start; i < s.length; i++) {
      final c = s[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c == r'\') {
          escaped = true;
        } else if (c == '"') {
          inString = false;
        }
        continue;
      }
      if (c == '"') {
        inString = true;
      } else if (c == '{') {
        depth++;
      } else if (c == '}') {
        depth--;
        if (depth == 0) return i;
      }
    }
    return -1;
  }

  static double? _pickNum(Map<String, dynamic> o, List<String> keys) {
    for (final k in keys) {
      final v = o[k];
      if (v is num) {
        final d = v.toDouble();
        if (d.isFinite) return d;
      }
      if (v is String) {
        final d = double.tryParse(v.trim());
        if (d != null && d.isFinite) return d;
      }
    }
    return null;
  }

  static bool? _pickBool(Map<String, dynamic> o, List<String> keys) {
    for (final k in keys) {
      final v = o[k];
      if (v is bool) return v;
      if (v is num) return v != 0;
      if (v is String) {
        final t = v.trim().toLowerCase();
        if (t == 'true' || t == 'yes') return true;
        if (t == 'false' || t == 'no') return false;
      }
    }
    return null;
  }

  static String? _pickStr(Map<String, dynamic> o, List<String> keys) {
    for (final k in keys) {
      final v = o[k];
      if (v is String && v.trim().isNotEmpty) return v.trim();
    }
    return null;
  }
}
