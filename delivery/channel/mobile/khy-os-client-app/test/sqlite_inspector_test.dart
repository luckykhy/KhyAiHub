// 应用数据浏览器的 SQLite 一侧：路径换算判据。
//
// 这个文件补的是一个**零测试**的缺口。`lib/core/vfs` 下 27 个源文件里，
// `sqlite_inspector.dart` 是唯一一个既没有同名测试、也没有任何测试 import 它的。
// 而它干的活——「把容器虚拟路径换算成真实路径」——正是「打不开数据库」这类
// 故障的根因位置：换算错一点，sqflite 就去撞一个不存在的文件，
// 用户看到的是「打不开」，没有任何线索指向「路径拼错了」。
//
// 判据抽成纯函数（SqlitePaths）之后才能在单元测试里钉死。三个方向：
//   1. 正常路径换算对（容器内 → 容器根 + 相对段）；
//   2. **边界路径不算容器内**（/khyos/containerX 是用户自建目录，不是容器）；
//   3. 缺容器根 / 不在容器内 → null（调用方据此抛错，而不是拼个错路径）。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/sqlite_inspector.dart';
import 'package:khy_os_client/core/vfs/vfs_route.dart';
import 'package:path/path.dart' as p;

void main() {
  const root = '/data/user/0/com.khyos.khy_os_client/files/khy-os/container';

  group('容器 tmp 落点', () {
    test('库文件落在容器 tmp 下，用归一化后的名字', () {
      expect(
        SqlitePaths.scratchFor('/data/data/com.foo/databases/app.db'),
        '/khyos/container/tmp/app.db',
      );
    });

    test('奇怪写法归一后仍是同一个落点', () {
      // 反斜杠、重复斜杠、./ 前缀都该被折叠掉——落点只能有一个。
      expect(
        SqlitePaths.scratchFor(r'\data\data\com.foo\databases\app.db'),
        '/khyos/container/tmp/app.db',
      );
      expect(
        SqlitePaths.scratchFor('/data/data/com.foo/./databases//app.db'),
        '/khyos/container/tmp/app.db',
      );
    });
  });

  group('虚拟路径 → 真实路径', () {
    // 期望值也用 p.join：这里要验的是「根 + 相对段拼对了」，不是分隔符风格
    // （p.join 在 Windows 测试宿主上用 \，在 Android 真机上是 /）。
    test('容器内的路径换算成容器根 + 相对段', () {
      expect(
        SqlitePaths.realFromVirtual('/khyos/container/tmp/app.db', root),
        p.join(root, 'tmp/app.db'),
      );
    });

    test('深层嵌套也一级不丢', () {
      expect(
        SqlitePaths.realFromVirtual('/khyos/container/tmp/a/b/c.db', root),
        p.join(root, 'tmp/a/b/c.db'),
      );
    });

    test('容器根本身也算容器内（isUnder 的相等分支）', () {
      expect(SqlitePaths.realFromVirtual('/khyos/container', root), root);
    });

    test('名字像容器但不是容器的路径，不算容器内', () {
      // /khyos/containerX 是用户自己建的目录。字符串前缀匹配会把它算成
      // 容器内，于是真实路径被拼到容器根底下——sqflite 去撞一个不存在
      // 的文件，用户只看到「打不开」。
      expect(
        SqlitePaths.realFromVirtual('/khyos/containerX/tmp/app.db', root),
        isNull,
      );
      expect(
        SqlitePaths.realFromVirtual('/khyos/containerfoo', root),
        isNull,
      );
    });

    test('完全不在容器下的路径不算容器内', () {
      expect(
        SqlitePaths.realFromVirtual('/storage/emulated/0/app.db', root),
        isNull,
      );
      expect(
        SqlitePaths.realFromVirtual('/data/data/com.foo/app.db', root),
        isNull,
      );
    });

    test('容器根为空时无从换算，返回 null', () {
      // 空根意味着原生没给出容器根（提权代理 没起来 / status 读不到）。
      // 此时拼出来的会是「相对路径」，sqflite 会拿它当 cwd 相对路径——
      // 又是一个「打不开但不知道为啥」。
      expect(SqlitePaths.realFromVirtual('/khyos/container/tmp/a.db', ''), isNull);
    });
  });

  group('判据用的是已有的段级比较', () {
    test('VfsPath.isUnder 按段比，不做字符串前缀', () {
      // 这条钉的是「复用了仓库里那个已经测过的判据」，而不是自己又写一遍。
      expect(VfsPath.isUnder('/khyos/container/tmp/a', VfsRoots.container), isTrue);
      expect(VfsPath.isUnder('/khyos/containerX/tmp/a', VfsRoots.container), isFalse);
    });
  });
}
