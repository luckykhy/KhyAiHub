import 'package:flutter/material.dart';
import '../../core/services/battery_guard.dart';
import '../../core/services/device_control.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';
import 'battery_guide_screen.dart';

/// 权限中心：khy-os 全部授权位的统一清点页（2026-11-15 用户拍板收敛）。
///
/// 之前权限散在 5 处：首启闸门、设置页三个区、设备页「权限状态」区、控制台
/// 横幅、悬浮窗「点此恢复」。同一件事最多 5 个入口、互不知道对方——排障时
/// 先得猜权限藏在哪个页。本页把授权位一行一项收拢：状态灯 + 一句话「缺了会
/// 怎样」+ 去授权直达，从系统设置页回来（resumed）自动复测。
///
/// 边界（收敛裁定的分工）：
///   - 本页管「状态 + 授权跳转」；无障碍/截屏/悬浮窗的**开关**是操作，
///     留在设置页原位，不搬。
///   - 首启闸门（_GateChecklistScreen）是闸门不是管理页，保留不动。
///   - 提权代理不是授权位（它经 adb 自举、重启后消失属正常），只作为
///     只读参考行挂在本页末尾，让「能力为什么被灰」在本页能答上。
class PermissionCenterScreen extends StatefulWidget {
  const PermissionCenterScreen({super.key});

  @override
  State<PermissionCenterScreen> createState() => _PermissionCenterScreenState();
}

class _PermissionCenterScreenState extends State<PermissionCenterScreen>
    with WidgetsBindingObserver {
  BridgeStatus? _bridge;
  PermissionStatus? _perms;
  bool _captureReady = false;
  ElevationStatus? _elevation;
  /// 电池/后台运行状态：省电策略冻结是"无障碍掉线"最常见的病因，
  /// 所以它作为授权位之一列在这里（而不是藏在别处）。
  BatteryStatusInfo? _battery;
  bool _loading = true;
  /// 正在跑授权动作的行：按钮换成小圈，防止双击连发两次系统页跳转。
  final Set<String> _pending = {};

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
    // 授权发生在 App 之外（系统设置页 / 系统弹窗），回来必须复测——
    // 与首启闸门、设置页同一条纪律。
    if (state == AppLifecycleState.resumed) _recheck();
  }

  Future<void> _recheck() async {
    // 五路并行：都是 MethodChannel 快照读，互不依赖，串行只会拉长白屏。
    final results = await Future.wait([
      DeviceControl.bridgeStatus(),
      DeviceControl.checkPermissions(),
      DeviceControl.isScreenCaptureReady(),
      DeviceControl.getElevationStatus(),
      BatteryGuard.status(),
    ]);
    if (!mounted) return;
    setState(() {
      _bridge = results[0] as BridgeStatus;
      _perms = results[1] as PermissionStatus;
      _captureReady = results[2] as bool;
      _elevation = results[3] as ElevationStatus;
      _battery = results[4] as BatteryStatusInfo;
      _loading = false;
    });
  }

  Future<void> _grant(String key, Future<void> Function() action) async {
    if (_pending.contains(key)) return;
    setState(() => _pending.add(key));
    try {
      await action();
    } finally {
      if (mounted) {
        setState(() => _pending.remove(key));
      }
      // 授权动作可能去了系统页（resumed 会复测），也可能原地弹系统框
      // （MediaProjection）：两种路径都主动复测一遍，不等 resumed。
      await _recheck();
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('权限中心')),
      body: SafeArea(
        child: _loading
            ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
            : ListView(
                padding: const EdgeInsets.all(AppSpacing.page),
                children: [
                  _summaryCard(palette),
                  const SizedBox(height: AppSpacing.section),
                  _card(palette, [
                    _row(palette, _PermItem(
                      keyId: 'allFiles',
                      icon: Icons.folder_off_outlined,
                      title: '所有文件访问',
                      why: '桥的令牌落盘与文件信箱前提。缺了它 PC 侧拿不到令牌，'
                          '手机连不上',
                      granted: _bridge?.allFiles ?? false,
                      actionLabel: '去授权',
                      action: DeviceControl.requestAllFilesAccess,
                    )),
                    const Divider(height: 1),
                    _row(palette, _PermItem(
                      keyId: 'a11y',
                      icon: Icons.accessibility_new,
                      title: '无障碍服务',
                      why: 'UI 自动化、点按、输入文字、无障碍截屏都靠它',
                      granted: _perms?.accessibility ??
                          (_bridge?.uiReady ?? false),
                      actionLabel: '去开启',
                      action: DeviceControl.requestAccessibility,
                    )),
                    const Divider(height: 1),
                    _row(palette, _PermItem(
                      keyId: 'overlay',
                      icon: Icons.picture_in_picture_alt_outlined,
                      title: '悬浮窗权限',
                      why: '工作悬浮框与任务进度胶囊要画在别的应用上层',
                      granted: _perms?.overlay ?? false,
                      actionLabel: '去授权',
                      action: DeviceControl.requestOverlay,
                    )),
                    const Divider(height: 1),
                    _row(palette, _PermItem(
                      keyId: 'notifications',
                      icon: Icons.notifications_outlined,
                      title: '通知权限',
                      why: '桥事件与「重装后自动恢复无障碍」的回执走通知',
                      granted: _perms?.notifications ?? false,
                      actionLabel: '去授权',
                      action: DeviceControl.requestNotifications,
                    )),
                    const Divider(height: 1),
                    _row(palette, _PermItem(
                      keyId: 'capture',
                      icon: Icons.screenshot_monitor_outlined,
                      title: '屏幕捕获',
                      why: '静默截屏与分析当前画面（MediaProjection，运行态）',
                      granted: _captureReady,
                      readyLabel: '运行中',
                      actionLabel: _captureReady ? '停止' : '启动',
                      action: () async {
                        if (_captureReady) {
                          await DeviceControl.stopScreenCapture();
                        } else {
                          await DeviceControl.startScreenCapture();
                        }
                      },
                    )),
                    const Divider(height: 1),
                    _row(palette, _PermItem(
                      keyId: 'battery',
                      icon: Icons.battery_saver_outlined,
                      title: '电池与后台运行',
                      why: '省电策略冻结后台时，无障碍会掉线、助手与 PC 断连'
                          '${_battery?.isIgnoringBatteryOptimizations ?? false ? '（当前：已放行）' : '（当前：未放行）'}',
                      granted: _battery?.isIgnoringBatteryOptimizations ?? false,
                      // 入口常驻：这一行指向的是一整页"一步步清单"，不是一次
                      // 授权动作。全绿时只留一个勾，用户就再也进不去那一页——
                      // 而"允许受限设置"这类步骤、以及手动打"已完成"，都住在那里。
                      keepAction: true,
                      readyLabel: '已放行',
                      actionLabel: '去设置',
                      action: () async {
                        await Navigator.of(context).push(MaterialPageRoute(
                            builder: (_) => const BatteryGuideScreen()));
                      },
                    )),
                  ]),
                  const SizedBox(height: AppSpacing.section),
                  _card(palette, [
                    _elevationRow(palette),
                  ]),
                  const SizedBox(height: AppSpacing.page),
                ],
              ),
      ),
    );
  }

  /// 汇总卡：N/M 已就绪 + 缺项点名。全绿时也要说「全部就绪」，
  /// 不留一张看不出是查完还是没查的卡。
  Widget _summaryCard(AppPalette palette) {
    final readyCount = _readyCount;
    const total = 6;
    final allReady = readyCount == total;
    final missing = <String>[
      if (!(_bridge?.allFiles ?? false)) '所有文件访问',
      if (!(_perms?.accessibility ?? false)) '无障碍',
      if (!(_perms?.overlay ?? false)) '悬浮窗',
      if (!(_perms?.notifications ?? false)) '通知',
      if (!_captureReady) '屏幕捕获',
      if (!(_battery?.isIgnoringBatteryOptimizations ?? false)) '电池白名单',
    ];
    final tone = allReady ? palette.success : palette.warning;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPad),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: AppAlpha.weakFill),
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: tone.withValues(alpha: AppAlpha.strokeWeak), width: AppStroke.thin),
      ),
      child: Row(
        children: [
          Icon(
            allReady ? Icons.verified_user_outlined : Icons.warning_amber_rounded,
            size: 22,
            color: tone,
          ),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('$readyCount/$total 已就绪',
                    style: AppText.cardTitle.copyWith(color: tone)),
                const SizedBox(height: AppSpacing.micro),
                Text(
                  allReady ? '全部授权位就绪' : '缺少：${missing.join('、')}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.secondary.copyWith(color: palette.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  int get _readyCount {
    var n = 0;
    if (_bridge?.allFiles ?? false) n++;
    if (_perms?.accessibility ?? false) n++;
    if (_perms?.overlay ?? false) n++;
    if (_perms?.notifications ?? false) n++;
    if (_captureReady) n++;
    if (_battery?.isIgnoringBatteryOptimizations ?? false) n++;
    return n;
  }

  Widget _card(AppPalette palette, List<Widget> children) {
    // Material 而不是 Container：理由与设置页 _card 同源——decoration 会把
    // 行的墨水反馈挡在最近的 Material 祖先之外，点下去没有任何视觉确认。
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

  Widget _row(AppPalette palette, _PermItem item) {
    final pending = _pending.contains(item.keyId);
    final tone = item.granted ? palette.success : palette.warning;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.dense),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: tone.withValues(alpha: AppAlpha.badgeFill),
              shape: BoxShape.circle,
            ),
            child: Icon(item.icon, size: 19, color: tone),
          ),
          const SizedBox(width: AppSpacing.inner),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(item.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
                const SizedBox(height: AppSpacing.micro),
                Text(item.why,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.secondary.copyWith(color: palette.textSecondary)),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.dense),
          if (pending)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else if (item.granted && !item.keepAction)
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.check_circle, size: 18, color: palette.success),
                const SizedBox(width: 4),
                Text(item.readyLabel,
                    style: AppText.label.copyWith(color: palette.success)),
              ],
            )
          else
            _capsule(palette, item.actionLabel, item.action, item.keyId),
        ],
      ),
    );
  }

  Widget _capsule(AppPalette palette, String label,
      Future<void> Function() onTap, String keyId) {
    // 高 32 对齐设置页行尾统一胶囊（settings_screen_new._actionCapsule）。
    return SizedBox(
      height: 32,
      child: Material(
        color: palette.primary.withValues(alpha: 0.14),
        shape: StadiumBorder(
            side: BorderSide(
                color: palette.primary.withValues(alpha: AppAlpha.strokeWeak),
                width: 1)),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadius.pill),
          onTap: () => _grant(keyId, onTap),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.inner),
            child: Center(
              child: Text(label,
                  style: AppText.secondary.copyWith(
                      color: palette.primary, fontWeight: FontWeight.w600)),
            ),
          ),
        ),
      ),
    );
  }

  /// 提权代理：只读参考行。它不是授权位——没有「去授权」可点，恢复走
  /// adb 自举（设置页的提权引导），重启后消失属正常，这里只负责把
  /// 「exec 为什么走 App 自身 uid」答上。
  Widget _elevationRow(AppPalette palette) {
    final st = _elevation;
    final ready = st?.canAttempt ?? false;
    final tone = ready ? palette.success : palette.textFaint;
    return Row(
      children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            color: tone.withValues(alpha: AppAlpha.badgeFill),
            shape: BoxShape.circle,
          ),
          child: Icon(Icons.terminal_outlined, size: 19, color: tone),
        ),
        const SizedBox(width: AppSpacing.inner),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('提权代理（参考）',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
              const SizedBox(height: AppSpacing.micro),
              Text(
                st == null ? '未知' : st.toString(),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: AppText.secondary.copyWith(color: palette.textSecondary),
              ),
            ],
          ),
        ),
        Text('不算授权位',
            style: AppText.micro.copyWith(color: palette.textFaint)),
      ],
    );
  }
}

/// 一行授权位的数据。granted 的 trailing 显示 readyLabel（默认「已就绪」），
/// 缺时显示 actionLabel 胶囊。
class _PermItem {
  const _PermItem({
    required this.keyId,
    required this.icon,
    required this.title,
    required this.why,
    required this.granted,
    required this.actionLabel,
    required this.action,
    this.readyLabel = '已就绪',
    this.keepAction = false,
  });

  final String keyId;
  final IconData icon;
  final String title;
  final String why;
  final bool granted;
  final String readyLabel;
  final String actionLabel;
  final Future<void> Function() action;

  /// 即使状态已就绪也保留行动胶囊（该行指向的是一整页清单，不是一次授权）。
  final bool keepAction;
}
