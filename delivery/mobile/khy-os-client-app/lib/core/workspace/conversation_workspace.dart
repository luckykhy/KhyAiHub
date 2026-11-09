// khy-canary: Khy-20261101-100-88XAVMND
library;

import 'workspace_paths.dart';

/// 对话级工作空间的根目录解析与校验（纯函数，不碰盘）。
///
/// 为什么单独一层：`Conversation` 要存一个用户挑的根，而"挑"意味着人可以输入任意
/// 字符串。原生侧 `resolvePath` 的 containment 检查是针对**某一个 base** 的，base
/// 本身是什么必须由这里定——这里松一寸，原生那边那道 `SecurityException` 就等于
/// 对着空气挥拳。
///
/// 三条硬规则，缺一条就是目录逃逸：
///   1. 必须是绝对路径（相对路径会被解析到调用方 cwd，那是不确定的东西）；
///   2. 不允许 `..`（规范化之后仍能爬出 base 的经典手法）；
///   3. 规范化后必须以 base 开头（大小写、`//`、末尾 `/` 都要先拧干）。

/// 校验结论。
class RootCheck {
  final bool ok;

  /// 规范化后的根；失败时为空串。
  final String normalized;

  /// 失败原因（中文，直接给人看）；成功时为空串。
  final String reason;

  /// 是否落在 /sdcard 之外（成功但值得提醒）。
  final bool outsideSharedStorage;

  const RootCheck({
    required this.ok,
    this.normalized = '',
    this.reason = '',
    this.outsideSharedStorage = false,
  });
}

/// 对话工作空间的根目录文法。
abstract final class ConversationWorkspace {
  /// 共享存储的根。选这里的子目录，用户才能在文件管理器里看见成果。
  static const String sharedStorageRoot = '/sdcard';

  /// App 自己设计的工作空间根。选择器的默认项。
  static const String designedRoot = WorkspaceLayout.defaultRoot;

  /// 根目录长度上限。超长了不是路径，是误粘了一段文本。
  static const int maxRootLength = 200;

  /// 规范化：去末尾斜杠、压掉重复斜杠。不做语义判断。
  ///
  /// 单独拆出来是因为它会被校验和展示两处用到，而两处对"什么算同一个路径"
  /// 必须给出同一个答案——否则界面上显示的根和实际生效的根不是一回事。
  static String normalize(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return '';
    // 压重复斜杠，但保留开头的那个（绝对路径标记）。
    s = s.replaceAll(RegExp(r'/{2,}'), '/');
    // 去末尾斜杠，根目录本身除外。
    while (s.length > 1 && s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    return s;
  }

  /// 校验用户挑的根。
  ///
  /// 返回的 [RootCheck.normalized] 才是应该被存进 Conversation 的值——展示用原样，
  /// 生效用规范化后的，两者不同就会出现在界面上看着对、落盘却差一点的情况。
  static RootCheck check(String raw) {
    final trimmed = raw.trim();
    if (trimmed.isEmpty) {
      return const RootCheck(ok: false, reason: '根目录不能为空。');
    }
    if (trimmed.length > maxRootLength) {
      return RootCheck(
        ok: false,
        reason: '根目录过长（超过 $maxRootLength 字符），像是误粘了别的内容。',
      );
    }
    if (!trimmed.startsWith('/')) {
      return const RootCheck(
        ok: false,
        reason: '根目录必须是绝对路径（以 / 开头）。相对路径会落到不确定的位置。',
      );
    }
    // 先规范化再查 `..`：`/sdcard/./a/../b` 这种形态压一压就现形了。
    final normalized = normalize(trimmed);
    for (final segment in normalized.split('/')) {
      if (segment == '..') {
        return RootCheck(
          ok: false,
          reason: '根目录不允许包含 ..（$normalized 会爬出所选根）。',
        );
      }
    }
    if (normalized == '/') {
      return const RootCheck(
        ok: false,
        reason: '不能把整个存储根当成工作目录，那等于没有工作目录。',
      );
    }
    return RootCheck(
      ok: true,
      normalized: normalized,
      outsideSharedStorage: !normalized.startsWith(sharedStorageRoot),
    );
  }

  /// 一个对话实际生效的根。
  ///
  /// null / 空串 = 用户没挑 = 用 App 既有默认（原生侧 `getExternalFilesDir`），
  /// 这是为了让没挑过的对话行为一字不变。挑了才用挑的。
  static String? effectiveRoot(String? conversationRoot) {
    final t = conversationRoot?.trim() ?? '';
    return t.isEmpty ? null : normalize(t);
  }

  /// 这个根是不是 App 自己设计的那个。
  static bool isDesignedRoot(String? root) => effectiveRoot(root) == designedRoot;

  /// 给人看的一句话：这个对话的文件会落到哪。
  static String describeRoot(String? conversationRoot) {
    final effective = effectiveRoot(conversationRoot);
    if (effective == null) {
      return '未指定（用 App 默认目录，文件管理器里看不到）';
    }
    if (effective == designedRoot) {
      return '$effective（App 设计的工作空间，文件管理器可见）';
    }
    final buffer = StringBuffer(effective);
    if (!effective.startsWith(sharedStorageRoot)) {
      buffer.write('（在 /sdcard 之外，文件管理器可能看不到）');
    }
    return buffer.toString();
  }
}
