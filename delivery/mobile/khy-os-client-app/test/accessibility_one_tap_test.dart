import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/device_control.dart';
import 'package:khy_os_client/ui/screens/settings_screen_new.dart';

/// 无障碍一键开关的行为护栏。
///
/// 这条链路是 2026-10-26 按用户要求加的：原来两个方向都只是跳系统设置，
/// 在 StepOS（MIUI 派生）上会落到「辅助功能」hub，用户每次都要
/// 辅助功能 → 无障碍 → 滚动 → 找 khy-os → 拨开关。
///
/// 现在开的那一下由本机 uid 2000 直接写 Settings.Secure。**这意味着 App
/// 拿到了安卓故意不给它的那个键**，所以 UI 侧有三条不能退让的性质，
/// 这个套件就是钉它们的：
///
///   1. 开之前必须弹确认框，并且框里要说清「写什么、去哪里撤销」；
///   2. 取消就不准动笔——一次误触不该把屏幕读取权交出去；
///   3. 写失败时把原因原样摆出来，并给一条去系统设置的路，
///      而不是静默失败让用户对着没动的开关猜。
///
/// 关的那一侧不需要确认（它在收缩能力），但必须真的去写，
/// 不能像以前那样也只会跳系统设置。
void main() {
  const channel = MethodChannel('com.khyos.khy_os_client/device');

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'enableAccessibility':
          return <String, Object?>{
            'ok': true, 'via': 'sidecar', 'already': false, 'reason': '',
          };
        case 'disableAccessibility':
          return <String, Object?>{
            'ok': true, 'via': 'sidecar', 'already': false, 'reason': '',
          };
        case 'accessibilitySetupAdvice':
          return <String, Object?>{'advice': '一键可用（sidecar 已就绪）'};
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  /// 记录真实走到了原生侧的调用，用来区分「弹了框」和「真的动笔了」。
  List<String> nativeCalls() {
    final log = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      log.add(call.method);
      switch (call.method) {
        case 'enableAccessibility':
          return <String, Object?>{
            'ok': true, 'via': 'sidecar', 'already': false, 'reason': '',
          };
        case 'disableAccessibility':
          return <String, Object?>{
            'ok': true, 'via': 'sidecar', 'already': false, 'reason': '',
          };
        case 'accessibilitySetupAdvice':
          return <String, Object?>{'advice': '一键可用（sidecar 已就绪）'};
        default:
          return null;
      }
    });
    return log;
  }

  Widget host() => const MaterialApp(home: SettingsScreenNew());

  /// 无障碍那个开关，按 key 点名而不是按位置。
  ///
  /// 原来这里写的是 `find.byType(Switch).first`，当时成立是因为「系统能力」区
  /// 是页面上唯一放开关的地方。后来「入口」区加了一个 PROCESS_TEXT 开关，排在
  /// 它上面——第一个 Switch 就换了人，而这套测试有五条挂在"点错开关"上，
  /// 失败信息是"找不到开启无障碍服务按钮"，指向完全错误的方向。
  ///
  /// 第二版试过按标签定位（`find.ancestor(of: find.text('无障碍服务'),
  /// matching: Row).first` 再取其内的 Switch），不行：`find.ancestor` 在这一页
  /// 上取到的 Row 不一定包含那个 Switch，报的是 `Bad state: No element`，
  /// 完全指不到真正的原因。所以最终用显式 key——要哪个就说哪个。
  Finder a11ySwitch() => find.byKey(const Key('a11y-switch'));

  /// 滚到无障碍那个开关真正出现在树里为止。
  ///
  /// 判据是 `a11ySwitch()` 而不是「页面上有没有 Switch」——后者在「入口」区加了
  /// 一个 PROCESS_TEXT 开关之后就不成立了：循环会停在那一个上，而无障碍那个还在
  /// 更下面没建出来，接着 ensureVisible 报 `Bad state: No element`，指向的却是
  /// 「找不到元素」而不是「滚得不够」。要什么就滚到什么。
  ///
  /// 为什么手写循环而不用 `scrollUntilVisible`：这个版本的 `dragUntilVisible`
  /// 在 finder 为空时会走 `Iterable.isEmpty`，而 finder 的 evaluate() 是懒迭代器，
  /// 空列表上 `.first` 直接抛 StateError——还没开始拖就炸了。
  Future<void> openCapabilities(WidgetTester tester) async {
    await tester.pumpWidget(host());
    await tester.pumpAndSettle();
    for (var i = 0; i < 40 && !tester.any(a11ySwitch()); i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -350));
      await tester.pumpAndSettle();
    }
    expect(tester.any(a11ySwitch()), isTrue,
        reason: '滚了 40 次还没见到无障碍开关，说明「系统能力」区没渲染出来');
    await tester.ensureVisible(a11ySwitch());
    await tester.pumpAndSettle();
  }

  testWidgets('开启前先弹确认框，且框里说清写什么、去哪里撤销', (tester) async {
    await openCapabilities(tester);

    await tester.tap(a11ySwitch());
    await tester.pumpAndSettle();

    expect(find.text('开启无障碍服务'), findsOneWidget,
        reason: '没有确认框就等于一次误触就能交出屏幕读取权');
    // 框里必须出现这三样：要写什么、能力是什么、怎么撤销。
    expect(find.textContaining('写一条系统设置'), findsOneWidget);
    expect(find.textContaining('读取屏幕内容'), findsOneWidget);
    expect(find.textContaining('系统设置'), findsWidgets);

    // 第四条，2026-10-27 加：开了无障碍也就等于同意「下次更新/重装后
    // 自动恢复它」（原生侧两者共用同一个 SharedPreferences 键）。那是一个
    // 用户没要求就发生的后果，所以必须在这个框里说清，并指出在哪里关掉。
    // 少了这句，用户会在某次更新后发现权限自己回来了而不知道是谁干的。
    //
    // 用「不想要这个行为」而不是开关标题来定位：标题在背后的设置页里也有
    // 一份，对话框开着的时候两者同时在树里，findsOneWidget 会误判为重复。
    expect(find.textContaining('更新或重装'), findsOneWidget,
        reason: '确认框没说开启会自动带出「重装后恢复」这个后果');
    expect(find.textContaining('不想要这个行为'), findsOneWidget,
        reason: '说了后果却没告诉用户去哪里关，等于没有退路');
  });

  testWidgets('取消确认框：不碰原生侧，开关不动', (tester) async {
    final log = nativeCalls();
    await openCapabilities(tester);

    await tester.tap(a11ySwitch());
    await tester.pumpAndSettle();
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();

    // 注意判据不是「一次原生调用都没有」：取消后 _refreshCapabilities 照例
    // 要回读一次真实状态，那是应该发生的。要紧的是**没有动笔**。
    expect(log, isNot(contains('enableAccessibility')),
        reason: '取消之后还去写，这个确认框就是装饰');
    expect(log, isNot(contains('disableAccessibility')));
  });

  testWidgets('确认之后才动笔，且写的是 enable', (tester) async {
    final log = nativeCalls();
    await openCapabilities(tester);

    await tester.tap(a11ySwitch());
    await tester.pumpAndSettle();
    await tester.tap(find.text('开启'));
    await tester.pumpAndSettle();

    expect(log, contains('enableAccessibility'));
    expect(log, isNot(contains('openAccessibilitySettings')),
        reason: '一键成功时不该再跳系统设置，那等于功能没生效');
  });

  testWidgets('关闭方向不弹框，直接写 disable', (tester) async {
    final log = nativeCalls();
    // 关键：必须在**第一次** pumpWidget 之前就把 isAccessibilityReady 设成
    // true。`pumpWidget` 用同配置的 widget 是原地更新、不会重跑 initState，
    // 所以「先建起来再改 mock 再重泵」这一步是无效的—— State 早就建好了。
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      log.add(call.method);
      switch (call.method) {
        case 'isAccessibilityReady':
          return <String, Object?>{'ready': true};
        case 'disableAccessibility':
          return <String, Object?>{
            'ok': true, 'via': 'sidecar', 'already': false, 'reason': '',
          };
        case 'accessibilitySetupAdvice':
          return <String, Object?>{'advice': '一键可用（sidecar 已就绪）'};
        default:
          return null;
      }
    });

    await openCapabilities(tester);

    await tester.tap(a11ySwitch());
    await tester.pumpAndSettle();

    expect(find.text('开启无障碍服务'), findsNothing,
        reason: '关是收缩能力，没有再确认一遍的必要');
    expect(log, contains('disableAccessibility'));
    expect(log, isNot(contains('enableAccessibility')));
  });

  testWidgets('提示行只说要求与退路，不做预测', (tester) async {
    // 第一版拿 ShellSidecarClient.ready() 预测「一键可用/不可用」，真机上被抓到
    // 撒谎：那个标志只在真跑过一次 exec 后才翻真，冷启动恒 false——提示说
    // 「一键不可用」，而同一次点击其实成功了。错的预测比没有预测更糟：
    // 它把用户支去配一条他已经有的通道。
    // 所以现在只有 Shizuku 连上了才允许承诺，其余一律只说要求和退路。
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'accessibilitySetupAdvice') {
        return <String, Object?>{
          'advice': '一键需要 sidecar（adb 提权）或 Shizuku；未就绪时点开关会改为打开系统设置',
        };
      }
      return null;
    });

    await openCapabilities(tester);

    expect(find.textContaining('一键需要'), findsOneWidget);
    expect(find.textContaining('未就绪时点开关会改为打开系统设置'), findsOneWidget);
    // 关键：不许出现「一键不可用」这种定论。
    expect(find.textContaining('一键不可用'), findsNothing,
        reason: '那是预测，而预测已经被实测证明会撒谎');
  });

  testWidgets('Shizuku 连上时才承诺一键可用', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'accessibilitySetupAdvice') {
        return <String, Object?>{'advice': '一键可用（Shizuku 已就绪）'};
      }
      return null;
    });

    await openCapabilities(tester);

    expect(find.textContaining('一键可用'), findsOneWidget);
  });

  testWidgets('写失败：原样摆出原因，并给一条去系统设置的路', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'enableAccessibility') {
        return <String, Object?>{
          'ok': false,
          'via': '',
          'already': false,
          'reason': '无提权通道',
        };
      }
      if (call.method == 'accessibilitySetupAdvice') {
        return <String, Object?>{'advice': '一键可用（sidecar 已就绪）'};
      }
      return null;
    });

    await openCapabilities(tester);
    await tester.tap(a11ySwitch());
    await tester.pumpAndSettle();
    await tester.tap(find.text('开启'));
    await tester.pumpAndSettle();

    expect(find.text('无提权通道'), findsOneWidget,
        reason: '把失败说成成功，比失败本身更糟');
    expect(find.text('去系统设置'), findsOneWidget,
        reason: '一键走不通时必须留一条手动路');
  });

  test('AccessibilitySetupResult 的三种结局互不混淆', () {
    const ok = AccessibilitySetupResult(
        ok: true, via: 'sidecar', already: false, reason: '');
    const already = AccessibilitySetupResult(
        ok: true, via: 'sidecar', already: true, reason: '');
    const bad = AccessibilitySetupResult(
        ok: false, via: '', already: false, reason: '无提权通道');

    expect(ok.message, '已通过 sidecar 写入');
    expect(already.message, '已经是这个状态了');
    expect(bad.message, '无提权通道');
    // already=true 绝不能算成「这次写成功了」——UI 要靠它区分要不要提示。
    expect(ok.already, isFalse);
    expect(already.ok, isTrue);
  });

  // 单独一组：见下面 a11yAutoRestoreGuards 的说明。
  a11yAutoRestoreGuards();
}

/// 「重装后自动恢复无障碍」这个开关自己的护栏。
///
/// WHY A SEPARATE GROUP. Enabling accessibility and agreeing to have it restored
/// after an update are the same stored key on the native side, but they are not
/// the same decision, and the UI has to make that visible rather than letting
/// one silently imply the other. These tests pin the part the dialog test above
/// cannot: that the switch exists on its own, defaults to off, and says what it
/// changes instead of restating its name.
void a11yAutoRestoreGuards() {
  const channel = MethodChannel('com.khyos.khy_os_client/device');

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'isA11yAutoRestoreOn':
          return <String, Object?>{'on': false};
        case 'setA11yAutoRestore':
          return <String, Object?>{'ok': true};
        case 'accessibilitySetupAdvice':
          return <String, Object?>{'advice': '一键需要 sidecar 或 Shizuku'};
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  Finder restoreSwitch() => find.byKey(const Key('a11y-auto-restore-switch'));

  Future<void> openCapabilities(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: SettingsScreenNew()));
    await tester.pumpAndSettle();
    for (var i = 0; i < 40 && !tester.any(restoreSwitch()); i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -350));
      await tester.pumpAndSettle();
    }
    expect(tester.any(restoreSwitch()), isTrue,
        reason: '滚了 40 次还没见到「重装后自动恢复」开关');
    await tester.ensureVisible(restoreSwitch());
    await tester.pumpAndSettle();
  }

  testWidgets('开关存在且默认关', (tester) async {
    // 默认必须是关。默认开等于每个新装用户都被预设同意「更新后自己把读屏幕
    // 权限开回来」，而他们还没见过这个开关。
    await openCapabilities(tester);
    expect(tester.widget<Switch>(restoreSwitch()).value, isFalse);
  });

  testWidgets('副标题说的是后果，不是把名字又说一遍', (tester) async {
    await openCapabilities(tester);
    // 关的时候要说清「关了会怎样」——那是用户做这个决定真正需要的信息。
    expect(find.textContaining('需要自己再开一次'), findsOneWidget);
  });

  testWidgets('点开会写原生侧，并把结果读回来', (tester) async {
    var stored = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'isA11yAutoRestoreOn':
          return <String, Object?>{'on': stored};
        case 'setA11yAutoRestore':
          stored = call.arguments is Map &&
              (call.arguments as Map)['on'] == true;
          return <String, Object?>{'ok': true};
        case 'accessibilitySetupAdvice':
          return <String, Object?>{'advice': '一键需要 sidecar 或 Shizuku'};
        default:
          return null;
      }
    });

    await openCapabilities(tester);
    await tester.tap(restoreSwitch());
    await tester.pumpAndSettle();

    expect(stored, isTrue, reason: '点了开关却没写到原生侧，UI 就是在撒谎');
    // 写成功后才翻成 on：先翻再写会让一次失败的写入留下一个「已开」的开关。
    expect(tester.widget<Switch>(restoreSwitch()).value, isTrue);
    expect(find.textContaining('已开'), findsWidgets);
  });
}
