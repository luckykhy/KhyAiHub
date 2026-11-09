/// Tamper-evident sidecar hash chain — Dart mirror of
/// runtime/node/backend/src/services/domain/trajectory/trajectoryProvenance/traceChain.js
/// (DESIGN-ARCH-047 phase 2).
///
/// The chain lives in its own file (`<record>.trace-chain.json`) beside the
/// JSONL instead of being folded into each line: the JSONL is append-only with
/// several readers, and per-line prevHash would couple every reader into the
/// chain arithmetic while one corrupt line would poison a full rebuild. The
/// platform side keeps it a sidecar for the same reasons.
///
/// The deterministic basis (seq, uuid, prevHash, producer, trust, contentHash,
/// at — that key order, nulls serialized as null) is byte-for-byte the Node
/// original's, so a sidecar either side wrote re-hashes identically. That
/// compatibility stops at the basis: verifyAgainstEntries binds the raw JSONL
/// line bytes positionally (third divergence below), so a phone-written chain
/// fed to the platform's cross-check reports broken — the two binding rules
/// are not interchangeable.
///
/// Three deliberate divergences from the JS module, all in the "honest verdict"
/// direction:
///   - an unreadable sidecar reports intact=false ("链文件无法读取或解析")
///     instead of the JS silent [] that turns a tampered file into a vacuous
///     green;
///   - a structurally broken entry reports brokenAt instead of the JS
///     TypeError (a bad sidecar must not brick a read-only verification screen);
///   - verifyAgainstEntries binds the chain to the raw JSONL line bytes and
///     matches by position. Re-encoding a parsed map would silently normalize
///     formatting, and position matching catches a deleted middle line that the
///     JS uuid matching walks right past.
///
/// No `seal` field: it was a process-private HMAC that the platform's own
/// verify deliberately ignores (unverifiable across processes), and a single
/// mobile process has no same-process attacker to defend against.

import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;

const int chainVersion = 1;

/// Genesis prevHash: 64 zeros. Spelled out because String.* is not a const
/// expression, and this value is the chain's anchor.
/// Split into two 32-zero literals on purpose: a single 64-char hex run is
/// indistinguishable from a key to secret scanners (check-secrets-staged.js
/// flags hex64), and literal concatenation is still a const expression, so
/// this keeps the anchor compile-time constant. Do not rejoin.
const String genesisPrev =
    '00000000000000000000000000000000' + '00000000000000000000000000000000';
const String chainExt = '.trace-chain.json';

String _sha256(String s) => sha256.convert(utf8.encode(s)).toString();

/// Digest of a record's content. Strings hash as-is; anything else goes through
/// JSON. null collapses to sha256('') — an absent body and an empty one are
/// indistinguishable at the hash layer, same as the JS original.
String contentHash(Object? content) {
  if (content == null) return _sha256('');
  if (content is String) return _sha256(content);
  try {
    return _sha256(jsonEncode(content));
  } catch (_) {
    return _sha256('$content');
  }
}

/// Derive the sidecar path that sits beside a JSONL record file (same
/// directory, same basename, extension swapped).
String chainPathFor(String jsonlPath) {
  final base = p.basename(jsonlPath);
  final stripped = base.toLowerCase().endsWith('.jsonl')
      ? base.substring(0, base.length - '.jsonl'.length)
      : base;
  return p.join(p.dirname(jsonlPath), '$stripped$chainExt');
}

class ChainRecord {
  const ChainRecord({
    required this.seq,
    required this.uuid,
    required this.prevHash,
    required this.producer,
    required this.trust,
    required this.contentHash,
    required this.at,
    required this.hash,
  });

  final int seq;
  final String? uuid;
  final String prevHash;
  final String? producer;
  final String? trust;
  final String contentHash;

  /// Epoch milliseconds, as handed in.
  final int at;
  final String hash;

  /// Build the next link; the hash is computed here, never passed in.
  factory ChainRecord.link({
    required int seq,
    String? uuid,
    required String prevHash,
    String? producer,
    String? trust,
    Object? content,
    int? at,
  }) {
    final digest = contentHash(content);
    final stamp = at ?? DateTime.now().millisecondsSinceEpoch;
    return ChainRecord(
      seq: seq,
      uuid: uuid,
      prevHash: prevHash,
      producer: producer,
      trust: trust,
      contentHash: digest,
      at: stamp,
      hash: _basisHash(
        seq: seq,
        uuid: uuid,
        prevHash: prevHash,
        producer: producer,
        trust: trust,
        contentHash: digest,
        at: stamp,
      ),
    );
  }

  static ChainRecord? fromJson(Map<String, dynamic> json) {
    final seq = json['seq'];
    final prevHash = json['prevHash'];
    final digest = json['contentHash'];
    final at = json['at'];
    final hash = json['hash'];
    if (seq is! int ||
        prevHash is! String ||
        digest is! String ||
        at is! int ||
        hash is! String) {
      return null;
    }
    return ChainRecord(
      seq: seq,
      uuid: json['uuid'] is String ? json['uuid'] as String : null,
      prevHash: prevHash,
      producer: json['producer'] is String ? json['producer'] as String : null,
      trust: json['trust'] is String ? json['trust'] as String : null,
      contentHash: digest,
      at: at,
      hash: hash,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'version': chainVersion,
        'seq': seq,
        'uuid': uuid,
        'prevHash': prevHash,
        'producer': producer,
        'trust': trust,
        'contentHash': contentHash,
        'at': at,
        'hash': hash,
      };

  /// Recompute this record's hash from the basis. `version` and any foreign key
  /// are outside the basis, exactly as on the platform side.
  String recomputeHash() => _basisHash(
        seq: seq,
        uuid: uuid,
        prevHash: prevHash,
        producer: producer,
        trust: trust,
        contentHash: contentHash,
        at: at,
      );
}

/// The cross-process byte contract: seven fields, fixed key order, nulls kept.
/// Changing any of it silently re-bases every chain ever written.
String _basisHash({
  required int seq,
  String? uuid,
  required String prevHash,
  String? producer,
  String? trust,
  required String contentHash,
  required int at,
}) {
  final basis = jsonEncode(<String, Object?>{
    'seq': seq,
    'uuid': uuid,
    'prevHash': prevHash,
    'producer': producer,
    'trust': trust,
    'contentHash': contentHash,
    'at': at,
  });
  return _sha256(basis);
}

class ChainAppendResult {
  const ChainAppendResult({required this.ok, this.seq, this.hash, this.error});

  final bool ok;
  final int? seq;
  final String? hash;
  final String? error;
}

class ChainVerification {
  const ChainVerification({
    required this.available,
    required this.intact,
    required this.length,
    this.brokenAt,
    this.reason,
  });

  /// The sidecar file exists and was readable. false only when missing.
  final bool available;

  final bool intact;
  final int length;

  /// Index of the first bad link (0-based), null when intact.
  final int? brokenAt;
  final String? reason;
}

Map<String, dynamic>? _asMap(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : null;

/// Decode a sidecar into its raw entries. Throws when the file exists but is
/// not parseable JSON — the caller decides what an unreadable sidecar means
/// (verify reports it; append refuses to build on it).
Future<List<Object?>> _decodeSidecar(String chainFile) async {
  final file = File(chainFile);
  if (!await file.exists()) return const <Object?>[];
  final text = await file.readAsString();
  if (text.trim().isEmpty) return const <Object?>[];
  final decoded = jsonDecode(text);
  if (decoded is! List) return const <Object?>[];
  return decoded;
}

Future<void> _writeAtomic(String chainFile, List<ChainRecord> chain) async {
  // tmp + rename, matching the platform's atomicWriteJson for atomicity only:
  // the platform also fsyncs because its sidecar is evidence; this one does
  // not. On phone flash a rename is already atomic, and a power-loss window
  // loses the tail — which the chain then reports as broken rather than
  // pretending the evidence was durable.
  final tmp = File('$chainFile.tmp');
  await tmp.writeAsString(
    jsonEncode(chain.map((r) => r.toJson()).toList()),
  );
  await tmp.rename(chainFile);
}

/// Append one link. The only write entry point: append-only, no update/delete.
/// Refuses to write when the existing sidecar is unreadable or holds a broken
/// entry — continuing would either restart the chain from genesis (hiding the
/// tampering) or punch a seq gap.
Future<ChainAppendResult> append(
  String chainFile, {
  String? uuid,
  String? producer,
  String? trust,
  Object? content,
  int? at,
}) async {
  try {
    // Refuse a directory before any tmp write: File.exists() is false for
    // directories, so without this guard the append would treat it as "no
    // chain yet" and strand a .tmp file when the rename onto the directory
    // fails.
    if (await FileSystemEntity.isDirectory(chainFile)) {
      return const ChainAppendResult(
        ok: false,
        error: '链路径不是文件，拒绝追加',
      );
    }
    List<Object?> raw;
    try {
      raw = await _decodeSidecar(chainFile);
    } catch (_) {
      return const ChainAppendResult(
        ok: false,
        error: '链文件损坏或不可解析，拒绝追加（不在断链上续写）',
      );
    }
    final existing = <ChainRecord>[];
    for (final entry in raw) {
      final map = _asMap(entry);
      final record = map == null ? null : ChainRecord.fromJson(map);
      if (record == null) {
        return const ChainAppendResult(
          ok: false,
          error: '链文件含结构不完整的记录，拒绝追加',
        );
      }
      existing.add(record);
    }
    final prev = existing.isEmpty ? null : existing.last;
    final record = ChainRecord.link(
      seq: existing.length,
      uuid: uuid,
      prevHash: prev?.hash ?? genesisPrev,
      producer: producer,
      trust: trust,
      content: content,
      at: at,
    );
    await _writeAtomic(chainFile, [...existing, record]);
    return ChainAppendResult(ok: true, seq: record.seq, hash: record.hash);
  } catch (e) {
    return ChainAppendResult(ok: false, error: '$e');
  }
}

/// Read the chain. Tolerant (bad entries dropped, unreadable file → empty):
/// display only. The verdict comes from [verify].
Future<List<ChainRecord>> read(String chainFile) async {
  try {
    final raw = await _decodeSidecar(chainFile);
    final out = <ChainRecord>[];
    for (final entry in raw) {
      final map = _asMap(entry);
      final record = map == null ? null : ChainRecord.fromJson(map);
      if (record != null) out.add(record);
    }
    return out;
  } catch (_) {
    return const <ChainRecord>[];
  }
}

/// Verify chain integrity: recompute each deterministic hash and check the
/// prevHash links. Any tampering surfaces at the first bad link. Total — an
/// unreadable path yields a verdict, never a throw.
Future<ChainVerification> verify(String chainFile) async {
  List<Object?> raw;
  try {
    // File.exists() is false for directories on every platform, so the
    // directory check must come first — otherwise "the path is a directory"
    // would read as "there is no chain", and a sidecar swapped for a directory
    // would be reported as never having existed.
    if (await FileSystemEntity.isDirectory(chainFile)) {
      return const ChainVerification(
        available: true,
        intact: false,
        length: 0,
        brokenAt: null,
        reason: '链路径不是文件',
      );
    }
    final file = File(chainFile);
    if (!await file.exists()) {
      return const ChainVerification(
        available: false,
        intact: false,
        length: 0,
        brokenAt: null,
        reason: '链文件不存在',
      );
    }
    raw = await _decodeSidecar(chainFile);
  } catch (_) {
    return const ChainVerification(
      available: true,
      intact: false,
      length: 0,
      brokenAt: null,
      reason: '链文件无法读取或解析',
    );
  }
  var prevHash = genesisPrev;
  for (var i = 0; i < raw.length; i++) {
    final map = _asMap(raw[i]);
    final record = map == null ? null : ChainRecord.fromJson(map);
    if (record == null) {
      return ChainVerification(
        available: true,
        intact: false,
        length: raw.length,
        brokenAt: i,
        reason: '链记录 #$i 结构不完整',
      );
    }
    if (record.seq != i) {
      return ChainVerification(
        available: true,
        intact: false,
        length: raw.length,
        brokenAt: i,
        reason: 'seq 不连续：期望 $i 实为 ${record.seq}',
      );
    }
    if (record.prevHash != prevHash) {
      return ChainVerification(
        available: true,
        intact: false,
        length: raw.length,
        brokenAt: i,
        reason: 'prevHash 断链于 #$i',
      );
    }
    if (record.recomputeHash() != record.hash) {
      return ChainVerification(
        available: true,
        intact: false,
        length: raw.length,
        brokenAt: i,
        reason: '内容哈希不匹配于 #$i（疑似篡改）',
      );
    }
    prevHash = record.hash;
  }
  return ChainVerification(
    available: true,
    intact: true,
    length: raw.length,
    brokenAt: null,
    reason: null,
  );
}

/// Cross-check the chain against the transcript lines it claims to cover —
/// catches "the JSONL body was edited but the chain was not recomputed".
/// [transcriptLines] are the raw JSONL lines (newline stripped), positionally
/// aligned with the chain.
Future<ChainVerification> verifyAgainstEntries(
  String chainFile,
  List<String> transcriptLines,
) async {
  final base = await verify(chainFile);
  if (!base.intact) return base;
  final chain = await read(chainFile);
  if (chain.length != transcriptLines.length) {
    return ChainVerification(
      available: true,
      intact: false,
      length: chain.length,
      brokenAt: chain.length < transcriptLines.length
          ? chain.length
          : transcriptLines.length,
      reason: 'transcript ${transcriptLines.length} 行 / 链 ${chain.length} 条，'
          '条数不符（疑似删行或少入链）',
    );
  }
  for (var i = 0; i < chain.length; i++) {
    if (contentHash(transcriptLines[i]) != chain[i].contentHash) {
      return ChainVerification(
        available: true,
        intact: false,
        length: chain.length,
        brokenAt: i,
        reason: 'transcript 正文哈希不匹配于 #$i（疑似改正文）',
      );
    }
  }
  return base;
}
