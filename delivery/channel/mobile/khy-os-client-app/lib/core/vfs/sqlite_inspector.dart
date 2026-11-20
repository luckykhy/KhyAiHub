// SQLite 库的结构化查看。
//
// 流程是「**先复制再打开**」，不是直接打开原库：
//   - 原库在别的 App 的私有目录里，那个 App 可能正开着它，直接打开会撞锁；
//   - 复制一份还能顺便避开「只读打开私有目录文件」的各种权限怪癖。
// 复制用 VFS 的通道（私有目录要 提权代理），落点在容器空间下的 tmp 里——
// 那是 App 自己可写的地方。
//
// 打开用 sqflite（只读）。表结构从 sqlite_master 读，每张表取前 N 行。

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import 'vfs_policy.dart';
import 'vfs_route.dart';
import 'vfs_service.dart';

/// 一张表的查看结果。
class SqliteTable {
  final String name;
  final List<String> columns;
  final List<List<Object?>> rows;

  /// 表被截断了（行数超过上限）。
  final bool truncated;

  const SqliteTable({
    required this.name,
    this.columns = const <String>[],
    this.rows = const <List<Object?>>[],
    this.truncated = false,
  });
}

/// 容器虚拟路径 ↔ 真实路径的换算（**纯函数，无通道依赖**）。
///
/// 为什么单独拆出来：这一段判据（「在不在容器内」「相对段怎么切」）是
/// 「打不开数据库」这类故障的根因位置，而它此前住在
/// [SqliteInspector._realPathOf] 里——那个方法要先调 `VfsService.status()`
/// 拿容器根，通道一参与就测不了。抽成纯函数后，`/khyos/containerX` 这种
/// 边界路径能在 JVM/单元测试里直接钉死。
abstract final class SqlitePaths {
  /// 容器空间下的临时目录——复制出来的库落在这里。
  static String get scratchDir => VfsPath.join(VfsRoots.container, 'tmp');

  /// 一个库文件在容器 tmp 下的虚拟落点。
  static String scratchFor(String dbPath) =>
      VfsPath.join(VfsRoots.container, 'tmp/${VfsPath.basename(dbPath)}');

  /// 虚拟路径 → 真实路径。
  ///
  /// 不在容器内、或容器根为空时返回 null（调用方据此抛错，而不是
  /// 返回一个拼错的路径让 sqflite 去撞一个莫名其妙的文件）。
  ///
  /// 判「在不在容器内」用 [VfsPath.isUnder]（按段比），不用裸 `startsWith`：
  /// `/khyos/containerX` 是用户自己建的目录名，不是容器空间。字符串前缀匹配
  /// 会把它也算成容器内，真实路径就被拼到容器根底下。`vfs_route.dart` 的
  /// `_foldStorageAlias` 早就为同一件事写过注释（「不做字符串前缀乱替换」），
  /// 这里不能反过来再用错的那种。
  ///
  /// **切相对段时要把前导 `/` 去掉**：`p.join(base, '/tmp/x')` 会**丢掉 base**
  /// 直接返回 `/tmp/x`（path 包里绝对路径胜出）。少了这一步，换算结果永远是
  /// 一个与容器根无关的绝对路径——sqflite 去撞一个不存在的文件，用户只看到
  /// 「打不开」，而真相是路径拼错了。这个 bug 在抽出纯函数、写上单元测试
  /// 之前**一直存在**（原实现就是 `p.join(root, relative)`，relative 带前导斜杠）。
  static String? realFromVirtual(String virtualPath, String containerRoot) {
    if (containerRoot.isEmpty) return null;
    if (!VfsPath.isUnder(virtualPath, VfsRoots.container)) return null;
    final relative = virtualPath == VfsRoots.container
        ? ''
        : virtualPath.substring(VfsRoots.container.length + 1);
    if (relative.isEmpty) return containerRoot;
    return p.join(containerRoot, relative);
  }
}

/// SQLite 查看器。
abstract final class SqliteInspector {
  /// 每张表最多取多少行。
  static const int maxRows = 50;

  /// 查看一个数据库文件。
  ///
  /// **打不开就抛，不返回空列表**：空列表会被调用方理解成「这个库没有表」，
  /// 而「打不开」和「没有表」是两件完全不同的事——前者要说原因（文件坏了 /
  /// 定位不到真实路径 / sqflite 打不开），后者是个正常结论。
  /// 调用方（`app_data_browser_screen`）本来就在 try/catch 里，抛出去正好
  /// 落到它已有的错误分支上。
  static Future<List<SqliteTable>> inspect(String dbPath) async {
    final scratch = SqlitePaths.scratchFor(dbPath);
    try {
      await VfsService.instance.mkdir(SqlitePaths.scratchDir, parents: true);
      await VfsService.instance.copy(
        dbPath,
        scratch,
        conflict: VfsConflict.overwrite,
      );
    } catch (_) {
      // 复制失败就往下走：也许原库本来就在可读的地方。
    }

    // sqflite 要的是真实路径；容器空间的真实路径由原生侧映射，
    // 这里用已知的容器根拼出来——容器根在 filesDir 下，App 自己能读。
    final real = await _realPathOf(scratch);
    if (real == null) {
      throw const VfsException(
        'not_found',
        '定位不到容器空间的真实路径，打不开这个数据库',
      );
    }

    Database? database;
    try {
      database = await openDatabase(real, readOnly: true);
      return await _readTables(database);
    } catch (error) {
      throw VfsException('unknown', '打不开这个数据库：$error');
    } finally {
      await database?.close();
    }
  }

  static Future<List<SqliteTable>> _readTables(Database database) async {
    final results = <SqliteTable>[];
    final master = await database.rawQuery(
      "SELECT name FROM sqlite_master WHERE type='table' "
      "AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    for (final row in master) {
      final tableName = (row['name'] ?? '').toString();
      if (tableName.isEmpty) continue;
      try {
        final columns = await database.rawQuery('PRAGMA table_info("$tableName")');
        final columnNames = columns
            .map((Map<String, Object?> c) => (c['name'] ?? '').toString())
            .toList();
        final data = await database.rawQuery(
          'SELECT * FROM "$tableName" LIMIT $maxRows',
        );
        results.add(SqliteTable(
          name: tableName,
          columns: columnNames,
          rows: data.map((Map<String, Object?> r) => r.values.toList()).toList(),
        ));
      } catch (_) {
        // 单张表读失败（比如视图权限）就跳过这一张，不影响其它表。
      }
    }
    return results;
  }

  /// 把虚拟路径换成真实路径。
  ///
  /// 容器空间的真实路径 = filesDir/khy-os/container。这里通过一次 stat 拿不到
  /// 真实路径（stat 返回的是虚拟路径），所以走原生给的容器根。
  ///
  /// 判据本身在 [SqlitePaths.realFromVirtual]（纯函数，可测）；这里只负责
  /// 拿容器根——通道调用与判据分开，判据才测得了。
  static Future<String?> _realPathOf(String virtualPath) async {
    final status = await VfsService.instance.status(refresh: true);
    return SqlitePaths.realFromVirtual(virtualPath, status.containerRoot);
  }
}
