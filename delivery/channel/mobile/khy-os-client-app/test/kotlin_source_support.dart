/// 读 Kotlin 源文件的测试辅助。
///
/// 为什么单独一个文件：Dart 侧有几处判据是原生 Kotlin 的真源的**镜像**（控制符
/// 名单、shell 白名单/黑名单）。镜像要成立，就得从原生源码读，不能在 Dart 侧抄
/// 一份——抄的那份与原生漂移时，Dart 测试照样绿，而绿的涵义是「真机上发得出去」。
///
/// 这类提取器一旦在多个测试文件里各写一份，就会各自漂移（某一处改了写法、另一处
/// 没跟上）。所以收在这里，一处实现、多处共用。
library;

import 'dart:io';

/// 原生 `ShellCommandPolicy.kt` 的相对位置（相对 Flutter 包根）。
///
/// `flutter test` 的工作目录是包根；另留两个候选兜底 CI 里换目录跑的情况。
const String kShellCommandPolicyPath =
    'android/app/src/main/kotlin/com/khyos/khy_os_client/ShellCommandPolicy.kt';

/// 原生 `MainActivity.kt` 的相对位置（相对 Flutter 包根）。
const String kMainActivityPath =
    'android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt';

/// 原生 `VfsBridge.kt` 的相对位置（相对 Flutter 包根）。
const String kVfsBridgePath =
    'android/app/src/main/kotlin/com/khyos/khy_os_client/vfs/VfsBridge.kt';

/// 按候选路径读一个原生源文件；全都找不到返回 null（由调用方判不通过）。
String? readNativeSource(String relative) {
  for (final candidate in <String>[relative, '../$relative', 'app/$relative']) {
    final file = File(candidate);
    if (file.existsSync()) return file.readAsStringSync();
  }
  return null;
}

/// 从 Kotlin 源文本里取出 `private val <name> = listOf(...)` 的全部字符串条目。
///
/// 为什么按字符扫而不是一条正则抓完：条目里带转义（`"\n"`、`"\r"` 在 Kotlin 里是
/// 一个换行/回车，不是两个字），数组里也可能带行注释，而注释里可能出现引号。按字符
/// 扫才能把「字符串里的引号」和「注释里的引号」分开，并且对换行/缩进的改动不敏感——
/// 只有声明本身与配对的 `)` 算锚点。
List<String> kotlinListEntries(String source, String name) {
  final anchor = 'private val $name = listOf(';
  final declared = source.indexOf(anchor);
  if (declared < 0) return const <String>[];
  var i = source.indexOf('(', declared) + 1;
  final out = <String>[];
  while (i < source.length) {
    final ch = source[i];
    if (ch == '"') {
      final buffer = StringBuffer();
      i++;
      while (i < source.length) {
        final c = source[i];
        if (c == '\\' && i + 1 < source.length) {
          buffer.write(kotlinEscape(source[i + 1]));
          i += 2;
          continue;
        }
        if (c == '"') {
          i++;
          break;
        }
        buffer.write(c);
        i++;
      }
      out.add(buffer.toString());
    } else if (ch == '/' && i + 1 < source.length && source[i + 1] == '/') {
      // 行注释：整行跳过，注释里的引号不是字符串定界符。
      while (i < source.length && source[i] != '\n') {
        i++;
      }
    } else if (ch == ')') {
      // 与 listOf( 配对的右括号：名单结束。
      return out;
    } else {
      i++;
    }
  }
  return out;
}

/// Kotlin 字符串转义的**取值**，不是转义序列本身：`"\n"` 在 Kotlin 里是一个换行。
String kotlinEscape(String ch) {
  switch (ch) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return ch;
  }
}

/// 从 Kotlin 源文本里取出全部 `const val NAME = "value"` 声明。
///
/// 为什么也要按字符扫：值里可能带转义，声明后面可能跟行注释，而注释里可能出现
/// 字符串——一条正则同样分不清。只收 `const val`（编译期常量），不收 `val`：
/// 后者可能由函数算出，不是能静态核对的契约。
Map<String, String> kotlinConstValues(String source) {
  final out = <String, String>{};
  final pattern = RegExp(r'const\s+val\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"');
  for (final match in pattern.allMatches(source)) {
    var i = match.end;
    final buffer = StringBuffer();
    while (i < source.length) {
      final c = source[i];
      if (c == '\\' && i + 1 < source.length) {
        buffer.write(kotlinEscape(source[i + 1]));
        i += 2;
        continue;
      }
      if (c == '"') break;
      buffer.write(c);
      i++;
    }
    out[match.group(1)!] = buffer.toString();
  }
  return out;
}
