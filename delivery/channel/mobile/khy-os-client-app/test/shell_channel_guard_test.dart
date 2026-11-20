import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/audit_log.dart';
import 'package:khy_os_client/core/services/shell_executor.dart';

import 'kotlin_source_support.dart';

/// shell 通道的纪律：这个平台上跑命令的门，只能有一扇。
///
/// 背景（§9.26）：原生 `shell` 通道上挂着两道闸——Dart 侧的语义护栏
/// （`ShellCommandGuard`）与原生侧的前缀白名单。绕过其中一道，命令就能带着
/// `rm -r -f /` 这类写法一路走到设备上。而事实上**确实存在第二扇门**：
/// `ShellExecutor.exec` 直连原生 `shell`，不过护栏、不进审计。
///
/// 这个套件钉四件事：
///   1. `lib/` 下只有 `DeviceControl` 一处直连原生 `shell` 通道；
///   2. App 自己拼出来的命令（`ShellCommands`）**真的发得出去**——不是只看
///      字符串长什么样，而是拿原生那份白名单逐条判；
///   3. `ShellExecutor.exec` 的危险命令在到达原生之前就被拦下；
///   4. 人工终端的命令也进操作日志（来源「用户手动」）。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');

  void mockChannel(Object? Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      return handler(call);
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('原生闸门镜像', () {
    test('ShellCommands 的每条命令都过得了原生那道闸', () {
      final allow = _nativeList('SHELL_ALLOW');
      final deny = _nativeList('SHELL_DENY');
      final controlChars = _nativeControlChars();
      expect(allow, isNotEmpty,
          reason: '解析不到原生白名单——多半是工作目录不对，或原生改了写法');
      expect(deny, isNotEmpty, reason: '解析不到原生黑名单');
      expect(controlChars, isNotEmpty,
          reason: '解析不到原生控制符名单（ShellCommandPolicy.CONTROL_CHARS）。\n'
              '这一维原来是硬编码的一份抄写，抄的与原生漂移时这条测试照样绿；\n'
              '改成读源码之后，读不到就必须判不通过——否则这一维会静默失效。');

      final offenders = <String>[];
      for (final entry in _commandSamples.entries) {
        for (final command in entry.value) {
          final lower = command.toLowerCase().trim();

          // 1) 控制符：原生是**整体拒绝**，不是只拒掉控制符后面那段。
          for (final ch in controlChars) {
            if (command.contains(ch)) {
              offenders.add('${entry.key} 含控制符 "$ch"：$command');
              break;
            }
          }

          // 2) 黑名单：前缀或 " $deny" 形态都算撞上。
          for (final denied in deny) {
            if (lower.startsWith(denied) || lower.contains(' $denied')) {
              offenders.add('${entry.key} 撞黑名单 "$denied"：$command');
            }
          }

          // 3) 白名单：前缀匹配。
          if (!allow.any(lower.startsWith)) {
            offenders.add('${entry.key} 前缀不在白名单：$command');
          }
        }
      }

      expect(offenders, isEmpty,
          reason: '下面这些命令在真机上**一条都发不出去**（原生闸门整体拒绝），\n'
              '但它们在自己的单测里是绿的——绿着骗人：\n'
              '${offenders.join('\n')}');
    });

    test('ShellCommands 的每个方法都被样本覆盖', () {
      final source =
          File('lib/core/services/shell_executor.dart').readAsStringSync();
      final start = source.indexOf('class ShellCommands');
      expect(start, greaterThan(-1), reason: '找不到 ShellCommands 类');
      final body = source.substring(start);
      final methods = RegExp(r'static String (\w+)\(')
          .allMatches(body)
          .map((RegExpMatch m) => m.group(1)!)
          .toSet();
      expect(methods.length, greaterThan(15),
          reason: '只认出 ${methods.length} 个方法，多半是写法变了');

      final covered = _commandSamples.keys.toSet();
      expect(covered.difference(methods), isEmpty,
          reason: '样本里有不存在的方法');
      expect(methods.difference(covered), isEmpty,
          reason: '这些 ShellCommands 方法没被样本覆盖，等于没被判定：'
              '${methods.difference(covered).join('、')}');
    });
  });

  group('只有一扇门', () {
    test('lib/ 下只有 DeviceControl 一处直连原生 shell 通道', () {
      final offenders = <String>[];
      for (final file in _dartFilesUnder('lib')) {
        final path = file.path.replaceAll('\\', '/');
        if (path.endsWith('/core/services/device_control.dart')) continue;
        final text = file.readAsStringSync();
        for (final method in const <String>['shell', 'elevatedShell']) {
          if (text.contains("invokeMethod('$method'")) {
            offenders.add('$path 直连了 $method 通道');
          }
        }
      }
      expect(offenders, isEmpty,
          reason: '绕过 DeviceControl 就绕过了护栏与审计：\n'
              '${offenders.join('\n')}');
    });
  });

  group('ShellExecutor.exec', () {
    test('危险命令在到达原生之前就被拦下', () async {
      var reachedNative = false;
      mockChannel((_) {
        reachedNative = true;
        return {
          'success': true,
          'stdout': 'should not happen',
          'stderr': '',
          'exitCode': 0,
        };
      });
      final r = await ShellExecutor.exec('rm -r -f /');
      expect(r.success, false);
      expect(r.stderr, contains('安全护栏'));
      expect(reachedNative, false, reason: '危险命令不该下发到原生');
    });

    test('普通命令照常下发', () async {
      var reachedNative = false;
      mockChannel((call) {
        expect(call.method, 'shell');
        expect(call.arguments['command'], 'ls /storage');
        reachedNative = true;
        return {
          'success': true,
          'stdout': 'ok',
          'stderr': '',
          'exitCode': 0,
        };
      });
      final r = await ShellExecutor.exec('ls /storage');
      expect(r.success, true);
      expect(r.stdout, 'ok');
      expect(reachedNative, true);
    });
  });

  group('人工终端也进审计', () {
    late Directory tmp;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('khy_terminal_audit');
      AuditLog.useDirectoryForTest(tmp);
    });

    tearDown(() {
      AuditLog.useDirectoryForTest(null);
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {}
    });

    test('终端命令记成「用户手动」', () async {
      mockChannel((call) {
        expect(call.method, 'terminalShell');
        return {
          'success': true,
          'stdout': 'Filesystem 1K-blocks\n',
          'stderr': '',
          'exitCode': 0,
        };
      });
      final r = await ShellExecutor.execTerminal('df -h', cwd: '/storage/emulated/0');
      expect(r.success, true);

      final entries = await AuditLog.instance.recent();
      expect(entries.length, 1);
      expect(entries.first.source, AuditSource.user);
      expect(entries.first.operation, 'terminal');
      expect(entries.first.detail, contains('df -h'));
      expect(entries.first.detail, contains('/storage/emulated/0'));
      expect(entries.first.ok, isTrue);
    });

    test('终端命令失败也要留痕', () async {
      mockChannel((_) => {
            'success': false,
            'stdout': '',
            'stderr': 'no such file',
            'exitCode': 1,
          });
      await ShellExecutor.execTerminal('cat /nope');

      final entries = await AuditLog.instance.recent();
      expect(entries.length, 1);
      expect(entries.first.ok, isFalse);
    });
  });
}

/// 每条命令都用代表性参数跑一遍。
///
/// 为什么用代表性参数而不是解析源码：这些是**真函数**，调用它们得到的就是真实
/// 产物。参数填什么只影响判定的具体字符串，不影响「发不发得出去」这个结论。
final Map<String, List<String>> _commandSamples = <String, List<String>>{
  'listPackages': <String>[
    ShellCommands.listPackages(),
    ShellCommands.listPackages(onlyThirdParty: true),
  ],
  'packageInfo': <String>[ShellCommands.packageInfo('com.android.chrome')],
  'openApp': <String>[ShellCommands.openApp('com.tencent.mm')],
  'startActivity': <String>[ShellCommands.startActivity('com.example/.Main')],
  'tap': <String>[ShellCommands.tap(100, 200)],
  'swipe': <String>[ShellCommands.swipe(10, 20, 30, 40)],
  'inputText': <String>[ShellCommands.inputText('hello')],
  'keyEvent': <String>[ShellCommands.keyEvent(4)],
  'screenshot': <String>[ShellCommands.screenshot('/sdcard/shot.png')],
  'currentActivity': <String>[ShellCommands.currentActivity()],
  'windowInfo': <String>[ShellCommands.windowInfo()],
  'runningProcesses': <String>[ShellCommands.runningProcesses()],
  'memoryInfo': <String>[ShellCommands.memoryInfo('com.example')],
  'batteryInfo': <String>[ShellCommands.batteryInfo()],
  'networkStatus': <String>[ShellCommands.networkStatus()],
  'listDir': <String>[ShellCommands.listDir('/tmp')],
  'readFile': <String>[ShellCommands.readFile('/etc/hosts')],
  'fileExists': <String>[ShellCommands.fileExists('/data/local')],
  'filePermissions': <String>[ShellCommands.filePermissions('/etc/hosts')],
  'deviceIp': <String>[ShellCommands.deviceIp()],
  'wifiInfo': <String>[ShellCommands.wifiInfo()],
  'bluetoothStatus': <String>[ShellCommands.bluetoothStatus()],
  'sensors': <String>[ShellCommands.sensors()],
  'inputDevices': <String>[ShellCommands.inputDevices()],
};

/// 从原生 `MainActivity.kt` 里读出白名单/黑名单条目。
///
/// 为什么直接读源码而不是在 Dart 侧抄一份：抄的那份一定会漂——原生加了条目而
/// Dart 侧没跟上，守卫就成了摆设。读真源就没有漂。
///
/// 为什么先剥注释：原生那几行里有解释性注释，注释里引用的字符串（例如
/// `"rm -rf /"`）不是**策略条目**。不剥掉就会把注释当成白名单/黑名单的一部分
/// ——那正是「读源码」这条路最容易踩的坑。
List<String> _nativeList(String name) {
  final file = File(
    'android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt',
  );
  if (!file.existsSync()) return const <String>[];
  final text = file.readAsStringSync();
  final start = text.indexOf('private val $name = arrayOf(');
  if (start < 0) return const <String>[];
  final end = text.indexOf(')', start);
  if (end < 0) return const <String>[];
  final body = text.substring(start, end);
  final out = <String>[];
  for (final line in body.split('\n')) {
    // 去掉行尾注释：注释里引用的字符串不是策略条目。
    final code = line.contains('//') ? line.substring(0, line.indexOf('//')) : line;
    for (final match in RegExp(r'"([^"]*)"').allMatches(code)) {
      out.add(match.group(1)!);
    }
  }
  return out;
}

/// 原生闸门的控制符名单（`ShellCommandPolicy.CONTROL_CHARS`）。
///
/// 为什么单独一个函数而不塞进 [_nativeList]：那份读的是 `MainActivity.kt` 的
/// `arrayOf(...)`，而控制符名单在 `ShellCommandPolicy.kt` 里、用 `listOf(...)`，
/// 且条目带转义（`"\n"`、`"\r"` 在 Kotlin 里是一个换行/回车，不是两个字）。
///
/// 为什么读源码而不继续硬编码：硬编码的那份与原生漂移时，上面那条「App 自己的命令
/// 过得了原生闸门」会照样绿——而它绿的涵义是「这些命令真机上发得出去」。控制符这
/// 一维此前正是硬编码的，是同一类抄写里漏得最久的一个。
List<String> _nativeControlChars() {
  final source = readNativeSource(kShellCommandPolicyPath);
  if (source == null) return const <String>[];
  return kotlinListEntries(source, 'CONTROL_CHARS');
}

/// 递归列出目录下的 Dart 源文件。
List<File> _dartFilesUnder(String root) {  final dir = Directory(root);
  if (!dir.existsSync()) return const <File>[];
  final out = <File>[];
  for (final entity in dir.listSync(recursive: true)) {
    if (entity is File && entity.path.endsWith('.dart')) out.add(entity);
  }
  return out;
}
