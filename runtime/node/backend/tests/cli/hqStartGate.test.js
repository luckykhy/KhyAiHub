'use strict';

/**
 * hqStartGate.test.js — 开工裁决的接线锁（todo→doing 盖章 → 备注 → status/close 可见）。
 *
 * 判据逻辑本身的矩阵在 `tests/cli/startVerdict.test.js`（jest）。本文件只证明
 * 纯逻辑证明不了的事：**开工戳真的由 CLI 在门的同一处写进磁盘**，且认领/备注
 * 真的能把同一条任务从 declared 推到 started。
 *
 * ⚠ 必须是 `node:test`：理由同 `hqReviewGate.test.js` —— 两套 runner 都扫
 * `*.test.js`，jest 风格文件在 `test:node` 下 `jest is not defined` 落地即红。
 *
 * ## 为什么只有 3 个 spawn
 *
 * 实测本机 `node bin/khy.js` 冷启 12~16s（仓库体量，与被测逻辑无关）。所以：
 *   - `todo→doing` 盖章（1 次 spawn）
 *   - `task note` 把任务推到 started（1 次 spawn）
 *   - `hq close --json` 项目面开工汇总（1 次 spawn）
 * `hq status` 的呈现面直接调 `H.buildStatus(<sandbox>)`（零 IO 之外不额外起进程）。
 * 「未声明 scope_guard 就拒、且不落开工戳」由 `hqReviewGate.test.js` 的既有 E2E 覆盖。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const H = require('../../src/cli/hqStore');
const S = require('../../src/cli/startVerdict');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'khy.js');
const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const REAL_HQ = path.join(REPO, 'works', 'record', 'ai', 'hq');

/**
 * 真跑一次 CLI。stdio 必须落**文件**：spawnSync 的管道版会等所有持有写端的
 * 后代进程退出，而 khy.js 会拉起后台辅助进程（见 hqReviewGate.test.js 的实测记录）。
 */
function runCli(args, extraEnv, sandboxDir) {
  const outFile = path.join(
    sandboxDir,
    `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
  );
  const fd = fs.openSync(outFile, 'w');
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: Object.assign({}, process.env, extraEnv, {
        KHY_GATEWAY_WARMUP_ON_BOOT: '0',
        KHY_STARTUP_UPDATE_CHECK: '0',
        KHY_AUTO_UPDATE: '0',
      }),
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 120000,
    });
    return { code: r.status, signal: r.signal, output: fs.readFileSync(outFile, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/** 独立沙箱：真实 HQ 真源拷贝 + 空反馈/报告目录，绝不碰仓内数据。 */
function newSandboxEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hq-start-'));
  const hq = path.join(root, 'hq');
  fs.mkdirSync(hq, { recursive: true });
  for (const f of ['BUGS.json', 'PROGRESS.json', 'ROADMAP.md', 'MODELS.json']) {
    fs.copyFileSync(path.join(REAL_HQ, f), path.join(hq, f));
  }
  fs.cpSync(path.join(REAL_HQ, 'prompts'), path.join(hq, 'prompts'), { recursive: true });
  const fb = path.join(root, 'feedback');
  const reports = path.join(root, 'reports');
  fs.mkdirSync(fb, { recursive: true });
  fs.mkdirSync(reports, { recursive: true });
  return { root, hq, fb, reports, env: { KHY_HQ_DIR: hq, KHY_FEEDBACK_DIR: fb } };
}

function readProgress(env) {
  return JSON.parse(fs.readFileSync(path.join(env.hq, 'PROGRESS.json'), 'utf8'));
}

function readTask(env, id) {
  return (readProgress(env).tasks || []).find((x) => x.id === id);
}

function writeTask(env, id, mutate) {
  const p = path.join(env.hq, 'PROGRESS.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const t = d.tasks.find((x) => x.id === id);
  mutate(t);
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');
}

test('E2E 开工戳 → 备注 → started：状态改写不再等于开工（一条真实链路）', () => {
  const env = newSandboxEnv();
  try {
    // 边界直接写进夹具：scope_guard 门的拒绝/放行已有独立 E2E，此处只测「盖章」。
    writeTask(env, 'T-001', (t) => {
      t.status = 'todo';
      t.scope_guard = ['只改 hq 相关文件'];
      delete t.started_at;
      delete t.started_by;
      delete t.start_note_count;
    });
    // 沙箱拷的是真实任务板（done 任务已是 started），所以断言用**差值**而不是绝对值 ——
    // 真实数据会变，差值只反映这一条任务的迁移。
    const before = S.rollupStarts((readProgress(env).tasks || []).map((x) => S.evaluateStart(x).verdict));
    const baselineNotes = (readTask(env, 'T-001').notes || []).length;

    const r1 = runCli(['hq', 'task', 'set', 'T-001', 'doing'], env.env, env.root);
    assert.strictEqual(r1.code, 0, `应放行；输出：\n${r1.output}`);

    const t1 = readTask(env, 'T-001');
    assert.strictEqual(t1.status, 'doing');
    assert.match(t1.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, JSON.stringify(t1.started_at));
    assert.ok(t1.started_by, '应记录盖章的机器');
    assert.strictEqual(t1.start_note_count, baselineNotes, '开工基线应等于盖章时的备注条数');
    assert.strictEqual(S.evaluateStart(t1).verdict, 'declared', '只有状态改写、零活动 → declared');

    const r2 = runCli(['hq', 'task', 'note', 'T-001', '--note', '已动工：先改 hqStore'], env.env, env.root);
    assert.strictEqual(r2.code, 0, r2.output);

    const t2 = readTask(env, 'T-001');
    assert.strictEqual((t2.notes || []).length, baselineNotes + 1);
    assert.strictEqual(t2.started_at, t1.started_at, '补备注不得改写开工时刻');
    assert.strictEqual(S.evaluateStart(t2).verdict, 'started');

    // status 的呈现面（buildStatus）与磁盘一致
    const st = H.buildStatus(env.hq);
    const row = (st.tasks || []).find((x) => x.id === 'T-001');
    assert.strictEqual(row.start, 'started');
    assert.strictEqual(row.started_at, t1.started_at);

    // 项目面收盘：开工汇总入账，行内带 start
    const r3 = runCli(
      ['hq', 'close', '--json'],
      Object.assign({}, env.env, { KHY_REPORTS_DIR: env.reports }),
      env.root
    );
    const text = r3.output.slice(r3.output.indexOf('{'));
    const report = JSON.parse(text);
    assert.strictEqual(report.startCounts.started, before.counts.started + 1, JSON.stringify(report.startCounts));
    assert.strictEqual(
      report.startCounts['not-started'],
      before.counts['not-started'] - 1,
      JSON.stringify(report.startCounts)
    );
    const closeRow = (report.tasks || []).find((x) => x.id === 'T-001');
    assert.strictEqual(closeRow.start, 'started');
    assert.strictEqual(closeRow.startSource, 'stamp');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('E2E 打回 todo 清掉开工戳：下次开工重新计时（不洗白中途停滞）', () => {
  const env = newSandboxEnv();
  try {
    writeTask(env, 'T-002', (t) => {
      t.status = 'doing';
      t.scope_guard = ['只改 hq 相关文件'];
      t.started_at = '2026-11-04T09:00:00';
      t.started_by = 'machine-a';
      t.start_note_count = 0;
    });

    const r = runCli(['hq', 'task', 'set', 'T-002', 'todo'], env.env, env.root);
    assert.strictEqual(r.code, 0, r.output);

    const t = readTask(env, 'T-002');
    assert.strictEqual(t.status, 'todo');
    assert.strictEqual(t.started_at, undefined, '打回后不得保留旧开工戳');
    assert.strictEqual(t.start_note_count, undefined);
    assert.strictEqual(S.evaluateStart(t).verdict, 'not-started');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
