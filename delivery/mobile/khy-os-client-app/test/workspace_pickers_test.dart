import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/workspace/conversation_workspace.dart';
import 'package:khy_os_client/core/workspace/workspace_choices.dart';
import 'package:khy_os_client/ui/widgets/workspace_pickers.dart';

/// 工作目录选择器与位置面板的 widget 测试。
///
/// 为什么要用 widget 测试而不是真机点：这两个面板是纯 widget，没有 Riverpod、
/// 没有 Dio、没有设备依赖，所以能确定性验证。而真机点不动——uiautomator 读不到
/// Flutter 的文字（节点全是 text=""），坐标只能靠截图估，估错一次就点到桌面上，
/// 那样的验证证明不了任何事。
void main() {
  group('WorkspacePickerSheet', () {
    testWidgets('显示预设候选，点一个返回规范化路径', (tester) async {
      String? picked;
      await _openPicker(tester, (v) => picked = v);
      // 预设里必须看得到设计的工作空间。
      expect(find.text('khy-os 工作空间'), findsOneWidget);

      await tester.tap(find.text('khy-os 工作空间'));
      await tester.pumpAndSettle();
      expect(picked, '/sdcard/khy-os');
    });

    testWidgets('手动输入合法路径被接受并规范化', (tester) async {
      String? picked;
      await _openPicker(tester, (v) => picked = v);
      // 尾斜杠和重复斜杠都要拧掉——存原样会出现界面看着对、落盘差一点。
      await tester.enterText(find.byType(TextField), '  /sdcard//mygame/  ');
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(Icons.check));
      await tester.pumpAndSettle();
      expect(picked, '/sdcard/mygame');
    });

    testWidgets('手动输入非法路径时报错，不返回', (tester) async {
      String? picked = '未触碰';
      await _openPicker(tester, (v) => picked = v);
      // 相对路径会落到不确定的位置，必须拒。
      await tester.enterText(find.byType(TextField), 'sdcard/relative');
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(Icons.check));
      await tester.pumpAndSettle();

      expect(find.textContaining('根目录必须是绝对路径'), findsOneWidget);
      expect(picked, '未触碰', reason: '拒绝了就不该有关闭值');
    });

    testWidgets('含 .. 的路径被拒', (tester) async {
      String? picked = '未触碰';
      await _openPicker(tester, (v) => picked = v);
      await tester.enterText(find.byType(TextField), '/sdcard/../etc');
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(Icons.check));
      await tester.pumpAndSettle();
      expect(find.textContaining('不允许包含'), findsOneWidget);
      expect(picked, '未触碰');
    });

    testWidgets('跳过返回 null，等于用 App 默认', (tester) async {
      String? picked = '未触碰';
      await _openPicker(tester, (v) => picked = v);
      await tester.tap(find.text('跳过，用默认'));
      await tester.pumpAndSettle();
      expect(picked, isNull);
    });

    testWidgets('标题说明不选会看不到文件', (tester) async {
      // 这句话是用户找不到文件时的第一手线索，不能省。
      // 包 Scaffold：TextField/ListTile 需要 Material 祖先。生产路径在 bottom
      // sheet 里本来就有，这里补上只是为了按真实约束搭。
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: WorkspacePickerSheet(choices: WorkspaceChoices.presets()),
        ),
      ));
      expect(find.text('这个对话的文件放哪？'), findsOneWidget);
      expect(find.textContaining('文件管理器里看不到'), findsOneWidget);
    });
  });


  group('LocationsSheet', () {
    testWidgets('每一行都显示，标签与值都在', (tester) async {
      await _openLocationsSheet(tester);
      expect(find.text('这个对话的位置'), findsOneWidget);
      expect(find.text('工作目录'), findsOneWidget);
      expect(find.text('App 文件工具根目录'), findsOneWidget);
      expect(find.text('对话库'), findsOneWidget);
      expect(find.textContaining('文件管理器看不到'), findsOneWidget);
    });

    testWidgets('没有可复制路径的行不出现复制或打开按钮', (tester) async {
      // 对话库那行没有路径。给它一个复制按钮，点下去复制到一句说明文字，
      // 那是纯误导。
      await _openLocationsSheet(tester);
      final tile = tester.widget<ListTile>(find.ancestor(
        of: find.text('对话库'),
        matching: find.byType(ListTile),
      ));
      final trailing = tile.trailing as Row;
      expect(trailing.children, isEmpty);
    });

    testWidgets('有路径的行才有复制与打开按钮', (tester) async {
      await _openLocationsSheet(tester);
      // 三行里两行带路径 → 两个复制 + 两个打开。
      expect(find.byIcon(Icons.copy), findsNWidgets(2));
      expect(find.byIcon(Icons.folder_open), findsNWidgets(2));
    });

    testWidgets('打开目录失败时提示改用复制，而不是假装成功', (tester) async {
      // 原生区分"没有 App 接"和"起了但立刻退"，这两种失败给用户的下一步完全不同。
      // 这里 mock 成后者（起了但立刻退）：提示必须说清改用复制，不能笼统一句失败。
      await _mockOpenDirectory(<String, Object>{'opened': false, 'noApp': false});
      await _openLocationsSheet(tester);
      await tester.tap(find.byIcon(Icons.folder_open).first);
      await tester.pumpAndSettle();
      expect(find.textContaining('复制路径'), findsOneWidget);
    });

    testWidgets('没有文件管理器接 intent 时提示去装，而不是说打不开', (tester) async {
      // noApp=true 是另一种失败：该做的不是复制路径，而是告诉用户缺什么。
      await _mockOpenDirectory(<String, Object>{'opened': false, 'noApp': true});
      await _openLocationsSheet(tester);
      await tester.tap(find.byIcon(Icons.folder_open).first);
      await tester.pumpAndSettle();
      expect(find.textContaining('没有文件管理器'), findsOneWidget);
    });
  });


  group('预设候选', () {
    test('第一个是设计的工作空间且标了推荐', () {
      final presets = WorkspaceChoices.presets();
      expect(presets.first.path, ConversationWorkspace.designedRoot);
      expect(presets.first.recommended, true);
    });

    test('预设覆盖用户最可能想要的几个位置', () {
      final paths = WorkspaceChoices.presets().map((c) => c.path).toSet();
      expect(paths, contains('/sdcard/khy-os'));
      expect(paths, contains('/sdcard/Download'));
      expect(paths, contains('/sdcard/Documents'));
    });

    test('预设之间没有重复路径', () {
      final paths = WorkspaceChoices.presets().map((c) => c.path).toList();
      expect(paths.toSet().length, paths.length);
    });

    test('预设都通过校验', () {
      // 预设自己过不了校验，用户点了就存不进去，那是纯粹的尴尬。
      for (final c in WorkspaceChoices.presets()) {
        expect(WorkspaceChoices.checkManual(c.path).ok, true,
            reason: '${c.path} 应通过校验');
      }
    });
  });
}

/// 位置面板的样例行。
///
/// 提到顶层而不是写在 group 闭包里：闭包内直接写 `final rows = <LocRow>[` 会让
/// 分析器把 `=> {` 后面的花式当成集合字面量，报 missing_identifier。放成函数
/// 没有这个歧义——这不是风格偏好，是绕开一个真实的解析坑。
/// 走真实使用路径打开位置面板：Scaffold + showModalBottomSheet。
///
/// 直接把它当 home 渲染不出列表（没有 Scaffold 时列表拿不到高度），那不是
/// widget 的 bug，是测试脚手架的错——所以按生产路径搭。
///
/// 顺便：闭包里写局部函数声明会让分析器把  后面的花式误判成集合字面量
/// （报 missing_identifier / Function expressions can't be named）。提到顶层
/// 就没有这个歧义。这不是风格偏好，是绕开一个真实的解析坑。
Future<void> _openLocationsSheet(WidgetTester tester) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (ctx) => ElevatedButton(
          onPressed: () => showModalBottomSheet<void>(
            context: ctx,
            builder: (_) => LocationsSheet(rows: _locRows()),
          ),
          child: const Text('open'),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}


/// 打开工作目录选择器，选中值经 onPicked 回传。
///
/// 之所以用回传而不是让 helper 返回值：showModalBottomSheet 的完成时机在按钮
/// 的 onPressed 里，helper 只能负责「打开」，选中要由各测试自己点、自己断言。
/// 早先让 helper 返回选中值，结果每个用例拿到的都是 null——那测的是脚手架，
/// 不是 widget。
Future<void> _openPicker(WidgetTester tester, void Function(String?) onPicked) async {
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (ctx) => ElevatedButton(
        onPressed: () async {
          final v = await showModalBottomSheet<String>(
            context: ctx,
            builder: (_) => WorkspacePickerSheet(
              choices: WorkspaceChoices.presets(),
            ),
          );
          onPicked(v);
        },
        child: const Text('open'),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}


/// 把 openDirectory 的原生回包 mock 成指定结局。
///
/// 不 mock 就跑不出断言：MethodChannel 在测试里没人接，返回值要等一个真实的
/// 异步回合，`pumpAndSettle` 只排帧不等它——SnackBar 永远不出现，测试就退化成
/// 什么都没验证。
Future<void> _mockOpenDirectory(Map<String, Object> reply) async {
  const ch = MethodChannel('com.khyos.khy_os_client/device');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(ch, (call) async {
    return call.method == 'openDirectory' ? reply : null;
  });
  addTearDown(() {
    messenger.setMockMethodCallHandler(ch, null);
  });
}

List<LocRow> _locRows() {
  return <LocRow>[
    const LocRow(
      label: '工作目录',
      value: '/sdcard/khy-os（App 设计的工作空间，文件管理器可见）',
      copyable: '/sdcard/khy-os',
    ),
    const LocRow(
      label: 'App 文件工具根目录',
      value: '/storage/emulated/0/Android/data/x/files',
      copyable: '/storage/emulated/0/Android/data/x/files',
      copyHint: '实际生效的根（App 私有目录，文件管理器看不到）',
    ),
    const LocRow(
      label: '对话库',
      value: 'FlutterSecureStorage（无文件路径）',
      copyHint: '加密存储，没有可直接跳转的路径',
    ),
  ];
}
