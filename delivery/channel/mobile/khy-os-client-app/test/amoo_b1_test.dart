import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/amoo_bridge_adapter.dart';

/// B1 出向连接的单元级完成判定（测试先行，TASK.md §B.0.1「没有判定不开工」）。
///
/// 判据真源：TASK.md §4 B1 + §C2 拍板（放弃自建 WSS，改「节点通道下发 + 结果
/// 文件回写」）+ contract.md §1/§3（K-01/K-20/K-21/K-22/K-23/K-24/K-25/K-31/
/// K-61/K-62）。设备侧三条（结果文件 30s 内出现、`ss -ltnp` 无新增监听、锁屏 10
/// 分钟复测）在 device/B1.md；本文件守那三条之前必须先绿的一半——信封闭集、错误
/// 回执、seq 单调、信箱三态与重放、只读判定与幂等三字段、传输路由、事件全集。
///
/// API 形状即契约形状：要改先改本文件与 device/B1.md，不许删断言绕过。
/// 仓库里现在没有 amoo_bridge_adapter.dart——本文件编译失败就是预期的首败，
/// 原始输出由工作流脚本落 EVID 的 checks/b1_red.txt（TASK.md §D.3）。
///
/// 全文件只 import adapter 一个业务模块：门红必须只归因于 adapter 缺失。仓库
/// 现在还有一批基线红（TASK.md §A：analyze 多个 error、既有单测编译不过），多
/// import 一个模块就会把别人的红混进 B1 的首败里，届时分不清是谁没干活。
void main() {
  group('AmooEnvelope.parse: K-20 唯一信封闭集', () {
    // 五类 kind 的线上拼法（2026-11-13 裁决，device/adapter.md §1.2 第 1 件据此关闭）：
    // 中文（指令/事件/审批/结果/错误）——TASK.md §5 信封字段明文如此，contract §3.1、
    // call_chain.dart、Java CallChain.java、amoo_b6_test.dart、device/B6.md 全部一致。
    // 曾按「和信箱协议其余部分同一套拼写」钉成英文，与任务书 §5 冲突，改判定侧。
    AmooEnvelope build() => const AmooEnvelope(
          protoV: '1.0',
          sessionId: 'sess-1',
          msgId: 'm-1',
          seq: 1,
          from: 'cloud',
          to: 'device',
          kind: AmooKind.cmd,
          payload: {'tool': 'ping', 'args': {}},
          traceId: 'trace-1',
          depth: 0,
          idempotencyKey: 'idem-1',
        );

    test('完整信封往返一致，且字段闭集正好 12 个', () {
      final env = build();
      final json = env.toJson();
      expect(json.keys.length, 12);
      final back = AmooEnvelope.parse(json);
      expect(back, isNotNull);
      expect(back!.toJson(), env.toJson());
    });

    test('缺任一必填字段即拒（10 个必填逐个试）', () {
      const required = <String>[
        'proto_v', 'session_id', 'msg_id', 'seq', 'from', 'to',
        'kind', 'payload', 'trace_id', 'depth',
      ];
      for (final key in required) {
        final json = build().toJson()..remove(key);
        expect(AmooEnvelope.parse(json), isNull, reason: 'missing $key');
      }
    });

    test('多一个字段即拒（K-20：与既有 /call 闭集同风格）', () {
      final json = build().toJson()..['extra'] = 1;
      expect(AmooEnvelope.parse(json), isNull);
    });

    test('session_id 形状 ^[a-zA-Z0-9_-]{1,64}\$（后端同款校验）', () {
      String? sessionOf(String sid) {
        final json = build().toJson()..['session_id'] = sid;
        return AmooEnvelope.parse(json)?.sessionId;
      }

      expect(sessionOf('Ab-9_x'), 'Ab-9_x');
      expect(sessionOf('a b'), isNull);
      expect(sessionOf(''), isNull);
      expect(sessionOf('x' * 65), isNull);
      expect(sessionOf('中文'), isNull);
    });

    test('kind 必须五选一，未知值拒', () {
      for (final k in AmooKind.values) {
        final json = build().toJson()..['kind'] = k.wire;
        expect(AmooEnvelope.parse(json)?.kind, k);
      }
      expect(AmooEnvelope.parse(build().toJson()..['kind'] = 'Command'), isNull);
      expect(AmooEnvelope.parse(build().toJson()..['kind'] = 'ping'), isNull);
    });

    test('五个 kind 的线上字面量互不相同且非空', () {
      // 两个 kind 映射到同一个字面量时，parse 仍能过——但云端按 kind 分派会
      // 分错，那种错在单元层不炸、在设备侧才炸（B1 判据才看得见）。
      final wires = AmooKind.values.map((k) => k.wire).toSet();
      expect(wires.length, AmooKind.values.length);
      for (final w in wires) {
        expect(w, isNotEmpty);
      }
    });

    test('kind=指令 的 payload 是 {tool,args} 闭集，tool 非空、args 必须是对象', () {
      bool ok(Object payload) =>
          AmooEnvelope.parse(build().toJson()..['payload'] = payload) != null;

      // args 两层规则（任务书 §5 拍板，别合成一层断言）：线上可缺席——信箱路径
      // BridgeService.java:559-562 的既定行为是缺席补空对象；解析结果必须是对象
      // ——call_chain.dart:228 的规则。适配器在边界归一化，断言钉在归一化行为上。
      final noArgs = AmooEnvelope.parse(
          build().toJson()..['payload'] = <String, dynamic>{'tool': 'ping'});
      expect(noArgs, isNotNull);
      expect(noArgs!.payload['args'], <String, dynamic>{});

      expect(ok({'tool': 'ping', 'args': {'x': 1}}), isTrue);
      expect(ok({'tool': 'ping', 'extra': 1}), isFalse);
      expect(ok({'args': {}}), isFalse);
      expect(ok({'tool': ''}), isFalse);
      expect(ok({'tool': 'ping', 'args': 'nope'}), isFalse);
      expect(ok('not-a-map'), isFalse);
    });

    test('idempotency_key：指令/审批必填，事件可不带（契约 §3.1 表）', () {
      final cmd = build().toJson()..remove('idempotency_key');
      expect(AmooEnvelope.parse(cmd), isNull);

      final approval = build().toJson()
        ..['kind'] = '审批'
        ..remove('idempotency_key');
      expect(AmooEnvelope.parse(approval), isNull);

      final event = build().toJson()
        ..['kind'] = '事件'
        ..remove('idempotency_key');
      expect(AmooEnvelope.parse(event), isNotNull);

      // 可选字段「缺席」与「显式 null」必须等价：回执序列化把空值写成 null，
      // parse 若只认缺席，同一信封过一遍 JSON 就变了性质。
      expect(
          AmooEnvelope.parse(build().toJson()
            ..['kind'] = '事件'
            ..['idempotency_key'] = null),
          isNotNull);
    });

    test('seq/depth 必须是整数（布尔、字符串、小数、null 都不是）', () {
      for (final bad in <Object?>[true, '1', 1.5, null]) {
        expect(AmooEnvelope.parse(build().toJson()..['seq'] = bad), isNull,
            reason: 'seq=$bad');
        expect(AmooEnvelope.parse(build().toJson()..['depth'] = bad), isNull,
            reason: 'depth=$bad');
      }
      expect(AmooEnvelope.parse(build().toJson()..['depth'] = -1), isNull);
    });

    test('proto_v 必须在支持集合内，否则拒 proto_v_unsupported', () {
      expect(AmooProto.supported, isNotEmpty);
      expect(AmooProto.supported, contains('1.0'));

      final r = AmooBridge.rejectEnvelope(build().toJson()..['proto_v'] = '9.9');
      expect(r, isNotNull);
      expect(r!.code, AmooErrors.protoVUnsupported);
      // 契约 §3.1：「对方不在集合内即拒，消息里带上自己支持的值」——光拒不报
      // 支持哪个，对方只能猜着改。
      expect('${r.error} ${r.fix}', contains(AmooProto.supported.first));
    });

    test('proto_v 是字符串；1.0 当数字给也拒', () {
      expect(AmooEnvelope.parse(build().toJson()..['proto_v'] = 1.0), isNull);
      expect(AmooEnvelope.parse(build().toJson()..['proto_v'] = 1), isNull);
    });

    test('parent_span 可空；给了就必须是字符串', () {
      expect(AmooEnvelope.parse(build().toJson()..['parent_span'] = null), isNotNull);
      expect(AmooEnvelope.parse(build().toJson()..['parent_span'] = 'span-1'), isNotNull);
      expect(AmooEnvelope.parse(build().toJson()..['parent_span'] = 7), isNull);
    });
  });

  group('AmooErrors: K-22 错误回执 + K-24 幂等三字段', () {
    test('信封级拒绝的三个幂等字段恒 false', () {
      final r = AmooErrors.of(AmooErrors.invalidArguments,
          error: '缺 session_id', fix: '补上后重发', guideTopic: 'schema');
      expect(r.actionDispatched, isFalse);
      expect(r.replaySafe, isFalse);
      expect(r.retrySafe, isFalse);

      final json = r.toJson();
      expect(json['kind'], '错误');
      expect(json['code'], AmooErrors.invalidArguments);
      expect(json['action_dispatched'], isFalse);
      expect(json['replay_safe'], isFalse);
      expect(json['retry_safe'], isFalse);
    });

    test('错误码表是闭集：契约 K-23 的 15 个，一个不多一个不少', () {
      expect(AmooErrors.codes.toSet(), <String>{
        'unauthorized',
        'unknown_peer',
        'credential_expired',
        'proto_v_unsupported',
        'invalid_arguments',
        'unknown_tool',
        'duplicate_id',
        'seq_conflict',
        'recursion_depth_exceeded',
        'session_budget_exceeded',
        'approval_required',
        'approval_timeout',
        'ui_tool_unavailable',
        'not_installed',
        'single_flight',
      });
    });

    test('解析失败的回执带齐 问题+修复+guide_topic，不是静默 null', () {
      final r = AmooBridge.rejectEnvelope(<String, dynamic>{'kind': 'nope'});
      expect(r, isNotNull);
      expect(r!.code, AmooErrors.invalidArguments);
      expect(r.error, isNotEmpty);
      expect(r.fix, isNotEmpty);
      expect(r.guideTopic, isNotEmpty);
    });
  });

  group('AmooSeqGate: K-20 seq 单调递增', () {
    test('首条 seq=1 放行；此后严格 +1，跳号/回退/同秒重复即拒', () {
      final gate = AmooSeqGate();
      expect(gate.check(1), isNull);
      gate.confirm(1);

      expect(gate.check(3)!.code, AmooErrors.seqConflict); // 跳号
      expect(gate.check(0)!.code, AmooErrors.seqConflict); // 回退
      expect(gate.check(1)!.code, AmooErrors.seqConflict); // 同秒重复
      expect(gate.check(2), isNull);
      gate.confirm(2);
      expect(gate.check(2)!.code, AmooErrors.seqConflict);
    });

    test('续接以已确认的最大 seq 为基线', () {
      final gate = AmooSeqGate(baseline: 7);
      expect(gate.check(8), isNull);
      gate.confirm(8);
      expect(gate.check(9), isNull);
      expect(gate.check(7)!.code, AmooErrors.seqConflict);
    });
  });

  group('AmooMsgLog: K-20 msg_id 会话内唯一', () {
    test('重复 msg_id 即拒 duplicate_id，不执行', () {
      final log = AmooMsgLog();
      expect(log.check('m-1'), isNull);
      log.record('m-1');

      expect(log.check('m-1')!.code, AmooErrors.duplicateId);
      expect(log.check('m-2'), isNull);
    });

    // T15：链路是「先认领、再执行」——不先认领，服务端重投的第二帧会在第一帧
    // 还没跑完时挤进来，两帧一起执行。但认领之后执行抛了，这条 id 就再也放不
    // 出来，重投被当重复吞掉，指令永久丢失。forget 就是那个解药。
    test('认领后撤回：同 id 可再次执行（执行失败时重投才有救）', () {
      final log = AmooMsgLog();
      log.record('m-1');
      expect(log.check('m-1')!.code, AmooErrors.duplicateId);

      log.forget('m-1');
      expect(log.check('m-1'), isNull,
          reason: '撤回认领后，服务端的重投必须能重新执行，不能被永久吞掉');
    });

    test('撤回不存在的 id 不抛、不影响其他 id', () {
      final log = AmooMsgLog();
      log.record('m-1');
      log.forget('never-seen');
      expect(log.check('m-1')!.code, AmooErrors.duplicateId);
    });
  });

  group('AmooMailbox: K-03 三态 + K-25 重放', () {
    test('id 规范 1-128 位 [A-Za-z0-9_-]（BridgeService.java isValidMailboxId）', () {
      expect(AmooMailbox.isValidId('A'), isTrue);
      expect(AmooMailbox.isValidId('a_b-C9'), isTrue);
      expect(AmooMailbox.isValidId('x' * 128), isTrue);
      expect(AmooMailbox.isValidId(''), isFalse);
      expect(AmooMailbox.isValidId('x' * 129), isFalse);
      expect(AmooMailbox.isValidId('a b'), isFalse);
      expect(AmooMailbox.isValidId('a.b'), isFalse);
      expect(AmooMailbox.isValidId('中文'), isFalse);
    });

    test('文件名三态由同一 id 派生', () {
      expect(AmooMailbox.cmdFile('k1'), 'cmd_k1.json');
      expect(AmooMailbox.processingFile('k1'), 'processing_k1.json');
      expect(AmooMailbox.resultFile('k1'), 'result_k1.json');
    });

    test('正文 id 与文件名 id 不一致 → invalid_arguments，未执行', () {
      final d = AmooMailbox.decide(id: 'k1', bodyId: 'k2', present: const {});
      expect(d.action, AmooMailAction.reject);
      expect(d.receipt!.code, AmooErrors.invalidArguments);
      expect(d.receipt!.actionDispatched, isFalse);
    });

    test('已有 result → 重放首次结果，不二次执行（K-25）', () {
      final d =
          AmooMailbox.decide(id: 'k1', bodyId: 'k1', present: const {'result_k1.json'});
      expect(d.action, AmooMailAction.replay);
      expect(d.resultFile, 'result_k1.json');

      // result 与遗留 processing 同时在，仍以 result 为准：拒绝路径绝不覆盖
      // 既有 result（BridgeService.java 同秒冲突分支的硬约束）。
      final d2 = AmooMailbox.decide(
          id: 'k1', bodyId: 'k1', present: const {'result_k1.json', 'processing_k1.json'});
      expect(d2.action, AmooMailAction.replay);
    });

    test('遗留 processing 且无 result → duplicate_id（那次副作用未知）', () {
      final d =
          AmooMailbox.decide(id: 'k1', bodyId: 'k1', present: const {'processing_k1.json'});
      expect(d.action, AmooMailAction.reject);
      expect(d.receipt!.code, AmooErrors.duplicateId);
      expect(d.receipt!.actionDispatched, isFalse);
    });

    test('干净信箱 → claim（改名占位后才执行）', () {
      final d = AmooMailbox.decide(
          id: 'k1', bodyId: 'k1', present: const {'result_other.json'});
      expect(d.action, AmooMailAction.claim);
    });
  });

  group('AmooTools: K-24 只读判定镜像桥（BridgeService.java:576-587）', () {
    test('只读集合逐字等于桥那 14 个', () {
      expect(AmooTools.readOnlyNames.toSet(), <String>{
        'ping', 'info', 'tools', 'ls', 'read', 'stat',
        'list_apps', 'battery', 'loop_status', 'amoo_result',
        'secret_list', 'ui_dump', 'shot', 'shot_b64',
      });
    });

    test('双态工具看参数：带值即变异，不带值才是只读', () {
      expect(AmooTools.isReadOnly('volume', const {}), isTrue);
      expect(AmooTools.isReadOnly('volume', const {'level': 5}), isFalse);
      expect(AmooTools.isReadOnly('brightness', const {}), isTrue);
      expect(AmooTools.isReadOnly('brightness', const {'value': 128}), isFalse);
      expect(AmooTools.isReadOnly('clipboard', const {}), isTrue);
      expect(AmooTools.isReadOnly('clipboard', const {'op': 'set'}), isFalse);
      expect(AmooTools.isReadOnly('clipboard', const {'op': 'get'}), isTrue);
      expect(AmooTools.isReadOnly('amoo_memory', const {'op': 'set'}), isFalse);
      expect(AmooTools.isReadOnly('amoo_memory', const {'op': 'get'}), isTrue);
    });

    test('未列入的工具一律按变异处理——不猜安全', () {
      // 桥侧注释原文：anything not listed here is treated as mutating。
      // 猜安全的后果是重放了有副作用的动作，而调用方以为没副作用。
      for (final t in <String>['exec', 'write', 'rm', 'toast', 'ui_click', 'nope']) {
        expect(AmooTools.isReadOnly(t, const {}), isFalse, reason: t);
      }
    });
  });

  group('AmooResult: K-24/K-62 幂等三字段的成功路径', () {
    test('只读成功：四字段齐且三幂等全 true（B1 设备判据同款）', () {
      final r = AmooResult.of(
          id: 'b1-1', tool: 'ping', ok: true, dispatched: true,
          output: const {'pong': true});
      expect(r.ok, isTrue);
      expect(r.actionDispatched, isTrue);
      expect(r.replaySafe, isTrue);
      expect(r.retrySafe, isTrue);

      final json = r.toJson();
      expect(json['kind'], AmooKind.result.wire);
      expect(json['ok'], isTrue);
      expect(json['action_dispatched'], isTrue);
      expect(json['replay_safe'], isTrue);
      expect(json['retry_safe'], isTrue);
    });

    test('有副作用工具成功也不可重放（read 判据含「只读」这一项）', () {
      final r = AmooResult.of(
          id: 'k1', tool: 'write', args: const {'path': '/sdcard/x'},
          ok: true, dispatched: true);
      expect(r.actionDispatched, isTrue);
      expect(r.ok, isTrue);
      expect(r.replaySafe, isFalse);
      expect(r.retrySafe, isFalse);
    });

    test('ok=false 永不 retry-safe；没到工具层时 dispatched=false', () {
      final r = AmooResult.of(id: 'k1', tool: 'ping', ok: false, dispatched: false);
      expect(r.ok, isFalse);
      expect(r.actionDispatched, isFalse);
      expect(r.replaySafe, isFalse);
      expect(r.retrySafe, isFalse);
    });

    test('派发了但失败：dispatched=true 而 ok=false，仍不可重放', () {
      // 这一格是 K-62 的分界：调用方能「修正后重发」的充分条件是
      // dispatched=false；dispatched=true 时副作用可能已经发生了。
      final r = AmooResult.of(id: 'k1', tool: 'write', ok: false, dispatched: true);
      expect(r.actionDispatched, isTrue);
      expect(r.ok, isFalse);
      expect(r.replaySafe, isFalse);
      expect(r.retrySafe, isFalse);
    });
  });

  group('AmooDelivery: K-61 已下发未确认', () {
    test('processing 在、result 缺席 = 未确认，措辞不许说「已执行」', () {
      expect(
          AmooDelivery.stateOf(present: const {'processing_k1.json'}, id: 'k1'),
          AmooDeliveryState.unconfirmed);
      final label = AmooDelivery.labelOf(AmooDeliveryState.unconfirmed);
      expect(label, contains('未确认'));
      expect(label, isNot(contains('已执行')));
    });

    test('result 出现 = 已结算；只有 cmd = 已下发；无痕迹 = absent', () {
      expect(
          AmooDelivery.stateOf(
              present: const {'result_k1.json', 'processing_k1.json'}, id: 'k1'),
          AmooDeliveryState.settled);
      expect(AmooDelivery.stateOf(present: const {'cmd_k1.json'}, id: 'k1'),
          AmooDeliveryState.dispatched);
      expect(AmooDelivery.stateOf(present: const <String>{}, id: 'k1'),
          AmooDeliveryState.absent);
    });

    test('四个状态的措辞互不重复', () {
      final labels =
          AmooDeliveryState.values.map(AmooDelivery.labelOf).toSet();
      expect(labels.length, AmooDeliveryState.values.length);
    });
  });

  group('AmooBridge.transportFor: K-01/K-21 按 to 路由到传输实现', () {
    test('to=device 走节点通道下发，to=cloud 走结果文件回写', () {
      expect(AmooBridge.transportFor('device'), AmooTransport.nodeChannel);
      expect(AmooBridge.transportFor('cloud'), AmooTransport.resultFile);
    });

    test('同一 to 恒得同一传输，不随调用漂移', () {
      // 路由随调用变就意味着同一笔指令可能这次走节点通道、下次走信箱，
      // 判据（30s 内出 result）就再也归因不到任一条通道上。
      expect(AmooBridge.transportFor('device'), AmooBridge.transportFor('device'));
      expect(AmooBridge.transportFor('cloud'), AmooBridge.transportFor('cloud'));
    });
  });

  group('AmooStream: K-31 事件流复用 SSE 全集', () {
    test('事件类型逐字等于 /api/ai/chat/stream 那 8 个', () {
      // 真源：routes/ai.js 的 sendEvent 调用处与 lib/core/gateway/khyos_api.dart
      // 的 KhyOsStreamEvent。自造一套事件名 = 轮询伪装事件流（TASK.md §10 禁止）。
      expect(AmooStream.events.toSet(), <String>{
        'start', 'status', 'heartbeat', 'control_request',
        'chunk', 'thinking_content', 'done', 'error',
      });
    });
  });

  group('AmooPeers: K-13/K-21 路由', () {
    test('未登记身份一律拒 unknown_peer，已登记配对放行', () {
      final peers = AmooPeers(const {'cloud', 'device'});
      expect(peers.checkRoute(from: 'cloud', to: 'device'), isNull);
      expect(peers.checkRoute(from: 'cloud', to: 'ghost')!.code,
          AmooErrors.unknownPeer);
      expect(peers.checkRoute(from: 'ghost', to: 'device')!.code,
          AmooErrors.unknownPeer);
    });
  });
}
