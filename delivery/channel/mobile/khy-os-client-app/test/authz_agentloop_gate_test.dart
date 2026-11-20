import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/agent_loop.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';
import 'package:khy_os_client/core/wechat/wechat_approval_bridge.dart';
import 'package:khy_os_client/core/authz/dialog_approval_channel.dart';

/// 附1 §5.3 repro (DESIGN-ARCH-216): AgentLoop itself is gate-agnostic — it calls
/// `_engine.execute` (agent_loop.dart:131) polymorphically, so gating depends
/// entirely on the injected engine. Negative control: a plain ToolEngine runs an
/// ask tool ungated through a real AgentLoop tool round. Positive: an
/// ApprovalGatedToolEngine denies -> zero side effects. A local fake LLM endpoint
/// drives the round; no author-live source is edited (read-only verification).

class _RecordingConfirm {
  _RecordingConfirm(this.answer);
  bool answer;
  final calls = <String>[];
  Future<bool> call({
    required String toolName,
    required Map<String, dynamic> params,
    String? reasoning,
  }) async {
    calls.add(toolName);
    return answer;
  }
}

ToolDef _askTool(List<String> effects) => ToolDef(
      name: 'risky_thing',
      description: 'ask-level tool for AgentLoop gate repro',
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

/// Local fake LLM: returns a tool_call for risky_thing until a tool result is
/// present in the messages, then a plain completion to end the loop. Stateless.
Future<HttpServer> _fakeLlm() async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    final body = await utf8.decoder.bind(req).join();
    final map = jsonDecode(body) as Map<String, dynamic>;
    final messages = (map['messages'] as List?) ?? [];
    final hasToolResult =
        messages.any((m) => (m as Map)['role'] == 'tool');
    final message = hasToolResult
        ? {'content': '完成'}
        : {
            'content': '执行工具',
            'tool_calls': [
              {
                'id': 'call_1',
                'function': {
                  'name': 'risky_thing',
                  'arguments': '{"target":"probe"}',
                },
              }
            ],
          };
    req.response
      ..statusCode = 200
      ..headers.contentType = ContentType.json
      ..write(jsonEncode({
        'choices': [
          {'message': message}
        ]
      }));
    await req.response.close();
  });
  return server;
}

AppConfigData _cfg(HttpServer s) => AppConfigData(
      baseUrl: 'http://127.0.0.1:${s.port}',
      apiKey: 'test-key',
      model: 'test-model',
    );

void main() {
  late HttpServer server;
  setUp(() async {
    server = await _fakeLlm();
  });
  tearDown(() async {
    await server.close(force: true);
  });

  test('NEGATIVE CONTROL: plain engine -> AgentLoop runs ask tool ungated',
      () async {
    final effects = <String>[];
    final engine = ToolEngine()..register(_askTool(effects));
    final loop = AgentLoop(engine: engine, config: _cfg(server));

    await loop.run('go').drain();

    expect(effects, ['ran:probe'],
        reason: 'AgentLoop has no own gate; plain engine runs the ask tool');
  });

  test('POSITIVE: gated engine + deny -> AgentLoop round leaves zero side effects',
      () async {
    final effects = <String>[];
    final confirm = _RecordingConfirm(false);
    final engine = ApprovalGatedToolEngine(
        approval: DialogApprovalChannel(confirm: confirm.call));
    engine.register(_askTool(effects));
    final loop = AgentLoop(engine: engine, config: _cfg(server));

    await loop.run('go').drain();

    expect(confirm.calls, ['risky_thing'],
        reason: 'gate must be consulted for the ask tool through AgentLoop');
    expect(effects, isEmpty, reason: 'deny must leave zero side effects');
  });

  test('POSITIVE: gated engine + allow -> AgentLoop runs the tool once',
      () async {
    final effects = <String>[];
    final confirm = _RecordingConfirm(true);
    final engine = ApprovalGatedToolEngine(
        approval: DialogApprovalChannel(confirm: confirm.call));
    engine.register(_askTool(effects));
    final loop = AgentLoop(engine: engine, config: _cfg(server));

    await loop.run('go').drain();

    expect(confirm.calls, ['risky_thing']);
    expect(effects, ['ran:probe']);
  });

  test('instrument self-verify: the fake LLM actually drives a tool round',
      () async {
    final effects = <String>[];
    final engine = ToolEngine()..register(_askTool(effects));
    final loop = AgentLoop(engine: engine, config: _cfg(server));

    final steps = await loop.run('go').toList();

    expect(effects, isNotEmpty,
        reason: 'if empty, the fake gateway never drove execute and every '
            'effects-empty assertion above is vacuous');
    expect(steps.any((s) => s.phase == AgentPhase.executing), isTrue,
        reason: 'the round must reach the executing phase');
  });
}