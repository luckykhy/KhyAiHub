// VFS 路径文法与路由表。
//
// 为什么这里只有「虚拟路径」这一套写法：文件管理器要给用户**一棵树**，而不是四棵
// 互不相通的树（公共存储一棵、私有目录一棵、系统分区一棵、容器一棵）。四棵树对应
// 四种权限，用户每切一次树就要重新理解一次「这里能干什么」——那不是文件管理器，
// 是四个文件管理器拼在一起。
//
// 所以底层要有一个**路由表**：路径前缀决定「走哪条通道」和「需要哪一档权限」。
// 路由表是唯一真源，且必须是纯函数：
//   - Dart 侧用它决定 via 与权限档，界面据此画灰态、画只读标识；
//   - 原生侧拿到的 via 已经是结论，它只负责执行 IO，**不再自己判路径**。
// 两侧各判一次必然漂移，而漂移的表现是「有的路径能开有的不能开，且没有报错」——
// 那是最难查的一类 bug，因为每一处单看都是对的。
//
// 归一化在这里做完：重复斜杠、`.`、`..`、尾斜杠。`..` 不允许越过根——越界就是
// 路径逃逸，那必须在**语法层**堵死，不能指望下游每个后端都记得检查。

import 'package:meta/meta.dart';

/// 底层访问通道。
enum VfsVia {
  /// Android Storage API（普通文件系统 IO）。
  storage,

  /// 提权代理 shell 通道（提权后的 shell）。
  shell,
}

/// 权限档位。分层的意义：用户要能看清「这一项能力从哪来、风险是什么」。
enum VfsTier {
  /// 基础文件管理。只要存储权限。
  basic,

  /// 应用私有目录。需要 提权代理。
  privateData,

  /// 系统分区只读。需要 提权代理。
  systemRead,

  /// 容器空间。宿主内目录，不与宿主共享挂载点。
  container,

  /// 提权（Root）。当前不支持——按钮恒灰是诚实的做法。
  elevated,
}

/// 权限档位的中文名（面向用户）。
extension VfsTierLabel on VfsTier {
  String get label {
    switch (this) {
      case VfsTier.basic:
        return '基础文件管理';
      case VfsTier.privateData:
        return '应用私有目录';
      case VfsTier.systemRead:
        return '系统分区（只读）';
      case VfsTier.container:
        return '容器空间';
      case VfsTier.elevated:
        return '系统提权';
    }
  }

  /// 这一档的能力来源说明——界面要让人知道「凭什么我能看这里」。
  String get sourceHint {
    switch (this) {
      case VfsTier.basic:
        return '仅需存储权限';
      case VfsTier.privateData:
        return '需启动提权代理';
      case VfsTier.systemRead:
        return '需启动提权代理';
      case VfsTier.container:
        return 'App 内置沙盒';
      case VfsTier.elevated:
        return '需 Root（当前版本不支持）';
    }
  }
}

/// 跨权限判据：两端不是同一档就算跨。
///
/// 目标 §五 明文要求「所有跨权限操作（如从私有目录复制到公共存储）记录审计日志」。
/// 在这之前，私有目录导出的那条审计记录与普通复制**长得一模一样**——同一个
/// operation、同一个来源标记，用户从日志里看不出这一条越过了权限边界。
/// 记了等于没记：能翻到的那条记录没有把「越界」这件事说出口。
///
/// 同一档内不算跨（比如 basic → basic）：否则用户自己拷几百个文件之后，
/// 日志会被「跨权限」刷满，真正要看的那几条反而被埋掉。
///
/// 为什么它住在路由层：它要看的是**权限档**，而权限档是路由表的产物。审计模块
/// 在服务层（两侧的公共下游），不能反过来依赖路由层——所以这判据留在能看见
/// 档位的地方，由调用方算出字符串再写进日志。
String crossTierLabel(VfsTier from, VfsTier to) {
  if (from == to) return '';
  return '跨权限：${from.label} → ${to.label}';
}

/// 路由结论。`via == null` 表示虚拟根（不是真实路径，是个目录树入口）。
@immutable
class VfsRoute {
  /// 走哪条通道；null = 虚拟根。
  final VfsVia? via;

  /// 需要哪一档权限。
  final VfsTier tier;

  /// 是否只读。系统分区恒为 true。
  final bool readOnly;

  /// 当前是否可用（权限是否具备）。
  final bool available;

  /// 不可用时的人话原因（界面上要显示的「点击激活访问」就是这句）。
  final String? unavailableReason;

  /// 虚拟根。
  const VfsRoute.root()
      : via = null,
        tier = VfsTier.basic,
        readOnly = false,
        available = true,
        unavailableReason = null;

  const VfsRoute({
    required this.via,
    required this.tier,
    this.readOnly = false,
    this.available = true,
    this.unavailableReason,
  });

  /// 不可用但**不是**权限问题（例如未知前缀）。
  const VfsRoute.unsupported(String reason)
      : via = null,
        tier = VfsTier.basic,
        readOnly = false,
        available = false,
        unavailableReason = reason;

  bool get isRoot => via == null;
}

/// 虚拟文件系统里已知的路径前缀。
abstract final class VfsRoots {
  /// 容器空间的虚拟前缀。
  static const String container = '/khyos/container';

  /// 公共存储根。
  static const String storage = '/storage/emulated/0';

  /// 公共存储的等价别名 → 真身。
  ///
  /// 这些不是「另一棵树」，就是同一棵树的符号链接：
  ///  - `/sdcard` 是 Android 上人人都会敲的那个路径；
  ///  - `/storage/self/primary` 是 `/storage/emulated/0` 的另一种写法。
  ///
  /// 为什么要在这里换：原生侧的权限探测（`VfsWatcher.storageProbe`）早就把
  /// `/sdcard` 换成 `/storage/emulated/0` 再去问权限了，而 Dart 侧的路由不知道
  /// 这件事——两边判定漂移的后果是，用户在地址栏敲 `/sdcard/Download`（最常见
  /// 的写法之一）会被判成「陌生路径」→ 落进 shell 兜底档 → 界面弹出
  /// 「该路径需通过 提权代理 访问，请先激活」，而它明明就是自己的内部存储。
  ///
  /// 这就是「同一个界面里无缝切换、无需感知权限差异」（目标 §二）被打破的样子：
  /// 用户看到的是权限差异，而差异的来源只是路径写法不同。
  static const Map<String, String> storageAliases = <String, String>{
    '/sdcard': '/storage/emulated/0',
    '/storage/self/primary': '/storage/emulated/0',
  };

  /// 系统只读分区。写操作一律拒绝。
  static const List<String> systemPartitions = <String>[
    '/system',
    '/vendor',
    '/product',
    '/apex',
    '/odm',
  ];

  /// 应用私有目录前缀。
  static const List<String> privatePrefixes = <String>[
    '/data/data',
    '/data/user',
  ];
}

/// 路径归一化。
///
/// 规则：统一 `/` 分隔、折叠重复斜杠、消解 `.`、消解 `..`、去掉尾斜杠，
/// 并把公共存储的**别名**换成真身。
/// `..` 越过根时**停在根**而不是报错——因为在文件浏览器里，向上再向上停在根是
/// 用户预期；但越界必须在这里就被吃掉，不能把 `..` 原样传到后端。
///
/// 为什么别名折叠放在这里（而不是散在各调用点）：归一化只有一个漏斗，别名也只有
/// 在这一个漏斗里换，才能保证「判定用的路径」与「下发到原生的路径」永远同形。
/// 漏一处就会分裂成两种行为，而分裂的表现是「有的路径能开有的不能开，且没有报错」——
/// 那是最难查的一类 bug。
abstract final class VfsPath {
  /// 归一化路径。空串视为根。
  static String normalize(String raw) {
    if (raw.trim().isEmpty) return '/';
    var path = raw.trim().replaceAll('\\', '/');
    final isAbsolute = path.startsWith('/');
    final parts = <String>[];
    for (final segment in path.split('/')) {
      if (segment.isEmpty || segment == '.') continue;
      if (segment == '..') {
        // 越界即止：把路径弹回根，不允许逃出虚拟文件系统。
        if (parts.isNotEmpty) parts.removeLast();
        continue;
      }
      parts.add(segment);
    }
    final joined = parts.join('/');
    final normalized = isAbsolute ? '/$joined' : (joined.isEmpty ? '/' : joined);
    return _foldStorageAlias(normalized);
  }

  /// 把公共存储的别名换成真身。
  ///
  /// 只换**整段相等或以其 + `/` 开头**的那一段，不做字符串前缀乱替换——
  /// `/sdcardX` 是用户自己建的目录名，不是别名。
  ///
  /// 为什么必须换（这不是洁癖，是漏洞）：
  ///  - 路由层把 `/sdcard/...` 判成 shell 档 → 用户在自己的内部存储上看到
  ///    「需通过 提权代理 访问，请先激活」（真机实测）；
  ///  - 原生侧的共享存储权限判据是 `real.startsWith("/storage/")`，
  ///    `/sdcard/...` 匹配不上 → **权限检查被绕过**。
  ///
  /// 换完之后路径形态与原生侧一致（原生侧也只认 `/storage/emulated/0`），
  /// 两边同源，「同一棵树的两种写法」不会再分裂成两种权限档。
  static String _foldStorageAlias(String normalized) {
    for (final entry in VfsRoots.storageAliases.entries) {
      final alias = entry.key;
      if (normalized == alias) return entry.value;
      if (normalized.startsWith('$alias/')) {
        return '${entry.value}${normalized.substring(alias.length)}';
      }
    }
    return normalized;
  }

  /// 是否是绝对路径（归一化后以 `/` 开头）。
  static bool isAbsolute(String path) => path.startsWith('/');

  /// 父目录。根的父目录是根。
  static String parent(String path) {
    final normalized = normalize(path);
    if (normalized == '/') return '/';
    final index = normalized.lastIndexOf('/');
    if (index <= 0) return '/';
    return normalized.substring(0, index);
  }

  /// 末段名字。根的名字是 `/`。
  static String basename(String path) {
    final normalized = normalize(path);
    if (normalized == '/') return '/';
    final index = normalized.lastIndexOf('/');
    return normalized.substring(index + 1);
  }

  /// 拼接子路径。
  static String join(String base, String child) {
    final normalizedBase = normalize(base);
    if (child.startsWith('/')) return normalize(child);
    if (normalizedBase == '/') return normalize('/$child');
    return normalize('$normalizedBase/$child');
  }

  /// 路径的各段（不含空段）。根返回空列表。
  static List<String> segments(String path) {
    final normalized = normalize(path);
    if (normalized == '/') return const <String>[];
    return normalized.substring(1).split('/');
  }

  /// 是否落在某个前缀之下（按段比较，避免 `/data/database` 被 `/data/dat` 命中）。
  static bool isUnder(String path, String prefix) {
    final p = normalize(path);
    final q = normalize(prefix);
    if (q == '/') return true;
    return p == q || p.startsWith('$q/');
  }

  /// 是否落在任一前缀之下。
  static bool isUnderAny(String path, List<String> prefixes) =>
      prefixes.any((prefix) => isUnder(path, prefix));
}

/// 私有目录里的包名解析。
///
/// 用途：首次访问某个应用的私有目录时要弹风险确认——但确认一次就够，
/// 之后每次进都弹会把用户逼疯。用包名做确认粒度，比用完整路径更贴近
/// 用户的心智模型（「我确认过这个 App 的数据」）。
abstract final class VfsPrivate {
  /// 这个路径属于哪个包的私有目录；不属于任何包时返回 null。
  static String? packageOf(String rawPath) {
    final path = VfsPath.normalize(rawPath);
    for (final prefix in VfsRoots.privatePrefixes) {
      if (!VfsPath.isUnder(path, prefix)) continue;
      final rest = path.substring(prefix.length);
      final segments =
          rest.split('/').where((String segment) => segment.isNotEmpty).toList();
      if (segments.isEmpty) return null;
      // /data/user/<userId>/<pkg> —— 第一段是用户号，不是包名。
      if (prefix == '/data/user') {
        if (segments.length < 2) return null;
        return segments[1];
      }
      return segments.first;
    }
    return null;
  }
}

/// 路由判定。
///
/// 参数 [elevationAvailable] 决定 shell 系档位是否可用；[safeMode] 是启动选项，
/// 安全模式下只保留基础文件管理——排查故障时需要一条「确定能走通」的路。
abstract final class VfsRouter {
  /// 判定一个路径的路由结论。
  static VfsRoute route(
    String rawPath, {
    bool elevationAvailable = false,
    bool safeMode = false,
  }) {
    // 归一化已经把公共存储的别名换成真身（`/sdcard` → `/storage/emulated/0`），
    // 否则 `/sdcard/Download` 这种最常见的写法会落到 shell 兜底档，界面弹
    // 「需通过 提权代理 访问」，而它就是用户的内部存储。
    final path = VfsPath.normalize(rawPath);

    // 虚拟根：不是真实路径，是「有哪些树可以进」的入口。
    if (path == '/') return const VfsRoute.root();

    // 容器空间：宿主内的普通目录，用 Storage API 就够，不需要提权。
    //
    // 安全模式下**故意保留**（既有测试 `容器在安全模式下也保留` 钉住这一点）：
    // 它的理由是「不需要提权、没有权限风险」。但文档 §9.1 写的规则是「禁用
    // `basic` 之外的**全部**档位」，容器是一档——两处口径不一致，已记为待拍板
    // （见设计文档 §9.50.13）。在拍板之前不改任何一边。
    if (VfsPath.isUnder(path, VfsRoots.container)) {
      return VfsRoute(via: VfsVia.storage, tier: VfsTier.container);
    }

    // 公共存储。
    if (path == '/storage' || VfsPath.isUnder(path, '/storage')) {
      return VfsRoute(via: VfsVia.storage, tier: VfsTier.basic);
    }

    // 系统分区：只读。
    if (VfsPath.isUnderAny(path, VfsRoots.systemPartitions)) {
      if (safeMode) {
        return VfsRoute(
          via: VfsVia.shell,
          tier: VfsTier.systemRead,
          readOnly: true,
          available: false,
          unavailableReason: '安全模式已启用，只保留基础文件管理',
        );
      }
      return VfsRoute(
        via: VfsVia.shell,
        tier: VfsTier.systemRead,
        readOnly: true,
        available: elevationAvailable,
        unavailableReason: elevationAvailable ? null : '需启动提权代理 才能浏览系统分区',
      );
    }

    // 应用私有目录。
    if (VfsPath.isUnderAny(path, VfsRoots.privatePrefixes)) {
      if (safeMode) {
        return VfsRoute(
          via: VfsVia.shell,
          tier: VfsTier.privateData,
          available: false,
          unavailableReason: '安全模式已启用，只保留基础文件管理',
        );
      }
      return VfsRoute(
        via: VfsVia.shell,
        tier: VfsTier.privateData,
        available: elevationAvailable,
        unavailableReason:
            elevationAvailable ? null : '需启动提权代理 才能访问应用私有目录',
      );
    }

    // 其余路径（/data 下别的目录、/mnt、/tmp…）按 shell 处理：普通 shell 看不到它们，
    // 所以可用性与私有目录同档——不能因为「路径眼生」就假装它一定可读。
    if (safeMode) {
      return VfsRoute(
        via: VfsVia.shell,
        tier: VfsTier.basic,
        available: false,
        unavailableReason: '安全模式已启用，只保留基础文件管理',
      );
    }
    return VfsRoute(
      via: VfsVia.shell,
      tier: VfsTier.privateData,
      available: elevationAvailable,
      unavailableReason:
          elevationAvailable ? null : '该路径需通过 提权代理 访问，请先启动提权代理',
    );
  }

  /// 写操作是否允许。系统分区恒拒绝；不可用的路由一律拒绝。
  static bool canWrite(VfsRoute route) {
    if (!route.available) return false;
    if (route.readOnly) return false;
    return route.via != null;
  }
}
