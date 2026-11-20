import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/agent_loop.dart';
import 'package:khy_os_client/core/agent/tool_verdict.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/services/trajectory_store.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';
import 'package:khy_os_client/core/wechat/wechat_approval_bridge.dart';
import 'package:khy_os_client/core/wechat/wechat_command_router.dart';
import 'package:khy_os_client/core/wechat/wechat_progress_reporter.dart';
import 'package:khy_os_client/core/wechat/wechat_task_runner.dart';

/// Local OpenAI-compatible endpoint: AgentLoop posts to `$baseUrl/chat/
/// completions`, so a loopback server with a scripted response queue is the
/// whole fake gateway. Ephemeral port, test-only — pinned loopback endpoints
/// in tests are protection, not hardcoding.
class FakeGateway {
  final HttpServer _server;
  final requests = <Map<String, dynamic>>[];
  final script = <Map<String, dynamic>>[];

  FakeGateway._(this._server) {
    _server.listen((req) async {
      final body = await utf8.decoder.bind(req).join();
      requests.add(jsonDecode(body) as Map<String, dynamic>);
      final resp = script.removeAt(0);
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(resp));
      await req.response.close();
    });
  }

  static Future<FakeGateway> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    return FakeGateway._(server);
  }

  String get baseUrl => 'http://127.0.0.1:${_server.port}/v1';

  Future<void> stop() => _server.close(force: true);

  void enqueueText(String content) => script.add({
        'choices': [
          {'message': {'content': content}}
        ],
      });

  void enqueueToolCall(String id, String name, Map<String, dynamic> args) =>
      script.add({
        'choices': [
          {
            'message': {
              'content': '',
              'tool_calls': [
                {
                  'id': id,
                  'type': 'function',
                  'function': {
                    'name': name,
                    'arguments': jsonEncode(args),
                  },
                }
              ],
            }
          }
        ],
      });
}

/// Fake channel: inbound controller + captured outbound (token|text).
class FakeTransport implements WechatTransport {
  final controller = StreamController<WechatInboundMessage>();
  final sent = <String>[];

  @override
  Stream<WechatInboundMessage> get inbound => controller.stream;

  @override
  Future<void> send(String contextToken, String text) async {
    sent.add('$contextToken|$text');
  }

  void emit(String token, String sender, String id, String text) {
    controller.add(WechatInboundMessage(
      contextToken: token,
      senderId: sender,
      messageId: id,
      text: text,
      receivedAt: DateTime.now(),
    ));
  }
}

class Harness {
  final transport = FakeTransport();
  final toolEffects = <String>[];
  FakeGateway? gateway;
  late TrajectoryStore store;
  late Directory trajDir;
  late WechatTaskRunner runner;

  Future<void> start({
    Duration approvalTimeout = kWechatPermissionTimeout,
    Set<String> allowed = const {'wx-owner'},
  }) async {
    trajDir = await Directory.systemTemp.createTemp('wechat-traj-test');
    store = TrajectoryStore(directoryPath: trajDir.path);
    gateway = await FakeGateway.start();
    final bridge = WechatApprovalBridge(
      sendPrompt: (token, text) => transport.send(token, text),
      timeout: approvalTimeout,
    );
    runner = WechatTaskRunner(
      transport: transport,
      loadConfig: () async => AppConfigData(
        baseUrl: gateway!.baseUrl,
        apiKey: 'test-key',
        model: 'test-model',
      ),
      allowedSenders: allowed,
      approvalBridge: bridge,
      engineFactory: (approval) {
        final engine = ApprovalGatedToolEngine(
          approval: approval,
          approvalTimeout: approvalTimeout,
        );
        engine.register(ToolDef(
          name: 'fetch_hot_list',
          description: 'fetch a hot list',
          inputSchema: {'type': 'object'},
          execute: (args) async {
            toolEffects.add('fetch:${args['src']}');
            return ToolResult.ok('热搜1；热搜2');
          },
        ));
        engine.register(ToolDef(
          name: 'send_rank',
          description: 'send the ranked list',
          inputSchema: {'type': 'object'},
          execute: (args) async {
            toolEffects.add('send');
            return ToolResult.ok('已发送榜单');
          },
        ));
        engine.register(ToolDef(
          name: 'risky_tap',
          description: 'ask-level tap',
          inputSchema: {'type': 'object'},
          permission: PermissionLevel.ask,
          execute: (args) async {
            toolEffects.add('tap:${args['target']}');
            return ToolResult.ok('已点击');
          },
        ));
        engine.register(ToolDef(
          name: 'flaky_check',
          description: 'always fails',
          inputSchema: {'type': 'object'},
          execute: (args) async => ToolResult.fail('应用没装上'),
        ));
        engine.register(ToolDef(
          name: 'slow_thing',
          description: 'takes a while',
          inputSchema: {'type': 'object'},
          execute: (args) async {
            await Future<void>.delayed(const Duration(milliseconds: 300));
            toolEffects.add('slow');
            return ToolResult.ok('slow done');
          },
        ));
        return engine;
      },
      trajectoryStore: store,
      reporter: WechatProgressReporter(
        send: (token, text) => transport.send(token, text),
        minInterval: Duration.zero,
      ),
    );
    runner.start();
  }

  Future<void> stop() async {
    await runner.dispose();
    await gateway?.stop();
    if (trajDir.existsSync()) trajDir.deleteSync(recursive: true);
  }
}

Future<void> waitUntil(bool Function() cond,
    {Duration timeout = const Duration(seconds: 5)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!cond()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('等待超时：条件未满足');
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

/// 本地任务的进度记录 sink：submitLocal 契约的观察点。
class RecordingSink implements TaskSink {
  final events = <String>[];

  @override
  Future<void> taskStarted(String taskText) async => events.add('start');

  @override
  Future<void> onExecuting(AgentStep step, {required int stepNo}) async =>
      events.add('exec:${step.toolName ?? ''}');

  @override
  Future<void> onReflecting(AgentStep step, ToolVerdict verdict,
      {required int stepNo}) async =>
      events.add('reflect');

  @override
  Future<void> onFinal(String text) async => events.add('final');

  @override
  Future<void> onRunFailed(String reason) async => events.add('fail:$reason');

  @override
  Future<void> onAbandoned() async => events.add('abandoned');
}

/// 全放行的审批通道：本地任务的 ask 工具走这里，微信 y/n 不被碰到。
class AutoAllowApproval implements ApprovalChannel {
  @override
  Future<WechatApprovalDecision> request({
    required String toolName,
    required Map<String, dynamic> params,
    String? reasoning,
  }) async =>
      WechatApprovalDecision.allow;
}

void main() {
  group('splitForWechat', () {
    test('short text stays one chunk, empty text yields nothing', () {
      expect(splitForWechat('你好'), ['你好']);
      expect(splitForWechat(''), isEmpty);
    });

    test('long text splits at 2048 UTF-16 code units', () {
      final text = 'A' * 5000;
      final chunks = splitForWechat(text);
      expect(chunks.map((c) => c.length), [2048, 2048, 904]);
      expect(chunks.join(), text);
    });

    test('never cuts a surrogate pair in half', () {
      final text = '${'x' * 2047}𠮷${'y' * 10}';
      final chunks = splitForWechat(text);
      expect(chunks[0].length, 2047);
      expect(text.runes.any((r) => r > 0xFFFF), isTrue); // the pair is astral
      expect(chunks.join(), text);
      expect(chunks[1].codeUnits.take(2), text.codeUnits.sublist(2047, 2049));
    });
  });

  group('WechatCommandRouter', () {
    WechatCommandRouter routerWith(List<String> out,
        {String? Function()? status,
        Future<bool> Function()? stop,
        List<String> Function(int)? records}) {
      return WechatCommandRouter(
        send: (t, s) async => out.add(s),
      )
        ..statusSnapshot = status
        ..stopCurrent = stop
        ..recentSummaries = records;
    }

    test('idle /status and /stop answer honestly', () async {
      final out = <String>[];
      final router = routerWith(out);
      expect(await router.handle('c', '/status'), isTrue);
      expect(await router.handle('c', '/stop'), isTrue);
      expect(out, ['当前没有正在执行的任务', '当前没有正在执行的任务']);
    });

    test('/status reports the running snapshot; /stop abandons', () async {
      final out = <String>[];
      final router = routerWith(out,
          status: () => '第 3/15 步 · 上一个动作 fetch_hot_list',
          stop: () async => true);
      expect(await router.handle('c', '/STATUS'), isTrue);
      expect(await router.handle('c', '/stop'), isTrue);
      expect(out[0], contains('第 3/15 步'));
      expect(out[1], '已放弃等待，后台步骤可能仍在跑');
    });

    test('「记录」 with and without a count', () async {
      final out = <String>[];
      var asked = 0;
      final router = routerWith(out,
          records: (n) {
            asked = n;
            return ['=== 执行日志 c1 ==='];
          });
      expect(await router.handle('c', '记录'), isTrue);
      expect(asked, 3);
      expect(await router.handle('c', '记录 5'), isTrue);
      expect(asked, 5);
      expect(out.join(), contains('=== 执行日志 c1 ==='));
    });

    test('empty record log answers, non-commands fall through', () async {
      final out = <String>[];
      final router = routerWith(out, records: (_) => const []);
      expect(await router.handle('c', '记录'), isTrue);
      expect(out, ['还没有执行记录']);
      expect(await router.handle('c', '打开抖音看热搜'), isFalse);
      expect(out, hasLength(1));
    });
  });

  group('WechatTaskRunner E2E (fake gateway + fake channel)', () {
    test('文本进→两步工具→进度≥2→分块结果→context_token 回带→轨迹 JSONL==链长',
        () async {
      final h = Harness();
      await h.start();
      final g = h.gateway!;
      g.enqueueToolCall('c1', 'fetch_hot_list', {'src': '抖音'});
      g.enqueueToolCall('c2', 'send_rank', {'items': '热搜1；热搜2'});
      g.enqueueText('A' * 5000);
      h.transport.emit('ctx-1', 'wx-owner', 'm1', '打开抖音看热搜');

      await waitUntil(() =>
          h.transport.sent.length >= 6 &&
          h.transport.sent.last.startsWith('ctx-1|AAAA'));

      // begin + per-step progress lines
      expect(h.transport.sent.first, 'ctx-1|开始执行（最多 15 步）：打开抖音看热搜');
      final progress = h.transport.sent
          .where((s) => RegExp(r'第 \d+/15 步').hasMatch(s))
          .toList();
      expect(progress.length, greaterThanOrEqualTo(2));
      expect(progress.join('\n'), contains('调用 fetch_hot_list'));
      expect(progress.join('\n'), contains('fetch_hot_list 已回报（已验证）'));

      // tool side effects happened exactly once each
      expect(h.toolEffects, ['fetch:抖音', 'send']);

      // final result delivered as chunks, context token echoed everywhere
      final chunks = h.transport.sent.sublist(h.transport.sent.length - 3);
      expect(chunks.map((c) => c.substring('ctx-1|'.length).length),
          [2048, 2048, 904]);
      expect(
          chunks.map((c) => c.substring('ctx-1|'.length)).join(), 'A' * 5000);
      for (final s in h.transport.sent) {
        expect(s.startsWith('ctx-1|'), isTrue, reason: s);
      }

      // trajectory: one JSONL line + one chain link per tool step
      final sessions = await h.store.listSessions();
      expect(sessions, hasLength(1));
      expect(sessions.single.conversationId, 'wechat-wx-owner-m1');
      final verdict = await h.store
          .verifySession('wechat-wx-owner-m1');
      expect(verdict.available, isTrue);
      expect(verdict.intact, isTrue,
          reason: verdict.reason ?? '');
      expect(verdict.length, 2);

      await h.stop();
    });

    test('ask 工具：微信回 y 才执行，提示语带 y/n 说明', () async {
      final h = Harness();
      await h.start();
      final g = h.gateway!;
      g.enqueueToolCall('c1', 'risky_tap', {'target': '搜索按钮'});
      g.enqueueText('已完成点击');
      h.transport.emit('ctx-1', 'wx-owner', 'm1', '点掉那个弹窗');

      await waitUntil(() => h.transport.sent
          .any((s) => s.contains('需要你授权执行:risky_tap')));
      // gate held: prompt out, no side effect yet
      expect(h.toolEffects, isEmpty);
      expect(h.transport.sent
              .firstWhere((s) => s.contains('需要你授权执行:risky_tap')),
          contains('回复 y 允许,n 拒绝。超时会自动拒绝。'));

      h.transport.emit('ctx-1', 'wx-owner', 'm2', 'y');
      await waitUntil(() => h.transport.sent.any((s) => s.endsWith('|已完成点击')));
      expect(h.toolEffects, ['tap:搜索按钮']);
      expect(h.transport.sent.join('\n'), contains('已回报（已验证）'));

      await h.stop();
    });

    test('ask 工具：微信回 n 拒绝——无工具副作用，失败如实进回喂', () async {
      final h = Harness();
      await h.start();
      final g = h.gateway!;
      g.enqueueToolCall('c1', 'risky_tap', {'target': '搜索按钮'});
      g.enqueueText('收到拒绝');
      h.transport.emit('ctx-1', 'wx-owner', 'm1', '点掉那个弹窗');

      await waitUntil(() =>
          h.transport.sent.any((s) => s.contains('需要你授权执行:risky_tap')));
      h.transport.emit('ctx-1', 'wx-owner', 'm2', 'n');
      // wait for the run to finish: the final message is the one carrying the
      // honesty suffix (only the complete step adds it)
      await waitUntil(() =>
          h.transport.sent.any((s) => s.contains('未计入已完成')));
      expect(h.toolEffects, isEmpty);
      // the refusal was fed back to the model verbatim
      expect(jsonEncode(g.requests.last), contains('用户拒绝了该操作'));
      // final narration carries the honesty suffix, never a bare 完成
      expect(h.transport.sent.join('\n'), contains('注意：1 步被核对推翻，未计入已完成。'));

      await h.stop();
    });

    test('ask 工具：不回复——120s 档可注入缩短，超时自动拒、无副作用', () async {
      final h = Harness();
      await h.start(approvalTimeout: const Duration(milliseconds: 120));
      final g = h.gateway!;
      g.enqueueToolCall('c1', 'risky_tap', {'target': '搜索按钮'});
      g.enqueueText('超时收尾');
      h.transport.emit('ctx-1', 'wx-owner', 'm1', '点掉那个弹窗');

      await waitUntil(() =>
          h.transport.sent.any((s) => s.contains('需要你授权执行:risky_tap')));
      // nobody replies; the timeout auto-deny path must carry the run home
      // (the honesty suffix marks the final message)
      await waitUntil(() =>
          h.transport.sent.any((s) => s.contains('未计入已完成')));
      expect(h.toolEffects, isEmpty);
      expect(jsonEncode(g.requests.last), contains('已自动拒绝'));
      expect(h.transport.sent.join('\n'), contains('未计入已完成'));

      await h.stop();
    });

    test('忙时拒收：回当前进度，不接新单', () async {
      final h = Harness();
      await h.start();
      final g = h.gateway!;
      g.enqueueToolCall('c1', 'slow_thing', {});
      g.enqueueText('第一个任务完成');
      h.transport.emit('ctx-1', 'wx-owner', 'm1', '先跑这个');

      await waitUntil(() => h.toolEffects.isNotEmpty || h.gateway!.requests.isNotEmpty);
      // tool is mid-run (300ms); a second task must be refused with progress
      await Future<void>.delayed(const Duration(milliseconds: 60));
      final before = h.transport.sent.length;
      h.transport.emit('ctx-2', 'wx-owner', 'm2', '再跑一个');
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(h.transport.sent.length, before + 1);
      expect(h.transport.sent.last, startsWith('ctx-2|'));
      expect(h.transport.sent.last, contains('已有任务在跑'));
      expect(h.transport.sent.last, contains('第 1/15 步'));

      await waitUntil(() => h.transport.sent
          .any((s) => s.startsWith('ctx-1|') && s.endsWith('|第一个任务完成')));
      expect(h.gateway!.requests, hasLength(2)); // task2 never dispatched

      await h.stop();
    });

    test('/status 报当前步，/stop 放弃等待且不再有结果消息', () async {
      final h = Harness();
      await h.start();
      final g = h.gateway!;
      g.enqueueToolCall('c1', 'slow_thing', {});
      g.enqueueText('FINAL-TEXT-XY');
      h.transport.emit('ctx-1', 'wx-owner', 'm1', '慢任务');

      await waitUntil(() => h.toolEffects.isNotEmpty || h.gateway!.requests.isNotEmpty);
      await Future<void>.delayed(const Duration(milliseconds: 60));
      h.transport.emit('ctx-1', 'wx-owner', 'm2', '/status');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(h.transport.sent.last, contains('第 1/15 步'));
      expect(h.transport.sent.last, contains('slow_thing'));

      h.transport.emit('ctx-1', 'wx-owner', 'm3', '/stop');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(h.transport.sent.last, 'ctx-1|已放弃等待，后台步骤可能仍在跑');

      // the abandoned run never delivers a final result, and the model is
      // never called again (script entry stays unconsumed)
      await Future<void>.delayed(const Duration(milliseconds: 500));
      expect(h.transport.sent.join('\n'), isNot(contains('FINAL-TEXT-XY')));
      expect(h.gateway!.requests, hasLength(1));

      // lock released: a new task is admitted again
      g.script.clear();
      g.enqueueText('新任务结果');
      h.transport.emit('ctx-1', 'wx-owner', 'm4', '再来一个');
      await waitUntil(() => h.transport.sent
          .any((s) => s.startsWith('ctx-1|') && s.endsWith('|新任务结果')));

      await h.stop();
    });

    test('「记录」回最近一次执行的摘要', () async {
      final h = Harness();
      await h.start();
      final g = h.gateway!;
      g.enqueueToolCall('c1', 'fetch_hot_list', {'src': '抖音'});
      g.enqueueText('榜单：热搜1、热搜2');
      h.transport.emit('ctx-1', 'wx-owner', 'm1', '打开抖音看热搜');
      await waitUntil(() => h.transport.sent
          .any((s) => s.startsWith('ctx-1|') && s.contains('榜单：热搜1、热搜2')));

      h.transport.emit('ctx-1', 'wx-owner', 'm2', '记录');
      await waitUntil(() => h.transport.sent
          .any((s) => s.contains('=== 执行日志 wechat-wx-owner-m1 ===')));
      final reply = h.transport.sent
          .firstWhere((s) => s.contains('=== 执行日志 wechat-wx-owner-m1 ==='));
      expect(reply, contains('fetch_hot_list'));
      expect(reply, contains('打开抖音看热搜'));

      await h.stop();
    });

    test('未授权账号直接拒之门外', () async {
      final h = Harness();
      await h.start();
      h.transport.emit('ctx-9', 'wx-stranger', 's1', '打开抖音');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(h.transport.sent, ['ctx-9|本账号不在允许名单，已拒绝执行']);
      expect(h.gateway!.requests, isEmpty);

      await h.stop();
    });

    test('无待批时收到 y/n 得到如实回答，不误启动任务', () async {
      final h = Harness();
      await h.start();
      h.transport.emit('ctx-1', 'wx-owner', 'm1', 'y');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(h.transport.sent, ['ctx-1|当前没有待批准的操作']);
      expect(h.gateway!.requests, isEmpty);

      await h.stop();
    });
  });

  group('submitLocal（本地任务管线）', () {
    test('空指令诚实拒绝，不占锁', () async {
      final h = Harness();
      await h.start();
      final refusal = await h.runner.submitLocal(
          '   ', sink: RecordingSink(), approval: AutoAllowApproval());
      expect(refusal, isNotEmpty);
      expect(h.gateway!.requests, isEmpty);

      await h.stop();
    });

    test('本地任务走同一条管线：sink 逐事件、结果同一来源、收尾释放锁',
        () async {
      final h = Harness();
      await h.start();
      final g = h.gateway!;
      final sink = RecordingSink();
      g.enqueueToolCall('l1', 'fetch_hot_list', {'src': '抖音'});
      g.enqueueText('榜单：热搜1、热搜2');

      final refusal = await h.runner.submitLocal(
          '打开抖音看热搜', sink: sink, approval: AutoAllowApproval());
      expect(refusal, '', reason: '空串=受理');
      await waitUntil(() => sink.events.contains('final'));
      expect(sink.events.first, 'start');
      expect(sink.events, contains('exec:fetch_hot_list'),
          reason: '与微信任务共用工具执行层');
      expect(h.toolEffects, contains('fetch:抖音'));

      // 收尾后锁已释放：再提一条能直接受理。
      final sink2 = RecordingSink();
      g.script.clear();
      g.enqueueText('第二条结果');
      expect(
          await h.runner
              .submitLocal('再来一条', sink: sink2, approval: AutoAllowApproval()),
          '');
      await waitUntil(() => sink2.events.contains('final'));

      await h.stop();
    });

    test('锁被占：诚实拒绝并带当前任务摘要，不排队', () async {
      final h = Harness();
      await h.start();
      final g = h.gateway!;
      final sink = RecordingSink();
      g.enqueueToolCall('l1', 'slow_thing', {});
      g.enqueueText('慢任务结果');
      expect(
          await h.runner
              .submitLocal('慢任务A', sink: sink, approval: AutoAllowApproval()),
          '');
      await waitUntil(() => sink.events.contains('exec:slow_thing'));

      final refusal = await h.runner.submitLocal(
          '插队任务', sink: RecordingSink(), approval: AutoAllowApproval());
      expect(refusal, contains('已有任务在跑'));
      expect(refusal, contains('slow_thing'),
          reason: '拒绝要说清当前在跑什么——静默排队等于吞掉指令');
      await waitUntil(() => sink.events.contains('final'));

      await h.stop();
    });

    test('stop=放弃等待：onAbandoned 带诚实语义，锁随即释放', () async {
      final h = Harness();
      await h.start();
      final g = h.gateway!;
      final sink = RecordingSink();
      g.enqueueToolCall('l1', 'slow_thing', {});
      g.enqueueText('不会被消费的结果');
      expect(
          await h.runner
              .submitLocal('慢任务B', sink: sink, approval: AutoAllowApproval()),
          '');
      await waitUntil(() => sink.events.contains('exec:slow_thing'));

      expect(await h.runner.stopCurrentTask(), isTrue);
      await waitUntil(() => sink.events.contains('abandoned'));
      expect(sink.events, isNot(contains('final')),
          reason: '放弃等待不伪造结果');

      // 锁已放：新任务立刻受理。
      g.script.clear();
      g.enqueueText('新任务结果');
      final sink2 = RecordingSink();
      expect(
          await h.runner
              .submitLocal('新任务', sink: sink2, approval: AutoAllowApproval()),
          '');
      await waitUntil(() => sink2.events.contains('final'));

      await h.stop();
    });
  });
}
