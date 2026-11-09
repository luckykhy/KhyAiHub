// 自动化脚本执行器的判据测试。
//
// 重点是**脚本执行时的路径护栏**：脚本是文件，用户可能手改过它，也可能从别处
// 拷进来。一个被改坏的脚本不该有能力去删系统目录——护栏在执行器里重判一遍，
// 不因为「脚本是自己录的」就放行。

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/automation_runner.dart';
import 'package:khy_os_client/core/vfs/automation_script.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/vfs');
  final calls = <MethodCall>[];

  void mockChannel(Object? Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return handler(call);
    });
  }

  setUp(() {
    calls.clear();
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  AutomationScript scriptWith(AutomationStep step) => AutomationScript(
        id: 's1',
        name: '测试',
        steps: <AutomationStep>[step],
      );

  group('路径护栏', () {
    test('相对路径被拒', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      final result = await AutomationRunner.run(
        scriptWith(const AutomationStep(
          op: 'copy',
          args: <String, dynamic>{'src': 'relative/path', 'dst': '/b'},
        )),
      );
      expect(result.allOk, isFalse);
      expect(result.steps.single.message, contains('绝对路径'));
    });

    test('含 .. 的路径被拒', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      final result = await AutomationRunner.run(
        scriptWith(const AutomationStep(
          op: 'delete',
          args: <String, dynamic>{'path': '/storage/../data'},
        )),
      );
      expect(result.allOk, isFalse);
      expect(result.steps.single.message, contains('..'));
    });

    test('系统分区被拒', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      final result = await AutomationRunner.run(
        scriptWith(const AutomationStep(
          op: 'delete',
          args: <String, dynamic>{'path': '/system/app/thing'},
        )),
      );
      expect(result.allOk, isFalse);
      expect(result.steps.single.message, contains('系统分区'));
    });

    test('不认识的操作类型被拒', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      final result = await AutomationRunner.run(
        scriptWith(const AutomationStep(op: 'format_disk')),
      );
      expect(result.allOk, isFalse);
      expect(result.steps.single.message, contains('不认识的步骤'));
    });
  });

  group('执行', () {
    test('复制步骤会真的发出 copy 调用', () async {
      mockChannel((call) => <String, dynamic>{'ok': true, 'skipped': false});
      final result = await AutomationRunner.run(
        scriptWith(const AutomationStep(
          op: 'copy',
          args: <String, dynamic>{
            'src': '/storage/emulated/0/a.txt',
            'dst': '/storage/emulated/0/b.txt',
          },
        )),
      );
      expect(result.allOk, isTrue);
      expect(calls.any((MethodCall call) => call.method == 'copy'), isTrue);
    });

    test('一步失败不阻断后面的步骤', () async {
      mockChannel((call) {
        if (call.method == 'copy') {
          return <String, dynamic>{'ok': false, 'error': 'denied', 'message': '被拒'};
        }
        return <String, dynamic>{'ok': true};
      });
      final result = await AutomationRunner.run(
        AutomationScript(
          id: 's1',
          name: '两步',
          steps: <AutomationStep>[
            const AutomationStep(
              op: 'copy',
              args: <String, dynamic>{
                'src': '/storage/emulated/0/a.txt',
                'dst': '/storage/emulated/0/b.txt',
              },
            ),
            const AutomationStep(
              op: 'mkdir',
              args: <String, dynamic>{'path': '/storage/emulated/0/New'},
            ),
          ],
        ),
      );
      expect(result.steps, hasLength(2));
      expect(result.steps[0].ok, isFalse);
      expect(result.steps[1].ok, isTrue);
      expect(result.doneCount, 1);
      expect(result.failedCount, 1);
    });
  });
}
