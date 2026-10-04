'use strict';

/**
 * autoModelRouting.test.js — IO 壳契约([DESIGN-ARCH-162] §3.2/§3.3,阶段 S1 观察者)。
 *
 * 覆盖:门控短路、候选池枚举/归一/relay 排除/超时保留旧数据、rank 的 broken 过滤与
 * skipped 点名、账本双写入口(recordOutcome)、S1 观察落盘(env 注入临时文件)、
 * getStage 绝不 fail-open、阶段字面量与登记表一致。
 *
 * 壳是模块级单例——每个用例重新 require(清 require.cache)拿独立状态。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SHELL = path.join(__dirname, '../../../src/services/gateway/autoModelRouting');

function freshShell() {
  delete require.cache[require.resolve(SHELL)];
  return require(SHELL);
}

function fakeGateway(rowsByAdapter, opts = {}) {
  return {
    _adapters: Object.keys(rowsByAdapter).map((k) => ({ key: k, enabled: true, available: true })),
    listModels: async (k) => {
      if (opts.hang && opts.hang === k) {
        await new Promise((r) => setTimeout(r, 1000)); // 远超注入的短超时
        return [];
      }
      if (opts.throwKey === k) {
        throw new Error('boom');
      }
      return rowsByAdapter[k] || [];
    },
    verifyModel: opts.verifyModel,
  };
}

test('gate OFF: rank returns null, recordOutcome no-ops, snapshot says disabled', async () => {
  const shell = freshShell();
  const OFF = { KHY_AUTO_MODEL_HEALTH_AWARE: 'off' };
  const gw = fakeGateway({ api: [{ id: 'glm:glm-4v-flash' }] });
  await shell.refreshPool(gw, OFF);
  assert.equal(shell.rank(gw, 'conversation', {}, OFF), null);
  shell.recordOutcome(
    { adapter: 'api', model: 'glm:glm-4v-flash', outcome: 'failure', errorType: 'model_not_found' },
    OFF
  );
  assert.equal(shell.getSnapshot(OFF).enabled, false);
});

test('pool: normalizes rows, dedupes, excludes relay, survives per-adapter failure', async () => {
  const shell = freshShell();
  const gw = fakeGateway({
    api: [{ id: 'glm:glm-4v-flash' }, { id: 'glm:glm-4v-flash' }, { id: '' }, 'kimi-k2'],
    claude: [{ model: 'claude-opus-4-8' }],
    relay: [{ id: 'never-pool-me' }],
  }, { throwKey: 'claude' });
  await shell.refreshPool(gw);
  const snap = shell.getSnapshot();
  assert.equal(snap.pool.api.models, 2, 'dedupe + empty-id dropped');
  assert.equal(snap.pool.claude.models, 0, 'listModels throw → status failed, empty models kept');
  assert.equal(snap.pool.claude.status, 'failed');
  assert.equal(snap.pool.relay, undefined, 'relay excluded from pool');
});

test('rank: broken model skipped and named; winner is best remaining across channels', async () => {
  const shell = freshShell();
  const gw = fakeGateway({
    api: [{ id: 'sensenova:sensenova-u1-fast' }, { id: 'glm:glm-4v-flash' }],
    claude: [{ id: 'claude-opus-4-8' }],
  });
  shell.recordOutcome({
    adapter: 'api',
    model: 'sensenova:sensenova-u1-fast',
    outcome: 'failure',
    errorType: 'model_not_found',
    message: '404',
  });
  await shell.refreshPool(gw);
  const v = shell.rank(gw, 'reasoning');
  assert.ok(v && v.poolReady);
  assert.equal(v.skipped.length, 1);
  assert.equal(v.skipped[0].model, 'sensenova:sensenova-u1-fast');
  assert.equal(v.skipped[0].reason, 'model_not_found');
  assert.ok(v.ranked.every((r) => r.model !== 'sensenova:sensenova-u1-fast'));
  assert.ok(['claude-opus-4-8', 'glm:glm-4v-flash'].includes(v.winner.model));
  // reasoning 偏好 T0 最强档 → opus 应压过 glm(视觉轻模型)
  assert.equal(v.winner.model, 'claude-opus-4-8');
});

test('success via recordOutcome clears the broken mark', async () => {
  const shell = freshShell();
  const gw = fakeGateway({ api: [{ id: 'glm:x' }] });
  shell.recordOutcome({ adapter: 'api', model: 'glm:x', outcome: 'failure', errorType: 'model_not_found' });
  await shell.refreshPool(gw);
  assert.equal(shell.rank(gw, 'chat').skipped.length, 1);
  shell.recordOutcome({ adapter: 'api', model: 'glm:x', outcome: 'success' });
  assert.equal(shell.rank(gw, 'chat').skipped.length, 0);
});

test('S1 observe: select+failure lines land in env-injected jsonl; divergent flagged', async () => {
  const shell = freshShell();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amr-')), 'auto-route.jsonl');
  const env = { KHY_AUTO_MODEL_OBSERVE_FILE: file };
  const gw = fakeGateway({ api: [{ id: 'glm:a' }, { id: 'glm:b' }] });
  shell.recordOutcome({ adapter: 'api', model: 'glm:a', outcome: 'failure', errorType: 'model_not_found' });
  await shell.refreshPool(gw);
  const v = shell.rank(gw, 'conversation');
  shell.observeSelection(
    {
      legacy: { adapter: 'api', model: 'glm:a' },
      taskType: 'conversation',
      ranked: v.ranked,
      skipped: v.skipped,
    },
    env
  );
  shell.observeFailure({ adapter: 'api', model: 'glm:a', errorType: 'model_not_found' }, env);
  const lines = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].ev, 'select');
  assert.equal(lines[0].divergent, true);
  assert.equal(lines[0].rec.model, 'glm:b');
  assert.equal(lines[1].ev, 'failure');
});

test('observe gate KHY_AUTO_MODEL_OBSERVE=off stops writing but not ranking', async () => {
  const shell = freshShell();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amr-off-')), 'auto-route.jsonl');
  shell.observeSelection(
    { legacy: { adapter: 'api', model: 'x' }, ranked: [], skipped: [] },
    { KHY_AUTO_MODEL_OBSERVE: 'off', KHY_AUTO_MODEL_OBSERVE_FILE: file }
  );
  assert.equal(fs.existsSync(file), false);
});

test('revive: probe-due model gets background verifyModel; success restores it', async () => {
  const shell = freshShell();
  let probed = null;
  const gw = fakeGateway({ api: [{ id: 'glm:slow' }] }, {
    verifyModel: async (adapter, model) => {
      probed = { adapter, model };
      return { status: 'verified', latencyMs: 50 };
    },
  });
  shell.recordOutcome({
    adapter: 'api',
    model: 'glm:slow',
    outcome: 'failure',
    errorType: 'model_not_found',
    // 故意用已过期的 at,使 refreshPool 内的状态立即是 probe-due
    at: Date.now() - 24 * 3600 * 1000,
  });
  await shell.refreshPool(gw);
  await new Promise((r) => setTimeout(r, 50)); // 让后台探活落地
  assert.deepEqual(probed, { adapter: 'api', model: 'glm:slow' });
  const v = shell.rank(gw, 'chat');
  assert.equal(v.skipped.length, 0, 'verified model restored to pool');
});

test('list timeout: hanging adapter keeps stale entry, never blocks the refresh', async () => {
  const shell = freshShell();
  process.env.KHY_AUTO_MODEL_LIST_TIMEOUT_MS = '500';
  try {
    const gw = fakeGateway(
      { api: [{ id: 'glm:a' }], claude: [{ id: 'claude-x' }] },
      { hang: 'claude' }
    );
    await shell.refreshPool(gw);
    const snap = shell.getSnapshot();
    assert.equal(snap.pool.api.status, 'ok');
    assert.equal(snap.pool.claude.status, 'failed');
  } finally {
    delete process.env.KHY_AUTO_MODEL_LIST_TIMEOUT_MS;
  }
});

test('stage authority: literal S1, garbage env never escalates', () => {
  const shell = freshShell();
  assert.equal(shell.KHY_AUTO_MODEL_ROUTE_STAGE, 'S1');
  assert.equal(shell.getStage({}), 'S1');
  assert.equal(shell.getStage({ KHY_AUTO_MODEL_ROUTE_STAGE: 'S4' }), 'S1');
  assert.equal(shell.getStage({ KHY_AUTO_MODEL_ROUTE_STAGE: 's3' }), 'S3');
});
