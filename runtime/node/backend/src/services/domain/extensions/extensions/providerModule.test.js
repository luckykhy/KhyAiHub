'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Redirect every collaborator away from the repo: extensionRoots is stubbed in the
// require cache before the subject is loaded, and provider files live in a temp dir.
const ROOTS_PATH = require.resolve('./extensionRoots.js');
const ORIGINAL_ROOTS = require.cache[ROOTS_PATH];
const ENV_SNAPSHOT = { ...process.env };

const stub = { find: () => null, calls: [] };
const stubbed = new Module(ROOTS_PATH);
stubbed.filename = ROOTS_PATH;
stubbed.loaded = true;
stubbed.exports = {
  findProvider: (service, opts) => {
    stub.calls.push({ service, opts });
    return stub.find(service, opts);
  },
};
require.cache[ROOTS_PATH] = stubbed;

const { requireFromProvider, fnFromProvider, __resetCache } = require('./providerModule.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b43-'));

function writeProviderFile(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, 'utf8');
  return dir;
}

const DIR_A = path.join(TMP, 'ext-a');
writeProviderFile(DIR_A, 'artifact-manifest.js', 'module.exports = { marker: "A", valueOf: 7 };');
writeProviderFile(DIR_A, 'c.js', 'module.exports = { marker: "A", whoami() { return this.marker; } };');
writeProviderFile(DIR_A, 'broken.js', 'throw new Error("provider exploded");');
writeProviderFile(DIR_A, 'plain.js', 'module.exports = { answer: 42 };');

const DIR_B = path.join(TMP, 'ext-b');
writeProviderFile(DIR_B, 'b c.js', 'module.exports = { marker: "B" };');

const DIR_EMPTY = path.join(TMP, 'ext-empty');
fs.mkdirSync(DIR_EMPTY, { recursive: true });

test.beforeEach(() => {
  stub.calls = [];
  stub.find = (service) => (service === 'portable-artifact' ? { dir: DIR_A }
    : service === 'a' ? { dir: DIR_B }
      : service === 'empty-dir' ? { dir: DIR_EMPTY }
        : service === 'a b' ? { dir: DIR_A }
          : null);
  __resetCache();
});

test.after(() => {
  if (ORIGINAL_ROOTS) require.cache[ROOTS_PATH] = ORIGINAL_ROOTS;
  else delete require.cache[ROOTS_PATH];
  process.env = { ...ENV_SNAPSHOT };
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('命中服务时 require 到拓展模块本体', () => {
  const mod = requireFromProvider('portable-artifact', 'artifact-manifest.js');
  assert.equal(mod.marker, 'A');
  assert.equal(mod.valueOf, 7);
});

test('probe 参数原样透传 file 本身（空目录骗不过解析）', () => {
  requireFromProvider('portable-artifact', 'artifact-manifest.js');
  assert.deepEqual(stub.calls, [
    { service: 'portable-artifact', opts: { probe: 'artifact-manifest.js' } },
  ]);
});

test('服务无人提供时返回 null 而不是抛错', () => {
  assert.equal(requireFromProvider('no-such-service', 'x.js'), null);
  assert.deepEqual(stub.calls, [{ service: 'no-such-service', opts: { probe: 'x.js' } }]);
});

test('拓展自身加载抛错被吞成 null（坏拓展不连累核）', () => {
  assert.equal(requireFromProvider('portable-artifact', 'broken.js'), null);
});

test('声明了服务但目录里没有该文件 → null', () => {
  assert.equal(requireFromProvider('empty-dir', 'whatever.js'), null);
  assert.equal(requireFromProvider('portable-artifact', 'missing-file.js'), null);
});

test('findProvider 自己抛错也收敛为 null', () => {
  stub.find = () => {
    throw new Error('roots scan blew up');
  };
  assert.equal(requireFromProvider('portable-artifact', 'artifact-manifest.js'), null);
});

test('缓存会记住"没有"：同进程内热插拔不生效，__resetCache 后才重扫', () => {
  stub.find = () => null;
  assert.equal(requireFromProvider('late-svc', 'artifact-manifest.js'), null);
  stub.find = (service) => (service === 'late-svc' ? { dir: DIR_A } : null);
  assert.equal(requireFromProvider('late-svc', 'artifact-manifest.js'), null);
  assert.equal(stub.calls.length, 1);
  __resetCache();
  assert.equal(requireFromProvider('late-svc', 'artifact-manifest.js').marker, 'A');
  assert.equal(stub.calls.length, 2);
});

test('缓存命中不再调用 findProvider', () => {
  requireFromProvider('portable-artifact', 'artifact-manifest.js');
  requireFromProvider('portable-artifact', 'artifact-manifest.js');
  assert.equal(stub.calls.length, 1);
});

test('fnFromProvider 拿到函数并绑定模块作为 this', () => {
  const fn = fnFromProvider('portable-artifact', 'c.js', 'whoami');
  assert.equal(typeof fn, 'function');
  assert.equal(fn(), 'A');
});

test('fnFromProvider 导出不存在或不是函数时走 fallback', () => {
  assert.equal(fnFromProvider('portable-artifact', 'plain.js', 'answer', () => 'FB')(), 'FB');
  assert.equal(fnFromProvider('portable-artifact', 'plain.js', 'nope', () => 'FB2')(), 'FB2');
  assert.equal(fnFromProvider('no-such-service', 'plain.js', 'nope', () => 'FB3')(), 'FB3');
});

test('fnFromProvider 无 fallback 时返回恒为 null 的函数；fallback 非函数同样回落', () => {
  const dflt = fnFromProvider('no-such-service', 'plain.js', 'nope');
  assert.equal(typeof dflt, 'function');
  assert.equal(dflt(), null);
  // a non-callable fallback is not honoured — measured: default () => null wins
  const bad = fnFromProvider('no-such-service', 'plain.js', 'nope', 'notafunction');
  assert.equal(typeof bad, 'function');
  assert.equal(bad(), null);
});

test('垃圾入参不抛错：undefined/空串照样走缓存键', () => {
  assert.equal(requireFromProvider(undefined, undefined), null);
  assert.deepEqual(stub.calls[0], { service: undefined, opts: { probe: undefined } });
  assert.equal(requireFromProvider('', ''), null);
  assert.equal(requireFromProvider(null, null), null);
  assert.equal(typeof fnFromProvider(undefined, undefined, undefined), 'function');
});

test('缓存键以 NUL 分隔：service/file 里的空格不会互相撞车（与模块头注释的字面描述不同）', () => {
  // 'a b' + 'c.js' and 'a' + 'b c.js' would collide under a space-joined key;
  // measured: they are distinct entries and each provider is consulted.
  const first = requireFromProvider('a b', 'c.js');
  assert.equal(first.marker, 'A');
  const second = requireFromProvider('a', 'b c.js');
  assert.equal(second.marker, 'B');
  assert.equal(stub.calls.length, 2);
  assert.deepEqual(stub.calls.map((c) => c.service), ['a b', 'a']);
  assert.deepEqual(stub.calls.map((c) => c.opts.probe), ['c.js', 'b c.js']);
  // the exact same pair is served from cache — no third findProvider call
  assert.equal(requireFromProvider('a b', 'c.js').marker, 'A');
  assert.equal(stub.calls.length, 2);
});
