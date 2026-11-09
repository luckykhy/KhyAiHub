import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/config/permission_mode.dart';
import 'package:khy_os_client/core/tools/builtin_tools.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';
import 'package:khy_os_client/ui/screens/settings_screen_new.dart';

/// The phone's permission-mode layer.
///
/// WHY THIS FILE EXISTS. Two latent bugs, both found while adding the mode
/// layer and both invisible until someone looked:
///
///   1. `ToolEngine.getPermission` defaulted to `PermissionLevel.auto` when
///      nothing explicit was set, so a tool that DECLARED `ask` was silently
///      auto-approved. `vision_tap` declares `ask` and was therefore never
///      asked about — the annotation was a lie with no symptom.
///   2. `_needsApproval` in the chat screen was hardcoded to two tool names,
///      so the declared level was never consulted at all.
///
/// The mode semantics themselves are pinned here too, because the difference
/// between "stop nagging me this session" and "never ask me" is the whole point
/// of having more than one mode, and collapsing them would be an easy
/// regression with no visible failure.
void main() {
  group('PermissionMode', () {
    test('wire names match the desktop vocabulary', () {
      // The desktop spells these `default` / `auto` / `bypass` in
      // toolCallingPermissions.js. Matching them is what makes a mode set on
      // one surface mean the same thing on another — the stated reason the
      // phone layer exists at all.
      expect(PermissionMode.values.map((m) => m.wire).toList(),
          ['default', 'auto', 'bypass']);
    });

    test('fromWire round-trips and falls back to prompt', () {
      for (final m in PermissionMode.values) {
        expect(PermissionMode.fromWire(m.wire), m);
      }
      // Unknown, null and empty all mean "ask", never "don't ask". A typo in
      // stored config must not silently become bypass.
      expect(PermissionMode.fromWire(null), PermissionMode.prompt);
      expect(PermissionMode.fromWire(''), PermissionMode.prompt);
      expect(PermissionMode.fromWire('bypasss'), PermissionMode.prompt);
      expect(PermissionMode.fromWire('yolo'), PermissionMode.prompt);
    });

    test('only bypass skips the prompt', () {
      expect(PermissionMode.prompt.asks, true);
      expect(PermissionMode.auto.asks, true);
      expect(PermissionMode.bypass.asks, false);
    });

    test('only auto remembers within the session', () {
      // The distinction that must not collapse: `auto` is "stop nagging me
      // this session", `bypass` is "never ask me". If auto started remembering
      // durably it would BE bypass under another name.
      expect(PermissionMode.prompt.remembersWithinSession, false);
      expect(PermissionMode.auto.remembersWithinSession, true);
      expect(PermissionMode.bypass.remembersWithinSession, false);
    });

    test('every mode has a label and a consequence, not just a name', () {
      for (final m in PermissionMode.values) {
        expect(m.label, isNotEmpty, reason: '$m 没有标签');
        expect(m.detail, isNotEmpty, reason: '$m 没有说明它到底改变什么');
        expect(m.detail, isNot(m.label),
            reason: '$m 的说明只是把名字又说了一遍，没有信息量');
      }
    });

    test('the file stays free of Flutter imports', () {
      // core/config is pure Dart by convention here (built_in_keys.dart and
      // provider_presets.dart import nothing). The colour a mode is drawn in
      // belongs to the theme layer, not to what the mode means.
      final src = _read('lib/core/config/permission_mode.dart');
      expect(src, isNot(contains("import 'package:flutter")));
    });
  });

  group('the declared level is honoured', () {
    test('a tool declaring ask is ask, not auto', () {
      // Regression test for latent bug #1. Before the fix,
      // `getPermission('vision_tap')` returned `auto` because nothing had
      // called `setPermission`, and the declaration was ignored.
      final engine = ToolEngine();
      engine.registerAll(createBuiltinTools());
      expect(engine.getPermission('vision_tap'), PermissionLevel.ask,
          reason: 'vision_tap 声明了 ask，必须被读出来');
    });

    test('a tool declaring nothing stays auto', () {
      final engine = ToolEngine();
      engine.registerAll(createBuiltinTools());
      expect(engine.getPermission('calculator'), PermissionLevel.auto);
    });

    test('an explicit setPermission still overrides the declaration', () {
      // The declaration is the default, not a ceiling. A caller that knows
      // better must be able to say so — and `PermissionLevel` has no `bypass`
      // of its own, because "don't ask" is a MODE decision, not a per-tool one.
      // Conflating them would give every tool its own private bypass.
      final engine = ToolEngine();
      engine.registerAll(createBuiltinTools());
      engine.setPermission('vision_tap', PermissionLevel.deny);
      expect(engine.getPermission('vision_tap'), PermissionLevel.deny);
      expect(engine.canExecute('vision_tap'), false);
    });

    test('canExecute still only cares about deny', () {
      // `ask` means "ask", not "refuse". Making it refuse would break every
      // tool that declares it, which is a worse failure than the one being
      // fixed.
      final engine = ToolEngine();
      engine.registerAll(createBuiltinTools());
      expect(engine.canExecute('vision_tap'), true);
      engine.setPermission('vision_tap', PermissionLevel.deny);
      expect(engine.canExecute('vision_tap'), false);
    });
  });

  group('AppConfig carries the mode', () {
    test('round-trips through JSON', () {
      const c = AppConfigData(
        baseUrl: 'https://x.com',
        apiKey: 'k',
        model: 'm',
        permissionMode: 'bypass',
      );
      final back = AppConfigData.fromJson(c.toJson());
      expect(back.permissionMode, 'bypass');
      expect(PermissionMode.fromWire(back.permissionMode), PermissionMode.bypass);
    });

    test('defaults to prompt, never to bypass', () {
      // The safe default. A config written before this field existed, or one
      // that lost the key, must land on "ask".
      const c = AppConfigData(baseUrl: '', apiKey: '', model: '');
      expect(c.permissionMode, 'default');
      expect(PermissionMode.fromWire(c.permissionMode), PermissionMode.prompt);

      final back = AppConfigData.fromJson(const <String, dynamic>{
        'baseUrl': '',
        'apiKey': '',
        'model': '',
      });
      expect(PermissionMode.fromWire(back.permissionMode), PermissionMode.prompt);
    });

    test('copyWith preserves it when not passed', () {
      const c = AppConfigData(
        baseUrl: '',
        apiKey: '',
        model: '',
        permissionMode: 'auto',
      );
      expect(c.copyWith(model: 'other').permissionMode, 'auto');
      expect(c.copyWith(permissionMode: 'bypass').permissionMode, 'bypass');
    });
  });

  group('the boundary is stated in the code', () {
    test('the mode file says what it is NOT for', () {
      // A reader who finds this later will reasonably ask "so why can't it
      // click the MediaProjection dialog too?". The answer belongs next to the
      // code, not in a commit message nobody reads.
      final src = _read('lib/core/config/permission_mode.dart');
      expect(src, contains('WHAT THIS IS NOT'));
      expect(src, contains("not khy-os's to waive"));
    });
  });

  group('the settings selector', () {
    testWidgets('renders all three modes with bypass last', (tester) async {
      // Order matters: `bypass` is the one that removes a safety prompt, and
      // listing it first would make it the path of least resistance.
      await pumpSettings(tester);
      final tiles = find.byType(RadioListTile<PermissionMode>);
      expect(tiles, findsNWidgets(3));
      expect(tester.widget<RadioListTile<PermissionMode>>(tiles.at(0)).value,
          PermissionMode.prompt);
      expect(tester.widget<RadioListTile<PermissionMode>>(tiles.at(2)).value,
          PermissionMode.bypass);
    });

    testWidgets('prompt is selected by default', (tester) async {
      // The safe default has to be what the user sees on a fresh install, not
      // something they have to notice and correct.
      await pumpSettings(tester);
      final tiles = find.byType(RadioListTile<PermissionMode>);
      for (var i = 0; i < 3; i++) {
        final t = tester.widget<RadioListTile<PermissionMode>>(tiles.at(i));
        expect(t.groupValue, PermissionMode.prompt);
        expect(t.groupValue == t.value, i == 0);
      }
    });

    testWidgets('the section says it does not cover system dialogs', (
      tester,
    ) async {
      // The single most likely misreading of this feature. Someone will see
      // "bypass" and assume it covers the MediaProjection dialog too; the text
      // has to say otherwise where they are looking.
      await pumpSettings(tester);
      expect(find.textContaining('系统那种同意框'), findsOneWidget);
      expect(find.textContaining('不归它管'), findsOneWidget);
    });
  });
}

/// Pump the settings screen far enough down to reach the 工具许可 section.
///
/// Scrolled to the radio tiles rather than to the section title, because the
/// section header and its content are separate widgets and only the tiles are
/// what these tests assert on.
Future<void> pumpSettings(WidgetTester tester) async {
  await tester.pumpWidget(const MaterialApp(home: SettingsScreenNew()));
  await tester.pumpAndSettle();
  for (var i = 0; i < 40 && !tester.any(find.byType(RadioListTile<PermissionMode>)); i++) {
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -350));
    await tester.pumpAndSettle();
  }
  expect(tester.any(find.byType(RadioListTile<PermissionMode>)), isTrue,
      reason: '滚了 40 次还没见到「工具许可」区');
  await tester.ensureVisible(find.byType(RadioListTile<PermissionMode>).first);
  await tester.pumpAndSettle();
}

String _read(String p) {
  final f = File(p);
  expect(f.existsSync(), true, reason: '$p 找不到——测试必须从 App 目录跑');
  return f.readAsStringSync();
}
