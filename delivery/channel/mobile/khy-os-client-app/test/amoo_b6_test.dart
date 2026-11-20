import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/trajectory/call_chain.dart';

/// B6 调用链护栏的单元级判定（任务书 §4 B6、contract §6）。
///
/// 为什么判据钉在 Dart 侧而不是只在设备上：depth 上限、错误码、预算停点是**数值契约**，
/// 设备上要靠 31 次信箱往返才看得到一次，改一个数字就要重跑一遍；Dart 侧同一组数值跑一次
/// 就够，设备侧只负责证明「桥真的按这组数值办事」（device/B6.md）。
///
/// 判据（三条，缺一即红）：
///   1. A→B→A 第 3 层被拒，错误码 `recursion_depth_exceeded`（K-51）；
///   2. 调用次数有上限并停止，超限码 `session_budget_exceeded` 且报已用量（K-52）；
///   3. 两端 trace_id 一致、span 链可复原（K-50）。
///
/// 本文件对当前代码是红的，且红的原因只有一个：`lib/core/trajectory/call_chain.dart`
/// 尚不存在（2026-11-13 实读，`lib/core/trajectory/` 只有 trace_chain.dart 与
/// trace_envelope.dart），import 即编译失败。首败原始输出按 EVID 约定落
/// `checks/b6_red.txt`。
///
/// 回炉记录（2026-11-13，判定回炉·B6）：原文件有两处让「红」指错地方的问题，已修——
///   1. 测试名里一个字面 `$` 没转义（Dart 字符串里 `$` 必须后跟标识符或 `${}`），
///      文件自身编译不过：模块实现对了这道门也照样红，是门自己的伤不是代码的伤；
///   2. seq 断言与 contract K-20「跳号/回退/同秒冲突即拒」相反（原断言放行跳号），
///      按合同实现的代码会被这道门误杀。改写后每处取值都在注释里注明出处。

/// 取一个信封被判拒时的错误码；没被拒返回 null。
String? rejectCode(Object? json) {
  try {
    CallEnvelope.parse(json);
    return null;
  } on CallRejected catch (e) {
    return e.code;
  }
}

Map<String, dynamic> envelope({
  String protoV = kProtoV,
  String sessionId = 's-b6',
  String msgId = 'm1',
  int seq = 1,
  String from = 'amoo',
  String to = 'khy',
  String kind = '指令',
  Map<String, dynamic> payload = const <String, dynamic>{'tool': 'ping', 'args': <String, dynamic>{}},
  String traceId = 'T-b6',
  String? parentSpan,
  int depth = 0,
  String idempotencyKey = 'k1',
}) {
  return <String, dynamic>{
    'proto_v': protoV,
    'session_id': sessionId,
    'msg_id': msgId,
    'seq': seq,
    'from': from,
    'to': to,
    'kind': kind,
    'payload': payload,
    'trace_id': traceId,
    'parent_span': parentSpan,
    'depth': depth,
    'idempotency_key': idempotencyKey,
  };
}

void main() {
  group('B6 信封闭集与 trace 三字段（contract K-20）', () {
    test('12 个字段齐全时往返一致，parent_span 可空', () {
      final env = CallEnvelope.parse(envelope());
      expect(env.traceId, 'T-b6');
      expect(env.depth, 0);
      expect(env.parentSpan, isNull);
      expect(env.kind, CallKind.instruction);
      expect(env.toJson()['trace_id'], 'T-b6');
      expect(env.toJson()['depth'], 0);
      expect(CallEnvelope.parse(env.toJson()).toJson(), env.toJson());
    });

    test('parent_span 缺席与显式 null 都合法（可选字段，根消息为空）', () {
      expect(CallEnvelope.parse(envelope(parentSpan: null)).parentSpan, isNull);
      final explicit = envelope()..['parent_span'] = null;
      expect(CallEnvelope.parse(explicit).parentSpan, isNull);
    });

    test('kind 五选一，越界拒', () {
      // kind=结果 的 payload 含三个幂等字段（contract §3.1 payload 行 + K-24）。
      expect(
        CallEnvelope.parse(envelope(
          kind: '结果',
          payload: <String, dynamic>{
            'action_dispatched': true,
            'replay_safe': false,
            'retry_safe': false,
          },
        )).kind,
        CallKind.result,
      );
      for (final bad in <String>['指令x', 'command', '']) {
        expect(rejectCode(envelope(kind: bad)), 'invalid_arguments');
      }
    });

    test('缺 trace_id / depth 形状错 / 未定义字段都判 invalid_arguments', () {
      final noTrace = envelope()..remove('trace_id');
      expect(rejectCode(noTrace), 'invalid_arguments');

      final depthAsString = envelope()..['depth'] = '2';
      expect(rejectCode(depthAsString), 'invalid_arguments');

      final depthMissing = envelope()..remove('depth');
      expect(rejectCode(depthMissing), 'invalid_arguments');

      final negativeDepth = envelope()..['depth'] = -1;
      expect(rejectCode(negativeDepth), 'invalid_arguments');

      final extraField = envelope()..['foo'] = 1;
      expect(rejectCode(extraField), 'invalid_arguments');

      final notAMap = <Object?>['not', 'a', 'map'];
      expect(rejectCode(notAMap), 'invalid_arguments');
    });

    test('session_id 形状 ^[a-zA-Z0-9_-]{1,64}\$，越界拒', () {
      expect(CallEnvelope.parse(envelope(sessionId: 'a' * 64)).sessionId.length, 64);
      expect(rejectCode(envelope(sessionId: 'a' * 65)), 'invalid_arguments');
      expect(rejectCode(envelope(sessionId: 'a b')), 'invalid_arguments');
      expect(rejectCode(envelope(sessionId: '')), 'invalid_arguments');
    });

    test('proto_v 不在支持集合内判 proto_v_unsupported', () {
      expect(rejectCode(envelope(protoV: '9.9')), 'proto_v_unsupported');
      expect(kSupportedProtoV, contains(kProtoV));
    });

    test('kind=指令 时 payload 闭集 {tool,args}', () {
      expect(
        rejectCode(envelope(payload: <String, dynamic>{'tool': 'ping', 'args': <String, dynamic>{}, 'extra': 1})),
        'invalid_arguments',
      );
      expect(
        rejectCode(envelope(payload: <String, dynamic>{'args': <String, dynamic>{}})),
        'invalid_arguments',
      );
    });
  });

  group('B6 depth 上限（contract K-51，判据 1）', () {
    test('上限值就是 2', () {
      expect(kMaxDepth, 2);
    });

    test('depth 0/1 放行，depth 2 与 depth 5 拒且码正确', () {
      final guard = CallGuard();
      expect(guard.admit(CallEnvelope.parse(envelope(msgId: 'm1', seq: 1, depth: 0))).admitted, isTrue);
      expect(guard.admit(CallEnvelope.parse(envelope(msgId: 'm2', seq: 2, depth: 1))).admitted, isTrue);
      // 两个被拒跳各起一个新 guard 且 seq 取 1：depth 是唯一拒因，错误码才指得准，
      // 不靠「检查顺序恰好先看 depth」这种没写进合同的运气。
      for (final depth in <int>[2, 5]) {
        final verdict = CallGuard().admit(
          CallEnvelope.parse(envelope(msgId: 'd$depth', seq: 1, depth: depth)),
        );
        expect(verdict.admitted, isFalse, reason: 'depth=$depth 必须被拒');
        expect(verdict.code, 'recursion_depth_exceeded');
      }
    });

    test('被拒回执带错误三件套，三幂等字段恒 false（contract K-22/K-24）', () {
      final verdict = CallGuard().admit(CallEnvelope.parse(envelope(depth: 2)));
      final receipt = verdict.receipt();
      expect(receipt['ok'], false);
      expect(receipt['code'], 'recursion_depth_exceeded');
      expect(receipt['error'], isNotEmpty);
      expect(receipt['fix'], isNotEmpty);
      expect(receipt['guide_topic'], isNotEmpty);
      expect(receipt['action_dispatched'], false);
      expect(receipt['replay_safe'], false);
      expect(receipt['retry_safe'], false);
    });
  });

  group('B6 调用预算熔断（contract K-52，判据 2）', () {
    test('同一条 trace 第 31 次起拒并报已用量，之后不再放行', () {
      final guard = CallGuard();
      for (var i = 1; i <= kMaxCallsPerTrace; i++) {
        final verdict = guard.admit(
          CallEnvelope.parse(envelope(msgId: 'c$i', seq: i, traceId: 'T-budget')),
        );
        expect(verdict.admitted, isTrue, reason: '第 $i 次应放行');
      }
      expect(guard.usedCalls('T-budget'), kMaxCallsPerTrace);

      final over = guard.admit(
        CallEnvelope.parse(envelope(msgId: 'c31', seq: 31, traceId: 'T-budget')),
      );
      expect(over.admitted, isFalse);
      expect(over.code, 'session_budget_exceeded');
      expect(over.receipt()['used'], kMaxCallsPerTrace);
      expect(over.receipt()['limit'], kMaxCallsPerTrace);

      // 之后不再放行。seq 仍取 31（被拒的消息不进「已确认」基线，K-20），
      // 且这一跳要的码是预算码而非序号码：超预算的 trace 再发也报预算，
      // 不让调用方误以为只是序号错（device/B6.md B6-4 补推 b6c32 的预期同理）。
      final again = guard.admit(
        CallEnvelope.parse(envelope(msgId: 'c31b', seq: 31, traceId: 'T-budget')),
      );
      expect(again.admitted, isFalse);
      expect(again.code, 'session_budget_exceeded');
      expect(guard.usedCalls('T-budget'), kMaxCallsPerTrace);
    });

    test('预算按 trace 独立计数，换一条 trace 从零开始', () {
      final guard = CallGuard();
      for (var i = 1; i <= kMaxCallsPerTrace; i++) {
        guard.admit(CallEnvelope.parse(envelope(msgId: 'a$i', seq: i, traceId: 'T-a')));
      }
      // seq 的基线按 (session, 方向) 算、不按 trace 算（K-20）：同一会话同一方向
      // 已经走到 30，换 trace 的下一条也得是 31，否则它该被 seq 拒而不是被预算放行。
      final other = guard.admit(
        CallEnvelope.parse(envelope(msgId: 'b1', seq: 31, traceId: 'T-b')),
      );
      expect(other.admitted, isTrue);
      expect(guard.usedCalls('T-b'), 1);
      expect(guard.usedCalls('T-a'), kMaxCallsPerTrace);
    });

    test('上限值复用桥侧常量 30（AmooLoop.Options.maxRounds），不新造第二个数值', () {
      expect(kMaxCallsPerTrace, 30);
    });
  });

  group('B6 两端 trace_id 与 span 链（contract K-50，判据 3）', () {
    test('A→B→A 三跳：前两跳放行、第三跳拒，两端记到的 trace_id 同一个', () {
      final amoo = CallGuard();
      final khy = CallGuard();

      // seq 按 (session, 方向) 独立计数（K-20）：amoo→khy 走 1、2，khy→amoo 从 1 起。
      final m1 = CallEnvelope.parse(
        envelope(msgId: 'm1', seq: 1, from: 'amoo', to: 'khy', traceId: 'T-x', depth: 0),
      );
      final m2 = CallEnvelope.parse(
        envelope(
          msgId: 'm2',
          seq: 1,
          from: 'khy',
          to: 'amoo',
          traceId: 'T-x',
          parentSpan: 'm1',
          depth: 1,
        ),
      );
      final m3 = CallEnvelope.parse(
        envelope(
          msgId: 'm3',
          seq: 2,
          from: 'amoo',
          to: 'khy',
          traceId: 'T-x',
          parentSpan: 'm2',
          depth: 2,
        ),
      );

      expect(khy.admit(m1).admitted, isTrue);
      expect(amoo.admit(m2).admitted, isTrue);
      final third = khy.admit(m3);
      expect(third.admitted, isFalse);
      expect(third.code, 'recursion_depth_exceeded');

      expect(amoo.traceIds(), <String>{'T-x'});
      expect(khy.traceIds(), <String>{'T-x'});
    });

    test('span 链沿 parent_span 反推，根在前', () {
      final m1 = CallEnvelope.parse(envelope(msgId: 'm1', seq: 1, traceId: 'T-x', depth: 0));
      final m2 = CallEnvelope.parse(
        envelope(msgId: 'm2', seq: 2, traceId: 'T-x', parentSpan: 'm1', depth: 1),
      );
      final m3 = CallEnvelope.parse(
        envelope(msgId: 'm3', seq: 3, traceId: 'T-x', parentSpan: 'm2', depth: 2),
      );
      expect(spanChain(<CallEnvelope>[m1, m2, m3]), <String>['m1', 'm2', 'm3']);
    });

    test('span 链断在中途时不猜不补，反推到断点为止', () {
      final m1 = CallEnvelope.parse(envelope(msgId: 'm1', seq: 1, traceId: 'T-x', depth: 0));
      final m3 = CallEnvelope.parse(
        envelope(msgId: 'm3', seq: 3, traceId: 'T-x', parentSpan: 'm2', depth: 2),
      );
      // 尖点取 depth 最大者（并列取列表中靠后的一条）：断链时 m2 不在场，
      // 链从 m3 起、反推到找不到父 span 为止，不拿 m1 冒充上一跳。
      expect(spanChain(<CallEnvelope>[m1, m3]), <String>['m3']);
      expect(spanChain(<CallEnvelope>[]), isEmpty);
    });
  });

  group('B6 拒因可机读', () {
    test('seq 逐次 +1：跳号与回退都判 seq_conflict，每方向独立计数（contract K-20）', () {
      final guard = CallGuard();
      expect(guard.admit(CallEnvelope.parse(envelope(msgId: 's1', seq: 1))).admitted, isTrue);
      expect(guard.admit(CallEnvelope.parse(envelope(msgId: 's2', seq: 2))).admitted, isTrue);

      final jump = guard.admit(CallEnvelope.parse(envelope(msgId: 's3', seq: 4)));
      expect(jump.admitted, isFalse, reason: '跳号必须被拒');
      expect(jump.code, 'seq_conflict');

      final back = guard.admit(CallEnvelope.parse(envelope(msgId: 's4', seq: 1)));
      expect(back.admitted, isFalse, reason: '回退必须被拒');
      expect(back.code, 'seq_conflict');

      // 对端方向有自己的序号基线，互不干扰。
      final otherSide = guard.admit(
        CallEnvelope.parse(envelope(msgId: 's5', seq: 1, from: 'khy', to: 'amoo')),
      );
      expect(otherSide.admitted, isTrue);
    });

    test('三个拒因各带自己的错误码，互不串', () {
      final depthVerdict = CallGuard().admit(CallEnvelope.parse(envelope(depth: 2)));
      expect(depthVerdict.code, 'recursion_depth_exceeded');

      final budgetGuard = CallGuard();
      for (var i = 1; i <= kMaxCallsPerTrace; i++) {
        budgetGuard.admit(CallEnvelope.parse(envelope(msgId: 'z$i', seq: i, traceId: 'T-z')));
      }
      final budgetVerdict = budgetGuard.admit(
        CallEnvelope.parse(envelope(msgId: 'z31', seq: 31, traceId: 'T-z')),
      );
      expect(budgetVerdict.code, 'session_budget_exceeded');

      final seqGuard = CallGuard();
      expect(seqGuard.admit(CallEnvelope.parse(envelope(msgId: 'q1', seq: 1))).admitted, isTrue);
      final seqVerdict = seqGuard.admit(CallEnvelope.parse(envelope(msgId: 'q2', seq: 3)));
      expect(seqVerdict.code, 'seq_conflict');
    });

    test('错误码字符串与 contract K-23 表逐字一致', () {
      expect(kCodeRecursionDepthExceeded, 'recursion_depth_exceeded');
      expect(kCodeSessionBudgetExceeded, 'session_budget_exceeded');
      expect(kCodeInvalidArguments, 'invalid_arguments');
      expect(kCodeSeqConflict, 'seq_conflict');
    });
  });
}
