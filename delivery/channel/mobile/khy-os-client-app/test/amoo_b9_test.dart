import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/amoo_keepalive.dart';

/// B9 保活的单元级完成判定（测试先行，TASK.md §B.0.1「没有判定不开工」）。
///
/// 判据真源：TASK.md §4 B9「阈值按 Doze 实测重定，FGS 常驻，回收后拉起续接」；
/// contract.md K-32（heartbeat_seq / heartbeat_age_ms / heartbeat_stale，阈值 180s）
/// 与 §10 V1/V3/V6（FGS dataSync、START_STICKY、force-idle 后仍要存活）。
/// 设备侧三条（force-idle+锁屏 30 分钟 heartbeat_seq 增长、强杀 60s 内重连续接、
/// 重连次数与耗时逐次记录）在 device/B9.md；本文件守那三条之前必须先绿的一半——
/// 陈旧阈值怎么重定、心跳怎么判陈旧、重连计划为什么不超 60s、重连怎么记账。
///
/// API 形状即契约形状：要改先改本文件与 device/B9.md §1.2，不许删断言绕过。
/// 仓库里现在没有 lib/core/gateway/amoo_keepalive.dart（实读 2026-11-12 与
/// 2026-11-13 两次，lib/core/gateway/ 下只有 ai_gateway / key_health / key_pool /
/// khyos_api / market_catalog / pairing / provider_adapter / zen_errors /
/// zen_gate / zen_models，清单不变）——本文件编译失败就是预期的首败。
///
/// 2026-11-13 回炉复核（判定回炉·B9）：调度称「判定对当前代码不是红的」，
/// 用调度方同一条命令实测，本文件 flutter test exit=1、
/// B9_keepalive_mirror.cmd exit=1（7 passed / 7 failed）——两门都是红的，
/// 红相即「缺模块」，不是空转，故判据一条没动（改成退出 0 只会得到恒真判定）。
/// 本文件自身没有 B8 那种 library; 错位伤：首条错误就是缺模块的 import（:2:8），
/// 35 条连锁全是该模块符号，模块落地后整片消失。证据见 device/B9.md §1.1。
///
/// 数值分两处把门，别合并：本文件钉 Dart 侧策略数值；Java 侧
/// HEARTBEAT_STALE_MS（bridge/BridgeService.java:49）必须等于重定后的同一个
/// 数——设备判定量的是桥，两边不同数就是在量一个没被钉住的东西。那个相等性
/// 由 checks/B9_keepalive_mirror.cmd 把着，不在本文件重复。
void main() {
  group('B9 陈旧阈值按 Doze 实测重定（TASK 4-B9 + K-32）', () {
    test('地板值就是契约 K-32 钉的 180s，重定只许上调', () {
      expect(kHeartbeatStaleFloorMs, 180000);
    });

    test('地板必须高过 exec 的 120s 自封顶（BridgeService.java:46-48 原注）', () {
      expect(kExecCapMs, 120000);
      expect(kHeartbeatStaleFloorMs, greaterThan(kExecCapMs));
    });

    test('重定余量 60s：贴着观测值定阈值，下一次冻结就误判', () {
      expect(kStaleMarginMs, 60000);
    });

    test('staleThresholdMs = max(地板, 实测冻结 + 余量)', () {
      expect(staleThresholdMs(0), 180000);
      expect(staleThresholdMs(59999), 180000);
      expect(staleThresholdMs(120000), 180000); // 冻结+余量恰在地板上
      expect(staleThresholdMs(120001), 180001); // 越过地板上沿，接管
      expect(staleThresholdMs(300000), 360000);
    });

    test('垃圾输入不许把阈值压到地板之下', () {
      expect(staleThresholdMs(-1), 180000);
    });

    test('阈值随实测单调不减：观测越坏，bar 只升不降', () {
      var last = -1;
      for (final freeze in <int>[-1, 0, 59999, 120000, 120001, 300000, 7200000]) {
        final bar = staleThresholdMs(freeze);
        expect(bar, greaterThanOrEqualTo(last), reason: 'freeze=$freeze');
        last = bar;
      }
    });

    test('生效阈值由实测值推导，不是另写一个独立字面量', () {
      expect(kDozeFreezeObservedMs, greaterThanOrEqualTo(0));
      expect(kHeartbeatStaleMs, staleThresholdMs(kDozeFreezeObservedMs));
    });
  });

  group('B9 心跳陈旧判定与桥侧同构（K-32）', () {
    test('首刻之前 age=-1 且判陈旧（桥侧 age<0 即 stale）', () {
      final hb = AmooHeartbeat();
      expect(hb.seq, 0);
      expect(hb.ageMs(1000), -1);
      expect(hb.stale(1000), isTrue);
    });

    test('tick 之后 seq 单调增、age 从 0 起算', () {
      final hb = AmooHeartbeat();
      hb.tick(1000);
      expect(hb.seq, 1);
      expect(hb.ageMs(1000), 0);
      expect(hb.stale(1000), isFalse);
      hb.tick(1120);
      expect(hb.seq, 2);
      expect(hb.ageMs(1120), 0);
      expect(hb.ageMs(1220), 100);
    });

    test('陈旧边界是严格大于阈值，与桥侧 age > HEARTBEAT_STALE_MS 一致', () {
      final hb = AmooHeartbeat();
      hb.tick(0);
      expect(hb.stale(kHeartbeatStaleFloorMs, thresholdMs: kHeartbeatStaleFloorMs),
          isFalse);
      expect(hb.stale(kHeartbeatStaleFloorMs + 1, thresholdMs: kHeartbeatStaleFloorMs),
          isTrue);
    });

    test('阈值可传入：Doze 重定后的值直接改变陈旧判定', () {
      final hb = AmooHeartbeat();
      hb.tick(0);
      final recalibrated = staleThresholdMs(300000);
      expect(hb.stale(recalibrated, thresholdMs: recalibrated), isFalse);
      expect(hb.stale(recalibrated + 1, thresholdMs: recalibrated), isTrue);
    });
  });

  group('B9 重连计划 60s 内（TASK 4-B9「强杀 60s 内重连续接」）', () {
    test('续接死线就是任务书那个 60s', () {
      expect(kReviveDeadlineMs, 60000);
    });

    test('每次尝试都排在死线内，且不少于 3 次', () {
      final times = AmooRevivePlan().attemptTimesMs();
      expect(times.length, greaterThanOrEqualTo(3));
      for (final t in times) {
        expect(t, greaterThanOrEqualTo(0));
        expect(t, lessThanOrEqualTo(kReviveDeadlineMs));
      }
    });

    test('首次不磨叽：5s 内就拉第一次', () {
      expect(AmooRevivePlan().attemptTimesMs().first, lessThanOrEqualTo(5000));
    });

    test('退避间隔只增不减，不退化成热循环（仓库规则 3）', () {
      final times = AmooRevivePlan().attemptTimesMs();
      final gaps = <int>[];
      for (var i = 1; i < times.length; i++) {
        gaps.add(times[i] - times[i - 1]);
      }
      for (var i = 1; i < gaps.length; i++) {
        expect(gaps[i], greaterThanOrEqualTo(gaps[i - 1]));
      }
    });

    test('跑完计划仍没续上 = 明确放弃，不无限重试', () {
      final plan = AmooRevivePlan();
      final n = plan.attemptTimesMs().length;
      for (var i = 0; i < n; i++) {
        plan.recordAttempt(ok: false);
      }
      expect(plan.attempts, n);
      expect(plan.exhausted, isTrue);
      expect(plan.reconnected, isFalse);
    });

    test('中途续上就不再排后面的尝试', () {
      final plan = AmooRevivePlan();
      plan.recordAttempt(ok: false);
      plan.recordAttempt(ok: true);
      expect(plan.reconnected, isTrue);
      expect(plan.exhausted, isFalse);
      expect(plan.attempts, 2);
    });
  });

  group('B9 重连记账（「记录重连次数与耗时」）', () {
    test('每次重连都记下耗时与成败，分开数', () {
      final log = AmooReconnectLog();
      log.record(atMs: 1000, durationMs: 4200, ok: true);
      log.record(atMs: 9000, durationMs: 5100, ok: false);
      log.record(atMs: 20000, durationMs: 3000, ok: true);
      expect(log.count, 3);
      expect(log.okCount, 2);
      expect(log.durations, <int>[4200, 5100, 3000]);
      expect(log.lastDurationMs, 3000);
    });

    test('没续上的那次也记账，但不混进成功数（K-00c：不把未确认说成已执行）', () {
      final log = AmooReconnectLog();
      log.record(atMs: 0, durationMs: 59000, ok: false);
      expect(log.count, 1);
      expect(log.okCount, 0);
      expect(log.lastDurationMs, 59000);
    });
  });
}
