import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/trajectory/call_chain.dart';
import 'package:khy_os_client/ui/render/envelope_render.dart';

/// A 阶段判定 T2–T5 的逻辑层红绿（渲染 widget 层见 envelope_reply_view_test.dart）。
///
/// 信封形状判定复用 CallEnvelope.parse（12 字段闭集，字段名与
/// android/.../bridge/CallChain.java 逐字一致）；本组测试钉的是渲染侧的
/// 三档顺序、未知降级、msg_id 去重与流式中断保块。
String _envelope({
  required Object? payload,
  String protoV = '1.0',
  String msgId = 'm1',
}) {
  return jsonEncode(<String, dynamic>{
    'proto_v': protoV,
    'session_id': 'session-1',
    'msg_id': msgId,
    'seq': 1,
    'from': 'pc',
    'to': 'device',
    'kind': '结果',
    'payload': payload,
    'trace_id': 'trace-1',
    'parent_span': null,
    'depth': 0,
    'idempotency_key': 'idem-1',
  });
}

void main() {
  group('StructuredReply 信封解析（字段名对齐 CallChain.java）', () {
    test('12 字段全解析：名字逐字一致，不许别名', () {
      final reply = StructuredReply.tryParseText(_envelope(
        payload: <String, dynamic>{'blocks': <Object?>[]},
      ));
      expect(reply, isNotNull);
      final env = reply!.env.toJson();
      // 字段闭集与 CallChain.java FIELDS 逐字一致（12 个，无第二个名字）。
      expect(env.keys.toSet(), <String>{
        'proto_v', 'session_id', 'msg_id', 'seq', 'from', 'to', 'kind',
        'payload', 'trace_id', 'parent_span', 'depth', 'idempotency_key',
      });
      expect(reply.msgId, 'm1');
      expect(reply.env.traceId, 'trace-1');
      expect(reply.env.parentSpan, isNull);
      expect(reply.env.idempotencyKey, 'idem-1');
      expect(reply.env.depth, 0);
      expect(reply.env.kind, CallKind.result);
    });

    test('不是信封形状的文本返回 null（走旧渲染路径）', () {
      expect(StructuredReply.tryParseText('普通 markdown 文本'), isNull);
      expect(StructuredReply.tryParseText('{"not":"envelope"}'), isNull);
      expect(StructuredReply.tryParseText('[1,2,3]'), isNull);
      expect(StructuredReply.tryParseText('半截{"proto_v"'), isNull);
    });

    test('字段闭集：多一个字段即 null（K-20 同一把尺子）', () {
      final bad = jsonDecode(_envelope(payload: <String, dynamic>{'content': 'x'}))
          as Map<String, dynamic>;
      bad['extra'] = 'nope';
      expect(StructuredReply.tryParse(bad), isNull);
    });
  });

  group('T2 三档顺序固定、命中即停（L1 blocks → L2 fenced → L3 plain）', () {
    test('L1：payload.blocks 是数组即命中，九类块按数组顺序解析、无重排', () {
      final payload = <String, dynamic>{
        'blocks': <Object?>[
          <String, dynamic>{'type': 'text', 'text': '第一段'},
          <String, dynamic>{'type': 'reasoning', 'text': '先想一想'},
          <String, dynamic>{'type': 'tool_call', 'callId': 'c1', 'name': 'exec_shell', 'args': <String, dynamic>{'cmd': 'ls'}},
          <String, dynamic>{'type': 'tool_result', 'callId': 'c1', 'ok': true, 'summary': '2 个文件'},
          <String, dynamic>{'type': 'code', 'language': 'dart', 'code': 'main(){}'},
          <String, dynamic>{'type': 'image', 'path': '/sdcard/a.png'},
          <String, dynamic>{'type': 'file', 'path': '/sdcard/a.log', 'size': 3},
          <String, dynamic>{'type': 'table', 'headers': <String>['列A', '列B'], 'rows': <Object?>[<String>['1', '2']]},
          <String, dynamic>{'type': 'status', 'code': 'waiting', 'detail': '等第 2 次轮询', 'attempt': 2},
        ],
      };
      final reply = StructuredReply.tryParseText(_envelope(payload: payload))!;
      final plan = reply.plan();
      expect(plan.tier, EnvelopeTier.l1Blocks, reason: 'blocks 在场必须命中 L1（顺序第一档）');
      expect(plan.structured, true);
      final types = plan.blocks.map((b) => b.runtimeType.toString()).toList();
      expect(types, <String>[
        'ReplyTextBlock',
        'ReplyReasoningBlock',
        'ReplyToolCallBlock',
        'ReplyToolResultBlock',
        'ReplyCodeBlock',
        'ReplyImageBlock',
        'ReplyFileBlock',
        'ReplyTableBlock',
        'ReplyStatusBlock',
      ], reason: '九类块按数组原序，无重排');
    });

    test('命中即停：payload 同时有 blocks 与 fenced content，L1 赢', () {
      final payload = <String, dynamic>{
        'blocks': <Object?>[<String, dynamic>{'type': 'text', 'text': '结构块'}],
        'content': '```json\n{"content":"围栏正文"}\n```',
      };
      final plan = StructuredReply.tryParseText(_envelope(payload: payload))!.plan();
      expect(plan.tier, EnvelopeTier.l1Blocks);
    });

    test('L2：无 blocks 但 content 带 ```json 围栏 → 取围栏里的 content', () {
      const content = '前言\n```json\n{"content":"被取出的正文"}\n```\n后记';
      final plan = StructuredReply.tryParseText(
              _envelope(payload: <String, dynamic>{'content': content}))!
          .plan();
      expect(plan.tier, EnvelopeTier.l2Fenced);
      expect(plan.text, '被取出的正文', reason: 'fenced json 取 content，前后记不进正文');
    });

    test('L3：无 blocks、无合法围栏 → markdown 原文 + structured=false', () {
      const content = '# 标题\n\n- 列表项\n\n```dart\nvoid main() {}\n```';
      final plan = StructuredReply.tryParseText(
              _envelope(payload: <String, dynamic>{'content': content}))!
          .plan();
      expect(plan.tier, EnvelopeTier.l3Plain);
      expect(plan.structured, false, reason: 'L3 必须标 structured=false');
      expect(plan.text, content, reason: '不改写：原文渲染');
    });

    test('围栏里没有 content 字段不算 L2 命中，继续走 L3', () {
      const content = '```json\n{"other":"x"}\n```';
      final plan = StructuredReply.tryParseText(
              _envelope(payload: <String, dynamic>{'content': content}))!
          .plan();
      expect(plan.tier, EnvelopeTier.l3Plain);
    });
  });

  group('T3 未知降级：未知块类型与未知 proto_v', () {
    test('未知块类型 → 降级纯文本块，原文 JSON 保留', () {
      final payload = <String, dynamic>{
        'blocks': <Object?>[
          <String, dynamic>{'type': 'text', 'text': '保留我'},
          <String, dynamic>{'type': 'future_block', 'x': 1},
          <String, dynamic>{'type': 'status', 'code': 'failed', 'detail': '工具不可用', 'attempt': 1},
        ],
      };
      final plan = StructuredReply.tryParseText(_envelope(payload: payload))!.plan();
      expect(plan.tier, EnvelopeTier.l1Blocks, reason: '未知块只降级自己，不把整份拖回 L3');
      final unknown = plan.blocks[1];
      expect(unknown, isA<ReplyUnknownBlock>());
      expect((unknown as ReplyUnknownBlock).raw, contains('future_block'),
          reason: '不丢内容：原文块 JSON 全量保留');
      expect(plan.blocks[0], isA<ReplyTextBlock>(), reason: '已知块照常');
      expect(plan.blocks[2], isA<ReplyStatusBlock>(), reason: '未知块后面的已知块不受影响');
    });

    test('形状不合法的已知类型也按未知降级，内容保留', () {
      final payload = <String, dynamic>{
        'blocks': <Object?>[
          <String, dynamic>{'type': 'table', 'headers': '不是数组'},
        ],
      };
      final plan = StructuredReply.tryParseText(_envelope(payload: payload))!.plan();
      expect(plan.blocks.single, isA<ReplyUnknownBlock>());
    });

    test('未知 proto_v：解析不拒，protoVSupported=false，blocks 照常渲染', () {
      final payload = <String, dynamic>{
        'blocks': <Object?>[<String, dynamic>{'type': 'text', 'text': '照常渲染'}],
      };
      final reply = StructuredReply.tryParseText(_envelope(payload: payload, protoV: '9.9'))!;
      expect(reply.protoV, '9.9');
      expect(reply.protoVSupported, false, reason: '渲染路径只标记不拒收：护栏路径的 proto_v_unsupported 不归渲染管');
      final plan = reply.plan();
      expect(plan.tier, EnvelopeTier.l1Blocks);
      expect(plan.blocks.single, isA<ReplyTextBlock>(), reason: '按最低兼容版本渲染：内容不因版本未知而丢');
    });
  });

  group('T4 同一 msg_id 只渲染一次', () {
    test('连发三次 finalize：只有第一次产出 turn，后两次 null', () {
      final buf = EnvelopeReplyBuffer();
      StructuredReply makeReply() => StructuredReply.tryParseText(_envelope(
            payload: <String, dynamic>{
              'blocks': <Object?>[<String, dynamic>{'type': 'text', 'text': '首次结果'}],
            },
            msgId: 'm-dup',
          ))!;
      final first = buf.finalize(localId: 'a1', reply: makeReply());
      expect(first, isNotNull);
      expect(buf.finalize(localId: 'a2', reply: makeReply()), isNull,
          reason: '第二次投递不得产生第二个气泡');
      expect(buf.finalize(localId: 'a3', reply: makeReply()), isNull,
          reason: '第三次投递同样 null');
      expect(buf.claimRender('m-dup'), false, reason: 'claim 之后永远不再 first-sight');
      expect(buf.turns.length, 1, reason: '缓冲里只有一个 turn');
    });

    test('不同 msg_id 各自独立', () {
      final buf = EnvelopeReplyBuffer();
      StructuredReply makeReply(String id) => StructuredReply.tryParseText(
          _envelope(payload: <String, dynamic>{'content': 'x'}, msgId: id))!;
      expect(buf.finalize(localId: 'a1', reply: makeReply('m-1')), isNotNull);
      expect(buf.finalize(localId: 'a2', reply: makeReply('m-2')), isNotNull);
      expect(buf.turns.length, 2);
    });
  });

  group('T5 流式中断：failed + 保留已收块，失败行不出现「成功」', () {
    test('两批块已收，流断：turn=failed、块保留、状态行无「成功」', () {
      final buf = EnvelopeReplyBuffer();
      final t = buf.absorbBlocks(
        msgId: 'm-stream',
        rawBlocks: <Object?>[
          <String, dynamic>{'type': 'text', 'text': '已收第 1 块'},
        ],
        localId: 'a1',
      );
      expect(t, isNotNull);
      buf.absorbBlocks(
        msgId: 'm-stream',
        rawBlocks: <Object?>[
          <String, dynamic>{'type': 'code', 'language': 'dart', 'code': 'x()'},
        ],
      );
      expect(buf.failByLocalId('a1', '连接中断'), true);
      final turn = buf.turns.single;
      expect(turn.state, TurnState.failed);
      expect(turn.blocks.length, 2, reason: '已收块必须保留');
      expect(turn.blocks[0], isA<ReplyTextBlock>());
      expect(turn.blocks[1], isA<ReplyCodeBlock>());
      expect(turn.statusLine, contains('失败'));
      expect(turn.statusLine, isNot(contains('成功')),
          reason: '失败路径的日志/状态行不得出现「成功」');
    });

    test('重复投递已定案 msg_id 的流式块：忽略不追加', () {
      final buf = EnvelopeReplyBuffer();
      StructuredReply reply() => StructuredReply.tryParseText(_envelope(
            payload: <String, dynamic>{'content': '定案正文'},
            msgId: 'm-closed',
          ))!;
      buf.finalize(localId: 'a1', reply: reply());
      final again = buf.absorbBlocks(
        msgId: 'm-closed',
        rawBlocks: <Object?>[<String, dynamic>{'type': 'text', 'text': '迟到的块'}],
      );
      expect(again, isNull, reason: '已渲染的 msg_id 不再收块（同一 msg_id 只渲染一次）');
    });
  });
}
