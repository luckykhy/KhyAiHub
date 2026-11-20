// 公共存储别名的判据测试。
//
// 为什么要有这个套件：2026-11-09 真机上，用户在地址栏敲 `/sdcard/Download`
// （最常见的写法之一），App 弹「该路径需通过 提权代理 访问，请先激活」——
// 而它就是用户自己的内部存储。
//
// 根因是**两侧判定漂移**：原生侧的权限探测（`VfsWatcher.storageProbe`）早就把
// `/sdcard` 换成 `/storage/emulated/0` 再去问权限了，Dart 侧的路径归一化却
// 不知道这件事，于是 `/sdcard/...` 落进「陌生路径 → shell 兜底档」。
//
// 这不只是体验问题：原生侧的共享存储权限判据是 `real.startsWith("/storage/")`，
// `/sdcard/...` 匹配不上 → **权限检查被绕过**。所以别名折叠必须落在
// `VfsPath.normalize` 这一个漏斗里，不能散在调用点。
//
// 判据是纯函数，测试不需要设备。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_route.dart';

void main() {
  group('公共存储别名折叠', () {
    test('/sdcard 换成 /storage/emulated/0', () {
      expect(VfsPath.normalize('/sdcard'), '/storage/emulated/0');
    });

    test('/sdcard 下的子路径跟着换', () {
      expect(
        VfsPath.normalize('/sdcard/Download/khyprobe'),
        '/storage/emulated/0/Download/khyprobe',
      );
    });

    test('/storage/self/primary 也换成真身', () {
      expect(
        VfsPath.normalize('/storage/self/primary/Download'),
        '/storage/emulated/0/Download',
      );
    });

    test('别名折叠发生在语法归一化之后（重复斜杠、尾斜杠一并处理）', () {
      expect(VfsPath.normalize('/sdcard//Download/'), '/storage/emulated/0/Download');
    });

    test('只按整段换：/sdcardX 是用户自建目录，不是别名', () {
      expect(VfsPath.normalize('/sdcardX/a'), '/sdcardX/a');
      expect(VfsPath.normalize('/sdcardX'), '/sdcardX');
    });

    test('别名段中间出现的也不换（只有前缀位置才算）', () {
      expect(
        VfsPath.normalize('/data/sdcard/a'),
        '/data/sdcard/a',
      );
    });

    test('非别名的路径原样不动', () {
      expect(VfsPath.normalize('/system/app'), '/system/app');
      expect(VfsPath.normalize('/data/data/com.foo'), '/data/data/com.foo');
      expect(VfsPath.normalize('/khyos/container'), '/khyos/container');
    });
  });

  group('别名折叠后的路由档位', () {
    test('/sdcard 走 storage 通道，不需要 提权代理', () {
      final route = VfsRouter.route('/sdcard/Download');
      expect(route.via, VfsVia.storage);
      expect(route.tier, VfsTier.basic);
      expect(route.available, isTrue,
          reason: '用户的内部存储不该要求提权——真机上这里弹了「需通过 提权代理 访问」');
    });

    test('/sdcard 与 /storage/emulated/0 判出同一个档', () {
      final alias = VfsRouter.route('/sdcard/Download');
      final real = VfsRouter.route('/storage/emulated/0/Download');
      expect(alias.via, real.via);
      expect(alias.tier, real.tier);
      expect(alias.available, real.available);
    });

    test('/storage/self/primary 同样走 storage 通道', () {
      final route = VfsRouter.route('/storage/self/primary/Download');
      expect(route.via, VfsVia.storage);
      expect(route.available, isTrue);
    });

    test('别名不影响私有目录与系统分区的判定', () {
      expect(VfsRouter.route('/data/data/com.foo').via, VfsVia.shell);
      expect(VfsRouter.route('/system/app').readOnly, isTrue);
    });
  });
}
