'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// config.js resolves the policy path via utils/dataHome (lazy require inside
// getPolicyPath). We point it at a temp dir so no repo path is ever written.
const dataHomePath = require.resolve('../../../../utils/dataHome');
const originalDataHome = require.cache[dataHomePath];

let TMP;
let cfg;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-permcfg-'));
  require.cache[dataHomePath] = {
    id: dataHomePath,
    filename: dataHomePath,
    loaded: true,
    exports: { getDataHome: () => TMP },
    paths: [],
  };
  cfg = require('./config');
});

after(() => {
  delete require.cache[require.resolve('./config')];
  if (originalDataHome) require.cache[dataHomePath] = originalDataHome;
  else delete require.cache[dataHomePath];
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  for (const f of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, f), { recursive: true, force: true });
});

describe('config — defaultPolicy', () => {
  test('默认策略为 confirm（最保守），白名单皆空', () => {
    const p = cfg.defaultPolicy();
    assert.equal(p.version, 1);
    assert.equal(p.defaultPolicy, 'confirm');
    assert.deepStrictEqual(p.tools, {});
    assert.deepStrictEqual(p.filesystem.pathWhitelist, []);
    assert.deepStrictEqual(p.network.urlWhitelist, []);
    assert.deepStrictEqual(p.codeExecution.limits, { cpuSeconds: 0, memoryMb: 0, timeoutMs: 0 });
    assert.ok(p.sensitiveOperations.requireConfirm.includes('git push'));
  });
  test('每次返回全新对象，改其一不污染其二（无活引用共享）', () => {
    const a = cfg.defaultPolicy();
    const b = cfg.defaultPolicy();
    a.filesystem.pathWhitelist.push('X');
    a.sensitiveOperations.requireConfirm.push('ZZZ');
    assert.deepStrictEqual(b.filesystem.pathWhitelist, []);
    assert.equal(b.sensitiveOperations.requireConfirm.includes('ZZZ'), false);
  });
});

describe('config — normalizeStrategy', () => {
  test('合法值 trim+小写归一', () => {
    assert.equal(cfg.normalizeStrategy(' AUTO '), 'auto');
    assert.equal(cfg.normalizeStrategy('Deny'), 'deny');
    assert.equal(cfg.normalizeStrategy('confirm'), 'confirm');
  });
  test('非法/垃圾 → null', () => {
    for (const bad of ['allow', 'approve', '', null, undefined, 0, {}, 'DENYTYP']) {
      assert.equal(cfg.normalizeStrategy(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('config — _merge', () => {
  test('对象递归合并；数组与标量整体替换', () => {
    const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2, 3] };
    const out = cfg._merge(base, { nested: { y: 9 }, list: [9] });
    assert.equal(out.a, 1);
    assert.equal(out.nested.x, 1);
    assert.equal(out.nested.y, 9);
    assert.deepStrictEqual(out.list, [9]);
  });
  test('undefined override 保留 base；null 覆盖', () => {
    assert.equal(cfg._merge({ a: 1 }, {}).a, 1);
    assert.equal(cfg._merge(5, undefined), 5);
    assert.equal(cfg._merge(5, null), null);
  });
  test('数组 base 被 override 替换', () => {
    assert.deepStrictEqual(cfg._merge([1, 2], [3]), [3]);
  });
});

describe('config — 路径与存在性', () => {
  test('getPolicyPath 落在 dataHome/permissions.json 且在临时目录内', () => {
    const p = cfg.getPolicyPath();
    assert.equal(p, path.join(TMP, 'permissions.json'));
    assert.ok(p.startsWith(TMP));
  });
  test('policyExists 反映磁盘有无', () => {
    assert.equal(cfg.policyExists(), false);
    fs.writeFileSync(cfg.getPolicyPath(), '{}');
    assert.equal(cfg.policyExists(), true);
  });
});

describe('config — loadPolicy', () => {
  test('无文件 → null（未选入即 no-op）', () => {
    assert.equal(cfg.loadPolicy(), null);
  });
  test('损坏 JSON / 非对象 / 数组 → null（fail-closed）', () => {
    fs.writeFileSync(cfg.getPolicyPath(), '{ broken');
    assert.equal(cfg.loadPolicy(), null);
    fs.writeFileSync(cfg.getPolicyPath(), '[1,2]');
    assert.equal(cfg.loadPolicy(), null);
    fs.writeFileSync(cfg.getPolicyPath(), '"str"');
    assert.equal(cfg.loadPolicy(), null);
  });
  test('部分文件深合并到默认，缺字段被补全', () => {
    fs.writeFileSync(cfg.getPolicyPath(), JSON.stringify({ defaultPolicy: 'auto' }));
    const p = cfg.loadPolicy();
    assert.equal(p.defaultPolicy, 'auto');
    assert.equal(p.version, 1);
    assert.ok(Array.isArray(p.filesystem.pathWhitelist));
    assert.ok(p.sensitiveOperations.requireConfirm.length > 0);
  });
  test('数组字段整体替换而非逐项追加', () => {
    fs.writeFileSync(cfg.getPolicyPath(), JSON.stringify({ sensitiveOperations: { requireConfirm: ['only'] } }));
    const p = cfg.loadPolicy();
    assert.deepStrictEqual(p.sensitiveOperations.requireConfirm, ['only']);
  });
});

describe('config — savePolicy / ensurePolicy', () => {
  test('savePolicy 合并默认后落盘，可被 loadPolicy 读回', () => {
    const r = cfg.savePolicy({ defaultPolicy: 'deny' });
    assert.equal(r.success, true);
    assert.equal(r.path, cfg.getPolicyPath());
    const p = cfg.loadPolicy();
    assert.equal(p.defaultPolicy, 'deny');
    assert.equal(p.version, 1);
  });
  test('savePolicy(null) 落保守默认', () => {
    cfg.savePolicy(null);
    assert.equal(cfg.loadPolicy().defaultPolicy, 'confirm');
  });
  test('ensurePolicy：缺文件时脚手架默认并返回', () => {
    assert.equal(cfg.policyExists(), false);
    const p = cfg.ensurePolicy();
    assert.equal(cfg.policyExists(), true);
    assert.equal(p.defaultPolicy, 'confirm');
  });
  test('KNOWN-DEFECT: savePolicy 遇不可写路径返回 error 但 ensurePolicy 随后仍返回内存默认（掩盖落盘失败）', () => {
    // Point dataHome at a path whose parent is a file so mkdirSync throws.
    const bogusFile = path.join(TMP, 'blocker');
    fs.writeFileSync(bogusFile, 'x');
    const savedDir = require.cache[dataHomePath].exports.getDataHome;
    require.cache[dataHomePath].exports.getDataHome = () => path.join(bogusFile, 'sub');
    const r = cfg.savePolicy({ defaultPolicy: 'auto' });
    assert.equal(r.success, false);
    // ensurePolicy: policyExists()→false → tries savePolicy (fails, ignored) →
    // loadPolicy()→null → returns defaultPolicy() in memory. The write failure
    // is silently swallowed; caller cannot tell persistence failed.
    const ensured = cfg.ensurePolicy();
    assert.equal(ensured.defaultPolicy, 'confirm');
    assert.equal(cfg.policyExists(), false);
    require.cache[dataHomePath].exports.getDataHome = savedDir;
  });
});
