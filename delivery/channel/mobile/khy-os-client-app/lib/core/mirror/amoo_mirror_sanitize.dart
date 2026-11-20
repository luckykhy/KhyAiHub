/// Text-body cap for the detail page. Above it the client marks the body
/// truncated (expandable in the UI).
const int kAmooMirrorTextMaxChars = 800;

const String kAmooMirrorSecretPlaceholder = '[已脱秘]';
const String kAmooMirrorPathPlaceholder = '[路径]';

/// Credential shapes. Copied from lib/core/services/amoo_approval.dart:155-156
/// (_kSecretShapes) — that list is the repo's existing judgement of what a
/// token looks like, and a second, slightly different list here is how the two
/// end up redacting different things.
final RegExp _secretShapes = RegExp(
    r'[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{4,}');

/// URL spans, used to protect them from the path rewrite: a URL's path
/// (`https://host/a/b`) IS an absolute path to a regex, and mangling it would
/// corrupt the one line where the full address is the useful content.
final RegExp _urlSpan = RegExp(r'[A-Za-z][A-Za-z0-9+.\-]*://\S*');

/// Absolute filesystem paths. **Why self-made**: lib/core/security/guard.dart:326-343
/// records why the phone dropped the desktop's two repo-path rewrites (the
/// phone system prompt publishes the repo layout, so a blanket rewrite shreds
/// normal answers), and its _leakPatterns (guard.dart:345+) target
/// process.env.X / system prompt / module names — there is NO filesystem-path
/// form to copy. So this pattern is homemade; the anchor is written here so
/// the next person does not go looking for a precedent that does not exist.
///
/// Segment chars are ASCII `[\w.-]` on purpose: admitting CJK would also admit
/// prose like「读/写」and replace half a sentence with [路径]. Paths with
/// non-ASCII segments under-match instead — under-matching hides less than
/// over-matching destroys.
///
/// Three forms, anchored so prose does not match:
///   - drive:      C:\... or C:/...
///   - UNC:        \\server\share
///   - POSIX abs:  /seg/seg... (a single /v1 is NOT a path — needs one full segment)
final RegExp _absolutePath = RegExp(
  r'[A-Za-z]:[\\/](?:[\w.\-]+[\\/])*[\w.\-]*'
  r'|\\\\[\w.\-]+(?:[\\/][\w.\-]+)*'
  r'|/(?:[\w.\-]+/)+[\w.\-]*',
);

/// Render-time sanitizing: token-shaped strings → [已脱秘], absolute paths →
/// [路径]. Idempotent (placeholders contain no slash and no credential shape).
String amooMirrorSanitizeText(String raw) {
  final redacted = raw.replaceAll(_secretShapes, kAmooMirrorSecretPlaceholder);
  final urls = _urlSpan.allMatches(redacted).toList(growable: false);
  final out = StringBuffer();
  var cursor = 0;
  for (final m in _absolutePath.allMatches(redacted)) {
    // Two skip rules, both standing in for a lookbehind Dart does not have:
    // inside a URL span (the URL's path is not a leak), and directly after an
    // ASCII word char — `12/31/2024` contains `/31/2024` and a date is not a
    // path. An absolute path's preceding character is whitespace, punctuation
    // or string start in every real case.
    if (_insideAny(m.start, urls)) continue;
    if (m.start > 0 && _isAsciiWord(redacted.codeUnitAt(m.start - 1))) continue;
    out.write(redacted.substring(cursor, m.start));
    out.write(kAmooMirrorPathPlaceholder);
    cursor = m.end;
  }
  out.write(redacted.substring(cursor));
  return out.toString();
}

bool _isAsciiWord(int unit) =>
    (unit >= 0x30 && unit <= 0x39) || // 0-9
    (unit >= 0x41 && unit <= 0x5A) || // A-Z
    (unit >= 0x61 && unit <= 0x7A) || // a-z
    unit == 0x5F; // _

bool _insideAny(int index, List<Match> spans) {
  for (final span in spans) {
    if (index >= span.start && index < span.end) return true;
  }
  return false;
}

final class AmooMirrorTruncated {
  const AmooMirrorTruncated(this.text, this.truncated);

  final String text;
  final bool truncated;
}

/// Truncation. **Does NOT call normalizeSpace**: ragTruncate
/// (lib/core/services/rag_retrieval.dart:101-105) starts with normalizeSpace
/// (:102), which collapses every whitespace run into a single space — copying
/// it would flatten the detail page's multi-line bodies into one line.
/// Boundary: only cuts when length > maxChars (exactly 800 is not cut).
AmooMirrorTruncated amooMirrorTruncate(
  String text, {
  int maxChars = kAmooMirrorTextMaxChars,
}) {
  final limit = maxChars < 0 ? 0 : maxChars;
  if (text.length <= limit) return AmooMirrorTruncated(text, false);
  var cut = text.substring(0, limit);
  // The cut can land between a surrogate pair; half a surrogate renders as a
  // replacement box that looks like corrupted content. One char shorter is
  // the cheaper lie.
  final lastUnit = cut.codeUnitAt(cut.length - 1);
  if (lastUnit >= 0xD800 && lastUnit <= 0xDBFF) {
    cut = cut.substring(0, cut.length - 1);
  }
  return AmooMirrorTruncated('$cut…', true);
}

/// The contract does not promise a single-line tool summary, but the collapsed
/// row must be one line or the list layout breaks.
String amooMirrorOneLine(String raw) => raw.replaceAll(RegExp(r'\s+'), ' ').trim();
