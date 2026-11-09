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

  /// 造一个「Shizuku 已就绪」的 status 响应。
  Map<String, dynamic> statusMap({
    bool shizuku = true,
    bool storage = true,
  }) =>
      <String, dynamic>{
        'ok': true,
        'storageGranted': storage,
        'safeMode': false,
        'shizuku': <String, dynamic>{
          'installed': shizuku,
          'running': shizuku,
          'version': '13.1.5',
          'available': shizuku,
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

    test('私有目录 → 公共存储也走 shell（读私有目录要 Shizuku）', () async {
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
    test('Shizuku 不可用时私有目录返回灰态占位符而不是报错', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap(shizuku: false);
        return <String, dynamic>{'ok': true, 'nodes': <dynamic>[]};
      });
      final vfs = VfsService.instance;
      await vfs.status(refresh: true);

      final listing = await vfs.list('/data/data/com.foo');
      expect(listing.locked, isTrue);
      expect(listing.nodes, hasLength(1));
      expect(listing.nodes.first.accessible, isFalse);
      expect(listing.lockReason, contains('Shizuku'));
    });

    test('原生报 shizuku_unavailable 时同样降级为灰态', () async {
      mockChannel((call) {
        if (call.method == 'status') return statusMap(shizuku: false);
        if (call.method == 'list') {
          return <String, dynamic>{
            'ok': false,
            'error': 'shizuku_unavailable',
            'message': 'Shizuku 未激活，无法访问该路径',
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
        if (call.method == 'status') return statusMap(shizuku: false);
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
}
