'use strict';

// Co-located contract tests for poolImporter.js (local IDE storage -> pool import).
// All values below are MEASURED (probes .khyos/tmp/probeImporterSync.js / probeImporter3.js).
// Strategy: os.homedir AND USERPROFILE/APPDATA/LOCALAPPDATA are redirected to a fresh mkdtemp
// BEFORE the module is required, so every storage constant and every runtime kiro candidate
// path lives inside the temp home; sqlite-adapter and ideDetector are stubbed through
// require.cache. Deps (db writes) are injected per importer so nothing touches real state.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const fs = require('fs');
const path = require('path');

const ENV_KEYS = [
  'KIRO_TOKEN_PATH', 'NIRVANA_TRAE_CACHE', 'NIRVANA_DEFAULT_LOGIN_EMAIL', 'NIRVANA_IMPORT_PATH',
  'KHY_POOL_AUTO_IMPORT_SOURCE', 'KHY_ACCOUNT_POOL_AUTO_IMPORT_SOURCE',
  'KHY_POOL_AUTO_IMPORT_COOLDOWN_MS', 'KHY_ACCOUNT_POOL_AUTO_IMPORT_COOLDOWN_MS',
  'KHY_POOL_EVENT_AUTO_IMPORT', 'KHY_ACCOUNT_POOL_EVENT_AUTO_IMPORT',
  'KHY_POOL_EVENT_AUTO_IMPORT_USE_DEFAULT_SOURCE', 'KHY_ACCOUNT_POOL_EVENT_AUTO_IMPORT_USE_DEFAULT_SOURCE',
  'KHY_POOL_EVENT_AUTO_IMPORT_USE_ENV_SOURCE', 'KHY_ACCOUNT_POOL_EVENT_AUTO_IMPORT_USE_ENV_SOURCE',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
];

const T = 'abcdefghijklmnop'; // the minimal STRICT token shape accepted everywhere

const origHomedir = os.homedir;
const envBackup = {};
const ideStub = { findInstallation: () => false, findDataPath: () => false };

function FakeDatabase(dbPath) {
  if (typeof dbPath !== 'string') throw new TypeError('cannot open');
  return { prepare: () => ({ get: () => undefined }), close() {} };
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
}

// ── bootstrap: runs at module load, BEFORE the modules under test are required ──
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-imp-home-'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-imp-scratch-'));
for (const k of ENV_KEYS) {
  envBackup[k] = process.env[k];
  delete process.env[k];
}
// redirect EVERY home-derived path (os.homedir + win env vars) into the temp home
os.homedir = () => fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.APPDATA = fakeHome;
process.env.LOCALAPPDATA = fakeHome;
const adapterId = require.resolve('../../../../config/sqlite-adapter');
require.cache[adapterId] = {
  id: adapterId, filename: adapterId, loaded: true, exports: FakeDatabase, children: [], paths: [],
};
const ideId = require.resolve('../../../gateway/adapters/ideDetector');
require.cache[ideId] = {
  id: ideId, filename: ideId, loaded: true, exports: ideStub, children: [], paths: [],
};
const cd = require('./candidateDetect');
const createImporter = require('./poolImporter');

const traeFile = path.join(scratch, 'trae-storage.json');
const srcDir = path.join(scratch, 'src');
const warpFile = cd.WARP_STORAGE_PATHS[6]; // <fakeHome>/AppData/Roaming/warp-terminal/storage.json
const kiroFile = cd.KIRO_TOKEN_PATH;
writeJson(traeFile, { traeAuth: { accessToken: T, email: 'u@corp.test' }, keepme: 1 });
fs.mkdirSync(srcDir, { recursive: true });
writeJson(path.join(srcDir, 'n.json'), { accessToken: `${T}zz`, email: 'n@corp.test' });
writeJson(warpFile, { apiKey: T, email: 'w@corp.test' });
writeJson(kiroFile, { accessToken: `${T}12`, email: 'k@corp.test' });

// Leak guard: fixture basenames vs NEW entries in the real data dirs (name-scoped, app-noise-safe).
const SUITE_FILE_NAMES = ['trae-storage.json', 'n.json', 'storage.json', 'kiro-auth-token.json'];
const GUARD_DIRS = [path.join(process.cwd(), '.khy'), path.join(origHomedir(), '.khyquant')];
const guardBaseline = new Set();
for (const dirPath of GUARD_DIRS) {
  if (fs.existsSync(dirPath)) for (const e of fs.readdirSync(dirPath)) guardBaseline.add(e);
}

after(() => {
  os.homedir = origHomedir;
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  for (const dir of [fakeHome, scratch]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Fresh importer + call recorder. `over` tweaks individual deps.
function makeImporter(over = {}) {
  const calls = { upserts: [], setActive: [], getActive: [], ensureReadyCount: 0 };
  let seq = 0;
  const state = over.state || new Map();
  const deps = {
    ensureReady: async () => {
      calls.ensureReadyCount += 1;
    },
    upsertTokenRecord: async (provider, candidate) => {
      if (over.upsertThrows) throw new Error(over.upsertThrows);
      calls.upserts.push([provider, candidate]);
      seq += 1;
      return over.upsertResult || { inserted: true, id: seq };
    },
    getActiveAccount: async (p) => {
      calls.getActive.push(p);
      return over.active === undefined ? null : over.active;
    },
    setActiveAccount: async (p, id) => {
      calls.setActive.push([p, id]);
    },
    _observedAutoImportState: state,
    TRAE_STORAGE_PATHS: over.traePaths === undefined ? [traeFile] : over.traePaths,
  };
  return { importer: createImporter(deps), calls, state };
}

test('工厂导出面：非法 deps 直接 TypeError，返回面恰好 3 个方法', () => {
  assert.throws(() => createImporter(), TypeError);
  assert.throws(() => createImporter(null), TypeError);
  assert.deepEqual(Object.keys(createImporter({
    ensureReady: async () => {}, upsertTokenRecord: async () => {}, getActiveAccount: async () => null,
    setActiveAccount: async () => {}, _observedAutoImportState: new Map(), TRAE_STORAGE_PATHS: [],
  })), ['importProviderTokens', 'autoImportObservedCredentials', 'detectWarpLocalLogin']);
});

test('trae 全链路：found/inserted/activated 与 upsert/setActive 实参按实测', async () => {
  const { importer, calls } = makeImporter();
  const r = await importer.importProviderTokens('trae');
  assert.deepEqual(r, {
    provider: 'trae',
    found: 1,
    inserted: 1,
    updated: 0,
    activated: 1,
    activatedByProvider: { trae: 1 },
    byProvider: { trae: { found: 1, inserted: 1, updated: 0, activated: 1 } },
  });
  assert.equal(calls.upserts.length, 1);
  assert.equal(calls.upserts[0][0], 'trae');
  assert.equal(calls.upserts[0][1].email, 'u@corp.test');
  assert.equal(calls.upserts[0][1].label, 'trae:u@corp.test');
  assert.equal(calls.upserts[0][1].accessToken, T);
  assert.deepEqual(calls.getActive, ['trae']);
  assert.deepEqual(calls.setActive, [['trae', 1]]);
  assert.equal(calls.ensureReadyCount, 1);
});

test('antigravity 走 nirvana broker 分支，结果与 trae 完全同形', async () => {
  const { importer } = makeImporter();
  const r = await importer.importProviderTokens('antigravity');
  assert.equal(r.provider, 'trae');
  assert.equal(r.found, 1);
  assert.deepEqual(r.byProvider.trae, { found: 1, inserted: 1, updated: 0, activated: 1 });
});

test('provider 非法与空值：错误发生在 ensureReady 之后；缺失依赖先炸', async () => {
  const { importer, calls } = makeImporter();
  await assert.rejects(() => importer.importProviderTokens('zzz'), { message: 'Unsupported provider: zzz' });
  assert.equal(calls.ensureReadyCount, 1, 'unsupported check runs AFTER ensureReady');
  for (const junk of ['', null, '   ']) {
    await assert.rejects(() => importer.importProviderTokens(junk), { message: 'provider is required' }, `${String(junk)} -> provider is required`);
  }
  // pin: an importer built from {} dies inside ensureReady (call order), NOT on provider validation
  await assert.rejects(() => createImporter({}).importProviderTokens('trae'), TypeError);
});

test('upsert/激活三态：updated 只计 updated、已有 active 不抢占、activateIfNone:false 不查询', async () => {
  const upd = makeImporter({ upsertResult: { updated: true, id: 3 } });
  const r1 = await upd.importer.importProviderTokens('trae');
  assert.equal(r1.updated, 1);
  assert.equal(r1.inserted, 0);
  assert.equal(r1.activated, 3);
  assert.deepEqual(upd.calls.setActive, [['trae', 3]]);

  const busy = makeImporter({ active: { id: 99 } });
  const r2 = await busy.importer.importProviderTokens('trae');
  assert.equal(r2.activated, null);
  assert.deepEqual(busy.calls.setActive, []);
  assert.deepEqual(r2.activatedByProvider, {});

  const off = makeImporter();
  const r3 = await off.importer.importProviderTokens('trae', { activateIfNone: false });
  assert.deepEqual(off.calls.getActive, []);
  assert.equal(r3.activated, null);
  assert.equal(r3.found, 1);
});

test('upsert 抛错即整批 reject（错误向上冒泡，无部分提交保护）', async () => {
  const { importer } = makeImporter({ upsertThrows: 'upsert-boom' });
  await assert.rejects(() => importer.importProviderTokens('trae'), /upsert-boom/);
});

test('sourcePath 合并：未知 provider 走 generic；trae 合并后 found=2', async () => {
  const { importer, calls } = makeImporter();
  const z = await importer.importProviderTokens('zzz', { sourcePath: srcDir });
  assert.equal(z.provider, 'zzz');
  assert.equal(z.found, 1);
  assert.deepEqual(z.byProvider.zzz, { found: 1, inserted: 1, updated: 0, activated: 1 });
  assert.equal(calls.upserts[0][1].email, 'n@corp.test');

  const t2 = makeImporter();
  const tr = await t2.importer.importProviderTokens('trae', { sourcePath: srcDir });
  assert.equal(tr.found, 2, 'trae storage + generic dir merge, token-deduped');
  assert.deepEqual(t2.calls.upserts.map(([, c]) => c.email).sort(), ['n@corp.test', 'u@corp.test']);
  assert.equal(tr.byProvider.trae.found, 2);
});

test('kiro 导入读 fakeHome 下 kiro-auth-token.json', async () => {
  const { importer, calls } = makeImporter();
  const r = await importer.importProviderTokens('kiro');
  assert.equal(r.provider, 'kiro');
  assert.equal(r.found, 1);
  assert.equal(r.activated, 1);
  assert.equal(calls.upserts[0][0], 'kiro');
  assert.equal(calls.upserts[0][1].email, 'k@corp.test');
  assert.equal(calls.upserts[0][1].accessToken, `${T}12`);
});

test('KNOWN-DEFECT: cursor 纯 token 存储被邮箱过滤整体丢弃 found=0', async () => {
  // Measured: cursor storage holding a perfectly valid accessToken with no email field ->
  // importProviderTokens('cursor') returns found:0. poolImporter.js:812 drops every candidate
  // whose email fails isValidEmail(null), so machine-local logins are silently unimportable.
  const curFile = cd.CURSOR_STORAGE_PATHS[0];
  writeJson(curFile, { cursorAuth: { accessToken: 'cursorTok12345678ab' } });
  try {
    const { importer } = makeImporter();
    const r = await importer.importProviderTokens('cursor');
    assert.deepEqual(r, {
      provider: 'cursor', found: 0, inserted: 0, updated: 0, activated: null,
      activatedByProvider: {}, byProvider: {},
    });
  } finally {
    fs.rmSync(curFile, { force: true });
  }
});

test('KNOWN-DEFECT: nirvana broker 给裸 refresh token 记录挂上硬编码私人邮箱入库', async () => {
  // Measured: a Nirvana storage file holding ONLY {refreshToken:'refreshTok123456789ab'}
  // imports as found:1 with email/label of 2578974124@qq.com (candidateDetect.js:184 constant,
  // attached via poolImporter.js:801 usePresetEmail for broker imports). The personal address
  // becomes the stored identity of a credential that never had one.
  const nirFile = cd.NIRVANA_STORAGE_PATHS[0];
  writeJson(nirFile, { refreshToken: 'refreshTok123456789ab' });
  try {
    const { importer, calls } = makeImporter({ traePaths: [] });
    const r = await importer.importProviderTokens('nirvana');
    assert.deepEqual(r, {
      provider: 'trae',
      found: 1,
      inserted: 1,
      updated: 0,
      activated: 1,
      activatedByProvider: { trae: 1 },
      byProvider: { trae: { found: 1, inserted: 1, updated: 0, activated: 1 } },
    });
    assert.equal(calls.upserts[0][1].email, '2578974124@qq.com');
    assert.equal(calls.upserts[0][1].label, 'trae:2578974124@qq.com');
    assert.equal(calls.upserts[0][1].refreshToken, 'refreshTok123456789ab');
    assert.equal(calls.upserts[0][1].accessToken, null);
  } finally {
    fs.rmSync(nirFile, { force: true });
  }
  // Contrast (measured): an accessToken-only Nirvana file surfaces NOTHING through the broker
  // path: importTraeCandidates claims it first with email:null, the richer preset-email variant
  // is tokenHash-deduped away (first-wins), then the isValidEmail filter drops everything.
  writeJson(nirFile, { accessToken: T });
  try {
    const { importer } = makeImporter({ traePaths: [] });
    const r2 = await importer.importProviderTokens('nirvana');
    assert.equal(r2.found, 0);
    assert.deepEqual(r2.byProvider, {});
  } finally {
    fs.rmSync(nirFile, { force: true });
  }
});

test('KNOWN-DEFECT: provider "constructor" 经 normalizePoolType 泄漏原型 Object，被当 SQL 参数写出', async () => {
  // Measured: poolImporter.js:730 normalizePoolType('constructor') returns the Object CONSTRUCTOR
  // (prototype-chain lookup, not own-property), so result.provider === Object and
  // poolImporter.js:835 calls upsertTokenRecord(<function Object>, candidate) — a function is
  // handed to the DB layer as the provider column, and stats keys stringify to
  // 'function Object() { [native code] }'.
  const { importer, calls } = makeImporter();
  const r = await importer.importProviderTokens('constructor', { sourcePath: srcDir, includeNirvana: false });
  assert.equal(r.provider, Object);
  assert.equal(r.found, 1);
  assert.equal(r.inserted, 1);
  assert.equal(r.activated, null, 'top-level activated stays null: stringify(key) !== norm function');
  assert.equal(typeof calls.upserts[0][0], 'function', 'upsertTokenRecord receives a FUNCTION as provider');
  assert.equal(String(calls.upserts[0][0]), 'function Object() { [native code] }');
  const statsKey = Object.keys(r.byProvider)[0];
  assert.equal(statsKey, 'function Object() { [native code] }');
  assert.deepEqual(r.byProvider[statsKey], { found: 1, inserted: 1, updated: 0, activated: 1 });
  assert.deepEqual(calls.setActive, [[statsKey, 1]]);
});

test('detectWarpLocalLogin 只读探测：ideDetector 桩可逐次替换', () => {
  const { importer } = makeImporter();
  assert.deepEqual(importer.detectWarpLocalLogin(), { installed: false, hasLogin: true, email: 'w@corp.test' });
  ideStub.findInstallation = () => ({ dir: 'fake' });
  assert.deepEqual(importer.detectWarpLocalLogin(), { installed: true, hasLogin: true, email: 'w@corp.test' });
  ideStub.findInstallation = () => false;
  ideStub.findDataPath = () => { throw new Error('boom'); };
  assert.deepEqual(importer.detectWarpLocalLogin(), { installed: false, hasLogin: true, email: 'w@corp.test' }, 'throwing detector degrades to installed:false');
  fs.rmSync(warpFile, { force: true });
  try {
    assert.deepEqual(importer.detectWarpLocalLogin(), { installed: false, hasLogin: false, email: null });
  } finally {
    writeJson(warpFile, { apiKey: T, email: 'w@corp.test' });
    ideStub.findDataPath = () => false;
  }
});

test('autoImportObservedCredentials 前置门：provider_required / disabled / source_not_found', async () => {
  const { importer, state } = makeImporter();
  assert.deepEqual(await importer.autoImportObservedCredentials(''), {
    provider: '', imported: false, skipped: true, reason: 'provider_required',
  });
  assert.deepEqual(await importer.autoImportObservedCredentials('trae', { enabled: false }), {
    provider: 'trae', imported: false, skipped: true, reason: 'disabled',
  });
  process.env.KHY_POOL_EVENT_AUTO_IMPORT = '0';
  try {
    assert.deepEqual(await importer.autoImportObservedCredentials('trae'), {
      provider: 'trae', imported: false, skipped: true, reason: 'disabled',
    });
  } finally {
    delete process.env.KHY_POOL_EVENT_AUTO_IMPORT;
  }
  assert.deepEqual(await importer.autoImportObservedCredentials('trae', { sourcePath: 'Z:/nope/x.zip' }), {
    provider: 'trae', sourcePath: 'Z:/nope/x.zip', imported: false, skipped: true, reason: 'source_not_found',
  });
  assert.equal(state.size, 0, 'gates short-circuit before any state is written');
});

test('autoImport 默认无源运行 + 冷却窗口 + force 重入 + 状态键', async () => {
  const { importer, state } = makeImporter();
  const r1 = await importer.autoImportObservedCredentials('trae');
  assert.equal(r1.imported, true);
  assert.equal(r1.skipped, false);
  assert.equal(r1.reason, '');
  assert.equal(r1.sourcePath, '');
  assert.equal(r1.found, 1);
  assert.equal(r1.activated, 1);
  assert.deepEqual([...state.keys()], ['trae:observed-local']);

  const r2 = await importer.autoImportObservedCredentials('trae');
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'cooldown');
  assert.equal(r2.cooldownMs, 45000);
  assert.ok(r2.sinceLastMs >= 0 && r2.sinceLastMs < 45000, `sinceLastMs=${r2.sinceLastMs}`);
  assert.equal(r2.lastResult, r1, 'cooldown hands back the previous result verbatim');

  const r3 = await importer.autoImportObservedCredentials('trae', { force: true });
  assert.equal(r3.imported, true, 'force bypasses cooldown');

  // explicit existing source -> state key carries the resolved path verbatim
  const withSrc = makeImporter();
  const s1 = await withSrc.importer.autoImportObservedCredentials('trae', { sourcePath: srcDir });
  assert.equal(s1.imported, true);
  assert.deepEqual([...withSrc.state.keys()], [`trae:${srcDir}`]);
  const s2 = await withSrc.importer.autoImportObservedCredentials('trae', { sourcePath: srcDir });
  assert.equal(s2.reason, 'cooldown');
  assert.equal(s2.sourcePath, srcDir);

  // cooldownMs is resolved through the clamp: 999999 -> 600000
  const clamped = makeImporter();
  await clamped.importer.autoImportObservedCredentials('trae', { cooldownMs: 999999 });
  const c2 = await clamped.importer.autoImportObservedCredentials('trae', { cooldownMs: 999999 });
  assert.equal(c2.cooldownMs, 600000);
});

test('autoImport 并发去重：第二个同步调用共享同一 promise 与结果', async () => {
  const { importer, calls } = makeImporter();
  const pA = importer.autoImportObservedCredentials('trae');
  const pB = importer.autoImportObservedCredentials('trae');
  assert.notEqual(pA, pB, 'outer async wrappers differ');
  const [a, b] = await Promise.all([pA, pB]);
  assert.equal(a, b, 'inFlight reuse hands back the identical result object');
  assert.equal(calls.ensureReadyCount, 1, 'only one underlying import run');
});

test('KNOWN-DEFECT: autoImport 失败也烧冷却窗口，import_failed 后立刻重试只拿到 cooldown', async () => {
  // Measured: poolImporter.js:964 sets state.lastAt = Date.now() BEFORE the try block, so a
  // failed import (here: upsert throws) consumes the full 45s cooldown; the retry that could
  // have succeeded is skipped.
  const { importer } = makeImporter({ upsertThrows: 'upsert-boom2' });
  const r1 = await importer.autoImportObservedCredentials('trae');
  assert.deepEqual(r1, {
    provider: 'trae', sourcePath: '', imported: false, skipped: true,
    reason: 'import_failed', error: 'upsert-boom2',
  });
  const r2 = await importer.autoImportObservedCredentials('trae');
  assert.equal(r2.reason, 'cooldown');
  assert.equal(r2.lastResult, r1);
});

test('收尾守卫：本套件凭据夹具文件名未出现在真实数据目录（repo .khy / ~/.khyquant）', () => {
  const leaks = [];
  for (const dirPath of GUARD_DIRS) {
    if (!fs.existsSync(dirPath)) continue;
    for (const e of fs.readdirSync(dirPath)) {
      if (!guardBaseline.has(e) && SUITE_FILE_NAMES.includes(e)) leaks.push(`${dirPath}${path.sep}${e}`);
    }
  }
  assert.deepEqual(leaks, [], 'no fixture writes landed in repo .khy or ~/.khyquant');
  assert.ok(warpFile.startsWith(fakeHome) && kiroFile.startsWith(fakeHome));
  assert.ok(traeFile.startsWith(scratch) && srcDir.startsWith(scratch));
});
