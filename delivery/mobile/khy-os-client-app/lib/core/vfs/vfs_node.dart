// VFS 节点模型。
//
// 一个节点是「目录里的一个条目」的完整描述。字段不是越多越好——但少一个，界面就得
// 自己去猜：只读标识靠 owner/group 猜、权限位靠 mode 猜、SELinux 标签干脆猜不出来。
// 所以这里一次把「专业文件管理器要展示的属性」都带齐。
//
// 关键字段是 [accessible]：它不是「操作成功了吗」，而是「这一项用户能不能用」。
// Shizuku 没激活时私有目录里的条目应当是**灰色占位符**，而不是报错——报错会让用户
// 以为 App 坏了，而实际上只是「还差一步授权」。

import 'package:meta/meta.dart';

/// 目录/文件条目。
@immutable
class VfsNode {
  /// 显示名。
  final String name;

  /// 虚拟绝对路径。
  final String path;

  /// 是否目录。
  final bool isDirectory;

  /// 字节数。目录取递归占用，取不到时为 0。
  final int size;

  /// 修改时间（毫秒）。
  final int modifiedMs;

  /// 权限位，形如 `rwxr-xr-x`。
  final String mode;

  /// 属主。
  final String owner;

  /// 属组。
  final String group;

  /// SELinux 标签，如 `u:object_r:sdcardfs:s0`。
  final String selinux;

  /// MIME 粗判。
  final String mime;

  /// 是否只读。
  final bool readOnly;

  /// 用户当前能不能用这一项。
  final bool accessible;

  /// 不能用时的人话原因。
  final String reason;

  /// 符号链接指向（可空）。
  final String linkTarget;

  const VfsNode({
    required this.name,
    required this.path,
    required this.isDirectory,
    this.size = 0,
    this.modifiedMs = 0,
    this.mode = '',
    this.owner = '',
    this.group = '',
    this.selinux = '',
    this.mime = 'application/octet-stream',
    this.readOnly = false,
    this.accessible = true,
    this.reason = '',
    this.linkTarget = '',
  });

  /// 从原生通道的 map 还原。缺字段用默认值，不抛——原生侧少给一个字段不该让
  /// 整个目录列表打不开。
  factory VfsNode.fromMap(Map<String, dynamic> map) {
    return VfsNode(
      name: (map['name'] ?? '').toString(),
      path: (map['path'] ?? '').toString(),
      isDirectory: map['isDirectory'] == true,
      size: _toInt(map['size']),
      modifiedMs: _toInt(map['modifiedMs']),
      mode: (map['mode'] ?? '').toString(),
      owner: (map['owner'] ?? '').toString(),
      group: (map['group'] ?? '').toString(),
      selinux: (map['selinux'] ?? '').toString(),
      mime: (map['mime'] ?? '').toString().isEmpty
          ? 'application/octet-stream'
          : map['mime'].toString(),
      readOnly: map['readOnly'] == true,
      accessible: map['accessible'] != false,
      reason: (map['reason'] ?? '').toString(),
      linkTarget: (map['linkTarget'] ?? '').toString(),
    );
  }

  /// 一个「锁住」的占位节点。用于 Shizuku 未激活时把私有目录显示成灰态条目，
  /// 而不是弹一个错误。
  factory VfsNode.locked(String path, String reason) => VfsNode(
        name: VfsNode.basenameOf(path),
        path: path,
        isDirectory: true,
        accessible: false,
        reason: reason,
        mime: 'inode/directory',
      );

  static String basenameOf(String path) {
    final normalized = path.endsWith('/') && path.length > 1
        ? path.substring(0, path.length - 1)
        : path;
    final index = normalized.lastIndexOf('/');
    return index < 0 ? normalized : normalized.substring(index + 1);
  }

  /// 人类可读的大小。目录不显示大小（递归占用容易误导）。
  String get readableSize {
    if (isDirectory) return '';
    if (size < 1024) return '$size B';
    const units = <String>['KB', 'MB', 'GB', 'TB'];
    var value = size / 1024;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return '${value.toStringAsFixed(value >= 100 ? 0 : 1)} ${units[unit]}';
  }

  static int _toInt(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value) ?? 0;
    return 0;
  }

  @override
  bool operator ==(Object other) =>
      other is VfsNode &&
      other.path == path &&
      other.name == name &&
      other.isDirectory == isDirectory &&
      other.size == size &&
      other.modifiedMs == modifiedMs &&
      other.accessible == accessible;

  @override
  int get hashCode =>
      Object.hash(path, name, isDirectory, size, modifiedMs, accessible);

  @override
  String toString() => 'VfsNode($path, dir=$isDirectory, size=$size)';
}

/// 一次列目录的结果。
///
/// [locked] 为 true 时 [nodes] 里只有占位节点，界面据此渲染灰态而不是错误页。
@immutable
class VfsListing {
  final List<VfsNode> nodes;

  /// 该目录是否处于「不可访问但路径真实存在」的状态。
  final bool locked;

  /// 锁定原因（人话）。
  final String? lockReason;

  const VfsListing({
    required this.nodes,
    this.locked = false,
    this.lockReason,
  });

  static const VfsListing empty = VfsListing(nodes: <VfsNode>[]);
}

/// 文件内容。
@immutable
class VfsContent {
  /// 文本内容（[binary] 为 true 时为空）。
  final String text;

  /// 二进制内容（base64，[binary] 为 true 时有效）。
  final String base64;

  /// 是否二进制。
  final bool binary;

  /// 是否被截断。
  final bool truncated;

  const VfsContent({
    this.text = '',
    this.base64 = '',
    this.binary = false,
    this.truncated = false,
  });

  factory VfsContent.fromMap(Map<String, dynamic> map) {
    final binary = map['binary'] == true;
    final payload = (map['content'] ?? '').toString();
    // 原生侧对二进制返回 base64、对文本返回原文——同一个字段两种含义，
    // 所以这里必须按 binary 标志分流：文本进 text，base64 进 base64。
    // 不分流的话，二进制文件的 base64 会被当成「文本内容」显示出来。
    return VfsContent(
      text: binary ? '' : payload,
      base64: binary ? payload : '',
      binary: binary,
      truncated: map['truncated'] == true,
    );
  }
}

/// 挂载点。
@immutable
class VfsMount {
  final String path;
  final String type;
  final bool readOnly;

  /// 是否可进入（可访问的挂载点）。
  final bool available;

  const VfsMount({
    required this.path,
    required this.type,
    this.readOnly = false,
    this.available = false,
  });

  factory VfsMount.fromMap(Map<String, dynamic> map) => VfsMount(
        path: (map['path'] ?? '').toString(),
        type: (map['type'] ?? '').toString(),
        readOnly: map['readOnly'] == true,
        available: map['available'] == true,
      );
}

/// 已安装应用（系统应用管理面板用）。
@immutable
class VfsPackage {
  final String pkg;
  final String label;
  final bool system;

  const VfsPackage({
    required this.pkg,
    required this.label,
    this.system = false,
  });

  factory VfsPackage.fromMap(Map<String, dynamic> map) => VfsPackage(
        pkg: (map['pkg'] ?? '').toString(),
        label: (map['label'] ?? '').toString(),
        system: map['system'] == true,
      );
}

/// 磁盘空间。
@immutable
class VfsSpace {
  final int total;
  final int free;
  final int used;

  const VfsSpace({this.total = 0, this.free = 0, this.used = 0});

  factory VfsSpace.fromMap(Map<String, dynamic> map) => VfsSpace(
        total: VfsNode._toInt(map['total']),
        free: VfsNode._toInt(map['free']),
        used: VfsNode._toInt(map['used']),
      );

  double get usedRatio => total <= 0 ? 0 : (used / total).clamp(0.0, 1.0);
}
