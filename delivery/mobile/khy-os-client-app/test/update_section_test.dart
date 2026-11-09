import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/update_check_service.dart';
import 'package:khy_os_client/ui/widgets/update_section.dart';

/// 「版本与更新」三态渲染。
///
/// WHY THESE THREE STATES. 这个 App 没有可独立升级的引擎，诚实的范围只有平台版本态
/// 与能力资产版本态。而三态里最容易被写错的是第三种：**查不到**。把它渲染成
/// 「已是最新」，用户就永远不知道后端其实连不上发布源——比没有这个功能更糟，
/// 因为现在它会主动说谎。所以每个状态各有一条断言钉住它**说出口的那句话**，
/// 并且查不到态额外断言它没有说出「已是最新」。
///
/// 探测走 loader 注入而不是真网：测试不该依赖一台跑着 khy-os 后端的机器。
void main() {
  Future<void> pump(
    WidgetTester tester,
    Future<UpdateCheckResult> Function(String current, String channel) loader,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(child: UpdateSection(loader: loader)),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  UpdateCheckResult resultFor({
    required String latest,
    required String sourceLabel,
    bool indeterminate = false,
    String? releasePage,
    String releaseChannel = 'stable',
  }) {
    return UpdateCheckResult.fromJson(<String, dynamic>{
      'releaseChannel': releaseChannel,
      'latest': latest,
      'sourceLabel': sourceLabel,
      'indeterminate': indeterminate,
      'localSourceEnabled': true,
      if (releasePage != null) 'releasePage': releasePage,
      'sources': <Map<String, dynamic>>[
        <String, dynamic>{
          'channel': 'github',
          'label': 'GitHub',
          'enabled': true,
          'version': null,
          'error': '请求超时',
        },
        <String, dynamic>{
          'channel': 'pypi',
          'label': 'PyPI',
          'enabled': true,
          'version': latest.isEmpty ? null : latest,
          'error': latest.isEmpty ? '网络错误' : null,
        },
        <String, dynamic>{
          'channel': 'npm',
          'label': 'npm',
          'enabled': true,
          'version': latest.isEmpty ? null : latest,
          'error': null,
        },
      ],
    }, current: '1.1.7');
  }

  testWidgets('update available: says which version, from where, and offers '
      'the release page', (tester) async {
    await pump(tester, (current, channel) async {
      return resultFor(
        latest: '1.2.0',
        sourceLabel: 'PyPI',
        releasePage: 'https://github.com/example.invalid/releases',
      );
    });

    expect(find.textContaining('有新版本：本机 v1.1.7 → 最新发布版 v1.2.0'),
        findsOneWidget);
    expect(find.textContaining('来自 PyPI'), findsOneWidget);
    // 打开发布页是这个状态下唯一的动作出口，必须在。
    expect(find.widgetWithText(FilledButton, '打开发布页'), findsOneWidget);
    // 每源读数要在——它是「为什么是 PyPI」的唯一依据。
    expect(find.textContaining('每源：'), findsOneWidget);
    // 有新版时绝不能出现「已是最新」的任何变体。
    expect(find.textContaining('没有可升级的新版本'), findsNothing);
  });

  testWidgets('up to date: says so without pretending it checked more than it '
      'did', (tester) async {
    await pump(tester, (current, channel) async {
      return resultFor(latest: '1.1.7', sourceLabel: 'PyPI');
    });

    expect(find.textContaining('没有可升级的新版本：本机 v1.1.7'), findsOneWidget);
    expect(find.textContaining('最新发布版 v1.1.7'), findsOneWidget);
    // 已最新时不给「打开发布页」——没有新版要去看。
    expect(find.widgetWithText(FilledButton, '打开发布页'), findsNothing);
    expect(find.textContaining('这不是「已是最新」'), findsNothing);
  });

  testWidgets('indeterminate: says 「查不到」 and explicitly not 「已是最新」',
      (tester) async {
    await pump(tester, (current, channel) async {
      return resultFor(latest: '', sourceLabel: '', indeterminate: true);
    });

    expect(find.text('查不到最新版本——这不是「已是最新」。'), findsOneWidget);
    // 每个源各自的原因要原样摆出来，否则用户不知道该配环境变量还是该重试。
    expect(find.textContaining('GitHub 请求超时'), findsOneWidget);
    expect(find.textContaining('PyPI 网络错误'), findsOneWidget);
    expect(find.textContaining('所有更新源都没取到版本'), findsOneWidget);
    expect(find.textContaining('这不是「已是最新」'), findsWidgets);
    // 这一条是本文件存在的理由：查不到不许显示成已最新。
    expect(find.textContaining('没有可升级的新版本'), findsNothing);
  });

  testWidgets('no release page configured: says so instead of showing a dead '
      'button', (tester) async {
    await pump(tester, (current, channel) async {
      return resultFor(latest: '1.2.0', sourceLabel: 'PyPI');
    });

    expect(find.widgetWithText(FilledButton, '打开发布页'), findsNothing);
    expect(find.textContaining('没有可打开发布页的地址'), findsOneWidget);
    expect(find.textContaining('KHY_UPDATE_GITHUB_REPOSITORY'), findsOneWidget);
  });

  testWidgets('the capability block reports its own version state and never '
      'claims a download it cannot make', (tester) async {
    // path_provider 没有平台通道（widget test 不起原生），这一块必须诚实报
    // 「读不到」而不是「未安装」——说未安装会让用户去点一个注定失败的下载。
    await pump(tester, (current, channel) async {
      return resultFor(latest: '1.1.7', sourceLabel: 'PyPI');
    });

    expect(find.textContaining('读不到能力资产的本地状态'), findsOneWidget);
  });

  testWidgets('the preview track says out loud that it changes nothing',
      (tester) async {
    // 后端 resolver 只报最高的正式版，所以 preview 与 stable 看到同一个版本号。
    // 不说出来，用户就会以为预览版已经在生效——一个没有任何症状的错误信念。
    await pump(tester, (current, channel) async {
      return resultFor(
        latest: '1.1.7',
        sourceLabel: 'PyPI',
        releaseChannel: 'preview',
      );
    });

    expect(find.textContaining('preview 轨道暂不改变探测结果'), findsOneWidget);
    expect(find.textContaining('只报最高的正式版'), findsOneWidget);
  });

  testWidgets('the stable track says nothing about preview',
      (tester) async {
    await pump(tester, (current, channel) async {
      return resultFor(latest: '1.1.7', sourceLabel: 'PyPI');
    });
    expect(find.textContaining('preview 轨道'), findsNothing);
  });
}
