// khy-canary: Khy-20261101-081-NPMK6T63
import 'package:flutter/services.dart';

import '../db/amoo_turn.dart';
import '../security/guard.dart';
import 'app_logger.dart';
import 'audit_log.dart';

/// amoo 反代客户端（本机，不经过 PC 桥）。
///
/// 与 [AmooService] 的分工：那个只做「把文本交给 amoo」的单次投递，拿不到回复；
/// 这个走桥的 ask/askResult/stop 三步协议，能把 amoo 的回复读回来，所以首页能直接
/// 在这里和 amoo 对话。
///
/// 为什么是三条通道而不是一条阻塞调用：amoo 想一轮约 6 分钟，而桥的 socket 超时
/// 只有 20 秒。一条阻塞调用必然超时；拆开发起/轮询/中断，每条都在毫秒级返回。
///
/// 诚实边界：本类只报告原生层说的话。原生说 failed 就报 failed，不会替它猜
/// 「也许 amoo 没收到」；reply 是 amoo 最新气泡的原始文本，未解析、未摘要。
///
/// 失败可观测：三条通道各自 catch 异常并返回失败 outcome，但**每一次都留日志**。
/// 不留的话，「原生壳太旧没有这三个通道」和「通道正常但这次失败了」在界面上
/// 都只是一句"调用失败"，而前者意味着整套反代根本没接上——那必须能查。
class AmooChatService {
  static const MethodChannel _channel =
      MethodChannel('com.khyos.khy_os_client/device');

  static final _log = AppLogger();

  static const Duration _callTimeout = Duration(seconds: 8);

  /// apex 直连这条路自己断了时，原生侧写进 error 的机器哨兵。
  /// 原值在 AmooApexLink.kt:50（ERR_PROVIDER_ERROR），两侧必须逐字一致——
  /// 判据用整串相等，不用「包含 apex」这类前缀：那会把「读不到 Amoo 的窗口」
  /// 也框进来，而后者的下一步是把 amoo 调到前台，不是换条路。
  static const _apexBridgeDown = 'apex-bridge-provider-down';

  /// 这一轮已经改走读屏路由没有。只降一级：读屏也断的话再降就是死循环。
  static var _onScreenRoute = false;

  /// 当前这一轮的 prompt。降级重发要带同一段原文——判据是「500 字 prompt 得
  /// 完整回答」，让用户把 500 字再打一遍不叫降级。
  static var _roundPrompt = '';

  /// 本轮提问的发起时刻（epoch ms）。原生不报步数，状态行至少要能报"等了多久"。
  static var _roundAskedAtMs = 0;

  static AmooAskOutcome _unavailable(String method, Object e) {
    _log.w(LogCategory.system, 'amoo 反代通道调用失败',
        details: <String, dynamic>{
          'method': method,
          // MissingPluginException 特指原生壳没有这个方法——那意味着 APK 太旧，
          // 整套反代没接上，和一次普通失败不是一回事，日志里要能分开。
          'missing_plugin': e is MissingPluginException,
          'error': '$e',
        });
    return AmooAskOutcome(
      ok: false,
      code: AmooAskFailure.unavailable,
      message: '调用失败：${e is PlatformException ? (e.message ?? e.code) : e}',
    );
  }

  /// 发起一次提问。
  ///
  /// [timeoutMs] 是给 amoo 的思考预算，原生层会夹在 15s..1800s 之间；
  /// 默认 7 分钟（amoo 实测约 6 分钟）。
  ///
  /// [route] 声明这一轮走哪条路。调用方一般不传（默认直连 apex 桥）；只有降级
  /// 重发时传 [AmooTransport.screen]——那时 apex 已经断了，再走它只是把同一
  /// 故障重演一遍，还多花一轮预算。
  static Future<AmooAskOutcome> ask(String prompt,
      {int timeoutMs = 420000, AmooTransport route = AmooTransport.direct}) async {
    final body = prompt.trim();
    if (body.isEmpty) {
      return const AmooAskOutcome(
        ok: false,
        code: AmooAskFailure.emptyPrompt,
        message: '请输入内容',
      );
    }
    // L1 闸门：注入/抽取尝试不出通道。amoo 会老老实实回答被套的那句话，
    // 而那句回答就是泄露本身——所以在投递之前拦，拦了就不投。
    // 良性继续（"继续"/"ok"）永远放行，冷却不会把它吞掉。
    final verdict = SecurityGuard.instance.analyzeInput(body);
    if (!verdict.safe) {
      // log_store 的 LogCategory.security 由接线阶段新增；在那之前拦截
      // 事件落在 system 里，可检索、不丢。
      _log.w(LogCategory.system, 'amoo 提问被安全防护拦截',
          details: <String, dynamic>{
            'threat': verdict.threat,
            'severity': verdict.severity?.name,
            'matches': verdict.allMatches,
          });
      return AmooAskOutcome(
        ok: false,
        code: AmooAskFailure.refused,
        message: verdict.refusal ?? '请求被安全策略拦截，请换个方式提问。',
      );
    }
    try {
      final result = await _channel
          .invokeMethod('amooAsk', {
            'prompt': body,
            'timeoutMs': timeoutMs,
            'route': route.name,
          }).timeout(_callTimeout);
      if (result is! Map) {
        return const AmooAskOutcome(
          ok: false,
          code: AmooAskFailure.unavailable,
          message: '原生层未返回结果',
        );
      }
      if (result['ok'] == true) {
        // prompt 与路由在这一轮落地：poll() 撞上 apex 哨兵时要凭它重发，
        // 而重发必须带同一段原文、并且声明换到了读屏路由——不声明就重发，
        // 等于在已经坏掉的那条路上盲试。
        _roundPrompt = body;
        _roundAskedAtMs = DateTime.now().millisecondsSinceEpoch;
        _onScreenRoute = route == AmooTransport.screen;
        return AmooAskOutcome(
          ok: true,
          job: result['job']?.toString() ?? '',
          state: AmooAskState.parse(result['state']?.toString()),
          via: AmooTransport.parse(result['via']?.toString()),
          askedAtMs: _roundAskedAtMs,
        );
      }
      return AmooAskOutcome(
        ok: false,
        code: AmooAskFailure.parse(result['code']?.toString()),
        message: result['message']?.toString() ?? '',
      );
    } on PlatformException catch (e) {
      return _unavailable('amooAsk', e);
    } catch (e) {
      return _unavailable('amooAsk', e);
    }
  }

  /// 轮询一次。失败也返回一个 outcome（state=failed），不抛。
  ///
  /// 唯一的例外：apex 直连这条路自己断了（error 带 [_apexBridgeDown]）。那种
  /// failed 不交出去，这里自己改走读屏路由重发。理由不是替用户省事——
  /// amoo_task_card.dart:230 一看见非 running 就停轮询并把这一轮判失败，
  /// 冒一个 failed 出去，那次降级就永远到不了：用户看到的是失败，而系统本来
  /// 能自己答上这一轮。
  static Future<AmooAskOutcome> poll() async {
    final outcome = await _pollOnce();
    final why = _degradationReason(outcome);
    if (why == null) return outcome;
    return _degradeToScreen(why);
  }

  static Future<AmooAskOutcome> _pollOnce() async {
    try {
      final result =
          await _channel.invokeMethod('amooAskResult').timeout(_callTimeout);
      if (result is! Map) {
        return const AmooAskOutcome(
          ok: false,
          code: AmooAskFailure.unavailable,
          message: '原生层未返回状态',
        );
      }
      return AmooAskOutcome(
        ok: true,
        state: AmooAskState.parse(result['state']?.toString()),
        reply: result['reply']?.toString() ?? '',
        error: result['error']?.toString() ?? '',
        // 这一轮是谁答的。原生没说（壳太旧）或说了个不认得的写法时落 unknown，
        // 不许冒称直连——那是把没测说成通过。
        via: AmooTransport.parse(result['via']?.toString()),
        // 原生层（MainActivity.amooAskResult）今天不返回这个键，所以它恒为空串。
        // 仍然接上，是为了让 Dart 侧的形状与另两条路（网关 / khy-os 后端）对齐：
        // 那两条有思维链，这条没有——差别在原生侧读不到，不该由调用方各自猜。
        reasoning: result['reasoning']?.toString() ?? '',
        askedAtMs: _roundAskedAtMs,
      );
    } on PlatformException catch (e) {
      return _unavailable('amooAskResult', e);
    } catch (e) {
      return _unavailable('amooAskResult', e);
    }
  }

  /// 这一轮要不要降级。null = 原样上交。
  ///
  /// 三个条件同时成立才降，缺一个都不降：
  ///   · 是传输层自己的故障——判据是 error 里的 apex 哨兵，不是 state==failed。
  ///     「amoo 这一轮没答好」同样是 failed，但它的下一步是把 amoo 调到前台，
  ///     不是换条路。混在一起的后果是每次答不上来都被伪装成降级，还多花一轮时间。
  ///   · 还没降过。读屏也断的话再降就是死循环。
  ///   · 手里有原 prompt。没有就无从重发，只能上交失败。
  static String? _degradationReason(AmooAskOutcome o) {
    if (!o.ok || o.state != AmooAskState.failed) return null;
    if (_onScreenRoute) return null;
    if (_roundPrompt.isEmpty) return null;
    if (!o.error.contains(_apexBridgeDown)) return null;
    return o.error;
  }

  /// 改走读屏路由重发同一段 prompt，并把「为什么换、从哪条换到哪条」写进
  /// 审计与运行日志——同一批字段写两处：审计可按时间查（contract K-83），
  /// 运行日志给现场排查用。只写一处的话，另一个面板上这次切换是隐形的。
  static Future<AmooAskOutcome> _degradeToScreen(String reason) async {
    final prompt = _roundPrompt;
    _onScreenRoute = true;
    await AuditLog.instance.record(
      AuditSource.system,
      'amoo 反代降级',
      '',
      detail: 'direct → screen：直连 apex 桥断开（$reason），'
          '改走读屏路由重发同一段 prompt',
    );
    _log.w(LogCategory.system, 'amoo 反代降级到读屏路由',
        details: <String, dynamic>{
          'from': AmooTransport.direct.name,
          'to': AmooTransport.screen.name,
          'reason': reason,
          'prompt_len': prompt.length,
        });
    final resent = await ask(prompt, route: AmooTransport.screen);
    if (!resent.ok) {
      // 重发也没出去：这一轮确实断了。失败照实上缴——不因为换过路就假装还在跑。
      return AmooAskOutcome(
        ok: false,
        code: resent.code,
        message: resent.message,
        state: AmooAskState.failed,
        via: AmooTransport.screen,
      );
    }
    return resent;
  }

  /// 中断。已经发出去的提问收不回来，所以只说「已请求中断」。
  static Future<bool> stop() async {
    try {
      final result = await _channel
          .invokeMethod('amooAskStop')
          .timeout(_callTimeout);
      return result is Map && result['ok'] == true;
    } catch (e) {
      _log.w(LogCategory.system, 'amoo 反代中断调用失败',
          details: <String, dynamic>{
            'method': 'amooAskStop',
            'missing_plugin': e is MissingPluginException,
            'error': '$e',
          });
      return false;
    }
  }
}

enum AmooAskState {
  idle,
  running,
  done,
  failed;

  static AmooAskState parse(String? raw) {
    switch (raw) {
      case 'running':
        return AmooAskState.running;
      case 'done':
        return AmooAskState.done;
      case 'failed':
        return AmooAskState.failed;
      default:
        return AmooAskState.idle;
    }
  }
}

/// 这一轮是谁答的：直连（apex 桥）还是读屏（无障碍）。
///
/// 为什么要它：两条路的答案在界面上并排给用户看，而它们依赖的前置条件、快慢
/// 全都不同（直连要 apex 桥在跑；读屏要无障碍开着、amoo 在前台）。不知道答案
/// 从哪条路来，就没法解释「为什么这次快了/慢了」，降级日志也没有可指的证据。
/// AMOO-INTEGRATION.md §二 通道 A 自己写着「via 字段是命门——最后一级会"成功"
/// 返回而什么都没做」。
///
/// 线上市值只有两个，别的一律 [unknown]：原生没说、或说了个不认得的写法，
/// 都不许猜成 direct——那是把没测说成通过。
enum AmooTransport {
  unknown,
  direct,
  screen;

  static AmooTransport parse(String? raw) {
    switch (raw) {
      case 'direct':
        return AmooTransport.direct;
      case 'screen':
        return AmooTransport.screen;
      default:
        return AmooTransport.unknown;
    }
  }
}

enum AmooAskFailure {
  /// amoo 不在前台。此时提问没有真的发出去——先打开 amoo。
  amooNotForeground,

  /// 已经有一个提问在跑。单飞，第二个会被拒。
  singleFlight,

  /// 前置条件没满足，或安全防护拦截，提问没有发出去。
  ///
  /// 与 [singleFlight] 分开是因为两者的下一步完全不同：单飞要等，
  /// 预检拒绝要去开条件（最常见的是无障碍服务没开），安全拦截要换个问法。
  /// 拒绝原因的原话在 [AmooAskOutcome.message] 里：预检拒绝时是原生层那句，
  /// 安全拦截时是 SecurityGuard 的 refusal（冷却那档还带剩余秒数）。
  refused,

  /// 上一笔提问卡死了，单飞锁已被原生层自动释放，重试即可。
  ///
  /// 为什么单独一档而不是并进 [refused]：两者在界面上要做的动作完全不同。
  /// refused 的意思是「你自己去开条件」（开无障碍、把 amoo 调到前台），
  /// 而这一档的意思是「你什么都没做错，上一笔堵在无界 IPC 里超过最大预算，
  /// 锁已经放了，再发一次」。并成一档的后果是用户照着 refused 的提示去
  /// 逐个检查权限，而权限一直是好的。
  orphanCleared,

  /// 原生壳太旧，没有这三个通道。
  unavailable,

  /// 输入为空（Dart 与 Kotlin 两侧都会拦）。
  emptyPrompt;

  static AmooAskFailure parse(String? raw) {
    switch (raw) {
      case 'amoo_not_foreground':
        return AmooAskFailure.amooNotForeground;
      case 'single_flight':
        return AmooAskFailure.singleFlight;
      case 'refused':
        return AmooAskFailure.refused;
      case 'orphan_cleared':
      case 'orphaned_ask':
        // 两个 code 同源：MainActivity 把原生 askError 的 orphaned_ask 前缀
        // 映射成 orphan_cleared，而桥侧（Tools.amooAsk）直接回 orphaned_ask。
        // 两侧都吃，漏一个就意味着同一种自愈在一条通道上有话可说、
        // 在另一条上被 default 吞成「原生壳可能太旧」。
        return AmooAskFailure.orphanCleared;
      case 'empty_prompt':
        return AmooAskFailure.emptyPrompt;
      default:
        return AmooAskFailure.unavailable;
    }
  }

  String get hint {
    switch (this) {
      case AmooAskFailure.amooNotForeground:
        return 'amoo 不在前台。先点「打开 amoo」回到聊天页，再提问。';
      case AmooAskFailure.singleFlight:
        return '已有一个提问在进行中，等它结束或先停止。';
      case AmooAskFailure.refused:
        return '提问被拒绝：前置条件没满足，或安全防护拦截，提问没有发出去。';
      case AmooAskFailure.orphanCleared:
        // 原话优先：原生层给的那句已经说了「锁已释放、可重试」，而这里这句是
        // 兜底。见 failureDetail 的透传条件。
        return '上一笔提问卡死并已清理，重试即可。';
      case AmooAskFailure.emptyPrompt:
        return '请输入内容。';
      case AmooAskFailure.unavailable:
        return '反代通道不可用（原生壳可能太旧）。';
    }
  }
}

/// 一次反代的结果。[ok] 只表示「原生层正常应答」，不表示 amoo 回答了。
class AmooAskOutcome {
  final bool ok;
  final AmooAskState state;
  final String job;
  final String reply;
  final String error;

  /// amoo 的思维链正文。**恒为空串**，这不是遗漏。
  ///
  /// 原因在原生侧，不在这一层：amoo 的回复是从它的无障碍 UI 树里读「最新一个
  /// 聊天气泡」的文本（`AmooChatText.lastChatBlock`），那棵树里没有思考区节点
  /// 可读；MethodChannel 回传的 Map 也只有 ok/state/reply/error。所以这条路上
  /// 游根本不产思维链，这里也不伪造一个——要等 amoo 自己的界面先有可读的思考区。
  ///
  /// 仍然设这个字段，是为了让三条路（网关 / khy-os 后端 / amoo 反代）的形状一致：
  /// 调用方不必为 amoo 单写一套"没有思维链"的分支。
  final String reasoning;

  /// 这一轮是谁答的。默认 [AmooTransport.unknown]：调用方不传、原生层不说时，
  /// 「不知道」比猜一个直连诚实。
  final AmooTransport via;

  /// 仅在 ok=false 时有意义。
  final AmooAskFailure? code;
  final String message;

  /// 本轮发起时刻（epoch ms）。0 = 不知道，状态行只报「等待 amoo 回复」。
  final int askedAtMs;

  /// 读屏路由的用户可见提示。直连路由返回空串。
  ///
  /// 为什么必须是 outcome 上的字段而不是让每个调用方自己拼：两条现场
  /// （apex 起不来就回落 / 轮询中 apex 断了再回落）都落在 via=screen 上，
  /// 而用户该看到的是同一句话——「这一轮的回复是读屏来的，要无障碍 +
  /// amoo 前台」。缺了它，via=screen 只是一个机器字段：任务卡的状态行
  /// 照旧显示「amoo 正在思考…」，用户与日志都说不清为什么这次要开无障碍，
  /// 也说不清这一轮降级了没有（T15 判据：提示要出现，且不许谎称成功）。
  String get degradeNotice => via == AmooTransport.screen
      ? '直连不可用，已自动降级为读屏路由：回复由读屏产生，需无障碍开启且 amoo 在前台'
      : '';

  const AmooAskOutcome({
    required this.ok,
    this.state = AmooAskState.idle,
    this.job = '',
    this.reply = '',
    this.error = '',
    this.reasoning = '',
    this.via = AmooTransport.unknown,
    this.code,
    this.message = '',
    this.askedAtMs = 0,
  });

  /// 失败时该给用户看的那句话。
  ///
  /// 多数失败用一个固定 hint 就够（amoo 不在前台 → 去点「打开 amoo」）。
  /// 但有两档不同，原生层知道**为什么**、以及**下一步该做什么**，那句原话比
  /// 任何通用措辞都有用，所以这两档优先用原生层给的原话：
  ///
  ///   · [AmooAskFailure.refused] —— 预检拒绝，原话是具体缺的条件
  ///     （无障碍服务没开等）；
  ///   · [AmooAskFailure.orphanCleared] —— 上一笔提问卡死后的自愈，原话是
  ///     「单飞锁已自动释放，可重试」。它不写在这儿的话，界面只会显示
  ///     「反代通道不可用（原生壳可能太旧）」——一句既不为真、也不指向
  ///     下一步的话。
  ///
  /// 原话逐字上屏，一个字节都不改：orphanCleared 那句以 `orphaned_ask: ` 开头，
  /// 那是 AmooLoop.healOrphanedAsk 留给两侧分档用的机器可读前缀（MainActivity
  /// 与桥侧 Tools.amooAsk 都按前缀判桶）。在这儿「顺手美化」掉它，用户看到的就
  /// 不再是原生说的那句——停止原因必须原样上报。契约由
  /// test/amoo_ui_test.dart 的孤儿自愈三条行为测试钉住。
  String get failureDetail {
    if ((code == AmooAskFailure.refused ||
            code == AmooAskFailure.orphanCleared) &&
        message.isNotEmpty) {
      return message;
    }
    return code?.hint ?? message;
  }

  /// 用户可见的一句话。刻意不把 reply 算进来——它可能很长，属于内容区。
  String get statusLine {
    if (!ok) {
      final detail = message.isNotEmpty ? message : (code?.hint ?? '');
      return detail.isEmpty ? '调用失败' : detail;
    }
    switch (state) {
      case AmooAskState.running:
        // 读屏路由要在状态行里说出来（T15）：同一条「正在思考」，用户看不出
        // 这一轮是不是换了条更慢的路——而看不出来就等于没提示。
        final notice = degradeNotice;
        final waiting = amooWaitingLabel(askedAtMs: askedAtMs);
        return notice.isEmpty ? waiting : '$waiting（$notice）';
      case AmooAskState.done:
        return 'amoo 已回复';
      case AmooAskState.failed:
        final detail = error.isNotEmpty ? error : '未知原因';
        return '未拿到回复：$detail';
      case AmooAskState.idle:
        return '空闲';
    }
  }
}
