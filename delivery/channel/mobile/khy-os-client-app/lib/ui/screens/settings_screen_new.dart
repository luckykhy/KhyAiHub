// khy-canary: Khy-20261101-119-QHHJQ2R2
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:dio/dio.dart';
import '../../core/config/app_config.dart';
import '../../core/config/built_in_keys.dart';
import '../../core/config/model_registry.dart';
import '../../core/config/permission_mode.dart';
import '../../core/db/amoo_mirror_store.dart';
import '../../core/drivers/driver_channel.dart';
import '../../core/floating/floating_task_hub.dart';
import '../../core/gateway/zen_errors.dart';
import '../../core/gateway/zen_gate.dart';
import '../../core/mirror/amoo_mirror_sync.dart';
import '../../core/services/app_logger.dart';
import '../../core/services/device_control.dart';
import '../../ui/theme/app_colors.dart';
import '../../ui/theme/design_tokens.dart';
import '../../ui/widgets/amoo_mirror_config_section.dart';
import '../../ui/widgets/local_model_section.dart';
import '../../ui/widgets/vision_config_section.dart';
import '../../ui/widgets/aurora.dart';
import '../../ui/widgets/project_info_card.dart';
import '../../ui/widgets/debug_net_capture_card.dart';
import 'amoo_mirror_list_screen.dart';
import 'network_diagnostic_screen.dart';
import 'log_viewer_screen.dart';
import 'permission_center_screen.dart';
import 'task_status_screen.dart';
import 'trajectory_screen.dart';
import 'vfs_settings_screen.dart';
import 'wechat_link_screen.dart';

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
  /// 版本号连点计数与调试菜单代次。代次一变，抓包面板换 key 重建，
  /// 它自己会重新读一次解锁状态——比在这里镜像一份布尔值可靠。
  int _versionTaps = 0;
  int _debugEpoch = 0;

  static const _debugChannel = MethodChannel('com.khyos.khy_os_client/device');

  Future<void> _onVersionTap() async {
    _versionTaps++;
    if (_versionTaps < 7) return;
    _versionTaps = 0;
    try {
      await _debugChannel.invokeMethod<Map<dynamic, dynamic>>(
          'netDebugUnlock', <String, dynamic>{'unlocked': true});
    } catch (_) {}
    if (!mounted) return;
    setState(() => _debugEpoch++);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('调试菜单已解锁：设置页底部出现「网络抓包（调试）」')),
    );
  }

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

  /// 新建对话默认是否同步到电脑。默认开——用户选的就是默认同步。
  /// 单对话可以在聊天页的同步面板里单独关掉，这里只管默认值。
  bool _sessionSyncOn = true;
  bool _sessionSyncBusy = false;

  /// amoo driver 开关。true = 启用（**没被禁用**）——取值取反是因为界面上
  /// 一个「开着」的开关必须对应「这个 driver 能用」，而不是对应内部名单里
  /// 没有它：后者在名单为空时也是「没禁用」，两种true不是一回事。
  bool _amooDriverOn = true;
  bool _amooDriverBusy = false;

  /// 任务悬浮胶囊（悬浮状态增量）。开关镜像 AppConfig 的
  /// floatingOverlayEnabled；授权位进页时现问（发生在 App 之外，同上面
  /// 两个系统开关的理由，不缓存进 build）。授权状态本身不再缓存：纯授权行
  /// 已收敛进权限中心（2026-11-15），这里只剩「没授权就去授权页」的判断，
  /// 那条路现查 PermissionStatus，不用一份会过期的镜像。
  bool _floatingOn = false;
  bool _floatingBusy = false;

  // 一键开关当前是否可用，以及为什么。空串=还没问到。
  // 不缓存成"问一次就信"：sidecar 重启后就没了，每次进设置页重问，
  // 免得给用户一个过期的一次性结论。
  String _a11yAdvice = '';
  bool _a11yAutoRestore = false;
  bool _autoRestoreBusy = false;

  /// 对话记录镜像的同步器，只作配置块 `acknowledgePairing()` 的目标。
  ///
  /// 纪律：禁止用它读 state / 显示 readiness——「同一实例」的约定只在列表页与
  /// 详情页之间成立（详情页由列表页注入），设置页这个是无态旁路，配完令牌把
  /// 闸门打开就完事。
  final AmooMirrorSync _amooMirrorSync =
      AmooMirrorSync(cache: AmooMirrorStore.instance);

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
      _sessionSyncOn = c.sessionSyncEnabled;
      _amooDriverOn = !c.isDriverDisabled('amoo');
      _floatingOn = c.floatingOverlayEnabled;
    });
  }

  /// 任务悬浮胶囊开关。开 = 写 AppConfig + 把悬浮状态层拉起来（它自己会写
  /// 一份 idle 快照，悬浮窗据此知道当前没任务）；没授权时打开开关会被引去
  /// 授权页，开关保持关——与 _toggleOverlay 同一条「不装样子」的纪律。
  /// 关 = 状态层收摊并写一份 floating=false 的 idle，把残留胶囊收下去。
  Future<void> _toggleFloatingOverlay(bool value) async {
    if (_floatingBusy) return;
    setState(() => _floatingBusy = true);
    try {
      if (value) {
        final p = await DeviceControl.checkPermissions();
        if (!mounted) return;
        if (!p.overlay) {
          await DeviceControl.requestOverlay();
          if (!mounted) return;
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('先在系统设置里授权「显示在其他应用上层」，回来再打开'),
          ));
          return;
        }
      }
      await AppConfig.save(floatingOverlayEnabled: value);
      await FloatingTaskHub.instance.setFloatingEnabled(value);
      if (!mounted) return;
      setState(() => _floatingOn = value);
    } finally {
      if (mounted) setState(() => _floatingBusy = false);
    }
  }

  /// 改全局默认。
  ///
  /// 这是一个真开关：写进 AppConfig 立刻生效，下次新建对话就用它。但它
  /// **只影响没单独表过态的对话**——已经单独关掉的对话不会因为这里打开
  /// 就被悄悄重新打开，那是替用户改他做过的决定。
  Future<void> _toggleSessionSync(bool value) async {
    setState(() => _sessionSyncBusy = true);
    try {
      await AppConfig.save(sessionSyncEnabled: value);
      await _load();
    } finally {
      if (mounted) setState(() => _sessionSyncBusy = false);
    }
  }

  /// 一键禁用/启用 amoo driver（§5.1）。
  ///
  /// 两步写，缺一不可：原生侧 DriverGate 决定六方法门和桥 HTTP 工具族放不放行；
  /// Flutter 侧 AppConfigData.disabledDrivers 决定 registry 出不出场。
  ///
  /// 原生门先写：它不依赖本地存储，存储服务坏掉时桥侧仍然安全。本地配置
  /// 存储失败时如实分开说——那一半（registry 出场）要等重启才恢复，
  /// 装作两个都写成功了，用户会以为禁用已完全生效。
  Future<void> _toggleAmooDriver(bool value) async {
    setState(() => _amooDriverBusy = true);
    try {
      final synced = await DriverChannel.setDriverEnabled('amoo', value);
      if (!synced && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('原生侧开关未接上（APK 可能太旧）：桥 HTTP 入口的'
              'amoo 工具族暂时还会放行'),
          duration: Duration(seconds: 4),
          behavior: SnackBarBehavior.floating,
        ));
      }
      try {
        final current = await AppConfig.load();
        final next = toggleDisabled(current.disabledDrivers, 'amoo', value);
        await AppConfig.save(disabledDrivers: next);
      } catch (_) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('本地配置保存失败：原生门已生效，但本机 registry '
                '仍会带 amoo，重启后恢复'),
            duration: Duration(seconds: 4),
            behavior: SnackBarBehavior.floating,
          ));
        }
        return;
      }
      await _load();
    } finally {
      if (mounted) setState(() => _amooDriverBusy = false);
    }
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
    } catch (e) {
      // 落盘失败就停在这里：不能接着 _load()，那会把用户刚填/刚选的值
      // 擦回旧配置，看起来像"保存成功但内容没了"。给一句可行动的提示。
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('保存失败：$e'),
            backgroundColor: AppPalette.of(context).warning,
            duration: const Duration(seconds: 3),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
      return;
    } finally {
      setState(() => _saving = false);
    }
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
      final resp = await d.get('$url/models',
          options: Options(
            // Zen 端点带指纹；只发 Authorization 会 403，看起来像 key 无效。
            headers: await ZenGate.requestHeaders(
              baseUrl: url,
              apiKey: effectiveKey,
            ),
            // 自己判 4xx：放行后一律当成功的话，403 会显示「连接成功」。
            validateStatus: (s) => s != null,
          ));
      if (isSuccessful(resp.statusCode)) {
        setState(() => _testResult = '连接成功');
      } else {
        final verdict = classify(resp.statusCode, bodyFromData(resp.data));
        setState(() => _testResult = verdict.message);
      }
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
          final verdict = classify(code, bodyFromData(e.response?.data));
          _testResult = verdict.kind == ZenErrorKind.unknown
              ? 'HTTP $code：${_describeHttpStatus(code)}'
              : verdict.message;
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
            // ── Section: 权限中心 ──
            // 统一权限入口（2026-11-15 用户拍板收敛）：所有授权位一行一项
            // （状态灯 + 去授权直达）都在权限中心里。原来散在手机桥卡、任务
            // 悬浮、设备页的纯授权行全部并进那一页；开关是「操作」，留在
            // 原位。汇总卡自带实时快照（init/resumed 各查一次），缺哪几样
            // 一瞥即知。
            const SectionTitle(title: '权限中心', icon: Icons.verified_user_outlined),
            const SizedBox(height: AppSpacing.dense),
            const _PermissionSummaryCard(),
            const SizedBox(height: AppSpacing.section),

            // ── Section: Provider Presets ──
            // 2026-11-15 用户要求：10 个提供商不再平铺成卡片。平铺时这一节要滚
            // 两三屏，而用户真正做的动作只有一个——选哪一个；每张卡的第二行还在
            // 重复同一句密钥状态。清单本身没删：点开字段是同一份名单，顺序、状态
            // 副标签、端点未配置的说明、选中即填 Base URL + 默认模型的行为照旧。
            const SectionTitle(title: '内置提供商', icon: Icons.router),
            const SizedBox(height: AppSpacing.dense),
            Text(
              // 原来写死「已内置密钥」。仓库消毒后所有内置数组都是空的，这句话
              // 就会和清单里每行的「无内置密钥」互相打脸。改成按实际数量说。
              // 判据用 canSend（端点 + 有一把能用的 bearer）：免费档的 bearer 是
              // public，hasKey 恒 false，只看它会说"没有可用通道"。
              !BuiltInKeys.providers.values.any((p) => p.canSend)
                  ? '当前构建没有内置密钥：选择提供商后，在下方 API 配置里填写 Key 即可使用'
                  : BuiltInKeys.providers.values.any((p) => p.hasKey)
                      ? '带绿点的提供商已内置密钥，选择即可用；其余选择后在下方 API 配置里填写 Key'
                      : '本构建没有内置账号密钥；标记「免费档」的提供商无需密钥，其余需在下方填写 Key',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
            const SizedBox(height: AppSpacing.dense),
            _providerSelector(palette),
            const SizedBox(height: AppSpacing.section),

          // ── Section: API Config ──
          const SectionTitle(title: 'API 配置', icon: Icons.key),
          const SizedBox(height: AppSpacing.dense),
          // 免费档提示：public 不是账号额度，走的是上游匿名共享池。
          // 这句话必须写在 key 输入框上方——用户在 429 时第一反应是"我是不是该换网络"，
          // 而实测换网络/换模型/换设备都无效，唯一有效的是换成账号 Key。
          if (_config != null &&
              !_config!.hasUserKey &&
              _config!.isKeylessProvider)
            Container(
              margin: const EdgeInsets.only(bottom: AppSpacing.dense),
              padding: const EdgeInsets.all(AppSpacing.dense),
              decoration: BoxDecoration(
                color: palette.warning.withValues(alpha: AppAlpha.weakFill),
                borderRadius: BorderRadius.circular(AppRadius.small),
                border: Border.all(
                    color: palette.warning.withValues(alpha: AppAlpha.strokeWeak),
                    width: AppStroke.thin),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.info_outline, size: 16, color: palette.warning),
                  const SizedBox(width: AppSpacing.dense),
                  Expanded(
                    child: Text(
                      '免费档：默认走匿名共享池，无需 Key——但该池可能被其它人用光（429，'
                      '换网络/换模型都无效）。填入账号 Key（opencode 官网登录后只勾免费模型生成）'
                      '即走账号额度，更稳定',
                      style: AppText.secondary.copyWith(color: palette.warning),
                    ),
                  ),
                ],
              ),
            ),
          // Built-in key indicator
          if (_config != null &&
              !_config!.hasUserKey &&
              _config!.hasBuiltInKey &&
              !_config!.isKeylessProvider)
            Container(
              margin: const EdgeInsets.only(bottom: AppSpacing.dense),
              padding: const EdgeInsets.all(AppSpacing.dense),
              decoration: BoxDecoration(
                color: palette.success.withValues(alpha: AppAlpha.weakFill),
                borderRadius: BorderRadius.circular(AppRadius.small),
                border: Border.all(
                    color: palette.success.withValues(alpha: AppAlpha.strokeWeak),
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
                color: palette.warning.withValues(alpha: AppAlpha.weakFill),
                borderRadius: BorderRadius.circular(AppRadius.small),
                border: Border.all(
                    color: palette.warning.withValues(alpha: AppAlpha.strokeWeak),
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
                hint: '粘贴服务商提供的 API Key',
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
          ], outlined: false),
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
            _listTileAction(
              palette, Icons.account_tree_outlined, '执行记录',
              '按会话查看工具执行轨迹，可验哈希链',
              () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const TrajectoryScreen())),
            ),
            // Amoo 对话记录镜像：与上面几行同属「只读记录查看器」，入口文案
            // 不带 Amoo 前缀是因为设置页里 amoo 相关开关已经在讲另一件事
            // （拉起 amoo 反代），混在一起会让人以为这个也会开 amoo。
            _listTileAction(
              palette, Icons.forum_outlined, '对话记录',
              '查看 Amoo 的历史会话与消息（只读镜像，不拉起 Amoo）',
              () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const AmooMirrorListScreen())),
            ),
            // 悬浮状态增量：执行记录看的是「已落盘的历史」，这一行看的是
            // 「正在跑的这一个」——快照直推，可就地补指令。
            _listTileAction(
              palette, Icons.monitor_heart_outlined, '任务副屏',
              '实时看当前任务的步骤与结果，可就地补指令',
              () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const TaskStatusScreen())),
            ),
          ]),
          const SizedBox(height: AppSpacing.section),

          // 对话记录镜像的配置块跟入口放在同一节：端点与 device_token 是这条
          // 只读链路唯一需要用户出手的地方，单独拆到别的节要多滚一屏。
          AmooMirrorConfigSection(sync: _amooMirrorSync),
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
                  // 「所有文件访问」「无障碍服务」两张纯授权行搬进权限中心了
                  // （2026-11-15 收敛）：桥卡只留桥自己的状态（协作模式/令牌），
                  // 授权位的状态与去授权在权限中心逐项看。
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
                // 未授权时不再补「悬浮窗权限」行：授权位的状态与去授权已收敛进
                // 权限中心（页顶入口卡）。开关保持「不装样子」的纪律——没授权
                // 时打开会被引去授权页，开关保持关。
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
          // ── Section: 会话同步 ──
          //
          // 这是**默认值**，不是总开关：聊天页头部那颗 chip 可以给单个对话
          // 单独关掉。把它放在设置页是因为"消息去不去电脑"是一个长期决定，
          // 不该每开一个对话都要重新想一次。
          const SectionTitle(title: '会话同步', icon: Icons.cloud_sync_outlined),
          const SizedBox(height: AppSpacing.dense),
          _entrySwitch(
            icon: Icons.cloud_sync_outlined,
            title: '默认同步到电脑',
            subtitle: _sessionSyncOn
                ? '开：没单独设置过的对话都写进电脑的共享会话'
                : '关：这些对话只存本机；电脑上已有的副本保留',
            value: _sessionSyncOn,
            busy: _sessionSyncBusy,
            onChanged: _toggleSessionSync,
            switchKey: const Key('session-sync-switch'),
          ),
          const SizedBox(height: AppSpacing.section),
          // ── Section: 助手 driver ──
          //
          // amoo 只是 driver 之一。这一节是「执行器不绑定任何助手」的用户面：
          // 关掉它，local / pc-bridge / script 与全部工具照常可用——所以文案
          // 必须把「关掉之后什么还活着」说在前面，而不是写成「停用 amoo」。
          const SectionTitle(title: '助手 driver', icon: Icons.extension_outlined),
          const SizedBox(height: AppSpacing.dense),
          _entrySwitch(
            icon: Icons.extension_outlined,
            title: 'amoo 反代',
            subtitle: _amooDriverOn
                ? '开：可把提问交给本机 amoo，并等待它的回复'
                : '关：amoo driver 已禁用，其余 driver、本地模型与全部工具照常可用',
            value: _amooDriverOn,
            busy: _amooDriverBusy,
            onChanged: _toggleAmooDriver,
            switchKey: const Key('amoo-driver-switch'),
          ),
          const SizedBox(height: AppSpacing.section),
          // ── Section: 微信 bot ──
          //
          // 入口只带路：扫码绑定与通道起停都在 WeChatLinkScreen 里（屏内那颗
          // SwitchListTile 直接调 IlinkWeChatGate）。同一 bot_token 全设备只允许
          // 一个轮询消费者，这里不再放第二颗开关跟屏内那颗打架。
          const SectionTitle(title: '微信 bot', icon: Icons.forum_outlined),
          const SizedBox(height: AppSpacing.dense),
          _listTileAction(
            palette, Icons.qr_code_2, '微信 bot',
            '扫码绑定 bot 账号，起停微信通道',
            () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const WeChatLinkScreen())),
          ),
          const SizedBox(height: AppSpacing.section),
          // ── Section: 任务悬浮 ──
          //
          // 任务执行期间在系统悬浮窗里画一枚进度胶囊（可展开看步骤、就地补
          // 指令、批准 ask 工具）。开关只管「要不要」：胶囊画在一切应用之上，
          // 是常驻屏面的可见侵入，默认关；画不画得成还差一道系统授权——
          // 没授权时打开开关会被引去授权页，开关保持关。
          const SectionTitle(title: '任务悬浮', icon: Icons.picture_in_picture_alt_outlined),
          const SizedBox(height: AppSpacing.dense),
          _entrySwitch(
            icon: Icons.picture_in_picture_alt_outlined,
            title: '任务悬浮胶囊',
            subtitle: _floatingOn
                ? '开：任务执行期间屏幕上浮着进度胶囊，可展开看步骤、就地补指令'
                : '关：任务进度只出现在微信与任务副屏里',
            value: _floatingOn,
            busy: _floatingBusy,
            onChanged: _toggleFloatingOverlay,
            switchKey: const Key('floating-overlay-switch'),
          ),
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
          // 取决于 sidecar/提权代理 在不在——那是会随重启变的。
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
          // 断点五：抓包面板。未解锁时它自己渲染成空——不在这里判，
          // 免得两处状态不一致（一处说解锁了、另一处说没有）。
          DebugNetCaptureCard(key: ValueKey('netcap-$_debugEpoch')),
          // 版本号是全 app 唯一落点（首页顶栏不再重复显示）。
          //
          // 连点 7 次解锁调试菜单：这是「人在这台设备旁边」的证据。没有这一步，
          // 抓包工具对 agent 是关着的（见 NetCapture.debugUnlocked 的 fail-closed）。
          GestureDetector(
            onTap: _onVersionTap,
            child: Center(
              child: Text('v1.1',
                  style: AppText.micro.copyWith(color: palette.textFaint)),
            ),
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
      // 单选组由 RadioGroup 祖先承载（groupValue/onChanged 在 Radio 上已废弃）。
      child: RadioGroup<PermissionMode>(
        groupValue: _permissionMode,
        onChanged: (v) {
          if (v != null) _setPermissionMode(v);
        },
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.dense),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('声明了「需询问」的工具，跑之前要不要问你',
                  style:
                      AppText.secondary.copyWith(color: palette.textSecondary)),
              const SizedBox(height: AppSpacing.dense),
              for (final m in PermissionMode.values)
                RadioListTile<PermissionMode>(
                  value: m,
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  // bypass 是唯一会消掉一个安全提示的档，用错误色而不是跟另外三档
                  // 同一个颜色：它不该在视觉上跟前三档平起平坐。远端审批仍然要问
                  // （问的对象换成设备旁的人），用主色，不占用警告/错误两档的语义。
                  activeColor: switch (m) {
                    PermissionMode.bypass => palette.error,
                    PermissionMode.remoteApproval => palette.primary,
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
      return '令牌未落盘（PC 会一直 401）——去「权限中心」授所有文件访问后重启桥';
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

  Widget _card(AppPalette palette, List<Widget> children,
      {bool outlined = true}) {
    // Material 而不是 Container：Container 的 decoration 是一层 DecoratedBox，
    // 它会把 ListTile 的墨水反馈挡在「最近的 Material 祖先」之外——卡里每一行
    // 点下去都没有任何视觉确认（而这里全是可点的行：去开启／启动／去授权）。
    // elevation: 0 + 不 clip，外观与原来的 Container 逐像素一致，
    // 只是让 ink 有着落的地方。这个缺陷是给「系统能力」写测试时才暴露的：
    // 之前的测试从没把设置页滚到这张卡。
    //
    // outlined:false 给回字形卡用：外卡去描边留 surface 底，卡内每个输入件
    // 自带一圈，双层描边叠在一起读起来像一格粗一格格细。
    return Material(
      color: palette.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        side: outlined
            ? BorderSide(color: palette.stroke, width: AppStroke.thin)
            : BorderSide.none,
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

  /// 内置提供商的下拉字段。样式与 [_modelSelector] 刻意保持一致：同一页里
  /// 两枚「点开是清单」的字段长得一样，用户才认得出来这是可点的。
  ///
  /// 显示值取 Base URL 匹配到的提供商名，而不是另存一份「当前选了谁」——
  /// 用户在下面的输入框里手改端点后，这里立刻变回「自定义」，不会出现
  /// 「字段说选了 X、请求实际发去 Y」的分叉。
  Widget _providerSelector(AppPalette palette) {
    final current = BuiltInKeys.matchBaseUrl(_baseUrl.text.trim());
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('提供商',
            style: AppText.secondary.copyWith(color: palette.textSecondary)),
        const SizedBox(height: AppSpacing.micro),
        GestureDetector(
          onTap: () => _showProviderPicker(palette),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.cardPadNarrow,
                vertical: AppSpacing.cardPadNarrow),
            decoration: BoxDecoration(
              color: palette.surfaceHigh,
              borderRadius: BorderRadius.circular(AppRadius.medium),
              border:
                  Border.all(color: palette.stroke, width: AppStroke.thin),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    current ?? '自定义（未使用内置提供商）',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.body.copyWith(
                      color: current == null
                          ? palette.textFaint
                          : palette.textPrimary,
                    ),
                  ),
                ),
                Icon(Icons.expand_more, size: 20, color: palette.textSecondary),
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// 提供商清单——就是原来平铺的那 10 张卡：同样的顺序、同样的状态副标签、
  /// 同样的绿点，只是从一屏装不下收进了一个对话框。
  ///
  /// 端点未配置的项点下去不填任何东西，先说明原因（同原来卡片的行为）：
  /// 把空 Base URL 写进输入框，用户只会在一个连不上的端点上排查半天。
  void _showProviderPicker(AppPalette palette) {
    final entries = BuiltInKeys.providers.entries.toList();
    final current = BuiltInKeys.matchBaseUrl(_baseUrl.text.trim());
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('选择提供商'),
        content: SizedBox(
          width: double.maxFinite,
          height: 400,
          child: ListView.builder(
            itemCount: entries.length,
            itemBuilder: (_, i) {
              final name = entries[i].key;
              final p = entries[i].value;
              final isActive = name == current;
              final noEndpoint = !p.endpointConfigured;
              return ListTile(
                dense: true,
                leading: !isActive && p.hasKey
                    ? Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                            color: palette.success, shape: BoxShape.circle),
                      )
                    : null,
                title: Text(name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.body.copyWith(
                        fontWeight: isActive ? FontWeight.w600 : null)),
                subtitle: Text(
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
                      : p.keyless
                          ? '免费档 · 无需密钥 · ${p.models.length} 个模型'
                          : p.hasKey
                              ? '内置密钥 · ${p.models.length} 个模型'
                              : '无内置密钥 · ${p.models.length} 个模型',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.secondary.copyWith(
                      // 端点没配是唯一需要用户马上动手的事；选中了却还没有 key
                      // （且不是免费档）同样值得提醒。其余保持中性。
                      color: noEndpoint ||
                              (isActive && !p.hasKey && !p.keyless)
                          ? palette.warning
                          : palette.textSecondary),
                ),
                trailing: isActive
                    ? Icon(Icons.check, size: 18, color: palette.primary)
                    : null,
                onTap: () async {
                  Navigator.pop(ctx);
                  if (noEndpoint) {
                    _explainMissingEndpoint(name);
                    return;
                  }
                  setState(() {
                    _baseUrl.text = p.baseUrl;
                    _model.text = p.defaultModel;
                    if (p.hasKey) {
                      _apiKey.text = ''; // Clear user key → use built-in
                    }
                  });
                  // 选中即落盘。以前只填表单不保存，用户选完直接去聊天页换模型，
                  // 聊天页读到的还是空配置 → 模型列表空、只显示「没拿到模型列表」
                  // （2026-11-16 实机；同一个陷阱在「连接测试」显示成功后依然存在，
                  // 因为连接测试读的是输入框，不是落盘值）。
                  await _save();
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
    );
  }

  Widget _modelSelector(AppPalette palette) {
    final currentModel = _model.text.isEmpty ? '选择模型' : _model.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Model',
            style: AppText.secondary.copyWith(color: palette.textSecondary)),
        const SizedBox(height: AppSpacing.micro),
        GestureDetector(
          onTap: () => _showModelDialog(palette),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.cardPadNarrow,
                vertical: AppSpacing.cardPadNarrow),
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
                                style: AppText.body.copyWith(
                                    fontWeight: isSelected
                                        ? FontWeight.w600
                                        : null)),
                            subtitle: m.name != m.id
                                ? Text(m.id,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: AppText.secondary)
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
        const SizedBox(height: AppSpacing.micro),
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
        const SizedBox(height: AppSpacing.micro),
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
          side: BorderSide(color: palette.primary.withValues(alpha: AppAlpha.strokeWeak)),
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

/// 设置页顶部的「权限中心」汇总卡：自带实时快照（init/resumed 各查一次），
/// 只报「N/M 已就绪 + 缺哪几样」，逐项状态与去授权在权限中心里。
/// 自己 fetch 而不是吃宿主数据：宿主那些字段（_bridgeStatus 等）刷新时机
/// 各不相同，汇总卡跟着它们会出现半新半旧的一瞥。
class _PermissionSummaryCard extends StatefulWidget {
  const _PermissionSummaryCard();

  @override
  State<_PermissionSummaryCard> createState() => _PermissionSummaryCardState();
}

class _PermissionSummaryCardState extends State<_PermissionSummaryCard>
    with WidgetsBindingObserver {
  BridgeStatus? _bridge;
  PermissionStatus? _perms;
  bool _captureReady = false;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _recheck();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 授权发生在 App 外（系统设置页），回来必须复测。
    if (state == AppLifecycleState.resumed) _recheck();
  }

  Future<void> _recheck() async {
    final results = await Future.wait([
      DeviceControl.bridgeStatus(),
      DeviceControl.checkPermissions(),
      DeviceControl.isScreenCaptureReady(),
    ]);
    if (!mounted) return;
    setState(() {
      _bridge = results[0] as BridgeStatus;
      _perms = results[1] as PermissionStatus;
      _captureReady = results[2] as bool;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    var ready = 0;
    if (_bridge?.allFiles ?? false) ready++;
    if (_perms?.accessibility ?? false) ready++;
    if (_perms?.overlay ?? false) ready++;
    if (_perms?.notifications ?? false) ready++;
    if (_captureReady) ready++;
    const total = 5;
    final allReady = ready == total;
    final tone = allReady ? palette.success : palette.warning;
    final missing = <String>[
      if (!(_bridge?.allFiles ?? false)) '所有文件访问',
      if (!(_perms?.accessibility ?? false)) '无障碍',
      if (!(_perms?.overlay ?? false)) '悬浮窗',
      if (!(_perms?.notifications ?? false)) '通知',
      if (!_captureReady) '屏幕捕获',
    ];
    return Material(
      color: tone.withValues(alpha: AppAlpha.weakFill),
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        side: BorderSide(color: tone.withValues(alpha: 0.35), width: AppStroke.thin),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        onTap: () async {
          await Navigator.push(context,
              MaterialPageRoute(builder: (_) => const PermissionCenterScreen()));
          // 权限中心里的授权动作改了状态，回来立刻重查这张汇总卡。
          if (mounted) _recheck();
        },
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.cardPad),
          child: _loading
              ? Row(children: [
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: AppSpacing.dense),
                  Text('正在清点授权位…',
                      style: AppText.secondary.copyWith(color: palette.textSecondary)),
                ])
              : Row(
                  children: [
                    Icon(
                      allReady
                          ? Icons.verified_user_outlined
                          : Icons.warning_amber_rounded,
                      size: 20,
                      color: tone,
                    ),
                    const SizedBox(width: AppSpacing.dense),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('权限中心 · $ready/$total 已就绪',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AppText.cardTitle.copyWith(color: tone)),
                          const SizedBox(height: AppSpacing.micro),
                          Text(
                            allReady ? '全部授权位就绪' : '缺少：${missing.join('、')}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppText.secondary.copyWith(color: palette.textSecondary),
                          ),
                        ],
                      ),
                    ),
                    Icon(Icons.chevron_right, size: 20, color: palette.textFaint),
                  ],
                ),
        ),
      ),
    );
  }
}
