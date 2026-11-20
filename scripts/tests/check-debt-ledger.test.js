'use strict';
/**
 * check-debt-ledger.test.js — 「据实回写留痕」读数（debt-ledger-rewrite-untraced）的单测。
 *
 * 这条读数的判据只有一句：measured 比上一次记录值上涨，而 regression 没写原因时，
 * 报一条 warning；其余情况一律不报（宁可漏报，不误报）。
 *
 * 排除误报的四种情形逐一有用例：有原因的上升、下降、持平、前值解析不出。
 * 另外单独验证结构化前值（measuredHistory）优先于文本解析。
 *
 * 同时断言 **exit code 不变**：warning 不参与退出码，这正是「读数不是门」的落地方式。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const CHECKER = path.resolve(__dirname, '..', 'ci', 'check-debt-ledger.js');
const RULE = 'debt-ledger-rewrite-untraced';
const TODAY = new Date().toISOString().slice(0, 10);

let seq = 0;
const TMP_ROOTS = [];

function entry(over) {
  return {
    id: 'fixture.metric',
    guard: 'scripts/ci/fixture-guard.js',
    metric: 'fixture-metric',
    measured: 100,
    measuredAt: TODAY,
    target: 50,
    risk: 'P2',
    owner: 'platform',
    dueBy: '2099-12-31',
    status: 'open',
    note: 'fixture',
    plan: 'fixture',
    ...over,
  };
}

/** 最小可跑的台账 fixture：覆盖完整性检查需要 BASELINE_IDS 与 baselines 存在。 */
function mkFixture(entries) {
  seq += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `khy-debt-${seq}-`));
  TMP_ROOTS.push(root);

  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  };

  write('scripts/ci/check-repo-layout.js', "'use strict';\nconst BASELINE_IDS = new Set([]);\n");
  write('scripts/ci/code-standards.baseline.json', JSON.stringify({ baselines: {} }, null, 2));
  write('scripts/ci/fixture-guard.js', "'use strict';\n");
  write('scripts/ci/debt-ledger.json', JSON.stringify({ updated: TODAY, entries }, null, 2));
  return root;
}

function run(root) {
  const r = cp.spawnSync(process.execPath, [CHECKER, '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KHY_DEBT_LEDGER_ROOT: root },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ok(r.stdout && r.stdout.trim(), `JSON 输出必须可解析，stderr=${r.stderr}`);
  return { status: r.status, json: JSON.parse(r.stdout) };
}

const untraced = (json) => (json.findings || []).filter((f) => f.rule === RULE);

test.after(() => {
  for (const r of TMP_ROOTS) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言结论 */
    }
  }
});

test('有原因的上升不报', () => {
  const root = mkFixture([
    entry({
      measured: 100,
      regression: '2026-11-18：80 → 100（+20，新增核心域文件带动）。按 QUAL-1 据实回写基线与实测值，棘轮自该值继续只降不升。',
    }),
  ]);
  const { status, json } = run(root);
  assert.strictEqual(untraced(json).length, 0, `有解释的上升不得报：${JSON.stringify(untraced(json))}`);
  assert.strictEqual(status, 0);
});

test('无原因的上升报一条 warning，且不改 exit code', () => {
  const root = mkFixture([
    entry({
      measured: 100,
      regression: '2026-11-18：80 → 100（+20）。按 QUAL-1 据实回写基线与实测值，棘轮自该值继续只降不升，target 不变。',
    }),
  ]);
  const { status, json } = run(root);

  const hits = untraced(json);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].level, 'warning');
  assert.match(hits[0].message, /从 80 涨到 100/);
  assert.match(hits[0].message, /未记录原因/);
  assert.match(hits[0].message, /不再度量改善/);

  assert.strictEqual(json.errors, 0, '不得新增 error');
  assert.strictEqual(status, 0, 'advisory 读数不得改变 exit code');
});

test('下降与持平不报', () => {
  const root = mkFixture([
    entry({ id: 'fixture.down', measured: 100, regression: '2026-11-18：120 → 100。按 QUAL-1 据实回写。' }),
    entry({ id: 'fixture.flat', measured: 100, regression: '2026-11-18：100 → 100。按 QUAL-1 据实回写。' }),
  ]);
  const { status, json } = run(root);
  assert.strictEqual(untraced(json).length, 0, `下降/持平不得报：${JSON.stringify(untraced(json))}`);
  assert.strictEqual(status, 0);
});

test('结构化前值缺失且文本解析不出时不报（宁可漏报）', () => {
  const root = mkFixture([
    entry({ id: 'fixture.no-arrow', measured: 100, regression: '按 QUAL-1 据实回写实测值，棘轮自该值继续只降不升。' }),
    entry({ id: 'fixture.no-regression', measured: 100 }),
  ]);
  const { status, json } = run(root);
  assert.strictEqual(untraced(json).length, 0, `解析不出前值不得报：${JSON.stringify(untraced(json))}`);
  assert.strictEqual(status, 0);
});

test('结构化 measuredHistory 优先于文本，缺失时退回文本', () => {
  // measuredHistory 末项 70，文本里写的是 80 → 100；前值应取 70，故仍报 70 → 100。
  const withStructured = mkFixture([
    entry({
      id: 'fixture.structured',
      measured: 100,
      measuredHistory: [50, 70],
      regression: '2026-11-18：80 → 100（+20）。按 QUAL-1 据实回写基线与实测值。',
    }),
  ]);
  const a = run(withStructured);
  const hitsA = untraced(a.json);
  assert.strictEqual(hitsA.length, 1);
  assert.match(hitsA[0].message, /从 70 涨到 100/);

  // 结构化前值高于当前 measured 时是下降，不报 —— 证明优先用的是 500 而不是文本里的 80。
  const structuredHigher = mkFixture([
    entry({
      id: 'fixture.structured-higher',
      measured: 100,
      measuredHistory: [500],
      regression: '2026-11-18：80 → 100（+20）。按 QUAL-1 据实回写基线与实测值。',
    }),
  ]);
  const b = run(structuredHigher);
  assert.strictEqual(untraced(b.json).length, 0);
});
