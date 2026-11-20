/// Amoo 桥适配层——四种传输（节点通道下发 / 结果文件回写 / 共享存储 / 审批状态文件）
/// 的唯一接触点（contract §1 K-01；C2 拍板「三个传输实现收进一层 adapter」）。
///
/// 为什么必须有这一层：B1/B5/B7 三处的传输细节各不相同（一个走云端固定接口，三个走
/// 设备侧文件），而信封字段、幂等三字段、判据数值必须只有一个出处。业务层只跟本模块
/// 说话；换传输实现时只改这里，协议和判定不动（K-01）。
///
/// 与 call_chain.dart 的分工：那个模块管「这一跳能不能调」（depth/预算/序号，
/// 带会话键）；本模块管「这一跳走哪条路、谁有权写、重放怎么算」。序号在传输侧
/// 还有第二问——单笔回写没有会话键可记——由 AmooSeqGate 守，拒的是同一个
/// kCodeSeqConflict。信封词汇（12 字段、五个 kind、proto_v 集合）两边同一套
/// ——形状校验复用 CallEnvelope.parse，不在这里抄第二份解析器。

import 'dart:convert';

import 'package:khy_os_client/core/trajectory/call_chain.dart';

const String _kCloud = 'cloud';
const String _kDevice = 'device';
const Set<String> _kPeers = <String>{_kCloud, _kDevice};

/// 模块默认的对等体登记表（K-13）。握手换身份时改这一处，send 的形状不动。
final AmooPeers _kDefaultPeers = AmooPeers(_kPeers);

/// 信箱/状态文件 id 规范，逐字镜像 BridgeService.java:456-465（1-128 位
/// 字母/数字/下划线/短横线）。id 落在文件名里，形状不合法就是目录穿越的口子。
final RegExp _kMailboxId = RegExp(r'^[A-Za-z0-9_-]{1,128}$');

/// kind 五选一，线上值与 CallKind 同一套（contract §3.1 表）。两侧一致性由单元门
/// amoo_adapter_test.dart 的集合相等断言钉住：漂移先在门上红，不等云端按 kind 分错派。
enum AmooKind {
  cmd('指令'),
  event('事件'),
  approval('审批'),
  result('结果'),
  error('错误');

  const AmooKind(this.wire);

  final String wire;

  static AmooKind? fromWire(Object? value) {
    for (final k in AmooKind.values) {
      if (k.wire == value) return k;
    }
    return null;
  }
}

/// 协议版本集合。直接复用 call_chain 的声明——proto_v 是版本真源，不在这里放第二份。
class AmooProto {
  static const Set<String> supported = kSupportedProtoV;
}

/// K-01 四种传输。一个枚举值 = 一条通道；两种传输共用同一个载体时，判据（30s 内出
/// result）就再也归因不到任一条通道上。
enum AmooTransport {
  /// T1 云端 → 设备：节点通道（云端固定接口，仓库内无同名实现，见契约 R-1）。
  nodeChannel,

  /// T2 设备 → 云端：结果文件（复用信箱三态协议）。
  resultFile,

  /// T3 设备 ⇄ 云端：共享存储（白名单内，设备单写）。
  sharedStore,

  /// T4 设备 ⇄ 云端：审批状态文件。
  approvalFile,
}

/// K-01 表的一行。[writer] 答「这条传输的写方是谁」——落设备存储的三条归设备单写
/// （K-04/K-70），云端只读消费。
class AmooTransportRow {
  const AmooTransportRow({
    required this.id,
    required this.transport,
    required this.writer,
  });

  final String id;
  final AmooTransport transport;
  final String writer;
}

/// K-22 错误回执 + K-24 幂等三字段。三个字段恒 false 且不作为构造参数暴露：
/// 信封级拒绝时什么都没到工具层（HttpBridge.java:494-503 同款），给了参数就是在
/// 邀请调用方写 true。
///
/// 与桥侧回执的差异只有两处，都来自 Dart 侧契约：kind 让它成为一个合法的 kind=错误
/// 消息（K-22），fix 履行仓库规则 2.2 的「问题+修复」模板——桥侧把修复建议写在 error
/// 字符串里，Dart 侧分成两个字段。
class AmooReceipt {
  const AmooReceipt({
    required this.code,
    required this.error,
    required this.fix,
    required this.guideTopic,
  })  : actionDispatched = false,
        replaySafe = false,
        retrySafe = false;

  final String code;
  final String error;
  final String fix;

  /// 指向 /agent-guide 的主题名；主题白名单在桥侧，这里只指真实存在的主题。
  final String guideTopic;
  final bool actionDispatched;
  final bool replaySafe;
  final bool retrySafe;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'kind': AmooKind.error.wire,
        'ok': false,
        'code': code,
        'error': error,
        'fix': fix,
        'guide_topic': guideTopic,
        'action_dispatched': actionDispatched,
        'replay_safe': replaySafe,
        'retry_safe': retrySafe,
      };
}

/// 错误码表（contract §3.2 K-23）。与调用链护栏共用的五个码直接引用 call_chain
/// 的常量——同一个码两个真源，改一处漏一处就是这么来的；其余是桥侧字面值，
/// Dart 侧没有可 import 的真源。
class AmooErrors {
  static const String unauthorized = 'unauthorized';
  static const String unknownPeer = 'unknown_peer';
  static const String credentialExpired = 'credential_expired';
  static const String protoVUnsupported = kCodeProtoVUnsupported;
  static const String invalidArguments = kCodeInvalidArguments;
  static const String unknownTool = 'unknown_tool';
  static const String duplicateId = 'duplicate_id';
  static const String seqConflict = kCodeSeqConflict;
  static const String recursionDepthExceeded = kCodeRecursionDepthExceeded;
  static const String sessionBudgetExceeded = kCodeSessionBudgetExceeded;
  static const String approvalRequired = 'approval_required';
  static const String approvalTimeout = 'approval_timeout';
  static const String uiToolUnavailable = 'ui_tool_unavailable';
  static const String notInstalled = 'not_installed';
  static const String singleFlight = 'single_flight';

  /// K-23 表的 15 行，一个不多一个不少（B1 门的计数断言钉的就是这份闭集）。
  static const Set<String> codes = <String>{
    unauthorized,
    unknownPeer,
    credentialExpired,
    protoVUnsupported,
    invalidArguments,
    unknownTool,
    duplicateId,
    seqConflict,
    recursionDepthExceeded,
    sessionBudgetExceeded,
    approvalRequired,
    approvalTimeout,
    uiToolUnavailable,
    notInstalled,
    singleFlight,
  };

  /// K-23 表尚未收录这一行（B8 门已注明需补行，锚点【B8】）：先按字面值落地，
  /// 且刻意不放进 [codes]——补行后与 B1 门「15 个码」的计数断言一起改成 16，
  /// 不许单方面改一边（device/adapter.md §1.2 第 2 件同款待裁）。
  static const String leaseExpired = 'lease_expired';

  static AmooReceipt of(
    String code, {
    required String error,
    required String fix,
    required String guideTopic,
  }) =>
      AmooReceipt(code: code, error: error, fix: fix, guideTopic: guideTopic);
}

/// 一跳消息的信封。字段集与 CallEnvelope 逐字相同（K-20 唯一信封）；差异只在
/// kind 的枚举成员名（本侧按传输语义命名）。
class AmooEnvelope {
  const AmooEnvelope({
    required this.protoV,
    required this.sessionId,
    required this.msgId,
    required this.seq,
    required this.from,
    required this.to,
    required this.kind,
    required this.payload,
    required this.traceId,
    required this.depth,
    this.parentSpan,
    this.idempotencyKey,
  });

  final String protoV;
  final String sessionId;

  /// 消息唯一 id，同时是 span id——信封里没有第 13 个字段。
  final String msgId;
  final int seq;
  final String from;
  final String to;
  final AmooKind kind;
  final Map<String, dynamic> payload;

  /// 调用链根 id，一次跨端任务全程不变（K-50）。
  final String traceId;

  /// 父 span id；根消息为空（缺席或显式 null 都合法）。
  final String? parentSpan;
  final int depth;

  /// kind=指令/审批 必填（K-25：同 key 重放返回首次结果）；其余 kind 可空。
  final String? idempotencyKey;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'proto_v': protoV,
        'session_id': sessionId,
        'msg_id': msgId,
        'seq': seq,
        'from': from,
        'to': to,
        'kind': kind.wire,
        'payload': payload,
        'trace_id': traceId,
        'parent_span': parentSpan,
        'depth': depth,
        // kind=结果 不重复携带 idempotency_key：信箱场景里它就是文件名 id
        // （K-25；BridgeService.java:451-455 原文「the mailbox id lives in the
        // FILENAME, never in the body」），正文再写一遍会让同一事实有两个真源。
        if (kind != AmooKind.result) 'idempotency_key': idempotencyKey,
      };

  /// 解析一跳信封。形状不符返回 null，拒因走 [AmooBridge.rejectEnvelope]——解析器
  /// 不抛异常：传输层交付的字节串什么都有可能，把一次坏消息变成一次崩溃，调用方
  /// 就拿不到可执行的修复建议。
  ///
  /// 校验复用 CallEnvelope.parse：12 字段闭集、session_id 形状、payload 闭集、
  /// 序号/深度类型、proto_v 集合只有一份真源。
  static AmooEnvelope? parse(Object? json) {
    final CallEnvelope parsed;
    try {
      parsed = CallEnvelope.parse(_normalizeArgs(json));
    } on CallRejected {
      return null;
    }
    final kind = AmooKind.fromWire(parsed.kind.wire);
    // 两侧线上值漂移时按拒收处理，不猜不补（一致性由单元门先钉住）。
    if (kind == null) return null;
    return AmooEnvelope(
      protoV: parsed.protoV,
      sessionId: parsed.sessionId,
      msgId: parsed.msgId,
      seq: parsed.seq,
      from: parsed.from,
      to: parsed.to,
      kind: kind,
      payload: parsed.payload,
      traceId: parsed.traceId,
      parentSpan: parsed.parentSpan,
      depth: parsed.depth,
      idempotencyKey: parsed.idempotencyKey,
    );
  }

  /// kind=指令 的 args 线上可缺席，解析结果必须是对象——两层规则各就各位
  /// （任务书 §5 拍板）：线上宽容镜像信箱路径的既定行为（BridgeService.java:559-562，
  /// 缺席补空对象），解析严格是 call_chain.dart:228 的规则。适配器在边界把缺席的
  /// args 补成空对象再交给共用解析器，不为这一格在 call_chain 里开第二个口子。
  ///
  /// 只在 kind=指令 上补：其余 kind 的 payload 形状各自定义（审批见 §9），
  /// 照抄这一补法会给它们塞进一个没人定义的字段。
  static Object? _normalizeArgs(Object? json) {
    if (json is! Map<String, dynamic>) return json;
    if (json['kind'] != AmooKind.cmd.wire) return json;
    final payload = json['payload'];
    if (payload is! Map || payload.containsKey('args')) return json;
    return <String, dynamic>{
      ...json,
      'payload': <String, dynamic>{...payload, 'args': <String, dynamic>{}},
    };
  }
}

/// 一次 send 的结果。四个出口互斥：帧（节点通道）/ 文件+正文（回写）/ 重放（首次结果
/// 已在盘上）/ 拒回执。[transport] 在路由之前就被拒时为 null——那次发送没有落到任何
/// 一条传输上。
class AmooSend {
  const AmooSend._({
    this.transport,
    this.frame,
    this.file,
    this.body,
    this.receipt,
    this.replay = false,
  });

  final AmooTransport? transport;

  /// 节点通道帧：就是信封本身（下发不改信封）。
  final Map<String, dynamic>? frame;

  /// 落盘文件名（result_<id>.json / approval_<id>.json）。
  final String? file;

  /// 文件正文：过同一套编解码，不为文件形态另起一个序列化器。
  final Map<String, dynamic>? body;

  final AmooReceipt? receipt;

  /// true = 重放首次结果：不重新生成正文，也不覆盖盘上既有 result（K-25）。
  final bool replay;
}

class AmooBridge {
  /// K-01 四种传输一张表。
  static const List<AmooTransportRow> transports = <AmooTransportRow>[
    AmooTransportRow(id: 'T1', transport: AmooTransport.nodeChannel, writer: _kCloud),
    AmooTransportRow(id: 'T2', transport: AmooTransport.resultFile, writer: _kDevice),
    AmooTransportRow(id: 'T3', transport: AmooTransport.sharedStore, writer: _kDevice),
    AmooTransportRow(id: 'T4', transport: AmooTransport.approvalFile, writer: _kDevice),
  ];

  /// 编解码只发生在这一处（K-20）：encode 就是信封自己的 toJson，边界不引入第二套字段名。
  static Map<String, dynamic> encodeEnvelope(AmooEnvelope env) => env.toJson();

  static String encodeEnvelopeText(AmooEnvelope env) => jsonEncode(encodeEnvelope(env));

  /// 节点通道交付的是 JSON 文本、结果文件里躺的也是 JSON 文本；解不出来返回 null，
  /// 拒收原因走 [rejectEnvelopeText]。
  static AmooEnvelope? decodeEnvelopeText(String text) {
    final Object? decoded;
    try {
      decoded = jsonDecode(text);
    } on FormatException {
      return null;
    }
    return AmooEnvelope.parse(decoded);
  }

  /// 拒收回执。返回 null = 这份 JSON 是合法信封，没有可拒的东西。
  static AmooReceipt? rejectEnvelope(Object? json) {
    try {
      CallEnvelope.parse(json);
      return null;
    } on CallRejected catch (e) {
      return AmooErrors.of(e.code, error: e.error, fix: e.fix, guideTopic: e.guideTopic);
    }
  }

  /// 文本路径的拒收回执：坏 JSON 与形状错误都给同一个 invalid_arguments 码，
  /// 消息带齐问题+修复+guide_topic，不是静默 null。
  static AmooReceipt? rejectEnvelopeText(String text) {
    final Object? decoded;
    try {
      decoded = jsonDecode(text);
    } on FormatException catch (e) {
      return AmooErrors.of(
        AmooErrors.invalidArguments,
        error: '信封不是合法 JSON 文本（${e.message}）：节点通道与结果文件交付的都是 JSON 文本。',
        fix: '按 12 字段信封重写后重发，字段表读 GET /agent-guide?topic=mailbox',
        guideTopic: 'mailbox',
      );
    }
    return rejectEnvelope(decoded);
  }

  /// K-21 按 to 路由。未登记 to 到不了这里——send 先按 K-13 拒 unknown_peer。
  static AmooTransport transportFor(String to) =>
      to == _kDevice ? AmooTransport.nodeChannel : AmooTransport.resultFile;

  /// K-04/K-70 写权矩阵。未登记身份在任何载体上都没有写权（K-13）。
  static bool canWrite(String peer, AmooTransport transport) {
    switch (transport) {
      case AmooTransport.nodeChannel:
        return peer == _kCloud;
      case AmooTransport.resultFile:
      case AmooTransport.sharedStore:
      case AmooTransport.approvalFile:
        return peer == _kDevice;
    }
  }

  /// 下发与回写都过这一个 send（K-02/K-03）：帧就是信封本身，回写正文过同一套编解码，
  /// 信封过去不改一个字段。
  ///
  /// [present] 是信箱目录当前的文件名集合。重放判定要看的盘上状态由调用方喂进来，
  /// 适配器自己不碰文件系统——判定因此可复现，也不在这里长出第二个 IO 通道。
  /// [lease] 是租约闸门的两个可观测量（到期时刻、当前时刻）；过期时帧都不生成。
  static AmooSend send(
    AmooEnvelope env, {
    Set<String> present = const <String>{},
    ({int expiresAt, int nowMs})? lease,
  }) {
    // 闸门在传输之前：帧一旦上了节点通道就撤不回来。
    final leaseRejection = lease == null
        ? null
        : checkLease(expiresAt: lease.expiresAt, nowMs: lease.nowMs);
    if (leaseRejection != null) {
      return AmooSend._(receipt: leaseRejection);
    }

    final peerRejection = _kDefaultPeers.checkRoute(from: env.from, to: env.to);
    if (peerRejection != null) {
      return AmooSend._(receipt: peerRejection);
    }

    final transport = transportFor(env.to);

    // 回写只收 kind=结果。放在写权之前：指令走回写通道是形状错误，报形状码，
    // 不让调用方以为是授权问题。
    if (transport == AmooTransport.resultFile && env.kind != AmooKind.result) {
      return AmooSend._(
        transport: transport,
        receipt: AmooErrors.of(
          AmooErrors.invalidArguments,
          error: '回写通道只收 kind=结果（收到 kind=${env.kind.wire}, to=${env.to}）。',
          fix: '把 kind 改成结果，或把 to 改成${_kDevice}走节点通道下发；信封字段读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        ),
      );
    }

    if (!canWrite(env.from, transport)) {
      return AmooSend._(
        transport: transport,
        receipt: AmooErrors.of(
          AmooErrors.unauthorized,
          error: '写入被拒：from=${env.from} 对${_transportName(transport)}没有写权——落设备存储的传输由设备单写。',
          fix: '把回写发起方改回${_kDevice}侧，或改走节点通道下发；写权矩阵读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        ),
      );
    }

    if (transport == AmooTransport.resultFile) {
      // 回写文件名由幂等键派生（K-25）：缺 key 或形状不合法都落不了信箱。
      final key = env.idempotencyKey;
      if (key == null || !_kMailboxId.hasMatch(key)) {
        return AmooSend._(
          transport: transport,
          receipt: AmooErrors.of(
            AmooErrors.invalidArguments,
            error: '回写文件名由幂等键派生：idempotency_key=${key == null ? '缺失' : '"$key" 不是合法信箱 id'}。',
            fix: '补上 1-128 位字母/数字/下划线/短横线的幂等键后重发，id 规范读 GET /agent-guide?topic=mailbox',
            guideTopic: 'mailbox',
          ),
        );
      }
      final ledger = _ledgerVerdict(key, present);
      if (ledger.receipt != null) {
        return AmooSend._(transport: transport, receipt: ledger.receipt);
      }
      if (ledger.replayFile != null) {
        return AmooSend._(transport: transport, file: ledger.replayFile, replay: true);
      }
      return AmooSend._(
        transport: transport,
        file: 'result_$key.json',
        body: encodeEnvelope(env),
      );
    }

    // 节点通道同样查幂等账本：同一个 key 在任一方向上出现过，就是已经处理过。
    final key = env.idempotencyKey;
    if (key != null) {
      final ledger = _ledgerVerdict(key, present);
      if (ledger.receipt != null) {
        return AmooSend._(transport: transport, receipt: ledger.receipt);
      }
      if (ledger.replayFile != null) {
        return AmooSend._(transport: transport, file: ledger.replayFile, replay: true);
      }
    }
    return AmooSend._(transport: transport, frame: encodeEnvelope(env));
  }

  /// K-81 审批状态文件名。id 形状同信箱 id——审批单 id 就是信封 idempotency_key。
  static String? approvalFile(String id) =>
      _kMailboxId.hasMatch(id) ? 'approval_$id.json' : null;

  /// 审批单 id 就是信封 idempotency_key（K-81 原文）。其它 kind 没有审批单：把指令的
  /// 幂等键当审批 id 用，会去读一个不存在的状态文件，然后按「读不到」放行或拒绝——
  /// 两种都是猜。
  static String? approvalIdOf(AmooEnvelope env) =>
      env.kind == AmooKind.approval ? env.idempotencyKey : null;

  /// K-81/K-82 审批状态文件的四态处置。返回 null = 放行（approved）。
  ///
  /// [expiresAt] 由调用方从状态文件读入（超时在设备侧判，K-82）：pending 但已过
  /// expires_at 按过期拒——「文件还写着 pending 就放行」等于把默认拒绝交给读取时机，
  /// 而没人保证那个时机。
  static AmooReceipt? approvalDisposition({
    required String state,
    required int nowMs,
    int? expiresAt,
  }) {
    switch (state) {
      case 'approved':
        return null;
      case 'pending':
        if (expiresAt != null && nowMs >= expiresAt) {
          return AmooErrors.of(
            AmooErrors.approvalTimeout,
            error: '审批已过期（expires_at=$expiresAt，state 仍写着 pending）：超时在设备侧判，默认拒绝。',
            fix: '重新发起审批；超时默认拒绝读 GET /agent-guide?topic=mailbox',
            guideTopic: 'mailbox',
          );
        }
        return AmooErrors.of(
          AmooErrors.approvalRequired,
          error: '审批未决（state=pending）：有副作用动作须设备侧确认后才执行。',
          fix: '等设备侧确认，或改走只读动作；审批语义读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        );
      case 'denied':
        return AmooErrors.of(
          AmooErrors.approvalRequired,
          error: '审批被拒（state=denied）：未确认就没有副作用。',
          fix: '按拒绝处置，不要重发同一审批单；审批语义读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        );
      case 'expired':
        return AmooErrors.of(
          AmooErrors.approvalTimeout,
          error: '审批已过期（state=expired）：超时默认拒绝。',
          fix: '重新发起审批；超时默认拒绝读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        );
      default:
        return AmooErrors.of(
          AmooErrors.invalidArguments,
          error: '审批状态"$state"不是四态之一（pending/approved/denied/expired）。',
          fix: '按四态重写状态文件；审批状态文件读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        );
    }
  }

  /// Q9/B8 租约闸门：到期那一刻起不受理新指令。不带 sessionId 的本机轮次没有租约
  /// 可判（K-30），expiresAt 缺席即放行。适配器自己不读系统时钟——租约真源在
  /// amoo_lease.dart（B8），这里只判喂进来的两个可观测量。
  static AmooReceipt? checkLease({int? expiresAt, required int nowMs}) {
    if (expiresAt == null || nowMs < expiresAt) return null;
    return AmooErrors.of(
      AmooErrors.leaseExpired,
      error: '租约已过期（expires_at=$expiresAt，now=$nowMs）：过期不受理新指令。',
      fix: '先续租（同一 session_id 重新取得租约）再发；租约语义读 GET /agent-guide?topic=mailbox',
      guideTopic: 'mailbox',
    );
  }

  /// 查幂等账本（K-25）。首次结果在盘上 = 重放缓存；无结果而有遗留 processing =
  /// 那次副作用未知，拒。result 与遗留 processing 同时在，仍以 result 为准——
  /// 拒绝路径绝不覆盖既有 result（BridgeService.java:487-511）。
  static ({String? replayFile, AmooReceipt? receipt}) _ledgerVerdict(
    String key,
    Set<String> present,
  ) {
    if (!_kMailboxId.hasMatch(key)) {
      return (
        replayFile: null,
        receipt: AmooErrors.of(
          AmooErrors.invalidArguments,
          error: 'idempotency_key="$key" 不是合法信箱 id（1-128 位字母/数字/下划线/短横线）：无法据它查重放账本。',
          fix: '改用合法形状的幂等键后重发，id 规范读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        ),
      );
    }
    final resultFile = 'result_$key.json';
    if (present.contains(resultFile)) return (replayFile: resultFile, receipt: null);
    if (present.contains('processing_$key.json')) {
      return (
        replayFile: null,
        receipt: AmooErrors.of(
          AmooErrors.duplicateId,
          error: '同 key 已有遗留 processing_$key.json（上次执行结果未知）：重放会双重执行。',
          fix: '先读 result_$key.json 或核对界面副作用，确认后删除该遗留文件再发；重放语义读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        ),
      );
    }
    return (replayFile: null, receipt: null);
  }

  static String _transportName(AmooTransport t) {
    switch (t) {
      case AmooTransport.nodeChannel:
        return '节点通道';
      case AmooTransport.resultFile:
        return '结果文件';
      case AmooTransport.sharedStore:
        return '共享存储';
      case AmooTransport.approvalFile:
        return '审批状态文件';
    }
  }
}

/// 一个方向的序号闸门（K-20 §3.1：每方向独立计数，跳号/回退/同秒冲突即拒；
/// 续接以已确认的最大 seq 为基线）。
///
/// 与 CallGuard 的分工：那个按 (session, from, to) 记 depth/预算/序号一整套，
/// 是 B6 的护栏；本类只守序号一件事——信箱回写与节点通道下发都要问「这一跳
/// 是不是下一条」，而单笔回写没有会话键可记。check 只判不记、confirm 才进
/// 基线：被拒的消息进基线，会把后面每一条序号一次判死。
class AmooSeqGate {
  AmooSeqGate({int baseline = 0}) : _last = baseline;

  int _last;

  AmooReceipt? check(int seq) {
    if (seq == _last + 1) return null;
    return AmooErrors.of(
      AmooErrors.seqConflict,
      error: '序号冲突：本方向下一条应为 ${_last + 1}，收到 $seq。',
      fix: '按已确认的最大 seq 续序后重发（被拒的消息不进基线）',
      guideTopic: 'mailbox',
    );
  }

  void confirm(int seq) {
    _last = seq;
  }
}

/// 一个会话内的 msg_id 账本（K-20 §3.1：同一 session 内 msg_id 不得重复，
/// 重复即拒、不执行）。
///
/// 与信箱的 result_<id>.json 重放是两回事：那个看盘上有没有首次结果（K-25），
/// 这个看这一跳有没有被记过——重放已确认的消息与重复投递是两种处置。
class AmooMsgLog {
  final Set<String> _seen = <String>{};

  AmooReceipt? check(String msgId) {
    if (!_seen.contains(msgId)) return null;
    return AmooErrors.of(
      AmooErrors.duplicateId,
      error: 'msg_id "$msgId" 本会话内已出现过：重复投递不执行。',
      fix: '改用全局唯一的 msg_id 后重发；若确为重放已确认的消息，按 K-25 读首次结果',
      guideTopic: 'mailbox',
    );
  }

  void record(String msgId) {
    _seen.add(msgId);
  }

  /// 撤回一次认领。
  ///
  /// 为什么需要：链路上的去重是「先认领、再执行」——不先认领，服务端重投的
  /// 第二帧会在第一帧还没跑完时挤进来，两帧一起执行，去重等于没做。但先认领
  /// 就有个代价：执行真的抛了，这条 id 已经被记过，服务端的重投会被当成重复
  /// 直接吞掉，指令就永久丢了。执行失败时调这个把它放回去，重投才有救。
  void forget(String msgId) {
    _seen.remove(msgId);
  }
}

/// 信箱命令的三种处置（K-03 三态 + K-25 重放）。
enum AmooMailAction {
  /// 干净信箱：改名占位后才执行。
  claim,

  /// 首次结果已在盘上：返回它，不二次执行。
  replay,

  /// 拒：回执带错误码，三个幂等字段恒 false。
  reject,
}

/// [AmooMailbox.decide] 的一次结论。receipt 只在 reject 时非空，resultFile
/// 只在 replay 时非空（K-25：重放的就是盘上那个首次结果）。
class AmooMailDecision {
  const AmooMailDecision._({
    required this.action,
    this.receipt,
    this.resultFile,
  });

  final AmooMailAction action;
  final AmooReceipt? receipt;
  final String? resultFile;
}

/// 信箱三态的文件名与准入判定（K-03，镜像 BridgeService.java:474-512）。
///
/// decide 是纯判定：盘上状态由调用方以 [present] 喂进来，适配器自己不碰
/// 文件系统——与 [AmooBridge.send] 同一条理由，判定因此可复现。
class AmooMailbox {
  /// id 规范 1-128 位 [A-Za-z0-9_-]（BridgeService.java:456-465）。id 落在
  /// 文件名里，形状不合法就是目录穿越的口子。
  static bool isValidId(String id) => _kMailboxId.hasMatch(id);

  static String cmdFile(String id) => 'cmd_$id.json';

  static String processingFile(String id) => 'processing_$id.json';

  static String resultFile(String id) => 'result_$id.json';

  /// 一笔信箱命令能不能执行、怎么执行。[bodyId] 是正文里的 id——与文件名
  /// id 不一致按 invalid_arguments 拒（BridgeService.java:524-525：那次
  /// 什么都没到工具层）。
  ///
  /// result 与遗留 processing 同时在，仍以 result 为准：拒绝路径绝不覆盖
  /// 既有 result（BridgeService.java:487-511 同秒冲突分支的硬约束）。
  /// 顺序与桥侧一致：先看 result（重放），再看遗留 processing（拒），
  /// 最后才读正文 id——桥侧也是在认领之后才比对正文的。
  static AmooMailDecision decide({
    required String id,
    required String bodyId,
    required Set<String> present,
  }) {
    if (!isValidId(id)) {
      return AmooMailDecision._(
        action: AmooMailAction.reject,
        receipt: AmooErrors.of(
          AmooErrors.invalidArguments,
          error: '信箱 id "$id" 不是合法形状（1-128 位字母/数字/下划线/短横线）：未执行、无副作用。',
          fix: '改用合法形状的 id 重写 cmd_$id.json，id 规范读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        ),
      );
    }
    if (present.contains(resultFile(id))) {
      return AmooMailDecision._(
        action: AmooMailAction.replay,
        resultFile: resultFile(id),
      );
    }
    if (present.contains(processingFile(id))) {
      return AmooMailDecision._(
        action: AmooMailAction.reject,
        receipt: AmooErrors.of(
          AmooErrors.duplicateId,
          error: '同 id 已有遗留 processing_$id.json（上次执行结果未知）：重放会双重执行。',
          fix: '先读 result_$id.json 或核对界面副作用，确认后删除该遗留文件再发；重放语义读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        ),
      );
    }
    if (bodyId != id) {
      return AmooMailDecision._(
        action: AmooMailAction.reject,
        receipt: AmooErrors.of(
          AmooErrors.invalidArguments,
          error: '信箱命令被拒绝：正文 id（$bodyId）与文件名 id（$id）不一致。',
          fix: '两者一致后重写 cmd_$id.json，信箱形状读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        ),
      );
    }
    return const AmooMailDecision._(action: AmooMailAction.claim);
  }
}

/// 只读判定，逐字镜像 BridgeService.java:610-621（K-24 成功路径的 read 判据：
/// 派发了 且 ok 且 只读，replay_safe/retry_safe 才为 true）。
///
/// 双态工具看参数：带值即变异。未列入的一律按变异处理——猜安全的后果是
/// 重放了有副作用的动作，而调用方以为没副作用（桥侧注释原文：anything not
/// listed here is treated as mutating）。
class AmooTools {
  static const Set<String> readOnlyNames = <String>{
    'ping',
    'info',
    'tools',
    'ls',
    'read',
    'stat',
    'list_apps',
    'battery',
    'loop_status',
    'amoo_result',
    'secret_list',
    'ui_dump',
    'shot',
    'shot_b64',
  };

  static bool isReadOnly(String tool, Map<String, dynamic> args) {
    switch (tool) {
      case 'volume':
        return !args.containsKey('level');
      case 'brightness':
        return !args.containsKey('value');
      case 'clipboard':
      case 'amoo_memory':
        return args['op'] != 'set';
      default:
        return readOnlyNames.contains(tool);
    }
  }
}

/// kind=结果 的回执体（K-24/K-62）。三个幂等字段不是构造参数：read 判据是
/// 「派发了 且 ok 且 只读」的合取（BridgeService.java:584），由这一类算——
/// 让调用方自己填的后果，是重放了有副作用的动作还以为能重放。
///
/// 时间戳不在这里盖：适配器不读系统时钟（与租约闸门同一条理由——喂进来的
/// 可观测量才算得动，判定因此可复现），由落盘那一侧盖。
class AmooResult {
  const AmooResult._({
    required this.id,
    required this.tool,
    required this.ok,
    required this.actionDispatched,
    required this.replaySafe,
    required this.retrySafe,
    required this.output,
  });

  final String id;
  final String tool;
  final bool ok;
  final bool actionDispatched;
  final bool replaySafe;
  final bool retrySafe;
  final Map<String, dynamic> output;

  static AmooResult of({
    required String id,
    required String tool,
    required bool ok,
    required bool dispatched,
    Map<String, dynamic> args = const <String, dynamic>{},
    Map<String, dynamic> output = const <String, dynamic>{},
  }) {
    final read = dispatched && ok && AmooTools.isReadOnly(tool, args);
    return AmooResult._(
      id: id,
      tool: tool,
      ok: ok,
      actionDispatched: dispatched,
      replaySafe: read,
      retrySafe: read,
      output: output,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'kind': AmooKind.result.wire,
        'id': id,
        'tool': tool,
        'ok': ok,
        'output': output,
        'action_dispatched': actionDispatched,
        'replay_safe': replaySafe,
        'retry_safe': retrySafe,
      };
}

/// 一笔消息在信箱里的四态（K-61：「已下发未确认」的观测量是 processing 在、
/// result 缺席）。
enum AmooDeliveryState {
  /// 目录里没有这个 id 的任何痕迹。
  absent,

  /// 只有 cmd_：worker 还没认领。
  dispatched,

  /// processing 在、result 缺席：副作用未知，不自动重放。
  unconfirmed,

  /// result 在：已结算，重放读它（K-25）。
  settled,
}

/// 四态的判定与措辞。措辞是给用户看的状态文本（仓库规则 2）：unconfirmed
/// 必须说「未确认」——说成「已执行」是 K-00c 禁的谎。
class AmooDelivery {
  static AmooDeliveryState stateOf({
    required Set<String> present,
    required String id,
  }) {
    if (present.contains(AmooMailbox.resultFile(id))) {
      return AmooDeliveryState.settled;
    }
    if (present.contains(AmooMailbox.processingFile(id))) {
      return AmooDeliveryState.unconfirmed;
    }
    if (present.contains(AmooMailbox.cmdFile(id))) {
      return AmooDeliveryState.dispatched;
    }
    return AmooDeliveryState.absent;
  }

  static String labelOf(AmooDeliveryState state) {
    switch (state) {
      case AmooDeliveryState.absent:
        return '无痕迹';
      case AmooDeliveryState.dispatched:
        return '已下发';
      case AmooDeliveryState.unconfirmed:
        return '已下发未确认';
      case AmooDeliveryState.settled:
        return '已结算';
    }
  }
}

/// 对话内容流的事件全集（K-31）：逐字等于 /api/ai/chat/stream 的 sendEvent
/// 八种（runtime/node/backend/src/routes/ai.js）与 KhyOsStreamEvent
/// （lib/core/gateway/khyos_api.dart:28-39）。
///
/// 不 import KhyOsStreamEvent 是有意的：那个类拽着 dio 与 secure_storage，
/// 传输层背不动，B1 门也会就此多依赖一个业务模块的健康。这八个名字与错误码
/// 同属「镜像真源」的线上词汇，不是平行实现；自造一套事件名才是禁止项
/// （轮询伪装事件流，TASK.md §10）。
class AmooStream {
  static const Set<String> events = <String>{
    'start',
    'status',
    'heartbeat',
    'control_request',
    'chunk',
    'thinking_content',
    'done',
    'error',
  };
}

/// 对等体登记表（K-13）：from/to 必须是握手中交换过的身份，未登记一律拒
/// unknown_peer。
class AmooPeers {
  AmooPeers(this.registered);

  final Set<String> registered;

  AmooReceipt? checkRoute({required String from, required String to}) {
    if (registered.contains(from) && registered.contains(to)) return null;
    return AmooErrors.of(
      AmooErrors.unknownPeer,
      error: '对等体未登记（from=$from, to=$to）：from/to 必须是握手中交换过的身份。',
      fix: '改用已登记身份（${registered.join('/')}）后重发，对等体登记读 GET /agent-guide?topic=mailbox',
      guideTopic: 'mailbox',
    );
  }
}
