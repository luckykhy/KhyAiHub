// 定时规格、逐步执行、AI 脚本校验、shell 输出解析的判据测试。
//
// 这几样都是「看起来对、错了很安静」的东西：
//   - 定时规格解析错 → 脚本在用户不知道的时候乱跑；
//   - AI 脚本校验松 → 模型一句「删除所有」就成了一段可执行的脚本；
//   - shell 输出解析错 → 精简清单按随机序排，看着还挺正常。

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/ai_script_generator.dart';
import 'package:khy_os_client/core/vfs/app_manager.dart';
import 'package:khy_os_client/core/vfs/automation_scheduler.dart';
import 'package:khy_os_client/core/vfs/automation_script.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/vfs');

  void mockChannel(Object? Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      return handler(call);
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('定时规格', () {
    test('every 形式', () {
      final spec = ScheduleSpec.parse('every 15m');
      expect(spec, isNotNull);
      expect(spec!.interval, const Duration(minutes: 15));
      expect(spec.label, '每 15 分钟');    });

    test('every 支持秒/小时/天', () {
      expect(ScheduleSpec.parse('every 30s')!.interval,
          const Duration(seconds: 30));
      expect(ScheduleSpec.parse('every 2h')!.interval,
          const Duration(hours: 2));
      expect(ScheduleSpec.parse('every 1d')!.interval,
          const Duration(days: 1));
    });

    test('daily 形式', () {
      final spec = ScheduleSpec.parse('daily 08:30');
      expect(spec, isNotNull);
      expect(spec!.hour, 8);
      expect(spec.minute, 30);
      expect(spec.label, '每天 08:30');
    });

    test('认不出来就是认不出来', () {
      expect(ScheduleSpec.parse('随便什么时候'), isNull);
      expect(ScheduleSpec.parse('every 0m'), isNull);
      expect(ScheduleSpec.parse('every 15x'), isNull);
      expect(ScheduleSpec.parse('daily 25:00'), isNull);
      expect(ScheduleSpec.parse(''), isNull);
    });

    test('到点判定：间隔型看距上次，daily 看今天这个点是否已过', () {
      final now = DateTime(2026, 11, 9, 10, 0);
      final interval = ScheduleSpec.parse('every 15m')!;
      expect(interval.nextDelay(now), const Duration(minutes: 15));

      final daily = ScheduleSpec.parse('daily 08:00')!;
      // 今天 08:00 已过 → 下一次是明天
      final delay = daily.nextDelay(now)!;
      expect(delay.inHours, 22);
    });
  });

  group('AI 脚本校验', () {
    test('合法脚本被接受', () {
      final result = AiScriptGenerator.parse(
        '{"name":"搬文件","steps":[{"op":"copy","args":'
        '{"src":"/sdcard/a.txt","dst":"/sdcard/b.txt"}}]}',
      );
      expect(result.ok, isTrue);
      expect(result.script!.name, '搬文件');
      expect(result.script!.steps, hasLength(1));
    });

    test('白名单外的操作类型被拒', () {
      final result = AiScriptGenerator.parse(
        '{"steps":[{"op":"format_disk","args":{"src":"/sdcard"}}]}',
      );
      expect(result.ok, isFalse);
      expect(result.error, contains('白名单'));
    });

    test('相对路径被拒', () {
      final result = AiScriptGenerator.parse(
        '{"steps":[{"op":"delete","args":{"src":"relative/a.txt"}}]}',
      );
      expect(result.ok, isFalse);
    });

    test('系统分区被拒', () {
      final result = AiScriptGenerator.parse(
        '{"steps":[{"op":"delete","args":{"src":"/system/app/x"}}]}',
      );
      expect(result.ok, isFalse);
    });

    test('重命名的目标当成新名字而不是路径', () {
      final result = AiScriptGenerator.parse(
        '{"steps":[{"op":"rename","args":{"src":"/sdcard/a.txt","to":"b.txt"}}]}',
      );
      expect(result.ok, isTrue);
      expect(result.script!.steps.first.args['to'], 'b.txt');
    });

    test('重命名的目标带路径分隔符被拒', () {
      final result = AiScriptGenerator.parse(
        '{"steps":[{"op":"rename","args":{"src":"/sdcard/a.txt","to":"x/b.txt"}}]}',
      );
      expect(result.ok, isFalse);
    });

    test('坏步骤被丢弃，好步骤保留', () {
      final result = AiScriptGenerator.parse(
        '{"steps":['
        '{"op":"format_disk","args":{"src":"/sdcard"}},'
        '{"op":"mkdir","args":{"src":"/sdcard/New"}}]}',
      );
      expect(result.ok, isTrue);
      expect(result.script!.steps, hasLength(1));
      expect(result.script!.steps.first.op, 'mkdir');
    });

    test('不是 JSON 时如实报错', () {
      final result = AiScriptGenerator.parse('随便说点什么');
      expect(result.ok, isFalse);
      expect(result.error, isNotEmpty);
    });
  });

  group('shell 输出解析', () {
    test('解析包名与字节数', () {
      final sizes = AppManager.parseSizeOutput(
        'com.a|1234\ncom.b|0\n\ncom.c|99',
      );
      expect(sizes['com.a'], 1234);
      expect(sizes['com.b'], 0);
      expect(sizes['com.c'], 99);
    });

    test('坏行被跳过而不是让整份清单失败', () {
      final sizes = AppManager.parseSizeOutput('garbage\ncom.a|10\nx|y');
      expect(sizes.length, 1);
      expect(sizes['com.a'], 10);
    });
  });

  group('逐步执行', () {
    test('一次只跑一步，逐步前进', () async {
      mockChannel((call) => <String, dynamic>{'ok': true, 'skipped': false});
      const script = AutomationScript(
        id: 's1',
        name: '两步',
        steps: <AutomationStep>[
          AutomationStep(
            op: 'copy',
            args: <String, dynamic>{
              'src': '/sdcard/a.txt',
              'dst': '/sdcard/b.txt',
            },
          ),
          AutomationStep(
            op: 'mkdir',
            args: <String, dynamic>{'path': '/sdcard/New'},
          ),
        ],
      );

      final runner = AutomationStepRunner(script);
      expect(runner.totalCount, 2);
      expect(runner.doneCount, 0);
      expect(runner.current!.op, 'copy');

      await runner.step();
      expect(runner.doneCount, 1);
      expect(runner.current!.op, 'mkdir');

      await runner.step();
      expect(runner.finished, isTrue);
      expect(runner.current, isNull);
    });
  });
}
