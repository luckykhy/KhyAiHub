'use strict';

/**
 * Colocated contract test for toolExecutionGroups.js (structured tool-execution output).
 *
 * The exhaustiveness gates live here, next to the closed sets they pin:
 *   ① RENDERERS keys ↔ ROW_KIND members (both directions) — the JS equivalent of
 *      `satisfies Record<RowKind, true>`; add a RowKind without a renderer → red.
 *   ② every TOOL_FAMILY_BY_NAME value is inside the closed ToolFamily set, and every key is
 *      reachable after normalization (a key that normalizes onto another key is dead weight).
 *   ③ every real tool name classifies to a family; anything landing on 'other' must be in
 *      UNCLASSIFIED_ALLOWLIST with a reason — and every allowlist entry must actually be
 *      exercised, so the list cannot rot into a blanket excuse (ZCode TaskStop 未登记的教训).
 *   ④ normalizeStatus maps khy-os' existing three states and ZCode's six states both ways,
 *      with no dead status in the closed set.
 *
 * Verified by hand that gate ① is real: appending a member to ROW_KIND without touching
 * RENDERERS makes `renderers cover exactly the row kinds` fail. That edit was reverted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOOL_FAMILY,
  TOOL_FAMILY_BY_NAME,
  TOOL_RUN_STATUS,
  STATUS_ALIASES,
  ROW_KIND,
  RENDERERS,
  NARRATION_PHASE,
  NEXT_ACTION_KIND,
  GROUP_KIND,
  classifyToolFamily,
  normalizeStatus,
  decodeToolStep,
  buildToolGroup,
  projectToolExecution,
} = require('./toolExecutionGroups');

// ── ① RowKind ↔ RENDERERS 穷尽性闸 ────────────────────────────────────────

test('renderers cover exactly the row kinds (both directions)', () => {
  assert.deepEqual(Object.keys(RENDERERS).sort(), [...ROW_KIND].sort());
  for (const kind of ROW_KIND) {
    assert.equal(typeof RENDERERS[kind], 'string', `${kind} has no renderer id`);
    assert.ok(RENDERERS[kind].length > 0, `${kind} maps to an empty renderer id`);
  }
});

// ── ② family 封闭表自洽 ───────────────────────────────────────────────────

test('every family value in the name table is inside the closed ToolFamily set', () => {
  const closed = new Set(TOOL_FAMILY);
  for (const [name, family] of Object.entries(TOOL_FAMILY_BY_NAME)) {
    assert.ok(closed.has(family), `${name} → ${family} is not a closed ToolFamily`);
  }
});

test('every family-table key is reachable after normalization (no shadowed keys)', () => {
  const seen = new Map();
  for (const key of Object.keys(TOOL_FAMILY_BY_NAME)) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    assert.equal(norm, key, `table key ${key} is not already normalized — it can never be hit`);
    assert.ok(!seen.has(norm), `${key} collides with ${seen.get(norm)} after normalization`);
    seen.set(norm, key);
  }
});

test('every closed family except the two reserved ones is reachable from a real tool name', () => {
  const reachable = new Set(Object.values(TOOL_FAMILY_BY_NAME));
  for (const family of TOOL_FAMILY) {
    // 'mcp' 保留族：来源由调用方显式声明；'other' 按定义就是兜底，二者都不该有名录条目。
    if (family === 'mcp' || family === 'other') continue;
    assert.ok(reachable.has(family), `family ${family} has no registered tool name`);
  }
});

// ── ③ 真实工具名 fixture + 未登记白名单 ───────────────────────────────────

// 43 个真实注册名：Claude Code 官方名（大小写混合）+ khy-os 内部名（下划线/连字符变体）。
const REAL_TOOL_NAMES = Object.freeze([
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'LS', 'ExitPlanMode',
  'read_file', 'readfile', 'notebookread', 'write_file', 'writefile', 'createfile',
  'edit_file', 'editfile', 'multiedit', 'applypatch', 'patch',
  'shell', 'shellcommand', 'command', 'executecode', 'build', 'buildproject',
  'projectblueprint', 'search', 'searchcontent', 'find', 'findfiles',
  'websearch', 'webfetch', 'agent', 'subagent', 'todoread', 'taskcreate',
  'askuserquestion',
  // 以下三条是**已知漏不了**的：动态注册名与空名，必须落在 'other' 并在此登记理由。
  'mcp__amoo__screenshot', 'Skill', '',
]);

// 凡 classify 出 'other' 的必须在此出现并带理由串；反向也查——白名单里没被 fixture 命中过的
// 条目即过期条目（防止它退化成一句「反正都算 other」的免罪牌）。键是**归一化后**的名字，
// 与 TOOL_FAMILY_BY_NAME 同一把尺（`mcp__amoo__screenshot` → `mcpamooscreenshot`）。
const UNCLASSIFIED_ALLOWLIST = Object.freeze({
  exitplanmode:
    'Claude Code 官方工具：既不改盘也不出网，没有可归的既有 family；归 other 后由渲染层走 raw fallback，而不是猜一个族',
  mcpamooscreenshot:
    'MCP 桥工具名运行期动态注册，封闭表不可能穷举；family "mcp" 保留给显式声明来源的调用方（ZCode 漏登记静默掉进 raw fallback 的两起线上事故）',
  skill: '技能调用，语义随技能而变，无法静态归族',
  '': '空工具名：没有可分类的身份',
});

test('every real tool name classifies, and every "other" carries a registered reason', () => {
  const hit = new Set();
  for (const name of REAL_TOOL_NAMES) {
    const family = classifyToolFamily(name);
    assert.ok(TOOL_FAMILY.includes(family), `${name} → ${family} is outside the closed set`);
    if (family !== 'other') continue;
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    assert.ok(
      Object.prototype.hasOwnProperty.call(UNCLASSIFIED_ALLOWLIST, key),
      `${name} fell through to 'other' with no registered reason — add it to UNCLASSIFIED_ALLOWLIST or to TOOL_FAMILY_BY_NAME`
    );
    assert.ok(
      typeof UNCLASSIFIED_ALLOWLIST[key] === 'string' && UNCLASSIFIED_ALLOWLIST[key].length > 10,
      `${name} needs a substantive reason, not a stub`
    );
    hit.add(key);
  }
  // 反向：白名单不许养过期条目。
  assert.deepEqual([...hit].sort(), Object.keys(UNCLASSIFIED_ALLOWLIST).sort());
});

test('normalization is case- and separator-insensitive, and garbage folds to "other"', () => {
  for (const name of ['Read', 'READ', 'read', 'read_file', 'read-file', ' read ']) {
    assert.equal(classifyToolFamily(name), 'read', `${name} should normalize onto "read"`);
  }
  for (const bad of [null, undefined, 42, {}, [], '   ', '___']) {
    assert.equal(classifyToolFamily(bad), 'other');
  }
});

test('classifyToolFamily never guesses by substring', () => {
  // `grep_results` 含 "grep" 但它不是 grep；猜族比不猜更糟。
  assert.equal(classifyToolFamily('grep_results'), 'other');
  assert.equal(classifyToolFamily('my_read_helper'), 'other');
});

// ── ④ normalizeStatus 双向映射 ───────────────────────────────────────────

const STATUS_GRID = Object.freeze([
  // khy-os 现有三态
  ['running', 'running'],
  ['succeeded', 'success'],
  ['failed', 'error'],
  // ZCode 六态
  ['inputStreaming', 'inputStreaming'],
  ['pendingApproval', 'pendingApproval'],
  ['cancelled', 'cancelled'],
  ['success', 'success'],
  ['error', 'error'],
  // 大小写 / 分隔符 / 同义变体
  ['SUCCEEDED', 'success'],
  ['pending_approval', 'pendingApproval'],
  ['input-streaming', 'inputStreaming'],
  ['Canceled', 'cancelled'],
  ['aborted', 'cancelled'],
  ['ok', 'success'],
  ['inprogress', 'running'],
  // runGraph 以 status:'paused' 收尾 ⇒ 仍是 running ⇒ 进 totals.unfinished
  ['paused', 'running'],
  // 未登记 ⇒ running（可见的未完成态），不是抛、也不是假报警的 error
  ['banana', 'running'],
  ['', 'running'],
  [null, 'running'],
  [undefined, 'running'],
]);

test('normalizeStatus maps khy-os three states and ZCode six states cell by cell', () => {
  for (const [raw, expected] of STATUS_GRID) {
    assert.equal(normalizeStatus(raw), expected, `normalizeStatus(${JSON.stringify(raw)})`);
  }
});

test('no status in the closed set is dead (every one has at least one alias)', () => {
  const covered = new Set(Object.values(STATUS_ALIASES));
  for (const status of TOOL_RUN_STATUS) {
    assert.ok(covered.has(status), `${status} has no alias mapping onto it`);
  }
});

// ── decodeToolStep：宽松逐字段 ────────────────────────────────────────────

function fullRawStep(overrides = {}) {
  return {
    id: 'tu-1',
    name: 'Read',
    status: 'succeeded',
    summary: '读取 src/cli/router.js · 340 行',
    channels: { output: { lines: 340 }, content: '340 行', metadata: { exit: 0 } },
    progress: { bytes: 340, total: 680, message: '读取中', updatedAt: 1750000000000 },
    artifact: {
      kind: 'file-diff',
      filePath: 'src/.dockerignore',
      beforeContent: 'node_modules\n',
      afterContent: 'node_modules\n.cache\n',
    },
    error: null,
    startedAt: 1000,
    endedAt: 1500,
    durationMs: 500,
    childStepIds: ['tu-1a', 'tu-1b'],
    ...overrides,
  };
}

test('a well-formed raw step decodes field by field', () => {
  assert.deepEqual(decodeToolStep(fullRawStep()), {
    id: 'tu-1',
    name: 'Read',
    family: 'read',
    status: 'success',
    summary: '读取 src/cli/router.js · 340 行',
    channels: { output: { lines: 340 }, content: '340 行', metadata: { exit: 0 } },
    progress: { bytes: 340, total: 680, fraction: 0.5, message: '读取中', updatedAt: 1750000000000 },
    artifact: {
      kind: 'file-diff',
      filePath: 'src/.dockerignore',
      beforeContent: 'node_modules\n',
      afterContent: 'node_modules\n.cache\n',
    },
    startedAt: 1000,
    endedAt: 1500,
    durationMs: 500,
    childStepIds: ['tu-1a', 'tu-1b'],
  });
});

test('one bad field drops only itself — the neighbours survive', () => {
  const step = decodeToolStep(
    fullRawStep({
      progress: 'not-an-object',
      artifact: { kind: 'file-diff' },
      error: 42,
      childStepIds: 'not-an-array',
      startedAt: 'abc',
      durationMs: {},
      channels: 'nope',
    })
  );
  assert.equal(step.id, 'tu-1', 'identity survives');
  assert.equal(step.family, 'read', 'family survives');
  assert.equal(step.status, 'success', 'status survives');
  assert.equal(step.summary, '读取 src/cli/router.js · 340 行', 'summary survives');
  assert.deepEqual(step.channels, {}, 'a garbage channels bag degrades to empty, not to a crash');
  assert.equal(step.progress, undefined, 'garbage progress is dropped whole');
  assert.equal(step.artifact, undefined, 'an artifact missing its contents is dropped');
  assert.equal(step.error, undefined, 'a non-object non-string error is dropped');
  assert.equal(step.childStepIds, undefined, 'a non-array childStepIds is dropped');
  assert.equal(step.startedAt, undefined, 'a non-numeric timestamp is dropped');
  assert.equal(step.durationMs, undefined, 'a non-numeric duration is dropped');
  assert.equal(step.endedAt, 1500, 'the healthy neighbour of the broken field is untouched');
});

test('progress omits fraction when total is absent — never guesses 0..1', () => {
  const step = decodeToolStep(fullRawStep({ progress: { bytes: 12, updatedAt: 1 } }));
  assert.deepEqual(step.progress, { updatedAt: 1, bytes: 12 });
});

test('identity-field failure degrades the whole step instead of dropping the group', () => {
  for (const raw of [null, undefined, 42, {}, [], { name: '   ' }]) {
    const step = decodeToolStep(raw, 7);
    assert.equal(step.family, 'other', JSON.stringify(raw));
    assert.equal(step.status, 'error', JSON.stringify(raw));
    assert.equal(step.id, 'step-7', 'a synthesized id keeps the row addressable');
    assert.ok(step.summary.length > 0, 'the fallback always has something to render');
  }
  // 有 id 就保留原 id——地址不该被合成值替换掉。
  assert.equal(decodeToolStep({ id: 'x' }, 7).id, 'x');
  // 缺 status **不是**身份字段失败：按载荷推断（无结果无错误 ⇒ running），摘要为空。
  assert.deepEqual(decodeToolStep({ name: 'Bash' }, 7), {
    id: 'step-7',
    name: 'Bash',
    family: 'shell',
    status: 'running',
    summary: '',
    channels: {},
  });
  // 而一个谁也不认识的状态原值才是。降级形状按规格固定：family 'other' + status 'error'
  // + summary=原名（原有 summary 被丢掉——这条已经不被信任了）。
  assert.deepEqual(decodeToolStep({ id: 'y', name: 'Bash', status: 'weird', summary: 's' }), {
    id: 'y',
    name: 'Bash',
    family: 'other',
    status: 'error',
    summary: 'Bash',
    channels: {},
  });
});

test('an unrecognized status string is an identity failure, not a silent "running"', () => {
  const step = decodeToolStep({ id: 'a', name: 'Bash', status: 'weird' });
  assert.equal(step.status, 'error');
  assert.equal(step.summary, 'Bash');
  // …while the lenient public mapper folds the same string to running.
  assert.equal(normalizeStatus('weird'), 'running');
});

test('status is inferred from the payload only when no status field is present', () => {
  assert.equal(decodeToolStep({ id: 'a', name: 'Bash', error: { message: 'boom' } }).status, 'error');
  assert.equal(decodeToolStep({ id: 'a', name: 'Bash', result: { ok: true } }).status, 'success');
  assert.equal(decodeToolStep({ id: 'a', name: 'Bash', output: 'x' }).status, 'success');
  assert.equal(decodeToolStep({ id: 'a', name: 'Bash' }).status, 'running');
  // 显式状态永远赢过推断。
  assert.equal(decodeToolStep({ id: 'a', name: 'Bash', result: {}, status: 'running' }).status, 'running');
});

test('truncation is display-only: summary is clipped, the full text stays in the model', () => {
  const long = 'x'.repeat(250);
  const step = decodeToolStep({ id: 'a', name: 'Read', summary: long });
  assert.equal(step.summary.length, 200, 'the display summary respects SUMMARY_CAP');
  assert.equal(step.summaryFull, long, 'not one byte is lost from the model');
  assert.equal(step.truncated.totalBytes, 250);
  assert.equal(step.truncated.ref, 'summaryFull');

  const short = decodeToolStep({ id: 'a', name: 'Read', summary: 'y'.repeat(200) });
  assert.equal(short.summaryFull, undefined, 'nothing to preserve → no summaryFull key');
  assert.equal(short.truncated, undefined);
});

test('the artifact is accepted from _khyWriteDiff too, and keeps the exact writeDiffRows shape', () => {
  const step = decodeToolStep({
    id: 'a',
    name: 'Write',
    _khyWriteDiff: { filePath: 'a.js', beforeContent: '1', afterContent: '2' },
  });
  assert.deepEqual(step.artifact, {
    kind: 'file-diff',
    filePath: 'a.js',
    beforeContent: '1',
    afterContent: '2',
  });
});

test('an explicit in-set family overrides the name lookup', () => {
  assert.equal(decodeToolStep({ id: 'a', name: 'whatever', family: 'mcp' }).family, 'mcp');
  // 不在封闭集里的显式 family 被忽略，退回按名查表。
  assert.equal(decodeToolStep({ id: 'a', name: 'Read', family: 'bogus' }).family, 'read');
});

test('decodeToolStep is idempotent — feeding a decoded step back changes nothing', () => {
  const once = decodeToolStep(fullRawStep(), 3);
  assert.deepEqual(decodeToolStep(once, 3), once);
  assert.deepEqual(decodeToolStep(decodeToolStep(once, 3), 3), once);
});

// ── buildToolGroup ───────────────────────────────────────────────────────

function step(id, family, status, extra = {}) {
  return { id, name: id, family, status, ...extra };
}

test('group counts roll up by family and by outcome', () => {
  const group = buildToolGroup({
    id: 'g1',
    kind: 'workflow',
    title: '✓ 读取 + 编辑 server.js · 2 步',
    startedAt: 100,
    endedAt: 900,
    thoughtMs: 11000,
    steps: [
      step('a', 'read', 'success', { durationMs: 10 }),
      step('b', 'read', 'error', { durationMs: 30 }),
      step('c', 'shell', 'running'),
      step('d', 'shell', 'cancelled'),
    ],
  });
  assert.equal(group.count, 4);
  assert.equal(group.status, 'running', 'any unfinished step makes the whole group running');
  assert.equal(group.counts.byFamily.read, 2);
  assert.equal(group.counts.byFamily.shell, 2);
  assert.equal(group.counts.byFamily.edit, 0, 'absent families are 0, not undefined');
  assert.equal(group.counts.succeeded, 1);
  assert.equal(group.counts.failed, 1);
  assert.equal(group.counts.unfinished, 1);
  assert.equal(group.counts.thoughtMs, 11000, '"Thought for 11s" comes from here');
  assert.deepEqual(group.stepIds, ['a', 'b', 'c', 'd']);
  assert.equal(group.startedAt, 100);
  assert.equal(group.endedAt, 900);
});

test('group status aggregation: unfinished > error > cancelled > success', () => {
  const base = [step('a', 'read', 'success')];
  assert.equal(buildToolGroup({ steps: base }).status, 'success');
  assert.equal(buildToolGroup({ steps: [step('a', 'read', 'cancelled')] }).status, 'cancelled');
  assert.equal(buildToolGroup({ steps: [...base, step('b', 'read', 'error')] }).status, 'error');
  assert.equal(buildToolGroup({ steps: [...base, step('b', 'read', 'pendingApproval')] }).status, 'running');
  assert.equal(
    buildToolGroup({ steps: [step('a', 'read', 'error'), step('b', 'read', 'cancelled')] }).status,
    'error',
    'error outranks cancelled'
  );
  assert.equal(buildToolGroup({ steps: [] }).status, 'success', 'an empty group is vacuously fine');
});

test('thoughtMs of 0 or garbage is omitted rather than displayed as "Thought for 0s"', () => {
  assert.equal(buildToolGroup({ steps: [], thoughtMs: 0 }).counts.thoughtMs, undefined);
  assert.equal(buildToolGroup({ steps: [], thoughtMs: 'soon' }).counts.thoughtMs, undefined);
});

test('timestamps fall back to the min/max of the member steps', () => {
  const group = buildToolGroup({
    steps: [step('a', 'read', 'success', { startedAt: 500, endedAt: 800 }), step('b', 'read', 'success', { startedAt: 200, endedAt: 900 })],
  });
  assert.equal(group.startedAt, 200);
  assert.equal(group.endedAt, 900);
  const bare = buildToolGroup({ steps: [step('a', 'read', 'success')] });
  assert.equal(bare.startedAt, 0, 'no timestamps anywhere → 0, not NaN/Infinity');
  assert.equal(bare.endedAt, undefined);
});

test('copyText is pre-rendered plain text and prefers the full summary', () => {
  const long = 'z'.repeat(260);
  const group = buildToolGroup({
    title: '✓ 读取 src/a.js · 1 步',
    steps: [{ id: 'a', name: 'Read', family: 'read', status: 'success', summary: long.slice(0, 200), summaryFull: long }],
  });
  assert.equal(group.copyText, `✓ 读取 src/a.js · 1 步\n  [success] Read - ${long}`);
  assert.equal(
    buildToolGroup({ title: '', steps: [step('a', 'read', 'success')] }).copyText,
    '  [success] a'
  );
  // 调用方可以整体覆盖（例如想给 JSON 而不是纯文本）。
  assert.equal(buildToolGroup({ steps: [], copyText: '{"x":1}' }).copyText, '{"x":1}');
});

test('nextAction is validated against the closed kind set and dropped otherwise', () => {
  const good = { kind: 'heal', text: '重试第 3 步', target: 'step-3', payload: { attempt: 2 } };
  assert.deepEqual(buildToolGroup({ steps: [], nextAction: good }).nextAction, good);
  for (const bad of [{ kind: 'nope', text: 'x' }, { kind: 'heal' }, 'heal', 42]) {
    assert.equal(buildToolGroup({ steps: [], nextAction: bad }).nextAction, undefined);
  }
  for (const kind of NEXT_ACTION_KIND) {
    assert.ok(buildToolGroup({ steps: [], nextAction: { kind, text: 't' } }).nextAction);
  }
});

test('unknown group kind falls back to "turn" and childGroupIds are stringified', () => {
  const group = buildToolGroup({ steps: [], kind: 'banana', childGroupIds: ['g0', 5, null, 'g2'] });
  assert.equal(group.kind, 'turn');
  assert.deepEqual(group.childGroupIds, ['g0', '5', 'g2']);
  for (const kind of GROUP_KIND) {
    assert.equal(buildToolGroup({ steps: [], kind }).kind, kind);
  }
});

// ── projectToolExecution ─────────────────────────────────────────────────

test('adjacent same-family steps merge, non-adjacent ones do not (Pass 2 only)', () => {
  const steps = [
    step('a', 'read', 'success'),
    step('b', 'read', 'error'),
    step('c', 'edit', 'success'),
    step('d', 'read', 'success'),
  ];
  const titles = [];
  const out = projectToolExecution({
    steps,
    describeGroup: (members) => {
      titles.push(members.map((m) => m.id).join('+'));
      return `titles#${titles.length}`;
    },
  });
  assert.deepEqual(out.groups.map((g) => g.count), [2, 1, 1]);
  assert.deepEqual(out.groups.map((g) => g.title), ['titles#1', 'titles#2', 'titles#3']);
  assert.deepEqual(out.groups.map((g) => g.stepIds), [['a', 'b'], ['c'], ['d']]);
  assert.deepEqual(out.totals.byFamily, {
    read: 3, write: 0, edit: 1, shell: 0, search: 0, web: 0, agent: 0, todo: 0, ask: 0, mcp: 0, other: 0,
  });
});

test('no describeGroup injected → title stays empty for the caller to fill in', () => {
  const out = projectToolExecution({ steps: [step('a', 'read', 'success')] });
  assert.equal(out.groups[0].title, '', 'the leaf never recomputes the verb sentence');
});

test('rows keep their order and inherit a group from the nearest preceding step', () => {
  const steps = [step('a', 'read', 'success'), step('b', 'shell', 'success')];
  const rows = [
    { kind: 'narration', text: '先看一下', phase: 'commentary' },
    { kind: 'step', stepId: 'a' },
    { kind: 'narration', text: '再跑一下', phase: 'final_answer' },
    { kind: 'step', stepId: 'b' },
    { kind: 'divider' },
  ];
  const out = projectToolExecution({ steps, rows, defaultGroupId: 'group-x' });
  assert.deepEqual(out.rows.map((r) => r.order), [0, 1, 2, 3, 4]);
  assert.deepEqual(out.rows.map((r) => r.kind), ['narration', 'step', 'narration', 'step', 'divider']);
  assert.deepEqual(out.rows.map((r) => r.groupId), ['group-x', 'group-0', 'group-0', 'group-1', 'group-1']);
  assert.equal(out.rows[2].phase, 'final_answer');
  assert.equal(out.rows[2].text, '再跑一下', 'the narration text is carried verbatim');
  assert.equal(out.rows[0].id, 'row-0', 'ids are synthesized when absent');
});

test('a caller-supplied group list bypasses adjacent grouping but is still normalized', () => {
  const out = projectToolExecution({
    groups: [{ id: 'g9', kind: 'process', title: 'T', steps: [step('a', 'read', 'success')] }],
    steps: [step('zz', 'shell', 'running')],
  });
  assert.equal(out.groups.length, 1, 'groups win — steps are not re-grouped');
  assert.equal(out.groups[0].id, 'g9');
  assert.equal(out.groups[0].kind, 'process');
  assert.equal(out.totals.unfinished, 1, 'totals still see every step from either source');
  assert.equal(out.totals.byFamily.shell, 1);
});

test('totals report durationP50 as a median and omit it when nothing was timed', () => {
  const out = projectToolExecution({
    steps: [
      step('a', 'read', 'success', { durationMs: 10 }),
      step('b', 'read', 'success', { durationMs: 20 }),
      step('c', 'read', 'success', { durationMs: 90 }),
    ],
  });
  assert.equal(out.totals.durationP50, 20);
  assert.equal(out.totals.succeeded, 3);
  const untimed = projectToolExecution({ steps: [step('a', 'read', 'success')] });
  assert.equal(untimed.totals.durationP50, undefined, 'never fabricate a duration');
});

test('a paused workflow run stays visible as unfinished instead of looking stuck', () => {
  const out = projectToolExecution({
    steps: [
      { id: 'n1', name: 'build', status: 'succeeded', durationMs: 12 },
      { id: 'n2', name: 'verify', status: 'paused' },
    ],
  });
  assert.equal(out.groups.length, 2, 'paused is not merged away');
  assert.equal(out.groups[1].status, 'running');
  assert.equal(out.totals.unfinished, 1);
  assert.equal(out.totals.succeeded, 1);
});

test('empty input yields the empty projection, not a crash', () => {
  assert.deepEqual(projectToolExecution(), { groups: [], rows: [], totals: emptyTotals() });
  assert.deepEqual(projectToolExecution({}), { groups: [], rows: [], totals: emptyTotals() });
  assert.deepEqual(projectToolExecution({ steps: [], rows: [], groups: [] }), {
    groups: [],
    rows: [],
    totals: emptyTotals(),
  });
});

function emptyTotals() {
  const byFamily = {};
  for (const f of TOOL_FAMILY) byFamily[f] = 0;
  return { byFamily, succeeded: 0, failed: 0, unfinished: 0 };
}

// ── 绝不抛：垃圾输入扫描 ──────────────────────────────────────────────────

test('no exported function throws on garbage input', () => {
  const garbage = [
    null, undefined, 0, 1, -1, NaN, Infinity, '', 'x', '{}', '[]', true, false,
    [], [null], [undefined], [1, 2], {}, { a: 1 }, () => {}, Symbol('s'),
    { id: {}, name: [], status: {}, family: 5, summary: {}, channels: 7, progress: 1, artifact: 2, error: 3 },
    { id: 'a', name: 'b', status: 'c', summary: 'd', channels: { output: undefined } },
    { steps: 'nope', rows: 5, groups: {} },
    { rows: [{}, null, 'x', { kind: 'bogus', stepId: 1 }] },
  ];
  for (const g of garbage) {
    assert.doesNotThrow(() => classifyToolFamily(g), `classifyToolFamily(${String(g)})`);
    assert.doesNotThrow(() => normalizeStatus(g), `normalizeStatus(${String(g)})`);
    assert.doesNotThrow(() => decodeToolStep(g), `decodeToolStep(${String(g)})`);
    assert.doesNotThrow(() => decodeToolStep(g, 1), `decodeToolStep(${String(g)}, 1)`);
    assert.doesNotThrow(() => buildToolGroup(g), `buildToolGroup(${String(g)})`);
    assert.doesNotThrow(() => projectToolExecution(g), `projectToolExecution(${String(g)})`);
  }
  // 而且每次都返回可渲染的最短合法结构，而不是 undefined。
  assert.ok(decodeToolStep(null).summary.length > 0);
  assert.ok(Array.isArray(projectToolExecution(null).rows));
  assert.ok(Array.isArray(projectToolExecution(null).groups));
});

test('every closed set is frozen and duplicate-free', () => {
  for (const [label, set] of [
    ['TOOL_FAMILY', TOOL_FAMILY],
    ['TOOL_RUN_STATUS', TOOL_RUN_STATUS],
    ['ROW_KIND', ROW_KIND],
    ['NARRATION_PHASE', NARRATION_PHASE],
    ['NEXT_ACTION_KIND', NEXT_ACTION_KIND],
    ['GROUP_KIND', GROUP_KIND],
  ]) {
    assert.ok(Object.isFrozen(set), `${label} must be frozen`);
    assert.equal(new Set(set).size, set.length, `${label} has duplicates`);
  }
  assert.ok(Object.isFrozen(TOOL_FAMILY_BY_NAME));
  assert.ok(Object.isFrozen(RENDERERS));
});

// ── 零 IO：纯叶子契约的自查镜像 ──────────────────────────────────────────

test('the module has zero static requires (D2 pure leaf)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'toolExecutionGroups.js'), 'utf8');
  const requires = src.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || [];
  assert.deepEqual(requires, [], 'a D2 leaf must not require anything, not even another leaf');
  assert.ok(!/\bconsole\./.test(src), 'no console output from a data-model leaf');
});
