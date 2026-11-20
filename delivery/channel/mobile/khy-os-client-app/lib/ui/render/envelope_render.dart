import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/trajectory/call_chain.dart';

/// 服务端结构化响应的渲染判定（A 阶段：信封解析 + 三档渲染）。
///
/// 信封形状判定复用 [CallEnvelope.parse]——12 个合约字段只有一份真源
/// （android/.../bridge/CallChain.java 的 FIELDS 闭集），这里不引入第二个字段名。
/// 与护栏路径的差异只有一处：护栏对未知 proto_v 拒收（K-20），渲染路径按
/// 「最低兼容版本渲染 + 版本不匹配提示」处理——拒收是调用闸门的语义，渲染是
/// 展示语义，拒收掉用户已收到的回复等于丢内容。
///
/// 三档顺序固定、命中即停（A 阶段任务书）：
///   L1 结构化 —— payload.blocks 是数组，按类型渲染；
///   L2 半结构化 —— payload.content 里的 ```json 围栏取 content；
///   L3 纯文本 —— content 原样（markdown），标 structured=false。
///
/// 不代答、不改写、不重放：块按数组原序、未知块原文保留、同一 msg_id 只渲染
/// 一次（[EnvelopeReplyBuffer.claimRender]）、请求未返回只显示状态。

/// 渲染档位。命中即停：判到哪档就按哪档渲染，不叠加。
enum EnvelopeTier { l1Blocks, l2Fenced, l3Plain }

/// 结构化回复里的一块。九类已知 + 一类未知降级，字段名沿用本仓既有词汇表：
/// text/reasoning/tool_call 与 ui/render/content_tier.dart 逐字一致；
/// tool_result 与 DriverToolResult（callId/ok/summary）一致；
/// status 与 DriverStatus（code/detail/attempt）一致。
sealed class ReplyBlock {
  const ReplyBlock();
}

class ReplyTextBlock extends ReplyBlock {
  const ReplyTextBlock(this.text);
  final String text;
}

class ReplyReasoningBlock extends ReplyBlock {
  const ReplyReasoningBlock(this.text);
  final String text;
}

class ReplyToolCallBlock extends ReplyBlock {
  const ReplyToolCallBlock(this.callId, this.name, this.args);
  final String callId;
  final String name;
  final Map<String, Object?> args;
}

class ReplyToolResultBlock extends ReplyBlock {
  const ReplyToolResultBlock(this.callId, this.ok, this.summary);
  final String callId;
  final bool ok;
  final String summary;
}

class ReplyCodeBlock extends ReplyBlock {
  const ReplyCodeBlock(this.code, this.language);
  final String code;

  /// 可缺席：纯代码不带语言标注是合法输入。
  final String? language;
}

class ReplyImageBlock extends ReplyBlock {
  const ReplyImageBlock(this.path);
  final String path;
}

class ReplyFileBlock extends ReplyBlock {
  const ReplyFileBlock(this.path, this.size);
  final String path;

  /// 可缺席：拿不到大小就不标，不编一个数。
  final int? size;
}

class ReplyTableBlock extends ReplyBlock {
  const ReplyTableBlock(this.headers, this.rows);
  final List<Object?> headers;
  final List<List<Object?>> rows;
}

class ReplyStatusBlock extends ReplyBlock {
  const ReplyStatusBlock(this.code, this.detail, this.attempt);
  final String code;
  final String detail;
  final int attempt;
}

/// 未知块降级：原文 JSON 全量保留（不丢内容），渲染成折叠的纯文本。
class ReplyUnknownBlock extends ReplyBlock {
  const ReplyUnknownBlock(this.raw);
  final String raw;
}

/// 解析 blocks 数组。未知类型 / 形状不符的已知类型都降级为 [ReplyUnknownBlock]，
/// 原文保留——加一种块类型不该让整份内容消失。
List<ReplyBlock> parseReplyBlocks(List<Object?> raw) {
  final out = <ReplyBlock>[];
  for (final item in raw) {
    out.add(_parseReplyBlock(item));
  }
  return out;
}

ReplyBlock _parseReplyBlock(Object? item) {
  if (item is! Map) return ReplyUnknownBlock(_rawOf(item));
  final text = item['text'];
  final type = item['type'];
  if (type == 'text') {
    if (text is String) return ReplyTextBlock(text);
    return ReplyUnknownBlock(_rawOf(item));
  }
  if (type == 'reasoning') {
    if (text is String) return ReplyReasoningBlock(text);
    return ReplyUnknownBlock(_rawOf(item));
  }
  if (type == 'tool_call') {
    final callId = item['callId'];
    final name = item['name'];
    final args = item['args'];
    if (callId is String && name is String && args is Map) {
      return ReplyToolCallBlock(
          callId, name, Map<String, Object?>.from(args));
    }
    return ReplyUnknownBlock(_rawOf(item));
  }
  if (type == 'tool_result') {
    final callId = item['callId'];
    final ok = item['ok'];
    final summary = item['summary'];
    if (callId is String && ok is bool && summary is String) {
      return ReplyToolResultBlock(callId, ok, summary);
    }
    return ReplyUnknownBlock(_rawOf(item));
  }
  if (type == 'code') {
    final code = item['code'];
    final language = item['language'];
    if (code is String) {
      return ReplyCodeBlock(code, language is String ? language : null);
    }
    return ReplyUnknownBlock(_rawOf(item));
  }
  if (type == 'image') {
    final path = item['path'];
    if (path is String) return ReplyImageBlock(path);
    return ReplyUnknownBlock(_rawOf(item));
  }
  if (type == 'file') {
    final path = item['path'];
    final size = item['size'];
    if (path is String) {
      return ReplyFileBlock(path, size is int ? size : null);
    }
    return ReplyUnknownBlock(_rawOf(item));
  }
  if (type == 'table') {
    final headers = item['headers'];
    final rows = item['rows'];
    if (headers is List &&
        rows is List &&
        rows.every((r) => r is List)) {
      return ReplyTableBlock(
        List<Object?>.from(headers),
        [for (final r in rows) List<Object?>.from(r as List)],
      );
    }
    return ReplyUnknownBlock(_rawOf(item));
  }
  if (type == 'status') {
    final code = item['code'];
    final detail = item['detail'];
    final attempt = item['attempt'];
    if (code is String) {
      return ReplyStatusBlock(
        code,
        detail is String ? detail : '',
        attempt is int ? attempt : 0,
      );
    }
    return ReplyUnknownBlock(_rawOf(item));
  }
  return ReplyUnknownBlock(_rawOf(item));
}

/// 未知块原文。jsonEncode(null) 合法（"null"），字符串键的 Map 拷贝是
/// jsonEncode 的形状要求。
String _rawOf(Object? item) =>
    jsonEncode(item is Map ? Map<String, dynamic>.from(item) : item);

/// 一次档位判定的结果。
class RenderPlan {
  const RenderPlan(this.tier,
      {required this.structured, this.blocks = const [], this.text = ''});

  final EnvelopeTier tier;

  /// L1/L2 true，L3 false（A 阶段任务书：L3 标 structured=false）。
  final bool structured;

  /// L1 的块序列，数组原序。
  final List<ReplyBlock> blocks;

  /// L2/L3 的正文。L2 已是围栏里取出的 content。
  final String text;
}

/// 一份服务端结构化响应（信封）的解析结果。null = 不是信封形状，调用方走旧
/// 渲染路径（markdown 文本），这是 L3 之外的第四条出口，不属于三档。
class StructuredReply {
  const StructuredReply(this.env, {required this.protoVSupported});

  final CallEnvelope env;
  final bool protoVSupported;

  String get msgId => env.msgId;
  String get protoV => env.protoV;

  /// 解析已解码的 JSON 对象。形状不符（含多字段、缺字段、kind 越界）返回
  /// null——拒收回执是护栏的事，渲染侧只回答「这像不像一封信」。
  static StructuredReply? tryParse(Object? decoded) {
    if (decoded is! Map) return null;
    final CallEnvelope env;
    try {
      env = CallEnvelope.parse(Map<String, dynamic>.from(decoded),
          tolerateUnknownProtoV: true);
    } on CallRejected {
      return null;
    }
    return StructuredReply(
      env,
      protoVSupported: kSupportedProtoV.contains(env.protoV),
    );
  }

  /// 解析 JSON 文本。非对象 JSON 或半截文本返回 null。
  static StructuredReply? tryParseText(String text) {
    final trimmed = text.trim();
    if (!trimmed.startsWith('{')) return null;
    final Object? decoded;
    try {
      decoded = jsonDecode(trimmed);
    } on FormatException {
      return null;
    }
    return tryParse(decoded);
  }

  /// 三档判定。顺序固定、命中即停。
  RenderPlan plan() {
    final payload = env.payload;

    // L1：blocks 在场即命中——哪怕里面全是未知块，也按 L1 渲染（未知块逐块
    // 降级，不把整份拖回 L3）。
    final rawBlocks = payload['blocks'];
    if (rawBlocks is List) {
      return RenderPlan(
        EnvelopeTier.l1Blocks,
        structured: true,
        blocks: parseReplyBlocks(List<Object?>.from(rawBlocks)),
      );
    }

    final content = payload['content'];
    if (content is String) {
      // L2：content 带 ```json 围栏且围栏对象带 content 字段 → 取该 content。
      final fenced = _firstFencedJsonContent(content);
      if (fenced != null) {
        return RenderPlan(EnvelopeTier.l2Fenced, structured: true, text: fenced);
      }
      // L3：无围栏（或围栏不是半结构化形状）→ 原文渲染，不改写。
      return RenderPlan(EnvelopeTier.l3Plain, structured: false, text: content);
    }

    // payload 既无 blocks 也无 content：原样序列化展示，不编内容。
    return RenderPlan(
      EnvelopeTier.l3Plain,
      structured: false,
      text: jsonEncode(Map<String, dynamic>.from(payload)),
    );
  }

  /// 按顺序找第一个形状合规的 ```json 围栏，取其 content 字段。围栏对象没有
  /// content 字段不算 L2 命中（继续找下一个 / 落 L3）。
  static String? _firstFencedJsonContent(String text) {
    var searchFrom = 0;
    while (true) {
      final open = text.indexOf('```json', searchFrom);
      if (open < 0) return null;
      final bodyStart = open + '```json'.length;
      final close = text.indexOf('```', bodyStart);
      if (close < 0) return null;
      final inner = text.substring(bodyStart, close).trim();
      searchFrom = close + 3;
      final Object? decoded;
      try {
        decoded = jsonDecode(inner);
      } on FormatException {
        continue;
      }
      if (decoded is Map && decoded['content'] is String) {
        return decoded['content'] as String;
      }
    }
  }
}

/// 一次结构化回复的现场状态：收块 → 定案 / 中断。
enum TurnState { receiving, done, failed }

/// 一轮结构化回复的渲染现场。块按到达顺序累积；done 信封定案时用信封里的
/// 全量数组替换流式前缀（同一数组的更完整版本，防重复渲染）。
class EnvelopeTurn {
  EnvelopeTurn({
    required this.localId,
    required this.msgId,
    this.protoV = '',
    this.protoVSupported = true,
  });

  /// 聊天屏里承载这一轮的气泡 id（结构化视图按它挂载）。
  final String localId;
  final String msgId;

  /// 定案后才可信；流式收块阶段为空串（版本角标等定案再画）。
  String protoV;
  bool protoVSupported;

  TurnState state = TurnState.receiving;

  /// 已收块。failed 后保留（T5）；done 后是信封全量数组（T2 的渲染顺序真源）。
  final List<ReplyBlock> blocks = [];

  /// L2/L3 的正文；L1 为 null。
  String? text;
  EnvelopeTier? tier;
  bool structured = false;

  /// 当前状态行（RUNTIME-002：动作+目标+进度）。失败行不含「成功」。
  String statusLine = '等待结构化回复 · 第 1 次投递';

  /// 视图重画信号。块追加/定案/失败都 bump 一次。
  final ValueNotifier<int> revision = ValueNotifier<int>(0);

  void appendBlocks(List<ReplyBlock> incoming) {
    // 已定案/已中断的轮不再收块：done 的数组是真源，迟到的流式块是重复投递。
    if (state != TurnState.receiving) return;
    if (incoming.isEmpty) return;
    blocks.addAll(incoming);
    statusLine = '接收结构化回复 · 已收 ${blocks.length} 块';
    _touch();
  }

  void applyPlan(RenderPlan plan) {
    tier = plan.tier;
    structured = plan.structured;
    if (plan.tier == EnvelopeTier.l1Blocks) {
      blocks
        ..clear()
        ..addAll(plan.blocks);
      text = null;
      statusLine = '结构化回复已渲染 · ${blocks.length} 块';
    } else {
      text = plan.text;
      statusLine = plan.structured
          ? '半结构化回复已渲染 · 取围栏正文'
          : '纯文本回复已渲染 · structured=false';
    }
    state = TurnState.done;
    _touch();
  }

  /// 流中断：保留已收块，状态行如实说失败（不给「成功」）。detail 是原样错误
  /// 信息，不改写。
  void fail(String detail) {
    state = TurnState.failed;
    statusLine =
        '结构化回复流中断（失败）：已收 ${blocks.length} 块 · $detail';
    _touch();
  }

  /// 块序列的纯文本投影，供会话保存与历史上送。不是渲染真源（渲染走
  /// EnvelopeReplyView），只是让 content 字段不空着。
  String plainProjection() {
    if (tier == EnvelopeTier.l1Blocks) {
      final out = StringBuffer();
      for (final b in blocks) {
        if (out.isNotEmpty) out.write('\n');
        if (b is ReplyTextBlock) {
          out.write(b.text);
        } else if (b is ReplyReasoningBlock) {
          out.write(b.text);
        } else if (b is ReplyCodeBlock) {
          out.write(b.code);
        } else if (b is ReplyToolCallBlock) {
          out.write('[tool_call] ${b.name}');
        } else if (b is ReplyToolResultBlock) {
          out.write('[tool_result] ${b.summary}');
        } else if (b is ReplyImageBlock || b is ReplyFileBlock) {
          out.write('[file] ${(b as dynamic).path as String}');
        } else if (b is ReplyTableBlock) {
          out.write(b.rows.map((r) => r.join(' | ')).join('\n'));
        } else if (b is ReplyStatusBlock) {
          out.write('[status] ${b.code} · ${b.detail}');
        } else if (b is ReplyUnknownBlock) {
          out.write(b.raw);
        }
      }
      return out.toString();
    }
    return text ?? '';
  }

  void _touch() => revision.value = revision.value + 1;
}

/// 跨轮缓冲：msg_id 去重（同一 msg_id 只渲染一次）+ 按 localId 找轮。
///
/// 一个实例守一个聊天屏。去重集合进程内有效——重启后内存归零，跨重启的重放
/// 检测是持久化层的面，不在这里（本模块不做持久化）。
class EnvelopeReplyBuffer {
  final List<EnvelopeTurn> _turns = <EnvelopeTurn>[];
  final Set<String> _renderedMsgIds = <String>{};
  final Map<String, EnvelopeTurn> _byLocalId = <String, EnvelopeTurn>{};

  /// 已登记的轮（按到达顺序）。测试与屏渲染枚举用。
  List<EnvelopeTurn> get turns => List.unmodifiable(_turns);

  /// 同一 msg_id 只渲染一次：首次 true 并登记，此后 false。
  bool claimRender(String msgId) => _renderedMsgIds.add(msgId);

  /// 流式块事件（SSE 事件带 msg_id + blocks 数组）。已有在收的轮就追加；
  /// 没有就开新轮。返回 null = 该 msg_id 已定案/已中断（重复投递，忽略）。
  EnvelopeTurn? absorbBlocks({
    required String msgId,
    required List<Object?> rawBlocks,
    String localId = '',
  }) {
    final existing = _turnByMsgId(msgId);
    if (existing != null) {
      existing.appendBlocks(parseReplyBlocks(rawBlocks));
      return existing.state == TurnState.receiving ? existing : null;
    }
    if (_renderedMsgIds.contains(msgId)) return null;
    final turn = EnvelopeTurn(localId: localId, msgId: msgId);
    _turns.add(turn);
    if (localId.isNotEmpty) _byLocalId[localId] = turn;
    turn.appendBlocks(parseReplyBlocks(rawBlocks));
    return turn;
  }

  /// done 信封定案。重复 msg_id 返回 null（调用方摘掉本次的占位气泡）。
  EnvelopeTurn? finalize({
    required String localId,
    required StructuredReply reply,
  }) {
    if (!claimRender(reply.msgId)) return null;
    var turn = _turnByMsgId(reply.msgId);
    if (turn == null) {
      turn = EnvelopeTurn(localId: localId, msgId: reply.msgId);
      _turns.add(turn);
    }
    turn.protoV = reply.protoV;
    turn.protoVSupported = reply.protoVSupported;
    turn.applyPlan(reply.plan());
    _byLocalId[localId] = turn;
    return turn;
  }

  /// 流中断。按本地气泡 id 找轮置 failed；找不到（非结构化轮）返回 false，
  /// 调用方走旧错误路径。
  bool failByLocalId(String localId, String detail) {
    final turn = _byLocalId[localId];
    if (turn == null) return false;
    turn.fail(detail);
    return true;
  }

  EnvelopeTurn? _turnByMsgId(String msgId) {
    for (final t in _turns) {
      if (t.msgId == msgId) return t;
    }
    return null;
  }

  void dispose() {
    for (final t in _turns) {
      t.revision.dispose();
    }
    _turns.clear();
    _byLocalId.clear();
  }

  /// 会话切换：turn 归属会话，跟着清。去重集合一并清——切换后同一 msg_id
  /// 再投递是新的渲染事件，不属于上一会话的重放。
  void reset() {
    dispose();
    _renderedMsgIds.clear();
  }
}
