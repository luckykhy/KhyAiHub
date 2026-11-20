import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'kotlin_source_support.dart';

/// 设备身份的来源与"不许写死"。
///
/// 为什么要有这个套件：身份值一旦被写进源码或测试，仓库里就存在一份"这台
/// 设备"的身份——所有人拿到的是同一个。设备标识的读取必须且只能发生在原生
/// 层（ZenDeviceSeed.kt），Dart 侧只收 64 位摘要。
void main() {
  /// 去掉注释行：`Settings.Secure` 出现在"为什么不能直读"的说明里是正常的，
  /// 出现在代码里才是问题。
  String codeOnly(String src) => src
      .split('\n')
      .where((line) {
        final t = line.trimLeft();
        return !(t.startsWith('//') ||
            t.startsWith('/*') ||
            t.startsWith('*'));
      })
      .join('\n');

  test('lib/ 不读设备标识；读取点只在 ZenDeviceSeed.kt', () {
    final forbidden = ['ANDROID_ID', 'Settings.Secure', 'Build.FINGERPRINT'];
    final hits = <String>[];
    final dir = Directory('lib');
    expect(dir.existsSync(), isTrue, reason: '工作目录应是 Flutter 包根');
    for (final f in dir.listSync(recursive: true).whereType<File>()) {
      if (!f.path.endsWith('.dart')) continue;
      final src = codeOnly(f.readAsStringSync());
      for (final token in forbidden) {
        if (src.contains(token)) hits.add('${f.path}: $token');
      }
    }
    expect(hits, isEmpty,
        reason: 'Dart 侧不该出现设备标识读取（会被误以为可以直接拿原始值）');

    final kotlin = readNativeSource(
        'android/app/src/main/kotlin/com/khyos/khy_os_client/ZenDeviceSeed.kt');
    expect(kotlin, isNotNull, reason: 'ZenDeviceSeed.kt 不见了，种子来源被换掉');
    expect(kotlin!, contains('ANDROID_ID'));
  });

  test('仓库源码里没有完整形态的写死 session id', () {
    // 只查"整串"：`ses_${...}` 这种插值形态不算——它每次都重算。
    final literal = RegExp(r'ses_[0-9a-f]{12}[0-9A-Za-z]{14}');
    final hits = <String>[];
    for (final root in ['lib', 'android/app/src']) {
      final dir = Directory(root);
      if (!dir.existsSync()) continue;
      for (final f in dir.listSync(recursive: true).whereType<File>()) {
        if (!f.path.endsWith('.dart') &&
            !f.path.endsWith('.kt') &&
            !f.path.endsWith('.java')) {
          continue;
        }
        final src = f.readAsStringSync();
        final m = literal.firstMatch(src);
        if (m != null) hits.add('${f.path}: ${m.group(0)}');
      }
    }
    expect(hits, isEmpty, reason: '写死的身份会让所有设备变成同一台');
  });
}
