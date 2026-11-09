import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/widgets/vision_config_section.dart';

/// The vision config block.
///
/// WHY THESE STATES ARE TESTED. The block's whole job is to answer "will this
/// work, and if not, what do I do about it" — and the previous answer to that
/// question was the string "未配置视觉模型。请在设置中填写。", which is why
/// `analyze_screen` has never once worked on this device. The user had no way
/// to know that "fill it in" meant "install a model server inside Termux".
///
/// So the states are pinned here: each one must say which of the four
/// situations it is, and the one that needs a Termux install must actually
/// mention the install steps.
/// TextField indices, in build order.
///
/// Written out because a test that indexes fields positionally and guesses
/// wrong fails in a way that looks like a widget bug: the assertion says
/// "expected gelab-zero-4b, got ''" when in fact it read the API-key field.
const _kUrlField = 0;
const _kModelField = 1;
const _kKeyField = 2;

void main() {
  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(child: VisionConfigSection()),
        ),
      ),
    );
    // Two frames: one to build, one for the async _load() to land.
    await tester.pump();
    await tester.pump();
  }

  group('VisionConfigSection', () {
    testWidgets('unconfigured by default, and says so', (tester) async {
      await pump(tester);
      expect(find.text('未配置：读屏幕、定位元素都用不了'), findsOneWidget);
    });

    testWidgets('unconfigured names BOTH routes, and leads with the one that '
        'needs no install on the phone', (tester) async {
      // This is the assertion that would have prevented the feature from
      // silently never working. "请在设置中填写" is technically true and
      // completely useless: the user is already in settings.
      //
      // The PC route comes first because it was measured to work
      // (2026-10-27: adb reverse makes the PC's Ollama answer on the phone's
      // loopback, so visionIsLocal stays true and the privacy gate needs no
      // relaxation) and because it needs a Windows install rather than a proot
      // distro plus a 2.6 GB pull on the phone itself. Leading with Termux —
      // as this text used to — sent people down the harder path for no reason.
      await pump(tester);

      final a = find.textContaining('A. 模型跑在 PC 上，手机蹭用');
      final b = find.textContaining('B. 模型跑在手机本地');
      expect(a, findsOneWidget);
      expect(b, findsOneWidget);

      // A must be laid out above B, not merely present.
      final aY = tester.getTopLeft(a).dy;
      final bY = tester.getTopLeft(b).dy;
      expect(aY, lessThan(bY), reason: 'PC 那条必须排在 Termux 那条前面');

      // The script name has to be in the text, or the route is not actionable.
      expect(find.textContaining('setup-phone-vision.ps1'), findsOneWidget);
      // And the cost has to be stated, or the USB dependency is a surprise.
      expect(find.textContaining('拔掉就断'), findsOneWidget);
      // The Termux route still exists for the "no PC at all" case.
      expect(find.textContaining('pkg install ollama'), findsOneWidget);
    });

    testWidgets('the prefill button uses the real default endpoint', (
      tester,
    ) async {
      // The button exists so the URL is never written out twice. If this
      // assertion fails, someone has hardcoded a second copy of the default.
      await pump(tester);
      await tester.tap(find.text('用本机 Ollama'));
      await tester.pump();

      final fields = find.byType(TextField);
      expect(fields, findsNWidgets(3));
      expect(
        tester.widget<TextField>(fields.at(_kUrlField)).controller!.text,
        'http://localhost:11434/v1',
      );
      expect(
        tester.widget<TextField>(fields.at(_kModelField)).controller!.text,
        'gelab-zero-4b',
      );
    });

    testWidgets('the API key field starts hidden and can be revealed', (
      tester,
    ) async {
      await pump(tester);
      final key = tester.widget<TextField>(find.byType(TextField).at(_kKeyField));
      expect(key.obscureText, true);

      await tester.tap(find.byIcon(Icons.visibility));
      await tester.pump();
      expect(
          tester
              .widget<TextField>(find.byType(TextField).at(_kKeyField))
              .obscureText,
          false);
    });

    testWidgets('the key field says it can be left empty for a local Ollama',
        (tester) async {
      // Otherwise a user setting up the local path types something into it,
      // and a wrong key is a much harder failure to diagnose than a missing one.
      await pump(tester);
      expect(find.text('（本机 Ollama 留空即可）'), findsOneWidget);
    });

    testWidgets('testing with an empty URL does not crash and reports it', (
      tester,
    ) async {
      await pump(tester);
      await tester.tap(find.text('测试连接'));
      await tester.pump();
      expect(find.text('Base URL 和模型名都要填'), findsOneWidget);
    });

    testWidgets('a non-http URL is reported rather than attempted', (
      tester,
    ) async {
      await pump(tester);
      await tester.enterText(
          find.byType(TextField).at(_kUrlField), 'localhost:11434');
      await tester.enterText(
          find.byType(TextField).at(_kModelField), 'gelab-zero-4b');
      await tester.pump();
      await tester.tap(find.text('测试连接'));
      await tester.pump();
      expect(find.textContaining('需以 http://'), findsOneWidget);
    });

    testWidgets('the section carries its own title', (tester) async {
      await pump(tester);
      expect(find.text('视觉模型'), findsOneWidget);
      expect(find.byIcon(Icons.remove_red_eye_outlined), findsOneWidget);
    });
  });
}
