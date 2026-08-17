'use strict';

/**
 * Session Recap Service — generate summaries for long conversations.
 *
 * Produces a structured recap when:
 *   - Conversation exceeds N turns (default: 10)
 *   - Context compression is triggered
 *   - User explicitly requests /recap
 *   - Token threshold is reached (auto-extract mode)
 *
 * Recap includes: key decisions, files changed, commands run, open questions.
 *
 * Auto-extract mode: when estimated token usage exceeds AUTO_EXTRACT_THRESHOLD,
 * automatically generates a recap and saves key facts to project memory.
 * This mirrors Claude Code's background memory extraction via forked subagent.
 *
 * @module sessionRecapService
 */

const log = require('../utils/logger');

// CJK 抽取补充(纯叶子·门 KHY_RECAP_CJK default-on)。门关或异常 → 各 helper 返回 []
// → 下方 union 空 → 抽取结果逐字节回退到原英文行为。防御式 require:缺失也不致命。
let _cjk = null;
try {
  _cjk = require('./sessionRecapCjk');
} catch {
  _cjk = null;
}
function _mergeUnique(base, extra) {
  if (!Array.isArray(extra) || extra.length === 0) {
    return base;
  }
  const seen = new Set(base);
  const out = base.slice();
  for (const item of extra) {
    if (item == null || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

// ── Auto-extraction config ──
const AUTO_EXTRACT_THRESHOLD = 0.65; // 65% of context budget
const AUTO_EXTRACT_MIN_TURNS = 8;
let _lastAutoExtractTurn = 0;

// ── Recap Generator ──

/**
 * 把一条消息的 content 摊平成纯文本字符串。
 *
 * content 有两种真实形态：简单消息是字符串；带工具调用的会话里则是内容块数组
 * （`[{type:'text',text}, {type:'tool_use',…}, {type:'tool_result',…}]`）。
 * 下游抽取器一律按字符串处理（`.split` / `.matchAll`），数组会让 `khy recap` 必崩
 * （`text.split is not a function`）。这里只保留人读散文——取 `text` 块——
 * tool_use/tool_result 是机器 I/O，跳过以免把工具输出里的路径/命令误当会话内容。
 */
function _flattenContent(content) {
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

/**
 * Generate a structured recap from conversation messages.
 *
 * @param {Array<{role: string, content: string}>} messages - Conversation history
 * @param {object} [context] - Additional context
 * @param {string[]} [context.filesChanged] - List of modified files
 * @param {string[]} [context.commandsRun] - List of shell commands executed
 * @returns {object} Recap object
 */
function generateRecap(messages, context) {
  if (!messages || messages.length === 0) {
    return { turns: 0, summary: '空对话。', sections: {} };
  }

  // 归一化 content → 字符串（见 _flattenContent），下方各抽取器一律按字符串处理。
  messages = messages.map((m) =>
    m && typeof m === 'object' ? { ...m, content: _flattenContent(m.content) } : m
  );

  const ctx = context || {};
  const userMessages = messages.filter((m) => m.role === 'user');
  const assistantMessages = messages.filter((m) => m.role === 'assistant');

  const recap = {
    turns: userMessages.length,
    timeRange: null,
    summary: '',
    sections: {
      topics: [],
      decisions: [],
      filesChanged: ctx.filesChanged || [],
      commandsRun: ctx.commandsRun || [],
      openQuestions: [],
      keyInsights: [],
    },
  };

  // Extract topics from user messages
  recap.sections.topics = _extractTopics(userMessages);

  // Extract decisions from assistant messages (English) + CJK union
  recap.sections.decisions = _extractDecisions(assistantMessages);
  if (_cjk) {
    recap.sections.decisions = _mergeUnique(
      recap.sections.decisions,
      _cjk.extractCjkDecisions(assistantMessages)
    ).slice(0, 10);
  }

  // Extract file changes mentioned in conversation (English + CJK-punctuation union)
  if (recap.sections.filesChanged.length === 0) {
    let files = _extractFileReferences(messages);
    if (_cjk) {
      files = _mergeUnique(files, _cjk.extractCjkFileReferences(messages));
    }
    recap.sections.filesChanged = files;
  }

  // Extract commands
  if (recap.sections.commandsRun.length === 0) {
    recap.sections.commandsRun = _extractCommands(messages);
  }

  // Extract open questions (English + CJK union)
  recap.sections.openQuestions = _extractOpenQuestions(messages);
  if (_cjk) {
    recap.sections.openQuestions = _mergeUnique(
      recap.sections.openQuestions,
      _cjk.extractCjkQuestions(messages)
    ).slice(0, 5);
  }

  // Extract key insights (English + CJK union)
  recap.sections.keyInsights = _extractInsights(assistantMessages);
  if (_cjk) {
    recap.sections.keyInsights = _mergeUnique(
      recap.sections.keyInsights,
      _cjk.extractCjkInsights(assistantMessages)
    ).slice(0, 5);
  }

  // Generate summary
  recap.summary = _buildSummary(recap);

  return recap;
}

/**
 * Format recap for CLI display.
 * @param {object} recap
 * @param {object} [options]
 * @param {Function} [options.chalk]
 * @returns {string}
 */
function formatRecap(recap, options) {
  const c = (options && options.chalk) || {
    bold: (t) => t,
    dim: (t) => t,
    cyan: (t) => t,
    green: (t) => t,
    yellow: (t) => t,
    white: (t) => t,
  };

  const lines = [];
  lines.push('');
  lines.push(c.bold(`  会话回顾（${recap.turns} 轮）`));
  lines.push(c.dim('  ' + '─'.repeat(50)));

  if (recap.summary) {
    lines.push('');
    lines.push(c.white(`  ${recap.summary}`));
  }

  const s = recap.sections;

  if (s.topics.length > 0) {
    lines.push('');
    lines.push(c.bold('  主题：'));
    s.topics.forEach((t) => lines.push(c.dim(`    • ${t}`)));
  }

  if (s.decisions.length > 0) {
    lines.push('');
    lines.push(c.bold('  关键决策：'));
    s.decisions.forEach((d) => lines.push(c.green(`    ✓ ${d}`)));
  }

  if (s.filesChanged.length > 0) {
    lines.push('');
    lines.push(c.bold('  改动文件：'));
    s.filesChanged.slice(0, 15).forEach((f) => lines.push(c.cyan(`    ${f}`)));
    if (s.filesChanged.length > 15) {
      lines.push(c.dim(`    … 另有 ${s.filesChanged.length - 15} 项`));
    }
  }

  if (s.commandsRun.length > 0) {
    lines.push('');
    lines.push(c.bold('  执行命令：'));
    s.commandsRun.slice(0, 10).forEach((cmd) => lines.push(c.dim(`    $ ${cmd}`)));
    if (s.commandsRun.length > 10) {
      lines.push(c.dim(`    … 另有 ${s.commandsRun.length - 10} 项`));
    }
  }

  if (s.openQuestions.length > 0) {
    lines.push('');
    lines.push(c.bold('  待解问题：'));
    s.openQuestions.forEach((q) => lines.push(c.yellow(`    ? ${q}`)));
  }

  if (s.keyInsights.length > 0) {
    lines.push('');
    lines.push(c.bold('  关键洞察：'));
    s.keyInsights.forEach((i) => lines.push(c.white(`    → ${i}`)));
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Format recap as protocol message for SDK.
 * @param {object} recap
 * @returns {object}
 */
function toProtocolMessage(recap) {
  return { type: 'session_recap', recap };
}

// ── Extractors ──

function _extractTopics(userMessages) {
  const topics = [];
  const seen = new Set();

  for (const msg of userMessages) {
    const text = msg.content || '';
    // First meaningful line
    const firstLine = text.split('\n')[0].trim();
    if (firstLine.length < 5 || firstLine.length > 100) {
      continue;
    }

    const normalized = firstLine
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, '')
      .trim();
    if (normalized.length < 3) {
      continue;
    }
    const key = normalized.substring(0, 30);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    topics.push(firstLine.length > 60 ? firstLine.substring(0, 57) + '...' : firstLine);
    if (topics.length >= 8) {
      break;
    }
  }

  return topics;
}

function _extractDecisions(assistantMessages) {
  const decisions = [];
  const patterns = [
    /(?:I'll|I will|Let me|Going to)\s+(.{10,80})/gi,
    /(?:decided to|choosing|using|selected)\s+(.{10,60})/gi,
    /(?:created|wrote|added|updated|fixed|removed)\s+(.{10,60})/gi,
  ];

  for (const msg of assistantMessages) {
    const text = msg.content || '';
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const matches = [...text.matchAll(pattern)];
      for (const m of matches) {
        const decision = m[0].trim();
        if (decision.length > 80) {
          continue;
        }
        decisions.push(decision.substring(0, 80));
        if (decisions.length >= 10) {
          return decisions;
        }
      }
    }
  }

  return decisions.slice(0, 10);
}

function _extractFileReferences(messages) {
  const files = new Set();
  const fileRegex =
    /(?:^|\s|[`"'])([a-zA-Z0-9_/.][a-zA-Z0-9_/.-]*\.[a-zA-Z]{1,6})(?:\s|[`"']|$|:)/gm;

  for (const msg of messages) {
    const text = msg.content || '';
    for (const m of text.matchAll(fileRegex)) {
      const f = m[1];
      // Filter out common false positives
      if (f.includes('http') || f.includes('www.') || f.startsWith('.')) {
        continue;
      }
      if (/\.(com|org|net|io|dev)$/i.test(f)) {
        continue;
      }
      files.add(f);
      if (files.size >= 30) {
        break;
      }
    }
    if (files.size >= 30) {
      break;
    }
  }

  return [...files];
}

function _extractCommands(messages) {
  const commands = [];
  const cmdRegex = /```(?:bash|sh|shell|console|terminal)?\s*\n([\s\S]*?)```/g;

  for (const msg of messages) {
    if (msg.role !== 'assistant') {
      continue;
    }
    const text = msg.content || '';
    for (const m of text.matchAll(cmdRegex)) {
      const block = m[1].trim();
      const lines = block
        .split('\n')
        .map((l) => l.replace(/^\$\s*/, '').trim())
        .filter((l) => l && !l.startsWith('#') && l.length < 120);
      for (const line of lines) {
        if (commands.length >= 20) {
          break;
        }
        commands.push(line);
      }
    }
  }

  return commands;
}

function _extractOpenQuestions(messages) {
  const questions = [];
  // Look at last few messages for unresolved questions
  const recent = messages.slice(-6);

  for (const msg of recent) {
    const text = msg.content || '';
    const qMatches = text.match(/([^.!]*\?)/g);
    if (qMatches) {
      for (const q of qMatches) {
        const clean = q.trim();
        if (clean.length >= 10 && clean.length <= 100) {
          // Skip rhetorical/common patterns
          if (/would you like|shall I|do you want|is that ok/i.test(clean)) {
            continue;
          }
          questions.push(clean);
          if (questions.length >= 5) {
            return questions;
          }
        }
      }
    }
  }

  return questions;
}

function _extractInsights(assistantMessages) {
  const insights = [];
  const patterns = [
    /(?:important|note|key point|worth noting|keep in mind)[:\s]+(.{10,80})/gi,
    /(?:the root cause|the issue|the problem)\s+(?:is|was)\s+(.{10,80})/gi,
    /(?:because|the reason)\s+(.{10,80})/gi,
  ];

  for (const msg of assistantMessages.slice(-5)) {
    const text = msg.content || '';
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const matches = [...text.matchAll(pattern)];
      for (const m of matches) {
        insights.push(m[0].trim().substring(0, 80));
        if (insights.length >= 5) {
          return insights;
        }
      }
    }
  }

  return insights;
}

function _buildSummary(recap) {
  const parts = [];
  const s = recap.sections;

  if (s.topics.length > 0) {
    parts.push(`讨论了 ${s.topics.length} 个主题`);
  }
  if (s.filesChanged.length > 0) {
    parts.push(`改动了 ${s.filesChanged.length} 个文件`);
  }
  if (s.decisions.length > 0) {
    parts.push(`做出了 ${s.decisions.length} 个决策`);
  }
  if (s.commandsRun.length > 0) {
    parts.push(`执行了 ${s.commandsRun.length} 条命令`);
  }

  if (parts.length === 0) {
    return `共 ${recap.turns} 轮对话。`;
  }
  return `共 ${recap.turns} 轮对话：${parts.join('，')}。`;
}

// ── Auto-extraction ──

/**
 * Check if auto-extraction should trigger based on token usage and turn count.
 *
 * @param {object} params
 * @param {number} params.estimatedTokens - Current estimated token usage
 * @param {number} params.maxTokens - Context window limit
 * @param {number} params.turnCount - Current conversation turn count
 * @returns {boolean}
 */
function shouldAutoExtract(params) {
  const { estimatedTokens, maxTokens, turnCount } = params;
  if (!estimatedTokens || !maxTokens) {
    return false;
  }
  if (turnCount < AUTO_EXTRACT_MIN_TURNS) {
    return false;
  }
  if (turnCount - _lastAutoExtractTurn < AUTO_EXTRACT_MIN_TURNS) {
    return false;
  }

  const ratio = estimatedTokens / maxTokens;
  return ratio >= AUTO_EXTRACT_THRESHOLD;
}

/**
 * Auto-extract key information from the conversation and save to project memory.
 * This runs asynchronously and should not block the main conversation flow.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [options]
 * @param {string} [options.cwd] - Project directory
 * @param {number} [options.turnCount] - Current turn count
 * @param {Function} [options.callModel] - AI call function for summarization
 * @returns {Promise<{ saved: boolean, recap: object|null }>}
 */
async function autoExtractMemory(messages, options = {}) {
  const turnCount = options.turnCount || messages.filter((m) => m.role === 'user').length;
  _lastAutoExtractTurn = turnCount;

  // Generate recap
  const recap = generateRecap(messages);
  if (!recap || recap.turns < AUTO_EXTRACT_MIN_TURNS) {
    return { saved: false, recap: null };
  }

  // Save recap to project memory
  try {
    const projectMemory = require('./projectMemoryService');
    const cwd = options.cwd || process.cwd();

    projectMemory.saveSessionTrace(cwd, {
      turns: recap.turns,
      summary: recap.summary,
      topics: recap.sections.topics,
      decisions: recap.sections.decisions,
      filesChanged: recap.sections.filesChanged,
      commandsRun: recap.sections.commandsRun.slice(0, 10),
      openQuestions: recap.sections.openQuestions,
      keyInsights: recap.sections.keyInsights,
      autoExtracted: true,
    });

    return { saved: true, recap };
  } catch (err) {
    log.debug('Auto-extract memory save failed:', err.message);
    return { saved: false, recap };
  }
}

/**
 * Reset auto-extract state (e.g., for new session).
 */
function resetAutoExtract() {
  _lastAutoExtractTurn = 0;
}

module.exports = {
  generateRecap,
  formatRecap,
  toProtocolMessage,
  shouldAutoExtract,
  autoExtractMemory,
  resetAutoExtract,
  AUTO_EXTRACT_THRESHOLD,
  AUTO_EXTRACT_MIN_TURNS,
};
