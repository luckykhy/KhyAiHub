import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/screens/console_screen.dart';

/// 控制台面板的交互测试。
///
/// 重点是「上下键翻历史」：这个功能此前零验证，而且它有一个不容易看出来的
/// 失效方式——Flutter 的按键事件从内往外冒泡，TextField 内部的 Shortcuts
/// 会先消费掉方向键，包在外层的 Focus.onKeyEvent 可能整条链路都收不到。
/// 真机上表现是「按上下键没反应」，而没有任何报错。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// 用假数据喂 MethodChannel，让面板能在没有真机的情况下渲染出来。
  void mockChannel({
    List<Map<String, dynamic>>? history,
    List<Map<String, dynamic>>? favorites,
    List<Map<String, dynamic>>? tools,
  }) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('com.khyos.khy_os_client/device'), (call) async {
      switch (call.method) {
        case 'consoleTools':
          return <String, dynamic>{'tools': tools ?? const []};
        case 'consoleHistory':
          return <String, dynamic>{
            'entries': history ?? const [],
            'path': '/sdcard/bridge-amoobridge/console_history.jsonl',
            'shared': true,
          };
        case 'consoleFavorites':
          return <String, dynamic>{'items': favorites ?? const []};
        case 'consolePending':
          return <String, dynamic>{'command': '', 'pending': false};
        case 'consoleExec':
          return <String, dynamic>{
            'ok': true,
            'status': 'ok',
            'tool': 'ping',
            'raw': '{"tool":"ping"}',
          };
        default:
          return null;
      }
    });
  }

  /// [origin] 默认 manual：既有测试都走手动路径。验收标准 4 要求 Amoo 与手动
  /// 「显示格式、记录方式完全一致」，所以这个参数必须能改——否则那一层永远是
  /// 零覆盖，而 JVM 只能证「记录字段相同」，证不了 Dart 把两条记录渲染成
  /// 同样的东西。
  Map<String, dynamic> record(String tool, String raw, String status,
          {String origin = 'manual'}) =>
      <String, dynamic>{
        'id': 'c-$tool',
        'ts': 1700000000000,
        'origin': origin,
        'tool': tool,
        'raw': raw,
        'status': status,
        'error': status == 'ok' ? '' : '测试用错误',
        'hint': '',
        'needs_auth': '',
        'capability_note': '',
        'args': const <String, dynamic>{},
        'result': const <String, dynamic>{},
      };

  Widget wrap() => const ProviderScope(child: MaterialApp(home: ConsoleScreen()));

  testWidgets('空态：没有历史时显示引导，不显示空白', (tester) async {
    mockChannel();
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    expect(find.textContaining('这里输入一条 JSON 命令'), findsOneWidget);
    expect(find.text('看工具面板（点工具填模板）'), findsOneWidget);
  });

  testWidgets('输入区与执行按钮渲染出来', (tester) async {
    mockChannel();
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    expect(find.byType(TextField), findsOneWidget);
    expect(find.byIcon(Icons.play_arrow), findsOneWidget);
  });

  testWidgets('历史卡片按来源与状态区分', (tester) async {
    mockChannel(history: [
      record('exec', '{"tool":"exec","args":{"cmd":"zz"}}', 'exec_error'),
      record('battery', '{"tool":"battery"}', 'ok'),
    ]);
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    // 三类失败的标签必须各自出现，不能混成一个「失败」。
    expect(find.text('执行报错'), findsOneWidget);
    expect(find.text('成功'), findsOneWidget);
    expect(find.text('手动'), findsNWidgets(2));
    // 命令原文原样保留，否则记录无法复现。
    expect(find.textContaining('{"tool":"exec"'), findsOneWidget);
  });

  testWidgets('工具不可用时工具项置灰且点不动', (tester) async {
    mockChannel(tools: [
      <String, dynamic>{
        'name': 'ui_tap',
        'desc': '按坐标点击',
        'group': '界面',
        'required': <dynamic>[
          <dynamic>['x', 'number'],
          <dynamic>['y', 'number'],
        ],
        'optional': const <dynamic>[],
        'one_of': const <dynamic>[],
        'needs_a11y': true,
        'available': false,
      },
    ]);
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    // 未授权无障碍的横幅要出现，并说明只有 ui_*/shot 受影响。
    expect(find.textContaining('未授权无障碍'), findsOneWidget);
    expect(find.textContaining('其余能力不受影响'), findsOneWidget);
  });

  /// 令牌重置的回执对话框。
  ///
  /// 断言两件事：① 回执里只有新旧指纹（前 8 位），完整 32 位令牌一个字符都
  /// 不许出现——那份凭证只属于设备上的 token.txt；② 未落盘时把「PC 侧拿到的
  /// 还是旧值」说出口，而不是摆一个「已重置」就算完。
  testWidgets('重置令牌：确认后弹回执，只带新旧指纹', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('com.khyos.khy_os_client/device'), (call) async {
      switch (call.method) {
        case 'consoleTools':
          return <String, dynamic>{'tools': const []};
        case 'consoleHistory':
          return <String, dynamic>{'entries': const [], 'path': '/x', 'shared': true};
        case 'consoleFavorites':
          return <String, dynamic>{'items': const []};
        case 'consolePending':
          return <String, dynamic>{'command': '', 'pending': false};
        case 'consoleResetToken':
          return <String, dynamic>{
            'ok': true,
            'reset': true,
            'old_fingerprint': '5500fae8',
            'old_fp_at': 1700000000000,
            'old_age_ms': 60000,
            'new_fingerprint': '9c1d77aa',
            'new_fp_at': 1700000060000,
            'persisted': false,
            'error': '新令牌只在内存：写盘失败',
          };
        default:
          return null;
      }
    });
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.vpn_key_outlined));
    await tester.pumpAndSettle();
    // 先确认再动手：这一按会让 PC 手里的 token.txt 作废。
    expect(find.text('重置访问令牌'), findsOneWidget);
    await tester.tap(find.text('重置'));
    await tester.pumpAndSettle();

    expect(find.text('令牌已重置'), findsOneWidget);
    expect(find.textContaining('旧令牌 5500fae8'), findsOneWidget);
    expect(find.textContaining('新令牌 9c1d77aa'), findsOneWidget);
    // 完整令牌绝不入屏：这两个指纹之外不该出现第 9 个十六进制字符。
    expect(find.textContaining('5500fae8db41cd054f45ea8834198d30'), findsNothing);
    // 未落盘必须说出口，不能只报「已重置」。
    expect(find.textContaining('只在手机内存里'), findsOneWidget);

    await tester.tap(find.text('知道了'));
    await tester.pumpAndSettle();
    expect(find.text('令牌已重置'), findsNothing);
  });

  testWidgets('共享存储失效时给出提示', (tester) async {    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('com.khyos.khy_os_client/device'), (call) async {
      if (call.method == 'consoleHistory') {
        return <String, dynamic>{
          'entries': const [],
          'path': '/data/user/0/com.khyos.khy_os_client/files/console',
          'shared': false,
        };
      }
      if (call.method == 'consoleTools') return <String, dynamic>{'tools': const []};
      if (call.method == 'consoleFavorites') return <String, dynamic>{'items': const []};
      if (call.method == 'consolePending') {
        return <String, dynamic>{'command': '', 'pending': false};
      }
      return null;
    });
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    // 前提不成立必须说出来，不能让用户以为 Amoo 也看得到。
    expect(find.textContaining('未使用共享存储'), findsOneWidget);
    expect(find.textContaining('Amoo 侧读不到'), findsOneWidget);
  });

  testWidgets('常用指令 chip 点击后填入输入框', (tester) async {
    mockChannel(favorites: [
      <String, dynamic>{
        'id': 'f-1',
        'label': '看电量',
        'json': '{"tool":"battery"}',
        'tool': 'battery',
      },
    ]);
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    await tester.tap(find.text('看电量'));
    await tester.pumpAndSettle();

    expect(find.text('{"tool":"battery"}'), findsOneWidget);
  });

  /// 这一条是重点：上下键翻历史。
  ///
  /// 真机上如果按键被 TextField 内部的 Shortcuts 先吃掉，这里就会失败——
  /// 而失败信息会直接说明「按上键后输入框内容没变」。
  testWidgets('按上键翻出上一条命令', (tester) async {
    mockChannel(history: [
      record('battery', '{"tool":"battery"}', 'ok'),
      record('info', '{"tool":"info"}', 'ok'),
    ]);
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    // 先聚焦输入框，否则按键没有去处。
    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pumpAndSettle();

    // 历史是新→旧排的，翻页方向是旧→新，所以第一按应该拿到较早那条。
    final text = tester.widget<TextField>(find.byType(TextField)).controller?.text;
    expect(text, isNotNull);
    expect(text, isNotEmpty,
        reason: '按上键应该把上一条命令填进输入框；空说明按键没到达处理逻辑');
    expect(text, anyOf('{"tool":"battery"}', '{"tool":"info"}'));
  });

  /// 上下键翻历史的完整语义：↑ 逐条往前（更早），↓ 逐条往后（更晚），
  /// 到边界必须停下。
  ///
  /// 上面那条只按了一次上键，证的是「按键到得了处理逻辑」。这里补三件它没证的：
  ///   ① 连续按上键要一条一条往前走，不是每次都给同一条；
  ///   ② 下键要能往回走——`_historyIndex < 0` 那个早退分支写反了不会有人发现；
  ///   ③ 翻到最旧一条后继续按上键必须**什么都不做**。这一条最关键：
  ///      `_sentCommands[next]` 越界会抛异常，而 Focus.onKeyEvent 里抛异常
  ///      会让输入区整个失灵——真机现象是「按上键没反应了」，且不报错。
  testWidgets('上下键逐条翻历史，到底后停下', (tester) async {
    mockChannel(history: [
      record('battery', '{"tool":"battery"}', 'ok'),
      record('info', '{"tool":"info"}', 'ok'),
      record('ls', '{"tool":"ls"}', 'ok'),
    ]);
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();

    String current() =>
        tester.widget<TextField>(find.byType(TextField)).controller?.text ?? '';

    // 起点：输入框是空的（没有正在编辑的内容）。
    expect(current(), isEmpty);

    // ① 按上键三次，应该依次拿到三条历史。历史是「新的在前」，
    // 所以顺序是 ls → info → battery。
    final walked = <String>[];
    for (var i = 0; i < 3; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.pumpAndSettle();
      walked.add(current());
    }
    expect(walked, ['{"tool":"ls"}', '{"tool":"info"}', '{"tool":"battery"}'],
        reason: '按上键必须逐条往前翻，且顺序与历史一致');

    // ③ 已经到最旧一条，再按必须原地不动——不能崩，也不能绕回最新。
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pumpAndSettle();
    expect(current(), '{"tool":"battery"}',
        reason: '翻到最旧一条后继续按上键必须保持原样');

    // ② 按下键往回走，最后回到空（「当前正在编辑」这一格）。
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pumpAndSettle();
    expect(current(), '{"tool":"info"}');
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pumpAndSettle();
    expect(current(), '{"tool":"ls"}');
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pumpAndSettle();
    expect(current(), isEmpty, reason: '再往上一格是「当前编辑」，应该是空');

    // 已经在最新一格，继续按下键也必须停下。
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pumpAndSettle();
    expect(current(), isEmpty);

    // 全程输入区仍然活着：还能正常打字，说明没有异常把 Focus 弄坏。
    await tester.enterText(find.byType(TextField), '{"tool":"ping"}');
    await tester.pumpAndSettle();
    expect(current(), '{"tool":"ping"}');
  });

  /// 护栏：没有在翻历史时，方向键必须留给 TextField 自己移动光标。
  ///
  /// 上面那条修掉了「翻历史时被光标条件挡住一半按键」的问题，解法是
  /// `_historyIndex >= 0` 时全盘接管。这条测试守着另一个方向：**没在翻历史时
  /// 不能过度接管**——否则用户在一段长命令中间按上键想挪光标，却莫名其妙
  /// 被换成了一条历史命令。原设计的存在理由就是这个，改实现时不能把它弄丢。
  ///
  /// 只断言「不翻」这一侧：另一侧（光标在末尾时该翻）已经由
  /// `按上键翻出上一条命令` 与 `上下键逐条翻历史，到底后停下` 覆盖，且那一侧
  /// 在测试环境里要手工同步 controller.selection 与焦点，不可靠。
  testWidgets('光标在中间时按上键不翻历史，交给 TextField 挪光标', (tester) async {
    mockChannel(history: [
      record('battery', '{"tool":"battery"}', 'ok'),
      record('info', '{"tool":"info"}', 'ok'),
    ]);
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();

    // 打一段长命令，把光标放到中间。
    const typed = '{"tool":"ls","args":{"path":"/x"}}';
    await tester.enterText(find.byType(TextField), typed);
    await tester.pumpAndSettle();
    final field = tester.widget<TextField>(find.byType(TextField));
    field.controller?.selection = const TextSelection.collapsed(offset: 8);
    await tester.pumpAndSettle();

    // 按上键：内容必须原样不动（不能换成历史里的命令）。
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(find.byType(TextField)).controller?.text,
        typed,
        reason: '光标不在开头时按上键必须留给 TextField，不能翻历史');
  });

  /// 验收标准 4：Amoo 产出的命令与手动输入的命令，显示格式、记录方式完全一致。
  ///
  /// JVM 侧已经证了两边**记录字段**相同（仅 origin 一栏不同），但那是原生层。
  /// 用户最终看到的是 Dart 渲染出来的卡片，而 Dart 这一层此前零覆盖——
  /// `record()` 助手的 origin 一直是硬编码的 'manual'，8 个 widget 测试全部
  /// 只跑手动路径。一条记录字段相同、却被渲染成两种样子的回归，JVM 抓不到。
  ///
  /// 判据不用整棵 widget 树序列化：`tester.allWidgets` 只覆盖当前挂载的
  /// widget，而历史卡片在 ListView 里，加上一次 pumpWidget 的过渡动画会残留
  /// （第一版正是因此拿到了 ScaleTransition/RotationTransition 而不是卡片），
  /// 那样的比较毫无意义。改为逐项断言两边都渲染出了同样的内容与控件。
  testWidgets('Amoo 与手动的命令卡片渲染结构一致', (tester) async {
    // 同一命令、同一状态、同一错误文案，只有 origin 不同。
    const cmd = '{"tool":"ls","args":{"path":"/no_such_dir_xyz"}}';

    // 分别渲染，避免两条记录同屏时互相干扰（也避免懒加载只画第一条）。
    //
    // 每次必须换一个 key：ConsoleScreen 是 StatefulWidget，同一棵树上重复
    // pumpWidget 不会重跑 initState，历史也就不会被重新加载——第二次换 origin
    // 后界面还是第一次那一条。第一版正是因此没找到 Amoo 徽标。
    Future<void> renderOne(String origin, String tag) async {
      mockChannel(history: [
        record('ls', cmd, 'exec_error', origin: origin),
      ]);
      await tester.pumpWidget(ProviderScope(
        key: ValueKey(tag),
        child: const MaterialApp(home: ConsoleScreen()),
      ));
      await tester.pumpAndSettle();
    }

    // ── manual ──
    // 每一轮渲染后**立刻**断言。写在一轮的断言不能留到下一轮之后：pumpWidget
    // 会整棵替换 widget 树，第二次渲染后第一次那棵已经不在了，那时再找
    // 「手动」只能找到 0 个。（第一版正是如此，报错信息却看不出这个原因。）
    await renderOne('manual', 'm');
    expect(find.textContaining(cmd), findsOneWidget,
        reason: '手动命令的原文必须原样显示');
    expect(find.textContaining('执行报错'), findsWidgets);
    expect(find.textContaining('测试用错误'), findsWidgets);
    expect(find.byIcon(Icons.code), findsOneWidget);
    expect(find.text('手动'), findsOneWidget, reason: '手动徽标只能有一个');

    // ── amoo ──
    await renderOne('amoo', 'a');
    expect(find.textContaining(cmd), findsOneWidget,
        reason: 'Amoo 命令的原文必须原样显示');
    expect(find.textContaining('执行报错'), findsWidgets);
    expect(find.textContaining('测试用错误'), findsWidgets);
    expect(find.byIcon(Icons.code), findsOneWidget);
    expect(find.text('Amoo'), findsOneWidget, reason: 'Amoo 徽标只能有一个');

    // 到这里两轮都跑过了：同样的命令、同样的状态、同样的错误文案、同样的
    // raw 视图入口、同样的卡片结构，都各自恰好渲染出一份。唯一差别是徽标上
    // 那两个汉字/那个名字——那是任务要求能区分两条路而有意保留的元数据，
    // 不是格式差异（见 VERIFICATION.md 第六节的界定）。
  });

  /// 「可一键切到 raw JSON」——目标第二块的原话要求。
  ///
  /// WHY THIS TEST EXISTS. 上面那条用例只断言了 raw 视图的**入口图标存在**
  /// （`find.byIcon(Icons.code)`），没有任何测试**点它**并验证视图真的换了。
  /// 一个只渲染图标、`onPressed` 却是空实现（或 setState 写错字段）的界面，
  /// 在那条用例下是全绿的。图标存在不等于功能存在。
  testWidgets('raw JSON 一键切换：图标翻转、JSON 摊开、再点回到格式化', (tester) async {
    const cmd = '{"tool":"exec","args":{"cmd":"zz_no_such_cmd_xyz"}}';
    mockChannel(history: [
      <String, dynamic>{
        ...record('exec', cmd, 'exec_error'),
        // 给一份非空 result，格式化视图才有可分辨的内容（_execResult 分支）。
        'result': <String, dynamic>{
          'out': '',
          'err': 'zz_no_such_cmd_xyz: not found',
          'exit': 127,
          'via': 'app',
        },
      },
    ]);
    await tester.pumpWidget(wrap());
    await tester.pumpAndSettle();

    // ── 默认：格式化视图 ──
    expect(find.byIcon(Icons.code), findsOneWidget,
        reason: '默认必须是「切到 raw」的图标');
    expect(find.textContaining('执行报错'), findsWidgets);
    expect(find.textContaining('退出码'), findsWidgets,
        reason: '格式化视图把 exec 结果按字段分块');
    expect(find.textContaining('"capability_note"'), findsNothing,
        reason: '格式化视图不该把 JSON 字段名摊给用户看');

    // ── 点一下：raw 视图 ──
    await tester.tap(find.byIcon(Icons.code));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.list_alt), findsOneWidget,
        reason: '切到 raw 后图标必须翻转成「切回格式化」');
    expect(find.textContaining('"capability_note"'), findsWidgets,
        reason: 'raw 视图必须把整条记录按 JSON 摊开（该字段只在 JSON 里出现）');
    expect(find.textContaining('exec_error'), findsWidgets);

    // ── 再点一下：回到格式化视图 ──
    await tester.tap(find.byIcon(Icons.list_alt));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.code), findsOneWidget,
        reason: '再点一次必须回到格式化视图');
    expect(find.textContaining('"capability_note"'), findsNothing);
    expect(find.textContaining('退出码'), findsWidgets,
        reason: '回到格式化后分块视图必须恢复');
  });
}
