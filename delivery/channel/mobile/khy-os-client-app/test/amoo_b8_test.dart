/// B8 租约与长任务的单元级判定（TASK.md §4 B8；contract K-33/K-52/K-53/K-60；
/// decisions Q9 长任务默认值）。
///
/// 为什么判据钉在 Dart 侧而不是只在设备上：分片长度、租约时长、预算上限、续跑幂等
/// 全是数值与状态机契约。设备上验一次要真跑几分钟再 force-stop；改一个数字就要整条
/// 重来。Dart 侧同一组数值跑一次就够，设备侧只负责证明「App 真的按这组数值办事」
/// （device/B8.md）。
///
/// 判据（TASK.md §4 B8 三条，缺一即红）：
///   1. 300s 任务分片可见——分片表落盘后仍可读，不是一坨不透明的总时长；
///   2. am force-stop 后重启续跑，产物条数与哈希同一次跑完一致——已完工的分片不重跑，
///      死在中间的分片不自动重放（contract K-61「已下发未确认」只报不重放）；
///   3. 超限明确拒绝并报已用量——拒绝发生在执行之前，回执带 used 与 limit。
///
/// 本文件对当前代码是红的：`lib/core/services/amoo_lease.dart` 尚不存在（2026-11-12
/// 实读 `lib/core/services/` 无该文件），import 即编译失败。首败原始输出按 EVID 约定
/// 落 `checks/B8_red.txt`。
///
/// 一处要补契约的地方（如实标注，不装作已在表内）：租约过期的拒绝码 `lease_expired`
/// 不在 contract K-23 错误码表里。本判定按 B8 需要新增它，并要求在 contract.md §3.2
/// 补一行、锚点【B8】。另外三个码（session_budget_exceeded / duplicate_id /
/// single_flight）逐字取表内既有值。
///
/// 2026-11-13 回炉复核（判定回炉·B8）：两门对当前代码仍为红——本文件
/// `flutter test --reporter compact` exit=1、`B8_lease_budget_mirror.cmd` exit=1
/// （13 passed / 1 failed / 2 skipped），红相即「缺模块」，不是空转，故不改写；
/// 把它改成退出 0 只会得到恒真判定。本次只修掉本文件自己的一处编译错误：
/// `library;` 原先挂在 import 之后（:28），Dart 要求 library 指令先于一切其它指令，
/// 模块落地后它照样会让本文件编译失败——按编译器提示上移到文件首部，红相因此
/// 只剩「缺模块」一种。证据见 device/B8.md §1.1。
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/amoo_lease.dart';

/// 把状态当真过一遍磁盘：JSON 字符串往返。
///
/// 只做 toJson/fromJson 自证会漏掉一类错——Map 里塞了不可编码对象。真编码一次才暴露，
/// 而设备上的落盘一定是这条路径。
Map<String, dynamic> throughDisk(Map<String, dynamic> state) {
  final wire = jsonEncode(state);
  return Map<String, dynamic>.from(jsonDecode(wire) as Map<String, dynamic>);
}

/// 每个分片的预估需求（上界）。Tools.java:1535-1540 的 preflightBytes 契约原文：
/// 「必须是上界……低估的代价是预算被绕开」。
const ShardDemand kDemand = ShardDemand(bytes: 1024, entries: 2, files: 1);

/// 假执行体。产物按分片号确定性生成——判据 2 比的是哈希，随机内容会让比对退化
/// 成比运气。
class FakeRunner {
  final List<int> dispatched = <int>[];

  ShardOutcome execute(int index, {ShardDemand? used}) {
    dispatched.add(index);
    return ShardOutcome(
      artifacts: <ShardArtifact>[
        ShardArtifact(shard: index, id: 'b8-$index', digest: 'sha-b8-$index'),
      ],
      used: used ?? kDemand,
    );
  }
}

AmooLease newLease({int totalMs = 900_000, int nowMs = 0}) => AmooLease.start(
      sessionId: 'b8',
      traceId: 'T-b8',
      msgId: 'm-b8-1',
      idempotencyKey: 'k-b8-1',
      totalMs: totalMs,
      nowMs: nowMs,
    );

/// 跑一个分片：准入 → claim → 执行 → commit。
///
/// claim 与 commit 之间就是进程死亡的窗口（桥的同形动作：cmd_ 先改名 processing_
/// 才执行，BridgeService.java:512）。测试里靠在这个窗口上落盘来复现它。
AmooLease runShard(
  AmooLease lease,
  FakeRunner runner,
  int index, {
  int nowMs = 5_000,
}) {
  final refusal = lease.checkAdmit(index: index, demand: kDemand, nowMs: nowMs);
  expect(refusal, isNull, reason: '分片 $index 应被放行，实际被拒：${refusal?.code}');
  final outcome = runner.execute(index);
  return lease.claim(index).commit(index: index, outcome: outcome);
}

void main() {
  group('B8 分片（判据 1：300s 任务分片可见）', () {
    test('分片上限就是 300s，900s 任务正好 3 片', () {
      expect(kShardMs, 300 * 1000);
      expect(planShards(900_000), <int>[300_000, 300_000, 300_000]);
    });

    test('不足一整片不分片，多出 1ms 才切第二片', () {
      expect(planShards(120_000), <int>[120_000]);
      expect(planShards(300_000), <int>[300_000]);
      expect(planShards(300_001), <int>[300_000, 1]);
      // 负数按「没有工作」处理而不是死循环：调用方算错时长时，一个空表比一个
      // 转不停的循环诚实。
      expect(planShards(0), isEmpty);
      expect(planShards(-1), isEmpty);
    });

    test('分片表落盘可见：重启后片数与每片时长不丢', () {
      final lease = newLease();
      expect(lease.shardCount, 3);
      expect(lease.shardPlan, <int>[300_000, 300_000, 300_000]);
      expect(lease.nextShard, 0);

      final back = AmooLease.fromJson(throughDisk(lease.toJson()));
      expect(back.shardCount, 3);
      expect(back.shardPlan, <int>[300_000, 300_000, 300_000]);
      expect(back.nextShard, 0);
    });

    test('分片按序号推进：跳号判 seq_conflict，回退也判 seq_conflict', () {
      var lease = newLease();
      expect(
        lease.checkAdmit(index: 1, demand: kDemand, nowMs: 0)!.code,
        'seq_conflict',
      );
      expect(
        lease.checkAdmit(index: -1, demand: kDemand, nowMs: 0)!.code,
        'invalid_arguments',
      );

      lease = runShard(lease, FakeRunner(), 0, nowMs: 1_000);
      expect(
        lease.checkAdmit(index: 0, demand: kDemand, nowMs: 2_000)!.code,
        'seq_conflict',
      );
      expect(lease.checkAdmit(index: 1, demand: kDemand, nowMs: 2_000), isNull);
    });
  });

  group('B8 续跑幂等（判据 2：force-stop 后重启续跑，产物条数与哈希同一次跑完一致）', () {
    test('一次跑完的基线：3 片 3 条产物一个稳定摘要', () {
      final lease = runAllShards();
      expect(lease.finished, isTrue);
      expect(lease.completedShards, <int>[0, 1, 2]);
      expect(lease.artifactCount, 3);
      expect(lease.artifactsDigest, isNotEmpty);
      // 同序列必得同摘要。
      expect(runAllShards().artifactsDigest, lease.artifactsDigest);
      // 不同序列必得不同摘要——否则哈希比对证明不了任何事。
      final half = FakeRunner();
      final partial = runShard(newLease(), half, 0, nowMs: 1_000);
      expect(partial.artifactsDigest, isNot(lease.artifactsDigest));
    });

    test('全部完成后没有可准入的分片', () {
      final lease = runAllShards();
      expect(lease.nextShard, -1);
      final refusal = lease.checkAdmit(index: 0, demand: kDemand, nowMs: 0);
      expect(refusal!.code, 'invalid_arguments');
      expect(refusal.fix, isNotEmpty);
    });

    test('进程死在分片边界：复活后续跑，产物条数与哈希同一次跑完一致', () {
      final runner = FakeRunner();
      var lease = newLease();
      lease = runShard(lease, runner, 0, nowMs: 1_000);
      lease = runShard(lease, runner, 1, nowMs: 2_000);
      final saved = throughDisk(lease.toJson());

      // 进程死亡：内存里的对象没了，只剩盘上那份。累计用量跟着租约走，
      // 不跟着进程走。
      var revived = AmooLease.fromJson(saved);
      expect(revived.completedShards, <int>[0, 1]);
      expect(revived.nextShard, 2);
      expect(revived.unconfirmedShard, isNull);
      expect(revived.used.bytes, 2 * 1024);

      revived = runShard(revived, runner, 2, nowMs: 3_000);

      // 每片只派发一次：0 和 1 没有重跑，2 没有跳过。
      expect(runner.dispatched, <int>[0, 1, 2]);
      expect(revived.artifactCount, 3);
      expect(revived.artifactsDigest, runAllShards().artifactsDigest);
      expect(revived.finished, isTrue);
    });

    test('进程死在分片中间（已下发未确认）：不自动重放，只报告', () {
      final runner = FakeRunner();
      var lease = newLease();
      lease = runShard(lease, runner, 0, nowMs: 1_000);

      // 第 1 片：先准入并落盘，执行还没回来进程就死了。落盘必须发生在执行
      // 之前，否则盘上看不出「这一片已经下发」。
      expect(lease.checkAdmit(index: 1, demand: kDemand, nowMs: 2_000), isNull);
      lease = lease.claim(1);
      final saved = throughDisk(lease.toJson());

      var revived = AmooLease.fromJson(saved);
      expect(revived.unconfirmedShard, 1);
      // 没有「可安全开跑」的片：一个照着 nextShard 往下跑的循环会被这里挡住，
      // 自动重放因此没有入口。
      expect(revived.nextShard, -1);
      expect(runner.dispatched, <int>[0]);
      // 未确认分片的用量不可知（outcome 没回来），按未收费处理。
      expect(revived.used.bytes, 1024);

      final dup = revived.checkAdmit(index: 1, demand: kDemand, nowMs: 3_000);
      expect(dup, isNotNull);
      expect(dup!.code, 'duplicate_id');
      expect(dup.used, isNull);

      // 调用方核对过副作用后显式确认重放，才允许重新派发（BridgeService.java:499
      // 的同形措辞：先核对，再删遗留文件发新命令）。
      revived = revived.confirmReplay(1);
      expect(revived.nextShard, 1);
      revived = runShard(revived, runner, 1, nowMs: 3_000);
      revived = runShard(revived, runner, 2, nowMs: 4_000);
      expect(revived.artifactsDigest, runAllShards().artifactsDigest);
      expect(revived.finished, isTrue);
    });

    test('commit 与 confirmReplay 只认自己 claim 过的那一片', () {
      final lease = newLease();
      expect(
        () => lease.commit(index: 0, outcome: const ShardOutcome()),
        throwsA(isA<StateError>()),
      );
      expect(() => lease.confirmReplay(0), throwsA(isA<StateError>()));

      final claimed = lease.claim(0);
      expect(
        () => claimed.commit(index: 1, outcome: const ShardOutcome()),
        throwsA(isA<StateError>()),
      );
      expect(() => claimed.confirmReplay(1), throwsA(isA<StateError>()));
    });
  });

  group('B8 累计预算（判据 3：超限明确拒绝并报已用量）', () {
    test('上限数值复用桥侧常量，不新造第二个真源', () {
      expect(kBudgetBytes, 8 * 1024 * 1024);
      expect(kBudgetEntries, 2000);
      expect(kBudgetFiles, 50);
      expect(kMaxRounds, 30);
    });

    test('超限拒绝带已用量与上限，且拒绝发生在执行之前', () {
      final runner = FakeRunner();
      var lease = newLease();
      expect(
        lease.checkAdmit(index: 0, demand: const ShardDemand(files: 49), nowMs: 0),
        isNull,
      );
      lease = lease.claim(0);
      lease = lease.commit(
        index: 0,
        outcome: runner.execute(0, used: const ShardDemand(files: 49)),
      );

      // 49 + 2 > 50：拒。执行体一次都没为第 1 片跑过——拒绝在前，不在事后。
      final refusal = lease.checkAdmit(
        index: 1,
        demand: const ShardDemand(files: 2),
        nowMs: 1_000,
      );
      expect(refusal, isNotNull);
      expect(refusal!.code, 'session_budget_exceeded');
      expect(refusal.used, 49);
      expect(refusal.limit, 50);
      expect(refusal.error, isNotEmpty);
      expect(refusal.fix, isNotEmpty);
      expect(refusal.guideTopic, isNotEmpty);
      expect(runner.dispatched, <int>[0]);
    });

    test('额度用尽后连 1 个都拒；需求为 0 的维度不触发拒绝', () {
      var lease = newLease();
      lease = lease.claim(0);
      lease = lease.commit(
        index: 0,
        outcome: const ShardOutcome(used: ShardDemand(files: 50)),
      );

      final one = lease.checkAdmit(
        index: 1,
        demand: const ShardDemand(files: 1),
        nowMs: 1_000,
      );
      expect(one!.code, 'session_budget_exceeded');
      expect(one.used, 50);
      expect(one.limit, 50);

      // 只读工作不该被导出额度挡死：这一维度没有需求，就没有超限。
      expect(
        lease.checkAdmit(index: 1, demand: const ShardDemand(), nowMs: 1_000),
        isNull,
      );
    });

    test('字节与条目两个维度各自判限，互不串', () {
      var lease = newLease();
      lease = lease.claim(0);
      lease = lease.commit(
        index: 0,
        outcome: const ShardOutcome(used: ShardDemand(bytes: 8 * 1024 * 1024)),
      );
      final bytesRefusal = lease.checkAdmit(
        index: 1,
        demand: const ShardDemand(bytes: 1),
        nowMs: 1_000,
      );
      expect(bytesRefusal!.code, 'session_budget_exceeded');
      expect(bytesRefusal.used, 8 * 1024 * 1024);
      expect(bytesRefusal.limit, 8 * 1024 * 1024);
      // 条目维度还空着。
      expect(
        lease.checkAdmit(index: 1, demand: const ShardDemand(entries: 1), nowMs: 1_000),
        isNull,
      );
    });

    test('累计预算跨重启不归零', () {
      var lease = newLease();
      lease = lease.claim(0);
      lease = lease.commit(
        index: 0,
        outcome: const ShardOutcome(used: ShardDemand(entries: 1_999)),
      );
      final revived = AmooLease.fromJson(throughDisk(lease.toJson()));
      expect(revived.used.entries, 1_999);

      // 重启后第 2 片只要 2 条就超 2000：预算不是每进程一份。
      final refusal = revived.checkAdmit(
        index: 1,
        demand: const ShardDemand(entries: 2),
        nowMs: 1_000,
      );
      expect(refusal!.code, 'session_budget_exceeded');
      expect(refusal.used, 1_999);
      expect(refusal.limit, 2_000);
    });

    test('轮次上限 30：第 31 次派发被拒并报已用量', () {
      var lease = newLease(totalMs: 31 * 300_000);
      expect(lease.shardCount, 31);
      for (var i = 0; i < 30; i++) {
        expect(
          lease.checkAdmit(index: i, demand: const ShardDemand(), nowMs: i),
          isNull,
          reason: '第 $i 片应放行',
        );
        lease = lease.claim(i);
      }
      expect(lease.rounds, 30);

      final over = lease.checkAdmit(
        index: 30,
        demand: const ShardDemand(),
        nowMs: 100,
      );
      expect(over!.code, 'session_budget_exceeded');
      expect(over.used, 30);
      expect(over.limit, 30);
    });
  });

  group('B8 跨轮租约（decisions Q9：120 分钟）', () {
    test('租约时长就是 120 分钟，到期时刻不含糊', () {
      expect(kLeaseTtlMs, 120 * 60 * 1000);
      final lease = newLease(nowMs: 1_000);
      expect(lease.grantedAt, 1_000);
      expect(lease.expiresAt, 1_000 + kLeaseTtlMs);
      expect(lease.isExpired(1_000 + kLeaseTtlMs - 1), isFalse);
      expect(lease.isExpired(1_000 + kLeaseTtlMs), isTrue);
    });

    test('过期租约不放行任何分片，错误码 lease_expired', () {
      final lease = newLease();
      final refusal = lease.checkAdmit(
        index: 0,
        demand: kDemand,
        nowMs: kLeaseTtlMs + 1,
      );
      expect(refusal!.code, kCodeLeaseExpired);
      expect(refusal.error, isNotEmpty);
      expect(refusal.fix, isNotEmpty);
    });

    test('续租从当下起算，已跑过的分片与用量不因续租丢失', () {
      var lease = newLease();
      lease = runShard(lease, FakeRunner(), 0, nowMs: 1_000);
      final renewed = lease.renew(5_000);
      expect(renewed.expiresAt, 5_000 + kLeaseTtlMs);
      expect(renewed.completedShards, <int>[0]);
      expect(renewed.used.bytes, 1024);
      expect(renewed.artifactsDigest, lease.artifactsDigest);
      expect(
        renewed.checkAdmit(index: 1, demand: kDemand, nowMs: 6_000),
        isNull,
      );
    });
  });

  group('B8 单飞与按会话续跑（contract K-53 / K-30）', () {
    test('同一会话第二笔长任务被拒 single_flight，不吞成「已发送」', () {
      final first = const LeaseBook().acquire(
        sessionId: 'b8s',
        traceId: 'T-b8s',
        msgId: 'm1',
        idempotencyKey: 'k1',
        totalMs: 900_000,
        nowMs: 0,
      );
      expect(first.refusal, isNull);
      expect(first.lease, isNotNull);

      final second = first.book.acquire(
        sessionId: 'b8s',
        traceId: 'T-b8s-2',
        msgId: 'm2',
        idempotencyKey: 'k2',
        totalMs: 900_000,
        nowMs: 0,
      );
      expect(second.refusal!.code, 'single_flight');
      expect(second.refusal!.error, isNotEmpty);
      expect(second.lease, isNull);
    });

    test('跑完之后同一会话可以再起一笔（跨轮同一 session_id）', () {
      var book = const LeaseBook();
      final first = book.acquire(
        sessionId: 'b8s',
        traceId: 'T-b8s',
        msgId: 'm1',
        idempotencyKey: 'k1',
        totalMs: 900_000,
        nowMs: 0,
      );
      book = first.book;
      var lease = first.lease!;
      final runner = FakeRunner();
      for (var i = 0; i < lease.shardCount; i++) {
        lease = runShard(lease, runner, i, nowMs: i);
        book = book.withLease(lease);
      }
      expect(book.resume('b8s'), isNull);

      final second = book.acquire(
        sessionId: 'b8s',
        traceId: 'T-b8s',
        msgId: 'm2',
        idempotencyKey: 'k2',
        totalMs: 900_000,
        nowMs: 10,
      );
      expect(second.refusal, isNull);
      expect(second.lease!.sessionId, 'b8s');
    });

    test('重启后按会话与幂等键都找回同一笔，首次结果即续跑凭证', () {
      var book = const LeaseBook();
      final first = book.acquire(
        sessionId: 'b8s',
        traceId: 'T-b8s',
        msgId: 'm1',
        idempotencyKey: 'k-b8s-1',
        totalMs: 900_000,
        nowMs: 0,
      );
      book = first.book;
      var lease = first.lease!;
      lease = runShard(lease, FakeRunner(), 0, nowMs: 1_000);
      book = book.withLease(lease);

      final revived = LeaseBook.fromJson(throughDisk(book.toJson()));
      final resumed = revived.resume('b8s');
      expect(resumed, isNotNull);
      expect(resumed!.idempotencyKey, 'k-b8s-1');
      expect(resumed.completedShards, <int>[0]);
      expect(resumed.artifactFor(0)!.digest, 'sha-b8-0');
      expect(resumed.artifactFor(0)!.id, 'b8-0');
      // 重放的键指向同一笔，不是新起一笔。
      expect(revived.byIdempotencyKey('k-b8s-1'), same(resumed));
    });

    test('过期未完成的租约挡住新任务：报 lease_expired 而不是 single_flight', () {
      final first = const LeaseBook().acquire(
        sessionId: 'b8s',
        traceId: 'T-b8s',
        msgId: 'm1',
        idempotencyKey: 'k1',
        totalMs: 900_000,
        nowMs: 0,
      );
      final revived = LeaseBook.fromJson(throughDisk(first.book.toJson()));
      final late = revived.acquire(
        sessionId: 'b8s',
        traceId: 'T-b8s',
        msgId: 'm2',
        idempotencyKey: 'k2',
        totalMs: 900_000,
        nowMs: kLeaseTtlMs + 1,
      );
      expect(late.refusal!.code, kCodeLeaseExpired);
      expect(late.lease, isNull);
    });
  });

  group('B8 状态落盘形状（闭集：不另造幂等标记）', () {
    test('toJson 键集固定，未知键拒收', () {
      final lease = newLease();
      expect(lease.toJson().keys.toSet(), <String>{
        'session_id',
        'trace_id',
        'msg_id',
        'idempotency_key',
        'total_ms',
        'granted_at',
        'expires_at',
        'completed',
        'dispatched',
        'artifacts',
        'used',
        'rounds',
      });
      final polluted = Map<String, dynamic>.from(lease.toJson())
        ..['dedupe_token'] = 'x';
      expect(
        () => AmooLease.fromJson(polluted),
        throwsA(isA<FormatException>()),
      );
    });

    test('每个字段都能过一遍磁盘再读回来', () {
      var lease = newLease(nowMs: 1_000);
      lease = runShard(lease, FakeRunner(), 0, nowMs: 2_000);
      lease = lease.claim(1);

      final back = AmooLease.fromJson(throughDisk(lease.toJson()));
      expect(back.sessionId, 'b8');
      expect(back.traceId, 'T-b8');
      expect(back.msgId, 'm-b8-1');
      expect(back.idempotencyKey, 'k-b8-1');
      expect(back.totalMs, 900_000);
      expect(back.grantedAt, 1_000);
      expect(back.expiresAt, 1_000 + kLeaseTtlMs);
      expect(back.completedShards, <int>[0]);
      expect(back.unconfirmedShard, 1);
      expect(back.artifactCount, 1);
      expect(back.used.bytes, 1024);
      expect(back.used.entries, 2);
      expect(back.used.files, 1);
      expect(back.rounds, 2);
      expect(back.artifactsDigest, lease.artifactsDigest);
    });

    test('形状损坏的落盘状态拒收，不猜不补', () {
      final good = newLease().toJson();
      expect(
        () => AmooLease.fromJson(<String, dynamic>{'session_id': 'b8'}),
        throwsA(isA<FormatException>()),
      );
      final badType = Map<String, dynamic>.from(good)..['total_ms'] = '900000';
      expect(
        () => AmooLease.fromJson(badType),
        throwsA(isA<FormatException>()),
      );
      final badList = Map<String, dynamic>.from(good)..['completed'] = '0,1';
      expect(
        () => AmooLease.fromJson(badList),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('B8 错误码与 contract K-23 表逐字一致', () {
    test('四个码各就各位', () {
      expect(kCodeSessionBudgetExceeded, 'session_budget_exceeded');
      expect(kCodeDuplicateId, 'duplicate_id');
      expect(kCodeSingleFlight, 'single_flight');
      expect(kCodeLeaseExpired, 'lease_expired');
    });
  });
}

/// 三片一次跑完。返回的租约就是判据 2 的比对基线。
AmooLease runAllShards() {
  final runner = FakeRunner();
  var lease = newLease();
  for (var i = 0; i < lease.shardCount; i++) {
    lease = runShard(lease, runner, i, nowMs: 1_000 + i);
  }
  return lease;
}
