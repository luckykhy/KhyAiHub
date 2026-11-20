import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/console_service.dart';

/// 控制台 Dart 侧的状态映射。
///
/// 为什么要单独测这一层：三类失败的真源在原生（KhyConsole 的 status 字段），
/// 但用户最终读到的字是这里翻出来的。原生分得再清，Dart 把三个 status 映成
/// 同一个词，前面就全白做了——而这是纯粹的打字错误就能造成的事故。
void main() {
  group('ConsoleStatus 三类失败必须可区分', () {
    test('三个状态各自映射到不同标签', () {
      final labels = <String>{
        ConsoleStatus.invalidArgs.label,
        ConsoleStatus.toolUnavailable.label,
        ConsoleStatus.execError.label,
      };
      expect(labels.length, 3,
          reason: '三个状态的标签必须互不相同，否则用户分不出该改哪边');
    });

    test('三个状态各自映射到不同处置建议', () {
      // 标签相同还能靠颜色分辨；处置建议相同就真的没法可想了。
      final remedies = <String>{
        ConsoleStatus.invalidArgs.remedy,
        ConsoleStatus.toolUnavailable.remedy,
        ConsoleStatus.execError.remedy,
      };
      expect(remedies.length, 3);
    });

    test('原生的 status 字符串能还原成对应枚举', () {
      expect(ConsoleStatus.parse('ok'), ConsoleStatus.ok);
      expect(ConsoleStatus.parse('invalid_args'), ConsoleStatus.invalidArgs);
      expect(ConsoleStatus.parse('tool_unavailable'), ConsoleStatus.toolUnavailable);
      expect(ConsoleStatus.parse('exec_error'), ConsoleStatus.execError);
    });

    test('未知 status 不静默变成成功', () {
      // 认不出来的状态必须是 unknown 而不是 ok——把失败读成成功是最坏的方向。
      expect(ConsoleStatus.parse('something_new'), ConsoleStatus.unknown);
      expect(ConsoleStatus.parse(null), ConsoleStatus.unknown);
      expect(ConsoleStatus.unknown.isOk, isFalse);
    });

    test('成功态没有处置建议', () {
      expect(ConsoleStatus.ok.remedy, isEmpty);
      expect(ConsoleStatus.ok.isOk, isTrue);
    });
  });

  group('命令来源', () {
    test('manual 与 amoo 标签不同', () {
      expect(consoleOriginLabel(kConsoleOriginManual), '手动');
      expect(consoleOriginLabel(kConsoleOriginAmoo), 'Amoo');
      expect(consoleOriginLabel(kConsoleOriginManual),
          isNot(consoleOriginLabel(kConsoleOriginAmoo)));
    });

    test('认不出来的来源按手动算，不按 Amoo 算', () {
      // 反过来会把别人发的命令记到自己头上。
      expect(consoleOriginLabel(''), '手动');
      expect(consoleOriginLabel(null), '手动');
    });
  });

  group('ConsoleEntry 从原生响应还原', () {
    test('三类失败的字段都取得到', () {
      final entry = ConsoleEntry.fromMap(<String, dynamic>{
        'id': 'c-1',
        'ts': 1000,
        'origin': 'amoo',
        'tool': 'ui_tap',
        'raw': '{"tool":"ui_tap"}',
        'status': 'tool_unavailable',
        'error': '工具不可用：未授权无障碍服务',
        'hint': '去系统设置开无障碍',
        'needs_auth': 'accessibility',
        'capability_note': '',
        'args': <String, dynamic>{'x': 1},
        'result': <String, dynamic>{},
      });

      expect(entry.status, ConsoleStatus.toolUnavailable);
      expect(entry.isAmoo, isTrue);
      expect(entry.needsAuth, 'accessibility');
      expect(entry.error, contains('未授权无障碍'));
      // 请求原文必须原样保留，否则记录无法复现。
      expect(entry.raw, '{"tool":"ui_tap"}');
    });

    test('缺字段不炸，按最保守的来', () {
      final entry = ConsoleEntry.fromMap(<String, dynamic>{});
      // 没有 status 时不能变成 ok。
      expect(entry.status, ConsoleStatus.unknown);
      expect(entry.isAmoo, isFalse);
      expect(entry.tool, isEmpty);
    });

    test('origin 是没见过的新值时按手动算，不按 Amoo 算', () {
      // 方向很重要：把别人发的命令记成 Amoo，用户会以为是本机助手干的；
      // 记成手动，最多是徽标显示得保守一点。所以未知值必须落到保守那侧。
      //
      // 与上面「命令来源」那条的分工：那条测的是 consoleOriginLabel('') 和
      // (null)——空值与缺失；这里测的是 ConsoleEntry.isAmoo 对**非空但没见过**
      // 的值的反应。isAmoo 是另一个判断（origin == 'amoo'），上面那条碰不到它，
      // 而它才是决定徽标显示成「手动」还是「Amoo」的那一个。
      for (final origin in ['pc', 'remote', 'AMOO', 'amoo ']) {
        final entry = ConsoleEntry.fromMap(<String, dynamic>{
          'origin': origin,
          'tool': 'ping',
          'raw': '{"tool":"ping"}',
          'status': 'ok',
        });
        expect(entry.isAmoo, isFalse,
            reason: '未知 origin "$origin" 必须按手动算，不能按 Amoo 算');
      }
      // 而正确的值仍然要认得出，别为了保守把真的 Amoo 也否了。
      final amoo = ConsoleEntry.fromMap(<String, dynamic>{
        'origin': 'amoo',
        'tool': 'ping',
        'raw': '{"tool":"ping"}',
        'status': 'ok',
      });
      expect(amoo.isAmoo, isTrue);
    });

    test('exec 的能力受限标注原样带出来', () {
      // 这是硬性约束 2 的落点：exec 以 App 身份跑的时候必须说出来，
      // 不能假装能写系统。
      final entry = ConsoleEntry.fromMap(<String, dynamic>{
        'status': 'ok',
        'tool': 'exec',
        'capability_note': '以 App 身份运行（未提权）：input / am / pm 会因权限不足而无操作',
      });
      expect(entry.capabilityNote, contains('未提权'));
      expect(entry.capabilityNote, contains('input'));
    });
  });

  group('ConsoleTool 示例命令', () {
    test('必填参数都填进示例，且类型正确', () {
      final tool = ConsoleTool.fromMap(<String, dynamic>{
        'name': 'ui_tap',
        'desc': '按坐标点击',
        'group': '界面',
        'required': <dynamic>[
          <dynamic>['x', 'number'],
          <dynamic>['y', 'number'],
        ],
        'optional': <dynamic>[],
        'one_of': <dynamic>[],
        'needs_a11y': true,
        'available': false,
      });

      expect(tool.name, 'ui_tap');
      expect(tool.needsA11y, isTrue);
      expect(tool.available, isFalse);
      // 坐标类参数给数字而不是字符串——给错了类型反而误导用户。
      final sample = tool.sample;
      expect(sample, contains('"x":100'));
      expect(sample, contains('"y":100'));
    });

    test('没有必填参数的工具也能给出示例', () {
      final tool = ConsoleTool.fromMap(<String, dynamic>{
        'name': 'ping',
        'required': <dynamic>[],
        'one_of': <dynamic>[],
      });
      expect(tool.sample, contains('"tool":"ping"'));
    });

    test('二选一参数取第一个填示例', () {
      final tool = ConsoleTool.fromMap(<String, dynamic>{
        'name': 'ui_click',
        'required': <dynamic>[],
        'one_of': <dynamic>['text', 'id'],
      });
      expect(tool.sample, contains('"text"'));
    });
  });
}
