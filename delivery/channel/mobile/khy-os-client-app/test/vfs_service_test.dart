// VFS 门面的行为测试（通道打桩）。
//
// 钉三件事：路径决定走哪条通道、权限不足时是「灰态」而不是「报错」、
// 写私有目录需要显式开启高级数据编辑模式。第三条是安全护栏，优先级最高。

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_node.dart';
import 'package:khy_os_client/core/vfs/vfs_policy.dart';
import 'package:khy_os_client/core/vfs/vfs_service.dart';

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

  /// 造一个「提权代理 已就绪」的 status 响应。
  Map<String, dynamic> statusMap({
    bool elevated = true,
    bool storage = true,
  }) =>
      <String, dynamic>{
        'ok': true,
        'storageGranted': storage,
        'safeMode': false,
        'elevation': <String, dynamic>{
          'installed': elevated,
          'running': elevated,
          'version': 'sidecar',
          'available': elevated,
        },
        'containerRoot': '/data/user/0/com.khyos.khy_os_client/files/khy-os/container',
        'containerInstalled': false,
      };

  group('VfsService 路由派发', () {
    test('公共存储用 storage 通道，私有目录用 shell 通道', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        return <String, dynamic>{'ok': true, 'nodes': <dynamic>[]};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);

      await vfs.list('/storage/emulated/0');
      final storageCall = calls.lastWhere((c) => c.method == 'list');
      expect((storageCall.arguments as Map)['via'], 'storage');

      await vfs.list('/data/data/com.foo');
      final shellCall = calls.lastWhere((c) => c.method == 'list');
      expect((shellCall.arguments as Map)['via'], 'shell');
    });

    test('容器空间映射到 storage 通道', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        return <String, dynamic>{'ok': true, 'nodes': <dynamic>[]};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);
      await vfs.list('/khyos/container');
      final listCall = calls.lastWhere((c) => c.method == 'list');
      expect((listCall.arguments as Map)['via'], 'storage');
    });
  });

  group('跨通道复制', () {
    test('公共存储 → 私有目录要走 shell（能读源不等于能写目标）', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        return <String, dynamic>{'ok': true, 'skipped': false};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);
      await vfs.applyPolicy(const VfsPolicy(advancedDataEdit: true));

      await vfs.copy(
        '/storage/emulated/0/a.txt',
        '/data/data/com.foo/files/a.txt',
      );
      final copyCall = calls.lastWhere((c) => c.method == 'copy');
      expect((copyCall.arguments as Map)['via'], 'shell');
    });

    test('两端都在公共存储时用普通 IO，不多要提权', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        return <String, dynamic>{'ok': true, 'skipped': false};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);

      await vfs.copy(
        '/storage/emulated/0/a.txt',
        '/storage/emulated/0/b.txt',
      );
      final copyCall = calls.lastWhere((c) => c.method == 'copy');
      expect((copyCall.arguments as Map)['via'], 'storage');
    });

    test('私有目录 → 公共存储也走 shell（读私有目录要 提权代理）', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        return <String, dynamic>{'ok': true, 'skipped': false};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);
      await vfs.applyPolicy(const VfsPolicy(advancedDataEdit: true));

      await vfs.copy(
        '/data/data/com.foo/files/a.txt',
        '/storage/emulated/0/a.txt',
      );
      final copyCall = calls.lastWhere((c) => c.method == 'copy');
      expect((copyCall.arguments as Map)['via'], 'shell');
    });
  });

  group('降级语义', () {
    test('提权代理 不可用时私有目录返回灰态占位符而不是报错', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap(elevated: false);
        return <String, dynamic>{'ok': true, 'nodes': <dynamic>[]};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);

      final listing = await vfs.list('/data/data/com.foo');
      expect(listing.locked, isTrue);
      expect(listing.nodes, hasLength(1));
      expect(listing.nodes.first.accessible, isFalse);
      expect(listing.lockReason, contains('提权代理'));
    });

    test('原生报 elevation_unavailable 时同样降级为灰态', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap(elevated: false);
        if (call.method == 'list') {
          return <String, dynamic>{
            'ok': false,
            'error': 'elevation_unavailable',
            'message': '提权代理 未激活，无法访问该路径',
          };
        }
        return <String, dynamic>{'ok': true};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);

      final listing = await vfs.list('/data/data/com.foo');
      expect(listing.locked, isTrue);
      expect(listing.nodes.first.accessible, isFalse);
    });
  });

  group('写权限护栏', () {
    test('写应用私有目录默认被拒（未开高级数据编辑）', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        return <String, dynamic>{'ok': true};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);
      await vfs.applyPolicy(const VfsPolicy());

      expect(
        () => vfs.write('/data/data/com.foo/files/a.txt', 'x'),
        throwsA(isA<VfsException>()),
      );
      expect(
        calls.any((c) => c.method == 'write'),
        isFalse,
      );
    });

    test('开启高级数据编辑后允许写私有目录', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        return <String, dynamic>{'ok': true};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);
      await vfs.applyPolicy(const VfsPolicy(advancedDataEdit: true));

      await vfs.write('/data/data/com.foo/files/a.txt', 'x');
      expect(calls.any((c) => c.method == 'write'), isTrue);
    });

    test('写只读分区被拒', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        return <String, dynamic>{'ok': true};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);
      await vfs.applyPolicy(const VfsPolicy(advancedDataEdit: true));

      await expectLater(
        vfs.write('/system/build.prop', 'x'),
        throwsA(
          isA<VfsException>().having(
            (e) => e.error,
            'error',
            'read_only',
          ),
        ),
      );
    });

    test('安全模式下即便开了高级编辑也拒绝写私有目录', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        return <String, dynamic>{'ok': true};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);
      // 恢复现场：`VfsService.instance` 是单例，`policy` 也是它的可变字段。
      // 不恢复的话，安全模式会一直挂着，后面任何依赖 policy 的用例都会被它
      // 影响——这种污染的表现是「某个用例莫名其妙失败」，极难查。
      final previous = vfs.policy;
      addTearDown(() async {
        await vfs.applyPolicy(previous);
      });
      await vfs.applyPolicy(
        const VfsPolicy(safeMode: true, advancedDataEdit: true),
      );

      await expectLater(
        vfs.write('/data/data/com.foo/files/a.txt', 'x'),
        throwsA(isA<VfsException>()),
      );
    });
  });

  group('列表排序', () {
    test('目录排在文件前面，同类按名称', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        if (call.method == 'list') {
          return <String, dynamic>{
            'ok': true,
            'nodes': <dynamic>[
              <String, dynamic>{
                'name': 'b.txt',
                'path': '/storage/emulated/0/b.txt',
                'isDirectory': false,
                'size': 10,
              },
              <String, dynamic>{
                'name': 'Zed',
                'path': '/storage/emulated/0/Zed',
                'isDirectory': true,
              },
              <String, dynamic>{
                'name': 'a.txt',
                'path': '/storage/emulated/0/a.txt',
                'isDirectory': false,
                'size': 20,
              },
            ],
          };
        }
        return <String, dynamic>{'ok': true};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);

      final listing = await vfs.list('/storage/emulated/0');
      expect(
        listing.nodes.map((VfsNode node) => node.name).toList(),
        <String>['Zed', 'a.txt', 'b.txt'],
      );
    });
  });

  group('虚拟根', () {
    test('根目录列出四个入口并带上可访问状态', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap(elevated: false);
        if (call.method == 'mounts') {
          return <String, dynamic>{
            'ok': true,
            'mounts': <dynamic>[
              <String, dynamic>{
                'path': '/storage/emulated/0',
                'type': 'sdcardfs',
                'readOnly': false,
                'available': true,
              },
            ],
          };
        }
        return <String, dynamic>{'ok': true};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);

      final listing = await vfs.list('/');
      final names = listing.nodes.map((node) => node.name).toList();
      expect(names, contains('内部存储'));
      expect(names, contains('应用数据'));
      expect(names, contains('系统目录'));
      expect(names, contains('容器空间'));

      final privateEntry =
          listing.nodes.firstWhere((node) => node.name == '应用数据');
      expect(privateEntry.accessible, isFalse);
    });
  });

  // 目标 §二 要的是「多线程复制/移动」。移动走多线程引擎的判据放在服务层，
  // 不在界面层——AI 计划与自动化脚本也调这个方法，只改界面就只覆盖了一半。
  group('移动的通道分流', () {
    test('公共存储的移动走多线程通道（copyStart），不走 move 通道', () async {
      final methods = <String>[];
      mockChannel((call) {
        methods.add(call.method);
        if (call.method == 'status') return statusMap();
        if (call.method == 'copyStart') {
          return <String, dynamic>{'ok': true, 'taskId': 'task-1'};
        }
        if (call.method == 'copyStatus') {
          return <String, dynamic>{
            'ok': true,
            'state': 'done',
            'done': 1,
            'total': 1,
            'files': 1,
            // 源已经不在了 = 真的搬走了。
            'srcGone': true,
          };
        }
        return <String, dynamic>{'ok': true};
      });

      final skipped = await VfsService.instance.move(
        '/storage/emulated/0/Download/a.txt',
        '/storage/emulated/0/Documents/a.txt',
      );

      expect(skipped, isFalse);
      expect(methods, contains('copyStart'));
      expect(methods, isNot(contains('move')));
    });

    test('源还在原地时算「被跳过」，不谎报移动完成', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap();
        if (call.method == 'copyStart') {
          return <String, dynamic>{'ok': true, 'taskId': 'task-2'};
        }
        if (call.method == 'copyStatus') {
          // 目标已存在、策略是跳过：任务状态是 done，但源根本没动。
          return <String, dynamic>{
            'ok': true,
            'state': 'done',
            'done': 0,
            'total': 0,
            'files': 0,
            'srcGone': false,
          };
        }
        return <String, dynamic>{'ok': true};
      });

      final skipped = await VfsService.instance.move(
        '/storage/emulated/0/Download/a.txt',
        '/storage/emulated/0/Documents/a.txt',
      );

      expect(skipped, isTrue);
    });

    test('应用私有目录的移动走 shell 通道的 move，不走多线程通道', () async {
      final methods = <String>[];
      mockChannel((call) {
        methods.add(call.method);
        if (call.method == 'status') return statusMap();
        if (call.method == 'move') {
          return <String, dynamic>{'ok': true, 'path': '/storage/emulated/0/a.txt'};
        }
        return <String, dynamic>{'ok': true};
      });
      // 写私有目录要显式开「高级数据编辑模式」——移动的源也在护栏里。
      // 这里把 safeMode 也显式写成 false：`VfsService.instance` 是单例，
      // policy 是它的可变字段，别的用例改过就会漏到这里。
      final previous = VfsService.instance.policy;
      VfsService.instance.policy =
          previous.copyWith(advancedDataEdit: true, safeMode: false);
      addTearDown(() => VfsService.instance.policy = previous);
      // status 是带缓存的：前面的用例可能缓存了「提权代理 不可用」，
      // 不刷新的话私有目录会被判成不可访问，测的就不是分流而是缓存了。
      await VfsService.instance.status(refresh: true);

      await VfsService.instance.move(
        '/data/data/com.example.app/files/a.txt',
        '/storage/emulated/0/a.txt',
      );

      expect(methods, contains('move'));
      expect(methods, isNot(contains('copyStart')));
    });
  });
}
