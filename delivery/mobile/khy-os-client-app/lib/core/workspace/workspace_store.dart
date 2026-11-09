// khy-canary: Khy-20261101-103-Z0CG1RE6
import 'dart:io';
import 'dart:math';

import 'package:path/path.dart' as p;

import '../services/app_logger.dart';
import 'workspace_paths.dart';

/// 工作空间的落地层：建目录、发临时目录、烧掉、扫孤儿。
///
/// 与 [WorkspacePaths] 的分工：那个是纯文法（可测、不碰盘），这个才碰盘。
/// 所有方法同样不抛，但每次失败都留日志——理由同 amoo_turn_store：一个静默失效的
/// 工作空间和一个正常工作的，界面上看不出区别。
class WorkspaceStore {
  WorkspaceStore._();
  static final WorkspaceStore instance = WorkspaceStore._();

  static final _log = AppLogger();

  /// 用户指定的根。null = 用默认值。
  ///
  /// 只在启动时读一次，之后驻留内存：它会被每个工具调用问到，每次都读盘是浪费。
  String? _rootOverride;

  WorkspacePaths paths({WorkspaceKind kind = WorkspaceKind.general, String slug = ''}) {
    return WorkspacePaths(
      root: _rootOverride ?? WorkspaceLayout.defaultRoot,
      kind: kind,
      slug: slug,
    );
  }

  /// 设置用户指定的根。空串或 null = 恢复默认。
  ///
  /// 不在这里落盘：调用方（设置页）负责持久化，落盘失败要能告诉用户"没保存成"，
  /// 而这里返回 void 说不清这件事。
  void setRootOverride(String? root) {
    final t = root?.trim() ?? '';
    _rootOverride = t.isEmpty ? null : t;
  }

  /// 根目录当前是什么（默认值 or 用户改过的）。给设置页显示用。
  String get effectiveRoot => _rootOverride ?? WorkspaceLayout.defaultRoot;

  bool get hasOverride => _rootOverride != null;

  /// 确保一个工作空间（含其 tmp/）存在。幂等。
  ///
  /// @return true 表示目录可用。false 时原因已进日志——通常是没拿到
  ///         MANAGE_EXTERNAL_STORAGE，或者用户指定的路径不可写。
  Future<bool> ensure(WorkspacePaths ws) async {
    try {
      for (final d in <String>[ws.dir, ws.tmpDir]) {
        final dir = Directory(d);
        if (!await dir.exists()) {
          await dir.create(recursive: true);
        }
      }
      return true;
    } catch (e) {
      _log.w(LogCategory.system, '工作空间创建失败',
          details: <String, dynamic>{'dir': ws.dir, 'error': '$e'});
      return false;
    }
  }

  /// 领一个临时目录：`<workspace>/tmp/<唯一名>/`。
  ///
  /// 为什么不给单个临时文件而给目录：一个任务往往要两三个中间产物（截图、解析
  /// 出的 xml、草稿）。逐个登记再逐个删，漏一个就成了用户看到的垃圾；整个目录
  /// 一次烧掉，没有"漏一个"的可能。
  ///
  /// 唯一名 = 毫秒时间戳 + 4 位随机。光有时间戳不够：两个任务在同一毫秒发起时
  /// 会撞名，而 `create()` 对已存在目录不报错，于是两个任务写进同一个临时目录，
  /// 其中一个烧掉的时候会连带删掉另一个的中间产物。
  static final Random _random = Random.secure();

  Future<Directory?> claimTempDir(WorkspacePaths ws) async {
    if (!await ensure(ws)) return null;
    try {
      final stamp = DateTime.now().millisecondsSinceEpoch;
      final suffix = _random.nextInt(0x10000).toRadixString(16).padLeft(4, '0');
      final dir = Directory(p.join(ws.tmpDir, 't$stamp-$suffix'));
      await dir.create(recursive: true);
      return dir;
    } catch (e) {
      _log.w(LogCategory.system, '临时目录创建失败',
          details: <String, dynamic>{'tmp': ws.tmpDir, 'error': '$e'});
      return null;
    }
  }

  /// 烧掉一个临时目录。用完即焚。
  ///
  /// 幂等且不因"已经没了"报错——重复 close 是正常用法（try/finally 里调一次、
  /// 出错分支再调一次），为此报错只会让人不敢调。
  Future<void> burn(Directory? dir) async {
    if (dir == null) return;
    try {
      if (await dir.exists()) {
        await dir.delete(recursive: true);
      }
    } catch (e) {
      // 烧不掉要留痕但不抛：调用方往往在 finally 里，抛异常会盖掉真正的错误。
      _log.w(LogCategory.system, '临时目录销毁失败',
          details: <String, dynamic>{'dir': dir.path, 'error': '$e'});
    }
  }

  /// 扫孤儿：删掉保留时间以前的临时项。
  ///
  /// 启动时调一次。这是"用完即焚"的兜底——正常路径由 [burn] 保证，进程被杀、
  /// 任务抛异常、手机没电这些情况下 close 不会执行，孤儿就是这么来的。
  ///
  /// 扫**每一个**工作空间的 tmp/，不只通用的那个：只扫通用空间的话，专用任务留下
  /// 的孤儿永远清不掉，而那正是最容易产生孤儿的地方（任务长、更容易被中断）。
  ///
  /// 只扫 `tmp/` 一层，不递归进任务目录：任务成果不是临时文件，误删的代价
  /// 远大于留一点垃圾。
  ///
  /// @return 删掉的条目数，供日志和界面显示"清了 N 项"。
  Future<int> sweepOrphanTemp({Duration? retention}) async {
    final keep = retention ?? WorkspaceLayout.tmpRetention;
    final cutoff = DateTime.now().subtract(keep).millisecondsSinceEpoch;
    final root = effectiveRoot;
    final tmpDirs = <String>[
      paths().tmpDir,
      // 专用任务的 tmp/ 要枚举 tasks/ 才能拿到。tasks/ 不存在时下面自然跳过。
      ...await _dedicatedTmpDirs(root),
    ];
    var removed = 0;
    for (final tmpPath in tmpDirs) {
      removed += await _sweepOneTmp(tmpPath, cutoff);
    }
    if (removed > 0) {
      _log.i(LogCategory.system, '清理过期临时项',
          details: <String, dynamic>{'removed': removed, 'retention': keep.inHours});
    }
    return removed;
  }

  /// 枚举 `<root>/tasks/*/tmp`。tasks/ 不存在或读不了时返回空——不是错误。
  Future<List<String>> _dedicatedTmpDirs(String root) async {
    try {
      final tasks = Directory(p.join(root, WorkspaceLayout.tasksDir));
      if (!await tasks.exists()) return const <String>[];
      final out = <String>[];
      await for (final entity in tasks.list(followLinks: false)) {
        if (entity is Directory) {
          out.add(p.join(entity.path, WorkspaceLayout.tmpDir));
        }
      }
      return out;
    } catch (e) {
      _log.w(LogCategory.system, '枚举专用任务目录失败',
          details: <String, dynamic>{'root': root, 'error': '$e'});
      return const <String>[];
    }
  }

  Future<int> _sweepOneTmp(String tmpPath, int cutoffMs) async {
    var removed = 0;
    try {
      final tmp = Directory(tmpPath);
      if (!await tmp.exists()) return 0;
      await for (final entity in tmp.list(followLinks: false)) {
        try {
          final stat = await entity.stat();
          if (stat.type == FileSystemEntityType.directory) {
            // 目录看它自身的 mtime：里面的文件被写过会更新它。
            if (stat.modified.millisecondsSinceEpoch < cutoffMs) {
              await entity.delete(recursive: true);
              removed++;
            }
          }
        } catch (e) {
          // 单个条目失败不该中断整轮扫描
          _log.w(LogCategory.system, '扫描临时项时跳过一项',
              details: <String, dynamic>{'path': entity.path, 'error': '$e'});
        }
      }
    } catch (e) {
      _log.w(LogCategory.system, '临时目录扫描失败',
          details: <String, dynamic>{'tmp': tmpPath, 'error': '$e'});
    }
    return removed;
  }
}
