// khy-canary: Khy-20261101-119-QHHJQ2R2
import 'package:flutter/material.dart';
import 'package:dio/dio.dart';
import '../../core/config/app_config.dart';
import '../../core/config/built_in_keys.dart';
import '../../core/config/model_registry.dart';
import '../../core/config/permission_mode.dart';
import '../../core/config/provider_presets.dart';
import '../../core/gateway/khyos_api.dart';
import '../../core/services/app_logger.dart';
import '../../core/services/device_control.dart';
import '../../ui/theme/app_colors.dart';
import '../../ui/theme/design_tokens.dart';
import '../../ui/widgets/local_model_section.dart';
import '../../ui/widgets/vision_config_section.dart';
import '../../ui/widgets/aurora.dart';
import '../../ui/widgets/project_info_card.dart';
import 'network_diagnostic_screen.dart';
import 'log_viewer_screen.dart';
import 'vfs_settings_screen.dart';

/// Redesigned settings screen - grouped sections
class SettingsScreenNew extends StatefulWidget {
  /// 没有路由可弹时（本页被当 tab 用）按返回该做什么。
  ///
  /// 由宿主 KhyOsHome 提供「切回 AI tab」。不传也行——那种情况下按返回
  /// 什么都不做，也好过把 App 退掉变成黑屏。
  final VoidCallback? onExit;

  /// 本页变成「可见」的那一次计数，由宿主页签索引充当。
  ///
  /// WHY THIS EXISTS. The host uses an `IndexedStack` (main.dart), so all four
  /// tabs stay alive and switching tabs only repaints — this State object is
  /// never rebuilt. The two things it displays that are decided OUTSIDE the
  /// app (the accessibility and screen-capture switches) are therefore only
  /// re-read on `initState` and on `AppLifecycleState.resumed`.
  ///
  /// That leaves a hole you can walk into: enable 无障碍服务 on the 设备 tab
  /// (or from the system page) while the app stays in the foreground, switch
  /// back to 设置, and the switch still says off. A toggle that contradicts
  /// reality is worse than no toggle — the user taps it expecting "off → on"
  /// and gets a confirmation dialog about writing a setting that is already
  /// written.
  ///
  /// The host bumps this on every tab change, so `didUpdateWidget` re-reads
  /// exactly when this page becomes the one being looked at. It is a counter
  /// and not a bool because "same index, re-selected" must also refresh — the
  /// user may have gone to system settings and back without any tab change.
  final int visibleTick;

  const SettingsScreenNew({super.key, this.onExit, this.visibleTick = 0});

  @override
  State<SettingsScreenNew> createState() => _SettingsScreenNewState();
}

class _SettingsScreenNewState extends State<SettingsScreenNew>
    with WidgetsBindingObserver {
  AppConfigData? _config;
  late TextEditingController _baseUrl;
  late TextEditingController _apiKey;
  late TextEditingController _model;
  late TextEditingController _sysPrompt;
  final _baseUrlFocus = FocusNode();
  final _apiKeyFocus = FocusNode();
  final _sysPromptFocus = FocusNode();
  bool _showKey = false;
  bool _saving = false;
  String? _testResult;
  final _logger = AppLogger();
  bool _loadingModels = false;
  List<ModelInfo> _availableModels = [];
  BridgeStatus? _bridgeStatus;

  // 系统能力开关。初值 false 而不是读一次再建 widget：真实状态由
  // _refreshCapabilities() 在 initState 里异步回填，首帧之后就是准的。
  bool _a11yOn = false;
  bool _captureOn = false;
  bool _a11yBusy = false;
  bool _captureBusy = false;

  /// 手机桥与工作悬浮框的忙碌位。与上面两个同构：真开关按下到回填之间
  /// 有一个窗口，期间 Switch 会整棵摘掉（见 [_entrySwitch] 的 busy 分支），
  /// 连点并发发多条起停命令就是这个位要挡的事。
  bool _bridgeBusy = false;
  bool _overlayBusy = false;

  /// 「选中文字后」菜单入口此刻装没装。
  ///
  /// 与上面两个不同：这个是 App 自己的组件，翻开关立刻生效，不需要用户去系统
  /// 设置里点什么。所以它是个真开关，不是"发起授权流程"的那种。
  bool _processTextOn = false;
  bool _processTextBusy = false;

  /// 工具许可模式。与桌面/终端同一套词汇，见 PermissionMode。
  PermissionMode _permissionMode = PermissionMode.prompt;

  // 一键开关当前是否可用，以及为什么。空串=还没问到。
  // 不缓存成"问一次就信"：sidecar 重启后就没了，每次进设置页重问，
  // 免得给用户一个过期的一次性结论。
  String _a11yAdvice = '';
  bool _a11yAutoRestore = false;
  bool _autoRestoreBusy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _baseUrl = TextEditingController();
    _apiKey = TextEditingController();
    _model = TextEditingController();
    _sysPrompt = TextEditingController();
    // 聚焦光晕要跟焦点态切换，监听器只负责触发重建。
    _baseUrlFocus.addListener(_focusChanged);
    _apiKeyFocus.addListener(_focusChanged);
    _sysPromptFocus.addListener(_focusChanged);
    _load();
    _refreshBridgeStatus();
    _refreshCapabilities();
    _refreshA11yAdvice();
    _refreshProcessTextEntry();
    _loadPermissionMode();
  }

  /// 读当前工具许可模式。
  ///
  /// 每次进这页都问一次而不是缓存：模式存在 AppConfig 里，可能在别的入口被改过
  /// （或换了一台设备上的同一份配置）。缓存会让这一页显示一个已经不是真实的档位。
  Future<void> _loadPermissionMode() async {
    final c = await AppConfig.load();
    if (!mounted) return;
    setState(() => _permissionMode = PermissionMode.fromWire(c.permissionMode));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _baseUrl.dispose();
    _apiKey.dispose();
    _model.dispose();
    _sysPrompt.dispose();
    _baseUrlFocus.dispose();
    _apiKeyFocus.dispose();
    _sysPromptFocus.dispose();
    super.dispose();
  }

  void _focusChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(SettingsScreenNew old) {
    super.didUpdateWidget(old);
    // 宿主页签变了 → 本页刚变成用户正在看的那一页。见 [visibleTick] 的注释：
    // IndexedStack 不重建子 State，所以这是唯一一个「变成可见」的信号。
    // 与 didChangeAppLifecycleState 复读同样的三样：无障碍/截屏的授权发生在
    // App 之外，提权通道也会在期间被重启或消失。
    if (old.visibleTick != widget.visibleTick) {
      _refreshCapabilities();
      _refreshA11yAdvice();
      _refreshBridgeStatus();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 从系统设置页（「所有文件访问」等）回来必须复测：一次性 FutureBuilder
    // 只在 build 时拉一次，授完权回来界面不变、不知是否生效。
    if (state == AppLifecycleState.resumed) {
      _refreshBridgeStatus();
      // 无障碍与截屏的授权都发生在 App 之外（系统设置页 / MediaProjection
      // 对话框），用户回来时状态已经变了。不在这里重读，开关就会显示一个
      // 和现实相反的值——而那比不显示更糟。
      _refreshCapabilities();
      // 提权通道同样会在这段时间里变（sidecar 可能被重启或重启后消失），
      // 一并重问，免得「一键可用」这句提示变成过期结论。
      _refreshA11yAdvice();
    }
  }

  Future<void> _refreshBridgeStatus() async {
    final st = await DeviceControl.bridgeStatus();
    if (mounted) setState(() => _bridgeStatus = st);
  }

  /// 读「选中文字后」入口的真实状态。
  ///
  /// 每次进这页都问一次系统，不缓存：重装 App 会把组件状态打回 manifest 默认
  /// （禁用），而缓存会继续显示"开着"——那时用户去长按选字会发现没有这一项，
  /// 而设置页说它有。
  Future<void> _refreshProcessTextEntry() async {
    final on = await DeviceControl.processTextEntryEnabled();
    if (mounted) setState(() => _processTextOn = on);
  }

  Future<void> _toggleProcessTextEntry(bool value) async {
    setState(() => _processTextBusy = true);
    try {
      final ok = await DeviceControl.setProcessTextEntryEnabled(value);
      if (!mounted) return;
      if (!ok) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('切换入口失败'),
          duration: Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ));
        return;
      }
      // 以真实状态回填，而不是把用户点的值直接当真。组件启用是系统做的事，
      // 失败了界面还显示"开着"就是撒谎。
      setState(() => _processTextOn = value);
    } finally {
      if (mounted) setState(() => _processTextBusy = false);
    }
  }

  Future<void> _load() async {
    final c = await AppConfig.load();
    setState(() {
      _config = c;
      _baseUrl.text = c.baseUrl;
      _apiKey.text = c.apiKey;
      _model.text = c.model;
      _sysPrompt.text = c.systemPrompt;
    });
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await AppConfig.save(
        baseUrl: _baseUrl.text.trim(),
        apiKey: _apiKey.text.trim(),
        model: _model.text.trim(),
        systemPrompt: _sysPrompt.text.trim(),
      );
      await _load();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text('配置已保存'),
            backgroundColor: AppPalette.of(context).success,
            duration: const Duration(seconds: 2),
            behavior: SnackBarBehavior.floating,
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(AppRadius.medium)),
          ),
        );
      }
    } finally {
      setState(() => _saving = false);
    }
  }

  Future<void> _test() async {
    setState(() => _testResult = null);
    final url = _baseUrl.text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      setState(() => _testResult = 'URL 无效：需以 http:// 或 https:// 开头');
      return;
    }
    // Use the effective key (user key or built-in)
    final effectiveKey = _apiKey.text.trim().isNotEmpty
        ? _apiKey.text.trim()
        : BuiltInKeys.getBuiltInKey(url);
    try {
      final d = Dio(BaseOptions(
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10)));
      await d.get('$url/models',
          options: Options(
            headers: {
              'Authorization': 'Bearer $effectiveKey'
            },
            validateStatus: (s) => s != null && s < 500,
          ));
      setState(() => _testResult = '连接成功');
    } on DioException catch (e) {
      final code = e.response?.statusCode;
      final errorCode = code != null
          ? ErrorCode.forHttpStatus(code)
          : (e.type == DioExceptionType.connectionTimeout
              ? ErrorCode.timeout
              : ErrorCode.connection);
      _logger.recordError(
        code: errorCode,
        message: '连接测试失败: $url',
        category: LogCategory.network,
        context: {
          'url': url,
          'type': e.type.name,
          'status': code?.toString() ?? '',
        },
        exception: e,
      );
      setState(() {
        if (code != null) {
          _testResult = 'HTTP $code：${_describeHttpStatus(code)}';
        } else if (e.type == DioExceptionType.connectionTimeout) {
          _testResult = '连接超时：服务器无响应';
        } else if (e.type == DioExceptionType.connectionError) {
          _testResult = '连接失败：请检查网络';
        } else {
          _testResult = '连接失败：${e.message}';
        }
      });
    } catch (e) {
      setState(() => _testResult = '连接失败：$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    // 本页同时被当 tab 用（KhyOsHome 的 screens 列表）和当路由用
    // （ChatScreenNew 头部齿轮 push 进来）。当 tab 时根导航器上没有东西可弹，
    // 顶栏那个返回箭头调的 Navigator.pop 就会把 App 退掉——用户看到的就是
    // 「点返回整个黑屏」（这台手机的桌面是深色的，看起来像 App 变黑）。
    //
    // 所以：有路由可弹才弹，没有就交给宿主（KhyOsHome 传 onExit 切回 AI tab）。
    // 宿主没给（理论上不该发生）就什么都不做——什么都不做也比退掉 App 好。
    final canPop = Navigator.canPop(context);
    void handleBack() {
      if (canPop) {
        Navigator.pop(context);
      } else {
        widget.onExit?.call();
      }
    }

    return PopScope(
      // 系统返回键走同一条判断：有路由可弹时正常弹，没有时拦下交给 onExit。
      // 不拦的话，在「设置」tab 上按系统返回会直接退出 App。
      //
      // 用 onPopInvokedWithResult 而不是 onPopInvoked：后者自 3.22 起废弃，
      // 留着它下一次 Flutter 升级就编不过。
      canPop: canPop,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) widget.onExit?.call();
      },
      child: Scaffold(
        appBar: AppBar(
          title: const Text('设置'),
          leading: IconButton(
              icon: const Icon(Icons.arrow_back),
              onPressed: handleBack,
              tooltip: canPop ? '返回' : '回到对话'),
        ),
      // ── 为什么这一页要单独包 SafeArea ─────────────────────────────────
      //
      // 宿主 Scaffold 用了 `extendBody: true`（main.dart，让滚动内容从玻璃底栏下
      // 透出来），body 一直延伸到屏幕最底，被 bottomNavigationBar 盖住底下那一块。
      // 另外三个页签（AI/技能/设备）都包了 SafeArea，它已经把这块避让掉了；唯独
      // 这一页没有，于是划到底时：
      //
      //   - 最后一段压在底栏下面，看不全也点不到；
      //   - 列表此时已到达最大滚动偏移，**再也划不动**——用户向上猛滑不会有任何
      //     位移，感知就是「卡在下面、没有惯性」，其实是没有可滚的量了。
      //
      // 修法和另外三个页签保持一致：包上 SafeArea，内边距保持统一的
      // AppSpacing.page。**不要**在这里自己拼一份底部 inset——那会和 SafeArea 重复
      // 计一遍系统 inset，把底部撑出过量空白（AI 页实测过：多出 380px 死空间）。
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.page),
          children: [
            // ── Section: Provider Presets ──
            const SectionTitle(title: '内置提供商', icon: Icons.router),
            const SizedBox(height: AppSpacing.dense),
            Text(
              // 原来写死「已内置密钥」。仓库消毒后所有内置数组都是空的，这句话
              // 就会和下一行每张卡的「无内置密钥」互相打脸。改成按实际数量说。
            BuiltInKeys.providers.values.where((p) => p.hasKey).isEmpty
                ? '当前构建没有内置密钥：选中提供商后，在下方 API 配置里填写 Key 即可使用'
                : '带绿点的提供商已内置密钥，选中即可用；其余选中后在下方 API 配置里填写 Key',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: AppText.secondary.copyWith(color: palette.textSecondary),
          ),
          const SizedBox(height: AppSpacing.dense),
          ...BuiltInKeys.providers.entries.map(
            (entry) => _presetTile(entry.key, entry.value, palette),
          ),
          const SizedBox(height: AppSpacing.section),

          // ── Section: API Config ──
          const SectionTitle(title: 'API 配置', icon: Icons.key),
          const SizedBox(height: AppSpacing.dense),
          // Built-in key indicator
          if (_config != null && !_config!.hasUserKey && _config!.hasBuiltInKey)
            Container(
              margin: const EdgeInsets.only(bottom: AppSpacing.dense),
              padding: const EdgeInsets.all(AppSpacing.dense),
              decoration: BoxDecoration(
                color: palette.success.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(AppRadius.small),
                border: Border.all(
                    color: palette.success.withValues(alpha: 0.35),
                    width: AppStroke.thin),
              ),
              child: Row(
                children: [
                  Icon(Icons.lock, size: 16, color: palette.success),
                  const SizedBox(width: AppSpacing.dense),
                  Expanded(
                    child: Text(
                      '当前使用内置密钥（${_config!.maskedEffectiveKey}）',
                      style: AppText.secondary.copyWith(color: palette.success),
                    ),
                  ),
                ],
              ),
            ),
          if (_config != null &&
              !_config!.hasUserKey &&
              !_config!.hasBuiltInKey &&
              _config!.baseUrl.isNotEmpty)
            Container(
              margin: const EdgeInsets.only(bottom: AppSpacing.dense),
              padding: const EdgeInsets.all(AppSpacing.dense),
              decoration: BoxDecoration(
                color: palette.warning.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(AppRadius.small),
                border: Border.all(
                    color: palette.warning.withValues(alpha: 0.35),
                    width: AppStroke.thin),
              ),
              child: Row(
                children: [
                  Icon(Icons.warning_amber_rounded,
                      size: 16, color: palette.warning),
                  const SizedBox(width: AppSpacing.dense),
                  Expanded(
                    child: Text(
                      '未配置密钥：请填写 API Key 或选择上方提供商',
                      style: AppText.secondary.copyWith(color: palette.warning),
                    ),
                  ),
                ],
              ),
            ),
          _card(palette, [
            _labeledField('Base URL', _baseUrl,
                hint: 'https://api.example.com/v1',
                palette: palette,
                focusNode: _baseUrlFocus),
            const SizedBox(height: AppSpacing.cardGap),
            _labeledFieldWithToggle('API Key', _apiKey,
                hint: 'sk-...',
                palette: palette,
                visible: _showKey,
                onToggle: () => setState(() => _showKey = !_showKey)),
            const SizedBox(height: AppSpacing.cardGap),
            _modelSelector(palette),
            const SizedBox(height: AppSpacing.cardGap),
            _labeledField('System Prompt', _sysPrompt,
                hint: '可选 - 自定义系统提示词',
                palette: palette,
                focusNode: _sysPromptFocus,
                multiline: true),
          ]),
          const SizedBox(height: AppSpacing.dense),
          Row(
            children: [
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(AppRadius.medium),
                    boxShadow: _saving ? null : AppShadows.glowPrimary,
                  ),
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: palette.primary,
                      foregroundColor: Colors.white,
                      minimumSize: const Size(0, 48),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(AppRadius.medium),
                      ),
                    ),
                    onPressed: _saving ? null : _save,
                    child: _saving
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                                strokeWidth: 2, color: Colors.white))
                        : Text('保存配置', style: AppText.cardTitle),
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.cardGap),
              Expanded(
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: palette.primary,
                    side: BorderSide(color: palette.primary, width: 1.2),
                    minimumSize: const Size(0, 48),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(AppRadius.medium),
                    ),
                  ),
                  onPressed: _test,
                  child: Text('测试连接', style: AppText.cardTitle),
                ),
              ),
            ],
          ),
          if (_testResult != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.dense),
              child: Text(
                _testResult!,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: AppText.secondary.copyWith(
                  color: _testResult!.startsWith('连接成功')
                      ? palette.success
                      : palette.error,
                ),
              ),
            ),
          // 作为第 4 Tab 嵌入时给玻璃底栏让位，否则尾排按钮被压住一半。
          const SizedBox(height: 48),

          // ── Section: 文件管理器 ──
          // 这一节是「权限透明可控」的入口：安全模式、AI 辅助强度、高级数据编辑
          // 与操作日志都在里面。放在设置页而不是文件管理器内部，是因为这些是
          // 一次性的授权决定，不是日常操作。
          const SectionTitle(title: '文件管理器', icon: Icons.folder_outlined),
          const SizedBox(height: AppSpacing.dense),
          _card(palette, [
            _listTileAction(
              palette, Icons.tune, '文件管理器设置',
              '安全模式、AI 辅助强度、高级数据编辑与操作日志',
              () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const VfsSettingsScreen())),
            ),
          ]),
          const SizedBox(height: AppSpacing.section),

          // ── Section: Diagnostics ──
          const SectionTitle(title: '诊断工具', icon: Icons.network_check),
          const SizedBox(height: AppSpacing.dense),
          _card(palette, [
            _listTileAction(
              palette, Icons.wifi_find, '网络诊断',
              '检查 DNS / 连接 / 自动修复',
              () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const NetworkDiagnosticScreen())),
            ),
            _listTileAction(
              palette, Icons.bug_report, '日志查看',
              '按天查看运行日志，错误优先',
              () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const LogViewerScreen())),
            ),
          ]),
          const SizedBox(height: AppSpacing.section),

          // ── Section: Device ──
          const SectionTitle(title: '设备控制', icon: Icons.devices),
          const SizedBox(height: AppSpacing.dense),
          _card(palette, [
            FutureBuilder<bool>(
              future: DeviceControl.isAccessibilityReady(),
              builder: (_, snap) {
                final ready = snap.data ?? false;
                return ListTile(
                  leading: _leadingDisc(Icons.accessibility_new, palette,
                      ready ? palette.success : palette.textFaint),
                  title: Text('无障碍服务', style: _tileTitle(palette)),
                  subtitle: Text(ready ? '已启用' : '未启用',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: _tileSubtitle(palette)),
                  trailing: ready
                      ? Icon(Icons.check_circle,
                          color: palette.success, size: 20)
                      // 和下方「系统能力」的开关走同一条路：一次确认 + 一键写入，
                      // 失败才退回系统设置。两处各写一套，必然有一套先烂掉。
                      : _actionCapsule(context, '去开启',
                          () => _toggleAccessibility(true)),
                );
              },
            ),
            const Divider(height: 1),
            FutureBuilder<bool>(
              future: DeviceControl.isScreenCaptureReady(),
              builder: (_, snap) {
                final ready = snap.data ?? false;
                return ListTile(
                  leading: _leadingDisc(Icons.screenshot, palette,
                      ready ? palette.success : palette.textFaint),
                  title: Text('屏幕捕获', style: _tileTitle(palette)),
                  subtitle: Text(ready ? '运行中' : '未运行',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: _tileSubtitle(palette)),
                  trailing: _actionCapsule(
                    context,
                    ready ? '停止' : '启动',
                    () async {
                      if (ready) {
                        await DeviceControl.stopScreenCapture();
                      } else {
                        await DeviceControl.startScreenCapture();
                      }
                      setState(() {});
                    },
                  ),
                );
              },
            ),
          ]),
          const SizedBox(height: AppSpacing.cardGap),
          // ── 手机桥（khy-os 桥，原 StepBridge 并入本 App） ──
          //
          // 这里原来是五行的 _card。现在「手机桥」与「工作悬浮框」提到卡外做
          // 成 _entrySwitch，卡里留四行。
          //
          // 为什么提出来：这两行是 App 自己的服务，翻过去就真的生效，属于
          // _entrySwitch 文档里写的那一类；而卡里剩下四行没有一行能被 App
          // 自己改变（协作模式是 PC 连不连、令牌是落没落盘、两个授权要去系统
          // 设置页）。让一行真开关和四行只读状态挤在同一张卡里，用户会以为
          // 点哪一行都能改。
          //
          // stretch 不能省：Column 默认 center 会把两个 Switch 行的 Container
          // 缩成固有宽，卡片视觉立刻塌。
          Builder(builder: (_) {
            final st = _bridgeStatus ?? const BridgeStatus();
            final ok = st.online;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _entrySwitch(
                  icon: Icons.cable,
                  title: '手机桥（khy-os 桥）',
                  subtitle: ok
                      ? '在线 · 端口 ${st.port} · ${st.toolCount} 个工具'
                      : '离线',
                  value: ok,
                  busy: _bridgeBusy,
                  onChanged: _toggleBridge,
                  switchKey: const Key('bridge-switch'),
                ),
                const SizedBox(height: AppSpacing.cardGap),
                _card(palette, [
                  ListTile(
                    leading: _leadingDisc(Icons.hub_outlined, palette,
                        st.pcReachable == true ? palette.success : palette.textFaint),
                    title: Text('协作模式', style: _tileTitle(palette)),
                    // PC 不在不是故障：桥照常运行，手机继续用自己的通道工作。
                    // 但要协作有两条硬前提，不写出来用户只能猜。
                    subtitle: Text(
                        st.pcReachable == true
                            ? '协作中 · PC 已连入这台手机'
                            : st.pcReachable == false
                                ? '独立工作 · PC 未连入（不影响本机使用）\n'
                                    '要协作需：手机与电脑同一局域网，且开发者选项里开启无线调试'
                                : '未知（桥未上报该状态）',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: _tileSubtitle(palette)),
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: _leadingDisc(
                        st.tokenPersisted == false
                            ? Icons.warning_amber_rounded
                            : Icons.vpn_key,
                        palette,
                        st.tokenPersisted == false
                            ? palette.warning
                            : ok
                                ? palette.success
                                : palette.textFaint),
                    title: Text('访问令牌', style: _tileTitle(palette)),
                    subtitle: Text(_tokenSubtitle(st),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: _tileSubtitle(palette)),
                  ),
                  if (!st.allFiles) ...[
                    const Divider(height: 1),
                    ListTile(
                      leading: _leadingDisc(
                          Icons.folder_off, palette, palette.warning),
                      title: Text('所有文件访问', style: _tileTitle(palette)),
                      subtitle: Text('桥的令牌落盘与文件信箱前提；缺了它 PC 侧拿不到令牌',
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: _tileSubtitle(palette)),
                      trailing: _actionCapsule(
                          context, '去授权', DeviceControl.requestAllFilesAccess),
                    ),
                  ],
                  if (!st.uiReady) ...[
                    const Divider(height: 1),
                    ListTile(
                      leading: _leadingDisc(
                          Icons.accessibility_new, palette, palette.warning),
                      title: Text('无障碍服务', style: _tileTitle(palette)),
                      subtitle: Text('UI 自动化与截图需要它（下方「无障碍服务」去开启）',
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: _tileSubtitle(palette)),
                    ),
                  ],
                ]),
                _entrySwitch(
                  icon: Icons.picture_in_picture_alt,
                  title: '工作悬浮框',
                  subtitle: st.overlayRunning
                      ? '显示中（可拖拽，点按展开）'
                      : st.overlayGranted
                          ? '未显示'
                          : '需要悬浮窗权限',
                  value: st.overlayRunning,
                  busy: _overlayBusy,
                  onChanged: _toggleOverlay,
                  switchKey: const Key('overlay-switch'),
                ),
                // 未授权时补这一行：原来「去授权」是手机桥那一行 trailing 的
                // 分支，手机桥提成开关后那个分支没了。用 _listTileAction 而不是
                // 再造一个按钮，是为了不长出第四种行形态。
                if (!st.overlayGranted)
                  _listTileAction(
                    palette,
                    Icons.picture_in_picture_alt,
                    '悬浮窗权限',
                    '去系统设置页授予；授予后这里就能开关',
                    DeviceControl.requestOverlay,
                  ),
              ],
            );
          }),
          const SizedBox(height: AppSpacing.section),
          // ── Section: 视觉模型 ──
          //
          // 单独一节，因为它不是「又一个 API 端点」。它决定的是 App 能不能
          // 看懂屏幕——而这是整套界面自动化的前提：没有它，一个纯文字推理
          // 模型只能回答「我无法操作界面」，那句话是假的，也正是这座桥要
          // 防的失败。
          //
          // 抽成 VisionConfigSection 而不是内联：本文件已过千行，而且这一块
          // 自己管自己的读写——视觉字段改得远比聊天模型少，视觉测试失败也
          // 不该把用户刚保存的聊天配置回滚掉。
          const SectionTitle(title: '视觉模型', icon: Icons.remove_red_eye_outlined),
          const SizedBox(height: AppSpacing.dense),
          const VisionConfigSection(),
          const SizedBox(height: AppSpacing.dense),
          // 内置本地模型放在 VisionConfigSection 之后，而不是之前：上面三个
          // 字段填的是「视觉模型在哪」，这一节填的是「把引擎和模型也一并给你」。
          // 顺序反了会让用户以为必须先填 URL 才能用本地模型，而事实是启动引擎
          // 后 URL 由原生侧回填（端口是它挑的，见 LocalModelSection）。
          //
          // onEndpointChanged 是必须的：本地引擎启动后会改写 visionBaseUrl，
          // 不通知父级，上面那三个字段会一直显示旧值，直到用户手动退出重进。
          LocalModelSection(onEndpointChanged: _refreshCapabilities),
          const SizedBox(height: AppSpacing.section),
          // ── Section: 入口 ──
          //
          // khy-os 要被想起来，得有入口。分享菜单是常开的（系统侧，不需要谁
          // 配合）；「选中文字后」那条默认关着——它会出现在本机每一次长按选字
          // 的菜单里，那是永久且用户可见的侵入，所以决定权给用户。
          const SectionTitle(title: '入口', icon: Icons.open_in_new_outlined),
          const SizedBox(height: AppSpacing.dense),
          _entrySwitch(
            icon: Icons.text_fields,
            title: '选中文字后',
            subtitle: '在系统「选中文字」菜单里加一项「用 khy-os 处理…」',
            value: _processTextOn,
            busy: _processTextBusy,
            onChanged: _toggleProcessTextEntry,
            switchKey: const Key('process-text-switch'),
          ),
          const SizedBox(height: AppSpacing.section),
          // ── Section: 工具许可 ──
          //
          // 这一节把手机补上和桌面/终端同一套的权限模式。之前手机上根本没有模式层，
          // 而且 `PermissionLevel.ask` 是个谎——ToolEngine.getPermission 在没有显式
          // 设置时回落到 auto，声明了 ask 的工具一次都没被问过。
          //
          // 三个档的差别是「khy-os 自己的提示要不要弹」，不是「能不能绕过系统」。
          // 安卓那种同意框（MediaProjection）不归这里管，而且那条路已经改成走无障碍
          // 服务，弹窗不再出现——所以这里没有东西可绕。
          const SectionTitle(title: '工具许可', icon: Icons.shield_outlined),
          const SizedBox(height: AppSpacing.dense),
          _permissionModeSelector(palette),
          const SizedBox(height: AppSpacing.section),
          // ── Section: 系统能力开关 ──
          //
          // 无障碍与截屏原来只有「去开启 / 启动」两个跳转，用户在这页看不出
          // 它们此刻到底是开是关——要跳到设备页或系统设置里才知道。做成真开关：
          // value 是实时状态，onChanged 负责发起授权流程，授权完成后回来刷新。
          const SectionTitle(title: '系统能力', icon: Icons.toggle_on_outlined),
          const SizedBox(height: AppSpacing.dense),
          _capabilitySwitch(
            icon: Icons.accessibility_new,
            title: '无障碍服务',
            subtitle: '读界面、点按、输入文字都靠它',
            value: _a11yOn,
            busy: _a11yBusy,
            onChanged: _toggleAccessibility,
            // 显式 key：这页现在有两个长得一样的开关，测试要能点名要哪一个。
            switchKey: const Key('a11y-switch'),
          ),
          // 一键是否可用，提前说。放在开关正下方而不是藏进二级页：
          // 用户在这一页要做的决定就是「点这个开关有没有用」，而这个答案
          // 取决于 sidecar/Shizuku 在不在——那是会随重启变的。
          if (_a11yAdvice.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(
                  left: AppSpacing.cardPadNarrow, bottom: AppSpacing.cardGap),
              child: Text(
                _a11yAdvice,
                style: AppText.micro.copyWith(color: palette.textFaint),
              ),
            ),
          // 重装后自动恢复。默认关，且必须是一个看得见的开关而不是隐式行为：
          // 它说的是「更新/重装这个 App 之后，App 会替你自己把无障碍授权开回来」，
          // 而那等于重新拿到读屏幕和模拟输入的权限。这种事不该悄悄做，
          // 也不该让用户在系统设置里关掉之后又被恢复过来还以为见鬼了。
          //
          // 为什么需要它：`adb install -r` 实测会把
          // enabled_accessibility_services 清成 null，所以每更一次版本，
          // 用户开过的无障碍就没了，读界面/点按/输入整套工具静默失效。
          _capabilitySwitch(
            icon: Icons.restore,
            title: '重装后自动恢复无障碍',
            subtitle: _a11yAutoRestore
                ? '已开：更新/重装后会按你的选择恢复，并发通知告诉你'
                : '关：更新/重装后需要自己再开一次',
            value: _a11yAutoRestore,
            busy: _autoRestoreBusy,
            onChanged: _toggleA11yAutoRestore,
            switchKey: const Key('a11y-auto-restore-switch'),
          ),
          _capabilitySwitch(
            icon: Icons.screenshot_monitor_outlined,
            title: '屏幕捕获',
            subtitle: '截屏与分析当前画面',
            value: _captureOn,
            busy: _captureBusy,
            onChanged: _toggleScreenCapture,
            switchKey: const Key('capture-switch'),
          ),
          const SizedBox(height: AppSpacing.section),
          // ── Section: Project ──
          const SectionTitle(title: '项目', icon: Icons.account_tree),
          const SizedBox(height: AppSpacing.dense),
          const ProjectInfoCard(),
          const SizedBox(height: AppSpacing.section),
          // 版本号是全 app 唯一落点（首页顶栏不再重复显示）。
          Center(
            child: Text('v1.1',
                style: AppText.micro.copyWith(color: palette.textFaint)),
          ),
          ],
        ), // ListView
      ), // SafeArea
    ), // Scaffold
    );
  }

  /// 一个真开关：点了立刻生效，value 以真实状态回填。
  ///
  /// 与 [_capabilitySwitch] 的分工：那个是用户同意型权限，App 自己开不了，
  /// 所以 onChanged 只能发起流程；这个是我们自己的组件，翻过去就真的装上了。
  /// 两者的共同点是 value 都不靠本地猜测——回填来自系统，所以界面不可能
  /// 显示"开着"而菜单里其实没有。
  Widget _entrySwitch({
    required IconData icon,
    required String title,
    required String subtitle,
    required bool value,
    required bool busy,
    required Future<void> Function(bool) onChanged,
    Key? switchKey,
  }) {
    final palette = AppPalette.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.cardGap),
      padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.cardPadNarrow, vertical: AppSpacing.dense),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: palette.primary.withValues(alpha: 0.10),
              shape: BoxShape.circle,
            ),
            child: Icon(icon, size: 18, color: palette.primary),
          ),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: _tileTitle(palette)),
                Text(subtitle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: _tileSubtitle(palette)),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.dense),
          if (busy)
            const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            Switch(key: switchKey, value: value, onChanged: (v) => onChanged(v)),
        ],
      ),
    );
  }

  /// 工具许可模式选择器。
  ///
  /// 与桌面/终端同一套词汇（default / auto / bypass），存进 AppConfig，所以
  /// 杀进程不会重置——用户选「一律不问」是一个决定，不是一次会话的心情。
  ///
  /// bypass 用红色而不是跟另外两档同一个颜色：它是唯一会消掉一个安全提示的档，
  /// 不该在视觉上跟前两档平起平坐。
  Widget _permissionModeSelector(AppPalette palette) {
    // Material 而不是 Container：Container 的 decoration 会把 ListTile 的墨水反馈
    // 挡在「最近的 Material 祖先」之外，Flutter 直接断言
    // "ListTile background color or ink splashes may be invisible"。
    // 这里每一行都是可点的 RadioListTile，所以必须让 ink 有着落的地方。
    // elevation: 0 + 不 clip，外观与 Container 逐像素一致。
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
            Text('声明了「需询问」的工具，跑之前要不要问你',
                style: AppText.secondary.copyWith(color: palette.textSecondary)),
            const SizedBox(height: AppSpacing.dense),
            for (final m in PermissionMode.values)
              RadioListTile<PermissionMode>(
                value: m,
                groupValue: _permissionMode,
                onChanged: (v) {
                  if (v != null) _setPermissionMode(v);
                },
                dense: true,
                contentPadding: EdgeInsets.zero,
                // bypass 是唯一会消掉一个安全提示的档，用错误色而不是跟另外两档
                // 同一个颜色：它不该在视觉上跟前两档平起平坐。
                activeColor: switch (m) {
                  PermissionMode.bypass => palette.error,
                  PermissionMode.auto => palette.warning,
                  PermissionMode.prompt => palette.success,
                },
                title: Text(m.label,
                    style: AppText.body.copyWith(color: palette.textPrimary)),
                subtitle: Text(m.detail,
                    style: AppText.micro.copyWith(color: palette.textFaint)),
              ),
            const SizedBox(height: 4),
            Text(
              '这里管的是 khy-os 自己的确认框。系统那种同意框（如屏幕捕获）不归它管——'
              '那条路已经改成复用你已授予的无障碍服务，弹窗不再出现，所以也没有东西可绕。',
              style: AppText.micro.copyWith(color: palette.textFaint),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _setPermissionMode(PermissionMode mode) async {
    setState(() => _permissionMode = mode);
    await AppConfig.save(permissionMode: mode.wire);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('工具许可已设为：${mode.label}'),
      duration: const Duration(seconds: 2),
      behavior: SnackBarBehavior.floating,
    ));
  }

  /// 一个「显示真实状态、点击发起授权」的开关。
  ///
  /// 为什么不是普通 SwitchListTile：无障碍与截屏都是**用户同意型**权限，
  /// App 自己开不了——前者要在系统设置里由用户勾选，后者要用户在弹出的
  /// MediaProjection 对话框上点「开始」。所以这个开关的 onChanged 不能直接
  /// 改 value，只能发起流程；value 永远以真实状态回填。
  ///
  /// 这正是它该有的样子：一个能点但状态不变的开关是撒谎，一个直接翻过去的
  /// 开关是越权。
  ///
  /// [switchKey] 由调用方给，因为同一个页面上现在有两个结构相同的开关（这里是
  /// 无障碍/截屏，「入口」区是选中文字），按位置取第一个会随排版变而指错人。
  /// 不叫 `key`：那会和 State 自带的 `key` 撞，编译直接报"getter 'key' isn't
  /// defined for the type State"——而这个报错完全不提示真实原因。
  Widget _capabilitySwitch({
    required IconData icon,
    required String title,
    required String subtitle,
    required bool value,
    required bool busy,
    required Future<void> Function(bool) onChanged,
    Key? switchKey,
  }) {
    final palette = AppPalette.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpacing.cardGap),
      padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.cardPadNarrow, vertical: AppSpacing.dense),
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: palette.primary.withValues(alpha: 0.10),
              shape: BoxShape.circle,
            ),
            child: Icon(icon, size: 18, color: palette.primary),
          ),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: AppText.body.copyWith(
                        fontWeight: FontWeight.w600,
                        color: palette.textPrimary)),
                Text(subtitle,
                    style: AppText.secondary
                        .copyWith(color: palette.textSecondary)),
              ],
            ),
          ),
          if (busy)
            const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            Switch(
              key: switchKey,
              value: value,
              // 关的时候直接关（截屏可以停，无障碍只能去系统设置关）。
              onChanged: (v) => onChanged(v),
            ),
        ],
      ),
    );
  }

  /// 无障碍：开 → 先确认，再由本机 uid 2000 直接写系统设置；关 → 直接写。
  ///
  /// **为什么开的那一下要多一道确认。** 这是整个 App 唯一一处会写
  /// Settings.Secure 的地方，而 enabled_accessibility_services 正是安卓
  /// 故意不给 App 自己碰的那个键——拿到它等于能读所有 App 的屏幕内容、
  /// 能模拟点按输入，也就是 stalkerware 的原语。所以那道确认框不是客套，
  /// 是把「即将写入什么、去哪里撤销」讲清楚，让同意是有知的同意。
  /// 关的那一下不需要：它在收缩能力，没有可被误导的方向。
  ///
  /// 写失败时不假装成功，也不静默跳系统设置——把 reason 摆出来，让用户
  /// 自己决定是去系统设置手动开，还是先去把提权通道弄起来。
  Future<void> _toggleAccessibility(bool value) async {
    if (_a11yBusy) return;
    if (value) {
      final go = await _confirmEnableAccessibility();
      if (!go) return;
    }
    setState(() => _a11yBusy = true);
    try {
      final r = value
          ? await DeviceControl.enableAccessibility()
          : await DeviceControl.disableAccessibility();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(r.message),
          backgroundColor: r.ok ? null : AppPalette.of(context).warning,
          action: (!r.ok)
              ? SnackBarAction(
                  label: '去系统设置',
                  onPressed: () => DeviceControl.openAccessibilitySettings(),
                )
              : null,
        ),
      );
    } finally {
      await _refreshCapabilities();
      if (mounted) setState(() => _a11yBusy = false);
    }
  }

  /// 开启前的确认框。返回 true 才动笔。
  Future<bool> _confirmEnableAccessibility() async {
    final palette = AppPalette.of(context);
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: palette.surface,
        title: const Text('开启无障碍服务'),
        content: const Text(
          'App 会写一条系统设置，把自己的无障碍服务打开。\n\n'
          '打开后它可以读取屏幕内容、模拟点按和输入文字——'
          '这正是界面自动化需要的。\n\n'
          '另外：更新或重装这个 App 之后，系统会把这个授权清掉，'
          'App 会按你这次的选择把它恢复，并发一条通知告诉你。'
          '不想要这个行为，可在下方「重装后自动恢复无障碍」关掉。\n\n'
          '随时也可在 系统设置 › 辅助功能 › 无障碍 里直接关掉。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('开启'),
          ),
        ],
      ),
    );
    return go == true;
  }

  /// 提权通道是否可用，用于在开关下面提前说明，而不是失败了再解释。
  Future<void> _refreshA11yAdvice() async {
    final a = await DeviceControl.accessibilitySetupAdvice();
    final r = await DeviceControl.isA11yAutoRestoreOn();
    if (!mounted) return;
    setState(() {
      _a11yAdvice = a;
      _a11yAutoRestore = r;
    });
  }

  /// 重装后自动恢复无障碍。见 UI 处注释：这是唯一一处会把「读屏幕」权限
  /// 在自己更新之后重新拿回来的开关，所以它自己也要说清后果。
  Future<void> _toggleA11yAutoRestore(bool value) async {
    if (_autoRestoreBusy) return;
    setState(() => _autoRestoreBusy = true);
    try {
      final ok = await DeviceControl.setA11yAutoRestore(value);
      if (!mounted) return;
      setState(() {
        _a11yAutoRestore = ok ? value : _a11yAutoRestore;
        _autoRestoreBusy = false;
      });
      if (!ok) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('设置没写进去，开关保持原样——没有假装成功'),
        ));
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(value
            ? '已开：下次更新/重装后会恢复无障碍授权，并通知你'
            : '已关：下次更新/重装后不再自动恢复'),
      ));
    } finally {
      if (mounted) setState(() => _autoRestoreBusy = false);
    }
  }

  /// 截屏：开 → 走 MediaProjection 授权并启动；关 → 直接停。
  Future<void> _toggleScreenCapture(bool value) async {
    if (_captureBusy) return;
    setState(() => _captureBusy = true);
    try {
      if (value) {
        await DeviceControl.startScreenCapture();
      } else {
        await DeviceControl.stopScreenCapture();
      }
    } finally {
      await _refreshCapabilities();
      if (mounted) setState(() => _captureBusy = false);
    }
  }

  /// 手机桥起停。互斥锁在最前面：_entrySwitch 的 busy 态是把 Switch 整棵摘掉
  /// 而不是禁用，连点会并发发多条 bridgeStart/bridgeStop。
  Future<void> _toggleBridge(bool value) async {
    if (_bridgeBusy) return;
    setState(() => _bridgeBusy = true);
    try {
      final r = value
          ? await DeviceControl.bridgeStart()
          : await DeviceControl.bridgeStop();
      if (!mounted) return;
      if (!r.ok) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(r.message.isEmpty ? '手机桥操作失败' : r.message),
          backgroundColor: AppPalette.of(context).warning,
        ));
      }
    } finally {
      await _refreshBridgeStatus();
      if (mounted) setState(() => _bridgeBusy = false);
    }
  }

  /// 工作悬浮框显隐。只动悬浮框，不停桥——两者可各自存活。
  Future<void> _toggleOverlay(bool value) async {
    if (_overlayBusy) return;
    // 没权限时不起服务，直接引去授权页：原生侧也会拒，但那一跳是异步的，
    // 用户看不到任何反馈，这里给一句明确的引导。
    if (value && !(_bridgeStatus?.overlayGranted ?? false)) {
      await DeviceControl.requestOverlay();
      return;
    }
    setState(() => _overlayBusy = true);
    try {
      final r = value
          ? await DeviceControl.overlayShow()
          : await DeviceControl.overlayHide();
      if (!mounted) return;
      if (!r.ok) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(r.message.isEmpty ? '悬浮框操作失败' : r.message),
          backgroundColor: AppPalette.of(context).warning,
        ));
      }
    } finally {
      await _refreshBridgeStatus();
      if (mounted) setState(() => _overlayBusy = false);
    }
  }

  /// 读一次两个能力的真实状态。
  ///
  /// 单独一个方法而不是塞进 _refreshBridgeStatus：授权发生在系统设置或系统
  /// 对话框里，用户回到 App 时这两个状态已经变了，必须重新读——沿用旧值就会
  /// 显示一个和现实相反的开关。
  Future<void> _refreshCapabilities() async {
    final a11y = await DeviceControl.isAccessibilityReady();
    final cap = await DeviceControl.isScreenCaptureReady();
    if (!mounted) return;
    setState(() {
      _a11yOn = a11y;
      _captureOn = cap;
    });
  }

  /// 令牌行：把「是否落盘」说成人能动手的一句话。PC 侧只认 token.txt，
  /// 令牌只在内存时桥看着在线、每个请求却 401。
  String _tokenSubtitle(BridgeStatus st) {
    if (st.tokenMasked.isEmpty) {
      return '启动后生成（完整值在本机 token.txt）';
    }
    if (st.tokenPersisted == false) {
      return '令牌未落盘（PC 会一直 401）——去授「所有文件访问」后重启桥';
    }
    final persisted = st.tokenPersisted == null ? '未知（旧版桥未上报）' : '是';
    return '令牌已落盘：$persisted · ${st.tokenMasked}';
  }

  String _describeHttpStatus(int code) {
    switch (code) {
      case 400: return '请求参数错误';
      case 401: return 'API Key 无效或过期';
      case 403: return '权限不足';
      case 404: return '模型或路径不存在';
      case 429: return '请求过频，请稍后重试';
      case 500: return '服务器内部错误';
      case 502: return '网关错误';
      case 503: return '服务不可用';
      case 504: return '网关超时';
      default: return '未知错误';
    }
  }

  Widget _card(AppPalette palette, List<Widget> children) {
    // Material 而不是 Container：Container 的 decoration 是一层 DecoratedBox，
    // 它会把 ListTile 的墨水反馈挡在「最近的 Material 祖先」之外——卡里每一行
    // 点下去都没有任何视觉确认（而这里全是可点的行：去开启／启动／去授权）。
    // elevation: 0 + 不 clip，外观与原来的 Container 逐像素一致，
    // 只是让 ink 有着落的地方。这个缺陷是给「系统能力」写测试时才暴露的：
    // 之前的测试从没把设置页滚到这张卡。
    return Material(
      color: palette.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        side: BorderSide(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.dense),
        child: Column(children: children),
      ),
    );
  }

  /// 点了「端点未配置」的项时说明原因。
  ///
  /// 不静默跳过，也不把空 Base URL 填进输入框：两者都会让用户以为点了没坏就是
  /// 成功了，然后在一个空端点上排查半天。
  void _explainMissingEndpoint(String name) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('$name：端点未随包提供'),
        content: const Text(
          '这个包的构建没有带上该提供商的端点。\n\n'
          '端点和内置密钥一样只在开发者本机生成、不提交进仓库，'
          '所以从仓库构建出来的包里它是空的。\n\n'
          '本机执行：\n'
          '  python scripts/gen_keys.py\n'
          '把输出的数组贴回 lib/core/config/built_in_keys.dart，'
          '重新打包后这一项即可用。\n\n'
          '在那之前你仍然可以在下方「API 配置」里手填 Base URL / Key / 模型。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('知道了'),
          ),
        ],
      ),
    );
  }

  Widget _presetTile(String name, BuiltInProvider p, AppPalette palette) {
    final isActive = _config?.baseUrl == p.baseUrl;
    final hasKey = p.hasKey;
    // 端点未配置 = 这个包没带上端点（本机还没跑 gen_keys.py 贴回数组）。
    // 这一项必须说得清，否则用户点下去只会得到一个连不上的空 Base URL——
    // 而界面看起来和别的项一模一样。
    final noEndpoint = !p.endpointConfigured;
    return PressableScale(
      onTap: noEndpoint
          ? () => _explainMissingEndpoint(name)
          : () {
              setState(() {
                _baseUrl.text = p.baseUrl;
                _model.text = p.defaultModel;
                if (hasKey) {
                  _apiKey.text = ''; // Clear user key → use built-in
                }
              });
            },
      child: Container(
        margin: const EdgeInsets.only(bottom: AppSpacing.cardGap),
        padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.cardPadNarrow,
            vertical: AppSpacing.cardPadNarrow),
        decoration: BoxDecoration(
          color: isActive
              ? palette.primary.withValues(alpha: 0.10)
              : palette.surface,
          borderRadius: BorderRadius.circular(AppRadius.medium),
          border: Border.all(
            color: isActive ? palette.primary : palette.stroke,
            width: isActive ? 1.2 : AppStroke.thin,
          ),
        ),
        child: Row(
          children: [
            if (!isActive && hasKey) ...<Widget>[
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                    color: palette.success, shape: BoxShape.circle),
              ),
              const SizedBox(width: AppSpacing.inner),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppText.body.copyWith(
                          fontWeight: FontWeight.w600,
                          color: palette.textPrimary)),
                  Text(
                    // 原来是 '需填写密钥'。那句话在 R2 之下恒真——没有任何内置供应商
                    // 携带明文 key（这是红线要求的）——于是每一行都显示"需填写密钥"，
                    // 包括用户明明已经填好自己的 key 的那些。标签描述的是"有没有内置
                    // 密钥"，读起来却像"你还没配"，两件事被混成了一件。
                    //
                    // 改成陈述事实：没有内置密钥，模型数照给。
                    //
                    // 端点未配置时那句话要让位——它是更前面的阻塞：连端点都没有，
                    // 谈密钥和模型数都没有意义。
                    noEndpoint
                        ? '端点未配置（本机跑 scripts/gen_keys.py 贴回后生效）'
                        : hasKey
                            ? '内置密钥 · ${p.models.length} 个模型'
                            : '无内置密钥 · ${p.models.length} 个模型',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.secondary.copyWith(
                        // 端点没配是唯一需要用户马上动手的事；其余保持中性。
                        color: noEndpoint
                            ? palette.warning
                            : (!hasKey && isActive)
                                ? palette.warning
                                : palette.textSecondary),
                  ),
                ],
              ),
            ),
            if (isActive) ...<Widget>[
              const SizedBox(width: AppSpacing.dense),
              Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.dense, vertical: 2),
                decoration: BoxDecoration(
                  color: palette.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(AppRadius.pill),
                ),
                child: Text('使用中',
                    style: AppText.label.copyWith(color: palette.primary)),
              ),
            ] else if (!hasKey) ...<Widget>[
              const SizedBox(width: AppSpacing.dense),
              Icon(Icons.chevron_right, size: 18, color: palette.textFaint),
            ],
          ],
        ),
      ),
    );
  }

  Widget _modelSelector(AppPalette palette) {
    final currentModel = _model.text.isEmpty ? '选择模型' : _model.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Model',
            style: AppText.secondary.copyWith(color: palette.textSecondary)),
        const SizedBox(height: 4),
        GestureDetector(
          onTap: () => _showModelDialog(palette),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.cardPadNarrow, vertical: 12),
            decoration: BoxDecoration(
              color: palette.surfaceHigh,
              borderRadius: BorderRadius.circular(AppRadius.medium),
              border: Border.all(
                  color: palette.stroke, width: AppStroke.thin),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    currentModel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.body.copyWith(
                      color: _model.text.isEmpty
                          ? palette.textFaint
                          : palette.textPrimary,
                    ),
                  ),
                ),
                if (_loadingModels)
                  SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: palette.primary),
                  )
                else
                  Icon(Icons.expand_more, size: 20, color: palette.textSecondary),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _showModelDialog(AppPalette palette) async {
    await _loadModels();
    if (!mounted) return;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Row(
            children: [
              const Text('选择模型'),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh, size: 20),
                onPressed: _loadingModels
                    ? null
                    : () async {
                        setDialogState(() => _loadingModels = true);
                        await _loadModels(forceRefresh: true);
                        setDialogState(() => _loadingModels = false);
                      },
                tooltip: '刷新模型列表',
              ),
            ],
          ),
          content: SizedBox(
            width: double.maxFinite,
            height: 400,
            child: _loadingModels
                ? const Center(child: CircularProgressIndicator())
                : _availableModels.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.cloud_off,
                                size: 40, color: palette.textFaint),
                            const SizedBox(height: AppSpacing.dense),
                            Text('无法加载模型列表',
                                style: TextStyle(color: palette.textSecondary)),
                            const SizedBox(height: 4),
                            Text('请检查网络后刷新',
                                style: TextStyle(
                                    fontSize: 11,
                                    color: palette.textFaint)),
                          ],
                        ),
                      )
                    : ListView.builder(
                        itemCount: _availableModels.length,
                        itemBuilder: (_, i) {
                          final m = _availableModels[i];
                          final isSelected = _model.text == m.id;
                          return ListTile(
                            dense: true,
                            title: Text(m.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: isSelected
                                        ? FontWeight.w600
                                        : FontWeight.normal)),
                            subtitle: m.name != m.id
                                ? Text(m.id,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 11))
                                : null,
                            trailing: isSelected
                                ? Icon(Icons.check,
                                    size: 18, color: palette.primary)
                                : null,
                            onTap: () {
                              setState(() => _model.text = m.id);
                              Navigator.pop(ctx);
                            },
                          );
                        },
                      ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('取消'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _loadModels({bool forceRefresh = false}) async {
    if (_loadingModels && !forceRefresh) return;
    setState(() => _loadingModels = true);

    final baseUrl = _baseUrl.text.trim();
    final apiKey = _apiKey.text.trim().isEmpty
        ? BuiltInKeys.getBuiltInKey(baseUrl)
        : _apiKey.text.trim();

    if (baseUrl.isNotEmpty && apiKey.isNotEmpty) {
      final models = await ModelRegistry.fetchModels(baseUrl, apiKey);
      if (models.isNotEmpty) {
        setState(() {
          _availableModels = models;
          _loadingModels = false;
        });
        return;
      }
    }

    // 降级：使用内置默认模型列表
    final providerName = BuiltInKeys.matchBaseUrl(baseUrl);
    if (providerName != null) {
      setState(() {
        _availableModels = ModelRegistry.getDefaultModels(providerName);
        _loadingModels = false;
      });
    } else {
      setState(() {
        _availableModels = [];
        _loadingModels = false;
      });
    }
  }

  Widget _labeledField(String label, TextEditingController ctrl,
      {String hint = '',
      required AppPalette palette,
      required FocusNode focusNode,
      bool multiline = false}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: AppText.secondary.copyWith(color: palette.textSecondary)),
        const SizedBox(height: 4),
        _focusGlow(
          focusNode,
          TextField(
            controller: ctrl,
            focusNode: focusNode,
            maxLines: multiline ? 3 : 1,
            decoration: InputDecoration(
              hintText: hint,
              isDense: true,
            ),
          ),
        ),
      ],
    );
  }

  Widget _labeledFieldWithToggle(String label, TextEditingController ctrl,
      {String hint = '',
      required AppPalette palette,
      bool visible = false,
      required VoidCallback onToggle}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: AppText.secondary.copyWith(color: palette.textSecondary)),
        const SizedBox(height: 4),
        Row(
          children: [
            Expanded(
              child: _focusGlow(
                _apiKeyFocus,
                TextField(
                  controller: ctrl,
                  focusNode: _apiKeyFocus,
                  obscureText: !visible,
                  decoration: InputDecoration(
                    hintText: hint,
                    isDense: true,
                  ),
                ),
              ),
            ),
            IconButton(
              icon: Icon(
                  visible ? Icons.visibility : Icons.visibility_off,
                  size: 20,
                  color: palette.textSecondary),
              onPressed: onToggle,
            ),
          ],
        ),
      ],
    );
  }

  Widget _listTileAction(AppPalette palette, IconData icon,
      String title, String subtitle, VoidCallback onTap) {
    return ListTile(
      leading: _leadingDisc(icon, palette, palette.primary),
      title: Text(title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: _tileTitle(palette)),
      subtitle: Text(subtitle,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: _tileSubtitle(palette)),
      trailing: Icon(Icons.chevron_right, color: palette.textFaint),
      onTap: onTap,
    );
  }

  /// 焦点光晕包在输入框外层：主题只接管描边与底色，glowSoft 得自己挂。
  Widget _focusGlow(FocusNode node, Widget child) {
    return AnimatedContainer(
      duration: AppDuration.micro,
      curve: AppCurves.standard,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        boxShadow: node.hasFocus ? AppShadows.glowSoft : null,
      ),
      child: child,
    );
  }

  /// ListTile 行首统一 36dp 圆盘；状态只染图标，盘底恒为 primary 10%。
  ///
  /// 颜色翻转走 AnimatedContainer + AppDuration.micro + AppCurves.standard，
  /// 和 [_focusGlow] 同一套词汇。放在这个 helper 里而不是各调用点：本页所有
  /// 卡内行的圆盘都因此统一过渡，且不新增任何时长或曲线常量。micro 不是循环
  /// 动画，所以不读 MediaQuery.disableAnimations——与 [_focusGlow] 保持一致，
  /// 不在本文件引入第二种约定。
  ///
  /// 两个新开关（手机桥、工作悬浮框）的行首盘不在这里：它们走 [_entrySwitch]，
  /// 那一家的盘是固定 primary 色、没有状态要翻（在线/离线由 Switch 自己的
  /// thumb 表达）。要给它也染状态色，得给 helper 加参数——那会动到现有五个
  /// 调用点，所以没做。
  Widget _leadingDisc(IconData icon, AppPalette palette, Color iconColor) {
    return AnimatedContainer(
      duration: AppDuration.micro,
      curve: AppCurves.standard,
      width: 36,
      height: 36,
      decoration: BoxDecoration(
        color: palette.primary.withValues(alpha: 0.10),
        shape: BoxShape.circle,
      ),
      child: Icon(icon, size: 18, color: iconColor),
    );
  }

  /// 行尾动作统一为高 32 的描边胶囊。
  Widget _actionCapsule(BuildContext context, String label, VoidCallback onTap) {
    final palette = AppPalette.of(context);
    return SizedBox(
      height: 32,
      child: OutlinedButton(
        onPressed: onTap,
        style: OutlinedButton.styleFrom(
          foregroundColor: palette.primary,
          side: BorderSide(color: palette.primary.withValues(alpha: 0.35)),
          shape: const StadiumBorder(),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.dense),
          minimumSize: const Size(0, 32),
          textStyle: AppText.secondary.copyWith(fontWeight: FontWeight.w600),
        ),
        child: Text(label),
      ),
    );
  }

  /// 列表行的统一字号：标题走 body 14/w600，说明走 secondary 12。
  TextStyle _tileTitle(AppPalette palette) =>
      AppText.body.copyWith(color: palette.textPrimary, fontWeight: FontWeight.w600);

  TextStyle _tileSubtitle(AppPalette palette) =>
      AppText.secondary.copyWith(color: palette.textSecondary);
}
