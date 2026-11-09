import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/db/amoo_turn.dart';

/// AmooTurn 的纯逻辑测试。
///
/// 刻意不碰 sqflite：主机上没有 sqlite3.dll，`AmooTurnStore` 的测试只能在
/// 设备上跑。这里测的是**不依赖原生库的那一半**——状态机、行映射、以及
/// 文案的诚实边界。而那恰好是全部容易出错的地方：SQL 写错会立刻抛异常，
/// 把 interrupted 说成 failed 却一声不响地骗人。
void main() {
  group('AmooTurnState.parse', () {
    test('五个已知态都能往返', () {
      for (final s in AmooTurnState.values) {
        expect(AmooTurnState.parse(s.wire), s, reason: '${s.wire} 往返失败');
      }
    });

    test('未知态退回 interrupted 而不是 running', () {
      // 这是关键的一条：库是跨版本持久的，旧版本写进去的态、或将来新增的态，
      // 在老代码眼里都是未知。若按 running 处理，界面会永远转圈；按
      // interrupted 处理，至少承认"断了"并给用户出口。
      expect(AmooTurnState.parse('some_future_state'), AmooTurnState.interrupted);
      expect(AmooTurnState.parse(null), AmooTurnState.interrupted);
      expect(AmooTurnState.parse(''), AmooTurnState.interrupted);
    });

    test('pending 与 running 都算未结算', () {
      expect(AmooTurnState.pending.isUnsettled, true);
      expect(AmooTurnState.running.isUnsettled, true);
      expect(AmooTurnState.done.isUnsettled, false);
      expect(AmooTurnState.failed.isUnsettled, false);
      expect(AmooTurnState.interrupted.isUnsettled, false);
    });
  });

  group('AmooTurn 行映射', () {
    test('toRow/fromRow 往返保持每个字段', () {
      const t = AmooTurn(
        id: 7,
        job: 'ask-1730000000000',
        prompt: '帮我打开微信',
        reply: '已打开',
        state: AmooTurnState.done,
        error: '',
        askedAt: 1730000000000,
        settledAt: 1730000060000,
        synced: true,
      );
      final back = AmooTurn.fromRow(t.toRow());
      expect(back.id, t.id);
      expect(back.job, t.job);
      expect(back.prompt, t.prompt);
      expect(back.reply, t.reply);
      expect(back.state, t.state);
      expect(back.error, t.error);
      expect(back.askedAt, t.askedAt);
      expect(back.settledAt, t.settledAt);
      expect(back.synced, t.synced);
    });

    test('reply 为 null 时不被悄悄变成空串', () {
      // 空串会被读成"amoo 回了空内容"，那是另一件事。未结算必须保持 null。
      const t = AmooTurn(prompt: 'x', askedAt: 1, state: AmooTurnState.running);
      expect(t.toRow()['reply'], isNull);
      expect(AmooTurn.fromRow(t.toRow()).reply, isNull);
    });

    test('synced 以 0/1 存储', () {
      const yes = AmooTurn(prompt: 'x', askedAt: 1, synced: true);
      const no = AmooTurn(prompt: 'x', askedAt: 1, synced: false);
      expect(yes.toRow()['synced'], 1);
      expect(no.toRow()['synced'], 0);
    });

    test('默认态是 pending——落盘先于发起', () {
      const t = AmooTurn(prompt: 'x', askedAt: 1);
      expect(t.state, AmooTurnState.pending);
    });
  });

  group('文案的诚实边界', () {
    test('interrupted 不说 amoo 失败', () {
      const t = AmooTurn(
        prompt: 'x',
        askedAt: 1,
        state: AmooTurnState.interrupted,
      );
      expect(t.statusLine, contains('中断'));
      expect(t.statusLine, isNot(contains('失败')));
      // 且必须说明 amoo 可能已经答了
      expect(t.statusLine, contains('可能已在'));
    });

    test('只有 interrupted 给恢复提示', () {
      for (final s in AmooTurnState.values) {
        final t = AmooTurn(prompt: 'x', askedAt: 1, state: s);
        if (s == AmooTurnState.interrupted) {
          expect(t.recoveryHint, isNotNull);
          // 且必须警告不要重复提问——同一句话再发等于问两遍
          expect(t.recoveryHint, contains('不重复提问'));
        } else {
          expect(t.recoveryHint, isNull, reason: '$s 不该给恢复提示');
        }
      }
    });

    test('failed 带上错误详情', () {
      const t = AmooTurn(
        prompt: 'x',
        askedAt: 1,
        state: AmooTurnState.failed,
        error: 'amoo_not_foreground',
      );
      expect(t.statusLine, contains('amoo_not_foreground'));
    });

    test('failed 且无错误时不显示冒号空挂', () {
      const t = AmooTurn(prompt: 'x', askedAt: 1, state: AmooTurnState.failed);
      expect(t.statusLine, '未拿到回复');
    });

    test('done 的状态行不含回复正文', () {
      // 回复可能很长，属于内容区；状态行塞进去会把卡片撑爆。
      const long = '很长很长的回复很长很长的回复很长很长的回复很长很长的回复'
          '很长很长的回复很长很长的回复很长很长的回复很长很长的回复';
      final t = AmooTurn(
        prompt: 'x',
        askedAt: 1,
        state: AmooTurnState.done,
        reply: long * 20,
      );
      expect(t.statusLine, 'amoo 已回复');
    });
  });

  group('schema', () {
    test('DDL 覆盖全部字段', () {
      for (final col in const <String>[
        'id',
        'job',
        'prompt',
        'reply',
        'state',
        'error',
        'asked_at',
        'settled_at',
        'synced',
      ]) {
        expect(AmooTurnSchema.createTable, contains(col),
            reason: 'DDL 缺列 $col');
      }
    });

    test('表名与索引名不脱节', () {
      expect(AmooTurnSchema.indexUnsettled, contains(AmooTurnSchema.table));
      expect(AmooTurnSchema.indexAskedAt, contains(AmooTurnSchema.table));
    });
  });
}
