'use strict';

/**
 * storyCollect.js — 故事层（fabula）：把会话消息链摊平成严格时序的 StoryEvent[]。
 *
 * DESIGN-ARCH-130：热奈特区分「故事」（实际发生了什么）与「话语」（怎么讲）。
 * 本模块只负责前者——不增删、不评论、不排序，逐条忠实登记，并给每条事件
 * 一个全局 seq（叙事文里的 [#n] 证据锚点即此 seq）。话语层的时序重排、
 * 时距压缩、频率合并全在 discourse.js；这里输出的顺序永远是真实时间序。
 *
 * 数据源是 sessionPersistence.buildConversationChain 的返回：
 *   { uuid, role, content, timestamp, isMeta, isCompactSummary,
 *     _timeline?, _toolCalls?, _turnStats? }
 * 其中 _toolCalls[i] = { seq, name, paramsSummary?, durationMs?, status, error? }，
 * _timeline[i] = { type:'text'|'thinking', text, durationMs? } | { type:'tools', … }。
 *
 * 纯函数叶子：无 IO、无时钟、无模型。同一份 messages ⇒ 同一份 story。
 */

const KIND = Object.freeze({
  USER_REQUEST: 'user.request',
  CONTEXT_COMPACT: 'context.compact',
  ASSISTANT_TEXT: 'assistant.text',
  ASSISTANT_THINKING: 'assistant.thinking',
  TOOL_CALL: 'tool.call',
  TURN_END: 'turn.end',
});

function _firstLine(text, max = 120) {
  const line = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    return '';
  }
  // relay 产出的 transcript 里偶发裸 `</think>` 残签——是标记不是叙述，丢弃
  if (/^<\/?[a-zA-Z][^>]*>$/.test(line)) {
    return '';
  }
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

// content 有字符串与内容块数组两种形态；tool_use/tool_result 是机器 I/O，
// 只保留 text 块（与 sessionRecapService._flattenContent 同一判断）。
function _flattenText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// 老式 transcript 没有 _toolCalls 增量字段（那是 TUI 回合产物），工具证据在
// content 的 tool_use 块里：{ type:'tool_use', id, name, input }。结果块不落盘，
// 所以 outcome 只能空着——叙事端绝不把「无记录」讲成「成功」。
function _toolUseBlocks(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((b) => b && b.type === 'tool_use' && b.name);
}

function _targetFromInput(input) {
  if (!input || typeof input !== 'object') {
    return '';
  }
  for (const k of ['file_path', 'path', 'command', 'query', 'pattern', 'url']) {
    if (typeof input[k] === 'string' && input[k]) {
      const v = input[k].replace(/\s+/g, ' ').trim();
      return v.length > 80 ? v.slice(0, 79) + '…' : v;
    }
  }
  return '';
}

/**
 * @param {Array<object>} messages buildConversationChain 的返回
 * @returns {{events: Array<object>, stats: object}}
 *   event = { seq, at, kind, actor, name?, target?, outcome?, durationMs?, tokens?, text?, evidence }
 *   evidence = { uuid, callSeq? } —— 回指 transcript 行的最小凭据
 */
function collectStory(messages) {
  const events = [];
  const list = Array.isArray(messages) ? messages : [];

  for (const msg of list) {
    if (!msg || typeof msg !== 'object') {
      continue;
    }
    const at = Number(msg.timestamp) || 0;
    const uuid = msg.uuid || null;

    if (msg.role === 'user') {
      if (msg.isCompactSummary) {
        events.push({
          at,
          kind: KIND.CONTEXT_COMPACT,
          actor: 'system',
          text: '上下文压缩（长对话折叠为摘要）',
          evidence: { uuid },
        });
        continue;
      }
      if (msg.isMeta) {
        continue;
      }
      const text = _firstLine(_flattenText(msg.content), 80);
      if (!text) {
        continue;
      }
      events.push({ at, kind: KIND.USER_REQUEST, actor: '用户', text, evidence: { uuid } });
      continue;
    }

    if (msg.role !== 'assistant') {
      continue;
    }

    const timeline = Array.isArray(msg._timeline) ? msg._timeline : null;
    if (timeline) {
      for (const seg of timeline) {
        if (!seg || !seg.type) {
          continue;
        }
        if (seg.type === 'thinking') {
          const text = _firstLine(seg.text, 120);
          if (text) {
            events.push({
              at,
              kind: KIND.ASSISTANT_THINKING,
              actor: 'KHY',
              text,
              durationMs: Number(seg.durationMs) > 0 ? Number(seg.durationMs) : undefined,
              evidence: { uuid },
            });
          }
        } else if (seg.type === 'text') {
          const text = _firstLine(seg.text, 120);
          if (text) {
            events.push({
              at,
              kind: KIND.ASSISTANT_TEXT,
              actor: 'KHY',
              text,
              evidence: { uuid },
            });
          }
        }
        // 'tools' 段是 _toolCalls 的展示态副本，权威记录以下方 _toolCalls 为准
      }
    } else {
      const text = _firstLine(_flattenText(msg.content), 120);
      if (text) {
        events.push({
          at,
          kind: KIND.ASSISTANT_TEXT,
          actor: 'KHY',
          text,
          evidence: { uuid },
        });
      }
    }

    if (Array.isArray(msg._toolCalls)) {
      for (const call of msg._toolCalls) {
        if (!call) {
          continue;
        }
        events.push({
          at,
          kind: KIND.TOOL_CALL,
          actor: 'KHY',
          name: String(call.name || 'tool'),
          target: typeof call.paramsSummary === 'string' ? call.paramsSummary : '',
          outcome: call.status === 'error' ? 'error' : 'done',
          durationMs: Number(call.durationMs) > 0 ? Number(call.durationMs) : undefined,
          text: call.status === 'error' && call.error ? String(call.error) : undefined,
          evidence: { uuid, callSeq: call.seq },
        });
      }
    } else {
      // 无 _toolCalls 的旧 transcript：从 content 的 tool_use 块补登记（outcome 留空）
      for (const b of _toolUseBlocks(msg.content)) {
        events.push({
          at,
          kind: KIND.TOOL_CALL,
          actor: 'KHY',
          name: String(b.name || 'tool'),
          target: _targetFromInput(b.input),
          outcome: undefined,
          evidence: { uuid },
        });
      }
    }

    if (msg._turnStats && typeof msg._turnStats === 'object') {
      events.push({
        at,
        kind: KIND.TURN_END,
        actor: 'KHY',
        durationMs: Number(msg._turnStats.elapsedMs) > 0 ? Number(msg._turnStats.elapsedMs) : undefined,
        tokens: Number(msg._turnStats.tokens) > 0 ? Number(msg._turnStats.tokens) : undefined,
        toolCount: Number.isInteger(msg._turnStats.toolCount) ? msg._turnStats.toolCount : undefined,
        evidence: { uuid },
      });
    }
  }

  events.forEach((e, i) => {
    e.seq = i + 1;
  });

  const stats = {
    total: events.length,
    toolCalls: events.filter((e) => e.kind === KIND.TOOL_CALL).length,
    toolErrors: events.filter((e) => e.kind === KIND.TOOL_CALL && e.outcome === 'error').length,
    userRequests: events.filter((e) => e.kind === KIND.USER_REQUEST).length,
    thinkings: events.filter((e) => e.kind === KIND.ASSISTANT_THINKING).length,
  };

  return { events, stats };
}

module.exports = { collectStory, KIND };
