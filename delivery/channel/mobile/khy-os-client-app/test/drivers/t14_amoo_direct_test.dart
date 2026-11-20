import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/drivers/amoo_driver.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/services/amoo_chat_service.dart';
import 'package:khy_os_client/core/services/audit_log.dart';
import 'package:khy_os_client/ui/render/content_tier.dart';

/// D 阶段 T14 判定的主机可判一半：直连路由下，500 字 prompt 得完整渲染。
///
/// 判据全文（任务书）：「锁屏 + Amoo 不在前台 + 无障碍关闭：发 500 字 prompt
/// 得到完整渲染，info.driver=amoo-direct」。
///
/// 拆开看，主机上能判的是：
///   · 500 字 prompt 整段送达、回复完整渲染（本文件，mock 通道）；
///   · info.driver=amoo-direct（driverNow 的 JVM 实测，见
///     red/D-T14-jvm-green.txt 的夹具输出——apex 桥在位 → amoo-direct）；
/// 造不出来的是设备现场三条件（锁屏/Amoo 非前台/无障碍关闭）与 info 的活读数，
/// 那是 harness/t14_check.mjs 的 live 判定（本阶段设备离线，未能执行，
/// 失败原文见 red/D-T14-red.txt）。
///
/// 为什么直连路由与无障碍无关值得在这里钉：T14 的三个现场条件里最要紧的
/// 正是「无障碍关闭」——读屏路由没有无障碍就拒绝服务，而 apex 直连不经过
/// 无障碍。客户端这条路只要还在问「无障碍开没开」，T14 的现场就永远答不上。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');

  /// 500 字整（判据写「500 字」，长度钉死 500，不写「大约 500」）。
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

  setUp(() {
    auditDir = Directory.systemTemp.createTempSync('khy_d14_audit');
    AuditLog.useDirectoryForTest(auditDir);
    calls.clear();
    // apex 直连健康：ask 接单、poll 一次 done。路由恒 direct——
    // 直连不依赖无障碍，也不依赖 Amoo 在前台（T14 的现场条件）。
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (call.method == 'amooAsk') {
        return <String, Object?>{
          'ok': true,
          'job': 'apex-1',
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
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    AuditLog.useDirectoryForTest(null);
    try {
      auditDir.deleteSync(recursive: true);
    } catch (_) {}
  });

  group('T14 直连路由：500 字 prompt 得完整渲染', () {
    test('500 字整段送达，回复完整渲染（decideTier 不截断）', () async {
      final started = await AmooChatService.ask(promptOf500());
      expect(started.ok, isTrue);
      final delivered = (calls.first.arguments as Map)['prompt'].toString();
      expect(delivered.length, 500, reason: '500 字 prompt 必须整段送达');
      expect(delivered, promptOf500());

      final outcome = await AmooChatService.poll();
      expect(outcome.state, AmooAskState.done);
      expect(outcome.via, AmooTransport.direct, reason: '这一轮是直连答的');
      expect(outcome.reply, completeAnswer, reason: '要的是完整回答，不是半句');

      // 渲染：完整回复经三档判定后一字不差（L3 纯文本档）。
      final decision = decideTier(outcome.reply);
      expect(decision.tier, ContentTier.l3);
      expect(decision.debugReason, isNull, reason: '完整回复不该触发降级判定');
    });

    test('直连路由不问无障碍：ask 的路由声明是 direct', () async {
      await AmooChatService.ask(promptOf500());
      final route = (calls.first.arguments as Map)['route'].toString();
      expect(route, 'direct',
          reason: '默认走 apex 直连——T14 的现场条件正是「无障碍关闭」');
    });

    test('driver 层：直连一轮完整会话事件（waiting → delta → finished）', () async {
      final gw = _DirectGateway(reply: completeAnswer);
      final d = AmooDriver(gateway: gw, pollInterval: Duration.zero);
      final events = await d
          .send(UserTurn(sessionId: 's', turnId: 't', text: promptOf500()))
          .toList();

      expect(events.first, isA<DriverStatus>());
      final content = events
          .whereType<DriverDelta>()
          .where((e) => e.kind == 'content')
          .map((e) => e.text)
          .join();
      expect(content, completeAnswer, reason: '完整回复一个 delta 到位');
      expect(decideTier(content).tier, ContentTier.l3);
      expect(events.whereType<DriverFinished>().single.reason, 'completed');
      expect(events.whereType<DriverFailed>(), isEmpty);
      // 直连健康时没有任何降级提示。
      for (final s in events.whereType<DriverStatus>()) {
        expect(driverStatusLine(s).text, isNot(contains('降级')));
      }
    });
  });
}

/// apex 直连健康的假网关：ask 接单（direct），poll 一次 done。
class _DirectGateway implements AmooGateway {
  _DirectGateway({required this.reply});

  final String reply;
  int polls = 0;

  @override
  Future<AmooAskOutcome> ask(String prompt, {int timeoutMs = 420000}) async {
    return AmooAskOutcome(
      ok: true,
      state: AmooAskState.running,
      job: 'apex-1',
      via: AmooTransport.direct,
    );
  }

  @override
  Future<AmooAskOutcome> poll() async {
    polls++;
    return AmooAskOutcome(
      ok: true,
      state: AmooAskState.done,
      reply: reply,
      via: AmooTransport.direct,
    );
  }

  @override
  Future<bool> stop() async => true;
}
