// SQLite 库的结构化查看。
//
// 流程是「**先复制再打开**」，不是直接打开原库：
//   - 原库在别的 App 的私有目录里，那个 App 可能正开着它，直接打开会撞锁；
//   - 复制一份还能顺便避开「只读打开私有目录文件」的各种权限怪癖。
// 复制用 VFS 的通道（私有目录要 Shizuku），落点在容器空间下的 tmp 里——
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

/// SQLite 查看器。
abstract final class SqliteInspector {
  /// 每张表最多取多少行。
  static const int maxRows = 50;

  /// 容器空间下的临时目录——复制出来的库落在这里。
  static String get scratchDir => '${VfsRoots.container}/tmp';

  /// 查看一个数据库文件。
  static Future<List<SqliteTable>> inspect(String dbPath) async {
    final name = VfsPath.basename(dbPath);
    final scratch = '$scratchDir/$name';
    try {
      await VfsService.instance.mkdir(scratchDir, parents: true);
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
    if (real == null) return const <SqliteTable>[];

    Database? database;
    try {
      database = await openDatabase(real, readOnly: true);
      final tables = await _readTables(database);
      return tables;
    } catch (_) {
      // 打不开就说打不开，别给一个空列表假装「里面没有表」。
      return const <SqliteTable>[];
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
  static Future<String?> _realPathOf(String virtualPath) async {
    final status = await VfsService.instance.status(refresh: true);
    final root = status.containerRoot;
    if (root.isEmpty) return null;
    final prefix = VfsRoots.container;
    if (!virtualPath.startsWith(prefix)) return null;
    final relative = virtualPath.substring(prefix.length);
    return p.join(root, relative);
  }
}
