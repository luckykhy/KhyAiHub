'use strict';

/**
 * hqRoadmapSyncGate.test.js — 「ROADMAP.md 未同步即拒绝落盘」的回归锁（bp-14）。
 *
 * 2026-10-21 的 T-030：`khy hq task set T-030 done` 落了 PROGRESS.json 却没在
 * ROADMAP.md 留下行，`khy hq verify` 从此恒 1 error（`✗ T-030 在 ROADMAP.md 中
 * 没有可同步的状态行`）。修法是把 ROADMAP 同步挪到 `saveJson` 之前、同步失败即
 * 拒绝（`handlers/hq.js` 的 `_applyState` + `cmdTaskSet` 的 [REFUSED] 处方）。
 *
 * 为什么单列一个文件：那是把一个**软提示**（dim 尾巴）换成**硬拒绝**（exit 1、
 * PROGRESS.json 一个字节不改）的行为变更，而它此前没有任何测试会在回退时变红
 * —— 2026-11-07 复核时 `grep roadmapSyncFailed tests/` 零命中。本文件补上：
 *   - `_syncRoadmap` 三态契约（行缺失 false 且不写文件 / 状态列不同 true 且改写 /
 *     已在目标态 true 且逐字节不动 / 文件不可读 null）；
 *   - E2E：缺行的合法迁移被拒（非零退出 + JSON 不被污染 + 处方含补行格式与重跑
 *     命令），且按处方补行后同一条命令放行并同步——拒绝是可闭合的门，不是死墙。
 *
 * 为什么 E2E 选 doing→review：它不踩验收清算门（review→done）也不踩 scope_guard
 * 门（todo→doing），拒绝只可能来自 ROADMAP 同步这一步，归因干净。
 *
 * ⚠ **必须是 node:test 而不是 jest**：`package.json` 的
 * `test:all = npm test && npm run test:node` —— 两套 runner 都扫全部 `*.test.js`，
 * jest 风格文件在 `test:node` 下 `jest is not defined` 落地即红；而
 * `jest.config.js` 会按 `require('node:test')` 标记把本文件从 jest 侧排除。
 * 这是本仓两套 runner 并存下的硬约定，勿改成 `describe/test`（hqReviewGate.test.js
 * 的同款说明）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HQH = require('../../src/cli/handlers/hq.js');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'khy.js');
// tests/cli → tests → backend → node → runtime → <repo>：五级
const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
// HQ 状态真源 2026-09-17 从 `.ai/hq/` 迁到 `works/record/ai/hq/`，这里跟着走。
const REAL_HQ = path.join(REPO, 'works', 'record', 'ai', 'hq');

// ── 纯逻辑：_syncRoadmap 三态契约 ──────────────────────────────────

/** 最小 ROADMAP 形状（行格式约束见 `works/record/ai/hq/ROADMAP.md` 首节）。 */
function roadmapText() {
  return [
    '| ID | 标题 | 类型 | 优先级 | 状态 |',
    '|----|------|------|--------|------|',
    '| T-001 | 甲 | feature | P1 | todo |',
    '| T-002 | 乙 | quality | P2 | doing |',
    '',
  ].join('\n');
}

function tmpRoadmap(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-roadmap-sync-'));
  const file = path.join(dir, 'ROADMAP.md');
  fs.writeFileSync(file, text, 'utf8');
  return { dir, file };
}

test('_syncRoadmap：行不存在 → false 且不写文件（verify 报的分叉形态）', () => {
  const { dir, file } = tmpRoadmap(roadmapText());
  try {
    const before = fs.readFileSync(file, 'utf8');
    assert.strictEqual(HQH._syncRoadmap(file, 'T-999', 'done'), false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, '同步失败不得留下任何写入');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_syncRoadmap：行存在且状态列不同 → true 且改写状态列', () => {
  const { dir, file } = tmpRoadmap(roadmapText());
  try {
    assert.strictEqual(HQH._syncRoadmap(file, 'T-001', 'done'), true);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('| T-001 | 甲 | feature | P1 | done |'), after);
    assert.ok(!after.includes('| T-001 | 甲 | feature | P1 | todo |'), '旧状态行应被替换');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_syncRoadmap：行已在目标状态 → true 且文件逐字节不变（同态重写不误判）', () => {
  const { dir, file } = tmpRoadmap(roadmapText());
  try {
    const before = fs.readFileSync(file, 'utf8');
    // hqStartGate 的 doing→todo 打回用例依赖这一态：ROADMAP 行本就是 todo。
    // 若把它并进 false，「同步失败即拒绝」会误杀合法的同态重写。
    assert.strictEqual(HQH._syncRoadmap(file, 'T-001', 'todo'), true);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_syncRoadmap：文件不可读 → null（与「没找到行」分开，掩盖真实故障更贵）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-roadmap-sync-'));
  try {
    assert.strictEqual(HQH._syncRoadmap(path.join(dir, 'no-such.md'), 'T-001', 'done'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 端到端：拒绝落盘 + 处方可闭合 ──────────────────────────────────

/**
 * 真跑一次 CLI。
 *
 * ⚠ stdio 必须落**文件**而不是管道（2026-09-23 实测教训）：spawnSync 的管道版
 * 会等到「所有持有写端的后代进程都退出」才返回 —— 而 khy.js 启动时会拉起
 * 后台辅助进程（gateway warmup 等），其存活时间不可控。stdio 重定向到文件后，
 * 直接子进程一退出 spawnSync 即返回。同时显式关掉三类启动期后台行为。
 */
function runCli(args, env, sandboxDir) {
  const outFile = path.join(
    sandboxDir,
    `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
  );
  const fd = fs.openSync(outFile, 'w');
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: Object.assign({}, process.env, env, {
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

/** 建独立沙箱（真实 HQ 真源拷贝 + 空反馈目录），返回 env 覆盖。 */
function newSandboxEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-roadmap-gate-'));
  const hq = path.join(root, 'hq');
  fs.mkdirSync(hq, { recursive: true });
  for (const f of ['BUGS.json', 'PROGRESS.json', 'ROADMAP.md', 'MODELS.json']) {
    fs.copyFileSync(path.join(REAL_HQ, f), path.join(hq, f));
  }
  fs.cpSync(path.join(REAL_HQ, 'prompts'), path.join(hq, 'prompts'), { recursive: true });
  const fb = path.join(root, 'feedback');
  fs.mkdirSync(fb, { recursive: true });
  return { root, hq, fb, env: { KHY_HQ_DIR: hq, KHY_FEEDBACK_DIR: fb } };
}

function readTask(env, id) {
  const d = JSON.parse(fs.readFileSync(path.join(env.hq, 'PROGRESS.json'), 'utf8'));
  return (d.tasks || []).find((x) => x.id === id);
}

function writeTask(env, id, mutate) {
  const p = path.join(env.hq, 'PROGRESS.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const t = d.tasks.find((x) => x.id === id);
  mutate(t);
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');
}

function hasRow(env, id) {
  const text = fs.readFileSync(path.join(env.hq, 'ROADMAP.md'), 'utf8');
  return text.split(/\r?\n/).some((l) => l.startsWith(`| ${id} |`));
}

function rowLine(env, id) {
  const text = fs.readFileSync(path.join(env.hq, 'ROADMAP.md'), 'utf8');
  return text.split(/\r?\n/).find((l) => l.startsWith(`| ${id} |`)) || '';
}

test('E2E ROADMAP 缺行 → task set 被拒、PROGRESS.json 不被污染、处方可闭合', () => {
  const env = newSandboxEnv();
  try {
    // T-001 摆成 doing：doing→review 合法且不踩其它门，拒绝只可能来自同步这一步。
    writeTask(env, 'T-001', (t) => {
      t.status = 'doing';
    });
    // 删掉它的 ROADMAP 行 —— 复刻 T-030 的形态：机读真源有、人读板无。
    const rm = path.join(env.hq, 'ROADMAP.md');
    fs.writeFileSync(
      rm,
      fs.readFileSync(rm, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('| T-001 |')).join('\n'),
      'utf8'
    );
    assert.strictEqual(hasRow(env, 'T-001'), false, '前置：沙箱 ROADMAP 应已无 T-001 行');

    const r = runCli(['hq', 'task', 'set', 'T-001', 'review'], env.env, env.root);
    assert.notStrictEqual(r.code, 0, `缺行时应被拒；输出：\n${r.output}`);
    // 拒绝理由必须指名的分叉、给出补行格式与重跑命令（RUNTIME-002.2：问题+修复）。
    assert.ok(r.output.includes('[REFUSED]'), r.output);
    assert.ok(r.output.includes('ROADMAP.md 中没有可同步的表格行'), r.output);
    assert.ok(r.output.includes('| T-001 |'), r.output);
    assert.ok(r.output.includes('khy hq task set T-001 review'), r.output);
    // 硬拒绝的核心：机读真源一个字节都不许前进，人读板也不许被顺手补写。
    assert.strictEqual(readTask(env, 'T-001').status, 'doing', '被拒时状态必须不变');
    assert.strictEqual(hasRow(env, 'T-001'), false, '被拒时不得往 ROADMAP 写任何东西');

    // 处方可闭合：按给出的格式补行，重跑同一条命令。
    const t = readTask(env, 'T-001');
    fs.appendFileSync(rm, `| T-001 | ${t.title} | ${t.type} | ${t.priority} | doing |\n`, 'utf8');
    const r2 = runCli(['hq', 'task', 'set', 'T-001', 'review'], env.env, env.root);
    assert.strictEqual(r2.code, 0, `补行后应放行；输出：\n${r2.output}`);
    assert.ok(r2.output.includes('[OK] T-001 doing -> review'), r2.output);
    assert.strictEqual(readTask(env, 'T-001').status, 'review', '放行后应落盘');
    assert.ok(rowLine(env, 'T-001').endsWith('| review |'), `同步应改写状态列：${rowLine(env, 'T-001')}`);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
