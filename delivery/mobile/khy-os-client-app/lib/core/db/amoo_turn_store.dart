// khy-canary: Khy-20261101-072-AE27SFZP
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import '../services/app_logger.dart';
import 'amoo_turn.dart';

/// amoo 反代提问的本地库。
///
/// 为什么需要它：一笔提问要等 amoo 约 6 分钟。这期间用户会切走、锁屏，
/// 系统也可能杀进程。等待线程随进程消失，但提问已经发给 amoo 且收不回来。
/// 没有库，这个事实就跟着进程一起没了；有库，重启后至少知道有一笔未结算。
///
/// 为什么用 sqflite + 手写 SQL 而不是 drift：drift 在 pubspec 里声明了却从未
/// 解析进 lock、也没有任何 import，启用它要跑 build_runner 代码生成——而当前
/// 没有可验证它的环境。手写 SQL 没有构建步骤会坏，且这一张表的 DDL 一眼能审完。
///
/// 失败策略：所有方法都不抛（调用方是 UI 轮询，一次数据库抖动不该把界面打穿），
/// 但**每次失败都必须留日志**。一个静默失效的持久层和一个正常工作的持久层，
/// 在界面上长得一模一样——那恰恰是最难发现的那类 bug。
class AmooTurnStore {
  AmooTurnStore._();
  static final AmooTurnStore instance = AmooTurnStore._();

  static final _log = AppLogger();

  Database? _db;
  bool _broken = false;

  /// 打开失败一次就标记为不可用，之后所有调用走 no-op。
  /// 为什么不再重试：打不开通常是磁盘或权限问题，在 UI 轮询路径上每次重试
  /// 只会把卡顿放大成卡死。
  Future<Database?> _database() async {
    if (_broken) return null;
    if (_db != null) return _db;
    try {
      final dir = await getApplicationDocumentsDirectory();
      final db = await openDatabase(
        p.join(dir.path, 'amoo_bridge.db'),
        version: AmooTurnSchema.version,
        onOpen: (db) async {
          await db.execute(AmooTurnSchema.indexUnsettled);
          await db.execute(AmooTurnSchema.indexAskedAt);
        },
        onCreate: (db, version) async {
          await db.execute(AmooTurnSchema.createTable);
          await db.execute(AmooTurnSchema.indexUnsettled);
          await db.execute(AmooTurnSchema.indexAskedAt);
        },
      );
      _db = db;
      return db;
    } catch (e, st) {
      _broken = true;
      _log.e(LogCategory.system, 'amoo 本地库打开失败，本次运行持久层不可用',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return null;
    }
  }

  /// 插入一笔「即将发起」的提问。
  ///
  /// 必须在调用原生 ask **之前**执行。反过来会在「原生已受理、库还不知道」
  /// 的窗口里留下永久孤儿——那是唯一收不回来的提问。
  ///
  /// 库不可用时返回 -1，调用方应照常发起提问（本地历史是增益，不是前提），
  /// 但要清楚这一笔没有本地记录。
  Future<int> insertPending(String prompt, int askedAt) async {
    final db = await _database();
    if (db == null) return -1;
    try {
      return await db.insert(
        AmooTurnSchema.table,
        AmooTurn(prompt: prompt, askedAt: askedAt).toRow(),
      );
    } catch (e, st) {
      _log.e(LogCategory.system, 'amoo 提问落盘失败，这一笔没有本地记录',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return -1;
    }
  }

  /// 原生已受理。
  Future<void> markRunning(int id, String job) async {
    final db = await _database();
    if (db == null || id < 0) return;
    try {
      await db.update(
        AmooTurnSchema.table,
        <String, Object?>{'job': job, 'state': AmooTurnState.running.wire},
        where: 'id = ?',
        whereArgs: <Object>[id],
      );
    } catch (e, st) {
      // 轮询路径上的次要写失败不阻断主流程，但要留痕：job id 丢了以后
      // 就没法把这行对回原生那次提问。
      _log.w(LogCategory.system, 'amoo 提问标记 running 失败',
          details: <String, dynamic>{'id': id, 'error': '$e'},
          error: e, stackTrace: st);
    }
  }

  /// 结算。reply 为 null 表示没有拿到内容（失败/中断），不是"amoo 回了空"。
  Future<void> settle(
    int id, {
    required AmooTurnState state,
    String? reply,
    String error = '',
    int? settledAt,
  }) async {
    final db = await _database();
    if (db == null || id < 0) return;
    try {
      await db.update(
        AmooTurnSchema.table,
        <String, Object?>{
          'state': state.wire,
          'reply': reply,
          'error': error,
          'settled_at': settledAt,
        },
        where: 'id = ?',
        whereArgs: <Object>[id],
      );
    } catch (e, st) {
      // 结算写失败最疼：行会永远停在 running，下次启动被回收成 interrupted，
      // 于是"明明拿到了回复"在界面上显示成"中断"。必须留痕。
      _log.e(LogCategory.system, 'amoo 提问结算写库失败，该行将被回收为 interrupted',
          details: <String, dynamic>{'id': id, 'state': state.wire, 'error': '$e'},
          error: e, stackTrace: st);
    }
  }

  /// 最近 N 笔，新的在前。
  Future<List<AmooTurn>> recent({int limit = 50}) async {
    final db = await _database();
    if (db == null) return const <AmooTurn>[];
    try {
      final rows = await db.query(
        AmooTurnSchema.table,
        orderBy: 'asked_at DESC, id DESC',
        limit: limit,
      );
      return rows.map(AmooTurn.fromRow).toList(growable: false);
    } catch (e, st) {
      _log.w(LogCategory.system, 'amoo 历史读取失败，本次返回空列表',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return const <AmooTurn>[];
    }
  }

  /// 把残留的未结算行（pending / running）全部改成 interrupted。
  ///
  /// 启动时调用一次。为什么必须做：这些行的等待线程已经随上次进程死了，
  /// 不回收的话界面会把它们永远显示成"正在等"。但**不能**据此宣称 amoo
  /// 失败——它可能照样答了，只是我们没在听。
  ///
  /// @return 被回收的行，供界面提示"上次中断，去 amoo 看看"
  Future<List<AmooTurn>> recoverInterrupted({int? at}) async {
    final db = await _database();
    if (db == null) return const <AmooTurn>[];
    final stamp = at ?? DateTime.now().millisecondsSinceEpoch;
    try {
      final stale = await db.query(
        AmooTurnSchema.table,
        where: 'state IN (?, ?)',
        whereArgs: <Object>[
          AmooTurnState.pending.wire,
          AmooTurnState.running.wire,
        ],
        orderBy: 'asked_at DESC',
      );
      if (stale.isEmpty) return const <AmooTurn>[];
      await db.update(
        AmooTurnSchema.table,
        <String, Object?>{
          'state': AmooTurnState.interrupted.wire,
          'settled_at': stamp,
        },
        where: 'state IN (?, ?)',
        whereArgs: <Object>[
          AmooTurnState.pending.wire,
          AmooTurnState.running.wire,
        ],
      );
      return stale
          .map(AmooTurn.fromRow)
          .map((t) => t.copyWith(
                state: AmooTurnState.interrupted,
                settledAt: stamp,
              ))
          .toList(growable: false);
    } catch (e, st) {
      _log.e(LogCategory.system, 'amoo 未结算提问回收失败，旧行可能永远显示为等待中',
          details: <String, dynamic>{'error': '$e'}, error: e, stackTrace: st);
      return const <AmooTurn>[];
    }
  }

  /// 关闭。仅用于测试。
  Future<void> close() async {
    await _db?.close();
    _db = null;
  }
}
