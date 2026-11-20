import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// VFS 通道的接线纪律：**Dart 调的方法名，原生必须注册；原生注册的，Dart 必须真在调。**
///
/// ## 为什么要有这个套件
///
/// 这是第二十六轮做的一次静态核对你一句「顺带」带出来的。核对时发现：Dart 侧的
/// 通道调用有两种形态——`VfsChannel.call('archiveList', ...)` 与裸
/// `invokeMethod('archiveList')`，而且**方法名常常不在 `call(` 那一行**：
///
/// ```dart
/// final result = await VfsChannel.call(
///   'appUninstall',          // ← 名字在下一行
///   <String, dynamic>{'pkg': pkg},
/// );
/// ```
///
/// 这意味着任何按行匹配的核对都会漏。而漏掉的后果是**静默失败**：Dart 发一个
/// 原生没注册的方法名，原生走到 `else -> throw VfsError(ERR_UNKNOWN, ...)`，
/// 用户看到的是「操作失败」，没有任何线索指向「方法名拼错了」。单测更抓不到——
/// Dart 侧的单测 mock 掉通道，问什么答什么，接线错了照样绿。
///
/// ## 钉住的三件事
///
///   1. **解析不到原生分发表 = 不通过**（不是跳过）：扫不到文件比没有套件更糟，
///      因为门读到的是绿灯；
///   2. Dart 通过 `VfsChannel.call` 发的每个方法名，原生都必须注册；
///   3. 原生注册的每个 VFS 方法名，Dart 都必须真在调（死分支同样是坏味道——
///      它说明「以为接上了，其实没接」）。
void main() {
  group('VFS 通道接线', () {
    test('原生分发表解析得到（扫不到就是不通过）', () {
      final dispatch = _nativeDispatch();
      expect(
        dispatch,
        isNotEmpty,
        reason: '解析不到 VfsBridge.kt 的 when (call.method) 分发表——\n'
            '要么工作目录不对，要么原生改了写法（换了锚点/缩进）。\n'
            '这种情况下后面的断言都会假绿，所以这里直接判不通过。',
      );
    });

    test('Dart 调的每个 VFS 方法名，原生都注册了', () {
      final dispatch = _nativeDispatch();
      expect(dispatch, isNotEmpty, reason: '分发表解析不到，见上一个用例');

      final dartNames = _dartVfsCallNames();
      expect(
        dartNames,
        isNotEmpty,
        reason: 'Dart 侧一个 VfsChannel.call 都扫不到——\n'
            '要么 lib/ 路径不对，要么调用形态变了（改成别的包装器）。',
      );

      final unregistered = <String>[];
      for (final name in dartNames) {
        if (!dispatch.contains(name)) unregistered.add(name);
      }

      expect(
        unregistered,
        isEmpty,
        reason: '下面这些方法名 Dart 在发，原生却没注册——\n'
            '真机上每条都会走到原生的 else 分支，用户只看到「操作失败」，\n'
            '没有任何线索指向「方法名对不上」。单测也抓不到：Dart 单测\n'
            'mock 掉通道，问什么答什么，接线错了照样绿：\n'
            '  ${unregistered.join('\n  ')}',
      );
    });

    test('原生注册的每个 VFS 方法名，Dart 都真在调', () {
      final dispatch = _nativeDispatch();
      expect(dispatch, isNotEmpty, reason: '分发表解析不到，见第一个用例');

      final dartNames = _dartVfsCallNames();
      expect(dartNames, isNotEmpty, reason: 'Dart 调用点扫不到');

      final dead = <String>[];
      for (final name in dispatch) {
        if (!dartNames.contains(name)) dead.add(name);
      }

      expect(
        dead,
        isEmpty,
        reason: '下面这些方法原生注册了，Dart 却从来没调——\n'
            '那是死分支：看起来「能力在」，用户点不到。\n'
            '要么把入口接上，要么把注册删掉，别留着一个没人用的门：\n'
            '  ${dead.join('\n  ')}',
      );
    });

    test('裸 invokeMethod 发的名字，Kotlin 某一处分发表了', () {
      // 这一条比上面三条宽：`invokeMethod` 可能发在设备通道、amoo 通道上，
      // 不只 VFS。所以判据放宽成「Kotlin 里任意一处 when 分发表有它」。
      final tables = _allKotlinDispatchNames();
      expect(
        tables,
        isNotEmpty,
        reason: '一个 Kotlin 分发表都扫不到——要么路径不对，要么全改了写法。',
      );

      final dartNames = _dartInvokeMethodNames();
      final orphans = <String>[];
      for (final name in dartNames) {
        if (!tables.contains(name)) orphans.add(name);
      }

      expect(
        orphans,
        isEmpty,
        reason: '下面这些名字 Dart 通过 invokeMethod 发出，\n'
            '但 Kotlin 里找不到任何一处 when 分发表注册它——\n'
            '真机上同样是静默失败：\n'
            '  ${orphans.join('\n  ')}',
      );
    });
  });
}

/// 从原生 `VfsBridge.kt` 读出 `when (call.method)` 分发表里的方法名。
///
/// 为什么锚在 `when (call.method)`：`VfsBridge.kt` 里还有别的 `when`（冲突策略
/// 的 `"skip" ->` / `"overwrite" ->` / `"merge" ->`），那些**不是方法名**。
/// 不锚定就会把冲突策略当成通道方法——第一次核对时正是这么错的，报出一堆
/// 「注册了但没人调」的假阳性。
Set<String> _nativeDispatch() {
  final file = File(
    'android/app/src/main/kotlin/com/khyos/khy_os_client/vfs/VfsBridge.kt',
  );
  if (!file.existsSync()) return const <String>{};
  final text = file.readAsStringSync();

  final start = text.indexOf('when (call.method)');
  if (start < 0) return const <String>{};
  final end = text.indexOf('else ->', start);
  if (end < 0) return const <String>{};
  final body = text.substring(start, end);

  final out = <String>{};
  for (final match in RegExp('"([A-Za-z0-9_]+)"\\s*->').allMatches(body)) {
    out.add(match.group(1)!);
  }
  return out;
}

/// Kotlin 里**所有** `when (...)` 分发表的名字（宽口径，供宽判据用）。
///
/// 与 [_nativeDispatch] 的区别：不锚方法名，任何 `"x" ->` 形态都收。宽判据
/// 只需要「某个地方注册过」，不需要精确。
Set<String> _allKotlinDispatchNames() {
  final root = Directory(
    'android/app/src/main/kotlin/com/khyos/khy_os_client',
  );
  if (!root.existsSync()) return const <String>{};
  final out = <String>{};
  for (final entity in root.listSync(recursive: true)) {
    if (entity is! File || !entity.path.endsWith('.kt')) continue;
    final text = entity.readAsStringSync();
    for (final match in RegExp('"([A-Za-z0-9_]+)"\\s*->').allMatches(text)) {
      out.add(match.group(1)!);
    }
  }
  return out;
}

/// Dart 侧通过 `VfsChannel.call(...)` 发出的方法名。
///
/// **必须跨行取**：调用点常常写成
/// ```dart
/// VfsChannel.call(
///   'appUninstall',
///   <String, dynamic>{'pkg': pkg},
/// );
/// ```
/// 方法名在 `call(` 的下一行。按行匹配会整类漏掉——第一次核对时就漏了
/// `appUninstall` / `appDisable` / `appEnable` 三个，还以为接线是好的。
Set<String> _dartVfsCallNames() {
  return _dartCallNames(RegExp(r'VfsChannel\.call\s*\('));
}

/// Dart 侧所有 `invokeMethod(...)` / `invokeMethod<T>(...)` 的方法名。
Set<String> _dartInvokeMethodNames() {
  return _dartCallNames(RegExp(r'invokeMethod(?:<[^>]*>)?\s*\('));
}

/// 通用提取：找到 [anchor] 的每个匹配，取其后的第一个字符串字面量。
///
/// **只看调用点的实参列表，不往文件剩余部分扫**。这一点是实测出来的：第一版
/// 用 `firstMatch(text.substring(match.end))`，结果 `invokeMethod(method, args)`
/// 这种**方法名是变量**的调用点，被抓成了文件后半段随便某个字符串字面量——
/// 报出 `on` / `ok` / `message` 三个「原生没注册」的假阳性。守卫自己撒谎比
/// 没有守卫更糟，所以这里改成：跳过空白后如果不是引号，就**放弃这个调用点**
/// （静态拿不到名字，不猜）。
Set<String> _dartCallNames(RegExp anchor) {
  final root = Directory('lib');
  if (!root.existsSync()) return const <String>{};
  final out = <String>{};
  for (final entity in root.listSync(recursive: true)) {
    if (entity is! File || !entity.path.endsWith('.dart')) continue;
    final text = entity.readAsStringSync();
    for (final match in anchor.allMatches(text)) {
      // 从调用点的左括号之后开始，只跳过空白（含换行）。
      var i = match.end;
      while (i < text.length && _isSpace(text.codeUnitAt(i))) {
        i++;
      }
      if (i >= text.length) continue;
      final quote = text.codeUnitAt(i);
      final isQuote = quote == 0x27 /* ' */ || quote == 0x22 /* " */;
      if (!isQuote) continue; // 方法名是变量/表达式，静态拿不到，不猜
      // 读到同一个引号为止。
      final sb = StringBuffer();
      i++;
      while (i < text.length && text.codeUnitAt(i) != quote) {
        sb.writeCharCode(text.codeUnitAt(i));
        i++;
      }
      final name = sb.toString();
      // 只收标识符形状：`VfsChannel.call('archiveList')` 是；拼接、插值不是。
      if (RegExp(r'^[A-Za-z0-9_]+$').hasMatch(name)) out.add(name);
    }
  }
  return out;
}

bool _isSpace(int code) =>
    code == 0x20 || code == 0x09 || code == 0x0A || code == 0x0D;
