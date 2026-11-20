// 底部提示面板的 widget 测试：冷却期、通知权限前置、以及两个按钮的行为。
//
// 这层是"非阻断式"承诺的落点：它必须在该弹的时候弹、不该弹的时候安静，
// 且不能因为提示失败把 App 启动带崩。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/battery_guard.dart';
import 'package:khy_os_client/ui/widgets/battery_prompt_sheet.dart';

const _channel = MethodChannel('com.khyos.khy_os_client/device');

/// 记录原生侧被调了哪些方法。
class _NativeSpy {
  final List<String> calls = <String>[];
  bool shouldPrompt = true;
  bool notificationsGranted = false;

  Map<Object?, Object?> get status => <Object?, Object?>{
        // 原生侧把厂商名归一成了小写（normalizeManufacturer），这里照抄，
        // 免得测试里的期望值和真机上的实际文案对不上。
        'manufacturer': 'stepx',
        'isIgnoringBatteryOptimizations': false,
        'isBackgroundRestricted': false,
        'autostartState': 'unknown',
        'restrictedSettingsLikely': false,
        'lastCheckAt': 1700000000000,
        'hasActionable': true,
      };
}

/// 宿主：挂载后立刻调用 maybeShow。
class _Host extends StatefulWidget {
  const _Host();

  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      await BatteryPromptSheet.maybeShow(context);
    });
  }

  @override
  Widget build(BuildContext context) => const Scaffold(body: Center(child: Text('host')));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _NativeSpy spy;

  setUp(() {
    spy = _NativeSpy();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (MethodCall call) async {
      spy.calls.add(call.method);
      switch (call.method) {
        case 'batteryPromptState':
          return {
            'shouldPrompt': spy.shouldPrompt,
            'dismissedAt': 0,
            'completed': false,
            'cooldownDays': 7,
            'nextPromptAt': 0,
            'status': spy.status,
          };
        case 'checkPermissions':
          return {
            'notifications': spy.notificationsGranted,
            'overlay': true,
            'accessibility': true,
          };
        case 'requestNotifications':
        case 'dismissBatteryPrompt':
        case 'completeBatteryPrompt':
        case 'clearBatteryPromptRecord':
          return {'ok': true};
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

  testWidgets('该弹的时候弹：说明里写清为什么要设，并给出机型', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Host()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('电池优化可能会让 khy-os 掉线'), findsOneWidget);
    // 文案要讲清"不设会怎样"，而不是只说"请去设置"。（正文与缺项清单里
    // 各出现一次，所以这里是"至少有一个"而不是"恰好一个"。）
    expect(find.textContaining('冻结'), findsWidgets);
    expect(find.textContaining('当前机型：stepx'), findsOneWidget);
    expect(find.text('以后再说'), findsOneWidget);
    expect(find.text('去看怎么设'), findsOneWidget);
  });

  testWidgets('通知权限没给时，先请求权限再展示面板', (tester) async {
    spy.notificationsGranted = false;
    await tester.pumpWidget(const MaterialApp(home: _Host()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(spy.calls.contains('requestNotifications'), isTrue);
    // 顺序：先查权限、缺了才请求，请求发生在面板展示之前。
    expect(spy.calls.indexOf('requestNotifications'),
        greaterThan(spy.calls.indexOf('checkPermissions')));
    expect(find.text('电池优化可能会让 khy-os 掉线'), findsOneWidget);
  });

  testWidgets('通知权限已给时，不再打扰用户要权限', (tester) async {
    spy.notificationsGranted = true;
    await tester.pumpWidget(const MaterialApp(home: _Host()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(spy.calls.contains('requestNotifications'), isFalse);
    expect(find.text('电池优化可能会让 khy-os 掉线'), findsOneWidget);
  });

  testWidgets('冷却期内（或已走完引导）不弹', (tester) async {
    spy.shouldPrompt = false;
    await tester.pumpWidget(const MaterialApp(home: _Host()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('电池优化可能会让 khy-os 掉线'), findsNothing);
    expect(spy.calls.contains('requestNotifications'), isFalse);
  });

  testWidgets('点「以后再说」记下冷却（7 天内不再自动弹）', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Host()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.text('以后再说'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(spy.calls.contains('dismissBatteryPrompt'), isTrue);
    expect(find.text('电池优化可能会让 khy-os 掉线'), findsNothing);
  });

  testWidgets('点「去看怎么设」进引导页', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Host()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.text('去看怎么设'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(spy.calls.contains('dismissBatteryPrompt'), isTrue);
    expect(find.text('电池与后台运行'), findsOneWidget);
  });
}
