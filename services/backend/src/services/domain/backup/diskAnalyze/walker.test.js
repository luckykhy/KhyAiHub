'use strict';

// Colocated tests for diskAnalyze/walker.js. The walker is fully DI'd
// (deps.fsImpl / deps.now / opts.deadline), so we never touch real disk here.
// flagRegistry is stubbed via require.cache to keep _resolveMaxEntries deterministic.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub src/services/flagRegistry (required lazily inside _resolveMaxEntries).
const flagRegistryPath = require.resolve('../../../flagRegistry');
const realFlagRegistry = require.cache[flagRegistryPath];
require.cache[flagRegistryPath] = {
  id: flagRegistryPath,
  filename: flagRegistryPath,
  loaded: true,
  exports: {
    resolveNumeric(key, env) {
      const n = Number.parseInt(env && env[key], 10);
      return Number.isFinite(n) && n > 0 ? n : NaN;
    },
  },
};

const walker = require('./walker');

test.after(() => {
  if (realFlagRegistry) {
    require.cache[flagRegistryPath] = realFlagRegistry;
  } else {
    delete require.cache[flagRegistryPath];
  }
});

// Build a fake Dirent-like entry.
function dirEnt(name) {
  return { name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
}
function fileEnt(name) {
  return { name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
}
function linkEnt(name) {
  return { name, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true };
}

// Fake fs backed by a nested object tree:
//   { 'dir': { 'sub': {...}, 'file.txt': { size, mtimeMs } } }
function fakeFs(tree) {
  const entriesOf = (dir) => {
    let node = tree;
    for (const part of String(dir).split(/[\\/]+/).filter(Boolean)) {
      node = node && node[part];
    }
    return node && typeof node === 'object' ? node : null;
  };
  return {
    readdirSync(p, opts) {
      const node = entriesOf(p);
      if (!node) {
        const err = new Error('ENOENT');
        throw err;
      }
      return Object.keys(node).map((name) =>
        typeof node[name] === 'object' && node[name] !== null && !('size' in node[name])
          ? dirEnt(name)
          : fileEnt(name)
      );
    },
    lstatSync(p) {
      const parent = entriesOf(path.dirname(p));
      const name = path.basename(p);
      if (!parent || !(name in parent)) {
        throw new Error('ENOENT');
      }
      const v = parent[name];
      const isLeaf = v === null || 'size' in v;
      return {
        isDirectory: () => !isLeaf,
        isFile: () => isLeaf,
        isSymbolicLink: () => false,
        size: isLeaf ? v.size || 0 : 0,
        mtimeMs: isLeaf ? v.mtimeMs || 0 : 0,
      };
    },
  };
}

test('walk 垃圾入参诚实返空：无 fsImpl / 非数组 roots / 空 roots', () => {
  assert.deepEqual(walker.walk(['C:\\x'], {}), {
    files: [],
    scanned: 0,
    bytes: 0,
    truncated: false,
    reason: 'no-fs',
  });
  assert.equal(walker.walk(['C:\\x'], { fsImpl: {} }).reason, 'no-fs');
  // roots 非数组/为空时不是 no-fs，而是空栈自然结束（reason=''）
  assert.equal(walker.walk(null, { fsImpl: fakeFs({}) }).files.length, 0);
  assert.equal(walker.walk(null, { fsImpl: fakeFs({}) }).reason, '');
  assert.equal(walker.walk([], { fsImpl: fakeFs({}) }).files.length, 0);
  assert.equal(walker.walk('C:\\', { fsImpl: fakeFs({}) }).files.length, 0); // 非数组被忽略
  assert.equal(walker.walk([null, '', undefined], { fsImpl: fakeFs({}) }).files.length, 0);
});

test('walk 收集文件三元组并累计 bytes', () => {
  const tree = {
    root: {
      'big.zip': { size: 100, mtimeMs: 111 },
      'small.txt': { size: 5, mtimeMs: 222 },
      sub: { 'deep.bin': { size: 50, mtimeMs: 333 } },
    },
  };
  const out = walker.walk(['root'], { fsImpl: fakeFs(tree) }, { env: {} });
  assert.equal(out.truncated, false);
  assert.equal(out.files.length, 3);
  assert.equal(out.bytes, 155);
  assert.equal(out.scanned, 4); // 3 files + 1 dir
  const names = out.files.map((f) => f.path.replace(/\\/g, '/')).sort();
  assert.deepEqual(names, ['root/big.zip', 'root/small.txt', 'root/sub/deep.bin']);
  const big = out.files.find((f) => f.path.endsWith('big.zip'));
  assert.equal(big.size, 100);
  assert.equal(big.mtimeMs, 111);
});

test('walk 跳过 SKIP_DIRS（大小写不敏感）', () => {
  const tree = {
    root: {
      node_modules: { 'x.js': { size: 1, mtimeMs: 1 } },
      NODE_MODULES: { 'y.js': { size: 1, mtimeMs: 1 } },
      '.git': { 'obj': { size: 1, mtimeMs: 1 } },
      keep: { 'real.dat': { size: 9, mtimeMs: 1 } },
    },
  };
  const out = walker.walk(['root'], { fsImpl: fakeFs(tree) }, { env: {} });
  assert.equal(out.files.length, 1);
  assert.ok(out.files[0].path.endsWith('real.dat'));
});

// KNOWN-DEFECT: _isSkippedDir 的注释声称「隐藏目录(以点开头)……跳过以聚焦用户可见大文件」，
// 但实现只查 SKIP_DIRS 后直接 return false（walker.js:72-73），'.cache' 之外的任意点目录
// （如 .vscode/.cargo）仍被遍历收集——注释与实现不符（低危：多走缓存目录，只影响遍历成本）。
test('KNOWN-DEFECT: 非黑名单点目录并未被跳过（注释说跳过，实现照走）', () => {
  assert.equal(walker.SKIP_DIRS.has('.vscode'), false);
  const tree = { root: { '.vscode': { 'settings.json': { size: 3, mtimeMs: 1 } } } };
  const out = walker.walk(['root'], { fsImpl: fakeFs(tree) }, { env: {} });
  assert.equal(out.files.length, 1); // 走进去了
});

test('walk 不跟随符号链接', () => {
  const fsImpl = fakeFs({ root: { 'real.txt': { size: 2, mtimeMs: 1 } } });
  const origReaddir = fsImpl.readdirSync;
  fsImpl.readdirSync = (p, o) => {
    const out = origReaddir(p, o);
    if (String(p).endsWith('root')) {
      out.push(linkEnt('linked'));
    }
    return out;
  };
  const out = walker.walk(['root'], { fsImpl }, { env: {} });
  assert.equal(out.files.length, 1);
  assert.ok(out.files[0].path.endsWith('real.txt'));
});

test('walk maxDepth 限深：深度到顶不再下钻', () => {
  const tree = { root: { a: { b: { 'deep.txt': { size: 1, mtimeMs: 1 } } }, 'top.txt': { size: 1, mtimeMs: 1 } } };
  const out = walker.walk(['root'], { fsImpl: fakeFs(tree) }, { maxDepth: 1, env: {} });
  assert.equal(out.files.length, 1);
  assert.ok(out.files[0].path.endsWith('top.txt'));
});

test('walk deadline 超时 → truncated:true reason=time-budget', () => {
  const tree = { root: { 'a.txt': { size: 1, mtimeMs: 1 }, 'b.txt': { size: 1, mtimeMs: 1 } } };
  const out = walker.walk(['root'], { fsImpl: fakeFs(tree) }, {
    env: {},
    deadline: { exceeded: () => true },
  });
  assert.equal(out.truncated, true);
  assert.equal(out.reason, 'time-budget');
});

test('walk 条目上限（env KHY_DISKANALYZE_MAX_ENTRIES）→ truncated:max-entries', () => {
  const tree = { root: { 'a.txt': { size: 1, mtimeMs: 1 }, 'b.txt': { size: 1, mtimeMs: 1 }, 'c.txt': { size: 1, mtimeMs: 1 } } };
  const out = walker.walk(['root'], { fsImpl: fakeFs(tree) }, { env: { KHY_DISKANALYZE_MAX_ENTRIES: '2' } });
  assert.equal(out.truncated, true);
  assert.equal(out.reason, 'max-entries');
  assert.equal(out.files.length, 1); // 第 2 个条目触发上限，未入 files
});

test('walk 单目录读失败 fail-soft：跳过继续，绝不抛', () => {
  const fsImpl = fakeFs({ root: { 'a.txt': { size: 1, mtimeMs: 1 } } });
  const origReaddir = fsImpl.readdirSync;
  fsImpl.readdirSync = (p, o) => {
    if (String(p) === 'root') {
      throw new Error('EACCES');
    }
    return origReaddir(p, o);
  };
  const out = walker.walk(['root', 'missing'], { fsImpl }, { env: {} });
  assert.equal(out.files.length, 0);
  assert.equal(out.truncated, false);
});

test('hashDuplicates 按 (size,sha1) 分组、组内排序、按 size 降序', () => {
  const blobs = {
    '/a.bin': Buffer.from('SAME'),
    '/b.bin': Buffer.from('SAME'),
    '/c.bin': Buffer.from('OTHER'),
    '/c2.bin': Buffer.from('OTHER'),
  };
  const fsImpl = { readFileSync: (p) => blobs[p] };
  const groups = walker.hashDuplicates(
    [
      { path: '/b.bin', sizeBytes: 4 },
      { path: '/a.bin', sizeBytes: 4 },
      { path: '/c.bin', sizeBytes: 5 },
      { path: '/c2.bin', sizeBytes: 5 },
    ],
    { fsImpl }
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0].sizeBytes, 5); // 降序
  assert.deepEqual(groups[0].files, ['/c.bin', '/c2.bin']);
  assert.deepEqual(groups[1].files, ['/a.bin', '/b.bin']);
  // hash 是 sha1 十六进制
  assert.match(groups[0].hash, /^[0-9a-f]{40}$/);
});

test('hashDuplicates 同内容不同大小不算重复（size 参与分组键）', () => {
  const blobs = { '/x': Buffer.from('DATA'), '/y': Buffer.from('DATA') };
  const groups = walker.hashDuplicates(
    [
      { path: '/x', sizeBytes: 4 },
      { path: '/y', sizeBytes: 5 },
    ],
    { fsImpl: { readFileSync: (p) => blobs[p] } }
  );
  assert.equal(groups.length, 0);
});

test('hashDuplicates 垃圾入参全返空数组、绝不抛', () => {
  assert.deepEqual(walker.hashDuplicates(null, { fsImpl: {} }), []);
  assert.deepEqual(walker.hashDuplicates([], { fsImpl: {} }), []);
  assert.deepEqual(walker.hashDuplicates('x', { fsImpl: {} }), []);
  assert.deepEqual(walker.hashDuplicates([{ path: '/x' }], {}), []); // 无 fsImpl
  assert.deepEqual(walker.hashDuplicates([{ path: '/x' }], { fsImpl: {} }), []); // 无 readFileSync
  assert.deepEqual(
    walker.hashDuplicates([null, {}, { path: '' }, { path: '/missing' }], { fsImpl: { readFileSync: () => { throw new Error('ENOENT'); } } }),
    []
  );
});

test('hashDuplicates sizeBytes 缺失回退 size，再缺 → 0', () => {
  const blobs = { '/m': Buffer.from('M'), '/n': Buffer.from('M') };
  const deps = { fsImpl: { readFileSync: (p) => blobs[p] } };
  const groups = walker.hashDuplicates(
    [
      { path: '/m', size: 7 },
      { path: '/n' }, // 双缺 → 0
    ],
    deps
  );
  // 7 与 0 键不同 → 各自成组但不足 2 个 → 无重复组
  assert.equal(groups.length, 0);
  const groups2 = walker.hashDuplicates(
    [
      { path: '/m', size: 7 },
      { path: '/n', sizeBytes: 7 },
    ],
    deps
  );
  assert.equal(groups2.length, 1);
  assert.equal(groups2[0].sizeBytes, 7);
});
