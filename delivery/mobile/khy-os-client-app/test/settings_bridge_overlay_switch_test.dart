import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/screens/settings_screen_new.dart';

/// 手机桥与工作悬浮框两个真开关的护栏。
///
/// WHY THIS FILE EXISTS. 这两行原来是卡里两个 ListTile + 行尾一个「启动/停止」
/// 胶囊，点了之后静默发一条命令、再静默刷新——成败都看不出来。现在它们是
/// `_entrySwitch`，于是有四条性质必须钉住：
///
///   1. value 只能来自 `bridgeStatus` 的事实（online / overlayRunning），
///      不能本地猜：一个和现实相反的开关比没有开关更糟；
///   2. 悬浮框未授权时开关必须是关、且必须有一条去授权的路——
///      否则用户对着一个点了没反应的开关按十次；
///   3. 未授权时点开关走的是 requestOverlay（引去系统设置页），
///      不是 overlayShow（起了服务也会被原生侧 stopSelf）；
///   4. busy 期间 Switch 连同 Key 一起从树上消失（`_entrySwitch` 的既有语义，
///      是 if/else 替换而不是 `onChanged: null`）。测试要钉住它而不是绕过它。
void main() {
  const channel = MethodChannel('com.khyos.khy_os_client/device');

  /// 装一个既记账又按方法名回包的 mock。
  ///
  /// 与 device_control_bridge_overlay_test.dart 里的同名 helper 同一个理由：
  /// `setMockMethodCallHandler` 是整体替换，分两次装会让记账那个被换掉。
  void install(
    Map<String, Object?> responses, {
    List<String>? log,
    Object? Function(String method)? fallback,
  }) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      log?.add(call.method);
      if (responses.containsKey(call.method)) return responses[call.method];
      return fallback?.call(call.method) ?? <Object?>{};
    });
  }

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  /// 在线 + 悬浮框在 + 授权齐：这是「一切都好」的那个快照。
  Map<String, Object?> healthyStatus() => <String, Object?>{
        'online': true,
        'port': 8787,
        'toolCount': 44,
        'overlayRunning': true,
        'overlayGranted': true,
        'allFiles': true,
        'uiReady': true,
      };

  Finder bridgeSwitch() => find.byKey(const Key('bridge-switch'));
  Finder overlaySwitch() => find.byKey(const Key('overlay-switch'));

  /// 滚到某个控件真正出现在树里为止，再 ensureVisible。
  ///
  /// 判据是要找的那个 finder 而不是「页面上有没有 Switch」：本页有四个开关，
  /// 按存在性判断会停在第一个上，而目标还在更下面没建出来。见
  /// accessibility_one_tap_test.dart 里对同一件事的长注释。
  Future<void> reveal(WidgetTester tester, Finder f) async {
    for (var i = 0; i < 40 && !tester.any(f); i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -350));
      await tester.pumpAndSettle();
    }
    expect(tester.any(f), isTrue, reason: '滚了 40 次还没见到目标控件');
    await tester.ensureVisible(f);
    await tester.pumpAndSettle();
  }

  Future<void> pumpHost(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: SettingsScreenNew()));
    await tester.pumpAndSettle();
  }

  testWidgets('两个开关都在，value 与副标题都来自 bridgeStatus 的事实', (tester) async {
    install({'bridgeStatus': healthyStatus()});
    await pumpHost(tester);

    await reveal(tester, bridgeSwitch());
    expect(tester.widget<Switch>(bridgeSwitch()).value, isTrue,
        reason: 'online=true 时手机桥开关必须是开');
    expect(find.text('在线 · 端口 8787 · 44 个工具'), findsOneWidget);

    await reveal(tester, overlaySwitch());
    expect(tester.widget<Switch>(overlaySwitch()).value, isTrue,
        reason: 'overlayRunning=true 时悬浮框开关必须是开');
    expect(find.text('显示中（可拖拽，点按展开）'), findsOneWidget);
  });

  testWidgets('离线时手机桥开关是关的，副标题只说「离线」', (tester) async {
    install({
      'bridgeStatus': <String, Object?>{
        'online': false,
        'port': 0,
        'toolCount': 0,
        'overlayRunning': false,
        'overlayGranted': true,
        'allFiles': true,
        'uiReady': true,
      }
    });
    await pumpHost(tester);

    await reveal(tester, bridgeSwitch());
    expect(tester.widget<Switch>(bridgeSwitch()).value, isFalse);
    expect(find.text('离线'), findsOneWidget);
    // 离线时不能把端口和工具数摆出来——那是 0 和 0，读起来像故障。
    expect(find.textContaining('端口'), findsNothing);
  });

  testWidgets('未授权：悬浮框开关是关的，且有一条去授权的路', (tester) async {
    install({
      'bridgeStatus': <String, Object?>{
        'online': true,
        'port': 8787,
        'toolCount': 44,
        'overlayRunning': false,
        'overlayGranted': false,
        'allFiles': true,
        'uiReady': true,
      }
    });
    await pumpHost(tester);

    await reveal(tester, overlaySwitch());
    // 未授权时 overlayRunning 必然是 false（原生侧无权限即 stopSelf），
    // 所以开关天然显示关，不需要额外造一个「不可用」的第三态。
    expect(tester.widget<Switch>(overlaySwitch()).value, isFalse);
    expect(find.text('需要悬浮窗权限'), findsOneWidget);
    expect(find.text('悬浮窗权限'), findsOneWidget,
        reason: '原来挂在手机桥行尾的「去授权」分支随那一行提成开关消失了，'
            '这里必须补回来');
    expect(find.text('去系统设置页授予；授予后这里就能开关'), findsOneWidget);
  });

  testWidgets('未授权时点开关：引去授权页，不起服务', (tester) async {
    final log = <String>[];
    install({
      'bridgeStatus': <String, Object?>{
        'online': true,
        'port': 8787,
        'toolCount': 44,
        'overlayRunning': false,
        'overlayGranted': false,
        'allFiles': true,
        'uiReady': true,
      }
    }, log: log);
    await pumpHost(tester);

    await reveal(tester, overlaySwitch());
    await tester.tap(overlaySwitch());
    await tester.pumpAndSettle();

    expect(log, contains('requestOverlay'),
        reason: '没权限时点开关必须把用户引去系统设置页');
    expect(log, isNot(contains('overlayShow')),
        reason: '原生侧也会拒，但那一跳是异步的，用户看不到任何反馈；'
            '先引去授权才不会按十次没反应');
  });

  testWidgets('未授权时只有一条授权入口，不双重引导', (tester) async {
    install({
      'bridgeStatus': <String, Object?>{
        'online': true,
        'port': 8787,
        'toolCount': 44,
        'overlayRunning': false,
        'overlayGranted': false,
        // 另两个授权项都置成「已满足」，这一页就只剩悬浮窗权限一个待授权项。
        'allFiles': true,
        'uiReady': true,
      }
    });
    await pumpHost(tester);

    await reveal(tester, overlaySwitch());
    expect(find.text('悬浮窗权限'), findsOneWidget);
    // 「去授权」这三个字的胶囊是另一套入口；未授权时它不该再出现，
    // 否则同一个权限有两个按钮指向两个地方。
    expect(find.text('去授权'), findsNothing);
  });

  testWidgets('已授权时点开关：起/藏的是悬浮框，不动桥', (tester) async {
    final log = <String>[];
    install({
      'bridgeStatus': <String, Object?>{
        'online': true,
        'port': 8787,
        'toolCount': 44,
        'overlayRunning': false,
        'overlayGranted': true,
        'allFiles': true,
        'uiReady': true,
      }
    }, log: log);
    await pumpHost(tester);

    await reveal(tester, overlaySwitch());
    await tester.tap(overlaySwitch());
    await tester.pumpAndSettle();

    expect(log, contains('overlayShow'));
    // 显隐完成后再读一次状态：不读，开关就会停在用户刚拨的那一下，
    // 而原生侧可能没起来。
    expect(log.where((m) => m == 'bridgeStatus').length, greaterThan(1),
        reason: '操作完成后必须回填真实状态');
    // 关键：只动悬浮框，桥一个字节都没被碰。
    expect(log, isNot(contains('bridgeStart')));
    expect(log, isNot(contains('bridgeStop')));
  });

  testWidgets('卡内四行的顺序没被结构调整打乱', (tester) async {
    install({
      'bridgeStatus': <String, Object?>{
        'online': true,
        'port': 8787,
        'toolCount': 44,
        'overlayRunning': true,
        'overlayGranted': true,
        // 两个条件行都要出现，否则这条断言只覆盖到一半的卡。
        'allFiles': false,
        'uiReady': false,
      }
    });
    await pumpHost(tester);
    await reveal(tester, find.text('协作模式'));

    // 用「协作模式」向上找最近的 Material：那是 _card，页面上另有一个同名的
    // Scaffold Material，取错就会把整页的 ListTile 都算进来。
    final card = find
        .ancestor(of: find.text('协作模式'), matching: find.byType(Material))
        .first;
    final titles = tester
        .widgetList<ListTile>(
            find.descendant(of: card, matching: find.byType(ListTile)))
        .map((t) => (t.title as Text).data)
        .toList();
    expect(titles, <String?>['协作模式', '访问令牌', '所有文件访问', '无障碍服务'],
        reason: '手机桥与工作悬浮框提成开关后，卡内四行的相对顺序一个都不该动');
  });

  testWidgets('busy 期间 Switch 连同 Key 一起消失，不是被禁用', (tester) async {
    final pending = Completer<Object?>();
    install({
      'bridgeStatus': <String, Object?>{
        'online': false,
        'port': 0,
        'toolCount': 0,
        'overlayRunning': false,
        'overlayGranted': true,
        'allFiles': true,
        'uiReady': true,
      }
    }, fallback: (method) {
      // 只把 bridgeStart 挂住，让 busy 窗口停在半空中。
      if (method == 'bridgeStart') return pending.future;
      return <Object?>{};
    });
    await pumpHost(tester);

    await reveal(tester, bridgeSwitch());
    await tester.tap(bridgeSwitch());
    await tester.pump();

    expect(find.byKey(const Key('bridge-switch')), findsNothing,
        reason: 'busy 时 _entrySwitch 把 Switch 整棵摘掉（if/else 替换），'
            '连点就是被「控件消失」挡住的，不是被禁用态提示挡住的');
    // 摘掉的同时顶上了一个转圈，用户知道活儿在干。
    expect(find.byType(CircularProgressIndicator), findsWidgets);

    pending.complete(<String, Object?>{'started': true});
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('bridge-switch')), findsOneWidget,
        reason: '命令回来后开关必须回来，否则用户以为界面卡死了');
  });

  testWidgets('起桥失败：原因摆出来，开关回落', (tester) async {
    install({
      'bridgeStatus': <String, Object?>{
        'online': false,
        'port': 0,
        'toolCount': 0,
        'overlayRunning': false,
        'overlayGranted': true,
        'allFiles': true,
        'uiReady': true,
      }
    }, fallback: (method) {
      if (method == 'bridgeStart') {
        return <String, Object?>{'started': false, 'message': '前台服务起不来'};
      }
      return <Object?>{};
    });
    await pumpHost(tester);

    await reveal(tester, bridgeSwitch());
    await tester.tap(bridgeSwitch());
    await tester.pumpAndSettle();

    expect(find.text('前台服务起不来'), findsOneWidget,
        reason: '把失败说成成功，比失败本身更糟');
    expect(find.byKey(const Key('bridge-switch')), findsOneWidget,
        reason: '失败后 busy 必须回落，否则开关永远不回来');
    // 回落之后 value 仍读自 bridgeStatus（还是离线），不是停在用户刚拨的那一下。
    expect(tester.widget<Switch>(bridgeSwitch()).value, isFalse);
  });
}
