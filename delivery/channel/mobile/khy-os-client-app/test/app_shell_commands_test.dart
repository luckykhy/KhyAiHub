import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'kotlin_source_support.dart';

/// App 自己发的 shell 命令，必须过得了原生那道控制符闸门。
///
/// 背景（§9.24）：原生 `MainActivity.isCommandAllowed` 对
/// `;` `&` `|` `` ` `` `>` `<` 与换行 **一律拒绝**（理由是「一条允许的命令
/// 夹带第二条命令」）。而 App 自己发的命令里曾经有一批带这些字符：
///
///   dumpsys connectivity 2>/dev/null | head -30
///   settings get global $key 2>/dev/null || settings get secure $key 2>/dev/null
///
/// 于是它们在真机上**一条都发不出去**：AI 的设备信息工具全哑，「系统应用按
/// 体积排序」也永远拿不到数据——而这两种失败都是**安静**的（降级、不报错）。
///
/// 这个套件扫的是 **App 自己拼出来的命令字面量**。用户或 AI 传来的命令不在
/// 扫描范围内——那类内容本来就该由运行时的闸门去判，不该在源码层拦。
void main() {
  test('App 自己发的命令不含 shell 控制符', () {
    final files = _dartFilesUnder('lib');
    // 扫不到文件 = 扫不成 = 不算通过（cwd 不对就会这样）。
    expect(files.length, greaterThan(20),
        reason: '只扫到 ${files.length} 个 Dart 文件，多半是工作目录不对——'
            '那样这个套件会「绿着骗人」。');
    // 读不到原生控制符名单，这一维就静默失效：一条都不查，也一条都不报。
    expect(_controlChars, isNotEmpty,
        reason: '读不到 ShellCommandPolicy.kt 的 CONTROL_CHARS'
            '（cwd=${Directory.current.path}）——\n'
            '这个套件扫的是 lib/ 下全部 execShell(...) 调用点，覆盖面比镜像测试广，'
            '所以这一维失效的代价更大。读不到就只能判不通过。');

    final offenders = <String>[];
    for (final file in files) {
      final text = file.readAsStringSync();
      for (final match in _callPattern.allMatches(text)) {
        final literal = match.group(1) ?? '';
        final content = _literalContent(literal);
        if (content == null) continue;
        final bad = _firstControlChar(content);
        if (bad != null) {
          offenders.add('${file.path}\n    ${literal.replaceAll('\n', '\\n')}\n    含控制符：$bad');
        }
      }
    }
    expect(offenders, isEmpty,
        reason: '下面这些命令带了控制符，原生闸门会整体拒绝它们：\n'
            '${offenders.join('\n')}');
  });

  // 工具层之外（文件管理器界面、自动化、VFS 侧）的命令调用，必须**显式**写明
  // 来源。
  //
  // 为什么：shell 通道的默认来源是「AI 建议」——工具层（`core/tools`）里的
  // 命令几乎全是 AI 发的，用默认就对了。但工具层之外可能是用户点了某个按钮
  // 触发的（比如「系统应用管理」面板里那一下），那种调用如果忘了写来源，
  // 操作日志就会把**用户自己点的**记成「AI 建议」——那是诬告，比不记更糟。
  //
  // 所以规则是：工具层之外必须显式声明，声明不了就不许调。
  test('工具层之外的命令调用必须显式标注来源', () {
    final files = _dartFilesUnder('lib').where(_isOutsideToolLayer).toList();
    expect(files.length, greaterThan(10),
        reason: '只扫到 ${files.length} 个 Dart 文件，多半是工作目录不对');

    final offenders = <String>[];
    for (final file in files) {
      final text = file.readAsStringSync();
      // 只在「代码」上扫：注释和字符串里的字样不算调用点。
      final code = _codeOnly(text);
      for (final match in _execShellCall.allMatches(code)) {
        final args = _callArgs(code, match.start);
        if (args.contains('source:')) continue;
        offenders.add('${file.path}\n    ${_snippet(code, match.start)}');
      }
    }
    expect(offenders, isEmpty,
        reason: '下面这些调用没有显式标注来源，审计日志会误判是谁干的：\n'
            '${offenders.join('\n')}');
  });
}

/// 是否属于「工具层之外」：要排除 AI 工具目录与通道自身。
bool _isOutsideToolLayer(File file) {
  final path = file.path.replaceAll('\\', '/');
  if (path.contains('/core/tools/')) return false;
  if (path.endsWith('/core/services/device_control.dart')) return false;
  return true;
}

/// `DeviceControl.execShell(...)` / `DeviceControl.execShellElevated(...)`。
final RegExp _execShellCall = RegExp(r'DeviceControl\.execShell(?:Elevated)?\(');

/// 取调用点的参数列表文本（括号配平）。
String _callArgs(String code, int callStart) {
  final open = code.indexOf('(', callStart);
  if (open < 0) return '';
  var depth = 0;
  for (var i = open; i < code.length; i++) {
    final ch = code[i];
    if (ch == '(') {
      depth++;
    } else if (ch == ')') {
      depth--;
      if (depth == 0) return code.substring(open + 1, i);
    }
  }
  return code.substring(open + 1);
}

/// 截一小段源码出来当证据。
String _snippet(String code, int start) {
  final end = code.indexOf(';', start);
  final stop = (end < 0 || end - start > 160) ? start + 160 : end;
  return code.substring(start, stop).replaceAll('\n', ' ').trim();
}

/// 把注释与字符串内容替换成空格（保留长度与换行），只留代码骨架。
///
/// 为什么需要：源码里到处是「注释里提到 execShell(」和「命令字符串里带括号」，
/// 直接扫原文会数出一堆不存在的调用点——那种误报比没有守卫更糟。
String _codeOnly(String text) {
  final buffer = StringBuffer();
  var i = 0;
  final n = text.length;
  while (i < n) {
    final ch = text[i];
    final next = i + 1 < n ? text[i + 1] : '';
    if (ch == '/' && next == '/') {
      while (i < n && text[i] != '\n') {
        buffer.write(' ');
        i++;
      }
      continue;
    }
    if (ch == '/' && next == '*') {
      buffer.write('  ');
      i += 2;
      while (i < n && !(text[i] == '*' && i + 1 < n && text[i + 1] == '/')) {
        buffer.write(text[i] == '\n' ? '\n' : ' ');
        i++;
      }
      if (i < n) {
        buffer.write('  ');
        i += 2;
      }
      continue;
    }
    if (ch == "'" || ch == '"') {
      final quote = ch;
      buffer.write(quote);
      i++;
      while (i < n) {
        if (text[i] == r'\' && i + 1 < n) {
          buffer.write('  ');
          i += 2;
          continue;
        }
        if (text[i] == quote) {
          buffer.write(quote);
          i++;
          break;
        }
        buffer.write(text[i] == '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    buffer.write(ch);
    i++;
  }
  return buffer.toString();
}

/// `execShell(...)` / `execShellElevated(...)` 的**第一个参数字面量**。
///
/// 只认字面量：变量（`execShell(cmd)`）是用户/AI 传进来的内容，不在源码层管。
///
/// 为什么不用 raw 字符串：模式里同时要出现 `'` 与 `"`，而 raw 字符串里的
/// `\"` **不转义引号**——字符串会提前结束，正则就废了。所以这里用普通字符串
/// 逐个转义（`\\` → `\\`，`\"` → `"`）。
final RegExp _callPattern = RegExp(
  "execShell(?:Elevated)?\\(\\s*(r'''[\\s\\S]*?'''|r\"\"\"[\\s\\S]*?\"\"\"|'(?:[^'\\\\\\n]|\\\\.)*'|\"(?:[^\"\\\\\\n]|\\\\.)*\")",
);

/// 取出字面量里的内容（去掉引号；raw 串去标记）。
String? _literalContent(String literal) {
  if (literal.startsWith("r'''") && literal.endsWith("'''") && literal.length >= 6) {
    return literal.substring(4, literal.length - 3);
  }
  if (literal.startsWith('r"""') && literal.endsWith('"""') && literal.length >= 6) {
    return literal.substring(4, literal.length - 3);
  }
  if (literal.length >= 2 &&
      ((literal.startsWith("'") && literal.endsWith("'")) ||
          (literal.startsWith('"') && literal.endsWith('"')))) {
    return literal.substring(1, literal.length - 1);
  }
  return null;
}

/// 原生控制符名单，惰性读一次。
///
/// 为什么读源码而不是在 Dart 侧列一份：这是同一份判据的**第四处抄写**了（另三处：
/// `ShellCommandGuard.kControlChars`、镜像测试的控制符、Kotlin 侧测试的名单快照）。
/// 抄的那份与原生漂移时，这个套件会漏放一条「真机上一条都发不出去」的命令——
/// 而它扫的是 lib/ 下**全部** `execShell(...)` 调用点，比镜像测试的覆盖面更广，
/// 漏放的代价也更大。
late final List<String> _controlChars = _readNativeControlChars();

List<String> _readNativeControlChars() {
  final source = readNativeSource(kShellCommandPolicyPath);
  if (source == null) return const <String>[];
  return kotlinListEntries(source, 'CONTROL_CHARS');
}

/// 第一个控制符（没有就返回 null）。
///
/// 比原生判据多出来的那一项是**源码文本特例**：这个套件扫的是 Dart 源码，源码里的
/// 换行可能写成转义序列（`'ls\n/tmp'`）而不是真换行，所以除了真字符，还要查
/// `\n` / `\r` 这两个字的文本形态。raw 串里的 `\n` 运行时并不是换行，那样写会被
/// 这里多拦一次——方向是安全的（宁可多看一眼），且 lib/ 下目前没有这种写法。
String? _firstControlChar(String content) {
  for (final ch in _controlChars) {
    if (content.contains(ch)) return ch;
  }
  if (content.contains(r'\n') || content.contains(r'\r')) return '换行转义';
  if (content.contains('\n') || content.contains('\r')) return '换行';
  return null;
}

/// 递归列出目录下的 Dart 源文件。
List<File> _dartFilesUnder(String root) {
  final dir = Directory(root);
  if (!dir.existsSync()) return const <File>[];
  final out = <File>[];
  for (final entity in dir.listSync(recursive: true)) {
    if (entity is File && entity.path.endsWith('.dart')) out.add(entity);
  }
  return out;
}
