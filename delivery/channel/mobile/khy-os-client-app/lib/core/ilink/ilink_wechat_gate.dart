// Facade tying the ilink channel to the app lifecycle.
//
// Mutex invariant: ONE getupdates consumer per bot_token, whole-device. The
// PC daemon (`khy wx`) and this App polling the same token would race the
// server cursor and split messages between them — so within this process the
// gate is a singleton and start() refuses while a channel is alive. Cross-
// device exclusion has no local witness (no shared store); migrating the
// token requires stopping the PC side first, which stays a documented manual
// step, not something the app can detect.
//
// Android keep-alive: the Dart poll loop lives in this process; the
// dataSync foreground service (WeChatBotService) only holds the process
// alive. start()/stop() bring the service up/down over the device
// MethodChannel and fail-soft when the channel is unavailable (tests).

import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'ilink_api.dart';
import 'ilink_channel.dart';
import 'ilink_message_codec.dart';
import 'ilink_peer_allowlist.dart';
import 'ilink_stores.dart';

/// Agent-side handler for allowed inbound text. Kept out of the channel: the
/// channel is transport, admission lives here (WS2 wires the AgentLoop in).
typedef IlinkTextHandler = Future<String?> Function(
    IlinkInboundMessage message);

class IlinkGateStatus {
  const IlinkGateStatus({
    required this.running,
    required this.enabled,
    required this.hasAccount,
    this.sessionExpired = false,
    this.accountId = '',
  });

  final bool running;
  final bool enabled;
  final bool hasAccount;
  final bool sessionExpired;

  /// Masked on purpose — status strings end up in UI and logs.
  final String accountId;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'running': running,
        'enabled': enabled,
        'hasAccount': hasAccount,
        'sessionExpired': sessionExpired,
        'accountId': accountId,
      };
}

class GateStartResult {
  const GateStartResult.ok(this.accountId) : error = null;
  const GateStartResult.fail(this.error) : accountId = '';

  final String? error;
  final String accountId;
  bool get ok => error == null;
}

class IlinkWeChatGate {
  IlinkWeChatGate._();

  static final IlinkWeChatGate instance = IlinkWeChatGate._();

  static const String _deviceChannel =
      'com.khyos.khy_os_client/device';
  static const String _enabledKey = 'ilink_enabled';

  IlinkChannel? _channel;
  IlinkAccount? _account;
  IlinkAccountStore? _accountStore;
  IlinkPeerAllowlist? _allowlist;
  IlinkTextHandler? _handler;

  bool get running => _channel != null;

  IlinkGateStatus status() {
    final enabledVal = _enabledMemo;
    return IlinkGateStatus(
      running: running,
      enabled: enabledVal,
      hasAccount: _account != null,
      sessionExpired: _channel?.sessionExpired ?? false,
      accountId: _account?.accountId ?? '',
    );
  }

  bool _enabledMemo = false;

  /// Wire the agent-side handler before start(); replaceable at runtime.
  set handler(IlinkTextHandler? h) => _handler = h;

  IlinkAccount? get account => _account;
  IlinkPeerAllowlist? get allowlist => _allowlist;

  /// Start the channel: requires credentials (scan first via
  /// wechat_link_screen). Persists the enabled flag so cold starts resume.
  Future<GateStartResult> start({http.Client? client}) async {
    if (running) {
      return const GateStartResult.fail('通道已在运行(同一 bot_token 只允许一个轮询消费者)');
    }
    final store = _accountStore ??= IlinkAccountStore();
    final account = await store.load();
    if (account == null) {
      return const GateStartResult.fail('还没有已确认的扫码凭据,请先扫码登录');
    }

    _enabledMemo = true;
    await _writeEnabled('1');

    final docs = await _docsDir();
    final cursorStore = IlinkCursorStore(ilinkFileStore(docs, 'cursor.json'));
    final ctxStore =
        IlinkContextTokenStore(ilinkFileStore(docs, 'context_tokens.json'));
    _allowlist = IlinkPeerAllowlist(ilinkFileStore(docs, 'peers.json'));

    final api = IlinkApi(
      botToken: account.botToken,
      baseUrl: account.baseUrl,
      client: client,
    );
    final channel = IlinkChannel(
      accountId: account.accountId,
      api: api,
      cursorStore: cursorStore,
      contextTokenStore: ctxStore,
    )..onMessage = _handleInbound;

    _account = account;
    _channel = channel;
    try {
      await channel.connect();
    } catch (e) {
      _channel = null;
      _enabledMemo = false;
      await _writeEnabled('0');
      return GateStartResult.fail('轮询启动失败:$e');
    }
    unawaited(_callService('wechatStart'));
    return GateStartResult.ok(account.accountId);
  }

  /// Stop the channel and the keep-alive service; clears the enabled flag so
  /// a cold start does not resurrect what the user turned off.
  Future<void> stop() async {
    _enabledMemo = false;
    await _writeEnabled('0');
    final channel = _channel;
    _channel = null;
    if (channel != null) {
      try {
        await channel.disconnect();
      } catch (_) {}
    }
    await _callService('wechatStop');
  }

  /// Cold-start hook for main(): resume only when credentials exist AND the
  /// user left the switch on. Any failure stays silent — startup must not be
  /// blocked by an optional channel.
  Future<void> resumeFromDisk() async {
    try {
      final store = _accountStore ??= IlinkAccountStore();
      final account = await store.load();
      if (account == null) return;
      if (await _readEnabled() != '1') return;
      await start();
    } catch (_) {}
  }

  Future<void> _handleInbound(IlinkInboundMessage message) async {
    final channel = _channel;
    if (channel == null) return;

    // Admission before anything else — the QR is forwardable, so an unknown
    // sender gets one honest refusal and nothing else (no agent, no tools).
    final allow = _allowlist;
    if (allow != null && !allow.isAllowed(_account?.userId ?? '', message.userId)) {
      await channel.sendMessage(message.channelId, kIlinkPeerDeniedReply,
          threadId: message.threadId);
      return;
    }

    if (message.unsupported.isNotEmpty) {
      await channel.sendMessage(
          message.channelId, '暂不支持的消息类型:${message.unsupported.join('、')}',
          threadId: message.threadId);
      return;
    }
    if (message.text.isEmpty) {
      await channel.sendMessage(message.channelId, '本条消息没有可读的文本内容。',
          threadId: message.threadId);
      return;
    }

    final h = _handler;
    if (h == null) {
      // Transport-only MVP: the agent layer is not wired yet. Saying nothing
      // would look identical to a dead bot; saying the truth costs one line.
      await channel.sendMessage(
          message.channelId, '通道在线,执行端尚未接线,暂无法处理指令。',
          threadId: message.threadId);
      return;
    }
    try {
      final reply = await h(message);
      if (reply != null && reply.isNotEmpty) {
        await channel.sendMessage(message.channelId, reply,
            threadId: message.threadId);
      }
    } catch (e) {
      await channel.sendMessage(message.channelId, '执行出错:$e',
          threadId: message.threadId);
    }
  }

  Future<String> _docsDir() async {
    final dir = await getApplicationDocumentsDirectory();
    return dir.path;
  }

  static const _secure = FlutterSecureStorage();

  Future<void> _writeEnabled(String v) async {
    try {
      await _secure.write(key: _enabledKey, value: v);
    } catch (_) {}
  }

  Future<String?> _readEnabled() async {
    try {
      return await _secure.read(key: _enabledKey);
    } catch (_) {
      return null;
    }
  }

  /// Bring the foreground service up/down. MissingPluginException (tests, or
  /// native side absent) is expected and swallowed.
  Future<void> _callService(String method) async {
    try {
      const MethodChannel(_deviceChannel).invokeMethod(method);
    } catch (_) {}
  }
}
