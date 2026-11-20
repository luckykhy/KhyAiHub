import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../core/config/endpoint_defaults.dart';
import '../../core/mirror/amoo_mirror_account_store.dart';
import '../../core/mirror/amoo_mirror_api.dart';
import '../../core/mirror/amoo_mirror_errors.dart';
import '../../core/mirror/amoo_mirror_sync.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// 探测派生的一行就绪态。
///
/// 与 `AmooMirrorSync` 的 status→readiness 映射是两套来源：这里每一次探测都是
/// 真发一次请求，同步器那个是长驻状态机。UI 上不要混用——设置页显示的是这个，
/// 列表页横幅显示的是那个。
enum AmooMirrorReadiness {
  unconfigured,
  unreachable,
  needsPairing,
  ready,
  testing,
}

/// 对话记录镜像的配置块：Base URL + device_token + 探测 + 保存。
///
/// 保存必须走 [widget.accounts]（缺省才是自建实例）——screens 测试靠注入观测
/// 保存动作，而「探测用屏幕未保存值」与「保存走另一份 store」本来就是矛盾的。
class AmooMirrorConfigSection extends StatefulWidget {
  const AmooMirrorConfigSection({
    super.key,
    this.accounts,
    this.client,
    this.sync,
  });

  /// 缺省自建；测试注入假件。
  final AmooMirrorAccountStore? accounts;

  /// 仅供测试注入（探测时替换 HTTP client）。
  final http.Client? client;

  /// 由设置页传入，只作 `acknowledgePairing()` 的目标——本块不读它的状态。
  final AmooMirrorSync? sync;

  @override
  State<AmooMirrorConfigSection> createState() =>
      _AmooMirrorConfigSectionState();
}

class _AmooMirrorConfigSectionState extends State<AmooMirrorConfigSection> {
  /// 加载与保存共用同一个 store：新建一个绕过注入的实例，保存就观测不到。
  late final AmooMirrorAccountStore _accounts =
      widget.accounts ?? AmooMirrorAccountStore();

  final _baseUrl = TextEditingController();
  final _token = TextEditingController();

  AmooMirrorReadiness _readiness = AmooMirrorReadiness.unconfigured;
  String _detail = '';
  bool _saving = false;
  bool _testing = false;
  bool _tokenVisible = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _baseUrl.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final account = await _accounts.load();
    if (!mounted) return;
    setState(() {
      _baseUrl.text = account?.baseUrl ?? '';
      _token.text = account?.deviceToken ?? '';
      _detail = '';
      _readiness = _readinessOf(_baseUrl.text, _token.text);
    });
  }

  /// 只按「有没有填」判，不探测：进设置页不该为一行状态发一次网络请求。
  static AmooMirrorReadiness _readinessOf(String baseUrl, String token) {
    if (baseUrl.trim().isEmpty) return AmooMirrorReadiness.unconfigured;
    if (token.trim().isEmpty) return AmooMirrorReadiness.needsPairing;
    return AmooMirrorReadiness.ready;
  }

  void _prefillMock() {
    setState(() {
      _baseUrl.text = kAmooMirrorMockBaseUrl;
    });
  }

  /// 探测用的是屏幕上还没保存的值（vision_config_section.dart:226-231 的教训：
  /// 读存量会测上一份配置，按钮便失去了意义）。
  Future<void> _test() async {
    final baseUrl = _baseUrl.text.trim();
    final token = _token.text.trim();
    if (baseUrl.isEmpty) {
      setState(() {
        _readiness = AmooMirrorReadiness.unconfigured;
        _detail = '先填 Base URL';
      });
      return;
    }
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      setState(() {
        _readiness = AmooMirrorReadiness.unreachable;
        _detail = 'URL 无效：需以 http:// 或 https:// 开头';
      });
      return;
    }

    setState(() {
      _readiness = AmooMirrorReadiness.testing;
      _detail = '正在连接 $baseUrl';
      _testing = true;
    });

    final api = AmooMirrorApi(
      client: widget.client,
      baseUrl: baseUrl,
      tokenProvider: () async => token,
      // 探测短超时：10s 默认值会让这个按钮看起来像卡死。
      requestTimeout: const Duration(seconds: 5),
    );
    try {
      final page = await api.fetchSessions();
      if (!mounted) return;
      setState(() {
        _readiness = AmooMirrorReadiness.ready;
        _detail = '连接成功：拿到 ${page.sessions.length} 个会话';
        _testing = false;
      });
    } on AmooMirrorApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _readiness = switch (e.kind) {
          AmooMirrorErrorKind.unauthorized =>
            AmooMirrorReadiness.needsPairing,
          _ => AmooMirrorReadiness.unreachable,
        };
        // 与列表页横幅、日志共用同一句（amoo_mirror_errors.dart）。
        _detail = describeAmooMirrorError(e);
        _testing = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _readiness = AmooMirrorReadiness.unreachable;
        _detail = '探测出错：$e';
        _testing = false;
      });
    } finally {
      // 注入的 client 不归这里所有，close() 自己会分辨。
      await api.close();
    }
  }

  Future<void> _save() async {
    final baseUrl = _baseUrl.text.trim();
    final token = _token.text.trim();
    if (baseUrl.isEmpty) {
      setState(() {
        _readiness = AmooMirrorReadiness.unconfigured;
        _detail = 'Base URL 不能为空';
      });
      return;
    }
    setState(() => _saving = true);
    try {
      await _accounts.save(AmooMirrorAccount(
        baseUrl: baseUrl,
        deviceToken: token,
        pairedAt: DateTime.now().millisecondsSinceEpoch,
      ));
      // 闭合 401 的恢复路：换了 token 之后同步器要能立刻重新开始，而不是等到
      // 下一轮自己发现 token 变了。
      widget.sync?.acknowledgePairing();
      if (!mounted) return;
      setState(() {
        _readiness = _readinessOf(baseUrl, token);
        _detail = '';
      });
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('对话记录配置已保存'),
        duration: Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
      ));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _readiness = AmooMirrorReadiness.unreachable;
        _detail = '保存失败：$e';
      });
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return Material(
      color: palette.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        side: BorderSide(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.dense),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.forum_outlined, size: 18, color: palette.primary),
                const SizedBox(width: AppSpacing.inner),
                Text(
                  '对话记录',
                  style: AppText.cardTitle.copyWith(color: palette.textPrimary),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.inner),
            _statusLine(palette),
            const SizedBox(height: AppSpacing.inner),
            _field('Base URL', _baseUrl, palette,
                hint: kAmooMirrorMockBaseUrl),
            const SizedBox(height: AppSpacing.inner),
            _tokenField(palette),
            const SizedBox(height: AppSpacing.inner),
            _buttons(palette),
            if (_detail.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.inner),
              Text(
                _detail,
                style: AppText.micro.copyWith(color: palette.textSecondary),
              ),
            ],
            const SizedBox(height: AppSpacing.inner),
            Text(
              '只读镜像：这里配置的端点只用于拉取 Amoo 的历史会话，'
              '不会把任何内容写进 Amoo，也不会把 Amoo 拉到前台。',
              style: AppText.micro.copyWith(color: palette.textFaint),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statusLine(AppPalette palette) {
    final (Color color, String text) = switch (_readiness) {
      AmooMirrorReadiness.unconfigured => (
          palette.textFaint,
          '未配置：对话记录列表打不开'
        ),
      AmooMirrorReadiness.unreachable => (
          palette.error,
          '配了但连不上：同步会失败，列表只剩缓存'
        ),
      AmooMirrorReadiness.needsPairing => (
          palette.warning,
          '未配对：缺 device_token，服务端会回 401'
        ),
      AmooMirrorReadiness.ready => (
          palette.success,
          '就绪 · 端点与令牌已配置'
        ),
      AmooMirrorReadiness.testing => (palette.textSecondary, '测试中…'),
    };
    return Row(
      children: <Widget>[
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: AppSpacing.inner),
        Expanded(
          child: Text(
            text,
            style: AppText.secondary.copyWith(color: color),
          ),
        ),
      ],
    );
  }

  Widget _field(
    String label,
    TextEditingController controller,
    AppPalette palette, {
    required String hint,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label,
          style: AppText.secondary.copyWith(color: palette.textSecondary),
        ),
        const SizedBox(height: AppSpacing.micro),
        TextField(
          controller: controller,
          style: AppText.body.copyWith(color: palette.textPrimary),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: AppText.micro.copyWith(color: palette.textFaint),
            isDense: true,
          ),
        ),
      ],
    );
  }

  Widget _tokenField(AppPalette palette) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            Text(
              'device_token',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
            const SizedBox(width: AppSpacing.inner),
            Text(
              '（只存本机安全存储）',
              style: AppText.micro.copyWith(color: palette.textFaint),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.micro),
        TextField(
          controller: _token,
          obscureText: !_tokenVisible,
          style: AppText.body.copyWith(color: palette.textPrimary),
          decoration: InputDecoration(
            isDense: true,
            suffixIcon: IconButton(
              icon: Icon(
                _tokenVisible ? Icons.visibility_off : Icons.visibility,
                size: 16,
              ),
              onPressed: () => setState(() => _tokenVisible = !_tokenVisible),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buttons(AppPalette palette) {
    return Row(
      children: <Widget>[
        _capsule(palette, '填入内置 mock', _prefillMock),
        const SizedBox(width: AppSpacing.inner),
        _capsule(palette, '测试连接', _test, busy: _testing),
        const SizedBox(width: AppSpacing.inner),
        _capsule(palette, '保存', _save, busy: _saving),
      ],
    );
  }

  Widget _capsule(
    AppPalette palette,
    String label,
    VoidCallback onTap, {
    bool busy = false,
  }) {
    return InkWell(
      onTap: busy ? null : onTap,
      borderRadius: BorderRadius.circular(AppRadius.small),
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.inner,
          vertical: 6,
        ),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppRadius.small),
          border: Border.all(
            color: palette.strokeStrong,
            width: AppStroke.thin,
          ),
        ),
        child: Text(
          busy ? '…' : label,
          style: AppText.label.copyWith(color: palette.primary),
        ),
      ),
    );
  }
}
