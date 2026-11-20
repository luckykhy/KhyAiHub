import 'dart:convert';

import 'package:http/http.dart' as http;

import 'amoo_mirror_models.dart';

/// Error kinds and the exception type — single definition point
/// (amoo_mirror_errors.dart only holds the mapping and the user-facing text).
enum AmooMirrorErrorKind {
  unauthorized, // 401
  notFound, // 404 session gone
  cursorStale, // 409 cursor invalid
  rateLimited, // 429
  server, // 5xx
  transport, // cannot connect / connection dropped
  timeout, // single request timed out
  badResponse, // 2xx but the JSON does not match the contract
}

class AmooMirrorApiException implements Exception {
  const AmooMirrorApiException({
    required this.kind,
    this.status,
    this.retryAfter,
    this.detail = '',
  });

  final AmooMirrorErrorKind kind;
  final int? status;

  /// Kept verbatim; the backoff policy decodes it (seconds vs HTTP-date is the
  /// key_pool parser's job, not this layer's).
  final String? retryAfter;

  /// Response body snippet, already truncated; logs and details only, never
  /// user-visible text.
  final String detail;

  @override
  String toString() =>
      'AmooMirrorApiException(${kind.name}, status: $status, retryAfter: $retryAfter)';
}

final class AmooMirrorSessionsPage {
  const AmooMirrorSessionsPage(this.sessions, {this.hasMore = false});

  final List<AmooMirrorSession> sessions;

  /// **Client-side inference**: the raw array length reached the page size.
  /// The contract has no session total and no pagination cursor — this is an
  /// honest "there may be more" signal, nothing stronger.
  final bool hasMore;
}

final class AmooMirrorMessagesPage {
  const AmooMirrorMessagesPage({
    required this.items,
    required this.nextCursor,
    required this.hasMore,
  });

  final List<AmooMirrorMessage> items;

  /// Empty/missing → null (caught up; stored as NULL).
  final AmooMirrorCursor? nextCursor;
  final bool hasMore;
}

/// Default per-request timeout. AGENTS.md rule 3 explicitly exempts
/// short-lived network fetch timeouts (its example is a 30s HTTP timeout);
/// the guard's timeoutRegex only matches setTimeout
/// (scripts/ci/check-agent-rules.js:874), so Dart's Future.timeout is not in
/// its pattern and will not false-positive.
const Duration kAmooMirrorDefaultRequestTimeout = Duration(seconds: 10);

/// Thin HTTP client for the Amoo mirror endpoints. Zero business judgement —
/// wire shapes live in amoo_mirror_models.dart, policy lives in the sync layer.
///
/// Read-only by construction: the class exposes GETs only.
class AmooMirrorApi {
  /// [client] is injected for tests (MockClient). **An injected client is not
  /// owned here: close() only closes a self-created one** — same discipline as
  /// lib/core/ilink/ilink_api.dart:59-61 (:87 and :110-112 are the enforcement
  /// points). [requestTimeout] is injectable: ilink_api.dart:72-76/:82-83 make
  /// timeoutMs a per-call parameter for the same reason — otherwise the
  /// Future.timeout unit test would have to really sleep 10 seconds.
  AmooMirrorApi({
    http.Client? client,
    required String baseUrl,
    required Future<String?> Function() tokenProvider,
    Duration requestTimeout = kAmooMirrorDefaultRequestTimeout,
  })  : _client = client,
        _tokenProvider = tokenProvider,
        _requestTimeout = requestTimeout,
        _baseUrl = baseUrl.trim().replaceAll(RegExp(r'/+$'), '');

  final http.Client? _client;

  /// Lazily created when no client was injected; closed by [close] and nowhere
  /// else — per-request close would kill keep-alive for the whole instance.
  http.Client? _ownedClient;
  final Future<String?> Function() _tokenProvider;
  final Duration _requestTimeout;
  final String _baseUrl;

  /// An injected client belongs to its caller and is never closed here.
  bool get _ownsClient => _client == null;

  /// GET /sessions?since=0&limit=50. The response is a **bare array** (wire
  /// table); the client merges by updatedAt DESC. `since` is always 0: the
  /// contract defines neither the boundary nor the time base, so the mirror
  /// always asks for everything and relies on idempotent merging.
  Future<AmooMirrorSessionsPage> fetchSessions() async {
    final uri = Uri.parse('$_baseUrl/sessions').replace(
      queryParameters: <String, String>{
        'since': '0',
        'limit': '$kAmooMirrorSessionsLimit',
      },
    );
    final decoded = await _getJson(uri);
    if (decoded is! List) {
      throw const AmooMirrorApiException(
        kind: AmooMirrorErrorKind.badResponse,
        detail: '/sessions 应答不是 JSON 数组',
      );
    }
    final sessions = <AmooMirrorSession>[];
    for (final raw in decoded) {
      final session = AmooMirrorSession.fromJson(raw);
      if (session != null) sessions.add(session);
    }
    // hasMore is inferred from the RAW length: a page where half the entries
    // were dropped as dirty still means the server had more to give.
    return AmooMirrorSessionsPage(
      sessions,
      hasMore: decoded.length >= kAmooMirrorSessionsLimit,
    );
  }

  /// GET /sessions/{id}/messages?cursor=`<ts>:<id>`&limit=200; a null cursor
  /// omits the parameter. Response {items,nextCursor,hasMore}.
  Future<AmooMirrorMessagesPage> fetchMessages(
    String sessionId, {
    AmooMirrorCursor? cursor,
  }) async {
    final query = <String, String>{'limit': '$kAmooMirrorMessagesLimit'};
    if (cursor != null) query['cursor'] = cursor.toString();
    final uri = Uri.parse(
      '$_baseUrl/sessions/${Uri.encodeComponent(sessionId)}/messages',
    ).replace(queryParameters: query);
    final decoded = await _getJson(uri);
    if (decoded is! Map) {
      throw const AmooMirrorApiException(
        kind: AmooMirrorErrorKind.badResponse,
        detail: '/messages 应答不是 JSON 对象',
      );
    }
    final rawItems = decoded['items'];
    if (rawItems is! List) {
      throw const AmooMirrorApiException(
        kind: AmooMirrorErrorKind.badResponse,
        detail: '/messages 缺 items 或 items 不是数组',
      );
    }
    final hasMore = decoded['hasMore'];
    if (hasMore is! bool) {
      // Strict on purpose: a missing hasMore would silently stop pagination,
      // and "silently stopped" is the failure mode this whole layer exists to
      // avoid. nextCursor is the lenient one because the wire table says
      // empty/missing means caught up.
      throw const AmooMirrorApiException(
        kind: AmooMirrorErrorKind.badResponse,
        detail: '/messages 缺 hasMore 或 hasMore 不是布尔',
      );
    }
    final nextCursorRaw = decoded['nextCursor'];
    final items = <AmooMirrorMessage>[];
    for (final raw in rawItems) {
      final message = AmooMirrorMessage.fromJson(raw, sessionId: sessionId);
      if (message != null) items.add(message);
    }
    return AmooMirrorMessagesPage(
      items: items,
      nextCursor: nextCursorRaw is String
          ? AmooMirrorCursor.parse(nextCursorRaw)
          : null,
      hasMore: hasMore,
    );
  }

  Future<Object?> _getJson(Uri uri) async {
    final token = await _tokenProvider();
    final trimmed = token?.trim() ?? '';
    final headers = <String, String>{'Accept': 'application/json'};
    // No token = no Authorization header; the server's 401 then drives the
    // pairing flow. An empty "Bearer " would be a lie about being paired.
    if (trimmed.isNotEmpty) {
      headers['Authorization'] = 'Bearer $trimmed';
    }
    final client = _client ?? (_ownedClient ??= http.Client());
    try {
      final resp = await client
          .get(uri, headers: headers)
          .timeout(_requestTimeout, onTimeout: () {
            // The client is NOT closed here (unlike ilink_api.dart:85-88): it
            // may be shared with later requests on this instance, and closing
            // it would abort the next in-flight GET. One abandoned request per
            // timeout is the cheaper outcome.
            throw const AmooMirrorApiException(
              kind: AmooMirrorErrorKind.timeout,
              detail: '请求超时',
            );
          });
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        final body = utf8.decode(resp.bodyBytes, allowMalformed: true);
        throw AmooMirrorApiException(
          kind: amooMirrorKindForStatus(resp.statusCode),
          status: resp.statusCode,
          retryAfter: resp.headers['retry-after'],
          detail: _snippet(body),
        );
      }
      return jsonDecode(utf8.decode(resp.bodyBytes, allowMalformed: true));
    } on AmooMirrorApiException {
      rethrow;
    } on FormatException catch (e) {
      // Malformed JSON on a 2xx is a contract violation, not a network fault.
      throw AmooMirrorApiException(
        kind: AmooMirrorErrorKind.badResponse,
        detail: '应答不是合法 JSON: ${_snippet('$e')}',
      );
    } catch (e) {
      // Socket / DNS / http client errors land here: transport errors stay
      // retryable by carrying no status (same contract as ilink_api.dart:104-107).
      throw AmooMirrorApiException(
        kind: AmooMirrorErrorKind.transport,
        detail: _snippet('$e'),
      );
    }
  }

  /// Only closes a self-created client; an injected one is its caller's.
  Future<void> close() async {
    if (_ownsClient) {
      final owned = _ownedClient;
      _ownedClient = null;
      owned?.close();
    }
  }
}

/// Status → kind. 401/404/409/429 are the contract's error codes; 5xx → server;
/// every other 4xx → badResponse (its semantics are not guessed).
AmooMirrorErrorKind amooMirrorKindForStatus(int status) {
  if (status == 401) return AmooMirrorErrorKind.unauthorized;
  if (status == 404) return AmooMirrorErrorKind.notFound;
  if (status == 409) return AmooMirrorErrorKind.cursorStale;
  if (status == 429) return AmooMirrorErrorKind.rateLimited;
  if (status >= 500) return AmooMirrorErrorKind.server;
  return AmooMirrorErrorKind.badResponse;
}

String _snippet(String body) {
  final flat = body.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.length <= 200) return flat;
  return '${flat.substring(0, 200)}…';
}
