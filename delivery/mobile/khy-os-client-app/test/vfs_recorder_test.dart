// 操作录制器与自动化脚本的判据测试。
//
// 钉的是「录进来的是什么」：只有用户手动做的写操作进脚本，AI 的操作不进。
// 混进 AI 的操作会让脚本语义变得没法预测——用户看着脚本不知道哪一步是「我做的」。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/automation_script.dart';
import 'package:khy_os_client/core/vfs/operation_recorder.dart';
import 'package:khy_os_client/core/vfs/vfs_audit.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('操作录制器', () {
    setUp(() => OperationRecorder.instance.clear());
    tearDown(() => OperationRecorder.instance.stop());

    test('只录用户手动的写操作', () async {
      final recorder = OperationRecorder.instance;
      recorder.start();

      await VfsAuditLog.instance.record(
        VfsSource.user,
        'copy',
        '/storage/emulated/0/a.txt',
        detail: '/storage/emulated/0/b.txt',
      );
      await VfsAuditLog.instance.record(
        VfsSource.ai,
        'delete',
        '/storage/emulated/0/ai.txt',
      );
      await VfsAuditLog.instance.record(
        VfsSource.user,
        'read',
        '/storage/emulated/0/c.txt',
      );

      expect(recorder.steps, hasLength(1));
      expect(recorder.steps.first.op, 'copy');
      expect(recorder.steps.first.args['src'], '/storage/emulated/0/a.txt');
      expect(recorder.steps.first.args['dst'], '/storage/emulated/0/b.txt');
    });

    test('停止录制后不再收集', () async {
      final recorder = OperationRecorder.instance;
      recorder.start();
      recorder.stop();

      await VfsAuditLog.instance.record(
        VfsSource.user,
        'mkdir',
        '/storage/emulated/0/New',
      );
      expect(recorder.steps, isEmpty);
    });

    test('导出脚本带触发方式与监视目录', () async {
      final recorder = OperationRecorder.instance;
      recorder.start();

      await VfsAuditLog.instance.record(
        VfsSource.user,
        'copy',
        '/storage/emulated/0/Download/a.txt',
        detail: '/storage/emulated/0/Documents/a.txt',
      );

      final script = recorder.export('测试脚本');
      expect(script, isNotNull);
      expect(script!.name, '测试脚本');
      expect(script.trigger, AutomationTrigger.directoryEvent);
      // 监视目录默认取第一步所在目录——「动这个目录时就这样做」是最常见意图。
      expect(script.watchDir, '/storage/emulated/0/Download');
      expect(script.steps, hasLength(1));
    });

    test('没有录到操作时导出返回 null，而不是造一个空脚本', () {
      final recorder = OperationRecorder.instance;
      recorder.start();
      recorder.clear();
      expect(recorder.export('空脚本'), isNull);
    });

    test('导出 JSON 可再解析回来', () {
      const script = AutomationScript(
        id: 'script-1',
        name: '搬运',
        trigger: AutomationTrigger.manual,
        steps: <AutomationStep>[
          AutomationStep(
            op: 'copy',
            args: <String, dynamic>{'src': '/a', 'dst': '/b'},
          ),
        ],
      );
      final json = AutomationScriptStore.export(script);
      final parsed = AutomationScript.fromJson(
        // ignore: unnecessary_cast
        (const JsonCodec().decode(json) as Map<dynamic, dynamic>)
            .cast<String, dynamic>(),
      );
      expect(parsed.name, '搬运');
      expect(parsed.steps, hasLength(1));
      expect(parsed.steps.first.op, 'copy');
      expect(parsed.steps.first.args['dst'], '/b');
    });
  });
}
