'use strict';

/**
 * Colocated contract test for toolExecutionSink.js (display-side sink for the
 * structured tool-execution report).
 *
 * Pinned here:
 *   ① the gate: same env literal as the S4/S5 producers, only '1' opens it, and a
 *      DIFFERENTLY named var (the workflow sibling `KHY_WORKFLOW_TOOL_GROUPS`, or the
 *      one-char-short typo) must NOT open it — otherwise a drift in the literal turns
 *      the panel on for installs that never asked for it.
 *   ② gate OFF is byte-identical to "no sink at all": ingest() stores nothing,
 *      snapshot() is null, panelRows() is 0. That is the user's first hard constraint
 *      ("门关时默认行为必须逐字节不变") and it is what makes the App.js wiring safe.
 *   ③ the three zones, in order, with REAL data: the projection alone (D2 returns
 *      {groups, rows, totals} and drops the step bodies) silently degrades every step
 *      row to "✗ 其它 · 步骤数据缺失" and empties the summary's usage[]. The sink must
 *      therefore feed the projection's own `steps` back into buildToolExecutionReport.
 *   ④ the zone ORDER comes from REPORT_ZONES, not from this file: permuting the closed
 *      set must be caught by the S3 order gate (asserted via report.orderViolations).
 *   ⑤ no ANSI bytes ever reach the panel (DECSTBM / \x1B[2J are forbidden by
 *      tui/AGENTS.md §0.2), and nothing throws on garbage input.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');

const sink = require('./toolExecutionSink');
const { projectTurnTimeline } = require('../toolExecutionTimeline');
const report = require('../toolExecutionReport');

// ── fixtures ───────────────────────────────────────────────────────────────

function liveTimeline() {
  return [
    { type: 'text', text: '先看一下配置' },
    {
      type: 'tool',
      tool: {
        name: 'Read',
        input: { path: 'a.js' },
        id: 'tu_1',
        result: { text: '...', isError: false, summary: '已读取 42 行' },
      },
    },
    {
      type: 'tool',
      tool: {
        name: 'Edit',
        input: { path: 'b.js' },
        id: 'tu_2',
        result: { text: 'ok', summary: '改好了', durationMs: 1200 },
      },
    },
    { type: 'tool', tool: { name: 'Bash', input: { cmd: 'ls' }, id: 'tu_3', progress: '正在跑' } },
  ];
}

function withGate(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'KHY_TUI_TOOL_GROUPS');
  const prev = process.env.KHY_TUI_TOOL_GROUPS;
  if (value === undefined) delete process.env.KHY_TUI_TOOL_GROUPS;
  else process.env.KHY_TUI_TOOL_GROUPS = value;
  try {
    sink.reset();
    return fn();
  } finally {
    if (had) process.env.KHY_TUI_TOOL_GROUPS = prev;
    else delete process.env.KHY_TUI_TOOL_GROUPS;
    sink.reset();
  }
}

/**
 * 一轮 n 次成功 Read 的 timeline —— 行帽/预算类用例的通用 fixture。
 * 抽出来是因为六处用例各写一遍（共 30 行），而本文件有 500 行硬顶。
 * @param {number} n
 * @returns {Array<object>}
 */
function manyTools(n) {
  const many = [];
  for (let i = 0; i < n; i += 1) {
    const tool = { name: 'Read', id: 't' + i, result: { text: 'x', isError: false } };
    many.push({ type: 'tool', tool });
  }
  return many;
}

/**
 * 一组账本份额实际画出的行数 = chrome + liveBudget。ink 在 outputHeight >= rows 时走
 * fullscreen 分支（chromeBudget.js:105，MEASURED 不是 >），故判据是严格小于。
 */
function paintedRows(rows, shares) {
  const { chromeRows, liveBudget } = require('../../utils/terminal/chromeBudget');
  return chromeRows(shares) + liveBudget(rows, shares);
}

const FRAME_SWEEP = [];
for (const rows of [10, 12, 16, 20, 24, 30, 40, 60, 120]) {
  for (const other of [0, 4, 10, 20, 40]) FRAME_SWEEP.push({ rows, other });
};

/**
 * 单组合的帧拟合判定，返 'fits' / 'already-broken'（后者 = 面板不在场也装不下的存量小屏）。
 * 这是 sink 对调用方的**契约**，不复制 App.js 的预算公式：只要调用方按「屏高 - 其余 chrome -
 * 账本下界 - 视口下限 - 尾行」预留，加面板就不会把帧推过 rows（App.js 那侧与 _cmBudget 同手法）。
 */
function frameOutcome(rows, other) {
  const { LIVE_MIN } = require('../../utils/terminal/chromeBudget');
  const budget = Math.max(0, rows - other - sink.MIN_OTHER_CHROME - LIVE_MIN - 1);
  const drawn = sink.panelRows({ instruction: 'x', rows, maxRows: budget });
  assert.ok(drawn <= budget, `rows=${rows} other=${other}: drew ${drawn} > budget ${budget}`);
  const bare = { inputRows: 1, statusRows: 1, extraRows: other, slack: 2 };
  if (paintedRows(rows, bare) >= rows) return 'already-broken';
  const shares = { inputRows: 1, statusRows: 1, extraRows: other + drawn, slack: 2 };
  const painted = paintedRows(rows, shares);
  assert.ok(painted < rows, `rows=${rows} other=${other} drawn=${drawn}: painted ${painted} >= rows`);
  return 'fits';
}


// ── ① gate ─────────────────────────────────────────────────────────────────

test('the gate is the S5 producer env name, and only "1" opens it', () => {
  assert.equal(sink.TOOL_GROUPS_ENV, 'KHY_TUI_TOOL_GROUPS');
  assert.equal(sink.isEnabled({ KHY_TUI_TOOL_GROUPS: '1' }), true);
  assert.equal(sink.isEnabled({ KHY_TUI_TOOL_GROUPS: ' 1 ' }), true);
  for (const off of ['0', 'true', 'yes', 'on', '', undefined, null, 1, {}, '2']) {
    assert.equal(
      sink.isEnabled({ KHY_TUI_TOOL_GROUPS: off }),
      false,
      `${JSON.stringify(off)} must not open the gate`
    );
  }
});

test('a differently named env var does not open the gate', () => {
  // The workflow sibling (S4) and the one-char-short typo are the two realistic
  // drifts: both are "some KHY_*_TOOL_GROUPS var", neither is THIS one.
  assert.equal(sink.isEnabled({ KHY_WORKFLOW_TOOL_GROUPS: '1' }), false);
  assert.equal(sink.isEnabled({ KHY_TUI_TOOL_GROUP: '1' }), false);
  assert.equal(sink.isEnabled({ KHY_CC_TUI: '1' }), false);
  assert.equal(sink.isEnabled({}), false);
});

test('isEnabled defaults to the live process env', () => {
  withGate('1', () => assert.equal(sink.isEnabled(), true));
  withGate(undefined, () => assert.equal(sink.isEnabled(), false));
});

// ── ② gate OFF is a no-op (byte-identical default) ─────────────────────────

test('gate OFF: ingest stores nothing, snapshot is null, panelRows is 0', () => {
  withGate(undefined, () => {
    const proj = projectTurnTimeline(liveTimeline());
    assert.equal(sink.ingest(proj), false, 'ingest refuses while the gate is closed');
    assert.equal(sink.snapshot({ instruction: '把配置改掉' }), null);
    assert.equal(sink.panelRows({ instruction: '把配置改掉', rows: 40 }), 0);
    // …and the projection is NOT retained: opening the gate afterwards must not
    // resurrect a report the closed gate already refused.
    assert.equal(sink.ingest(proj), false);
    process.env.KHY_TUI_TOOL_GROUPS = '1';
    assert.equal(sink.snapshot({ instruction: '把配置改掉' }), null);
  });
});

test('gate OFF: a garbage ingest is still a no-op and never throws', () => {
  withGate('0', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}]) {
      assert.equal(sink.ingest(bad), false);
    }
    assert.equal(sink.snapshot({}), null);
    assert.equal(sink.panelRows({}), 0);
  });
});

// ── ③ three zones, real data ───────────────────────────────────────────────

test('the three zones render in order with real step data', () => {
  withGate('1', () => {
    assert.equal(sink.ingest(projectTurnTimeline(liveTimeline())), true);
    const view = sink.snapshot({ instruction: '把配置改掉', rows: 40 });
    assert.ok(view, 'gate on + a projection ⇒ a view');
    assert.equal(view.rowCount, view.instructionRows.length + view.processRows.length + view.summaryRows.length);

    // 第 1 区: the instruction verbatim — no rewrite, no summary, no truncation.
    assert.deepEqual(view.instructionRows, ['把配置改掉']);

    // 第 2 区: narration is a first-class row, the group header carries the count,
    // and every step row shows its glyph + family + summary (NOT "步骤数据缺失").
    assert.equal(view.processRows[0], '● 先看一下配置');
    assert.match(view.processRows[1], /执行工具 3 次/);
    assert.equal(view.processRows.filter((r) => r.includes('步骤数据缺失')).length, 0);
    assert.ok(view.processRows.some((r) => r.includes('已读取 42 行')));
    assert.ok(view.processRows.some((r) => r.includes('正在跑')));

    // 第 3 区: totals AND usage[], with `unfinished` as a first-class count.
    const head = view.summaryRows[0];
    assert.match(head, /执行工具 3 次/);
    assert.match(head, /完成 2/);
    assert.match(head, /失败 0/);
    assert.match(head, /未完成 1/);
    assert.ok(view.summaryRows.some((r) => r.startsWith('按工具：')));
    assert.ok(view.summaryRows.some((r) => r.includes('Bash 1 次') && r.includes('未完成 1')));
    assert.ok(view.summaryRows.some((r) => r.includes('中位耗时 1 秒')));
  });
});

test('the projection alone (no steps) is NOT enough — the sink feeds them back', () => {
  // This is the regression guard for the silent degradation: D2's projection drops the
  // step bodies, so a sink that forgets to hand `steps` to the report builder renders
  // "✗ 其它 · 步骤数据缺失" for every row and an empty usage[].
  withGate('1', () => {
    const proj = projectTurnTimeline(liveTimeline());
    assert.ok(Array.isArray(proj.steps) && proj.steps.length === 3, 'S5 attaches the steps');
    const bare = report.buildToolExecutionReport({ projection: proj, instruction: 'x' });
    const bareText = report.renderReportText(bare).join('\n');
    assert.match(bareText, /步骤数据缺失/, 'sanity: without steps the rows degrade');
    assert.deepEqual(bare.stats.usage, [], 'sanity: without steps usage[] is empty');

    sink.ingest(proj);
    const view = sink.snapshot({ instruction: 'x', rows: 40 });
    assert.equal(view.processRows.filter((r) => r.includes('步骤数据缺失')).length, 0);
    assert.ok(view.report.stats.usage.length > 0, 'the sink restores usage[]');
  });
});

test('a multi-line instruction is never truncated', () => {
  withGate('1', () => {
    sink.ingest(projectTurnTimeline(liveTimeline()));
    const instruction = '第一行\n第二行\n\n第四行';
    const view = sink.snapshot({ instruction, rows: 40 });
    assert.deepEqual(view.instructionRows, ['第一行', '第二行', '', '第四行']);
    assert.equal(view.instructionRows.length, 4, 'empty lines survive');
  });
});

test('an empty instruction produces no zone-1 rows (not a blank line)', () => {
  withGate('1', () => {
    sink.ingest(projectTurnTimeline(liveTimeline()));
    const view = sink.snapshot({ instruction: '', rows: 40 });
    assert.deepEqual(view.instructionRows, []);
  });
});

// ── ④ order comes from REPORT_ZONES, not from here ─────────────────────────

test('zone order is the S3 closed set, and the report self-reports violations', () => {
  withGate('1', () => {
    sink.ingest(projectTurnTimeline(liveTimeline()));
    const view = sink.snapshot({ instruction: '把配置改掉', rows: 40 });
    assert.deepEqual(
      view.zones.map((z) => z.zone),
      ['instruction', 'process', 'summary'],
      'assembly order follows REPORT_ZONES'
    );
    assert.equal(view.orderOk, true);
    assert.deepEqual(view.orderViolations, []);
    assert.deepEqual(view.layoutViolations, []);

    // The order gate is mechanical: a permuted set must be caught by S3's own
    // predicate (the negative test mutates REPORT_ZONES and expects a red).
    const permuted = [view.zones[1], view.zones[0], view.zones[2]];
    assert.ok(report.zoneOrderViolations(permuted).length > 0);
  });
});

// ── ⑤ no ANSI bytes, no throws ─────────────────────────────────────────────

test('no ANSI / control bytes ever reach the panel rows', () => {
  // The escapes are ASSEMBLED, never written literally: a literal DECSTBM in this file
  // would itself trip check-agent-rules' scroll-region rule (the very rule this test
  // exists to keep the sink clear of).
  const ESC = String.fromCharCode(0x1b);
  const CLEAR2 = `${ESC}[2J`; // ED2 — full-screen clear, forbidden by tui/AGENTS.md §0.2
  const SCROLL = `${ESC}[1;24r`; // DECSTBM — scroll region, forbidden by tui/AGENTS.md §0.2
  const RED = `${ESC}[31m${ESC}[0m`;
  withGate('1', () => {
    const hostile = [
      { type: 'text', text: `前${CLEAR2}中${SCROLL}后${RED}红` },
      {
        type: 'tool',
        tool: {
          name: 'Read',
          id: 'tu_1',
          result: { text: 'x', summary: `ok${CLEAR2}done`, isError: false },
        },
      },
    ];
    sink.ingest(projectTurnTimeline(hostile));
    const view = sink.snapshot({ instruction: `指令${CLEAR2}原文`, rows: 40 });
    const all = [...view.instructionRows, ...view.processRows, ...view.summaryRows].join('\n');
    assert.equal(all.indexOf(ESC), -1, 'no ESC byte survives');
    assert.equal(all.indexOf('[2J'), -1, 'no full-screen-clear parameter survives');
    assert.equal(all.indexOf('[1;24r'), -1, 'no scroll-region parameter survives');
    assert.ok(all.includes('前中后'), 'visible text is untouched');
  });
});

test('garbage input never throws and degrades to null / empty', () => {
  withGate('1', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}, { groups: 'no', rows: 3, totals: null }]) {
      assert.doesNotThrow(() => sink.ingest(bad));
    }
    const view = sink.snapshot({ instruction: 'x', rows: 40 });
    if (view) {
      assert.ok(Array.isArray(view.instructionRows));
      assert.ok(Array.isArray(view.processRows));
      assert.ok(Array.isArray(view.summaryRows));
    }
    assert.doesNotThrow(() => sink.snapshot({ messages: 'not-an-array' }));
    assert.doesNotThrow(() => sink.panelRows({ rows: 'abc' }));
    assert.doesNotThrow(() => sink.reset());
  });
});

test('an empty turn projects zero process rows (the summary still counts 0)', () => {
  withGate('1', () => {
    sink.ingest(projectTurnTimeline([]));
    const view = sink.snapshot({ instruction: '', rows: 40 });
    assert.deepEqual(view.instructionRows, [], 'no instruction ⇒ no zone-1 rows');
    assert.deepEqual(view.processRows, [], 'no tools ⇒ no zone-2 rows');
    assert.ok(view.summaryRows.length > 0, 'the summary is still honest about "0 calls"');
    assert.equal(view.rowCount, view.summaryRows.length);
    assert.equal(sink.panelRows({ instruction: '', rows: 40 }), view.rowCount);
  });
});

// ── instruction extraction ─────────────────────────────────────────────────

test('latestInstruction takes the LAST user message (the current turn)', () => {
  const messages = [
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '答' },
    { role: 'notice', content: '提示' },
    { role: 'user', content: '第二句' },
    { role: 'assistant', content: '答2' },
  ];
  assert.equal(sink.latestInstruction(messages), '第二句');
  assert.equal(sink.latestInstruction([{ role: 'assistant', content: 'only' }]), '');
  assert.equal(sink.latestInstruction([]), '');
  assert.equal(sink.latestInstruction(null), '');
  assert.equal(sink.latestInstruction([{ role: 'user' }]), '');
  assert.equal(sink.latestInstruction([{ role: 'user', content: 42 }]), '42');
});

test('latestInstruction memoizes on the messages array identity', () => {
  const messages = [{ role: 'user', content: '同一句' }];
  const first = sink.latestInstruction(messages);
  const frozen = Object.freeze([{ role: 'user', content: '同一句' }]);
  assert.equal(sink.latestInstruction(messages), first, 'same identity ⇒ memo hit');
  assert.equal(sink.latestInstruction(frozen), '同一句', 'a new array is re-scanned');
});

// ── height ledger ──────────────────────────────────────────────────────────

test('panelRows equals the rowCount the panel will actually draw', () => {
  withGate('1', () => {
    sink.ingest(projectTurnTimeline(liveTimeline()));
    for (const rows of [24, 30, 40, 60, 200]) {
      const opts = { instruction: '把配置改掉', rows };
      assert.equal(
        sink.panelRows(opts),
        sink.snapshot(opts).rowCount,
        `rows=${rows}: the ledger and the panel must agree`
      );
    }
  });
});

test('the panel total is capped, the process zone takes the tail, tiny terminals get nothing', () => {
  withGate('1', () => {
        sink.ingest(projectTurnTimeline(manyTools(40)));
    const big = sink.snapshot({ instruction: 'x', rows: 200 });
    assert.equal(big.rowCount, sink.PANEL_ROW_CAP, 'total capped at PANEL_ROW_CAP');
    assert.ok(big.processRows.length > 0, 'the process zone is not starved on a big terminal');
    assert.ok(
      big.processRows[big.processRows.length - 1].length > 0,
      'the tail is kept (newest steps survive)'
    );
    assert.ok(big.truncatedZones.includes('process'), 'process is the zone that got cut');
  });
});

test('the height ledger can always absorb the panel (the \\x1B[2J regression)', () => {
  withGate('1', () => {
        sink.ingest(projectTurnTimeline(manyTools(40)));
    // liveBudget(rows, shares) = max(LIVE_MIN, rows - chrome - 1)。面板行数一旦超过
    // rows - MIN_OTHER_CHROME - LIVE_MIN - 1，账本被 LIVE_MIN 地板顶住，chrome + liveBudget
    // + 1 > rows 就是字面溢出 → ink fullscreen repaint。这条断言就是那条线的守卫。
    for (const rows of [9, 10, 12, 16, 20, 24, 30, 40, 60, 120, 200]) {
      const opts = { instruction: '把配置改掉', rows };
      const drawn = sink.panelRows(opts);
      const safe = rows - sink.MIN_OTHER_CHROME - 3 - 1; // LIVE_MIN = 3
      assert.ok(
        drawn <= safe,
        `rows=${rows}: panel drew ${drawn} but the ledger can only absorb ${safe}`
      );
    }
  });
});

test('the process zone is budgeted last, after the instruction', () => {
  withGate('1', () => {
        sink.ingest(projectTurnTimeline(manyTools(40)));
    // 10 行终端：预算 2，指令 1 行先用掉，过程区只剩 1 行，汇总区 0 行。
    const view = sink.snapshot({ instruction: 'x', rows: 10 });
    assert.equal(view.instructionRows.length, 1, 'the instruction is served first');
    assert.equal(view.rowCount, 2, 'total = the whole budget');
    assert.equal(view.summaryRows.length, 0, 'the summary is the first thing dropped');
    assert.equal(sink.panelRows({ instruction: 'x', rows: 8 }), 0, 'rows=8 cannot host the panel at all');
  });
});

// ── maxRows：调用方（App.js 账本）给的硬预算 ────────────────────────────────

test('an explicit maxRows is honoured exactly, and 0 means "draw nothing"', () => {
  withGate('1', () => {
        sink.ingest(projectTurnTimeline(manyTools(40)));
    for (const maxRows of [1, 2, 3, 5, 12]) {
      const opts = { instruction: 'x', rows: 200, maxRows };
      assert.ok(sink.panelRows(opts) <= maxRows, `maxRows=${maxRows} is a hard ceiling`);
      assert.equal(sink.panelRows(opts), sink.snapshot(opts).rowCount, 'ledger and panel agree');
    }
    assert.equal(sink.snapshot({ instruction: 'x', rows: 200, maxRows: 0 }), null, 'budget 0 ⇒ nothing');
    assert.equal(sink.panelRows({ instruction: 'x', rows: 200, maxRows: 0 }), 0, 'ledger agrees');
    // 负数 / NaN / 非数字都按「没给」处理，不炸也不画出负行。
    for (const junk of [-5, NaN, 'abc', null]) {
      const opts = { instruction: 'x', rows: 200, maxRows: junk };
      assert.ok(Number.isFinite(sink.panelRows(opts)) && sink.panelRows(opts) >= 0, `junk ${junk} is safe`);
    }
  });
});
// ── cols：可用显示列数（Ink 二次软换行的防线） ────────────────────────────────

test('cols clips every row to the available display width, CJK included', () => {
  withGate('1', () => {
    // 一条 162 字符的工具摘要 + 一条 80 汉字（160 显示列）的指令。
    const wide = [];
    wide.push({ type: 'text', text: 'x' });
    wide.push({
      type: 'tool',
      tool: {
        name: 'Read',
        id: 'tu_wide',
        result: { isError: false, summary: 'A'.repeat(162) },
      },
    });
    sink.ingest(projectTurnTimeline(wide));
    const { displayWidth } = require('../../utils/text/width');
    for (const cols of [20, 40, 93, 120]) {
      const view = sink.snapshot({ instruction: '指'.repeat(80), rows: 40, cols });
      assert.ok(view, `cols=${cols} still yields a view`);
      for (const row of [...view.instructionRows, ...view.processRows, ...view.summaryRows]) {
        assert.ok(
          displayWidth(row) <= cols,
          `cols=${cols}: a row measured ${displayWidth(row)} display columns ⇒ ink would wrap it`
        );
      }
    }
  });
});

test('rowCount does not depend on cols — that is what lets the ledger ignore it', () => {
  withGate('1', () => {
        sink.ingest(projectTurnTimeline(manyTools(40)));
    const bare = sink.panelRows({ instruction: 'x', rows: 40 });
    for (const cols of [10, 40, 93, 400, undefined, null, 0, -1, NaN]) {
      assert.equal(
        sink.panelRows({ instruction: 'x', rows: 40, cols }),
        bare,
        `cols=${cols} must not change the row count`
      );
    }
  });
});

test('a caller that reserves rows-otherChrome-MIN_OTHER_CHROME-LIVE_MIN-1 never loses a frame to the panel', () => {
  withGate('1', () => {
        sink.ingest(projectTurnTimeline(manyTools(40)));
    const outcomes = FRAME_SWEEP.map((c) => frameOutcome(c.rows, c.other));
    const alreadyBroken = outcomes.filter((s) => s === 'already-broken').length;
    const fits = outcomes.length - alreadyBroken;
    assert.ok(fits > 0, `the sweep had to cover something (fits=${fits}, alreadyBroken=${alreadyBroken})`);
  });
});

// ── module hygiene ─────────────────────────────────────────────────────────

test('the sink is the only new tui leaf and it lives next to its own test', () => {
  // Same-name/same-dir colocation is what check-repo-layout's functional-unit rule
  // counts; a source file without its test is a +1 on that debt.
  assert.equal(
    path.basename(__filename),
    `${path.basename(__dirname, '') === 'tui' ? 'toolExecutionSink' : 'x'}.test.js`
  );
});
