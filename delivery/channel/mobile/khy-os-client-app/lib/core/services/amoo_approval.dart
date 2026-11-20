/// 远端审批——跨端有副作用动作的确认面（contract §9 K-80–K-84）。
///
/// 为什么单独一个模块，而不是并进 PermissionMode：远端的发起者不是握着手机的那个人，
/// 他看不见屏幕，也不知道自己那次 rm 落在哪。所以「要不要问」必须与模式层解耦——
/// 把本机 bypass 的授权跨端继承，等于让一个人替另一个人关掉一道安全提示。
/// 单元门用「四种模式下同一个结论」把这条钉住。
///
/// 超时也判在设备侧，且 ApprovalGate.decide 自己就会判：云端轮询读状态文件的间隙里，
/// 超时必须已经被判掉。等人来调 expireDue 才拒，等于把「默认拒绝」的执行权交给一个
/// 没人保证会跑的定时器。
///
/// 与 audit_log.dart 同目录是刻意的：审批每次状态改写都要进审计，而 core/services
/// 是执行侧与文件侧的公共下游，方向只有一条。
library;

import 'package:khy_os_client/core/services/audit_log.dart';

/// 确认面第一类：命令本身有多危险，判据在参数里。
/// 逐字镜像桥侧 `LoopModes.java` 的 HIGH_RISK_TOOLS；相等性由
/// amoo_b7_test.dart 的原生镜像断言钉住，这里只放镜像值。
const Set<String> kHighRiskTools = <String>{'exec', 'rm'};

/// 确认面第二类：这个工具做的事撤不回来，判据在工具名上——参数再正常也不改变结论。
/// 同样是 LoopModes.java IRREVERSIBLE_TOOLS 的逐字镜像。
const Set<String> kIrreversibleTools = <String>{
  'secret_code',
  'secret_put',
  'secret_list',
  'secret_del',
  'adou_signin',
  'amoo_ask',
  'amoo_result',
  'amoo_memory',
  'amoo_stop',
};

/// 确认面 = 两个名单的并集。不出现第三份「也要确认」的名单：两份名单各自有原生
/// 真源，并集只是算术，再抄一份就是第三个会漂移的出处。
const Set<String> kConfirmTools = <String>{...kHighRiskTools, ...kIrreversibleTools};

/// 与模式无关：任何入口、任何档位，名单内的工具都要人批。
bool needsHumanApproval(String tool) => kConfirmTools.contains(tool);

/// 超时时长。与 exec 单次上限同一个量级（`Tools.java` 的 `Math.min(timeout, 120)`），
/// 比 B1 的 30s 结果文件判据长——锁屏上看到通知、解锁、读摘要、做决定，30 秒不够；
/// 但也不该超过一次 exec，否则云端那侧早就判它挂了。
const int kApprovalTimeoutMs = 120000;

/// 参数摘要长度上限。状态文件要小（云端轮询读），弹框要一眼读完。
const int kArgsDigestMaxChars = 600;

/// 审批单 id 形状。与信箱 id 同一条规则（`BridgeService.java:456-465`）：这个 id
/// 会落进状态文件名，`/` 与 `..` 必须被拒。
final RegExp _kIdShape = RegExp(r'^[A-Za-z0-9_-]{1,128}$');

// 状态文件字段闭集（K-81）。这些名字是设备侧与云端之间唯一的共识载体：写错一个
// 字母不报编译错，只会让云端永远读到空。所以集中钉在这一处，toJson/parse 都指这里。
const String _fApprovalId = "approval_id";
const String _fState = "state";
const String _fMsgId = "msg_id";
const String _fTraceId = "trace_id";
const String _fTool = "tool";
const String _fArgsDigest = "args_digest";
const String _fCreatedAt = "created_at";
const String _fExpiresAt = "expires_at";
const String _fDecidedAt = "decided_at";
const String _fDecidedBy = "decided_by";

const List<String> _kFields = <String>[
  _fApprovalId,
  _fState,
  _fMsgId,
  _fTraceId,
  _fTool,
  _fArgsDigest,
  _fCreatedAt,
  _fExpiresAt,
  _fDecidedAt,
  _fDecidedBy,
];

/// 前八个必填；后两个（决策时间、决策人）可缺席——未决的单本来就没人批过。
const List<String> _kRequiredFields = <String>[
  _fApprovalId,
  _fState,
  _fMsgId,
  _fTraceId,
  _fTool,
  _fArgsDigest,
  _fCreatedAt,
  _fExpiresAt,
];

/// guide_topic 只指真实存在的主题（`khy_bridge_guide.md` 的 TOPIC 索引）。
/// 审批相关指向 exec——危险命令底线与「先确认再执行」写在那一段；
/// 重放语义指向 mailbox——id 唯一性与三态协议写在那一段。
const String _kGuideExec = 'exec';
const String _kGuideMailbox = 'mailbox';

/// K-81 四态，无第五态。
enum ApprovalState {
  pending('pending'),
  approved('approved'),
  denied('denied'),
  expired('expired');

  const ApprovalState(this.wire);

  final String wire;

  static ApprovalState? fromWire(Object? value) {
    for (final s in ApprovalState.values) {
      if (s.wire == value) return s;
    }
    return null;
  }
}

/// 错误码闭集（K-23）里本模块会用到的三个，不新造第四个。
class AmooApprovalCodes {
  static const String approvalRequired = 'approval_required';
  static const String approvalTimeout = 'approval_timeout';
  static const String duplicateId = 'duplicate_id';
}

/// 键名装的是凭据本身时，值整条替换。判据是「这个名字是什么」，不是「这次恰不像个
/// 凭据」——`token=abc` 与 `token=1` 同样不该出现在人要读的摘要里。
const Set<String> _kSecretKeys = <String>{
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'pin',
  'otp',
  'code',
  'authorization',
  'auth',
  'cookie',
  'session',
  'session_token',
  'credential',
  'credentials',
  'private_key',
  'bearer',
};

/// 值里夹带的凭据形态。键名漏判时的兜底：一条命令串里带一个 Bearer 或 sk- 令牌，
/// 光替换键名是挡不住的。
final RegExp _kSecretShapes =
    RegExp(r'[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{4,}');

/// 参数摘要。人要能认得出自己在批什么（路径、命令要可读），但不能看见凭据原文
/// （K-81：敏感参数只放摘要，不进原文）。
///
/// 键序无关：云端与设备侧对同一份 args 各序列化一次，顺序不同不算不同的审批。
String approvalArgsDigest(Map<String, dynamic> args) {
  if (args.isEmpty) return '{}';
  final keys = args.keys.toList()..sort();
  final parts = <String>[for (final k in keys) '$k=${_renderValue(k, args[k])}'];
  final digest = parts.join('; ');
  if (digest.length <= kArgsDigestMaxChars) return digest;
  return '${digest.substring(0, kArgsDigestMaxChars - 3)}...';
}

String _renderValue(String key, Object? value) {
  if (_kSecretKeys.contains(key.toLowerCase())) return '***';
  if (value is Map) {
    if (value.isEmpty) return '{}';
    final inner = value.keys.map((k) => '$k').toList()..sort();
    return '{${inner.map((k) => '$k=${_renderValue(k, value[k])}').join('; ')}}';
  }
  if (value is String) return value.replaceAll(_kSecretShapes, '[redacted]');
  return '$value';
}

/// 审批状态文件的一条记录。十个字段闭集，多一个字段即拒（K-81）。
class ApprovalRecord {
  const ApprovalRecord({
    required this.approvalId,
    required this.state,
    required this.msgId,
    required this.traceId,
    required this.tool,
    required this.argsDigest,
    required this.createdAt,
    required this.expiresAt,
    this.decidedAt,
    this.decidedBy,
  });

  final String approvalId;
  final ApprovalState state;
  final String msgId;
  final String traceId;
  final String tool;
  final String argsDigest;
  final int createdAt;
  final int expiresAt;
  final int? decidedAt;
  final String? decidedBy;

  /// 还剩多少毫秒到期。负数表示已过期。
  int remainingMs(int nowMs) => expiresAt - nowMs;

  Map<String, dynamic> toJson() => <String, dynamic>{
        _fApprovalId: approvalId,
        _fState: state.wire,
        _fMsgId: msgId,
        _fTraceId: traceId,
        _fTool: tool,
        _fArgsDigest: argsDigest,
        _fCreatedAt: createdAt,
        _fExpiresAt: expiresAt,
        _fDecidedAt: decidedAt,
        _fDecidedBy: decidedBy,
      };

  /// 读回一条记录。任何一个字段不对就返回 null——审批文件是设备与云端之间唯一的
  /// 共识载体，形状不对时答「没有这一条」比答「按默认值来」安全。
  static ApprovalRecord? parse(Object? raw) {
    if (raw is! Map) return null;
    final keys = raw.keys.map((k) => '$k').toSet();
    if (!keys.containsAll(_kRequiredFields)) return null;
    if (!_kFields.toSet().containsAll(keys)) return null;

    final id = raw[_fApprovalId];
    if (id is! String || !_kIdShape.hasMatch(id)) return null;
    final state = ApprovalState.fromWire(raw[_fState]);
    if (state == null) return null;
    final msgId = raw[_fMsgId];
    final traceId = raw[_fTraceId];
    final tool = raw[_fTool];
    final digest = raw[_fArgsDigest];
    if (msgId is! String || msgId.isEmpty) return null;
    if (traceId is! String || traceId.isEmpty) return null;
    if (tool is! String || tool.isEmpty) return null;
    if (digest is! String || digest.isEmpty) return null;
    final createdAt = raw[_fCreatedAt];
    final expiresAt = raw[_fExpiresAt];
    if (createdAt is! num || expiresAt is! num) return null;
    // 出生即过期的单没有意义：云端读到它就必然拒绝，这一条从来不该存在。
    if (expiresAt.compareTo(createdAt) <= 0) return null;
    final decidedAt = raw[_fDecidedAt];
    if (decidedAt != null && decidedAt is! num) return null;
    final decidedBy = raw[_fDecidedBy];
    if (decidedBy != null &&
        (decidedBy is! String || decidedBy.trim().isEmpty)) {
      return null;
    }
    return ApprovalRecord(
      approvalId: id,
      state: state,
      msgId: msgId,
      traceId: traceId,
      tool: tool,
      argsDigest: digest,
      createdAt: createdAt.toInt(),
      expiresAt: expiresAt.toInt(),
      decidedAt: decidedAt?.toInt(),
      decidedBy: decidedBy,
    );
  }

  ApprovalRecord _replace({
    required ApprovalState state,
    int? decidedAt,
    String? decidedBy,
  }) =>
      ApprovalRecord(
        approvalId: approvalId,
        state: state,
        msgId: msgId,
        traceId: traceId,
        tool: tool,
        argsDigest: argsDigest,
        createdAt: createdAt,
        expiresAt: expiresAt,
        decidedAt: decidedAt,
        decidedBy: decidedBy,
      );
}

/// 一次审批判决。execute=false 时三幂等字段恒 false（K-24：什么都没到工具层）。
class ApprovalVerdict {
  const ApprovalVerdict({
    required this.execute,
    required this.code,
    required this.error,
    required this.fix,
    required this.guideTopic,
    required this.state,
    required this.approvalId,
    required this.label,
  });

  /// 能不能真的去执行。
  final bool execute;

  /// 拒绝码，只在 K-23 表里取。execute=true 时为 null。
  final String? code;

  final String error;
  final String fix;
  final String guideTopic;
  final ApprovalState? state;

  /// 这一判决针对的审批单；没有单时为 null。
  final String? approvalId;

  /// 给人看的一句话。必须说清「未执行」——把「已下发未确认」说成「已执行」是
  /// K-00c 明令禁止的那件事。
  final String label;

  Map<String, dynamic> receipt() => <String, dynamic>{
        'ok': execute,
        'code': code,
        'error': error,
        'fix': fix,
        'guide_topic': guideTopic,
        'approval_state': state?.wire,
        'action_dispatched': execute,
        // 批准过一次不等于可以再放行一次：副作用已经发生，重放会二次执行。
        'replay_safe': false,
        'retry_safe': false,
      };
}

/// 审批闸门。
///
/// 内存态：状态文件的落盘与清理归桥侧信箱目录的保留期策略，本模块只判「批没批」。
/// 所有时间参数都可注入，默认取真实时钟——单元门不许真实时钟进判定。
class ApprovalGate {
  final Map<String, ApprovalRecord> _records = <String, ApprovalRecord>{};
  final Set<String> _consumed = <String>{};

  int _nowMs() => DateTime.now().millisecondsSinceEpoch;

  /// 生成或取回一张待审单。
  ///
  /// 同一个 approvalId 重复请求返回首次那一张：云端重发不弹第二次框（K-25 同 key
  /// 重放返回首次结果）。参数不同也不重新生成——按首参摘要执行，是「首次结果」
  /// 的语义；调用方要改参数就得换 key。
  ///
  /// id 形状不在这里校验：信封侧已按信箱 id 规则拦过（amoo_bridge_adapter.dart），
  /// 内部可信路径不套第二道。
  ApprovalRecord request({
    required String approvalId,
    required String msgId,
    required String traceId,
    required String tool,
    Map<String, dynamic> args = const <String, dynamic>{},
    int? nowMs,
  }) {
    final existing = _records[approvalId];
    if (existing != null) return existing;
    final created = nowMs ?? _nowMs();
    final record = ApprovalRecord(
      approvalId: approvalId,
      state: ApprovalState.pending,
      msgId: msgId,
      traceId: traceId,
      tool: tool,
      argsDigest: approvalArgsDigest(args),
      createdAt: created,
      expiresAt: created + kApprovalTimeoutMs,
    );
    _records[approvalId] = record;
    return record;
  }

  ApprovalRecord? find(String approvalId) => _records[approvalId];

  List<ApprovalRecord> pending() => _records.values
      .where((r) => r.state == ApprovalState.pending)
      .toList(growable: false);

  /// 人点了「批准」。
  ///
  /// 已过期的单点批准不算数（K-82）：云端那侧已经读到 expired 了，这里再改回来
  /// 就是两端说两套话。此时原样返回那一张，状态仍是 expired。
  ///
  /// 未知 id 与空 decidedBy 返回 null：不凭空造一张单，也不留一条没有决策人的审计。
  Future<ApprovalRecord?> approve(
    String approvalId, {
    required String decidedBy,
    int? atMs,
  }) async {
    final who = decidedBy.trim();
    if (who.isEmpty) return null;
    final record = _records[approvalId];
    if (record == null) return null;
    if (record.state != ApprovalState.pending) return record;
    final approved = record._replace(
      state: ApprovalState.approved,
      decidedAt: atMs ?? _nowMs(),
      decidedBy: who,
    );
    _records[approvalId] = approved;
    await _audit(approved, ok: true, decidedBy: who);
    return approved;
  }

  /// 人点了「拒绝」。结论以第一次为准：拒了之后又点批准不翻案。
  Future<ApprovalRecord?> deny(
    String approvalId, {
    required String decidedBy,
    int? atMs,
  }) async {
    final who = decidedBy.trim();
    if (who.isEmpty) return null;
    final record = _records[approvalId];
    if (record == null) return null;
    if (record.state != ApprovalState.pending) return record;
    final denied = record._replace(
      state: ApprovalState.denied,
      decidedAt: atMs ?? _nowMs(),
      decidedBy: who,
    );
    _records[approvalId] = denied;
    await _audit(denied, ok: false, decidedBy: who);
    return denied;
  }

  /// 把到期仍未决的单改写成 expired，返回被改写的那几张。
  ///
  /// 不删单：云端还要能读到 expired 才拒绝执行，删了它就无从得知曾经有过这一条。
  Future<List<ApprovalRecord>> expireDue({int? nowMs}) async {
    final now = nowMs ?? _nowMs();
    final due = _records.values
        .where((r) => r.state == ApprovalState.pending && now >= r.expiresAt)
        .toList(growable: false);
    final flipped = <ApprovalRecord>[];
    for (final record in due) {
      flipped.add(await _expireOne(record));
    }
    return flipped;
  }

  /// 这一跳能不能执行。
  ///
  /// 只对 [needsHumanApproval] 为真的工具调这里——名单外的工具没有要人批的副作用，
  /// 压根不进这道闸；它们的重放安全性由桥侧回执的三字段回答（K-24 的判据是
  /// 「派发了 且 ok 且 只读」），这里不猜。
  ///
  /// 超时不靠外部定时器先跑 expireDue：云端轮询读状态文件的间隙里，超时必须已经
  /// 被判掉。
  Future<ApprovalVerdict> decide({
    required String tool,
    String? approvalId,
    int? nowMs,
  }) async {
    final now = nowMs ?? _nowMs();
    final record = approvalId == null ? null : _records[approvalId];
    if (record == null) {
      return ApprovalVerdict(
        execute: false,
        code: AmooApprovalCodes.approvalRequired,
        error: '远端 $tool 未确认：没有审批单',
        fix: '在手机上查看审批通知并点「批准」；$kApprovalTimeoutMs 毫秒无人确认将默认拒绝',
        guideTopic: _kGuideExec,
        state: null,
        approvalId: null,
        label: '未确认：远端 $tool 需要设备旁的人批准，未执行',
      );
    }

    if (record.state == ApprovalState.pending && now >= record.expiresAt) {
      return _timeoutVerdict(await _expireOne(record));
    }

    switch (record.state) {
      case ApprovalState.approved:
        if (_consumed.contains(record.approvalId)) {
          return ApprovalVerdict(
            execute: false,
            code: AmooApprovalCodes.duplicateId,
            error: '审批单 ${record.approvalId} 已放行过一次',
            fix: '同一 idempotency_key 重放返回首次结果，不二次执行；确需重做请换一个新 key',
            guideTopic: _kGuideMailbox,
            state: record.state,
            approvalId: record.approvalId,
            label: '已放过一次：$tool 不再执行第二次',
          );
        }
        _consumed.add(record.approvalId);
        return ApprovalVerdict(
          execute: true,
          code: null,
          error: '',
          fix: '',
          guideTopic: _kGuideExec,
          state: record.state,
          approvalId: record.approvalId,
          label: '已批准：$tool 可以执行（批准人 ${record.decidedBy}）',
        );

      case ApprovalState.denied:
        return ApprovalVerdict(
          execute: false,
          code: AmooApprovalCodes.approvalRequired,
          error: '审批单 ${record.approvalId} 已被 ${record.decidedBy} 拒绝',
          fix: '需要执行就换一个 idempotency_key 重新发起，并在设备上取得批准',
          guideTopic: _kGuideExec,
          state: record.state,
          approvalId: record.approvalId,
          label: '已拒绝：$tool 被设备旁的人拒绝，未执行',
        );

      case ApprovalState.expired:
        return _timeoutVerdict(record);

      case ApprovalState.pending:
        // 进度要可读：还剩多少秒是「等」这个状态唯一有信息的数字。
        final seconds = (record.remainingMs(now) + 999) ~/ 1000;
        return ApprovalVerdict(
          execute: false,
          code: AmooApprovalCodes.approvalRequired,
          error: '审批单 ${record.approvalId} 还在等设备旁的人确认',
          fix: '在手机上查看审批通知并点「批准」或「拒绝」；$kApprovalTimeoutMs 毫秒无人确认将默认拒绝',
          guideTopic: _kGuideExec,
          state: record.state,
          approvalId: record.approvalId,
          label: '未确认：等设备旁的人批准 $tool，还剩 $seconds 秒，未执行',
        );
    }
  }

  /// 已放行过的 id。放过即记账：同一 key 再放行第二次会二次执行副作用。
  Set<String> consumedIds() => Set<String>.unmodifiable(_consumed);

  Future<ApprovalRecord> _expireOne(ApprovalRecord record) async {
    final expired = record._replace(state: ApprovalState.expired);
    _records[record.approvalId] = expired;
    await _audit(expired, ok: false, decidedBy: null);
    return expired;
  }

  ApprovalVerdict _timeoutVerdict(ApprovalRecord record) => ApprovalVerdict(
        execute: false,
        code: AmooApprovalCodes.approvalTimeout,
        error: '审批单 ${record.approvalId} 超过 $kApprovalTimeoutMs 毫秒无人确认，已过期',
        fix: '换一个 idempotency_key 重新发起；这一条默认拒绝，未执行',
        guideTopic: _kGuideExec,
        state: ApprovalState.expired,
        approvalId: record.approvalId,
        label: '已过期：${record.tool} 的审批无人确认，未执行',
      );

  /// 审批的每次状态改写都进审计。没有这一步，「谁没批」「谁批的」就查不到——
  /// 判据 3 的「审计留痕」四个字落在这一行上。
  Future<void> _audit(
    ApprovalRecord record, {
    required bool ok,
    required String? decidedBy,
  }) async {
    await AuditLog.instance.record(
      AuditSource.ai,
      'approval_${record.state.name}',
      '',
      detail: '${record.tool} ${record.approvalId}'
          '${decidedBy == null ? '' : ' by $decidedBy'}',
      ok: ok,
    );
  }
}
