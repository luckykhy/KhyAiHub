'use strict';

// Co-located contract tests for trajectoryGuide/guideRetriever.js.
//
// guideRetriever leans on two collaborators it reaches by require:
// ../../../learningRetrieval (the hybrid RAG engine + its RAG_ENABLED gate) and
// ./mapStore (stored maps + their file paths). Both are replaced in require.cache
// with controllable stubs BEFORE the module is required, so the suite never touches
// disk, the embedding endpoint, or any real corpus. `after` restores the original
// cache entries (which here are absent, since nothing loaded them first).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const LR_PATH = require.resolve('../../../learningRetrieval');
const MS_PATH = require.resolve('./mapStore');
const SAVED_CACHE = { [LR_PATH]: require.cache[LR_PATH], [MS_PATH]: require.cache[MS_PATH] };

const STUB = {
  ragEnabled: true,
  maps: [],
  ctx: null,
  buildThrows: false,
  calls: [],
};

require.cache[LR_PATH] = {
  id: LR_PATH,
  filename: LR_PATH,
  loaded: true,
  exports: {
    get RAG_ENABLED() {
      return STUB.ragEnabled;
    },
    async buildContext(query, opts) {
      STUB.calls.push({ query, opts });
      if (STUB.buildThrows) {
        throw new Error('retrieval boom');
      }
      return STUB.ctx;
    },
  },
};
require.cache[MS_PATH] = {
  id: MS_PATH,
  filename: MS_PATH,
  loaded: true,
  exports: {
    listMaps: () => STUB.maps,
    pathFor: (id) => `fetched:${id}.map.json`,
    mapsDir: () => '/tmp/stub-maps',
    saveMap: () => '/tmp/stub-maps/x',
    readMap: () => null,
  },
};

const { findGuide, _mapIdFromSource } = require('./guideRetriever');

function resetStub(patch = {}) {
  STUB.ragEnabled = true;
  STUB.maps = [];
  STUB.ctx = null;
  STUB.buildThrows = false;
  STUB.calls = [];
  Object.assign(STUB, patch);
}

after(() => {
  for (const [path, entry] of Object.entries(SAVED_CACHE)) {
    if (entry === undefined) {
      delete require.cache[path];
    } else {
      require.cache[path] = entry;
    }
  }
});

test('_mapIdFromSource 从 fetched:<id>.map.json 还原 id，前缀可选', () => {
  assert.equal(_mapIdFromSource('fetched:abc.map.json'), 'abc');
  assert.equal(_mapIdFromSource('abc.map.json'), 'abc');
});

test('_mapIdFromSource 贪婪匹配：多段名保留内层点，双扩展名截到最后一段', () => {
  assert.equal(_mapIdFromSource('fetched:a.b.map.json'), 'a.b');
  assert.equal(_mapIdFromSource('fetched:a.map.json.map.json'), 'a.map.json');
});

test('_mapIdFromSource 非字符串 / 缺扩展名 / 扩展名不在结尾返回 null', () => {
  assert.equal(_mapIdFromSource(null), null);
  assert.equal(_mapIdFromSource(5), null);
  assert.equal(_mapIdFromSource(''), null);
  assert.equal(_mapIdFromSource('fetched:abc.json'), null);
  assert.equal(_mapIdFromSource('x.map.jsony'), null);
  // typeof guard rejects objects even when they carry a usable toString().
  assert.equal(_mapIdFromSource({ toString: () => 'fetched:z.map.json' }), null);
});

test('KNOWN-DEFECT: _mapIdFromSource 对纯扩展名 ".map.json" 返回空串（falsy 但非 null）', () => {
  // Probe: the regex `^(.*)\.map\.json$` matches with group 1 = "", so the function
  // returns "" rather than null. It only survives because findGuide later does
  // `if (!id) continue`, which happens to treat the empty string as no-match.
  assert.equal(_mapIdFromSource('fetched:.map.json'), '');
});

test('findGuide RAG 关闭时返回 null，不查 mapStore', async () => {
  resetStub({ ragEnabled: false, maps: [{ id: 'm1' }] });
  assert.equal(await findGuide('q'), null);
  assert.equal(STUB.calls.length, 0);
});

test('findGuide 无地图或地图全部缺 id 时返回 null', async () => {
  resetStub({ maps: [] });
  assert.equal(await findGuide('q'), null);
  resetStub({ maps: [null, {}, { noId: 1 }] });
  assert.equal(await findGuide('q'), null);
  assert.equal(STUB.calls.length, 0, 'extraPaths 为空时提前返回，不调 buildContext');
});

test('findGuide buildContext 抛错时静默降级为 null', async () => {
  resetStub({ maps: [{ id: 'm1' }], buildThrows: true });
  assert.equal(await findGuide('q'), null);
});

test('findGuide 上下文缺失 / chunks 非数组 / 空数组时返回 null', async () => {
  resetStub({ maps: [{ id: 'm1' }] });
  for (const ctx of [null, undefined, {}, { chunks: 'nope' }, { chunks: [] }]) {
    STUB.ctx = ctx;
    assert.equal(await findGuide('q'), null, JSON.stringify(ctx));
  }
});

test('findGuide 命中 chunk 但 id 不在 store 中时返回 null', async () => {
  resetStub({
    maps: [{ id: 'm1' }],
    ctx: { chunks: [{ source: 'fetched:ghost.map.json', score: 1 }] },
  });
  assert.equal(await findGuide('q'), null);
});

test('findGuide 命中时按 blended=retrieval*(0.5+0.5*quality) 打分', async () => {
  const map = { id: 'm1', qualityScore: 1, steps: [] };
  resetStub({ maps: [map], ctx: { chunks: [{ source: 'fetched:m1.map.json', score: 0.8 }] } });
  const r = await findGuide('部署');
  assert.equal(r.map, map);
  assert.equal(r.retrievalScore, 0.8);
  assert.ok(Math.abs(r.score - 0.8 * (0.5 + 0.5 * 1)) < 1e-9);
  assert.equal(STUB.calls[0].query, '部署');
  assert.equal(STUB.calls[0].opts.allowVector, false);
  assert.deepEqual(STUB.calls[0].opts.extraPaths, ['fetched:m1.map.json']);
});

test('findGuide qualityScore 非数字按 0 计、c.score 非数字按 0 计', async () => {
  const map = { id: 'm1', qualityScore: 'high' };
  resetStub({ maps: [map], ctx: { chunks: [{ source: 'fetched:m1.map.json', score: undefined }] } });
  const r = await findGuide('q');
  assert.equal(r.retrievalScore, 0);
  assert.equal(r.score, 0);
});

test('findGuide 多候选取 blended 最大者', async () => {
  const m1 = { id: 'm1', qualityScore: 0 };
  const m2 = { id: 'm2', qualityScore: 1 };
  resetStub({
    maps: [m1, m2],
    ctx: {
      chunks: [
        { source: 'fetched:m1.map.json', score: 0.9 }, // blended 0.9*0.5=0.45
        { source: 'fetched:m2.map.json', score: 0.7 }, // blended 0.7*1.0=0.70
      ],
    },
  });
  const r = await findGuide('q');
  assert.equal(r.map, m2);
  assert.ok(r.score > 0.45);
});

test('KNOWN-DEFECT: findGuide 平局时保留先遇到的 chunk（严格大于），后到的高 retrievalScore 不夺位', async () => {
  // blended scores tie exactly (0.5*1 == 1*0.5). The doc claims quality lets a
  // "higher-quality trajectory win ties", but the comparison is `blended > best.score`
  // (strict), so the FIRST chunk wins regardless of the second's raw retrievalScore.
  const lowQ = { id: 'm1', qualityScore: 1 };
  const highR = { id: 'm2', qualityScore: 0 };
  resetStub({
    maps: [lowQ, highR],
    ctx: {
      chunks: [
        { source: 'fetched:m1.map.json', score: 0.5 }, // blended 0.5
        { source: 'fetched:m2.map.json', score: 1.0 }, // blended 0.5 -> tie, ignored
      ],
    },
  });
  const r = await findGuide('q');
  assert.equal(r.map, lowQ);
  assert.equal(r.retrievalScore, 0.5);
});

test('KNOWN-DEFECT: qualityScore 未被钳制在 [0,1]，docstring 承诺的 [0.5,1.0] 先验区间失守', async () => {
  // Docstring: "quality acts as a multiplicative prior in [0.5, 1.0]". Probe shows the
  // multiplier 0.5+0.5*quality is computed straight off the stored number with NO clamp,
  // so qualityScore>1 boosts blended ABOVE the raw retrieval score, and a negative
  // qualityScore drags it below zero.
  const boosted = { id: 'm1', qualityScore: 3 };
  resetStub({ maps: [boosted], ctx: { chunks: [{ source: 'fetched:m1.map.json', score: 1 }] } });
  assert.equal((await findGuide('q')).score, 1 * (0.5 + 0.5 * 3)); // 2.0 > retrieval score 1

  const negative = { id: 'm2', qualityScore: -1 };
  resetStub({ maps: [negative], ctx: { chunks: [{ source: 'fetched:m2.map.json', score: 1 }] } });
  assert.equal((await findGuide('q')).score, 1 * (0.5 + 0.5 * -1)); // 0.0
});

test('findGuide 透传 allowVector=true 给 buildContext', async () => {
  const map = { id: 'm1', qualityScore: 0 };
  resetStub({ maps: [map], ctx: { chunks: [{ source: 'fetched:m1.map.json', score: 0.2 }] } });
  await findGuide('q', { allowVector: true });
  assert.equal(STUB.calls[0].opts.allowVector, true);
  assert.deepEqual(STUB.calls[0].opts.extraPaths, ['fetched:m1.map.json']);
});
