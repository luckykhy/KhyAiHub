import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/gateway/khyos_api.dart';
import '../../core/services/app_logger.dart';
import '../../core/services/device_control.dart';
import '../../core/services/local_model_store.dart';
import '../../core/services/update_check_service.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// 「版本与更新」：平台版本态 + 能力资产版本态。
///
/// WHY THIS EXISTS. 这个 App 没有可独立升级的引擎——llama.cpp 与 QuickJS 都编进
/// APK，升级只能整包重装（`entries/apk-unpack/hiao2/khyos-手机版欠缺功能.md` 第 11
/// 条把这件事记成了欠缺）。诚实的范围因此只有两样：**平台（后端）的版本态**与
/// **能力资产（当前只有内置视觉模型一对）的版本态**。APK 自替换和引擎渠道切换
/// 都不做，也不在这里假装能做。
///
/// THE ONE THING IT MUST NOT DO IS LIE. 三种「看起来一样」的结局各有不同的下一步：
///   · 有新版        → 去打开发布页；
///   · 没有新版      → 什么都不用做；
///   · **查不到**    → 去看每个源各自的原因，或重试。
/// 把第三种显示成第二种是本 widget 结构上要防的唯一事故——后端
/// `latestVersionResolver` 全失败时判 `indeterminate`，Dart 侧原样继承，
/// `UpdateCheckResult.indeterminateReason` 里的话必须一字不改地摆出来。
///
/// 为什么探测走后端代查：见 `update_check_service.dart` 文件头。手机只报自己的
/// 版本号，不直连 GitHub / PyPI / npm。
class UpdateSection extends StatefulWidget {
  const UpdateSection({
    super.key,
    this.api,
    this.channel = 'stable',
    this.loader,
  });

  final KhyOsApi? api;

  /// 更新轨道。接线阶段从 `AppConfig` 的渠道字段传入（stable / preview）。
  final String channel;

  /// 探测函数的注入点。null 时走真实网络。
  ///
  /// 存在的唯一理由是测试：三态渲染必须被 widget test 钉住，而测试不该打真网。
  /// 不是策略接口——只有一份实现。
  final Future<UpdateCheckResult> Function(String current, String channel)?
      loader;

  @override
  State<UpdateSection> createState() => _UpdateSectionState();
}

enum _Phase { checking, upToDate, updateAvailable, indeterminate, failed }

class _UpdateSectionState extends State<UpdateSection> {
  final _store = LocalModelStore.instance;

  _Phase _phase = _Phase.checking;
  UpdateCheckResult? _result;
  String _detail = '';
  bool _busy = false;

  List<CapabilityStatus> _assets = const [];
  String _assetsDetail = '';
  bool _assetsLoaded = false;

  @override
  void initState() {
    super.initState();
    _check();
    _loadAssets();
  }

  Future<void> _check() async {
    setState(() {
      _phase = _Phase.checking;
      _detail = '';
    });
    try {
      final loader = widget.loader;
      final result = loader != null
          ? await loader(kAppVersion, widget.channel)
          : await (await _service())
              .check(current: kAppVersion, channel: widget.channel);
      if (!mounted) return;
      setState(() {
        _result = result;
        _phase = switch (result.verdict) {
          UpdateVerdict.upToDate => _Phase.upToDate,
          UpdateVerdict.updateAvailable => _Phase.updateAvailable,
          UpdateVerdict.indeterminate => _Phase.indeterminate,
        };
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.failed;
        _detail = '$e';
      });
    }
  }

  /// 取探测服务。
  ///
  /// 自持 api 时先 `loadConnection()`：一个没有加载过连接的 `KhyOsApi` 实例，
  /// `apiFetch` 必抛「未连接到 khy-os 后端」（khyos_api.dart:384）——那不是降级，
  /// 而是确定性失败。与 plugin_market_screen.dart:113 同一处理。
  ///
  /// loadConnection 自己抛时不在这里转译：让 check() 去抛那句能指导用户下一步的
  /// 话，比把安全存储的异常原样摆出来有用。
  Future<UpdateCheckService> _service() async {
    final api = widget.api;
    if (api != null) return UpdateCheckService(api);
    final fresh = KhyOsApi();
    try {
      await fresh.loadConnection();
    } catch (_) {
      // 读不到安全存储不代表没配对过，但这里没有地址可填（接线方注入已连通的
      // 实例），所以按「没连过」继续走。
    }
    return UpdateCheckService(fresh);
  }

  Future<void> _loadAssets() async {
    try {
      final statuses = await _store.capabilityStatuses();
      if (!mounted) return;
      setState(() {
        _assets = statuses;
        _assetsLoaded = true;
      });
    } catch (e) {
      if (!mounted) return;
      // 读不到磁盘状态就说读不到。这里最常见的原因是 path_provider 的平台通道
      // 还没就绪，说「未安装」会让用户去点一个注定失败的下载。
      setState(() {
        _assetsLoaded = true;
        _assetsDetail = '读不到能力资产的本地状态：$e';
      });
    }
  }

  Future<void> _openReleasePage() async {
    final page = _result?.releasePage;
    if (page == null || page.isEmpty) return;
    setState(() => _busy = true);
    final ok = await DeviceControl.openUrl(page);
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('没有 App 能打开这个发布页：$page。请复制地址用浏览器打开。'),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _header(palette),
        const SizedBox(height: AppSpacing.dense),
        _body(palette),
        const SizedBox(height: AppSpacing.section),
        _assetsHeader(palette),
        const SizedBox(height: AppSpacing.dense),
        _assetsBody(palette),
      ],
    );
  }

  Widget _header(AppPalette palette) {
    return Row(
      children: [
        Icon(Icons.system_update_alt, size: 18, color: palette.primary),
        const SizedBox(width: AppSpacing.dense),
        Expanded(
          child: Text('平台版本',
              style: AppText.body
                  .copyWith(fontWeight: FontWeight.w600, color: palette.textPrimary)),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          decoration: BoxDecoration(
            color: palette.primary.withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(AppRadius.small),
          ),
          child: Text('本机 v$kAppVersion',
              style: AppText.secondary.copyWith(color: palette.primary)),
        ),
      ],
    );
  }

  Widget _body(AppPalette palette) {
    switch (_phase) {
      case _Phase.checking:
        // 没有不确定进度圈，理由同 local_model_section：pumpAndSettle 会等一个
        // 永远排着帧的 CircularProgressIndicator，设置页就永远 settle 不了。
        return Text('正在检查平台版本（后端代查 GitHub / PyPI / npm）…',
            style: AppText.secondary.copyWith(color: palette.textSecondary));

      case _Phase.upToDate:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _result == null
                  ? '没有可升级的新版本。'
                  : '没有可升级的新版本：本机 v${_result.current}，'
                      '最新发布版 v${_result.latest ?? '?'}'
                      '（来自 ${_result.sourceLabel ?? '未知源'}）。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
            const SizedBox(height: AppSpacing.dense),
            _sourceReadout(palette),
            const SizedBox(height: AppSpacing.dense),
            _trackNote(palette),
            const SizedBox(height: AppSpacing.dense),
            _textButton('重新检查', _check),
          ],
        );

      case _Phase.updateAvailable:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '有新版本：本机 v${_result?.current ?? kAppVersion} → '
              '最新发布版 v${_result?.latest ?? '?'}'
              '（来自 ${_result?.sourceLabel ?? '未知源'}）。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
            const SizedBox(height: AppSpacing.dense),
            _sourceReadout(palette),
            const SizedBox(height: AppSpacing.dense),
            _trackNote(palette),
            const SizedBox(height: AppSpacing.dense),
            _platformUpdateNote(palette),
            const SizedBox(height: AppSpacing.dense),
            Row(children: [
              if ((_result?.releasePage ?? '').isNotEmpty) ...[
                _button('打开发布页', _openReleasePage, busy: _busy),
                const SizedBox(width: AppSpacing.dense),
              ],
              _textButton('重新检查', _check),
            ]),
            if ((_result?.releasePage ?? '').isEmpty) ...[
              const SizedBox(height: AppSpacing.dense),
              Text('没有可打开发布页的地址：后端没有配置更新源'
                  '（KHY_UPDATE_GITHUB_REPOSITORY）。',
                  style: AppText.secondary
                      .copyWith(color: palette.textFaint, fontSize: 11)),
            ],
          ],
        );

      case _Phase.indeterminate:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('查不到最新版本——这不是「已是最新」。',
                style: AppText.secondary.copyWith(color: palette.warning)),
            const SizedBox(height: AppSpacing.dense),
            _sourceReadout(palette),
            const SizedBox(height: AppSpacing.dense),
            _trackNote(palette),
            const SizedBox(height: AppSpacing.dense),
            Text(_result?.indeterminateReason ?? '',
                style: AppText.secondary.copyWith(color: palette.textSecondary)),
            const SizedBox(height: AppSpacing.dense),
            Row(children: [
              _button('重新检查', _check, busy: _busy),
            ]),
          ],
        );

      case _Phase.failed:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_detail.isEmpty ? '探测失败，但没有原因——这本身是个 bug。' : _detail,
                style: AppText.secondary.copyWith(color: palette.warning)),
            const SizedBox(height: AppSpacing.dense),
            Row(children: [
              _button('重新检查', _check, busy: _busy),
            ]),
          ],
        );
    }
  }

  Widget _sourceReadout(AppPalette palette) {
    final result = _result;
    if (result == null) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('每源：${result.sourceReadout}',
            style: AppText.secondary
                .copyWith(color: palette.textFaint, fontSize: 11)),
        if (result.backendRunningVersion != null) ...[
          const SizedBox(height: 2),
          // 这一行是背景，不是结论。手机端与平台是两条独立版本线，拿它比只会
          // 得到无意义的「你落后了」——所以只陈述事实，不参与上面的判定。
          Text('后端所在主机运行版本 v${result.backendRunningVersion}'
              '（不参与上面的判定）',
              style: AppText.secondary
                  .copyWith(color: palette.textFaint, fontSize: 11)),
        ],
      ],
    );
  }

  /// 后端自己那半边的状态。只在非 idle 时说——idle 是常态，说一句「空闲」只会
  /// 让用户以为出了什么事。
  Widget _platformUpdateNote(AppPalette palette) {
    final state = _result?.platformUpdateState;
    if (state == null || state.isEmpty || state == 'idle') {
      return const SizedBox.shrink();
    }
    return Text('后端自己的更新状态是 $state：它在等自己重启，'
        '与这个 App 要不要升级无关。',
        style: AppText.secondary.copyWith(color: palette.textFaint, fontSize: 11));
  }

  /// preview 轨道当前不改变探测结果。
  ///
  /// 这句话存在的唯一理由是它必须被说出来：后端 `latestVersionResolver` 按构造
  /// 只取最高的非 prerelease 正式版，所以选 preview 与选 stable 看到的是同一个
  /// 版本号。不说，用户就会以为预览版已经在生效——一个没有任何症状的错误信念。
  Widget _trackNote(AppPalette palette) {
    if (_result?.releaseChannel != 'preview') {
      return const SizedBox.shrink();
    }
    return Text('preview 轨道暂不改变探测结果：后端只报最高的正式版。'
        '要看预览版，需要平台侧的版本解析器支持 prerelease。',
        style: AppText.secondary.copyWith(color: palette.textFaint, fontSize: 11));
  }

  // ── 能力资产 ──

  Widget _assetsHeader(AppPalette palette) {
    return Row(
      children: [
        Icon(Icons.inventory_2_outlined, size: 18, color: palette.primary),
        const SizedBox(width: AppSpacing.dense),
        Expanded(
          child: Text('能力资产',
              style: AppText.body
                  .copyWith(fontWeight: FontWeight.w600, color: palette.textPrimary)),
        ),
        Text('可独立更新', style: AppText.micro.copyWith(color: palette.textFaint)),
      ],
    );
  }

  Widget _assetsBody(AppPalette palette) {
    if (!_assetsLoaded) {
      return Text('正在读取能力资产清单…',
          style: AppText.secondary.copyWith(color: palette.textSecondary));
    }
    if (_assetsDetail.isNotEmpty) {
      return Text(_assetsDetail,
          style: AppText.secondary.copyWith(color: palette.warning));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final status in _assets) _assetRow(palette, status),
        const SizedBox(height: AppSpacing.dense),
        Text('下载与升级在「内置本地模型」里做；这里只报版本态。',
            style: AppText.secondary
                .copyWith(color: palette.textFaint, fontSize: 11)),
        // 只在真的有没有登记哈希的资产时才说这句。无条件说出来会在填了 sha256
        // 之后变成谎话，而这句话的全部作用就是不说谎。
        if (_assets.any((s) => s.asset.sha256.isEmpty)) ...[
          const SizedBox(height: 2),
          Text('没有登记 sha256 的资产按版本号 + 字节数判断，未经哈希校验。',
              style: AppText.secondary
                  .copyWith(color: palette.textFaint, fontSize: 11)),
        ],
      ],
    );
  }

  Widget _assetRow(AppPalette palette, CapabilityStatus status) {
    final color = status.needsFetch ? palette.textSecondary : palette.primary;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            status.needsFetch ? Icons.download_outlined : Icons.check_circle_outline,
            size: 14,
            color: color,
          ),
          const SizedBox(width: AppSpacing.dense),
          Expanded(
            child: Text('${status.asset.name}：${status.label}',
                style: AppText.secondary.copyWith(color: color)),
          ),
        ],
      ),
    );
  }

  Widget _button(String label, VoidCallback onTap, {bool busy = false}) {
    return FilledButton(
      onPressed: busy ? null : onTap,
      child: Text(label),
    );
  }

  Widget _textButton(String label, VoidCallback onTap) {
    return TextButton(onPressed: onTap, child: Text(label));
  }
}
