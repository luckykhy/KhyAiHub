'use strict';

/**
 * Colocated contract test for ToolExecutionPanel.js (the Ink view for the
 * structured tool-execution report).
 *
 * Pinned here:
 *   ① gate OFF ⇒ the component returns `null`. That single fact is what makes the
 *      App.js wiring zero-risk: a null child adds no rows and no bytes.
 *   ② gate ON with a projection ⇒ a Box whose children are exactly the three zones
 *      in order (instruction / process / summary), one Text per row, no extra chrome
 *      rows (chrome rows are unaccounted height, and unaccounted height is what pushes
 *      the live region past terminal rows and makes ink emit the forbidden \x1B[2J).
 *   ③ the child count equals `toolExecutionSink.panelRows()` — the App.js height ledger
 *      reads that number, so a drift between "what the panel draws" and "what the ledger
 *      reserves" is a silent layout regression.
 *   ④ fault isolation: a sink that throws / an ink namespace that is missing both
 *      degrade to null instead of taking the render tree down.
 *   ⑤ no ANSI bytes are constructed here (tui/AGENTS.md §0.2): the panel emits plain
 *      strings only; colour is the theme channel's job.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');

const React = require('react');
const ToolExecutionPanel = require('./ToolExecutionPanel');
const toolExecutionSink = require('../toolExecutionSink');
const { projectTurnTimeline } = require('../../toolExecutionTimeline');
const inkRuntime = require('../inkRuntime');

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
    toolExecutionSink.reset();
    return fn();
  } finally {
    if (had) process.env.KHY_TUI_TOOL_GROUPS = prev;
    else delete process.env.KHY_TUI_TOOL_GROUPS;
    toolExecutionSink.reset();
  }
}

/** Install a stub ink namespace so the component body can call inkRuntime.get(). */
function withInk(fn) {
  const prev = inkRuntime.get;
  const calls = [];
  const stub = {
    Box: 'Box',
    Text: function Text() {},
  };
  inkRuntime.get = () => stub;
  try {
    return fn(stub, calls);
  } finally {
    inkRuntime.get = prev;
  }
}

/** Collect the plain text of every Text child, in render order. */
function childTexts(element) {
  const kids = element.props.children || [];
  return React.Children.toArray(kids).map((kid) => kid.props.children);
}

// ── ① gate OFF ⇒ null ─────────────────────────────────────────────────────

test('gate OFF: the panel renders null (zero rows, zero bytes)', () => {
  withGate(undefined, () => {
    toolExecutionSink.ingest(projectTurnTimeline(liveTimeline()));
    assert.equal(ToolExecutionPanel({ messages: [{ role: 'user', content: 'x' }], rows: 40 }), null);
  });
});

test('gate ON but no projection yet: the panel renders null', () => {
  withGate('1', () => {
    assert.equal(ToolExecutionPanel({ messages: [], rows: 40 }), null);
  });
});

// ── ② three zones, in order, no extra chrome ──────────────────────────────

test('gate ON: one Text row per zone row, in zone order, no chrome rows', () => {
  withGate('1', () => {
    const instruction = '把配置改掉';
    toolExecutionSink.ingest(projectTurnTimeline(liveTimeline()));
    const el = withInk(() =>
      ToolExecutionPanel({ instruction, rows: 40 })
    );
    assert.ok(el, 'gate on + projection ⇒ an element');
    assert.equal(el.type, 'Box');
    assert.equal(el.props.flexDirection, 'column');
    assert.equal(el.props.paddingX, 1);
    assert.equal(el.props.marginTop, undefined, 'no margin row: it would be unaccounted height');
    assert.equal(el.props.marginBottom, undefined, 'no margin row: it would be unaccounted height');

    const view = toolExecutionSink.snapshot({ instruction, rows: 40 });
    const texts = childTexts(el);
    assert.equal(
      texts.length,
      view.instructionRows.length + view.processRows.length + view.summaryRows.length,
      'exactly one Text per drawn row — chrome rows are unaccounted height'
    );
    assert.deepEqual(
      texts,
      [...view.instructionRows, ...view.processRows, ...view.summaryRows],
      'children are the three zones, in order'
    );
    assert.equal(texts[0], '把配置改掉', 'zone 1 is the verbatim instruction');
    assert.ok(texts.some((t) => t.includes('已读取 42 行')), 'zone 2 carries the step rows');
    assert.ok(texts[texts.length - 1].length > 0, 'zone 3 is last');
  });
});

test('the instruction zone is dim, the process zone is not, the summary is dim', () => {
  withGate('1', () => {
    const instruction = '把配置改掉';
    toolExecutionSink.ingest(projectTurnTimeline(liveTimeline()));
    const el = withInk(() => ToolExecutionPanel({ instruction, rows: 40 }));
    const kids = React.Children.toArray(el.props.children);
    const view = toolExecutionSink.snapshot({ instruction, rows: 40 });
    const nInstr = view.instructionRows.length;
    const nProc = view.processRows.length;
    const nSum = view.summaryRows.length;
    for (let i = 0; i < nInstr; i += 1) assert.equal(kids[i].props.dimColor, true);
    for (let i = nInstr; i < nInstr + nProc; i += 1) assert.equal(kids[i].props.dimColor, undefined);
    for (let i = nInstr + nProc; i < kids.length; i += 1) assert.equal(kids[i].props.dimColor, true);
    assert.ok(nSum > 0, 'the fixture has a summary zone');
  });
});

// ── ③ child count == the ledger number ────────────────────────────────────

test('the drawn row count equals panelRows() at every terminal height', () => {
  withGate('1', () => {
    const instruction = '把配置改掉';
    toolExecutionSink.ingest(projectTurnTimeline(liveTimeline()));
    for (const rows of [24, 30, 40, 60, 200]) {
      const el = withInk(() => ToolExecutionPanel({ instruction, rows }));
      const drawn = React.Children.toArray(el.props.children).length;
      assert.equal(
        drawn,
        toolExecutionSink.panelRows({ instruction, rows }),
        `rows=${rows}: App.js reserves panelRows() but the panel draws ${drawn}`
      );
    }
  });
});

test('a capped process zone is drawn capped (tail kept)', () => {
  withGate('1', () => {
    const many = [];
    for (let i = 0; i < 40; i += 1) {
      many.push({ type: 'tool', tool: { name: 'Read', id: `t${i}`, result: { text: 'x', isError: false } } });
    }
    toolExecutionSink.ingest(projectTurnTimeline(many));
    const el = withInk(() => ToolExecutionPanel({ instruction: '', rows: 200 }));
    const view = toolExecutionSink.snapshot({ instruction: '', rows: 200 });
    // 断总量而不是断过程区：PANEL_ROW_CAP 现在是「面板总行数天花板」（三区一起算），
    // 指令区非空时过程区必然小于它。这里指令为空，两者才恰好相等。
    assert.equal(view.rowCount, toolExecutionSink.PANEL_ROW_CAP);
    assert.equal(view.processRows.length, view.rowCount, 'empty instruction ⇒ the budget is all process');
    assert.equal(React.Children.toArray(el.props.children).length, view.rowCount);
  });
});

// ── ④ fault isolation ─────────────────────────────────────────────────────

test('a sink that throws degrades to null, never to a crash', () => {
  withGate('1', () => {
    toolExecutionSink.ingest(projectTurnTimeline(liveTimeline()));
    const prev = toolExecutionSink.snapshot;
    toolExecutionSink.snapshot = () => {
      throw new Error('boom');
    };
    try {
      assert.equal(ToolExecutionPanel({ instruction: 'x', rows: 40 }), null);
    } finally {
      toolExecutionSink.snapshot = prev;
    }
  });
});

test('an ink namespace that is not ready yet degrades to null', () => {
  withGate('1', () => {
    toolExecutionSink.ingest(projectTurnTimeline(liveTimeline()));
    const prev = inkRuntime.get;
    inkRuntime.get = () => ({ Box: null, Text: null });
    try {
      assert.equal(ToolExecutionPanel({ instruction: 'x', rows: 40 }), null);
    } finally {
      inkRuntime.get = prev;
    }
    inkRuntime.get = () => {
      throw new Error('ink not loaded');
    };
    try {
      assert.equal(ToolExecutionPanel({ instruction: 'x', rows: 40 }), null);
    } finally {
      inkRuntime.get = prev;
    }
  });
});

// ── ⑤ no ANSI construction ────────────────────────────────────────────────

test('the panel source constructs no escape bytes of its own', () => {
  const raw = require('fs').readFileSync(path.join(__dirname, 'ToolExecutionPanel.js'), 'utf8');
  // Comments legitimately NAME the forbidden sequences (that is how the prohibition is
  // documented), so strip them before scanning for *construction*.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(src.indexOf('\x1B'), -1, 'no literal ESC in code');
  assert.equal(src.indexOf('\\x1B'), -1, 'no escaped ESC in code');
  assert.equal(src.indexOf('\\u001b'), -1, 'no unicode-escaped ESC in code');
  // DECSTBM (scroll region) and ED2 (full-screen clear) must never be assembled here.
  assert.equal(/\[2J/.test(src), false);
  assert.equal(/\[\d+;\d+r/.test(src), false);
  // The docstring DOES name them (the prohibition has to be written down somewhere).
  assert.equal(raw.indexOf('[2J') !== -1, true, 'sanity: the raw file documents the ban');
});

test('every rendered row is a plain string', () => {
  withGate('1', () => {
    toolExecutionSink.ingest(projectTurnTimeline(liveTimeline()));
    const el = withInk(() => ToolExecutionPanel({ instruction: '把配置改掉', rows: 40 }));
    for (const t of childTexts(el)) {
      assert.equal(typeof t, 'string');
      assert.equal(t.indexOf('\x1B'), -1);
    }
  });
});

// ── module hygiene ─────────────────────────────────────────────────────────

test('the panel lives next to its own colocated test', () => {
  assert.equal(path.basename(__filename), 'ToolExecutionPanel.test.js');
  assert.equal(typeof ToolExecutionPanel, 'function');
});
