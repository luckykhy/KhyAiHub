import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/conversation_db.dart';
import 'package:khy_os_client/core/services/conversation_migrate.dart';

void main() {
  // T4 的判据核心：导出的 JSONL 外部工具可直接解析，且缺 amoo 专属字段
  // 不影响读取。这组测试就是那条判据的机读形式。
  group('通用会话格式（T4 schema 真源）', () {
    test('六字段齐全，role 限四枚举', () {
      final t = ChatTurn(
        id: 'turn-1',
        sessionId: 'conv-1',
        role: ChatTurn.roleAssistant,
        content: '你好',
        ts: DateTime.utc(2026, 11, 13, 3, 30),
        meta: const {'driver': 'amoo'},
      );
      final json = t.toJson();
      expect(json.keys.toSet(), {'id', 'session_id', 'role', 'content', 'ts', 'meta'});
      expect(json['role'], 'assistant');

      for (final role in const ['user', 'assistant', 'system', 'tool']) {
        expect(ChatTurn.fromJson({'role': role}).role, role);
      }
      // 未知 role 不抛——按原值透出，由渲染层决定怎么画；抛异常会让
      // 整份会话读不出来。
      expect(ChatTurn.fromJson({'role': 'weird'}).role, 'weird');
    });

    test('meta.driver 不是必填：缺了照样读', () {
      final t = ChatTurn.fromJson({
        'id': 'x',
        'session_id': 's',
        'role': 'user',
        'content': 'hi',
        'ts': '2026-11-13T03:30:00.000Z',
      });
      expect(t.meta['driver'], isNull);
      expect(t.content, 'hi');
    });

    test('JSONL 编解码往返一致', () {
      final turns = [
        ChatTurn(id: '1', sessionId: 's', role: 'user', content: '问', ts: DateTime.utc(2026, 11, 13, 3)),
        ChatTurn(id: '2', sessionId: 's', role: 'assistant', content: '答', ts: DateTime.utc(2026, 11, 13, 4), meta: const {'driver': 'local'}),
      ];
      final text = ConversationTurnCodec.encodeJsonl(turns);
      expect(text.trim().split('\n').length, 2, reason: '一行一轮次');
      expect(ConversationTurnCodec.decodeJsonl(text).length, 2);
      expect(ConversationTurnCodec.decodeJsonl(text)[1].meta['driver'], 'local');
    });

    test('空行与坏行不毒化整份解析', () {
      final text = '{"id":"1","session_id":"s","role":"user","content":"a","ts":"2026-11-13T03:00:00.000Z"}\n'
          '\n'
          'not-json\n';
      final turns = ConversationTurnCodec.decodeJsonl(text);
      expect(turns.length, 1, reason: '坏行跳过而不是整份失败——T4 要求外部工具可读');
      expect(turns.first.content, 'a');
    });
  });

  group('legacy 迁移', () {
    test('ChatMsg → ChatTurn：字段一一对应，session_id 用对话 id', () {
      final conv = Conversation(
        id: 'conv-42',
        title: '旧对话',
        messages: [
          ChatMsg(role: 'user', content: '提问', timestamp: DateTime.utc(2026, 11, 1, 8)),
          ChatMsg(
            role: 'assistant',
            content: '回答',
            timestamp: DateTime.utc(2026, 11, 1, 9),
            reasoning: '想了想',
          ),
        ],
      );

      final turns = ConversationMigrate.fromLegacyConversation(conv);
      expect(turns.length, 2);
      expect(turns.every((t) => t.sessionId == 'conv-42'), true);
      expect(turns[0].role, 'user');
      expect(turns[0].content, '提问');
      expect(turns[0].ts, DateTime.utc(2026, 11, 1, 8));
      expect(turns[1].meta['reasoning'], '想了想', reason: '思维链进 meta，不开新必填字段');
    });

    test('迁移幂等：同一条 legacy 迁移两次结果一致', () {
      final conv = Conversation(id: 'c', messages: [ChatMsg(role: 'user', content: 'x')]);
      final a = ConversationMigrate.fromLegacyConversation(conv).map((t) => t.toJson()).toList();
      final b = ConversationMigrate.fromLegacyConversation(conv).map((t) => t.toJson()).toList();
      expect(jsonEncode(a), jsonEncode(b));
    });

    test('迁移不写 amoo 专属必填字段', () {
      final conv = Conversation(
        id: 'c',
        messages: [
          ChatMsg(role: 'assistant', content: '来自 amoo 的回答'),
        ],
      );
      for (final t in ConversationMigrate.fromLegacyConversation(conv)) {
        final json = t.toJson();
        // 通用格式只认这六个键；任何 amoo_* / turnId 之类都不该出现在必填位。
        expect(json.keys.toSet(), {'id', 'session_id', 'role', 'content', 'ts', 'meta'});
      }
    });
  });
}
