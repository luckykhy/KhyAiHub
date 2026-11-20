// khy-canary: Khy-20261113-003-P3TIER
import 'dart:convert';

import 'package:khy_os_client/core/drivers/driver_event.dart';

/// 渲染三档（§5.4）。
///
/// 判定只看**内容形状**，不认识 driver：这是「新接入一个 driver 不需要改
/// 渲染代码」的机制保证（T2 判据的正面形式）。
enum ContentTier { l1, l2, l3 }

/// L1 的块类型。与 DriverToolCall / DriverDelta 的内存结构对齐——driver 的
/// 工具调用与思维链落到盘上再读回来，形状不变。
sealed class ContentBlock {}

class TextBlock extends ContentBlock {
  final String text;
  TextBlock(this.text);
}

class ReasoningBlock extends ContentBlock {
  final String text;
  ReasoningBlock(this.text);
}

class ToolCallBlock extends ContentBlock {
  final String callId;
  final String name;
  final Map<String, Object?> args;
  ToolCallBlock(this.callId, this.name, this.args);
}

/// 一次档位判定的结果。
class TierDecision {
  final ContentTier tier;

  /// L1 时的装配块；L2/L3 为 null（各自按文本渲染）。
  final List<ContentBlock>? blocks;

  /// 判定失败的原因（只留调试日志，不弹任何需要人工选择的对话框）。
  final String? debugReason;

  const TierDecision(this.tier, {this.blocks, this.debugReason});
}

/// 三档降级判定（§5.4）。
///
/// L1：内容能解析为约定的块序列 JSON。
/// L2：L1 失败但含 markdown 结构（标题/列表/代码栅栏）。
/// L3：都失败——纯文本。
///
/// 全程无人工介入：判定失败只记 [TierDecision.debugReason]，由渲染器落到
/// 调试日志；弹选择对话框等于把降级成本转嫁给用户，那是这条机制的反面。
TierDecision decideTier(String content) {
  if (content.trim().isEmpty) {
    return const TierDecision(ContentTier.l3, debugReason: 'empty');
  }

  final l1 = _tryParseBlocks(content);
  if (l1 != null) return TierDecision(ContentTier.l1, blocks: l1);

  if (_hasMarkdownStructure(content)) {
    return const TierDecision(ContentTier.l2);
  }
  return const TierDecision(ContentTier.l3);
}

/// 解析块序列。返回 null = 不是（或不是完整的）块序列 JSON——调用方据此
/// 降级，而不是看到异常。
List<ContentBlock>? _tryParseBlocks(String content) {
  final trimmed = content.trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    final decoded = jsonDecode(trimmed);
    if (decoded is! List) return null;
    final blocks = <ContentBlock>[];
    for (final item in decoded) {
      if (item is! Map) return null; // 数组里有非对象：不是块序列
      final type = item['type'];
      if (type == 'text') {
        blocks.add(TextBlock((item['text'] ?? '').toString()));
      } else if (type == 'reasoning') {
        blocks.add(ReasoningBlock((item['text'] ?? '').toString()));
      } else if (type == 'tool_call') {
        blocks.add(ToolCallBlock(
          (item['callId'] ?? '').toString(),
          (item['name'] ?? '').toString(),
          item['args'] is Map ? Map<String, Object?>.from(item['args'] as Map) : const {},
        ));
      } else {
        // 未知块：**不跳过**。跳过等于静默删内容——用户看到的只是"少了一段"，
        // 而界面上没有任何东西解释为什么少。降级成文本并把类型标出来，至少让
        // 「这里有个我不认识的块」是可见的、可上报的。
        //
        // 与「加一种块类型不该让整份内容退回 L3」并不冲突：这条仍然留在 L1，
        // 只是把不认识的块当文本画。
        final raw = jsonEncode(item);
        blocks.add(TextBlock('[未知块 ${type ?? "?"}] $raw'));
      }
    }
    // 空数组也是合法 L1（空会话占位），但要有可渲染的东西才算：
    // 全未知类型的数组等价于没有块。
    return blocks.isEmpty ? null : blocks;
  } catch (_) {
    return null;
  }
}

bool _hasMarkdownStructure(String content) {
  final lines = content.split('\n');
  for (final line in lines) {
    final t = line.trimLeft();
    if (t.startsWith('#') || t.startsWith('- ') || t.startsWith('* ') ||
        t.startsWith('> ') || t.startsWith('```') || t.startsWith('|')) {
      return true;
    }
  }
  // 行内代码与粗体也算结构：一段带 `code` 的话按纯文本画会丢掉语义。
  return content.contains('`') || content.contains('**');
}

/// 组装好的状态行。UI 直接画，不再自己拼字符串。
class StatusLine {
  final String text;

  /// 是否有重试入口（T7：超时/可重试失败必须给）。
  final bool retryable;
  const StatusLine(this.text, {this.retryable = false});
}

/// DriverStatus → 状态行。RUNTIME-002：动作+目标+进度。
///
/// 进度信号用 attempt（第 N 次轮询/重试）与 detail 里的等待秒数——两者都
/// 是真实推进量，不是装饰。
StatusLine driverStatusLine(DriverStatus s) {
  final detail = s.detail.trim();
  // attempt 是 driver 侧传来的 1-based 计数（amoo driver 的轮询次数、
  // 连接重试次数）。这里直接用它，不再 +1——加过的后果是「第 4 次」
  // 对应实际第 3 次，进度信号对用户说谎。
  switch (s.code) {
    case 'waiting':
      return StatusLine('等待回复${detail.isEmpty ? '' : ' · $detail'} · 第 ${s.attempt}次轮询');
    case 'connecting':
      return StatusLine('连接中${detail.isEmpty ? '' : ' · $detail'}');
    case 'degraded':
      return StatusLine('连续 ${s.attempt} 次失败 · 可在设置中禁用或重试', retryable: true);
    case 'timed_out':
      return StatusLine('等待超时（第 ${s.attempt} 次）${detail.isEmpty ? '' : ' · $detail'}', retryable: true);
    case 'failed':
      return StatusLine('失败${detail.isEmpty ? '' : '：$detail'}');
    default:
      return StatusLine(detail.isEmpty ? '状态更新（第 ${s.attempt} 次）' : detail);
  }
}

/// DriverFailed → 状态行。retryable 一路带到 UI：没有重试入口的失败
/// 不给按钮，有的话必须给。
StatusLine driverFailedLine(DriverFailed f) {
  final msg = f.error.toString();
  return StatusLine(
    f.retryable ? '本轮失败，可重试：$msg' : '本轮失败：$msg',
    retryable: f.retryable,
  );
}
