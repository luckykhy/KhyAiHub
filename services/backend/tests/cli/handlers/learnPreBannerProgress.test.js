'use strict';
/**
 * learn.js pre-banner progress contract (轮二十八, Rule 2/2.6).
 * `learn next` used to emit nothing until the mode banner, after a TTL-gated dynamic
 * overlay refresh (scan + up to 2 model calls) and, in mode 2, a per-file remote fetch.
 * Proves: stale overlay announces BEFORE the refresh await; fresh overlay stays silent
 * (no noise on the fast path); mode-2 fetch announces before fetchMissingForTopic;
 * and the service-side isOverlayFresh ⟺ maybeRefreshDynamic('fresh') contract holds.
 *
 * RUN WITH `node --test` — require.cache injection does NOT work under jest.
 * All cache keys MUST carry the `.js` extension or eviction/injection silently no-ops.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');
const LEAF = path.join(SRC, 'cli', 'handlers', 'learn.js');
const FORMATTERS = path.join(SRC, 'cli', 'formatters.js');
const AI = path.join(SRC, 'cli', 'ai.js');
const DYN = path.join(SRC, 'services', 'learningCurriculumDynamic.js');
const RET = path.join(SRC, 'services', 'learningRetrieval.js');
const PROFILE = path.join(SRC, 'services', 'learningProfile.js');
const CURRICULUM = path.join(SRC, 'services', 'learningCurriculum.js');

const dyn = require(DYN);
const ret = require(RET);
const profile = require(PROFILE);

function aiStub(withModel) {
  const fn = () => ({
    chat: async () => ({ reply: '' }),
    getActiveProvider: () => (withModel ? 'API 云端服务 (api) · m' : null),
    getAiStatus: () => (withModel ? { available: true, provider: 'x' } : { available: false }),
  });
  return { id: AI, filename: AI, loaded: true, exports: fn };
}

async function runScenario({ withModel, overlayFresh }) {
  const events = [];
  const saved = {
    en: dyn.isDynamicEnabled, fr: dyn.isOverlayFresh, rf: dyn.maybeRefreshDynamic,
    emb: ret.isEmbeddingReachable, docs: ret.isDocsRemoteReachable,
    bc: ret.buildContext, fm: ret.fetchMissingForTopic,
    lvl: profile.getLevel,
    info: require(FORMATTERS).printInfo,
  };
  dyn.isDynamicEnabled = () => true;
  dyn.isOverlayFresh = () => { events.push('check-fresh'); return overlayFresh; };
  dyn.maybeRefreshDynamic = async () => { events.push('refresh:ran'); return { ok: true }; };
  ret.isEmbeddingReachable = async () => false;
  ret.isDocsRemoteReachable = async () => !withModel;
  ret.buildContext = async () => { events.push('buildContext:ran'); return { chunks: [], text: '', usedVector: false }; };
  ret.fetchMissingForTopic = async () => { events.push('fetch:ran'); return []; };
  profile.getLevel = () => 'L1';
  require(FORMATTERS).printInfo = (msg) => events.push(`info:${String(msg).slice(0, 24)}`);

  require.cache[AI] = aiStub(withModel);
  const curriculumFake = new Proxy({
    getNextTopic: () => ({ layer: { id: 1, title: 'L', summary: '' }, topic: { id: 't1', title: 'T', desc: '' } }),
    markTopicViewed: () => {},
    formatTopicDetailRich: () => 'DETAIL',
    buildSimpleLayerPrompt: () => 'P',
    buildLayerOverviewPrompt: () => 'P',
    buildTopicPrompt: () => 'P',
    getProgress: () => ({}),
  }, { get: (t, k) => (k in t ? t[k] : () => '') });
  require.cache[CURRICULUM] = { id: CURRICULUM, filename: CURRICULUM, loaded: true, exports: curriculumFake };
  delete require.cache[LEAF];

  const origLog = console.log;
  console.log = (...a) => {
    const s = String(a[0] || '');
    if (s.includes('模式') || s.includes('DETAIL')) events.push('BANNER/RENDER');
  };
  try {
    const learn = require(LEAF);
    await Promise.race([
      learn.handleLearn('next', []),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  } catch { /* deep render paths are irrelevant to the ordering contract */ } finally {
    console.log = origLog;
    delete require.cache[LEAF];
    delete require.cache[AI];
    delete require.cache[CURRICULUM];
    Object.assign(dyn, { isDynamicEnabled: saved.en, isOverlayFresh: saved.fr, maybeRefreshDynamic: saved.rf });
    Object.assign(ret, { isEmbeddingReachable: saved.emb, isDocsRemoteReachable: saved.docs, buildContext: saved.bc, fetchMissingForTopic: saved.fm });
    profile.getLevel = saved.lvl;
    require(FORMATTERS).printInfo = saved.info;
  }
  return events;
}

const idx = (evs, needle) => evs.findIndex((e) => e.includes(needle));

test('stale overlay + mode3: announce precedes refresh await precedes banner', async () => {
  const evs = await runScenario({ withModel: true, overlayFresh: false });
  assert.ok(idx(evs, '模式') >= 0 || idx(evs, 'BANNER') >= 0, `banner must be reached: ${evs.join('|')}`);
  const info = idx(evs, 'info:刷新动态知识点覆盖层');
  assert.ok(info >= 0, `announce missing: ${evs.join('|')}`);
  assert.ok(info < idx(evs, 'refresh:ran'), 'announce must come BEFORE the refresh await');
  assert.ok(idx(evs, 'refresh:ran') < idx(evs, 'BANNER'), 'refresh must complete before banner render');
  assert.strictEqual(idx(evs, 'info:补取'), -1, 'mode3 must not announce the mode2 fetch');
});

test('fresh overlay: fast path stays silent', async () => {
  const evs = await runScenario({ withModel: true, overlayFresh: true });
  assert.strictEqual(idx(evs, 'info:刷新动态知识点覆盖层'), -1, `fast path must not announce: ${evs.join('|')}`);
  assert.ok(idx(evs, 'BANNER') >= 0, 'banner must still render (non-vacuous)');
});

test('mode2 stale: refresh announce then fetch announce before fetch', async () => {
  const evs = await runScenario({ withModel: false, overlayFresh: false });
  assert.ok(idx(evs, 'info:刷新动态知识点覆盖层') >= 0);
  const fetchInfo = idx(evs, 'info:补取本知识点缺失的远端');
  assert.ok(fetchInfo >= 0, `fetch announce missing: ${evs.join('|')}`);
  assert.ok(fetchInfo < idx(evs, 'fetch:ran'), 'fetch announce must precede the await');
});

test('mode2 fresh: no refresh noise, fetch announce still present', async () => {
  const evs = await runScenario({ withModel: false, overlayFresh: true });
  assert.strictEqual(idx(evs, 'info:刷新动态知识点覆盖层'), -1);
  assert.ok(idx(evs, 'info:补取本知识点缺失的远端') >= 0, `fetch announce must stay: ${evs.join('|')}`);
});

test('service contract: isOverlayFresh agrees with maybeRefreshDynamic fresh short-circuit', async () => {
  const savedTtl = process.env.KHY_LEARN_DYNAMIC_TTL_MS;
  const savedLog = console.log; console.log = () => {};
  let created = false;
  try {
    dyn.clearOverlay();
    assert.strictEqual(dyn.isOverlayFresh(), false, 'no overlay ⇒ not fresh');
    await dyn.refreshDynamic({ useNetwork: false, useModel: false });
    created = !!dyn.loadOverlay().generatedAt;
    assert.ok(created, 'scan-only refresh should write an overlay on this machine');
    process.env.KHY_LEARN_DYNAMIC_TTL_MS = '3600000';
    assert.strictEqual(dyn.isOverlayFresh(), true, 'fresh overlay ⇒ fresh');
    const r = await dyn.maybeRefreshDynamic({ useNetwork: false, useModel: false });
    assert.strictEqual(r.skipped, true, 'maybeRefreshDynamic must short-circuit iff fresh');
    assert.strictEqual(r.reason, 'fresh');
    process.env.KHY_LEARN_DYNAMIC_TTL_MS = '1';
    assert.strictEqual(dyn.isOverlayFresh(), false, 'TTL expiry ⇒ not fresh');
  } finally {
    console.log = savedLog;
    if (savedTtl === undefined) delete process.env.KHY_LEARN_DYNAMIC_TTL_MS;
    else process.env.KHY_LEARN_DYNAMIC_TTL_MS = savedTtl;
    if (created) { dyn.clearOverlay(); require('node:fs'); }
  }
});
