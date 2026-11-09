// khy-canary: Khy-20261101-110-C54CY3NF
import 'package:flutter/material.dart';
import '../../core/gateway/khyos_api.dart';
import '../../core/gateway/pairing.dart';
import '../widgets/khy_brand_mark.dart';
import 'qr_scan_screen.dart';

class ConnectionScreen extends StatefulWidget {
  final KhyOsApi api;
  final VoidCallback onConnected;

  const ConnectionScreen({
    super.key,
    required this.api,
    required this.onConnected,
  });

  @override
  State<ConnectionScreen> createState() => _ConnectionScreenState();
}

class _ConnectionScreenState extends State<ConnectionScreen> {
  final _addressController = TextEditingController();
  final _pairingController = TextEditingController();
  bool _isConnecting = false;
  String? _error;
  /// 连接进度的可读描述：动作 + 目标 + 进度（RUNTIME-002）。
  String? _progress;

  @override
  void initState() {
    super.initState();
    _restoreLastAddress();
  }

  @override
  void dispose() {
    _addressController.dispose();
    _pairingController.dispose();
    super.dispose();
  }

  /// 装好即连：把上次成功的地址填回输入框，并直接试连。
  /// 用户不必重新查 IP；失败时地址保留在框里，重试按钮立即可用。
  Future<void> _restoreLastAddress() async {
    KhyOsConnection? saved;
    try {
      saved = await widget.api.loadConnection();
    } catch (_) {
      return;
    }
    final address = (saved?.apiBaseUrl ?? '').trim();
    if (!mounted || address.isEmpty) return;
    _addressController.text = address;
    await _autoConnect(address);
  }

  /// 有界自动重连：最多 3 次，间隔递增。任何异常都如实落到 _error，
  /// 不把「试过了」显示成「连上了」。
  Future<void> _autoConnect(String address) async {
    const maxAttempts = 3;
    for (var attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!mounted) return;
      setState(() {
        _isConnecting = true;
        _error = null;
        _progress = '连接 $address（第 $attempt/$maxAttempts 次）…';
      });
      try {
        await widget.api.verifyAndSave(address);
        if (!mounted) return;
        setState(() => _progress = null);
        widget.onConnected();
        return;
      } catch (e) {
        if (attempt >= maxAttempts) {
          if (mounted) {
            setState(() {
              _error = '连接 $address 失败（已试 $maxAttempts 次）：$e\n'
                  '手机与电脑需在同一局域网；可点「Connect」重试，或改用配对码。';
              _progress = null;
            });
          }
          break;
        }
        await Future<void>.delayed(Duration(seconds: attempt * 2));
      }
    }
    if (mounted && _progress != null) {
      setState(() => _progress = null);
    }
    if (mounted) setState(() => _isConnecting = false);
  }

  Future<void> _connect() async {
    final address = _addressController.text.trim();
    if (address.isEmpty) return;

    setState(() {
      _isConnecting = true;
      _error = null;
      _progress = '连接 $address…';
    });

    try {
      await widget.api.verifyAndSave(address);
      if (mounted) {
        setState(() => _progress = null);
        widget.onConnected();
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) {
        setState(() {
          _isConnecting = false;
          _progress = null;
        });
      }
    }
  }

  Future<void> _usePairing() async {
    final payload = _pairingController.text.trim();
    if (payload.isEmpty) return;

    setState(() {
      _isConnecting = true;
      _error = null;
    });

    try {
      // Payload is `{"apiBaseUrl": "..."}` from `khy mobile app`, not a query
      // string — see PairingPayloadParser for the full contract.
      final pairing = PairingPayloadParser.parse(payload);
      await widget.api.verifyAndSave(pairing.apiBaseUrl);
      if (mounted) {
        widget.onConnected();
      }
    } on PairingParseException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _isConnecting = false);
    }
  }

  Future<void> _scanQr() async {
    final result = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const QrScanScreen()),
    );
    if (!mounted || result == null || result.trim().isEmpty) return;
    _pairingController.text = result;
    setState(() => _error = null);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Scaffold(
      backgroundColor: cs.surface,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                // 品牌块：墨黑底 + 琥珀主标（与 Web / 桌面端 / TUI 同一枚主标）。
                const KhyBrandTile(size: 80, radius: 20, markScale: 0.66),
                const SizedBox(height: 24),
                Text(
                  'khy-os',
                  style: theme.textTheme.headlineMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Connect to your khy-os node',
                  style: theme.textTheme.bodyLarge?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 48),
                _buildSection(
                  title: 'Pairing Code',
                  icon: Icons.qr_code_scanner,
                  child: Column(
                    children: [
                      TextField(
                        controller: _pairingController,
                        maxLines: 3,
                        decoration: const InputDecoration(
                          hintText: 'Paste pairing content or scan QR code',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: _isConnecting ? null : _scanQr,
                              icon: const Icon(Icons.qr_code_scanner),
                              label: const Text('Scan QR'),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: FilledButton(
                              onPressed: _isConnecting ? null : _usePairing,
                              child: _isConnecting
                                  ? const SizedBox(
                                      width: 20,
                                      height: 20,
                                      child: CircularProgressIndicator(strokeWidth: 2),
                                    )
                                  : const Text('Use Pairing Code'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),
                _buildSection(
                  title: 'Manual Connection',
                  icon: Icons.dns_outlined,
                  child: Column(
                    children: [
                      TextField(
                        controller: _addressController,
                        decoration: const InputDecoration(
                          hintText: 'https://your-khy-node.example',
                          border: OutlineInputBorder(),
                          prefixIcon: Icon(Icons.link),
                        ),
                      ),
                      const SizedBox(height: 12),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton(
                          onPressed: _isConnecting ? null : _connect,
                          child: const Text('Check and Connect'),
                        ),
                      ),
                    ],
                  ),
                ),
                if (_progress != null) ...[
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(
                          _progress!,
                          style: theme.textTheme.bodySmall
                              ?.copyWith(color: cs.onSurfaceVariant),
                        ),
                      ),
                    ],
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: cs.errorContainer,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.error_outline, color: cs.error),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _error!,
                            style: TextStyle(color: cs.onErrorContainer),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildSection({
    required String title,
    required IconData icon,
    required Widget child,
  }) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.3),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 20, color: cs.primary),
              const SizedBox(width: 8),
              Text(
                title,
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          child,
        ],
      ),
    );
  }
}