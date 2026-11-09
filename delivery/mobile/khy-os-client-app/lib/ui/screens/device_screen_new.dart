// khy-canary: Khy-20261101-111-ED62BGK3
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../core/services/amoo_service.dart';
import '../../core/services/device_control.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import '../widgets/amoo_composer.dart';
import '../widgets/aurora.dart';

/// Device control dashboard - capabilities + quick actions
class DeviceScreenNew extends StatefulWidget {
  /// 本页变成「可见」的那一次计数，由宿主页签索引充当。
  ///
  /// WHY THIS EXISTS. This screen reads three things decided outside the app
  /// (accessibility, screen capture, notification/overlay permissions). It
  /// already re-reads them on `AppLifecycleState.resumed`, but the host uses an
  /// `IndexedStack` (main.dart), so switching tabs never rebuilds this State.
  /// Enable 无障碍服务 on 设置, come back here without ever leaving the app,
  /// and the card still says 未启用 while the service is live — with a 「去开启」
  /// button that opens a page showing it already on.
  final int visibleTick;

  const DeviceScreenNew({super.key, this.visibleTick = 0});

  @override
  State<DeviceScreenNew> createState() => _DeviceScreenNewState();
}

class _DeviceScreenNewState extends State<DeviceScreenNew>
    with WidgetsBindingObserver {
  bool _a11yReady = false;
  bool _screenReady = false;
  String _deviceInfo = '';
  String _lastScreenshot = '';
  PermissionStatus _perms = const PermissionStatus(
      notifications: false, overlay: false, accessibility: false);
  AmooStatus _amoo = const AmooStatus();
  // IndexedStack 会让设备页常驻；只靠 initState 会一直显示旧状态。
  // 15s 只刷新 amoo 安装态（只读 resolveActivity），不重跑整套 _loadStatus。
  Timer? _amooTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadStatus();
    _amooTimer = Timer.periodic(const Duration(seconds: 15), (_) => _refreshAmoo());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _amooTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 定时器只刷 amoo；从系统设置页（如「所有文件访问」）回来要复测整套
    // 状态，否则授完权回来界面不变、不知是否生效。
    if (state == AppLifecycleState.resumed) {
      _loadStatus();
    }
  }

  @override
  void didUpdateWidget(DeviceScreenNew old) {
    super.didUpdateWidget(old);
    // IndexedStack 不重建子 State，所以「变成可见」只有这一个信号。见
    // [visibleTick]：切回本页时必须重读，否则卡片显示的和系统里是反的。
    if (old.visibleTick != widget.visibleTick) {
      _loadStatus();
    }
  }

  Future<void> _refreshAmoo() async {
    final amoo = await AmooService.status();
    if (mounted) setState(() => _amoo = amoo);
  }

  Future<void> _loadStatus() async {
    final a11y = await DeviceControl.isAccessibilityReady();
    final screen = await DeviceControl.isScreenCaptureReady();
    final perms = await DeviceControl.checkPermissions();
    final info = await DeviceControl.getDeviceInfo();
    final amoo = await AmooService.status();
    if (mounted) {
      setState(() {
        _a11yReady = a11y;
        _screenReady = screen;
        _perms = perms;
        _amoo = amoo;
        _deviceInfo = info.isNotEmpty
            ? '${info['brand']} ${info['model']}\n'
                'Android ${info['releaseVersion']} API ${info['sdkVersion']}'
            : '未知设备';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return Scaffold(
      body: SafeArea(
        child: CustomScrollView(
          slivers: [
            // Header
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(
                    AppSpacing.page, AppSpacing.page, AppSpacing.page, 0),
                child: GlassCard(
                  tint: AppGlass.bar,
                  padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.page, vertical: AppSpacing.dense),
                  child: Row(
                    children: [
                      const GradientTile(icon: Icons.devices, size: 36),
                      const SizedBox(width: AppSpacing.inner),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('设备控制',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppText.title
                                    .copyWith(color: palette.textPrimary)),
                            Text('无障碍 · 截屏 · Shell',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppText.secondary
                                    .copyWith(color: palette.textSecondary)),
                          ],
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.refresh, size: 20),
                        onPressed: _loadStatus,
                      ),
                    ],
                  ),
                ),
              ),
            ),
            // Capability cards
            SliverPadding(
              padding: const EdgeInsets.all(AppSpacing.page),
              sliver: SliverList(
                delegate: SliverChildListDelegate([
                  _sectionTitle(palette, '功能状态'),
                  const SizedBox(height: AppSpacing.dense),
                  _capCard(
                    context: context,
                    icon: Icons.accessibility_new,
                    title: '无障碍服务',
                    subtitle: _a11yReady ? '已启用，可模拟点击和滑动' : '未启用，需在系统设置中开启',
                    active: _a11yReady,
                    action: _a11yReady ? null : () => DeviceControl.openAccessibilitySettings(),
                    actionLabel: _a11yReady ? null : '去开启',
                  ),
                  const SizedBox(height: AppSpacing.cardGap),
                  _capCard(
                    context: context,
                    icon: Icons.screenshot,
                    title: '屏幕捕获',
                    subtitle: _screenReady ? '运行中，可静默截屏' : '未运行，需授权后启动',
                    active: _screenReady,
                    action: _screenReady
                        ? () async {
                            await DeviceControl.stopScreenCapture();
                            _loadStatus();
                          }
                        : () async {
                            final ok = await DeviceControl.startScreenCapture();
                            if (ok) {
                              await Future.delayed(const Duration(seconds: 1));
                              _loadStatus();
                            }
                          },
                    actionLabel: _screenReady ? '停止' : '启动',
                  ),
                  const SizedBox(height: AppSpacing.cardGap),
                  _capCard(
                    context: context,
                    icon: Icons.terminal,
                    title: 'Shell 命令',
                    subtitle: '白名单命令：am, pm, dumpsys, input...',
                    active: true,
                  ),
                  const SizedBox(height: AppSpacing.cardGap),
                  _capCard(
                    context: context,
                    icon: Icons.forum_outlined,
                    title: 'amoo',
                    subtitle: _amoo.summary,
                    // resolveActivity 只证明「可解析」，不证明第三方 uid 能启动；
                    // 这里不用绿色（active）冒充成功态。
                    active: false,
                    muted: !_amoo.installed,
                    outlineAction: true,
                    action: _amoo.canShare
                        ? () => showAmooComposer(context)
                        : _amoo.installed
                            ? () async {
                                final ok = await AmooService.openChat();
                                if (!ok && context.mounted) {
                                  _showDialog(context, 'amoo', '已安装 amoo，但无法解析分享入口。');
                                }
                              }
                            : null,
                    actionLabel: _amoo.canShare
                        ? '分享'
                        : _amoo.installed
                            ? '打开'
                            : null,
                  ),

                  const SizedBox(height: AppSpacing.section),

                  // ── Permission Section ──
                  _sectionTitle(palette, '权限状态'),
                  const SizedBox(height: AppSpacing.dense),
                  _permCard(palette),

                  const SizedBox(height: AppSpacing.section),

                  // Quick actions
                  _sectionTitle(palette, '快捷操作'),
                  const SizedBox(height: AppSpacing.dense),
                  GridView.count(
                    crossAxisCount: 4,
                    crossAxisSpacing: AppSpacing.cardGap,
                    mainAxisSpacing: AppSpacing.cardGap,
                    childAspectRatio: 1,
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    children: [
                      _quickAction(palette, Icons.home, '主页', () async {
                        await DeviceControl.a11yGlobalAction(DeviceControl.globalActionHome);
                      }),
                      _quickAction(palette, Icons.arrow_back, '返回', () async {
                        await DeviceControl.a11yGlobalAction(DeviceControl.globalActionBack);
                      }),
                      _quickAction(palette, Icons.notifications, '通知', () async {
                        await DeviceControl.a11yGlobalAction(DeviceControl.globalActionNotifications);
                      }),
                      _quickAction(palette, Icons.recent_actors, '最近', () async {
                        await DeviceControl.a11yGlobalAction(DeviceControl.globalActionRecents);
                      }),
                      _quickAction(palette, Icons.screenshot, '截屏', () async {
                        final data = await DeviceControl.captureFrame();
                        if (data != null && mounted) {
                          setState(() => _lastScreenshot = data);
                          _showScreenshot(context, data);
                        }
                      }, highlight: true),
                      _quickAction(palette, Icons.vibration, '振动', () {
                        DeviceControl.vibrate(duration: 300);
                      }),
                      _quickAction(palette, Icons.view_in_ar, 'UI树', () async {
                        final dump = await DeviceControl.a11yDumpUi();
                        if (dump.isNotEmpty && mounted) {
                          _showDialog(context, 'UI 树', dump);
                        }
                      }),
                      _quickAction(palette, Icons.list, '可点击', () async {
                        final items = await DeviceControl.a11yListClickable();
                        if (items.isNotEmpty && mounted) {
                          final text = items.take(20).map((e) =>
                              '${e['text']} @ (${e['x']},${e['y']})').join('\n');
                          _showDialog(context, '可点击元素', text);
                        }
                      }),
                    ],
                  ),

                  const SizedBox(height: AppSpacing.section),

                  // Device info
                  _sectionTitle(palette, '设备信息'),
                  const SizedBox(height: AppSpacing.dense),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(AppSpacing.cardPad),
                    decoration: BoxDecoration(
                      color: palette.surfaceHigh,
                      borderRadius: BorderRadius.circular(AppRadius.medium),
                      border: Border.all(
                          color: palette.stroke, width: AppStroke.thin),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (final line in _deviceInfo.split('\n'))
                          Text(line,
                              style: AppText.secondary.copyWith(
                                  fontSize: 12,
                                  fontFamily: 'monospace',
                                  height: 1.6,
                                  color: palette.textPrimary)),
                      ],
                    ),
                  ),
                  const SizedBox(height: AppSpacing.page),
                ]),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionTitle(AppPalette palette, String title) {
    return Text(
      title,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: AppText.secondary.copyWith(
        fontSize: 13,
        fontWeight: FontWeight.w700,
        color: palette.textPrimary.withValues(alpha: 0.85),
      ),
    );
  }

  Widget _permCard(AppPalette palette) {
    return Container(
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: palette.stroke, width: AppStroke.thin),
      ),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.cardPad),
      child: Column(
        children: [
          _permRow(palette, '通知权限', _perms.notifications,
              () => DeviceControl.requestNotifications()),
          const Divider(),
          _permRow(palette, '悬浮窗权限', _perms.overlay,
              () => DeviceControl.requestOverlay()),
          const Divider(),
          _permRow(palette, '无障碍服务', _perms.accessibility,
              () => DeviceControl.requestAccessibility()),
        ],
      ),
    );
  }

  Widget _permRow(
      AppPalette palette, String label, bool granted, VoidCallback onGrant) {
    return SizedBox(
      height: 44,
      child: Row(
        children: [
          Icon(
            granted ? Icons.check_circle : Icons.warning_amber_rounded,
            size: 18,
            color: granted ? palette.success : palette.warning,
          ),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppText.secondary.copyWith(
                fontSize: 13,
                color: granted ? palette.textPrimary : palette.textSecondary,
              ),
            ),
          ),
          if (granted)
            const StatusPill(label: '已授权', tone: StatusPillTone.success)
          else
            _grantCapsule(palette, onGrant),
        ],
      ),
    );
  }

  Widget _grantCapsule(AppPalette palette, VoidCallback onGrant) {
    return PressableScale(
      onTap: onGrant,
      child: Container(
        height: 28,
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.inner),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppRadius.pill),
          border: Border.all(
            color: palette.warning.withValues(alpha: 0.7),
            width: AppStroke.thin,
          ),
        ),
        child: Text('去授权',
            maxLines: 1, overflow: TextOverflow.ellipsis,
            style: AppText.label.copyWith(color: palette.warning)),
      ),
    );
  }

  Widget _capCard({
    required BuildContext context,
    required IconData icon,
    required String title,
    required String subtitle,
    required bool active,
    VoidCallback? action,
    String? actionLabel,
    bool muted = false,
    bool outlineAction = false,
  }) {
    final palette = AppPalette.of(context);
    final card = Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.cardPad),
      decoration: BoxDecoration(
        color: active
            ? palette.success.withValues(alpha: 0.06)
            : palette.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(
          color: active
              ? palette.success.withValues(alpha: 0.16)
              : palette.stroke,
          width: AppStroke.thin,
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: active
                  ? palette.success.withValues(alpha: 0.12)
                  : palette.surfaceHigh,
              borderRadius: BorderRadius.circular(AppRadius.small),
            ),
            child: Icon(icon,
                size: 20,
                color: active ? palette.success : palette.textSecondary),
          ),
          const SizedBox(width: AppSpacing.inner),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.cardTitle
                        .copyWith(color: palette.textPrimary)),
                Text(subtitle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.secondary
                        .copyWith(color: palette.textSecondary)),
              ],
            ),
          ),
          if (action != null) ...[
            const SizedBox(width: AppSpacing.inner),
            _actionCapsule(palette, action, actionLabel ?? '操作',
                outlined: outlineAction),
          ],
        ],
      ),
    );
    return muted ? Opacity(opacity: 0.6, child: card) : card;
  }

  Widget _actionCapsule(AppPalette palette, VoidCallback onTap, String label,
      {required bool outlined}) {
    return PressableScale(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.cardPad, vertical: AppSpacing.dense),
        decoration: BoxDecoration(
          gradient: outlined ? null : AppGradients.brand2,
          borderRadius: BorderRadius.circular(AppRadius.pill),
          border: outlined
              ? Border.all(color: palette.strokeStrong, width: AppStroke.thin)
              : null,
          boxShadow: outlined ? null : AppShadows.glowSoft,
        ),
        child: Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: AppText.secondary.copyWith(
            fontWeight: FontWeight.w600,
            color: outlined ? palette.primary : Colors.white,
          ),
        ),
      ),
    );
  }

  Widget _quickAction(
      AppPalette palette, IconData icon, String label, VoidCallback onTap,
      {bool highlight = false}) {
    return PressableScale(
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          gradient: highlight ? AppGradients.brand : null,
          color: highlight ? null : palette.surfaceHigh,
          borderRadius: BorderRadius.circular(AppRadius.medium),
          border: highlight
              ? null
              : Border.all(color: palette.stroke, width: AppStroke.thin),
        ),
        // 360dp 去页边距后格子只剩 73dp，FittedBox 让大字号下整体缩放而非溢出。
        child: FittedBox(
          fit: BoxFit.scaleDown,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: highlight
                      ? Colors.white.withValues(alpha: 0.18)
                      : palette.primary.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                child: Icon(icon,
                    size: 24,
                    color: highlight ? Colors.white : palette.primary),
              ),
              const SizedBox(height: 4),
              Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.label.copyWith(
                    color: highlight ? Colors.white : palette.textSecondary,
                  )),
            ],
          ),
        ),
      ),
    );
  }

  void _showScreenshot(BuildContext context, String dataUrl) {
    showDialog(
      context: context,
      builder: (ctx) {
        // Strip base64 prefix for display
        final base64 = dataUrl.split(',').last;
        return Dialog(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 300, maxHeight: 500),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox(height: 12),
                Text('截屏 (${base64.length} bytes)',
                    style: const TextStyle(
                        fontSize: 13, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                // Just show size info - actual image rendering would need
                // the base64 to be converted to a byte array
                Container(
                  width: 200,
                  height: 300,
                  color: const Color(0xFF1a1a2e),
                  child: const Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.screenshot, size: 40, color: Colors.white54),
                        SizedBox(height: 8),
                        Text('截图已捕获', style: TextStyle(color: Colors.white54, fontSize: 12)),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                TextButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('关闭'),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  void _showDialog(BuildContext context, String title, String content) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(
            child: SelectableText(
              content,
              style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: content));
              ScaffoldMessenger.of(context)
                  .showSnackBar(const SnackBar(content: Text('已复制')));
              Navigator.pop(ctx);
            },
            child: const Text('复制'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }
}
