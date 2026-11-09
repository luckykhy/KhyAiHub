import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/project_profile.g.dart';
import 'package:khy_os_client/ui/widgets/project_info_card.dart';

/// 「项目」区块。
///
/// 这个卡片有两个消费方（settings_screen 与 settings_screen_new），而真机上用户
/// 看到的是后者。早先只改前者的教训是：卡片"实现了"却没人见过。所以这里按它
/// 自己的约束搭脚手架测，不依赖任何一个设置页。
void main() {
  Widget harness() => MaterialApp(
        home: Scaffold(body: SingleChildScrollView(child: ProjectInfoCard())),
      );

  testWidgets('五块内容都在', (tester) async {
    await tester.pumpWidget(harness());
    expect(find.text('项目'), findsOneWidget);
    expect(find.text('版本轨道'), findsOneWidget);
    expect(find.text('构建基线'), findsOneWidget);
    expect(find.text('守卫结论'), findsOneWidget);
    expect(find.text('项目结构'), findsOneWidget);
    expect(find.text('红线（AI 动手前须知道）'), findsOneWidget);
  });

  testWidgets('版本轨道逐条显示，不是一坨', (tester) async {
    await tester.pumpWidget(harness());
    for (final t in BuildInfo.current.versionTracks) {
      expect(find.textContaining(t.track), findsWidgets);
      expect(find.textContaining(t.version), findsWidgets);
    }
  });

  testWidgets('守卫结论一定带日期', (tester) async {
    // 一个没有日期的绿灯比不显示更糟：基线性守卫会随代码增长重新变红，
    // 而半年前的通过看起来会像刚刚的通过。
    await tester.pumpWidget(harness());
    final guards = BuildInfo.current.guards;
    if (guards == null) {
      expect(find.textContaining('构建时未记录'), findsOneWidget);
      return;
    }
    expect(find.textContaining('快照时间：'), findsOneWidget);
    expect(find.textContaining(guards.takenAt), findsOneWidget);
  });

  testWidgets('仓库无提交时不显示空 commit', (tester) async {
    // 本机没有提交，commit 为空串。显示一个空白行不如说清"以版本轨道为准"。
    await tester.pumpWidget(harness());
    if (BuildInfo.current.commit.isEmpty) {
      expect(find.text('仓库无提交（版本轨道为准）'), findsOneWidget);
    }
  });

  testWidgets('红线逐条显示', (tester) async {
    await tester.pumpWidget(harness());
    for (final e in ProjectProfileData.redLines) {
      expect(find.textContaining(e[0]), findsOneWidget,
          reason: '${e[0]} 必须在界面上看得见');
    }
  });
}
