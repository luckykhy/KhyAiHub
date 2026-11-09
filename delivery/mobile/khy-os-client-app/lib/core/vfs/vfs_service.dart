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

import 'vfs_audit.dart';
import 'vfs_channel.dart';
import 'vfs_node.dart';
import 'vfs_policy.dart';
import 'vfs_route.dart';

/// VFS 失败。
class VfsException implements Exception {
  /// 机器码（与原生契约同一套词表）。
  final String error;

  /// 中文说明。
  final String message;

  const VfsException(this.error, this.message);

  @override
  String toString() => 'VfsException($error): $message';
}

/// 运行环境状态。
@immutable
class VfsStatus {
  /// 存储权限是否具备。
  final bool storageGranted;

  /// Shizuku 是否已安装。
  final bool shizukuInstalled;

  /// Shizuku 是否已连接并授权。
  final bool shizukuAvailable;

  /// Shizuku 版本。
  final String shizukuVersion;

  /// 容器根目录（宿主内真实路径）。
  final String containerRoot;

  /// 容器运行时是否已安装。
  final bool containerInstalled;

  const VfsStatus({
    this.storageGranted = false,
    this.shizukuInstalled = false,
    this.shizukuAvailable = false,
    this.shizukuVersion = '',
    this.containerRoot = '',
    this.containerInstalled = false,
  });

  factory VfsStatus.fromMap(Map<String, dynamic> map) {
    final shizuku = map['shizuku'];
    final shizukuMap = shizuku is Map
        ? shizuku.map((key, value) => MapEntry(key.toString(), value))
        : const <String, dynamic>{};
    return VfsStatus(
      storageGranted: map['storageGranted'] == true,
      shizukuInstalled: shizukuMap['installed'] == true,
      shizukuAvailable: shizukuMap['available'] == true,
      shizukuVersion: (shizukuMap['version'] ?? '').toString(),
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
      shizukuAvailable: env.shizukuAvailable,
      safeMode: policy.safeMode,
    );
  }

  /// 列目录。
  ///
  /// 虚拟根（`/`）返回入口节点列表；权限不足的目录返回**灰色占位符**而不是报错。
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
    final result = await VfsChannel.call('list', <String, dynamic>{
      'path': normalized,
      'via': via,
    });
    if (result['ok'] != true) {
      final reason = (result['message'] ?? '无法列出目录').toString();
      if (result['error'] == 'shizuku_unavailable') {
        return VfsListing(
          nodes: <VfsNode>[VfsNode.locked(normalized, reason)],
          locked: true,
          lockReason: reason,
        );
      }
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        reason,
      );
    }
    final raw = result['nodes'];
    final nodes = <VfsNode>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          nodes.add(VfsNode.fromMap(
            item.map((key, value) => MapEntry(key.toString(), value)),
          ));
        }
      }
    }
    nodes.sort(_compareNodes);
    return VfsListing(nodes: nodes);
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
    VfsSource source = VfsSource.user,
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
    VfsSource source = VfsSource.user,
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
    VfsSource source = VfsSource.user,
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
    VfsSource source = VfsSource.user,
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
    await _record(source, 'rename', from, detail: target,
        ok: result['ok'] == true);
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
    VfsSource source = VfsSource.user,
  }) async {
    final from = VfsPath.normalize(src);
    final to = VfsPath.normalize(dst);
    await _guardWrite(to);
    final result = await VfsChannel.call('copy', <String, dynamic>{
      'src': from,
      'dst': to,
      'via': await _copyVia(from, to),
      'conflict': (conflict ?? policy.defaultConflict).name,
    });
    await _record(source, 'copy', from, detail: to, ok: result['ok'] == true);
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
  /// 能读源不代表能写目标。按目标选通道（shell，Shizuku）才能过。
  /// 反过来（私有目录 → 公共存储）同理：读私有目录要 Shizuku。
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
  Future<bool> move(
    String src,
    String dst, {
    VfsConflict? conflict,
    VfsSource source = VfsSource.user,
  }) async {
    final from = VfsPath.normalize(src);
    final to = VfsPath.normalize(dst);
    await _guardWrite(from);
    await _guardWrite(to);
    final result = await VfsChannel.call('move', <String, dynamic>{
      'src': from,
      'dst': to,
      // 移动也是「读源 + 写目标」，通道口径与复制一致：取两端权限更高的那条。
      'via': await _copyVia(from, to),
      'conflict': (conflict ?? policy.defaultConflict).name,
    });
    await _record(source, 'move', from, detail: to, ok: result['ok'] == true);
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '移动失败').toString(),
      );
    }
    return result['skipped'] == true;
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
          nodes.add(VfsNode.fromMap(
            item.map((key, value) => MapEntry(key.toString(), value)),
          ));
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
          list.add(VfsMount.fromMap(
            item.map((key, value) => MapEntry(key.toString(), value)),
          ));
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
          list.add(VfsPackage.fromMap(
            item.map((key, value) => MapEntry(key.toString(), value)),
          ));
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
      throw VfsException(
        'denied',
        '写入应用私有目录需要先在设置里开启「高级数据编辑模式」',
      );
    }
  }

  Future<void> _record(
    VfsSource source,
    String operation,
    String path, {
    String detail = '',
    bool ok = true,
  }) async {
    await VfsAuditLog.instance.record(
      source,
      operation,
      path,
      detail: detail,
      ok: ok,
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
        accessible: env.shizukuAvailable,
        reason: env.shizukuAvailable ? '' : '需激活 Shizuku',
      ),
      VfsNode(
        name: '系统目录',
        path: '/system',
        isDirectory: true,
        mime: 'inode/directory',
        readOnly: true,
        accessible: env.shizukuAvailable,
        reason: env.shizukuAvailable ? '' : '需激活 Shizuku',
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
