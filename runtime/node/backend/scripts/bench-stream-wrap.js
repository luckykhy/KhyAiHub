'use strict';

// 基线：App.js `_mainContentLines` memo 里对流式正文的折行开销。
// 缺陷本体在 App.js:6367 —— 每个 paint 都对本轮累积全文重跑 wrapCell，
// 而 memo deps 含 query.streaming（useQueryBridge 的 {...v} 每帧新对象），
// 于是每轮 O(N²)。此脚本只测**真实生产模块** `src/cli/tui/wrapCell.js`，
// 不复制它的逻辑；O(N²) 要看 turn-* 累计点随规模的增幅倍数，不是单帧点数。
//
// 用法：`node runtime/node/backend/scripts/bench-stream-wrap.js`（仓库根，无需 npm）

const path = require('path');

const BACKEND = path.join(__dirname, '..');
const { wrapCell, wrapCellIncremental } = require(path.join(BACKEND, 'src', 'cli', 'tui', 'wrapCell.js'));

// App.js `_mainContentCols` 的缺省口径（无侧栏、无 rail 时 `_railCols(0) || 80`）。
const COLS = 80;
const WIDE_COLS = 200;
const REPS = 7; // best-of-7
const FRAME_CHARS = ['3000', '20000', '40000', '64000']; // 单帧折行
const TURN_CHARS = ['4000', '8000', '16000']; // 整轮累计
const TURN_CHUNK_CHARS = 200; // 一次 paint 追加的字符量

// 确定性伪随机：同一规模每次跑出的文本完全一致，读数可比。
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

// 贴近模型输出的混合体：中文、ASCII、行内标记、空行、代码围栏、列表。
const PIECES = [
  '根据上一轮的反馈，',
  '`wrapCell` 的显示宽度计量',
  '在 CJK 上按 2 列计，',
  'emoji 与代理对也一并处理。',
  '\n\n- 每帧重新折行\n- memo deps 含 streaming\n\n',
  '```js\nfor (const seg of wrapCell(text, cols)) {}\n```\n\n',
  'this is a plain ASCII sentence that keeps going for a while, ',
  '**加粗**、*斜体*、`行内代码`、',
  '\n',
  '结语：本轮结论已在上文给出。',
];

function makeText(chars, seed) {
  const rnd = lcg(seed || 1);
  let out = '';
  while (out.length < chars) out += PIECES[Math.floor(rnd() * PIECES.length)];
  return out.slice(0, chars);
}

function bestOf(fn) {
  fn(); // 预热不计入 —— 首次调用要把 wrapCell 惰性 require 的 string-width 付掉
  let best = Infinity;
  for (let i = 0; i < REPS; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

// 整轮：一帧一帧追加，每帧对累积全文折行。
// fullTurn = 改前口径（每帧全量重折）；incTurn = App.js 现在的口径（只扫新增尾巴）。
// 两者跑的是同一个 `_scan`，差别只在每帧重扫多少字符。
// 帧间隔按 useQueryBridge 的 FRAME_MS=40 折算，故墙钟与 CPU 同步，
// 单看这里的 ms 就是「一次会话答复里花在折行上的时间」。
function fullTurn(totalChars) {
  const step = makeText(TURN_CHUNK_CHARS, 7);
  const t0 = process.hrtime.bigint();
  let acc = '';
  while (acc.length < totalChars) {
    acc += step;
    wrapCell(acc, COLS);
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function incTurn(totalChars) {
  const step = makeText(TURN_CHUNK_CHARS, 7);
  const t0 = process.hrtime.bigint();
  let acc = '';
  let state = null;
  while (acc.length < totalChars) {
    acc += step;
    state = wrapCellIncremental(state, acc, COLS).state;
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const points = [];
for (const n of FRAME_CHARS) {
  const text = makeText(Number(n), Number(n) + 1);
  points.push({ label: 'chars' + n, ms: bestOf(() => wrapCell(text, COLS)) });
}

// 反驳「cols 大就变快」：同一份文本换 200 列再测。
const wide = makeText(64000, 64001);
points.push({ label: 'chars64000-cols' + WIDE_COLS, ms: bestOf(() => wrapCell(wide, WIDE_COLS)) });

for (const n of TURN_CHARS) {
  points.push({ label: 'turn-chars' + n, ms: bestOf(() => fullTurn(Number(n))) });
  points.push({ label: 'turn-inc-chars' + n, ms: bestOf(() => incTurn(Number(n))) });
}

process.stdout.write(
  JSON.stringify({
    subject:
      'App.js 流式正文折行：单帧全量 wrapCell + 整轮累计（turn-chars=每帧全量重折，' +
      'turn-inc-chars=wrapCellIncremental 只扫新增尾巴，即改后口径）' +
      '（真实模块 src/cli/tui/wrapCell.js，best-of-' +
      REPS +
      '，cols=' +
      COLS +
      '）',
    points,
  }) + '\n'
);
