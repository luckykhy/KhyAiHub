import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/screens/settings_screen_new.dart';

/// 设置页返回行为的回归护栏。
///
/// 实测的 bug：设置页既被当 tab 用（KhyOsHome 的 screens 列表），又被
/// ChatScreenNew 的头部齿轮 push 当路由用。当它是 tab 时，顶栏那个 ← 调的
/// `Navigator.pop(context)` 在根导航器上没有东西可弹——那一按把 App 退掉，
/// 用户看到的是「整个黑屏」（这台手机的桌面是深色的）。
///
/// 这个套件钉住两半：
///   1. 没有路由可弹时，← 必须交给宿主（onExit），不能去 pop；
///   2. 有路由可弹时（push 进来的那一半），← 照旧 pop。
void main() {
  /// 把设置页当根路由用——正是「设置」tab 的情形。
  Widget asTab({VoidCallback? onExit}) => MaterialApp(
        home: SettingsScreenNew(onExit: onExit),
      );

  testWidgets('tab 形态：← 不 pop，交给 onExit', (tester) async {
    var exited = 0;
    await tester.pumpWidget(asTab(onExit: () => exited += 1));

    await tester.tap(find.byIcon(Icons.arrow_back));
    await tester.pumpAndSettle();

    expect(exited, 1, reason: '没有路由可弹时必须交给宿主');
    // 页面还在：没有被 pop 掉。
    expect(find.text('设置'), findsOneWidget);
  });

  testWidgets('tab 形态且宿主没给 onExit：← 什么也不做', (tester) async {
    // 什么都不做也好过退掉 App 变黑屏。这个用例是那道防线本身。
    await tester.pumpWidget(asTab());

    await tester.tap(find.byIcon(Icons.arrow_back));
    await tester.pumpAndSettle();

    expect(find.text('设置'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('路由形态：← 照旧 pop', (tester) async {
    // push 进来的那一半不能被改坏——那里本来就有路由可弹。
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (ctx) => ElevatedButton(
          onPressed: () => Navigator.push(
            ctx,
            MaterialPageRoute<void>(
              builder: (_) => const SettingsScreenNew(),
            ),
          ),
          child: const Text('open'),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('设置'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.arrow_back));
    await tester.pumpAndSettle();

    expect(find.text('设置'), findsNothing, reason: 'push 进来的应当被弹掉');
    expect(find.text('open'), findsOneWidget);
  });

  testWidgets('tab 形态：系统返回键也交给 onExit', (tester) async {
    // PopScope 那半。少了它，在「设置」tab 上按系统返回/返回手势照样退 App。
    var exited = 0;
    await tester.pumpWidget(asTab(onExit: () => exited += 1));

    await tester.binding.handlePopRoute(); // 等价于系统返回键
    await tester.pumpAndSettle();

    expect(exited, 1);
    expect(find.text('设置'), findsOneWidget);
  });
}
