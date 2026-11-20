/// Trajectory store — append-only JSONL plus a sidecar hash chain per session.
///
/// Division of labor with LogStore (logs/khy-os-YYYY-MM-DD.jsonl), deliberately
/// not mixed:
///   - LogStore records "what broke in the app" — diagnostics by day, 14-day
///     retention, errors double-written to a projection file;
///   - this store records "what this turn's tools did, verifiably" — one file
///     per conversation, every line sealed into a sidecar hash chain.
/// The chain is a sidecar file (`<record>.trace-chain.json`), never folded into
/// the JSONL lines — the same convention as the platform side, so a
/// phone-written record set reads identically there.
///
/// Every method here is best-effort evidence and none throws at the caller: a
/// failed append is reported through its result, because the tool loop that
/// produced the trajectory must not fail just because its audit trail could
/// not be written (same red line as the platform replayLedger's 防呆 1).

import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

import '../agent/execution_log.dart';
import '../trajectory/trace_chain.dart';
import '../trajectory/trace_envelope.dart';

class TrajectoryStore {
  TrajectoryStore({String? directoryPath}) : _dirOverride = directoryPath;

  /// Sibling of LogStore's `logs/`, never inside it.
  static const String dirName = 'trajectories';

  final String? _dirOverride;
  Directory? _dir;
  bool _disabled = false;

  /// Serialized writes: within a session the JSONL line must land before its
  /// chain link, and concurrent appends would interleave both files.
  Future<void> _writeChain = Future<void>.value();

  Future<Directory?> _resolveDir() async {
    if (_disabled) return null;
    final cached = _dir;
    if (cached != null) return cached;
    try {
      final base = _dirOverride != null
          ? Directory(_dirOverride)
          : await getApplicationDocumentsDirectory();
      final dir = Directory(p.join(base.path, dirName));
      if (!await dir.exists()) await dir.create(recursive: true);
      _dir = dir;
      return dir;
    } catch (_) {
      _disabled = true;
      return null;
    }
  }

  File _sessionFile(Directory dir, String conversationId) =>
      File(p.join(dir.path, '${_safeName(conversationId)}.jsonl'));

  /// A conversation id becomes a file name, so hostile path characters are a
  /// system boundary here. Sanitizing keeps traversal out; two distinct ids
  /// that collide after sanitization would merge into one session file, which
  /// the chain still records honestly.
  String _safeName(String conversationId) {
    final cleaned = conversationId.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    return cleaned.isEmpty ? 'unknown' : cleaned;
  }

  /// Append one execution log's steps: one JSONL line plus one chain link per
  /// step. Steps are recorded as handed over, terminal or not — a step held by
  /// an approval gate is exactly the evidence worth keeping, and there is no
  /// update path to complete it later. The screen renders a still-running
  /// record as "执行中 · 第 N 条" rather than the step's progress-less summary.
  ///
  /// [trust] applies to the whole turn — steps executed locally on the phone
  /// default to verified (fail-safe-to-ours); a caller whose approval gate
  /// held a step passes quarantined.
  Future<TrajectoryAppendResult> appendExecutionLog(
    ExecutionLog log, {
    TraceTrust trust = TraceTrust.verified,
  }) async {
    final dir = await _resolveDir();
    if (dir == null) {
      return const TrajectoryAppendResult(
        ok: false,
        appended: 0,
        error: '轨迹目录不可用',
      );
    }
    final file = _sessionFile(dir, log.conversationId);
    final chainFile = chainPathFor(file.path);
    var appended = 0;
    String? error;

    _writeChain = _writeChain.then((_) async {
      // The chain is the seq authority: a record's seq must equal its link's
      // position, so seed from the chain, not from the line count. If the two
      // ever diverge, verifySession reports it instead of hiding it.
      var seq = (await read(chainFile)).length;
      for (final step in log.steps) {
        final record = TrajectoryRecord.fromStep(
          seq: seq++,
          conversationId: log.conversationId,
          step: step,
          trust: trust,
        );
        final line = jsonEncode(record.toJson());
        await file.writeAsString('$line\n', mode: FileMode.append);
        final link = await append(
          chainFile,
          uuid: record.uuid,
          producer: record.envelope.producer.wire,
          trust: record.envelope.trust.name,
          content: line,
          at: record.at,
        );
        if (!link.ok) {
          // Stop at the first refused link: more lines would only widen the
          // gap between transcript and chain.
          error = link.error;
          return;
        }
        appended++;
      }
    }).catchError((_) {
      error = '写入轨迹库失败';
    });
    await _writeChain;

    return TrajectoryAppendResult(
      ok: error == null,
      appended: appended,
      error: error,
    );
  }

  /// Sessions that have trajectory files, newest first, each with its sidecar
  /// verdict at list granularity (chain integrity only).
  Future<List<TrajectorySession>> listSessions() async {
    final dir = await _resolveDir();
    if (dir == null) return const <TrajectorySession>[];
    if (!await dir.exists()) return const <TrajectorySession>[];
    final out = <TrajectorySession>[];
    await for (final entity in dir.list()) {
      if (entity is! File) continue;
      final name = p.basename(entity.path);
      if (!name.endsWith('.jsonl')) continue;
      final chain = await verify(chainPathFor(entity.path));
      out.add(TrajectorySession(
        conversationId: name.substring(0, name.length - '.jsonl'.length),
        filePath: entity.path,
        recordCount: await _lineCount(entity),
        updatedAt: await entity.lastModified(),
        chain: chain,
      ));
    }
    out.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return out;
  }

  Future<List<TrajectoryRecord>> readSession(String conversationId) async {
    final dir = await _resolveDir();
    if (dir == null) return const <TrajectoryRecord>[];
    return _readRecords(_sessionFile(dir, conversationId));
  }

  /// Full cross-check for one session: chain integrity plus every transcript
  /// line's digest. This is what the screen's 校验 action runs.
  Future<ChainVerification> verifySession(String conversationId) async {
    final dir = await _resolveDir();
    if (dir == null) {
      return const ChainVerification(
        available: false,
        intact: false,
        length: 0,
        brokenAt: null,
        reason: '轨迹目录不可用',
      );
    }
    final file = _sessionFile(dir, conversationId);
    if (!await file.exists()) {
      return const ChainVerification(
        available: false,
        intact: false,
        length: 0,
        brokenAt: null,
        reason: '该会话没有轨迹记录',
      );
    }
    final lines = <String>[];
    for (final line in await file.readAsLines()) {
      if (line.trim().isNotEmpty) lines.add(line);
    }
    return verifyAgainstEntries(chainPathFor(file.path), lines);
  }

  Future<List<TrajectoryRecord>> _readRecords(File file) async {
    try {
      if (!await file.exists()) return const <TrajectoryRecord>[];
      final out = <TrajectoryRecord>[];
      for (final line in await file.readAsLines()) {
        if (line.trim().isEmpty) continue;
        try {
          final decoded = jsonDecode(line);
          if (decoded is Map) {
            final record =
                TrajectoryRecord.fromJson(Map<String, dynamic>.from(decoded));
            if (record != null) out.add(record);
          }
        } catch (_) {
          // One bad line must not take the whole page down (LogStore's rule).
        }
      }
      return out;
    } catch (_) {
      return const <TrajectoryRecord>[];
    }
  }

  Future<int> _lineCount(File file) async {
    try {
      if (!await file.exists()) return 0;
      var count = 0;
      for (final line in await file.readAsLines()) {
        if (line.trim().isNotEmpty) count++;
      }
      return count;
    } catch (_) {
      return 0;
    }
  }
}

class TrajectoryAppendResult {
  const TrajectoryAppendResult({
    required this.ok,
    required this.appended,
    this.error,
  });

  final bool ok;

  /// Steps that got both a transcript line and a chain link.
  final int appended;
  final String? error;
}

/// One recorded tool step. The envelope rides inside the record under
/// [kTraceKey], exactly as on the platform side.
class TrajectoryRecord {
  TrajectoryRecord({
    required this.uuid,
    required this.conversationId,
    required this.seq,
    required this.at,
    required this.envelope,
    required this.tool,
    required this.state,
    required this.durationMs,
    this.paramsHash,
    this.artifacts = const [],
    this.tier,
    this.summary,
  });

  final String uuid;
  final String conversationId;

  /// 0-based, equal to this record's position in the sidecar chain.
  final int seq;

  /// Epoch milliseconds.
  final int at;
  final TraceEnvelope envelope;
  final String tool;

  /// ExecState name.
  final String state;
  final int durationMs;

  /// sha256 of the canonical params; the raw args stay in the execution log,
  /// only the digest enters the trajectory.
  final String? paramsHash;
  final List<TraceArtifact> artifacts;
  final ReplayTier? tier;

  /// Client-generated one-line outcome. Kept even when the envelope is
  /// quarantined — it is evidence. The screen refuses to render it for
  /// quarantined records: untrusted bytes never reach the display.
  final String? summary;

  factory TrajectoryRecord.fromStep({
    required int seq,
    required String conversationId,
    required ExecutionStep step,
    TraceTrust trust = TraceTrust.verified,
    TraceProducer producer = TraceProducer.khyLocal,
  }) {
    final terminal = step.state == ExecState.success ||
        step.state == ExecState.failed ||
        step.state == ExecState.timeout;
    return TrajectoryRecord(
      uuid: const Uuid().v4(),
      conversationId: conversationId,
      seq: seq,
      at: DateTime.now().millisecondsSinceEpoch,
      envelope: TraceEnvelope.make(
        producer: producer,
        trust: trust,
        kind: terminal ? TraceKind.toolResult : TraceKind.toolCall,
      ),
      tool: step.toolName,
      state: step.state.name,
      durationMs: step.durationMs,
      paramsHash: step.paramsHash ?? contentHash(jsonEncode(step.args)),
      artifacts: step.artifacts,
      tier: step.tier,
      summary: step.summary,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'uuid': uuid,
        'conversation_id': conversationId,
        'seq': seq,
        'at': at,
        'tool': tool,
        'state': state,
        'duration_ms': durationMs,
        if (paramsHash != null) 'params_hash': paramsHash,
        if (artifacts.isNotEmpty)
          'artifacts': artifacts.map((a) => a.toJson()).toList(),
        if (tier != null) 'tier': tier!.wire,
        if (summary != null) 'summary': summary,
        kTraceKey: envelope.toJson(),
      };

  static TrajectoryRecord? fromJson(Map<String, dynamic> json) {
    final uuid = json['uuid'];
    final conversationId = json['conversation_id'];
    final seq = json['seq'];
    final at = json['at'];
    final tool = json['tool'];
    if (uuid is! String ||
        conversationId is! String ||
        seq is! int ||
        at is! int ||
        tool is! String) {
      return null;
    }
    final rawArtifacts = json['artifacts'];
    final artifacts = <TraceArtifact>[];
    if (rawArtifacts is List) {
      for (final raw in rawArtifacts) {
        if (raw is! Map) continue;
        final artifact = TraceArtifact.fromJson(Map<String, dynamic>.from(raw));
        if (artifact != null) artifacts.add(artifact);
      }
    }
    return TrajectoryRecord(
      uuid: uuid,
      conversationId: conversationId,
      seq: seq,
      at: at,
      envelope: traceOf(json),
      tool: tool,
      state: json['state'] is String ? json['state'] as String : 'unknown',
      durationMs: (json['duration_ms'] as num?)?.toInt() ?? 0,
      paramsHash:
          json['params_hash'] is String ? json['params_hash'] as String : null,
      artifacts: artifacts,
      tier: ReplayTier.fromWire(json['tier']),
      summary: json['summary'] is String ? json['summary'] as String : null,
    );
  }
}

class TrajectorySession {
  const TrajectorySession({
    required this.conversationId,
    required this.filePath,
    required this.recordCount,
    required this.updatedAt,
    required this.chain,
  });

  final String conversationId;
  final String filePath;
  final int recordCount;
  final DateTime updatedAt;

  /// Sidecar verdict at list granularity. The detail page re-runs the full
  /// cross-check against the transcript before showing 校验结果.
  final ChainVerification chain;
}
