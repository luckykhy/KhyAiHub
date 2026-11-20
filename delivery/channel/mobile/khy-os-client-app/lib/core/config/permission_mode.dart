/// The phone's tool-permission mode — the mobile counterpart of the mode layer
/// that already exists in khy-os's desktop and terminal.
///
/// WHY THIS EXISTS. The desktop/terminal has a full mode vocabulary
/// (`default / plan / acceptEdits / auto / dontAsk / bypass / RedPass`, mapped
/// in `toolCallingPermissions.js` to permission-store profiles). The phone had
/// nothing: no mode, no selector, and two latent bugs that only surfaced once
/// somebody looked:
///
///   1. `ToolEngine.getPermission` fell back to `PermissionLevel.auto` when no
///      explicit level was set, so a tool that DECLARED `ask` was silently
///      auto-approved. `vision_tap` declares `ask` and was therefore never
///      asked about.
///   2. `_needsApproval` in the chat screen was hardcoded to two tool names,
///      so the declared level was never consulted at all.
///
/// WHAT THIS IS NOT. It is not a way past an operating-system consent gate.
/// The desktop's `bypass` covers khy-os's OWN prompts — "should I ask before
/// running this tool" — which exist for the user's convenience and which the
/// user is entitled to waive. Android's MediaProjection dialog is a different
/// thing entirely: it is the OS asking the human whether an app may capture
/// their screen, and it is not khy-os's to waive. That dialog is instead
/// removed by routing screenshots through the accessibility service the vision
/// tools already depend on, so there is nothing left to bypass.
///
/// The wire names match the desktop's, so a mode set on one surface means the
/// same thing on another.
///
/// Deliberately free of Flutter imports, like the rest of `core/config`: the
/// colour each mode is drawn in belongs to the theme layer, not to a decision
/// about what the mode means.
enum PermissionMode {
  /// Ask every time, for every tool that declares `ask`.
  prompt('default'),

  /// Ask once per tool per session, then remember the answer.
  ///
  /// The "remember" is session-scoped on purpose: a durable auto-approve for a
  /// tool that taps the screen is what [bypass] is for, and collapsing the two
  /// would make the distinction between "stop nagging me this once" and "never
  /// ask me about this" unexpressible.
  auto('auto'),

  /// Never ask. Tools that declare `ask` run without a prompt.
  bypass('bypass'),

  /// A side-effecting action that arrived from the far side of the bridge runs
  /// neither here nor over there: it produces an approval record and waits for
  /// the human standing next to the phone. Timeout defaults to deny.
  ///
  /// The line against [bypass]: `bypass` waives the prompt that would interrupt
  /// the person holding the phone. This mode moves the question to that person
  /// instead of removing it — one remote action, one approval record, and no
  /// "don't ask me about this tool again this round". A remote caller does not
  /// inherit a local `bypass`; that lives in `core/services/amoo_approval.dart`.
  remoteApproval('remote_approval');

  const PermissionMode(this.wire);

  final String wire;

  static PermissionMode fromWire(String? s) {
    for (final m in PermissionMode.values) {
      if (m.wire == s) return m;
    }
    return PermissionMode.prompt;
  }

  /// Whether a tool declaring `ask` should produce a prompt in this mode.
  bool get asks => this != PermissionMode.bypass;

  /// Whether an answer given in this mode should be remembered for the rest of
  /// the session.
  bool get remembersWithinSession => this == PermissionMode.auto;

  /// The label shown in the settings selector.
  String get label => switch (this) {
        PermissionMode.prompt => '每次询问',
        PermissionMode.auto => '本次会话记住',
        PermissionMode.bypass => '一律不问',
        PermissionMode.remoteApproval => '远端审批',
      };

  /// What the mode actually does, in one line, for the settings subtitle.
  ///
  /// Each line names a consequence rather than restating the name: a user
  /// choosing between these needs to know what stops happening, not what the
  /// mode is called.
  String get detail => switch (this) {
        PermissionMode.prompt => '声明了「需询问」的工具每次都会弹框让你确认',
        PermissionMode.auto => '同一个工具本次会话只问一次，之后直接执行',
        PermissionMode.bypass => '声明了「需询问」的工具直接执行，不再弹框',
        PermissionMode.remoteApproval => '远端的副作用动作生成审批单等你确认，超时默认拒绝',
      };
}
