import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';
import 'package:khy_os_client/core/toolhost/tool_host_client.dart';
import 'package:khy_os_client/core/wechat/wechat_approval_bridge.dart';
import 'package:khy_os_client/core/authz/dialog_approval_channel.dart';

/// P0 repro for the residual authorization leak (DESIGN-ARCH-216 E-A03/E-A06):
/// ask-declared tools and dangerous shell ran ungated through the driver host
/// client, the agent screen and the longcat screen. These tests pin both the
/// bug (base engine, negative control) and the B+ fix (gated engine), and they
/// verify the instrument itself so a green run cannot be vacuous.

/// Records every confirm call and answers with a fixed bool — lets the gate be
/// observed without a Flutter dialog.
class _RecordingConfirm {
  _RecordingConfirm(this.answer);
  bool answer;
  final calls = <Map<String, Object?>>[];

  Future<bool> call({
    required String toolName,
    required Map<String, dynamic> params,
    String? reasoning,
  }) async {
    calls.add({'tool': toolName, 'params': Map<String, dynamic>.from(params)});
    return answer;
  }
}

ToolDef _makeAskTool(List<String> effects, {String name = 'risky_thing'}) =>
    ToolDef(
      name: name,
      description: 'ask-level tool for gate tests',
      inputSchema: const {
        'type': 'object',
        'properties': {
          'target': {'type': 'string'},
        },
      },
      permission: PermissionLevel.ask,
      execute: (args) async {
        effects.add('ran:${args['target']}');
        return ToolResult.ok('done');
      },
    );

ToolDef _makeShellTool(List<String> effects, {String name = 'exec_shell'}) =>
    ToolDef(
      name: name,
      description: 'shell tool for dangerous-command gate tests',
      inputSchema: const {
        'type': 'object',
        'properties': {
          'command': {'type': 'string'},
        },
      },
      execute: (args) async {
        effects.add('ran:${args['command']}');
        return ToolResult.ok('shell done');
      },
    );

void main() {
  group('driver host path (E-A03)', () {
    test('NEGATIVE CONTROL: base engine runs an ask tool with no approval',
        () async {
      final effects = <String>[];
      final engine = ToolEngine();
      engine.register(_makeAskTool(effects));
      final client = ToolEngineHostClient(engine);

      final r = await client.invoke('risky_thing', {'target': '发送按钮'});

      // The bug: execution happened and nothing was asked.
      expect(r.success, isTrue);
      expect(effects, ['ran:发送按钮']);
    });

    test('B+ FIX: gated engine + deny -> tool never runs, refusal returned',
        () async {
      final effects = <String>[];
      final confirm = _RecordingConfirm(false);
      final engine =
          ApprovalGatedToolEngine(approval: DialogApprovalChannel(confirm: confirm.call));
      engine.register(_makeAskTool(effects));
      final client = ToolEngineHostClient(engine);

      final r = await client.invoke('risky_thing', {'target': '发送按钮'});

      expect(confirm.calls, hasLength(1));
      expect(confirm.calls.single['tool'], 'risky_thing');
      expect(r.success, isFalse);
      expect(r.output, contains('用户拒绝了该操作'));
      expect(effects, isEmpty, reason: 'deny must leave zero side effects');
    });

    test('B+ FIX: gated engine + allow -> tool runs once, asked once',
        () async {
      final effects = <String>[];
      final confirm = _RecordingConfirm(true);
      final engine =
          ApprovalGatedToolEngine(approval: DialogApprovalChannel(confirm: confirm.call));
      engine.register(_makeAskTool(effects));
      final client = ToolEngineHostClient(engine);

      final r = await client.invoke('risky_thing', {'target': '发送按钮'});

      expect(confirm.calls, hasLength(1));
      expect(r.success, isTrue);
      expect(effects, ['ran:发送按钮']);
    });
  });

  group('DialogApprovalChannel adapter', () {
    test('true -> allow, false -> deny, params forwarded', () async {
      final yes = _RecordingConfirm(true);
      final no = _RecordingConfirm(false);
      final allowCh = DialogApprovalChannel(confirm: yes.call);
      final denyCh = DialogApprovalChannel(confirm: no.call);

      expect(
        await allowCh.request(toolName: 'vision_tap', params: {'target': 'x'}),
        WechatApprovalDecision.allow,
      );
      expect(
        await denyCh.request(toolName: 'vision_tap', params: {'target': 'x'}),
        WechatApprovalDecision.deny,
      );
      expect(yes.calls.single['params'], {'target': 'x'});
    });
  });

  group('gateDangerousTools (agent / longcat path)', () {
    test('marks the three dangerous tools ask; bash alias covered', () {
      final engine = ToolEngine();
      engine.registerAll([
        _makeShellTool(<String>[], name: 'exec_shell'),
        _makeShellTool(<String>[], name: 'exec_shell_elevated'),
        _makeShellTool(<String>[], name: 'android'),
      ]);
      expect(engine.getPermission('exec_shell'), PermissionLevel.auto);

      gateDangerousTools(engine);

      expect(engine.getPermission('exec_shell'), PermissionLevel.ask);
      expect(engine.getPermission('exec_shell_elevated'), PermissionLevel.ask);
      expect(engine.getPermission('android'), PermissionLevel.ask);
      expect(kGateDangerousTools, contains('exec_shell_elevated'));
    });

    test('gated engine asks before exec_shell; deny leaves zero side effects',
        () async {
      final effects = <String>[];
      final confirm = _RecordingConfirm(false);
      final engine =
          ApprovalGatedToolEngine(approval: DialogApprovalChannel(confirm: confirm.call));
      engine.register(_makeShellTool(effects));
      gateDangerousTools(engine);

      final r = await engine.execute('exec_shell', {'command': 'rm -rf /sdcard'});

      expect(confirm.calls, hasLength(1));
      expect(confirm.calls.single['tool'], 'exec_shell');
      expect(r.success, isFalse);
      expect(effects, isEmpty);
    });

    test('bash alias canonicalizes to exec_shell and is held by the gate', () {
      final confirm = _RecordingConfirm(true);
      final engine =
          ApprovalGatedToolEngine(approval: DialogApprovalChannel(confirm: confirm.call));
      engine.register(_makeShellTool(<String>[]));
      gateDangerousTools(engine);

      expect(engine.heldByGate('bash'), isTrue);
      expect(engine.heldByGate('exec_shell'), isTrue);
    });
  });

  group('instrument self-verification (a green run must not be vacuous)', () {
    test('recording confirm actually records and answers', () async {
      final confirm = _RecordingConfirm(true);
      final ch = DialogApprovalChannel(confirm: confirm.call);
      expect(confirm.calls, isEmpty);
      await ch.request(toolName: 't', params: {'k': 'v'});
      expect(confirm.calls, hasLength(1), reason: 'instrument must observe calls');
      confirm.answer = false;
      expect(await ch.request(toolName: 't', params: {}),
          WechatApprovalDecision.deny);
    });

    test('ask tool actually runs when allowed (effects probe is live)',
        () async {
      final effects = <String>[];
      final engine = ToolEngine();
      engine.register(_makeAskTool(effects));
      await engine.execute('risky_thing', {'target': 'probe'});
      expect(effects, ['ran:probe'],
          reason: 'if this is empty, every effects-empty assertion above is vacuous');
    });
  });

  group('callId propagation (附1 §5.4 repro-before)', () {
    test('host client receives callId then drops it (bug present, gate slice does not fix)',
        () async {
      Map<String, dynamic>? captured;
      final engine = ToolEngine();
      engine.register(ToolDef(
        name: 'spy',
        description: 'captures args for callId repro',
        inputSchema: const {'type': 'object', 'properties': {}},
        execute: (args) async {
          captured = Map<String, dynamic>.from(args);
          return ToolResult.ok('spied');
        },
      ));
      final client = ToolEngineHostClient(engine);

      final r = await client.invoke('spy', {'k': 'v'}, callId: 'call_x');

      final cap = captured;
      expect(r.success, isTrue);
      expect(cap, isNotNull);
      expect(cap!['k'], 'v', reason: 'instrument live: spy must capture real args');
      expect(cap.containsKey('callId'), isFalse,
          reason: 'callId dropped at tool_host_client.dart:58 (repro-before)');
      expect(cap.values.contains('call_x'), isFalse);
    });
  });
}