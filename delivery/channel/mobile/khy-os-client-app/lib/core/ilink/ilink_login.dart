// QR login flow, ported from ilinkLogin.js.
//
// Two UNAUTHENTICATED GETs (no token exists before login):
//   GET /ilink/bot/get_bot_qrcode?bot_type=3
//       → { ret:0, qrcode:<id>, qrcode_img_content:<url to scan> }
//   GET /ilink/bot/get_qrcode_status?qrcode=<id>
//       → { ret:0, status:'wait'|'scaned'|'confirmed'|'expired', ... }
//   confirmed carries bot_token / ilink_bot_id / ilink_user_id / baseurl.
//
// bot_type=3 rides on a WeChat grey release: a client without the capability
// refuses to scan and there is no local workaround — which is why every
// failure path surfaces the server's own words (retmsg) instead of inventing
// error text (ilinkLogin.js:13-15).
//
// Contract: fail-soft, returns { ok, ... } result objects, never throws.
// Expired QR codes are refreshed automatically up to kIlinkMaxQrRefresh times.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'ilink_protocol.dart';
import 'ilink_stores.dart';

/// Account extracted from a confirmed status response; null when required
/// fields are missing. A server-sent baseurl is kept only when it passes the
/// https + allowlist check, else left empty so IlinkApi falls back to the
/// default endpoint (ilinkLogin.js:107-120).
IlinkAccount? accountFromConfirmed(Map<String, dynamic>? data) {
  if (data == null) return null;
  final token = data['bot_token'];
  final botId = data['ilink_bot_id'];
  final userId = data['ilink_user_id'];
  if (token is! String || token.isEmpty) return null;
  if (botId is! String || botId.isEmpty) return null;
  if (userId is! String || userId.isEmpty) return null;
  final rawBase = data['baseurl'];
  final baseUrl = rawBase is String ? rawBase : '';
  final trusted = baseUrl.isNotEmpty &&
      isTrustedIlinkBaseUrl(baseUrl, kIlinkAllowedHosts);
  return IlinkAccount(
    botToken: token,
    accountId: botId,
    userId: userId,
    baseUrl: trusted ? baseUrl : '',
    firstBoundAt: DateTime.now().toUtc().toIso8601String(),
  );
}

/// One QR fetch. ok:false carries the server's words verbatim.
Future<QrCodeResult> requestQrCode(http.Client client) async {
  try {
    final url = Uri.parse('$kIlinkBaseUrl/ilink/bot/get_bot_qrcode?bot_type=$kIlinkBotType');
    final resp = await client
        .get(url)
        .timeout(Duration(milliseconds: kIlinkRequestTimeoutMs));
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      return QrCodeResult(error: 'HTTP ${resp.statusCode}');
    }
    final data = jsonDecode(utf8.decode(resp.bodyBytes));
    if (data is! Map ||
        data['ret'] != 0 ||
        data['qrcode'] is! String ||
        (data['qrcode'] as String).isEmpty ||
        data['qrcode_img_content'] is! String ||
        (data['qrcode_img_content'] as String).isEmpty) {
      final ret = data is Map ? data['ret'] : '?';
      final retmsg = data is Map ? data['retmsg'] : null;
      return QrCodeResult(
        error: '取二维码失败(ret=$ret)${retmsg is String && retmsg.isNotEmpty ? ':$retmsg' : ''}',
      );
    }
    return QrCodeResult(
      qrcodeId: data['qrcode'] as String,
      qrcodeUrl: data['qrcode_img_content'] as String,
    );
  } catch (e) {
    return QrCodeResult(error: '$e');
  }
}

/// One status poll. A single failed poll (jitter / long-poll timeout) is not
/// fatal — the login loop just keeps polling (ilinkLogin.js:95-104).
Future<QrStatusResult> pollQrStatus(http.Client client, String qrcodeId) async {
  try {
    final url = Uri.parse(
        '$kIlinkBaseUrl/ilink/bot/get_qrcode_status?qrcode=${Uri.encodeQueryComponent(qrcodeId)}');
    final resp = await client
        .get(url)
        .timeout(Duration(milliseconds: kIlinkQrPollTimeoutMs));
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      return QrStatusResult(error: 'HTTP ${resp.statusCode}');
    }
    final data = jsonDecode(utf8.decode(resp.bodyBytes));
    final map = data is Map ? data : <String, dynamic>{};
    return QrStatusResult(
      status: map['status'] is String ? map['status'] as String : '',
      data: Map<String, dynamic>.from(map),
    );
  } catch (e) {
    return QrStatusResult(error: '$e');
  }
}

/// Login progression callbacks: [onQr] hands over the URL to render (the
/// screen draws the PNG), [onStatus] reports scan/expire progression.
typedef OnQr = void Function(String qrcodeUrl, int attempt);
typedef OnStatus = void Function(String line);

class LoginResult {
  const LoginResult.ok(this.account, {required this.isNew})
      : error = null;
  const LoginResult.fail(this.error)
      : account = null,
        isNew = false;

  final IlinkAccount? account;
  final bool isNew;
  final String? error;

  bool get ok => account != null;
}

/// Full flow: fetch QR → caller renders → poll until confirmed → persist.
/// Expired codes refresh automatically, at most [maxRefresh] attempts.
///
/// [client] is injected (tests use MockClient); [sleep] is the interruptible
/// wait between polls. Cancellation: the loop checks [isCancelled] between
/// steps — the same role AbortSignal plays on the Node side.
Future<LoginResult> login(
  http.Client client, {
  required IlinkAccountStore accountStore,
  required Future<void> Function(Duration) sleep,
  required bool Function() isCancelled,
  OnQr? onQr,
  OnStatus? onStatus,
  int maxRefresh = kIlinkMaxQrRefresh,
  int pollIntervalMs = kIlinkQrPollIntervalMs,
}) async {
  for (var attempt = 1; attempt <= maxRefresh; attempt++) {
    if (isCancelled()) {
      return LoginResult.fail('已取消');
    }

    final qr = await requestQrCode(client);
    if (qr.error != null) {
      return LoginResult.fail(qr.error!);
    }
    onQr?.call(qr.qrcodeUrl!, attempt);

    var scanedNotified = false;
    var expired = false;

    while (!expired) {
      if (isCancelled()) {
        return LoginResult.fail('已取消');
      }

      final res = await pollQrStatus(client, qr.qrcodeId!);
      if (res.error == null) {
        final status = res.status;
        final data = res.data;
        if (status == 'confirmed') {
          final account = accountFromConfirmed(data);
          if (account == null) {
            return LoginResult.fail('扫码已确认,但应答缺少必要字段');
          }
          final existing = await accountStore.load();
          try {
            await accountStore.save(account);
          } catch (e) {
            return LoginResult.fail('凭据落盘失败:$e');
          }
          return LoginResult.ok(account, isNew: existing == null);
        }
        if (status == 'expired') {
          expired = true;
          onStatus?.call(attempt < maxRefresh ? '二维码已过期,正在换一张…' : '二维码已过期。');
          break;
        }
        if (status == 'scaned' && !scanedNotified) {
          scanedNotified = true;
          onStatus?.call('已扫码,请在手机上确认。');
        }
        if (status.isNotEmpty && status != 'wait' && status != 'scaned') {
          // Known failure statuses (not grey-released / version too old /
          // forbidden / rejected / cancelled): pass the server's own message
          // through, never invent one (ilinkLogin.js:276-285).
          const known = <String>['not_support', 'version', 'forbid', 'reject', 'cancel'];
          if (known.any(status.contains)) {
            return LoginResult.fail('扫码失败:${res.retmsg ?? status}');
          }
          if (res.retmsg != null) {
            return LoginResult.fail('扫码失败:${res.retmsg}');
          }
        }
      }
      await sleep(Duration(milliseconds: pollIntervalMs));
    }
  }

  return LoginResult.fail('二维码连续过期 $maxRefresh 次,已放弃。请重新进入本页再试。');
}

class QrCodeResult {
  const QrCodeResult({this.qrcodeId, this.qrcodeUrl, this.error});
  final String? qrcodeId;
  final String? qrcodeUrl;
  final String? error;
}

class QrStatusResult {
  const QrStatusResult({this.status = '', this.data = const <String, dynamic>{}, this.error});
  final String status;
  final Map<String, dynamic> data;
  final String? error;

  String? get retmsg {
    final v = data['retmsg'];
    return v is String && v.isNotEmpty ? v : null;
  }
}
