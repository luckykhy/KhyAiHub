'use strict';

// Co-located contract tests for poolSync.js (active pool account -> local IDE storage write-back).
// All values below are MEASURED (probes .khyos/tmp/probeImporterSync.js).
// Strategy: os.homedir AND USERPROFILE/APPDATA/LOCALAPPDATA are redirected to a fresh mkdtemp
// BEFORE requiring, so every write-back default path lands inside the temp home; sqlite-adapter
// is stubbed through require.cache and db reads come from injected deps. The suite never writes
// to the real home, repo .khy/ or ~/.khyquant (verified by the name-scoped leak guard).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const fs = require('fs');
const path = require('path');

const ENV_KEYS = [
  'KIRO_TOKEN_PATH', 'NIRVANA_TRAE_CACHE', 'NIRVANA_DEFAULT_LOGIN_EMAIL', 'NIRVANA_IMPORT_PATH',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
];

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const origHomedir = os.homedir;
const envBackup = {};

function FakeDatabase(dbPath) {
  if (typeof dbPath !== 'string') throw new TypeError('cannot open');
  return { prepare: () => ({ get: () => undefined }), close() {} };
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// ── bootstrap: runs at module load, BEFORE the modules under test are required ──
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sync-home-'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sync-scratch-'));
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
const cd = require('./candidateDetect'); // same instance poolSync requires
const createSync = require('./poolSync');

const traeFile = path.join(scratch, 'trae-storage.json');
const kiroFile = cd.KIRO_TOKEN_PATH; // lands under fakeHome because homedir is patched at load
writeJson(traeFile, { traeAuth: { accessToken: 'oldToken12345678ab', email: 'old@corp.test' }, keepme: 1 });
writeJson(kiroFile, { extraKeep: 1 });

// Leak guard: fixture basenames vs NEW entries in the real data dirs (name-scoped, app-noise-safe).
const SUITE_FILE_NAMES = ['trae-storage.json', 'kiro-auth-token.json', 'storage.json', 'never-written.json'];
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

// Fresh sync instance + call recorder. `over` tweaks individual deps.
function makeSync(over = {}) {
  const calls = { getActive: [], ensureReadyCount: 0 };
  const deps = {
    ensureReady: async () => {
      calls.ensureReadyCount += 1;
    },
    getActiveAccount: async (p) => {
      calls.getActive.push(p);
      if (over.activeThrows) throw new Error(over.activeThrows);
      return over.active === undefined ? null : over.active;
    },
    TRAE_STORAGE_PATHS: over.traePaths === undefined ? [traeFile] : over.traePaths,
  };
  return { sync: createSync(deps), calls };
}

test('工厂导出面：非法 deps 直接 TypeError，返回面恰好 2 个方法', () => {
  assert.throws(() => createSync(), TypeError);
  assert.throws(() => createSync(null), TypeError);
  assert.deepEqual(Object.keys(makeSync().sync), ['syncActiveAccountToLocal', 'getWatchablePaths']);
});

test('入参与空状态门：provider 空先过 ensureReady、无 active、无存储路径', async () => {
  const a = makeSync();
  await assert.rejects(() => a.sync.syncActiveAccountToLocal(''), { message: 'provider is required' });
  assert.equal(a.calls.ensureReadyCount, 1, 'validation runs AFTER ensureReady (poolSync.js:233-236)');

  const b = makeSync();
  assert.deepEqual(await b.sync.syncActiveAccountToLocal('trae'), {
    provider: 'trae', attempted: 0, updated: 0, reason: 'no_active_account', paths: [],
  });
  assert.deepEqual(b.calls.getActive, ['trae'], 'lookup uses the normalized provider');

  const c = makeSync({ active: { accessToken: 'x' } });
  assert.deepEqual(await c.sync.syncActiveAccountToLocal('foo'), {
    provider: 'foo', attempted: 0, updated: 0, reason: 'no_storage_path', paths: [],
  });
});

test('getActiveAccount 抛错直接向上 reject（无内部吞异常）', async () => {
  const { sync } = makeSync({ activeThrows: 'db-down' });
  await assert.rejects(() => sync.syncActiveAccountToLocal('cursor'), /db-down/);
});

test('cursor 默认路径：目录自动创建，嵌套+扁平双份键与 source/updatedAt 落盘', async () => {
  const target = cd.CURSOR_STORAGE_PATHS[0];
  const { sync } = makeSync({ active: { accessToken: 'cursorPOOL12345678ab', email: 'c2@corp.test' } });
  const r = await sync.syncActiveAccountToLocal('cursor');
  assert.deepEqual(r, {
    provider: 'cursor', attempted: 1, updated: 1, paths: [target], errors: [],
  });
  const p = readJson(target);
  assert.equal(p.cursorAuth.accessToken, 'cursorPOOL12345678ab');
  assert.equal(p.cursorAuth.email, 'c2@corp.test');
  assert.equal(p.cursorAuth.source, 'khy-pool');
  assert.match(p.cursorAuth.updatedAt, ISO);
  assert.equal(p['cursorAuth/accessToken'], 'cursorPOOL12345678ab');
  assert.equal(p['cursorAuth/email'], 'c2@corp.test');
  assert.equal('cursorAuth/expiresAt' in p, false, 'no expiresAt keys when account has none');
  assert.equal('expiresAt' in p.cursorAuth, false);
});

test('KNOWN-DEFECT: cursor 轮换后旧扁平邮箱键存活，身份与新凭据不一致', async () => {
  // Measured: poolSync.js:171-173 shallow-spreads the old file, and a token-only account
  // writes only cursorAuth/accessToken. The stale flat 'cursorAuth/email' from the PREVIOUS
  // account survives next to the new token (nested cursorAuth has no email at all), so the
  // local IDE keeps showing the old identity against rotated credentials.
  const target = path.join(scratch, 'cursor-stale', 'storage.json');
  writeJson(target, { 'cursorAuth/email': 'old@corp.test', other: 1 });
  const { sync } = makeSync({ active: { accessToken: 'cursorNEW12345678ab' } });
  const r = await sync.syncActiveAccountToLocal('cursor', { targetPath: target });
  assert.equal(r.updated, 1);
  const p = readJson(target);
  assert.equal(p['cursorAuth/accessToken'], 'cursorNEW12345678ab');
  assert.equal(p['cursorAuth/email'], 'old@corp.test', 'STALE identity survived the rotation');
  assert.equal('email' in p.cursorAuth, false);
  assert.equal(p.other, 1);
});

test('trae 全量合并：keepme 保留，traeAuth/nirvanaAuth 与全部扁平键逐一实测', async () => {
  const acc = {
    accessToken: 'traePOOL12345678ab',
    refreshToken: 'rTraePOOL1234567',
    email: 's@corp.test',
    authData: {
      host: 'https://h',
      userJwt: 'jwtVAL1234567890ab',
      userInfo: { n: 1 },
      callback: { x: 'y' },
      refreshExpireAt: 'rfe',
    },
  };
  const { sync } = makeSync({ active: acc });
  const r = await sync.syncActiveAccountToLocal('trae');
  assert.deepEqual(r, { provider: 'trae', attempted: 1, updated: 1, paths: [traeFile], errors: [] });
  const p = readJson(traeFile);
  assert.match(p.traeAuth.updatedAt, ISO);
  assert.match(p.nirvanaAuth.updatedAt, ISO);
  assert.deepEqual(p, {
    keepme: 1,
    traeAuth: {
      accessToken: acc.accessToken,
      refreshToken: acc.refreshToken,
      email: acc.email,
      host: 'https://h',
      userJwt: acc.authData.userJwt,
      userInfo: { n: 1 },
      source: 'khy-pool',
      updatedAt: p.traeAuth.updatedAt,
    },
    'traeAuth/accessToken': acc.accessToken,
    'traeAuth/refreshToken': acc.refreshToken,
    'traeAuth/email': acc.email,
    nirvanaAuth: {
      accessToken: acc.accessToken,
      refreshToken: acc.refreshToken,
      email: acc.email,
      refreshExpireAt: 'rfe',
      host: 'https://h',
      userJwt: acc.authData.userJwt,
      userInfo: { n: 1 },
      callback: { x: 'y' },
      source: 'khy-pool',
      updatedAt: p.nirvanaAuth.updatedAt,
    },
    'nirvanaAuth/accessToken': acc.accessToken,
    'nirvanaAuth/refreshToken': acc.refreshToken,
    'nirvanaAuth/email': acc.email,
    'nirvanaAuth/refreshExpireAt': 'rfe',
    'nirvanaAuth/host': 'https://h',
    'nirvanaAuth/userJwt': acc.authData.userJwt,
  });
});

test('kiro 为全量替换写入：旧文件多余键（extraKeep）被丢弃', async () => {
  const { sync } = makeSync({ active: { accessToken: 'kiroNEW1234567890ab' } });
  const r = await sync.syncActiveAccountToLocal('kiro');
  assert.ok(r.paths.includes(kiroFile), 'existing candidate path is resolved');
  assert.equal(r.updated, r.paths.length);
  assert.equal(r.updated >= 1, true);
  const p = readJson(kiroFile);
  assert.equal('extraKeep' in p, false, 'kiro write-back REPLACES the file (poolSync.js:256-264)');
  assert.match(p.updatedAt, ISO);
  assert.deepEqual(p, {
    accessToken: 'kiroNEW1234567890ab',
    refreshToken: '',
    email: '',
    expiresAt: null,
    provider: 'kiro',
    authMethod: 'pool',
    updatedAt: p.updatedAt,
  });
});

test('warp 形态：endpoint 进嵌套 warpAuth 且复制为顶层 endpoint（无扁平 warpAuth/endpoint）', async () => {
  const target = path.join(scratch, 'warp-sync', 'storage.json');
  writeJson(target, {});
  const { sync } = makeSync({ active: {
    accessToken: 'warpPOOL12345678ab',
    email: 'w2@corp.test',
    authData: { endpoint: 'https://ep' },
  } });
  const r = await sync.syncActiveAccountToLocal('warp', { targetPath: target });
  assert.equal(r.updated, 1);
  const p = readJson(target);
  assert.equal(p.warpAuth.endpoint, 'https://ep');
  assert.equal(p.endpoint, 'https://ep', 'endpoint is ALSO hoisted to top level (poolSync.js:222)');
  assert.equal('warpAuth/endpoint' in p, false);
  assert.equal(p['warpAuth/accessToken'], 'warpPOOL12345678ab');
  assert.equal(p['warpAuth/email'], 'w2@corp.test');
  assert.equal('warpAuth/expiresAt' in p, false);
});

test('KNOWN-DEFECT: 未知 provider 带 targetPath 时静默 no-op，却汇报 attempted:1', async () => {
  // Measured: poolSync.js:278-279 `continue`s for providers without a shape branch, so nothing
  // is written, yet the return still reports attempted = paths.length = 1 with empty errors.
  // Callers cannot distinguish "synced" from "silently skipped".
  const target = path.join(scratch, 'never-written.json');
  const { sync } = makeSync({ active: { accessToken: 'whatever12345678ab' } });
  const r = await sync.syncActiveAccountToLocal('foo', { targetPath: target });
  assert.deepEqual(r, { provider: 'foo', attempted: 1, updated: 0, paths: [], errors: [] });
  assert.equal(fs.existsSync(target), false);
});

test('targetPath 为空白串时回落默认路径解析', async () => {
  const { sync } = makeSync({ active: { accessToken: 'traePOOL12345678ab' } });
  const r = await sync.syncActiveAccountToLocal('trae', { targetPath: '   ' });
  assert.deepEqual(r.paths, [traeFile], 'blank targetPath trims away (poolSync.js:77), defaults to existing trae storage');
});

test('损坏 JSON 被凭据 JSON 整体替换；KNOWN-DEFECT: 数组 JSON 被展开成数字键对象', async () => {
  const junkDir = path.join(scratch, 'junk');
  fs.mkdirSync(junkDir, { recursive: true });
  const junk = path.join(junkDir, 'storage.json');
  fs.writeFileSync(junk, 'not json at all {', 'utf8');
  const { sync } = makeSync({ active: { accessToken: 'cursorPOOL12345678ab', email: 'j@corp.test' } });
  const r = await sync.syncActiveAccountToLocal('cursor', { targetPath: junk });
  assert.equal(r.updated, 1);
  const p = readJson(junk);
  assert.deepEqual(Object.keys(p).sort(), ['cursorAuth', 'cursorAuth/accessToken', 'cursorAuth/email']);
  assert.equal(p.cursorAuth.accessToken, 'cursorPOOL12345678ab');

  // Measured KNOWN-DEFECT: a JSON ARRAY in the storage file parses as an object (poolSync.js:56-67)
  // and spreads into numeric keys ("0":1,"1":2) that then persist inside the credential file (:173).
  const arr = path.join(scratch, 'arr', 'storage.json');
  fs.mkdirSync(path.dirname(arr), { recursive: true });
  fs.writeFileSync(arr, '[1,2]', 'utf8');
  const r2 = await sync.syncActiveAccountToLocal('cursor', { targetPath: arr });
  assert.equal(r2.updated, 1);
  const p2 = readJson(arr);
  assert.equal(p2[0], 1);
  assert.equal(p2[1], 2);
  assert.equal(p2.cursorAuth.accessToken, 'cursorPOOL12345678ab');
});

test('targetPath 指向目录：EISDIR 计入 errors，updated 保持 0', async () => {
  const dirPath = path.join(scratch, 'a-dir');
  fs.mkdirSync(dirPath, { recursive: true });
  const { sync } = makeSync({ active: { accessToken: 'cursorPOOL12345678ab' } });
  const r = await sync.syncActiveAccountToLocal('cursor', { targetPath: dirPath });
  assert.equal(r.attempted, 1);
  assert.equal(r.updated, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].path, dirPath);
  assert.match(r.errors[0].error, /EISDIR/);
});

test('getWatchablePaths 全量 10 条：cursor 6 + trae 1 + kiro 3，全部 fakeHome 域', () => {
  const { sync } = makeSync();
  const all = sync.getWatchablePaths();
  assert.equal(all.length, 10);
  assert.deepEqual(all, [
    ...cd.CURSOR_STORAGE_PATHS.map((p) => ({ provider: 'cursor', path: p, type: 'json' })),
    ...cd.CURSOR_DB_PATHS.map((p) => ({ provider: 'cursor', path: p, type: 'vscdb' })),
    { provider: 'trae', path: traeFile, type: 'json' },
    ...[
      path.join(fakeHome, '.aws', 'sso', 'cache', 'kiro-auth-token.json'),
      path.join(fakeHome, 'aws', 'sso', 'cache', 'kiro-auth-token.json'),
      path.join(fakeHome, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'auth.json'),
    ].map((p) => ({ provider: 'kiro', path: p, type: 'json' })),
  ]);
  assert.deepEqual([...new Set(all.map((e) => e.type))].sort(), ['json', 'vscdb']);
  assert.deepEqual(sync.getWatchablePaths('nirvana'), sync.getWatchablePaths('trae'), 'nirvana aliases to the trae branch');
  assert.deepEqual(sync.getWatchablePaths('foo'), []);
});

test('KNOWN-DEFECT: getWatchablePaths("") 等同省略参数，返回全部 provider 路径', () => {
  // Measured: poolSync.js:307 branches on truthiness, so an empty-string provider filter
  // silently watches cursor/trae/kiro instead of nothing — callers passing a blanked-out
  // config value widen the watch surface. Prototype keys degrade to [] (harmless here).
  const { sync } = makeSync();
  assert.deepEqual(sync.getWatchablePaths(''), sync.getWatchablePaths());
  assert.equal(sync.getWatchablePaths('').length, 10);
  assert.deepEqual(sync.getWatchablePaths('constructor'), [], 'leaked Object never matches a branch -> empty');
});

test('收尾守卫：真实数据目录未被本套件写入（repo .khy / ~/.khyquant）', () => {
  for (const dirPath of GUARD_DIRS) {
    if (!fs.existsSync(dirPath)) continue;
    const fresh = fs.readdirSync(dirPath).filter((e) => !guardBaseline.has(e));
    assert.deepEqual(
      fresh.filter((e) => SUITE_FILE_NAMES.includes(e)), [],
      `suite fixture escaped into ${dirPath}`,
    );
  }
  assert.ok(traeFile.startsWith(scratch) && kiroFile.startsWith(fakeHome));
  assert.ok(cd.CURSOR_STORAGE_PATHS.every((p) => p.startsWith(fakeHome)));
});
