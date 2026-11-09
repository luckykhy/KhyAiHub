'use strict';

/**
 * bench-transcript-projection — 量 App.js 每帧在转录投影上花掉的真实开销。
 *
 * 跑的是生产模块本身（`src/cli/tui/transcriptLines`），渲染器也用 App 实际传进去的
 * 那两个（`Transcript.renderMarkdown` / `ToolLines.summarizeArgs`），不是复制一份逻辑
 * 在这里重演 —— 复制出来的数字量的是这个脚本，不是 App。
 *
 * 一次「帧」在这里等于 App.js 两个 memo 合起来干的事（`_mainContentLines` 走
 * `buildTranscriptLines`，`_mainContentRecords` 走 `buildTranscriptLineRecords` 再逐行核对
 * 前缀）。memo 的 deps 只差 roles/folds 用到的那些，所以两者在同一次重算里必然都跑。
 *
 * 用法：`node runtime/node/backend/scripts/bench-transcript-projection.js`
 * stdout 只有一个 JSON 对象，无别的输出。
 */

const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const transcriptLines = require(path.join(BACKEND, 'src/cli/tui/transcriptLines'));
const Transcript = require(path.join(BACKEND, 'src/cli/tui/ink-components/Transcript'));
const ToolLines = require(path.join(BACKEND, 'src/cli/tui/ink-components/ToolLines'));

// 与 App.js `_THINKING_CLICK_HINT` 同串（App.js:42）。
const THINKING_CLICK_HINT = '（点击展开）';

// 主内容列宽。App 走 `_mainContentCols`（有看板时是减过看板宽的列），这里取一个
// 中间偏窄的真实值而不是 80 —— 折行越窄行数越多，越接近满屏 transcript 的实际负载。
const COLS = 72;

const REPEATS = 7;

// 确定性伪随机：同一份会话每次跑出来的行数完全一致，跨次运行可比。
function _rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const _WORDS = [
  '投影', '转录', '折行', '消息', '思维链', '工具', '角色', '视口', '选区', '截断',
  'memo', 'deps', '行数', '上限', '渲染器', '前缀', '核对', '数组', '同长', '锚点',
];

function _sentence(rand, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(_WORDS[Math.floor(rand() * _WORDS.length)]);
  return out.join(' ') + '。';
}

// 一条 assistant 消息：思维链 + 工具 + 带 markdown 的答复，覆盖投影里的三条主路径。
function _assistant(rand) {
  return {
    role: 'assistant',
    timeline: [
      {
        type: 'thinking',
        text: _sentence(rand, 120),
        durationMs: 1200 + Math.floor(rand() * 4000),
      },
      {
        type: 'tools',
        tools: [
          {
            name: 'readFile',
            input: { file_path: 'runtime/node/backend/src/cli/tui/transcriptLines.js' },
            result: { success: true, output: _sentence(rand, 40) },
          },
          {
            name: 'bash',
            input: { command: 'node runtime/node/backend/scripts/bench-transcript-projection.js' },
            result: { success: true, output: _sentence(rand, 30) },
          },
        ],
      },
      {
        type: 'text',
        text:
          '## 小节\n\n' +
          '- ' + _sentence(rand, 8) + '\n' +
          '- ' + _sentence(rand, 8) + '\n\n' +
          '```js\nconst a = 1;\nconst b = a + 1;\n```\n\n' +
          _sentence(rand, 60) + '\n\n' +
          '> ' + _sentence(rand, 10),
      },
    ],
  };
}

// 会话按 user/assistant 交替，`msgs` 指消息条数（所以 assistant 约一半）。
function _session(msgs, seed) {
  const rand = _rng(seed);
  const out = [];
  for (let i = 0; i < msgs; i++) {
    out.push(i % 2 === 0 ? { role: 'user', content: _sentence(rand, 14) } : _assistant(rand));
  }
  return out;
}

const _opts = () => ({
  cols: COLS,
  showAll: false,
  renderMarkdown: Transcript.renderMarkdown,
  summarizeTool: ToolLines.summarizeArgs,
  expandedThinking: new Set(),
  thinkingHint: THINKING_CLICK_HINT,
});

// App.js `_mainContentLines` + `_mainContentRecords` 两个 memo 一次重算的等价体。
// 改前是「投影两遍 + 第二遍逐行核对前缀」；现在两个 memo 共用同一份 `_committedRecords`，
// 故这里也只投影一遍，第二个 memo 只做前缀核对（CAP 截断守卫）。
function _frame(messages, opts) {
  const rec = transcriptLines.buildTranscriptLineRecords(messages, opts);
  if (!rec || !Array.isArray(rec.lines) || !Array.isArray(rec.roles)) return null;
  const lines = rec.lines;
  const n = Math.min(rec.lines.length, rec.roles.length, lines.length);
  if (n !== rec.lines.length) return null;
  for (let i = 0; i < n; i++) {
    if (rec.lines[i] !== lines[i]) return null;
  }
  return { lines: lines.length, roles: rec.roles.length, folds: rec.folds.length };
}

function _bench(label, messages, fn) {
  fn(messages, _opts()); // 首次预热不进统计
  let best = Infinity;
  for (let r = 0; r < REPEATS; r++) {
    const t0 = process.hrtime.bigint();
    fn(messages, _opts());
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  return Math.round(best * 10) / 10;
}

// 只跑一份投影 —— 与 _frame 同口径，用来核对「两个 memo 共用一份」之后没有额外开销。
function _once(messages, opts) {
  return transcriptLines.buildTranscriptLineRecords(messages, opts).lines;
}

const SCALES = [80, 160, 240, 320];

const points = [];
const stats = [];
for (const msgs of SCALES) {
  const session = _session(msgs, 20261012 + msgs);
  const shape = _frame(session, _opts()); // 确认这一帧真的投影成功（没早退、没错位）
  const frameMs = _bench('msgs' + msgs, session, _frame);
  const onceMs = _bench('msgs' + msgs + '_once', session, _once);
  points.push({ label: 'msgs' + msgs, ms: frameMs });
  points.push({ label: 'msgs' + msgs + '_once', ms: onceMs });
  stats.push({
    msgs,
    lines: shape.lines,
    frameMs,
    onceMs,
    ratio: Math.round((frameMs / onceMs) * 100) / 100,
  });
}

process.stdout.write(
  JSON.stringify({
    subject:
      'App.js 每帧对整场会话的转录投影：_mainContentLines 与 _mainContentRecords ' +
      '共用同一份 buildTranscriptLineRecords（改前是两个 memo 各跑一遍完整投影），' +
      'best-of-' + REPEATS + '（已去首次预热），cols=' + COLS + '，showAll=false',
    points,
    stats,
  }) + '\n'
);
