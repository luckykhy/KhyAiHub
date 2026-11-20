import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/render/envelope_render.dart';
import 'package:khy_os_client/ui/render/envelope_reply_view.dart';
import 'package:khy_os_client/ui/widgets/thinking_block.dart';

/// A 阶段判定 T2/T3/T5 的 widget 层红绿（逻辑层见 envelope_render_test.dart）。
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

EnvelopeTurn _turnFrom(String envelopeText, {String localId = 'a1'}) {
  final buf = EnvelopeReplyBuffer();
  final reply = StructuredReply.tryParseText(envelopeText)!;
  final turn = buf.finalize(localId: localId, reply: reply);
  expect(turn, isNotNull, reason: '测试用信封必须可解析：$envelopeText');
  return turn!;
}

Future<void> _pump(WidgetTester tester, Widget child) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(child: child),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  group('T2 九类块按数组顺序渲染（无重排）', () {
    late EnvelopeTurn turn;
    setUp(() {
      turn = _turnFrom(_envelope(payload: <String, dynamic>{
        'blocks': <Object?>[
          <String, dynamic>{'type': 'text', 'text': 'MARK文本块'},
          <String, dynamic>{'type': 'reasoning', 'text': 'MARK思维链内容'},
          <String, dynamic>{'type': 'tool_call', 'callId': 'c1', 'name': 'exec_shell', 'args': <String, dynamic>{'cmd': 'ls'}},
          <String, dynamic>{'type': 'tool_result', 'callId': 'c1', 'ok': true, 'summary': 'MARK工具结果'},
          <String, dynamic>{'type': 'code', 'language': 'dart', 'code': 'MARK代码块'},
          <String, dynamic>{'type': 'image', 'path': 'MARK图路径.png'},
          <String, dynamic>{'type': 'file', 'path': 'MARK文件路径.log', 'size': 3},
          <String, dynamic>{'type': 'table', 'headers': <String>['MARK表头'], 'rows': <Object?>[<String>['单元格']]},
          <String, dynamic>{'type': 'status', 'code': 'waiting', 'detail': 'MARK状态', 'attempt': 2},
        ],
      }));
    });

    testWidgets('九类块都在场上，内容一个不丢', (tester) async {
      await _pump(tester, EnvelopeReplyView(turn: turn));
      expect(find.textContaining('MARK文本块'), findsOneWidget);
      expect(find.byType(ThinkingBlock), findsOneWidget, reason: 'reasoning 块复用 ThinkingBlock');
      expect(find.textContaining('exec_shell'), findsOneWidget);
      expect(find.textContaining('MARK工具结果'), findsOneWidget);
      expect(find.textContaining('MARK代码块'), findsOneWidget);
      expect(find.textContaining('MARK图路径.png'), findsOneWidget);
      expect(find.textContaining('MARK文件路径.log'), findsOneWidget);
      expect(find.textContaining('MARK表头'), findsOneWidget);
      expect(find.textContaining('MARK状态'), findsOneWidget, reason: 'status 块按 RUNTIME-002 组装状态行');
    });

    testWidgets('纵向顺序与数组顺序一致（无重排）', (tester) async {
      await _pump(tester, EnvelopeReplyView(turn: turn));
      final dy = <double>[];
      void collect(Finder f) {
        expect(f, findsOneWidget, reason: '每类块只渲染一次');
        dy.add(tester.getRect(f).center.dy);
      }

      collect(find.textContaining('MARK文本块'));
      collect(find.byType(ThinkingBlock));
      collect(find.textContaining('exec_shell'));
      collect(find.textContaining('MARK工具结果'));
      collect(find.textContaining('MARK代码块'));
      collect(find.textContaining('MARK图路径.png'));
      collect(find.textContaining('MARK文件路径.log'));
      collect(find.textContaining('MARK表头'));
      collect(find.textContaining('MARK状态'));

      for (var i = 1; i < dy.length; i++) {
        expect(dy[i], greaterThan(dy[i - 1]),
            reason: '第 $i 个块必须画在第 ${i - 1} 个块之下（数组原序，无重排）');
      }
    });
  });

  group('T3 未知降级：未知块与未知 proto_v', () {
    testWidgets('未知块折叠标注，内容保留、不崩', (tester) async {
      final turn = _turnFrom(_envelope(payload: <String, dynamic>{
        'blocks': <Object?>[
          <String, dynamic>{'type': 'text', 'text': '前文保留'},
          <String, dynamic>{'type': 'future_block', 'x': 1},
        ],
      }));
      await _pump(tester, EnvelopeReplyView(turn: turn));
      expect(find.textContaining('未知块类型'), findsOneWidget,
          reason: '未知块必须有折叠标注');
      // 展开后原文可见：内容不丢。
      await tester.tap(find.textContaining('未知块类型'));
      await tester.pumpAndSettle();
      expect(find.textContaining('future_block'), findsOneWidget,
          reason: '折叠内容展开后可见（不丢内容）');
      expect(find.textContaining('前文保留'), findsOneWidget);
    });

    testWidgets('未知 proto_v：版本不匹配角标在场上，内容照常渲染', (tester) async {
      final turn = _turnFrom(_envelope(
        payload: <String, dynamic>{
          'blocks': <Object?>[
            <String, dynamic>{'type': 'text', 'text': 'MARK版本不匹配正文'},
          ],
        },
        protoV: '9.9',
      ));
      await _pump(tester, EnvelopeReplyView(turn: turn));
      expect(find.textContaining('协议版本不匹配'), findsOneWidget,
          reason: '未知 proto_v 必须提示版本不匹配');
      expect(find.textContaining('MARK版本不匹配正文'), findsOneWidget,
          reason: '按最低兼容版本渲染：内容不丢');
    });

    testWidgets('L3 纯文本：structured=false 角标在场上', (tester) async {
      final turn = _turnFrom(_envelope(payload: <String, dynamic>{
        'content': '# 普通markdown\n\n一段正文。',
      }));
      await _pump(tester, EnvelopeReplyView(turn: turn));
      expect(find.textContaining('structured=false'), findsOneWidget);
      expect(find.textContaining('一段正文。'), findsOneWidget);
    });
  });

  group('T5 流式中断的现场', () {
    testWidgets('failed 状态行 + 已收块保留，全场不出现「成功」', (tester) async {
      final buf = EnvelopeReplyBuffer();
      buf.absorbBlocks(
        msgId: 'm-fail',
        rawBlocks: <Object?>[
          <String, dynamic>{'type': 'text', 'text': 'MARK已收块一'},
        ],
        localId: 'a1',
      );
      buf.absorbBlocks(
        msgId: 'm-fail',
        rawBlocks: <Object?>[
          <String, dynamic>{'type': 'code', 'language': 'dart', 'code': 'MARK已收块二'},
        ],
      );
      buf.failByLocalId('a1', '连接中断');
      final turn = buf.turns.single;

      await _pump(tester, EnvelopeReplyView(turn: turn));
      expect(find.textContaining('失败'), findsWidgets, reason: 'failed 必须可见');
      expect(find.textContaining('MARK已收块一'), findsOneWidget, reason: '已收块保留');
      expect(find.textContaining('MARK已收块二'), findsOneWidget, reason: '已收块保留');
      expect(find.textContaining('成功'), findsNothing,
          reason: 'T5：中断现场不得出现「成功」');
    });

    testWidgets('请求未返回：只显示状态，无伪造正文', (tester) async {
      final buf = EnvelopeReplyBuffer();
      buf.absorbBlocks(
        msgId: 'm-wait',
        rawBlocks: <Object?>[],
        localId: 'a2',
      );
      final turn = buf.turns.single;
      await _pump(tester, EnvelopeReplyView(turn: turn));
      expect(find.byType(SelectableText), findsNothing,
          reason: '未返回时不渲染任何正文');
      expect(turn.statusLine, isNotEmpty, reason: '只显示状态行');
    });
  });
}
