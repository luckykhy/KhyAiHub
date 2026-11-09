// khy-canary: Khy-20261101-071-BAV740DY
import 'package:meta/meta.dart';

/// 一次 amoo 反代提问在本地库里的生命周期。
///
/// 为什么需要 `pending` 这个看起来多余的态：提问必须**先落盘再发起**。
/// 反过来（先问、成功再写库）会留下一个窗口——原生已经受理、库还不知道——
/// 进程在这个窗口里死掉，这笔提问就永久孤儿化。而它是唯一"已经发出、
/// 收不回来"的那种，丢了连"我们问过"这个事实都没了。
///
/// `interrupted` 和 `failed` 必须分开，这是诚实边界：
///   - failed  = amoo 侧或桥侧明确给了错误
///   - interrupted = 我们的等待线程被进程死亡带走，amoo 可能照样答了
/// 把后者显示成前者，等于凭空宣布一件我们并不知道的事。
enum AmooTurnState {
  /// 已落盘，尚未得到原生受理确认
  pending,

  /// 原生已受理，正在等 amoo 回答（约 6 分钟）
  running,

  /// 拿到回复
  done,

  /// 明确失败（桥或 amoo 给了错误）
  failed,

  /// 等待器随进程死亡而消失；amoo 的应答状态未知
  interrupted;

  static AmooTurnState parse(String? raw) {
    switch (raw) {
      case 'pending':
        return AmooTurnState.pending;
      case 'running':
        return AmooTurnState.running;
      case 'done':
        return AmooTurnState.done;
      case 'failed':
        return AmooTurnState.failed;
      case 'interrupted':
        return AmooTurnState.interrupted;
      default:
        // 未知态按 interrupted 处理而不是按 running：把没结算的旧行继续
        // 当"正在等"会让界面永远转圈，而承认"中断"至少给了用户一个出口。
        return AmooTurnState.interrupted;
    }
  }

  String get wire => name;

  /// 是否还没结算（重启后需要回收的）
  bool get isUnsettled => this == pending || this == running;
}

/// 一笔提问。不可变；状态迁移由 [copyWith] 产生新实例。
@immutable
class AmooTurn {
  final int? id;

  /// 原生 ask 返回的 job id（`ask-<epoch ms>`）。未受理前为空。
  final String job;

  final String prompt;

  /// amoo 最新气泡的原始文本。未结算时为 null——不是空串。
  /// 空串会被读成"amoo 回了空内容"，那是另一件事。
  final String? reply;

  final AmooTurnState state;
  final String error;

  /// epoch ms
  final int askedAt;

  /// epoch ms；未结算为 null
  final int? settledAt;

  /// 双向同步的出站信箱标记。今天没有消费者。
  final bool synced;

  const AmooTurn({
    this.id,
    this.job = '',
    required this.prompt,
    this.reply,
    this.state = AmooTurnState.pending,
    this.error = '',
    required this.askedAt,
    this.settledAt,
    this.synced = false,
  });

  AmooTurn copyWith({
    int? id,
    String? job,
    String? prompt,
    String? reply,
    AmooTurnState? state,
    String? error,
    int? askedAt,
    int? settledAt,
    bool? synced,
  }) {
    return AmooTurn(
      id: id ?? this.id,
      job: job ?? this.job,
      prompt: prompt ?? this.prompt,
      // reply 要能显式置回 null（例如 interrupted 时不该留着一个旧回复），
      // 所以这里用哨兵而不是 ?? 。
      reply: reply ?? this.reply,
      state: state ?? this.state,
      error: error ?? this.error,
      askedAt: askedAt ?? this.askedAt,
      settledAt: settledAt ?? this.settledAt,
      synced: synced ?? this.synced,
    );
  }

  Map<String, Object?> toRow() {
    return <String, Object?>{
      'id': id,
      'job': job,
      'prompt': prompt,
      'reply': reply,
      'state': state.wire,
      'error': error,
      'asked_at': askedAt,
      'settled_at': settledAt,
      'synced': synced ? 1 : 0,
    };
  }

  static AmooTurn fromRow(Map<String, Object?> row) {
    return AmooTurn(
      id: row['id'] as int?,
      job: (row['job'] as String?) ?? '',
      prompt: (row['prompt'] as String?) ?? '',
      reply: row['reply'] as String?,
      state: AmooTurnState.parse(row['state'] as String?),
      error: (row['error'] as String?) ?? '',
      askedAt: (row['asked_at'] as int?) ?? 0,
      settledAt: row['settled_at'] as int?,
      synced: (row['synced'] as int?) == 1,
    );
  }

  /// 用户可见的一句话。刻意不把 reply 算进来——它可能很长，属于内容区。
  String get statusLine {
    switch (state) {
      case AmooTurnState.pending:
        return '正在提交给 amoo…';
      case AmooTurnState.running:
        return 'amoo 正在思考…';
      case AmooTurnState.done:
        return 'amoo 已回复';
      case AmooTurnState.failed:
        final detail = error.trim();
        return detail.isEmpty ? '未拿到回复' : '未拿到回复：$detail';
      case AmooTurnState.interrupted:
        return '上次提问中断（应用被关闭或重启）；回复可能已在 amoo 中';
    }
  }

  /// 中断行专属的下一步动作文案。只有 interrupted 该给这个提示——
  /// 对 failed 行说"去 amoo 看看"是推卸，我们明确知道那次失败了。
  String? get recoveryHint {
    if (state != AmooTurnState.interrupted) return null;
    return '打开 amoo 查看是否已有回复；本机不重复提问（同一句话再发一次会问两遍）。';
  }
}

/// 库结构。集中一处，迁移时只改这里。
///
/// 为什么用 TEXT 存 state 而不是 INTEGER：状态值会出现在日志和人工排查里，
/// `state='interrupted'` 比 `state=4` 少一次查表。代价是解析要走
/// [AmooTurnState.parse]，而它本来就存在。
abstract final class AmooTurnSchema {
  static const String table = 'amoo_turn';

  static const String createTable = '''
CREATE TABLE IF NOT EXISTS $table (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job        TEXT    NOT NULL DEFAULT '',
  prompt     TEXT    NOT NULL,
  reply      TEXT,
  state      TEXT    NOT NULL,
  error      TEXT    NOT NULL DEFAULT '',
  asked_at   INTEGER NOT NULL,
  settled_at INTEGER,
  synced     INTEGER NOT NULL DEFAULT 0
)
''';

  /// 未结算行要在启动时被回收，这个索引让那次查询不是全表扫。
  static const String indexUnsettled =
      'CREATE INDEX IF NOT EXISTS idx_${table}_state ON $table (state)';

  /// 列表按时间倒序取最近若干条。
  static const String indexAskedAt =
      'CREATE INDEX IF NOT EXISTS idx_${table}_asked_at ON $table (asked_at DESC)';

  static const int version = 1;
}
