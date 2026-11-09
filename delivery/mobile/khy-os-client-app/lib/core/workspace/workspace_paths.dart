// khy-canary: Khy-20261101-102-2KPZ8ZBN
/// 任务工作空间的路径文法。
///
/// 为什么需要它，以及为什么是这两个：
/// 手机上没有"当前目录"这回事。一个 Agent 说"把文件放到工作空间"，如果没有一个
/// 约定好的位置，结果就是文件散落在 /sdcard 根目录——本机已经堆了几十个调试用的
/// xml 和 png 就是这么来的。所以工作空间必须是显式的、可解析的、有限的。
///
/// 两个空间对应两种寿命：
///   - 通用（general）：一次性的、没有归属的活儿。所有没声明任务名的活儿都落这里。
///   - 专用（dedicated）：有明确任务名的活儿，彼此隔离，`<root>/tasks/<slug>/`。
/// 分开的理由是清理策略不同：通用空间可以整体回收，专用空间要按任务保留。
///
/// 每个空间下固定有一个 `tmp/`。临时文件只许进这里，且用完即焚（见
/// [WorkspaceStore]）——不设这个约束的话，临时文件会和工作成果混在一起，
/// 于是谁都不敢删，最后变成垃圾。
library;

import 'package:meta/meta.dart';

/// 工作空间的两种。
enum WorkspaceKind {
  /// 通用任务工作空间：`<root>/workspace/`
  general,

  /// 专用任务工作空间：`<root>/tasks/<slug>/`
  dedicated;

  static WorkspaceKind parse(String? raw) {
    switch (raw) {
      case 'dedicated':
        return WorkspaceKind.dedicated;
      default:
        return WorkspaceKind.general;
    }
  }

  String get wire => name;
}

/// 路径文法的全部常量。集中一处，测试钉的也是这些。
abstract final class WorkspaceLayout {
  /// 默认根目录。在共享存储上，因为工作空间的全部意义就在于**用户和 amoo
  /// 都能在文件管理器里看见它**——放进 App 私有目录就谁也看不见了。
  static const String defaultRoot = '/sdcard/khy-os';

  /// 通用工作空间在根下的名字。
  static const String generalDir = 'workspace';

  /// 专用工作空间的父目录名。
  static const String tasksDir = 'tasks';

  /// 每个工作空间下固定存在的临时目录名。
  static const String tmpDir = 'tmp';

  /// 临时文件的最长保留时间。
  ///
  /// 为什么需要"保留时间"而不只是"用完即焚"：焚毁只覆盖正常路径。进程被杀、
  /// 任务抛异常、手机没电——这些情况下 `close()` 根本不会执行，孤儿临时文件
  /// 就是这么来的。保留时间是对这条漏网的兜底。
  ///
  /// 24h 的判据：必须明显长于最长合法任务（amoo 一轮提问约 6 分钟，差 240 倍），
  /// 又必须短到能约束垃圾。取 24h 是为了按天对齐，人工排查时好说。
  static const Duration tmpRetention = Duration(hours: 24);

  /// 任务名（slug）的长度上限。它会变成目录名，过长会在某些文件系统上直接失败。
  static const int maxSlugLength = 64;

  /// 不能用作任务名的保留字——它们和工作空间的结构目录撞名。
  static const Set<String> reservedSlugs = <String>{
    generalDir,
    tasksDir,
    tmpDir,
    'in',
    'out',
  };
}

/// 一次路径解析的结果。不可变，带上它是怎么来的，便于出错时复盘。
@immutable
class WorkspacePaths {
  /// 工作空间根（可被用户改）。
  final String root;

  final WorkspaceKind kind;

  /// 专用空间的任务名；通用空间为空。
  final String slug;

  const WorkspacePaths({
    required this.root,
    this.kind = WorkspaceKind.general,
    this.slug = '',
  });

  WorkspacePaths.copy(WorkspacePaths other)
      : root = other.root,
        kind = other.kind,
        slug = other.slug;

  /// 这个工作空间本身的目录。
  String get dir {
    switch (kind) {
      case WorkspaceKind.general:
        return _join(root, WorkspaceLayout.generalDir);
      case WorkspaceKind.dedicated:
        return _join(root, WorkspaceLayout.tasksDir, slug);
    }
  }

  /// 临时目录。临时文件只许进这里。
  String get tmpDir => _join(dir, WorkspaceLayout.tmpDir);

  /// 根下的另一个空间（用于"这是通用的，那是专用的"这类说明）。
  String get kindLabel =>
      kind == WorkspaceKind.general ? '通用任务工作空间' : '专用任务工作空间';

  @override
  bool operator ==(Object other) =>
      other is WorkspacePaths &&
      other.root == root &&
      other.kind == kind &&
      other.slug == slug;

  @override
  int get hashCode => Object.hash(root, kind, slug);

  @override
  String toString() => 'WorkspacePaths($kindLabel root=$root'
      '${slug.isEmpty ? '' : ' slug=$slug'})';
}

/// 任务名（slug）的校验与规整。
///
/// 为什么单独抽出来并测得很严：slug 会直接变成一个目录名。一个含 `/` 或 `..`
/// 的 slug 不是"名字不好看"的问题，是**目录逃逸**——`../../..` 能让一次写入落到
/// 工作空间以外的任何地方。这里的规则是宁可拒绝，不替他猜。
abstract final class WorkspaceSlug {
  /// 允许的字符：小写字母、数字、`-`、`_`、`.`（但 `.` 有额外限制）。
  static final RegExp _allowed = RegExp(r'^[a-z0-9._-]+$');

  /// 规整：去空白、小写、空格转 `-`。
  ///
  /// 只做无语义损失的规整。其余一律拒绝而不是替他猜——把中文任务名硬转成拼音
  /// 是猜，猜错的代价是目录名和任务对不上，比直接报错难查得多。
  static String normalize(String raw) {
    var s = raw.trim().toLowerCase();
    s = s.replaceAll(RegExp(r'\s+'), '-');
    return s;
  }

  /// 校验。返回 null 表示合法，否则是一句人类可读的拒绝理由。
  ///
  /// 顺序要紧：**路径逃逸必须排在字符集之前**。反过来的话，`../escape` 会先被
  /// 字符集规则拦下，报一句"只能包含小写字母"——技术上没错，但把用户引向完全
  /// 错误的方向：他真正的风险是跳出工作空间，不是大小写。越危险的拒绝理由
  /// 越要先说。
  static String? validate(String raw) {
    if (raw.isEmpty) return '任务名不能为空';
    if (raw.length > WorkspaceLayout.maxSlugLength) {
      return '任务名过长（上限 ${WorkspaceLayout.maxSlugLength} 字符）';
    }
    if (raw.contains('/') || raw.contains('\\')) {
      return '任务名不能包含路径分隔符（会跳出工作空间）';
    }
    if (raw == '..' || raw.contains('..')) {
      return '任务名不能包含 ..（会跳出工作空间）';
    }
    if (raw == '.') return '任务名不能是 .';
    if (!_allowed.hasMatch(raw)) {
      return '任务名只能包含小写字母、数字、-、_、. ';
    }
    if (raw.startsWith('.')) return '任务名不能以 . 开头';
    if (raw.startsWith('-')) return '任务名不能以 - 开头';
    if (raw.endsWith('.') || raw.endsWith('-')) {
      return '任务名不能以 . 或 - 结尾';
    }
    if (WorkspaceLayout.reservedSlugs.contains(raw)) {
      return '任务名不能占用保留字：${WorkspaceLayout.reservedSlugs.join(', ')}';
    }
    return null;
  }

  /// 规整 + 校验。合法时返回规整后的名字，否则抛出 [ArgumentError]。
  static String canonical(String raw) {
    final n = normalize(raw);
    final why = validate(n);
    if (why != null) {
      throw ArgumentError(why);
    }
    return n;
  }
}

/// 拼接路径段，统一用 `/`。
///
/// 不用 `package:path` 的 `join`：它按宿主平台选分隔符，在 Android 上是对的，
/// 但这里的纯逻辑要在主机测试里跑，Windows 上会变成 `\`，于是测试断言的和设备上
/// 实际发生的不是一回事。工作空间路径是给 `dart:io` 用的，Android 上就是 `/`。
String _join(String a, [String? b, String? c]) {
  final parts = <String>[a, ?b, ?c];
  final buf = StringBuffer();
  for (final p in parts) {
    if (p.isEmpty) continue;
    if (buf.isNotEmpty && !buf.toString().endsWith('/')) buf.write('/');
    buf.write(p);
  }
  return buf.toString();
}
