// 权限中心里「电池与后台运行」那一行的 widget 测试。
//
// 这一行是本次新增的常驻入口：它指向的是一整页"一步步清单"，不是一次授权动作。
// 所以状态全绿时也必须保留「去设置」胶囊——否则用户再也进不去那一页，
// 而"允许受限设置"这类步骤与手动打"已完成"都住在那里。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/screens/permission_center_screen.dart';

const _channel = MethodChannel('com.khyos.khy_os_client/device');

/// 通道返回值的可变开关：一个测试里改一处状态，断言另一处。
class _NativeSpy {
  bool batteryWhitelisted = true;
  bool accessibilityOn = true;
  bool screenCaptureOn = false;

  Map<Object?, Object?> get status => <Object?, Object?>{
        'manufacturer': 'stepx',
        'isIgnoringBatteryOptimizations': batteryWhitelisted,
        'isBackgroundRestricted': false,
        'autostartState': 'unknown',
        'restrictedSettingsLikely': false,
        'lastCheckAt': 1700000000000,
        'hasActionable': !batteryWhitelisted,
      };
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _NativeSpy spy;

  setUp(() {
    spy = _NativeSpy();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (MethodCall call) async {
      switch (call.method) {
        case 'bridgeStatus':
          return {
            'online': true,
            'port': 8896,
            'tokenMasked': '***',
            'tokenPersisted': true,
            'uiReady': true,
            'toolCount': 60,
            'overlayRunning': false,
            'overlayGranted': true,
            'allFiles': true,
            'pcReachable': true,
          };
        case 'checkPermissions':
          return {
            'notifications': true,
            'overlay': true,
            'accessibility': spy.accessibilityOn,
          };
        case 'isScreenCaptureReady':
          return spy.screenCaptureOn;
        case 'elevationStatus':
          return {
            'installed': true,
            'running': true,
            'online': false,
            'version': '1.0',
            'reason': '未授权',
          };
        case 'batteryStatus':
          return spy.status;
        case 'batteryGuideSteps':
          return <Map<Object?, Object?>>[];
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
  });

  Future<void> pumpCenter(WidgetTester tester) async {
    // 权限中心是一张长列表，默认 800x600 的测试视口装不下最后一行——
    // 换成与真机同尺寸，否则测不到"常驻入口"那一行。
    tester.view.physicalSize = const Size(1200, 2670);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const MaterialApp(home: PermissionCenterScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  testWidgets('汇总口径含"电池白名单"这一项（5/6，缺屏幕捕获）', (tester) async {
    await pumpCenter(tester);

    expect(find.textContaining('/6 已就绪'), findsOneWidget);
    expect(find.textContaining('屏幕捕获'), findsWidgets);
  });

  testWidgets('电池已放行时仍保留「去设置」入口（常驻）', (tester) async {
    spy.batteryWhitelisted = true;
    await pumpCenter(tester);

    // 这一行存在，且带入口
    expect(find.text('电池与后台运行'), findsOneWidget);
    expect(find.textContaining('当前：已放行'), findsOneWidget);
    // 别的行在就绪时只显示勾，这一行不一样
    expect(find.text('去设置'), findsOneWidget);
  });

  testWidgets('电池未放行时汇总卡点名"电池白名单"', (tester) async {
    spy.batteryWhitelisted = false;
    await pumpCenter(tester);

    expect(find.textContaining('电池白名单'), findsWidgets);
    expect(find.text('去设置'), findsOneWidget);
  });

  testWidgets('点「去设置」进到引导页', (tester) async {
    await pumpCenter(tester);

    await tester.tap(find.text('去设置'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 断言引导页**独有**的东西：权限中心那一行也写着"电池与后台运行"，
    // 只查标题会两边都命中，等于没测。
    expect(find.text('一键放行电池优化'), findsOneWidget);
  });
}
