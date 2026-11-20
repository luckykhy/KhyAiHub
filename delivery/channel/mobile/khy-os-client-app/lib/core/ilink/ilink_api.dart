// Thin IO layer for the WeChat ilink bot API, ported from ilinkApi.js.
// HTTP only, zero business judgement — wire shapes and policy live in the
// codec / policy / protocol leaves.
//
// Contract deviation from the rest of the app: _post THROWS. The poll loop
// needs exceptions to drive backoff and failure counting; swallowing them here
// would let the channel spin silently through a server outage. Callers must
// catch (ilinkApi.js:13-15).
//
// Auth is a triple, all three required (ilinkApi.js:8-11):
//   Authorization: Bearer <bot_token>
//   AuthorizationType: ilink_bot_token
//   X-WECHAT-UIN: base64 of a random uint32, one per client instance,
//                 stable for the process lifetime

import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'ilink_protocol.dart';
import 'ilink_send_policy.dart';

/// Stable per-instance UIN: 4 random bytes, base64. Generated once per
/// IlinkApi instance, same as crypto.randomBytes(4).toString('base64').
String generateIlinkUin(Random rng) {
  final b = List<int>.generate(4, (_) => rng.nextInt(256));
  return base64Encode(b);
}

class IlinkApi {
  IlinkApi({
    required String botToken,
    String? baseUrl,
    http.Client? client,
    Random? rng,
  })  : token = botToken,
        _httpClient = client,
        _rng = rng ?? Random.secure() {
    // A server-sent baseurl is wire data, never blind-trusted: non-https or
    // off-allowlist falls back to the default (ilinkApi.js:39-43).
    final candidate = (baseUrl ?? '').trim();
    final trusted = candidate.isNotEmpty &&
        isTrustedIlinkBaseUrl(candidate, kIlinkAllowedHosts);
    this.baseUrl =
        (trusted ? candidate : kIlinkBaseUrl).replaceAll(RegExp(r'/+$'), '');
    baseUrlFellBack = candidate.isNotEmpty && !trusted;
    uin = generateIlinkUin(_rng);
  }

  final String token;
  late final String baseUrl;
  late final bool baseUrlFellBack;
  late final String uin;

  final http.Client? _httpClient;
  final Random _rng;

  /// Null = own a fresh client per request; an injected client (tests) is
  /// reused and never closed here — the owner closes it.
  bool get _ownsClient => _httpClient == null;

  Map<String, String> _headers() => <String, String>{
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
        'AuthorizationType': 'ilink_bot_token',
        'X-WECHAT-UIN': uin,
      };

  /// POST one JSON payload. THROWS on transport error, timeout or non-2xx —
  /// see the file header for why this layer must not fail-soft.
  Future<Map<String, dynamic>> _post(
    String apiPath,
    Map<String, dynamic> body,
    int timeoutMs,
  ) async {
    final url = Uri.parse('$baseUrl/$apiPath');
    final client = _httpClient ?? http.Client();
    try {
      final resp = await client
          .post(url, headers: _headers(), body: jsonEncode(body))
          .timeout(
            Duration(milliseconds: timeoutMs),
            onTimeout: () {
              // Closing the client aborts the in-flight socket; without it a
              // 35s long-poll would leak one connection per timeout round.
              if (_ownsClient) client.close();
              throw IlinkApiException.timeout(apiPath, timeoutMs);
            },
          );
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        throw IlinkApiException.http(resp.statusCode, utf8.decode(resp.bodyBytes, allowMalformed: true));
      }
      final decoded = jsonDecode(utf8.decode(resp.bodyBytes));
      if (decoded is Map<String, dynamic>) {
        return decoded;
      }
      if (decoded is Map) {
        return Map<String, dynamic>.from(decoded);
      }
      throw IlinkApiException.transport('应答不是 JSON 对象($apiPath)');
    } on IlinkApiException {
      rethrow;
    } catch (e) {
      // Socket / DNS / malformed-JSON land here: transport errors stay
      // retryable by carrying no status.
      throw IlinkApiException.transport('$e');
    } finally {
      // close() is idempotent; calling it again after the onTimeout close is
      // harmless. An injected client is owned by its caller, never closed.
      if (_ownsClient) {
        client.close();
      }
    }
  }

  /// Long-poll new messages. The server holds until a message arrives or the
  /// near-timeout elapses.
  Future<Map<String, dynamic>> getUpdates(String? buf) {
    return _post(
      'ilink/bot/getupdates',
      buf == null || buf.isEmpty ? <String, dynamic>{} : <String, dynamic>{'get_updates_buf': buf},
      kIlinkGetUpdatesTimeoutMs,
    );
  }

  /// Send one message. [payload] comes from buildOutboundMessage.
  Future<Map<String, dynamic>> sendMessage(Map<String, dynamic> payload) {
    return _post('ilink/bot/sendmessage', payload, kIlinkRequestTimeoutMs);
  }

  /// Fetch the bot config containing typing_ticket (needed for the typing
  /// indicator).
  Future<Map<String, dynamic>> getConfig(String ilinkUserId, String? contextToken) {
    return _post(
      'ilink/bot/getconfig',
      <String, dynamic>{
        'ilink_user_id': ilinkUserId,
        'context_token': contextToken,
      },
      kIlinkGetConfigTimeoutMs,
    );
  }

  /// Start/stop the typing indicator. status: 1 = typing, 2 = cancel.
  Future<Map<String, dynamic>> sendTyping(
    String toUserId,
    String typingTicket,
    int status,
  ) {
    return _post(
      'ilink/bot/sendtyping',
      <String, dynamic>{
        'ilink_user_id': toUserId,
        'typing_ticket': typingTicket,
        'status': status,
      },
      kIlinkSendTypingTimeoutMs,
    );
  }
}
