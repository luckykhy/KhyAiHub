import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/amoo_chat_service.dart';
import 'package:khy_os_client/core/services/audit_log.dart';

/// B4「直连 ChatTarget」完成判定（TASK.md §4 B4、contract.md K-00/K-00b/K-90）。
///
/// 判据三条里，①「500 字 prompt 得完整回答」与 ③「两路径要点一致」的真机部分在
/// device/B4.md（要关系统无障碍、要锁屏，主机上造不出来）；这里钉的是它们在主机上
/// 可判的那一半，加上 ②「断直连能自动降级且有日志」的客户端契约：
///
///  1. 每一轮必须带传输身份：这一轮是谁答的（direct / screen）必须说得出来；
///     原生没说就落 unknown，不许冒称 direct。AMOO-INTEGRATION.md §二 通道 A 自己
///     写着「via 字段是命门——最后一级会"成功"返回而什么都没做」。
///  2. 直连桥断（apex 哨兵）时客户端自己改走读屏路由重发，调用方不该被要求改代码；
///     且传输故障不许以 failed 冒到调用方脸上——amoo_task_card.dart:230 一看见非
///     running 就停轮询并把这一轮判失败，那次降级就永远到不了。
///  3. 反过来：amoo 自己没答好（不是桥断了）不许伪装成降级——不换路、不盲试，
///     失败原样上抛。
///  4. 切换必须落审计日志：原因（哨兵）与两条路的名字，同一次记录里。
///
/// 接缝（K-00b 复用不重写）：只钉 [AmooChatService] 这一对既有入口——
/// amoo_task_card.dart:164/:208 与 builtin_tools.dart:1004/:1016 都在调它。
/// [AmooTransport] 与 [AmooAskOutcome] 的 via 字段必须能经
/// lib/core/services/amoo_chat_service.dart 这个文件 reach 到（同文件定义或
/// re-export 均可），不新开一个要求调用方改 import 的模块。
///
/// 首败（2026-11-13 实测，原始输出见 device/B4.md §S1）：本文件对当前代码编译不过
/// ——AmooTransport 不存在、AmooAskOutcome 没有 via 字段。这就是 B4 的红。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.khyos.khy_os_client/device');

  /// apex 桥自己没起来时原生侧写的机器哨兵（AmooApexLink.kt:50）。
  /// 拿它当「直连这条路断了」的判据：它是传输层自己的故障，与「amoo 这一轮没答好」
  /// 是两件事——后者不该触发降级，否则一次普通的答不上来会被伪装成换了条路重问。
  const apexBridgeDown = 'apex-bridge-provider-down';

  /// amoo 没答好时的原生错误（AmooApexLink.kt:186 的原话形态）：不是桥断了。
  const amooWindowGone = '读不到 Amoo 的窗口';

  /// 500 字整。判据写的是「500 字 prompt」，长度钉死 500，不写「大约 500」：
  /// 判据数值必须可复算。
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
  var apexHealthy = false;
  var omitVia = false;
  var viaOverride = '';
  var amooAnswerBad = false;
  var a11yReads = 0;
  var lastJob = '';

  /// 这次 ask 有没有声明走读屏路由。认形状不认名字：方法名含 screen/a11y，或参数里
  /// route/via/transport/prefer 之一的值说 screen/a11y/accessibility。
  /// 都不算的只有一种——不声明就重发，那是在已经坏掉的那条路上盲试，不是降级。
  bool declaresScreenRoute(MethodCall call) {
    final m = call.method.toLowerCase();
    if (m.contains('screen') || m.contains('a11y')) return true;
    final args = call.arguments;
    if (args is! Map) return false;
    for (final e in args.entries) {
      final k = e.key.toString().toLowerCase();
      final v = '${e.value}'.toLowerCase();
      final namesRoute = k.contains('route') ||
          k.contains('via') ||
          k.contains('transport') ||
          k.contains('prefer');
      final saysScreen =
          v.contains('screen') || v.contains('a11y') || v.contains('accessibility');
      if (namesRoute && saysScreen) return true;
    }
    return false;
  }

  /// 原生结果 map。两个旋钮分别造「原生没这个键」与「原生给了个奇怪值」两种现场，
  /// 免得判定只能防一种漂移。
  Map<String, Object?> nativeResult(Map<String, Object?> out) {
    if (viaOverride.isNotEmpty) out['via'] = viaOverride;
    if (omitVia) out.remove('via');
    return out;
  }

  List<String> readAuditLines() {
    final out = <String>[];
    for (final f in auditDir.listSync().whereType<File>()) {
      if (!f.path.endsWith('.jsonl')) continue;
      out.addAll(f.readAsLinesSync().where((l) => l.trim().isNotEmpty));
    }
    return out;
  }

  setUp(() {
    auditDir = Directory.systemTemp.createTempSync('khy_b4_audit');
    AuditLog.useDirectoryForTest(auditDir);
    calls.clear();
    apexHealthy = false;
    omitVia = false;
    viaOverride = '';
    amooAnswerBad = false;
    a11yReads = 0;
    lastJob = '';
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (call.method == 'amooAsk') {
        // 路由听调用方的：声明了读屏就走 a11y，否则走 apex。这样「不声明就重发」
        // 必然又落回坏掉的 apex 上，测试看得见。
        final screen = declaresScreenRoute(call);
        lastJob = screen ? 'a11y-${calls.length}' : 'khy-apex-${calls.length}';
        return <String, Object?>{
          'ok': true,
          'job': lastJob,
          'state': 'running',
          'via': screen ? 'screen' : 'direct',
        };
      }
      if (call.method == 'amooAskResult') {
        final onA11y = lastJob.startsWith('a11y-');
        if (!onA11y && amooAnswerBad) {
          // amoo 这一轮没答好：不是桥断了，错误里没有哨兵。
          return nativeResult(<String, Object?>{
            'ok': true,
            'state': 'failed',
            'error': amooWindowGone,
            'via': 'direct',
          });
        }
        if (!onA11y && !apexHealthy) {
          // 直连这一轮的运输层故障：哨兵进 error，身份仍是 direct。
          return nativeResult(<String, Object?>{
            'ok': true,
            'state': 'failed',
            'error': apexBridgeDown,
            'via': 'direct',
          });
        }
        if (onA11y && a11yReads < 1) {
          // 换路之后这一轮重新开始：先 running，再 done。
          a11yReads++;
          return nativeResult(
              <String, Object?>{'ok': true, 'state': 'running', 'via': 'screen'});
        }
        return nativeResult(<String, Object?>{
          'ok': true,
          'state': 'done',
          'reply': completeAnswer,
          'via': onA11y ? 'screen' : 'direct',
        });
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

  test('直连桥断了：客户端自己改走读屏路由，日志写清为什么换', () async {
    final started = await AmooChatService.ask(promptOf500());
    expect(started.ok, isTrue, reason: 'apex 接单成功，故障只会在轮询时暴露');
    final delivered = (calls.first.arguments as Map)['prompt'];
    expect(delivered, promptOf500(), reason: '500 字 prompt 必须整段送达，不许截断');
    expect('$delivered'.length, 500);

    // 降级之后客户端可能要自己重发再读，一次 poll 不必然是终态（阻塞式与采样式
    // 实现都允许），所以这里是闭环；上限钉死 5 次——判据不许靠「多等一会」蒙过去。
    final states = <AmooAskState>[];
    var outcome = await AmooChatService.poll();
    states.add(outcome.state);
    while (outcome.state != AmooAskState.done && states.length <= 5) {
      outcome = await AmooChatService.poll();
      states.add(outcome.state);
    }

    expect(states, isNot(contains(AmooAskState.failed)),
        reason: '传输故障一以 failed 冒出来，amoo_task_card.dart:230 就停轮询判失败，'
            '那次降级永远到不了');
    expect(outcome.state, AmooAskState.done, reason: '降级之后必须真的拿到回答');
    expect(outcome.reply, completeAnswer, reason: '要的是完整回答，不是半句');
    expect(outcome.via, AmooTransport.screen,
        reason: '这一轮是读屏路径答的，界面不许把它显示成直连');

    final asks = calls.where((c) => c.method == 'amooAsk').toList();
    expect(asks.length, 2,
        reason: '自动降级 = 客户端自己改走读屏路由重发，调用方不该被要求改代码');
    expect(declaresScreenRoute(asks.last), isTrue,
        reason: '第二次必须声明走读屏路由；不声明就重发等于在坏掉的那条路上盲试');
    expect((asks.last.arguments as Map)['prompt'], promptOf500(),
        reason: '降级重发也必须带同一段 500 字 prompt');

    final audit = readAuditLines();
    expect(audit, isNotEmpty, reason: '降级必须有日志，不能只有内存里的自称');
    final joined = audit.join('\n');
    expect(joined, contains(apexBridgeDown), reason: '日志必须写清为什么降级');
    expect(joined, contains('direct'));
    expect(joined, contains('screen'));
  });

  test('amoo 自己没答好（不是桥断了）：不伪装成降级，原样上抛失败', () async {
    apexHealthy = true;
    amooAnswerBad = true;
    final started = await AmooChatService.ask(promptOf500());
    expect(started.ok, isTrue);

    final outcome = await AmooChatService.poll();
    expect(outcome.state, AmooAskState.failed);
    expect(outcome.error, contains(amooWindowGone),
        reason: '原生给的原话要上得去，界面才知道下一步是去开 amoo');

    expect(calls.where((c) => c.method == 'amooAsk').length, 1,
        reason: '不是传输故障就换路重发，是把一次答不上来伪装成降级，还多花用户一轮时间');
    expect(readAuditLines().join('\n'), isNot(contains('screen')),
        reason: '没有发生过切换，日志里就不该出现读屏路由');
  });

  test('原生没说这一轮是谁答的：一律 unknown，不许冒称直连', () async {
    apexHealthy = true;
    omitVia = true;
    final started = await AmooChatService.ask(promptOf500());
    expect(started.ok, isTrue);

    final noKey = await AmooChatService.poll();
    expect(noKey.state, AmooAskState.done);
    expect(noKey.via, AmooTransport.unknown,
        reason: '没有传输身份的结果不许被说成直连——那是把没测说成通过');

    omitVia = false;
    viaOverride = 'apex';
    final oddValue = await AmooChatService.poll();
    expect(oddValue.via, AmooTransport.unknown,
        reason: '将来原生改了写法，先落 unknown，也别猜成 direct');
  });

  test('直连没坏：不多此一举降级，身份就是 direct', () async {
    apexHealthy = true;
    final started = await AmooChatService.ask(promptOf500());
    expect(started.ok, isTrue);

    final outcome = await AmooChatService.poll();
    expect(outcome.state, AmooAskState.done);
    expect(outcome.reply, completeAnswer);
    expect(outcome.via, AmooTransport.direct);

    expect(calls.where((c) => c.method == 'amooAsk').length, 1,
        reason: '直连没坏就改走读屏，是把用户的时间花在更慢的那条路上');
    expect(readAuditLines().join('\n'), isNot(contains('screen')),
        reason: '没有发生过切换，日志里就不该出现读屏路由');
  });

  test('传输身份的线上市值只有两个，别的不认', () {
    expect(AmooTransport.parse('direct'), AmooTransport.direct);
    expect(AmooTransport.parse('screen'), AmooTransport.screen);
    expect(AmooTransport.parse(null), AmooTransport.unknown);
    expect(AmooTransport.parse(''), AmooTransport.unknown);
    expect(AmooTransport.parse('apex'), AmooTransport.unknown);
  });
}
