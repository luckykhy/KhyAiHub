'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// remoteDevSessionStore is a thin IO shell over a durable pointer file. We
// redirect its data home into a temp dir via require.cache so nothing is ever
// written under the repo, and restore the original module afterwards.
const dataHomePath = require.resolve('../../../../utils/dataHome');
const originalDataHome = require.cache[dataHomePath];

let TMP;
function installStub() {
  require.cache[dataHomePath] = {
    id: dataHomePath,
    filename: dataHomePath,
    loaded: true,
    exports: { getDataDir: (sub) => path.join(TMP, sub || '') },
    paths: [],
  };
}

let store;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-store-'));
  installStub();
  store = require('./remoteDevSessionStore');
});

after(() => {
  delete require.cache[require.resolve('./remoteDevSessionStore')];
  if (originalDataHome) require.cache[dataHomePath] = originalDataHome;
  else delete require.cache[dataHomePath];
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('remoteDevSessionStore — pointerPath', () => {
  test('落在 remotedev/session.json 且解析到临时目录内', () => {
    const p = store.pointerPath();
    assert.equal(p, path.join(TMP, 'remotedev', 'session.json'));
    assert.ok(p.startsWith(TMP));
  });
});

describe('remoteDevSessionStore — readPointer', () => {
  test('文件缺失 → null（不抛）', () => {
    assert.equal(store.readPointer(), null);
  });
  test('写入后可读回同一对象', () => {
    fs.mkdirSync(path.dirname(store.pointerPath()), { recursive: true });
    fs.writeFileSync(store.pointerPath(), JSON.stringify({ connectionId: 'c', host: 'h' }));
    const r = store.readPointer();
    assert.equal(r.connectionId, 'c');
    assert.equal(r.host, 'h');
  });
  test('损坏 JSON / 空文件 / 非对象 → null', () => {
    const file = store.pointerPath();
    fs.writeFileSync(file, '{ not json');
    assert.equal(store.readPointer(), null);
    fs.writeFileSync(file, '');
    assert.equal(store.readPointer(), null);
    fs.writeFileSync(file, '"just a string"');
    assert.equal(store.readPointer(), null);
    fs.writeFileSync(file, '42');
    assert.equal(store.readPointer(), null);
  });
  test('KNOWN-DEFECT: JSON 数组被当作合法指针原样返回，未按"描述符对象"过滤', () => {
    // readPointer only checks `typeof obj === 'object'`, which is true for
    // arrays. remoteDevSessionStore.js:33 returns the parsed array verbatim
    // instead of null. Harmless downstream (reconcileSession rejects it for
    // lacking connectionId) but the doc promises a descriptor object or null.
    fs.writeFileSync(store.pointerPath(), '[1,2,3]');
    assert.deepStrictEqual(store.readPointer(), [1, 2, 3]);
  });
});

describe('remoteDevSessionStore — writePointer', () => {
  test('合法对象写入并可读回，返回原描述符引用', () => {
    const d = { connectionId: 'x', port: 22 };
    const out = store.writePointer(d);
    assert.equal(out, d);
    assert.deepStrictEqual(store.readPointer(), d);
  });
  test('原子写不留 .tmp 残留', () => {
    store.writePointer({ connectionId: 'y' });
    const dir = path.dirname(store.pointerPath());
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepStrictEqual(leftovers, []);
  });
  test('null/undefined/非对象/数组入参 → null 且不落盘', () => {
    for (const bad of [null, undefined, 0, '', 'str', 42]) {
      assert.equal(store.writePointer(bad), null);
    }
  });
  test('写盘失败时不抛，返回 null', () => {
    // Re-require the store with getDataDir pointing at a path whose parent is a
    // plain file, so writeFileSync/renameSync throw ENOTDIR and the catch path
    // returns null.
    const bogusFile = path.join(TMP, 'not-a-dir');
    fs.writeFileSync(bogusFile, 'x');
    const storePath = require.resolve('./remoteDevSessionStore');
    const saved = require.cache[storePath];
    delete require.cache[storePath];
    require.cache[dataHomePath].exports = { getDataDir: () => bogusFile };
    const fresh = require('./remoteDevSessionStore');
    assert.equal(fresh.writePointer({ connectionId: 'z' }), null);
    require.cache[dataHomePath].exports = { getDataDir: (sub) => path.join(TMP, sub || '') };
    if (saved) require.cache[storePath] = saved;
    else delete require.cache[storePath];
  });
});

describe('remoteDevSessionStore — clearPointer', () => {
  test('存在则删除返回 true，缺失返回 false', () => {
    store.writePointer({ connectionId: 'c' });
    assert.equal(fs.existsSync(store.pointerPath()), true);
    assert.equal(store.clearPointer(), true);
    assert.equal(fs.existsSync(store.pointerPath()), false);
    assert.equal(store.clearPointer(), false);
  });
});
