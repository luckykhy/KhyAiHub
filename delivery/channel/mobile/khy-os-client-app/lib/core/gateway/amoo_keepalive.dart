/// B9 保活策略——心跳陈旧阈值按 Doze 实测重定、强杀后的重连计划、重连记账。
///
/// 为什么单独一个模块：设备判定（device/B9.md）量的是**桥**（BridgeService 的
/// worker 循环），而阈值怎么定、多久算陈旧、续接为什么不超 60s 这些规则必须有一个
/// Dart 侧的真源，桥侧的 HEARTBEAT_STALE_MS 与它逐位相等才说得上「两边钉的是同一个
/// 数」——这个相等性由 checks/B9_keepalive_mirror.cmd 把着，不在调用点重复。
/// 数值与桥侧常量一一对应，注释里给出 BridgeService.java 的行号出处。

import 'dart:math' as math;

/// 桥 worker 单命令阻塞上限（BridgeService.java:45-48 原注：exec 自身封顶约
/// 120s）。陈旧阈值必须高过它，否则每次长 exec 都误判陈旧。
const int kExecCapMs = 120000;

/// 契约 K-32 钉的陈旧地板。「重定」只许上调：观测更坏时抬 bar，不许悄悄下调。
const int kHeartbeatStaleFloorMs = 180000;

/// 重定余量。贴着观测值定阈值，下一次冻结就误判——这是本判定引入的规则参数
/// （任务书未给数值），改它必须同步改 amoo_b9_test.dart 与 device/B9.md §1.2。
const int kStaleMarginMs = 60000;

/// 强杀后的续接死线（TASK §4 B9 原文「60s 内」）。
const int kReviveDeadlineMs = 60000;

/// Doze 窗口实测最长冻结毫秒数，由 device/B9.md B9-1 采样得出后据实填。
/// 未测期间为 0，生效阈值退到地板——不许为了让数字好看先填一个估值。
const int kDozeFreezeObservedMs = 0;

/// 生效阈值。Java 侧 HEARTBEAT_STALE_MS 必须等于它（镜像门判据）。
final int kHeartbeatStaleMs = staleThresholdMs(kDozeFreezeObservedMs);

/// 重定规则：max(地板, 实测冻结 + 余量)。观测越坏 bar 只升不降；负的观测值
/// 只会把和压低，地板天然兜住，不需要额外 clamp。
int staleThresholdMs(int dozeFreezeMs) {
  return math.max(kHeartbeatStaleFloorMs, dozeFreezeMs + kStaleMarginMs);
}

/// 心跳陈旧判定，与桥侧 heartbeatSeq / heartbeatAgeMs / heartbeatStale 同构
/// （BridgeService.java:66-92）：首刻之前 age 为 -1 即判陈旧；陈旧是 age 严格
/// 大于阈值——age 恰等于阈值的那一跳不算陈旧，和桥侧逐字一致。
class AmooHeartbeat {
  int _seq = 0;

  /// null = 从未跳过（桥侧拿 hbTickMs 为 0 当这个哨兵，可那边的时间戳取自
  /// System.currentTimeMillis，永远不为 0；Dart 侧判定要用 0 起算的假时钟，
  /// 只能另立哨兵，否则 tick(0) 会被误判成「首刻之前」）。
  int? _tickMs;

  int get seq => _seq;

  /// 距上一跳的毫秒数；从未跳过返回 -1（桥侧 hbTickMs 为 0 的分支）。
  int ageMs(int nowMs) {
    final int? tickMs = _tickMs;
    return tickMs == null ? -1 : nowMs - tickMs;
  }

  bool stale(int nowMs, {int? thresholdMs}) {
    final int age = ageMs(nowMs);
    return age < 0 || age > (thresholdMs ?? kHeartbeatStaleMs);
  }

  void tick(int nowMs) {
    _seq += 1;
    _tickMs = nowMs;
  }
}

/// 从被杀死时刻起算的重连计划。间隔只增不减（仓库规则 3：不退化成热循环），
/// 跑完仍未续上就是 exhausted——明确放弃，不无限重试。
class AmooRevivePlan {
  static const List<int> _scheduleMs = <int>[1000, 5000, 15000, 30000, 60000];

  int _attempts = 0;
  bool _reconnected = false;

  List<int> attemptTimesMs() => List<int>.unmodifiable(_scheduleMs);

  int get attempts => _attempts;

  bool get reconnected => _reconnected;

  bool get exhausted => !_reconnected && _attempts >= _scheduleMs.length;

  void recordAttempt({required bool ok}) {
    _attempts += 1;
    if (ok) _reconnected = true;
  }
}

/// 「记录重连次数与耗时」的账本：每次重连一条，没续上的那次也记，但不混进
/// okCount（K-00c：不把未确认说成已执行）。
class AmooReconnectLog {
  final List<int> _atMs = <int>[];
  final List<int> _durations = <int>[];
  final List<bool> _ok = <bool>[];

  int get count => _durations.length;

  int get okCount => _ok.where((bool ok) => ok).length;

  List<int> get durations => List<int>.unmodifiable(_durations);

  int get lastDurationMs => _durations.isEmpty ? -1 : _durations.last;

  void record({required int atMs, required int durationMs, required bool ok}) {
    _atMs.add(atMs);
    _durations.add(durationMs);
    _ok.add(ok);
  }
}
