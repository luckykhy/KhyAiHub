// khy-canary: Khy-1.1.47+32-202611152100-BATTERYGUARD
import 'package:flutter/material.dart';

import '../../core/services/battery_guard.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// 电池白名单 / 后台运行引导页。
///
/// ## 这一页要解决的事
///
/// 无障碍服务被系统的省电策略冻结后掉线，用户看到的现象是"助手忽然不听话了"。
/// 真实病因常常是三件互相独立的事，用户却只说同一句话：
///   1. 系统电池优化（Doze / App Standby）把后台网络与闹钟掐了；
///   2. 厂商的自启动 / 后台运行开关把应用挡在后台之外；
///   3. Android 13+ 侧载安装的「受限设置」把无障碍开关**置灰**，用户点不动，
///      于是误以为"电池优化没做"，跑去电池页反复折腾。
///
/// 所以本页把三件事**分开列**，每一步都写清"为什么要设"——只写"请去设置"的
/// 引导等于没引导：用户不知道不设会怎样，也不知道自己已经设了没有。
///
/// ## 边界
///
/// - 本页**只做提示与引导**，不阻断任何功能：没放行不等于不能用。
/// - 每步的「去设置」都可能失败（ROM 改名/拦截），失败时退到应用详情页并
///   如实说明，不假装成功。
/// - 「已完成」是用户自己打的勾——有些状态系统不告诉应用（自启动、受限设置），
///   强行让用户反复回去确认比让他点一下更难用。
class BatteryGuideScreen extends StatefulWidget {
  const BatteryGuideScreen({super.key});

  @override
  State<BatteryGuideScreen> createState() => _BatteryGuideScreenState();
}

class _BatteryGuideScreenState extends State<BatteryGuideScreen>
    with WidgetsBindingObserver {
  BatteryStatusInfo? _status;
  List<BatteryGuideStep> _steps = const <BatteryGuideStep>[];
  bool _loading = true;
  /// 正在跳转的行：按钮换成小圈，防止双击连发两次系统页跳转。
  final Set<String> _pending = <String>{};
  /// 每一步（或"一键放行"）最近一次动作的结果，按 key 存。
  ///
  /// 为什么存在卡片里而不是页面顶部的提示条：用户是在卡片上点的"去设置"，
  /// 结果就该出现在那张卡片上——顶部的提示条要滚动才看得见，而这一步的
  /// 卡片往往在屏幕下方，用户会以为点了没反应。
  final Map<String, String> _tips = <String, String>{};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _reload();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 授权发生在系统设置页（App 之外），回来必须复测——否则用户明明放行了，
    // 页面还显示"未放行"，他只会再去设置里翻一遍。
    if (state == AppLifecycleState.resumed) _reload();
  }

  Future<void> _reload() async {
    final results = await Future.wait([
      BatteryGuard.status(),
      BatteryGuard.steps(),
    ]);
    if (!mounted) return;
    setState(() {
      _status = results[0] as BatteryStatusInfo;
      _steps = results[1] as List<BatteryGuideStep>;
      _loading = false;
    });
  }

  Future<void> _run(String key, Future<BatteryActionResult> Function() action) async {
    if (_pending.contains(key)) return;
    setState(() {
      _pending.add(key);
      _tips.remove(key);
    });
    BatteryActionResult r;
    try {
      r = await action();
    } catch (e) {
      r = const BatteryActionResult(opened: false, via: '', message: '操作失败');
    }
    if (mounted) {
      setState(() {
        _pending.remove(key);
        _tips[key] = r.message.isEmpty ? (r.opened ? '已打开' : '没有打开') : r.message;
      });
    }
    // 跳转成功与否都复测一次：跳成功时状态可能已经变了，跳失败时至少把
    // "没打开"这件事如实留在提示里。
    await _reload();
  }

  Future<void> _markDone(BatteryGuideStep step) async {
    await BatteryGuard.markStepDone(step.id);
    await _reload();
  }

  Future<void> _undoDone(BatteryGuideStep step) async {
    await BatteryGuard.clearStepDone(step.id);
    await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final st = _status;
    return Scaffold(
      appBar: AppBar(title: const Text('电池与后台运行')),
      body: SafeArea(
        child: _loading
            ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
            : ListView(
                padding: const EdgeInsets.all(AppSpacing.page),
                children: [
                  _summaryCard(palette, st),
                  const SizedBox(height: AppSpacing.section),
                  _requestCard(palette),
                  const SizedBox(height: AppSpacing.section),
                  for (final step in _steps) ...[
                    _stepCard(palette, step),
                    const SizedBox(height: AppSpacing.dense),
                  ],
                  _footnote(palette),
                  const SizedBox(height: AppSpacing.page),
                ],
              ),
      ),
    );
  }

  /// 汇总卡：一眼看清"哪几项没放行"。全绿也要说话，不留一张看不出是查完
  /// 还是没查的卡。
  Widget _summaryCard(AppPalette palette, BatteryStatusInfo? st) {
    if (st == null) return const SizedBox.shrink();
    final items = <(String, bool, String)>[
      ('电池优化白名单', st.isIgnoringBatteryOptimizations, '已放行'),
      ('后台运行', !st.isBackgroundRestricted, '未被限制'),
      ('自启动', st.autostartAllowed, st.autostartLabel),
    ];
    final pendingCount = items.where((e) => !e.$2).length;
    final tone = pendingCount == 0 ? palette.success : palette.warning;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.cardPad),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: AppAlpha.weakFill),
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: tone.withValues(alpha: AppAlpha.strokeWeak), width: AppStroke.thin),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                pendingCount == 0 ? Icons.verified_user_outlined : Icons.warning_amber_rounded,
                size: 22,
                color: tone,
              ),
              const SizedBox(width: AppSpacing.dense),
              Expanded(
                child: Text(
                  pendingCount == 0 ? '后台运行没有被限制' : '$pendingCount 项需要放行',
                  style: AppText.cardTitle.copyWith(color: tone),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          for (final it in items)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  Icon(
                    it.$2 ? Icons.check_circle_outline : Icons.remove_circle_outline,
                    size: 15,
                    color: it.$2 ? palette.success : palette.textFaint,
                  ),
                  const SizedBox(width: 6),
                  Text(it.$1, style: AppText.secondary.copyWith(color: palette.textSecondary)),
                  const Spacer(),
                  Text(it.$3, style: AppText.micro.copyWith(color: palette.textFaint)),
                ],
              ),
            ),
          if (st.restrictedSettingsLikely) ...[
            const SizedBox(height: AppSpacing.dense),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.lock_outline, size: 15, color: palette.warning),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    '这台机器疑似处于「受限设置」：侧载安装的应用在 Android 13+ '
                    '会被限制，无障碍开关可能是灰的。下面第一步有解除方法。',
                    style: AppText.secondary.copyWith(color: palette.textSecondary),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  /// 一键请求加白（系统弹窗；被拦时自动退到电池优化应用列表）。
  Widget _requestCard(AppPalette palette) {
    final pending = _pending.contains('request');
    return _card(palette, [
      Row(
        children: [
          Icon(Icons.battery_saver_outlined, size: 20, color: palette.primary),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Text('一键放行电池优化',
                style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
          ),
          if (pending)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            _capsule(palette, '去请求', () => _run(
                'request', BatteryGuard.requestWhitelist)),
        ],
      ),
      const SizedBox(height: AppSpacing.dense),
      Text(
        '系统弹窗里选「允许」即可。若弹窗被安全中心拦下，会自动打开电池优化应用列表，'
        '在其中找到 khy-os 选「不受限制」。',
        style: AppText.secondary.copyWith(color: palette.textSecondary),
      ),
      if (_tips['request'] != null) _tipLine(palette, _tips['request']!),
    ]);
  }

  /// 一步引导卡片：入口名称 + 为什么要设 + 「去设置」「已完成」两个按钮。
  Widget _stepCard(AppPalette palette, BatteryGuideStep step) {
    final pending = _pending.contains(step.id);
    final tone = step.done ? palette.success : palette.warning;
    return _card(palette, [
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: tone.withValues(alpha: AppAlpha.badgeFill),
              shape: BoxShape.circle,
            ),
            child: Icon(
              step.done ? Icons.check_circle : Icons.info_outline,
              size: 17,
              color: tone,
            ),
          ),
          const SizedBox(width: AppSpacing.inner),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(step.title,
                    style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
                const SizedBox(height: AppSpacing.micro),
                Text(step.why,
                    style: AppText.secondary.copyWith(color: palette.textSecondary)),
              ],
            ),
          ),
        ],
      ),
      if (step.id == 'restricted_settings') ...[
        const SizedBox(height: AppSpacing.dense),
        _restrictedHowTo(palette),
      ],
      const SizedBox(height: AppSpacing.dense),
      Row(
        children: [
          if (step.optional)
            Text('这一步在当前系统上不存在',
                style: AppText.micro.copyWith(color: palette.textFaint))
          else if (pending)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else ...[
            _capsule(palette, '去设置', () => _run(step.id, () => BatteryGuard.openStep(step.id))),
            const SizedBox(width: AppSpacing.dense),
            if (step.done)
              TextButton(
                onPressed: () => _undoDone(step),
                child: Text('取消完成',
                    style: AppText.micro.copyWith(color: palette.textFaint)),
              )
            else
              TextButton(
                onPressed: () => _markDone(step),
                child: Text('已完成',
                    style: AppText.micro.copyWith(color: palette.textSecondary)),
              ),
          ],
        ],
      ),
      if (step.done && step.doneManually)
        Padding(
          padding: const EdgeInsets.only(top: AppSpacing.micro),
          child: Text('由你手动标记完成（系统未开放查询接口）',
              style: AppText.micro.copyWith(color: palette.textFaint)),
        ),
      if (_tips[step.id] != null) _tipLine(palette, _tips[step.id]!),
    ]);
  }

  /// 一步动作的结果说明：说清"到底打开了没有、走的哪条路"。
  Widget _tipLine(AppPalette palette, String tip) {
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.dense),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(AppSpacing.dense),
        decoration: BoxDecoration(
          color: palette.textSecondary.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(AppRadius.medium),
        ),
        child: Text(tip, style: AppText.secondary.copyWith(color: palette.textSecondary)),
      ),
    );
  }

  /// 「允许受限设置」没有可直接跳转的 Activity（它藏在应用信息页右上角的
  /// 溢出菜单里，系统没有对外的 Intent），所以只能图文说明。
  Widget _restrictedHowTo(AppPalette palette) {
    const lines = <String>[
      '1. 打开「设置 → 应用 → khy-os」（下面「去设置」按钮会直接送到应用信息页）',
      '2. 点右上角的三个点（⋮）菜单',
      '3. 菜单里选「允许受限设置」',
      '4. 回到「设置 → 无障碍」把 khy-os 的开关打开（开关不再是灰的）',
    ];
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.dense),
      decoration: BoxDecoration(
        color: palette.primary.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppRadius.medium),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final l in lines)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Text(l,
                  style: AppText.secondary.copyWith(color: palette.textSecondary)),
            ),
        ],
      ),
    );
  }

  Widget _footnote(AppPalette palette) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('说明', style: AppText.label.copyWith(color: palette.textSecondary)),
        const SizedBox(height: AppSpacing.micro),
        Text(
          '· 应用无法自行把包名写进系统白名单（系统不允许），只能请求 + 引导；\n'
          '· 各家 ROM 的入口名称与路径不同，页面按你的机型给出对应入口；\n'
          '· 这一页的检测结果只用于提示，不会限制本 App 的任何功能。',
          style: AppText.micro.copyWith(color: palette.textFaint),
        ),
        const SizedBox(height: AppSpacing.dense),
        // 「以后再说」的冷却记录是可以清掉的：用户处理完了、或者只是不想再被
        // 提醒，清一次就回到"下次冷启还会提示"的状态。
        TextButton(
          onPressed: () async {
            await BatteryGuard.clearPromptRecord();
            if (!mounted) return;
            setState(() => _tips['record'] = '已清除本机的提示记录，下次冷启会再提示一次');
          },
          child: Text('清除本机的提示记录',
              style: AppText.micro.copyWith(color: palette.textSecondary)),
        ),
        if (_tips['record'] != null) _tipLine(palette, _tips['record']!),
      ],
    );
  }

  Widget _card(AppPalette palette, List<Widget> children) {
    // Material 而不是 Container：理由与权限中心同源——decoration 会把行的墨水
    // 反馈挡在最近的 Material 祖先之外，点下去没有任何视觉确认。
    return Material(
      color: palette.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        side: BorderSide(color: palette.stroke, width: AppStroke.thin),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.dense),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
      ),
    );
  }

  Widget _capsule(AppPalette palette, String label, Future<void> Function() onTap) {
    return SizedBox(
      height: 32,
      child: Material(
        color: palette.primary.withValues(alpha: 0.14),
        shape: StadiumBorder(
            side: BorderSide(
                color: palette.primary.withValues(alpha: AppAlpha.strokeWeak), width: 1)),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadius.pill),
          onTap: onTap,
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
}
