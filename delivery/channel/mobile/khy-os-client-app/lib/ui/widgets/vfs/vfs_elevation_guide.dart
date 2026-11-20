// 提权激活引导。
//
// 为什么只讲提权代理：2026-11-12 人裁决「完全移除第三方提权应用依赖」。
// khyos 自带提权代理（sidecar）就是 uid 2000 shell，与旧方案的 server 同级，
// 所以这一页讲的是**怎么把 khyos 自己的代理拉起来**，而不是「去装另一个 App」。
//
// 两条路都写在这里，诚实标出各自要什么：
//   · 手机自己来（不需要电脑）：App 用本机的无线调试端点连回自己的 adbd，
//     拿到 uid 2000 的 shell，再从那里把代理拉起来。配对也在 App 内完成
//     （2026-11-17 起）：用户把手机屏幕上的 6 位配对码填进来，App 用 SPAKE2
//     与本机 adbd 完成授权——码只进口令，不落盘、不回传。
//   · 电脑侧一条命令（需要电脑）：兜底路径，不需要配对。
//
// 诚实的边界写在步骤里：
//   · 提权默认关闭——这是任务书红线。开关打开后还要用户再点一次「拉起」，
//     两步都在用户手上，App 不静默提权。
//   · 提权代理不随重启保留——平台事实；已配对的前提下，重启后 App 会自动
//     重连拉起（T5），不再需要任何人的动作。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/services/device_control.dart';
import '../../theme/app_colors.dart';
import '../../theme/design_tokens.dart';

/// 电脑侧拉起提权代理的命令（khyos 仓库内的脚本，兜底路径）。
const String kElevationHostCommand =
    'pwsh -File delivery/mobile/khy-os-client-app/scripts/provision-shell-sidecar.ps1 -FromDevice';

/// 电脑侧路线的激活步骤（公开常量：关键步骤被漏掉时，测试要能发现）。
const List<String> kElevationActivationSteps = <String>[
  '在电脑上装好 adb（Android SDK 的 platform-tools），并把手机和电脑连到同一个局域网。',
  '手机：设置 → 关于手机 → 连点版本号打开开发者选项 → 打开「无线调试」。',
  '电脑上跑一条命令，把 khyos 的提权代理拉起来：\n$kElevationHostCommand',
  '命令输出「listening on 8897 as uid 2000」即成功；回到本 App，'
      '私有目录与系统分区入口就会从灰态变成可点。',
];

/// 手机自己来的路线：步骤 + 前提。
///
/// 两处都不是可选的，漏了用户就卡在那一步之后（都有实测）：
///  · 「启用提权」开关默认关（任务书红线）——2026-11-17 实测，步骤里没提它时，
///    用户点「让手机自己拉起」得到的是一句他执行不了的桥工具命令。
///  · 配对码必须在**通知栏**填——2026-11-18 实测，配对端口只活在系统那个配对
///    弹窗期间，用户一回本 App 填码，设置页被 stop、弹窗关闭、端口从 mDNS 消失。
///    通知栏只让设置页 pause，弹窗活着，所以收码位置只能在通知栏。
const List<String> kElevationSelfServiceSteps = <String>[
  '手机：设置 → 开发者选项 → 无线调试，打开它（点下面的「跳转无线调试」按钮可以直接过去；'
      '有的手机落在开发者选项页，「无线调试」就在那一页里）。',
  '点「配对（通知栏收码）」，App 会在通知栏发一条带输入框的通知。',
  '点通知栏里的「跳转无线调试」→「使用配对码配对设备」，屏幕弹出 6 位数字，'
      '保持这个弹窗开着。',
  '下拉通知栏，在那条通知的输入框里填这 6 位，点「发送配对码」。'
      'App 自己完成与本机 adbd 的授权，这一步只需做一次。',
  '把上面的「启用提权」开关打开（默认关闭），再点「让手机自己拉起」。'
      'App 连回本机的 adbd，用 uid 2000 的身份把提权代理拉起来。',
];

/// 前提与注意事项。
const List<String> kElevationNotes = <String>[
  '提权代理是 uid 2000（shell）身份，由 khyos 自己实现，不依赖任何第三方提权 App。',
  '提权默认关闭；开关打开后还要再点一次「拉起」才生效，两步都在你手上。',
  '手机重启后代理不会自动保留——这是平台事实。已配对的前提下，App 会自动重连'
      '并把代理拉起来（不需要配对码，也不需要电脑）；系统若撤销了授权，'
      '状态会如实显示「未配对」。',
  '走「电脑侧一条命令」那条兜底路的话，重启后要重跑一次命令。',
];

/// 提权激活引导面板。
class VfsElevationGuideSheet extends StatefulWidget {
  const VfsElevationGuideSheet({super.key});

  /// 弹出面板。
  static Future<void> show(BuildContext context) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext sheetContext) => const VfsElevationGuideSheet(),
    );
  }

  @override
  State<VfsElevationGuideSheet> createState() => _VfsElevationGuideSheetState();
}

class _VfsElevationGuideSheetState extends State<VfsElevationGuideSheet>
    with WidgetsBindingObserver {
  ElevationStatus? _status;
  ElevationEndpoint _endpoint = const ElevationEndpoint();
  final TextEditingController _endpointField = TextEditingController();
  bool _busy = false;
  String _lastMessage = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _endpointField.dispose();
    super.dispose();
  }

  /// 从通知栏/shade 回到本页时必须重读状态。
  ///
  /// 为什么（实测 2026-11-18）：配对是在**通知栏**完成的——用户按第 2 步点了
  /// 「配对（通知栏收码）」后就去设置页开弹窗、下拉通知栏填码，配对成功发生在
  /// 本页看不见的地方。回来时这一页还显示着「未配对」，用户据此点「让手机自己拉起」，
  /// 收到的是一句「还没和这台手机配对过」——而他五分钟前刚配对成功。
  /// 页面不跟着现实走，就是把用户的正确操作判成错误。
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async {
    final status = await DeviceControl.getElevationStatus();
    final endpoint = await DeviceControl.getElevationEndpoint();
    if (!mounted) return;
    setState(() {
      _status = status;
      _endpoint = endpoint;
      if (_endpointField.text.isEmpty && endpoint.endpoint.isNotEmpty) {
        _endpointField.text = endpoint.endpoint;
      }
    });
  }

  /// 让手机自己把代理拉起来。
  Future<void> _bootstrap() async {
    final endpoint = _endpointField.text.trim();
    setState(() {
      _busy = true;
      _lastMessage = '';
    });
    if (endpoint.isNotEmpty) {
      await DeviceControl.setElevationEndpoint(endpoint);
    }
    final result = await DeviceControl.bootstrapElevation();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _lastMessage = result.ok
          ? result.message
          : '${result.message}${result.detail.isEmpty ? '' : '\n${result.detail}'}';
    });
    await _refresh();
  }

  /// 发通知栏收码通知，然后让用户去弹窗那一边填码。
  ///
  /// **不再有 App 内配对输入框**：实测 2026-11-18，配对端点只活在
  /// 「使用配对码配对设备」弹窗期间，用户一切回 App 填码，设置页被 stop、
  /// 弹窗关闭、服务从 mDNS 消失——App 内输码这条路在平台上根本走不通
  /// （连得上也是个过期端口）。通知栏只让设置页 pause，弹窗活着，
  /// 所以收码位置只能在通知栏。
  Future<void> _pair() async {
    setState(() {
      _busy = true;
      _lastMessage = '';
    });
    final ok = await DeviceControl.postPairingPrompt();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _lastMessage = ok
          ? '通知栏已发「输入配对码」。\n'
              '1. 点通知栏里的「跳转无线调试」；\n'
              '2. 进「无线调试 → 使用配对码配对设备」，保持弹窗开着；\n'
              '3. 下拉通知栏，在那条通知的输入框里填 6 位码，点「发送配对码」。'
          : '通知栏权限没开，发不出收码通知。请在系统设置里允许 khy-os 发通知，'
              '然后再点一次「配对」。';
    });
    await _refresh();
  }

  /// 开/关提权。关闭是显式动作：原生侧会请运行中的代理自杀。
  Future<void> _toggleEnabled(bool on) async {
    setState(() {
      _busy = true;
      _lastMessage = '';
    });
    final result = await DeviceControl.setElevationEnabled(on);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _lastMessage = result.message;
    });
    await _refresh();
  }

  /// 找本机的无线调试端点。找不到不是错误——手填也能用。
  Future<void> _discover() async {
    setState(() => _busy = true);
    final found = await DeviceControl.discoverElevationEndpoint();
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (found.isNotEmpty) {
        _endpointField.text = found;
        _lastMessage = '找到了：$found';
      } else {
        _lastMessage = '自动找没找到，手填手机「无线调试」那一页的 IP:端口也行。';
      }
    });
  }

  /// 跳到无线调试开关所在的页面。
  ///
  /// 原生侧带回退链：先试无线调试页本身，被拒就落到包含它的开发者选项页
  /// （这台设备实测走这一条）。toast 说明落在哪一页，因为「试过最好的那一跳」
  /// 和「最好的那一跳成功了」是两件事——用户要知道自己该在屏幕上找什么。
  ///
  /// 开关的开与配对弹窗的打开都要用户亲手点：App 能带你去，不能替你按。
  Future<void> _openDevSettings() async {
    await DeviceControl.openWirelessDebuggingSettings();
    if (!mounted) return;
    _toast('已跳转；在那一页里找「无线调试」。');
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final status = _status;

    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.page,
        right: AppSpacing.page,
        top: AppSpacing.page,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.page,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.shield_outlined, size: 18, color: palette.primary),
                const SizedBox(width: AppSpacing.inner),
                Expanded(
                  child: Text(
                    '激活提权',
                    style: AppText.title.copyWith(color: palette.textPrimary),
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                  icon: const Icon(Icons.close, size: 18),
                  color: palette.textSecondary,
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.dense),
            _statusCard(context, status),
            const SizedBox(height: AppSpacing.dense),
            _switchRow(context, status),
            const SizedBox(height: AppSpacing.cardGap),
            Text(
              '为什么需要它',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            Text(
              '浏览别的应用的私有目录、查看系统分区、冻结或卸载应用——这些都要 shell 权限。'
              'khyos 自带一个提权代理，让你不 root、不装任何第三方 App 就拿到这份权限。'
              '代理没起来时，本 App 会把这些入口画成灰态，而不是报错。',
              style: AppText.body.copyWith(color: palette.textSecondary),
            ),
            const SizedBox(height: AppSpacing.cardGap),
            Text(
              '手机自己来（不用电脑）',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            for (int i = 0; i < kElevationSelfServiceSteps.length; i++)
              _stepRow(context, i + 1, kElevationSelfServiceSteps[i]),
            const SizedBox(height: AppSpacing.dense),
            Row(
              children: <Widget>[
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy ? null : _openDevSettings,
                    child: const Text('跳转无线调试'),
                  ),
                ),
                const SizedBox(width: AppSpacing.inner),
                Expanded(
                  child: FilledButton(
                    onPressed: _busy ? null : _pair,
                    child: const Text('配对（通知栏收码）'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.dense),
            _endpointInput(context),
            const SizedBox(height: AppSpacing.dense),
            Row(
              children: <Widget>[
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy ? null : _discover,
                    child: const Text('自动找端点'),
                  ),
                ),
                const SizedBox(width: AppSpacing.inner),
                Expanded(
                  child: FilledButton(
                    onPressed: _busy ? null : _bootstrap,
                    child: Text(_busy ? '正在拉起…' : '让手机自己拉起'),
                  ),
                ),
              ],
            ),
            if (_lastMessage.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.dense),
              Text(
                _lastMessage,
                style: AppText.micro.copyWith(color: palette.textFaint),
              ),
            ],
            if (_endpoint.fingerprint.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.dense),
              Text(
                '本 App 的配对指纹：${_endpoint.fingerprint}',
                style: AppText.micro.copyWith(color: palette.textFaint),
              ),
            ],
            const SizedBox(height: AppSpacing.cardGap),
            Text(
              '怎么激活（电脑侧兜底）',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            for (int i = 0; i < kElevationActivationSteps.length; i++)
              _stepRow(context, i + 1, kElevationActivationSteps[i]),
            const SizedBox(height: AppSpacing.cardGap),
            Text(
              '前提与注意',
              style: AppText.cardTitle.copyWith(color: palette.textPrimary),
            ),
            const SizedBox(height: AppSpacing.dense),
            for (final note in kElevationNotes)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Padding(
                      padding: const EdgeInsets.only(top: 6, right: 8),
                      child: Icon(Icons.circle, size: 4, color: palette.textFaint),
                    ),
                    Expanded(
                      child: Text(
                        note,
                        style: AppText.micro.copyWith(color: palette.textFaint),
                      ),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: AppSpacing.cardGap),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                onPressed: () => Navigator.of(context).maybePop(),
                child: const Text('关闭'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 无线调试端点的输入框。IP:端口，一个字段。配对码弹窗里的端口和这里的
  /// 连接端口是两个端口，别混——自动找会拿对。
  Widget _endpointInput(BuildContext context) {
    final palette = AppPalette.of(context);
    return TextField(
      controller: _endpointField,
      keyboardType: TextInputType.text,
      style: AppText.body.copyWith(color: palette.textPrimary),
      decoration: InputDecoration(
        labelText: '本机无线调试地址（IP:端口，可留空）',
        hintText: '留空则先用本机 adbd 的 5555 端口',
        border: const OutlineInputBorder(),
        isDense: true,
      ),
    );
  }

  /// 提权开关。默认关（任务书红线）；开与关都记审计。
  Widget _switchRow(BuildContext context, ElevationStatus? status) {
    final palette = AppPalette.of(context);
    final enabled = status?.enabled ?? false;
    return Row(
      children: <Widget>[
        Icon(Icons.key_outlined, size: 18, color: palette.textSecondary),
        const SizedBox(width: AppSpacing.inner),
        Expanded(
          child: Text(
            '启用提权（默认关闭；开启后 App 才会连本机 adbd 拉起代理）',
            style: AppText.body.copyWith(color: palette.textSecondary),
          ),
        ),
        Switch(
          value: enabled,
          onChanged: _busy ? null : _toggleEnabled,
        ),
      ],
    );
  }

  /// 当前状态。这一段要能一眼看出「现在卡在哪一步」。
  Widget _statusCard(BuildContext context, ElevationStatus? status) {
    final palette = AppPalette.of(context);
    if (status == null) {
      return _card(palette.surfaceHigh, palette.stroke, null, '正在查提权状态…');
    }
    if (status.available) {
      return _card(
        palette.success.withValues(alpha: AppAlpha.weakFill),
        palette.success.withValues(alpha: AppAlpha.strokeWeak),
        palette.success,
        '提权代理已就绪（层：${status.elevatedLevel}）——'
            '私有目录与系统分区现在可以访问了。',
      );
    }
    final auth = status.isPaired ? '已配对' : '未配对';
    return _card(
      palette.warning.withValues(alpha: AppAlpha.weakFill),
      palette.warning.withValues(alpha: AppAlpha.strokeWeak),
      palette.warning,
      '提权代理还没起来（层：${status.elevatedLevel}，设备：$auth）'
          '${status.reason.isEmpty ? '' : '：${status.reason}'}。',
    );
  }

  Widget _card(
    Color background,
    Color border,
    Color? accent,
    String text,
  ) {
    final palette = AppPalette.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppRadius.small),
        border: Border.all(color: border),
      ),
      child: Text(
        text,
        style: AppText.body.copyWith(color: accent ?? palette.textSecondary),
      ),
    );
  }

  /// 一步。序号用实心圆点，不用数字——数字要占一行的宽度，读起来更散。
  Widget _stepRow(BuildContext context, int index, String text) {
    final palette = AppPalette.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.dense),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 20,
            height: 20,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: palette.primary.withValues(alpha: 0.15),
              shape: BoxShape.circle,
            ),
            child: Text(
              '$index',
              style: AppText.micro.copyWith(color: palette.primary),
            ),
          ),
          const SizedBox(width: AppSpacing.inner),
          Expanded(
            child: Text(
              text,
              style: AppText.body.copyWith(color: palette.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}
