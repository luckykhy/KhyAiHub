// WeChat (personal account) channel: long-poll inbound, HTTP outbound.
// Ported from channels/ilinkChannel.js — semantic parity is the contract.
//
// Fundamental difference vs webhook channels: this one actively long-polls
// (getupdates holds ~35s), so connect() starts a self-driving loop and
// disconnect() must tear it down cleanly or the app cannot go idle.
//
// Dispatch is FIRE-AND-FORGET, never awaited inside the loop. Not a perf
// trick but a correctness requirement: one agent query can run for minutes,
// and the user's `y`/`n` approval reply must still be pulled down during it —
// awaiting dispatch here would stall the poll and starve approvals
// (ilinkChannel.js:10-13).
//
// Contract: protocol errors are NOT swallowed — exceptions from IlinkApi are
// counted in the loop and drive backoff; connect/disconnect and message
// dispatch are fail-soft.

import 'dart:async';

import 'ilink_api.dart';
import 'ilink_message_codec.dart';
import 'ilink_protocol.dart';
import 'ilink_send_policy.dart';
import 'ilink_stores.dart';

class IlinkSendReport {
  const IlinkSendReport.ok(this.sent)
      : ok = true,
        error = null;
  const IlinkSendReport.fail(this.sent, this.error)
      : ok = false;

  final bool ok;

  /// Chunks actually sent. A mid-split failure reports the truth instead of
  /// pretending the whole reply went out (ilinkChannel.js:252-254).
  final int sent;
  final String? error;
}

class IlinkChannel {
  IlinkChannel({
    required this.accountId,
    required this.api,
    required IlinkCursorStore cursorStore,
    required IlinkContextTokenStore contextTokenStore,
    this.debugLog,
    this.backoffShortMs = kIlinkBackoffShortMs,
    this.backoffLongMs = kIlinkBackoffLongMs,
    this.backoffThreshold = kIlinkBackoffThreshold,
    this.sessionExpiredPauseMs = kIlinkSessionExpiredPauseMs,
    this.sendRetryBaseMs = kIlinkSendRetryBaseMs,
  })  : _cursors = cursorStore,
        _contextTokens = contextTokenStore;

  final String accountId;
  final IlinkApi api;
  final IlinkCursorStore _cursors;
  final IlinkContextTokenStore _contextTokens;

  /// Timing knobs default to the protocol constants; tests inject tiny values
  /// instead of sleeping through real backoffs.
  final int backoffShortMs;
  final int backoffLongMs;
  final int backoffThreshold;
  final int sessionExpiredPauseMs;
  final int sendRetryBaseMs;

  /// Set from the gate: allowlist-judged inbound text for the agent layer.
  void Function(IlinkInboundMessage message)? onMessage;

  /// Only surfaced for backoff chatter (warn-grade lines); null = silent.
  void Function(String line)? debugLog;

  final IlinkDedupe _dedupe = IlinkDedupe();
  int _seq = 0;
  int _failures = 0;
  bool _connected = false;
  bool _abort = false;

  /// Set after ret=-14 until a healthy poll round proves the session alive —
  /// status must tell the truth instead of pretending all is well.
  bool sessionExpired = false;

  Completer<void>? _sleepWaker;

  bool get connected => _connected;

  /// Start the poll loop. Returns immediately; the first round is not awaited
  /// (connect must not hang 35s on the first long-poll).
  Future<void> connect() async {
    if (_connected) return;
    _abort = false;
    _connected = true;
    sessionExpired = false;
    // The loop swallows its own exceptions; not awaited on purpose.
    unawaited(_pollLoop());
  }

  /// Abort the loop and wait for it to actually exit, so no fetch is left in
  /// flight keeping the process busy after shutdown.
  Future<void> disconnect() async {
    _abort = true;
    _wakeSleep();
    _connected = false;
  }

  void _wakeSleep() {
    final waker = _sleepWaker;
    if (waker != null && !waker.isCompleted) {
      waker.complete();
    }
  }

  /// Abortable sleep: disconnect() wakes it immediately (same role as the
  /// AbortSignal listener in ilinkChannel.js:89-106).
  Future<void> _sleep(Duration d) async {
    final waker = Completer<void>();
    _sleepWaker = waker;
    await Future.any<void>(<Future<void>>[
      waker.future,
      Future<void>.delayed(d),
    ]);
    _sleepWaker = null;
  }

  /// Long-poll main loop. Each round: getupdates → persist cursor → dispatch
  /// new messages. Failures back off via decideBackoffMs; ret=-14 pauses long
  /// (re-scan needed, fast retries are pointless) (ilinkChannel.js:113-188).
  Future<void> _pollLoop() async {
    while (!_abort) {
      try {
        final buf = await _cursors.get(accountId);
        final resp = await api.getUpdates(buf);
        if (_abort) break;

        if (isSessionExpired(resp)) {
          sessionExpired = true;
          debugLog?.call(
              'ilink: 会话已过期(ret=$kIlinkRetSessionExpired),需重新扫码。暂停轮询。');
          await _sleep(Duration(milliseconds: sessionExpiredPauseMs));
          continue;
        }

        _failures = 0;
        sessionExpired = false;

        // Persist the cursor BEFORE dispatching: dispatch is fire-and-forget,
        // and a crash between dispatch and cursor-save would re-pull the same
        // messages. Losing the cursor write only risks one duplicated round —
        // the dedupe catches that — so it must not break polling.
        final newBuf = resp['get_updates_buf'];
        if (newBuf is String && newBuf.isNotEmpty) {
          await _cursors.set(accountId, newBuf);
        }

        final msgs = resp['msgs'];
        if (msgs is! List) continue;
        for (final raw in msgs) {
          final parsed = parseInboundMessage(raw);
          if (parsed == null) continue; // BOT echo / missing fields → drop
          if (!_dedupe.accept(parsed.messageId)) continue;
          // Record the inbound context_token: proactive sends later need it
          // as fallback (see _resolveContextToken). Fail-soft write.
          if (parsed.threadId.isNotEmpty) {
            _contextTokens.set(accountId, parsed.userId, parsed.threadId);
          }
          // ⚠ never await: dispatch must not stall the next poll round.
          _dispatch(parsed);
        }
      } catch (err) {
        if (_abort) break;
        _failures += 1;
        final wait = decideBackoffMs(
          _failures,
          shortMs: backoffShortMs,
          longMs: backoffLongMs,
          threshold: backoffThreshold,
        );
        final line =
            'ilink 轮询失败(连续 $_failures 次),${wait}ms 后重试:$err';
        debugLog?.call(line);
        await _sleep(Duration(milliseconds: wait));
      }
    }
  }

  void _dispatch(IlinkInboundMessage parsed) {
    try {
      onMessage?.call(parsed);
    } catch (_) {
      // A handler crash must not kill the poll loop.
    }
  }

  /// Send one chunk with retry on transient failures. Zero retries would drop
  /// a whole reply on one network hiccup — and WeChat cannot tell "no reply"
  /// from "failed reply", so transient errors back off and retry while
  /// permanent errors (4xx payload/auth) abort immediately
  /// (ilinkChannel.js:201-225).
  Future<void> _sendChunkWithRetry(Map<String, dynamic> payload) async {
    final maxRetries = kIlinkSendMaxRetries;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      if (_abort) {
        throw IlinkApiException.transport('已取消');
      }
      try {
        await api.sendMessage(payload);
        return;
      } catch (err) {
        if (attempt >= maxRetries || !isRetryableSendError(err)) {
          rethrow;
        }
        final wait = sendBackoffMs(attempt + 1, baseMs: sendRetryBaseMs);
        debugLog?.call('ilink 出站失败($err),${wait}ms 后重试');
        await _sleep(Duration(milliseconds: wait));
      }
    }
  }

  /// Send a text reply, auto-split at the length cap, chunks in order.
  ///
  /// [threadId] carries the inbound context_token; when absent the most
  /// recent persisted token for this peer is used — proactive pushes (no
  /// inbound round to echo) only attach to the conversation via that fallback
  /// (ilinkChannel.js:264-278).
  Future<IlinkSendReport> sendMessage(String channelId, String? text,
      {String? threadId}) async {
    final chunks = splitMessage(text, kIlinkMaxMessageLength);
    if (chunks.isEmpty) {
      return const IlinkSendReport.ok(0);
    }
    var sent = 0;
    for (final chunk in chunks) {
      _seq += 1;
      final payload = buildOutboundMessage(
        toUserId: channelId,
        clientId: buildClientId(_seq, DateTime.now().millisecondsSinceEpoch),
        contextToken: await _resolveContextToken(channelId, threadId),
        items: buildTextItems(chunk),
      );
      try {
        await _sendChunkWithRetry(payload);
        sent += 1;
      } catch (err) {
        // Mid-split failure: report how many chunks DID go out.
        return IlinkSendReport.fail(sent, '$err');
      }
    }
    return IlinkSendReport.ok(sent);
  }

  /// Inbound token first; when absent, fall back to the most recent token
  /// persisted from an inbound message of this peer.
  Future<String> _resolveContextToken(String channelId, String? threadId) async {
    final fromInbound = threadId ?? '';
    if (fromInbound.isNotEmpty) {
      return fromInbound;
    }
    return _contextTokens.get(accountId, channelId);
  }
}
