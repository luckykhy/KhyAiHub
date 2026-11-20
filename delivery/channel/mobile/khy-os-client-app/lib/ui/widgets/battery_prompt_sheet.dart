// khy-canary: Khy-1.1.47+32-202611152100-BATTERYGUARD
import 'package:flutter/material.dart';

import '../../core/services/battery_guard.dart';
import '../../core/services/device_control.dart';
import '../screens/battery_guide_screen.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// 电池白名单的非阻断式底部提示面板。
///
/// ## 为什么是"非阻断"
///
/// 无障碍掉线是**用户体验问题**，不是 App 的运行前提。所以这里用底部面板
/// （可以随手划掉、不会挡住任何功能），而不是弹窗对话框，更不是启动闸门。
/// 一个把用户拦在启动路径上的提示，用户第二次就会开始找关闭它的办法——
/// 那样它反而拦住了真正要解决的事。
///
/// ## 什么时候弹
///
/// - 首次启动，或检测到"还没放行"；
/// - 用户没有点过「以后再说」（点了就 7 天内不再自动弹）；
/// - 通知权限已授予——**先请求权限，再展示面板**：引导与掉线提醒都靠通知送达，
///   通知权限没给时面板本身就是最后一条通道（请求通知的弹窗在系统里，
///   不占本 App 的界面）。
///
/// ## 什么时候不弹
///
/// 全绿（已在白名单、未被后台限制、自启动已允许）不弹；用户走完引导不弹。
class BatteryPromptSheet extends StatelessWidget {
  const BatteryPromptSheet({super.key, required this.status});

  final BatteryStatusInfo? status;

  /// 按需展示：先问原生"该不该弹"，再决定要不要弹。
  ///
  /// 返回 true 表示这次真的弹了（便于调用方记账）。
  static Future<bool> maybeShow(BuildContext context) async {
    try {
      final state = await BatteryGuard.promptState();
      if (!state.shouldPrompt) return false;

      // 通知权限未授予时先请求：引导通知与掉线提醒都靠它送达。
      // 请求是系统弹窗，App 侧不阻塞；即便用户拒绝，面板仍然照常展示。
      try {
        final perms = await DeviceControl.checkPermissions();
        if (!perms.notifications) {
          await DeviceControl.requestNotifications();
        }
      } catch (_) {
        // 权限查询失败不阻断：面板本身不依赖通知权限。
      }

      final status = state.status ?? await BatteryGuard.status();
      if (!context.mounted) return false;
      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (ctx) => BatteryPromptSheet(status: status),
      );
      return true;
    } catch (_) {
      // 提示层任何失败都不许影响 App 启动。
      return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final st = status;
    final manufacturer = (st?.manufacturer ?? '').trim();
    final reasons = <String>[
      if (st != null && !st.isIgnoringBatteryOptimizations)
        '还没加入电池优化白名单：息屏后系统会冻结后台网络与定时任务',
      if (st != null && st.isBackgroundRestricted) '当前处于后台受限状态',
      if (st != null && st.autostartDenied) '厂商侧显示自启动已被禁止',
      if (st != null && st.restrictedSettingsLikely)
        '疑似处于「受限设置」：侧载安装的应用无障碍开关会被置灰',
    ];
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
            AppSpacing.page, 0, AppSpacing.page, AppSpacing.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('电池优化可能会让 khy-os 掉线',
                style: AppText.cardTitle.copyWith(color: palette.textPrimary)),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '系统的省电策略会在息屏后冻结本应用：锁屏一会儿，'
              '无障碍服务就可能不再收到事件，助手与 PC 也会断连。'
              '把 khy-os 设为「不受限制」就能避免。'
              '${manufacturer.isEmpty ? '' : '\n当前机型：$manufacturer'}',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
            if (reasons.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.dense),
              for (final r in reasons)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(Icons.arrow_right, size: 14, color: palette.warning),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(r,
                            style: AppText.micro.copyWith(color: palette.textSecondary)),
                      ),
                    ],
                  ),
                ),
            ],
            const SizedBox(height: AppSpacing.section),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () async {
                      await BatteryGuard.dismissPrompt();
                      if (context.mounted) Navigator.of(context).pop();
                    },
                    child: Text('以后再说',
                        style: AppText.secondary.copyWith(color: palette.textSecondary)),
                  ),
                ),
                const SizedBox(width: AppSpacing.dense),
                Expanded(
                  child: FilledButton(
                    onPressed: () async {
                      // 走引导页：那里有一步一清单与"为什么要设"。
                      // 不在这里直接跳系统页——一步一清单比一串跳转更不容易让
                      // 用户漏掉厂商特有的那几个开关。
                      //
                      // 导航器先取出来：pop 之后这个 sheet 的 context 就要被
                      // 卸载，再用它 push 会踩到已失效的 element。
                      final nav = Navigator.of(context);
                      await BatteryGuard.dismissPrompt();
                      if (!context.mounted) return;
                      nav.pop();
                      nav.push(MaterialPageRoute(
                          builder: (_) => const BatteryGuideScreen()));
                    },
                    // 不覆盖文字颜色：FilledButton 的前景色是 onPrimary（浅色），
                    // 换成 primary（橙）就变成橙底橙字——真机截图里按钮是空白的。
                    child: const Text('去看怎么设'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.micro),
            Text('提示只弹一次；选「以后再说」后 7 天内不再自动提醒。'
                '这一层不会限制 khy-os 的任何功能。',
                style: AppText.micro.copyWith(color: palette.textFaint)),
          ],
        ),
      ),
    );
  }
}
