import 'dart:async';

import 'package:dio/dio.dart';

import '../../data/models/models.dart';
import '../config/endpoint_defaults.dart';
import '../gateway/provider_adapter.dart';

/// Single-request timeout for one arena call.
///
/// RUNTIME-003 exception, same class as the per-adapter Dio timeouts: this
/// bounds ONE network request that is either streaming a reply or dead, it is
/// not a wall-clock kill on a long-running task. There is no idle reset here
/// because there is nothing to reset — a chat completion that produced no byte
/// for this long is a hung socket, and the other contestants keep running.
///
/// This is the OUTER bound. Adapters carry their own Dio timeouts
/// (OpenAI/DeepSeek 60s receive, Anthropic/Ollama 120s), so a slow model on
/// those often dies at the inner bound first; that case is reported as a
/// transport-level timeout (see [arenaErrorMessage]), never as the arena
/// bound it did not reach.
const Duration kArenaRequestTimeout = Duration(seconds: 120);

/// One competitor: an already-configured adapter plus the model to ask.
///
/// The runner never builds adapters itself — construction needs the user's
/// credentials and lives at the call site (screen) or in [arenaAdapterFor].
class ArenaContestant {
  const ArenaContestant({
    required this.adapter,
    required this.model,
    required this.label,
  });

  final ProviderAdapter adapter;
  final String model;

  /// UI name, usually "provider · model".
  final String label;
}

/// One selectable entry of the arena catalog: a provider the user has
/// configured plus one of its models.
class ArenaCandidate {
  const ArenaCandidate({
    required this.provider,
    required this.model,
    required this.baseUrl,
    required this.apiKey,
  });

  final String provider;
  final String model;

  /// Endpoint and credential as configured by the user; never a literal in
  /// this file — the caller resolves them from the app's configuration.
  final String baseUrl;
  final String apiKey;

  /// Stable identity across the picker and the selection list. Model names
  /// repeat across providers, so provider must be part of the key.
  String get key => '$provider::$model';

  String get label => '$provider · $model';

  ArenaContestant toContestant() => ArenaContestant(
        adapter: arenaAdapterFor(
          baseUrl: baseUrl,
          apiKey: apiKey,
          model: model,
          label: label,
        ),
        model: model,
        label: label,
      );
}

/// One competitor's outcome. A failed entry keeps [latencyMs] and [error] and
/// carries empty content — the comparison table must show it as a row that
/// failed, not drop it silently.
class ArenaResult {
  const ArenaResult({
    required this.contestant,
    this.content = '',
    this.latencyMs = 0,
    this.usage,
    this.error,
  });

  final ArenaContestant contestant;
  final String content;
  final int latencyMs;
  final TokenUsage? usage;

  /// null = succeeded. Non-null = human-readable failure reason.
  final String? error;

  bool get ok => error == null;
  bool get failed => !ok;

  int get tokens => usage?.totalTokens ?? 0;
}

/// One arena run: the prompt plus one result per contestant, in the order the
/// contestants were given.
class ArenaRun {
  const ArenaRun({required this.prompt, required this.results});

  final String prompt;
  final List<ArenaResult> results;

  ArenaSummary get summary => buildArenaSummary(results);
}

/// Fans one prompt out to every contestant in parallel and collects the
/// outcomes. Each call is individually guarded, so one model failing cannot
/// take the others down with it; the only way [ArenaRunner.run] itself
/// rejects is a throwing `onSettled` callback, which belongs to the caller.
class ArenaRunner {
  const ArenaRunner({this.timeout = kArenaRequestTimeout});

  final Duration timeout;

  /// [onSettled] fires once per contestant as it finishes, in completion
  /// order — the screen needs it for "n/N 个模型已返回" instead of a spinner
  /// that says nothing about progress.
  Future<ArenaRun> run(
    String prompt,
    List<ArenaContestant> contestants, {
    void Function(int settled, int total)? onSettled,
  }) async {
    var settled = 0;
    final futures = contestants.map((contestant) async {
      final result = await _ask(contestant, prompt);
      settled += 1;
      onSettled?.call(settled, contestants.length);
      return result;
    });
    final results = await Future.wait(futures);
    return ArenaRun(prompt: prompt, results: results);
  }

  Future<ArenaResult> _ask(ArenaContestant contestant, String prompt) async {
    final watch = Stopwatch()..start();
    try {
      final response = await contestant.adapter
          .chat(ChatRequest(
            messages: [
              ChatMessage(
                id: 'arena',
                conversationId: 'arena',
                role: MessageRole.user,
                content: prompt,
                timestamp: DateTime.now(),
              ),
            ],
            model: contestant.model,
          ))
          .timeout(timeout);
      watch.stop();
      return ArenaResult(
        contestant: contestant,
        content: response.content,
        latencyMs: watch.elapsedMilliseconds,
        usage: response.usage,
      );
    } catch (error) {
      watch.stop();
      return ArenaResult(
        contestant: contestant,
        latencyMs: watch.elapsedMilliseconds,
        error: arenaErrorMessage(error, timeout),
      );
    }
  }
}

/// Failure reason in "problem + cause + one-line fix" form (rule 2.2).
///
/// Adapter exceptions arrive as raw DioException/TimeoutException strings that
/// name Dart types, not anything the user can act on.
String arenaErrorMessage(Object error, Duration timeout) {
  if (error is TimeoutException) {
    return '请求超时（${timeout.inSeconds} 秒）：该模型在 ${timeout.inSeconds} 秒内'
        '没有返回完整回复。修复：重试，或换一个更快的模型。';
  }
  if (error is DioException) {
    final status = error.response?.statusCode;
    switch (status) {
      case 401:
        return '认证失败 (401)：该模型的 API key 无效或过期。修复：在设置里更新这个提供商的密钥。';
      case 403:
        return '权限不足 (403)：当前 key 无权访问该模型。修复：更换密钥或换一个有权限的模型。';
      case 404:
        return '模型不存在 (404)：该提供商不提供这个模型名。修复：重新选择模型。';
      case 413:
        return '请求过大 (413)：prompt 超过模型上限。修复：缩短 prompt 后重试。';
      case 429:
        return '限流 (429)：请求过多。修复：稍后重试，或减少同时对比的模型数。';
    }
    if (status != null && status >= 500) {
      return '上游异常 ($status)：模型服务暂不可用。修复：稍后重试。';
    }
    // The adapters enforce their own Dio timeouts, which for OpenAI/DeepSeek
    // (60s receive) fire BEFORE the arena's 120s bound. Calling that a network
    // error would send the user to check their connection for what is actually
    // a slow model — wrong cause, wrong fix (rule 2.2).
    if (error.type == DioExceptionType.connectionTimeout ||
        error.type == DioExceptionType.sendTimeout ||
        error.type == DioExceptionType.receiveTimeout) {
      return '请求超时：传输层在限定时间内没有收到完整回复（早于竞技场的 '
          '${timeout.inSeconds} 秒上限）。修复：重试，或换一个更快的模型。';
    }
    return '网络错误（${error.type.name}）：请求没有到达模型服务。'
        '修复：检查手机网络连接后重试。';
  }
  return '请求失败：$error。修复：检查该模型的密钥与端点后重试。';
}

/// Builds an adapter for an endpoint, reusing the four existing transports.
///
/// Every entry of the built-in provider registry is an OpenAI-compatible
/// `/v1` endpoint, so OpenAI-compatible is the default arm; Anthropic /
/// DeepSeek / Ollama stay reachable through the same abstraction for
/// self-hosted setups. No new transport is written here.
///
/// Host matching is pure comparison (no URL is constructed on those lines) —
/// the endpoints themselves come from the caller's configuration.
ProviderAdapter arenaAdapterFor({
  required String baseUrl,
  required String apiKey,
  required String model,
  String label = '',
}) {
  final id = label.isEmpty ? baseUrl : label;
  final host = Uri.tryParse(baseUrl)?.host.toLowerCase() ?? '';
  if (host.contains('anthropic')) {
    return AnthropicAdapter(id: id, name: id, apiKey: apiKey, model: model);
  }
  if (host.contains('deepseek')) {
    return DeepSeekAdapter(id: id, name: id, apiKey: apiKey, model: model);
  }
  if (baseUrl == kDefaultOllamaBaseUrl) {
    return OllamaAdapter(id: id, name: id, baseUrl: baseUrl, model: model);
  }
  return OpenAIAdapter(
    id: id,
    name: id,
    baseUrl: baseUrl,
    apiKey: apiKey,
    model: model,
  );
}

// ── Summary / metrics ──
//
// Same measurement contract as runtime/node/backend/src/services/arenaManager.js
// generateArenaSummary (latency / chars / code blocks / Jaccard). The score is
// a deterministic heuristic (code blocks / truncation / density) and is
// labelled as such in the UI — evals/index.js `Simulated score` (random) is
// deliberately NOT reproduced.

/// Per-model row of the comparison table.
class ArenaMetrics {
  const ArenaMetrics({
    required this.model,
    required this.latencyMs,
    required this.contentLength,
    required this.wordCount,
    required this.hasCode,
    required this.codeBlockCount,
    required this.tokens,
    required this.heuristicScore,
  });

  final String model;
  final int latencyMs;
  final int contentLength;
  final int wordCount;
  final bool hasCode;

  /// Closed ``` pairs. An odd fence count means a block was left open.
  final int codeBlockCount;

  /// 0 when the provider reported no usage.
  final int tokens;

  /// 0-100 deterministic heuristic, NOT a quality evaluation.
  final int heuristicScore;
}

/// Pairwise Jaccard similarity of two successful answers, 0-100.
class ArenaPairSimilarity {
  const ArenaPairSimilarity({
    required this.modelA,
    required this.modelB,
    required this.similarity,
  });

  final String modelA;
  final String modelB;
  final int similarity;
}

/// Structural shape of one answer (same regexes as arenaManager.js).
class ArenaStructure {
  const ArenaStructure({
    required this.model,
    required this.hasCodeBlocks,
    required this.hasNumberedList,
    required this.hasBulletList,
    required this.hasHeadings,
    required this.paragraphs,
  });

  final String model;
  final bool hasCodeBlocks;
  final bool hasNumberedList;
  final bool hasBulletList;
  final bool hasHeadings;
  final int paragraphs;
}

class ArenaSummary {
  const ArenaSummary({
    required this.totalModels,
    required this.metrics,
    required this.failed,
    required this.fastest,
    required this.similarities,
    required this.structures,
  });

  final int totalModels;
  final List<ArenaMetrics> metrics;

  /// Failed contestants with their reasons; kept so the table can show the
  /// row that failed instead of pretending the arena had fewer models.
  final List<ArenaResult> failed;

  /// Factual fastest successful answer. null when nothing succeeded.
  final ArenaMetrics? fastest;

  final List<ArenaPairSimilarity> similarities;
  final List<ArenaStructure> structures;

  int get successCount => metrics.length;
  int get failedCount => failed.length;
}

ArenaSummary buildArenaSummary(List<ArenaResult> results) {
  final succeeded = results.where((r) => r.ok).toList();
  final failed = results.where((r) => r.failed).toList();

  final metrics = succeeded
      .map((r) => ArenaMetrics(
            model: r.contestant.label,
            latencyMs: r.latencyMs,
            contentLength: r.content.length,
            wordCount: arenaWordCount(r.content),
            hasCode: r.content.contains('```'),
            codeBlockCount: arenaFenceCount(r.content) ~/ 2,
            tokens: r.tokens,
            heuristicScore: arenaHeuristicScore(r.content),
          ))
      .toList();

  final fastest = metrics.isEmpty
      ? null
      : (metrics.toList()..sort((a, b) => a.latencyMs.compareTo(b.latencyMs)))
          .first;

  final similarities = <ArenaPairSimilarity>[];
  for (var i = 0; i < succeeded.length; i++) {
    for (var j = i + 1; j < succeeded.length; j++) {
      similarities.add(ArenaPairSimilarity(
        modelA: succeeded[i].contestant.label,
        modelB: succeeded[j].contestant.label,
        similarity:
            arenaJaccardPercent(succeeded[i].content, succeeded[j].content),
      ));
    }
  }

  final structures = succeeded
      .map((r) => ArenaStructure(
            model: r.contestant.label,
            hasCodeBlocks: r.content.contains('```'),
            hasNumberedList:
                RegExp(r'^\s*\d+[.)]\s', multiLine: true).hasMatch(r.content),
            hasBulletList:
                RegExp(r'^\s*[-*]\s', multiLine: true).hasMatch(r.content),
            hasHeadings:
                RegExp(r'^#+\s', multiLine: true).hasMatch(r.content),
            paragraphs: r.content.split(RegExp(r'\n\n+')).length,
          ))
      .toList();

  return ArenaSummary(
    totalModels: results.length,
    metrics: metrics,
    failed: failed,
    fastest: fastest,
    similarities: similarities,
    structures: structures,
  );
}

int arenaWordCount(String content) =>
    content.split(RegExp(r'\s+')).where((w) => w.isNotEmpty).length;

int arenaFenceCount(String content) => '```'.allMatches(content).length;

/// Jaccard similarity over lowercase word sets, 0-100 (arenaManager.js
/// _jaccardSimilarity). Two empty answers are 0, not 100 — "both said
/// nothing" is not agreement.
int arenaJaccardPercent(String a, String b) {
  final wordsA = _wordSet(a);
  final wordsB = _wordSet(b);
  final union = wordsA.union(wordsB);
  if (union.isEmpty) return 0;
  final intersection = wordsA.intersection(wordsB).length;
  return (intersection / union.length * 100).round();
}

Set<String> _wordSet(String text) => text
    .toLowerCase()
    .split(RegExp(r'\s+'))
    .where((w) => w.isNotEmpty)
    .toSet();

/// Deterministic heuristic score, 0-100, codeEval-style: information density,
/// code-block closure, truncation. It says nothing about whether the answer
/// is correct or good — the UI labels it 「启发式分数」 for that reason.
int arenaHeuristicScore(String content) {
  final text = content.trim();
  if (text.isEmpty) return 0;

  final nonSpace = text.replaceAll(RegExp(r'\s'), '').length;
  final density = nonSpace / text.length;

  final fences = arenaFenceCount(text);
  // An odd fence count is a block left open — the answer was cut mid-code.
  final codeClosed = fences % 2 == 0;

  final endsClean = _endsAtBoundary(text);

  // Bounded by construction: density ≤ 1, so 30 + 30 + 40 is the ceiling.
  final score = density * 30 + (codeClosed ? 30 : 0) + (endsClean ? 40 : 0);
  return score.round();
}

bool _endsAtBoundary(String text) {
  if (text.endsWith('```')) return true;
  const boundaries = '。！？.!?}）]”"\'`';
  return boundaries.contains(text[text.length - 1]);
}
