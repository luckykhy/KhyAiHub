'use strict';

/**
 * transcriptLines leaf tests (node:test).
 *
 * Rewritten 2026-09-16 against the current `src/cli/tui/transcriptLines.js`.
 * The previous jest-`describe` version stopped parsing after encoding
 * corruption and was replaced by a QUARANTINE stub (see tests/DEBT.md §六).
 * The corruption ate the CJK string literals outright (unlike the sibling
 * files, where only the `)` in `expect(f(x).toBe(y)` was lost), so every
 * expected line below is re-derived from the current source rather than
 * recovered from the original. The *coverage list* is the original's.
 *
 * Covers:
 *   - per-role projection (user / assistant / bash / error / notice / turn-stats / unknown)
 *   - showAll parity with CC `transcript:toggleShowAll` (thinking + tool bodies)
 *   - injected renderMarkdown / summarizeTool are actually used
 *   - blank-line separation between messages, wrapping at cols
 *   - caps (TOTAL_LINE_CAP / TOOL_BODY_LINE_CAP) announce what they dropped
 *   - defensive: garbage in → [] out, never throws
 *
 * Run: `node --test tests/cli/tui/transcriptLines.test.js`
 */

const assert = require('node:assert');
const test = require('node:test');

const {
  buildTranscriptLines,
  buildStreamThinkingExpansion,
  defaultSummarizeTool,
  TOTAL_LINE_CAP,
  TOOL_BODY_LINE_CAP,
  STREAM_THINKING_BODY_CAP,
} = require('../../../src/cli/tui/transcriptLines');
const { buildThinkingHeader } = require('../../../src/cli/thinkingDuration');
const { visWidth } = require('../../../src/cli/tui/wrapCell');

const COLS = 40;
const build = (msgs, opts) => buildTranscriptLines(msgs, { cols: COLS, ...(opts || {}) });

// ── per-role projection ───────────────────────────────────────────────────

test('user message: prompt marker + image count', () => {
  const out = build([{ role: 'user', content: '帮我读配置', imageCount: 2 }]);
  assert.deepStrictEqual(out, ['❯ 帮我读配置', '  ×2']);
});

test('user message without images has no attachment line', () => {
  assert.deepStrictEqual(build([{ role: 'user', content: 'hi' }]), ['❯ hi']);
});

test('assistant timeline: thinking summary, tool head, answer text', () => {
  const out = build([
    {
      role: 'assistant',
      timeline: [
        { type: 'thinking', text: '先定位文件' },
        {
          type: 'tools',
          tools: [
            { name: 'readFile', input: { file_path: '/tmp/a.json' }, result: { success: true } },
          ],
        },
        { type: 'text', text: '配置在 a.json' },
      ],
    },
  ]);
  assert.deepStrictEqual(out, [
    '思考 · 5 字（Ctrl+O 展开）',
    '',
    '  ✓ readFile(/tmp/a.json)',
    '',
    '配置在 a.json',
  ]);
});

test('assistant legacy path (no timeline): content then tools', () => {
  const out = build([
    { role: 'assistant', content: '好的', tools: [{ name: 'bash', input: { command: 'ls' } }] },
  ]);
  assert.deepStrictEqual(out, ['好的', '  ◆ bash(ls)']);
});

test('assistant timeline carrying only tools falls back to content for the answer', () => {
  const out = build([
    {
      role: 'assistant',
      content: '结果如上',
      timeline: [{ type: 'tools', tools: [{ name: 'bash', result: { success: true } }] }],
    },
  ]);
  assert.deepStrictEqual(out, ['结果如上', '  ✓ bash']);
});

test('failed tool shows ✗ and the reason', () => {
  const out = build([
    {
      role: 'assistant',
      timeline: [
        { type: 'tools', tools: [{ name: 'bash', result: { isError: true, error: '权限不足' } }] },
      ],
    },
  ]);
  assert.deepStrictEqual(out, ['  ✗ bash — 权限不足']);
});

test('bash command / output / empty output', () => {
  assert.deepStrictEqual(build([{ role: 'bash-command', content: 'ls -la' }]), ['! ls -la']);
  assert.deepStrictEqual(build([{ role: 'bash-output', content: 'a\nb\n\n' }]), ['⎿ a', '  b']);
  assert.deepStrictEqual(build([{ role: 'bash-output', content: '' }]), ['（无输出）']);
});

test('error and turn-stats', () => {
  assert.deepStrictEqual(build([{ role: 'error', content: 'boom' }]), ['✗ 错误：boom']);
  // turn-stats 原样透传 content(不做任何包装)
  assert.deepStrictEqual(build([{ role: 'turn-stats', content: '✓ 1m 30s' }]), ['✓ 1m 30s']);
  assert.deepStrictEqual(build([{ role: 'turn-stats', content: '' }]), []);
});

test('gateway notice: collapsed counts hidden lines, showAll expands them', () => {
  const msg = {
    role: 'notice',
    content: { gateway: true, content: '网关就绪', detail: '网关就绪\nA\nB' },
  };
  assert.deepStrictEqual(build([msg]), ['· 网关就绪  (+2 行)']);
  assert.deepStrictEqual(build([msg], { showAll: true }), ['· 网关就绪', '  A', '  B']);
});

test('plain notice', () => {
  assert.deepStrictEqual(build([{ role: 'notice', content: '已切换模型' }]), ['· 已切换模型']);
});

test('unknown roles degrade to a text projection and are skipped when empty', () => {
  assert.deepStrictEqual(build([{ role: 'qa', content: { text: '问答' } }]), ['问答']);
  assert.deepStrictEqual(build([{ role: 'expansion', content: '展开的旧段落' }]), ['展开的旧段落']);
  assert.deepStrictEqual(build([{ role: 'brand-new-role-2099' }]), []);
});

// 'decision' 曾经落在上面的 default 分支里(所以本文件早年的版本拿它当「未知角色」
// 的样本)。现在它是**一等角色**:transcriptLines.js 有专门的 `case 'decision'`,走
// permissionNotice.decisionVerdict 这份与 committed 侧共用的判词 —— 改前它对决定
// 记录什么都不画,那条决定在应用内 Viewport 里是隐形的,与 buildDecisionRecord 自己
// 「让决定在浮层消失后仍可见」的意图正好相反。判词口径属 SSOT,不在这里另写一份。
test('decision role renders the shared verdict, not the unknown-role fallback', () => {
  assert.deepStrictEqual(build([{ role: 'decision', decision: 'allow', tool: 'bash' }]), [
    '  ✓ 已批准：bash',
  ]);
  assert.deepStrictEqual(build([{ role: 'decision', decision: 'deny', tool: 'rm' }]), [
    '  ✗ 已拒绝：rm',
  ]);
  // 判词缺失时如实回显「未记录」,绝不假装「已批准」。
  assert.deepStrictEqual(build([{ role: 'decision', content: '已批准' }]), ['  • 决定 未记录']);
});

// ── showAll ───────────────────────────────────────────────────────────────

test('showAll expands thinking in full instead of a char summary', () => {
  const msgs = [{ role: 'assistant', timeline: [{ type: 'thinking', text: '一\n二' }] }];
  assert.deepStrictEqual(build(msgs), ['思考 · 2 字（Ctrl+O 展开）']);
  assert.deepStrictEqual(build(msgs, { showAll: true }), ['思考', '一', '二']);
});

// 折叠行文案的 SSOT 是 cli/thinkingDuration.js —— 内联转录区此前自己拼字符串,
// 既丢真实时长又与浮层侧文案分叉。本用例锁住「两处同一个口径」。
test('folded thinking line carries the real duration and the caller hint', () => {
  const msgs = [
    { role: 'assistant', timeline: [{ type: 'thinking', text: '一\n二', durationMs: 12000 }] },
  ];
  assert.deepStrictEqual(build(msgs), ['思考 12s · 2 字（Ctrl+O 展开）']);
  assert.deepStrictEqual(build(msgs, { thinkingHint: '（点击展开）' }), [
    '思考 12s · 2 字（点击展开）',
  ]);
  assert.deepStrictEqual(build(msgs, { showAll: true })[0], '思考 12s');
});

test('showAll expands the tool result body, indented under its head', () => {
  const msgs = [
    {
      role: 'assistant',
      timeline: [
        {
          type: 'tools',
          tools: [{ name: 'readFile', result: { success: true, output: 'l1\nl2' } }],
        },
      ],
    },
  ];
  assert.deepStrictEqual(build(msgs), ['  ✓ readFile']);
  assert.deepStrictEqual(build(msgs, { showAll: true }), ['  ✓ readFile', '    l1', '    l2']);
});

test('a tool result with no textual payload adds no body lines', () => {
  const msgs = [
    { role: 'assistant', timeline: [{ type: 'tools', tools: [{ name: 'x', result: { success: true } }] }] },
  ];
  assert.deepStrictEqual(build(msgs, { showAll: true }), ['  ✓ x']);
});

// ── 注入 ──────────────────────────────────────────────────────────────────

test('injected renderMarkdown is applied to assistant text with cols', () => {
  const seen = [];
  const out = build([{ role: 'assistant', timeline: [{ type: 'text', text: 'hi' }] }], {
    renderMarkdown: (t, cols) => {
      seen.push([t, cols]);
      return '<' + t + '>';
    },
  });
  assert.deepStrictEqual(out, ['<hi>']);
  assert.deepStrictEqual(seen, [['hi', COLS]]);
});

test('injected summarizeTool overrides the default argument summary', () => {
  const out = build(
    [{ role: 'assistant', timeline: [{ type: 'tools', tools: [{ name: 't', input: { path: '/a' } }] }] }],
    { summarizeTool: () => 'CUSTOM' }
  );
  assert.deepStrictEqual(out, ['  ◆ t(CUSTOM)']);
});

test('defaultSummarizeTool prefers descriptive keys and tolerates junk', () => {
  assert.equal(defaultSummarizeTool({ input: { file_path: '/a/b.js' } }), '/a/b.js');
  assert.equal(defaultSummarizeTool({ input: '{"command":"ls"}' }), 'ls');
  assert.equal(defaultSummarizeTool({ input: 'not json' }), 'not json');
  assert.equal(defaultSummarizeTool({}), '');
  assert.equal(defaultSummarizeTool(null), '');
});

// ── layout ────────────────────────────────────────────────────────────────

test('messages are separated by exactly one blank line', () => {
  const out = build([
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'user', content: 'c' },
  ]);
  assert.deepStrictEqual(out, ['❯ a', '', '❯ b', '', '❯ c']);
});

test('messages that project to nothing do not leave a stray blank line', () => {
  const out = build([
    { role: 'user', content: 'a' },
    { role: 'turn-stats', content: '' },
    { role: 'user', content: 'b' },
  ]);
  assert.deepStrictEqual(out, ['❯ a', '', '❯ b']);
});

test('long lines are hard-wrapped at cols', () => {
  const out = build([{ role: 'error', content: 'x'.repeat(100) }], { cols: 20 });
  assert.ok(out.length > 1, '超宽行必须被折成多行');
  for (const ln of out) {
    // 计费口径是**显示列**而非字符数：'✗ 错误：' 前缀里每个全角字符占 2 列。
    assert.ok(visWidth(ln) <= 20, `折行后每行不得超过 cols 列: ${JSON.stringify(ln)}`);
  }
});

test('an unusable cols falls back to a sane default rather than producing 1-char lines', () => {
  const out = buildTranscriptLines([{ role: 'error', content: 'y'.repeat(100) }], { cols: 0 });
  // 兜底宽度是 80 **列**（ASCII 下等于 80 字符）。
  assert.equal(visWidth(out[0]), 80);
});

// ── caps ──────────────────────────────────────────────────────────────────

test('tool body over the per-tool cap says how many lines it withheld', () => {
  const body = Array.from({ length: TOOL_BODY_LINE_CAP + 5 }, (_, i) => 'L' + i).join('\n');
  const out = build(
    [{ role: 'assistant', timeline: [{ type: 'tools', tools: [{ name: 't', result: { output: body } }] }] }],
    { showAll: true }
  );
  assert.equal(out.length, 1 + TOOL_BODY_LINE_CAP + 1);
  assert.match(out[out.length - 1], /还有 5 行未展开/);
});

test('total lines over the cap keep the tail and announce the dropped head', () => {
  // Each user message costs 2 lines (content + separator) after the first.
  const msgs = Array.from({ length: TOTAL_LINE_CAP }, (_, i) => ({ role: 'user', content: 'm' + i }));
  const out = buildTranscriptLines(msgs, { cols: COLS });
  assert.equal(out.length, TOTAL_LINE_CAP + 1);
  assert.match(out[0], /更早的 \d+ 行未载入/);
  assert.equal(out[out.length - 1], '❯ m' + (TOTAL_LINE_CAP - 1)); // newest content survives
});

// ── defensive ─────────────────────────────────────────────────────────────

test('garbage input yields an empty array instead of throwing', () => {
  assert.deepStrictEqual(buildTranscriptLines(), []);
  assert.deepStrictEqual(buildTranscriptLines(null, null), []);
  assert.deepStrictEqual(buildTranscriptLines('nope'), []);
  assert.deepStrictEqual(buildTranscriptLines([null, undefined, 7, 'x']), []);
  assert.deepStrictEqual(buildTranscriptLines([{}]), []);
});

test('a message whose projection throws is skipped, the rest survive', () => {
  const boom = {
    role: 'assistant',
    timeline: [
      {
        type: 'text',
        get text() {
          throw new Error('boom');
        },
      },
    ],
  };
  assert.deepStrictEqual(
    build([{ role: 'user', content: 'a' }, boom, { role: 'user', content: 'b' }]),
    ['❯ a', '', '❯ b']
  );
});

test('a throwing injected renderer does not take the whole view down', () => {
  const out = build(
    [{ role: 'user', content: 'a' }, { role: 'assistant', timeline: [{ type: 'text', text: 'x' }] }],
    {
      renderMarkdown: () => {
        throw new Error('renderer down');
      },
    }
  );
  assert.deepStrictEqual(out, ['❯ a']);
});

// ── 回归锚点(2026-09-16)──────────────────────────────────────────────────
// 根因 C 的修复把整段转录交给 Viewport 承载(`lines` 模式 + 贴底哨兵)。
// 这条锁住「投影结果是**行数组**、不是消息数组」这个前提 ——
// Viewport 的半页/整页滚动按行算,粒度一旦退回消息级,
// scroll:halfPageUp 的 less 惯例就对不上了。
test('回归锚点: 投影粒度是「行」而非「消息」(Viewport 半页滚动依赖这条)', () => {
  const out = build([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);
  assert.ok(out.includes(''), '消息之间有空行 → 行数 > 消息数');
  assert.equal(out.length, 3, '两条消息 → 3 行(含分隔空行)');
});

// ── 流式思考展开态(buildStreamThinkingExpansion) ────────────────────────────
// 这块上一轮只交付了实现、没交付测试:40 行硬上限、`⋯` 截断标记、两套下标簿记
// (anchorRows / bodyRows)全部无背书。下面十条把它们连同两个已修欠账一起锁住。

test('流式思考展开态: 基本装配(头行 + 正文行, 两套下标)', () => {
  const out = buildStreamThinkingExpansion({ bodyLines: ['a', 'b'] });
  assert.deepStrictEqual(out, {
    rows: ['  思考', '  a', '  b'],
    anchorRows: [0],
    bodyRows: [1, 2],
  });
});

test('流式思考展开态: 头行走 thinkingDuration 的既有 builder(不另造第二份文案)', () => {
  // 头行文案的真源是 cli/thinkingDuration.js;这里对拍而不是写死第二份字面量。
  const expected = '  ' + buildThinkingHeader({ durationMs: undefined });
  assert.equal(buildStreamThinkingExpansion({ bodyLines: [] }).rows[0], expected);
  assert.equal(expected, '  思考', '流式期间 durationMs 恒缺省 ⇒ 裸「思考」, 不编造时长');
});

test('流式思考展开态: 行数封顶是硬的, 超限打截断标记', () => {
  const src = Array.from({ length: STREAM_THINKING_BODY_CAP + 5 }, (_, i) => 'L' + i);
  const out = buildStreamThinkingExpansion({ bodyLines: src });
  assert.equal(out.rows.length, 1 + STREAM_THINKING_BODY_CAP + 1, '头行 + 上限行 + 1 行截断标记');
  assert.equal(out.rows[out.rows.length - 1], '  ⋯');
  assert.deepStrictEqual(
    out.bodyRows,
    // [1..上限] + 截断标记行那一格（见下面那条「除头行外每一行」的回归锚点）。
    Array.from({ length: STREAM_THINKING_BODY_CAP + 1 }, (_, i) => i + 1),
    'bodyRows 是 [1..上限+1], 最后一格是截断标记行'
  );
});

test('流式思考展开态: truncated 为真时即使没到上限也打截断标记', () => {
  const out = buildStreamThinkingExpansion({ bodyLines: ['a', 'b'], truncated: true });
  assert.equal(out.rows.length, 4);
  assert.equal(out.rows[out.rows.length - 1], '  ⋯');
});

test('流式思考展开态: 未截断时既无标记也不多占行', () => {
  const out = buildStreamThinkingExpansion({ bodyLines: ['a', 'b'] });
  assert.equal(out.rows.length, 3);
  assert.ok(!out.rows.includes('  ⋯'));
});

// 回归锚点(欠账 2):`⋯` 截断行的下标曾经没进 bodyRows ⇒ App.js 的
// `_streamThinkingBodyRowsRef` 不给它上 thinking 锚点 ⇒ Viewport 的
// `thinkingLineTextProps` 只判 anchor.kind,于是展开态被截断时紫底块最后一行透明。
// 摘掉 transcriptLines.js 里那一行 `bodyRows.push(rows.length)` 立刻红。
test('回归锚点: 除头行外每一行(含截断标记)都在 bodyRows 里', () => {
  const src = Array.from({ length: STREAM_THINKING_BODY_CAP + 5 }, (_, i) => 'L' + i);
  for (const opts of [
    { bodyLines: src },
    { bodyLines: src, truncated: true },
    { bodyLines: ['a'], truncated: true },
  ]) {
    const out = buildStreamThinkingExpansion(opts);
    assert.deepStrictEqual(
      out.bodyRows,
      out.rows.map((_, i) => i).slice(1),
      `截断标记行必须带底色: ${JSON.stringify(opts)}`
    );
  }
});

test('流式思考展开态: 两套下标不重叠、严格升序、全部落在 rows 内', () => {
  const src = Array.from({ length: STREAM_THINKING_BODY_CAP + 5 }, (_, i) => 'L' + i);
  const out = buildStreamThinkingExpansion({ bodyLines: src });
  assert.deepStrictEqual(out.anchorRows, [0], '头行是唯一锚点');
  assert.ok(!out.bodyRows.includes(0), '头行不得同时是正文行');
  for (let i = 1; i < out.bodyRows.length; i++) {
    assert.ok(out.bodyRows[i] > out.bodyRows[i - 1], 'bodyRows 严格升序且无重复');
  }
  for (const r of [...out.anchorRows, ...out.bodyRows]) {
    assert.ok(r >= 0 && r < out.rows.length, `下标 ${r} 必须落在 rows 内`);
  }
});

test('流式思考展开态: 垃圾输入不抛, 只可能多一行截断标记', () => {
  const cases = [
    undefined,
    {},
    { bodyLines: null, truncated: true },
    { bodyLines: 'not an array' },
    { bodyLines: [undefined, null, 7, true] },
    {
      bodyLines: [
        {
          get boom() {
            throw new Error('boom');
          },
        },
      ],
    },
  ];
  for (const c of cases) {
    const out = buildStreamThinkingExpansion(c);
    assert.ok(Array.isArray(out.rows) && out.rows.length >= 1, '至少保住了头行');
    assert.equal(out.rows[0], '  思考');
  }
});

// 回归锚点(欠账 4):`hidden` 曾是返回值里的死字段 —— JSDoc 承诺它是「给调用方的
// 预算回执」,但全仓没有任何读者(App.js 只取 rows/anchorRows/bodyRows)。
// 已删除:谁要显示「还有 N 行未展开」就必须重新加回字段**并**配 SSOT 文案。
test('回归锚点: 返回值不含 hidden 死字段', () => {
  const out = buildStreamThinkingExpansion({ bodyLines: ['a', 'b'], truncated: true });
  assert.ok(!('hidden' in out), 'hidden 已删除, 不得以任何形态复活');
  assert.deepStrictEqual(Object.keys(out).sort(), ['anchorRows', 'bodyRows', 'rows']);
});
