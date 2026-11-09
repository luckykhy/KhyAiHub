import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/conversation_db.dart';
import 'package:khy_os_client/core/services/training_export.dart';

/// training_export 的单测。
///
/// 钉三件事：两种格式的字段形状（与 runtime/node/backend/src/services/
/// trainingDataService.js recordInteraction 65-84 行逐键对齐）、空会话导出
/// 空文件而不是一行空壳、多轮对话按 user→assistant 成对切。
///
/// 不碰 FlutterSecureStorage（主机上没有）：ConversationDB 那半边只在真机
/// 跑，与 amoo_turn_test / rag_retrieval_test 同一纪律。
void main() {
  ChatMsg msg(String role, String content, {DateTime? at}) => ChatMsg(
        role: role,
        content: content,
        timestamp: at,
      );

  List<Map<String, dynamic>> lines(String jsonl) => jsonl
      .split('\n')
      .where((line) => line.isNotEmpty)
      .map((line) => jsonDecode(line) as Map<String, dynamic>)
      .toList();

  group('collectTrainingTurns', () {
    test('一轮对话切出一个 turn：messages 到 user 为止，response 单独', () {
      final turns = collectTrainingTurns([
        Conversation(
          id: 'c1',
          messages: [
            msg('user', '怎么止损', at: DateTime.utc(2026, 11, 4, 9)),
            msg('assistant', '设好止损位', at: DateTime.utc(2026, 11, 4, 9, 1)),
          ],
        ),
      ]);

      expect(turns, hasLength(1));
      expect(turns.single.sessionId, 'c1');
      expect(turns.single.messages, [
        {'role': 'user', 'content': '怎么止损'},
      ]);
      expect(turns.single.response, '设好止损位');
      expect(turns.single.at, DateTime.utc(2026, 11, 4, 9, 1));
      expect(turns.single.model, 'unknown');
    });

    test('多轮对话每个回合一个 turn，历史累积不丢', () {
      final turns = collectTrainingTurns([
        Conversation(
          id: 'c1',
          messages: [
            msg('user', '问题一'),
            msg('assistant', '回答一'),
            msg('user', '问题二'),
            msg('assistant', '回答二'),
          ],
        ),
      ]);

      expect(turns, hasLength(2));
      expect(turns.last.messages.map((m) => m['content']).toList(),
          <String>['问题一', '回答一', '问题二']);
      expect(turns.last.response, '回答二');
    });

    test('system / tool 消息随历史保留，不当成训练目标', () {
      final turns = collectTrainingTurns([
        Conversation(
          id: 'c1',
          messages: [
            msg('system', '你是助手'),
            msg('user', '问题'),
            msg('tool', '工具输出'),
            msg('assistant', '回答'),
          ],
        ),
      ]);

      expect(turns, hasLength(1));
      expect(turns.single.messages.map((m) => m['role']).toList(),
          <String>['system', 'user', 'tool']);
      expect(turns.single.response, '回答');
    });

    test('空会话与只有 user 的会话都不产出行', () {
      expect(collectTrainingTurns(const []), isEmpty);
      expect(
        collectTrainingTurns([Conversation(id: 'c1', messages: const [])]),
        isEmpty,
      );
      // 尾问没有回答：导出空 response 是在教模型用沉默回答。
      expect(
        collectTrainingTurns([
          Conversation(id: 'c1', messages: [msg('user', '没人答')]),
        ]),
        isEmpty,
      );
      expect(
        collectTrainingTurns([
          Conversation(id: 'c1', messages: [msg('assistant', '自言自语')]),
        ]),
        isEmpty,
      );
    });

    test('空内容的消息被跳过，不产出空 turn', () {
      expect(
        collectTrainingTurns([
          Conversation(
            id: 'c1',
            messages: [msg('user', '问题'), msg('assistant', '')],
          ),
        ]),
        isEmpty,
      );
    });

    test('model 由调用方给：本地会话不记模型，不猜', () {
      final turns = collectTrainingTurns(
        [
          Conversation(
            id: 'c1',
            messages: [msg('user', 'q'), msg('assistant', 'a')],
          ),
        ],
        model: 'glm-5.3',
      );
      expect(turns.single.model, 'glm-5.3');
    });
  });

  group('buildTrainingJsonl 字段形状', () {
    TrainingTurn turn({
      List<Map<String, dynamic>> messages = const [
        {'role': 'user', 'content': 'q'},
      ],
      String response = 'a',
    }) =>
        TrainingTurn(
          sessionId: 'c1',
          messages: messages,
          response: response,
          model: 'm1',
          at: DateTime.utc(2026, 11, 4, 10, 30),
        );

    test('sharegpt：与 recordInteraction 逐键对齐', () {
      final jsonl = buildTrainingJsonl([turn()]);
      final rows = lines(jsonl);
      expect(rows, hasLength(1));
      final row = rows.single;

      expect(row['timestamp'], '2026-11-04T10:30:00.000Z');
      expect(row['version'], '1.0');
      expect(row['user_id'], 'anonymous');
      expect(row['session_id'], 'c1');
      expect(row['messages'], [
        {'role': 'user', 'content': 'q'},
      ]);
      expect(row['response'], 'a');
      expect(row['model'], 'm1');
      expect(row['intent'], 'general');
      expect(row['response_time_ms'], isNull);
      expect(row['metadata'], {
        'source': 'android',
        'adapter': null,
        'tokens_used': null,
      });
      // sharegpt 不带 alpaca 三元组。
      expect(row.containsKey('instruction'), false);
      expect(row.containsKey('input'), false);
      expect(row.containsKey('output'), false);
    });

    test('alpaca：在兼容字段之上加 instruction/input/output', () {
      final jsonl = buildTrainingJsonl(
        [turn()],
        format: TrainingExportFormat.alpaca,
      );
      final row = lines(jsonl).single;

      // 平台采集器读的键一个不少。
      expect(row['messages'], [
        {'role': 'user', 'content': 'q'},
      ]);
      expect(row['response'], 'a');
      expect(row['model'], 'm1');
      expect(row['intent'], 'general');

      expect(row['instruction'], 'q');
      expect(row['input'], '');
      expect(row['output'], 'a');
    });

    test('alpaca 多轮：instruction 取最后一问，input 装更早的用户轮', () {
      final jsonl = buildTrainingJsonl(
        [
          turn(
            messages: const [
              {'role': 'user', 'content': '第一问'},
              {'role': 'assistant', 'content': '第一答'},
              {'role': 'user', 'content': '最后问'},
            ],
            response: '最后答',
          ),
        ],
        format: TrainingExportFormat.alpaca,
      );
      final row = lines(jsonl).single;

      expect(row['instruction'], '最后问');
      expect(row['input'], '第一问');
      expect(row['output'], '最后答');
    });

    test('JSONL 形状：一行一个对象、以换行收尾、行数等于 turn 数', () {
      final jsonl = buildTrainingJsonl([turn(), turn(response: 'b')]);
      expect(jsonl.endsWith('\n'), true);
      expect(lines(jsonl), hasLength(2));
      expect(lines(jsonl).map((r) => r['response']).toList(),
          <String>['a', 'b']);
    });

    test('空 turn 列表导出空串，不是一行空壳', () {
      expect(buildTrainingJsonl(const []), '');
    });

    test('source 可指定（采集器据此区分来源）', () {
      final row = lines(buildTrainingJsonl([turn()], source: 'share')).single;
      expect((row['metadata'] as Map<String, dynamic>)['source'], 'share');
    });
  });

  group('PII 脱敏', () {
    test('手机号/身份证/邮箱/银行卡/IP 与平台侧同一套掩码', () {
      expect(sanitizeTrainingText('打我 13800138000'), '打我 [PHONE]');
      // 18 位身份证：不含 1[3-9] 开头的 11 位子串，才走得到身份证分支——
      // 平台侧先跑手机号正则，含这类子串的号码会被掩成 [PHONE]，这里不复刻
      // 那个先后次序的巧合，只验身份证分支本身。
      expect(sanitizeTrainingText('证 110105200001011234'), '证 [ID]');
      expect(sanitizeTrainingText('邮 a@b.com'), '邮 [EMAIL]');
      expect(sanitizeTrainingText('卡 6222 0202 0001 0001'), '卡 [BANKCARD]');
      expect(sanitizeTrainingText('机 10.1.2.3'), '机 [IP]');
    });

    test('脱敏同时作用于 messages 与 response', () {
      final jsonl = buildTrainingJsonl([
        TrainingTurn(
          sessionId: 'c1',
          messages: const [
            {'role': 'user', 'content': '打 13800138000'},
          ],
          response: '已记 110105200001011234',
          model: 'm',
          at: DateTime.utc(2026, 11, 4),
        ),
      ]);
      final row = lines(jsonl).single;
      expect((row['messages'] as List).single['content'], '打 [PHONE]');
      expect(row['response'], '已记 [ID]');
    });

    test('普通文本不被误伤', () {
      const text = '止损位设在 3200，仓位 3 成。';
      expect(sanitizeTrainingText(text), text);
    });
  });
}
