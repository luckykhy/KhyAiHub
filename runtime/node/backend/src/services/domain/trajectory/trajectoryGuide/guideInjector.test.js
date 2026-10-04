'use strict';

// Co-located contract tests for trajectoryGuide/guideInjector.js.
//
// The module reaches three collaborators: ./config (env gate), ./guideRetriever
// (async map lookup) and ../../security/marshal/capabilityVector (weak/strong
// verdict). To keep the suite hermetic — no disk, no AI gateway, no real model
// tier table — capabilityVector and guideRetriever are replaced in require.cache
// with controllable stubs BEFORE guideInjector is required; originals are restored
// in `after`. config is left real but its gate/char env keys are snapshotted and
// restored so ambient CI env cannot flip the outcome.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = ['KHY_TRAJ_GUIDE_INJECT', 'KHY_TRAJ_GUIDE_CHARS'];
const SAVED_ENV = {};
for (const k of ENV_KEYS) {
  SAVED_ENV[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
}

const CV_PATH = require.resolve('../../security/marshal/capabilityVector');
const GR_PATH = require.resolve('./guideRetriever');
const SAVED_CACHE = { [CV_PATH]: require.cache[CV_PATH], [GR_PATH]: require.cache[GR_PATH] };

const STUB = {
  strength: 'weak',
  assessThrows: false,
  guide: null,
  retrieverThrows: false,
  retrieverCalls: [],
};

require.cache[CV_PATH] = {
  id: CV_PATH,
  filename: CV_PATH,
  loaded: true,
  exports: {
    assess() {
      if (STUB.assessThrows) {
        throw new Error('assess boom');
      }
      return { strength: STUB.strength, tier: 'T3', vector: {}, score: 0, modelId: 'stub' };
    },
  },
};
require.cache[GR_PATH] = {
  id: GR_PATH,
  filename: GR_PATH,
  loaded: true,
  exports: {
    async findGuide(query, opts) {
      STUB.retrieverCalls.push({ query, opts });
      if (STUB.retrieverThrows) {
        throw new Error('retriever boom');
      }
      return STUB.guide;
    },
    _mapIdFromSource() {
      return null;
    },
  },
};

const { buildGuideBlock, _renderBlock } = require('./guideInjector');

function setGate(on) {
  if (on) {
    process.env.KHY_TRAJ_GUIDE_INJECT = '1';
  } else {
    delete process.env.KHY_TRAJ_GUIDE_INJECT;
  }
  process.env.KHY_TRAJ_GUIDE_CHARS = '4000';
  STUB.strength = 'weak';
  STUB.assessThrows = false;
  STUB.guide = null;
  STUB.retrieverThrows = false;
  STUB.retrieverCalls = [];
}

after(() => {
  for (const [path, entry] of Object.entries(SAVED_CACHE)) {
    if (entry === undefined) {
      delete require.cache[path];
    } else {
      require.cache[path] = entry;
    }
  }
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = SAVED_ENV[k];
    }
  }
});

test('_renderBlock 无步骤时只渲染头部模板', () => {
  const block = _renderBlock({ task: '登录', steps: [] }, 4000);
  assert.ok(block.startsWith('# Recommended Path'));
  assert.ok(block.includes('"登录"'));
  assert.ok(block.includes('You MAY follow'));
});

test('_renderBlock NETWORK_AI 步骤追加非确定性提示，其余步骤不加', () => {
  const block = _renderBlock({
    task: 't',
    steps: [
      { seq: 0, intent: 'read' },
      { seq: 1, intent: 'call model', tier: 'NETWORK_AI' },
    ],
  }, 4000);
  assert.ok(block.includes('1. read'));
  assert.ok(block.includes('2. call model  (non-deterministic — use judgement)'));
  assert.ok(!block.includes('1. read  (non-deterministic'));
});

test('_renderBlock seq 缺省按 0 计，序号从 1 起', () => {
  const block = _renderBlock({ task: 't', steps: [{ intent: 'X' }, { seq: 4, intent: 'Y' }] }, 4000);
  assert.ok(block.includes('1. X'));
  assert.ok(block.includes('5. Y'));
});

test('_renderBlock steps 非数组（缺失/对象/字符串）当作无步骤', () => {
  for (const bad of [undefined, {}, 'notarray', null]) {
    const block = _renderBlock({ task: 't', steps: bad }, 4000);
    assert.ok(block.includes('# Recommended Path'));
    assert.ok(!block.includes('non-deterministic'));
  }
});

test('buildGuideBlock 门控关闭时直接返回 null，不触碰检索', async () => {
  setGate(false);
  delete process.env.KHY_TRAJ_GUIDE_INJECT;
  const r = await buildGuideBlock({ userMessage: 'x', modelId: 'm' });
  assert.equal(r, null);
  assert.equal(STUB.retrieverCalls.length, 0);
});

test('buildGuideBlock 门控开启但缺 userMessage 或 modelId 返回 null', async () => {
  setGate(true);
  assert.equal(await buildGuideBlock({ modelId: 'm' }), null);
  assert.equal(await buildGuideBlock({ userMessage: 'x' }), null);
  assert.equal(await buildGuideBlock({}), null);
});

test('buildGuideBlock 强模型不消费地图，检索不被调用', async () => {
  setGate(true);
  STUB.strength = 'strong';
  const r = await buildGuideBlock({ userMessage: 'x', modelId: 'm' });
  assert.equal(r, null);
  assert.equal(STUB.retrieverCalls.length, 0);
});

test('buildGuideBlock assess 抛错时收敛为 null', async () => {
  setGate(true);
  STUB.assessThrows = true;
  assert.equal(await buildGuideBlock({ userMessage: 'x', modelId: 'm' }), null);
});

test('buildGuideBlock 检索抛错时 best-effort 返回 null', async () => {
  setGate(true);
  STUB.retrieverThrows = true;
  assert.equal(await buildGuideBlock({ userMessage: 'x', modelId: 'm' }), null);
});

test('buildGuideBlock 检索无结果 / 无 map 时返回 null', async () => {
  setGate(true);
  STUB.guide = null;
  assert.equal(await buildGuideBlock({ userMessage: 'x', modelId: 'm' }), null);
  STUB.guide = { map: null, score: 1 };
  assert.equal(await buildGuideBlock({ userMessage: 'x', modelId: 'm' }), null);
});

test('buildGuideBlock 弱模型命中地图时渲染推荐路径块并透传 allowVector', async () => {
  setGate(true);
  STUB.guide = { map: { task: '部署', steps: [{ seq: 0, intent: 'build' }] } };
  const r = await buildGuideBlock({ userMessage: '  帮我部署  ', modelId: 'weak-1', allowVector: true });
  assert.ok(r.includes('"部署"'));
  assert.ok(r.includes('1. build'));
  assert.equal(STUB.retrieverCalls.length, 1);
  assert.equal(STUB.retrieverCalls[0].query, '  帮我部署  ');
  assert.deepEqual(STUB.retrieverCalls[0].opts, { allowVector: true });
});

test('buildGuideBlock allowVector 缺省被强制成布尔 false 传入检索', async () => {
  setGate(true);
  STUB.guide = { map: { task: 't', steps: [] } };
  await buildGuideBlock({ userMessage: 'x', modelId: 'm' });
  assert.deepEqual(STUB.retrieverCalls[0].opts, { allowVector: false });
});

test('KNOWN-DEFECT: buildGuideBlock(null) 在门控开启时 reject，违反「绝不破坏本轮」', () => {
  // Probe: default `args = {}` only guards undefined; null slips past and
  // `const { userMessage } = args` throws. Since buildGuideBlock is async this
  // surfaces as a rejected promise (not a null), breaking the best-effort contract.
  setGate(true);
  return assert.rejects(() => buildGuideBlock(null), TypeError);
});

test('KNOWN-DEFECT: 地图 steps 含 null 元素时 _renderBlock 抛错，buildGuideBlock 随之 reject', async () => {
  // Probe: `for (const s of steps)` then `s.tier` on a null entry throws TypeError.
  // _renderBlock runs OUTSIDE buildGuideBlock's try/catch (that only wraps the
  // retriever call), so a stored map with a corrupt step crashes the turn instead
  // of returning null.
  assert.throws(() => _renderBlock({ task: 't', steps: [null] }, 4000), TypeError);
  setGate(true);
  STUB.guide = { map: { task: 't', steps: [null] } };
  await assert.rejects(() => buildGuideBlock({ userMessage: 'x', modelId: 'm' }), TypeError);
});

test('KNOWN-DEFECT: budgetChars 只约束后续步骤，头部与首步永不裁剪，返回块可远超预算', () => {
  // Probe: with budgetChars=5 the fixed header (~300 chars) plus the first step are
  // still emitted before the guard can fire, so the block length dwarfs the budget.
  const block = _renderBlock({
    task: 't',
    steps: [{ seq: 0, intent: 'AAA' }, { seq: 1, intent: 'BBB' }],
  }, 5);
  assert.ok(block.includes('1. AAA'));
  assert.ok(block.includes('2. BBB') === false);
  assert.ok(block.includes('path truncated'));
  assert.ok(block.length > 5, 'header + first step are never counted against the budget');
});
