// khy-canary: Khy-20261113-001-P1DRVEV

/// Driver 流式事件——Render Layer 的唯一输入。
///
/// 铁律：事件词汇表是通用语义，不含任何 driver 私有字段。渲染层只认识这里
/// 的类型；新增 driver 不改渲染层，靠的就是这条（T2 判据的机制保证）。
///
/// 构造器刻意不写 const：sealed 父类没有 const 构造器，子类写 const 会编译
/// 失败；这些事件也不是热路径上值得省的对象。
sealed class DriverEvent {}

/// 会话开始。driver 在 send() 前或首块前发。
class DriverStarted extends DriverEvent {
  final String sessionId;
  final String turnId;
  DriverStarted({required this.sessionId, required this.turnId});
}

/// 增量内容。kind: 'content'（正文）/ 'reasoning'（思维链）。
class DriverDelta extends DriverEvent {
  final String kind;
  final String text;
  DriverDelta({required this.kind, required this.text});
}

/// driver 请求一次工具调用（经 ToolHostClient，不是自己执行）。
class DriverToolCall extends DriverEvent {
  final String callId;
  final String name;
  final Map<String, Object?> args;
  DriverToolCall({required this.callId, required this.name, required this.args});
}

/// 工具调用结果回灌。ok=false 时 summary 说明原因。
class DriverToolResult extends DriverEvent {
  final String callId;
  final bool ok;
  final String summary;
  DriverToolResult({required this.callId, required this.ok, required this.summary});
}

/// 状态行。RUNTIME-002：由 code + detail + attempt 组装「动作+目标+进度」。
///
/// code 取值：waiting / connecting / degraded / timed_out / failed，
/// 以及 route_degraded（一轮换了传输路由——如 amoo 直连断了改走读屏；
/// detail 是可读提示，渲染层 default 分支原样出，不加分支）。
/// retryable 不在这个类上——它在 DriverFailed 上（§7 T7 判据按此断言）。
class DriverStatus extends DriverEvent {
  final String code;
  final String detail;
  final int attempt;
  DriverStatus({required this.code, this.detail = '', this.attempt = 0});
}

/// 一轮正常结束。reason: completed / aborted / superseded。
class DriverFinished extends DriverEvent {
  final String turnId;
  final String reason;
  DriverFinished({required this.turnId, required this.reason});
}

/// 一轮失败。retryable=true 时 UI 给重试入口；driver 不得用本地模型代答。
class DriverFailed extends DriverEvent {
  final Object error;
  final bool retryable;
  DriverFailed({required this.error, required this.retryable});
}
