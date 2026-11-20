import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/widgets/debug_net_capture_card.dart';

/// 抓包调试面板的护栏（断点五，T18 的人这一侧）。
///
/// WHY THIS FILE EXISTS. 这个面板是「开启需确认」的人机界面：解锁位只有它能写，
/// 工具侧只读。三条性质必须钉住：
///
///   1. 没解锁时整块不出现——不是灰着的入口，是不存在。调试工具对一个
///       「随手翻到设置的普通用户」可见，本身就是泄露面；
///   2. 开抓要经 consent 弹窗（人点允许），面板必须如实说「点了允许才开始」，
///      而不是显示成已经在抓；
///   3. TLS 档是显式调试项：默认关，文案必须说清「不信任 CA 的 App 会失败」。
void main() {
  const channel = MethodChannel('com.khyos.khy_os_client/device');

  void install(Map<String, Object?> responses, {List<String>? log}) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      log?.add(call.method);
      if (responses.containsKey(call.method)) return responses[call.method];
      return <Object?>{};
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  testWidgets('没解锁时面板整块不出现', (tester) async {
    install({'netDebugState': {'unlocked': false, 'vpn_supported': true}});
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: DebugNetCaptureCard())));
    await tester.pumpAndSettle();
    expect(find.text('网络抓包（调试）'), findsNothing);
    expect(find.text('开始抓包'), findsNothing);
  });

  testWidgets('解锁后开抓要过人点授权，且如实说明点了允许才开始', (tester) async {
    final log = <String>[];
    install({
      'netDebugState': {'unlocked': true, 'vpn_supported': true},
      'netCaptureStart': {'ok': true, 'vpn': 'consent_requested'},
    }, log: log);
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: DebugNetCaptureCard())));
    await tester.pumpAndSettle();

    await tester.tap(find.text('开始抓包'));
    await tester.pumpAndSettle();
    expect(log, contains('netCaptureStart'));
    expect(find.textContaining('系统会弹「连接请求」'), findsOneWidget);
    // 不能显示成「已开始抓包」——授权还没给，给了才有流量。
    expect(find.textContaining('已开始抓包'), findsNothing);
  });

  testWidgets('开抓参数默认不带 tls（默认档不需要 CA）', (tester) async {
    Object? args;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'netCaptureStart') args = call.arguments;
      if (call.method == 'netDebugState') {
        return {'unlocked': true, 'vpn_supported': true};
      }
      if (call.method == 'netCaptureStart') return {'ok': true, 'active': true};
      return <Object?>{};
    });
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: DebugNetCaptureCard())));
    await tester.pumpAndSettle();

    await tester.tap(find.text('开始抓包'));
    await tester.pumpAndSettle();
    expect(args, isA<Map>());
    expect((args as Map)['tls'], isFalse,
        reason: '默认档是 self：不碰 TLS、不需要 CA，tls 只能是显式打开');
  });

  testWidgets('TLS 档默认关，文案说清不信任 CA 的 App 会失败', (tester) async {
    install({'netDebugState': {'unlocked': true, 'vpn_supported': true}});
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: DebugNetCaptureCard())));
    await tester.pumpAndSettle();

    final toggle = find.widgetWithText(SwitchListTile, 'TLS 解密（self+tls）');
    expect(toggle, findsOneWidget);
    expect(tester.widget<SwitchListTile>(toggle).value, isFalse);
    expect(find.textContaining('HTTPS 只记目标主机'), findsOneWidget);

    // 打开之后文案换成「会失败并记无法解密」——不能是「打开就都能解密了」。
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(toggle).value, isTrue);
    expect(find.textContaining('无法解密'), findsOneWidget);
  });

  testWidgets('抓包中显示档位（off/self/self+tls）与 CA 导出入口', (tester) async {
    install({
      'netDebugState': {'unlocked': true, 'vpn_supported': true},
      'netCaptureStatus': {
        'active': true,
        'port': 8899,
        'capture': 'self+tls',
        'records': 3,
        'undecryptable': 1,
        'rules': 2,
        'expires_in_ms': 600000,
      },
    });
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: DebugNetCaptureCard())));
    await tester.pumpAndSettle();

    expect(find.textContaining('抓包中 · self+tls'), findsOneWidget);
    expect(find.textContaining('端口 8899'), findsOneWidget);
    expect(find.text('导出 CA 证书'), findsOneWidget);
  });
}
