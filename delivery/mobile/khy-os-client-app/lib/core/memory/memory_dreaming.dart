import 'dart:convert';

import 'memory_store.dart';

/// The three consolidation phases, with their cadence.
enum DreamPhase {
  light('light', '轻整理', Duration(hours: 6)),
  deep('deep', '深度固化', Duration(hours: 24)),
  rem('rem', '模式提取', Duration(days: 7));

  const DreamPhase(this.wire, this.label, this.interval);

  final String wire;
  final String label;

  /// How often this phase is due. The platform runs Deep at 03:00 and REM on
  /// Sunday 05:00; a phone that is asleep at those hours would simply never
  /// dream, so the cadence is expressed as an interval since the last run
  /// instead of a wall-clock slot.
  final Duration interval;

  static DreamPhase parse(String? raw) {
    for (final v in DreamPhase.values) {
      if (v.wire == raw) return v;
    }
    return DreamPhase.light;
  }
}

/// AI callback for the phases that need a model.
///
/// Null means "not connected", and the Deep/REM phases then do not run and say
/// so. There is deliberately no transport in here: this batch adds no network
/// layer on the client (`khyos_api.dart` is out of scope), so a caller wires its
/// own configured gateway or backend call in — or leaves it null and gets an
/// honest "not run" instead of a fabricated result.
typedef DreamSynthesizer = Future<String> Function(String prompt);

/// One cluster the Light phase wants to fold together.
class DreamMerge {
  const DreamMerge({required this.keeper, required this.absorbed});

  /// The copy that stays.
  final MemoryEntry keeper;

  /// The copies that would be archived into it.
  final List<MemoryEntry> absorbed;

  /// What the keeper's recallCount becomes after folding the duplicates in.
  int get mergedRecallCount =>
      keeper.recallCount + absorbed.fold<int>(0, (sum, e) => sum + e.recallCount);
}

/// The Light-phase plan. Pure — nothing moves until the caller archives through
/// the store, and what it archives is restorable.
class DreamLightPlan {
  const DreamLightPlan({required this.merges, required this.considered});

  final List<DreamMerge> merges;

  /// How many entries fell inside the lookback window, before dedup.
  final int considered;

  bool get isEmpty => merges.isEmpty;
  int get merged => merges.length;
  int get dropped => merges.fold<int>(0, (sum, m) => sum + m.absorbed.length);
  int get kept => considered - dropped;

  /// Ids of every duplicate that would be archived, for the caller to hand to
  /// [MemoryStore.forget].
  List<String> get absorbedIds => [
        for (final m in merges) for (final e in m.absorbed) e.id,
      ];
}

/// The Deep-phase outcome.
class DreamDeepReport {
  const DreamDeepReport({
    required this.ran,
    required this.note,
    this.candidates = const <MemoryEntry>[],
    this.synthesis,
  });

  /// Whether a model actually ran. False means nothing was written, and [note]
  /// says why.
  final bool ran;

  /// Chinese status for the UI: what happened, to what, with what progress.
  final String note;

  /// The entries that qualified, whether or not the phase ran.
  final List<MemoryEntry> candidates;

  /// The model's consolidation. The caller decides whether to store it as a new
  /// memory — this module never writes.
  final String? synthesis;
}

/// The REM-phase outcome.
class DreamRemReport {
  const DreamRemReport({
    required this.ran,
    required this.note,
    this.sources = const <MemoryEntry>[],
    this.patterns = const <DreamPattern>[],
  });

  final bool ran;
  final String note;
  final List<MemoryEntry> sources;
  final List<DreamPattern> patterns;
}

/// One extracted pattern. [strength] is the model's own confidence, kept as
/// given so the threshold stays visible instead of baked into the parse.
class DreamPattern {
  const DreamPattern({required this.description, required this.strength});

  final String description;
  final double strength;
}

/// Sleep-cycle memory consolidation, ported from `services/memoryDreaming.js`.
///
///   Light (6h)  → local near-duplicate folding. Runs on-device, always.
///   Deep  (24h) → analytical synthesis of the memories the user keeps coming
///                 back to. Needs a model.
///   REM   (7d)  → cross-memory pattern extraction. Needs a model.
///
/// The port is honest about what the client entry can and cannot express, and
/// every deviation is marked where it applies rather than papered over.
class MemoryDreaming {
  const MemoryDreaming._();

  static const double lightSimilarity = 0.9;
  static const int lightLookbackDays = 2;
  static const int lightLimit = 100;

  static const int deepLimit = 10;
  static const int deepMaxAgeDays = 30;
  static const int deepMinRecallCount = 3;

  static const int remLookbackDays = 7;

  /// Wide search for pattern finding, as in the platform's `REM_LIMIT * 3`.
  static const int remSourceLimit = 30;
  static const int remMinSources = 3;
  static const double remMinStrength = 0.75;

  /// Whether [phase] is due. A phase that has never run is due immediately.
  static bool isDue(DreamPhase phase, int lastRunMs, int nowMs) =>
      lastRunMs <= 0 || nowMs - lastRunMs >= phase.interval.inMilliseconds;

  /// Light phase: fold recent near-duplicates.
  ///
  /// Two deviations from the platform, both forced by the client entry model:
  ///   - the platform filters by `source` (daily/session/recall); the client
  ///     entry has no source axis, so the lookback window is the only filter;
  ///   - the platform keeps the entry with the highest `score + recallCount`;
  ///     the client entry has no health score, so recallCount then recency
  ///     decides.
  static DreamLightPlan planLightDedup(
    List<MemoryEntry> entries, {
    int? nowMs,
    double similarity = lightSimilarity,
    int lookbackDays = lightLookbackDays,
    int limit = lightLimit,
  }) {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    final cutoff = now - lookbackDays * 86400000;
    final recent = entries.where((e) => e.updatedMs >= cutoff).toList()
      ..sort((a, b) => b.updatedMs.compareTo(a.updatedMs));
    final window = recent.length > limit ? recent.sublist(0, limit) : recent;
    if (window.length < 2) {
      return DreamLightPlan(merges: const <DreamMerge>[], considered: window.length);
    }

    final grams = window.map(_ngrams).toList(growable: false);
    final assigned = List<bool>.filled(window.length, false);
    final merges = <DreamMerge>[];

    for (var i = 0; i < window.length; i++) {
      if (assigned[i]) continue;
      assigned[i] = true;
      final cluster = <MemoryEntry>[window[i]];
      for (var j = i + 1; j < window.length; j++) {
        if (assigned[j]) continue;
        if (_jaccard(grams[i], grams[j]) >= similarity) {
          assigned[j] = true;
          cluster.add(window[j]);
        }
      }
      if (cluster.length == 1) continue;
      cluster.sort((a, b) {
        final byRecall = b.recallCount.compareTo(a.recallCount);
        if (byRecall != 0) return byRecall;
        return b.updatedMs.compareTo(a.updatedMs);
      });
      merges.add(DreamMerge(keeper: cluster.first, absorbed: cluster.sublist(1)));
    }

    return DreamLightPlan(merges: merges, considered: window.length);
  }

  /// Deep phase: consolidate the entries the user keeps coming back to.
  ///
  /// DEVIATION, stated rather than hidden: the platform also requires a health
  /// score ≥ 0.8 and ≥ 3 distinct recall queries. The client entry carries
  /// neither, so recallCount is the only signal left, and what remains here is
  /// the platform's threshold with the fields that do not exist removed.
  static Future<DreamDeepReport> runDeep(
    List<MemoryEntry> entries, {
    DreamSynthesizer? synthesizer,
    int? nowMs,
    int limit = deepLimit,
    int maxAgeDays = deepMaxAgeDays,
    int minRecallCount = deepMinRecallCount,
  }) async {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    final qualified = entries.where((e) {
      final ageDays = (now - e.updatedMs) / 86400000;
      return ageDays <= maxAgeDays && e.recallCount >= minRecallCount;
    }).toList()
      ..sort((a, b) => b.recallCount.compareTo(a.recallCount));
    final picked =
        qualified.length > limit ? qualified.sublist(0, limit) : qualified;

    if (picked.isEmpty) {
      return DreamDeepReport(
        ran: false,
        note: '没有达到召回 $minRecallCount 次的记忆，深度固化无事可做',
      );
    }
    if (synthesizer == null) {
      // The honest answer. Claiming a consolidation that never ran would put a
      // fabricated "insight" in front of the user as if a model had read their
      // memories.
      return DreamDeepReport(
        ran: false,
        note: '未连接 AI 网关或后端，本次不执行深度固化；'
            '${picked.length} 条候选记忆原样保留',
        candidates: picked,
      );
    }

    try {
      final raw = await synthesizer(buildDeepSynthesisPrompt(picked));
      final text = raw.trim();
      if (text.isEmpty) {
        return DreamDeepReport(
          ran: false,
          note: '模型未返回内容，深度固化未写入任何记忆',
          candidates: picked,
        );
      }
      return DreamDeepReport(
        ran: true,
        note: '深度固化完成：${picked.length} 条候选归纳为 1 条洞察',
        candidates: picked,
        synthesis: text,
      );
    } catch (e) {
      return DreamDeepReport(
        ran: false,
        note: '深度固化失败：$e；候选记忆未改动',
        candidates: picked,
      );
    }
  }

  /// REM phase: cross-memory pattern extraction.
  static Future<DreamRemReport> runRem(
    List<MemoryEntry> entries, {
    DreamSynthesizer? synthesizer,
    int? nowMs,
    int lookbackDays = remLookbackDays,
    int limit = remSourceLimit,
  }) async {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    final cutoff = now - lookbackDays * 86400000;
    final qualified = entries.where((e) => e.updatedMs >= cutoff).toList()
      ..sort((a, b) => b.recallCount.compareTo(a.recallCount));
    final sources =
        qualified.length > limit ? qualified.sublist(0, limit) : qualified;

    if (sources.length < remMinSources) {
      return DreamRemReport(
        ran: false,
        note: '近 $lookbackDays 天只有 ${sources.length} 条记忆，'
            '不足 $remMinSources 条，模式提取无事可做',
        sources: sources,
      );
    }
    if (synthesizer == null) {
      return DreamRemReport(
        ran: false,
        note: '未连接 AI 网关或后端，本次不执行模式提取；'
            '${sources.length} 条来源记忆原样保留',
        sources: sources,
      );
    }

    try {
      final raw = await synthesizer(buildPatternPrompt(sources));
      final patterns =
          parsePatterns(raw).where((p) => p.strength >= remMinStrength).toList();
      return DreamRemReport(
        ran: true,
        note: patterns.isEmpty
            ? '模型未给出强度 ≥ $remMinStrength 的模式，未写入任何记忆'
            : '模式提取完成：得到 ${patterns.length} 条模式',
        sources: sources,
        patterns: patterns,
      );
    } catch (e) {
      return DreamRemReport(
        ran: false,
        note: '模式提取失败：$e；来源记忆未改动',
        sources: sources,
      );
    }
  }

  /// Ported from `_buildDeepSynthesisPrompt`. English on purpose: the platform's
  /// prompt is English and the two have to stay comparable.
  static String buildDeepSynthesisPrompt(List<MemoryEntry> candidates) {
    final entries =
        candidates.map((c) => '[Recalls:${c.recallCount}] ${_textOf(c)}').join('\n\n');
    return 'Synthesize the following memory fragments into a single coherent insight.\n'
        'Preserve all specific identifiers, paths, numbers, and technical details.\n'
        'Focus on extracting the underlying pattern or principle.\n\n'
        'Memory fragments:\n$entries\n\n'
        'Output a concise synthesis (2-4 sentences) that captures the essential knowledge.';
  }

  /// Ported from `_buildPatternExtractionPrompt`.
  static String buildPatternPrompt(List<MemoryEntry> sources) {
    final entries = sources.map((s) => '- ${_textOf(s)}').join('\n');
    return 'Analyze these memory entries and extract recurring patterns or themes.\n'
        'Output as JSON array: [{"description": "...", "strength": 0.0-1.0}]\n'
        'Only include patterns with strength >= 0.75.\n\n'
        'Memories:\n$entries';
  }

  /// Parse a `[{"description": "...", "strength": 0.0-1.0}]` answer.
  ///
  /// Tolerates a fenced block and JSON embedded in prose, because models produce
  /// both even when told not to. Anything unparseable yields no patterns rather
  /// than a guess: a fabricated pattern would be written back as a memory and
  /// then recalled as if the user had said it.
  static List<DreamPattern> parsePatterns(String raw) {
    final text = raw.trim();
    if (text.isEmpty) return const <DreamPattern>[];
    final direct = _decodeArray(text);
    if (direct != null) return direct;
    final match = RegExp(r'\[[\s\S]*\]').firstMatch(text);
    if (match == null) return const <DreamPattern>[];
    return _decodeArray(match.group(0)!) ?? const <DreamPattern>[];
  }

  static List<DreamPattern>? _decodeArray(String text) {
    try {
      final decoded = jsonDecode(text);
      if (decoded is List) return _patternsFrom(decoded);
      if (decoded is Map<String, dynamic> && decoded['patterns'] is List) {
        return _patternsFrom(decoded['patterns'] as List);
      }
    } catch (_) {
      // Not JSON — the caller tries the next candidate.
    }
    return null;
  }

  static List<DreamPattern> _patternsFrom(List raw) {
    final out = <DreamPattern>[];
    for (final item in raw) {
      if (item is! Map) continue;
      final desc = item['description'];
      if (desc is! String || desc.trim().isEmpty) continue;
      final strength = item['strength'];
      final value = strength is num
          ? strength.toDouble().clamp(0.0, 1.0).toDouble()
          : 0.0;
      out.add(DreamPattern(description: desc.trim(), strength: value));
    }
    return out;
  }

  /// Character trigrams, the shape `_extractNgrams` uses.
  ///
  /// The platform clusters on `content`; the client entry has no separate
  /// content field, so name + description + body stand in for it.
  static Set<String> _ngrams(MemoryEntry entry) {
    final text =
        '${entry.name} ${entry.description} ${entry.body}'.toLowerCase().replaceAll(
      RegExp(r'\s+'),
      ' ',
    );
    final set = <String>{};
    for (var i = 0; i + 3 <= text.length; i++) {
      set.add(text.substring(i, i + 3));
    }
    return set;
  }

  static double _jaccard(Set<String> a, Set<String> b) {
    if (a.isEmpty && b.isEmpty) return 1;
    var inter = 0;
    for (final t in a) {
      if (b.contains(t)) inter++;
    }
    final union = a.length + b.length - inter;
    return union > 0 ? inter / union : 0;
  }

  /// What the model gets to read for one entry. The platform passes `content`
  /// alone; description and name are prepended here because the client splits
  /// what the platform keeps in one field.
  static String _textOf(MemoryEntry entry) {
    final name = entry.name.trim();
    final desc = entry.description.trim();
    final body = entry.body.trim();
    final parts = <String>[
      if (name.isNotEmpty) name,
      if (desc.isNotEmpty) desc,
      if (body.isNotEmpty) body,
    ];
    return parts.join('\n');
  }
}
