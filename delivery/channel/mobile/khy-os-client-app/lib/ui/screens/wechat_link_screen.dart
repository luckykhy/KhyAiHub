// WeChat bot login screen: full-screen QR (rendered by the pure-Dart qr
// package — the device has no QR-drawing capability, mobile_scanner only
// scans), a "save to gallery" button so the SAME phone can scan it from the
// WeChat "扫一扫 → 相册" flow without a second device, and a live status line.
//
// Login requires a human with a grey-release WeChat client; a client without
// the capability refuses the scan and the server's own message is shown
// verbatim (see ilink_login.dart).

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:image/image.dart' as img;
import 'package:qr/qr.dart';

import '../../core/ilink/ilink_login.dart';
import '../../core/ilink/ilink_stores.dart';
import '../../core/ilink/ilink_wechat_gate.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

enum _LinkPhase { idle, loading, qrReady, scaned, confirmed, failed }

class WeChatLinkScreen extends StatefulWidget {
  const WeChatLinkScreen({super.key});

  @override
  State<WeChatLinkScreen> createState() => _WeChatLinkScreenState();
}

class _WeChatLinkScreenState extends State<WeChatLinkScreen> {
  final IlinkWeChatGate _gate = IlinkWeChatGate.instance;

  _LinkPhase _phase = _LinkPhase.idle;
  String _statusLine = '';
  Uint8List? _qrPng;
  IlinkGateStatus? _gateStatus;

  /// Flipped by dispose / re-login; the login loop checks it between steps.
  bool _cancelled = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _refreshGateStatus();
    _startLogin();
  }

  @override
  void dispose() {
    _cancelled = true;
    super.dispose();
  }

  void _refreshGateStatus() {
    setState(() => _gateStatus = _gate.status());
  }

  Future<void> _startLogin() async {
    if (_busy) return;
    _busy = true;
    _cancelled = false;
    setState(() {
      _phase = _LinkPhase.loading;
      _statusLine = '正在获取登录二维码…';
      _qrPng = null;
    });

    final client = http.Client();
    final result = await login(
      client,
      accountStore: IlinkAccountStore(),
      sleep: (d) async {
        if (_cancelled) return;
        await Future<void>.delayed(d);
      },
      isCancelled: () => _cancelled,
      onQr: (url, attempt) {
        if (!mounted || _cancelled) return;
        setState(() {
          _phase = _LinkPhase.qrReady;
          _statusLine = attempt > 1 ? '第 $attempt 张二维码,请扫码' : '请用微信扫一扫扫描本码';
          _qrPng = _renderQrPng(url);
        });
      },
      onStatus: (line) {
        if (!mounted || _cancelled) return;
        setState(() {
          if (line.contains('已扫码')) {
            _phase = _LinkPhase.scaned;
          }
          _statusLine = line;
        });
      },
    );
    client.close();

    if (!mounted || _cancelled) return;
    _busy = false;
    setState(() {
      if (result.ok) {
        _phase = _LinkPhase.confirmed;
        _statusLine = '登录成功,凭据已保存';
      } else {
        _phase = _LinkPhase.failed;
        _statusLine = result.error ?? '登录失败';
      }
    });
    _refreshGateStatus();
  }

  /// QR matrix → PNG bytes (quiet zone 4 modules, L error correction — the
  /// on-screen code has no smudge risk, matching the terminal default).
  Uint8List? _renderQrPng(String data) {
    try {
      // qr 4.x: build the payload first, no fromData convenience factory.
      final code = QrCode(
        payload: QrPayload.fromString(data),
        errorCorrectLevel: QrErrorCorrectLevel.low,
      );
      final matrix = QrImage(code);
      final modules = matrix.moduleCount;
      const quiet = 4;
      const modulePx = 8;
      final dim = (modules + quiet * 2) * modulePx;
      final image = img.Image(width: dim, height: dim);
      img.fillRect(
        image,
        x1: 0,
        y1: 0,
        x2: dim - 1,
        y2: dim - 1,
        color: img.ColorRgb8(255, 255, 255),
      );
      for (var row = 0; row < modules; row++) {
        for (var col = 0; col < modules; col++) {
          if (matrix.isDark(row, col)) {
            img.fillRect(
              image,
              x1: (col + quiet) * modulePx,
              y1: (row + quiet) * modulePx,
              x2: (col + quiet) * modulePx + modulePx - 1,
              y2: (row + quiet) * modulePx + modulePx - 1,
              color: img.ColorRgb8(0, 0, 0),
            );
          }
        }
      }
      return img.encodePng(image);
    } catch (_) {
      return null;
    }
  }

  /// Write the PNG into /sdcard/Pictures so WeChat's 扫一扫 → 相册 picks it up
  /// on the SAME phone. The app holds MANAGE_EXTERNAL_STORAGE; no gallery
  /// plugin involved. MediaStore indexing is not triggered without a scanner
  /// broadcast — if the gallery does not show the file immediately, pick it
  /// via the file picker inside WeChat's album page.
  Future<void> _saveToGallery() async {
    final png = _qrPng;
    if (png == null) return;
    try {
      final dir = Directory('/sdcard/Pictures');
      if (!dir.existsSync()) {
        dir.createSync(recursive: true);
      }
      final name =
          'wechat-bot-login-${DateTime.now().millisecondsSinceEpoch}.png';
      final f = File('${dir.path}/$name');
      await f.writeAsBytes(png, flush: true);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已保存到相册:$name(若相册未刷新,请在微信选图时用文件方式选择)')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('保存失败:$e')),
      );
    }
  }

  Future<void> _toggleChannel(bool on) async {
    setState(() => _busy = true);
    try {
      if (on) {
        final r = await _gate.start();
        if (!r.ok && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(r.error ?? '启动失败')),
          );
        }
      } else {
        await _gate.stop();
      }
    } finally {
      _busy = false;
      if (mounted) {
        _refreshGateStatus();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final status = _gateStatus;
    return Scaffold(
      appBar: AppBar(title: const Text('微信机器人绑定')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.page),
          children: [
            Text(
              '扫码登录',
              style: AppText.title.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '二维码等同于这台机器的授权入口,请勿转发给他人。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
            const SizedBox(height: AppSpacing.section),
            Center(child: _buildQrArea(palette)),
            const SizedBox(height: AppSpacing.section),
            // 动作+目标+进度:状态行必须说清卡在哪一步
            Text(
              _statusLine,
              textAlign: TextAlign.center,
              style: AppText.body.copyWith(color: palette.textPrimary),
            ),
            if (_phase == _LinkPhase.qrReady && _qrPng != null) ...[
              const SizedBox(height: AppSpacing.section),
              Center(
                child: FilledButton.icon(
                  onPressed: _saveToGallery,
                  icon: const Icon(Icons.photo_outlined),
                  label: const Text('保存二维码到相册(微信扫一扫→相册选图)'),
                ),
              ),
            ],
            if (_phase == _LinkPhase.failed) ...[
              const SizedBox(height: AppSpacing.section),
              Center(
                child: FilledButton.icon(
                  onPressed: _startLogin,
                  icon: const Icon(Icons.refresh),
                  label: const Text('重新获取二维码'),
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.section * 2),
            Text(
              '通道开关',
              style: AppText.title.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            SwitchListTile(
              value: status?.running ?? false,
              onChanged: _busy ? null : _toggleChannel,
              title: const Text('在本机运行微信机器人'),
              subtitle: Text(
                status == null
                    ? '状态读取中…'
                    : status.running
                        ? '长轮询运行中(账号 ${status.accountId})'
                        : status.hasAccount
                            ? '已登录,未运行'
                            : '尚未扫码登录',
              ),
            ),
            const SizedBox(height: AppSpacing.section),
            Text(
              '注意:同一账号的电脑端守护进程与本机不能同时轮询,切换前先在电脑端停止 khy wx。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildQrArea(AppPalette palette) {
    switch (_phase) {
      case _LinkPhase.qrReady when _qrPng != null:
        return Container(
          padding: const EdgeInsets.all(AppSpacing.cardPad),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(AppRadius.medium),
          ),
          child: Image.memory(
            _qrPng!,
            width: 280,
            height: 280,
            fit: BoxFit.contain,
          ),
        );
      case _LinkPhase.confirmed:
        return const SizedBox(
          height: 280,
          child: Center(
              child: Icon(Icons.check_circle, size: 96, color: Colors.green)),
        );
      case _LinkPhase.failed:
        return SizedBox(
          height: 280,
          child: Center(
            child: Icon(Icons.error_outline, size: 96, color: palette.warning),
          ),
        );
      default:
        return const SizedBox(
          height: 280,
          child: Center(child: CircularProgressIndicator()),
        );
    }
  }
}
