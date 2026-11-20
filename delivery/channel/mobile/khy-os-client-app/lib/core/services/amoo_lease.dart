/// B8 跨轮租约与长任务分片（TASK.md §4 B8；实现面契约 device/B8.md §1.2，语义由
/// test/amoo_b8_test.dart 逐条钉住）。
///
/// 为什么单独成模块：分片上限、租约时长、累计预算、派发轮次全是「进程死后还要认」的
/// 数值与状态机。force-stop 之后内存态全丢，只有落盘那份能续跑，所以这里只产出可
/// 序列化状态——持久化交给适配器，时钟由调用方以 nowMs 传入（续跑判定要用落盘时刻，
/// 不是读取时刻）。
///
/// 数值不在这里新造真源：分片上限与 8MB/2000/50/30 逐字复用桥侧 Tools.java 与
/// AmooLoop.java（契约 K-52），租约 120 分钟沿用仓库既有租约默认值（decisions Q9）。
/// 本文件不碰平台 IO、不建表，主机上可直接单测。
library;

/// 分片上限 300s。300s 量级的任务拆成 3 个约 100s 的分片，每片各自有回执——中途
/// 任一刻都说得清跑到第几片（判据 1「分片可见」）。
const int kShardMs = 300 * 1000;

/// 跨轮租约 120 分钟（decisions Q9：沿用仓库既有租约默认值，不新造第二个真源）。
const int kLeaseTtlMs = 120 * 60 * 1000;

/// 单会话累计预算，逐字复用桥侧 Tools.java 的 SESSION_*_BUDGET（契约 K-52）。
const int kBudgetBytes = 8 * 1024 * 1024;
const int kBudgetEntries = 2000;
const int kBudgetFiles = 50;

/// 派发轮次上限，复用桥侧 AmooLoop.maxRounds。
const int kMaxRounds = 30;

/// 错误码。前四个逐字取 contract K-23 表；invalid_arguments / seq_conflict 是同表
/// 内的信封级码，B8 的租约状态机直接复用，不另立码表。
const String kCodeSessionBudgetExceeded = 'session_budget_exceeded';
const String kCodeDuplicateId = 'duplicate_id';
const String kCodeSingleFlight = 'single_flight';
const String kCodeLeaseExpired = 'lease_expired';
const String kCodeInvalidArguments = 'invalid_arguments';
const String kCodeSeqConflict = 'seq_conflict';

/// 把总时长切成每片不超过 [kShardMs] 的分片表。
///
/// totalMs <= 0 返回空表：调用方算错时长时，一个空表比一个转不停的循环诚实。
List<int> planShards(int totalMs) {
  if (totalMs <= 0) return const <int>[];
  final shards = <int>[];
  var left = totalMs;
  while (left > kShardMs) {
    shards.add(kShardMs);
    left -= kShardMs;
  }
  shards.add(left);
  return shards;
}

/// 一个分片的预估需求（上界）。Tools.java:1535-1540 的 preflightBytes 契约原文：
/// 「必须是上界……低估的代价是预算被绕开」。
class ShardDemand {
  const ShardDemand({this.bytes = 0, this.entries = 0, this.files = 0});

  final int bytes;
  final int entries;
  final int files;

  static const String _kBytes = 'bytes';
  static const String _kEntries = 'entries';
  static const String _kFiles = 'files';

  Map<String, dynamic> toJson() => <String, dynamic>{
    _kBytes: bytes,
    _kEntries: entries,
    _kFiles: files,
  };

  /// 形状不对就抛，不猜不补：预算读数是判据的一部分，补一个默认值等于谎报已用量。
  static ShardDemand fromJson(Map<String, dynamic> json) {
    if (json.length != 3 ||
        !json.containsKey(_kBytes) ||
        !json.containsKey(_kEntries) ||
        !json.containsKey(_kFiles)) {
      throw const FormatException(
        'amoo_lease used 键集越界：只认 bytes/entries/files',
      );
    }
    int readInt(String key) {
      final value = json[key];
      if (value is! int) {
        throw FormatException('amoo_lease used.$key 不是整数：${value.runtimeType}');
      }
      return value;
    }

    return ShardDemand(
      bytes: readInt(_kBytes),
      entries: readInt(_kEntries),
      files: readInt(_kFiles),
    );
  }
}

/// 一条产物。digest 由执行体算好塞入——租约只负责把它带过磁盘，不重算内容哈希。
class ShardArtifact {
  const ShardArtifact({
    required this.shard,
    required this.id,
    required this.digest,
  });

  final int shard;
  final String id;
  final String digest;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'shard': shard,
    'id': id,
    'digest': digest,
  };

  static ShardArtifact fromJson(Map<String, dynamic> json) {
    if (json.length != 3 ||
        !json.containsKey('shard') ||
        !json.containsKey('id') ||
        !json.containsKey('digest')) {
      throw const FormatException(
        'amoo_lease artifacts 条目键集越界：只认 shard/id/digest',
      );
    }
    final shard = json['shard'];
    final id = json['id'];
    final digest = json['digest'];
    if (shard is! int || id is! String || digest is! String) {
      throw const FormatException('amoo_lease artifacts 条目形状不对');
    }
    return ShardArtifact(shard: shard, id: id, digest: digest);
  }
}

/// 一个分片执行完的实际结果。[used] 是这一片真实花掉的量——记账以它为准，
/// 「读到了就是读到了，不管成不成功」（Tools.java:1500 同语义）。
class ShardOutcome {
  const ShardOutcome({
    this.artifacts = const <ShardArtifact>[],
    this.used = const ShardDemand(),
  });

  final List<ShardArtifact> artifacts;
  final ShardDemand used;
}

/// 拒绝回执。错误三件套按仓库规则 2.2（问题 + 原因 + 修复建议）；used/limit 只在
/// 预算拒时有值，其余情形留空——把没有的数字写成 0 是谎报已用量。
class LeaseRefusal {
  const LeaseRefusal({
    required this.code,
    required this.error,
    required this.fix,
    required this.guideTopic,
    this.used,
    this.limit,
  });

  final String code;
  final String error;
  final String fix;
  final String guideTopic;
  final int? used;
  final int? limit;
}

/// 一笔跨轮租约：不可变，每次状态迁移都返回新对象。
///
/// 两步派发的形状（device/B8.md §1.2 语义 2）：checkAdmit 只判不跑 → claim 记下
/// 「已下发」→ 执行 → commit 记账。claim 与 commit 之间就是进程死亡的窗口，与桥
/// 「cmd_ 先改名 processing_ 才执行」同形（BridgeService.java:512）。
class AmooLease {
  AmooLease._({
    required this.sessionId,
    required this.traceId,
    required this.msgId,
    required this.idempotencyKey,
    required this.totalMs,
    required this.grantedAt,
    required this.expiresAt,
    required this.completed,
    required this.dispatched,
    required this.artifacts,
    required this.used,
    required this.rounds,
  });

  /// 落盘键集闭集（12 个）。多一个键 fromJson 就拒——续跑凭证就是这三个既有身份
  /// 字段加结果，不另造第四个幂等标记（TASK.md §10）。
  static const Set<String> _kKeys = <String>{
    'session_id',
    'trace_id',
    'msg_id',
    'idempotency_key',
    'total_ms',
    'granted_at',
    'expires_at',
    'completed',
    'dispatched',
    'artifacts',
    'used',
    'rounds',
  };

  /// 起一笔租约。nowMs 由调用方传入，模块不自己读时钟。
  static AmooLease start({
    required String sessionId,
    required String traceId,
    required String msgId,
    required String idempotencyKey,
    required int totalMs,
    required int nowMs,
  }) {
    return AmooLease._(
      sessionId: sessionId,
      traceId: traceId,
      msgId: msgId,
      idempotencyKey: idempotencyKey,
      totalMs: totalMs,
      grantedAt: nowMs,
      expiresAt: nowMs + kLeaseTtlMs,
      completed: const <int>[],
      dispatched: const <int>[],
      artifacts: const <ShardArtifact>[],
      used: const ShardDemand(),
      rounds: 0,
    );
  }

  final String sessionId;
  final String traceId;
  final String msgId;
  final String idempotencyKey;
  final int totalMs;
  final int grantedAt;
  final int expiresAt;

  /// 已完工的分片序号，按完工顺序。
  final List<int> completed;

  /// 已下发未确认的分片序号，按 claim 顺序。
  final List<int> dispatched;

  final List<ShardArtifact> artifacts;

  /// 累计已用量。跟着租约走，不跟着进程走——重启不归零。
  final ShardDemand used;

  /// 已派发轮次。claim 一次就是一轮（派发了就是一轮）。
  final int rounds;

  int get shardCount => planShards(totalMs).length;

  List<int> get shardPlan => planShards(totalMs);

  List<int> get completedShards => completed;

  /// 下一个可开跑的分片；-1 = 没有（有未确认分片，或全跑完了）。
  ///
  /// 照着这个返回值往下跑的循环，遇到未确认分片会自然停住——自动重放因此没有入口。
  int get nextShard => dispatched.isEmpty ? _firstPending() : -1;

  /// 已下发未确认的那一片；多片同时在飞时报最后 claim 的那片（最可能是刚死的）。
  int? get unconfirmedShard => dispatched.isEmpty ? null : dispatched.last;

  bool get finished => dispatched.isEmpty && _firstPending() < 0;

  int get artifactCount => artifacts.length;

  ShardArtifact? artifactFor(int index) {
    for (final artifact in artifacts) {
      if (artifact.shard == index) return artifact;
    }
    return null;
  }

  /// 产物序列摘要。同序列必得同摘要（重启后比对用），不同序列必得不同摘要——
  /// 否则「哈希与一次跑完一致」这条判据证明不了任何事。
  String get artifactsDigest => _fnv1a32(
    artifacts.map((a) => '${a.shard}/${a.id}/${a.digest}').join(';'),
  );

  /// 到期时刻算已过期：expiresAt 这一刻就是过期，不是下一秒。
  bool isExpired(int nowMs) => nowMs >= expiresAt;

  /// 只判不跑。返回 null = 放行；否则按错误三件套报出为什么拒。
  ///
  /// 判定次序（device/B8.md §1.2 语义 4）有两处按单测钉死的细节，与文字顺序不同：
  /// duplicate_id 只认「要的正是那片未确认的」——轮次上限那条要连 claim 三十次都
  /// 不 commit，dispatched 里同时躺着三十片，此时问第 31 片必须判到轮次上限；
  /// 已全部完成必须排在跳号之前，否则 nextShard=-1 会把「跑完了」误判成 seq_conflict。
  LeaseRefusal? checkAdmit({
    required int index,
    required ShardDemand demand,
    required int nowMs,
  }) {
    if (isExpired(nowMs)) {
      return LeaseRefusal(
        code: kCodeLeaseExpired,
        error: '跨轮租约已过期：$grantedAt 授予，$expiresAt 到期，当前 $nowMs',
        fix: '重新发起这笔长任务，或用 renew 续租后继续分片',
        guideTopic: 'lease',
      );
    }
    if (dispatched.contains(index)) {
      return LeaseRefusal(
        code: kCodeDuplicateId,
        error: '分片 $index 已下发未确认，副作用未知',
        fix: '先核对该分片的产物，再 confirmReplay 显式确认重放，不要自动重发',
        guideTopic: 'idempotency',
      );
    }
    if (index < 0) {
      return LeaseRefusal(
        code: kCodeInvalidArguments,
        error: '分片序号 $index 为负：序号从 0 开始',
        fix: '用 nextShard 的返回值作为 index',
        guideTopic: 'schema',
      );
    }
    final pending = _firstPending();
    if (pending < 0) {
      return LeaseRefusal(
        code: kCodeInvalidArguments,
        error: '全部分片已完成（共 $shardCount 片），没有可准入的分片',
        fix: '要重跑请另起一笔租约：同一 session_id，换 msg_id 与 idempotency_key',
        guideTopic: 'lease',
      );
    }
    if (index != pending) {
      return LeaseRefusal(
        code: kCodeSeqConflict,
        error: '分片序号 $index 不是下一个待跑分片 $pending（跳号或回退）',
        fix: '按 nextShard 返回的序号派发，跳号与回退同一码',
        guideTopic: 'envelope',
      );
    }
    if (rounds >= kMaxRounds) {
      return LeaseRefusal(
        code: kCodeSessionBudgetExceeded,
        error: '派发轮次已达上限：已 $rounds 轮，上限 $kMaxRounds 轮',
        fix: '拆成多笔租约分批复跑，每笔各带自己的 msg_id 与 idempotency_key',
        guideTopic: 'budget',
        used: rounds,
        limit: kMaxRounds,
      );
    }
    final budget = _budgetRefusal(demand);
    if (budget != null) return budget;
    return null;
  }

  /// 记下「已下发」。派发轮次 +1。调用前必须先过 checkAdmit——这里不再复核，
  /// 是因为「先判后跑」的两步形状就是这个模块要证明的东西。
  AmooLease claim(int index) {
    return AmooLease._(
      sessionId: sessionId,
      traceId: traceId,
      msgId: msgId,
      idempotencyKey: idempotencyKey,
      totalMs: totalMs,
      grantedAt: grantedAt,
      expiresAt: expiresAt,
      completed: completed,
      dispatched: List<int>.unmodifiable(<int>[...dispatched, index]),
      artifacts: artifacts,
      used: used,
      rounds: rounds + 1,
    );
  }

  /// 记账。只认自己 claim 过的那一片，否则抛 StateError——把别人 claim 的片子
  /// 记账过来，累计用量就成了两本账。
  AmooLease commit({required int index, required ShardOutcome outcome}) {
    if (!dispatched.contains(index)) {
      throw StateError('分片 $index 没有 claim 过：commit 只认自己 claim 过的那一片');
    }
    return AmooLease._(
      sessionId: sessionId,
      traceId: traceId,
      msgId: msgId,
      idempotencyKey: idempotencyKey,
      totalMs: totalMs,
      grantedAt: grantedAt,
      expiresAt: expiresAt,
      completed: List<int>.unmodifiable(<int>[...completed, index]),
      dispatched: List<int>.unmodifiable(<int>[...dispatched]..remove(index)),
      artifacts: List<ShardArtifact>.unmodifiable(<ShardArtifact>[
        ...artifacts,
        ...outcome.artifacts,
      ]),
      used: ShardDemand(
        bytes: used.bytes + outcome.used.bytes,
        entries: used.entries + outcome.used.entries,
        files: used.files + outcome.used.files,
      ),
      rounds: rounds,
    );
  }

  /// 调用方核对过副作用之后的显式决定：这一片可以重跑。不核对就没有这个入口，
  /// 未确认分片因此不会被自动重放（K-61「只报不重放」）。
  AmooLease confirmReplay(int index) {
    if (!dispatched.contains(index)) {
      throw StateError('分片 $index 没有待确认的下发：confirmReplay 只清自己 claim 过的那一片');
    }
    return AmooLease._(
      sessionId: sessionId,
      traceId: traceId,
      msgId: msgId,
      idempotencyKey: idempotencyKey,
      totalMs: totalMs,
      grantedAt: grantedAt,
      expiresAt: expiresAt,
      completed: completed,
      dispatched: List<int>.unmodifiable(<int>[...dispatched]..remove(index)),
      artifacts: artifacts,
      used: used,
      rounds: rounds,
    );
  }

  /// 续租从当下起算，不累积旧时长；已跑过的分片与用量不因续租丢失。
  AmooLease renew(int nowMs) {
    return AmooLease._(
      sessionId: sessionId,
      traceId: traceId,
      msgId: msgId,
      idempotencyKey: idempotencyKey,
      totalMs: totalMs,
      grantedAt: nowMs,
      expiresAt: nowMs + kLeaseTtlMs,
      completed: completed,
      dispatched: dispatched,
      artifacts: artifacts,
      used: used,
      rounds: rounds,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
    'session_id': sessionId,
    'trace_id': traceId,
    'msg_id': msgId,
    'idempotency_key': idempotencyKey,
    'total_ms': totalMs,
    'granted_at': grantedAt,
    'expires_at': expiresAt,
    'completed': completed,
    'dispatched': dispatched,
    'artifacts': artifacts.map((a) => a.toJson()).toList(),
    'used': used.toJson(),
    'rounds': rounds,
  };

  /// 读回落盘状态。键集多一个、少一个、形状不对，一律 FormatException——
  /// 续跑凭证要被用来决定「要不要再跑一遍有副作用的分片」，猜一个默认值
  /// 比拒绝续跑危险得多。
  factory AmooLease.fromJson(Map<String, dynamic> json) {
    final keys = json.keys.toSet();
    if (keys.length != _kKeys.length || !keys.containsAll(_kKeys)) {
      throw const FormatException('amoo_lease 落盘键集不在闭集内（多一个键即拒，缺键也不猜）');
    }

    int readInt(String key) {
      final value = json[key];
      if (value is! int) {
        throw FormatException('amoo_lease $key 不是整数：${value.runtimeType}');
      }
      return value;
    }

    String readId(String key) {
      final value = json[key];
      if (value is! String || value.isEmpty) {
        throw FormatException('amoo_lease $key 不是非空字符串');
      }
      return value;
    }

    List<int> readInts(String key) {
      final value = json[key];
      if (value is! List) {
        throw FormatException('amoo_lease $key 不是数组：${value.runtimeType}');
      }
      final out = <int>[];
      for (final item in value) {
        if (item is! int) {
          throw FormatException('amoo_lease $key 含非整数条目：$item');
        }
        out.add(item);
      }
      return List<int>.unmodifiable(out);
    }

    final rawArtifacts = json['artifacts'];
    if (rawArtifacts is! List) {
      throw const FormatException('amoo_lease artifacts 不是数组');
    }
    final parsedArtifacts = <ShardArtifact>[];
    for (final raw in rawArtifacts) {
      if (raw is! Map) {
        throw const FormatException('amoo_lease artifacts 含非对象条目');
      }
      parsedArtifacts.add(
        ShardArtifact.fromJson(Map<String, dynamic>.from(raw)),
      );
    }

    final rawUsed = json['used'];
    if (rawUsed is! Map) {
      throw const FormatException('amoo_lease used 不是对象');
    }

    return AmooLease._(
      sessionId: readId('session_id'),
      traceId: readId('trace_id'),
      msgId: readId('msg_id'),
      idempotencyKey: readId('idempotency_key'),
      totalMs: readInt('total_ms'),
      grantedAt: readInt('granted_at'),
      expiresAt: readInt('expires_at'),
      completed: readInts('completed'),
      dispatched: readInts('dispatched'),
      artifacts: List<ShardArtifact>.unmodifiable(parsedArtifacts),
      used: ShardDemand.fromJson(Map<String, dynamic>.from(rawUsed)),
      rounds: readInt('rounds'),
    );
  }

  /// 第一个既没完工也没在飞的分片；-1 = 没有。
  int _firstPending() {
    for (var i = 0; i < shardCount; i++) {
      if (!completed.contains(i) && !dispatched.contains(i)) return i;
    }
    return -1;
  }

  LeaseRefusal? _budgetRefusal(ShardDemand demand) {
    if (demand.bytes > 0 && used.bytes + demand.bytes > kBudgetBytes) {
      return LeaseRefusal(
        code: kCodeSessionBudgetExceeded,
        error:
            '会话累计字节将超限：已用 ${used.bytes}，本片还要 ${demand.bytes}，'
            '上限 $kBudgetBytes',
        fix: '缩小本片规模或另起会话；超限在执行之前就拒，不会先跑再报',
        guideTopic: 'budget',
        used: used.bytes,
        limit: kBudgetBytes,
      );
    }
    if (demand.entries > 0 && used.entries + demand.entries > kBudgetEntries) {
      return LeaseRefusal(
        code: kCodeSessionBudgetExceeded,
        error:
            '会话累计条目将超限：已用 ${used.entries}，本片还要 ${demand.entries}，'
            '上限 $kBudgetEntries',
        fix: '缩小本片规模或另起会话；超限在执行之前就拒，不会先跑再报',
        guideTopic: 'budget',
        used: used.entries,
        limit: kBudgetEntries,
      );
    }
    if (demand.files > 0 && used.files + demand.files > kBudgetFiles) {
      return LeaseRefusal(
        code: kCodeSessionBudgetExceeded,
        error:
            '会话累计文件将超限：已用 ${used.files}，本片还要 ${demand.files}，'
            '上限 $kBudgetFiles',
        fix: '缩小本片规模或另起会话；超限在执行之前就拒，不会先跑再报',
        guideTopic: 'budget',
        used: used.files,
        limit: kBudgetFiles,
      );
    }
    // 需求为 0 的维度不触发拒绝：只读工作不该被导出额度挡死。
    return null;
  }
}

/// FNV-1a 32 位。为什么不引 package:crypto：它只是本包的传递依赖、没在 pubspec
/// 声明；为「同序列同摘要、不同序列不同摘要」这个判据新增一个声明依赖不值得。
String _fnv1a32(String text) {
  var hash = 0x811c9dc5;
  for (final unit in text.codeUnits) {
    hash = ((hash ^ unit) * 0x01000193) & 0xFFFFFFFF;
  }
  return hash.toRadixString(16).padLeft(8, '0');
}

/// 进程内的租约簿：每个 session 只留最新一笔。
///
/// 历史归 amoo_turn 与轨迹，不在这里造第二份账；簿子本身可序列化，重启后按
/// session 或幂等键找回同一笔（contract K-30 跨轮同一 session_id）。
class LeaseBook {
  const LeaseBook() : _leases = const <String, AmooLease>{};

  const LeaseBook._(this._leases);

  final Map<String, AmooLease> _leases;

  /// 起一笔（或挡住一笔）。成功时返回的 book 已含新租约；失败时 lease 为 null、
  /// book 原样返回。
  ///
  /// 死掉的权威不该冒充活着的占用：旧租约未完成且已过期时报 lease_expired，
  /// 不是 single_flight。
  ({LeaseBook book, LeaseRefusal? refusal, AmooLease? lease}) acquire({
    required String sessionId,
    required String traceId,
    required String msgId,
    required String idempotencyKey,
    required int totalMs,
    required int nowMs,
  }) {
    final existing = _leases[sessionId];
    if (existing != null && !existing.finished) {
      if (existing.isExpired(nowMs)) {
        return (
          book: this,
          refusal: LeaseRefusal(
            code: kCodeLeaseExpired,
            error:
                '会话 $sessionId 的上一笔长任务租约已过期：'
                '${existing.expiresAt} 到期，当前 $nowMs',
            fix: '重新发起这笔长任务，换新的 msg_id 与 idempotency_key',
            guideTopic: 'lease',
          ),
          lease: null,
        );
      }
      return (
        book: this,
        refusal: LeaseRefusal(
          code: kCodeSingleFlight,
          error:
              '会话 $sessionId 已有一笔长任务在跑'
              '（已完成 ${existing.completed.length}/${existing.shardCount} 片）',
          fix: '等上一笔收尾，或先 amoo_stop 中断后再起；第二笔不许吞成「已发送」',
          guideTopic: 'single-flight',
        ),
        lease: null,
      );
    }
    final lease = AmooLease.start(
      sessionId: sessionId,
      traceId: traceId,
      msgId: msgId,
      idempotencyKey: idempotencyKey,
      totalMs: totalMs,
      nowMs: nowMs,
    );
    return (book: withLease(lease), refusal: null, lease: lease);
  }

  LeaseBook withLease(AmooLease lease) {
    final next = Map<String, AmooLease>.from(_leases);
    next[lease.sessionId] = lease;
    return LeaseBook._(next);
  }

  /// 找回同一笔未完成的租约；已完成或没有过都返回 null。
  ///
  /// 过期与否不在这里判——那是放行时的事（checkAdmit 会给 lease_expired），
  /// 查找时过滤掉过期租约只会让调用方少一次据实拒绝。
  AmooLease? resume(String sessionId) {
    final lease = _leases[sessionId];
    if (lease == null || lease.finished) return null;
    return lease;
  }

  /// 重放的键指向同一笔，不是新起一笔。
  AmooLease? byIdempotencyKey(String key) {
    for (final lease in _leases.values) {
      if (lease.idempotencyKey == key) return lease;
    }
    return null;
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
    'leases': _leases.values.map((lease) => lease.toJson()).toList(),
  };

  factory LeaseBook.fromJson(Map<String, dynamic> json) {
    if (json.length != 1 || !json.containsKey('leases')) {
      throw const FormatException('amoo_lease 簿子键集越界：只认 leases');
    }
    final raw = json['leases'];
    if (raw is! List) {
      throw const FormatException('amoo_lease 簿子 leases 不是数组');
    }
    final leases = <String, AmooLease>{};
    for (final entry in raw) {
      if (entry is! Map) {
        throw const FormatException('amoo_lease 簿子 leases 含非对象条目');
      }
      final lease = AmooLease.fromJson(Map<String, dynamic>.from(entry));
      leases[lease.sessionId] = lease;
    }
    return LeaseBook._(leases);
  }
}
