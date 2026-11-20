import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/khyos_api.dart';
import 'package:khy_os_client/ui/screens/plugin_market_screen.dart';
import 'package:khy_os_client/ui/theme/app_theme.dart';

/// 市场页在「还没连上」时的行为。
///
/// 这一屏是唯一能脱离网络验证的部分：连上之后的所有展示都来自后端载荷，
/// 由 market_catalog_test 钉形状。这里只保证未连接、配对内容错误这两件事
/// 不会崩、也不会把用户送到一个假的"市场为空"。
/// 未连接时本页只读；连接并登录后安装/卸载走 /api/skills/install|uninstall，
/// 那一段要真后端才能验证，请求形状由 market_catalog_test 钉。
/// 不碰 flutter_secure_storage 的 KhyOsApi。
///
/// 那条方法通道在 widget 测试环境里没有宿主实现，`loadConnection()` 不会完成，
/// 页面会永远停在 booting 转圈——被测的不是安全存储，所以这里直接给它一个
/// 「没配对过」的答复。
class _OfflineApi extends KhyOsApi {
  @override
  Future<KhyOsConnection?> loadConnection() async => null;
}

void main() {
  Future<void> pumpScreen(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(body: PluginMarketScreen(api: _OfflineApi())),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('未连接时只读、已连接后可安装：地址页把两种状态说清楚', (tester) async {
    await pumpScreen(tester);

    expect(find.text('后端地址'), findsOneWidget);
    expect(find.text('配对内容（可选）'), findsOneWidget);
    expect(find.text('扫描配对码'), findsOneWidget);
    expect(find.text('连接并读取'), findsOneWidget);
    expect(find.textContaining('未连接时本页只读'), findsOneWidget);
    expect(find.textContaining('连接并登录后技能与 MCP 条目可直接安装'), findsOneWidget);
  });

  testWidgets('扫到管理页二维码时当场拒绝，不发起网络请求', (tester) async {
    await pumpScreen(tester);

    await tester.enterText(
      find.widgetWithText(TextField, '后端地址'),
      '{"apiBaseUrl":"http://192.168.1.9:3000/admin/ai-gateway"}',
    );
    await tester.tap(find.text('连接并读取'));
    await tester.pumpAndSettle();

    expect(find.textContaining('管理页二维码'), findsOneWidget);
    // 仍停在连接页，没有进入市场或登录页。
    expect(find.text('连接并读取'), findsOneWidget);
  });

  testWidgets('地址无法解析时报具体原因，而不是留一个空屏', (tester) async {
    await pumpScreen(tester);

    await tester.enterText(
      find.widgetWithText(TextField, '后端地址'),
      'http://[not-a-host',
    );
    await tester.tap(find.text('连接并读取'));
    await tester.pumpAndSettle();

    expect(find.textContaining('不是有效地址'), findsOneWidget);
  });
}
