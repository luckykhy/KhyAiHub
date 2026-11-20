import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/drivers/amoo_driver.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/services/amoo_chat_service.dart';
import 'package:khy_os_client/core/services/audit_log.dart';
import 'package:khy_os_client/ui/render/content_tier.dart';

/// D 阶段 T15 判定（主机可判的一半）：断掉直连 → 自动降级 amoo-screen，
/// 且**可读提示出现**、日志无「成功」字样。
///
/// 真机部分（掐断 apex 直连的 live 诱导）在 device 判定脚本
/// works/data/khy/feedback/khyos-structured-link-20261114/harness/t15_check.mjs
/// （锁屏/前台/无障碍状态在主机上造不出来）；这里钉的是客户端契约：
///
///  1. 降级必须带一句**用户可见的提示**（AmooAskOutcome.degradeNotice +
///     statusLine），只说「这一轮是读屏答的」不够——用户看不到 via 字段，
///     看不到的就是没提示（RUNTIME-002：状态要能被看见）。
///  2. 提示与日志里不许出现「成功」：降级是换了一条更慢的路，不是又一次
///     成功。把降级写成成功，用户就无法解释「为什么这次要开无障碍」。
///  3. driver 层（AmooDriver）必须把提示转成 DriverStatus 事件，经渲染层
///     状态行映射器上屏——驱动层与渲染层之间只过通用事件词汇表。
///  4. 降级之后这一轮仍要真的答完：完整回复 + DriverFinished(completed)，
///     不许把「换了条路」当成失败交出去，也不许在半句上假装完成。
///
/// 首败（本阶段实测）：AmooAskOutcome 没有 degradeNotice 字段、
/// statusLine 不含降级提示、AmooDriver 不发提示事件——本文件对当前代码
/// 编译不过/断言失败，这就是 T15 的红。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');

  /// apex 桥自己没起来时原生侧写的机器哨兵（AmooApexLink.kt:50）。
  const apexBridgeDown = 'apex-bridge-provider-down';

  /// 500 字整（与 T14 判据同一把尺：长度钉死 500，不写「大约 500」）。
  String promptOf500() {
    const unit = '请核对桥在线状态并列出可用工具';
    var s = '';
    while (s.length < 500) {
      s += unit;
    }
    return s.substring(0, 500);
  }

  const completeAnswer = '桥在线；此刻可用工具 50 个，其中界面工具 11 个可调，'
      'exec 已提权到 sidecar。以上为完整回答。';

  late Directory auditDir;
  final calls = <MethodCall>[];
  var lastRoute = 'direct';

  /// 反代提示里不允许出现的字样。降级不是成功——写了就是谎称。
  bool saysSuccess(String text) => text.contains('成功');

  setUp(() {
    auditDir = Directory.systemTemp.createTempSync('khy_d15_audit');
    AuditLog.useDirectoryForTest(auditDir);
    calls.clear();
    lastRoute = 'direct';
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (call.method == 'amooAsk') {
        // 路由听调用方的：声明了 screen 才走读屏。这样「不声明就重发」
        // 必然又落回坏掉的 apex 上，测试看得见。
        lastRoute = (call.arguments is Map &&
                (call.arguments as Map)['route'] == 'screen')
            ? 'screen'
            : 'direct';
        return <String, Object?>{
          'ok': true,
          'job': lastRoute == 'screen' ? 'a11y-1' : 'apex-1',
          'state': 'running',
          'via': lastRoute,
        };
      }
      if (call.method == 'amooAskResult') {
        if (lastRoute == 'direct') {
          // 直连这一轮的运输层故障：哨兵进 error，身份仍是 direct。
          return <String, Object?>{
            'ok': true,
            'state': 'failed',
            'error': apexBridgeDown,
            'via': 'direct',
          };
        }
        // 换路之后这一轮重新开始：先 done（读屏一次读全，不演 running）。
        return <String, Object?>{
          'ok': true,
          'state': 'done',
          'reply': completeAnswer,
          'via': 'screen',
        };
      }
      return <String, Object?>{};
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    AuditLog.useDirectoryForTest(null);
    try {
      auditDir.deleteSync(recursive: true);
    } catch (_) {}
  });

  List<String> readAuditLines() {
    final out = <String>[];
    for (final f in auditDir.listSync().whereType<File>()) {
      if (!f.path.endsWith('.jsonl')) continue;
      out.addAll(f.readAsLinesSync().where((l) => l.trim().isNotEmpty));
    }
    return out;
  }

  /// 跑完「ask → poll 到底」的闭环，返回最后一个 outcome。
  /// 上限钉死 5 次 poll——判据不许靠「多等一会」蒙过去。
  Future<AmooAskOutcome> askThenPollToEnd() async {
    await AmooChatService.ask(promptOf500());
    var outcome = await AmooChatService.poll();
    var n = 1;
    while (outcome.state != AmooAskState.done &&
        outcome.state != AmooAskState.failed &&
        n < 5) {
      outcome = await AmooChatService.poll();
      n++;
    }
    return outcome;
  }

  group('T15 降级提示（客户端契约）', () {
    test('直连断：outcome 带可读降级提示，statusLine 也带', () async {
      // 第一次 poll 就撞上哨兵 → 客户端自己降级重发；返回的 outcome 是
      // 重发后的 running 态（读屏路由）。
      await AmooChatService.ask(promptOf500());
      final degraded = await AmooChatService.poll();

      expect(degraded.via, AmooTransport.screen,
          reason: '这一轮已经改走读屏，身份不许还是 direct');
      expect(degraded.ok, isTrue, reason: '降级重发接单了，不是失败');
      expect(degraded.state, AmooAskState.running);

      expect(degraded.degradeNotice, isNotEmpty,
          reason: '降级必须带一句用户可见的提示：只说 via=screen，'
              '用户根本看不到这个字段——看不到的就是没提示');
      expect(degraded.degradeNotice, contains('降级'));
      expect(degraded.degradeNotice, contains('读屏'));
      expect(saysSuccess(degraded.degradeNotice), isFalse,
          reason: '降级是换了条更慢的路，不是又一次成功');
      expect(degraded.statusLine, contains('降级'),
          reason: '状态行要能让用户看见这次降级（RUNTIME-002）');
      expect(saysSuccess(degraded.statusLine), isFalse);
    });

    test('降级日志写清为什么换，且全程无「成功」字样', () async {
      final outcome = await askThenPollToEnd();
      expect(outcome.state, AmooAskState.done,
          reason: '降级之后必须真的拿到回答，不许把换路当成失败');
      expect(outcome.reply, completeAnswer, reason: '要的是完整回答');

      final audit = readAuditLines();
      expect(audit, isNotEmpty, reason: '降级必须有日志，不能只有内存里的自称');
      final joined = audit.join('\n');
      expect(joined, contains(apexBridgeDown), reason: '日志必须写清为什么降级');
      expect(joined, contains('screen'));
      for (final line in audit) {
        expect(saysSuccess(line), isFalse,
            reason: '降级不是成功：日志里出现「成功」用户就没法解释'
                '为什么这次要开无障碍。命中行：$line');
      }
    });

    test('提示与回复不互相顶掉：降级后仍拿到完整回复', () async {
      final outcome = await askThenPollToEnd();
      expect(outcome.state, AmooAskState.done);
      expect(outcome.reply, completeAnswer);
      // 500 字 prompt 原样送达过两次（首发 + 降级重发），不许截断。
      final prompts = calls
          .where((c) => c.method == 'amooAsk')
          .map((c) => (c.arguments as Map)['prompt'].toString())
          .toList();
      expect(prompts.length, 2);
      for (final p in prompts) {
        expect(p.length, 500, reason: '降级重发也必须带同一段 500 字 prompt');
      }
    });

    test('直连没坏：没有降级提示，也没有「降级」字样', () async {
      // 同一套 mock 下把直连修好：poll 直接 done（via=direct）。
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        if (call.method == 'amooAsk') {
          return <String, Object?>{
            'ok': true,
            'job': 'apex-ok',
            'state': 'running',
            'via': 'direct',
          };
        }
        if (call.method == 'amooAskResult') {
          return <String, Object?>{
            'ok': true,
            'state': 'done',
            'reply': completeAnswer,
            'via': 'direct',
          };
        }
        return <String, Object?>{};
      });

      await AmooChatService.ask(promptOf500());
      final outcome = await AmooChatService.poll();
      expect(outcome.state, AmooAskState.done);
      expect(outcome.via, AmooTransport.direct);
      expect(outcome.degradeNotice, isEmpty,
          reason: '直连没坏就提示降级，是把没发生的事说成发生了');
      expect(outcome.statusLine, isNot(contains('降级')));
    });
  });

  group('T15 driver 层：提示经 DriverStatus 上屏', () {
    /// 假网关：ask 回放「降级重发后」的回执（via=screen），poll 一次 done。
    /// 提示不手填——它由 AmooAskOutcome.degradeNotice 从 via 派生，测的是
    /// driver 把提示转成通用事件的那段映射。
    _DegradedGateway degradedGateway() => _DegradedGateway();

    test('降级提示转成 DriverStatus，渲染行可读且无「成功」', () async {
      final d = AmooDriver(
        gateway: degradedGateway(),
        pollInterval: Duration.zero,
      );
      final events = await d
          .send(UserTurn(sessionId: 's', turnId: 't', text: promptOf500()))
          .toList();

      final statuses = events.whereType<DriverStatus>().toList();
      expect(statuses, isNotEmpty, reason: 'driver 必须把降级提示转成状态事件');
      final rendered =
          statuses.map((s) => driverStatusLine(s).text).join('\n');
      expect(rendered, contains('降级'),
          reason: '提示要能经渲染层状态行映射器画出来，用户才看得见');
      expect(rendered, contains('读屏'));
      for (final line in rendered.split('\n')) {
        expect(line.trim(), isNotEmpty, reason: '状态行不许是空气泡');
        expect(saysSuccess(line), isFalse);
      }

      // 降级不是失败：这一轮照常答完。
      final finished = events.whereType<DriverFinished>().toList();
      expect(finished.single.reason, 'completed');
      final content = events
          .whereType<DriverDelta>()
          .where((e) => e.kind == 'content')
          .map((e) => e.text)
          .join();
      expect(content, completeAnswer, reason: '降级后仍要完整回复');
      expect(events.whereType<DriverFailed>(), isEmpty,
          reason: '换了条路答上来不是失败');
    });

    test('渲染层认不出的状态 code 原样出 detail（新词汇不加渲染分支）', () async {
      // 提示事件的 code 不在 waiting/connecting/degraded/timed_out/failed
      // 五枝 switch 里——它必须走 default 分支把 detail 原样画出来。
      // 这就是「新增 driver 不改渲染代码」在事件词汇表侧的对应物。
      final d = AmooDriver(
        gateway: degradedGateway(),
        pollInterval: Duration.zero,
      );
      final events = await d
          .send(const UserTurn(sessionId: 's', turnId: 't', text: 'q'))
          .toList();
      final noticeStatus = events
          .whereType<DriverStatus>()
          .firstWhere((s) => s.detail.contains('降级'));
      expect(noticeStatus.code, 'route_degraded');
      final line = driverStatusLine(noticeStatus);
      expect(line.text, contains('降级'));
      expect(line.text, isNotEmpty);
    });
  });
}

/// 回放「降级重发后」现场的一次会话：ask 接单（via=screen），poll 一次 done。
class _DegradedGateway implements AmooGateway {
  _DegradedGateway();

  int polls = 0;

  @override
  Future<AmooAskOutcome> ask(String prompt, {int timeoutMs = 420000}) async {
    return AmooAskOutcome(
      ok: true,
      state: AmooAskState.running,
      job: 'a11y-1',
      via: AmooTransport.screen,
    );
  }

  @override
  Future<AmooAskOutcome> poll() async {
    polls++;
    return AmooAskOutcome(
      ok: true,
      state: AmooAskState.done,
      reply: '桥在线；此刻可用工具 50 个，其中界面工具 11 个可调，'
          'exec 已提权到 sidecar。以上为完整回答。',
      via: AmooTransport.screen,
    );
  }

  @override
  Future<bool> stop() async => true;
}
