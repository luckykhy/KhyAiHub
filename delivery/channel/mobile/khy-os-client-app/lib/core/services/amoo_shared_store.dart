/// B5 共享投影——设备侧单写者写进共享文档的那一份状态（contract §8，amoo-bridge-20261112）。
///
/// 权威方已由 TASK.md §C2 拍板为设备侧：无并发写、读到即最终态、不用版本向量。
/// 所以本项目里**不存在** merge 函数——两个同键输入只按「后者胜」塌成一条（K-70）。
/// 做字段级合并反而会把"用户改过的标题"和"更早的标题"拼成一个谁都没写过的值。
///
/// 删除也不物理消失，而是以墓碑留在文档里（K-73）：另一端靠它知道"这条没了"，
/// 删掉墓碑等于删除传不过去。
///
/// 白名单在写入前生效，不是先全量同步再过滤（K-72）：三个 project* 就是闸门，
/// 返回 null 的记录在文档里连占位都没有。
library;

import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:meta/meta.dart';

import 'package:khy_os_client/core/db/amoo_turn.dart';
import 'package:khy_os_client/core/services/conversation_db.dart';
import 'package:khy_os_client/core/services/conversation_sync.dart';

/// 共享文档里的记录来源。一个成员 = contract K-71 白名单里的一处存储；
/// 新增来源要在契约里补行，不在这里私自加。
enum SharedSource {
  /// 对话记录（Conversation，键是对话 id）。
  conversation,

  /// amoo 反代轮次（amoo_turn 表，键是原生 job id）。
  amooTurn,

  /// amoo_memory.json 的条目（形状见 bridge/AmooMemory.java）。
  memory,
}

/// 信箱产物的三类保留期（contract K-74）。数值真源在 BridgeService.java:56-59，
/// Dart 侧不新造第二份。
enum SharedArtifactKind {
  result,
  tmp,
  processing,
}

/// 共享文档里的一条记录。[key] 是跨端唯一键：删除传播靠同键相消，所以投影
/// 必须用记录自己的 id（对话 id / job id / memory id），另起一个 id 会让墓碑
/// 永远对不上活记录——删除在文档里表现为"多了一条"而不是"这条没了"。
@immutable
class SharedEntry {
  const SharedEntry({
    required this.source,
    required this.id,
    required this.fields,
    this.deleted = false,
  });

  final SharedSource source;
  final String id;

  /// 投影出来的字段。墓碑的 fields 是空的——墓碑只承载"这条没了"这一个事实。
  final Map<String, Object?> fields;

  /// true = 墓碑：留在文档里，但存活集合不含它。
  final bool deleted;

  String get key => '${source.name}:$id';

  Map<String, Object?> toJson() => <String, Object?>{
        'source': source.name,
        'id': id,
        'fields': fields,
        'deleted': deleted,
      };
}

abstract final class AmooSharedStore {
  /// 对话记录投影。开关判据复用 [ConversationSync.effectiveEnabled]（K-00b）——
  /// 真值表只有一份，抄第二份必然漂移。
  ///
  /// 只投影元数据，不投影消息正文：凭据、剪贴板原文、截屏原图全在正文里
  /// （K-72 默认不出本机五项），而"投影后文档里搜不到原文"正是白名单的判据。
  /// 时间戳同理不投影——它会让同一份输入在两次投影里字节不同，哈希就废了。
  static SharedEntry? projectConversation(
    Conversation c, {
    required bool globalSyncDefault,
  }) {
    if (!ConversationSync.effectiveEnabled(
      override: c.syncToDesktop,
      globalDefault: globalSyncDefault,
    )) {
      return null;
    }
    return SharedEntry(
      source: SharedSource.conversation,
      id: c.id,
      fields: <String, Object?>{
        'title': c.title,
        'messages': c.messages.length,
      },
    );
  }

  /// amoo 轮次投影。
  ///
  /// `synced` 是出站信箱标记（amoo_turn.dart:79-80），本项目是它在 schema 文件外
  /// 的唯一读者：投影把它带进共享文档，云端才分得出哪几笔设备侧已经入账。
  ///
  /// prompt/reply 与 memory 条目同级，都是白名单里的记录本体（K-71 第 2/3 项）；
  /// 对话消息正文不投影，见 [projectConversation]。
  static SharedEntry? projectAmooTurn(AmooTurn t) {
    final String? id;
    if (t.job.isNotEmpty) {
      id = t.job;
    } else if (t.id != null) {
      // 未被原生受理的行没有 job id，用库内行号兜底：两个空 job 会互相覆盖成
      // 一条，而那明明是两笔提问。
      id = 'row-${t.id}';
    } else {
      // 未受理且没有行号，连跨端键都拼不出来。没有键就删不掉、也对不回墓碑。
      return null;
    }
    return SharedEntry(
      source: SharedSource.amooTurn,
      id: id,
      fields: <String, Object?>{
        'prompt': t.prompt,
        'reply': t.reply,
        'state': t.state.wire,
        'askedAt': t.askedAt,
        'synced': t.synced,
      },
    );
  }

  /// memory 条目投影（id/text/confidence/provenance，见 bridge/AmooMemory.java）。
  static SharedEntry? projectMemory(Map<String, Object?> mem) {
    // 敏感条目不进共享面（K-75）。标记在文档里而不是另起一份：Java 侧 fromJson
    // 只 optString 已知四个键，多一个键不影响旧解析。
    if (mem['sensitive'] == true) return null;
    final id = mem['id'];
    // 没有 id 的条目没有跨端键，同 sensitive 的理由不投影。
    if (id is! String || id.isEmpty) return null;
    return SharedEntry(
      source: SharedSource.memory,
      id: id,
      fields: <String, Object?>{
        'text': mem['text'],
        'confidence': mem['confidence'],
        if (mem['provenance'] != null) 'provenance': mem['provenance'],
      },
    );
  }

  /// 墓碑。fields 为空——它只承载"这条没了"，不夹带任何字段值。
  static SharedEntry tombstone(SharedSource source, String id) => SharedEntry(
        source: source,
        id: id,
        fields: const <String, Object?>{},
        deleted: true,
      );

  /// 把一批投影塌成一份文档：同键后者胜，不合并（K-70 读到即最终态）。
  ///
  /// 同一个键出现两次只可能是本机先后写了两次（例如先活记录、后墓碑），
  /// 后来那次就是最终态。
  static List<SharedEntry> build(List<SharedEntry> entries) {
    // LinkedHashMap：覆盖时保留首次出现的位置，行序只由第一次写入决定，
    // 反复投影同一份状态不会让行序漂移。
    final byKey = <String, SharedEntry>{};
    for (final e in entries) {
      byKey[e.key] = e;
    }
    return byKey.values.toList(growable: false);
  }

  /// 规范 JSON：按键排序后的稳定文本。两端各自投影同一份设备态必须得到同一串
  /// 字节，而行序来自写入次序（不是规范量），所以在这里排。
  static String canonicalJson(List<SharedEntry> doc) {
    final ordered = [...doc]
      ..sort((SharedEntry a, SharedEntry b) => a.key.compareTo(b.key));
    return jsonEncode(ordered.map((SharedEntry e) => e.toJson()).toList());
  }

  /// 共享文档摘要：规范 JSON 的 sha256，64 位小写十六进制。
  /// 两端哈希差异 0 是 B5-3 的判据；差异非 0 时用 [diffFields] 定位到字段。
  static String digest(List<SharedEntry> doc) =>
      sha256.convert(utf8.encode(canonicalJson(doc))).toString();

  /// 两份文档的字段级差异，每条都指到记录与字段（B5-5：差异非 0 须按
  /// source/id/字段 三级键定位）。空列表 = 两份文档等价。
  static List<String> diffFields(List<SharedEntry> a, List<SharedEntry> b) {
    final left = <String, SharedEntry>{for (final e in build(a)) e.key: e};
    final right = <String, SharedEntry>{for (final e in build(b)) e.key: e};
    final keys = <String>{...left.keys, ...right.keys}.toList()..sort();
    final out = <String>[];
    for (final key in keys) {
      final x = left[key];
      final y = right[key];
      if (x == null || y == null) {
        out.add('$key: ${x == null ? 'only in B' : 'only in A'}');
        continue;
      }
      if (x.deleted != y.deleted) {
        out.add('$key.deleted: A=${x.deleted} B=${y.deleted}');
      }
      final fields = <String>{...x.fields.keys, ...y.fields.keys}.toList()..sort();
      for (final f in fields) {
        final xv = x.fields[f];
        final yv = y.fields[f];
        if (xv != yv) out.add('$key.$f: A=$xv B=$yv');
      }
    }
    return out;
  }

  /// 信箱产物保留期（contract K-74）。
  static Duration retention(SharedArtifactKind kind) {
    switch (kind) {
      case SharedArtifactKind.result:
        return const Duration(hours: 24);
      case SharedArtifactKind.tmp:
        return const Duration(hours: 1);
      case SharedArtifactKind.processing:
        return const Duration(hours: 72);
    }
  }

  /// 过期判定，与 BridgeService.java:313-319 同一边界：age **严格大于**保留期
  /// 才算过期，等于时还没过期。负年龄（时钟被改过）走不删的一侧。
  static bool artifactExpired(SharedArtifactKind kind, int ageMs) =>
      ageMs > retention(kind).inMilliseconds;
}
