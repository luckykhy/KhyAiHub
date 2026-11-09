// khy-canary: Khy-20261101-081-NPMK6T63
import 'package:flutter/services.dart';

import '../security/guard.dart';
import '../services/app_logger.dart';

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
  static Future<AmooAskOutcome> ask(String prompt,
      {int timeoutMs = 420000}) async {
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
          .invokeMethod('amooAsk', {'prompt': body, 'timeoutMs': timeoutMs})
          .timeout(_callTimeout);
      if (result is! Map) {
        return const AmooAskOutcome(
          ok: false,
          code: AmooAskFailure.unavailable,
          message: '原生层未返回结果',
        );
      }
      if (result['ok'] == true) {
        return AmooAskOutcome(
          ok: true,
          job: result['job']?.toString() ?? '',
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
  static Future<AmooAskOutcome> poll() async {
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
        // 原生层（MainActivity.amooAskResult）今天不返回这个键，所以它恒为空串。
        // 仍然接上，是为了让 Dart 侧的形状与另两条路（网关 / khy-os 后端）对齐：
        // 那两条有思维链，这条没有——差别在原生侧读不到，不该由调用方各自猜。
        reasoning: result['reasoning']?.toString() ?? '',
      );
    } on PlatformException catch (e) {
      return _unavailable('amooAskResult', e);
    } catch (e) {
      return _unavailable('amooAskResult', e);
    }
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

  /// 仅在 ok=false 时有意义。
  final AmooAskFailure? code;
  final String message;

  const AmooAskOutcome({
    required this.ok,
    this.state = AmooAskState.idle,
    this.job = '',
    this.reply = '',
    this.error = '',
    this.reasoning = '',
    this.code,
    this.message = '',
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
        return 'amoo 正在思考…';
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
