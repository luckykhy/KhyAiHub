'use strict';

// Co-located tests for resourceManager.js. dataHome / nativeHttp /
// maintenance ledgerWriter / archiveInstaller.extractArchive are stubbed via
// require.cache BEFORE the module under test loads; every store root is an
// os.tmpdir() sandbox and all downloads go through injected fake downloaders.
// Nothing spawns, nothing networks, nothing touches the repo.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha(content) { return crypto.createHash('sha256').update(content).digest('hex'); }

const dataHomeId = require.resolve('../../../../utils/dataHome');
const origDataHomeEntry = require.cache[dataHomeId];
const fakeHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-rmhome-')), 'data');
require.cache[dataHomeId] = {
  id: dataHomeId, filename: dataHomeId, loaded: true,
  exports: { getBaseDataDir: (n) => path.join(fakeHome, String(n)), getDataDir: (n) => path.join(fakeHome, String(n)) },
};

const httpId = require.resolve('../../../../utils/nativeHttp');
const origHttpEntry = require.cache[httpId];
require.cache[httpId] = {
  id: httpId, filename: httpId, loaded: true,
  exports: { requestStream: () => { throw new Error('network must stay stubbed'); } },
};

const ledgerId = require.resolve('../../maintenance/uninstall/ledgerWriter');
const origLedgerEntry = require.cache[ledgerId];
const ledgerCalls = [];
require.cache[ledgerId] = {
  id: ledgerId, filename: ledgerId, loaded: true,
  exports: { appendSideEffect: (entry) => ledgerCalls.push(entry) },
};

const archId = require.resolve('./archiveInstaller');
const realArch = require('./archiveInstaller');
const origArchEntry = require.cache[archId];
const extractCalls = [];
require.cache[archId] = {
  id: archId, filename: archId, loaded: true,
  exports: {
    // Fake extractor: records the decision and materialises the sentinel so
    // the real locate/copy/validate chain can run against it.
    extractArchive: (archivePath, destDir, format) => {
      extractCalls.push({ archivePath, destDir, format });
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, 'PKG-SENT'), 'sentinel');
    },
    locatePayloadRoot: realArch.locatePayloadRoot,
    copyPayload: realArch.copyPayload,
    applyChmod: realArch.applyChmod,
  },
};

const rm = require('./resourceManager');
const storeMod = require('./resourceStore');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-rm-'));
const ENV_KEYS = ['KHY_RESOURCE_MIRROR_BASE', 'KHY_RESOURCE_HOME', 'KHY_RESOURCE_MANIFEST'];
const origEnv = {};
for (const k of ENV_KEYS) origEnv[k] = process.env[k];

after(() => {
  require.cache[dataHomeId] = origDataHomeEntry;
  require.cache[httpId] = origHttpEntry;
  require.cache[ledgerId] = origLedgerEntry;
  require.cache[archId] = origArchEntry;
  for (const [k, e] of [[dataHomeId, origDataHomeEntry], [httpId, origHttpEntry], [ledgerId, origLedgerEntry], [archId, origArchEntry]]) {
    if (e === undefined) delete require.cache[k];
  }
  for (const k of ENV_KEYS) { if (origEnv[k] === undefined) delete process.env[k]; else process.env[k] = origEnv[k]; }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp sandbox */ }
  try { fs.rmSync(path.dirname(fakeHome), { recursive: true, force: true }); } catch { /* temp sandbox */ }
});

const PLAT = 'linux-x64';
const C1 = 'content-rt-bytes';
const CM = 'content-multi';
const CG = 'content-gz';
const C2 = 'content-rt2';
const CB = 'content-busy';
const CS = 'content-slow';
const URLS = {
  'https://origin.test/rt.bin': C1,
  'https://origin.test/multi.bin': CM,
  'https://origin.test/gz.tgz': CG,
  'https://origin.test/rt2.bin': C2,
  'https://origin.test/busy.bin': CB,
  'https://origin.test/slow.bin': CS,
  'https://origin.test/mir.bin': 'mirror-bytes',
  'https://mirror.local/files/mir.bin': 'mirror-bytes',
};
const BAD_URLS = new Set(['https://origin.test/bad.bin', 'https://origin.test/never.bin']);

function variant(sources, sha256, over = {}) {
  return { sources, sha256, size: null, format: 'file', sentinel: null, sourceSubdir: '.', chmod: [], files: [], ...over };
}

function makeResource(id, version, sources, sha256, over = {}) {
  return { id, kind: 'runtime', version, policy: 'manual', description: `${id} desc`, platforms: { [PLAT]: variant(sources, sha256, over.platformVariant || {}) } };
}

function makeManifest() {
  return {
    schemaVersion: 1,
    channel: 'test',
    resources: [
      makeResource('rt', '1.2.3', ['https://origin.test/rt.bin'], sha(C1)),
      makeResource('multi', '1.0.0', ['https://origin.test/bad.bin', 'https://origin.test/multi.bin'], sha(CM)),
      makeResource('gz', '2.0.0', ['https://origin.test/gz.tgz'], sha(CG), { platformVariant: { format: 'tar.gz', sentinel: 'PKG-SENT' } }),
      makeResource('rt2', '0.1.0', ['https://origin.test/rt2.bin'], sha(C2)),
      makeResource('bad', '1.0.0', ['https://origin.test/rt.bin'], 'f'.repeat(64)),
      makeResource('down', '1.0.0', ['https://origin.test/never.bin'], sha('whatever')),
      makeResource('busyres', '1.0.0', ['https://origin.test/busy.bin'], sha(CB)),
      makeResource('slow', '1.0.0', ['https://origin.test/slow.bin'], sha(CS)),
      makeResource('mir', '1.0.0', ['https://origin.test/mir.bin'], sha('mirror-bytes')),
    ],
  };
}

function fakeDownloader({ defer = null, extraFail = [] } = {}) {
  const failed = new Set([...BAD_URLS, ...extraFail]);
  const callUrls = [];
  const fn = async (url, dest) => {
    callUrls.push(url);
    if (defer) await defer;
    if (failed.has(url) || !(url in URLS)) throw new Error(`net down: ${url}`);
    fs.writeFileSync(dest, URLS[url]);
    return { bytes: URLS[url].length };
  };
  fn.callUrls = callUrls;
  return fn;
}

const rootMain = path.join(tmp, 'main-root');
const manager = rm.createResourceManager({ root: rootMain, manifest: makeManifest(), platform: PLAT });

describe('detectPlatformKey', () => {
  test('返回 platform-arch 且与 process 值一致（未知 arch 原样透传）', () => {
    const archMap = { x64: 'x64', arm64: 'arm64' };
    const expected = `${process.platform}-${archMap[process.arch] || process.arch}`;
    assert.equal(rm.detectPlatformKey(), expected);
  });
});

describe('createResourceManager 构造', () => {
  test('显式 root/manifest/platform 全透传，store 落在给定 root 下', () => {
    assert.equal(manager.store.root, rootMain);
    assert.equal(manager.platform, PLAT);
    assert.equal(manager.manifest.channel, 'test');
    assert.ok(fs.existsSync(path.join(rootMain, 'installs')));
  });

  test('无 options.root 时回落到（已 stub 的）dataHome resources 子目录', () => {
    delete process.env.KHY_RESOURCE_HOME;
    const m2 = rm.createResourceManager({ manifest: makeManifest(), platform: PLAT });
    assert.equal(m2.store.root, path.join(fakeHome, 'resources'));
  });

  test('KNOWN-DEFECT: manager.manifest 是内部活引用，外部改写立即改变后续解析决策', () => {
    // resourceManager.js:59 keeps the manifest object as internal state and
    // line 208 returns it raw. When the manifest was loaded internally (via
    // manifestPath), a caller that mutates manager.manifest writes straight
    // through into the manager's decision state with no reload possible.
    const mfFile = path.join(tmp, 'live-ref-manifest.json');
    fs.writeFileSync(mfFile, JSON.stringify(makeManifest()));
    const m3 = rm.createResourceManager({ root: path.join(tmp, 'live-ref'), manifestPath: mfFile, platform: PLAT });
    assert.equal(m3.resolve('rt').version, '1.2.3');
    m3.manifest.resources[0].version = '9.9.9-mutated';
    assert.equal(m3.resolve('rt').version, '9.9.9-mutated');
  });

  test('unknown id：resolve/inspect 同步抛，ensure 返回 rejected promise', async () => {
    assert.throws(() => manager.resolve('ghost'), /unknown resource: ghost/);
    assert.throws(() => manager.inspect('ghost'), /unknown resource/);
    await assert.rejects(() => manager.ensure('ghost'), /unknown resource: ghost/);
  });
});

describe('resolve / inspect（安装前）', () => {
  test('变体在但从未安装 → missing；path() 为 null', () => {
    const r = manager.resolve('rt');
    assert.equal(r.status, 'missing');
    assert.equal(r.path, null);
    assert.equal(r.platform, PLAT);
    assert.equal(manager.path('rt'), null);
  });

  test('inspect() 列表逐项带 policy/description', () => {
    const list = manager.inspect();
    assert.equal(list.length, 9);
    const rt = list.find((x) => x.id === 'rt');
    assert.equal(rt.policy, 'manual');
    assert.equal(rt.description, 'rt desc');
  });
});

describe('ensure 主链路（顺序敏感）', () => {
  const sharedOpts = {};

  test('rt 首次安装：download→blob→extract→install→active→ledger 全落盘', async () => {
    const dl = fakeDownloader();
    const res = await manager.ensure('rt', { downloader: dl, ...sharedOpts });
    assert.equal(res.status, 'provisioned');
    assert.equal(res.version, '1.2.3');
    const target = manager.store.installPath('runtime', 'rt', '1.2.3', PLAT);
    assert.equal(res.path, target);
    assert.ok(fs.existsSync(path.join(target, 'payload')));
    const rec = manager.store.readInstallRecord('runtime', 'rt', '1.2.3', PLAT);
    assert.equal(rec.sha256, sha(C1));
    assert.equal(rec.source, 'https://origin.test/rt.bin');
    assert.equal(manager.store.readActive('runtime', 'rt').version, '1.2.3');
    const side = ledgerCalls.find((e) => e.target === manager.store.root);
    assert.ok(side && side.kind === 'runtime' && side.action === 'remove-runtime');
    void sharedOpts;
  });

  test('已 present 时 ensure 直接复用，不再下载', async () => {
    const dl = fakeDownloader();
    const res = await manager.ensure('rt', { downloader: dl });
    assert.equal(res.status, 'present');
    assert.equal(dl.callUrls.length, 0);
  });

  test('blob 命中缓存后重装不再下载', async () => {
    fs.rmSync(path.join(rootMain, 'installs'), { recursive: true, force: true });
    fs.rmSync(path.join(rootMain, 'active'), { recursive: true, force: true });
    const dl = fakeDownloader();
    const res = await manager.ensure('rt', { downloader: dl });
    assert.equal(res.status, 'provisioned');
    assert.equal(dl.callUrls.length, 0, 'blob already present, download must be skipped');
  });

  test('多源回退：首源失败后第二源成功，记录实际源', async () => {
    const dl = fakeDownloader();
    const sources = [];
    const res = await manager.ensure('multi', { downloader: dl, onSource: (s) => sources.push(s) });
    assert.equal(res.status, 'provisioned');
    assert.deepEqual(dl.callUrls, ['https://origin.test/bad.bin', 'https://origin.test/multi.bin']);
    assert.deepEqual(sources, dl.callUrls);
    assert.equal(manager.store.readInstallRecord('runtime', 'multi', '1.0.0', PLAT).source, 'https://origin.test/multi.bin');
  });

  test('KNOWN-DEFECT: _resolvedSource 写在调用方 options 上，复用时把上一个资源的源写进本次安装记录', async () => {
    // resourceManager.js:108 stores the resolved source onto the caller's
    // options object; line 138 prefers it over this resource's own sources[0].
    // When the blob is already cached (no download this round), a reused opts
    // carries the PREVIOUS resource's URL into install.json on disk.
    fs.rmSync(path.join(rootMain, 'installs'), { recursive: true, force: true });
    fs.rmSync(path.join(rootMain, 'active'), { recursive: true, force: true });
    fs.rmSync(manager.store.blobPath(sha(C1)), { force: true });
    const optsShared = { downloader: fakeDownloader() };
    const first = await manager.ensure('rt', optsShared);
    assert.equal(first.status, 'provisioned');
    assert.equal(optsShared._resolvedSource, 'https://origin.test/rt.bin');
    const blob = manager.store.blobPath(sha(C2));
    fs.mkdirSync(path.dirname(blob), { recursive: true });
    fs.writeFileSync(blob, C2);
    const res = await manager.ensure('rt2', optsShared);
    assert.equal(res.status, 'provisioned');
    const rec = manager.store.readInstallRecord('runtime', 'rt2', '0.1.0', PLAT);
    assert.equal(rec.source, 'https://origin.test/rt.bin', 'defect: stale source from the previous ensure is recorded');
    assert.notEqual(rec.source, 'https://origin.test/rt2.bin');
  });

  test('SHA256 不匹配 → failed 且坏 blob 不留存', async () => {
    const dl = fakeDownloader();
    const res = await manager.ensure('bad', { downloader: dl });
    assert.equal(res.status, 'failed');
    assert.match(res.error, /SHA256 mismatch/);
    assert.equal(fs.existsSync(manager.store.blobPath('f'.repeat(64))), false);
  });

  test('所有源都失败 → failed 透传最后一个错误，staging 清理干净', async () => {
    const dl = fakeDownloader();
    const res = await manager.ensure('down', { downloader: dl });
    assert.equal(res.status, 'failed');
    assert.match(res.error, /net down/);
    assert.deepEqual(fs.readdirSync(manager.store.dirs.staging), []);
  });

  test('锁被占用 → busy；释放后正常安装', async () => {
    const lock = manager.store.acquireLock(`runtime-busyres-${PLAT}`);
    assert.ok(lock);
    const busy = await manager.ensure('busyres', { downloader: fakeDownloader() });
    assert.equal(busy.status, 'busy');
    manager.store.releaseLock(lock);
    const ok = await manager.ensure('busyres', { downloader: fakeDownloader() });
    assert.equal(ok.status, 'provisioned');
  });

  test('同一 id 并发 ensure 复用同一 in-flight promise', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const dl = fakeDownloader({ defer: gate });
    const p1 = manager.ensure('slow', { downloader: dl });
    const p2 = manager.ensure('slow', { downloader: dl });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    // ensure() is an async wrapper so callers get distinct promise objects,
    // but both resolve to the ONE shared ensureImpl result and only one
    // download ever runs — the inflight map dedupe is observable that way.
    assert.equal(r1, r2, 'second caller must be served the shared in-flight result');
    assert.equal(r1.status, 'provisioned');
    assert.equal(dl.callUrls.length, 1, 'concurrent ensure must not double-download');
  });

  test('tar.gz 走 extractor（已桩）并以 sentinel 定位 payload', async () => {
    extractCalls.length = 0;
    const dl = fakeDownloader();
    const res = await manager.ensure('gz', { downloader: dl });
    assert.equal(res.status, 'provisioned');
    assert.equal(extractCalls.length, 1);
    assert.equal(extractCalls[0].format, 'tar.gz');
    assert.equal(extractCalls[0].archivePath, manager.store.blobPath(sha(CG)));
    const target = manager.store.installPath('runtime', 'gz', '2.0.0', PLAT);
    assert.ok(fs.existsSync(path.join(target, 'PKG-SENT')));
  });

  test('prefetch 即 ensure 别名', async () => {
    assert.equal(manager.prefetch, manager.ensure);
  });
});

describe('镜像源 env（opt-in）', () => {
  test('KHY_RESOURCE_MIRROR_BASE 生效时下载源改写为 mirror + basename', async () => {
    process.env.KHY_RESOURCE_MIRROR_BASE = 'https://mirror.local/files/';
    try {
      const m2 = rm.createResourceManager({ root: path.join(tmp, 'mirror-root'), manifest: makeManifest(), platform: PLAT });
      const dl = fakeDownloader();
      const seen = [];
      const res = await m2.ensure('mir', { downloader: dl, onSource: (s) => seen.push(s) });
      assert.equal(res.status, 'provisioned');
      assert.deepEqual(seen, ['https://mirror.local/files/mir.bin']);
      assert.deepEqual(dl.callUrls, ['https://mirror.local/files/mir.bin']);
    } finally {
      delete process.env.KHY_RESOURCE_MIRROR_BASE;
    }
  });
});

describe('平台适配', () => {
  test('无当前平台变体 → unsupported-platform（resolve 与 ensure 口径一致）', async () => {
    const m = rm.createResourceManager({ root: path.join(tmp, 'unsupported'), manifest: makeManifest(), platform: 'plan9-x64' });
    const r = m.resolve('rt');
    assert.equal(r.status, 'unsupported-platform');
    assert.equal(r.path, null);
    const res = await m.ensure('rt', { downloader: fakeDownloader() });
    assert.equal(res.status, 'unsupported-platform');
  });

  test('KNOWN-DEFECT: variant 查表不做 own-property 守卫，platform 传入 constructor 等键命中原型链', async () => {
    // resourceManager.js:69 reads item.platforms[platform] with no
    // hasOwnProperty guard. With options.platform = 'constructor' the lookup
    // resolves to Object's constructor function, which is truthy, so the
    // resource is treated as "supported". blobPath is then called at line 96
    // with Object.sha256 === undefined — BEFORE ensureImpl's try block — so
    // ensure REJECTS outright (callers expecting the documented structured
    // status never get one) and the mutex acquired at line 93 leaks (no
    // finally is installed yet).
    const m = rm.createResourceManager({ root: path.join(tmp, 'proto'), manifest: makeManifest(), platform: 'constructor' });
    await assert.rejects(() => m.ensure('rt', { downloader: fakeDownloader() }), /invalid sha256/);
    assert.equal(m.resolve('rt').status, 'missing', 'resolve must not report unsupported-platform here either');
    assert.equal(storeMod.acquireLock('runtime-rt-constructor', path.join(tmp, 'proto')), null, 'lock from the crashed ensure is still held');
  });
});

describe('verify / activate / rollback', () => {
  test('verify 对未安装记录返回 missing', () => {
    const m = rm.createResourceManager({ root: path.join(tmp, 'verify-m'), manifest: makeManifest(), platform: PLAT });
    assert.deepEqual(m.verify('rt'), { id: 'rt', status: 'missing' });
  });

  test('主 manager（rt 已装）verify → verified；activate 已装版本 → activated；未知版本 → missing', () => {
    assert.equal(manager.verify('rt').status, 'verified');
    const act = manager.activate('rt', '1.2.3');
    assert.equal(act.status, 'activated');
    const miss = manager.activate('rt', '9.9.9');
    assert.equal(miss.status, 'missing');
    assert.match(miss.error, /version not installed: 9\.9\.9/);
  });

  test('手工安装记录可被 rollback 激活并改写 active', () => {
    const target2 = manager.store.installPath('runtime', 'rt', '1.2.2', PLAT);
    fs.mkdirSync(target2, { recursive: true });
    const blob = manager.store.blobPath(sha(C1));
    manager.store.writeInstallRecord({ id: 'rt', kind: 'runtime', version: '1.2.2', platform: PLAT, sha256: sha(C1), path: target2, blob, source: 'manual', installedAt: '2026-01-01T00:00:00.000Z' });
    const res = manager.rollback('rt', '1.2.2');
    assert.equal(res.status, 'rolled-back');
    assert.equal(manager.store.readActive('runtime', 'rt').version, '1.2.2');
    assert.equal(manager.resolve('rt').version, '1.2.2');
  });

  test('blob 被篡改后 verify → corrupt', () => {
    const blob = manager.store.blobPath(sha(C1));
    fs.writeFileSync(blob, 'tampered');
    assert.equal(manager.verify('rt').status, 'corrupt');
    fs.writeFileSync(blob, C1);
    assert.equal(manager.verify('rt').status, 'verified');
  });
});

describe('gc', () => {
  test('预览不删、apply 删除无引用旧 blob；被引用与新鲜的 blob 不动', () => {
    const dirs = manager.store.dirs;
    const orphanDir = path.join(dirs.blobs, 'ff');
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphan = path.join(orphanDir, 'f'.repeat(64));
    fs.writeFileSync(orphan, 'orphan');
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(orphan, old, old);

    const preview = manager.gc({ minAgeMs: 0 });
    assert.equal(preview.status, 'preview');
    assert.ok(preview.candidates.includes(orphan));
    assert.equal(preview.count, preview.candidates.length);
    assert.ok(fs.existsSync(orphan), 'preview must not delete');

    const applied = manager.gc({ minAgeMs: 0, apply: true });
    assert.equal(applied.status, 'cleaned');
    assert.equal(fs.existsSync(orphan), false);
    assert.ok(fs.existsSync(manager.store.blobPath(sha(C1))), 'referenced blob must survive');

    const recent = path.join(orphanDir, 'e'.repeat(64));
    fs.writeFileSync(recent, 'recent');
    const defaultAge = manager.gc();
    assert.ok(!defaultAge.candidates.includes(recent), 'fresh blob under 24h default must not be collected');
  });

  test('损坏的 install.json 不保护其 blob（注释承诺的行为）', () => {
    const dirs = manager.store.dirs;
    const ghostInstallDir = manager.store.installPath('runtime', 'ghost', '1.0.0', PLAT);
    fs.mkdirSync(ghostInstallDir, { recursive: true });
    fs.writeFileSync(path.join(ghostInstallDir, 'install.json'), '{broken');
    const dir = path.join(dirs.blobs, 'ee');
    fs.mkdirSync(dir, { recursive: true });
    const blob = path.join(dir, 'e'.repeat(63) + '9');
    fs.writeFileSync(blob, 'x');
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(blob, old, old);
    const res = manager.gc({ minAgeMs: 0 });
    assert.ok(res.candidates.includes(blob));
  });
});
