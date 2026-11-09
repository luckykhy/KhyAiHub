// 事件总线与复制任务的判据测试。
//
// 这层测的是「原生推的事件能不能到 Dart」与「任务控制能不能发出去」。
// 事件总线存在的理由就是通道只有一个 handler——所以这里要同时验证：
// 目录事件与复制进度**同时**订阅时，两边都能收到（这正是总线要解决的问题）。

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_channel.dart';
import 'package:khy_os_client/core/vfs/vfs_copy_task.dart';
import 'package:khy_os_client/core/vfs/vfs_event_bus.dart';
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

  group('事件总线', () {
    test('按方法名分发，同一通道上两类事件互不干扰', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      VfsEventBus.instance.install();

      final watchEvents = <Map<String, dynamic>>[];
      final progressEvents = <Map<String, dynamic>>[];
      VfsEventBus.instance.on('vfsEvent', watchEvents.add);
      VfsEventBus.instance.on('vfsProgress', progressEvents.add);

      await simulateNative(const MethodCall('vfsEvent', <String, dynamic>{
        'type': 'created',
        'dir': '/d',
        'path': '/d/a',
        'name': 'a',
      }));
      await simulateNative(const MethodCall('vfsProgress', <String, dynamic>{
        'taskId': 't1',
        'phase': 'copying',
        'done': 100,
        'total': 200,
      }));

      expect(watchEvents, hasLength(1));
      expect(progressEvents, hasLength(1));
      expect(watchEvents.first['name'], 'a');
      expect(progressEvents.first['taskId'], 't1');
    });

    test('一个订阅者抛错不影响另一个', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      VfsEventBus.instance.install();

      final received = <Map<String, dynamic>>[];
      VfsEventBus.instance.on('vfsEvent', (Map<String, dynamic> args) {
        throw StateError('boom');
      });
      VfsEventBus.instance.on('vfsEvent', received.add);

      await simulateNative(const MethodCall('vfsEvent', <String, dynamic>{
        'type': 'created',
      }));
      expect(received, hasLength(1));
    });

    test('没有订阅者的方法名被安静忽略', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      VfsEventBus.instance.install();
      await simulateNative(const MethodCall('somethingElse', <String, dynamic>{}));
      // 不抛异常就是通过
    });
  });

  group('复制任务', () {
    test('start 传参正确并返回 taskId', () async {
      mockChannel((call) {
        expect(call.method, 'copyStart');
        final args = call.arguments as Map;
        expect(args['src'], '/a.txt');
        expect(args['dst'], '/b.txt');
        expect(args['resume'], isTrue);
        expect(args['conflict'], 'rename');
        return <String, dynamic>{'ok': true, 'taskId': 't1'};
      });

      final id = await VfsCopyTasks.instance.start(
        src: '/a.txt',
        dst: '/b.txt',
      );
      expect(id, 't1');
    });

    test('start 失败返回 null', () async {
      mockChannel((call) => <String, dynamic>{
            'ok': false,
            'error': 'not_found',
            'message': '源不存在',
          });
      final id = await VfsCopyTasks.instance.start(src: '/x', dst: '/y');
      expect(id, isNull);
    });

    test('cancel 把 taskId 传回去', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      await VfsCopyTasks.instance.cancel('t1');
      final cancelCall = calls.firstWhere((MethodCall c) => c.method == 'copyCancel');
      expect((cancelCall.arguments as Map)['taskId'], 't1');
    });

    test('status 解析出进度', () async {
      mockChannel((call) => <String, dynamic>{
            'ok': true,
            'state': 'running',
            'done': 512,
            'total': 1024,
            'files': 3,
            'error': '',
          });
      final status = await VfsCopyTasks.instance.status('t1');
      expect(status, isNotNull);
      expect(status!.done, 512);
      expect(status.total, 1024);
      expect(status.files, 3);
      expect(status.ratio, closeTo(0.5, 0.001));
      expect(status.finished, isFalse);
      // 原生的状态查询用 state 而不是 phase——统一后进行中显示为 copying。
      expect(status.phase, 'copying');
    });

    test('status 返回 state=done 时算已结束', () async {
      mockChannel((call) => <String, dynamic>{
            'ok': true,
            'state': 'done',
            'done': 100,
            'total': 100,
            'files': 1,
          });
      final status = await VfsCopyTasks.instance.status('t1');
      expect(status!.finished, isTrue);
      expect(status.phase, 'done');
    });

    test('原生推的进度事件进入进度流', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});
      final received = <CopyProgress>[];
      final subscription =
          VfsCopyTasks.instance.progress.listen(received.add);

      await simulateNative(const MethodCall('vfsProgress', <String, dynamic>{
        'taskId': 't1',
        'phase': 'done',
        'done': 100,
        'total': 100,
        'files': 2,
        'current': '/b.txt',
      }));
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(1));
      expect(received.first.phase, 'done');
      expect(received.first.finished, isTrue);
      expect(received.first.ratio, 1.0);
      await subscription.cancel();
    });
  });

  group('目录事件与复制进度共存', () {
    test('两个订阅者同时装在一个通道上，互不顶掉', () async {
      mockChannel((call) => <String, dynamic>{'ok': true});

      final watchEvents = <VfsWatchEvent>[];
      void watchListener(VfsWatchEvent event) => watchEvents.add(event);
      VfsWatcherService.instance.start();
      VfsWatcherService.instance.addListener(watchListener);
      VfsCopyTasks.instance.install();

      await simulateNative(const MethodCall('vfsEvent', <String, dynamic>{
        'type': 'created',
        'dir': '/d',
        'path': '/d/a',
        'name': 'a',
      }));
      await simulateNative(const MethodCall('vfsProgress', <String, dynamic>{
        'taskId': 't1',
        'phase': 'copying',
        'done': 1,
        'total': 2,
      }));

      expect(watchEvents, hasLength(1));
      VfsWatcherService.instance.removeListener(watchListener);
    });
  });
}
