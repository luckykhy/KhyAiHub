// khy-canary: Khy-20261101-105-PX5NXGAP
import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show ImageFilter, PlatformDispatcher;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'ui/theme/app_theme.dart';
import 'ui/theme/app_colors.dart';
import 'ui/theme/design_tokens.dart';
import 'ui/widgets/aurora.dart';
import 'ui/widgets/khy_pet.dart';
import 'ui/screens/chat_screen_new.dart';
import 'ui/screens/file_manager_screen.dart';
import 'ui/screens/tools_hub_screen.dart';
import 'ui/screens/device_screen_new.dart';
import 'ui/screens/settings_screen_new.dart';
import 'core/gateway/khyos_api.dart';
import 'core/services/app_logger.dart';
import 'core/services/device_control.dart';
import 'core/workspace/workspace_store.dart';

final khyOsApiProvider = Provider<KhyOsApi>((ref) => KhyOsApi());

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppLogger().init();
  _installCrashHandlers();
  // 工作空间自举：建通用工作空间（含 tmp/）+ 扫上一轮的孤儿临时项。
  //
  // 为什么不 await：启动路径不该被盘上操作拖住，而且工作空间建不起来也不该
  // 阻止 App 起来——它是增益，不是前提。失败由 WorkspaceStore 自己记日志。
  //
  // 为什么只建通用的：专用工作空间按需创建（有任务名才建）。启动时预建一堆空
  // 目录就是占位，而空占位正是要避免的东西。
  unawaited(_bootstrapWorkspace());
  runZonedGuarded(
    () => runApp(const ProviderScope(child: KhyOsApp())),
    (error, stack) => AppLogger().recordError(
      code: ErrorCode.crash,
      message: '未捕获的 Zone 异常',
      category: LogCategory.system,
      exception: error,
      stack: stack,
      severity: LogLevel.fatal,
    ),
  );
}

Future<void> _bootstrapWorkspace() async {
  final store = WorkspaceStore.instance;
  await store.ensure(store.paths());
  await store.sweepOrphanTemp();
}

/// 未捕获异常必须落盘。
///
/// 这是手机端日志规范里「错误优先」的底线：崩了但日志里没有等于没崩——
/// 用户报障时，第一份证据就没了。
void _installCrashHandlers() {
  final logger = AppLogger();

  FlutterError.onError = (details) {
    logger.recordError(
      code: ErrorCode.crash,
      message: '未捕获的界面异常',
      category: LogCategory.system,
      context: <String, dynamic>{'library': details.library},
      exception: details.exception,
      stack: details.stack,
      severity: LogLevel.fatal,
    );
    FlutterError.presentError(details);
  };

  PlatformDispatcher.instance.onError = (error, stack) {
    logger.recordError(
      code: ErrorCode.crash,
      message: '未捕获的异步异常',
      category: LogCategory.system,
      exception: error,
      stack: stack,
      severity: LogLevel.fatal,
    );
    return true;
  };
}

class KhyOsApp extends ConsumerWidget {
  const KhyOsApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp(
      title: 'khy-os',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      home: const KhyOsHome(),
    );
  }
}

/// Main home screen with bottom navigation
class KhyOsHome extends ConsumerStatefulWidget {
  const KhyOsHome({super.key});

  @override
  ConsumerState<KhyOsHome> createState() => _KhyOsHomeState();
}

class _KhyOsHomeState extends ConsumerState<KhyOsHome>
    with WidgetsBindingObserver, SingleTickerProviderStateMixin {
  int _tabIndex = 0;
  final KhyOsApi _api = KhyOsApi();
  bool _isLoading = true;

  /// 文件管理器的状态句柄。
  ///
  /// AI 悬浮按钮放在**外层** Scaffold：外层是 `extendBody: true`（内容延伸到底栏
  /// 之下），内层 Scaffold 的 FAB 会被压在玻璃底栏底下——真机上验证过，按钮根本不显示。
  final GlobalKey<FileManagerScreenState> _fileManagerKey =
      GlobalKey<FileManagerScreenState>();

  /// AI 助手按钮是否可见（由文件管理器回报，AI 关掉时要把入口也收掉）。
  bool _assistantVisible = false;

  // 选中瞬间的一次性过冲（§5 spring 1→1.12→1），不循环。
  late final AnimationController _tabPulse = AnimationController(
    vsync: this,
    duration: AppDuration.spring,
  );

  // 上升 easeOut、回落 easeOutBack（带轻微回弹），合成 1→1.12→1。
  static final Animatable<double> _tabBounce = TweenSequence<double>(
    <TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0, end: 1)
            .chain(CurveTween(curve: Curves.easeOut)),
        weight: 40,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 1, end: 0)
            .chain(CurveTween(curve: Curves.easeOutBack)),
        weight: 60,
      ),
    ],
  );

  // 首启闸门（装机授权清单）。MANAGE_EXTERNAL_STORAGE 没有运行时弹窗，这一次
  // 系统页点击 APK 代劳不了——清单 + resumed 自动复测把它压成
  // 「打开 → 按清单点 → 回来自动确认」。完成（或明确跳过）后标记落
  // flutter_secure_storage，本装机的后续启动直接进主界面。
  static const _gateKey = 'khyos_bridge_gate_done';
  static const _gateStorage = FlutterSecureStorage();
  bool _gateDone = false;

  // 页签顺序即产品定位：文件管理是第一页签（用户打开 App 想的是「我的文件在哪」），
  // 对话退到第二页签成为「AI 助手」——它是随叫随到的增强层，不再是入口。
  static const _tabTitles = ['文件', 'AI', '技能', '设备', '设置'];
  static const _tabIcons = [
    Icons.folder_outlined,
    Icons.chat_bubble_outline,
    Icons.bolt_outlined,
    Icons.devices_outlined,
    Icons.settings_outlined,
  ];
  static const _tabSelectedIcons = [
    Icons.folder,
    Icons.chat_bubble,
    Icons.bolt,
    Icons.devices,
    Icons.settings,
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _init();
  }

  Future<void> _init() async {
    AppLogger().setScreen(_tabTitles.first);
    await _api.loadConnection();
    String? marker;
    try {
      marker = await _gateStorage.read(key: _gateKey);
    } catch (_) {
      // 读不到标记就按「没做完」走闸门——宁可按清单看一遍，也不静默放过。
      marker = null;
    }
    if (!mounted) return;
    setState(() {
      _gateDone = marker != null;
      _isLoading = false;
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 从系统设置页回来：自动复测，置顶项就绪即过闸（闸门页自己也会复测，
    // 这里负责落标记与切换主界面）。
    if (state == AppLifecycleState.resumed) {
      _recheckGate();
    }
  }

  Future<void> _recheckGate() async {
    if (_gateDone) return;
    final st = await DeviceControl.bridgeStatus();
    if (st.allFiles) {
      await _completeGate();
    }
  }

  Future<void> _completeGate() async {
    try {
      await _gateStorage.write(key: _gateKey, value: 'done');
    } catch (_) {
      // 写不进标记也不拦着用：本次进程内已放行。
    }
    if (mounted) setState(() => _gateDone = true);
  }

  Future<void> _skipGate() async {
    // 用户明确选择暂不授权：闸门只弹一次，不重复打扰。设置页仍保留
    // 「所有文件访问」一行，随时可补授。
    try {
      await _gateStorage.write(key: _gateKey, value: 'skipped');
    } catch (_) {}
    if (mounted) setState(() => _gateDone = true);
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return _splash(context);
    }

    if (!_gateDone) {
      return _GateChecklistScreen(
        onGranted: _completeGate,
        onSkip: _skipGate,
      );
    }

    final screens = [
      // 文件管理器是主界面：浏览、复制、移动、删除、重命名、压缩解压、搜索、
      // 书签、存储分析都在这里，AI 只是嵌在各操作环节里的可选增强。
      FileManagerScreen(
        key: _fileManagerKey,
        onAssistantVisibilityChanged: (bool visible) {
          if (mounted) setState(() => _assistantVisible = visible);
        },
      ),
      ChatScreenNew(api: _api),
      // 原来是 SkillsScreenNew（一个技能网格）。换成工具与智能体总览：
      // 技能只是能力的一种，而用户真正问的是"这 App 到底能干什么、谁干的、
      // 要不要先做点什么"——那需要工具清单、桥状态、智能体可用性一起答。
      const ToolsHubScreen(),
      // visibleTick：宿主页签索引。IndexedStack 让四个页签同时活着，切页
      // 只换谁被画、不重建子 State，所以「变成可见」这件事必须由宿主显式
      // 告诉它们——否则在设备页开了无障碍，回来设置页的开关还显示关着。
      DeviceScreenNew(visibleTick: _tabIndex),
      // onExit 是必须的：设置页顶部那个 ← 在「设置」tab 上没有路由可弹，
      // 不给它一个去处，那一按就会把 App 退掉——用户看到的是整个黑屏。
      // 给它「切回 AI tab」，那一按就回到对话，和 Android「次级目的地返回到
      // 起始目的地」的规范一致。
      SettingsScreenNew(
        visibleTick: _tabIndex,
        onExit: () {
        if (!mounted) return;
        setState(() => _tabIndex = 0);
      }),
    ];

    return Scaffold(
      // 内容延伸到底栏之下，滚动段落才从玻璃底栏下透出（§6.5.3）。
      extendBody: true,
      body: Stack(
        // expand 保住了原来 body 直接给 IndexedStack 的紧约束：页签内容
        // 仍然铺满整屏，桌宠层是 Positioned，不受这个 fit 影响。
        fit: StackFit.expand,
        children: [
          IndexedStack(
            index: _tabIndex,
            children: screens,
          ),
          // 桌宠浮层：Positioned 只让它占自己那个盒子，不铺满屏幕，
          // 因此不会吞掉页面的触摸。层级在内容之上、玻璃底栏之下。
          const Positioned(
            left: KhyPetAnchors.defaultLeft,
            bottom: KhyPetAnchors.defaultBottom,
            child: KhyPetOverlay(),
          ),
        ],
      ),
      floatingActionButton: _tabIndex == 0 && _assistantVisible
          ? FloatingActionButton.small(
              onPressed: () => _fileManagerKey.currentState?.openAiPanel(),
              tooltip: 'AI 助手',
              child: const Icon(Icons.auto_awesome),
            )
          : null,
      bottomNavigationBar: _GlassNavBar(
        child: NavigationBar(
          selectedIndex: _tabIndex,
          onDestinationSelected: (i) {
            setState(() => _tabIndex = i);
            _tabPulse.forward(from: 0);
            AppLogger().setScreen(_tabTitles[i]);
          },
          destinations: [
            for (var i = 0; i < 5; i++)
              NavigationDestination(
                icon: _pulseIcon(i, Icon(_tabIcons[i])),
                selectedIcon: _pulseIcon(i, Icon(_tabSelectedIcons[i])),
                label: _tabTitles[i],
              ),
          ],
        ),
      ),
    );
  }

  /// 启动页：右上角 radial 光斑 + 96dp hero logo + 三点跳动（§6.5.1）。
  Widget _splash(BuildContext context) {
    final palette = AppPalette.of(context);
    final width = MediaQuery.sizeOf(context).width;
    return Scaffold(
      body: Stack(
        children: [
          Positioned(
            top: -width * 0.25,
            right: -width * 0.25,
            child: Container(
              width: width * 1.2,
              height: width * 1.2,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(
                  colors: <Color>[
                    palette.primary.withValues(alpha: 0.18),
                    palette.primary.withValues(alpha: 0),
                  ],
                ),
              ),
            ),
          ),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const GradientTile(
                  icon: Icons.smart_toy_outlined,
                  size: 96,
                  gradient: AppGradients.brand,
                ),
                const SizedBox(height: AppSpacing.section),
                Text(
                  'khy-os',
                  style: AppText.display.copyWith(color: palette.textPrimary),
                ),
                const SizedBox(height: AppSpacing.dense),
                Text(
                  '文件管理器 · AI 助手',
                  style:
                      AppText.secondary.copyWith(color: palette.textSecondary),
                ),
                const SizedBox(height: AppSpacing.section),
                const _DotLoader(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 选中瞬间图标弹一下；outline/filled 成对切换仍由导航按状态分派。
  Widget _pulseIcon(int index, Widget icon) {
    return AnimatedBuilder(
      animation: _tabPulse,
      builder: (context, child) {
        final active = index == _tabIndex;
        final reduced = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
        final w = !active || reduced
            ? 0.0
            : _tabBounce.transform(_tabPulse.value);
        return Transform.scale(scale: 1 + 0.12 * w, child: child);
      },
      child: icon,
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _tabPulse.dispose();
    _api.dispose();
    super.dispose();
  }
}

/// 底栏玻璃底（§4 第 3 处）：blur + 顶部 1px stroke。半透明底色已由
/// navigationBarTheme 给出，blur 这一半只能在 shell 补，否则玻璃不成像。
class _GlassNavBar extends StatelessWidget {
  const _GlassNavBar({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return DecoratedBox(
      position: DecorationPosition.foreground,
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: palette.stroke, width: AppStroke.thin),
        ),
      ),
      child: ClipRect(
        child: BackdropFilter(
          filter: ImageFilter.blur(
            sigmaX: AppGlass.sigma,
            sigmaY: AppGlass.sigma,
          ),
          child: child,
        ),
      ),
    );
  }
}

/// 三点跳动（§5 dots：400ms easeInOut、6dp 圆点、各 stagger 120ms）。
/// 常驻动画全 app 只批了运行中 breathe 与启动/检测两点，这里别再复用第三处。
class _DotLoader extends StatefulWidget {
  const _DotLoader();

  @override
  State<_DotLoader> createState() => _DotLoaderState();
}

class _DotLoaderState extends State<_DotLoader>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller =
      AnimationController(vsync: this, duration: AppDuration.dots);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 减弱动效直接停表而不是放慢：慢速循环仍是常驻运动。
    final reduced = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (reduced) {
      _controller.stop();
    } else if (!_controller.isAnimating) {
      _controller.repeat();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < 3; i++) ...[
          if (i > 0) const SizedBox(width: AppSpacing.dense),
          _BouncingDot(
            controller: _controller,
            phase: i * 0.3,
            color: palette.primary,
          ),
        ],
      ],
    );
  }
}

class _BouncingDot extends StatelessWidget {
  const _BouncingDot({
    required this.controller,
    required this.phase,
    required this.color,
  });

  final AnimationController controller;

  /// 相位偏移：stagger 120ms / 周期 400ms = 0.3。
  final double phase;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, child) {
        // Dart 的 % 对负数返回非负值，相位回绕天然成立。
        final t = (controller.value - phase) % 1.0;
        return Transform.translate(
          offset: Offset(0, -math.sin(t * math.pi) * 6),
          child: child,
        );
      },
      child: Container(
        width: 6,
        height: 6,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      ),
    );
  }
}

/// 一页式装机授权清单。置顶项「所有文件访问」是令牌落盘的前提；从系统设置
/// 回到本页（resumed）自动复测并勾掉已完成项，置顶项勾完即过闸。
class _GateChecklistScreen extends StatefulWidget {
  const _GateChecklistScreen({required this.onGranted, required this.onSkip});

  final Future<void> Function() onGranted;
  final Future<void> Function() onSkip;

  @override
  State<_GateChecklistScreen> createState() => _GateChecklistScreenState();
}

class _GateChecklistScreenState extends State<_GateChecklistScreen>
    with WidgetsBindingObserver {
  bool _checking = true;
  BridgeStatus? _bridge;
  PermissionStatus? _perms;

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
    if (state == AppLifecycleState.resumed) {
      _recheck();
    }
  }

  Future<void> _recheck() async {
    final bridge = await DeviceControl.bridgeStatus();
    final perms = await DeviceControl.checkPermissions();
    if (!mounted) return;
    setState(() {
      _bridge = bridge;
      _perms = perms;
      _checking = false;
    });
    if (bridge.allFiles) {
      await widget.onGranted();
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final bridge = _bridge;
    final perms = _perms;
    final items = <_GateItem>[
      _GateItem(
        icon: Icons.folder_off,
        title: '所有文件访问',
        why: '桥的令牌落盘与文件信箱前提。缺了它电脑拿不到令牌，手机连不上',
        granted: bridge?.allFiles ?? false,
        mustHave: true,
        onGrant: DeviceControl.requestAllFilesAccess,
      ),
      _GateItem(
        icon: Icons.accessibility_new,
        title: '无障碍服务',
        why: 'UI 自动化与截图需要它',
        granted: bridge?.uiReady ?? perms?.accessibility ?? false,
        onGrant: DeviceControl.requestAccessibility,
      ),
      _GateItem(
        icon: Icons.picture_in_picture_alt,
        title: '悬浮窗权限',
        why: '工作悬浮框需要它',
        granted: bridge?.overlayGranted ?? perms?.overlay ?? false,
        onGrant: DeviceControl.requestOverlay,
      ),
    ];
    final grantedCount = items.where((item) => item.granted).length;

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.page),
          children: [
            Row(
              children: [
                const GradientTile(
                  icon: Icons.verified_user_outlined,
                  size: 48,
                  gradient: AppGradients.brand,
                ),
                const SizedBox(width: AppSpacing.inner),
                Expanded(
                  child: Text(
                    '装机授权',
                    style: AppText.title.copyWith(color: palette.textPrimary),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.cardGap),
            Row(
              children: [
                for (var i = 0; i < items.length; i++) ...[
                  if (i > 0) const SizedBox(width: AppSpacing.dense),
                  _GateProgressSegment(
                    lit: i < grantedCount,
                    palette: palette,
                  ),
                ],
              ],
            ),
            const SizedBox(height: AppSpacing.cardGap),
            Text(
              '手机桥要连上电脑，先完成下面 $grantedCount/${items.length} 项授权',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '从系统设置回到本页会自动复测并勾掉已完成项；置顶项完成后即进入主界面',
              style: AppText.secondary.copyWith(
                color: palette.textSecondary,
                height: 1.5,
              ),
            ),
            const SizedBox(height: AppSpacing.cardPad),
            if (_checking)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: AppSpacing.section),
                child: Center(child: _DotLoader()),
              )
            else
              for (final item in items) ...[
                _GateItemTile(item: item),
                const SizedBox(height: AppSpacing.dense),
              ],
            const SizedBox(height: AppSpacing.cardPad),
            Center(
              child: TextButton(
                onPressed: () => widget.onSkip(),
                style: TextButton.styleFrom(
                  foregroundColor: palette.textSecondary,
                ),
                child: const Text('暂不授权，直接进入'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GateItem {
  const _GateItem({
    required this.icon,
    required this.title,
    required this.why,
    required this.granted,
    this.mustHave = false,
    required this.onGrant,
  });

  final IconData icon;
  final String title;
  final String why;
  final bool granted;
  final bool mustHave;
  final Future<void> Function() onGrant;
}

class _GateItemTile extends StatelessWidget {
  const _GateItemTile({required this.item});

  final _GateItem item;

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: item.granted
            ? palette.success.withValues(alpha: 0.06)
            : palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(
          color: item.granted
              ? palette.success.withValues(alpha: 0.35)
              : palette.stroke,
          width: AppStroke.thin,
        ),
      ),
      child: Row(
        children: [
          Icon(
            item.granted ? Icons.check_circle : item.icon,
            size: 22,
            color: item.granted ? palette.success : palette.textSecondary,
          ),
          const SizedBox(width: AppSpacing.inner),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        item.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppText.body.copyWith(
                          fontWeight: FontWeight.w600,
                          color: palette.textPrimary,
                        ),
                      ),
                    ),
                    if (item.mustHave) ...[
                      const SizedBox(width: AppSpacing.dense),
                      const StatusPill(
                        label: '必须',
                        tone: StatusPillTone.warning,
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  item.granted ? '已授权' : item.why,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.secondary.copyWith(
                    color: item.granted
                        ? palette.success
                        : palette.textSecondary,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
          if (!item.granted) ...[
            const SizedBox(width: AppSpacing.dense),
            _GrantButton(onTap: item.onGrant),
          ],
        ],
      ),
    );
  }
}

/// 3 段 44×6dp pill 进度条：完成段 brandGradient2，未完成 surfaceHigh+stroke。
class _GateProgressSegment extends StatelessWidget {
  const _GateProgressSegment({required this.lit, required this.palette});

  final bool lit;
  final AppPalette palette;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 6,
      decoration: BoxDecoration(
        color: lit ? null : palette.surfaceHigh,
        gradient: lit ? AppGradients.brand2 : null,
        borderRadius: BorderRadius.circular(AppRadius.pill),
        border: lit
            ? null
            : Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
    );
  }
}

/// 「去授权」胶囊（§6.6.3）：高 36/pill/白字 12 w600/glowSoft。
class _GrantButton extends StatelessWidget {
  const _GrantButton({required this.onTap});

  final Future<void> Function() onTap;

  @override
  Widget build(BuildContext context) {
    return PressableScale(
      onTap: () => onTap(),
      child: Container(
        height: 36,
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.cardPad),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          gradient: AppGradients.brand2,
          borderRadius: BorderRadius.circular(AppRadius.pill),
          boxShadow: AppShadows.glowSoft,
        ),
        child: Text(
          '去授权',
          style: AppText.secondary.copyWith(
            color: Colors.white,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}
