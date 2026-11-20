import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/console_service.dart';
import 'package:khy_os_client/ui/widgets/amoo_composer.dart';

/// JSON direct render: the chat entry runs a console command in place instead of
/// jumping to amoo.
///
/// The failure this guards is concrete: the amoo send panel used to hand ANY text
/// to `shareText`, so a JSON command pasted in from the chat box ended up on
/// amoo's share page. That command could have run on this phone in milliseconds,
/// and its result belonged back in the console history as a card — jumping to
/// amoo hands a locally-solvable job to an assistant that takes ~6 minutes and
/// needs the foreground the whole time.
///
/// [looksLikeConsoleCommand] mirrors the native AmooLoop.looksLikeCommand (which
/// asks KhyConsole.prepare whether it recognised a tool name). Both sides judge
/// once, not because a second judgement is wanted, but because the JUMP is
/// initiated here and the judgement has to happen before it.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// Records the native calls, so "was a share ever attempted" is assertable.
  final calls = <String>[];

  void mockChannel({Map<String, dynamic>? execResult}) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
            const MethodChannel('com.khyos.khy_os_client/device'), (call) async {
      calls.add(call.method);
      switch (call.method) {
        case 'amooStatus':
          return <String, dynamic>{
            'installed': true,
            'canShare': true,
            'canOpenChat': true,
            'versionName': '1.0',
          };
        case 'sendToAmoo':
          return <String, dynamic>{
            'ok': true,
            'via': 'direct',
            'message': 'handed to amoo share page (delivery unconfirmed)',
          };
        case 'consoleExec':
          return execResult ??
              <String, dynamic>{
                'ok': true,
                'id': 'c-1',
                'ts': 1700000000000,
                'origin': 'manual',
                'tool': 'battery',
                'raw': '{"tool":"battery"}',
                'status': 'ok',
                'error': '',
                'hint': '',
                'needs_auth': '',
                'capability_note': '',
                'args': const <String, dynamic>{},
                'result': const <String, dynamic>{'percent': 35},
              };
        default:
          return null;
      }
    });
  }

  setUp(() => calls.clear());

  // ---- the judgement ----

  group('looksLikeConsoleCommand', () {
    test('a command is recognised', () {
      expect(looksLikeConsoleCommand('{"tool":"ls","args":{"path":"/sdcard"}}'), isTrue);
      // Text pasted out of an input box almost always carries newlines.
      expect(looksLikeConsoleCommand('\n  {"tool":"ping"}\n'), isTrue);
    });

    test('prose is not', () {
      expect(looksLikeConsoleCommand('install this for me'), isFalse);
      expect(looksLikeConsoleCommand(''), isFalse);
      expect(looksLikeConsoleCommand('   '), isFalse);
    });

    test('JSON that is not a command is not', () {
      expect(looksLikeConsoleCommand('{"args":{}}'), isFalse);
      expect(looksLikeConsoleCommand('{"tool":42}'), isFalse);
      expect(looksLikeConsoleCommand('{"tool":""}'), isFalse);
      // Malformed: better to send it as prose than to execute half a command.
      expect(looksLikeConsoleCommand('{"tool":"ls"'), isFalse);
    });
  });

  // ---- panel routing ----

  /// The sheet's own title is also "share to amoo", so the button label has to
  /// be narrowed by widget type — a bare find.text hits two.
  String buttonLabel(WidgetTester tester) {
    final texts = tester.widgetList<Text>(find.descendant(
      of: find.byType(FilledButton),
      matching: find.byType(Text),
    ));
    return texts.isEmpty ? '' : texts.first.data ?? '';
  }

  Widget wrap() => MaterialApp(
        home: Builder(
          builder: (ctx) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => showAmooComposer(ctx, initialText: ''),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );

  /// Opens the sheet and types [text] into it.
  ///
  /// The pump after enterText is load-bearing: onPressed was fixed during the
  /// PREVIOUS build, and with empty text it is null. Tapping without a rebuild
  /// taps a disabled button — which is how the first version of this test
  /// silently verified nothing at all.
  Future<void> openWith(WidgetTester tester, String text) async {
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), text);
    await tester.pump();
  }

  testWidgets('command: button becomes local run, and no share is attempted',
      (tester) async {
    mockChannel();
    await tester.pumpWidget(wrap());
    await openWith(tester, '{"tool":"battery"}');

    // The button follows the route. One label for both and the user can only guess.
    expect(buttonLabel(tester), '在本机执行');
    expect(find.textContaining('识别为本地命令'), findsOneWidget);

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();

    // The load-bearing assertion: not one share was attempted.
    expect(calls.contains('sendToAmoo'), isFalse);
    expect(calls.contains('consoleExec'), isTrue);
    // And the result renders as a card: tool, status, and where the record went.
    expect(find.text('battery'), findsOneWidget);
    expect(find.textContaining('状态 ok'), findsOneWidget);
    expect(find.textContaining('完整记录见控制台历史'), findsOneWidget);
  });

  testWidgets('command: the input is not cleared, so a param can be edited and resent',
      (tester) async {
    mockChannel();
    await tester.pumpWidget(wrap());
    await openWith(tester, '{"tool":"battery"}');

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();

    // A result often means "change one parameter and run it again"; clearing the
    // original text would make the user retype it.
    expect(find.text('{"tool":"battery"}'), findsOneWidget);
  });

  testWidgets('a command that cannot run still says why', (tester) async {
    mockChannel(execResult: <String, dynamic>{
      'ok': false,
      'id': 'c-2',
      'ts': 1700000000000,
      'origin': 'manual',
      'tool': 'ui_tap',
      'raw': '{"tool":"ui_tap"}',
      'status': 'tool_unavailable',
      'error': '工具不可用：未授权无障碍服务，ui_tap 无法执行',
      'hint': '在系统设置 > 无障碍中启用「khy-os」后即可使用',
      'needs_auth': 'accessibility',
      'capability_note': '',
      'args': const <String, dynamic>{},
      'result': const <String, dynamic>{},
    });
    await tester.pumpWidget(wrap());
    await openWith(tester, '{"tool":"ui_tap"}');

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();

    expect(find.textContaining('未授权无障碍服务'), findsOneWidget);
    expect(find.textContaining('系统设置 > 无障碍'), findsOneWidget);
    expect(calls.contains('sendToAmoo'), isFalse);
  });

  testWidgets('prose: still goes to the share sheet, local exec is never touched',
      (tester) async {
    mockChannel();
    await tester.pumpWidget(wrap());
    await openWith(tester, '现在屏幕上有什么');

    expect(buttonLabel(tester), '分享到 amoo');

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();

    expect(calls.contains('sendToAmoo'), isTrue);
    expect(calls.contains('consoleExec'), isFalse);
  });
}
