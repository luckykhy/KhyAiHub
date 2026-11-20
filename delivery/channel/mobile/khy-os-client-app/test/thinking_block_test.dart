import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/theme/app_theme.dart';
import 'package:khy_os_client/ui/widgets/thinking_block.dart';

/// 思维链折叠块的契约测试。
///
/// 覆盖验收标准要求的四条：默认收起、点头部展开、再点收起、空 reasoning 不渲染。
/// 另加两条本组件自己的硬约束：流式中/已结束两态标题、disableAnimations 下动画归零。
void main() {
  Widget wrap(Widget child, {Brightness brightness = Brightness.dark}) {
    return MaterialApp(
      theme: brightness == Brightness.dark
          ? AppTheme.dark()
          : AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );
  }

  const reasoning = '先看看用户问的是什么，再决定要不要动工具。';

  group('ThinkingBlock', () {
    testWidgets('空 reasoning 整体不渲染（不是空壳）', (tester) async {
      await tester.pumpWidget(wrap(const ThinkingBlock(reasoning: '')));
      expect(find.byType(ThinkingBlock), findsOneWidget);
      // 零尺寸：既没有标题也没有正文
      expect(find.text('思考'), findsNothing);
      expect(find.text('正在思考'), findsNothing);

      // 全空白同样算空
      await tester.pumpWidget(
          wrap(const ThinkingBlock(reasoning: '   \n\t ')));
      expect(find.text('思考'), findsNothing);
    });

    testWidgets('默认收起：只有标题，正文不在树上', (tester) async {
      await tester.pumpWidget(wrap(const ThinkingBlock(reasoning: reasoning)));

      // 未流式 → 「思考」
      expect(find.text('思考'), findsOneWidget);
      expect(find.text('收起'), findsNothing);
      expect(find.text('展开'), findsOneWidget);
      // 收起态正文根本不进树（不是"渲染了但看不见"）
      expect(find.text(reasoning), findsNothing);
    });

    testWidgets('点头部展开、再点收起', (tester) async {
      await tester.pumpWidget(wrap(const ThinkingBlock(reasoning: reasoning)));

      await tester.tap(find.text('思考'));
      await tester.pumpAndSettle();
      expect(find.text(reasoning), findsOneWidget);
      expect(find.text('收起'), findsOneWidget);

      await tester.tap(find.text('思考'));
      await tester.pumpAndSettle();
      expect(find.text(reasoning), findsNothing);
      expect(find.text('展开'), findsOneWidget);
    });

    testWidgets('标题区分流式中 / 已结束两态', (tester) async {
      await tester.pumpWidget(
          wrap(const ThinkingBlock(reasoning: reasoning, streaming: true)));
      expect(find.text('正在思考'), findsOneWidget);
      expect(find.text('思考'), findsNothing);

      await tester.pumpWidget(
          wrap(const ThinkingBlock(reasoning: reasoning, streaming: false)));
      expect(find.text('思考'), findsOneWidget);
      expect(find.text('正在思考'), findsNothing);
    });

    testWidgets('disableAnimations 下展开不播动画，直接到位', (tester) async {
      await tester.pumpWidget(
        MediaQuery(
          data: const MediaQueryData(disableAnimations: true),
          child: MaterialApp(
            theme: AppTheme.dark(),
            home: Scaffold(
              body: Center(child: ThinkingBlock(reasoning: reasoning)),
            ),
          ),
        ),
      );

      await tester.tap(find.text('思考'));
      // 一次 pump 就到位：没有 200ms 过渡可等
      await tester.pump();
      expect(find.text(reasoning), findsOneWidget);
    });

    testWidgets('深浅两主题都能渲染（正文只用 textSecondary）', (tester) async {
      for (final brightness in Brightness.values) {
        // 每个主题一把 Key：pumpWidget 会按位置复用 State，不给新 Key 的话
        // 第二圈拿到的还是上一圈那个 _expanded=true 的 State，一点就收回去了。
        await tester.pumpWidget(wrap(
          ThinkingBlock(key: ValueKey('tb_${brightness.name}'),
              reasoning: reasoning),
          brightness: brightness,
        ));
        expect(find.text('思考'), findsOneWidget);
        await tester.tap(find.text('思考'));
        await tester.pumpAndSettle();
        expect(find.text(reasoning), findsOneWidget);
      }
    });
  });
}
