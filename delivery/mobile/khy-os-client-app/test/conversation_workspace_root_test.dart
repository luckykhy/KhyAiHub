import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/conversation_db.dart';

/// 对话数据模型的测试。
///
/// 只测纯序列化与 copyWith，不碰 FlutterSecureStorage（那需要设备/插件）。
/// 重点在两件事：老对话读新字段不能炸，以及 copyWith 不能静默丢字段——
/// 后者是加 workspaceRoot 之前就存在的隐患，加字段会让它从"丢一个将来可能
/// 有用的字段"变成"用户挑的工作目录莫名消失"。
void main() {
  group('workspaceRoot 序列化', () {
    test('挑了根：进 JSON，出来还在', () {
      final conv = Conversation(
        id: 'c1',
        title: '写游戏',
        workspaceRoot: '/sdcard/khy-os',
      );
      final back = Conversation.fromJson(conv.toJson());
      expect(back.workspaceRoot, '/sdcard/khy-os');
    });

    test('没挑根：JSON 里没有这个键，读出来是 null', () {
      // 只在挑了的时候写键。老对话因此不需要迁移，也不需要版本号。
      final conv = Conversation(id: 'c1');
      expect(conv.toJson().containsKey('workspaceRoot'), false);
      expect(Conversation.fromJson(conv.toJson()).workspaceRoot, isNull);
    });

    test('老对话的 JSON（没有 workspaceRoot 键）读得出来，且是 null', () {
      // 这是升级路径：不抛、不默认成某个根、行为一字不变。
      final legacy = Conversation.fromJson({
        'id': 'old1',
        'title': '以前的对话',
        'messages': <dynamic>[],
        'createdAt': '2026-10-01T00:00:00.000',
        'updatedAt': '2026-10-01T00:00:00.000',
      });
      expect(legacy.id, 'old1');
      expect(legacy.workspaceRoot, isNull);
      expect(legacy.messages, isEmpty);
    });

    test('workspaceRoot 是错类型时按 null 处理，不炸', () {
      final c = Conversation.fromJson({
        'id': 'x',
        'workspaceRoot': 12345,
      });
      expect(c.workspaceRoot, isNull);
    });
  });

  group('copyWith', () {
    test('只改 title 时，workspaceRoot 不能丢', () {
      // 这个用例在加字段之前是会失败的：原 copyWith 根本不传 workspaceRoot。
      final conv = Conversation(
        id: 'c1',
        title: '旧标题',
        workspaceRoot: '/sdcard/khy-os',
      );
      final renamed = conv.copyWith(title: '新标题');
      expect(renamed.title, '新标题');
      expect(renamed.workspaceRoot, '/sdcard/khy-os');
    });

    test('只改 messages 时，workspaceRoot 同样不能丢', () {
      final conv = Conversation(
        id: 'c1',
        workspaceRoot: '/sdcard/khy-os',
      );
      final withMsgs = conv.copyWith(messages: [
        ChatMsg(role: 'user', content: 'hi'),
      ]);
      expect(withMsgs.messages.length, 1);
      expect(withMsgs.workspaceRoot, '/sdcard/khy-os');
    });

    test('能改根，也能显式清掉', () {
      final conv = Conversation(id: 'c1', workspaceRoot: '/sdcard/a');
      expect(conv.copyWith(workspaceRoot: '/sdcard/b').workspaceRoot, '/sdcard/b');
      expect(conv.copyWith(clearWorkspaceRoot: true).workspaceRoot, isNull);
    });

    test('copyWith 保留 id 与 createdAt，只推进 updatedAt', () {
      final created = DateTime.utc(2026, 10, 1, 8);
      final conv = Conversation(id: 'c1', createdAt: created);
      final copy = conv.copyWith(title: 't');
      expect(copy.id, 'c1');
      expect(copy.createdAt, created);
      expect(copy.updatedAt.isAfter(created), true);
    });
  });

  group('ConversationSummary', () {
    test('摘要带上根，让会话列表能显示文件落在哪', () {
      final s = ConversationSummary(
        id: 'c1',
        title: 't',
        messageCount: 3,
        createdAt: DateTime(2026),
        updatedAt: DateTime(2026),
        workspaceRoot: '/sdcard/khy-os',
      );
      expect(s.workspaceRoot, '/sdcard/khy-os');
      final none = ConversationSummary(
        id: 'c2',
        title: 't',
        messageCount: 0,
        createdAt: DateTime(2026),
        updatedAt: DateTime(2026),
      );
      expect(none.workspaceRoot, isNull);
    });
  });
}
