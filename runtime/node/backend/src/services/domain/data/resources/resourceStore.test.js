'use strict';

// Co-located tests for resourceStore.js. utils/dataHome is stubbed via
// require.cache BEFORE the module loads so the fallback root never points at
// the real data home; every operation is pinned to an os.tmpdir() sandbox.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataHomeId = require.resolve('../../../../utils/dataHome');
const origDataHomeEntry = require.cache[dataHomeId];
const fakeBase = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-store-home-')), 'data');
require.cache[dataHomeId] = {
  id: dataHomeId,
  filename: dataHomeId,
  loaded: true,
  exports: {
    getBaseDataDir: (name) => path.join(fakeBase, String(name)),
    getDataDir: (name) => path.join(fakeBase, String(name)),
  },
};

const store = require('./resourceStore');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-store-'));
const ENV_KEY = 'KHY_RESOURCE_HOME';
const origEnv = process.env[ENV_KEY];

after(() => {
  require.cache[dataHomeId] = origDataHomeEntry;
  if (origDataHomeEntry === undefined) delete require.cache[dataHomeId];
  if (origEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = origEnv;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp sandbox */ }
  try { fs.rmSync(path.dirname(fakeBase), { recursive: true, force: true }); } catch { /* temp sandbox */ }
});

const SHA_OK = 'ab'.repeat(32);
const SHA_BAD = 'zz'.repeat(32);

function sub(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('assertSafeSegment', () => {
  test('小写字母数字与 . _ - 组合通过；穿越/分隔符/大小写/垃圾被拒', () => {
    assert.equal(store.assertSafeSegment('runtime'), 'runtime');
    assert.equal(store.assertSafeSegment('v1.2.3-beta_x'), 'v1.2.3-beta_x');
    for (const bad of ['../x', 'a/b', 'a\\b', '', 'UPPER', '.hidden', '__proto__', 'a..b', null, undefined, 42, {}, [], 'x'.repeat(200)]) {
      assert.throws(() => store.assertSafeSegment(bad), /unsafe resource id/, `expected reject: ${String(bad)}`);
    }
    assert.equal(store.assertSafeSegment('win32-x64', 'platform'), 'win32-x64');
    assert.throws(() => store.assertSafeSegment('../evil', 'platform'), /unsafe platform/);
    assert.throws(() => store.assertSafeSegment('a\\b', 'lock'), /unsafe lock/);
  });
});

describe('layout / ensureLayout / getRoot', () => {
  test('layout 在给定 root 下派生全部子目录', () => {
    const root = path.join(tmp, 'lay');
    const dirs = store.layout(root);
    assert.equal(dirs.root, root);
    assert.equal(dirs.blobs, path.join(root, 'blobs', 'sha256'));
    assert.equal(dirs.installs, path.join(root, 'installs'));
    assert.equal(dirs.active, path.join(root, 'active'));
    assert.equal(dirs.locks, path.join(root, 'locks'));
  });

  test('ensureLayout 幂等创建目录并返回同一布局', () => {
    const root = path.join(tmp, 'lay2');
    const first = store.ensureLayout(root);
    const second = store.ensureLayout(root);
    assert.deepEqual(first, second);
    for (const dir of Object.values(first)) assert.ok(fs.statSync(dir).isDirectory());
  });

  test('getRoot 优先 env，其次 dataHome stub 的 resources 子目录', () => {
    process.env[ENV_KEY] = path.join(tmp, 'envhome');
    assert.equal(store.getRoot(), path.join(tmp, 'envhome'));
    delete process.env[ENV_KEY];
    assert.equal(store.getRoot(), path.join(fakeBase, 'resources'));
  });
});

describe('blobPath / installPath / activePath', () => {
  test('blobPath 按前 2 位分片且大小写归一', () => {
    const root = path.join(tmp, 'paths');
    const p = store.blobPath(SHA_OK.toUpperCase(), root);
    assert.equal(p, path.join(root, 'blobs', 'sha256', 'ab', SHA_OK));
  });

  test('blobPath 拒绝非法 sha（含 ../ 形态）', () => {
    const root = path.join(tmp, 'paths2');
    assert.throws(() => store.blobPath('../../etc/passwd', root), /invalid sha256/);
    assert.throws(() => store.blobPath(SHA_BAD, root), /invalid sha256/);
    assert.throws(() => store.blobPath(undefined, root), /invalid sha256/);
  });

  test('installPath/activePath 组装四级路径并拒绝不安全段', () => {
    const root = path.join(tmp, 'paths3');
    assert.equal(
      store.installPath('runtime', 'rt', '1.2.3', 'win32-x64', root),
      path.join(root, 'installs', 'runtime', 'rt', '1.2.3', 'win32-x64')
    );
    assert.equal(store.activePath('tool', 'x', root), path.join(root, 'active', 'tool', 'x.json'));
    assert.throws(() => store.installPath('../escape', 'rt', '1', 'win32-x64', root), /unsafe resource kind/);
    assert.throws(() => store.installPath('runtime', 'rt', '1', '../evil', root), /unsafe platform/);
    assert.throws(() => store.activePath('runtime', null, root), /unsafe resource id/);
  });
});

describe('sha256File', () => {
  test('已知内容匹配官方测试向量，空文件与二进制同样正确', () => {
    const dir = sub('hash');
    const f1 = path.join(dir, 'abc');
    fs.writeFileSync(f1, 'abc');
    assert.equal(store.sha256File(f1), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const f2 = path.join(dir, 'empty');
    fs.writeFileSync(f2, '');
    assert.equal(store.sha256File(f2), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const f3 = path.join(dir, 'big.bin');
    const bytes = Buffer.alloc(1024 * 1024 + 7, 0x61);
    fs.writeFileSync(f3, bytes);
    assert.equal(store.sha256File(f3), crypto.createHash('sha256').update(bytes).digest('hex'));
  });

  test('文件缺失/目录入参直接抛错不返回假摘要', () => {
    const dir = sub('hash2');
    assert.throws(() => store.sha256File(path.join(dir, 'ghost')), (err) => ['ENOENT', 'EPERM'].includes(err.code));
    assert.throws(() => store.sha256File(dir));
  });
});

describe('atomicWriteJson / readActive / install records', () => {
  test('atomicWriteJson 写入 pretty JSON + 尾随换行并自建父目录', () => {
    const dir = sub('atomic');
    const file = path.join(dir, 'deep', 'nested', 'x.json');
    store.atomicWriteJson(file, { a: 1 });
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.deepEqual(JSON.parse(raw), { a: 1 });
  });

  test('readActive/readInstallRecord：无文件返回 null，损坏 JSON 静默返回 null', () => {
    const root = path.join(tmp, 'rec1');
    const dirs = store.ensureLayout(root);
    assert.equal(store.readActive('runtime', 'ghost', root), null);
    assert.equal(store.readInstallRecord('runtime', 'ghost', '1', 'win32-x64', root), null);
    const activeFile = store.activePath('runtime', 'broken', root);
    fs.mkdirSync(path.dirname(activeFile), { recursive: true });
    fs.writeFileSync(activeFile, '{oops');
    assert.equal(store.readActive('runtime', 'broken', root), null);
    assert.ok(dirs.state);
  });

  test('activate 写 active 记录并补 activatedAt，返回重读结果', () => {
    const root = path.join(tmp, 'rec2');
    const record = { kind: 'runtime', id: 'app', version: '1.0.0', platform: 'win32-x64', path: 'P', blob: 'B', sha256: SHA_OK };
    const back = store.activate(record, root);
    assert.equal(back.id, 'app');
    assert.equal(back.version, '1.0.0');
    assert.match(back.activatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(store.readActive('runtime', 'app', root).sha256, SHA_OK);
  });

  test('activate 拒绝不安全 kind/id（不把穿越路径写盘）', () => {
    const root = path.join(tmp, 'rec3');
    assert.throws(() => store.activate({ kind: '../evil', id: 'app' }, root), /unsafe resource kind/);
    assert.equal(fs.existsSync(path.join(root, 'evil')), false);
  });

  test('writeInstallRecord 落在 installPath 下的 install.json', () => {
    const root = path.join(tmp, 'rec4');
    const s = store.createStore({ root });
    const record = { kind: 'runtime', id: 'app', version: '2.0.0', platform: 'win32-x64', sha256: SHA_OK };
    s.writeInstallRecord(record);
    const file = path.join(s.installPath('runtime', 'app', '2.0.0', 'win32-x64'), 'install.json');
    assert.deepEqual(s.readInstallRecord('runtime', 'app', '2.0.0', 'win32-x64'), record);
    assert.ok(fs.existsSync(file));
  });
});

describe('acquireLock / releaseLock', () => {
  test('锁是目录级互斥：二次 acquire 返回 null，release 后可再取', () => {
    // Fresh roots have no locks/ dir; the module mutex uses mkdirSync(recursive:false)
    // so acquire silently fails (null) until ensureLayout has created the layout.
    const root = path.join(tmp, 'lock1');
    store.ensureLayout(root);
    const l1 = store.acquireLock('runtime-rt-win32-x64', root);
    assert.ok(l1 && fs.existsSync(path.join(l1, 'owner')));
    assert.equal(fs.readFileSync(path.join(l1, 'owner'), 'utf8').trim(), String(process.pid));
    assert.equal(store.acquireLock('runtime-rt-win32-x64', root), null);
    store.releaseLock(l1);
    assert.equal(fs.existsSync(l1), false);
    assert.ok(store.acquireLock('runtime-rt-win32-x64', root));
  });

  test('超过 20 分钟的陈旧锁被回收重建', () => {
    const root = path.join(tmp, 'lock2');
    store.ensureLayout(root);
    const l1 = store.acquireLock('tool-x-linux-x64', root);
    const old = new Date(Date.now() - 21 * 60 * 1000);
    fs.utimesSync(l1, old, old);
    const l2 = store.acquireLock('tool-x-linux-x64', root);
    assert.ok(l2, 'stale lock must be reclaimed');
    assert.ok(fs.existsSync(l2));
  });

  test('KNOWN-DEFECT: resourceStore.js:103 回收陈旧锁后不写 owner 文件', () => {
    // Stale reclaim path does rm+mkdir and returns immediately, skipping the
    // owner-file write of line 100 — a reclaimed lock is unattributable.
    const root = path.join(tmp, 'lock4');
    store.ensureLayout(root);
    const l1 = store.acquireLock('tool-y-linux-x64', root);
    const old = new Date(Date.now() - 21 * 60 * 1000);
    fs.utimesSync(l1, old, old);
    const l2 = store.acquireLock('tool-y-linux-x64', root);
    assert.equal(l2, l1);
    assert.equal(fs.existsSync(path.join(l2, 'owner')), false);
  });

  test('releaseLock 对 null/不存在路径静默；垃圾锁名被拒', () => {
    const root = path.join(tmp, 'lock3');
    store.releaseLock(null);
    store.releaseLock(path.join(root, 'ghost.lock'));
    assert.throws(() => store.acquireLock('../evil', root), /unsafe lock/);
    assert.throws(() => store.acquireLock(null, root), /unsafe lock/);
  });
});

describe('createStore', () => {
  test('工厂在 root 下建好布局并暴露一致的路径派生', () => {
    const root = path.join(tmp, 'factory');
    const s = store.createStore({ root });
    assert.equal(s.root, root);
    assert.equal(s.dirs.blobs, path.join(root, 'blobs', 'sha256'));
    assert.equal(s.hasBlob(SHA_OK), false);
    const st = s.stat();
    assert.equal(st.root, root);
    assert.equal(s.blobPath(SHA_OK), path.join(s.dirs.blobs, 'ab', SHA_OK));
    assert.equal(s.activePath('runtime', 'a'), store.activePath('runtime', 'a', root));
  });

  test('store 回调拒绝垃圾入参且不落盘', () => {
    const root = path.join(tmp, 'factory2');
    const s = store.createStore({ root });
    assert.throws(() => s.blobPath('nope'), /invalid sha256/);
    assert.throws(() => s.installPath('runtime', 'a/b', '1', 'linux-x64'), /unsafe resource id/);
    assert.equal(s.readActive('runtime', 'ghost'), null);
  });
});
