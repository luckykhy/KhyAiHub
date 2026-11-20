import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../ui/theme/app_colors.dart';
import '../../ui/theme/design_tokens.dart';

/// 调试菜单里的「网络抓包」面板（断点五）。
///
/// 为什么这个面板必须存在，而不是只留工具。工具是给 agent 调的，而这个功能
/// 的门是**人**——只有人在调试菜单里解锁过，工具才肯开。没有一个看得见的
/// 面板，就没有「人解锁」这个动作，工具那边永远返回 debug_only。
///
/// 面板只做四件事：解锁状态、开/停、看状态、导出。规则（net_rule_*）不在这里
/// 编辑——那是调试期临时手段，用工具调更快，也不该被误当成常用配置。
class DebugNetCaptureCard extends StatefulWidget {
  const DebugNetCaptureCard({super.key});

  @override
  State<DebugNetCaptureCard> createState() => _DebugNetCaptureCardState();
}

class _DebugNetCaptureCardState extends State<DebugNetCaptureCard> {
  static const _channel = MethodChannel('com.khyos.khy_os_client/device');

  bool _busy = false;
  bool _unlocked = false;
  bool _vpnSupported = false;
  bool _tls = false;
  Map<String, dynamic> _status = <String, dynamic>{};
  String _note = '';
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await _channel.invokeMethod<Map<dynamic, dynamic>>('netDebugState');
      if (!mounted) return;
      setState(() {
        _unlocked = r?['unlocked'] == true;
        _vpnSupported = r?['vpn_supported'] == true;
      });
      if (_unlocked) await _refresh();
    } catch (_) {
      // 通道不在（老构建 / 桌面端）时面板自己不可用，但不该把设置页炸掉。
    }
  }

  Future<void> _refresh() async {
    try {
      final r = await _channel.invokeMethod<Map<dynamic, dynamic>>('netCaptureStatus');
      if (!mounted) return;
      setState(() {
        _status = Map<String, dynamic>.from(r ?? const <String, dynamic>{});
      });
      final active = _status['active'] == true;
      if (active && _poll == null) {
        _poll = Timer.periodic(const Duration(seconds: 3), (_) => _refresh());
      } else if (!active) {
        _poll?.cancel();
        _poll = null;
      }
    } catch (_) {}
  }

  Future<void> _start() async {
    setState(() => _busy = true);
    try {
      final r = await _channel.invokeMethod<Map<dynamic, dynamic>>(
          'netCaptureStart', <String, dynamic>{'tls': _tls});
      final vpn = r?['vpn']?.toString() ?? '';
      if (mounted) {
        setState(() {
          _note = vpn == 'consent_requested'
              // 授权弹窗只能人来点。这里如实说，不假装已经开好了。
              ? '系统会弹「连接请求」：点允许之后才开始抓。'
              : (r?['ok'] == true
                  ? (_tls
                      ? '已开始抓包（self+tls，最长 15 分钟，到点自动停）'
                      : '已开始抓包（最长 15 分钟，到点自动停）')
                  : '开不了：${r?['error'] ?? r?['code']}');
        });
      }
    } catch (e) {
      if (mounted) setState(() => _note = '开不了：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
      await _refresh();
    }
  }

  Future<void> _stop() async {
    setState(() => _busy = true);
    try {
      await _channel.invokeMethod<Map<dynamic, dynamic>>('netCaptureStop');
      if (mounted) setState(() => _note = '已停止，规则已清空');
    } catch (e) {
      if (mounted) setState(() => _note = '停不了：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
      await _refresh();
    }
  }

  Future<void> _export() async {
    try {
      final r = await _channel.invokeMethod<Map<dynamic, dynamic>>('netCaptureExport');
      if (mounted) {
        setState(() => _note = r?['ok'] == true
            ? '已导出 ${r?['records']} 条（已脱敏）→ ${r?['path']}'
            : '导出失败：${r?['error'] ?? r?['code']}');
      }
    } catch (e) {
      if (mounted) setState(() => _note = '导出失败：$e');
    }
  }

  /// 导出调试 CA 证书（只有证书，没有私钥）。装不装由用户在系统设置里决定。
  Future<void> _exportCa() async {
    setState(() => _busy = true);
    try {
      final r = await _channel.invokeMethod<Map<dynamic, dynamic>>('netCaptureExportCa');
      if (mounted) {
        setState(() => _note = r?['ok'] == true
            ? 'CA 证书已导出 → ${r?['path']}'
            : '导出失败：${r?['error'] ?? r?['code']}');
      }
    } catch (e) {
      if (mounted) setState(() => _note = '导出失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    if (!_unlocked) {
      // 没解锁就整块不出现：调试面板不是一个「灰着的入口」，
      // 它压根不该被普通用户看到。
      return const SizedBox.shrink();
    }
    final active = _status['active'] == true;
    final vpn = _status['vpn']?.toString() ?? 'off';
    final tier = _status['capture']?.toString() ?? (active ? 'self' : 'off');
    final records = _status['records'] ?? 0;
    final undecryptable = _status['undecryptable'] ?? 0;
    final rules = _status['rules'] ?? 0;
    final ttlLeft = (_status['expires_in_ms'] as num?)?.toInt() ?? 0;

    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.cardGap),
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.wifi_tethering, size: 18, color: palette.primary),
              const SizedBox(width: AppSpacing.dense),
              Text('网络抓包（调试）', style: AppText.body),
              const Spacer(),
              Text(active ? '抓包中 · $tier' : '未开启',
                  style: AppText.micro.copyWith(
                      color: active ? palette.primary : palette.textFaint)),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          Text(
            !_vpnSupported
                ? '本机 Android 版本不支持代理型 VPN（需要 Android 10+）'
                : active
                    ? '端口 ${_status['port'] ?? 0} · VPN $vpn · 记录 $records · '
                        '解不开 $undecryptable · 规则 $rules · 剩余 ${(ttlLeft / 1000).round()}s'
                    : '默认关闭；开了最长 15 分钟，到点自动停，规则不落盘',
            style: AppText.micro.copyWith(color: palette.textFaint),
          ),
          const SizedBox(height: AppSpacing.dense),
          // TLS 档：显式调试项，默认关。这一档要用户自己装 CA，装了才能解密；
          // 没装的 App 会明确得到「无法解密」，不会被伪装成抓到了。
          // 自己的 Material：ListTile 的水墨画在最近的 Material 祖先上，而这块
          // 卡片本身带着背景色——不包一层，点击反馈会被卡片底色吃掉。
          Material(
            color: Colors.transparent,
            child: SwitchListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              value: _tls,
              title: Text('TLS 解密（self+tls）', style: AppText.micro),
              subtitle: Text(
                _tls
                    ? '已开：用调试 CA 尝试解密 HTTPS。不信任该 CA 的 App 会连接失败并记「无法解密」'
                    : '关：HTTPS 只记目标主机，看不到方法与正文',
                style: AppText.micro.copyWith(color: palette.textFaint),
              ),
              onChanged: (active || _busy)
                  ? null
                  : (v) => setState(() {
                        _tls = v;
                        _note = v
                            ? '开抓后会生成调试 CA；需要在系统设置里「安装证书 → CA 证书」装上它才能解密'
                            : '';
                      }),
            ),
          ),
          if (_note.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.dense),
            Text(_note, style: AppText.micro.copyWith(color: palette.primary)),
          ],
          const SizedBox(height: AppSpacing.dense),
          Wrap(
            spacing: AppSpacing.dense,
            children: [
              FilledButton.tonal(
                onPressed: _busy || active || !_vpnSupported ? null : _start,
                child: const Text('开始抓包'),
              ),
              OutlinedButton(
                onPressed: _busy || !active ? null : _stop,
                child: const Text('停止'),
              ),
              OutlinedButton(
                onPressed: _busy ? null : _export,
                child: const Text('导出'),
              ),
              OutlinedButton(
                onPressed: _busy ? null : _exportCa,
                child: const Text('导出 CA 证书'),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          Text(
            // 这条限制不藏在代码注释里：用户看到「只有部分 App 被抓到」时，
            // 唯一能自己解释这件事的地方就是这里。
            '只覆盖走系统 HTTP 代理的客户端（WebView / OkHttp 等）。'
            '默认档 HTTPS 不做 MITM：只能看到目标主机，记录里标 tls_not_intercepted。'
            '敏感字段在记录时就被打码成 <redacted:长度>，导出的文件同样不含原文。',
            style: AppText.micro.copyWith(color: palette.textFaint),
          ),
        ],
      ),
    );
  }
}
