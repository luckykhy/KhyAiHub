import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'kotlin_source_support.dart';

/// VFS 错误码的跨语言契约：**Dart 按码分支的每一个码，原生必须真的会抛。**
///
/// ## 为什么要有这个套件
///
/// 错误码是通道契约的第四个维度（前三个：方法名 `vfs_channel_wiring_test`、
/// 字段 `vfs_field_contract_test`、请求参数名）。它比前三个更隐蔽，因为 Dart 侧
/// **只有一处**按原生错误码分支：
///
/// ```dart
/// if (result['error'] == 'elevation_unavailable') { /* 灰态 + 引导 */ }
/// ```
///
/// 这一处正是目标 §五 的要求「提权代理 未激活时，私有目录显示为灰色占位符 +
/// 点击激活访问引导，**而非报错**」。原生把 `ERR_ELEVATION_UNAVAILABLE` 改个名，
/// Dart 这个 `==` 就静默失配——用户看到的从「灰态 + 引导」变成「一条报错」，
/// 而**没有任何测试会红**：分支失配不产生异常，只是不再走进那段代码。
///
/// ## 钉住的两件事
///
/// 1. Dart 按码分支的每个码，都在原生 `const val ERR_*` 的取值集合里；
/// 2. 原生那 10 个码解析得到（解析不到 = 不通过，不是跳过）。
void main() {
  test('Dart 按码分支的每个错误码，原生都会抛', () {
    final source = readNativeSource(kVfsBridgePath);
    expect(source, isNotNull,
        reason: '读不到 VfsBridge.kt（cwd=${Directory.current.path}）——\n'
            '这条测试要把 Dart 的错误码分支钉回原生真源，读不到就只能判不通过；\n'
            '跳过它，下面的比对会假绿。');

    final nativeCodes = kotlinConstValues(source!)
        .entries
        .where((e) => e.key.startsWith('ERR_'))
        .map((e) => e.value)
        .toSet();
    expect(nativeCodes, isNotEmpty,
        reason: '从 VfsBridge.kt 解析不到任何 const val ERR_* 声明。\n'
            '空集合会让下面的「子集」判定意外成立（Dart 分支是空集时也通过）。');

    final branchCodes = _dartBranchCodes();
    expect(branchCodes, isNotEmpty,
        reason: '在 lib/ 下一个错误码分支都没找到（形如 result[\'error\'] == \'x\'）。\n'
            '要么写法变了，要么那条灰态降级被删了——两种都应该让人知道，\n'
            '而不是让这个套件空转着绿。');

    final unknown = branchCodes.difference(nativeCodes);
    expect(unknown, isEmpty,
        reason: 'Dart 在这些错误码上分支，但原生不抛它们：$unknown\n'
            '后果不是报错，而是**静默走错分支**——分支失配不产生异常，\n'
            '只是不再走进那段代码。最典型的一处：\n'
            '  elevation_unavailable 失配 → 私有目录从「灰态 + 引导」变成「一条报错」\n'
            '原生码集合 = ${nativeCodes.toList()..sort()}');
  });
}

/// Dart 侧**按原生错误码分支**的地方。
///
/// 只收 `==` / `!=` 比较形态，不收 `throw VfsException('x', ...)`——那是 Dart
/// 自己当**生产者**，不是消费原生的码，两者契约方向相反。
///
/// 为什么也扫注释之外的全部 lib/：错误码分支可能出现在任何消费通道回执的地方
/// （列表、复制、watcher、自动化），不止 `vfs_service.dart` 一处。
Set<String> _dartBranchCodes() {
  final out = <String>{};
  final dir = Directory('lib');
  if (!dir.existsSync()) return out;
  // result['error'] == 'x' / result["error"] != "x" / error == 'x'
  final pattern = RegExp(
    r"""(?:\[['"]error['"]\]|(?<![.\w])error)\s*(?:==|!=)\s*['"]([a-z_]+)['"]""",
  );
  for (final entity in dir.listSync(recursive: true)) {
    if (entity is! File || !entity.path.endsWith('.dart')) continue;
    for (final match in pattern.allMatches(entity.readAsStringSync())) {
      out.add(match.group(1)!);
    }
  }
  return out;
}
