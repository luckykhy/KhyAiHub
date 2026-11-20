import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';
import 'package:khy_os_client/core/toolhost/tool_host_client.dart';

void main() {
  // ToolHostClient 是 Driver → Tool Host 的唯一门。这组测试钉两件事：
  // 能力清单来自注册表快照（driver 不得自维护清单），未注册名拒绝执行
  // 而不是降级成别的工具。
  group('ToolHostClient', () {
    late ToolEngine engine;
    late ToolHostClient client;

    setUp(() {
      engine = ToolEngine();
      engine.registerAll([
        ToolDef(
          name: 'ls',
          description: '列目录',
          inputSchema: const {
            'type': 'object',
            'properties': {'path': {'type': 'string'}},
          },
          execute: (args) async => ToolResult.ok('entries for ${args['path']}'),
        ),
        ToolDef(
          name: 'shot',
          description: '截屏',
          inputSchema: const {'type': 'object', 'properties': {}},
          execute: (args) async => ToolResult.ok('b64...'),
        ),
      ]);
      client = ToolEngineHostClient(engine);
    });

    test('capabilities() 与引擎注册表一致', () {
      final names = client.capabilities().map((c) => c.name).toList()..sort();
      expect(names, ['ls', 'shot']);
    });

    test('未注册名抛 UnregisteredCapabilityError，不静默执行', () async {
      expect(
        () => client.invoke('amoo_secret_tool', const {}),
        throwsA(isA<UnregisteredCapabilityError>()),
      );
    });

    test('已注册名执行并带回结果', () async {
      final r = await client.invoke('ls', {'path': '/sdcard'});
      expect(r.success, true);
      expect(r.output, contains('/sdcard'));
    });

    test('错误信息里列出可用名字（模型改错名时能自己纠正）', () async {
      // invoke 是异步的：拒绝执行以 Future 失败的形式回来，断言要挂在
      // Future 上——同步 try/catch 抓不到一个还没 await 的 Future 的错。
      try {
        await client.invoke('list_files', const {});
        fail('应当抛错');
      } on UnregisteredCapabilityError catch (e) {
        expect(e.toString(), contains('ls'));
        expect(e.toString(), contains('shot'));
      }
    });
  });
}
