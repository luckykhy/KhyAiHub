// 自动化脚本的定时执行与逐步执行。
//
// **定时执行**只在 App 进程活着时有效——这是 Android 的现实：没有前台服务，
// 进程被杀就没了。所以界面上要写明「App 运行期间有效」，不假装是后台常驻。
//
// 调度口径：一个 60 秒的心跳，检查每个启用且带 schedule 的脚本是否到点。
// 不用精确闹钟（AlarmManager 需要额外权限且对文件操作这种分钟级任务过重）。
//
// **逐步执行**是把脚本拆成一步一步让人点：脚本是「一串不可逆的操作」，
// 一次全跑出了问题没法停在中间；能单步跑，就能看清哪一步出的问题。

import 'dart:async';

import 'automation_runner.dart';
import 'automation_script.dart';
import 'vfs_audit.dart';

/// 定时规格。
///
/// 支持两种写法：`every 15m`（每隔多久）与 `daily 08:00`（每天几点）。
/// 认不出来就是认不出来——不猜一个默认间隔，那会让脚本在用户不知道的时候跑。
class ScheduleSpec {
  /// 间隔（every 形式）。
  final Duration? interval;

  /// 每天几点（daily 形式）。
  final int? hour;
  final int? minute;

  const ScheduleSpec._({this.interval, this.hour, this.minute});

  /// 解析。
  static ScheduleSpec? parse(String raw) {
    final text = raw.trim().toLowerCase();
    if (text.isEmpty) return null;

    if (text.startsWith('every ')) {
      final body = text.substring(6).trim();
      final match = RegExp(r'^(\d+)\s*([smhd])$').firstMatch(body);
      if (match == null) return null;
      final amount = int.tryParse(match.group(1) ?? '') ?? 0;
      if (amount <= 0) return null;
      final unit = match.group(2);
      final seconds = switch (unit) {
        's' => amount,
        'm' => amount * 60,
        'h' => amount * 3600,
        'd' => amount * 86400,
        _ => 0,
      };
      if (seconds <= 0) return null;
      return ScheduleSpec._(interval: Duration(seconds: seconds));
    }

    if (text.startsWith('daily ')) {
      final body = text.substring(6).trim();
      final match = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(body);
      if (match == null) return null;
      final h = int.tryParse(match.group(1) ?? '');
      final m = int.tryParse(match.group(2) ?? '');
      if (h == null || m == null || h > 23 || m > 59) return null;
      return ScheduleSpec._(hour: h, minute: m);
    }

    return null;
  }

  /// 人类可读描述。
  String get label {
    final interval = this.interval;
    if (interval != null) {
      final totalMinutes = interval.inSeconds ~/ 60;
      if (totalMinutes >= 60 && totalMinutes % 60 == 0) {
        return '每 ${totalMinutes ~/ 60} 小时';
      }
      if (totalMinutes >= 1 && interval.inSeconds % 60 == 0) {
        return '每 $totalMinutes 分钟';
      }
      return '每 ${interval.inSeconds} 秒';
    }
    if (hour != null && minute != null) {
      return '每天 ${hour.toString().padLeft(2, '0')}:'
          '${minute.toString().padLeft(2, '0')}';
    }
    return '未设置';
  }

  /// 距离下一次执行还有多久。到点了就返回 null（表示「现在就该跑」）。
  Duration? nextDelay(DateTime now) {
    if (interval != null) return interval!;
    if (hour == null || minute == null) return null;
    final today = DateTime(now.year, now.month, now.day, hour!, minute!);
    var next = today;
    if (!next.isAfter(now)) {
      next = today.add(const Duration(days: 1));
    }
    return next.difference(now);
  }
}

/// 脚本调度器。
class AutomationScheduler {
  AutomationScheduler._();

  static final AutomationScheduler instance = AutomationScheduler._();

  Timer? _ticker;
  final Map<String, DateTime> _lastRun = <String, DateTime>{};
  bool _started = false;

  /// 执行回调（每次定时执行后通知界面）。
  void Function(AutomationScript script, AutomationRunResult result)? onRun;

  /// 启动调度。
  void start() {
    if (_started) return;
    _started = true;
    // 心跳 60 秒：分钟级的脚本用不着更细的粒度。
    _ticker = Timer.periodic(const Duration(seconds: 60), (_) => _tick());
  }

  /// 停止调度。
  void stop() {
    _ticker?.cancel();
    _ticker = null;
    _started = false;
  }

  /// 立刻检查一次（脚本刚被保存/启用时调用）。
  Future<void> tickNow() => _tick();

  Future<void> _tick() async {
    List<AutomationScript> scripts;
    try {
      scripts = await AutomationScriptStore.load();
    } catch (_) {
      return;
    }
    final now = DateTime.now();
    for (final script in scripts) {
      if (!script.enabled) continue;
      if (script.trigger != AutomationTrigger.schedule) continue;
      final spec = ScheduleSpec.parse(script.schedule);
      if (spec == null) continue;

      final last = _lastRun[script.id];
      if (last != null && now.difference(last) < const Duration(minutes: 1)) {
        continue;
      }
      // 到点判定：间隔型看「距上次是否已过间隔」，每日型看「今天这个点是否已过且今天还没跑过」。
      final due = spec.interval != null
          ? (last == null || now.difference(last) >= spec.interval!)
          : _dailyDue(spec, now, last);
      if (!due) continue;

      _lastRun[script.id] = now;
      final result = await AutomationRunner.run(script);
      await VfsAuditLog.instance.record(
        VfsSource.script,
        'schedule:${script.name}',
        script.watchDir,
        detail: result.allOk ? '定时执行完成' : '${result.failedCount} 步失败',
      );
      onRun?.call(script, result);
    }
  }

  bool _dailyDue(ScheduleSpec spec, DateTime now, DateTime? last) {
    final today = DateTime(now.year, now.month, now.day, spec.hour!, spec.minute!);
    if (now.isBefore(today)) return false;
    if (last == null) return true;
    // 今天这个点之后已经跑过就不重复。
    return last.isBefore(today);
  }
}

/// 逐步执行器：把脚本拆成单步，让人一步步点。
class AutomationStepRunner {
  AutomationStepRunner(this.script);

  final AutomationScript script;

  int _cursor = 0;
  final List<AutomationRunResult> _history = <AutomationRunResult>[];

  /// 当前待执行的步骤（null 表示已全部执行完）。
  AutomationStep? get current {
    if (_cursor >= script.steps.length) return null;
    return script.steps[_cursor];
  }

  /// 已执行的步数。
  int get doneCount => _cursor;

  /// 总步数。
  int get totalCount => script.steps.length;

  /// 是否已跑完。
  bool get finished => _cursor >= script.steps.length;

  /// 执行当前这一步并前进。
  Future<AutomationRunResult> step() async {
    final step = current;
    if (step == null) {
      return const AutomationRunResult(<AutomationRunStep>[]);
    }
    final single = AutomationScript(
      id: script.id,
      name: script.name,
      steps: <AutomationStep>[step],
    );
    final result = await AutomationRunner.run(single);
    _history.add(result);
    _cursor++;
    return result;
  }
}
