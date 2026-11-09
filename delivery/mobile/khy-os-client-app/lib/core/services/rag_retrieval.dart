// Ported from runtime/node/backend/src/services/ragRetrievalService.js.
//
// Why pure Dart with zero IO: the retrieval math is the half worth testing on
// any machine and the half that must stay byte-compatible with the desktop /
// TUI channels. The IO half (sqflite knowledge rows, secure-storage
// conversations) lives in knowledge_store.dart so a failing store degrades to
// "no context" without touching the math.
//
// This is keyword hybrid retrieval, NOT vector retrieval — the platform chat
// augmentation link itself never used embeddings/rerank (those serve the
// memory engine and the LLM tool surface), and the phone has neither an
// Ollama nor a gateway endpoint to call.
//
// Deliberately not ported from the platform:
//   * the 90s TTL cache (:412-432): mobile has no invalidation hook after a
//     kb_import, so a stale hit would re-show knowledge the user just
//     deleted. Wrong-but-fast is worse than slow here.
//   * the bm25 term of the session score (:346): it comes from the FTS5 rank
//     of sessionSearchIndex, which has no mobile counterpart. Per the task
//     spec the session source is overlap + recency only; the remaining
//     weights are the platform's own (0.52 / 0.18).
//   * the `level` field of knowledge entries: it comes from the platform's
//     KNOWLEDGE_DB layering, which is not ported; the mobile table has no
//     level column.
import 'dart:math' as math;

import 'package:meta/meta.dart';

/// Platform defaults (ragRetrievalService.js :14-17).
const int defaultKnowledgeTopK = 4;
const int defaultSessionTopK = 3;
const int defaultTotalTopK = 6;
const int defaultMaxContextChars = 2400;

/// Per-snippet cap inside a formatted block (platform :86, :395).
const int ragSnippetMaxLen = 220;

/// Platform :384 header and :403 tail, byte-identical on purpose: this text
/// goes straight into the system prompt, and the tail is what keeps the model
/// honest when retrieved knowledge disagrees with the user's question.
const String ragContextHeader = '以下是检索增强上下文（RAG），仅在与当前问题相关时使用：';
const String ragContextTail = '若上述上下文与当前问题冲突或信息不足，请明确说明不确定性并以当前问题为准。';

// Platform _SYNONYMS (:95-134), ported verbatim: query expansion is a
// semantic contract with the other channels, not a mobile-local choice.
const Map<String, List<String>> _synonyms = <String, List<String>>{
  '量化': <String>['quant', '程序化'],
  'quant': <String>['量化'],
  '止损': <String>['stop_loss', '离场'],
  'stop_loss': <String>['止损'],
  '均线': <String>['ma', '移动平均'],
  'ma': <String>['均线'],
  '回测': <String>['backtest'],
  'backtest': <String>['回测'],
  '仓位': <String>['position', '资金管理'],
  'position': <String>['仓位'],
  '因子': <String>['factor'],
  'factor': <String>['因子'],
  '回撤': <String>['drawdown'],
  'drawdown': <String>['回撤'],
  '波动率': <String>['volatility'],
  'volatility': <String>['波动率'],
  '对冲': <String>['hedge'],
  'hedge': <String>['对冲'],
  '夏普': <String>['sharpe'],
  'sharpe': <String>['夏普'],
  '流动性': <String>['liquidity'],
  'liquidity': <String>['流动性'],
  '高频': <String>['hft'],
  'hft': <String>['高频'],
  'alpha': <String>['超额收益'],
  'beta': <String>['系统性风险'],
  'rsi': <String>['相对强弱'],
  'macd': <String>['异同移动平均'],
  '策略': <String>['strategy'],
  'strategy': <String>['策略'],
  '风险': <String>['risk'],
  'risk': <String>['风险'],
  '模型': <String>['model'],
  '网关': <String>['gateway'],
  '适配器': <String>['adapter'],
  '工具': <String>['tool'],
  '代理': <String>['proxy', 'agent'],
  'proxy': <String>['代理'],
};

final RegExp _tokenPartPattern = RegExp(r'[\u4e00-\u9fff]+|[a-z0-9_]+');
final RegExp _cjkRunPattern = RegExp(r'^[\u4e00-\u9fff]+$');
final RegExp _cjkCharPattern = RegExp(r'[\u4e00-\u9fff]');
final RegExp _whitespaceRunPattern = RegExp(r'\s+');
final RegExp _greetingPattern = RegExp(r'^(hi|hello|hey|yo|你好|您好|在吗|在么|嗨)$');

/// Platform collapseWhitespaceLoose: whitespace runs collapse to one space,
/// trimmed. One function so truncation and the scorer see the same
/// normalization the platform sees.
String normalizeSpace(String text) =>
    text.replaceAll(_whitespaceRunPattern, ' ').trim();

/// Platform _truncate (:86-92). The `max(0, ...)` guard keeps a maxLen below
/// 3 from throwing instead of producing the platform's '...' alone.
String ragTruncate(String text, {int maxLen = ragSnippetMaxLen}) {
  final normalized = normalizeSpace(text);
  if (normalized.length <= maxLen) return normalized;
  return '${normalized.substring(0, math.max(0, maxLen - 3))}...';
}

/// Platform _tokenize (:136-169): CJK runs become 1/2/3-grams, ASCII runs
/// become the word plus a 4-char prefix and ing/tion/ed stems.
List<String> tokenize(String text) {
  final lower = text.toLowerCase();
  final tokens = <String>[];
  for (final match in _tokenPartPattern.allMatches(lower)) {
    final part = match.group(0)!;
    if (_cjkRunPattern.hasMatch(part)) {
      for (var i = 0; i < part.length; i++) {
        tokens.add(part[i]);
        if (i < part.length - 1) tokens.add(part.substring(i, i + 2));
        if (i < part.length - 2) tokens.add(part.substring(i, i + 3));
      }
    } else {
      tokens.add(part);
      if (part.length >= 6) tokens.add(part.substring(0, 4));
      if (part.endsWith('ing') && part.length > 4) {
        tokens.add(part.substring(0, part.length - 3));
      }
      if (part.endsWith('tion') && part.length > 5) {
        tokens.add(part.substring(0, part.length - 4));
      }
      if (part.endsWith('ed') && part.length > 3) {
        tokens.add(part.substring(0, part.length - 2));
      }
    }
  }
  // JS `[...new Set(...)]` keeps first-occurrence order; LinkedHashSet does
  // the same, and synonym expansion iterates in that order.
  return tokens.toSet().toList();
}

/// Platform _expandWithSynonyms (:171-182).
List<String> expandWithSynonyms(List<String> tokens) {
  final expanded = <String>{...tokens};
  for (final token in tokens) {
    final syns = _synonyms[token];
    if (syns == null) continue;
    expanded.addAll(syns.map((s) => s.toLowerCase()));
  }
  return expanded.toList();
}

/// Platform _overlapScore (:184-233): direct hits at full weight, synonym
/// hits at 0.3, fuzzy prefix hits at 0.15, capped at 1.
double overlapScore(
  List<String> queryTokens,
  String text, [
  List<String>? expandedTokens,
]) {
  if (queryTokens.isEmpty) return 0;
  final docTokens = tokenize(text).toSet();
  if (docTokens.isEmpty) return 0;

  var directHit = 0;
  for (final token in queryTokens) {
    if (docTokens.contains(token)) directHit += 1;
  }
  final directScore = directHit / queryTokens.length;

  var synScore = 0.0;
  if (expandedTokens != null &&
      expandedTokens.length > queryTokens.length) {
    var synHit = 0;
    for (final token in expandedTokens) {
      if (!queryTokens.contains(token) && docTokens.contains(token)) {
        synHit += 1;
      }
    }
    final synTotal = expandedTokens.length - queryTokens.length;
    synScore = synTotal > 0 ? (synHit / synTotal) * 0.3 : 0;
  }

  var partialHit = 0.0;
  if (directHit < queryTokens.length) {
    for (final qt in queryTokens) {
      if (qt.length < 2) continue;
      for (final dt in docTokens) {
        if (dt != qt &&
            (dt.startsWith(qt) || qt.startsWith(dt)) &&
            dt.length >= 2) {
          partialHit += 0.5;
          break;
        }
      }
    }
  }
  final partialScore = (partialHit / queryTokens.length) * 0.15;

  return math.min(1.0, directScore + synScore + partialScore);
}

/// Platform _keywordScore (:235-271): whole-keyword containment either way,
/// shared-prefix partial credit at 0.4, denominator capped at 4 keywords.
double keywordScore(String query, List<String> keywords) {
  final q = query.toLowerCase();
  if (q.isEmpty || keywords.isEmpty) return 0;

  var hits = 0;
  var partialHits = 0.0;
  for (final kw in keywords) {
    final k = kw.toLowerCase().trim();
    if (k.isEmpty) continue;
    if (q.contains(k) || k.contains(q)) {
      hits += 1;
      continue;
    }
    final minLen = math.min(q.length, k.length);
    if (minLen < 2) continue;
    var shared = 0;
    for (var i = 0; i < minLen; i++) {
      if (q[i] == k[i]) {
        shared += 1;
      } else {
        break;
      }
    }
    if (shared >= 2) partialHits += shared / math.max(q.length, k.length);
  }
  final base = math.min(4, keywords.length);
  return math.min(1.0, (hits + partialHits * 0.4) / (base == 0 ? 1 : base));
}

/// Platform _isGreetingLike (:53-58).
bool isGreetingLike(String text) =>
    _greetingPattern.hasMatch(text.trim().toLowerCase());

/// Platform _shouldRetrieve (:60-81): the four skip rules.
bool shouldRetrieve(
  String query, {
  bool isFollowUp = false,
  bool enabled = true,
}) {
  if (!enabled) return false;
  if (isFollowUp) return false;
  final text = query.trim();
  if (text.isEmpty) return false;
  if (text.startsWith('/')) return false;
  if (isGreetingLike(text)) return false;
  // A 3-char ASCII query ("abc") carries no retrieval signal, but a 2-char
  // CJK query ("止损") does — the CJK test is what separates them.
  if (text.length < 4 && !_cjkCharPattern.hasMatch(text)) return false;
  return true;
}

/// One knowledge-base entry as retrieval sees it. Deliberately free of DB
/// concerns (no id/ts): the store maps its rows in and out of this.
class KnowledgeItem {
  final String title;
  final String content;
  final List<String> keywords;
  final String category;

  /// 'learned' (what mobile imports produce) or 'builtin'. Drives the source
  /// tag and the platform's 0.04 learned boost.
  final String source;

  const KnowledgeItem({
    this.title = '',
    this.content = '',
    this.keywords = const <String>[],
    this.category = '',
    this.source = 'learned',
  });
}

/// A scored retrieval hit. Sealed with two kinds because they format and
/// dedupe differently, and one base so fusion and formatting switch
/// exhaustively.
sealed class RagCandidate {
  const RagCandidate();

  double get score;

  /// Platform :374 key: kind + title(80) + content(140). Kind-scoped on
  /// purpose — the same sentence as a KB entry and as a past chat message is
  /// two different provenances and must survive fusion as two entries.
  String get dedupeKey;
}

String _head(String text, int max) =>
    text.length <= max ? text : text.substring(0, max);

@immutable
final class KnowledgeCandidate extends RagCandidate {
  final String source;
  final String category;
  final String title;
  final String content;
  final List<String> keywords;

  @override
  final double score;

  const KnowledgeCandidate({
    required this.source,
    required this.category,
    required this.title,
    required this.content,
    this.keywords = const <String>[],
    required this.score,
  });

  @override
  String get dedupeKey =>
      'knowledge|${_head(title, 80)}|${_head(content, 140)}';
}

/// One historical chat message as the session source hands it over.
class SessionRow {
  final String sessionId;
  final String title;
  final String role;
  final String content;

  /// epoch ms
  final int timestamp;

  const SessionRow({
    required this.sessionId,
    this.title = '',
    this.role = '',
    required this.content,
    required this.timestamp,
  });
}

@immutable
final class SessionCandidate extends RagCandidate {
  final String sessionId;
  final String title;
  final String role;
  final String content;
  final int timestamp;

  @override
  final double score;

  const SessionCandidate({
    required this.sessionId,
    this.title = '',
    this.role = '',
    required this.content,
    required this.timestamp,
    required this.score,
  });

  @override
  String get dedupeKey => 'session|${_head(title, 80)}|${_head(content, 140)}';
}

/// Platform _knowledgeCandidates (:273-322) minus the IO: the caller supplies
/// the entries, this scores, filters at 0.06, sorts and truncates.
List<KnowledgeCandidate> scoreKnowledge(
  String query,
  List<KnowledgeItem> items, {
  int limit = defaultKnowledgeTopK,
}) {
  final queryTokens = tokenize(query);
  final expandedTokens = expandWithSynonyms(queryTokens);
  final scored = <KnowledgeCandidate>[];
  for (final item in items) {
    final title = item.title.trim();
    final content = item.content.trim();
    final textForScore = '$title $content ${item.keywords.join(' ')}';
    final overlap = overlapScore(queryTokens, textForScore, expandedTokens);
    final keyword = keywordScore(query, item.keywords);
    // Platform :294 compares the un-lowercased query against the raw title —
    // case-sensitive on purpose, do not "fix" it.
    final titleBoost =
        title.isNotEmpty && (title.contains(query) || query.contains(title))
            ? 0.18
            : 0.0;
    final sourceBoost = item.source.toLowerCase() == 'learned' ? 0.04 : 0.0;
    final docTokens = tokenize(textForScore).toSet();
    var covered = 0;
    for (final token in queryTokens) {
      if (docTokens.contains(token)) covered += 1;
    }
    final coverageBoost = queryTokens.isNotEmpty
        ? (covered / queryTokens.length) * 0.06
        : 0.0;
    scored.add(KnowledgeCandidate(
      source: item.source,
      category: item.category.trim(),
      title: title,
      content: content,
      keywords: item.keywords,
      score:
          overlap * 0.55 + keyword * 0.2 + titleBoost + sourceBoost + coverageBoost,
    ));
  }
  final kept =
      scored.where((c) => c.score > 0.06 && c.content.isNotEmpty).toList();
  return _byScoreDesc(kept).take(math.max(1, limit)).toList();
}

/// Platform _sessionCandidates (:324-368) minus the IO and the bm25 term.
List<SessionCandidate> scoreSessionRows(
  String query,
  List<SessionRow> rows, {
  int limit = defaultSessionTopK,
  DateTime? now,
}) {
  final queryTokens = tokenize(query);
  final expandedTokens = expandWithSynonyms(queryTokens);
  final nowMs = (now ?? DateTime.now()).millisecondsSinceEpoch;
  final scored = <SessionCandidate>[];
  for (final row in rows) {
    final content = row.content.trim();
    final overlap = overlapScore(queryTokens, content, expandedTokens);
    // Platform :347 folds a missing/zero timestamp into "now" (JS `||`), so
    // an old row without a timestamp is not punished with maximum age.
    final stamp = row.timestamp > 0 ? row.timestamp : nowMs;
    final ageDays = math.max(0, nowMs - stamp) / 86400000;
    final recency = math.max(0.0, 1 - ageDays / 45);
    scored.add(SessionCandidate(
      sessionId: row.sessionId,
      title: row.title,
      role: row.role,
      content: content,
      timestamp: row.timestamp,
      score: overlap * 0.52 + recency * 0.18,
    ));
  }
  final kept =
      scored.where((c) => c.score > 0.07 && c.content.isNotEmpty).toList();
  return _byScoreDesc(kept).take(math.max(1, limit)).toList();
}

/// Platform _dedupeCandidates (:370-382).
List<RagCandidate> dedupeCandidates(List<RagCandidate> candidates) {
  final seen = <String>{};
  final out = <RagCandidate>[];
  for (final candidate in candidates) {
    if (seen.add(candidate.dedupeKey)) out.add(candidate);
  }
  return out;
}

/// Platform :480-482: knowledge first, then sessions, deduped, sorted by
/// score, truncated to the total topK.
List<RagCandidate> mergeCandidates(
  List<KnowledgeCandidate> knowledge,
  List<SessionCandidate> sessions, {
  int totalTopK = defaultTotalTopK,
}) {
  final merged =
      dedupeCandidates(<RagCandidate>[...knowledge, ...sessions]);
  return _byScoreDesc(merged).take(math.max(1, totalTopK)).toList();
}

String _knowledgeHeading(int index, KnowledgeCandidate candidate) {
  final sourceTag = candidate.source == 'learned' ? '学习知识' : '内置知识';
  final category = candidate.category.isEmpty ? '通用' : candidate.category;
  final title = candidate.title.isEmpty ? '无标题' : candidate.title;
  return '$index. [$sourceTag|$category] $title';
}

String _sessionHeading(int index, SessionCandidate candidate) {
  final title = candidate.title.isNotEmpty
      ? candidate.title
      : (candidate.sessionId.isNotEmpty
          ? candidate.sessionId
          : 'untitled');
  return '$index. [历史会话|$title]';
}

/// Platform _formatContext (:384-410).
String formatContext(
  List<RagCandidate> candidates, {
  int maxChars = defaultMaxContextChars,
}) {
  final lines = <String>[ragContextHeader];
  for (var i = 0; i < candidates.length; i++) {
    final candidate = candidates[i];
    final index = i + 1;
    final heading = switch (candidate) {
      KnowledgeCandidate k => _knowledgeHeading(index, k),
      SessionCandidate s => _sessionHeading(index, s),
    };
    lines.add(heading);
    lines.add('   ${ragTruncate(candidate.content)}');
  }
  lines.add(ragContextTail);
  final text = lines.join('\n');
  if (text.length <= maxChars) return text;
  return '${_head(text, math.max(0, maxChars - 4))}\n...';
}

enum RagOutcome { skipped, noMatch, matched }

@immutable
class RagResult {
  final bool used;
  final String context;
  final RagOutcome outcome;

  /// How many entries made it into the context block.
  final int selectedCount;

  /// Per-source hit counts (after each source's own topK, before fusion) —
  /// the wiring turns these into the honest status line.
  final int knowledgeHits;
  final int sessionHits;

  final int contextChars;

  const RagResult({
    required this.used,
    required this.context,
    required this.outcome,
    this.selectedCount = 0,
    this.knowledgeHits = 0,
    this.sessionHits = 0,
    this.contextChars = 0,
  });

  const RagResult.skipped()
      : used = false,
        context = '',
        outcome = RagOutcome.skipped,
        selectedCount = 0,
        knowledgeHits = 0,
        sessionHits = 0,
        contextChars = 0;

  const RagResult.noMatch({
    required this.knowledgeHits,
    required this.sessionHits,
  })  : used = false,
        context = '',
        outcome = RagOutcome.noMatch,
        selectedCount = 0,
        contextChars = 0;
}

int _clampInt(int value, int min, int max) =>
    value < min ? min : (value > max ? max : value);

/// Dart's List.sort is not stable; the index tiebreak reproduces the
/// platform's stable sort, where equal scores keep the incoming order
/// (knowledge entries ahead of session rows).
List<T> _byScoreDesc<T extends RagCandidate>(List<T> items) {
  final decorated = <(T, int)>[];
  for (var i = 0; i < items.length; i++) {
    decorated.add((items[i], i));
  }
  decorated.sort((a, b) {
    final byScore = b.$1.score.compareTo(a.$1.score);
    return byScore != 0 ? byScore : a.$2.compareTo(b.$2);
  });
  return decorated.map((e) => e.$1).toList();
}

/// Platform buildRetrievalContext (:442-515) minus cache and IO.
///
/// topK/maxChars are clamped to the platform's own bounds (:458-467) instead
/// of trusted: wiring passes user config through, and a garbage value must
/// not produce an empty or explosive context block.
RagResult buildRetrievalContext(
  String query, {
  List<KnowledgeItem> knowledge = const <KnowledgeItem>[],
  List<SessionRow> sessions = const <SessionRow>[],
  bool isFollowUp = false,
  bool enabled = true,
  int knowledgeTopK = defaultKnowledgeTopK,
  int sessionTopK = defaultSessionTopK,
  int totalTopK = defaultTotalTopK,
  int maxContextChars = defaultMaxContextChars,
  DateTime? now,
}) {
  final cleanQuery = query.trim();
  if (!shouldRetrieve(cleanQuery, isFollowUp: isFollowUp, enabled: enabled)) {
    return const RagResult.skipped();
  }

  final knowledgeCandidates = scoreKnowledge(
    cleanQuery,
    knowledge,
    limit: _clampInt(knowledgeTopK, 1, 12),
  );
  final sessionCandidates = scoreSessionRows(
    cleanQuery,
    sessions,
    limit: _clampInt(sessionTopK, 1, 10),
    now: now,
  );
  final merged = mergeCandidates(
    knowledgeCandidates,
    sessionCandidates,
    totalTopK: _clampInt(totalTopK, 1, 16),
  );

  if (merged.isEmpty) {
    return RagResult.noMatch(
      knowledgeHits: knowledgeCandidates.length,
      sessionHits: sessionCandidates.length,
    );
  }

  final context =
      formatContext(merged, maxChars: _clampInt(maxContextChars, 400, 12000));
  return RagResult(
    used: context.isNotEmpty,
    context: context,
    outcome: RagOutcome.matched,
    selectedCount: merged.length,
    knowledgeHits: knowledgeCandidates.length,
    sessionHits: sessionCandidates.length,
    contextChars: context.length,
  );
}
