import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/shell_command_guard.dart';

import 'kotlin_source_support.dart';

/// 命令护栏的判据测试。
///
/// 这些用例的由来：2026-11-09 用探针实测过旧版过滤器（纯正则），下面
/// 「rm 的各种写法」那一组**全部放行**（§9.23）。所以它们不是补的边角，
/// 是补的**洞**——每一条都对应一种 AI 换写法就能绕过去的形态。
void main() {
  group('CommandSafety.split', () {
    test('按 shell 连接符切成多条子命令', () {
      final parsed = CommandSafety.split('ls && rm -rf /');
      expect(parsed.map((c) => c.program).toList(), ['ls', 'rm']);
    });

    test('引号内的空格算一个操作对象', () {
      final parsed = CommandSafety.split('rm "my file.txt"');
      expect(parsed.single.operands, ['my file.txt']);
    });

    test('程序名去掉路径', () {
      expect(CommandSafety.split('/bin/rm -rf /').single.program, 'rm');
      expect(CommandSafety.split('/usr/bin/env').single.program, 'env');
    });
  });

  group('rm 的各种写法都判成同一件事', () {
    // 这一组就是探针实测出来的漏网清单：旧版纯正则把它们**全部放行**。
    const recursiveRoot = <String>[
      'rm -rf /',
      'rm -fr /',
      'rm -r -f /',
      'rm -f -r /',
      'rm -Rf /',
      'rm --recursive --force /',
      'rm -rf --no-preserve-root /',
      'rm -rf /*',
      'rm -rf ./',
      'rm -rf //',
    ];
    for (final command in recursiveRoot) {
      test('$command 被拒绝', () {
        expect(ShellCommandGuard.reason(command), isNotNull, reason: command);
      });
    }

    test('递归删用户存储根被拒绝', () {
      expect(ShellCommandGuard.reason('rm -rf /storage/emulated/0'), isNotNull);
      expect(ShellCommandGuard.reason('rm -rf /sdcard'), isNotNull);
    });

    test('递归删系统分区被拒绝', () {
      for (final command in <String>[
        'rm -rf /system',
        'rm -rf /vendor',
        'rm -rf /data',
        'rm -rf /data/data',
        'rm -rf /proc',
      ]) {
        expect(ShellCommandGuard.reason(command), isNotNull, reason: command);
      }
    });

    test('非递归删除放行', () {
      expect(ShellCommandGuard.reason('rm file.txt'), isNull);
      expect(ShellCommandGuard.reason('rm -f /tmp/a'), isNull);
    });

    test('递归删子目录不硬拒（属高危但合法，走确认流程）', () {
      expect(ShellCommandGuard.reason('rm -rf /storage/emulated/0/DCIM'), isNull);
      expect(ShellCommandGuard.reason('rm -rf /data/data/com.example/files'), isNull);
    });
  });

  group('chmod 的八进制写法', () {
    test('777 及更宽被拒绝', () {
      for (final command in <String>[
        'chmod 777 /system',
        'chmod -R 777 /data',
        'chmod 7777 /x',
        'chmod 0777 /x',
      ]) {
        expect(ShellCommandGuard.reason(command), isNotNull, reason: command);
      }
    });

    test('常规权限放行', () {
      expect(ShellCommandGuard.reason('chmod 644 file'), isNull);
      expect(ShellCommandGuard.reason('chmod 755 /x'), isNull);
      expect(ShellCommandGuard.reason('chmod +x f'), isNull);
    });
  });

  group('chown / mount', () {
    test('改根或系统分区的属主被拒绝', () {
      expect(ShellCommandGuard.reason('chown root /'), isNotNull);
      expect(ShellCommandGuard.reason('chown root /system'), isNotNull);
    });

    test('挂载块设备或系统分区被拒绝', () {
      expect(ShellCommandGuard.reason('mount /dev/block/sda /mnt'), isNotNull);
      expect(ShellCommandGuard.reason('mount -o remount,rw /system'), isNotNull);
      expect(ShellCommandGuard.reason('mount -o rw /'), isNotNull);
    });

    test('普通属主修改放行', () {
      expect(ShellCommandGuard.reason('chown user /data/local/tmp/x'), isNull);
    });
  });

  group('块设备与系统级操作', () {
    test('写块设备被拒绝', () {
      expect(
        ShellCommandGuard.reason('dd if=/dev/zero of=/dev/block/sda'),
        isNotNull,
      );
    });

    test('普通 dd 放行', () {
      expect(
        ShellCommandGuard.reason('dd if=/dev/zero of=/data/local/tmp/a'),
        isNull,
      );
    });

    test('关掉 SELinux 被拒绝，开着放行', () {
      expect(ShellCommandGuard.reason('setenforce 0'), isNotNull);
      expect(ShellCommandGuard.reason('setenforce 1'), isNull);
    });

    test('内核模块与擦除工具被拒绝', () {
      for (final command in <String>[
        'insmod evil.ko',
        'rmmod evil.ko',
        'modprobe evil',
        'shred -u file',
        'wipe /dev/sda',
      ]) {
        expect(ShellCommandGuard.reason(command), isNotNull, reason: command);
      }
    });

    test('格式化被拒绝（含带后缀的程序名）', () {
      expect(ShellCommandGuard.reason('mkfs.ext4 /dev/block/sda'), isNotNull);
      expect(ShellCommandGuard.reason('mkfs /dev/block/sda'), isNotNull);
    });

    test('关机重启被拒绝', () {
      expect(ShellCommandGuard.reason('reboot'), isNotNull);
      expect(ShellCommandGuard.reason('shutdown -h now'), isNotNull);
    });

    test('fork 炸弹被拒绝', () {
      expect(ShellCommandGuard.reason(r':(){ :|:& };:'), isNotNull);
    });

    test('重定向写块设备被拒绝', () {
      expect(ShellCommandGuard.reason('echo x > /dev/block/sda'), isNotNull);
    });
  });

  group('包装与替换', () {
    test('前缀包装里的命令照样判', () {
      for (final command in <String>[
        'env rm -rf /',
        'env -u FOO rm -rf /',
        'sudo rm -rf /',
        'busybox rm -rf /',
        'timeout 5 rm -rf /',
      ]) {
        expect(ShellCommandGuard.reason(command), isNotNull, reason: command);
      }
    });

    test('解释器包装里的命令照样判', () {
      expect(ShellCommandGuard.reason("sh -c 'rm -rf /'"), isNotNull);
      expect(ShellCommandGuard.reason('sh -c "rm -rf /"'), isNotNull);
    });

    test('命令替换里的命令照样判', () {
      expect(ShellCommandGuard.reason(r'echo $(rm -rf /)'), isNotNull);
      expect(ShellCommandGuard.reason(r'echo `rm -rf /`'), isNotNull);
    });

    test('删除目标来自命令替换时无法静态判定，拒绝', () {
      expect(ShellCommandGuard.reason(r'rm -rf $(echo /)'), isNotNull);
    });
  });

  group('放行', () {
    test('常规命令放行', () {
      for (final command in <String>[
        'ls -la /storage',
        'cp -a /a /b',
        'echo hi',
        'pm list packages',
        'dumpsys connectivity 2>/dev/null | head -30',
        'settings get global airplane_mode_on',
      ]) {
        expect(ShellCommandGuard.reason(command), isNull, reason: command);
      }
    });

    test('只是提到危险串，不当成执行', () {
      // 旧版正则不锚定，把这两条判成危险——于是 AI 写个说明都被拦。
      expect(ShellCommandGuard.reason("echo 'rm -rf / is dangerous'"), isNull);
      expect(ShellCommandGuard.reason("grep 'rm -rf' notes.md"), isNull);
      expect(ShellCommandGuard.reason('ls; echo rm -rf /'), isNull);
    });

    test('应用自己的多行脚本不会被 Dart 护栏误伤', () {
      // 原生那道闸门另有「控制符一律拒」的政策（原生侧问题，见 §9.23），
      // 这里守的是 Dart 侧不要把这脚本拦下来。
      const script = r'''
for p in $(pm list packages -s 2>/dev/null | cut -d: -f2); do
  ap=$(pm path "$p" 2>/dev/null | head -1 | cut -d: -f2)
  if [ -n "$ap" ]; then
    s=$(stat -c %s "$ap" 2>/dev/null || echo 0)
    echo "$p|$s"
  else
    echo "$p|0"
  fi
done
''';
      expect(ShellCommandGuard.reason(script), isNull);
    });
  });

  group('原生闸门的控制符', () {
    test('控制符被认出来', () {
      for (final ch in ShellCommandGuard.kControlChars) {
        expect(ShellCommandGuard.hasControlChar('ls $ch x'), isTrue,
            reason: '控制符 $ch 应该被认出来');
      }
    });

    test('Dart 的控制符名单与原生闸门逐条相同', () {
      // 上面那条只遍历 Dart 自己那份名单——它证明「名单里每个字符都被认出来」，
      // 证明不了「名单与原生那道闸门是同一份」。后者由这条钉。
      //
      // 两份漂移的后果不是「测试不准」，而是 **App 在开发期以为发得出去、真机上
      // 被自家闸门挡回来**——正是 §9.24 说的「最荒唐的一种坏法」。
      final native = _nativeControlChars();
      expect(native, isNotEmpty,
          reason: '读不到 ShellCommandPolicy.kt 的 CONTROL_CHARS'
              '（cwd=${Directory.current.path}）。\n'
              '要么工作目录不对，要么原生改了写法。这种情况下上面那条'
              '「控制符被认出来」只是同义反复，所以这里直接判不通过。');
      expect(
        native.toSet(),
        equals(ShellCommandGuard.kControlChars.toSet()),
        reason: '控制符名单与原生不一致：\n'
            '  原生有、Dart 没有 = '
            '${native.toSet().difference(ShellCommandGuard.kControlChars.toSet())}\n'
            '  Dart 有、原生没有 = '
            '${ShellCommandGuard.kControlChars.toSet().difference(native.toSet())}\n'
            '修法：两边必须同一份——原生是执行方，Dart 是开发期预报。',
      );
    });

    test('普通命令没有控制符', () {
      for (final command in <String>[
        'dumpsys connectivity',
        'settings get global airplane_mode_on',
        'pm list packages -f',
        'logcat -d -t 50',
      ]) {
        expect(ShellCommandGuard.hasControlChar(command), isFalse, reason: command);
      }
    });

    test('管道与重定向是控制符（这正是 App 自己的命令踩过的坑）', () {
      expect(ShellCommandGuard.hasControlChar('dumpsys x 2>/dev/null | head -30'), isTrue);
      expect(ShellCommandGuard.hasControlChar('settings get a || settings get b'), isTrue);
    });
  });

  group('firstLines 替代 head -n', () {
    test('取前 n 行', () {
      expect(ShellCommandGuard.firstLines('a\nb\nc\nd', 2), 'a\nb');
    });

    test('行数不够时原样返回', () {
      expect(ShellCommandGuard.firstLines('a\nb', 30), 'a\nb');
    });

    test('n <= 0 表示不截断', () {
      expect(ShellCommandGuard.firstLines('a\nb', 0), 'a\nb');
    });

    test('空串不炸', () {
      expect(ShellCommandGuard.firstLines('', 10), '');
    });
  });

  group('ShellCommandGuard.isDangerous', () {
    test('与 reason 一致', () {
      expect(ShellCommandGuard.isDangerous('rm -rf /'), isTrue);
      expect(ShellCommandGuard.isDangerous('ls -la /storage'), isFalse);
      expect(ShellCommandGuard.isDangerous(''), isTrue, reason: '空命令也是拒绝');
    });
  });

  group('探针清单：修复前实测漏网的 13 条，现在全部拦住', () {
    // 这张表是 2026-11-09 探针实测出来的**旧版漏网清单**（27 条该拦的写法里，
    // 旧版只拦住 14 条）。原样固化在此：以后谁再动判定层，这 13 条不许回退。
    const leaked = <String>[
      'rm -r -f /',
      'rm -f -r /',
      'rm --recursive --force /',
      'rm -rf /storage/emulated/0',
      'rm -rf ./',
      'rm -rf /system',
      'rm -rf /data',
      'chmod 7777 /x',
      'chmod 0777 /x',
      'mount /dev/block/sda /mnt',
      'mount /system',
      "sh -c 'rm -rf /'",
      r'echo $(rm -rf /)',
    ];
    for (final command in leaked) {
      test(command, () {
        expect(ShellCommandGuard.reason(command), isNotNull, reason: command);
      });
    }
  });

  group('探针清单：旧版误拦的两条，现在放行', () {
    // 旧版正则不锚定，把「只是提到危险串」也判成危险，于是 AI 写个说明都被拦。
    for (final command in <String>[
      "echo 'rm -rf / is dangerous'",
      "grep 'rm -rf' notes.md",
    ]) {
      test(command, () {
        expect(ShellCommandGuard.reason(command), isNull, reason: command);
      });
    }
  });
}

/// 原生闸门的控制符名单（`ShellCommandPolicy.CONTROL_CHARS`）。
///
/// 为什么要读源码而不是在 Dart 侧再抄一份断言：[ShellCommandGuard.kControlChars]
/// 本身就是一份手抄的复印件，注释声称与原生那道闸门一致。用一份抄来的值去校验另一份
/// 抄来的值，两个一起漂也发现不了。所以这里直接读原生真源。
///
/// 纪律与 `vfs_channel_wiring_test.dart` 相同：**读不到就返回空，由调用方判不通过**，
/// 不静默跳过——扫不到比没有更糟，门读到的是绿灯。
List<String> _nativeControlChars() {
  final source = readNativeSource(kShellCommandPolicyPath);
  if (source == null) return const <String>[];
  return kotlinListEntries(source, 'CONTROL_CHARS');
}
