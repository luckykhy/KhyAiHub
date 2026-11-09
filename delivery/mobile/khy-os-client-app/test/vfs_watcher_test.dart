// 目录事件监听（Dart 侧）的判据测试。
//
// 钉的是**事件通路**这一段：原生推来的 `vfsEvent` 要能被 Dart 收到、
// 分发给监听者，并且带出正确的字段。原生侧的去抖与合并是另一段逻辑，
// 由原生自己测（那边没有 JVM 测试基建，所以只能靠真机验证）。

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_channel.dart';
import 'package:khy_os_client/core/vfs/vfs_watcher.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel(kVfsChannelName);
  final calls = <MethodCall>[];

  void mockChannel(Object? Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return handler(call);
    });
  }

  /// 模拟原生 → Dart 的调用。
  Future<void> simulateNative(MethodCall call) async {
    await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .handlePlatformMessage(
      kVfsChannelName,
      const StandardMethodCodec().encodeMethodCall(call),
      (_) {},
    );
  }

  setUp(() => calls.clear());

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    VfsChannel.setEventHandler(null);
  });

  group('监听控制', () {
    test('watchStart 传目录与脚本 id，返回 watchId', () async {
      mockChannel((call) {
        expect(call.method, 'watchStart');
        final args = call.arguments as Map;
        expect(args['dir'], '/storage/emulated/0/Download');
        expect(args['scriptId'], 'script-1');
        return <String, dynamic>{'ok': true, 'watchId': 'w1'};
      });

      final result = await VfsWatcherService.instance.watch(
        '/storage/emulated/0/Download',
        scriptId: 'script-1',
      );
      expect(result.ok, isTrue);
      expect(result.watchId, 'w1');
    });

    test('watchStart 失败时带原因（路径错 vs 需要 Shizuku）', () async {
      mockChannel((call) => <String, dynamic>{
            'ok': false,
            'error': 'denied',
            'message': '该目录需 Shizuku，当前只支持公共存储目录的事件监听',
          });
      final result = await VfsWatcherService.instance.watch('/data/data/com.foo');
      expect(result.ok, isFalse);
      expect(result.error, 'denied');
      expect(result.displayMessage, contains('Shizuku'));
    });

    test('watchStart 回了 ok 但没给 watchId 也算失败', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      final result = await VfsWatcherService.instance.watch('/d');
      expect(result.ok, isFalse);
    });

    test('watchList 解析监听项', () async {
      mockChannel((call) => <String, dynamic>{
            'ok': true,
            'watches': <dynamic>[
              <String, dynamic>{
                'watchId': 'w1',
                'dir': '/storage/emulated/0/Download',
                'scriptId': 'script-1',
              },
            ],
          });
      final watches = await VfsWatcherService.instance.list();
      expect(watches, hasLength(1));
      expect(watches.first.watchId, 'w1');
      expect(watches.first.scriptId, 'script-1');
    });

    test('watchStop 会把 watchId 传回去', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      await VfsWatcherService.instance.stop('w1');
      final stopCall = calls.firstWhere((MethodCall c) => c.method == 'watchStop');
      expect((stopCall.arguments as Map)['watchId'], 'w1');
    });
  });

  group('事件分发', () {
    test('原生推来的 vfsEvent 会被分发给监听者', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      VfsWatcherService.instance.start();

      final received = <VfsWatchEvent>[];
      void listener(VfsWatchEvent event) => received.add(event);
      VfsWatcherService.instance.addListener(listener);

      await simulateNative(const MethodCall('vfsEvent', <String, dynamic>{
        'type': 'created',
        'dir': '/storage/emulated/0/Download',
        'path': '/storage/emulated/0/Download/app.apk',
        'name': 'app.apk',
      }));

      expect(received, hasLength(1));
      expect(received.first.type, 'created');
      expect(received.first.name, 'app.apk');
      expect(received.first.path, '/storage/emulated/0/Download/app.apk');

      VfsWatcherService.instance.removeListener(listener);
    });

    test('不是 vfsEvent 的原生调用被忽略', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      VfsWatcherService.instance.start();

      final received = <VfsWatchEvent>[];
      void listener(VfsWatchEvent event) => received.add(event);
      VfsWatcherService.instance.addListener(listener);

      await simulateNative(const MethodCall('somethingElse', <String, dynamic>{}));
      expect(received, isEmpty);

      VfsWatcherService.instance.removeListener(listener);
    });

    test('一个监听者抛错不影响其它监听者', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      VfsWatcherService.instance.start();

      final received = <VfsWatchEvent>[];
      void bad(VfsWatchEvent event) => throw StateError('boom');
      void good(VfsWatchEvent event) => received.add(event);
      VfsWatcherService.instance.addListener(bad);
      VfsWatcherService.instance.addListener(good);

      await simulateNative(const MethodCall('vfsEvent', <String, dynamic>{
        'type': 'deleted',
        'dir': '/d',
        'path': '/d/x',
        'name': 'x',
      }));

      expect(received, hasLength(1));

      VfsWatcherService.instance.removeListener(bad);
      VfsWatcherService.instance.removeListener(good);
    });
  });
}
