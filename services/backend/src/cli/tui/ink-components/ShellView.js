'use strict';

/**
 * ShellView — a peek panel (块4 SUBVIEW) over the CURRENT or most-recent tool
 * call's command and output, opened with ↓ while a turn is executing.
 *
 * It reads from the live streaming state (timeline/tools) — the same data the
 * StreamingBlock tails — so it needs no backend change. As the tool result fills
 * in, the panel reflects it; if the backend later streams incremental tool
 * output, this panel lights up automatically. Bounded height + a scroll offset
 * keep it within the viewport (anti-staircase, consistent with StreamingBlock).
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');
const { STATUS, isAgentFamilyTool, statusDot, formatStats } = require('../../agentTreeView');

function _toolName(t) {
  return (t && (t.name || t.toolName || t.tool)) || 'tool';
}

// [DESIGN-FOLD-001] §2 L3: does the latest tool carry a live sub-agent fan-out
// tree? Only then does ↓ open the sub-task peek (otherwise the shell peek).
function _agentTreeOf(tool) {
  if (!tool || !isAgentFamilyTool(tool.name || tool.toolName || tool.tool || '')) {
    return null;
  }
  const tree = tool._agentTree;
  return Array.isArray(tree) && tree.length > 0 ? tree : null;
}

// Flatten the fan-out into one scrollable line list: per agent a status header,
// its bounded full-prose buffer (honest dropped-count line when capped), then a
// spacer. Each entry keeps its own colour/bold props so the window slice can
// render mixed-weight lines. Pure; never throws.
function _agentPeekLines(tree) {
  const flat = [];
  const list = Array.isArray(tree) ? tree : [];
  list.forEach((a) => {
    const name = (a && a.name) || 'agent';
    const status = (a && a.status) || STATUS.PENDING;
    const dot = statusDot(status);
    const stats = formatStats(a);
    const statsStr = stats.length > 0 ? ` · ${stats.join(' · ')}` : '';
    flat.push({ text: `${dot} ${name} · ${status}${statsStr}`, bold: true });
    const dropped = (a && a.outputDropped) || 0;
    if (dropped > 0) {
      flat.push({ text: `  …（早前 ${dropped} 行已省略）`, dim: true });
    }
    const lines = Array.isArray(a && a.outputLines) ? a.outputLines : [];
    if (lines.length === 0 && !(a && a.outputTail)) {
      flat.push({ text: '  （暂无正文输出）', dim: true });
    } else {
      lines.forEach((ln) => flat.push({ text: `  ${ln}` }));
      if (a && a.outputTail) {
        // Partial line still streaming — shown as-is so the tail is visible.
        flat.push({ text: `  ${a.outputTail}` });
      }
    }
    flat.push({ text: '' });
  });
  return flat;
}

// Most-descriptive common arg keys, in preference order. Hoisted to a module
// constant so _argSummary() iterates one shared array instead of rebuilding
// the literal each peek-panel render. Read-only iterand; never mutated.
const _ARG_SUMMARY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'description',
];

function _argSummary(t) {
  const raw = t && (t.input ?? t.args ?? t.parameters ?? t.arguments);
  if (raw == null) {
    return '';
  }
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (typeof obj !== 'object') {
    return String(obj);
  }
  for (const key of _ARG_SUMMARY_KEYS) {
    if (obj[key]) {
      return String(obj[key]);
    }
  }
  return Object.keys(obj)
    .map((k) => `${k}=${typeof obj[k] === 'string' ? obj[k] : JSON.stringify(obj[k])}`)
    .join(', ');
}

function _resultText(t) {
  const r = t && t.result;
  if (!r) {
    return '';
  }
  const text = r.text || r.content || r.output || '';
  return typeof text === 'string' ? text : JSON.stringify(text, null, 2);
}

// Pick the most recent tool from the live state: prefer the last tool entry in
// the ordered timeline, else the last item in the flat tools array.
function _latestTool(streaming) {
  if (!streaming) {
    return null;
  }
  const tl = Array.isArray(streaming.timeline) ? streaming.timeline : null;
  if (tl) {
    for (let i = tl.length - 1; i >= 0; i--) {
      if (tl[i] && tl[i].type === 'tool' && tl[i].tool) {
        return tl[i].tool;
      }
    }
  }
  const tools = Array.isArray(streaming.tools) ? streaming.tools : null;
  if (tools && tools.length) {
    return tools[tools.length - 1];
  }
  return null;
}

function ShellView({ streaming, scroll = 0 }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  const tool = _latestTool(streaming);
  if (!tool) {
    return h(
      Box,
      {
        flexDirection: 'column',
        marginTop: 1,
        borderStyle: 'round',
        borderColor: 'cyan',
        paddingX: 1,
      },
      h(Text, { color: 'cyan', bold: true }, '⊟ 实时输出'),
      h(Text, { dimColor: true }, '（暂无正在执行的工具）· ← 返回')
    );
  }

  // [DESIGN-FOLD-001] §2 L3: agent-family tool with a live fan-out tree → the
  // sub-task peek (per-agent full prose, bounded + scrollable). Everything else
  // falls through to the command peek byte-identically.
  const agentTree = _agentTreeOf(tool);
  if (agentTree) {
    return _renderAgentPeek({ h, Box, Text, tree: agentTree, scroll });
  }

  const done = !!tool.result;
  const isErr = done && (tool.result.isError || tool.result.is_error || tool.result.error);
  const statusIcon = !done ? '◆' : isErr ? '✗' : '✓';
  const statusColor = !done ? 'yellow' : isErr ? 'red' : 'green';

  const out = _resultText(tool);
  const allLines = out ? out.split('\n') : [];

  // Bounded viewport for the body. Leave room for the prompt frame + footer.
  const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;
  const maxBody = Math.max(4, Math.min(allLines.length, rows - 12));

  // Clamp the scroll offset to the scrollable range.
  const maxScroll = Math.max(0, allLines.length - maxBody);
  const off = Math.max(0, Math.min(scroll, maxScroll));
  const body = allLines.slice(off, off + maxBody);

  const children = [
    h(
      Box,
      { key: 'title' },
      h(Text, { color: 'cyan', bold: true }, '⊟ 实时输出  '),
      h(Text, { color: statusColor }, statusIcon + ' '),
      h(Text, { bold: true }, _toolName(tool))
    ),
    h(Text, { key: 'arg', dimColor: true }, '$ ' + _argSummary(tool)),
  ];

  if (allLines.length === 0) {
    children.push(h(Text, { key: 'pending', dimColor: true }, done ? '（无输出）' : '执行中…'));
  } else {
    children.push(
      h(
        Box,
        { key: 'body', flexDirection: 'column', marginTop: 1 },
        ...body.map((ln, i) => h(Text, { key: i }, ln))
      )
    );
  }

  // Scroll/return affordance.
  const scrollInfo =
    maxScroll > 0 ? `  ·  ${off + 1}-${off + body.length}/${allLines.length}  (↑↓ 滚动)` : '';
  children.push(h(Text, { key: 'hint', dimColor: true }, `← 返回${scrollInfo}`));

  return h(
    Box,
    {
      flexDirection: 'column',
      marginTop: 1,
      borderStyle: 'round',
      borderColor: 'cyan',
      paddingX: 1,
    },
    ...children
  );
}

// [DESIGN-FOLD-001] §2 L3 — the sub-task peek body. Same bounded-viewport
// discipline as the command peek (rows-12 body, clamped scroll offset, honest
// window counter) so the panel can never overflow the live region.
function _renderAgentPeek({ h, Box, Text, tree, scroll }) {
  const flat = _agentPeekLines(tree);
  const running = Array.isArray(tree)
    ? tree.some((a) => a && a.status === STATUS.RUNNING)
    : false;

  const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;
  const maxBody = Math.max(4, Math.min(flat.length, rows - 12));
  const maxScroll = Math.max(0, flat.length - maxBody);
  const off = Math.max(0, Math.min(scroll, maxScroll));
  const body = flat.slice(off, off + maxBody);

  const children = [
    h(
      Box,
      { key: 'title' },
      h(Text, { color: 'cyan', bold: true }, '⊟ 子任务副屏  '),
      h(Text, { color: running ? 'yellow' : 'green' }, running ? '◆' : '✓'),
      h(Text, { bold: true }, ` ${tree.length} agents`)
    ),
  ];

  if (flat.length === 0) {
    children.push(h(Text, { key: 'empty', dimColor: true }, '（暂无子任务）'));
  } else {
    children.push(
      h(
        Box,
        { key: 'body', flexDirection: 'column', marginTop: 1 },
        ...body.map((ln, i) =>
          h(
            Text,
            { key: i, dimColor: !!ln.dim, bold: !!ln.bold },
            ln.text
          )
        )
      )
    );
  }

  const scrollInfo =
    maxScroll > 0 ? `  ·  ${off + 1}-${off + body.length}/${flat.length}  (↑↓ 滚动)` : '';
  children.push(h(Text, { key: 'hint', dimColor: true }, `← 返回${scrollInfo}`));

  return h(
    Box,
    {
      flexDirection: 'column',
      marginTop: 1,
      borderStyle: 'round',
      borderColor: 'cyan',
      paddingX: 1,
    },
    ...children
  );
}

module.exports = ShellView;
