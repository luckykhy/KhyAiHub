// 容器根缺失时的列目录行为（通道打桩）。
//
// ## 为什么要有这个套件
//
// 真机实测（2026-11-18，用户截图）：全新安装后点侧栏「容器空间」，文件管理器
// 停在「目录不存在：/khyos/container」+ 一个重试钮上——再点重试还是同一个错，
// 因为根目录压根没人建。同一个根因下，「容器应用」页更糟：`_load()` 不接异常，
// 用户看到的是一只永远转圈的 spinner。
//
// 容器是 App 自己的沙盒（filesDir/khy-os/container），写入路径（VfsCopier 拷入、
// mkdir 新建、sqlite scratch）本来就会自建它；缺的只是**读路径**这一侧。所以判据
// 钉在这三件事上：
//   1. 列容器根遇到 not_found → 先建根再重试，用户看到的是空目录而不是死页；
//   2. 根已经存在时**不**发 mkdir——读操作不该每次Listing都顺手写一次盘；
//   3. 容器根**之下**的目录真不存在时照样报错——不把「用户敲错路径」一起抹平。

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_service.dart';
import 'package:khy_os_client/ui/screens/container_apps_screen.dart';
import 'package:khy_os_client/ui/theme/app_theme.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/vfs');

  final calls = <MethodCall>[];

  void mockChannel(Object? Function(MethodCall call) handler) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return handler(call);
        });
  }

  Map<String, dynamic> statusMap() => <String, dynamic>{
    'ok': true,
    'storageGranted': true,
    'safeMode': false,
    'elevation': <String, dynamic>{
      'installed': false,
      'running': false,
      'version': '',
      'available': false,
    },
    'containerRoot':
        '/data/user/0/com.khyos.khy_os_client/files/khy-os/container',
    'containerInstalled': false,
  };

  setUp(() => calls.clear());

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('容器根不存在时，列目录先建根再重试，不把用户按在死页上', () async {
    var listCalls = 0;
    mockChannel((call) {
      switch (call.method) {
        case 'status':
          return statusMap();
        case 'mkdir':
          return <String, dynamic>{
            'ok': true,
            'message': '已创建目录：/khyos/container',
          };
        case 'list':
          listCalls++;
          // 第一次列：原生找不到根（全新安装就是这一下）
          if (listCalls == 1) {
            return <String, dynamic>{
              'ok': false,
              'error': 'not_found',
              'message': '目录不存在：/khyos/container',
            };
          }
          return <String, dynamic>{'ok': true, 'nodes': <dynamic>[]};
        default:
          return <String, dynamic>{'ok': true};
      }
    });

    final vfs = VfsService.instance;
    await vfs.status(refresh: true);

    final listing = await vfs.list('/khyos/container');

    expect(listing.locked, isFalse);
    expect(listing.nodes, isEmpty);
    expect(listCalls, 2, reason: '失败后必须重列一次，否则用户看到的是旧结果');

    final mkdirIndex = calls.indexWhere((c) => c.method == 'mkdir');
    expect(mkdirIndex, greaterThanOrEqualTo(0), reason: '必须真的去建容器根，不是把错误咽了');
    expect((calls[mkdirIndex].arguments as Map)['path'], '/khyos/container');
  });

  test('mkdir 撞上 conflict（根已被并发建出）不算失败', () async {
    var listCalls = 0;
    mockChannel((call) {
      switch (call.method) {
        case 'status':
          return statusMap();
        case 'mkdir':
          return <String, dynamic>{
            'ok': false,
            'error': 'conflict',
            'message': '目录已存在：/khyos/container',
          };
        case 'list':
          listCalls++;
          if (listCalls == 1) {
            return <String, dynamic>{
              'ok': false,
              'error': 'not_found',
              'message': '目录不存在：/khyos/container',
            };
          }
          return <String, dynamic>{'ok': true, 'nodes': <dynamic>[]};
        default:
          return <String, dynamic>{'ok': true};
      }
    });

    final vfs = VfsService.instance;
    await vfs.status(refresh: true);

    final listing = await vfs.list('/khyos/container');
    expect(listing.nodes, isEmpty);
    expect(listCalls, 2);
  });

  test('容器根已存在时不发 mkdir——读不该每次顺手写盘', () async {
    mockChannel((call) {
      switch (call.method) {
        case 'status':
          return statusMap();
        case 'list':
          return <String, dynamic>{
            'ok': true,
            'nodes': <dynamic>[
              <String, dynamic>{
                'name': 'photos',
                'path': '/khyos/container/photos',
                'isDirectory': true,
              },
            ],
          };
        default:
          return <String, dynamic>{'ok': true};
      }
    });

    final vfs = VfsService.instance;
    await vfs.status(refresh: true);

    final listing = await vfs.list('/khyos/container');
    expect(listing.nodes, hasLength(1));
    expect(calls.where((c) => c.method == 'mkdir'), isEmpty);
  });

  test('容器根之下的目录真不存在时，错误照旧报出来', () async {
    mockChannel((call) {
      switch (call.method) {
        case 'status':
          return statusMap();
        case 'list':
          return <String, dynamic>{
            'ok': false,
            'error': 'not_found',
            'message': '目录不存在：/khyos/container/nope',
          };
        default:
          return <String, dynamic>{'ok': true};
      }
    });

    final vfs = VfsService.instance;
    await vfs.status(refresh: true);

    await expectLater(
      vfs.list('/khyos/container/nope'),
      throwsA(isA<VfsException>().having((e) => e.error, 'error', 'not_found')),
    );
    // 不能为了兜一个不存在的子目录就把整个容器根建出来——那是把
    // 「用户敲错路径」和「沙盒还没初始化」混成一件事。
    expect(calls.where((c) => c.method == 'mkdir'), isEmpty);
  });

  group('容器应用页', () {
    // mkdir 会写审计日志，审计日志要 path_provider 指路；widget test 不起原生，
    // 不 mock 的话那个 Future 永远不回来（表现为 spinner 永转 + pumpAndSettle 超时）。
    // 别的套件（floating_task_hub_test 等）同一理由同一打法。
    const pathProvider = MethodChannel('plugins.flutter.io/path_provider');
    late Directory supportDir;

    setUp(() {
      supportDir = Directory.systemTemp.createTempSync(
        'khyos-container-app-test',
      );
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(pathProvider, (call) async {
            if (call.method == 'getApplicationSupportPath')
              return supportDir.path;
            return null;
          });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(pathProvider, null);
      try {
        supportDir.deleteSync(recursive: true);
      } catch (_) {}
    });

    testWidgets('读不到容器目录时报错 + 重试，不留一只永转的 spinner', (tester) async {
      mockChannel((call) {
        switch (call.method) {
          case 'status':
            return statusMap();
          case 'mkdir':
            return <String, dynamic>{'ok': true};
          case 'list':
            // 建根也救不了的那种失败（这里是存储权限没给）：必须让人看到原因。
            return <String, dynamic>{
              'ok': false,
              'error': 'storage_denied',
              'message': '缺少「所有文件访问」权限，无法访问共享存储',
            };
          default:
            return <String, dynamic>{'ok': true};
        }
      });

      await tester.pumpWidget(
        MaterialApp(theme: AppTheme.dark(), home: const ContainerAppsScreen()),
      );
      await tester.pumpAndSettle();

      expect(
        find.byType(CircularProgressIndicator),
        findsNothing,
        reason:
            '_load() 不接异常时（2026-11-18 前）界面就卡在这只 spinner 上，'
            '没有错误也没有出口',
      );
      expect(find.textContaining('所有文件访问'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, '重试'), findsOneWidget);
    });

    testWidgets('容器根由 list 自建后，空态说的是「运行时未安装」', (tester) async {
      var listCalls = 0;
      mockChannel((call) {
        switch (call.method) {
          case 'status':
            return statusMap();
          case 'mkdir':
            return <String, dynamic>{'ok': true};
          case 'list':
            listCalls++;
            if (listCalls == 1) {
              return <String, dynamic>{
                'ok': false,
                'error': 'not_found',
                'message': '目录不存在：/khyos/container',
              };
            }
            return <String, dynamic>{'ok': true, 'nodes': <dynamic>[]};
          default:
            return <String, dynamic>{'ok': true};
        }
      });

      await tester.pumpWidget(
        MaterialApp(theme: AppTheme.dark(), home: const ContainerAppsScreen()),
      );
      await tester.pumpAndSettle();

      expect(find.text('容器运行时未安装'), findsOneWidget);
      expect(find.text('容器空间里还没有应用'), findsNothing);
    });
  });
}
