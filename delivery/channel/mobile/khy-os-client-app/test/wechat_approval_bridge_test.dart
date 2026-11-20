import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';
import 'package:khy_os_client/core/wechat/wechat_approval_bridge.dart';

/// Bridge that records what the engine asked and denies everything — lets
/// gate-interception tests observe the request without a transport.
class _RecordingBridge implements WechatApprovalChannel {
  final requests = <Map<String, Object?>>[];

  @override
  Future<WechatApprovalDecision> request({
    required String toolName,
    required Map<String, dynamic> params,
    String? reasoning,
  }) async {
    requests.add({'tool': toolName, 'params': Map<String, dynamic>.from(params)});
    return WechatApprovalDecision.deny;
  }
}

ToolDef makeAskTool(List<String> effects, {String name = 'risky_thing'}) =>
    ToolDef(
      name: name,
      description: 'ask-level tool for gate tests',
      inputSchema: {
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

void main() {
  group('parsePermissionReply', () {
    test('allow word list, trailing punctuation stripped', () {
      for (final w in ['y', 'Y', 'yes', '是', '好', '允许', '同意']) {
        expect(parsePermissionReply(w), WechatPermissionReply.allow, reason: w);
      }
      expect(parsePermissionReply('y。'), WechatPermissionReply.allow);
      expect(parsePermissionReply('好!'), WechatPermissionReply.allow);
    });

    test('deny word list', () {
      for (final w in ['n', 'no', '否', '不', '拒绝', '不允许']) {
        expect(parsePermissionReply(w), WechatPermissionReply.deny, reason: w);
      }
    });

    test('anything else is null', () {
      expect(parsePermissionReply('好的'), isNull);
      expect(parsePermissionReply('不行'), isNull);
      expect(parsePermissionReply(''), isNull);
      expect(parsePermissionReply('打开抖音'), isNull);
      expect(parsePermissionReply('/status'), isNull);
    });
  });

  group('formatWechatPermissionPrompt', () {
    test('tool line, params and y/n footer', () {
      final s = formatWechatPermissionPrompt(
          toolName: 'vision_tap', params: {'target': '搜索框'});
      expect(s, contains('需要你授权执行:vision_tap'));
      expect(s, contains('· target: 搜索框'));
      expect(s, contains('回复 y 允许,n 拒绝。超时会自动拒绝。'));
    });

    test('preferred key order: command before path before the rest', () {
      final s = formatWechatPermissionPrompt(
          toolName: 't',
          params: {'pattern': 'b', 'command': 'a', 'note': 'c'});
      final ci = s.indexOf('· command:');
      final pi = s.indexOf('· pattern:');
      final ni = s.indexOf('· note:');
      expect(ci, greaterThan(-1));
      expect(pi, greaterThan(ci));
      expect(ni, greaterThan(pi));
    });

    test('skips private keys, caps at 6 keys, truncates long values', () {
      final params = <String, dynamic>{
        'big': '长' * 300,
        'k1': '1',
        'k2': '2',
        'k3': '3',
        'k4': '4',
        'k5': '5',
        'k7': '7',
        '_hidden': 'x',
        'explanation': 'y',
        'diffPreview': 'z',
      };
      final s = formatWechatPermissionPrompt(toolName: 't', params: params);
      expect(s, isNot(contains('_hidden')));
      expect(s, isNot(contains('explanation')));
      expect(s, isNot(contains('diffPreview')));
      // the 7th candidate key is cut by the 6-key cap
      expect(s, isNot(contains('· k7:')));
      expect(s, contains('· big: ${'长' * 200}…(共 300 字符)'));
    });
  });

  group('WechatApprovalBridge', () {
    test('resolveInbound with nothing pending returns false', () {
      final bridge = WechatApprovalBridge(sendPrompt: (t, s) async {});
      expect(bridge.resolveInbound('y'), isFalse);
    });

    test('pending + y resolves allow and clears the slot', () async {
      final prompts = <String>[];
      final bridge = WechatApprovalBridge(
          sendPrompt: (t, s) async => prompts.add(s));
      final decision = bridge.request(
          toolName: 'vision_tap', params: {'target': '搜索框'});
      await Future<void>.delayed(Duration.zero);
      expect(prompts, hasLength(1));
      expect(bridge.hasPending, isTrue);
      expect(bridge.resolveInbound('y'), isTrue);
      expect(await decision, WechatApprovalDecision.allow);
      expect(bridge.hasPending, isFalse);
      expect(bridge.resolveInbound('y'), isFalse);
    });

    test('pending + n resolves deny', () async {
      final bridge = WechatApprovalBridge(sendPrompt: (t, s) async {});
      final decision = bridge.request(toolName: 't', params: const {});
      await Future<void>.delayed(Duration.zero);
      expect(bridge.resolveInbound('不'), isTrue);
      expect(await decision, WechatApprovalDecision.deny);
    });

    test('unanswered request times out to deny', () async {
      final bridge = WechatApprovalBridge(
          sendPrompt: (t, s) async {},
          timeout: const Duration(milliseconds: 60));
      final decision = bridge.request(toolName: 't', params: const {});
      await Future<void>.delayed(Duration.zero);
      expect(await decision, WechatApprovalDecision.timeout);
    });

    test('second concurrent request is refused, first slot intact', () async {
      final bridge = WechatApprovalBridge(sendPrompt: (t, s) async {});
      final first = bridge.request(toolName: 't1', params: const {});
      await Future<void>.delayed(Duration.zero);
      final second =
          await bridge.request(toolName: 't2', params: const {});
      expect(second, WechatApprovalDecision.deny);
      expect(bridge.resolveInbound('y'), isTrue);
      expect(await first, WechatApprovalDecision.allow);
    });

    test('prompt send failure still falls through to timeout', () async {
      final bridge = WechatApprovalBridge(
        sendPrompt: (t, s) async => throw Exception('transport down'),
        timeout: const Duration(milliseconds: 60),
      );
      final decision = bridge.request(toolName: 't', params: const {});
      await Future<void>.delayed(Duration.zero);
      expect(await decision, WechatApprovalDecision.timeout);
    });
  });

  group('ApprovalGatedToolEngine', () {
    test('auto tool executes with no approval request', () async {
      final bridge = _RecordingBridge();
      final engine = ApprovalGatedToolEngine(approval: bridge);
      engine.register(ToolDef(
        name: 'safe_tool',
        description: 'd',
        inputSchema: {'type': 'object'},
        execute: (args) async => ToolResult.ok('ok'),
      ));
      final r = await engine.execute('safe_tool', {});
      expect(r.success, isTrue);
      expect(bridge.requests, isEmpty);
    });

    test('deny-level tool fails without any approval request', () async {
      final bridge = _RecordingBridge();
      final engine = ApprovalGatedToolEngine(approval: bridge);
      engine.register(ToolDef(
        name: 'blocked_tool',
        description: 'd',
        inputSchema: {'type': 'object'},
        execute: (args) async => ToolResult.ok('should never run'),
      ));
      engine.setPermission('blocked_tool', PermissionLevel.deny);
      final r = await engine.execute('blocked_tool', {});
      expect(r.success, isFalse);
      expect(r.output, contains('Tool denied: blocked_tool'));
      expect(bridge.requests, isEmpty);
    });

    test('ask tool blocked until y, then executes exactly once', () async {
      final effects = <String>[];
      final prompts = <String>[];
      final bridge = WechatApprovalBridge(
          sendPrompt: (t, s) async => prompts.add(s));
      final engine = ApprovalGatedToolEngine(approval: bridge);
      engine.register(makeAskTool(effects));

      final pending = engine.execute('risky_thing', {'target': '发送按钮'});
      await Future<void>.delayed(Duration.zero);
      // Blocked before any side effect: the prompt is out, the tool is not.
      expect(prompts, hasLength(1));
      expect(prompts.single, contains('需要你授权执行:risky_thing'));
      expect(prompts.single, contains('回复 y 允许,n 拒绝。超时会自动拒绝。'));
      expect(effects, isEmpty);
      expect(bridge.hasPending, isTrue);

      expect(bridge.resolveInbound('y'), isTrue);
      final r = await pending;
      expect(r.success, isTrue);
      expect(effects, ['ran:发送按钮']);
    });

    test('ask tool denied by n never executes', () async {
      final effects = <String>[];
      final bridge = WechatApprovalBridge(sendPrompt: (t, s) async {});
      final engine = ApprovalGatedToolEngine(approval: bridge);
      engine.register(makeAskTool(effects));
      final pending = engine.execute('risky_thing', {'target': 'x'});
      await Future<void>.delayed(Duration.zero);
      expect(bridge.resolveInbound('n'), isTrue);
      final r = await pending;
      expect(r.success, isFalse);
      expect(r.output, '用户拒绝了该操作');
      expect(effects, isEmpty);
    });

    test('ask tool auto-denied after timeout never executes', () async {
      final effects = <String>[];
      final bridge = WechatApprovalBridge(
          sendPrompt: (t, s) async {},
          timeout: const Duration(milliseconds: 80));
      final engine = ApprovalGatedToolEngine(
          approval: bridge,
          approvalTimeout: const Duration(milliseconds: 80));
      engine.register(makeAskTool(effects));
      final r = await engine.execute('risky_thing', {'target': 'x'});
      expect(r.success, isFalse);
      expect(r.output, contains('已自动拒绝'));
      expect(effects, isEmpty);
    });

    test('alias call is gated under its canonical name', () async {
      final effects = <String>[];
      final bridge = _RecordingBridge();
      final engine = ApprovalGatedToolEngine(approval: bridge);
      // kToolAliases maps bash→exec_shell; the alias must not bypass the gate.
      engine.register(makeAskTool(effects, name: 'exec_shell'));
      expect(engine.heldByGate('bash'), isTrue);
      final r = await engine.execute('bash', {'target': 'x'});
      expect(r.success, isFalse);
      expect(bridge.requests, hasLength(1));
      expect(bridge.requests.single['tool'], 'exec_shell');
      expect(effects, isEmpty);
    });

    test('executeToolCalls goes through the same gate', () async {
      final effects = <String>[];
      final bridge = WechatApprovalBridge(sendPrompt: (t, s) async {});
      final engine = ApprovalGatedToolEngine(approval: bridge);
      engine.register(makeAskTool(effects));
      final pending = engine.executeToolCalls([
        {
          'id': 'c1',
          'function': {'name': 'risky_thing', 'arguments': '{"target":"x"}'}
        }
      ]);
      await Future<void>.delayed(Duration.zero);
      expect(effects, isEmpty);
      expect(bridge.resolveInbound('y'), isTrue);
      final results = await pending;
      expect(results, hasLength(1));
      expect(results.single['role'], 'tool');
      expect(results.single['content'], contains('"success":true'));
      expect(effects, ['ran:x']);
    });

    test('approval default timeout aligns with the PC daemon (120s)', () {
      expect(kWechatPermissionTimeout, const Duration(milliseconds: 120000));
    });
  });
}
