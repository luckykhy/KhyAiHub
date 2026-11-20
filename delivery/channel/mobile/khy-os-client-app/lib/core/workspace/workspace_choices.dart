// khy-canary: Khy-20261101-101-2CXRQ7GP
import 'dart:io';

import 'package:khy_os_client/core/workspace/conversation_workspace.dart';

/// 一个可供选择的工作目录候选。
class DirChoice {
  /// 绝对路径（已规范化）。
  final String path;

  /// 展示名。给 /sdcard/khy-os 这类已知位置一个人话名字。
  final String label;

  /// 一句话说明，告诉人选了它会怎样。
  final String hint;

  /// 是否推荐。
  final bool recommended;

  const DirChoice({
    required this.path,
    required this.label,
    required this.hint,
    this.recommended = false,
  });
}

/// 目录选择器的候选与列举（IO 只在列举，其余纯）。
///
/// 为什么要预设而不是纯让用户浏览：`/sdcard` 下有上百个目录，其中九成是
/// 系统与 App 的私有数据，选错的代价是"文件写进去了但找不到"和"把别人 App
/// 的数据目录当工作区"。所以给一小撮已知位置 + 手动输入兜底。
abstract final class WorkspaceChoices {
  /// 候选上限。超过这个数说明预设该收一收了，不是让列表无限长。
  static const int maxChoices = 12;

  /// 预设候选。顺序即推荐顺序。
  ///
  /// 第一个是 App 自己设计的工作空间——选它意味着文件管理器里看得见，
  /// 这和 `WorkspacePaths` 的注释是同一个理由（"放进 App 私有目录就谁也
  /// 看不见了"）。
  static List<DirChoice> presets() => const [
        DirChoice(
          path: ConversationWorkspace.designedRoot,
          label: 'khy-os 工作空间',
          hint: 'App 设计的位置，文件管理器里能看见，也能和 amoo 共用',
          recommended: true,
        ),
        DirChoice(
          path: '/sdcard/Download',
          label: '下载目录',
          hint: '系统和浏览器都看得到，适合放要交出去的东西',
        ),
        DirChoice(
          path: '/sdcard/Documents',
          label: '文档目录',
          hint: '系统文档应用默认看这里',
        ),
        DirChoice(
          path: '/sdcard/khy-os/workspace',
          label: 'khy-os 通用空间',
          hint: '一次性活儿落这里；按任务隔离的用 <根>/tasks/<任务名>',
        ),
      ];

  /// 列举 `/sdcard` 下真实存在的目录，合并进预设。
  ///
  /// IO 在这里，且失败静默返回预设：选不到更多目录不该让人选不了目录。
  /// 已存在的预设不重复出现。
  ///
  /// 若探测到仓库根，它会被提到第一位并标推荐——手机上真躺着仓库时，用户几乎
  /// 不可能想把这个对话的文件写到 Download 里去。
  static Future<List<DirChoice>> load() async {
    final out = presets();
    final seen = out.map((c) => c.path).toSet();
    try {
      final root = Directory(ConversationWorkspace.sharedStorageRoot);
      if (!await root.exists()) return out;
      await for (final entity in root.list(followLinks: false)) {
        if (out.length >= maxChoices) break;
        if (entity is! Directory) continue;
        final path = ConversationWorkspace.normalize(entity.path);
        if (seen.contains(path)) continue;
        // 跳过点开头隐藏目录与 Android 私有数据——后者选了等于没选。
        final name = path.split('/').last;
        if (name.startsWith('.') || name == 'Android') continue;
        seen.add(path);
        out.add(DirChoice(
          path: path,
          label: name,
          hint: '/sdcard 下已存在的目录',
        ));
      }
    } catch (_) {
      // 读不到 /sdcard（权限没给、存储未挂载）就只给预设。选择器因此永远
      // 有东西可显示，不会变成一个空对话框。
    }

    final repo = await detectRepoRoot();
    return mergeRepoChoice(out, repo);
  }

  /// 把探测到的仓库根并进候选列表。纯函数——合并规则全部在这里，可单测。
  ///
  /// 三条规则，每条都对应一个用户看得见的错：
  ///   1. 仓库根排最前：手机上真躺着仓库时，没人想把对话文件写到 Download 去；
  ///   2. 路径不重复：仓库根常正好就是 /sdcard/khy-os 本身，重复会出现两条
  ///      看起来不同的选项指向同一处；
  ///   3. 推荐只能有一个：多个星标等于没有推荐。
  static List<DirChoice> mergeRepoChoice(List<DirChoice> base, DirChoice? repo) {
    if (repo == null) return base;
    final out = List<DirChoice>.of(base);
    final at = out.indexWhere((c) => c.path == repo.path);
    if (at >= 0) {
      out[at] = repo;
    } else {
      out.add(repo);
    }
    for (var i = 0; i < out.length; i += 1) {
      if (out[i].path != repo.path && out[i].recommended) {
        out[i] = DirChoice(
          path: out[i].path,
          label: out[i].label,
          hint: out[i].hint,
        );
      }
    }
    final hit = out.where((c) => c.path == repo.path).toList();
    final rest = out.where((c) => c.path != repo.path).toList();
    return [...hit, ...rest];
  }

  /// 探测手机上是否放着 khy-os 仓库，放着就返回仓库根的候选。
  ///
  /// 判据要求 `pyproject.toml` **与** `runtime/` **与** `delivery/` 同时在场。
  /// 三个都要，是为了不把一个碰巧有 runtime/ 目录的 App 数据目录当成本仓库——
  /// 误判的后果是用户以为在改项目，实际在改别的东西，而这种误会不会有任何报错。
  ///
  /// 探测范围是一小撮已知位置，不是全盘扫：全盘扫 `/sdcard` 要几秒，而选择器
  /// 是在用户点「新对话」时同步等着的。
  static Future<DirChoice?> detectRepoRoot() async {
    const probes = [
      '/sdcard/khy-os',
      '/sdcard/khy-os/khy-os',
      '/sdcard/khy-os/repo',
      '/sdcard/Download/khy-os',
      '/sdcard/Documents/khy-os',
    ];
    for (final probe in probes) {
      final found = await _readRepoAt(probe);
      if (found != null) return found;
    }

    // 扫设计的工作空间下面一层。
    //
    // 这一步是必须的：只靠上面那几个硬编码位置，等于猜用户会把仓库放哪。实测把仓库
    // 放到一个没猜到的名字（_probe_repo）就整个探测不到——"功能实现了但不生效"
    // 比没有功能更坑，因为它连报错都没有。
    //
    // 仍然不是全盘扫：只扫一层、只扫设计的工作空间下面。全盘扫 /sdcard 要几秒，
    // 而选择器是在用户点「新对话」时同步等着的。
    try {
      final base = Directory(ConversationWorkspace.designedRoot);
      if (!await base.exists()) return null;
      await for (final entity in base.list(followLinks: false)) {
        if (entity is! Directory) continue;
        final found = await _readRepoAt(entity.path);
        if (found != null) return found;
      }
    } catch (_) {
      // 读不到（权限没给、存储未挂载）就当没有仓库。探测是尽力而为，
      // 不该让选择器因此打不开。
    }
    return null;
  }

  /// 读一个路径像不像仓库根；像就返回候选，不像返回 null。
  static Future<DirChoice?> _readRepoAt(String rootPath) async {
    try {
      final root = Directory(rootPath);
      if (!await root.exists()) return null;
      // 三个判据都要在，缺一个就不认。理由见 detectRepoRoot 的注释。
      if (!await File('$rootPath/pyproject.toml').exists()) return null;
      if (!await Directory('$rootPath/runtime').exists()) return null;
      if (!await Directory('$rootPath/delivery').exists()) return null;
      final top = <String>[];
      await for (final e in root.list(followLinks: false)) {
        if (e is Directory) {
          final name = e.path.split('/').last;
          if (!name.startsWith('.')) top.add(name);
        }
      }
      top.sort();
      final shown = top.take(8).join('  ');
      return DirChoice(
        path: rootPath,
        label: 'khy-os 仓库根',
        hint: '已检测到仓库（${top.length} 个顶层目录）：$shown',
        recommended: true,
      );
    } catch (_) {
      // 单个探测点读不到就换下一个。探测是尽力而为，读不到只意味着不多这一项。
      return null;
    }
  }

  /// 校验并规范化一次手动输入。
  ///
  /// 直接复用 ConversationWorkspace.check——校验规则只能有一个真源，
  /// 选择器自己再判一次就会出现"选择器说行、存进去不行"。
  static RootCheck checkManual(String raw) => ConversationWorkspace.check(raw);
}
