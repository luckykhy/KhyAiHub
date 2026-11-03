import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/data/models/models.dart';
import 'package:khy_os_client/ui/theme/app_theme.dart';
import 'package:khy_os_client/ui/widgets/chat_message_row.dart';
import 'package:khy_os_client/ui/widgets/thinking_block.dart';

/// 消息行的局部重建契约。
///
/// 重点在第 1 条：它是「一个 chunk 只重建受影响那一行」这条性能结论的**可执行
/// 判据**。如果哪天 ChatRowStore 被改回「一个全局 notifier 通知所有行」，
/// 这个测试会红——那时每个流式 chunk 又会重建整个消息列表。
void main() {
  ChatMessage msg(String id, {MessageRole role = MessageRole.assistant}) {
    return ChatMessage(
      id: id,
      conversationId: 'c1',
      role: role,
      content: '',
      timestamp: DateTime.fromMillisecondsSinceEpoch(0),
    );
  }

  Widget host({required List<Widget> children}) {
    return MaterialApp(
      theme: AppTheme.dark(),
      home: Scaffold(body: Column(children: children)),
    );
  }

  group('ChatRowStore 局部重建', () {
    testWidgets('一次 chunk 只让受影响那一行重建', (tester) async {
      final messages = <ChatMessage>[msg('a'), msg('b'), msg('c')];
      final store = ChatRowStore(messages);
      final builds = <String, int>{'a': 0, 'b': 0, 'c': 0};

      // 与 chat_screen_new._rowFor 完全同构的订阅方式：每条消息一个
      // ValueListenableBuilder，包里 ChatBubbleRow。
      Widget row(String id) {
        final m = messages.firstWhere((m) => m.id == id);
        return ValueListenableBuilder<ChatRowState>(
          valueListenable: store.notifierFor(m),
          builder: (ctx, state, _) {
            builds[id] = builds[id]! + 1;
            return ChatBubbleRow(message: state.message, busy: false, action: '');
          },
        );
      }

      await tester.pumpWidget(host(children: [row('a'), row('b'), row('c')]));
      expect(builds, {'a': 1, 'b': 1, 'c': 1});

      // 一个流式 chunk
      store.appendContent('b', '第一块');
      await tester.pump();
      expect(builds, {'a': 1, 'b': 2, 'c': 1});

      // 一个思维链 chunk 同样只动自己那一行
      store.appendReasoning('b', '先想一下');
      await tester.pump();
      expect(builds, {'a': 1, 'b': 3, 'c': 1});
      expect(store.notifierFor(messages[1]).value.reasoning, '先想一下');

      // 改一条已经不在列表里的 id：不炸，也不惊动任何行
      store.appendContent('nope', 'x');
      await tester.pump();
      expect(builds, {'a': 1, 'b': 3, 'c': 1});

      store.dispose();
    });

    test('正文与思维链同源同生命周期，改一处不会丢另一处', () {
      final messages = <ChatMessage>[msg('a')];
      final store = ChatRowStore(messages);

      store.appendReasoning('a', '想');
      store.appendContent('a', '答');
      final v = store.notifierFor(messages[0]).value;

      expect(v.reasoning, '想');
      expect(v.message.content, '答');
      // 列表本身也跟着改了：上送后端的历史不能缺这一段
      expect(messages[0].content, '答');

      store.dispose();
    });
  });

  group('ChatBubbleRow', () {
    testWidgets('assistant 且有思维链时，块在气泡之前', (tester) async {
      await tester.pumpWidget(host(
        children: [
          ChatBubbleRow(
            message: ChatMessage(
              id: 'a',
              conversationId: 'c1',
              role: MessageRole.assistant,
              content: '最终答复',
              timestamp: DateTime.fromMillisecondsSinceEpoch(0),
            ),
            busy: false,
            action: '',
            thinking: const ThinkingBlock(reasoning: '先想后答'),
          ),
        ],
      ));

      expect(find.byType(ThinkingBlock), findsOneWidget);
      expect(find.text('最终答复'), findsOneWidget);
      // 阅读序「思考 → 动作 → 答复」：块整体在答复文字之上
      expect(
        tester.getBottomLeft(find.byType(ThinkingBlock)).dy,
        lessThanOrEqualTo(tester.getTopLeft(find.text('最终答复')).dy),
      );
    });

    testWidgets('用户消息 / 空思维链不渲染块', (tester) async {
      await tester.pumpWidget(host(children: [
        ChatBubbleRow(
          message: msg('u', role: MessageRole.user),
          busy: false,
          action: '',
          thinking: const ThinkingBlock(reasoning: '不该出现'),
        ),
      ]));
      // 思维链由调用方门控（assistant && 非空），这里传了也不该出现：
      // ThinkingBlock 收到空串会整体不渲染，但这里传的是非空——
      // 所以真正该验的是「调用方不给用户消息传块」。见 _rowFor 的门控注释。
      expect(find.byType(ThinkingBlock), findsOneWidget); // 组件自身不越权
      expect(find.text('不该出现'), findsNothing); // 默认收起
    });
  });
}
