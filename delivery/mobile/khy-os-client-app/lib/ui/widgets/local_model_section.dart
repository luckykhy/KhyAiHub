import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/config/app_config.dart';
import '../../core/services/device_control.dart';
import '../../core/services/local_model_store.dart';
import '../theme/app_colors.dart';
import '../theme/design_tokens.dart';

/// The built-in local model: download, start, stop, delete.
///
/// WHY THIS EXISTS. The requirement (2026-10-27) is a local vision model with no
/// Ollama install anywhere. The engine is llama.cpp linked into the APK; the
/// model is ~2.7 GB fetched on demand. This widget is the only place that
/// decision is exposed to the user, and it is deliberately the loudest thing in
/// the vision settings: a 2.7 GB download is a commitment, and burying it behind
/// a toggle is how a user ends up with a full disk they did not agree to.
///
/// THE ONE THING IT MUST NOT DO IS LIE. Three states are easy to conflate and
/// each has a different fix:
///   · files not on disk      → offer the download;
///   · files on disk, engine
///     not running            → offer 启动 (this is the post-restart state, and
///                              the engine is process state so it dies with the
///                              app);
///   · engine running          → show the port and offer 停止.
/// A button that says "启用" and then fails because the model was never
/// downloaded is the failure mode this widget is structured to prevent.
///
/// WHY THE ENDPOINT IS FILLED IN FOR THE USER. Starting the engine returns the
/// port it actually bound (it prefers 8780 but falls back), so the URL is only
/// knowable after the fact. Writing it into `visionBaseUrl` here means the user
/// never types a loopback address, and `AppConfigData.visionIsLocal` becomes
/// true by construction rather than by the user happening to spell localhost
/// correctly — which is what makes the privacy gate for background sync hold.
class LocalModelSection extends StatefulWidget {
  const LocalModelSection({super.key, this.onEndpointChanged});

  /// Called after the config has been rewritten so the parent can refresh its
  /// own view of the vision fields. Without this the base-URL field above would
  /// still show the old value until the page is reopened.
  final VoidCallback? onEndpointChanged;

  @override
  State<LocalModelSection> createState() => _LocalModelSectionState();
}

enum _Phase { checking, needDownload, downloading, ready, running, failed }

class _LocalModelSectionState extends State<LocalModelSection> {
  final _store = LocalModelStore.instance;

  _Phase _phase = _Phase.checking;
  String _detail = '';
  double _progress = 0;
  String _progressLabel = '';
  bool _busy = false;
  int _port = 0;
  LocalModelState? _state;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _phase = _Phase.checking);
    try {
      final s = await _store.prepare();
      final status = await DeviceControl.localVisionStatus();
      if (!mounted) return;
      setState(() {
        _state = s;
        _port = (status['port'] as int?) ?? 0;
        _phase = (status['running'] == true)
            ? _Phase.running
            : (s.complete ? _Phase.ready : _Phase.needDownload);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.failed;
        _detail = '读取本地模型状态失败：$e';
      });
    }
  }

  Future<void> _download() async {
    setState(() {
      _busy = true;
      _phase = _Phase.downloading;
      _progress = 0;
      _detail = '';
    });

    for (final name in [
      LocalModelStore.modelFile,
      LocalModelStore.mmprojFile,
    ]) {
      try {
        // download() returns false when the connection dropped mid-stream. That
        // is the expected outcome of a phone doing something else, so it is
        // reported as "可继续" rather than as a failure — and the next attempt
        // resumes from the .part file rather than starting over.
        final done = await _store.download(name, onProgress: (got, total) {
          if (!mounted) return;
          setState(() {
            _progress = total > 0 ? got / total : 0;
            _progressLabel = '${_mb(got)} / ${_mb(total)}';
          });
        });
        if (!done) {
          if (!mounted) return;
          setState(() {
            _phase = _Phase.failed;
            _detail = '下载中断，已保存进度。重新点「下载」会接着下，不会从零开始。';
          });
          return;
        }
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _phase = _Phase.failed;
          _detail = '$e';
        });
        return;
      }
    }

    if (!mounted) return;
    setState(() => _busy = false);
    await _refresh();
  }

  Future<void> _start() async {
    setState(() {
      _busy = true;
      _detail = '';
    });
    final s = await _store.prepare();
    final r = await DeviceControl.startLocalVision(
        s.modelPathFor(LocalModelStore.modelFile),
        s.modelPathFor(LocalModelStore.mmprojFile));
    if (!mounted) return;
    setState(() => _busy = false);

    if (r['ok'] == true) {
      final url = r['url'] as String? ?? '';
      final model = r['model'] as String? ?? '';
      // Persist the endpoint so every existing consumer works unchanged — the
      // chat vision call, the settings test button, and the privacy gate that
      // background sync reads.
      await AppConfig.save(
        visionBaseUrl: url,
        visionApiKey: '',
        visionModel: model,
      );
      widget.onEndpointChanged?.call();
      if (!mounted) return;
      setState(() {
        _phase = _Phase.running;
        _port = (r['port'] as int?) ?? 0;
        _detail = '已把视觉端点设为 $url';
      });
    } else {
      setState(() {
        _phase = _Phase.failed;
        _detail = (r['message'] as String?) ?? '启动失败';
      });
    }
  }

  Future<void> _stop() async {
    await DeviceControl.stopLocalVision();
    if (!mounted) return;
    setState(() => _phase = _Phase.ready);
  }

  Future<void> _delete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除本地模型？'),
        content: Text('会释放约 ${_state?.humanTotal ?? '2.7'} 空间。'
            '之后要用就得重新下载。'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    await DeviceControl.stopLocalVision();
    await _store.deleteModel();
    if (!mounted) return;
    await _refresh();
  }

  String _mb(int bytes) {
    final mb = bytes / (1024 * 1024);
    return mb >= 1024 ? '${(mb / 1024).toStringAsFixed(2)} GB' : '${mb.toStringAsFixed(0)} MB';
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
      ],
    );
  }

  Widget _header(AppPalette palette) {
    return Row(
      children: [
        Icon(Icons.memory, size: 18, color: palette.primary),
        const SizedBox(width: AppSpacing.dense),
        Expanded(
          child: Text('内置本地模型',
              style: AppText.body
                  .copyWith(fontWeight: FontWeight.w600, color: palette.textPrimary)),
        ),
        if (_phase == _Phase.running)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: palette.primary.withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(AppRadius.small),
            ),
            child: Text('运行中',
                style: AppText.secondary.copyWith(color: palette.primary)),
          ),
      ],
    );
  }

  Widget _body(AppPalette palette) {
    switch (_phase) {
      case _Phase.checking:
        // NO indeterminate spinner here, deliberately. `pumpAndSettle` waits for
        // every scheduled frame to finish, and a CircularProgressIndicator
        // schedules frames forever — so one of these anywhere on the settings
        // page makes the page permanently unsettleable, which broke four
        // existing widget tests the moment this section was mounted.
        //
        // The deeper reason it should not be here anyway: this phase lasts one
        // microtask (two channel calls). A spinner that appears and vanishes
        // inside a frame is a flicker, not feedback. The phase only becomes
        // visible if a channel call genuinely hangs, and in that case static
        // text saying "正在检查…" is the honest thing to show.
        return const Padding(
          padding: EdgeInsets.symmetric(vertical: AppSpacing.dense),
          child: Text('正在检查本地模型…'),
        );

      case _Phase.needDownload:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '不装 Ollama 也能用本地视觉模型：引擎已经打进这个 App，'
              '只差模型文件。\n\n'
              '需要下载约 ${_state?.humanTotal ?? '2.7 GB'}（Q4 量化，含视觉投影器），'
              '存到 App 私有目录，可随时删除。下载中断后会保留进度，'
              '重新点「下载」会接着下。',
              style: AppText.secondary.copyWith(color: palette.textSecondary),
            ),
            const SizedBox(height: AppSpacing.dense),
            _button('下载模型（${_state?.humanTotal ?? '2.7 GB'}）', _download,
                busy: _busy),
          ],
        );

      case _Phase.downloading:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            LinearProgressIndicator(value: _progress),
            const SizedBox(height: AppSpacing.dense),
            Text(_progressLabel.isEmpty ? '准备下载…' : _progressLabel,
                style: AppText.secondary.copyWith(color: palette.textSecondary)),
            const SizedBox(height: AppSpacing.dense),
            Text('下载期间可以退出这个页面，但别杀 App——杀了这一段的进度还在，'
                '只是要重新进来点一次。',
                style: AppText.secondary
                    .copyWith(color: palette.textFaint, fontSize: 11)),
          ],
        );

      case _Phase.ready:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('模型已就绪（${_state?.humanTotal ?? ''}）。'
                '引擎随 App 进程存活，重启后要再点一次「启动」。',
                style: AppText.secondary.copyWith(color: palette.textSecondary)),
            const SizedBox(height: AppSpacing.dense),
            Row(children: [
              _button('启动', _start, busy: _busy),
              const SizedBox(width: AppSpacing.dense),
              _textButton('删除模型', _delete),
            ]),
          ],
        );

      case _Phase.running:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('已在 127.0.0.1:$_port 提供 OpenAI 兼容端点，'
                '视觉模型字段已自动填好。截图不会离开这台手机。',
                style: AppText.secondary.copyWith(color: palette.textSecondary)),
            const SizedBox(height: AppSpacing.dense),
            Row(children: [
              _button('停止', _stop, busy: _busy),
              const SizedBox(width: AppSpacing.dense),
              _textButton('删除模型', _delete),
            ]),
          ],
        );

      case _Phase.failed:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_detail.isEmpty ? '出错了，但没有原因——这本身是个 bug。' : _detail,
                style: AppText.secondary.copyWith(color: palette.warning)),
            const SizedBox(height: AppSpacing.dense),
            Row(children: [
              _button('重试', _phase == _Phase.downloading ? _download : _start,
                  busy: _busy),
              const SizedBox(width: AppSpacing.dense),
              _textButton('重新检查', _refresh),
            ]),
          ],
        );
    }
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
