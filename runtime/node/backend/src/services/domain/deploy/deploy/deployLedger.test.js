'use strict';

// Co-located tests for deployLedger.js. All filesystem access is injected via
// deps and pinned to an os.tmpdir() sandbox; defaultDeps is exercised with
// utils/dataHome stubbed through require.cache so the ledger never targets a
// real data home inside this suite.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const fs = require('fs');
const path = require('path');

const ledger = require('./deployLedger');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-ledger-'));
const dataHomeId = require.resolve('../../../../utils/dataHome');
const origDataHomeEntry = require.cache[dataHomeId];

after(() => {
  if (origDataHomeEntry === undefined) delete require.cache[dataHomeId]; else require.cache[dataHomeId] = origDataHomeEntry;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp sandbox */ }
});

function makeDeps(dirName = 'dir') {
  const dir = path.join(tmp, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const alive = new Set();
  return {
    dir,
    deps: {
      fs,
      dir: () => dir,
      now: () => '2026-01-02T03:04:05.000Z',
      isAlive: (pid) => alive.has(pid),
      alive,
    },
  };
}

const rec = (over = {}) => ({
  name: 'app', source: '/src/app', target: '/deploy/app', type: 'node',
  startCmd: 'npm start', pid: 1234, port: 3000, logFile: '/deploy/app/x.log',
  status: 'deployed', ...over,
});

describe('load / save', () => {
  test('账本文件不存在/JSON 损坏/顶层不是数组时一律读成空表', () => {
    const a = makeDeps('empty');
    assert.deepEqual(ledger.load(a.deps), []);
    fs.writeFileSync(path.join(a.dir, 'ledger.json'), '{broken');
    assert.deepEqual(ledger.load(a.deps), [], 'corrupt ledger must heal as empty, never crash');
    fs.writeFileSync(path.join(a.dir, 'ledger.json'), JSON.stringify({ not: 'array' }));
    assert.deepEqual(ledger.load(a.deps), []);
  });

  test('save 写 pretty JSON 并返回落盘路径，load 原样读回', () => {
    const b = makeDeps('roundtrip');
    const p = ledger.save([rec()], b.deps);
    assert.equal(p, path.join(b.dir, 'ledger.json'));
    assert.ok(fs.readFileSync(p, 'utf8').includes('\n  {'));
    assert.deepEqual(ledger.load(b.deps), [rec()]);
  });
});

describe('upsert / get / remove', () => {
  test('首次 upsert 插入完整记录并盖 updatedAt', () => {
    const c = makeDeps('upsert1');
    const merged = ledger.upsert(rec(), c.deps);
    assert.equal(merged.updatedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(ledger.get('app', c.deps).pid, 1234);
  });

  test('同名 upsert 逐字段合并（旧字段保留、新字段覆盖）', () => {
    const d = makeDeps('upsert2');
    ledger.upsert(rec({ port: null, logFile: null }), d.deps);
    const merged = ledger.upsert({ name: 'app', pid: 999, status: 'running' }, d.deps);
    assert.equal(merged.source, '/src/app', 'fields absent from the patch survive the merge');
    assert.equal(merged.pid, 999);
    assert.equal(merged.status, 'running');
    assert.equal(ledger.load(d.deps).length, 1);
  });

  test('get 缺失返回 null；remove 命中 true / 未命中 false 且都回写', () => {
    const e = makeDeps('remove');
    assert.equal(ledger.get('ghost', e.deps), null);
    ledger.upsert(rec({ name: 'a' }), e.deps);
    ledger.upsert(rec({ name: 'b' }), e.deps);
    assert.equal(ledger.remove('a', e.deps), true);
    assert.equal(ledger.remove('a', e.deps), false);
    assert.deepEqual(ledger.load(e.deps).map((r) => r.name), ['b']);
  });

  test('remove 未命中也会重写文件（现存记录原样保留）', () => {
    const f = makeDeps('remove2');
    ledger.upsert(rec({ name: 'keep' }), f.deps);
    const before = fs.readFileSync(path.join(f.dir, 'ledger.json'), 'utf8');
    ledger.remove('ghost', f.deps);
    const after = JSON.parse(fs.readFileSync(path.join(f.dir, 'ledger.json'), 'utf8'));
    assert.deepEqual(after.map((r) => r.name), ['keep']);
    assert.ok(before.includes('keep'));
  });
});

describe('listReconciled', () => {
  test('running 且进程已死 → 报告 exited（只改返回副本，不落盘）', () => {
    const g = makeDeps('reconcile1');
    ledger.upsert(rec({ name: 'dead', status: 'running', pid: 111 }), g.deps);
    ledger.upsert(rec({ name: 'alive', status: 'running', pid: 222 }), g.deps);
    g.deps.alive.add(222);
    const list = ledger.listReconciled(g.deps);
    const dead = list.find((r) => r.name === 'dead');
    const live = list.find((r) => r.name === 'alive');
    assert.equal(dead.status, 'exited');
    assert.equal(live.status, 'running');
    assert.deepEqual(ledger.load(g.deps).find((r) => r.name === 'dead').status, 'running', 'reconcile must not rewrite disk');
  });

  test('非 running 状态原样透传，isAlive 不被调用', () => {
    const h = makeDeps('reconcile2');
    let calls = 0;
    h.deps.isAlive = () => { calls += 1; return false; };
    ledger.upsert(rec({ name: 'x', status: 'stopped', pid: 5 }), h.deps);
    const out = ledger.listReconciled(h.deps);
    assert.equal(out[0].status, 'stopped');
    assert.equal(calls, 0);
  });

  test('running 且 pid 为 null 视为 exited', () => {
    const i = makeDeps('reconcile3');
    i.deps.alive = new Set();
    // isAlive(null) via deps stub: Set has no null → false → exited.
    ledger.upsert(rec({ name: 'nopid', status: 'running', pid: null }), i.deps);
    assert.equal(ledger.listReconciled(i.deps)[0].status, 'exited');
  });
});

describe('ledgerPath / defaultDeps', () => {
  test('ledgerPath 是 dir() 下的 ledger.json', () => {
    const j = makeDeps('lpath');
    assert.equal(ledger.ledgerPath(j.deps), path.join(j.dir, 'ledger.json'));
  });

  test('defaultDeps 经 stub 的 dataHome 指向 tmp，load 不崩', () => {
    const k = makeDeps('default1');
    require.cache[dataHomeId] = {
      id: dataHomeId, filename: dataHomeId, loaded: true,
      exports: { getDataDir: () => k.dir },
    };
    const deps = ledger.defaultDeps();
    assert.equal(deps.dir(), k.dir);
    assert.equal(ledger.ledgerPath(deps), path.join(k.dir, 'ledger.json'));
    assert.deepEqual(ledger.load(deps), []);
  });

  test('isAlive: 0/null/undefined 直接 false，不发信号；真实 pid 为 true；不存在的 pid 为 false', () => {
    const k = makeDeps('default2');
    require.cache[dataHomeId] = {
      id: dataHomeId, filename: dataHomeId, loaded: true,
      exports: { getDataDir: () => k.dir },
    };
    const deps = ledger.defaultDeps();
    assert.equal(deps.isAlive(0), false);
    assert.equal(deps.isAlive(null), false);
    assert.equal(deps.isAlive(undefined), false);
    assert.equal(deps.isAlive(process.pid), true);
    assert.equal(deps.isAlive(999999999), false);
  });

  test('save 走 defaultDeps 时写进 stub 的 dir 而不是仓库路径', () => {
    const k = makeDeps('default3');
    require.cache[dataHomeId] = {
      id: dataHomeId, filename: dataHomeId, loaded: true,
      exports: { getDataDir: () => k.dir },
    };
    const p = ledger.save([rec({ name: 'dep' })]);
    assert.equal(p, path.join(k.dir, 'ledger.json'));
    assert.equal(fs.existsSync(path.join(process.cwd(), 'ledger.json')), false);
  });
});
