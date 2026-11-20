// 终端命令解析：把用户敲的一行拆成「要不要切目录」与「交给 shell 的命令体」。
//
// 为什么单独成文件，而不是塞进终端抽屉的 widget 里：
//   这条规则是**纯逻辑**，可以在没有设备、没有 MethodChannel 的情况下测。
//   抽屉是 widget，测它要起 Flutter 引擎；而这条规则恰恰是出过错的地方——
//   cwd 曾被拼成 `cd <dir> && cmd` 发给原生，命令体里因此带上了 `&&`，
//   而 shell 控制符是硬禁的，结果终端在真机上一条命令都发不出去。
//
// 定位：终端是**人工命令区**，命令由用户自己敲。这里只做两件事：
//   1. 认出「切目录」这种 shell 内建（cd 是内建，交给原生会被准入策略拒掉，
//      所以在 Dart 侧就地处理成「换 cwd」）；
//   2. 把相对路径解析成绝对路径，让终端显示的 cwd 与实际落点一致。
// 危险命令的准入在原生侧（TerminalShell）——Dart 侧不重复一份白名单，
// 两份白名单必然漂移。

/// 终端里一条命令的解析结果。
class TerminalCommand {
  /// 是否是一条「切换工作目录」命令。
  final bool changesDirectory;

  /// 目标目录。仅 [changesDirectory] 为 true 时有值。
  final String? targetDirectory;

  /// 交给 shell 执行的命令体。切目录命令时为空。
  final String shellCommand;

  const TerminalCommand({
    required this.changesDirectory,
    this.targetDirectory,
    required this.shellCommand,
  });
}

/// 解析一行终端输入。
///
/// 只认「cd 空格 路径」这一种形态：`cd` 是 shell 内建，且带参数的形式容易和
/// `cd -`（回到上一个目录）、`cd`（回 home）混淆——这两种都不支持，
/// 宁可明确不支持，也不要猜错落点。
TerminalCommand parseTerminalCommand(String raw) {
  final text = raw.trim();
  if (text.isEmpty) {
    return const TerminalCommand(changesDirectory: false, shellCommand: '');
  }

  final match = RegExp(r'^cd\s+(.+)$').firstMatch(text);
  if (match == null) {
    return TerminalCommand(changesDirectory: false, shellCommand: text);
  }

  return TerminalCommand(
    changesDirectory: true,
    targetDirectory: _unquote(match.group(1)!.trim()),
    shellCommand: '',
  );
}

/// 把相对路径解析成绝对路径，并消掉 `.` 与 `..`。
///
/// 为什么要在 Dart 侧做归一化：终端顶栏显示的是 cwd，下一条命令就在那儿跑。
/// 如果显示的是 `/a/b/../c` 而实际跑在 `/a/c`，用户看到的落点与真实落点对不上，
/// 排查起来极其困难。归一化后显示与执行用的是同一个字符串。
String resolveTerminalPath(String cwd, String target) {
  final raw = target.trim();
  if (raw.isEmpty) return cwd;

  final base = raw.startsWith('/') ? raw : '$cwd/$raw';
  final segments = <String>[];
  for (final part in base.split('/')) {
    if (part.isEmpty || part == '.') continue;
    if (part == '..') {
      if (segments.isNotEmpty) segments.removeLast();
      continue;
    }
    segments.add(part);
  }
  return '/${segments.join('/')}';
}

/// 去掉路径外层的一层引号。
String _unquote(String value) {
  if (value.length >= 2) {
    final first = value[0];
    final last = value[value.length - 1];
    if ((first == "'" && last == "'") || (first == '"' && last == '"')) {
      return value.substring(1, value.length - 1);
    }
  }
  return value;
}
