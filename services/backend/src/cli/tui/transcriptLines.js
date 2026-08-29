'use strict';

/**
 * transcriptLines — 把 messages 投影成「纯文本行数组」的单一真源(纯叶子:零 IO、
 * 确定性、绝不抛)。TranscriptView 按行切片做 bounded viewport 滚动。
 *
 * 另出 `buildTranscriptLineRecords`:同一份投影,额外给出**与行同长同序的角色数组**,
 * 供 Viewport 逐行着色(「用户自己那几行」要在屏幕上与 AI 答复分开 —— 见
 * `userMessageStyle.js`)。行本身仍是裸字符串,角色绝不混进文本里。
 *
 * 为什么按行而不按消息:CC Transcript context 的 `scroll:lineUp` /
 * `scroll:halfPageUp`(ctrl+u)在「一条消息 = 一格」的粒度下没有意义 —— 半页翻的是
 * 「视口行数的一半」,所以投影必须落到行粒度才对得上 CC 的 less 惯例。
 *
 * showAll 对齐 CC 的 `transcript:toggleShowAll`(ctrl+e):
 *   false → 思考压成一行摘要、工具压成一行状态
 *   true  → 思考展开全文、工具展开结果输出
 *
 * 渲染器一律**注入**而非 require,这样叶子无依赖、可单测,同时调用方能传入与
 * committed 区完全相同的渲染器保证排版一致:
 *   renderMarkdown(text, cols) → 已按 cols 排好版的字符串(缺省恒等)
 *   summarizeTool(tool)        → 工具参数摘要字符串(缺省内置保守实现)
 *
 * 上限是硬的(TOTAL_LINE_CAP / TOOL_BODY_LINE_CAP):长会话不能让视图把整段历史
 * 铺进内存再切片。超限时保留尾部并在首行注明丢了多少,绝不静默丢内容。
 */

// 总行数上限:超过后从**尾部**保留(用户要看的永远是最近的对话),头部截断并注明。
const TOTAL_LINE_CAP = 20000;

// 唯一的例外依赖:折行/行计费的单一真源(纯叶子、零 IO、fail-soft 自带兜底)。
const { wrapCell } = require('./wrapCell');
// 授权决定判词的单一真源(与 committed 侧 Transcript.MessageBlock 共用同一份判词)。
const _permissionNotice = require('./permissionNotice');
// 折叠/展开思考行的文案单一真源(与 committed 全屏浮层的 Transcript.js 共用同一份
// 摘要与时长口径 —— 此前这里自己拼 `'💭 思考 · N 字'`,浮层侧却显示真实思考时长,
// 同一个折叠行在两个面上口径不一致)。
const { buildThinkingSummary, buildThinkingHeader } = require('../thinkingDuration');
// showAll 时单个工具结果最多展开的行数。
const TOOL_BODY_LINE_CAP = 200;
// 单行硬截断宽度兜底(cols 非法时用)。
const DEFAULT_COLS = 80;

function _cols(cols) {
  const n = Number(cols);
  return Number.isFinite(n) && n >= 20 ? Math.floor(n) : DEFAULT_COLS;
}

function _str(v) {
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

// 把一段可能含换行的文本切成行;每行按**显示宽度**硬折(不做断词)。
// 折行必须委托 wrapCell —— 它是「折行 + 行计费」的单一真源(DESIGN-ARCH-103
// P0-4 / H6)。此处曾自己按 `line.length` 切字符:CJK 每字占 2 列 ⇒ 切出的行
// 实际 ≈ 2×cols 宽，被 Viewport 的 overflow:hidden 裁掉右半；内联着色的
// `ESC[36m` 又会被从中间锯断，终端把剩下的 `36m` 当正文打出来(BUG-32)。
function _wrap(text, width) {
  const w = width > 0 ? width : DEFAULT_COLS;
  // 与历史行为一致：逐逻辑行去掉行尾空白，再交给单一真源折行。
  return _str(text)
    .split('\n')
    .reduce((acc, raw) => acc.concat(wrapCell(raw.replace(/\s+$/, ''), w)), []);
}

function _truncate(s, max) {
  const t = _str(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, Math.max(1, max - 1)) + '…' : t;
}

// 内置保守摘要:优先常见描述性键,否则整体截断。调用方可用 summarizeTool 覆盖
// (TranscriptView 传 ToolLines.summarizeArgs,与 committed 区文案一致)。
const _ARG_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'name', 'prompt'];

function defaultSummarizeTool(tool) {
  if (!tool || typeof tool !== 'object') {
    return '';
  }
  const raw = tool.input ?? tool.args ?? tool.parameters;
  if (raw === null || raw === undefined) {
    return '';
  }
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return _truncate(raw, 60);
    }
  }
  if (!obj || typeof obj !== 'object') {
    return _truncate(obj, 60);
  }
  for (const k of _ARG_KEYS) {
    if (obj[k]) {
      return _truncate(obj[k], 60);
    }
  }
  return _truncate(_str(obj), 60);
}

function _toolStatus(tool) {
  const r = tool && tool.result;
  if (!r) {
    return { icon: '◆', label: '' };
  }
  if (r.isError || r.is_error || r.error || r.success === false) {
    return { icon: '✗', label: _truncate(r.error || r.message || '失败', 60) };
  }
  return { icon: '✓', label: '' };
}

// showAll 时工具结果的正文:从常见字段里取第一个非空的文本载荷。
const _BODY_KEYS = ['output', 'stdout', 'content', 'text', 'result', 'data'];

function _toolBody(result) {
  if (result === null || result === undefined) {
    return '';
  }
  if (typeof result === 'string') {
    return result;
  }
  if (typeof result !== 'object') {
    return _str(result);
  }
  for (const k of _BODY_KEYS) {
    const v = result[k];
    if (typeof v === 'string' && v.trim()) {
      return v;
    }
  }
  const err = result.error || result.message;
  if (typeof err === 'string' && err.trim()) {
    return err;
  }
  return '';
}

function _toolLines(tools, ctx) {
  const out = [];
  const list = Array.isArray(tools) ? tools : [];
  for (const tool of list) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const name = _str(tool.name || tool.toolName || tool.tool || 'tool');
    const args = _truncate(ctx.summarizeTool(tool), 60);
    const st = _toolStatus(tool);
    let head = '  ' + st.icon + ' ' + name;
    if (args) {
      head += '(' + args + ')';
    }
    if (st.label) {
      head += ' — ' + st.label;
    }
    out.push(..._wrap(head, ctx.cols));
    if (!ctx.showAll) {
      continue;
    }
    const body = _toolBody(tool.result);
    if (!body) {
      continue;
    }
    const bodyLines = _wrap(body, Math.max(20, ctx.cols - 4));
    const shown = bodyLines.slice(0, TOOL_BODY_LINE_CAP);
    for (const ln of shown) {
      out.push('    ' + ln);
    }
    const hidden = bodyLines.length - shown.length;
    if (hidden > 0) {
      out.push('    … 该工具输出还有 ' + hidden + ' 行未展开(单工具上限 ' + TOOL_BODY_LINE_CAP + ' 行)');
    }
  }
  return out;
}

// 助手消息的 timeline 条目(text / thinking / tools)。这里逐条投影,连续 tools
// 条目自然相邻,视觉上仍读作一个过程组。
//
// 返回 `{ lines, marks }`:marks 与 lines **同长**,只有思维链的那一行带
// `{ kind:'thinking', key }`(其余一律 null)。它是「折叠行 → 条目」的唯一映射真源 ——
// 逐条点击展开要靠它把**屏幕行下标**换回「哪条消息的第几段思考」,绝不允许反过来
// 用文本前缀去猜(那是第二份折叠判据,改文案就静默失效)。
function _timelineLines(timeline, ctx, keyBase) {
  const out = [];
  const marks = [];
  const _mark = (line, key) => {
    out.push(line);
    marks.push(key ? { kind: 'thinking', key } : null);
  };
  let seg = -1;
  for (const e of timeline) {
    seg += 1;
    if (!e || typeof e !== 'object') {
      continue;
    }
    if (e.type === 'text') {
      if (!e.text) {
        continue;
      }
      if (out.length > 0) {
        out.push('');
        marks.push(null);
      }
      for (const ln of _wrap(ctx.renderMarkdown(_str(e.text), ctx.cols), ctx.cols)) {
        out.push(ln);
        marks.push(null);
      }
    } else if (e.type === 'thinking') {
      if (!e.text) {
        continue;
      }
      if (out.length > 0) {
        out.push('');
        marks.push(null);
      }
      const key = `${keyBase}:${seg}`;
      // 展开来源有二:全局 showAll(Ctrl+O)与**逐条点击**。后者只放开这一条。
      const open = ctx.showAll || (ctx.expandedThinking && ctx.expandedThinking.has(key));
      if (open) {
        _mark(buildThinkingHeader({ durationMs: e.durationMs }), key);
        for (const ln of _wrap(_str(e.text).trim(), ctx.cols)) {
          out.push(ln);
          marks.push(null);
        }
      } else {
        const chars = _str(e.text).replace(/\s+/g, '').length;
        _mark(buildThinkingSummary({ chars, durationMs: e.durationMs, hint: ctx.thinkingHint }), key);
      }
    } else if (e.type === 'tools') {
      const lines = _toolLines(e.tools, ctx);
      if (lines.length === 0) {
        continue;
      }
      if (out.length > 0) {
        out.push('');
        marks.push(null);
      }
      for (const ln of lines) {
        out.push(ln);
        marks.push(null);
      }
    }
  }
  return { lines: out, marks };
}

// 与 _timelineLines 同口径:返回 { lines, marks };marks 为 null 表示「本消息没有
// 可逐条展开的行」,调用方按 lines.length 补 null。
function _messageLines(msg, ctx, keyBase) {
  if (!msg || typeof msg !== 'object') {
    return { lines: [], marks: [] };
  }
  const plain = (lines) => ({ lines, marks: null });
  const cols = ctx.cols;
  switch (msg.role) {
    case 'user': {
      const lines = _wrap(_str(msg.content), Math.max(20, cols - 2)).map(
        (ln, i) => (i === 0 ? '❯ ' : '  ') + ln
      );
      if (Number(msg.imageCount) > 0) {
        lines.push('  📎×' + Number(msg.imageCount));
      }
      return plain(lines);
    }
    case 'assistant': {
      const timeline =
        Array.isArray(msg.timeline) && msg.timeline.length > 0 ? msg.timeline : null;
      if (timeline) {
        const { lines, marks } = _timelineLines(timeline, ctx, keyBase);
        // Non-streaming adapter fallback:timeline 只带工具时,可见答复在 content 里。
        const hasText = timeline.some((e) => e && e.type === 'text' && e.text);
        if (!hasText && msg.content) {
          const head = _wrap(ctx.renderMarkdown(_str(msg.content), cols), cols);
          return {
            lines: [...head, ...lines],
            marks: new Array(head.length).fill(null).concat(marks),
          };
        }
        return { lines, marks };
      }
      const lines = [];
      if (msg.content) {
        lines.push(..._wrap(ctx.renderMarkdown(_str(msg.content), cols), cols));
      }
      if (Array.isArray(msg.tools) && msg.tools.length > 0) {
        lines.push(..._toolLines(msg.tools, ctx));
      }
      return plain(lines);
    }
    case 'error':
      return plain(_wrap('✗ 错误：' + _str(msg.content), cols));
    case 'bash-command':
      return plain(_wrap('! ' + _str(msg.content), cols));
    case 'bash-output': {
      const text = _str(msg.content).replace(/\n+$/, '');
      if (!text) {
        return plain(['（无输出）']);
      }
      return plain(_wrap(text, Math.max(20, cols - 2)).map((ln, i) => (i === 0 ? '⎿ ' : '  ') + ln));
    }
    case 'notice': {
      const c = msg.content;
      if (c && typeof c === 'object' && c.gateway === true) {
        const detail = _str(c.detail).split('\n');
        const summary = typeof c.content === 'string' ? c.content : detail[0] || '';
        if (!ctx.showAll || detail.length <= 1) {
          const extra = detail.length > 1 ? '  (+' + (detail.length - 1) + ' 行)' : '';
          return plain(_wrap('· ' + summary + extra, cols));
        }
        const out = _wrap('· ' + summary, cols);
        for (const ln of detail.slice(1)) {
          out.push(..._wrap('  ' + ln, cols));
        }
        return plain(out);
      }
      return plain(_wrap('· ' + _str(c), cols));
    }
    case 'turn-stats':
      return plain(msg.content ? _wrap(_str(msg.content), cols) : []);
    // 授权决定的**判词**(useQueryBridge.buildDecisionRecord 写、此前只有 committed 侧
    // 的 Transcript.MessageBlock 画 ⇒ 应用内 Viewport 里那条决定是隐形的,与它自己的注释
    // 「让决定在浮层消失后仍可见」正好相反)。判词与 committed 侧共用 permissionNotice
    // 的同一份 decisionVerdict,两套渲染不会各说各话。
    case 'decision': {
      const v = _permissionNotice.decisionVerdict(msg.decision);
      const tool = _str(msg.tool);
      const arg = _str(msg.argSummary);
      return plain(
        _wrap(
          `  ${v.mark}${v.label}${tool ? `：${tool}` : ''}${arg ? `(${_truncate(arg, 60)})` : ''}`,
          cols
        )
      );
    }
    default: {
      // 未知/展示型角色(decision / expansion / qa / 未来新增)统一走保守文本投影,
      // 拿不到文本就整条跳过 —— 前向兼容 fail-soft,绝不因新角色抛错。
      const c = msg.content;
      const text = _str(c && typeof c === 'object' ? c.text || c.content : c);
      return plain(text ? _wrap(text, cols) : []);
    }
  }
}

/**
 * messages → 文本行数组 + **平行的角色数组**。空/非法输入 → 两个空数组。绝不抛。
 *
 * 为什么角色只能走平行数组:行数组是「纯文本投影」——`wrapCell` 的折行、`Viewport` 的
 * `overflow:hidden` 截断、`selection.js` 的「屏幕行 == 数组下标 + 列号换算」全都建立
 * 在「元素是不含元数据的裸字符串」之上(见 App.js `_mainContentLines` 的 ⚠ 契约)。
 * 所以角色绝不塞进 `lines[i]`,而是同长同序地放在 `roles[i]`。
 *
 * `roles[i]` 取消息的 `role`(user / assistant / error / turn-stats …);消息之间的
 * 空行与「更早的 N 行未载入」那行取 `''`(= 不着色)。
 *
 * `folds[i]` 是第三个同长同序数组 —— **行 → 可折叠条目**的锚点:思维链行带
 * `{ kind:'thinking', key }`,其余行为 `null`。它存在的唯一理由是「屏幕行 == lines
 * 下标」这条不变量不许被破坏:要逐条展开就只能再挂一个平行数组,绝不把元数据混进
 * `lines[i]`,也绝不靠文本前缀反推是哪一条(那是第二份折叠判据)。
 *
 * @param {Array} messages 会话消息(useQueryBridge 的 messages)
 * @param {{cols?:number, showAll?:boolean, renderMarkdown?:Function, summarizeTool?:Function, thinkingHint?:string, expandedThinking?:{has:Function}}} opts
 * @returns {{lines:string[], roles:string[], folds:(object|null)[]}} 三个数组**恒同长**。
 */
function buildTranscriptLineRecords(messages, opts) {
  try {
    const list = Array.isArray(messages) ? messages : [];
    const o = opts && typeof opts === 'object' ? opts : {};
    const ctx = {
      cols: _cols(o.cols),
      showAll: !!o.showAll,
      // 折叠行的展开提示后缀由调用方面定(浮层 Ctrl+O / 内联区点击),缺省沿用 SSOT 默认值。
      thinkingHint: typeof o.thinkingHint === 'string' ? o.thinkingHint : undefined,
      // 逐条展开的思维链 key 集合(Set 或任何带 .has 的对象);null/缺省 → 全部折叠。
      expandedThinking:
        o.expandedThinking && typeof o.expandedThinking.has === 'function'
          ? o.expandedThinking
          : null,
      renderMarkdown: typeof o.renderMarkdown === 'function' ? o.renderMarkdown : (t) => _str(t),
      summarizeTool:
        typeof o.summarizeTool === 'function' ? o.summarizeTool : defaultSummarizeTool,
    };
    const lines = [];
    const roles = [];
    const folds = [];
    let mi = -1;
    for (const msg of list) {
      mi += 1;
      let msgLines = [];
      let msgMarks = null;
      try {
        const rec = _messageLines(msg, ctx, _str(msg && msg.uuid) || `i${mi}`);
        msgLines = rec.lines;
        msgMarks = rec.marks;
      } catch {
        msgLines = []; // 单条消息投影失败不拖垮整个视图
      }
      if (!msgLines || msgLines.length === 0) {
        continue;
      }
      const role = msg && typeof msg === 'object' ? _str(msg.role) : '';
      if (lines.length > 0) {
        lines.push(''); // 消息之间恰一空行(对齐 committed 区的 marginTop:1)
        roles.push('');
        folds.push(null);
      }
      for (let j = 0; j < msgLines.length; j++) {
        lines.push(msgLines[j]);
        roles.push(role);
        folds.push(msgMarks && msgMarks.length === msgLines.length ? msgMarks[j] : null);
      }
    }
    if (lines.length > TOTAL_LINE_CAP) {
      const dropped = lines.length - TOTAL_LINE_CAP;
      return {
        lines: [
          '… 更早的 ' + dropped + ' 行未载入(已达 ' + TOTAL_LINE_CAP + ' 行视图上限)',
          ...lines.slice(dropped),
        ],
        // 截断提示行本身不是任何消息的一部分 → 角色空(不着色),保持两个数组同长。
        roles: ['', ...roles.slice(dropped)],
        // 提示行同样不是任何思维链 → 锚点 null,保持三个数组同长。
        folds: [null, ...folds.slice(dropped)],
      };
    }
    return { lines, roles, folds };
  } catch {
    return { lines: [], roles: [], folds: [] };
  }
}

/**
 * messages → 文本行数组。空/非法输入 → []。绝不抛。
 *
 * 是 `buildTranscriptLineRecords` 的**行视图**:逐字节等于它出现之前的实现(同一份
 * 投影、同一个上限截断),只是丢掉了角色。老调用方一律不受影响。
 *
 * @param {Array} messages 会话消息(useQueryBridge 的 messages)
 * @param {{cols?:number, showAll?:boolean, renderMarkdown?:Function, summarizeTool?:Function}} opts
 * @returns {string[]}
 */
function buildTranscriptLines(messages, opts) {
  return buildTranscriptLineRecords(messages, opts).lines;
}

module.exports = {
  buildTranscriptLines,
  buildTranscriptLineRecords,
  defaultSummarizeTool,
  TOTAL_LINE_CAP,
  TOOL_BODY_LINE_CAP,
};
