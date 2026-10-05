'use strict';

/**
 * runtimeResourceProbe.test.js — 驻留资源普查的判定契约（node:test，纯叶子）。
 *
 * 普查装进 `khy doctor` 与启动 notice 之后，最怕的是「永远绿」的表针：判定写反或
 * 预算抄错，工具就只是装饰。这里用合成快照双向卡住每个判据（低于预算 → 不报，
 * 高于预算 → 报），并用真实进程读数保证采集侧不是恒零桩。
 */

const assert = require('node:assert');
const test = require('node:test');

const probe = require('../src/services/runtimeResourceProbe');

function snapAt(over = {}) {
  const base = {
    pid: 4242,
    uptimeSeconds: 3.2,
    // Judge the synthetic snapshots on the tight cli tier unless a case says
    // otherwise; the tui tier has its own dedicated regression below.
    phase: 'cli',
    memory: { rssMB: 120, heapUsedMB: 40, heapTotalMB: 60, externalMB: 2, rssBudgetMB: probe.BUDGET_RSS_MB },
    modules: { loaded: 500, budget: probe.MODULE_BUDGET.frame },
    handles: { total: 5, by: { Timeout: 3 } },
    machine: { totalMB: 16000, freeMB: 8000, freePct: 50, cpus: 8, floorFreePct: probe.FLOOR_FREE_MEM_PCT },
    children: [],
    ...over,
  };
  return base;
}

test('baseline census is clean: nothing over budget reports no exceedance', () => {
  const findings = probe.assessResidency(snapAt());
  assert.strictEqual(findings.filter((f) => f.exceeded).length, 0);
  assert.strictEqual(probe.buildResidencyNotice(snapAt()), null);
});

test('each budget trips in the right direction', () => {
  const clean = snapAt();
  const cases = [
    { id: 'memory', at: { memory: { ...clean.memory, rssMB: probe.BUDGET_RSS_MB + 1 } } },
    { id: 'modules', at: { modules: { loaded: probe.MODULE_BUDGET.frame + 1, budget: probe.MODULE_BUDGET.frame } } },
    { id: 'handles', at: { handles: { total: 99, by: { Timeout: probe.HANDLE_BUDGET_TIMERS + 1 } } } },
    { id: 'handles', at: { handles: { total: 99, by: { FSWatcher: probe.HANDLE_BUDGET_WATCHERS + 1 } } }, via: '文件监视' },
    { id: 'machine', at: { machine: { ...clean.machine, freePct: probe.FLOOR_FREE_MEM_PCT - 1 } } },
  ];
  for (const c of cases) {
    const hit = probe.assessResidency(snapAt(c.at)).find((f) => f.id === c.id);
    assert.ok(hit, `finding ${c.id} exists`);
    assert.strictEqual(hit.exceeded, true, `${c.id}${c.via ? ` (${c.via})` : ''} must report over budget`);
    if (c.via) assert.match(hit.summary, new RegExp(c.via));
  }
});

test('a resident child is stated as a cost, never as a violation', () => {
  // The image bridge is resident by design; flagging it every session would make
  // the whole notice noise. It must still be visible, with its disposal command.
  const running = snapAt({
    children: [{ name: '剪贴板图片桥 (powershell)', running: true, enabled: true, pid: 9, pollMs: 500 }],
  });
  const f = probe.assessResidency(running).find((x) => x.id === 'children');
  assert.strictEqual(f.exceeded, false);
  assert.match(f.detail, /pid=9/);
  assert.match(f.summary, /85 MB/);
  assert.match(f.hint, /clipboard bridge stop/);
  assert.strictEqual(probe.buildResidencyNotice(running), null, 'cost statement alone must not fire the notice');
});

test('boundary reads stay clean (budget is inclusive of the limit itself)', () => {
  const at = snapAt({
    memory: { ...snapAt().memory, rssMB: probe.BUDGET_RSS_MB },
    modules: { loaded: probe.MODULE_BUDGET.frame, budget: probe.MODULE_BUDGET.frame },
    handles: { total: 5, by: { Timeout: probe.HANDLE_BUDGET_TIMERS, FSWatcher: probe.HANDLE_BUDGET_WATCHERS } },
    machine: { ...snapAt().machine, freePct: probe.FLOOR_FREE_MEM_PCT },
  });
  assert.strictEqual(probe.assessResidency(at).filter((f) => f.exceeded).length, 0);
});

test('data home only appears when the disk walk was asked for', () => {
  assert.ok(!probe.assessResidency(snapAt()).some((f) => f.id === 'dataHome'));
  const withDisk = snapAt({
    dataHome: {
      root: '/tmp/.khy', totalMB: 509, totalHuman: '509 MB', reclaimableMB: 229,
      reclaimableHuman: '229 MB', thresholdMB: 500, overThreshold: true,
      top: [{ rel: 'tmp', human: '186 MB' }],
    },
  });
  const d = probe.assessResidency(withDisk).find((f) => f.id === 'dataHome');
  assert.strictEqual(d.exceeded, true);
  assert.match(d.summary, /509 MB/);
  assert.match(d.hint, /khy clean --runtime --dry-run/);
});

test('notice names the offending readings and carries a fix', () => {
  const line = probe.buildResidencyNotice(snapAt({
    handles: { total: 99, by: { Timeout: probe.HANDLE_BUDGET_TIMERS + 2, FSWatcher: 1 } },
  }));
  assert.ok(line, 'notice is emitted when something is over budget');
  assert.ok(line.includes('定时器 22/20 · 监视 1/2'), line);
  assert.match(line, /处置：/);
  assert.match(line, /pid 4242/);
});

test('the module graph never fires the session notice (developer-facing reading)', () => {
  // Its disposal is "change the code" — that stays in `khy doctor`, not in a boot line.
  const onlyModules = snapAt({
    modules: { loaded: probe.MODULE_BUDGET.frame + 500, budget: probe.MODULE_BUDGET.frame },
  });
  assert.strictEqual(probe.buildResidencyNotice(onlyModules), null);
  const asFinding = probe.assessResidency(onlyModules).find((f) => f.id === 'modules');
  assert.strictEqual(asFinding.exceeded, true, 'doctor still sees it as over budget');
});

test('module budget is split by measurement phase', () => {
  const at = (phase) =>
    snapAt({ modules: { loaded: 1084, budget: probe.MODULE_BUDGET[phase] } });
  const over = (phase) => probe.assessResidency(at(phase)).find((f) => f.id === 'modules').exceeded;
  assert.strictEqual(over('frame'), true, 'first-paint target still trips at 1084');
  assert.strictEqual(over('cli'), false);
  assert.strictEqual(over('tui'), false);
});

test('census threads the phase through to the module budget', () => {
  // Guards the wiring, not just the table: if collectRuntimeCensus drops opts.phase,
  // the phase table above still looks right while every caller silently gets the default.
  assert.strictEqual(probe.collectRuntimeCensus({ phase: 'frame' }).modules.budget, 1000);
  assert.strictEqual(probe.collectRuntimeCensus({ phase: 'cli' }).modules.budget, 1200);
  assert.strictEqual(probe.collectRuntimeCensus({ phase: 'tui' }).modules.budget, 2200);
  assert.strictEqual(probe.collectRuntimeCensus({}).modules.budget, 2200);
});

test('design lock: module budgets may only be lowered', () => {
  assert.deepStrictEqual({ ...probe.MODULE_BUDGET }, { frame: 1000, cli: 1200, tui: 2200 });
});

test('an unknown phase falls back to the loosest tier instead of crying wolf', () => {
  assert.strictEqual(probe.collectModuleGraph('nope').budget, probe.MODULE_BUDGET.tui);
});

test('every finding carries a reading with numerator and denominator', () => {
  const snap = snapAt({
    handles: { total: 99, by: { Timeout: 22, FSWatcher: 3 } },
    dataHome: {
      root: '/tmp/.khy', totalMB: 509, totalHuman: '509 MB', reclaimableMB: 229,
      reclaimableHuman: '229 MB', thresholdMB: 500, overThreshold: true, top: [],
    },
  });
  const findings = probe.assessResidency(snap);
  for (const f of findings) {
    assert.ok(typeof f.reading === 'string' && f.reading.length > 0, f.id + ' has a reading');
  }
  const by = (id) => findings.find((f) => f.id === id).reading;
  assert.strictEqual(by('handles'), '定时器 22/20 · 监视 3/2');
  assert.strictEqual(by('memory'), 'RSS 120/220 MB');
  assert.strictEqual(by('dataHome'), '509/500 MB');
});

test('live census returns real numbers, not an empty stub', () => {
  const snap = probe.collectRuntimeCensus();
  assert.ok(snap.modules.loaded > 0);
  assert.ok(snap.memory.rssMB > 0 && snap.machine.totalMB > 0);
  assert.ok(snap.memory.heapUsedMB > 0);
  assert.ok(Number.isFinite(snap.uptimeSeconds) && snap.uptimeSeconds >= 0);
  assert.ok(Array.isArray(snap.children));
  // Wiring proof: the counter must follow an actual require, not a frozen number.
  const before = probe.collectModuleGraph().loaded;
  require('../src/services/hardwareProfileService');
  assert.ok(probe.collectModuleGraph().loaded > before, 'module count tracks require.cache growth');
  // Every reading the judge touches must be present, or judgement silently passes on undefined.
  for (const f of probe.assessResidency(snap)) {
    assert.ok(typeof f.exceeded === 'boolean', `${f.id} judgement resolved`);
    assert.ok(f.detail && f.summary && f.hint, `${f.id} carries detail/summary/hint`);
    assert.ok(typeof f.reading === 'string' && f.reading.length > 0, `${f.id} carries a reading`);
    assert.ok(!/undefined|NaN/.test(f.detail), `${f.id} detail has no unset field`);
  }
});
test('handle budget is split by phase and may only be lowered', () => {
  assert.deepStrictEqual({ ...probe.HANDLE_BUDGET }, {
    frame: { timers: 20, watchers: 2 },
    cli: { timers: 20, watchers: 2 },
    tui: { timers: 30, watchers: 4 },
  });
  assert.strictEqual(probe.HANDLE_BUDGET_TIMERS, 20, 'back-compat alias = cli tier');
  assert.strictEqual(probe.HANDLE_BUDGET_WATCHERS, 2, 'back-compat alias = cli tier');
});

test('an interactive session is judged by the tui tier, not the cli tripwire', () => {
  // Regression (2026-10-04): a live TUI session at ~26 timers — the render
  // scheduler plus the registered resident intervals — was reported over budget
  // against the cli 20-timer tripwire. The tui tier must stay silent; cli still
  // catches the same reading as growth.
  const at = (phase) => snapAt({ phase, handles: { total: 26, by: { Timeout: 26 } } });
  assert.strictEqual(
    probe.assessResidency(at('tui')).find((f) => f.id === 'handles').exceeded,
    false,
    'tui tier must not flag 26 timers'
  );
  assert.strictEqual(
    probe.assessResidency(at('cli')).find((f) => f.id === 'handles').exceeded,
    true,
    'cli tier keeps the leak tripwire'
  );
});

test('census carries the resolved phase for the judge', () => {
  assert.strictEqual(probe.collectRuntimeCensus({ phase: 'cli' }).phase, 'cli');
  assert.strictEqual(probe.collectRuntimeCensus({}).phase, 'tui', 'default phase is the loosest tier');
});

test('handle census names what the count is made of', () => {
  const h = probe.collectHandleCensus();
  assert.ok(Array.isArray(h.top), 'top breakdown is present');
  assert.strictEqual(h.top.reduce((n, x) => n + x.count, 0), h.total, 'top partitions the census');
});

test('the environment reading is its own sentence, never merged with our own', () => {
  const snap = snapAt({
    phase: 'cli',
    handles: { total: 26, by: { Timeout: 26 } },
    machine: { ...snapAt().machine, freePct: probe.FLOOR_FREE_MEM_PCT - 1 },
  });
  const line = probe.buildResidencyNotice(snap);
  assert.ok(line, 'notice fires when something is over budget');
  assert.ok(line.includes('活体句柄'), 'khy self-reading present');
  assert.ok(line.includes('环境：'), 'environment reading gets its own sentence');
  assert.ok(!/均超出判据/.test(line), 'self and environment are never conflated');
});

test('an environment-only reading still speaks, but as environment', () => {
  const onlyEnv = snapAt({
    phase: 'cli',
    machine: { ...snapAt().machine, freePct: probe.FLOOR_FREE_MEM_PCT - 1 },
  });
  const line = probe.buildResidencyNotice(onlyEnv);
  assert.ok(line && line.includes('环境：'), 'environment-only still reports');
  assert.ok(line.includes('非 khy 缺陷'), 'and says so plainly');
});
