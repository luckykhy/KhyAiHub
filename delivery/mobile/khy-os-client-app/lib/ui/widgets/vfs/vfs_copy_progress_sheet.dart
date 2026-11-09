// 复制进度面板。
//
// 大目录复制是分钟级操作，用户必须能看见「到哪了」并且能停。
// 面板只做展示与取消——复制本身在原生侧的线程池里跑，Dart 这边只是听进度。

import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/vfs/vfs_copy_task.dart';
import '../../theme/design_tokens.dart';

/// 复制进度面板。
class VfsCopyProgressSheet extends StatefulWidget {
  final String taskId;

  /// 复制完成后回调（成功/取消都会调）。
  final ValueChanged<CopyProgress> onFinished;

  const VfsCopyProgressSheet({
    super.key,
    required this.taskId,
    required this.onFinished,
  });

  /// 弹出进度面板。
  static Future<void> show(
    BuildContext context, {
    required String taskId,
    required ValueChanged<CopyProgress> onFinished,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      isDismissible: false,
      enableDrag: false,
      builder: (BuildContext sheetContext) => VfsCopyProgressSheet(
        taskId: taskId,
        onFinished: onFinished,
      ),
    );
  }

  @override
  State<VfsCopyProgressSheet> createState() => _VfsCopyProgressSheetState();
}

class _VfsCopyProgressSheetState extends State<VfsCopyProgressSheet> {
  StreamSubscription<CopyProgress>? _subscription;
  CopyProgress _progress = const CopyProgress(taskId: '', phase: 'copying');
  bool _cancelling = false;

  @override
  void initState() {
    super.initState();
    VfsCopyTasks.instance.install();
    _subscription = VfsCopyTasks.instance.progress.listen((CopyProgress p) {
      if (!mounted) return;
      if (p.taskId.isNotEmpty && p.taskId != widget.taskId) return;
      setState(() => _progress = p);
      if (p.finished) {
        widget.onFinished(p);
        Navigator.of(context).maybePop();
      }
    });
    // 补一次状态查询：面板可能开在进度事件之前（任务已经跑了一会儿）。
    _poll();
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  Future<void> _poll() async {
    final status = await VfsCopyTasks.instance.status(widget.taskId);
    if (!mounted || status == null) return;
    setState(() => _progress = status);
    if (status.finished) {
      widget.onFinished(status);
      Navigator.of(context).maybePop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final progress = _progress;

    return Padding(
      padding: const EdgeInsets.all(AppSpacing.page),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.copy_all_outlined, size: 18, color: palette.primary),
              const SizedBox(width: AppSpacing.inner),
              Expanded(
                child: Text(
                  '正在复制',
                  style: AppText.title.copyWith(color: palette.textPrimary),
                ),
              ),
              if (progress.finished)
                IconButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                  icon: const Icon(Icons.close, size: 18),
                  color: palette.textSecondary,
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.cardGap),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: progress.ratio,
              minHeight: 6,
              backgroundColor: palette.surfaceHigh,
              valueColor: AlwaysStoppedAnimation<Color>(palette.primary),
            ),
          ),
          const SizedBox(height: AppSpacing.dense),
          Text(
            '${progress.readableDone}'
            '${progress.total > 0 ? ' / ${CopyProgress.readableBytes(progress.total)}' : ''}'
            ' · ${progress.files} 个文件',
            style: AppText.secondary.copyWith(color: palette.textSecondary),
          ),
          if (progress.current.isNotEmpty) ...<Widget>[
            const SizedBox(height: 4),
            Text(
              progress.current,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppText.micro.copyWith(color: palette.textFaint),
            ),
          ],
          const SizedBox(height: AppSpacing.cardGap),
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  '中断后可以继续：已复制的部分会保留，下次自动接着传。',
                  style: AppText.micro.copyWith(color: palette.textFaint),
                ),
              ),
              const SizedBox(width: AppSpacing.cardGap),
              OutlinedButton(
                onPressed: _cancelling
                    ? null
                    : () async {
                        setState(() => _cancelling = true);
                        await VfsCopyTasks.instance.cancel(widget.taskId);
                      },
                child: Text(_cancelling ? '正在停止' : '取消'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
