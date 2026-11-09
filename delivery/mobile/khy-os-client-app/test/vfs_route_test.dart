// VFS 路由与路径文法的判据测试。
//
// 这些是纯函数，所以测试不需要任何设备环境——路由写错的后果是「有的路径能开有的
// 不能开且没有报错」，那是最难查的一类 bug，必须用最硬的判据钉住。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_route.dart';

void main() {
  group('VfsPath 归一化', () {
    test('空串与根等价', () {
      expect(VfsPath.normalize(''), '/');
      expect(VfsPath.normalize('   '), '/');
      expect(VfsPath.normalize('/'), '/');
    });

    test('折叠重复斜杠与尾斜杠', () {
      expect(VfsPath.normalize('/storage//emulated/0/'), '/storage/emulated/0');
      expect(VfsPath.normalize('/storage///emulated'), '/storage/emulated');
    });

    test('消解 . 与 ..', () {
      expect(VfsPath.normalize('/storage/emulated/0/../1'), '/storage/emulated/1');
      expect(VfsPath.normalize('/storage/./emulated'), '/storage/emulated');
    });

    test('.. 越过根时停在根，不产生越界路径', () {
      expect(VfsPath.normalize('/../..'), '/');
      expect(VfsPath.normalize('/storage/../../etc'), '/etc');
      expect(VfsPath.normalize('/../../data/data'), '/data/data');
    });

    test('父目录与末段名', () {
      expect(VfsPath.parent('/storage/emulated/0'), '/storage/emulated');
      expect(VfsPath.parent('/storage'), '/');
      expect(VfsPath.parent('/'), '/');
      expect(VfsPath.basename('/storage/emulated/0'), '0');
      expect(VfsPath.basename('/'), '/');
    });

    test('拼接', () {
      expect(VfsPath.join('/storage/emulated/0', 'Download'), '/storage/emulated/0/Download');
      expect(VfsPath.join('/', 'Download'), '/Download');
      expect(VfsPath.join('/a', '/b'), '/b');
    });

    test('前缀判定按段比较，不做字符串前缀', () {
      expect(VfsPath.isUnder('/data/data/com.foo', '/data/data'), isTrue);
      expect(VfsPath.isUnder('/data/database/x', '/data/data'), isFalse);
    });
  });

  group('VfsRouter 路由判据', () {
    test('虚拟根没有通道', () {
      final route = VfsRouter.route('/');
      expect(route.isRoot, isTrue);
      expect(route.tier, VfsTier.basic);
    });

    test('公共存储走 storage 通道', () {
      final route = VfsRouter.route('/storage/emulated/0');
      expect(route.via, VfsVia.storage);
      expect(route.tier, VfsTier.basic);
      expect(route.available, isTrue);
    });

    test('容器空间走 storage 通道且不需要提权', () {
      final route = VfsRouter.route('/khyos/container');
      expect(route.via, VfsVia.storage);
      expect(route.tier, VfsTier.container);
      expect(route.available, isTrue);
    });

    test('应用私有目录走 shell 通道且需要 Shizuku', () {
      final without = VfsRouter.route('/data/data/com.foo');
      expect(without.via, VfsVia.shell);
      expect(without.tier, VfsTier.privateData);
      expect(without.available, isFalse);
      expect(without.unavailableReason, contains('Shizuku'));

      final withShizuku =
          VfsRouter.route('/data/data/com.foo', shizukuAvailable: true);
      expect(withShizuku.available, isTrue);
      expect(withShizuku.unavailableReason, isNull);
    });

    test('系统分区恒为只读', () {
      final route = VfsRouter.route('/system/app', shizukuAvailable: true);
      expect(route.readOnly, isTrue);
      expect(route.tier, VfsTier.systemRead);
      expect(VfsRouter.canWrite(route), isFalse);
    });

    test('安全模式下高级档位一律不可用', () {
      final privateRoute = VfsRouter.route('/data/data/com.foo', safeMode: true);
      expect(privateRoute.available, isFalse);
      expect(privateRoute.unavailableReason, contains('安全模式'));

      final systemRoute =
          VfsRouter.route('/system', shizukuAvailable: true, safeMode: true);
      expect(systemRoute.available, isFalse);

      final basicRoute = VfsRouter.route('/storage/emulated/0', safeMode: true);
      expect(basicRoute.available, isTrue);
    });

    test('容器在安全模式下也保留（它是宿主内普通目录）', () {
      final route = VfsRouter.route('/khyos/container', safeMode: true);
      expect(route.available, isTrue);
    });

    test('不可用的路由不允许写', () {
      final route = VfsRouter.route('/data/data/com.foo');
      expect(VfsRouter.canWrite(route), isFalse);
    });
  });
}
