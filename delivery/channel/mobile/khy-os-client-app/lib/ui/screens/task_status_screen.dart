// 状态副屏：当前任务的实时视图（直接推流，不落文件轮询）。
//
// 数据源是 TaskStateFeed，注入而非内部构造：测试给 fake，App 里用
// FloatingTaskHub 的 DirectTaskFeed。提交/停止/批准走 FloatingTaskHub 的
// 同一条本地任务管线——与悬浮窗信箱、微信任务共用同一把锁。
//
// spinner 是手搓的（AnimationController + CustomPaint）：一颗 indeterminate
// 圆弧加呼吸脉冲。不引第三方 spinner 包——这个页面只此一处用，为此进
// pubspec 是净负债。

import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../core/floating/floating_status_controller.dart';
import '../../core/floating/floating_task_hub.dart';
import '../../core/floating/task_state.dart';

/// phase 的中文标签。thinking 特意写成「在想下一步」——这是需求原话，
/// 也是 spinner 高亮行该说的话。
String taskPhaseLabel(TaskPhase phase) => switch (phase) {
      TaskPhase.idle => '空闲',
      TaskPhase.thinking => '在想下一步',
      TaskPhase.acting => '执行中',
      TaskPhase.reflecting => '核对结果',
      TaskPhase.awaitingApproval => '等你批准',
      TaskPhase.done => '已完成',
      TaskPhase.error => '出错',
    };

class TaskStatusScreen extends StatefulWidget {
  const TaskStatusScreen({
    super.key,
    this.feed,
    this.onSubmit,
    this.onStop,
    this.onApproval,
  });

  /// 注入的数据流；缺省取 FloatingTaskHub 的直推流（未启动时为 null，
  /// 页面摆诚实空态，输入仍可用——submitLocal 会把状态层拉起来）。
  final TaskStateFeed? feed;

  /// 测试注入点：三个动作的默认实现都走 FloatingTaskHub。
  final Future<String> Function(String text)? onSubmit;
  final Future<bool> Function()? onStop;
  final Future<bool> Function(String id, bool allow)? onApproval;

  @override
  State<TaskStatusScreen> createState() => _TaskStatusScreenState();
}

class _TaskStatusScreenState extends State<TaskStatusScreen> {
  StreamSubscription<TaskSnapshot>? _sub;
  TaskSnapshot? _latest;
  bool _busy = false;
  final _input = TextEditingController();
  String? _notice;

  @override
  void initState() {
    super.initState();
    final feed = widget.feed ?? FloatingTaskHub.instance.feed;
    if (widget.feed == null) {
      // 测试注入 feed 时不碰真 hub；App 路径确保状态层活着（开关关也允许
      // 副屏提交任务——开关只管悬浮胶囊画不画）。
      unawaited(FloatingTaskHub.instance.ensureStarted());
    }
    if (feed != null) {
      _sub = feed.stream.listen((s) {
        if (!mounted) return;
        setState(() => _latest = s);
      });
      // 静态入口点开时先拿一份当前快照，不等下一次变化。
      final c = FloatingTaskHub.instance.controller;
      if (c != null && mounted) setState(() => _latest = c.current);
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    _input.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final text = _input.text.trim();
    if (text.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final refusal = await (widget.onSubmit ?? FloatingTaskHub.instance.submitLocal)(text);
      if (!mounted) return;
      setState(() {
        if (refusal.isEmpty) {
          _input.clear();
        } else {
          _notice = refusal;
        }
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _stop() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final stopped =
          await (widget.onStop ?? FloatingTaskHub.instance.stopCurrent)();
      if (!mounted) return;
      setState(() {
        _notice = stopped
            ? '已放弃等待：AgentLoop 不支持中断，后台步骤可能仍在跑'
            : '当前没有正在执行的任务';
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _approve(String id, bool allow) async {
    final ok = await (widget.onApproval ?? FloatingTaskHub.instance.resolveApproval)(
        id, allow);
    if (!mounted) return;
    if (!ok) setState(() => _notice = '这个审批已经不在了（可能刚超时自动拒绝）');
  }

  @override
  Widget build(BuildContext context) {
    final s = _latest;
    final running = s != null && !s.isIdle;
    return Scaffold(
      appBar: AppBar(title: const Text('任务副屏')),
      body: Column(
        children: [
          Expanded(
            child: s == null
                ? const _EmptyView()
                : ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      _HeaderCard(snapshot: s),
                      if (running) ...[
                        const SizedBox(height: 12),
                        _RunningCard(snapshot: s),
                        if (s.lastScreenshotPath.isNotEmpty) ...[
                          const SizedBox(height: 12),
                          _ScreenshotCard(path: s.lastScreenshotPath),
                        ],
                      ],
                      if (s.pendingApproval != null) ...[
                        const SizedBox(height: 12),
                        _ApprovalCard(
                          approval: s.pendingApproval!,
                          onDecision: _approve,
                        ),
                      ],
                      if (s.steps.isNotEmpty) ...[
                        const SizedBox(height: 12),
                        _StepsCard(snapshot: s),
                      ],
                      if (s.lastResultExcerpt.isNotEmpty ||
                          s.errorMessage.isNotEmpty) ...[
                        const SizedBox(height: 12),
                        _ResultCard(snapshot: s),
                      ],
                      if (_notice != null) ...[
                        const SizedBox(height: 12),
                        Text(_notice!,
                            style: TextStyle(
                                color: Theme.of(context).colorScheme.error)),
                      ],
                    ],
                  ),
          ),
          SafeArea(
            top: false,
            child: _Composer(
              controller: _input,
              busy: _busy,
              running: running,
              onSubmit: _submit,
              onStop: _stop,
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyView extends StatelessWidget {
  const _EmptyView();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          '还没有任务数据。\n在下方输入框提交一条指令，或先在设置里打开任务悬浮胶囊。',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      ),
    );
  }
}

/// 标题卡：任务摘要 + 来源 chip + phase 徽标。
class _HeaderCard extends StatelessWidget {
  const _HeaderCard({required this.snapshot});

  final TaskSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final s = snapshot;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    s.summary.isEmpty ? '（还没有动作）' : s.summary,
                    style: Theme.of(context)
                        .textTheme
                        .titleSmall
                        ?.copyWith(fontWeight: FontWeight.bold),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                Chip(
                  label: Text('来源：${s.source.label}'),
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  labelStyle: Theme.of(context).textTheme.labelSmall,
                ),
                Chip(
                  label: Text(taskPhaseLabel(s.phase)),
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  backgroundColor: s.phase == TaskPhase.error
                      ? cs.errorContainer
                      : s.isIdle
                          ? null
                          : cs.primaryContainer,
                  labelStyle: Theme.of(context).textTheme.labelSmall,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 运行态卡：手搓 spinner + 第 n/N 步 + 在想什么。
class _RunningCard extends StatelessWidget {
  const _RunningCard({required this.snapshot});

  final TaskSnapshot snapshot;

  bool get _spinning => snapshot.phase == TaskPhase.thinking ||
      snapshot.phase == TaskPhase.acting ||
      snapshot.phase == TaskPhase.reflecting ||
      snapshot.phase == TaskPhase.awaitingApproval;

  @override
  Widget build(BuildContext context) {
    final s = snapshot;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            if (_spinning) ...[
              const _HandmadeSpinner(size: 56),
              const SizedBox(width: 16),
            ] else ...[
              Icon(Icons.check_circle_outline,
                  size: 48, color: Theme.of(context).colorScheme.primary),
              const SizedBox(width: 16),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.totalSteps > 0
                        ? '第 ${math.min(s.stepIndex, s.totalSteps)}/'
                            '${s.totalSteps} 步'
                        : '准备中',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (s.thinkingHint.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        '在想：${s.thinkingHint}',
                        style: Theme.of(context).textTheme.bodySmall,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 手搓 indeterminate spinner：两段圆弧反向旋转 + 半径呼吸。
/// AnimationController 驱动 CustomPaint，不引第三方包。
class _HandmadeSpinner extends StatefulWidget {
  const _HandmadeSpinner({this.size = 56});

  final double size;

  @override
  State<_HandmadeSpinner> createState() => _HandmadeSpinnerState();
}

class _HandmadeSpinnerState extends State<_HandmadeSpinner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) => CustomPaint(
          painter: _SpinnerPainter(progress: _controller.value),
        ),
      ),
    );
  }
}

class _SpinnerPainter extends CustomPainter {
  _SpinnerPainter({required this.progress});

  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    // 呼吸：半径随 sin 收放，转速由 controller 决定。
    final base = size.shortestSide / 2 - 6;
    final radius = base + math.sin(progress * 2 * math.pi) * 2;
    final color = Colors.blueAccent;

    // Gradient.sweep 的参数是位置式的（center, colors, stops, tileMode,
    // startAngle, endAngle）：渐变随弧一起转，尾部淡出。ui 版才有这个
    // 构造——painting 的 Gradient 是另一棵继承树。
    final sweep = ui.Gradient.sweep(
      center,
      <Color>[color.withValues(alpha: 0.0), color],
      <double>[0.0, 1.0],
      TileMode.clamp,
      progress * 2 * math.pi,
      progress * 2 * math.pi + math.pi * 1.5,
    );

    final arcPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4
      ..strokeCap = StrokeCap.round
      ..shader = sweep;
    canvas.drawArc(Rect.fromCircle(center: center, radius: radius),
        progress * 2 * math.pi, math.pi * 1.5, false, arcPaint);

    // 内圈脉冲点：另一层「在动」的证词，弧之外的第二只眼。
    final dotPaint = Paint()..color = color.withValues(alpha: 0.5);
    final dotAngle = -progress * 2 * math.pi * 1.6;
    canvas.drawCircle(
      Offset(
        center.dx + math.cos(dotAngle) * radius * 0.55,
        center.dy + math.sin(dotAngle) * radius * 0.55,
      ),
      3,
      dotPaint,
    );
  }

  @override
  bool shouldRepaint(_SpinnerPainter oldDelegate) =>
      oldDelegate.progress != progress;
}

/// 最新截图缩略卡（agent 此刻正看着的画面）。文件被 5 张清理删掉时摆占位
/// 不崩——先 existsSync 再挂 Image.file：errorBuilder 要等真实读取失败才
/// 触发，那条路在系统盘被杀进程等场景下没有通知，占位是唯一诚实的兜底。
class _ScreenshotCard extends StatelessWidget {
  const _ScreenshotCard({required this.path});

  final String path;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('当前画面',
                style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: SizedBox(
                height: 160,
                width: double.infinity,
                child: File(path).existsSync()
                    ? Image.file(
                        File(path),
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => Center(
                          child: Text('截图还在路上（或已被清出保留窗口）',
                              style: Theme.of(context).textTheme.bodySmall),
                        ),
                      )
                    : Center(
                        child: Text('截图还在路上（或已被清出保留窗口）',
                            style: Theme.of(context).textTheme.bodySmall),
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 待批卡：批准的是哪个工具、对什么目标，按钮文案里说全。
class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({required this.approval, required this.onDecision});

  final PendingApprovalInfo approval;
  final Future<void> Function(String id, bool allow) onDecision;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      color: cs.secondaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '等你批准：${approval.tool}'
              '${approval.target.isEmpty ? '' : '（目标：${approval.target}）'}',
              style: Theme.of(context)
                  .textTheme
                  .titleSmall
                  ?.copyWith(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text('120 秒不答复会自动拒绝。',
                style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            Row(
              children: [
                FilledButton.icon(
                  key: const Key('approval-allow'),
                  onPressed: () => onDecision(approval.id, true),
                  icon: const Icon(Icons.check),
                  label: const Text('批准'),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  key: const Key('approval-deny'),
                  onPressed: () => onDecision(approval.id, false),
                  icon: const Icon(Icons.close),
                  label: const Text('拒绝'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 最近步骤（新在前，来自快照的 8 条摘要）。悬浮快照是独立模型，不搬
/// ExecutionLog.toText——那是整份参数与输出的导出形态，屏上放不下也不该放。
class _StepsCard extends StatelessWidget {
  const _StepsCard({required this.snapshot});

  final TaskSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final steps = snapshot.steps;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('最近步骤（新在前，最多 ${FloatingStatusController.maxSteps} 条）',
                style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            for (var i = 0; i < steps.length; i++)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      i == 0 ? '▶' : '·',
                      style: TextStyle(
                        color: i == 0
                            ? Theme.of(context).colorScheme.primary
                            : Theme.of(context).colorScheme.outline,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        steps[i].text,
                        style: i == 0
                            ? Theme.of(context)
                                .textTheme
                                .bodyMedium
                                ?.copyWith(fontWeight: FontWeight.bold)
                            : Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.snapshot});

  final TaskSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final failed = snapshot.errorMessage.isNotEmpty;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(failed ? '失败原因' : '结果',
                style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 4),
            Text(
              failed ? snapshot.errorMessage : snapshot.lastResultExcerpt,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}

/// 底部输入条。停止按钮的文案不撒谎：AgentLoop 没有中断通道，
/// 停止 = 放弃等待，后台步骤可能仍在跑。
class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.busy,
    required this.running,
    required this.onSubmit,
    required this.onStop,
  });

  final TextEditingController controller;
  final bool busy;
  final bool running;
  final Future<void> Function() onSubmit;
  final Future<void> Function() onStop;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  key: const Key('task-input'),
                  controller: controller,
                  enabled: !busy,
                  decoration: const InputDecoration(
                    hintText: '补充或修改要求…',
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                  minLines: 1,
                  maxLines: 3,
                  onSubmitted: (_) => onSubmit(),
                ),
              ),
              IconButton(
                key: const Key('task-submit'),
                onPressed: busy ? null : onSubmit,
                icon: const Icon(Icons.send),
              ),
            ],
          ),
          Row(
            children: [
              TextButton.icon(
                key: const Key('task-stop'),
                onPressed: running && !busy ? onStop : null,
                icon: const Icon(Icons.stop_circle_outlined),
                label: const Text('停止（放弃等待，AgentLoop 不支持中断）'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
