import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/amoo_bridge_adapter.dart';
import 'package:khy_os_client/core/trajectory/call_chain.dart';

import 'kotlin_source_support.dart';

/// ADAPTER 适配层核心的单元级完成判定（测试先行，TASK.md §B.0.1「没有判定不开工」）。
///
/// 判据真源：contract.md §1（K-01 唯一传输接触点 / K-02 节点通道下发 / K-03 结果文件
/// 回写 / K-04 设备侧权威 / K-05 审批状态文件 / K-07 断网续接）+ §3（K-20 唯一信封闭集 /
/// K-21 路由 / K-24 幂等三字段 / K-25 重放同 key 返回首次结果）+ §9（K-81/K-82 审批状态
/// 文件与超时默认拒绝）+ decisions.md Q9（租约 120 分钟）。
///
/// 与 B1 门的分工：`test/amoo_b1_test.dart` 钉信封/信箱/回执的**字段级**形状（parse 的
/// 每一条拒绝、信箱三态、只读判定、事件全集）；本门钉「**一个缝**」本身——六件事：
/// ① 编解码只发生在适配器边界一次，且过一遍线不变形（两端哈希比对 N9 的前提）；
/// ② 四种传输一张表，下发与回写都过同一个 `send`，信封过去不改一个字段；
/// ③ 落设备存储的三条传输写方只有设备（云端只读消费）；
/// ④ 审批状态文件的命名、审批单 id 与四态处置；
/// ⑤ 租约闸门在传输之前；
/// ⑥ 幂等三字段复用桥侧那三个，不另造第四个标记。
/// 设备侧三条（结果文件 30s、`ss -ltnp` 无新增监听、锁屏 10 分钟）在 device/B1.md；
/// 适配层在设备上的层级观测在 device/adapter.md。
///
/// 本文件对当前代码是红的：`lib/core/gateway/amoo_bridge_adapter.dart` 尚不存在
/// （2026-11-13 实读 `lib/core/gateway/`：ai_gateway / key_health / key_pool /
/// khyos_api / market_catalog / pairing / provider_adapter / zen_errors / zen_gate /
/// zen_models 十个文件，无 `amoo_*`），import 即编译失败。首败原始输出按 EVID 约定落
/// `checks/ADAPTER_red.txt`（TASK.md §D.3）。
///
/// 本文件新增钉住的 API 形状（实现方按此落地，要改先改本文件与 device/adapter.md）：
/// `AmooBridge.encodeEnvelope/encodeEnvelopeText/decodeEnvelopeText/rejectEnvelopeText`、
/// `AmooBridge.transports`（K-01 四行表）、`AmooBridge.send`（→ `AmooSend`）、
/// `AmooBridge.canWrite`、`AmooBridge.approvalFile/approvalIdOf/approvalDisposition`、
/// `AmooBridge.checkLease`，以及回执类型名 `AmooReceipt`（B1 门只用类型推断，没钉名字）。
///
/// 两处跨规格待裁（如实标注，不装作没有）：
/// 1. **kind 线上值两套**：contract §3.1 表给的是中文枚举（指令/事件/审批/结果/错误），
///    `lib/core/trajectory/call_chain.dart:53-57` 按表实现中文；而
///    `test/amoo_b1_test.dart:111-118` 把适配器侧钉成英文（'approval'/'event'）。
///    本门钉「两侧同一套」而不钉哪一套——方向由实现方定，但选定后两边必须一起改，
///    不许各留一套（K-20 唯一信封）。
/// 2. **`lease_expired` 不在 contract K-23 表内**：B8 门（test/amoo_b8_test.dart:19-22）
///    已注明需在契约补一行、锚点【B8】。本门钉字面值 `'lease_expired'`；补行后
///    `test/amoo_b1_test.dart:180-198` 的「15 个码一个不多一个不少」要同步成 16，
///    两边一起改，不许单方面删断言绕过。

void main() {
  group('ADAPTER 信封编解码：K-20 编解码只发生在适配器边界一次', () {
    test('encode 就是信封自己的 toJson，边界不引入第二套字段名', () {
      final env = envelope();
      expect(AmooBridge.encodeEnvelope(env), env.toJson());
      expect(AmooBridge.encodeEnvelope(env).keys.toSet(), <String>{
        'proto_v',
        'session_id',
        'msg_id',
        'seq',
        'from',
        'to',
        'kind',
        'payload',
        'trace_id',
        'parent_span',
        'depth',
        'idempotency_key',
      });
    });

    test('文本往返：同一份文本解出同一信封，再编码得同一份文本', () {
      // 节点通道交付的是 JSON 文本、结果文件里躺的也是 JSON 文本——编解码在边界
      // 发生一次，业务层拿到的已经是信封对象。
      final env = envelope();
      final text = AmooBridge.encodeEnvelopeText(env);
      expect(text, isNotEmpty);

      final back = AmooBridge.decodeEnvelopeText(text);
      expect(back, isNotNull);
      expect(back!.toJson(), env.toJson());
      // 两端哈希差异 0（N9）的前提：编码确定性 + 过一遍线不变形。缺这一条，
      // 同一笔消息在两端会各算出不同的摘要，而差异查不到字段上。
      expect(AmooBridge.encodeEnvelopeText(back), text);
    });

    test('同一信封两次编码逐字节相同', () {
      final env = envelope(msgId: 'm-det', traceId: 'trace-det');
      expect(
          AmooBridge.encodeEnvelopeText(env), AmooBridge.encodeEnvelopeText(env));
    });

    test('垃圾文本拒收返回 null，拒绝回执带齐三件套且不抛异常', () {
      // 传输层交付的字节串什么都有可能：适配器边界是唯一该把它变成「拒」的地方。
      // 抛异常会把一次坏消息变成一次崩溃，调用方拿不到可执行的修复建议。
      for (final garbage in const <String>[
        '',
        '   ',
        'not json',
        '[]',
        'null',
        '42',
        '"str"',
        '{',
        '{"proto_v":1}',
      ]) {
        expect(AmooBridge.decodeEnvelopeText(garbage), isNull, reason: garbage);
        final r = AmooBridge.rejectEnvelopeText(garbage);
        expect(r, isNotNull, reason: garbage);
        expect(r!.code, AmooErrors.invalidArguments, reason: garbage);
        expect(r.error, isNotEmpty, reason: garbage);
        expect(r.fix, isNotEmpty, reason: garbage);
        expect(r.guideTopic, isNotEmpty, reason: garbage);
        expect(r.actionDispatched, isFalse, reason: garbage);
      }
    });

    test('proto_v 不在支持集合内：文本路径与 Map 路径同一个码', () {
      final foreign = envelope(protoV: '9.9');
      final text = jsonEncode(AmooBridge.encodeEnvelope(foreign));
      expect(AmooBridge.decodeEnvelopeText(text), isNull);

      final r = AmooBridge.rejectEnvelopeText(text);
      expect(r, isNotNull);
      expect(r!.code, AmooErrors.protoVUnsupported);
      // 契约 §3.1：「对方不在集合内即拒，消息里带上自己支持的值」——光拒不报
      // 支持哪个，对方只能猜着改。
      expect('${r.error} ${r.fix}', contains(AmooProto.supported.first));
    });

    test('信封多一个字段：文本路径同样拒（闭集不认「多了个可选字段」）', () {
      final json = AmooBridge.encodeEnvelope(envelope())..['extra'] = 1;
      expect(AmooBridge.decodeEnvelopeText(jsonEncode(json)), isNull);
    });
  });

  group('ADAPTER K-20 唯一信封：适配器与调用链护栏同一份词汇', () {
    test('kind 线上值两处同一套，一个不多一个不少', () {
      // 两套线上值同时存在时，云端按 kind 分派会分错——那种错在单元层不炸、
      // 在设备侧才炸（B6 判据才看得见）。本断言钉「同一套」，不钉哪一套：
      // 见文件头待裁第 1 条。
      expect(AmooKind.values.map((k) => k.wire).toSet(),
          CallKind.values.map((k) => k.wire).toSet());
    });

    test('12 个合约字段同名同集合（K-20 闭集）', () {
      expect(envelope().toJson().keys.toSet(),
          callEnvelope().toJson().keys.toSet());
    });

    test('proto_v 支持集合同一套', () {
      expect(AmooProto.supported.toSet(), kSupportedProtoV);
    });
  });

  group('ADAPTER K-01 四种传输一张表（适配器是唯一接触点）', () {
    test('T1-T4 一行不少，载体互不相同', () {
      final rows = AmooBridge.transports;
      expect(rows.length, 4);
      expect(rows.map((r) => r.id).toSet(), <String>{'T1', 'T2', 'T3', 'T4'});
      // 两种传输共用同一个载体时，判据（30s 内出 result）就再也归因不到任一条
      // 通道上——表必须先于实现把这事钉住。
      expect(rows.map((r) => r.transport).toSet().length, 4);
    });

    test('写方只有设备：T2/T3/T4 落设备存储的三条都归设备单写', () {
      final byId = {for (final r in AmooBridge.transports) r.id: r};
      expect(byId['T1']!.transport, AmooTransport.nodeChannel);
      expect(byId['T1']!.writer, 'cloud');
      expect(byId['T2']!.transport, AmooTransport.resultFile);
      expect(byId['T2']!.writer, 'device');
      expect(byId['T3']!.transport, AmooTransport.sharedStore);
      expect(byId['T3']!.writer, 'device');
      expect(byId['T4']!.transport, AmooTransport.approvalFile);
      expect(byId['T4']!.writer, 'device');
    });

    test('transportFor 与表一致（K-21 按 to 路由）', () {
      final byId = {for (final r in AmooBridge.transports) r.id: r};
      expect(AmooBridge.transportFor('device'), byId['T1']!.transport);
      expect(AmooBridge.transportFor('cloud'), byId['T2']!.transport);
    });
  });

  group('ADAPTER K-02/K-03 下发与回写：一个缝，信封过去不变形', () {
    test('to=device → 节点通道帧，帧就是信封本身（下发不改信封）', () {
      final env = envelope();
      final sent = AmooBridge.send(env);
      expect(sent.receipt, isNull);
      expect(sent.transport, AmooTransport.nodeChannel);
      expect(sent.frame, isNotNull);
      expect(sent.frame, AmooBridge.encodeEnvelope(env));
      // 帧解回来还是同一封信：msg_id/seq/trace_id 一个都不能变，span 链复原
      // （K-50）与序号单调（K-20）都指着它们。
      expect(AmooEnvelope.parse(sent.frame!)!.toJson(), env.toJson());
      expect(sent.file, isNull);
      expect(sent.body, isNull);
      expect(sent.replay, isFalse);
    });

    test('to=cloud 且 kind=结果 → 结果文件回写，文件名由幂等键派生', () {
      final env = resultEnvelope();
      final sent = AmooBridge.send(env);
      expect(sent.receipt, isNull);
      expect(sent.transport, AmooTransport.resultFile);
      // K-25：信箱场景的文件名 id 就是 idempotency_key。
      expect(sent.file, 'result_k1.json');
      expect(sent.body, isNotNull);
      expect(sent.body!['kind'], AmooKind.result.wire);
      expect(sent.body!['msg_id'], env.msgId);
      expect(sent.body!['trace_id'], env.traceId);
      // 正文过同一套编解码，不为文件形态另起一个序列化器。
      expect(sent.body, AmooBridge.encodeEnvelope(env));
      expect(sent.frame, isNull);
    });

    test('回写只收 kind=结果：指令走回写通道即拒', () {
      final sent = AmooBridge.send(envelope(to: 'cloud', kind: AmooKind.cmd));
      expect(sent.frame, isNull);
      expect(sent.file, isNull);
      expect(sent.receipt, isNotNull);
      expect(sent.receipt!.code, AmooErrors.invalidArguments);
      expect(sent.receipt!.actionDispatched, isFalse);
    });

    test('已有 result 同 key → 重放首次结果，不再下发也不再覆盖（K-25）', () {
      for (final to in const ['device', 'cloud']) {
        final env = to == 'cloud' ? resultEnvelope() : envelope();
        final sent = AmooBridge.send(env, present: const {'result_k1.json'});
        expect(sent.receipt, isNull, reason: to);
        expect(sent.replay, isTrue, reason: to);
        expect(sent.file, 'result_k1.json', reason: to);
        // 首次结果在盘上，适配器不重新生成正文——重放覆盖既有 result 是禁止项
        // （BridgeService.java 同秒冲突分支：拒绝路径绝不覆盖既有 result）。
        expect(sent.body, isNull, reason: to);
        expect(sent.frame, isNull, reason: to);
      }
    });

    test('只有 cmd_ 在（已下发未认领）→ 照常下发，与重放分开', () {
      // 「已下发未确认」的观测量是 processing 在、result 缺席（K-61）；cmd_ 在
      // 说明 worker 还没认领。两种形状混为一谈会把未确认的消息当成已确认的重放。
      final sent = AmooBridge.send(envelope(), present: const {'cmd_k1.json'});
      expect(sent.receipt, isNull);
      expect(sent.replay, isFalse);
      expect(sent.frame, isNotNull);
    });

    test('遗留 processing 且无 result → duplicate_id，那次副作用未知', () {
      final sent =
          AmooBridge.send(envelope(), present: const {'processing_k1.json'});
      expect(sent.replay, isFalse);
      expect(sent.frame, isNull);
      expect(sent.receipt, isNotNull);
      expect(sent.receipt!.code, AmooErrors.duplicateId);
      expect(sent.receipt!.actionDispatched, isFalse);
    });

    test('to 是未登记身份 → unknown_peer，帧都不生成', () {
      final sent = AmooBridge.send(envelope(to: 'ghost'));
      expect(sent.frame, isNull);
      expect(sent.receipt, isNotNull);
      expect(sent.receipt!.code, AmooErrors.unknownPeer);
    });

    test('幂等键形状不合法 → invalid_arguments，写不出信箱目录之外', () {
      for (final bad in <String>['', 'a b', '../escape', 'a.b', 'x' * 129]) {
        final sent = AmooBridge.send(resultEnvelope(key: bad));
        expect(sent.file, isNull, reason: bad);
        expect(sent.receipt, isNotNull, reason: bad);
        expect(sent.receipt!.code, AmooErrors.invalidArguments, reason: bad);
      }
    });
  });

  group('ADAPTER K-04/K-70 设备侧权威：落设备存储的写方只有设备', () {
    test('canWrite 矩阵：节点通道归云端，其余三条归设备', () {
      expect(AmooBridge.canWrite('cloud', AmooTransport.nodeChannel), isTrue);
      expect(AmooBridge.canWrite('device', AmooTransport.nodeChannel), isFalse);
      expect(AmooBridge.canWrite('device', AmooTransport.resultFile), isTrue);
      expect(AmooBridge.canWrite('device', AmooTransport.sharedStore), isTrue);
      expect(AmooBridge.canWrite('device', AmooTransport.approvalFile), isTrue);
      expect(AmooBridge.canWrite('cloud', AmooTransport.resultFile), isFalse);
      expect(AmooBridge.canWrite('cloud', AmooTransport.sharedStore), isFalse);
      expect(AmooBridge.canWrite('cloud', AmooTransport.approvalFile), isFalse);
      // 未登记身份在任何载体上都没有写权（K-13）。
      for (final t in AmooTransport.values) {
        expect(AmooBridge.canWrite('ghost', t), isFalse, reason: '$t');
      }
    });

    test('云端来源的结果回写被拒：unauthorized + 三字段恒 false', () {
      final sent = AmooBridge.send(resultEnvelope(from: 'cloud'));
      expect(sent.frame, isNull);
      expect(sent.file, isNull);
      expect(sent.body, isNull);
      final r = sent.receipt;
      expect(r, isNotNull);
      expect(r!.code, AmooErrors.unauthorized);
      expect(r.actionDispatched, isFalse);
      expect(r.replaySafe, isFalse);
      expect(r.retrySafe, isFalse);
      // 规则 2.2：错误消息要说清「谁是写方」，否则调用方只看到一句无权，
      // 不知道该把回写挪回设备侧还是去改授权。
      expect(r.error, isNotEmpty);
      expect(r.fix, isNotEmpty);
      expect(r.guideTopic, isNotEmpty);
    });
  });

  group('ADAPTER K-05/K-81/K-82 审批状态文件（T4）', () {
    test('状态文件名 approval_<id>.json，id 形状同信箱 id', () {
      expect(AmooBridge.approvalFile('b7-rm-1'), 'approval_b7-rm-1.json');
      for (final bad in <String>['', 'a b', '../escape', 'a.b', 'x' * 129, '中文']) {
        expect(AmooBridge.approvalFile(bad), isNull, reason: bad);
      }
    });

    test('审批单 id 就是信封 idempotency_key（K-81 原文）', () {
      expect(AmooBridge.approvalIdOf(envelope(kind: AmooKind.approval)), 'k1');
      // 其它 kind 没有审批单：把指令的幂等键当审批 id 用，会去读一个不存在的
      // 状态文件，然后按「读不到」放行或拒绝——两种都是猜。
      expect(AmooBridge.approvalIdOf(envelope(kind: AmooKind.cmd)), isNull);
    });

    test('approved 放行；pending/denied 拒 approval_required；expired 拒 approval_timeout', () {
      expect(AmooBridge.approvalDisposition(state: 'approved', nowMs: 100), isNull);

      final pending = AmooBridge.approvalDisposition(
          state: 'pending', nowMs: 100, expiresAt: 100 + 120000);
      expect(pending, isNotNull);
      expect(pending!.code, AmooErrors.approvalRequired);

      final denied = AmooBridge.approvalDisposition(state: 'denied', nowMs: 100);
      expect(denied, isNotNull);
      expect(denied!.code, AmooErrors.approvalRequired);

      final expired = AmooBridge.approvalDisposition(state: 'expired', nowMs: 100);
      expect(expired, isNotNull);
      expect(expired!.code, AmooErrors.approvalTimeout);
    });

    test('pending 但已过 expires_at：按过期拒，不照 pending 放行', () {
      // 超时在设备侧判（K-82）。云端轮询读到状态文件的间隙里，过期必须已经被
      // 判掉：一个「文件还写着 pending 就放行」的实现，等于把默认拒绝交给
      // 读取时机，而没人保证那个时机。
      final late = AmooBridge.approvalDisposition(
          state: 'pending', nowMs: 100 + 120001, expiresAt: 100 + 120000);
      expect(late, isNotNull);
      expect(late!.code, AmooErrors.approvalTimeout);
    });

    test('未知状态拒收，不猜不补', () {
      for (final bad in const ['PENDING', 'cancelled', '', 'approved ']) {
        final r = AmooBridge.approvalDisposition(state: bad, nowMs: 1);
        expect(r, isNotNull, reason: bad);
        expect(r!.code, AmooErrors.invalidArguments, reason: bad);
      }
    });

    test('所有拒绝的三幂等字段恒 false：未确认就没有副作用', () {
      final receipts = <AmooReceipt?>[
        AmooBridge.approvalDisposition(
            state: 'pending', nowMs: 1, expiresAt: 99999),
        AmooBridge.approvalDisposition(state: 'expired', nowMs: 1),
        AmooBridge.approvalDisposition(state: 'denied', nowMs: 1),
        AmooBridge.approvalDisposition(state: 'nope', nowMs: 1),
      ];
      for (final r in receipts) {
        expect(r, isNotNull);
        expect(r!.actionDispatched, isFalse);
        expect(r.replaySafe, isFalse);
        expect(r.retrySafe, isFalse);
      }
    });
  });

  group('ADAPTER K-07/Q9 租约闸门：过期不受理新指令', () {
    test('无租约的本机轮次放行；未到期放行', () {
      // 不带 sessionId 的轮次只存在于本机存储（K-30），没有租约可判。
      expect(AmooBridge.checkLease(nowMs: 1000), isNull);
      expect(AmooBridge.checkLease(expiresAt: 1000, nowMs: 999), isNull);
    });

    test('到期那一刻起拒，错误码 lease_expired，三字段恒 false', () {
      final r = AmooBridge.checkLease(expiresAt: 1000, nowMs: 1000);
      expect(r, isNotNull);
      expect(r!.code, 'lease_expired');
      expect(r.actionDispatched, isFalse);
      expect(r.replaySafe, isFalse);
      expect(r.retrySafe, isFalse);
      expect(r.error, isNotEmpty);
      // 修复建议要能执行：说清「续租」而不是「请重试」——重试一次还是这个码。
      expect(r.fix, isNotEmpty);
      expect(r.guideTopic, isNotEmpty);
    });

    test('租约过期时 send 不发帧（闸门在传输之前）', () {
      // 闸门放在传输之后就晚了：帧已经出到节点通道上，撤回不了。
      // 租约真源在 amoo_lease.dart（B8），这里只喂到期时刻这一可观测量，
      // 适配器自己不读系统时钟——判定因此可复现。
      final sent =
          AmooBridge.send(envelope(), lease: (expiresAt: 1000, nowMs: 1000));
      expect(sent.frame, isNull);
      expect(sent.file, isNull);
      expect(sent.receipt, isNotNull);
      expect(sent.receipt!.code, 'lease_expired');
    });
  });

  group('ADAPTER K-24 幂等三字段：复用桥侧那三个，不另造第四个', () {
    test('适配器产出的每一份拒绝回执都带齐三个字段且恒 false', () {
      final receipts = <AmooReceipt?>[
        AmooErrors.of(AmooErrors.invalidArguments,
            error: '缺 session_id', fix: '补上后重发', guideTopic: 'schema'),
        AmooBridge.rejectEnvelope(<String, dynamic>{'kind': 'nope'}),
        AmooBridge.rejectEnvelopeText('not json'),
        AmooBridge.send(resultEnvelope(from: 'cloud')).receipt,
        AmooBridge.send(resultEnvelope(key: '../escape')).receipt,
        AmooBridge.send(envelope(), lease: (expiresAt: 0, nowMs: 1)).receipt,
        AmooBridge.approvalDisposition(state: 'expired', nowMs: 1),
        AmooBridge.checkLease(expiresAt: 0, nowMs: 1),
      ];
      for (final r in receipts) {
        expect(r, isNotNull);
        final json = r!.toJson();
        expect(json['action_dispatched'], isFalse, reason: '${json['code']}');
        expect(json['replay_safe'], isFalse, reason: '${json['code']}');
        expect(json['retry_safe'], isFalse, reason: '${json['code']}');
      }
    });

    test('回执与回写正文里没有任何第四个幂等标记（TASK.md §10 禁止项）', () {
      final bodies = <Object?>[
        AmooErrors.of(AmooErrors.invalidArguments,
                error: 'e', fix: 'f', guideTopic: 'schema')
            .toJson(),
        AmooBridge.send(resultEnvelope(from: 'cloud')).receipt!.toJson(),
        AmooBridge.approvalDisposition(state: 'expired', nowMs: 1)!.toJson(),
        AmooBridge.checkLease(expiresAt: 0, nowMs: 1)!.toJson(),
        AmooBridge.send(resultEnvelope()).body,
      ];
      for (final body in bodies) {
        final hits = idempotencyishKeys(body);
        expect(
            hits.difference(
                <String>{'action_dispatched', 'replay_safe', 'retry_safe'}),
            isEmpty,
            reason: '多出来的幂等标记：${hits.join(',')}');
      }
    });

    test('三个字段名逐字来自桥侧 Java，不是 Dart 侧新造的', () {
      final src = readNativeSource(kBridgeServicePath);
      expect(src, isNotNull,
          reason: '读不到 $kBridgeServicePath——复用判定读不到原生真源就只能判不通过');
      for (final name in const <String>[
        'action_dispatched',
        'replay_safe',
        'retry_safe',
      ]) {
        expect(src, contains(name), reason: '$name 不在桥侧回执里');
      }
      // 适配器侧同一套名字：回执 JSON 的键与桥侧逐字相同。
      final r = AmooBridge.rejectEnvelopeText('not json');
      expect(r, isNotNull);
      expect(r!.toJson().keys,
          containsAll(<String>['action_dispatched', 'replay_safe', 'retry_safe']));
    });
  });
}

/// 原生 `BridgeService.java`：三个幂等字段名的真源（成功路径写入处）。
const String kBridgeServicePath =
    'android/app/src/main/java/com/khyos/khy_os_client/bridge/BridgeService.java';

/// 一笔云端→设备的指令信封。`to` 默认 device（走节点通道下发）。
AmooEnvelope envelope({
  String protoV = '1.0',
  String sessionId = 'sess-1',
  String msgId = 'm-1',
  int seq = 1,
  String from = 'cloud',
  String to = 'device',
  AmooKind kind = AmooKind.cmd,
  Map<String, dynamic> payload = const <String, dynamic>{
    'tool': 'ping',
    'args': <String, dynamic>{},
  },
  String traceId = 'trace-1',
  int depth = 0,
  String idempotencyKey = 'k1',
}) =>
    AmooEnvelope(
      protoV: protoV,
      sessionId: sessionId,
      msgId: msgId,
      seq: seq,
      from: from,
      to: to,
      kind: kind,
      payload: payload,
      traceId: traceId,
      depth: depth,
      idempotencyKey: idempotencyKey,
    );

/// 一笔设备→云端的结果回写信封。payload 带 K-24 三个字段（contract §3.1）。
AmooEnvelope resultEnvelope({String from = 'device', String key = 'k1'}) =>
    envelope(
      from: from,
      to: 'cloud',
      kind: AmooKind.result,
      payload: <String, dynamic>{
        'ok': true,
        'output': const <String, dynamic>{'pong': true},
        'action_dispatched': true,
        'replay_safe': true,
        'retry_safe': true,
      },
      idempotencyKey: key,
    );

/// 调用链护栏那一侧的信封，用于「唯一信封」的词汇比对。
CallEnvelope callEnvelope() => const CallEnvelope(
      protoV: '1.0',
      sessionId: 'sess-1',
      msgId: 'm-1',
      seq: 1,
      from: 'cloud',
      to: 'device',
      kind: CallKind.instruction,
      payload: <String, dynamic>{
        'tool': 'ping',
        'args': <String, dynamic>{},
      },
      traceId: 'trace-1',
      depth: 0,
      idempotencyKey: 'k1',
    );

/// 「像幂等标记」的键名特征。三个既有字段都在这个特征里，另造的第四个也会被
/// 它抓到——禁另造标记（TASK.md §10）靠这条正则才有执行面。
final RegExp _kIdempotencyish =
    RegExp(r'idempot|dedupe|replay|retry|dispatch|attempt|nonce');

/// 递归收出 JSON 里所有像幂等标记的键名。
///
/// 为什么递归：三个字段在 kind=结果 的信封里位于 payload 内层（contract §3.1），
/// 只扫顶层会漏掉内层另造的标记。
Set<String> idempotencyishKeys(Object? node) {
  final out = <String>{};
  void walk(Object? v) {
    if (v is Map) {
      for (final e in v.entries) {
        if (e.key is String && _kIdempotencyish.hasMatch(e.key as String)) {
          out.add(e.key as String);
        }
        walk(e.value);
      }
    } else if (v is List) {
      for (final e in v) {
        walk(e);
      }
    }
  }

  walk(node);
  return out;
}
