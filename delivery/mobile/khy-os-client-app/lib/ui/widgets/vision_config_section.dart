// khy-canary: Khy-20261101-133-Z1VTPCX1
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../core/config/app_config.dart';
import '../../core/config/endpoint_defaults.dart';
import '../../ui/theme/app_colors.dart';
import '../../ui/theme/design_tokens.dart';

/// What the vision endpoint is doing right now.
///
/// WHY THIS IS A TYPE AND NOT A STRING. The four states need different fixes,
/// and a single "未配置 / 不可用" string would send the user to the wrong one:
///   · [unconfigured] — nothing to test, fill in the fields;
///   · [unreachable] — configured but nothing answered, which on this device
///     almost always means Ollama is not running;
///   · [readyLocal] — working, and the screenshots never leave the phone;
///   · [readyRemote] — working, and the screenshots go somewhere else.
///
/// The last two are deliberately the same colour and only differ in a line of
/// text, because the difference is not "one is broken" — it is a trade the user
/// is entitled to make, as long as they know they are making it.
enum VisionReadiness {
  unconfigured,
  unreachable,
  readyLocal,
  readyRemote,
  testing,
}

/// The vision-model configuration block.
///
/// WHY IT IS ITS OWN WIDGET. `settings_screen_new.dart` was already past a
/// thousand lines and the god-file gate is 2500, so anything substantial goes
/// in its own file. But there is a second reason: this block owns its own load
/// and save. The main settings screen saves the chat model's four fields in one
/// `AppConfig.save` call; the vision fields have a different lifecycle — they
/// are changed far less often, and a failed vision test must not roll back the
/// chat config the user just saved.
///
/// WHY A TEST-CONNECTION BUTTON AT ALL. `analyze_screen` has existed for a
/// while and has never once worked on this device, because nothing ever told
/// the user the endpoint was wrong — it just said "未配置视觉模型。请在设置中
/// 填写。" The button is the difference between a feature that appears to work
/// and one that does.
class VisionConfigSection extends StatefulWidget {
  const VisionConfigSection({super.key});

  @override
  State<VisionConfigSection> createState() => _VisionConfigSectionState();
}

class _VisionConfigSectionState extends State<VisionConfigSection> {
  final _baseUrl = TextEditingController();
  final _apiKey = TextEditingController();
  final _model = TextEditingController();

  VisionReadiness _readiness = VisionReadiness.unconfigured;
  String _detail = '';
  bool _saving = false;
  bool _keyVisible = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _baseUrl.dispose();
    _apiKey.dispose();
    _model.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final c = await AppConfig.load();
    if (!mounted) return;
    setState(() {
      _baseUrl.text = c.visionBaseUrl;
      _apiKey.text = c.visionApiKey;
      _model.text = c.visionModel;
      _readiness = c.hasVisionConfig
          ? (c.visionIsLocal
              ? VisionReadiness.readyLocal
              : VisionReadiness.readyRemote)
          : VisionReadiness.unconfigured;
      _detail = '';
    });
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await AppConfig.save(
        visionBaseUrl: _baseUrl.text.trim(),
        visionApiKey: _apiKey.text.trim(),
        visionModel: _model.text.trim(),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('视觉模型配置已保存'),
        duration: Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
      ));
      await _load();
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// Fill in the on-device Ollama defaults.
  ///
  /// A button rather than a placeholder because the value has to come from
  /// `kDefaultOllamaVisionBaseUrl` — writing it into the hint text would create
  /// the second copy of the default that the constant exists to prevent, and
  /// this one would be shown to the user and therefore believed.
  void _prefillLocal() {
    setState(() {
      _baseUrl.text = kDefaultOllamaVisionBaseUrl;
      _model.text = kDefaultVisionModel;
    });
  }

  /// Ask the endpoint what models it has.
  ///
  /// `/v1/models` rather than a chat completion: it is a GET, it returns the
  /// model list, and it proves connectivity, authentication and that the URL is
  /// an OpenAI-compatible endpoint all at once. A chat completion would prove
  /// the same things but cost a full inference and would fail confusingly on an
  /// endpoint that is up but has no vision model loaded.
  Future<void> _test() async {
    final url = _baseUrl.text.trim();
    final model = _model.text.trim();
    if (url.isEmpty || model.isEmpty) {
      setState(() {
        _readiness = VisionReadiness.unconfigured;
        _detail = 'Base URL 和模型名都要填';
      });
      return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      setState(() {
        _readiness = VisionReadiness.unreachable;
        _detail = 'URL 无效：需以 http:// 或 https:// 开头';
      });
      return;
    }

    setState(() {
      _readiness = VisionReadiness.testing;
      _detail = '正在连接…';
    });

    // Only the key on screen. `AppConfigData.effectiveVisionKey` would also
    // fall back to the chat provider's key for a remote endpoint, but that
    // fallback is defined over *saved* config — and this button exists to test
    // what the user just typed, before it is saved.
    final key = _apiKey.text.trim();
    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 8),
      receiveTimeout: const Duration(seconds: 20),
    ));

    try {
      final resp = await dio.get(
        '$url/models',
        options: Options(headers: {
          if (key.isNotEmpty) 'Authorization': 'Bearer $key',
        }),
      );

      final data = resp.data;
      final ids = data is Map && data['data'] is List
          ? (data['data'] as List)
              .whereType<Map>()
              .map((e) => e['id']?.toString() ?? '')
              .where((s) => s.isNotEmpty)
              .toList()
          : <String>[];

      final local = _isLocal(url);
      if (!mounted) return;
      setState(() {
        _readiness = local
            ? VisionReadiness.readyLocal
            : VisionReadiness.readyRemote;
        if (ids.isEmpty) {
          _detail = '连上了，但没返回模型列表';
        } else if (ids.contains(model)) {
          _detail = '可用，已加载 $model';
        } else {
          _detail = '连上了，但没有 $model。现有：${ids.take(5).join('、')}';
        }
      });
    } on DioException catch (e) {
      if (!mounted) return;
      final status = e.response?.statusCode;
      setState(() {
        _readiness = VisionReadiness.unreachable;
        _detail = switch (e.type) {
          DioExceptionType.connectionError ||
          DioExceptionType.connectionTimeout =>
            '连不上 $url。本地 Ollama 的话，确认 Termux 里 ollama serve 正在跑',
          DioExceptionType.receiveTimeout => '超时：端点有响应但太慢',
          DioExceptionType.badResponse =>
            'HTTP ${status ?? "?"}：${e.response?.statusMessage ?? ""}',
          _ => e.message ?? '未知错误',
        };
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _readiness = VisionReadiness.unreachable;
        _detail = '出错：$e';
      });
    }
  }

  /// Duplicated from `AppConfigData.visionIsLocal` on purpose.
  ///
  /// This method runs before anything has been saved — it is classifying what
  /// the user just typed, not what is stored. Reading the stored value would
  /// test the last-saved config instead of the fields on screen, and the button
  /// would report success for a value the user has since edited.
  static bool _isLocal(String url) {
    final u = Uri.tryParse(url);
    if (u == null || !u.hasAuthority) return false;
    final h = u.host.toLowerCase();
    return h == 'localhost' || h == '127.0.0.1' || h == '::1';
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return _shell(palette, [
      _statusLine(palette),
      const SizedBox(height: AppSpacing.inner),
      _field('Base URL', _baseUrl, palette,
          hint: kDefaultOllamaVisionBaseUrl),
      const SizedBox(height: AppSpacing.inner),
      _field('模型名', _model, palette, hint: kDefaultVisionModel),
      const SizedBox(height: AppSpacing.inner),
      _keyField(palette),
      const SizedBox(height: AppSpacing.inner),
      _buttons(palette),
      if (_detail.isNotEmpty) ...[
        const SizedBox(height: AppSpacing.inner),
        Text(_detail, style: AppText.micro.copyWith(color: palette.textSecondary)),
      ],
      const SizedBox(height: AppSpacing.inner),
      _hint(palette),
    ]);
  }

  Widget _shell(AppPalette palette, List<Widget> children) {
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
          children: [
            Row(
              children: [
                Icon(Icons.remove_red_eye_outlined,
                    size: 18, color: palette.cyan),
                const SizedBox(width: AppSpacing.inner),
                Text('视觉模型',
                    style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
              ],
            ),
            const SizedBox(height: AppSpacing.inner),
            ...children,
          ],
        ),
      ),
    );
  }

  /// The one line that says whether this will work.
  Widget _statusLine(AppPalette palette) {
    final (Color color, String text) = switch (_readiness) {
      VisionReadiness.unconfigured => (
          palette.textFaint,
          '未配置：读屏幕、定位元素都用不了'
        ),
      VisionReadiness.unreachable => (
          palette.error,
          '配了但连不上：视觉定位会失败'
        ),
      VisionReadiness.readyLocal => (
          palette.success,
          '就绪 · 本机推理，截图不出设备'
        ),
      VisionReadiness.readyRemote => (
          palette.warning,
          '就绪 · 远端端点，截图会发到那里'
        ),
      VisionReadiness.testing => (palette.textSecondary, '测试中…'),
    };
    return Row(
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: AppSpacing.inner),
        Expanded(
          child: Text(text,
              style: AppText.secondary.copyWith(color: color)),
        ),
      ],
    );
  }

  Widget _field(String label, TextEditingController ctrl, AppPalette palette,
      {required String hint}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: AppText.secondary.copyWith(color: palette.textSecondary)),
        const SizedBox(height: 4),
        TextField(
          controller: ctrl,
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

  Widget _keyField(AppPalette palette) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('API Key',
                style:
                    AppText.secondary.copyWith(color: palette.textSecondary)),
            const SizedBox(width: AppSpacing.inner),
            Text('（本机 Ollama 留空即可）',
                style: AppText.micro.copyWith(color: palette.textFaint)),
          ],
        ),
        const SizedBox(height: 4),
        TextField(
          controller: _apiKey,
          obscureText: !_keyVisible,
          style: AppText.body.copyWith(color: palette.textPrimary),
          decoration: InputDecoration(
            isDense: true,
            suffixIcon: IconButton(
              icon: Icon(_keyVisible ? Icons.visibility_off : Icons.visibility,
                  size: 16),
              onPressed: () => setState(() => _keyVisible = !_keyVisible),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buttons(AppPalette palette) {
    return Row(
      children: [
        _capsule(palette, '用本机 Ollama', _prefillLocal),
        const SizedBox(width: AppSpacing.inner),
        _capsule(palette, '测试连接', _test,
            busy: _readiness == VisionReadiness.testing),
        const SizedBox(width: AppSpacing.inner),
        _capsule(palette, '保存', _save, busy: _saving),
      ],
    );
  }

  Widget _capsule(AppPalette palette, String label, VoidCallback onTap,
      {bool busy = false}) {
    return InkWell(
      onTap: busy ? null : onTap,
      borderRadius: BorderRadius.circular(AppRadius.small),
      child: Container(
        padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.inner, vertical: 6),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppRadius.small),
          border: Border.all(color: palette.strokeStrong, width: AppStroke.thin),
        ),
        child: Text(busy ? '…' : label,
            style: AppText.label.copyWith(color: palette.primary)),
      ),
    );
  }

  /// The part that makes an unreachable local endpoint actionable.
  ///
  /// `analyze_screen` used to say "请在设置中填写" and nothing else, which is
  /// why it never worked here: the user had no way to know that "fill it in"
  /// meant "install a language-model server inside Termux". So this says what
  /// is missing, and says it only when it is actually missing.
  Widget _hint(AppPalette palette) {
    if (_readiness == VisionReadiness.readyLocal ||
        _readiness == VisionReadiness.readyRemote) {
      return Text(
        '换模型时注意坐标约定：默认的 $kDefaultVisionModel 用 0-1000 归一化坐标，'
        '换成按图像像素给坐标的模型也能用（会自动判断），但精度会差一点。',
        style: AppText.micro.copyWith(color: palette.textFaint),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '有两条路，两条的 Base URL 都是 $kDefaultOllamaVisionBaseUrl，'
          '截图都不出这台设备：',
          style: AppText.micro.copyWith(color: palette.textSecondary),
        ),
        const SizedBox(height: 4),
        Text(
          'A. 模型跑在 PC 上，手机蹭用（推荐，手机上零安装）\n'
          '     PC 装好 Ollama，跑一次 setup-phone-vision.ps1。\n'
          '     它用 adb reverse 把 PC 的 11434 映到手机的回环上。\n'
          '     代价：要插着 USB，拔掉就断，拔回来重跑脚本即可。',
          style: AppText.micro.copyWith(color: palette.textFaint),
        ),
        const SizedBox(height: 4),
        Text(
          'B. 模型跑在手机本地（真的不依赖电脑）\n'
          '     Termux 里：pkg install ollama → ollama serve\n'
          '     → ollama pull $kDefaultVisionModel',
          style: AppText.micro.copyWith(color: palette.textFaint),
        ),
        const SizedBox(height: 4),
        Text(
          '想用云端多模态模型也行，填一个你已有密钥的端点即可——'
          '那样截图会发到对方服务器，本页会标出来。',
          style: AppText.micro.copyWith(color: palette.textFaint),
        ),
      ],
    );
  }
}
