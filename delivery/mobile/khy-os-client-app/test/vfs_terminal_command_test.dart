// 终端命令解析的测试。
//
// 测的是**纯逻辑**：一行输入该被理解成「切目录」还是「一条命令」，
// 以及相对路径怎么解析成绝对路径。这些规则出过错（cwd 曾被拼成
// `cd <dir> && cmd`，被原生的控制符禁令整体拒绝，终端在真机上一条命令都发不出去），
// 所以要有一组不用设备就能跑的回归。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_terminal_command.dart';

void main() {
  group('parseTerminalCommand', () {
    test('普通命令原样交给 shell', () {
      final parsed = parseTerminalCommand('ls -la');
      expect(parsed.changesDirectory, isFalse);
      expect(parsed.shellCommand, 'ls -la');
      expect(parsed.targetDirectory, isNull);
    });

    test('cd 绝对路径被认成切目录', () {
      final parsed = parseTerminalCommand('cd /storage/emulated/0/Download');
      expect(parsed.changesDirectory, isTrue);
      expect(parsed.targetDirectory, '/storage/emulated/0/Download');
      expect(parsed.shellCommand, isEmpty);
    });

    test('cd 相对路径保留原样，交给解析器拼', () {
      final parsed = parseTerminalCommand('cd Documents');
      expect(parsed.changesDirectory, isTrue);
      expect(parsed.targetDirectory, 'Documents');
    });

    test('cd 带引号的路径去掉外层引号', () {
      final parsed = parseTerminalCommand("cd '/storage/emulated/0/My Docs'");
      expect(parsed.changesDirectory, isTrue);
      expect(parsed.targetDirectory, '/storage/emulated/0/My Docs');
    });

    test('cd 没有参数时不当成切目录——交给原生报错更诚实', () {
      final parsed = parseTerminalCommand('cd');
      expect(parsed.changesDirectory, isFalse);
      expect(parsed.shellCommand, 'cd');
    });

    test('名字里带 cd 的别的命令不算切目录', () {
      final parsed = parseTerminalCommand('cat cd.txt');
      expect(parsed.changesDirectory, isFalse);
      expect(parsed.shellCommand, 'cat cd.txt');
    });

    test('空输入返回空命令', () {
      final parsed = parseTerminalCommand('   ');
      expect(parsed.changesDirectory, isFalse);
      expect(parsed.shellCommand, isEmpty);
    });
  });

  group('resolveTerminalPath', () {
    test('相对路径拼在 cwd 后面', () {
      expect(
        resolveTerminalPath('/storage/emulated/0', 'Documents'),
        '/storage/emulated/0/Documents',
      );
    });

    test('绝对路径不受 cwd 影响', () {
      expect(
        resolveTerminalPath('/storage/emulated/0', '/data/local/tmp'),
        '/data/local/tmp',
      );
    });

    test('.. 被消掉', () {
      expect(
        resolveTerminalPath('/storage/emulated/0/Android', '../Download'),
        '/storage/emulated/0/Download',
      );
    });

    test('. 被消掉', () {
      expect(
        resolveTerminalPath('/storage/emulated/0', './Android/.'),
        '/storage/emulated/0/Android',
      );
    });

    test('.. 越过根目录时停在根，不越界', () {
      expect(
        resolveTerminalPath('/storage', '../../etc'),
        '/etc',
      );
    });

    test('cwd 是根时相对路径不会多出斜杠', () {
      expect(resolveTerminalPath('/', 'data'), '/data');
    });
  });
}
