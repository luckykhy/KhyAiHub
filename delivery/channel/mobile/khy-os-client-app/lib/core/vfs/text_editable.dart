import 'vfs_node.dart';

/// 一个文件能不能用内置文本编辑器改（**纯判据，无 Flutter 依赖**）。
///
/// ## 为什么单独成文件
///
/// 这道判据是**唯一一道**挡在二进制文件和「保存即损坏」之间的东西：
/// 判宽了，用户对着一个 APK 点「编辑」再保存，文件就没了；判窄了，
/// 该能改的配置改不了。
///
/// 而它原先住在 `FileManagerScreenState._isEditable` 里——一个 `_` 前缀的
/// 私有静态方法。私有方法等于没有判据：`test/` 目录调用不到，于是
/// 「二进制文件一定不给编辑入口」这条最要紧的安全属性**一行测试都没有**。
///
/// 与 `ShellCommandPolicy` 同一思路：判据抽成纯函数才能被测。
/// 调用点（`file_manager_screen.dart`）保留一行委托，行为逐字节不变。
abstract final class TextEditable {
  /// 已知可安全当文本编辑的扩展名。
  ///
  /// **只收确实该拿编辑器改的**。这个清单是白名单——不在里面的按二进制处理，
  /// 因为「给一个必然把文件改坏的功能，比不给更糟」。
  ///
  /// 注意 MIME 判定优先：`FileMeta.mimeOf` 认得 `text/html` / `text/css` 等，
  /// 那些扩展名不在这里也能过。这里补的是 MIME 表里没有、但确实是纯文本的。
  static const Set<String> extensions = <String>{
    '.txt', '.log', '.json', '.xml', '.yaml', '.yml', '.conf', '.ini',
    '.properties', '.md', '.csv', '.sh', '.js', '.dart', '.kt', '.java',
    '.gradle', '.toml', '.env',
  };

  /// 这个节点能不能编辑。
  ///
  /// 三条判据，任一成立即可：
  ///   1. 不是目录；
  ///   2. MIME 是 `text/*`（原生侧按扩展名判出来的）；
  ///   3. 扩展名（小写后）在 [extensions] 白名单里。
  ///
  /// 目录永远不给——编辑器是给文件用的，目录没有「内容」可改。
  static bool isEditable(VfsNode node) {
    if (node.isDirectory) return false;
    if (node.mime.startsWith('text/')) return true;
    final lower = node.name.toLowerCase();
    for (final extension in extensions) {
      if (lower.endsWith(extension)) return true;
    }
    return false;
  }
}
