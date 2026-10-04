'use strict';

/**
 * forgeryBuilders.test.js — co-located suite for adversarial envelope builders (pure leaf).
 *
 * IO: none — the furnace handle is injected per call; nothing is required from the host.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   FB-E1  an unknown mode returns a bare `{ payload }` envelope lacking the
 *          sealed/seal/brand keys that every other branch emits.
 *   FB-E2  a null payload throws TypeError on `payload.mode` — no guard.
 *   FB-E3  in 'tamper' mode a throwing furnace.intercept is swallowed by the bare
 *          `catch {}` and the builder silently degrades to the fake-seal fallback.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { _buildForgery } = require('./forgeryBuilders');

const BRAND = '__khySeal';

function makeFurnace(intercept) {
  return { SEAL_BRAND: BRAND, intercept };
}

describe('_buildForgery — 敌对信封构造', () => {
  it('bare 模式：sealed 但无品牌键，seal 固定 whatever', () => {
    const env = _buildForgery(makeFurnace(() => null), { mode: 'bare', payload: { a: 1 } });
    assert.deepEqual(env, { sealed: true, payload: { a: 1 }, seal: 'whatever' });
    assert.equal(env[BRAND], undefined);
  });

  it('fake-brand 模式：带品牌键，未给 seal 时用 deadbeef×8 兜底', () => {
    const env = _buildForgery(makeFurnace(() => null), { mode: 'fake-brand', payload: { b: 2 } });
    assert.equal(env[BRAND], true);
    assert.equal(env.sealed, true);
    assert.deepEqual(env.payload, { b: 2 });
    assert.equal(env.seal, 'deadbeef'.repeat(8));
    assert.equal(env.seal.length, 64);
  });

  it('fake-brand 模式：显式 seal 原样透传（含空串走 || 兜底）', () => {
    const given = _buildForgery(makeFurnace(() => null), { mode: 'fake-brand', seal: 'abc', payload: {} });
    assert.equal(given.seal, 'abc');
    const empty = _buildForgery(makeFurnace(() => null), { mode: 'fake-brand', seal: '', payload: {} });
    assert.equal(empty.seal, 'deadbeef'.repeat(8));
  });

  it('tamper 模式：真封印信封的 payload 被 tamperWith 覆盖、seal 沿用旧的', () => {
    const calls = [];
    const furnace = makeFurnace((text, opts) => {
      calls.push([text, opts]);
      return { payload: { kind: 'ActionIntent', level: 'L0', text: 'orig' }, seal: 'realseal' };
    });
    const env = _buildForgery(furnace, { mode: 'tamper', tamperWith: { level: 'L9' } });
    assert.deepEqual(calls, [['打开文件 report.txt 并总结其要点', { forceLevel: 'L0' }]]);
    assert.equal(env[BRAND], true);
    assert.equal(env.seal, 'realseal');
    assert.deepEqual(env.payload, { kind: 'ActionIntent', level: 'L9', text: 'orig' });
  });

  it('tamper 模式：intercept 返回无 payload 时降级为 00×16 假 seal', () => {
    const furnace = makeFurnace(() => ({ seal: 'x' }));
    const env = _buildForgery(furnace, { mode: 'tamper', tamperWith: { evil: true } });
    assert.equal(env.seal, '00'.repeat(16));
    assert.deepEqual(env.payload, { kind: 'ActionIntent', evil: true });
    assert.equal(env[BRAND], true);
  });

  it('tamper 模式：无 tamperWith 时兜底 payload 只剩 kind 字段', () => {
    const furnace = makeFurnace(() => { throw new Error('boom'); });
    const env = _buildForgery(furnace, { mode: 'tamper' });
    assert.deepEqual(env.payload, { kind: 'ActionIntent' });
    assert.equal(env.seal, '00'.repeat(16));
  });

  it('furnace 缺 SEAL_BRAND 时品牌键落在 undefined 上（键名字符串化）', () => {
    const env = _buildForgery({ intercept: () => null }, { mode: 'fake-brand', seal: 's' });
    assert.equal(env.undefined, true);
    assert.equal(env.seal, 's');
  });

  it('KNOWN-DEFECT: FB-E1 未知 mode 返回缺 sealed/seal/品牌键的异形信封', () => {
    // measured: mode 'weird' → { payload: {...} } only; mode undefined + no payload → { payload: {} }
    const known = _buildForgery(makeFurnace(() => null), { mode: 'weird', payload: { z: 1 } });
    assert.deepEqual(known, { payload: { z: 1 } });
    const empty = _buildForgery(makeFurnace(() => null), {});
    assert.deepEqual(empty, { payload: {} });
  });

  it('KNOWN-DEFECT: FB-E2 payload 传 null 直接抛 TypeError（读取 mode）', () => {
    // measured: _buildForgery(furnace, null) → TypeError: Cannot read properties of null (reading 'mode')
    assert.throws(
      () => _buildForgery(makeFurnace(() => null), null),
      { name: 'TypeError', message: /Cannot read properties of null \(reading 'mode'\)/ }
    );
  });

  it('KNOWN-DEFECT: FB-E3 intercept 抛错被静默吞掉并降级，调用方无从知晓', () => {
    // measured: throwing intercept → same fake-seal envelope as the no-payload branch
    const furnace = makeFurnace(() => { throw new Error('exploded'); });
    const env = _buildForgery(furnace, { mode: 'tamper', tamperWith: { k: 1 } });
    assert.equal(env.seal, '00'.repeat(16));
    assert.equal(env.payload.k, 1);
  });
});
