import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/model_registry.dart';
import 'package:khy_os_client/ui/theme/design_tokens.dart';
import 'package:khy_os_client/ui/widgets/model_picker_sheet.dart';

/// 模型选择面板。
///
/// 重点验两件事：选中值真的能带回调用方（否则聊天页「切换模型」是个空操作），
/// 以及面板不会溢出——bottom sheet 里 mainAxisSize.min + Flexible 是实测会炸的组合。
void main() {
  final models = [
    const ModelInfo(id: 'm-a', name: '模型 A', provider: 'p'),
    const ModelInfo(id: 'm-b-long-identifier-name', name: '模型 B', provider: 'p'),
  ];

  /// 打开面板并回传选中值。
  ///
  /// helper 只负责「打开」，选中由各用例自己点、自己断言——让 helper 同时返回
  /// 选中值的话，每个用例拿到的都会是 null（showModalBottomSheet 的完成时机在
  /// 按钮的 onPressed 里，helper 等不到）。
  Future<void> openPicker(WidgetTester tester, void Function(ModelInfo?) onPicked,
      {List<ModelInfo>? list}) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (ctx) => ElevatedButton(
            onPressed: () async {
              onPicked(await showModalBottomSheet<ModelInfo>(
                context: ctx,
                builder: (_) => ModelPickerSheet(
                  models: list ?? models,
                  currentId: 'm-a',
                  palette: AppPalette.of(ctx),
                ),
              ));
            },
            child: const Text('open'),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('两个模型都列出来，当前选中的打勾', (tester) async {
    await openPicker(tester, (_) {});
    expect(find.text('模型 A'), findsOneWidget);
    expect(find.text('模型 B'), findsOneWidget);
    // 当前项要有可见的勾——否则用户不知道现在用的是哪个。
    expect(find.byIcon(Icons.check), findsOneWidget);
  });

  testWidgets('点一个把它的 id 带回调用方', (tester) async {
    // 关键：没有这一步，聊天页的「切换模型」选了也白选。
    ModelInfo? picked;
    await openPicker(tester, (v) => picked = v);
    await tester.tap(find.text('模型 B'));
    await tester.pumpAndSettle();
    expect(picked?.id, 'm-b-long-identifier-name');
  });

  testWidgets('id 与 name 不同时把 id 也显示出来', (tester) async {
    // 只显示 name 时，两个 name 相同而 id 不同的模型无法区分。
    await openPicker(tester, (_) {});
    expect(find.textContaining('m-b-long-identifier-name'), findsOneWidget);
  });

  testWidgets('空列表时说清原因，不留一个空白面板', (tester) async {
    await openPicker(tester, (_) {}, list: const []);
    expect(find.textContaining('没拿到模型列表'), findsOneWidget);
    expect(find.textContaining('换一个提供商'), findsOneWidget);
  });

  testWidgets('面板不溢出', (tester) async {
    // 回归护栏：mainAxisSize.min + Flexible(ListView) 在 bottom sheet 里实测
    // 溢出 99564 像素。ConstrainedBox 是唯一的修法，删掉就会复现。
    await openPicker(tester, (_) {});
    expect(tester.takeException(), isNull);
  });
}
