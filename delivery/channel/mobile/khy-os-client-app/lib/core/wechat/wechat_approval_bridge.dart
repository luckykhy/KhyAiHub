// WeChat y/n approval gate for ask-level tools.
//
// Why a ToolEngine subclass instead of a before-hook: the base engine swallows
// hook results and exceptions and always proceeds to the tool
// (tool_engine.dart:179-184), so a hook can observe but never block. AgentLoop
// calls _engine.execute directly (agent_loop.dart:131) with no gate of its own
// — the ask dialog only exists in the chat UI (chat_screen_new.dart:810-824).
// Overriding execute() is the single choke point every call goes through,
// executeToolCalls included (tool_engine.dart:253).
import 'dart:async';
import 'dart:convert';

import '../tools/tool_engine.dart';

/// How long a WeChat y/n approval may stay unanswered before auto-deny.
///
/// Aligned with the PC daemon: ILINK_PERMISSION_TIMEOUT_MS defaults to '120000'
/// (serviceDefaults.js:410-411, env KHY_ILINK_PERMISSION_TIMEOUT_MS).
const Duration kWechatPermissionTimeout = Duration(milliseconds: 120000);

/// Outcome of one remote approval.
enum WechatApprovalDecision { allow, deny, timeout }

/// The y/n word classes, mirroring the PC daemon's parsePermissionReply
/// (ilinkSendPolicy.js:88-103). Word lists must stay zero-drift across both
/// ends: the same reply text must mean the same thing, and 'y' with nothing
/// pending falls through to the task router on both.
enum WechatPermissionReply { allow, deny }

WechatPermissionReply? parsePermissionReply(String text) {
  var t = text.trim().toLowerCase().replaceAll(RegExp(r'[。．.!!]+$'), '');
  if (t.isEmpty) return null;
  const allow = {'y', 'yes', '是', '好', '允许', '同意'};
  const deny = {'n', 'no', '否', '不', '拒绝', '不允许'};
  if (allow.contains(t)) return WechatPermissionReply.allow;
  if (deny.contains(t)) return WechatPermissionReply.deny;
  return null;
}

/// Dart port of ilinkSendPolicy.formatPermissionPrompt (ilinkSendPolicy.js:177).
///
/// The PC daemon renders the same structured info into the same Chinese shape,
/// and the wording is copied verbatim (half-width colon and comma included) so
/// a user sees one consistent prompt on both ends. Parameter values are
/// truncated: params may carry a whole file body, and echoing it to WeChat is
/// both noise and exposure.
String formatWechatPermissionPrompt({
  required String toolName,
  Map<String, dynamic>? params,
  String? riskInfo,
  String? reasoning,
  int maxValueLen = 200,
}) {
  final lines = <String>['需要你授权执行:$toolName'];
  if (riskInfo != null && riskInfo.isNotEmpty) {
    lines.add('风险等级:$riskInfo');
  }

  final p = params ?? const <String, dynamic>{};
  const preferred = ['command', 'file_path', 'filePath', 'path', 'url', 'pattern'];
  final keys = p.keys
      .where((k) =>
          !k.startsWith('_') && k != 'explanation' && k != 'diffPreview')
      .toList();
  keys.sort((a, b) {
    final ia = preferred.indexOf(a);
    final ib = preferred.indexOf(b);
    if (ia == -1 && ib == -1) return 0;
    if (ia == -1) return 1;
    if (ib == -1) return -1;
    return ia.compareTo(ib);
  });
  for (final k in keys.take(6)) {
    var v = p[k];
    if (v is Map || v is List) {
      try {
        v = jsonEncode(v);
      } catch (_) {
        v = '[对象]';
      }
    }
    var s = v?.toString() ?? '';
    if (s.length > maxValueLen) {
      // s.length is read before the reassignment lands, so 共 N 字符 reports
      // the original length — same as the JS template does.
      s = '${s.substring(0, maxValueLen)}…(共 ${s.length} 字符)';
    }
    lines.add('· $k: $s');
  }

  if (reasoning != null && reasoning.isNotEmpty) {
    lines.add(reasoning.length > maxValueLen
        ? '${reasoning.substring(0, maxValueLen)}…'
        : reasoning);
  }

  lines.add('');
  lines.add('回复 y 允许,n 拒绝。超时会自动拒绝。');
  return lines.join('\n');
}

/// ask 工具的审批通道契约。从 ApprovalGatedToolEngine 抽出来：微信来源走
/// WechatApprovalChannel（y/n 回信），本地来源走悬浮信箱的
/// OverlayApprovalChannel（lib/core/floating/overlay_task_sink.dart）——
/// 同一份契约、两个去向，引擎不认得任何一侧。
abstract class ApprovalChannel {
  Future<WechatApprovalDecision> request({
    required String toolName,
    required Map<String, dynamic> params,
    String? reasoning,
  });
}

/// Who the bridge asks. The runner wires the real bridge to the transport's
/// send primitive; tests capture the prompt instead.
abstract class WechatApprovalChannel implements ApprovalChannel {}

class _PendingApproval {
  final Completer<WechatApprovalDecision> completer;
  final Timer timer;
  _PendingApproval(this.completer, this.timer);
}

/// Single-slot approval bridge over WeChat y/n replies.
///
/// One slot is enough: a run executes tool calls serially and the runner
/// refuses concurrent runs (the same single-task shape as the PC daemon's
/// permission reply routing, ilinkDispatcher.js:806). A second concurrent
/// request is denied rather than overwriting a question the user has not
/// answered yet.
class WechatApprovalBridge implements WechatApprovalChannel {
  WechatApprovalBridge({
    required Future<void> Function(String contextToken, String text) sendPrompt,
    Duration timeout = kWechatPermissionTimeout,
  })  : _askPeer = sendPrompt,
        _askTimeout = timeout;

  final Future<void> Function(String contextToken, String text) _askPeer;
  final Duration _askTimeout;

  _PendingApproval? _pending;

  /// The conversation the current task came from. Set by the runner per task;
  /// the tool layer has no context of its own, so the prompt must be addressed
  /// through this back-channel.
  String? activeContextToken;

  bool get hasPending => _pending != null;

  /// Consume an inbound text as a permission reply when one is pending.
  /// Returns false when nothing is pending or the text is not a permission
  /// word — the caller then routes it as a normal message.
  bool resolveInbound(String text) {
    final pending = _pending;
    if (pending == null) return false;
    final reply = parsePermissionReply(text);
    if (reply == null) return false;
    _pending = null;
    pending.timer.cancel();
    pending.completer.complete(reply == WechatPermissionReply.allow
        ? WechatApprovalDecision.allow
        : WechatApprovalDecision.deny);
    return true;
  }

  @override
  Future<WechatApprovalDecision> request({
    required String toolName,
    required Map<String, dynamic> params,
    String? reasoning,
  }) async {
    if (_pending != null) return WechatApprovalDecision.deny;
    final completer = Completer<WechatApprovalDecision>();
    late final _PendingApproval slot;
    slot = _PendingApproval(completer, Timer(_askTimeout, () {
      if (!identical(_pending, slot)) return;
      _pending = null;
      completer.complete(WechatApprovalDecision.timeout);
    }));
    _pending = slot;
    // Prompt delivery is best-effort — the PC daemon swallows _say failures
    // too (ilinkDispatcher.js:1716). If the transport is down the timeout
    // still denies, which is the safe direction.
    try {
      await _askPeer(activeContextToken ?? '', formatWechatPermissionPrompt(
        toolName: toolName,
        params: params,
        reasoning: reasoning,
      ));
    } catch (_) {
      // delivery failed; the timeout will deny — the safe direction
    }
    return completer.future;
  }
}

/// ToolEngine decoration that turns declared ask-permissions into WeChat
/// approvals.
///
/// The registry lives on THIS instance: super.execute resolves tools from the
/// same maps the subclass inherits, so callers register the builtin and vision
/// tools directly here instead of into a base engine they would keep around.
///
/// The local permission mode (chat UI's bypass / auto) deliberately does not
/// weaken this gate: those knobs govern the on-screen dialog, while a remote
/// WeChat session has no screen to tap — the y/n reply is the only approval
/// surface there, and silence must not become consent.
class ApprovalGatedToolEngine extends ToolEngine {
  ApprovalGatedToolEngine({
    required ApprovalChannel approval,
    Duration approvalTimeout = kWechatPermissionTimeout,
  })  : _approvalChannel = approval,
        _askTimeout = approvalTimeout;

  final ApprovalChannel _approvalChannel;
  final Duration _askTimeout;

  /// Tools that passed the gate with an explicit y this run. Evidence for the
  /// trajectory layer, which records gate-held steps as quarantined.
  final Set<String> approvedViaGate = <String>{};

  /// True when [toolName] (alias or canonical) is gated by this engine — the
  /// runner uses it to pick the trajectory trust level.
  bool heldByGate(String toolName) {
    final canonical = kToolAliases[toolName] ?? toolName;
    return getPermission(canonical) == PermissionLevel.ask;
  }

  @override
  Future<ToolResult> execute(String toolName, Map<String, dynamic> args) async {
    // Judge on the canonical name: aliases must not become a side door around
    // a tool's own declaration (same rule as tool_engine.dart's kToolAliases).
    final canonical = kToolAliases[toolName] ?? toolName;
    if (getPermission(canonical) == PermissionLevel.ask) {
      final decision = await _approvalChannel.request(
        toolName: canonical,
        params: args,
      );
      switch (decision) {
        case WechatApprovalDecision.allow:
          approvedViaGate.add(canonical);
          break;
        case WechatApprovalDecision.deny:
          // Same wording the chat UI uses on refusal (chat_screen_new.dart:813).
          return ToolResult.fail('用户拒绝了该操作');
        case WechatApprovalDecision.timeout:
          return ToolResult.fail(
              '等待授权超过 ${_askTimeout.inSeconds} 秒,已自动拒绝。');
      }
    }
    return super.execute(toolName, args);
  }
}
