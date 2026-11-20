// VFS 门面：文件管理器与 AI 计划执行器唯一要面对的入口。
//
// 门面存在的理由是**判定要只有一处**。权限判定散在界面、散在 AI 执行器、散在原生侧，
// 就会出现「界面上不让点，AI 却能执行」的裂缝。所以规则是：
//   - 路径 → 通道/权限档：[VfsRouter]（纯函数）
//   - 权限档 → 能不能做：[VfsPolicy] + [VfsStatus]
//   - 真正的 IO：原生通道
// 界面与 AI 都只调这里，判定自然一致。
//
// 失败一律抛 [VfsException]（带机器码 + 中文说明），只有「列目录遇到不可访问的目录」
// 是例外——那个要返回灰色占位符而不是抛错，因为报错会让用户以为 App 坏了。

import 'dart:async';

import 'package:meta/meta.dart';

import '../services/audit_log.dart';
import 'vfs_channel.dart';
import 'vfs_copy_task.dart';
import 'vfs_exception.dart';
import 'vfs_node.dart';
import 'vfs_policy.dart';
import 'vfs_route.dart';

// VfsException 的真源在 vfs_exception.dart（拆出来是为了断掉
// vfs_service ↔ vfs_copy_task 的循环依赖）。用 export 再露出去，
// 全仓 53 处引用一行都不用改。
export 'vfs_exception.dart';

/// 运行环境状态。
@immutable
class VfsStatus {
  /// 存储权限是否具备。
  final bool storageGranted;

  /// 提权代理 是否已安装。
  final bool elevationInstalled;

  /// 提权代理 是否已连接并授权。
  final bool elevationAvailable;

  /// 当前执行层级：`sidecar`（uid 2000）或 `app`。
  final String elevationChannel;

  /// 容器根目录（宿主内真实路径）。
  final String containerRoot;

  /// 容器运行时是否已安装。
  final bool containerInstalled;

  const VfsStatus({
    this.storageGranted = false,
    this.elevationInstalled = false,
    this.elevationAvailable = false,
    this.elevationChannel = '',
    this.containerRoot = '',
    this.containerInstalled = false,
  });

  factory VfsStatus.fromMap(Map<String, dynamic> map) {
    final elevation = map['elevation'];
    final elevationMap = elevation is Map
        ? elevation.map((key, value) => MapEntry(key.toString(), value))
        : const <String, dynamic>{};
    return VfsStatus(
      storageGranted: map['storageGranted'] == true,
      elevationInstalled: elevationMap['installed'] == true,
      elevationAvailable: elevationMap['available'] == true,
      elevationChannel:
          (elevationMap['channel'] ?? elevationMap['version'] ?? '').toString(),
      containerRoot: (map['containerRoot'] ?? '').toString(),
      containerInstalled: map['containerInstalled'] == true,
    );
  }
}

/// 文件系统门面。
class VfsService {
  VfsService._();

  static final VfsService instance = VfsService._();

  /// 当前策略。界面改策略后要调用 [applyPolicy] 落盘并让状态失效。
  VfsPolicy policy = const VfsPolicy();

  VfsStatus? _status;

  /// 载入策略。
  Future<VfsPolicy> loadPolicy() async {
    policy = await VfsPolicyStore.load();
    return policy;
  }

  /// 保存策略。
  Future<void> applyPolicy(VfsPolicy next) async {
    policy = next;
    _status = null;
    await VfsPolicyStore.save(next);
  }

  /// 读环境状态（带缓存）。
  Future<VfsStatus> status({bool refresh = false}) async {
    if (!refresh && _status != null) return _status!;
    final result = await VfsChannel.call('status');
    final status = result['ok'] == true
        ? VfsStatus.fromMap(result)
        : const VfsStatus();
    _status = status;
    return status;
  }

  /// 当前路由结论。
  Future<VfsRoute> routeOf(String path) async {
    final env = await status();
    return VfsRouter.route(
      path,
      elevationAvailable: env.elevationAvailable,
      safeMode: policy.safeMode,
    );
  }

  /// 列目录。
  ///
  /// 虚拟根（`/`）返回入口节点列表；权限不足的目录返回**灰色占位符**而不是报错。
  /// 容器根不存在时先把它建出来再重列一次——见 [_isMissingContainerRoot]。
  Future<VfsListing> list(String path) async {
    final normalized = VfsPath.normalize(path);
    if (normalized == '/') return _listRoot();

    final route = await routeOf(normalized);
    if (!route.available) {
      return VfsListing(
        nodes: <VfsNode>[
          VfsNode.locked(normalized, route.unavailableReason ?? '当前不可访问'),
        ],
        locked: true,
        lockReason: route.unavailableReason,
      );
    }
    final via = route.via == VfsVia.shell ? 'shell' : 'storage';
    var result = await VfsChannel.call('list', <String, dynamic>{
      'path': normalized,
      'via': via,
    });
    if (_isMissingContainerRoot(normalized, result)) {
      await _createContainerRoot();
      result = await VfsChannel.call('list', <String, dynamic>{
        'path': normalized,
        'via': via,
      });
    }
    if (result['ok'] != true) {
      final reason = (result['message'] ?? '无法列出目录').toString();
      if (result['error'] == 'elevation_unavailable') {
        return VfsListing(
          nodes: <VfsNode>[VfsNode.locked(normalized, reason)],
          locked: true,
          lockReason: reason,
        );
      }
      throw VfsException((result['error'] ?? 'unknown').toString(), reason);
    }
    final raw = result['nodes'];
    final nodes = <VfsNode>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          nodes.add(
            VfsNode.fromMap(
              item.map((key, value) => MapEntry(key.toString(), value)),
            ),
          );
        }
      }
    }
    nodes.sort(_compareNodes);
    return VfsListing(nodes: nodes);
  }

  /// 列容器根时原生说「目录不存在」——全新安装（或清过数据）就是这一下。
  ///
  /// 容器是 App 自己的沙盒，真实根在 filesDir 下，侧栏「容器空间」与「容器应用」页
  /// 都直奔 `list`；写入路径（VfsCopier 拷入、mkdir、sqlite scratch）本来就会自建
  /// 它，缺的只是读路径这一侧。2026-11-18 真机实测：不补这一环，用户点容器空间看到
  /// 的是「目录不存在：/khyos/container」死页，点重试回到同一个错。
  ///
  /// 只认**根本身**：根下面的子目录不存在照样报错，那通常是用户敲错了路径，
  /// 一起抹平就等于把两种完全不同的情况说成同一句话。
  bool _isMissingContainerRoot(
    String normalized,
    Map<String, dynamic> result,
  ) =>
      result['ok'] != true &&
      result['error'] == 'not_found' &&
      normalized == VfsRoots.container;

  /// 建容器根。已经存在（并发建出、刚建过）时原生的 `conflict` 不是错误。
  Future<void> _createContainerRoot() async {
    try {
      await mkdir(VfsRoots.container, source: AuditSource.system);
    } on VfsException catch (error) {
      if (error.error != 'conflict') rethrow;
    }
  }

  /// 取单个节点属性。
  Future<VfsNode?> stat(String path) async {
    final normalized = VfsPath.normalize(path);
    final route = await routeOf(normalized);
    if (!route.available) return null;
    final result = await VfsChannel.call('stat', <String, dynamic>{
      'path': normalized,
      'via': route.via == VfsVia.shell ? 'shell' : 'storage',
    });
    if (result['ok'] != true) return null;
    final node = result['node'];
    if (node is! Map) return null;
    return VfsNode.fromMap(
      node.map((key, value) => MapEntry(key.toString(), value)),
    );
  }

  /// 读文件内容。
  Future<VfsContent> read(String path, {int maxBytes = 1024 * 1024}) async {
    final normalized = VfsPath.normalize(path);
    final route = await routeOf(normalized);
    if (!route.available) {
      throw VfsException('denied', route.unavailableReason ?? '当前不可访问');
    }
    final result = await VfsChannel.call('read', <String, dynamic>{
      'path': normalized,
      'via': route.via == VfsVia.shell ? 'shell' : 'storage',
      'maxBytes': maxBytes,
    });
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '读取失败').toString(),
      );
    }
    return VfsContent.fromMap(result);
  }

  /// 写文件。
  Future<void> write(
    String path,
    String content, {
    bool binary = false,
    AuditSource source = AuditSource.user,
  }) async {
    final normalized = VfsPath.normalize(path);
    await _guardWrite(normalized);
    final route = await routeOf(normalized);
    final result = await VfsChannel.call('write', <String, dynamic>{
      'path': normalized,
      'via': route.via == VfsVia.shell ? 'shell' : 'storage',
      'content': content,
      'binary': binary,
    });
    await _record(
      source,
      'write',
      normalized,
      ok: result['ok'] == true,
      detail: (result['message'] ?? '').toString(),
    );
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '写入失败').toString(),
      );
    }
  }

  /// 建目录。
  Future<void> mkdir(
    String path, {
    bool parents = true,
    AuditSource source = AuditSource.user,
  }) async {
    final normalized = VfsPath.normalize(path);
    await _guardWrite(normalized);
    final route = await routeOf(normalized);
    final result = await VfsChannel.call('mkdir', <String, dynamic>{
      'path': normalized,
      'via': route.via == VfsVia.shell ? 'shell' : 'storage',
      'parents': parents,
    });
    await _record(source, 'mkdir', normalized, ok: result['ok'] == true);
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '创建目录失败').toString(),
      );
    }
  }

  /// 删除。返回删除的条目数。
  Future<int> delete(
    String path, {
    bool recursive = false,
    AuditSource source = AuditSource.user,
  }) async {
    final normalized = VfsPath.normalize(path);
    await _guardWrite(normalized);
    final route = await routeOf(normalized);
    final result = await VfsChannel.call('delete', <String, dynamic>{
      'path': normalized,
      'via': route.via == VfsVia.shell ? 'shell' : 'storage',
      'recursive': recursive,
    });
    await _record(source, 'delete', normalized, ok: result['ok'] == true);
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '删除失败').toString(),
      );
    }
    final deleted = result['deleted'];
    return deleted is num ? deleted.toInt() : 0;
  }

  /// 重命名 / 移动（同一目录内改名用这个）。
  Future<void> rename(
    String path,
    String to, {
    bool overwrite = false,
    AuditSource source = AuditSource.user,
  }) async {
    final from = VfsPath.normalize(path);
    final target = VfsPath.normalize(to);
    await _guardWrite(from);
    await _guardWrite(target);
    final route = await routeOf(from);
    final result = await VfsChannel.call('rename', <String, dynamic>{
      'path': from,
      'to': target,
      'via': route.via == VfsVia.shell ? 'shell' : 'storage',
      'overwrite': overwrite,
    });
    await _record(
      source,
      'rename',
      from,
      detail: target,
      ok: result['ok'] == true,
    );
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '重命名失败').toString(),
      );
    }
  }

  /// 复制。返回 true 表示因冲突被跳过。
  Future<bool> copy(
    String src,
    String dst, {
    VfsConflict? conflict,
    AuditSource source = AuditSource.user,
  }) async {
    final from = VfsPath.normalize(src);
    final to = VfsPath.normalize(dst);
    await _guardWrite(to);
    // 两端各判一次权限档：跨档的操作要在审计里留痕（目标 §五）。
    final srcRoute = await routeOf(from);
    final dstRoute = await routeOf(to);
    final result = await VfsChannel.call('copy', <String, dynamic>{
      'src': from,
      'dst': to,
      'via': await _copyVia(from, to),
      'conflict': (conflict ?? policy.defaultConflict).name,
    });
    await _record(
      source,
      'copy',
      from,
      detail: to,
      ok: result['ok'] == true,
      crossTier: crossTierLabel(srcRoute.tier, dstRoute.tier),
    );
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '复制失败').toString(),
      );
    }
    return result['skipped'] == true;
  }

  /// 复制走哪条通道。
  ///
  /// **取两端里权限更高的那条**，不是看源。
  ///
  /// 为什么：复制要写的是**目标**。把公共存储的文件导进应用私有目录时，
  /// 若按源选通道（storage），写 /data/data/... 那一步就必然被系统拒绝——
  /// 能读源不代表能写目标。按目标选通道（shell，提权代理）才能过。
  /// 反过来（私有目录 → 公共存储）同理：读私有目录要 提权代理。
  ///
  /// 两端都在公共存储时用普通 IO，不多要一次提权。
  Future<String> _copyVia(String src, String dst) async {
    final srcRoute = await routeOf(src);
    final dstRoute = await routeOf(dst);
    if (srcRoute.via == VfsVia.shell || dstRoute.via == VfsVia.shell) {
      return 'shell';
    }
    return 'storage';
  }

  /// 移动。返回 true 表示因冲突被跳过。
  ///
  /// 走哪条路：**两端都在普通文件系统上时走多线程引擎**（字节级续传、线程池），
  /// 涉及应用私有目录或系统分区时走 shell 通道的同步实现——多线程引擎是 Java IO，
  /// 够不到那些路径。
  ///
  /// 为什么要在这里分流（而不是只在界面层）：AI 计划与自动化脚本也调用这个方法。
  /// 只改界面的话，「多线程移动」就只覆盖手动操作这一半——目标 §二 要的是移动
  /// 本身够强，不是某一个入口够强。
  Future<bool> move(
    String src,
    String dst, {
    VfsConflict? conflict,
    AuditSource source = AuditSource.user,
  }) async {
    final from = VfsPath.normalize(src);
    final to = VfsPath.normalize(dst);
    await _guardWrite(from);
    await _guardWrite(to);
    // 移动同样跨档时要留痕：把私有目录里的东西搬到公共存储，风险不比复制小。
    final srcRoute = await routeOf(from);
    final dstRoute = await routeOf(to);
    final strategy = conflict ?? policy.defaultConflict;

    if (canUseThreadedMove(srcRoute.via, dstRoute.via)) {
      final skipped = await _threadedMove(from, to, strategy);
      await _record(
        source,
        'move',
        from,
        detail: to,
        ok: true,
        crossTier: crossTierLabel(srcRoute.tier, dstRoute.tier),
      );
      return skipped;
    }

    final result = await VfsChannel.call('move', <String, dynamic>{
      'src': from,
      'dst': to,
      // 移动也是「读源 + 写目标」，通道口径与复制一致：取两端权限更高的那条。
      'via': await _copyVia(from, to),
      'conflict': strategy.name,
    });
    await _record(
      source,
      'move',
      from,
      detail: to,
      ok: result['ok'] == true,
      crossTier: crossTierLabel(srcRoute.tier, dstRoute.tier),
    );
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '移动失败').toString(),
      );
    }
    return result['skipped'] == true;
  }

  /// 记一条「移动」的审计。
  ///
  /// 为什么单独有这个方法：移动走的是**异步任务通道**（原生侧多线程引擎），
  /// 审计没法在任务里记——任务完成时 Dart 侧只收到一个进度事件。所以由调用方
  /// 在任务结束后调它。
  ///
  /// 跨档标记在这里算：把私有目录里的东西搬到公共存储，风险不比复制小，
  /// 一样要留痕。
  Future<void> recordMove(String from, String to, {bool ok = true}) async {
    final src = VfsPath.normalize(from);
    final dst = VfsPath.normalize(to);
    final srcRoute = await routeOf(src);
    final dstRoute = await routeOf(dst);
    await _record(
      AuditSource.user,
      'move',
      src,
      detail: dst,
      ok: ok,
      crossTier: crossTierLabel(srcRoute.tier, dstRoute.tier),
    );
  }

  /// 多线程移动：起一个复制引擎的移动任务，等它跑完。
  ///
  /// 返回 true 表示「没搬走」（因冲突被跳过）。
  ///
  /// 为什么等：移动这个接口是**同步语义**的——调用方（AI 计划、自动化脚本）
  /// 期待函数返回时东西已经搬过去了。这里没有把整个接口改成异步：那是更大一
  /// 次改动，会波及 AI 计划的逐步执行与脚本执行器。
  ///
  /// 判「没搬走」用原生回传的 `srcGone`：源还在原地，就说明它没被搬走。不能
  /// 只看任务状态是 done——目标已存在且策略是跳过时任务也是 done，但源根本没动，
  /// 那时候报「移动完成」是在骗人。
  Future<bool> _threadedMove(
    String from,
    String to,
    VfsConflict conflict,
  ) async {
    final taskId = await VfsCopyTasks.instance.start(
      src: from,
      dst: to,
      conflict: conflict,
      resume: true,
      move: true,
    );
    while (true) {
      final progress = await VfsCopyTasks.instance.status(taskId);
      if (progress == null || progress.finished) {
        if (progress != null && progress.phase == 'error') {
          throw VfsException(
            'unknown',
            progress.current.isEmpty ? '移动失败' : progress.current,
          );
        }
        return progress == null || !progress.srcGone;
      }
      await Future<void>.delayed(const Duration(milliseconds: 200));
    }
  }

  /// 搜索。
  Future<List<VfsNode>> search(
    String dir, {
    String query = '',
    String namePattern = '*',
    int maxResults = 50,
    bool recursive = true,
  }) async {
    final normalized = VfsPath.normalize(dir);
    final route = await routeOf(normalized);
    if (!route.available) {
      throw VfsException('denied', route.unavailableReason ?? '当前不可访问');
    }
    final result = await VfsChannel.call('search', <String, dynamic>{
      'dir': normalized,
      'via': route.via == VfsVia.shell ? 'shell' : 'storage',
      'query': query,
      'namePattern': namePattern,
      'maxResults': maxResults,
      'recursive': recursive,
    });
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '搜索失败').toString(),
      );
    }
    final raw = result['nodes'];
    final nodes = <VfsNode>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          nodes.add(
            VfsNode.fromMap(
              item.map((key, value) => MapEntry(key.toString(), value)),
            ),
          );
        }
      }
    }
    return nodes;
  }

  /// 哈希。
  Future<String> hash(String path, {String algorithm = 'sha256'}) async {
    final normalized = VfsPath.normalize(path);
    final route = await routeOf(normalized);
    if (!route.available) {
      throw VfsException('denied', route.unavailableReason ?? '当前不可访问');
    }
    final result = await VfsChannel.call('hash', <String, dynamic>{
      'path': normalized,
      'via': route.via == VfsVia.shell ? 'shell' : 'storage',
      'algorithm': algorithm,
    });
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '计算哈希失败').toString(),
      );
    }
    return (result['digest'] ?? '').toString();
  }

  /// 磁盘空间。
  Future<VfsSpace> space(String path) async {
    final result = await VfsChannel.call('space', <String, dynamic>{
      'path': VfsPath.normalize(path),
    });
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '读取空间信息失败').toString(),
      );
    }
    return VfsSpace.fromMap(result);
  }

  /// 挂载点。
  Future<List<VfsMount>> mounts() async {
    final result = await VfsChannel.call('mounts');
    final raw = result['mounts'];
    final list = <VfsMount>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          list.add(
            VfsMount.fromMap(
              item.map((key, value) => MapEntry(key.toString(), value)),
            ),
          );
        }
      }
    }
    return list;
  }

  /// 已安装应用。
  Future<List<VfsPackage>> packages() async {
    final result = await VfsChannel.call('packages');
    final raw = result['packages'];
    final list = <VfsPackage>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          list.add(
            VfsPackage.fromMap(
              item.map((key, value) => MapEntry(key.toString(), value)),
            ),
          );
        }
      }
    }
    list.sort((a, b) => a.label.compareTo(b.label));
    return list;
  }

  /// 写操作前的权限护栏。
  ///
  /// 两条：只读路径一律拒；写应用私有目录需要显式开启「高级数据编辑模式」——
  /// 读私有目录是「看一眼」，写私有目录是「改别人的数据」，风险不是一个量级。
  Future<void> _guardWrite(String normalized) async {
    final route = await routeOf(normalized);
    if (!route.available) {
      throw VfsException('denied', route.unavailableReason ?? '当前不可访问');
    }
    if (route.readOnly) {
      throw VfsException('read_only', '该路径是只读分区，不能写入');
    }
    if (route.tier == VfsTier.privateData && !policy.advancedDataEdit) {
      throw VfsException('denied', '写入应用私有目录需要先在设置里开启「高级数据编辑模式」');
    }
  }

  Future<void> _record(
    AuditSource source,
    String operation,
    String path, {
    String detail = '',
    bool ok = true,
    String crossTier = '',
  }) async {
    await AuditLog.instance.record(
      source,
      operation,
      path,
      detail: detail,
      ok: ok,
      crossTier: crossTier,
    );
  }

  /// 虚拟根的入口列表。
  Future<VfsListing> _listRoot() async {
    final env = await status(refresh: true);
    final nodes = <VfsNode>[
      VfsNode(
        name: '内部存储',
        path: VfsRoots.storage,
        isDirectory: true,
        mime: 'inode/directory',
        accessible: env.storageGranted,
        reason: env.storageGranted ? '' : '缺少存储权限',
      ),
      VfsNode(
        name: '应用数据',
        path: '/data/data',
        isDirectory: true,
        mime: 'inode/directory',
        accessible: env.elevationAvailable,
        reason: env.elevationAvailable ? '' : '需启动提权代理',
      ),
      VfsNode(
        name: '系统目录',
        path: '/system',
        isDirectory: true,
        mime: 'inode/directory',
        readOnly: true,
        accessible: env.elevationAvailable,
        reason: env.elevationAvailable ? '' : '需启动提权代理',
      ),
      VfsNode(
        name: '容器空间',
        path: VfsRoots.container,
        isDirectory: true,
        mime: 'inode/directory',
        accessible: true,
      ),
    ];

    // 真实挂载点（外置存储卡等）也进根目录，但只列 `/storage` 下的——
    // 其它挂载点（/proc、/sys、/dev）对用户没有意义，列出来只会让根目录变噪声。
    final mounted = await mounts();
    for (final mount in mounted) {
      if (!VfsPath.isUnder(mount.path, '/storage')) continue;
      if (nodes.any((node) => node.path == mount.path)) continue;
      nodes.add(
        VfsNode(
          name: VfsPath.basename(mount.path),
          path: mount.path,
          isDirectory: true,
          mime: 'inode/directory',
          readOnly: mount.readOnly,
          accessible: !mount.readOnly,
          reason: mount.readOnly ? '只读挂载' : '',
        ),
      );
    }
    return VfsListing(nodes: nodes);
  }

  /// 目录优先、再按名称排序。文件管理器里目录排前面是通用预期。
  static int _compareNodes(VfsNode a, VfsNode b) {
    if (a.isDirectory != b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.toLowerCase().compareTo(b.name.toLowerCase());
  }
}
