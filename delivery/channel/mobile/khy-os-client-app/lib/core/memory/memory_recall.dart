import 'dart:math' as math;

import 'memory_store.dart';

/// The sentence the recall box opens with — the same one the platform's
/// proactive block uses ("我记得你之前提到过…"). A constant so the UI and the
/// tests read the same words.
const String kRecallHeader = '我记得你之前提到过';

/// One ranked memory.
class RecallHit {
  const RecallHit({
    required this.entry,
    required this.score,
    required this.keywordScore,
    required this.recency,
  });

  final MemoryEntry entry;

  /// keywordScore × recency — the expression the platform's degrade path uses.
  final double score;

  final double keywordScore;

  /// In (0, 1]; 1.0 for a just-written memory, and exactly 1.0 forever for a
  /// permanent one.
  final double recency;
}

/// A recall box ready to render.
///
/// Exists as a type rather than a bare string because the caller has two jobs
/// with the result: show the box, and count the recalls it surfaced
/// (see [MemoryStore.noteRecall]). A string alone would force the UI to re-parse
/// what it just rendered.
class RecallSection {
  const RecallSection({required this.hits, required this.text});

  final List<RecallHit> hits;

  /// The box body, header included, ready for a `Text` widget.
  final String text;

  List<String> get ids =>
      hits.map((h) => h.entry.id).toList(growable: false);
}

/// Proactive recall: rank memories for the current topic and frame them.
///
/// Ported from `domain/memory/memoryEngine/scoring.js` + `index.js`
/// (`rankMemories` degrade path and `formatProactiveContext`). The hybrid
/// lexical ∪ semantic layer is deliberately NOT ported: it needs an embedding
/// backend, and this batch adds no transport on the client. What is ported is
/// the deterministic half — keyword overlap × time decay × type filter — which
/// is also the half that is testable without a network.
class MemoryRecall {
  const MemoryRecall._();

  static const int defaultLimit = 3;
  static const int defaultMaxChars = 900;

  /// Minimum weighted overlap for an entry to qualify at all. The platform's
  /// default; raising it makes recall quieter, not better.
  static const int defaultMinScore = 1;

  /// Field weights, mirroring `selectRelevantMemories`: name ×3, description ×2,
  /// type ×1, body ×1.
  static const int _weightName = 3;
  static const int _weightDescription = 2;
  static const int _weightType = 1;
  static const int _weightBody = 1;

  /// Tier-scoped recency half-lives in days, mirroring `scoring._halfLifeDays`.
  /// permanent is infinite: age never discounts a permanent memory, which is the
  /// ranking agreeing with the retention semantics instead of contradicting them.
  static const double _shortTermHalfLifeDays = 1;
  static const double _crossSessionHalfLifeDays = 30;

  /// Symmetric CJK-bigram enrichment — the first of the two layers in
  /// `memoryRecallTokens.js`, applied identically to the query and to every
  /// field.
  ///
  /// Why it is here at all: the tokenizer emits single CJK characters, so
  /// 「记忆」and 「机时」score the same against a query containing both. Adding
  /// adjacent bigrams to both sides is monotone (overlap can only grow), so
  /// shared real words outrank shared single characters without ever removing a
  /// hit that existed before.
  ///
  /// The second layer, canonical alias sentinels (「偏好」↔ `preference`), is not
  /// ported: it is a domain word table that would be a second source of truth
  /// the moment it drifted from the platform's. The platform remains the only
  /// place that table lives.
  static Set<String> enrichRecallTokens(Set<String> base, String text) {
    final out = <String>{...base};
    for (final run in RegExp(r'[\u4e00-\u9fff]+').allMatches(text.toLowerCase())) {
      final s = run.group(0)!;
      for (var i = 0; i + 1 < s.length; i++) {
        out.add(s.substring(i, i + 2));
      }
    }
    return out;
  }

  static int _overlapCount(Set<String> query, Set<String> field) {
    var n = 0;
    for (final t in query) {
      if (field.contains(t)) n++;
    }
    return n;
  }

  /// Recency multiplier in (0, 1]: 1.0 when just written, 0.5 at one half-life.
  /// [nowMs] is injectable so tests are deterministic.
  static double recencyMultiplier(int updatedMs, int nowMs, MemoryTier tier) {
    final halfLifeDays = switch (tier) {
      MemoryTier.permanent => double.infinity,
      MemoryTier.shortTerm => _shortTermHalfLifeDays,
      MemoryTier.crossSession => _crossSessionHalfLifeDays,
    };
    if (!halfLifeDays.isFinite) return 1;
    final ageMs = math.max(0, nowMs - updatedMs);
    return math.pow(0.5, ageMs / 86400000 / halfLifeDays).toDouble();
  }

  /// Weighted keyword overlap for one entry, using the platform's field math.
  static double keywordScore(Set<String> queryTokens, MemoryEntry entry) {
    double field(String text) {
      final tokens = enrichRecallTokens(tokenizeForRecall(text), text);
      return _overlapCount(queryTokens, tokens).toDouble();
    }

    return field(entry.name) * _weightName +
        field(entry.description) * _weightDescription +
        field(entry.type.wire) * _weightType +
        field(entry.body) * _weightBody;
  }

  /// Rank [entries] for [query].
  ///
  /// Ordering is fully deterministic — score desc, then recency, then id — so
  /// the same store always produces the same box.
  static List<RecallHit> rank(
    String query,
    List<MemoryEntry> entries, {
    int limit = defaultLimit,
    int minScore = defaultMinScore,
    Set<MemoryType>? types,
    int? nowMs,
  }) {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    final queryTokens = enrichRecallTokens(tokenizeForRecall(query), query);
    if (queryTokens.isEmpty) return const <RecallHit>[];

    final hits = <RecallHit>[];
    for (final entry in entries) {
      if (types != null && !types.contains(entry.type)) continue;
      final kw = keywordScore(queryTokens, entry);
      if (kw < minScore) continue;
      final recency = recencyMultiplier(entry.updatedMs, now, entry.effectiveTier);
      hits.add(RecallHit(
        entry: entry,
        score: kw * recency,
        keywordScore: kw,
        recency: recency,
      ));
    }

    hits.sort((a, b) {
      final byScore = b.score.compareTo(a.score);
      if (byScore != 0) return byScore;
      final byRecency = b.entry.updatedMs.compareTo(a.entry.updatedMs);
      if (byRecency != 0) return byRecency;
      return a.entry.id.compareTo(b.entry.id);
    });
    return hits.length > limit ? hits.sublist(0, limit) : hits;
  }

  /// Rank and frame. Returns null when there is nothing to say.
  ///
  /// The null is load-bearing: an empty recall box reads as "the app looked and
  /// found nothing about you", which is worse than saying nothing at all. Same
  /// contract as the platform's `buildProactiveSystemSection`.
  static RecallSection? buildSection(
    String query,
    List<MemoryEntry> entries, {
    int limit = defaultLimit,
    int maxChars = defaultMaxChars,
    int minScore = defaultMinScore,
    Set<MemoryType>? types,
    int? nowMs,
  }) {
    final ranked =
        rank(query, entries, limit: limit, minScore: minScore, types: types, nowMs: nowMs);
    if (ranked.isEmpty) return null;

    // The header carries the hit count, which is not known until the bullets are
    // chosen, so it is charged a fixed worst-case width instead: 「（99 条）：」
    // is 8 characters.
    var budget = maxChars - (kRecallHeader.length + 8);
    if (budget <= 0) return null;

    final lines = <String>[];
    for (final hit in ranked) {
      final bullet = _bullet(hit);
      if (bullet.length > budget) break;
      lines.add(bullet);
      budget -= bullet.length;
    }
    if (lines.isEmpty) return null;

    return RecallSection(
      hits: ranked.sublist(0, lines.length),
      text: '$kRecallHeader（${lines.length} 条）：\n${lines.join('\n')}',
    );
  }

  /// One bullet: tier and kind as badges, the title, the snippet, and where it
  /// came from. The source line is not decoration — a user who cannot tell which
  /// memory the box is quoting cannot correct it either.
  static String _bullet(RecallHit hit) {
    final entry = hit.entry;
    final title = entry.name.trim().isEmpty ? entry.id : entry.name.trim();
    final snippet = _snippet(entry);
    return '· (${entry.type.label}·${entry.effectiveTier.label}) '
        '$title：$snippet — 来源：本地记忆 ${entry.id}';
  }

  static String _snippet(MemoryEntry entry) {
    final desc = entry.description.trim();
    if (desc.isNotEmpty) return desc;
    final body = entry.body.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (body.isEmpty) return '（无描述）';
    return body.length <= 160 ? body : '${body.substring(0, 160)}…';
  }
}
