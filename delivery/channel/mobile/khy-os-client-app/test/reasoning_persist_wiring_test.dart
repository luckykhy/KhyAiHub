import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/conversation_db.dart';
import 'package:khy_os_client/data/models/models.dart' hide Conversation;
import 'package:khy_os_client/ui/theme/app_theme.dart';
import 'package:khy_os_client/ui/widgets/chat_message_row.dart';
import 'package:khy_os_client/ui/widgets/thinking_block.dart';

/// 思维链持久化三处接线的回归测试。
///
/// 背景：存储层早就绪（`ChatMsg.reasoning` 能存能读、缺键不抛），但屏幕层三处
/// 没接，切会话再切回思维链照样消失。三处分别是：
///   1. `ChatRowStore.appendReasoning` / `setReasoning` 曾用恒等 patch
///      `(m) => m`，于是 `messages[i].reasoning` 永远是 null；
///   2. `_saveConversation` 映射成 `ChatMsg` 时不传 `reasoning`；
///   3. `_loadConversation` 构造 `ChatMessage` 时不传 `reasoning`，且先
///      `_rows.clear()` 把思维链存档清空了。
/// 任一处单独修都没用——三处一起才构成「存得下去、读得回来、画得出来」。
///
/// 单一真源约定（下面每组测试都在守它）：`messages[i].reasoning` 是唯一真源，
/// 保存与上送历史读它；`ChatRowStore._reasoningById` 只是它的镜像，供 notifier
/// 首建与 chunk 累加读。两处必须一致，否则就是「UI 显示思维链但存下去是空」
/// 或反之。
///
/// 真存储：这里跑的是真的 `ConversationDB`（FlutterSecureStorage 换成测试
/// 平台），所以走的是 jsonEncode/jsonDecode 这条真实的编解码路径，不是
/// 内存里传对象。
void main() {
  // 思维链与正文刻意用完全不同的字，方便「content 不含思维链」的断言。
  const r1 = '内部推理甲';
  const r2 = '内部推理乙';
  const c1 = '可见正文一';
  const c2 = '可见正文二';

  ChatMessage assistant(String id, DateTime at) => ChatMessage(
        id: id,
        conversationId: 'c1',
        role: MessageRole.assistant,
        content: '',
        timestamp: at,
      );

  /// 与 `chat_screen_new._rowFor` 同构的订阅方式：每条消息一个
  /// ValueListenableBuilder，思维链块在 builder 里构造。
  Widget rowFor(ChatRowStore store, ChatMessage msg, {bool busy = false}) {
    return ValueListenableBuilder<ChatRowState>(
      valueListenable: store.notifierFor(msg),
      builder: (ctx, state, _) {
        final reasoning = state.reasoning;
        final thinking = msg.role == MessageRole.assistant &&
                reasoning.trim().isNotEmpty
            ? ThinkingBlock(reasoning: reasoning, streaming: busy)
            : null;
        return ChatBubbleRow(
          message: state.message,
          thinking: thinking,
          busy: busy,
          action: '',
        );
      },
    );
  }

  Widget host(List<Widget> children) => MaterialApp(
        theme: AppTheme.dark(),
        home: Scaffold(body: Column(children: children)),
      );

  setUp(() {
    // 每个测试一份干净的存储。必须在碰 ConversationDB 之前换平台。
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
  });

  group('断点一：思维链写进消息字段，不只活在 notifier 快照里', () {
    test('appendReasoning 累加进 messages[i].reasoning', () {
      final msgs = <ChatMessage>[assistant('a1', DateTime.utc(2026, 11, 3, 9))];
      final store = ChatRowStore(msgs);

      store.appendReasoning('a1', r1);
      store.appendReasoning('a1', r2);

      // 这一条就是恒等 patch 时代的断言：曾经它恒为 null。
      expect(msgs[0].reasoning, r1 + r2);
      // 快照与消息字段一致（两份状态不允许各说各话）
      expect(store.notifierFor(msgs[0]).value.reasoning, msgs[0].reasoning);

      store.dispose();
    });

    test('setReasoning（本地非流式）同样写消息字段', () {
      final msgs = <ChatMessage>[assistant('a1', DateTime.utc(2026, 11, 3, 9))];
      final store = ChatRowStore(msgs);

      store.setReasoning('a1', '整段思维链');
      expect(msgs[0].reasoning, '整段思维链');

      store.dispose();
    });

    test('正文 chunk 不会把思维链冲掉（copyWith 之后字段还在）', () {
      final msgs = <ChatMessage>[assistant('a1', DateTime.utc(2026, 11, 3, 9))];
      final store = ChatRowStore(msgs);

      // 真实时序：先想后答，两者交错到达
      store.appendReasoning('a1', r1);
      store.appendContent('a1', c1);
      store.appendReasoning('a1', r2);
      store.appendContent('a1', c2);

      expect(msgs[0].reasoning, r1 + r2);
      expect(msgs[0].content, c1 + c2);
      // 硬约束：思维链绝不进正文
      expect(msgs[0].content.contains(r1), isFalse);
      expect(msgs[0].content.contains(r2), isFalse);

      store.dispose();
    });

    test('clear 把思维链镜像一起清——复用同一个 id 也不会带上一段旧思维链', () {
      final msgs = <ChatMessage>[assistant('same', DateTime.utc(2026, 11, 3, 9))];
      final store = ChatRowStore(msgs);
      store.appendReasoning('same', r1);
      expect(msgs[0].reasoning, r1);

      store.clear();
      expect(msgs, isEmpty);

      // 新会话复用同一个 id（id 是毫秒时间戳，撞上的概率不为零）
      final next = assistant('same', DateTime.utc(2026, 11, 3, 10));
      msgs.add(next);
      expect(store.notifierFor(next).value.reasoning, '');

      store.dispose();
    });
  });

  group('断点二 + 断点三：切会话 → 存 → 读回', () {
    test('思维链原样回来，且行 notifier 看得到（ThinkingBlock 画得出来）', () async {
      // 1) 流式一轮，思维链与正文各自累加
      final msgs = <ChatMessage>[
        ChatMessage(
          id: 'u1',
          conversationId: 'c1',
          role: MessageRole.user,
          content: '问',
          timestamp: DateTime.utc(2026, 11, 3, 9),
        ),
        assistant('a1', DateTime.utc(2026, 11, 3, 9, 0, 1)),
      ];
      final store = ChatRowStore(msgs);
      store.appendReasoning('a1', r1);
      store.appendContent('a1', c1);
      store.appendReasoning('a1', r2);
      store.appendContent('a1', c2);

      // 2) 存：与 _saveConversation 的映射逐字段同构
      await ConversationDB.save(Conversation(
        id: 'conv_rt',
        messages: msgs
            .map((m) => ChatMsg(
                  role: m.role == MessageRole.user ? 'user' : 'assistant',
                  content: m.content,
                  reasoning: m.reasoning,
                  timestamp: m.timestamp,
                ))
            .toList(),
      ));

      // 3) 切走：消息列表与思维链存档一起清空
      store.clear();
      expect(msgs, isEmpty);
      store.dispose();

      // 4) 切回：与 _loadConversation 的映射逐字段同构
      final back = await ConversationDB.load('conv_rt');
      expect(back, isNotNull);
      final reloaded = <ChatMessage>[];
      final store2 = ChatRowStore(reloaded);
      for (final msg in back!.messages) {
        final msgId = '${msg.timestamp.millisecondsSinceEpoch}';
        reloaded.add(ChatMessage(
          id: msgId,
          conversationId: back.id,
          role: msg.role == 'user' ? MessageRole.user : MessageRole.assistant,
          content: msg.content,
          reasoning: msg.reasoning,
          timestamp: msg.timestamp,
        ));
        // 灌进行 store：只写 ChatMessage 的话那一行渲染不出块来
        store2.setReasoning(msgId, msg.reasoning ?? '');
      }

      final a = reloaded.firstWhere((m) => m.role == MessageRole.assistant);
      expect(a.reasoning, r1 + r2);
      expect(a.content, c1 + c2);
      // 思维链绝不进正文（存盘路上也没被拼进去）
      expect(a.content.contains(r1), isFalse);

      // 行 notifier 也看得到，ThinkingBlock 的门控（assistant && 非空）才过
      expect(store2.notifierFor(a).value.reasoning, r1 + r2);

      store2.dispose();
    });

    testWidgets('读回之后那一行真的渲染出思维链块', (tester) async {
      final msgs = <ChatMessage>[
        ChatMessage(
          id: 'u1',
          conversationId: 'c1',
          role: MessageRole.user,
          content: '问',
          timestamp: DateTime.utc(2026, 11, 3, 9),
        ),
        assistant('a1', DateTime.utc(2026, 11, 3, 9, 0, 1)),
      ];
      final store = ChatRowStore(msgs);
      store.appendReasoning('a1', r1 + r2);
      store.appendContent('a1', c1);
      await ConversationDB.save(Conversation(
        id: 'conv_w',
        messages: msgs
            .map((m) => ChatMsg(
                  role: m.role == MessageRole.user ? 'user' : 'assistant',
                  content: m.content,
                  reasoning: m.reasoning,
                  timestamp: m.timestamp,
                ))
            .toList(),
      ));
      store.clear();
      store.dispose();

      final back = await ConversationDB.load('conv_w');
      final reloaded = <ChatMessage>[];
      final store2 = ChatRowStore(reloaded);
      for (final msg in back!.messages) {
        final msgId = '${msg.timestamp.millisecondsSinceEpoch}';
        reloaded.add(ChatMessage(
          id: msgId,
          conversationId: back.id,
          role: msg.role == 'user' ? MessageRole.user : MessageRole.assistant,
          content: msg.content,
          reasoning: msg.reasoning,
          timestamp: msg.timestamp,
        ));
        store2.setReasoning(msgId, msg.reasoning ?? '');
      }

      await tester.pumpWidget(host(
        reloaded.map((m) => rowFor(store2, m)).toList(),
      ));
      await tester.pumpAndSettle();

      // 块画出来了（默认收起，只有标题）
      expect(find.text('思考'), findsOneWidget);
      expect(find.text(c1), findsOneWidget);

      store2.dispose();
    });
  });

  group('旧会话容错：JSON 里没有 reasoning 键', () {
    Future<Conversation> legacyStore() async {
      // 存储键是 ConversationDB._prefix + id，所以是 'conv_conv_legacy'。
      FlutterSecureStorage.setMockInitialValues(<String, String>{
      'conv_conv_legacy': jsonEncode({
        'id': 'conv_legacy',
        'title': '以前的对话',
        'messages': [
          {
            'role': 'user',
            'content': '问',
            'timestamp': '2026-10-01T00:00:00.000'
          },
          {
            'role': 'assistant',
            'content': '答',
            'timestamp': '2026-10-01T00:00:01.000'
          },
        ],
        'createdAt': '2026-10-01T00:00:00.000',
        'updatedAt': '2026-10-01T00:00:01.000',
      }),
    });
    final back = await ConversationDB.load('conv_legacy');
    expect(back, isNotNull);
    return back!;
  }

    test('读得出来，不抛，reasoning 为 null，那一行不渲染块', () async {
      final back = await legacyStore();
      expect(back.messages.length, 2);
      expect(back.messages[1].reasoning, isNull);

      // 走一遍读回映射：不抛、思维链为 null、store 里也没有
      final reloaded = <ChatMessage>[];
      final store = ChatRowStore(reloaded);
      for (final msg in back.messages) {
        final msgId = '${msg.timestamp.millisecondsSinceEpoch}';
        reloaded.add(ChatMessage(
          id: msgId,
          conversationId: back.id,
          role: msg.role == 'user' ? MessageRole.user : MessageRole.assistant,
          content: msg.content,
          reasoning: msg.reasoning,
          timestamp: msg.timestamp,
        ));
        store.setReasoning(msgId, msg.reasoning ?? '');
      }
      final a = reloaded[1];
      expect(a.reasoning, isNull);
      expect(store.notifierFor(a).value.reasoning, '');

      store.dispose();
    });

    testWidgets('旧会话那一行没有思维链块', (tester) async {
      final back = await legacyStore();
      final reloaded = <ChatMessage>[];
      final store = ChatRowStore(reloaded);
      for (final msg in back.messages) {
        final msgId = '${msg.timestamp.millisecondsSinceEpoch}';
        reloaded.add(ChatMessage(
          id: msgId,
          conversationId: back.id,
          role: msg.role == 'user' ? MessageRole.user : MessageRole.assistant,
          content: msg.content,
          reasoning: msg.reasoning,
          timestamp: msg.timestamp,
        ));
        store.setReasoning(msgId, msg.reasoning ?? '');
      }

      await tester.pumpWidget(host(
        reloaded.map((m) => rowFor(store, m)).toList(),
      ));
      await tester.pumpAndSettle();

      expect(find.text('答'), findsOneWidget);
      expect(find.text('思考'), findsNothing);
      expect(find.text('正在思考'), findsNothing);

      store.dispose();
    });

    test('reasoning 是错类型时按 null 处理，不炸', () async {
      FlutterSecureStorage.setMockInitialValues(<String, String>{
        'conv_conv_broken': jsonEncode({
          'id': 'conv_broken',
          'title': '被手改坏的对话',
          'messages': [
            {
              'role': 'assistant',
              'content': '答',
              'reasoning': 12345,
              'timestamp': '2026-10-01T00:00:01.000',
            },
          ],
        }),
      });

      final back = await ConversationDB.load('conv_broken');
      expect(back, isNotNull);
      expect(back!.messages.single.reasoning, isNull);
    });
  });

  group('源级守卫：两处映射的接线不能被人删掉', () {
    test('_saveConversation 传 reasoning，_loadConversation 传 reasoning 并灌行 store',
        () {
      final src = File('lib/ui/screens/chat_screen_new.dart').readAsStringSync();
      final saveAt = src.indexOf('Future<void> _saveConversation()');
      final loadAt = src.indexOf('Future<void> _loadConversation(String id)');
      final delAt = src.indexOf('Future<void> _deleteConversation(');
      expect(saveAt, greaterThan(-1), reason: '找不到 _saveConversation');
      expect(loadAt, greaterThan(saveAt), reason: '找不到 _loadConversation');
      expect(delAt, greaterThan(loadAt), reason: '找不到 _deleteConversation');

      final save = src.substring(saveAt, loadAt);
      final load = src.substring(loadAt, delAt);

      expect(save, contains('reasoning: m.reasoning'));
      expect(load, contains('reasoning: msg.reasoning'));
      // 只写 ChatMessage 不够：行 notifier 首建读的是 store 的思维链存档
      expect(load, contains('_rows.setReasoning('));
    });
  });
}
