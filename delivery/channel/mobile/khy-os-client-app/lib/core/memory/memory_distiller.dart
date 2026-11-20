import 'dart:math' as math;

import 'memory_store.dart';

/// Why the distiller wants to forget an entry.
enum DistillReason {
  empty('empty', '空记忆'),
  duplicate('duplicate', '重复'),
  stale('stale', '陈旧');

  const DistillReason(this.wire, this.label);

  final String wire;

  /// Chinese label for the report and the archive list.
  final String label;
}

/// Tunables, ported from `distiller.js`.
///
/// A class rather than module-level constants because each threshold needs a
/// test that forces its branch with a one-day horizon — with frozen constants
/// those tests would have to fabricate a memory from the year 1990.
class DistillThresholds {
  const DistillThresholds({
    this.minBodyChars = 12,
    this.dupThreshold = 0.82,
    this.staleDaysUser = 3650,
    this.staleDaysFeedback = 540,
    this.staleDaysReference = 365,
    this.staleDaysProject = 180,
  });

  /// Bodies shorter than this carry no information worth recalling.
  final int minBodyChars;

  /// Token Jaccard at which two entries count as the same memory.
  final double dupThreshold;

  /// Per-type staleness horizons in days. `user` is effectively immortal — the
  /// per-type approximation of the permanent tier; the tier itself is the hard
  /// invariant (see [MemoryEntry.forgetEligible]).
  final int staleDaysUser;
  final int staleDaysFeedback;
  final int staleDaysReference;
  final int staleDaysProject;

  int staleDaysFor(MemoryType type) => switch (type) {
        MemoryType.user => staleDaysUser,
        MemoryType.feedback => staleDaysFeedback,
        MemoryType.reference => staleDaysReference,
        MemoryType.project => staleDaysProject,
      };
}

/// An entry worth keeping, with the value score that says how much.
class DistillKeep {
  const DistillKeep({required this.entry, required this.value});

  final MemoryEntry entry;
  final double value;
}

/// An entry proposed for archiving, with the reason in words.
class DistillForget {
  const DistillForget({
    required this.entry,
    required this.reason,
    required this.detail,
  });

  final MemoryEntry entry;
  final DistillReason reason;
  final String detail;
}

/// A near-duplicate cluster: the survivor stays, the rest are archived.
class DistillMergeGroup {
  const DistillMergeGroup({required this.survivorId, required this.absorbedIds});

  final String survivorId;
  final List<String> absorbedIds;
}

class DistillStats {
  const DistillStats({
    required this.total,
    required this.keep,
    required this.forget,
    required this.mergeGroups,
    required this.byReason,
  });

  final int total;
  final int keep;
  final int forget;
  final int mergeGroups;
  final Map<DistillReason, int> byReason;
}

/// What a distillation run would do. A plan, not an action.
class DistillPlan {
  const DistillPlan({
    required this.keep,
    required this.forget,
    required this.merge,
    required this.stats,
  });

  final List<DistillKeep> keep;
  final List<DistillForget> forget;
  final List<DistillMergeGroup> merge;
  final DistillStats stats;

  /// Nothing to do. The UI says so instead of rendering an empty report.
  bool get isEmpty => forget.isEmpty && merge.isEmpty;
}

/// What a periodic run is allowed to do.
///
/// The platform gates this on `KHY_MEMORY_DISTILL_AUTO`; the client has no env,
/// so the mode is a value the settings card picks. `report` is the default and
/// `archive` has to be chosen deliberately — the safe direction is a report the
/// user reads, not a move the user discovers afterwards.
enum DistillAutoMode {
  off('off', '关闭'),
  report('report', '只出报告'),
  archive('archive', '报告并归档');

  const DistillAutoMode(this.wire, this.label);

  final String wire;
  final String label;

  static DistillAutoMode parse(String? raw) {
    for (final v in DistillAutoMode.values) {
      if (v.wire == raw) return v;
    }
    return DistillAutoMode.report;
  }
}

/// The answer to "should a distillation run now, and what may it do".
class DistillRun {
  const DistillRun({
    required this.run,
    required this.apply,
    required this.note,
  });

  final bool run;

  /// Whether the run may archive. Only ever true for [DistillAutoMode.archive].
  final bool apply;

  /// Chinese explanation for the UI; never empty when [run] is false.
  final String note;
}

/// Periodic gating, ported from `distiller.maybeDistill` / `intervalElapsed`.
class DistillPolicy {
  const DistillPolicy({
    this.mode = DistillAutoMode.report,
    this.intervalDays = 7,
  });

  final DistillAutoMode mode;
  final int intervalDays;

  DistillRun decide(int nowMs, {int lastRunMs = 0, bool force = false}) {
    if (mode == DistillAutoMode.off) {
      return const DistillRun(run: false, apply: false, note: '周期蒸馏已关闭');
    }
    if (!force && lastRunMs > 0 && nowMs - lastRunMs < intervalDays * 86400000) {
      final days = ((nowMs - lastRunMs) / 86400000).floor();
      return DistillRun(
        run: false,
        apply: false,
        note: '距上次蒸馏 $days 天，未满 $intervalDays 天周期',
      );
    }
    if (mode == DistillAutoMode.archive) {
      return const DistillRun(
        run: true,
        apply: true,
        note: '到期：分析并归档建议忘记的记忆（归档可恢复）',
      );
    }
    return const DistillRun(run: true, apply: false, note: '到期：只分析并出报告，不动任何记忆');
  }
}

/// Periodic memory distillation: decide, transparently and reversibly, what to
/// keep and what to forget.
///
/// Ported from `domain/memory/memoryEngine/distiller.js`. The safety contract is
/// the whole point of the module and is carried over unchanged:
///   - [analyze] is pure. It produces a plan with a reason per decision and
///     touches nothing.
///   - "forget" means archive — a move into the archive keys with a manifest,
///     never a delete. Restoring is a move back (see [MemoryStore.restore]).
///   - Dry-run is the default everywhere; archiving requires an explicit mode.
///   - The permanent tier is immune to every automatic reason.
class MemoryDistiller {
  const MemoryDistiller._();

  /// Token set of an entry's name + description + body (`_memTokens`).
  static Set<String> _tokens(MemoryEntry entry) =>
      tokenizeForRecall('${entry.name} ${entry.description} ${entry.body}');

  static double _jaccard(Set<String> a, Set<String> b) {
    if (a.isEmpty || b.isEmpty) return 0;
    var inter = 0;
    for (final t in a) {
      if (b.contains(t)) inter++;
    }
    final union = a.length + b.length - inter;
    return union == 0 ? 0 : inter / union;
  }

  /// Durability weight by kind (higher ⇒ more worth keeping).
  static double _durability(MemoryType type) => switch (type) {
        MemoryType.user => 1.0,
        MemoryType.feedback => 0.9,
        MemoryType.reference => 0.6,
        MemoryType.project => 0.5,
      };

  /// A transparent "worth keeping" score: durability × recency × richness.
  /// Picks the survivor among near-duplicates and explains keep decisions.
  static double _valueScore(
      MemoryEntry entry, int nowMs, DistillThresholds t) {
    final ageDays = math.max(0, nowMs - entry.updatedMs) / 86400000;
    final horizon = math.max(1, t.staleDaysFor(entry.type));
    final recency = math.pow(0.5, ageDays / horizon).toDouble();
    final richness = math.min(1.0, entry.body.trim().length / 400);
    return _durability(entry.type) *
        (0.5 + 0.5 * recency) *
        (0.4 + 0.6 * richness);
  }

  /// Produce a distillation plan. Pure: no disk writes, no store access.
  ///
  /// What to forget, in priority order: empty bodies, then near-duplicates of a
  /// higher-value entry, then per-type staleness. Everything else is kept with
  /// its value score. A permanent entry is never in the forget set, whatever its
  /// body length or age.
  static DistillPlan analyze(
    List<MemoryEntry> entries, {
    int? nowMs,
    DistillThresholds thresholds = const DistillThresholds(),
  }) {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    final forget = <DistillForget>[];
    final merge = <DistillMergeGroup>[];
    final forgotten = <String>{};

    // 1) Empty / near-empty bodies.
    for (final entry in entries) {
      final bodyLen = entry.body.trim().length;
      if (bodyLen < thresholds.minBodyChars && entry.forgetEligible) {
        forget.add(DistillForget(
          entry: entry,
          reason: DistillReason.empty,
          detail: '正文仅 $bodyLen 字符',
        ));
        forgotten.add(entry.id);
      }
    }

    // 2) Near-duplicates among the survivors, highest value first so the
    //    strongest copy is the one that stays.
    final survivors = entries.where((e) => !forgotten.contains(e.id)).toList()
      ..sort((a, b) {
        final byValue =
            _valueScore(b, now, thresholds).compareTo(_valueScore(a, now, thresholds));
        if (byValue != 0) return byValue;
        final byAge = b.updatedMs.compareTo(a.updatedMs);
        if (byAge != 0) return byAge;
        return a.id.compareTo(b.id);
      });

    final kept = <MemoryEntry>[];
    for (final entry in survivors) {
      if (forgotten.contains(entry.id)) continue;
      MemoryEntry? absorbedInto;
      for (final k in kept) {
        if (_jaccard(_tokens(entry), _tokens(k)) >= thresholds.dupThreshold) {
          absorbedInto = k;
          break;
        }
      }
      if (absorbedInto == null) {
        kept.add(entry);
        continue;
      }
      // Near-duplicate of something already kept. A permanent entry is still
      // immune: it stays, and the duplicate it matched is the one that goes.
      if (!entry.forgetEligible) {
        kept.add(entry);
        continue;
      }
      // Bound to a non-nullable local: the closures below read it, and a
      // promoted variable does not carry its promotion into a closure body.
      final keeperId = absorbedInto.id;
      forget.add(DistillForget(
        entry: entry,
        reason: DistillReason.duplicate,
        detail: '与 ${_title(absorbedInto)} 高度重复',
      ));
      forgotten.add(entry.id);
      final at = merge.indexWhere((g) => g.survivorId == keeperId);
      if (at >= 0) {
        merge[at] = DistillMergeGroup(
          survivorId: keeperId,
          absorbedIds: <String>[...merge[at].absorbedIds, entry.id],
        );
      } else {
        merge.add(DistillMergeGroup(
          survivorId: keeperId,
          absorbedIds: <String>[entry.id],
        ));
      }
    }

    // 3) Staleness, per kind.
    for (final entry in kept.toList()) {
      if (forgotten.contains(entry.id)) continue;
      final ageDays = (now - entry.updatedMs) / 86400000;
      final horizon = thresholds.staleDaysFor(entry.type);
      if (ageDays > horizon && entry.forgetEligible) {
        forget.add(DistillForget(
          entry: entry,
          reason: DistillReason.stale,
          detail: '已 ${ageDays.round()} 天未更新，'
              '超过${entry.type.label} ${horizon} 天保鲜期',
        ));
        forgotten.add(entry.id);
      }
    }

    final keep = kept
        .where((e) => !forgotten.contains(e.id))
        .map((e) {
      final value = _valueScore(e, now, thresholds);
      // Rounded to 4 decimals the way distiller.js rounds, so the report shows
      // the same numbers the platform would.
      final rounded = (value * 10000).round() / 10000;
      return DistillKeep(entry: e, value: rounded);
    }).toList()
      ..sort((a, b) => b.value.compareTo(a.value));

    final byReason = <DistillReason, int>{};
    for (final f in forget) {
      byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
    }

    return DistillPlan(
      keep: keep,
      forget: forget,
      merge: merge,
      stats: DistillStats(
        total: entries.length,
        keep: keep.length,
        forget: forget.length,
        mergeGroups: merge.length,
        byReason: byReason,
      ),
    );
  }

  /// The dry-run report, in Chinese. This is what a report-only periodic run
  /// shows: every decision named with its reason, because a distillation the
  /// user cannot audit is a deletion the user cannot object to.
  static String formatReport(DistillPlan plan) {
    final lines = <String>[];
    final s = plan.stats;
    lines.add('共 ${s.total} 条记忆 → 保留 ${s.keep} · 建议忘记 ${s.forget}');
    if (plan.forget.isNotEmpty) {
      lines.add('');
      lines.add('建议忘记（归档，可恢复）：');
      for (final f in plan.forget) {
        lines.add('  - [${f.reason.label}] ${_title(f.entry)} — ${f.detail}');
      }
    }
    if (plan.merge.isNotEmpty) {
      lines.add('');
      lines.add('合并组（保留首项，其余归档）：');
      for (final g in plan.merge) {
        lines.add('  - 保留 ${g.survivorId} ← 吸收 ${g.absorbedIds.join('、')}');
      }
    }
    if (plan.keep.isNotEmpty) {
      lines.add('');
      lines.add('保留（价值高→低，前 10 条）：');
      for (final k in plan.keep.take(10)) {
        lines.add('  - ${_title(k.entry)}（${k.entry.type.label}，价值 ${k.value}）');
      }
    }
    return lines.join('\n');
  }

  static String _title(MemoryEntry entry) =>
      entry.name.trim().isEmpty ? entry.id : entry.name.trim();
}
