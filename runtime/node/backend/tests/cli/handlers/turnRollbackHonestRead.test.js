'use strict';

/**
 * turnRollbackHonestRead.test.js — `khy turn-rollback` 无参路径的读错误诚实性契约。
 *
 * 复现源自 .khy/feedback/hci-r38-turnrollback-swallow/ :旧代码 `catch { turns = [] }`
 * 把 listTurns 的真实异常(ENOTDIR 等)吞成空列表 → 谎报「没有可回滚的回合」,
 * 而同一状态下 list 分支却说真话。修后两分支同源同话。
 * node --test only;service 用 seeded fake(真实 fs 端到端已由探针证明)。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const BACKEND = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(BACKEND, 'src');

function seed(absPath, exportsObj) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[absPath] = m;
}

const rec = { success: [], error: [], info: [], warn: [] };
seed(path.join(SRC, 'cli', 'formatters.js'), {
  printSuccess: (m) => rec.success.push(String(m)),
  printError: (m) => rec.error.push(String(m)),
  printInfo: (m) => rec.info.push(String(m)),
  printWarn: (m) => rec.warn.push(String(m)),
  printTable: () => {},
});

const SVC = path.join(SRC, 'services', 'turnCheckpointService.js');
const HANDLER = path.join(SRC, 'cli', 'handlers', 'turnRollback.js');

function withService(svc, run) {
  const prevSvc = require.cache[SVC];
  const prevHandler = require.cache[HANDLER];
  try {
    seed(SVC, svc);
    delete require.cache[HANDLER];
    return run(require(HANDLER));
  } finally {
    if (prevSvc) require.cache[SVC] = prevSvc;
    else delete require.cache[SVC];
    if (prevHandler) require.cache[HANDLER] = prevHandler;
    else delete require.cache[HANDLER];
  }
}

function reset() {
  rec.success.length = 0;
  rec.error.length = 0;
  rec.info.length = 0;
  rec.warn.length = 0;
}

const ENOTDIR = Object.assign(new Error('ENOTDIR: not a directory, scandir X'), { code: 'ENOTDIR' });

test('T1 无参 + listTurns 抛异常 → 如实报读失败,禁「没有可回滚的回合」', async () => {
  reset();
  const svc = { listTurns: () => { throw ENOTDIR; } };
  await withService(svc, async ({ handleTurnRollback }) => {
    await handleTurnRollback('turn-rollback', '', [], { confirm: true });
  });
  assert.equal(rec.error.length, 1, JSON.stringify(rec.error));
  assert.match(rec.error[0], /读取回合检查点失败/);
  assert.match(rec.error[0], /ENOTDIR/, '病因必须到达用户');
  assert.ok(!rec.error[0].includes('没有可回滚'), '吞错谎报必须绝迹');
});

test('T2 list 分支同话(两分支对同一状态不再互相矛盾)', async () => {
  reset();
  const svc = { listTurns: () => { throw ENOTDIR; } };
  await withService(svc, async ({ handleTurnRollback }) => {
    await handleTurnRollback('turn-rollback', 'list', [], {});
  });
  assert.equal(rec.error.length, 1);
  assert.match(rec.error[0], /读取回合检查点失败/);
});

test('T3 真空列表仍诚实报「没有可回滚的回合」(不误伤既有措辞)', async () => {
  reset();
  const svc = { listTurns: () => [] };
  await withService(svc, async ({ handleTurnRollback }) => {
    await handleTurnRollback('turn-rollback', '', [], { confirm: true });
  });
  assert.equal(rec.error.length, 1);
  assert.match(rec.error[0], /没有可回滚的回合/);
});

test('T4 happy path:找到 ended 回合 → 真调 rollbackTurn 并按结果回执', async () => {
  reset();
  const called = [];
  const svc = {
    listTurns: () => [{ turnId: 't-42', status: 'ended', fileCount: 2, createdAt: 'x' }],
    rollbackTurn: (id) => { called.push(id); return { success: true, restored: true, files: ['a', 'b'], conflicts: 0 }; },
    buildSemanticCorrection: () => 'correction',
  };
  await withService(svc, async ({ handleTurnRollback }) => {
    await handleTurnRollback('turn-rollback', '', [], { confirm: true });
  });
  assert.deepEqual(called, ['t-42'], '非空转:目标回合必须真被回滚');
  assert.equal(rec.error.length, 0);
  assert.match(rec.success.join(''), /已回滚回合 t-42 的 2 个文件改动/);
});
