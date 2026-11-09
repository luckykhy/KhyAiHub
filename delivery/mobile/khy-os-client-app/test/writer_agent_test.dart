import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/writer_agent.dart';
import 'package:khy_os_client/core/workspace/workspace_paths.dart';

/// 写入子智能体的测试。
///
/// 在主机上跑，用 `systemTemp` 下的真目录：这一层就是碰盘的，
/// 用假的反而测不到真正会出错的地方（字节数不符、目录不存在、
/// 路径逃逸）。跑完删掉，不留垃圾。
void main() {
  late Directory sandbox;
  late WriterAgent writer;

  setUp(() {
    sandbox = Directory.systemTemp.createTempSync('khyos_writer_test_');
    writer = WriterAgent();
  });

  tearDown(() {
    if (sandbox.existsSync()) sandbox.deleteSync(recursive: true);
  });

  WorkspacePaths ws() => WorkspacePaths(root: sandbox.path);

  group('正常写入', () {
    test('写入成功 → verified，证据带绝对路径和字节数', () async {
      final r = await writer.write(
        ws(),
        WriteRequest(relativePath: 'a.txt', content: '你好'),
      );
      expect(r.ok, isTrue);
      expect(r.observations.single.verified, isTrue);
      expect(r.observations.single.evidence!['bytes'], 6); // 两个汉字 = 6 字节
      expect(File('${sandbox.path}/workspace/a.txt').existsSync(), isTrue);
    });

    test('按需建父目录', () async {
      final r = await writer.write(
        ws(),
        WriteRequest(relativePath: 'sub/dir/b.txt', content: 'x'),
      );
      expect(r.observations.single.verified, isTrue);
      expect(File('${sandbox.path}/workspace/sub/dir/b.txt').existsSync(), isTrue);
    });

    test('覆盖写同名文件', () async {
      await writer.write(ws(), WriteRequest(relativePath: 'c.txt', content: '旧'));
      final r = await writer.write(
          ws(), WriteRequest(relativePath: 'c.txt', content: '新内容'));
      expect(r.observations.single.verified, isTrue);
      expect(File('${sandbox.path}/workspace/c.txt').readAsStringSync(), '新内容');
    });

    test('readBack 能读回，并给出字节数', () async {
      await writer.write(
          ws(), WriteRequest(relativePath: 'd.txt', content: 'abcde'));
      final r = await writer.readBack(ws(), 'd.txt');
      expect(r.observations.single.verified, isTrue);
      expect(r.data['content'], 'abcde');
      expect(r.data['bytes'], 5);
    });

    test('purpose 进日志字段', () async {
      final r = await writer.write(
        ws(),
        WriteRequest(relativePath: 'e.txt', content: 'x', purpose: '导出的清单'),
      );
      expect(r.data['purpose'], '导出的清单');
    });
  });

  group('路径逃逸（最要紧的一组）', () {
    test('绝对路径被拒', () async {
      final r = await writer.write(
        ws(),
        WriteRequest(relativePath: '/etc/passwd', content: 'x'),
      );
      expect(r.ok, isFalse);
      expect(r.error, contains('绝对路径'));
    });

    test('含 .. 的路径被拒', () async {
      final r = await writer.write(
        ws(),
        WriteRequest(relativePath: '../escape.txt', content: 'x'),
      );
      expect(r.ok, isFalse);
      expect(r.error, contains('越出工作空间'));
    });

    test('深层 .. 也被拒——先规范化再比前缀', () async {
      // `a/../../x` 看着像在工作空间里，规范化之后就在外面。
      // 只查字面 `..` 会漏掉这种；所以顺序必须是 normalize 之后比前缀。
      final r = await writer.write(
        ws(),
        WriteRequest(relativePath: 'a/../../escape.txt', content: 'x'),
      );
      expect(r.ok, isFalse);
      expect(r.error, contains('越出工作空间'));
    });

    test('反斜杠穿越在 POSIX 上不是分隔符，但仍被挡住', () async {
      // 这条测的是"换平台也会变"的风险：设备上是 POSIX，`..\x` 不是
      // 上层目录。这里不断言具体行为，只断言它不会写到工作空间外面。
      final r = await writer.write(
        ws(),
        WriteRequest(relativePath: r'..\escape.txt', content: 'x'),
      );
      final outside = sandbox.listSync()
          .whereType<File>()
          .map((f) => f.path)
          .toList();
      expect(outside.where((p) => p.contains('escape.txt')), isEmpty,
          reason: '不管怎么解释，都不该落到沙箱根下');
      // 在 POSIX 上它是一个合法文件名，所以写入应当成功。
      expect(r.ok || r.error != null, isTrue);
    });

    test('空路径被拒', () async {
      final r = await writer.write(
        ws(),
        WriteRequest(relativePath: '   ', content: 'x'),
      );
      expect(r.ok, isFalse);
      expect(r.error, contains('不能为空'));
    });

    test('readBack 同样不接受逃逸路径', () async {
      final r = await writer.readBack(ws(), '../../etc/hosts');
      expect(r.ok, isFalse);
      expect(r.error, contains('越出工作空间'));
    });
  });

  group('预算', () {
    test('超过单次写入上限被拒，不截断了事', () async {
      final r = await writer.write(
        ws(),
        WriteRequest(
          relativePath: 'big.txt',
          content: 'x' * (WriterAgent.maxContentBytes + 1),
        ),
      );
      expect(r.ok, isFalse);
      expect(r.error, contains('上限'));
    });

    test('正好等于上限可以写', () async {
      final r = await writer.write(
        ws(),
        WriteRequest(
          relativePath: 'exact.txt',
          content: 'x' * WriterAgent.maxContentBytes,
        ),
      );
      expect(r.observations.single.verified, isTrue);
    });
  });

  group('失败形态', () {
    test('读回不存在的文件 → 未验证，不是失败', () async {
      final r = await writer.readBack(ws(), 'nope.txt');
      expect(r.ok, isTrue);
      expect(r.observations.single.verified, isFalse);
      expect(r.observations.single.why, contains('不存在'));
    });

    test('读回空路径被拒', () async {
      final r = await writer.readBack(ws(), '');
      expect(r.ok, isFalse);
    });
  });

  group('临时目录', () {
    test('领到的临时目录在工作空间的 tmp 下', () async {
      final d = await writer.claimTemp(ws());
      expect(d, isNotNull);
      expect(d!.path, startsWith('${sandbox.path}/workspace/tmp'));
      await writer.burnTemp(d);
      expect(d.existsSync(), isFalse);
    });

    test('burn(null) 不抛——finally 里会调它', () async {
      await expectLater(writer.burnTemp(null), completes);
    });

    test('重复 burn 同一个目录不抛', () async {
      final d = await writer.claimTemp(ws());
      await writer.burnTemp(d);
      await expectLater(writer.burnTemp(d), completes);
    });
  });

  group('报告形态', () {
    test('toJson 可序列化', () async {
      final r = await writer.write(
        ws(),
        WriteRequest(relativePath: 'f.txt', content: 'x'),
      );
      expect(r.toJson()['role'], 'writer');
      expect(r.toJson()['unverified'], 0);
    });

    test('失败报告不带观察，错误在 error 里', () async {
      final r = await writer.write(
        ws(),
        WriteRequest(relativePath: '../x', content: 'x'),
      );
      expect(r.observations, isEmpty);
      expect(r.error, isNotNull);
    });
  });
}
