import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/screens/settings_screen_new.dart';

/// 内置提供商从平铺卡片改成一枚下拉字段（2026-11-15 用户要求）的护栏。
///
/// 钉三件事：
///   1. 页面本身不再平铺提供商——打开页面前看不到任何提供商名，只有一枚字段；
///   2. 点开字段是同一份清单，选中即把 Base URL 与默认模型填进下面的表单；
///   3. 端点未配置的项（仓库构建里的 'khy-os 网关'）点下去
///      不写任何值，先说明原因——把空 Base URL 填进输入框，用户只会在一个
///      连不上的端点上排查半天。'opencode free' 同属未配置，但它与 OpenCode Zen
///      等价，未生成镜像端点时整项不列出（见 built_in_keys_endpoints_test）。
///
/// 为什么全程用 pump 定帧而不是 pumpAndSettle：本页（权限中心快照卡）带着
/// 一个不停止的动画，pumpAndSettle 永远等不到「没有下一帧」——仓库里
/// task_status_screen_test.dart 对同类永转动画是同一处理。同理拖拽不用
/// dragUntilVisible（它内部也调 pumpAndSettle），改用手动循环。
void main() {
  /// 空配置进页面：匹配不上任何内置端点，字段应显示「自定义」而不是
  /// 冒充某一项。AppConfig.load() 在测试环境没有平台通道，fail-soft 回默认值。
  Widget asTab() => const MaterialApp(home: SettingsScreenNew());

  /// 推进若干帧，够路由/对话框过渡与 initState 的异步回填跑完。
  Future<void> settleFrames(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Finder baseUrlField() => find.byWidgetPredicate(
        (w) =>
            w is TextField &&
            w.decoration?.hintText == 'https://api.example.com/v1',
      );

  /// 点字段本体，不是上方那个「提供商」标签——标签在 GestureDetector 外面，
  /// 点它什么都不会发生（真机上第一次就踩过：点标签没反应，点字段才开）。
  Finder providerField() => find.text('自定义（未使用内置提供商）');

  testWidgets('页面不平铺提供商，只呈现一枚下拉字段', (tester) async {
    await tester.pumpWidget(asTab());
    await settleFrames(tester);

    expect(find.text('提供商'), findsOneWidget);
    expect(providerField(), findsOneWidget);
    expect(find.byIcon(Icons.expand_more), findsWidgets);
    // 平铺时代每个提供商名都直接出现在页面里；现在只有点开清单才看得到。
    expect(find.text('OpenRouter'), findsNothing);
    expect(find.text('Agnes'), findsNothing);
  });

  testWidgets('点开清单选中提供商：Base URL 与默认模型落入表单', (tester) async {
    await tester.pumpWidget(asTab());
    await settleFrames(tester);

    await tester.tap(providerField());
    await settleFrames(tester);
    expect(find.text('选择提供商'), findsOneWidget);

    await tester.tap(find.text('SupXH'));
    await settleFrames(tester);

    // 清单收起，字段显示刚选的这一项。
    expect(find.text('选择提供商'), findsNothing);
    expect(find.text('SupXH'), findsOneWidget);

    final baseUrl = tester.widget<TextField>(baseUrlField());
    expect(baseUrl.controller?.text, 'https://speed44.toter.me/v1');
    expect(find.text('claude-sonnet-4-5'), findsOneWidget);
  });

  testWidgets('端点未配置的项：先说明原因，不写 Base URL', (tester) async {
    await tester.pumpWidget(asTab());
    await settleFrames(tester);

    await tester.tap(providerField());
    await settleFrames(tester);

    // 清单 10 项，对话框只露得出前几项——把里面那个 ListView 拖到目标可见。
    final list = find.descendant(
      of: find.byType(AlertDialog),
      matching: find.byType(ListView),
    );
    for (var i = 0;
        i < 25 && find.text('khy-os 网关').evaluate().isEmpty;
        i++) {
      await tester.drag(list, const Offset(0, -100));
      await tester.pump(const Duration(milliseconds: 80));
    }
    expect(find.text('khy-os 网关'), findsOneWidget);

    await tester.tap(find.text('khy-os 网关'));
    await settleFrames(tester);

    // 弹出的是说明而不是选中：表单里的 Base URL 一个字都没多。
    expect(find.text('khy-os 网关：端点未随包提供'), findsOneWidget);
    final baseUrl = tester.widget<TextField>(baseUrlField());
    expect(baseUrl.controller?.text, isEmpty);
  });
}
