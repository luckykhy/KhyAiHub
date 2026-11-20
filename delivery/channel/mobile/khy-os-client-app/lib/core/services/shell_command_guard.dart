// AI / 设备控制通道的命令护栏：结构化判定 + 正则兜底。
//
// 为什么放在 core/services 而不是 core/vfs：真正执行命令的入口是
// [DeviceControl.execShell] / [DeviceControl.execShellElevated]（core/services），
// 而 core/vfs 已经依赖 core/services（app_manager.dart 用 DeviceControl）。
// 护栏放在执行侧所在的层，依赖方向就是单向的，不会绕成环。
//
// **为什么需要它**：AI 危险命令过滤器原先只靠一组正则（见 ai_safety.dart）。
// 2026-11-09 用探针实测（§9.23），下面这些写法**全部从正则的缝里钻了过去**：
//
//   rm -r -f /                  （参数拆成两个）
//   rm -f -r /                  （顺序反了）
//   rm --recursive --force /    （长选项）
//   rm -rf /storage/emulated/0  （递归删用户存储根，不是根目录）
//   rm -rf ./                   （等价于删当前目录）
//   chmod 7777 /x               （setuid/setgid 比特）
//   chmod 0777 /x               （前导零写法）
//   mount /dev/block/sda /mnt   （挂载块设备）
//
// 也就是说：AI 只要把命令换个写法，护栏就形同虚设。而这道护栏的**全部意义**
// 就是拦住这些命令——它漏一次，「AI 输出经白名单校验」就是一句空话。
//
// 两层分工：
//   · 结构化判定（本文件的主判定）：把程序名与参数**拆出来**再按语义判，
//     所以「换个写法」骗不过它。
//   · 正则兜底（[kDangerousCommandPatterns]）：接住结构化判定看不见的形态，
//     比如 `mkfs.ext4`（程序名带后缀）、fork 炸弹、重定向写块设备。

/// 一条解析出来的命令。
class ParsedCommand {
  /// 程序名（不含路径）。`/bin/rm` 归一成 `rm`。
  final String program;

  /// 参数（不含程序名本身）。
  final List<String> args;

  const ParsedCommand(this.program, this.args);

  /// 参数里带递归语义（`-r` / `-R` / `--recursive`）。
  bool get hasRecursive {
    for (final a in args) {
      if (a == '--recursive') return true;
      if (a.startsWith('-') && !a.startsWith('--')) {
        final flags = a.substring(1);
        if (flags.contains('r') || flags.contains('R')) return true;
      }
    }
    return false;
  }

  /// 参数里带强制语义（`-f` / `--force` / `--no-preserve-root`）。
  bool get hasForce {
    for (final a in args) {
      if (a == '--force' || a == '--no-preserve-root') return true;
      if (a.startsWith('-') && !a.startsWith('--')) {
        final flags = a.substring(1);
        if (flags.contains('f')) return true;
      }
    }
    return false;
  }

  /// 非选项参数（操作对象）。
  List<String> get operands =>
      args.where((a) => !a.startsWith('-')).toList(growable: false);
}

/// 危险命令模式（正则兜底）。
///
/// 这些模式匹配的是「命令语义」，不是具体字符串：`rm -rf /` 和 `rm -fr /`、
/// `rm -rf --no-preserve-root /` 都要挡住，所以用正则而不是相等比较。
///
/// **它们是兜底，不是主判定**。主判定是 [ShellCommandGuard.reason] 里的
/// 结构化解析——正则扛不住参数的各种写法：`rm -r -f /`（拆成两个参数）、
/// `rm --recursive --force /`（长选项）、`chmod 0777`（前导零）都能从缝里钻过去。
///
/// 2026-11-09 实测（探针跑出来的，见 §9.23）：旧版只靠这组正则时，上面三种
/// 写法**全部放行**。所以现在两层都要在：结构化解析管主流写法，正则兜住
/// 结构化解析看不见的形态（比如 `mkfs.ext4` 这种带后缀的程序名）。
///
/// **为什么锚在段首**（`(?:^|[;|&\\n])\s*`）：正则匹配的是**位置**，而
/// 「提到」不等于「执行」。`echo rm -rf /` 只是把这句话打印出来，`grep 'rm -rf'
/// notes.md` 只是在搜文本——旧版不锚定，把这两条也判成危险，于是 AI 写个说明
/// 都被拦。锚在段首之后，只有**真的作为一条命令**出现时才命中。
/// 唯一的例外是最后一条（重定向）：`> /dev/block` 的危险在**目标**，跟它在
/// 哪个位置无关，所以不锚定。
///
/// 不是 `const` 列表：RegExp 没有 const 构造器，写成 const 会在编译期直接报错。
final List<RegExp> kDangerousCommandPatterns = <RegExp>[
  // 递归删根或递归删通配根。
  RegExp(r'(?:^|[;|&\\n])\s*rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*[fF]|-[a-zA-Z]*[fF][a-zA-Z]*[rR])\b[^|;&]*\s/(?:\s|$|\*)'),
  // 根目录级递归删除的常见变体。
  RegExp(r'(?:^|[;|&\\n])\s*rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+--no-preserve-root'),
  // 放宽权限到 777。
  RegExp(r'(?:^|[;|&\\n])\s*chmod\s+(?:-[a-zA-Z]+\s+)*777\b'),
  RegExp(r'(?:^|[;|&\\n])\s*chown\b[^|;&]*\s/(?:\s|$)'),
  // 文件系统格式化（`mkfs.ext4` 这种带后缀的程序名结构化判定认不出来）。
  RegExp(r'(?:^|[;|&\\n])\s*mkfs(\.\w+)?\b'),
  // 直接写块设备。
  RegExp(r'(?:^|[;|&\\n])\s*dd\b[^|;&]*\bof=/dev/'),
  // fork 炸弹。
  RegExp(r'(?:^|[;|&\\n])\s*:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:'),
  // 关掉 SELinux 强制。
  RegExp(r'(?:^|[;|&\\n])\s*setenforce\s+0\b'),
  // 内核模块（Root 语义的操作）。
  RegExp(r'(?:^|[;|&\\n])\s*(insmod|rmmod|modprobe)\b'),
  // 擦除工具。
  RegExp(r'(?:^|[;|&\\n])\s*(shred|wipe)\b'),
  // 覆盖块设备节点（重定向不锚定：危险在目标，与位置无关）。
  RegExp(r'>\s*/dev/block'),
];

/// 命令解析与危险判定的纯逻辑。
abstract final class CommandSafety {
  /// 解释器：`sh -c '<命令>'` 这种包装里装的是**另一条命令**。
  static const Set<String> kInterpreters = <String>{
    'sh', 'bash', 'ash', 'dash', 'zsh', 'ksh',
  };

  /// 前缀包装：真正要判的是它们**后面**那条命令。
  static const Set<String> kWrappers = <String>{
    'env', 'nice', 'nohup', 'setsid', 'stdbuf', 'ionice',
    'command', 'exec', 'time', 'sudo', 'doas', 'busybox', 'timeout',
  };

  /// 包装器里「选项要吃掉一个值」的那些。
  ///
  /// 漏掉这一条，`env -u FOO rm -rf /` 会被判成「env 带了一个操作对象 FOO」，
  /// 于是 `rm -rf /` 这一段根本没被看见。
  static const Map<String, Set<String>> kWrapperValueOptions = <String, Set<String>>{
    'env': <String>{'-u', '-C', '-S'},
    'nice': <String>{'-n', '--adjustment'},
  };

  /// 把一条命令字符串拆成若干条子命令。
  ///
  /// 按 `;`、`&&`、`||`、`|`、`&` 切分：这些是 shell 的命令连接符，
  /// 它们后面跟的是**另一条命令**，必须**各自**判一遍——只看整串的前半段
  /// 的话，`ls && rm -rf /` 会因为开头是 `ls` 而放行。
  ///
  /// 不做引号解析：引号里的内容仍按普通字符处理。这对安全性是**保守**的
  /// （引号内的危险串照样会被匹配到），对准确性略有损失——但为了判危险，
  /// 宁可多拦。
  static List<ParsedCommand> split(String command) {
    final parts = <String>[];
    final buffer = StringBuffer();
    for (var i = 0; i < command.length; i++) {
      final ch = command[i];
      if (ch == ';' || ch == '|' || ch == '&' || ch == '\n') {
        parts.add(buffer.toString());
        buffer.clear();
        continue;
      }
      buffer.write(ch);
    }
    parts.add(buffer.toString());

    final parsed = <ParsedCommand>[];
    for (final part in parts) {
      final trimmed = part.trim();
      if (trimmed.isEmpty) continue;
      final tokens = _tokenize(trimmed);
      if (tokens.isEmpty) continue;
      parsed.add(ParsedCommand(_programName(tokens.first), tokens.sublist(1)));
    }
    return parsed;
  }

  /// 把一段命令切成词。
  ///
  /// 按空白切，但**保留**引号内的空格——`rm "my file"` 是一个操作对象，
  /// 切成两个就等于把它当成了两个路径，判起来就不准了。
  static List<String> _tokenize(String text) {
    final tokens = <String>[];
    final buffer = StringBuffer();
    var quote = '';
    var has = false;
    for (var i = 0; i < text.length; i++) {
      final ch = text[i];
      if (quote.isNotEmpty) {
        if (ch == quote) {
          quote = '';
        } else {
          buffer.write(ch);
        }
        continue;
      }
      if (ch == '"' || ch == "'") {
        quote = ch;
        has = true;
        continue;
      }
      if (ch == ' ' || ch == '\t') {
        if (has || buffer.isNotEmpty) {
          tokens.add(buffer.toString());
          buffer.clear();
          has = false;
        }
        continue;
      }
      buffer.write(ch);
    }
    if (has || buffer.isNotEmpty) tokens.add(buffer.toString());
    return tokens;
  }

  /// 取程序名：去掉路径部分。
  ///
  /// `/bin/rm`、`/usr/bin/rm`、`rm` 是同一个命令。
  static String _programName(String token) {
    final slash = token.lastIndexOf('/');
    if (slash < 0) return token;
    final name = token.substring(slash + 1);
    return name.isEmpty ? token : name;
  }

  /// 判定一条命令是否危险。
  ///
  /// @return 危险时给出人话理由；安全时返回 null。
  static String? reason(String command, {int depth = 0}) {
    // 递归深度封顶：解释器可以套解释器、命令替换可以套命令替换，
    // 不封顶就可能被套娃拖成死循环。
    if (depth >= 4) return null;

    // 命令替换：`$(...)` 与反引号里装的是**另一条命令**，而且它会真的执行。
    // `echo $(rm -rf /)` 看着像 echo，实际那条 rm 照跑不误。
    for (final inner in _substitutions(command)) {
      final why = reason(inner, depth: depth + 1);
      if (why != null) return why;
    }

    for (final parsed in split(command)) {
      final why = _reasonOf(parsed, depth: depth);
      if (why != null) return why;
    }
    return null;
  }

  /// 把命令替换里的内容抠出来。
  ///
  /// 两种形态：`$( ... )` 与反引号 `` ` ... ` ``。括号按**配对**找结尾，
  /// 免得 `$(echo (a))` 取到一半。
  static List<String> _substitutions(String command) {
    final out = <String>[];

    for (var i = 0; i < command.length; i++) {
      if (command[i] != '\$' ||
          i + 1 >= command.length ||
          command[i + 1] != '(') {
        continue;
      }
      var depth = 1;
      var j = i + 2;
      for (; j < command.length; j++) {
        final ch = command[j];
        if (ch == '(') {
          depth++;
        } else if (ch == ')') {
          depth--;
          if (depth == 0) break;
        }
      }
      if (j < command.length) out.add(command.substring(i + 2, j));
      i = j;
    }

    var start = command.indexOf('`');
    while (start >= 0) {
      final end = command.indexOf('`', start + 1);
      if (end < 0) break;
      out.add(command.substring(start + 1, end));
      start = command.indexOf('`', end + 1);
    }
    return out;
  }

  /// 判定单条（已解析的）命令是否危险。
  static String? _reasonOf(ParsedCommand cmd, {required int depth}) {
    // 递归深度封顶：解释器可以套解释器（`sh -c "sh -c '...'"`），
    // 不封顶就可能被套娃拖成死循环。
    if (depth >= 4) return null;

    // 解释器包装：`sh -c '<真正的命令>'`。
    if (kInterpreters.contains(cmd.program)) {
      final payload = _interpreterPayload(cmd);
      if (payload != null) return reason(payload, depth: depth + 1);
      return null;
    }

    // 前缀包装：`env` / `sudo` / `busybox` / `timeout 5` 等——真正要判的是
    // 它们后面那条命令。不拆这层，`busybox rm -rf /` 会因为程序名是
    // `busybox` 而被放行。
    if (kWrappers.contains(cmd.program)) {
      final inner = _strippedWrapper(cmd);
      if (inner != null) return _reasonOf(inner, depth: depth + 1);
      return null;
    }

    switch (cmd.program) {
      case 'rm':
        return _reasonRm(cmd);
      case 'chmod':
        return _reasonChmod(cmd);
      case 'chown':
        return _reasonChown(cmd);
      case 'mount':
      case 'umount':
        return _reasonMount(cmd);
      case 'mkfs':
        return '格式化文件系统';
      case 'dd':
        return cmd.args.any((a) => a.startsWith('of=/dev/'))
            ? '直接写块设备'
            : null;
      case 'setenforce':
        return cmd.operands.contains('0') ? '关闭 SELinux 强制模式' : null;
      case 'insmod':
      case 'rmmod':
      case 'modprobe':
        return '加载或卸载内核模块';
      case 'shred':
      case 'wipe':
        return '用擦除工具覆写数据';
      case 'reboot':
      case 'shutdown':
      case 'halt':
      case 'poweroff':
        return '关机或重启设备';
      case 'format':
        return '格式化存储';
      default:
        return null;
    }
  }

  /// `sh -c '<载荷>'` 里的载荷。
  static String? _interpreterPayload(ParsedCommand cmd) {
    for (var i = 0; i < cmd.args.length; i++) {
      final a = cmd.args[i];
      if (a == '-c' && i + 1 < cmd.args.length) return cmd.args[i + 1];
      // `sh -lc '<载荷>'` 这种黏在一起的写法。
      if (a.startsWith('-') && a.endsWith('c') && a.length > 1) {
        if (i + 1 < cmd.args.length) return cmd.args[i + 1];
      }
    }
    return null;
  }

  /// 去掉前缀包装，取出**里面**那条命令。
  ///
  /// 包装器自己带的选项要一并吃掉：`env -u FOO rm -rf /` 里 `-u FOO` 是
  /// env 的选项，不是要判的命令；`timeout 5 rm -rf /` 里 `5` 是时长。
  static ParsedCommand? _strippedWrapper(ParsedCommand cmd) {
    final args = <String>[...cmd.args];
    final valueOptions = kWrapperValueOptions[cmd.program] ?? const <String>{};

    // 先吃掉选项（连同需要值的那个）。
    while (args.isNotEmpty) {
      final a = args.first;
      if (!a.startsWith('-')) break;
      args.removeAt(0);
      if (valueOptions.contains(a) && args.isNotEmpty) {
        args.removeAt(0);
      }
    }

    // `timeout 5 ...`：时长是位置参数，得专门去掉。
    if (cmd.program == 'timeout' && args.isNotEmpty) {
      final first = args.first;
      if (RegExp(r'^\d+(\.\d+)?[smhd]?$').hasMatch(first)) {
        args.removeAt(0);
      }
    }

    if (args.isEmpty) return null;
    return ParsedCommand(_programName(args.first), args.sublist(1));
  }

  /// `rm` 的判定。
  ///
  /// 规则：**递归**（`-r`/`-R`/`--recursive`）删**存储根 / 分区根**就危险。
  ///
  /// 分三档：
  ///  1. 根与通配根（`/`、`/*`、`/.`）——删掉整个系统；
  ///  2. 系统分区（`/system`、`/data`、`/proc`…）——删掉系统的一部分；
  ///  3. 用户存储根（`/storage/emulated/0`、`/sdcard`）——删掉全部用户数据。
  ///
  /// 为什么把「递归删存储根」也算危险：用户在这个 App 里最常做的事就是
  /// 删文件，而 AI 给出一条「清理重复照片」的命令时，`rm -rf /storage/emulated/0`
  /// 看起来人畜无害——**递归 + 目标是存储根**才是要点：它会把整棵用户数据
  /// 树删掉，而用户以为只是删了几张照片。
  ///
  /// 而「递归删某个子目录」（`/storage/emulated/0/Download`、某个应用私有目录）
  /// **不在这里拦**：那是「高危但合法」，该走确认流程，不是直接禁掉。
  /// 拦与不拦的分界在 [_isStorageRoot] 与 [_isUnderUserStorage]。
  static String? _reasonRm(ParsedCommand cmd) {
    if (!cmd.hasRecursive) return null;
    for (final operand in cmd.operands) {
      if (_isRootLike(operand)) return '递归删除根目录';
      if (_isStorageRoot(operand)) return '递归删除存储根或系统分区';
      if (_isUserStorageRoot(operand)) return '递归删除用户存储根';
      // 操作对象是命令替换出来的：`rm -rf $(echo /)` 展开后是什么，静态判不出来。
      // 判不出来就不能放行——这条的落点是「不确定」，不是「已知安全」。
      if (operand.contains('\$(') || operand.contains('`')) {
        return '递归删除的目标由命令替换产生，无法静态判定';
      }
    }
    return null;
  }

  /// `chmod` 的判定。
  ///
  /// 危险的是把权限放到 **777 或更宽**：
  ///  - `777` 本身；
  ///  - `7777` / `0777` 这类带 setuid/setgid/sticky 位的写法——它们权限更宽，
  ///    不是「更严」；
  ///  - 数字权限要按**八进制**看：`0777` 与 `777` 是同一个值。
  ///
  /// 只拦 777 这一档而不是「任何三位数」：`chmod 755` 是正常操作，不该拦。
  static String? _reasonChmod(ParsedCommand cmd) {
    for (final operand in cmd.operands) {
      if (_isWorldWritableMode(operand)) return '把权限放开到 777 及更宽';
    }
    return null;
  }

  /// 权限位是否是「全开放」（777 及更宽）。
  ///
  /// 只看**数字**权限（八进制），不看符号权限（`a+rwx`）——符号写法表达的是
  /// 「加这些权限」，同样危险，但判定要靠另一种解析（按 who/operator 组合），
  /// 复杂度高且收益低：AI 生成命令时用数字写法占绝大多数。
  /// `chmod +x` 这种加一个执行位的正常操作不在此列。
  static bool _isWorldWritableMode(String operand) {
    if (!RegExp(r'^[0-7]{3,4}$').hasMatch(operand)) return false;
    // 去掉前导零后按八进制看低三位：777 及以上（更高位是 setuid/setgid/sticky）
    final digits = operand.replaceFirst(RegExp(r'^0+'), '');
    if (digits.length < 3) return false;
    final low = digits.substring(digits.length - 3);
    final value = int.tryParse(low, radix: 8);
    if (value == null) return false;
    return value >= 0x1FF; // 0777
  }

  /// `chown` 的判定：改根目录或系统分区的属主。
  static String? _reasonChown(ParsedCommand cmd) {
    for (final operand in cmd.operands) {
      if (_isRootLike(operand)) return '改写根目录的属主';
      if (_isSystemPartition(operand)) return '改写系统分区的属主';
    }
    return null;
  }

  /// `mount` / `umount` 的判定：挂载块设备或系统分区。
  ///
  /// 挂载本身要 root，而 AI 不该生成要 root 的命令——`mount /dev/block/sda /mnt`
  /// 这类会直接改掉系统的分区视图。
  static String? _reasonMount(ParsedCommand cmd) {
    for (final operand in cmd.operands) {
      if (operand.startsWith('/dev/')) return '挂载块设备';
      if (_isRootLike(operand)) return '挂载根目录';
      if (_isSystemPartition(operand)) return '挂载系统分区';
    }
    return null;
  }

  /// 是不是「根或通配根」这类目标。
  static bool _isRootLike(String path) {
    final p = path.trim();
    if (p == '/' || p == '/*' || p == '/.' || p == './' || p == '../') return true;
    // `//`、`/./*` 这两个通配根写法。
    if (p == '//') return true;
    if (p.startsWith('/./*')) return true;
    return false;
  }

  /// 是不是「存储根 / 系统分区」这类目标。
  ///
  /// 这些是**分区本身**：递归删掉它们等于抹掉一整个分区。
  static bool _isStorageRoot(String path) {
    final p = path.trim();
    for (final root in <String>[
      '/system', '/vendor', '/product', '/apex', '/odm',
      '/proc', '/sys', '/dev',
      '/data', '/data/data', '/data/user',
      '/storage', '/storage/emulated',
    ]) {
      if (p == root) return true;
    }
    return false;
  }

  /// 是不是系统分区（含其下的路径）。
  static bool _isSystemPartition(String path) {
    final p = path.trim();
    for (final root in <String>['/system', '/vendor', '/product', '/apex', '/odm']) {
      if (p == root || p.startsWith('$root/')) return true;
    }
    return false;
  }

  /// 是不是用户存储的**根**（不是它下面的子目录）。
  static bool _isUserStorageRoot(String path) {
    final p = path.trim();
    if (p == '/storage/emulated/0' || p == '/storage/emulated/0/') return true;
    // `/sdcard` 这类别名同样指向用户存储。
    if (p == '/sdcard' || p == '/sdcard/') return true;
    return false;
  }
}

/// 命令护栏的对外入口。
///
/// 两层判定：先结构化（[CommandSafety]），再正则兜底
/// （[kDangerousCommandPatterns]）。任一层命中就拒绝。
abstract final class ShellCommandGuard {
  /// 原生闸门禁掉的 shell 控制符。
  ///
  /// 原生那道闸门（`MainActivity.isCommandAllowed`）对它们一律拒绝，理由是
  /// 「一条允许的命令夹带第二条命令」。所以 **App 自己发的命令也必须不含
  /// 这些字符**——被自家闸门挡回来是最荒唐的一种坏法（§9.24）。
  static const List<String> kControlChars = <String>[
    ';', '&', '|', '`', '\$(', '>', '<', '\n', '\r',
  ];

  /// 这条命令能不能过原生那道控制符闸门。
  ///
  /// 为什么把这条判据也放在 Dart 侧：原生那道只回答「能不能跑」，不告诉调用方
  /// 「你的命令为什么发不出去」；App 侧能在**开发期**就发现自己拼了一条过不去
  /// 的命令，而不是等真机上一片「命令被拒绝」。
  static bool hasControlChar(String command) {
    for (final ch in kControlChars) {
      if (command.contains(ch)) return true;
    }
    return false;
  }

  /// 取前 [n] 行（替代 `| head -n`）。
  ///
  /// 为什么要自己截断而不让 shell 截：`|` 本身就是控制符，命令里带管道就过不了
  /// 原生那道闸门。截断搬到 Dart 侧做，效果一样（少几行输出），而命令本身是
  /// 干净的。原生侧 stdout 与 stderr 是分开抽的（`ShellRunner` 两个线程），
  /// 所以连 `2>/dev/null` 都是多余的——错误信息本来就单独在 stderr 里。
  static String firstLines(String text, int n) {
    if (n <= 0) return text;
    final lines = text.split('\n');
    if (lines.length <= n) return text;
    return lines.take(n).join('\n');
  }

  /// 这条命令该不该被拒绝。
  ///
  /// @return 该拒绝时给出**具体**理由（人能看懂「为什么被拦」），
  ///         放行时返回 null。
  static String? reason(String command) {
    final trimmed = command.trim();
    if (trimmed.isEmpty) return '空命令';

    final structured = CommandSafety.reason(trimmed);
    if (structured != null) return structured;

    for (final pattern in kDangerousCommandPatterns) {
      if (pattern.hasMatch(trimmed)) return '命中危险命令模式';
    }
    return null;
  }

  /// 这条命令是不是「危险模式」（用于决定要不要弹确认框）。
  static bool isDangerous(String command) => reason(command) != null;
}
