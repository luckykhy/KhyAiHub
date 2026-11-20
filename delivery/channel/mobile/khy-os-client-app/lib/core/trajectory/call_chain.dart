/// B6 调用链护栏 —— 设备侧桥（android/.../bridge/CallChain.java）同一份数值契约的
/// Dart 镜像（contract §6 K-50/K-51/K-52，错误码表 K-23）。
///
/// 为什么 Dart 侧也有一份：depth 上限、每 trace 调用预算、四个错误码是**数值契约**，
/// 两端必须逐字一致。设备侧判定（device/B6.md）要 31 次信箱往返才看得到一次熔断；
/// 这里同一组数值跑一次就够，两端漂移时先在单元门红，而不是等到设备上红得不明不白。
///
/// 与 trace_envelope.dart / trace_chain.dart 的分工：那两个是轨迹 Provenance 家族，
/// 管「这条记录是谁产的、可不可信」；本模块管「这一跳能不能调」——递归深度、调用
/// 预算、序号。同一组字段两种语义只会让两处判据互相污染，所以不并家。
library;

/// 本端声明的协议版本。对端不在 [kSupportedProtoV] 内即拒（K-20）。
const String kProtoV = '1.0';

/// 本端支持的协议版本集合；拒 proto_v 时要把自己支持的值带给对方（K-20）。
const Set<String> kSupportedProtoV = <String>{kProtoV};

/// 递归深度上限：depth=0/1 放行，depth>=2 拒（K-51，A→B→A 的第 3 层起不接受）。
const int kMaxDepth = 2;

/// 单条 trace 的调用次数上限。直接复用桥侧 AmooLoop.Options.maxRounds=30，
/// 不新造第二个预算数值（device/B6.md §1.2：再定一个新数就是第二个预算真源）。
const int kMaxCallsPerTrace = 30;

/// 错误码与 contract K-23 表逐字一致；改这里等于改合同，四个码一起改。
const String kCodeRecursionDepthExceeded = 'recursion_depth_exceeded';
const String kCodeSessionBudgetExceeded = 'session_budget_exceeded';
const String kCodeInvalidArguments = 'invalid_arguments';
const String kCodeSeqConflict = 'seq_conflict';
const String kCodeProtoVUnsupported = 'proto_v_unsupported';

/// 12 个合约字段（TASK.md §5 硬性字段集）。闭集：多一个字段即拒（K-20）。
const List<String> _kFields = <String>[
  'proto_v',
  'session_id',
  'msg_id',
  'seq',
  'from',
  'to',
  'kind',
  'payload',
  'trace_id',
  'parent_span',
  'depth',
  'idempotency_key',
];

/// session_id 形状与后端同一把尺子（khyos_api.dart:292 按该校验）。
final RegExp _kSessionId = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

/// kind 五选一，线上值是中文枚举（contract §3.1）。
enum CallKind {
  instruction('指令'),
  event('事件'),
  approval('审批'),
  result('结果'),
  error('错误');

  const CallKind(this.wire);

  final String wire;

  static CallKind? fromWire(Object? value) {
    for (final k in CallKind.values) {
      if (k.wire == value) return k;
    }
    return null;
  }
}

/// 形状被拒时抛出的错误（K-22 回执三件套：问题一句话 + 修复建议 + 下一步读什么）。
class CallRejected implements Exception {
  CallRejected({
    required this.code,
    required this.error,
    required this.fix,
    required this.guideTopic,
  });

  final String code;
  final String error;
  final String fix;

  /// 指向 /agent-guide 的主题名；主题白名单在桥侧（exec/mailbox/schema/ui/loop），
  /// 这里只允许指到真实存在的主题，否则回执让人去读一份不存在的规范。
  final String guideTopic;
}

/// 一跳调用的信封。span id 就是 [msgId]——信封里没有第 13 个字段，
/// 「span 链可复原」不引入新字段（device/B6.md §1.1）。
class CallEnvelope {
  const CallEnvelope({
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
  final String msgId;
  final int seq;
  final String from;
  final String to;
  final CallKind kind;
  final Map<String, dynamic> payload;

  /// 调用链根 id，一次跨端任务全程不变（K-50）。
  final String traceId;

  /// 父 span id；根消息为空（缺席或显式 null 都合法）。
  final String? parentSpan;
  final int depth;

  /// kind=指令/审批 必填（K-25：同 key 重放返回首次结果）；其余 kind 可空。
  final String? idempotencyKey;

  /// 解析一跳信封。形状不符抛 [CallRejected]，code 必是 K-23 表里的一个。
  ///
  /// 只做**形状**判断：depth 超限、预算超限、序号冲突是运行时判据，归
  /// [CallGuard.admit]——parse 红的是「这封信写错了」，admit 红的是「这一跳
  /// 不许调」，两种红的修法不同，不能合成一个 error。
  ///
  /// [tolerateUnknownProtoV] 只给渲染路径用（ui/render/envelope_render.dart）：
  /// 形状合法但版本未知时照常返回信封，版本处置归调用方——按最低兼容版本
  /// 渲染并提示版本不匹配。护栏路径（缺省）仍拒（K-20）：拒收是调用闸门的
  /// 语义，渲染是展示语义，渲染侧拒收等于把用户已收到的回复整份丢掉。
  static CallEnvelope parse(Object? json, {bool tolerateUnknownProtoV = false}) {
    if (json is! Map) {
      throw CallRejected(
        code: kCodeInvalidArguments,
        error: '信封不是 JSON 对象（收到 ${_typeName(json)}）：调用链信封是 12 字段的 JSON 对象。',
        fix: '按 12 字段信封重写，字段表读 GET /agent-guide?topic=mailbox',
        guideTopic: 'mailbox',
      );
    }
    for (final key in json.keys) {
      if (key is! String || !_kFields.contains(key)) {
        throw CallRejected(
          code: kCodeInvalidArguments,
          error: '信封含未定义字段 "$key"：顶层只允许 12 个合约字段。',
          fix: '去掉该字段后重写，字段表读 GET /agent-guide?topic=mailbox',
          guideTopic: 'mailbox',
        );
      }
    }

    final protoV = json['proto_v'];
    if (protoV is! String || protoV.isEmpty) {
      throw _invalid('proto_v 缺失或不是字符串', '补上本端声明的协议版本');
    }
    if (!kSupportedProtoV.contains(protoV)) {
      if (!tolerateUnknownProtoV) {
        throw CallRejected(
          code: kCodeProtoVUnsupported,
          error: 'proto_v "$protoV" 不在对端支持集合内：本端只支持 ${kSupportedProtoV.join('、')}。',
          fix: '把 proto_v 改成受支持的值（${kSupportedProtoV.join('、')}）后重发',
          guideTopic: 'mailbox',
        );
      }
      // 渲染路径：版本未知不在这里处置，见函数头注释。
    }

    final sessionId = json['session_id'];
    if (sessionId is! String || !_kSessionId.hasMatch(sessionId)) {
      throw _invalid(
        'session_id "$sessionId" 形状不合法：须 1-64 位字母/数字/下划线/短横线',
        '改用合法形状的会话 id 后重发',
      );
    }

    final msgId = json['msg_id'];
    if (msgId is! String || msgId.isEmpty) {
      throw _invalid('msg_id 缺失或为空：span id 就是 msg_id，空值无法复原调用链', '补上全局唯一的 msg_id');
    }

    final seq = json['seq'];
    if (seq is! int) {
      throw _invalid('seq 缺失或不是整数（收到 ${_typeName(seq)}）', '把 seq 改成本方向的下一个序号');
    }

    final from = json['from'];
    if (from is! String || from.isEmpty) {
      throw _invalid('from 缺失或为空', '补上发起方身份');
    }
    final to = json['to'];
    if (to is! String || to.isEmpty) {
      throw _invalid('to 缺失或为空', '补上接收方身份');
    }

    final kind = CallKind.fromWire(json['kind']);
    if (kind == null) {
      throw _invalid(
        'kind "${json['kind']}" 不是五个合约值之一（指令/事件/审批/结果/错误）',
        '把 kind 改成五个合约值之一',
      );
    }

    final payload = json['payload'];
    if (payload is! Map<String, dynamic>) {
      throw _invalid(
        'payload 缺失或不是 JSON 对象（收到 ${_typeName(payload)}）',
        '把 payload 改为对象后重发',
      );
    }
    if (kind == CallKind.instruction) {
      // kind=指令 的 payload 是闭集 {tool,args}（contract §3.1 payload 行）。
      // 其余 kind 的 payload 形状由各自的节定义（审批见 §9），这里只要求是对象。
      for (final key in payload.keys) {
        if (key != 'tool' && key != 'args') {
          throw CallRejected(
            code: kCodeInvalidArguments,
            error: 'kind=指令 的 payload 含未定义字段 "$key"：闭集为 {tool,args}。',
            fix: '去掉该字段后重发，每工具参数细节读 GET /agent-guide?topic=schema',
            guideTopic: 'schema',
          );
        }
      }
      final tool = payload['tool'];
      if (tool is! String || tool.isEmpty) {
        throw CallRejected(
          code: kCodeInvalidArguments,
          error: 'kind=指令 的 payload 缺 tool 或 tool 为空：闭集为 {tool,args}。',
          fix: '补上工具名后重发，工具表读 GET /agent-guide?topic=schema',
          guideTopic: 'schema',
        );
      }
      if (payload['args'] is! Map) {
        throw CallRejected(
          code: kCodeInvalidArguments,
          error: 'kind=指令 的 payload 的 args 不是 JSON 对象（收到 ${_typeName(payload['args'])}）：闭集为 {tool,args}。',
          fix: '把 args 改为对象后重发，每工具参数细节读 GET /agent-guide?topic=schema',
          guideTopic: 'schema',
        );
      }
    }

    final traceId = json['trace_id'];
    if (traceId is! String || traceId.isEmpty) {
      throw _invalid('trace_id 缺失或为空：一次跨端任务全程不变，空值无法对账', '补上调用链根 id');
    }

    final parentSpan = json['parent_span'];
    if (parentSpan != null && (parentSpan is! String || parentSpan.isEmpty)) {
      throw _invalid(
        'parent_span 必须是字符串或空（收到 ${_typeName(parentSpan)}）：根消息用 null，不用空串',
        '把 parent_span 改为父消息的 msg_id，根消息改为 null',
      );
    }

    final depth = json['depth'];
    if (depth is! int || depth < 0) {
      throw _invalid(
        'depth 缺失、不是整数或为负（收到 ${_typeName(depth)}）：depth 是主叫方的实际层级',
        '把 depth 改为 0 或正整数后重发',
      );
    }

    final idempotencyKey = json['idempotency_key'];
    if (kind == CallKind.instruction || kind == CallKind.approval) {
      if (idempotencyKey is! String || idempotencyKey.isEmpty) {
        throw _invalid(
          'kind=${kind.wire} 缺 idempotency_key：同 key 重放要能返回首次结果',
          '补上全局唯一的幂等键后重发',
        );
      }
    } else if (idempotencyKey != null && idempotencyKey is! String) {
      throw _invalid('idempotency_key 不是字符串', '把 idempotency_key 改为字符串或省略');
    }

    return CallEnvelope(
      protoV: protoV,
      sessionId: sessionId,
      msgId: msgId,
      seq: seq,
      from: from,
      to: to,
      kind: kind,
      payload: Map<String, dynamic>.from(payload),
      traceId: traceId,
      parentSpan: parentSpan is String ? parentSpan : null,
      depth: depth,
      idempotencyKey: idempotencyKey is String ? idempotencyKey : null,
    );
  }

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
        'idempotency_key': idempotencyKey,
      };

  static CallRejected _invalid(String problem, String fix) => CallRejected(
        code: kCodeInvalidArguments,
        error: '$problem。',
        fix: '$fix，字段表读 GET /agent-guide?topic=mailbox',
        guideTopic: 'mailbox',
      );

  static String _typeName(Object? v) => v == null ? 'null' : v.runtimeType.toString();
}

/// 一跳调用过不过闸门的判定。[receipt] 镜像 HttpBridge.invalidArguments 的形状：
/// 信封级拒绝时三个幂等字段恒 false（K-24），预算拒时另带 used 与 limit。
class CallVerdict {
  const CallVerdict._({
    required this.admitted,
    this.code,
    this.error,
    this.fix,
    this.guideTopic,
    this.used,
    this.limit,
  });

  final bool admitted;
  final String? code;
  final String? error;
  final String? fix;
  final String? guideTopic;

  /// 本条 trace 已放行的调用数；预算拒时等于 [limit]。
  final int? used;

  /// 单条 trace 的调用上限（[kMaxCallsPerTrace]）。
  final int? limit;

  /// 回执。放行时只报 ok——这一跳的执行结果归工具层，护栏不代它说话；
  /// 拒时给全三件套 + 三个恒 false 的幂等字段。
  Map<String, dynamic> receipt() {
    if (admitted) return <String, dynamic>{'ok': true};
    return <String, dynamic>{
      'ok': false,
      'code': code,
      'error': error,
      'fix': fix,
      'guide_topic': guideTopic,
      'action_dispatched': false,
      'replay_safe': false,
      'retry_safe': false,
      if (used != null) 'used': used,
      if (limit != null) 'limit': limit,
    };
  }
}

/// 调用链护栏。一个实例守一侧（A 侧一个、B 侧一个），记账只进内存：
/// 进程重启后序号基线从零起，跨轮续接的基线由调用方按已确认的最大 seq 喂进来
/// ——那需要持久化，本模块不做（B8 租约的面）。
class CallGuard {
  final Map<String, int> _calls = <String, int>{};
  final Map<String, int> _seqBase = <String, int>{};

  /// 这条 trace 已放行的调用数。
  int usedCalls(String traceId) => _calls[traceId] ?? 0;

  /// 本侧记到的 trace id 集合（判据【B6】：两端记到的 trace_id 同一个）。
  Set<String> traceIds() => _calls.keys.toSet();

  /// 拒因检查顺序 depth → 预算 → seq（device/B6.md §1.3）：超预算的 trace
  /// 再发必须报预算码，不让调用方误以为只是序号错。
  CallVerdict admit(CallEnvelope env) {
    if (env.depth >= kMaxDepth) {
      return CallVerdict._(
        admitted: false,
        code: kCodeRecursionDepthExceeded,
        error: '调用链第 ${env.depth + 1} 层被拒：depth 上限 $kMaxDepth，'
            '被调用方不得回调用发起方做同一目标。',
        fix: '收敛调用链（换 trace_id 重开一条）或改用结果文件回写，'
            '递归防护读 GET /agent-guide?topic=mailbox',
        guideTopic: 'mailbox',
      );
    }
    final used = usedCalls(env.traceId);
    if (used >= kMaxCallsPerTrace) {
      return CallVerdict._(
        admitted: false,
        code: kCodeSessionBudgetExceeded,
        error: '本条 trace 的调用次数已达上限（已用 $used / 上限 $kMaxCallsPerTrace）：'
            '互调熔断，不再放行。',
        fix: '停止继续调用，先汇总已得结果或另起 trace_id，'
            '预算语义读 GET /agent-guide?topic=mailbox',
        guideTopic: 'mailbox',
        used: used,
        limit: kMaxCallsPerTrace,
      );
    }
    // 序号基线按 (session_id, 方向) 独立计数，不按 trace 算（K-20）：
    // 同一条会话里换 trace 是正常的长任务，不该被序号砍。
    final key = '${env.sessionId}|${env.from}|${env.to}';
    final expect = (_seqBase[key] ?? 0) + 1;
    if (env.seq != expect) {
      return CallVerdict._(
        admitted: false,
        code: kCodeSeqConflict,
        error: '序号冲突：本方向下一条应为 $expect，收到 ${env.seq}。',
        fix: '按已确认的最大 seq 续序后重发（被拒的消息不进基线），'
            '信封字段读 GET /agent-guide?topic=mailbox',
        guideTopic: 'mailbox',
      );
    }
    _calls[env.traceId] = used + 1;
    _seqBase[key] = env.seq;
    return const CallVerdict._(admitted: true);
  }
}

/// 沿 parent_span 反推 span 链，根在前。
///
/// 尖点取 depth 最大者（并列取列表中靠后一条）；断链反推到断点为止——
/// 不猜不补，父 span 不在场时那一跳就是链的起点，不拿别的消息冒充上一跳
/// （K-50「span 链可复原」+ 单测「断链不猜不补」）。
List<String> spanChain(List<CallEnvelope> envelopes) {
  if (envelopes.isEmpty) return const <String>[];
  var tip = envelopes.first;
  for (final e in envelopes) {
    if (e.depth >= tip.depth) tip = e;
  }
  final byId = <String, CallEnvelope>{for (final e in envelopes) e.msgId: e};
  final out = <String>[];
  var cur = tip;
  // 环检测：parent_span 指回链上某一跳时停。信封来自对端，环是可能的输入，
  // 不是不可能的异常。
  while (!out.contains(cur.msgId)) {
    out.add(cur.msgId);
    final parentId = cur.parentSpan;
    if (parentId == null) break;
    final parent = byId[parentId];
    if (parent == null) break;
    cur = parent;
  }
  return out.reversed.toList();
}
