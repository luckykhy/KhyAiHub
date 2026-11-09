/// `_khyTrace` provenance envelope — Dart mirror of the platform single source
/// runtime/node/backend/src/services/domain/trajectory/trajectoryProvenance/khyTrace.js
/// (DESIGN-ARCH-047 §2).
///
/// The phone never re-executes a trajectory: replay must run on the backend host
/// that owns the workspace files and tools. What the phone owes the platform is
/// the same envelope, so a record written here reads identically there.
///
/// Two rules from the JS original are load-bearing and must survive any edit:
///   - labels fail safe to ours: missing/abnormal input collapses to
///     khy-local/verified, never the reverse — isolation triggers on
///     producer != khy-local, so a missed tag can only err toward "ours";
///   - an unknown producer collapses to relay with the raw value kept as
///     producerId, and no entry point throws.
///
/// TraceArtifact / ReplayTier live here (not in the chain or the store) because
/// they are plain record value types shared by execution_log and
/// trajectory_store; this file is the only one of the three with no dart:io.

/// JSON key the envelope rides on inside a trajectory record.
const String kTraceKey = '_khyTrace';

/// Envelope schema version, same value as the JS original.
const int traceVersion = 1;

enum TraceProducer {
  khyLocal('khy-local'),
  codex('codex'),
  claudeCode('claude-code'),
  relay('relay');

  const TraceProducer(this.wire);

  /// Value as it appears on the wire (and in the JS enums).
  final String wire;

  static TraceProducer? fromWire(Object? value) {
    for (final p in TraceProducer.values) {
      if (p.wire == value) return p;
    }
    return null;
  }
}

enum TraceTrust {
  verified,
  claimed,
  quarantined;

  static TraceTrust? fromWire(Object? value) {
    for (final t in TraceTrust.values) {
      if (t.name == value) return t;
    }
    return null;
  }
}

enum TraceKind {
  text('text'),
  thinking('thinking'),
  toolCall('tool_call'),
  toolResult('tool_result');

  const TraceKind(this.wire);

  final String wire;

  static TraceKind? fromWire(Object? value) {
    for (final k in TraceKind.values) {
      if (k.wire == value) return k;
    }
    return null;
  }
}

/// Replay tier, mirroring trajectoryReplay/tierRegistry.js (DESIGN-ARCH-048):
/// FILE auto-replays, SHELL needs pre-approval, NETWORK_AI never replays.
///
/// No phone-side classification ships in phase 1 on purpose: the tool-name
/// registry that decides the tier is a backend asset (tools/_writeToolNames.js)
/// and the mobile tool set is a different list, so porting the sets would pin
/// desktop tool names into the phone. The field is recorded so the backend
/// replay gate has it the day it lands.
enum ReplayTier {
  file('FILE'),
  shell('SHELL'),
  networkAi('NETWORK_AI');

  const ReplayTier(this.wire);

  final String wire;

  static ReplayTier? fromWire(Object? value) {
    for (final t in ReplayTier.values) {
      if (t.wire == value) return t;
    }
    return null;
  }
}

/// One file artifact a tool step touched: path + sha256 of its after-bytes.
/// Shape copied from replayLedger's `artifacts[]` ({path, sha256, op}); the
/// bytes themselves stay on disk, only the digest travels.
class TraceArtifact {
  const TraceArtifact({required this.path, required this.sha256, this.op});

  final String path;
  final String sha256;

  /// create / modify / delete, when the caller knows it.
  final String? op;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'path': path,
        'sha256': sha256,
        if (op != null) 'op': op,
      };

  static TraceArtifact? fromJson(Map<String, dynamic> json) {
    final path = json['path'];
    final sha = json['sha256'];
    if (path is! String || sha is! String) return null;
    return TraceArtifact(
      path: path,
      sha256: sha,
      op: json['op'] is String ? json['op'] as String : null,
    );
  }
}

class TraceEnvelope {
  const TraceEnvelope({
    required this.producer,
    required this.producerId,
    required this.trust,
    required this.kind,
    required this.at,
    this.contradictions = const <dynamic>[],
    this.seal,
  });

  final TraceProducer producer;
  final String? producerId;
  final TraceTrust trust;
  final TraceKind kind;

  /// Epoch milliseconds.
  final int at;

  /// Filled by later reconciliation stages (P4); pass-through here.
  final List<dynamic> contradictions;

  /// Pass-through field; the phone does not seal (see trace_chain.dart on why
  /// the process-private HMAC seal was not ported).
  final String? seal;

  /// Build an envelope with the JS original's normalization: unknown producer
  /// collapses to relay, missing trust is verified only for khy-local, unknown
  /// kind falls back to text.
  factory TraceEnvelope.make({
    Object? producer,
    Object? producerId,
    Object? trust,
    Object? kind,
    int? at,
    Object? contradictions,
    Object? seal,
  }) {
    final norm = normalizeProducer(producer, producerId);
    return TraceEnvelope(
      producer: norm.producer,
      producerId: norm.producerId,
      trust: _normalizeTrust(trust, norm.producer),
      kind: _normalizeKind(kind),
      at: at ?? DateTime.now().millisecondsSinceEpoch,
      contradictions: contradictions is List
          ? List<dynamic>.from(contradictions)
          : const <dynamic>[],
      seal: seal is String ? seal : null,
    );
  }

  /// Parse a stored envelope. Returns null when producer/trust are not frozen
  /// enum values — the caller then applies the fail-safe default (traceOf).
  static TraceEnvelope? fromJson(Map<String, dynamic> json) {
    final producer = TraceProducer.fromWire(json['producer']);
    final trust = TraceTrust.fromWire(json['trust']);
    if (producer == null || trust == null) return null;
    final rawContradictions = json['contradictions'];
    return TraceEnvelope(
      producer: producer,
      producerId:
          json['producerId'] is String ? json['producerId'] as String : null,
      trust: trust,
      kind: TraceKind.fromWire(json['kind']) ?? TraceKind.text,
      at: (json['at'] as num?)?.toInt() ?? 0,
      contradictions: rawContradictions is List
          ? List<dynamic>.from(rawContradictions)
          : const <dynamic>[],
      seal: json['seal'] is String ? json['seal'] as String : null,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'v': traceVersion,
        'producer': producer.wire,
        'producerId': producerId,
        'trust': trust.name,
        'kind': kind.wire,
        'at': at,
        'contradictions': contradictions,
        'seal': seal,
      };
}

/// Normalize a producer: known enums pass through; null/empty is ours; anything
/// else collapses to relay with the raw value as producerId (explicit
/// producerId wins over the raw producer, same as the JS original).
({TraceProducer producer, String? producerId}) normalizeProducer(
  Object? producer,
  Object? producerId,
) {
  final known = producer is TraceProducer
      ? producer
      : producer is String
          ? TraceProducer.fromWire(producer)
          : null;
  if (known != null) {
    return (
      producer: known,
      producerId: producerId == null ? null : '$producerId',
    );
  }
  if (producer == null || (producer is String && producer.isEmpty)) {
    // Fail-safe branch returns before producerId is read: a passed id is
    // dropped together with the empty producer (JS branch order).
    return (producer: TraceProducer.khyLocal, producerId: null);
  }
  return (
    producer: TraceProducer.relay,
    producerId: producerId == null ? '$producer' : '$producerId',
  );
}

TraceTrust _normalizeTrust(Object? trust, TraceProducer producer) {
  final known = trust is TraceTrust
      ? trust
      : trust is String
          ? TraceTrust.fromWire(trust)
          : null;
  // A legal trust passes through verbatim — even "verified" on an external
  // producer; the caller owns that claim. Only missing/abnormal values default,
  // and never to verified for anything but our own producer.
  if (known != null) return known;
  return producer == TraceProducer.khyLocal
      ? TraceTrust.verified
      : TraceTrust.claimed;
}

TraceKind _normalizeKind(Object? kind) {
  final known = kind is TraceKind
      ? kind
      : kind is String
          ? TraceKind.fromWire(kind)
          : null;
  return known ?? TraceKind.text;
}

/// Whether an entry carries a structurally valid envelope (JS `isTrace`).
bool entryHasTrace(Map<String, dynamic>? entry) {
  final raw = entry?[kTraceKey];
  if (raw is! Map) return false;
  return TraceEnvelope.fromJson(Map<String, dynamic>.from(raw)) != null;
}

/// Read an entry's envelope. Never returns null: a missing or structurally
/// broken envelope yields the fail-safe khy-local/verified default, so every
/// downstream renderer, chain link and reconciler holds a complete envelope.
TraceEnvelope traceOf(Map<String, dynamic>? entry) {
  final raw = entry?[kTraceKey];
  if (raw is Map) {
    final parsed = TraceEnvelope.fromJson(Map<String, dynamic>.from(raw));
    if (parsed != null) return parsed;
  }
  return TraceEnvelope.make(
    producer: TraceProducer.khyLocal,
    trust: TraceTrust.verified,
  );
}

/// Whether a producer is an external relay — the single predicate isolation and
/// reconciliation branch on. An unknown producer string is NOT relayed (not a
/// frozen enum value); it reads as ours, which is the fail-safe direction.
bool isRelayed(Object? producer) {
  final known = producer is TraceProducer
      ? producer
      : producer is String
          ? TraceProducer.fromWire(producer)
          : null;
  return known != null && known != TraceProducer.khyLocal;
}

/// Shallow-copy an entry with a fresh envelope attached (JS `stamp`); the input
/// map is never mutated.
Map<String, dynamic> stamp(
  Map<String, dynamic> entry, {
  Object? producer,
  Object? producerId,
  Object? trust,
  Object? kind,
  int? at,
  Object? contradictions,
  Object? seal,
}) {
  return <String, dynamic>{
    ...entry,
    kTraceKey: TraceEnvelope.make(
      producer: producer,
      producerId: producerId,
      trust: trust,
      kind: kind,
      at: at,
      contradictions: contradictions,
      seal: seal,
    ).toJson(),
  };
}
