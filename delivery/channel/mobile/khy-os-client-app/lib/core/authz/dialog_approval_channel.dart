import '../tools/tool_engine.dart';
import '../wechat/wechat_approval_bridge.dart';

/// Adapts a screen-side confirmation callback to the broker's [ApprovalChannel]
/// so the author's [ApprovalGatedToolEngine] gates the residual execution paths
/// (driver host, agent screen, longcat screen) through the same choke point the
/// WeChat runner already uses. The decorator only consults the channel for
/// ask-declared tools; this adapter turns a bool dialog result into the
/// allow/deny decision the decorator understands. A dismissed dialog maps to
/// deny — silence is never consent (same rule as the WeChat bridge).
class DialogApprovalChannel implements ApprovalChannel {
  DialogApprovalChannel({required this.confirm});

  final Future<bool> Function({
    required String toolName,
    required Map<String, dynamic> params,
    String? reasoning,
  }) confirm;

  @override
  Future<WechatApprovalDecision> request({
    required String toolName,
    required Map<String, dynamic> params,
    String? reasoning,
  }) async {
    final ok =
        await confirm(toolName: toolName, params: params, reasoning: reasoning);
    return ok ? WechatApprovalDecision.allow : WechatApprovalDecision.deny;
  }
}

/// Tools whose blast radius warrants a confirmation even though the builtin
/// definitions declare no ask permission. The chat UI already catches these via
/// _needsApproval's dangerous-command branch; the driver/agent/longcat paths had
/// no such branch, so the most dangerous tools ran ungated. Marking them ask on
/// the gated instance makes the broker consult the channel for them. Names are
/// canonical (kToolAliases maps bash->exec_shell, so exec_shell covers bash too).
const Set<String> kGateDangerousTools = {
  'exec_shell',
  'exec_shell_elevated',
  'android',
};

/// Marks [kGateDangerousTools] as ask on [engine]. Call after registering tools
/// so the explicit permission overrides the builtin auto default.
void gateDangerousTools(ToolEngine engine) {
  for (final name in kGateDangerousTools) {
    engine.setPermission(name, PermissionLevel.ask);
  }
}