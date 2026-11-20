import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_models.dart';

/// Contract-model pins: wire key names, the two block shapes, bad-row handling,
/// cursor parsing, and the grouping order. These are the places where a renamed
/// field or a silently-defaulted value would pass every other test while the
/// UI quietly shows amoo's data as something else.
void main() {
  group('AmooMirrorSession.fromJson (wire camelCase keys)', () {
    test('全字段按契约键名解析', () {
      final session = AmooMirrorSession.fromJson(<String, dynamic>{
        'id': 's-1',
        'title': '帮我修 bug',
        'updatedAt': 1730000000000,
        'lastPreview': '最后一句话',
        'messageCount': 12,
        'agentKey': 'amoo',
        'compacted': true,
      });
      expect(session, isNotNull);
      expect(session!.id, 's-1');
      expect(session.title, '帮我修 bug');
      expect(session.updatedAt, 1730000000000);
      expect(session.lastPreview, '最后一句话');
      expect(session.messageCount, 12);
      expect(session.agentKey, 'amoo');
      expect(session.compacted, isTrue);
    });

    test('缺 id 或空 id → null（主键脏数据不能压成一行）', () {
      expect(AmooMirrorSession.fromJson(<String, dynamic>{'title': 'x'}), isNull);
      expect(
        AmooMirrorSession.fromJson(<String, dynamic>{'id': '', 'title': 'x'}),
        isNull,
      );
      expect(AmooMirrorSession.fromJson('not-a-map'), isNull);
    });

    test('缺列表字段给默认值，updatedAt 坏值落底而不是丢行', () {
      final session = AmooMirrorSession.fromJson(<String, dynamic>{'id': 's-2'})!;
      expect(session.title, '');
      expect(session.lastPreview, '');
      expect(session.messageCount, 0);
      expect(session.agentKey, '');
      expect(session.compacted, isFalse);
      // 会话在服务端存在，时钟脏不该让它从界面上消失
      expect(session.updatedAt, 0);
    });

    test('toJson 出的键名就是契约键名', () {
      final json = const AmooMirrorSession(
        id: 's-1',
        title: 't',
        updatedAt: 5,
      ).toJson();
      expect(json.keys.toSet(), <String>{
        'id',
        'title',
        'updatedAt',
        'lastPreview',
        'messageCount',
        'agentKey',
        'compacted',
      });
      // 禁下划线键：出现 snake_case 说明映射写错了半边
      for (final key in json.keys) {
        expect(key.contains('_'), isFalse, reason: '$key 不是契约键名');
      }
    });

    test('toRow/fromRow 往返，列名为 snake_case 且不含 next_cursor', () {
      const session = AmooMirrorSession(
        id: 's-1',
        title: 't',
        updatedAt: 1730000000000,
        lastPreview: 'p',
        messageCount: 3,
        agentKey: 'researcher',
        compacted: true,
      );
      final row = session.toRow();
      expect(row['session_id'], 's-1');
      expect(row['updated_at'], 1730000000000);
      expect(row['compacted'], 1);
      expect(row.containsKey('next_cursor'), isFalse,
          reason: 'next_cursor 只由消息同步路径写，不能从列表合并写进去');
      final back = AmooMirrorSession.fromRow(row)!;
      expect(back.id, session.id);
      expect(back.title, session.title);
      expect(back.updatedAt, session.updatedAt);
      expect(back.lastPreview, session.lastPreview);
      expect(back.messageCount, session.messageCount);
      expect(back.agentKey, session.agentKey);
      expect(back.compacted, session.compacted);
    });

    test('fromRow 空 session_id → null', () {
      expect(
        AmooMirrorSession.fromRow(<String, Object?>{
          'session_id': '',
          'updated_at': 1,
        }),
        isNull,
      );
    });
  });

  group('blocks', () {
    test('text 与 tool 两种块按 type 判别', () {
      final blocks = parseAmooMirrorBlocks(<dynamic>[
        <String, dynamic>{'type': 'text', 'text': '你好'},
        <String, dynamic>{
          'type': 'tool',
          'name': 'read_file',
          'summary': '读取 lib/main.dart',
          'truncated': true,
        },
      ])!;
      expect(blocks, hasLength(2));
      final text = blocks[0] as AmooMirrorTextBlock;
      expect(text.text, '你好');
      final tool = blocks[1] as AmooMirrorToolBlock;
      expect(tool.name, 'read_file');
      expect(tool.summary, '读取 lib/main.dart');
      expect(tool.truncated, isTrue);
    });

    test('未知 type 丢块不丢消息；tool 缺 name/summary 同样丢块', () {
      final blocks = parseAmooMirrorBlocks(<dynamic>[
        <String, dynamic>{'type': 'text', 'text': '留我'},
        <String, dynamic>{'type': 'image', 'url': 'x'},
        <String, dynamic>{'type': 'tool', 'name': 'read_file'},
        <String, dynamic>{'type': 'tool', 'summary': '只有摘要'},
      ])!;
      expect(blocks, hasLength(1));
      expect((blocks.single as AmooMirrorTextBlock).text, '留我');
    });

    test('truncated 缺失按 false', () {
      final blocks = parseAmooMirrorBlocks(<dynamic>[
        <String, dynamic>{'type': 'tool', 'name': 'bash', 'summary': 'ls'},
      ])!;
      expect((blocks.single as AmooMirrorToolBlock).truncated, isFalse);
    });

    test('非 List 入参返回 null（脏数据信号，不是空列表）', () {
      expect(parseAmooMirrorBlocks(null), isNull);
      expect(parseAmooMirrorBlocks(<String, dynamic>{'type': 'text'}), isNull);
      expect(parseAmooMirrorBlocks('text'), isNull);
    });

    test('显式空数组是服务端的陈述，返回空列表而非 null', () {
      expect(parseAmooMirrorBlocks(<dynamic>[]), isEmpty);
    });
  });

  group('AmooMirrorMessage', () {
    test('全字段解析，parentId 可空', () {
      final message = AmooMirrorMessage.fromJson(<String, dynamic>{
        'id': 'm-006',
        'parentId': 'm-005',
        'timestamp': 1730000060000,
        'role': 'assistant',
        'blocks': <dynamic>[
          <String, dynamic>{'type': 'text', 'text': '好的'},
        ],
      }, sessionId: 's-amoo-001')!;
      expect(message.id, 'm-006');
      expect(message.sessionId, 's-amoo-001');
      expect(message.parentId, 'm-005');
      expect(message.timestamp, 1730000060000);
      expect(message.role, AmooMirrorRole.assistant);
      expect(message.blocks, hasLength(1));

      final root = AmooMirrorMessage.fromJson(<String, dynamic>{
        'id': 'm-001',
        'timestamp': 1730000010000,
        'role': 'user',
        'blocks': <dynamic>[],
      }, sessionId: 's-amoo-001')!;
      expect(root.parentId, isNull);
      expect(root.role, AmooMirrorRole.user);
    });

    test('坏行整条 null：缺 id / 空 id / timestamp 非数 / role 不可解析 / blocks 缺失', () {
      Map<String, dynamic> base() => <String, dynamic>{
            'id': 'm-1',
            'timestamp': 1730000010000,
            'role': 'user',
            'blocks': <dynamic>[],
          };
      expect(
        AmooMirrorMessage.fromJson(
            base()..remove('id'), sessionId: 's'),
        isNull,
      );
      expect(
        AmooMirrorMessage.fromJson(base()..['id'] = '', sessionId: 's'),
        isNull,
      );
      expect(
        AmooMirrorMessage.fromJson(
            base()..['timestamp'] = '1730000010000', sessionId: 's'),
        isNull,
      );
      expect(
        AmooMirrorMessage.fromJson(base()..['role'] = 'system', sessionId: 's'),
        isNull,
      );
      expect(
        AmooMirrorMessage.fromJson(base()..remove('blocks'), sessionId: 's'),
        isNull,
      );
      // blocks 不是数组同样整条 null——绝不兜底成空列表
      expect(
        AmooMirrorMessage.fromJson(
            base()..['blocks'] = <String, dynamic>{'type': 'text'},
            sessionId: 's'),
        isNull,
      );
    });

    test('toRow 存 blocks 为服务端原文 JSON；fromRow 往返', () {
      const message = AmooMirrorMessage(
        id: 'm-006',
        sessionId: 's-amoo-001',
        parentId: 'm-005',
        timestamp: 1730000060000,
        role: AmooMirrorRole.assistant,
        blocks: <AmooMirrorBlock>[
          AmooMirrorTextBlock('好的'),
          AmooMirrorToolBlock(name: 'read_file', summary: '读文件', truncated: true),
        ],
      );
      final row = message.toRow();
      expect(row['session_id'], 's-amoo-001');
      expect(row['message_id'], 'm-006');
      expect(row['parent_id'], 'm-005');
      expect(row['role'], 'assistant');
      // 库里存的是可解析的原文 JSON，不是脱敏后的展示文本
      expect(jsonDecode(row['blocks'] as String), isA<List<dynamic>>());

      final back = AmooMirrorMessage.fromRow(row)!;
      expect(back.id, message.id);
      expect(back.sessionId, message.sessionId);
      expect(back.parentId, message.parentId);
      expect(back.timestamp, message.timestamp);
      expect(back.role, message.role);
      expect(back.blocks, hasLength(2));
      expect((back.blocks[0] as AmooMirrorTextBlock).text, '好的');
      expect((back.blocks[1] as AmooMirrorToolBlock).truncated, isTrue);
    });

    test('fromRow 坏 blocks JSON → 整条 null，不兜底空气泡', () {
      expect(
        AmooMirrorMessage.fromRow(<String, Object?>{
          'session_id': 's',
          'message_id': 'm-1',
          'timestamp': 1,
          'role': 'user',
          'blocks': '{not json',
        }),
        isNull,
      );
    });

    test('fromRow blocks 非数组 JSON → null', () {
      expect(
        AmooMirrorMessage.fromRow(<String, Object?>{
          'session_id': 's',
          'message_id': 'm-1',
          'timestamp': 1,
          'role': 'user',
          'blocks': '{"type":"text"}',
        }),
        isNull,
      );
    });

    test('fromRow timestamp 非 int / role 未知 → null', () {
      expect(
        AmooMirrorMessage.fromRow(<String, Object?>{
          'session_id': 's',
          'message_id': 'm-1',
          'timestamp': 1.5,
          'role': 'user',
          'blocks': '[]',
        }),
        isNull,
      );
      expect(
        AmooMirrorMessage.fromRow(<String, Object?>{
          'session_id': 's',
          'message_id': 'm-1',
          'timestamp': 1,
          'role': 'system',
          'blocks': '[]',
        }),
        isNull,
      );
    });
  });

  group('AmooMirrorCursor', () {
    test('格式化是 <ts>:<id>', () {
      expect(const AmooMirrorCursor(1730000060000, 'm-006').toString(),
          '1730000060000:m-006');
    });

    test('往返', () {
      final cursor = AmooMirrorCursor.parse('1730000060000:m-006');
      expect(cursor, isNotNull);
      expect(cursor!.timestamp, 1730000060000);
      expect(cursor.id, 'm-006');
      expect(cursor.toString(), '1730000060000:m-006');
    });

    test('空/畸形/无冒点/时间非数字 → null（=全量重拉）', () {
      expect(AmooMirrorCursor.parse(null), isNull);
      expect(AmooMirrorCursor.parse(''), isNull);
      expect(AmooMirrorCursor.parse('   '), isNull);
      expect(AmooMirrorCursor.parse('no-colon'), isNull);
      expect(AmooMirrorCursor.parse(':m-006'), isNull);
      expect(AmooMirrorCursor.parse('1730000060000:'), isNull);
      expect(AmooMirrorCursor.parse('abc:m-006'), isNull);
    });

    test('id 里带冒号按第一个冒号切（时间戳在前）', () {
      final cursor = AmooMirrorCursor.parse('1730000060000:m:006')!;
      expect(cursor.timestamp, 1730000060000);
      expect(cursor.id, 'm:006');
    });
  });

  group('groupSessionsByAgent', () {
    AmooMirrorSession session(
      String id,
      String agentKey,
      int updatedAt,
    ) =>
        AmooMirrorSession(
          id: id,
          title: id,
          updatedAt: updatedAt,
          agentKey: agentKey,
        );

    test('按 agentKey 分组；组序=组内最新 updatedAt 降序；组内同序', () {
      final grouped = groupSessionsByAgent(<AmooMirrorSession>[
        session('old-amoo', 'amoo', 1000),
        session('new-research', 'researcher', 9000),
        session('new-amoo', 'amoo', 5000),
        session('old-research', 'researcher', 2000),
      ]);
      expect(grouped.keys.toList(), <String>['researcher', 'amoo']);
      expect(
        grouped['researcher']!.map((s) => s.id).toList(),
        <String>['new-research', 'old-research'],
      );
      expect(
        grouped['amoo']!.map((s) => s.id).toList(),
        <String>['new-amoo', 'old-amoo'],
      );
    });

    test('组序与输入顺序无关（同一份数据乱序进，分组结果一致）', () {
      final a = <AmooMirrorSession>[
        session('x', 'amoo', 3000),
        session('y', 'researcher', 9000),
      ];
      final b = <AmooMirrorSession>[a[1], a[0]];
      expect(groupSessionsByAgent(a).keys.toList(),
          groupSessionsByAgent(b).keys.toList());
    });

    test('空输入返回空 map', () {
      expect(groupSessionsByAgent(const <AmooMirrorSession>[]), isEmpty);
    });
  });

  group('page-size constants', () {
    test('与契约默认 limit 对齐', () {
      expect(kAmooMirrorSessionsLimit, 50);
      expect(kAmooMirrorMessagesLimit, 200);
    });
  });
}
