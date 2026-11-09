// 归档与存储分析的判据测试。
//
// 归档这块的要点是**失败语义**：不支持的格式要诚实地返回「读不了」，
// 而不是返回一个空列表假装包里是空的——后者会让用户以为文件是空的。

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_analysis.dart';
import 'package:khy_os_client/core/vfs/vfs_archive.dart';
import 'package:khy_os_client/core/vfs/vfs_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/vfs');

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

  group('归档路径识别', () {
    test('zip / tar.gz / tgz 算归档', () {
      expect(VfsArchive.isArchivePath('/a/b.zip'), isTrue);
      expect(VfsArchive.isArchivePath('/a/b.tar.gz'), isTrue);
      expect(VfsArchive.isArchivePath('/a/b.tgz'), isTrue);
      expect(VfsArchive.isArchivePath('/a/b.ZIP'), isTrue);
    });

    test('其它不算归档', () {
      expect(VfsArchive.isArchivePath('/a/b.txt'), isFalse);
      expect(VfsArchive.isArchivePath('/a/b.apk'), isFalse);
    });

    test('rar 与 7z 不在支持范围（不假装能开）', () {
      // 识别层不把它们当归档，避免走进「读不了」的分支；
      // 真正打开时由原生侧返回「只支持 ZIP 与 TAR.GZ」。
      expect(VfsArchive.isArchivePath('/a/b.rar'), isFalse);
      expect(VfsArchive.isArchivePath('/a/b.7z'), isFalse);
    });
  });

  group('归档列表', () {
    test('解析条目并把目录排在前面', () async {
      mockChannel((call) {
        expect(call.method, 'archiveList');
        return <String, dynamic>{
          'ok': true,
          'format': 'zip',
          'entries': <dynamic>[
            <String, dynamic>{
              'name': 'b.txt',
              'path': 'b.txt',
              'isDirectory': false,
              'size': 100,
              'compressedSize': 40,
            },
            <String, dynamic>{
              'name': 'docs',
              'path': 'docs',
              'isDirectory': true,
            },
          ],
        };
      });

      final listing = await VfsArchive.list('/a/b.zip');
      expect(listing, isNotNull);
      expect(listing!.format, 'zip');
      expect(listing.entries, hasLength(2));
      expect(listing.sorted.first.name, 'docs');
      expect(listing.totalBytes, 100);
    });

    test('读不了时返回 null 而不是空列表', () async {
      mockChannel((call) => <String, dynamic>{
            'ok': false,
            'error': 'not_found',
            'message': '当前版本只支持 ZIP 与 TAR.GZ',
          });

      final listing = await VfsArchive.list('/a/b.rar');
      expect(listing, isNull);
    });
  });

  group('归档提取', () {
    test('成功时返回写出的路径', () async {
      mockChannel((call) => <String, dynamic>{
            'ok': true,
            'extracted': <dynamic>['/out/a.txt', '/out/b.txt'],
            'count': 2,
            'message': '跳过了 1 个已存在的条目',
          });

      final result = await VfsArchive.extract('/a/b.zip', '/out');
      expect(result.paths, hasLength(2));
      expect(result.paths.first, '/out/a.txt');
      expect(result.count, 2);
      // 成功也可能带说明——「解开了 8 个，跳过 2 个」是成功，不是失败。
      expect(result.message, contains('跳过'));
    });

    test('失败时抛 VfsException 并带机器码', () async {
      mockChannel((call) => <String, dynamic>{
            'ok': false,
            'error': 'conflict',
            'message': '目标已存在',
          });

      await expectLater(
        VfsArchive.extract('/a/b.zip', '/out'),
        throwsA(
          isA<VfsException>().having((VfsException e) => e.error, 'error', 'conflict'),
        ),
      );
    });
  });

  group('归档加密', () {
    test('识别加密包扩展名', () {
      expect(VfsArchive.isEncryptedPath('/a/b.khyenc'), isTrue);
      expect(VfsArchive.isEncryptedPath('/a/b.KHYENC'), isTrue);
      expect(VfsArchive.isEncryptedPath('/a/b.zip'), isFalse);
    });

    test('加密调 archiveEncrypt 并返回虚拟路径', () async {
      mockChannel((call) {
        expect(call.method, 'archiveEncrypt');
        final args = call.arguments as Map;
        expect(args['sourcePath'], '/a/b.zip');
        expect(args['targetPath'], '/a/b.zip.khyenc');
        expect(args['password'], 'pw');
        return <String, dynamic>{'ok': true, 'path': '/a/b.zip.khyenc'};
      });

      final path = await VfsArchive.encrypt('/a/b.zip', '/a/b.zip.khyenc', 'pw');
      expect(path, '/a/b.zip.khyenc');
    });

    test('空密码直接被拒，不发到原生', () async {
      var called = false;
      mockChannel((call) {
        called = true;
        return <String, dynamic>{'ok': true};
      });
      await expectLater(
        VfsArchive.encrypt('/a/b.zip', '/a/b.khyenc', ''),
        throwsA(
          isA<VfsException>().having(
            (VfsException e) => e.error,
            'error',
            'invalid_path',
          ),
        ),
      );
      expect(called, isFalse);
    });

    test('密码错误映射为 denied', () async {
      mockChannel((call) => <String, dynamic>{
            'ok': false,
            'error': 'denied',
            'message': '密码不正确，或文件已损坏',
          });
      await expectLater(
        VfsArchive.decrypt('/a/b.khyenc', '/a/b.zip', 'wrong'),
        throwsA(
          isA<VfsException>().having(
            (VfsException e) => e.error,
            'error',
            'denied',
          ),
        ),
      );
    });

    test('目标已存在映射为 conflict', () async {
      mockChannel((call) => <String, dynamic>{
            'ok': false,
            'error': 'conflict',
            'message': '目标已存在',
          });
      await expectLater(
        VfsArchive.encrypt('/a/b.zip', '/a/b.khyenc', 'pw'),
        throwsA(
          isA<VfsException>().having(
            (VfsException e) => e.error,
            'error',
            'conflict',
          ),
        ),
      );
    });
  });

  group('存储分析', () {    test('解析四个维度', () {
      final analysis = StorageAnalysis.fromMap(<String, dynamic>{
        'totalBytes': 2048,
        'fileCount': 12,
        'dirCount': 3,
        'byType': <dynamic>[
          <String, dynamic>{'type': '图片', 'bytes': 1024, 'count': 8},
        ],
        'byFolder': <dynamic>[
          <String, dynamic>{'path': '/Download', 'bytes': 1024},
        ],
        'largest': <dynamic>[
          <String, dynamic>{'path': '/a/b.mp4', 'bytes': 1024},
        ],
        'byMonth': <dynamic>[
          <String, dynamic>{'month': '2026-11', 'bytes': 2048},
        ],
      });

      expect(analysis.totalBytes, 2048);
      expect(analysis.fileCount, 12);
      expect(analysis.byType.single.type, '图片');
      expect(analysis.byFolder.single.path, '/Download');
      expect(analysis.largest.single.path, '/a/b.mp4');
      expect(analysis.byMonth.single.month, '2026-11');
    });

    test('可读总量与比例', () {
      final analysis = StorageAnalysis.fromMap(<String, dynamic>{
        'totalBytes': 1024 * 1024,
      });
      expect(analysis.readableTotal, '1.0 MB');
      expect(analysis.ratioOf(512 * 1024), closeTo(0.5, 0.001));
      expect(analysis.ratioOf(0), 0);
    });

    test('总量为 0 时比例不除零', () {
      const analysis = StorageAnalysis();
      expect(analysis.ratioOf(100), 0);
      expect(analysis.readableTotal, '0 B');
    });
  });
}
