'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SRC = __dirname;
const BACKSLASH = String.fromCharCode(92);

// ── require.cache seams (installed BEFORE backupService is required, restored in after()) ──
const SEAM_PATHS = {
  sqliteHotCopy: path.resolve(SRC, 'sqliteHotCopy.js'),
  storageRoots: path.resolve(SRC, '../../../../utils/storageRoots.js'),
  dataHome: path.resolve(SRC, '../../../../utils/dataHome.js'),
  sqliteAdapter: path.resolve(SRC, '../../../../config/sqlite-adapter.js'),
  spawn: path.resolve(SRC, '../../../../utils/spawnWithIdleTimeout.js'),
  atomic: path.resolve(SRC, '../../../../utils/atomicWriteJson.js'),
};

const state = {
  hotCopy: null,
  freeBytes: 1024 * 1024 * 1024,
  spawn: null,
  atomicFails: false,
  dataHomeCalls: [],
};

const savedEntries = new Map();
const realAtomic = require(SEAM_PATHS.atomic);
const realDataHome = require(SEAM_PATHS.dataHome);

let tmpRoot = '';
function newTmpRoot() {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b45e-'));
  return tmpRoot;
}
newTmpRoot();
function tmpJoin(...segs) {
  return path.join(tmpRoot, ...segs);
}

function installSeam(key, exports) {
  savedEntries.set(key, require.cache[key]);
  require.cache[key] = { id: key, filename: key, loaded: true, exports };
}

installSeam(SEAM_PATHS.sqliteHotCopy, {
  // Default double: writes a stand-in copy so backupService's sha256 pass has real bytes.
  // No test ever reaches a real SQLite handle through this seam.
  hotCopySqlite: (sourcePath, targetPath) => {
    if (state.hotCopy) return state.hotCopy(sourcePath, targetPath);
    // createBackup() only creates the set dir, not the db/ subdir — the real
    // hotCopySqlite does this at sqliteHotCopy.js, so the double must too.
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, Buffer.alloc(64, 9));
    return { ok: true, bytes: 64, journalMode: 'wal', integrity: 'ok', durationMs: 1, error: null };
  },
  restoreSqliteInPlace: (backupPath, targetPath) => ({
    ok: true, error: null, removedSidecars: [], backupPath, targetPath,
  }),
});

installSeam(SEAM_PATHS.storageRoots, {
  ...require(SEAM_PATHS.storageRoots),
  freeBytesFor: () => state.freeBytes,
});

installSeam(SEAM_PATHS.dataHome, {
  ...realDataHome,
  getDataDir: (...segs) => {
    state.dataHomeCalls.push(['getDataDir', ...segs]);
    return tmpJoin('dh', ...segs);
  },
  getDataHome: () => {
    state.dataHomeCalls.push(['getDataHome']);
    return tmpJoin('dh-home');
  },
  getProjectDataHome: () => {
    state.dataHomeCalls.push(['getProjectDataHome']);
    return tmpJoin('dh-home');
  },
  getAppHome: () => {
    state.dataHomeCalls.push(['getAppHome']);
    return tmpJoin('app-home-nonexistent');
  },
});

installSeam(SEAM_PATHS.sqliteAdapter, { __driverInfo: { type: 'node:sqlite' } });

installSeam(SEAM_PATHS.spawn, {
  spawnWithIdleTimeout: async (bin, args, opts) => {
    if (state.spawn) return state.spawn(bin, args, opts);
    return { code: 0, stdout: '', stderr: '' };
  },
});

installSeam(SEAM_PATHS.atomic, Object.assign(
  (...args) => (state.atomicFails ? false : realAtomic(...args)),
  realAtomic
));

after(() => {
  for (const [key, saved] of savedEntries) {
    if (saved) require.cache[key] = saved;
    else delete require.cache[key];
  }
  savedEntries.clear();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const svc = require('./backupService.js');
const mf = require('./backupManifest.js');
const { BACKUP, COLD_EXPORT } = require('../../../../constants/serviceDefaults');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-01T00:00:00Z');

function makeHome(name, files = {}) {
  const dir = tmpJoin('homes', name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function sha(bufOrFile) {
  if (Buffer.isBuffer(bufOrFile)) return crypto.createHash('sha256').update(bufOrFile).digest('hex');
  return crypto.createHash('sha256').update(fs.readFileSync(bufOrFile)).digest('hex');
}
const shaStr = (s) => sha(Buffer.from(s, 'utf8'));

// The engine reads process.env for the manifest's dbMode/postgres source while the dump itself
// honours opts.env, so the assertions about it must not depend on the ambient environment.
const DB_ENV_KEYS = ['DB_MODE', 'DB_TYPE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_PASSWORD'];
async function withDbEnvCleared(fn) {
  const saved = {};
  for (const k of DB_ENV_KEYS) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    delete process.env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of DB_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('resolveBackupRoot / resolveHomes', () => {
  test('opts.root 优先且被绝对化，注入时完全不碰 dataHome', () => {
    state.dataHomeCalls = [];
    const rel = path.join('a', 'b');
    assert.equal(svc.resolveBackupRoot({ root: rel }), path.resolve(rel));
    const abs = tmpJoin('explicit-root');
    assert.equal(svc.resolveBackupRoot({ root: abs }), abs);
    assert.deepEqual(state.dataHomeCalls, []);
  });

  test('空串 root 是「没指定」而不是当前工作目录', () => {
    state.dataHomeCalls = [];
    const fell = svc.resolveBackupRoot({ root: '' });
    assert.equal(fell, svc.resolveBackupRoot({}));
    assert.notEqual(fell, process.cwd());
    assert.equal(path.isAbsolute(fell), true);
  });

  test('无 root 时按 BACKUP.ROOT 常量、再回落 dataHome 的 backups 子目录', () => {
    state.dataHomeCalls = [];
    const got = svc.resolveBackupRoot();
    if (BACKUP.ROOT) {
      assert.equal(got, path.resolve(BACKUP.ROOT));
      assert.deepEqual(state.dataHomeCalls, []);
    } else {
      assert.equal(got, tmpJoin('dh', 'backups'));
      assert.deepEqual(state.dataHomeCalls, [['getDataDir', 'backups']]);
    }
  });

  test('opts.homes 注入只做双真值过滤，不查磁盘', () => {
    const homes = [
      { role: 'user', dir: '/tmp/u' },
      { role: '', dir: '/tmp/x' },
      { role: 'project', dir: '' },
      { role: 'app', dir: 0 },
      null,
      undefined,
      'string',
      42,
      {},
    ];
    assert.deepEqual(svc.resolveHomes({ homes }), [{ role: 'user', dir: '/tmp/u' }]);
    assert.deepEqual(svc.resolveHomes({ homes: [] }), []);
    assert.deepEqual(svc.resolveHomes({ homes: 'not-an-array' }).length, 0);
  });

  test('缺省解析：去重（Windows 大小写不敏感）并跳过不存在与抛错的家目录', () => {
    state.dataHomeCalls = [];
    // The dataHome seam points getDataHome()/getProjectDataHome() at tmpJoin('dh-home'),
    // and resolveHomes() deliberately skips dirs that do not exist — so this fixture has
    // to create it, otherwise default resolution yields nothing at all.
    fs.mkdirSync(tmpJoin('dh-home'), { recursive: true });
    const resolved = svc.resolveHomes({});
    assert.deepEqual(resolved.map((h) => h.role), ['user'], 'project resolves onto the same dir and app does not exist');
    fs.writeFileSync(tmpJoin('app-home-nonexistent'), 'x');
    const withApp = svc.resolveHomes({});
    assert.deepEqual(withApp.map((h) => h.role), ['user', 'app']);
    fs.rmSync(tmpJoin('app-home-nonexistent'));
    // NOTE (2026-10-10): this block used to swap require.cache[dataHome] for a module whose
    // resolvers all throw, asserting resolveHomes({}) === []. That swap never took effect —
    // backupService.js binds `const dh = require('.../dataHome')` at load time (L39), long
    // before this suite runs, so it keeps calling the seam installed at L72. The assertion
    // only ever passed because none of the home dirs existed. What is actually verified here
    // is the existence filter, so drop the homes and assert the empty result directly.
    fs.rmSync(tmpJoin('dh-home'), { recursive: true, force: true });
    assert.deepEqual(svc.resolveHomes({}), []);
  });
});

describe('collectHomeFiles：按资产规则分柜', () => {
  test('SQLite / 日志 / PID / 锁 / 原子残留被排除，状态文件带 role 前缀记账', () => {
    newTmpRoot();
    const home = makeHome('walk', {
      'config.json': '{}',
      'sessions.jsonl': '{"a":1}\n',
      'taskboard.db': 'binary',
      'taskboard.db-wal': 'binary',
      'app.log': 'noise',
      'daemon.pid': '123',
      'x.lock': 'l',
      'manifest.json.tmp-4242': 'residue',
      'nested/deep/state.json': '[]',
    });
    const r = svc.collectHomeFiles(home, 'user', 'full', tmpJoin('root-outside'));
    assert.deepEqual(r.files.map((f) => f.rel), ['config.json', 'nested/deep/state.json', 'sessions.jsonl']);
    assert.deepEqual(r.excluded.map((e) => e.path).sort(), [
      'user:app.log',
      'user:daemon.pid',
      'user:manifest.json.tmp-4242',
      'user:taskboard.db',
      'user:taskboard.db-wal',
      'user:x.lock',
    ]);
  });

  test('core 级剪掉流水目录，full 级收下；非法 tier 按 core 处理', () => {
    newTmpRoot();
    const home = makeHome('tiers', {
      'audit/a.jsonl': '{}\n',
      'receipts/r.jsonl': '{}\n',
      'cognitive_snapshots/s.json': '{}',
      'config.json': '{}',
    });
    const root = tmpJoin('root-outside');
    const core = svc.collectHomeFiles(home, 'user', 'core', root);
    assert.deepEqual(core.files.map((f) => f.rel), ['config.json']);
    assert.deepEqual(core.excluded, [
      { path: 'user:audit', reason: '审计流水(10 MB / 1300+ 文件),core 级不收' },
      { path: 'user:cognitive_snapshots', reason: '认知快照流水,core 级不收' },
      { path: 'user:receipts', reason: '工具调用凭据流水,core 级不收' },
    ]);
    const full = svc.collectHomeFiles(home, 'user', 'full', root);
    assert.deepEqual(full.files.map((f) => f.rel).sort(), [
      'audit/a.jsonl',
      'cognitive_snapshots/s.json',
      'config.json',
      'receipts/r.jsonl',
    ]);
    assert.deepEqual(full.excluded, [], 'full 级没有任何可解释的排除项');
    assert.deepEqual(svc.collectHomeFiles(home, 'user', 'bogus', root), core, '非法分级 = core 分级');
  });

  test('分级字符串的容错：大小写与首尾空白仍算 full，null/对象退回 core', () => {
    newTmpRoot();
    const home = makeHome('tiercase', { 'audit/a.jsonl': '{}\n' });
    const root = tmpJoin('root-outside');
    for (const tier of ['FULL', '  full  ', 'Full']) {
      assert.deepEqual(svc.collectHomeFiles(home, 'user', tier, root).files.map((f) => f.rel), ['audit/a.jsonl'], tier);
    }
    for (const tier of [null, undefined, 0, NaN, {}, [], () => {}]) {
      assert.deepEqual(svc.collectHomeFiles(home, 'user', tier, root).files, [], String(tier));
    }
  });

  test('备份根落在家目录内部时整棵剪掉，防递归', () => {
    newTmpRoot();
    const home = makeHome('selfhost', {
      'config.json': '{}',
      'data/backups/keepme.json': '{}',
    });
    const inside = path.join(home, 'data', 'backups');
    const r = svc.collectHomeFiles(home, 'user', 'full', inside);
    assert.deepEqual(r.files.map((f) => f.rel), ['config.json']);
    assert.deepEqual(r.excluded, [{ path: 'user:data/backups', reason: '备份根目录自身(防递归)' }]);
    // The `backups` prune is name-based, not root-relative: see the sibling suite
    // 「符号链接不跟随，命名冲突的目录名 logs/tmp/backups 一律剪」 which pins that a
    // directory named `backups` is dropped wherever it sits. So even with the backup
    // root pointed elsewhere, data/backups/ is still excluded.
    const other = svc.collectHomeFiles(home, 'user', 'full', tmpJoin('elsewhere'));
    assert.deepEqual(other.files.map((f) => f.rel).sort(), ['config.json']);
  });

  test('幽灵 *.json 目录整棵剪掉，其子文件根本不被遍历', () => {
    newTmpRoot();
    const home = makeHome('phantom', { 'api_keys.json/inner.txt': 'x', 'keep.json': '{}' });
    const r = svc.collectHomeFiles(home, 'user', 'full', tmpJoin('root2'));
    assert.deepEqual(r.files.map((f) => f.rel), ['keep.json']);
    assert.deepEqual(r.excluded, [
      { path: 'user:api_keys.json', reason: '幽灵 *.json 目录(dataHome 误用产物,非状态)' },
    ]);
  });

  test('符号链接不跟随，命名冲突的目录名 logs/tmp/backups 一律剪', () => {
    newTmpRoot();
    const home = makeHome('links', { 'logs/a.log': 'x', 'tmp/b.json': '{}', 'backups/c.json': '{}', 'keep.json': '{}' });
    const r = svc.collectHomeFiles(home, 'user', 'full', tmpJoin('root-sym'));
    assert.deepEqual(r.files.map((f) => f.rel), ['keep.json']);
    assert.deepEqual(r.excluded.map((e) => [e.path, e.reason]), [
      ['user:backups', '备份集自身(防递归)'],
      ['user:logs', '日志,非状态'],
      ['user:tmp', '临时目录'],
    ]);
    const link = path.join(home, 'pointing');
    try {
      fs.symlinkSync(path.join(home, 'keep.json'), link, 'file');
      const withLink = svc.collectHomeFiles(home, 'user', 'full', tmpJoin('root-sym'));
      assert.deepEqual(withLink.files.map((f) => f.rel), ['keep.json']);
      assert.deepEqual(withLink.excluded.find((e) => e.path === 'user:pointing'), {
        path: 'user:pointing',
        reason: '符号链接,不跟随',
      });
    } catch (err) {
      // Windows 上非特权账户创建符号链接会被拒绝：这不是被测行为，如实说明即可。
      assert.match(String(err.code || ''), /EPERM|ENOSYS/, String(err));
    }
  });

  test('两张表都按路径升序，输出与 readdir 顺序无关', () => {
    newTmpRoot();
    const home = makeHome('sorted', {
      'z.json': '{}', 'a.json': '{}', 'm.log': 'x', 'b.json': '{}', 'n.log': 'x',
    });
    const r = svc.collectHomeFiles(home, 'user', 'core', tmpJoin('root3'));
    assert.deepEqual(r.files.map((f) => f.rel), ['a.json', 'b.json', 'z.json']);
    assert.deepEqual(r.excluded.map((e) => e.path), ['user:m.log', 'user:n.log']);
  });

  test('家目录不存在时只报一条根目录不可读', () => {
    newTmpRoot();
    const r = svc.collectHomeFiles(tmpJoin('never-created'), 'project', 'full', tmpJoin('root4'));
    assert.deepEqual(r.files, []);
    assert.equal(r.excluded.length, 1);
    assert.equal(r.excluded[0].path, '.');
    assert.match(r.excluded[0].reason, /^目录不可读: /);
  });

  test('KNOWN-DEFECT: 名为 constructor 的目录被剪，manifest 落盘时理由整个消失', () => {
    // End-to-end evidence for backupAssetPlan.js:267: classifyDir reads the exclusion table
    // through the prototype chain, so a directory named `constructor` yields
    // reason = Object's constructor (a Function). backupService writes that straight into
    // manifest.excluded (:205) and JSON.stringify drops function values — the manifest then
    // says the directory was excluded for no stated reason, which is the "沉默" the module
    // header exists to prevent.
    newTmpRoot();
    const home = makeHome('proto', { 'constructor/inner.json': '{}', 'config.json': '{}' });
    const r = svc.collectHomeFiles(home, 'user', 'core', tmpJoin('root5'));
    assert.equal(typeof r.excluded[0].reason, 'function');
    // The pinned defect is that `reason` vanishes through the JSON round-trip.
    // collectHomeFiles only ever emits { path, reason } — it does not spread
    // classifyDir's `prune` — so the surviving object carries no `prune` key at all.
    assert.deepEqual(JSON.parse(JSON.stringify({ excluded: r.excluded })), {
      excluded: [{ path: 'user:constructor' }],
    });
    assert.equal(JSON.parse(JSON.stringify({ excluded: r.excluded })).excluded[0].reason, undefined);
  });
});

describe('dumpPostgres：可选子进程分支（spawn 被桩替换，绝不真起进程）', () => {
  const PG_ENV = {
    DB_MODE: 'postgres',
    DB_HOST: 'pghost',
    DB_PORT: '6000',
    DB_USER: 'pguser',
    DB_NAME: 'mydb',
    DB_PASSWORD: 'secret',
  };

  test('DB_MODE/DB_TYPE 不是 postgres 时整段跳过并说明原因', async () => {
    newTmpRoot();
    const cases = [
      [{}, 'auto'],
      [{ DB_MODE: 'auto' }, 'auto'],
      [{ DB_TYPE: 'mysql' }, 'mysql'],
      [{ DB_MODE: 'POSTGRES-x' }, 'postgres-x'],
      [{ DB_MODE: null, DB_TYPE: '' }, 'auto'],
      [{ DB_MODE: 0, DB_TYPE: false }, 'auto'],
      [{ DB_MODE: ' sqlite ' }, ' sqlite '],
      [{ DB_TYPE: 'postgresql' }, 'postgresql'],
      [{ DB_TYPE: 'PostgreSQL' }, 'postgresql'],
    ];
    for (const [env, mode] of cases) {
      const target = tmpJoin(`skip-${mode.trim()}.dump`);
      const r = await svc.dumpPostgres(target, { env });
      assert.equal(r.ok, true, `${mode} 的跳过不是失败`);
      assert.equal(r.skipped, true);
      assert.equal(r.bytes, 0);
      assert.equal(r.reason, `DB_MODE=${mode},非 postgres,跳过 pg_dump`);
      assert.equal(fs.existsSync(target), false, '跳过路径不落目录也不建文件');
    }
    const upper = await svc.dumpPostgres(tmpJoin('upper.dump'), { env: { DB_MODE: 'POSTGRES' } });
    assert.equal(upper.skipped, false, 'mode 大小写不敏感：POSTGRES 会真的起 pg_dump');
  });

  test('postgres 模式：成功导出按文件实际大小记账，父目录自动创建', async () => {
    newTmpRoot();
    const target = tmpJoin('db', 'postgres.dump');
    state.spawn = async () => {
      fs.writeFileSync(target, Buffer.alloc(1234, 1));
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await svc.dumpPostgres(target, { env: PG_ENV });
    assert.deepEqual(r, { ok: true, skipped: false, reason: '', bytes: 1234 });
    assert.equal(fs.existsSync(target), true);
  });

  test('pg_dump 退出码非 0 时带上 stderr 末三行', async () => {
    newTmpRoot();
    state.spawn = async () => ({ code: 2, stdout: '', stderr: 'a\nb\nc\nd\n' });
    const r = await svc.dumpPostgres(tmpJoin('x.dump'), { env: PG_ENV });
    assert.equal(r.ok, false);
    assert.equal(r.bytes, 0);
    assert.equal(r.reason, 'pg_dump 退出码 2: b c d');
  });

  test('pg_dump 产出空文件算失败（宁可没有备份，也不要一份空的）', async () => {
    newTmpRoot();
    const target = tmpJoin('empty.dump');
    state.spawn = async () => {
      fs.writeFileSync(target, '');
      return { code:0, stdout:'', stderr:'' };
    };
    const r = await svc.dumpPostgres(target, { env: PG_ENV });
    assert.deepEqual(r, { ok: false, skipped: false, reason: 'pg_dump 产出空文件', bytes: 0 });
  });

  test('pg_dump 二进制不可用时结构化降级，只取错误首行', async () => {
    newTmpRoot();
    state.spawn = async () => { throw new Error('spawn pg_dump ENOENT\nstack line'); };
    const r = await svc.dumpPostgres(tmpJoin('nope.dump'), { env: PG_ENV });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'pg_dump 不可用: spawn pg_dump ENOENT');
  });

  test('参数与空闲超时候来自常量，密码只进子进程环境', async () => {
    newTmpRoot();
    let seen = null;
    state.spawn = async (bin, args, opts) => {
      seen = { bin, args, opts };
      fs.writeFileSync(tmpJoin('pgargs.dump'), 'x');
      return { code: 0, stdout: '', stderr: '' };
    };
    const target = tmpJoin('pgargs.dump');
    await svc.dumpPostgres(target, { env: PG_ENV });
    assert.equal(seen.bin, BACKUP.PG_DUMP_BIN);
    assert.deepEqual(seen.args, [
      '--format=custom',
      '--verbose',
      `--file=${target}`,
      '--host=pghost',
      '--port=6000',
      '--username=pguser',
      'mydb',
    ]);
    assert.equal(seen.opts.idleMs, BACKUP.PG_DUMP_IDLE_TIMEOUT_MS);
    assert.equal(seen.opts.label, 'pg_dump');
    assert.equal(seen.opts.spawnOpts.env.PGPASSWORD, 'secret');
    assert.equal(seen.opts.spawnOpts.windowsHide, true);
    assert.equal(seen.opts.env, undefined, 'the password must not leak into a top-level env field');
  });

  test('opts.env 缺省时读 process.env：有值取值，缺字段用文档默认值', async () => {
    newTmpRoot();
    let args = null;
    state.spawn = async (bin, argv, opts) => {
      args = argv;
      fs.writeFileSync(tmpJoin('dflt.dump'), 'x');
      return { code: 0, stdout: '', stderr: '' };
    };
    try {
      process.env.DB_MODE = 'postgres';
      process.env.DB_HOST = 'envhost';
      process.env.DB_PORT = '5599';
      process.env.DB_USER = 'envuser';
      process.env.DB_NAME = 'envdb';
      await svc.dumpPostgres(tmpJoin('dflt.dump'), {});
      assert.deepEqual(args, [
        '--format=custom',
        '--verbose',
        `--file=${tmpJoin('dflt.dump')}`,
        '--host=envhost',
        '--port=5599',
        '--username=envuser',
        'envdb',
      ]);
      assert.equal(args.includes('quant_trading'), false);

      for (const k of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME']) delete process.env[k];
      await svc.dumpPostgres(tmpJoin('dflt2.dump'), {});
      assert.deepEqual(args.slice(3), ['--host=localhost', '--port=5432', '--username=postgres', 'quant_trading']);
    } finally {
      for (const k of ['DB_MODE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME']) delete process.env[k];
      args = null;
    }
  });

  test('注入的 env 只进子进程，绝不回写 process.env', async () => {
    newTmpRoot();
    const before = {
      DB_MODE: process.env.DB_MODE,
      DB_HOST: process.env.DB_HOST,
      DB_NAME: process.env.DB_NAME,
      DB_PASSWORD: process.env.DB_PASSWORD,
    };
    let argv = null;
    state.spawn = async (bin, args, opts) => {
      argv = args;
      fs.writeFileSync(args[2].replace('--file=', ''), 'x');
      return { code: 0, stdout: '', stderr: '' };
    };
    await svc.dumpPostgres(tmpJoin('iso.dump'), { env: PG_ENV });
    assert.equal(argv[3], '--host=pghost', 'the dump itself really ran off opts.env');
    assert.equal(process.env.DB_MODE, before.DB_MODE);
    assert.equal(process.env.DB_HOST, before.DB_HOST);
    assert.equal(process.env.DB_NAME, before.DB_NAME);
    assert.equal(process.env.DB_PASSWORD, before.DB_PASSWORD);
    assert.deepEqual(Object.keys(process.env).filter((k) => k.startsWith('PGPASSWORD')), []);
  });

  after(() => { state.spawn = null; });
});

describe('createBackup：端到端（注入 root/homes，全部落在临时目录）', () => {
  function baseOpts(extra = {}) {
    return { root: tmpJoin('root'), homes: [{ role: 'user', dir: tmpJoin('homes', 'h') }], nowMs: NOW, ...extra };
  }

  test('一次成功的备份：manifest 先写、.complete 最后写、verify 当场通过', async () => {
    newTmpRoot();
    const home = makeHome('h', { 'config.json': '{"a":1}', 'taskboard.db': 'sqlite-ish' });
    state.hotCopy = null;
    const r = await svc.createBackup(baseOpts({ note: '基线' }));
    assert.equal(r.ok, true, String(r.error));
    assert.equal(r.error, null);
    assert.equal(r.dir, path.join(tmpJoin('root'), r.id));
    assert.equal(mf.parseBackupId(r.id).ok, true);
    assert.equal(mf.parseBackupId(r.id).timeMs, NOW);
    const kinds = r.manifest.entries.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['file', 'sqlite']);
    const sqlite = r.manifest.entries.find((e) => e.kind === 'sqlite');
    assert.equal(sqlite.target, 'db/user-taskboard.db');
    assert.equal(sqlite.journalMode, 'wal');
    assert.equal(sqlite.bytes, 64);
    assert.equal(sqlite.sha256, sha(path.join(r.dir, 'db', 'user-taskboard.db')));
    const file = r.manifest.entries.find((e) => e.kind === 'file');
    assert.equal(file.target, 'home-user/config.json');
    assert.equal(r.manifest.totalBytes, 64 + fs.statSync(path.join(home, 'config.json')).size);
    assert.equal(fs.existsSync(path.join(r.dir, BACKUP.MANIFEST_FILENAME)), true);
    assert.equal(fs.existsSync(path.join(r.dir, BACKUP.COMPLETE_MARKER)), true);
    assert.equal(svc.verifyBackup(r.id, { root: tmpJoin('root') }).ok, true);
    const listed = svc.listBackups({ root: tmpJoin('root') });
    assert.equal(listed.sets.length, 1);
    assert.equal(listed.sets[0].complete, true);
    assert.equal(listed.sets[0].tier, 'core');
    assert.equal(listed.sets[0].note, '基线');
  });

  test('磁盘预检不过时直接拒绝，且不留下半个备份集目录', async () => {
    newTmpRoot();
    makeHome('h', { 'config.json': '{}' });
    state.freeBytes = BACKUP.MIN_FREE_BYTES - 1;
    const root = tmpJoin('root');
    const r = await svc.createBackup(baseOpts({ root }));
    assert.equal(r.ok, false);
    assert.match(r.error, /可用空间不足/);
    assert.equal(r.id, '');
    assert.deepEqual(fs.readdirSync(root), [], 'only the root itself may exist');
    state.freeBytes = 1024 * 1024 * 1024;
    const ok = await svc.createBackup(baseOpts({ root }));
    assert.equal(ok.ok, true, String(ok.error));
  });

  test('未解析到任何家目录时结构化失败', async () => {
    newTmpRoot();
    const r = await svc.createBackup(baseOpts({ homes: [] }));
    assert.equal(r.ok, false);
    assert.equal(r.error, '未解析到任何数据家目录,无可备份内容');
    assert.deepEqual(fs.readdirSync(tmpJoin('root')), []);
  });

  test('SQLite 热备失败默认硬失败并清残骸，allowPartial 才降级为警告', async () => {
    newTmpRoot();
    makeHome('h', { 'config.json': '{}', 'taskboard.db': 'x' });
    const root = tmpJoin('root');
    state.hotCopy = () => ({ ok: false, bytes: 0, journalMode: 'unknown', integrity: 'unknown', durationMs: 0, error: '副本完整性校验未通过: broken' });
    const hard = await svc.createBackup(baseOpts({ root }));
    assert.equal(hard.ok, false);
    assert.match(hard.error, /SQLite 热备失败 user:taskboard\.db — 副本完整性校验未通过/);
    // id/dir 是「起过备份」的痕，失败即被 finally 清掉 —— 报出来的 id 指向一个不存在的集。
    assert.equal(mf.parseBackupId(hard.id).ok, true);
    assert.equal(hard.dir, path.join(root, hard.id));
    assert.equal(fs.existsSync(hard.dir), false, 'the swept set must not exist');
    assert.deepEqual(fs.readdirSync(root), [], 'only the root itself may survive');
    assert.deepEqual(hard.warnings, [], '硬失败不靠 warnings 提示');
    assert.equal(hard.manifest, null);

    const partial = await svc.createBackup(baseOpts({ root, allowPartial: true }));
    assert.equal(partial.ok, true, String(partial.error));
    assert.notEqual(partial.id, hard.id);
    assert.deepEqual(partial.warnings, ['SQLite 热备失败 user:taskboard.db — 副本完整性校验未通过: broken']);
    assert.deepEqual(partial.manifest.entries.map((e) => e.kind), ['file']);
    assert.deepEqual(partial.manifest.excluded.find((e) => /热备失败/.test(String(e.reason))), {
      path: 'user:taskboard.db',
      reason: '热备失败: 副本完整性校验未通过: broken',
    });
    state.hotCopy = null;
  });

  test('一个 SQLite 库都没发现时给出部署可能未初始化的警告', async () => {
    newTmpRoot();
    makeHome('h', { 'config.json': '{}' });
    const r = await svc.createBackup(baseOpts());
    assert.equal(r.ok, true, String(r.error));
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /未发现任何 SQLite 库/);
  });

  test('家目录里只剩被排除项时 manifest 自校验失败，不留残骸', async () => {
    newTmpRoot();
    makeHome('h', { 'app.log': 'noise' });
    const root = tmpJoin('root');
    const r = await svc.createBackup(baseOpts({ root }));
    assert.equal(r.ok, false);
    assert.match(r.error, /manifest 自校验失败: entries 为空/);
    assert.deepEqual(fs.readdirSync(root), []);
  });

  test('manifest 落盘失败时报写入失败并清掉备份集', async () => {
    newTmpRoot();
    makeHome('h', { 'config.json': '{}' });
    const root = tmpJoin('root');
    state.atomicFails = true;
    const r = await svc.createBackup(baseOpts({ root }));
    state.atomicFails = false;
    assert.equal(r.ok, false);
    assert.match(r.error, /manifest 写入失败/);
    assert.deepEqual(fs.readdirSync(root), []);
  });

  test('冷导出只在 full 级生效：core 级即使显式 includeCold 也不产归档', async () => {
    newTmpRoot();
    makeHome('h', { 'config.json': '{}', 'audit/old.jsonl': `{"ts":${NOW - 400 * DAY}}\n` });
    const core = await svc.createBackup(baseOpts({ tier: 'core', includeCold: true }));
    assert.equal(core.ok, true, String(core.error));
    assert.equal(core.manifest.entries.some((e) => e.kind === 'cold-export'), false);
    assert.equal(fs.existsSync(path.join(core.dir, COLD_EXPORT.SUBDIR)), false);

    const full = await svc.createBackup(baseOpts({ tier: 'full', includeCold: true, root: tmpJoin('rootFull') }));
    assert.equal(full.ok, true, String(full.error));
    const cold = full.manifest.entries.find((e) => e.kind === 'cold-export');
    assert.equal(cold.target, 'cold/user-audit.jsonl.gz');
    assert.equal(cold.records, 1);
    assert.equal(cold.sourceFiles, 1);
    assert.deepEqual(cold.window, { days: COLD_EXPORT.WINDOW_DAYS, untilMs: NOW });
    assert.equal(cold.compression, 'gzip');
    assert.deepEqual(full.manifest.excluded.filter((e) => /冷归档/.test(String(e.reason))), [
      { path: 'user:audit/old.jsonl', reason: '已整份并入冷归档(cold-export)' },
    ]);
    assert.equal(full.manifest.entries.some((e) => e.target === 'home-user/audit/old.jsonl'), false);
  });

  test('冷导出失败不升级为整次失败，退回逐文件复制并留痕', async () => {
    newTmpRoot();
    makeHome('h', { 'config.json': '{}', 'audit/old.jsonl': `{"ts":${NOW - 400 * DAY}}\n` });
    const coldMod = require('./coldExportService.js');
    const savedExport = coldMod.exportColdDir;
    coldMod.exportColdDir = () => ({
      ok: false, exported: false, target: '', bytes: 0, sha256: '', records: 0,
      sourceFiles: 0, skippedRecent: 0, coveredFiles: [], error: '磁盘写不动',
    });
    try {
      const r = await svc.createBackup(baseOpts({ tier: 'full', includeCold: true }));
      assert.equal(r.ok, true, String(r.error));
      assert.equal(r.warnings.length, 2);
      assert.match(r.warnings[0], /未发现任何 SQLite 库/);
      assert.equal(r.warnings[1], '冷导出失败 user:audit — 磁盘写不动');
      assert.deepEqual(r.manifest.excluded.find((e) => e.path === 'user:audit'), {
        path: 'user:audit',
        reason: '冷导出失败: 磁盘写不动',
      });
      assert.equal(r.manifest.entries.some((e) => e.target === 'home-user/audit/old.jsonl'), true, '退回逐文件复制');
      assert.equal(r.manifest.entries.some((e) => e.kind === 'cold-export'), false);
      assert.equal(fs.existsSync(path.join(r.dir, COLD_EXPORT.SUBDIR)), false);
    } finally {
      coldMod.exportColdDir = savedExport;
    }
  });

  test('清单里的环境记账来自注入时间与常量，而不是各处再算一遍', async () => {
    newTmpRoot();
    makeHome('h', { 'config.json': '{}' });
    const r = await svc.createBackup(baseOpts({ tier: 'full' }));
    assert.equal(r.ok, true, String(r.error));
    const m = r.manifest;
    assert.equal(m.schemaVersion, BACKUP.MANIFEST_SCHEMA_VERSION);
    assert.equal(m.createdAt, new Date(NOW).toISOString());
    assert.equal(m.tier, 'full');
    assert.equal(m.containsSecrets, true);
    assert.equal(m.sqliteDriver, 'node:sqlite');
    assert.equal(m.platform, `${process.platform}-${process.arch}`);
    assert.equal(m.nodeVersion, process.version);
    assert.equal(m.dbMode, String(process.env.DB_MODE || process.env.DB_TYPE || 'auto'));
    assert.equal(m.dataHomes.user, tmpJoin('homes', 'h'));
    assert.deepEqual(m.restoreHints.map((h) => h.kind), ['reindex', 'drop-wal', 'discard']);
    assert.equal(typeof m.khyVersion, 'string');
  });

  test('进度回调拿到带动作与目标的文本，非函数入参被安全忽略', async () => {
    newTmpRoot();
    makeHome('h', { 'config.json': '{}', 'b.json': '{}', 'c.json': '{}' });
    const msgs = [];
    const r = await svc.createBackup(baseOpts({ onProgress: (m) => msgs.push(m) }));
    assert.equal(r.ok, true, String(r.error));
    assert.match(msgs[0], /^备份 \d{8}T\d{6}Z-[0-9a-f]{6}:已解析 1 个数据家目录,分级 core,开始盘点资产$/);
    assert.equal(msgs.some((m) => /^复制 user 家目录:3 个文件待处理$/.test(m)), true);
    assert.equal(msgs.some((m) => /^复制 user 家目录:已完成 3\/3$/.test(m)), true);
    // 3 项 = 3 个 json,6 B = 3 × 2 B,1 项排除 = postgres 跳过被记进 excluded。
    assert.match(msgs[msgs.length - 1], new RegExp(`^备份 ${r.id}:完成 3 项 / 6 B,排除 1 项,落盘 ${r.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    assert.equal(msgs.filter((m) => /热备 SQLite/.test(m)).length, 0);
    const spies = [];
    const odd = await svc.createBackup(baseOpts({
      root: tmpJoin('root2'),
      onProgress: Object.assign((m) => spies.push(m), { notCalled: true }),
    }));
    assert.equal(odd.ok, true, String(odd.error));
    assert.equal(spies.length, msgs.length);
    for (const bad of ['not-a-function', 42, {}, [], null, undefined, true]) {
      const silent = await svc.createBackup(baseOpts({ root: tmpJoin(`root-${String(bad)}`), onProgress: bad }));
      assert.equal(silent.ok, true, `${String(bad)}: ${String(silent.error)}`);
    }
  });

  test('KNOWN-DEFECT: pg_dump 用注入 env，清单出处却写 process.env', async () => {
    // backupService.js:251-254 builds the argv from opts.env, but :416 records the entry's
    // `source` from process.env.DB_HOST/DB_NAME and :569 records manifest.dbMode from
    // process.env too. So an injected environment (the documented test/CLI seam) produces a
    // backup whose manifest names the WRONG database: a restore operator reading
    // postgres://localhost/quant_trading would connect somewhere else than the dump came from,
    // and manifest.dbMode says 'auto' although a pg_dump was actually taken.
    newTmpRoot();
    makeHome('h', { 'config.json': '{}' });
    state.spawn = async (bin, args) => {
      fs.writeFileSync(args[2].replace('--file=', ''), Buffer.alloc(10, 1));
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await svc.createBackup(baseOpts({
      env: { DB_MODE: 'postgres', DB_HOST: 'pghost', DB_NAME: 'mydb', DB_PORT: '6000', DB_USER: 'pguser', DB_PASSWORD: 'x' },
    }));
    assert.equal(r.ok, true, String(r.error));
    const pg = r.manifest.entries.find((e) => e.kind === 'pgdump');
    assert.equal(pg.target, 'db/postgres.dump');
    assert.equal(pg.bytes, 10);
    assert.equal(pg.source, `postgres://${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME || 'quant_trading'}`);
    assert.equal(pg.source.includes('pghost'), false);
    assert.equal(r.manifest.dbMode, String(process.env.DB_MODE || process.env.DB_TYPE || 'auto'));
    assert.notEqual(r.manifest.dbMode, 'postgres');
    state.spawn = null;
  });

  test('KNOWN-DEFECT: .complete 的 completedAt 用真实时钟，注入的时间只影响 manifest', async () => {
    // backupService.js:592 stamps the marker with `Date.now()` while createdAt honours
    // opts.nowMs, so a back-dated (or forward-dated) backup set carries a completion time that
    // contradicts its own manifest — and any tool that trusts .complete's timestamp sees a
    // different instant than the one the set claims.
    newTmpRoot();
    makeHome('h', { 'config.json': '{}' });
    const r = await svc.createBackup(baseOpts({ nowMs: Date.parse('2020-01-02T03:04:05.000Z') }));
    assert.equal(r.ok, true, String(r.error));
    assert.equal(r.manifest.createdAt, '2020-01-02T03:04:05.000Z');
    const marker = JSON.parse(fs.readFileSync(path.join(r.dir, BACKUP.COMPLETE_MARKER), 'utf8'));
    assert.equal(marker.id, r.id);
    assert.equal(String(marker.completedAt).startsWith('2020-01-02'), false);
    assert.equal(Date.parse(marker.completedAt) > Date.parse('2025-01-01T00:00:00Z'), true);
  });
});

describe('listBackups / resolveSetId / verifyBackup / pruneBackups', () => {
  function seedSet(root, id, { manifest = true, complete = true, files = {} } = {}) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    if (manifest) fs.writeFileSync(path.join(dir, BACKUP.MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
    if (complete) fs.writeFileSync(path.join(dir, BACKUP.COMPLETE_MARKER), JSON.stringify({ id }));
    return dir;
  }

  function manifestWith(entries, overrides = {}) {
    return {
      schemaVersion: 1,
      id: '20260816T074600Z-aaaaaa',
      createdAt: '2026-08-16T07:46:00.000Z',
      tier: 'core',
      note: '',
      entries,
      excluded: [],
      dataHomes: { user: '/tmp/u' },
      containsSecrets: true,
      restoreHints: [],
      totalBytes: entries.reduce((s, e) => s + (e.bytes || 0), 0),
      ...overrides,
    };
  }

  test('非备份集目录与残破集各按事实呈现', () => {
    newTmpRoot();
    const root = tmpJoin('root');
    const body = manifestWith([{ kind: 'file', target: 'home-user/a.json', sha256: shaStr('payload'), bytes: 7 }]);
    seedSet(root, '20260820T000000Z-aaaaaa', { manifest: body, files: { 'home-user/a.json': 'payload' } });
    seedSet(root, 'not-a-backup-set', { manifest: body, complete: false });
    seedSet(root, '20260810T000000Z-bbbbbb', { manifest: null, complete: false });
    const { sets, root: r } = svc.listBackups({ root });
    assert.equal(r, root);
    assert.deepEqual(sets.map((s) => s.id), ['20260820T000000Z-aaaaaa', '20260810T000000Z-bbbbbb']);
    assert.equal(sets[0].complete, true);
    assert.equal(sets[0].tier, 'core');
    assert.equal(sets[0].entryCount, 1);
    assert.equal(sets[1].complete, false);
    assert.equal(sets[1].tier, 'unknown');
    assert.equal(sets[1].entryCount, 0);
    assert.equal(sets[1].totalBytes, 0);
    assert.equal(sets[1].createdAt, '2026-08-10T00:00:00.000Z');
    assert.equal(sets[1].containsSecrets, false);
    assert.equal(sets[1].manifest, null);
  });

  test('备份根不存在时给出空清单而不是抛', () => {
    newTmpRoot();
    const r = svc.listBackups({ root: tmpJoin('nowhere') });
    assert.deepEqual(r, { root: tmpJoin('nowhere'), sets: [] });
  });

  test('resolveSetId 认 latest 两种写法与精确 id，忽略未完成的集', () => {
    newTmpRoot();
    const root = tmpJoin('root');
    const body = manifestWith([{ kind: 'file', target: 'a.json', sha256: shaStr('x'), bytes: 1 }]);
    seedSet(root, '20260810T000000Z-bbbbbb', { manifest: body });
    seedSet(root, '20260820T000000Z-aaaaaa', { manifest: body, complete: false });
    const opts = { root };
    assert.equal(svc.resolveSetId('--latest', opts), '20260810T000000Z-bbbbbb');
    assert.equal(svc.resolveSetId('latest', opts), '20260810T000000Z-bbbbbb');
    assert.equal(svc.resolveSetId('', opts), '20260810T000000Z-bbbbbb');
    assert.equal(svc.resolveSetId('  20260810T000000Z-bbbbbb  ', opts), '20260810T000000Z-bbbbbb');
    assert.equal(svc.resolveSetId('20260820T000000Z-aaaaaa', opts), '20260820T000000Z-aaaaaa');
    assert.equal(svc.resolveSetId('20260801T000000Z-cccccc', opts), '');
    assert.equal(svc.resolveSetId(undefined, opts), '20260810T000000Z-bbbbbb');
  });

  test('verify 抓出缺文件、字节不符、sha 不符与缺 .complete', () => {
    newTmpRoot();
    const root = tmpJoin('root');
    const good = { kind: 'file', target: 'home-user/a.json', sha256: shaStr('payload'), bytes: 7 };
    const missing = { kind: 'file', target: 'home-user/gone.json', sha256: shaStr('x'), bytes: 1 };
    const wrongSize = { kind: 'file', target: 'home-user/small.json', sha256: shaStr('payload'), bytes: 99 };
    const wrongSha = { kind: 'file', target: 'home-user/liar.json', sha256: 'f'.repeat(64), bytes: 7 };
    const body = manifestWith([good, missing, wrongSize, wrongSha], { id: '20260820T000000Z-aaaaaa' });
    seedSet(root, '20260820T000000Z-aaaaaa', {
      manifest: body,
      files: {
        'home-user/a.json': 'payload',
        'home-user/small.json': 'payload',
        'home-user/liar.json': 'payload',
      },
    });
    const r = svc.verifyBackup('20260820T000000Z-aaaaaa', { root });
    assert.equal(r.ok, false);
    assert.equal(r.checked, 4);
    assert.deepEqual(r.problems, [
      '文件缺失: home-user/gone.json',
      '字节数不符: home-user/small.json(清单 99 B,实际 7 B)',
      'sha256 不符: home-user/liar.json',
    ]);
    fs.rmSync(path.join(root, '20260820T000000Z-aaaaaa', BACKUP.COMPLETE_MARKER));
    const broken = svc.verifyBackup('20260820T000000Z-aaaaaa', { root });
    assert.match(broken.problems[0], /缺少 .complete 标记/);
  });

  test('verify 对结构非法的 manifest 逐条列出问题，找不到集时给错误', () => {
    newTmpRoot();
    const root = tmpJoin('root');
    const bad = manifestWith([{ kind: 'DIRECTORY', target: '', sha256: 'nope', bytes: -1 }], { id: 'garbage', schemaVersion: 0, createdAt: '' });
    seedSet(root, '20260820T000000Z-aaaaaa', { manifest: bad, complete: false });
    const r = svc.verifyBackup('20260820T000000Z-aaaaaa', { root });
    assert.equal(r.ok, false);
    assert.equal(r.error, null);
    assert.deepEqual(r.problems, [
      '缺少 .complete 标记 —— 该备份写入未完成,不可用于恢复',
      'manifest 结构: schemaVersion 缺失或非法',
      'manifest 结构: id 非法: garbage',
      'manifest 结构: createdAt 缺失或非法',
      'manifest 结构: entries[0].kind 非法: DIRECTORY',
      'manifest 结构: entries[0].target 缺失',
      'manifest 结构: entries[0].sha256 非法(必须是 64 位小写十六进制)',
      'manifest 结构: entries[0].bytes 非法',
    ]);
    assert.equal(svc.verifyBackup('nope', { root }).error, '找不到备份集: nope');
    assert.equal(svc.verifyBackup('nope', { root }).id, 'nope');
    const emptyRoot = svc.listBackups({ root: tmpJoin('empty-root') });
    assert.equal(svc.verifyBackup('--latest', { root: tmpJoin('empty-root') }).error, '找不到备份集: --latest');
    void emptyRoot;
  });

  test('KNOWN-DEFECT: verify 按 manifest 的 target 拼路径，../ 越出备份集也能报通过', () => {
    // backupService.js:705 `path.join(dir, String(e.target).split('/').join(path.sep))` never
    // checks that the result stays under `dir`, while restoreService's _placeFile does. A
    // crafted manifest can therefore have verify hash a file outside the backup set and print
    // "verified ok" for a set whose own payload is absent.
    newTmpRoot();
    const root = tmpJoin('root');
    const outside = path.join(root, 'outside.json');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(outside, 'TRUSTED-BYTES');
    const entry = { kind: 'file', target: '../outside.json', sha256: shaStr('TRUSTED-BYTES'), bytes: Buffer.byteLength('TRUSTED-BYTES') };
    seedSet(root, '20260820T000000Z-aaaaaa', { manifest: manifestWith([entry], { id: '20260820T000000Z-aaaaaa' }) });
    const r = svc.verifyBackup('20260820T000000Z-aaaaaa', { root });
    assert.equal(r.checked, 1);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true, 'a set containing nothing but an escape passes verification');
    assert.equal(fs.existsSync(path.join(root, '20260820T000000Z-aaaaaa', 'home-user')), false);
  });

  test('prune 先清残破集，dryRun 只报告不动手', () => {
    newTmpRoot();
    const root = tmpJoin('root');
    const body = manifestWith([{ kind: 'file', target: 'a.json', sha256: shaStr('x'), bytes: 1 }]);
    seedSet(root, '20260820T000000Z-aaaaaa', { manifest: body });
    seedSet(root, '20260815T000000Z-bbbbbb', { manifest: body, complete: false });
    seedSet(root, '20260810T000000Z-cccccc', { manifest: body });
    const dry = svc.pruneBackups({ root, keepCount: 1, keepDays: 1, nowMs: NOW, dryRun: true });
    // keepCount=1 + keepDays=1: aaaaaa is the newest complete set (never dropped),
    // bbbbbb lacks .complete, and ccccc is both over the count and older than a day.
    // planRetention's keep/drop are disjoint, so `kept` holds only aaaaaa.
    assert.deepEqual(dry.kept, ['20260820T000000Z-aaaaaa']);
    assert.deepEqual(dry.dropped.map((d) => [d.id, d.removed]), [
      ['20260815T000000Z-bbbbbb', false],
      ['20260810T000000Z-cccccc', false],
    ]);
    assert.equal(fs.existsSync(path.join(root, '20260815T000000Z-bbbbbb')), true);
    const real = svc.pruneBackups({ root, keepCount: 1, keepDays: 1, nowMs: NOW });
    assert.deepEqual(real.dropped.map((d) => [d.id, d.removed]), [
      ['20260815T000000Z-bbbbbb', true],
      ['20260810T000000Z-cccccc', true],
    ]);
    assert.deepEqual(fs.readdirSync(root), ['20260820T000000Z-aaaaaa']);
    assert.deepEqual(svc.pruneBackups({ root }).kept, ['20260820T000000Z-aaaaaa']);
  });

  test('prune 在删除失败时如实标 removed:false，不谎报已清理', () => {
    newTmpRoot();
    const root = tmpJoin('root');
    const body = manifestWith([{ kind: 'file', target: 'a.json', sha256: shaStr('x'), bytes: 1 }]);
    seedSet(root, '20260820T000000Z-aaaaaa', { manifest: body });
    seedSet(root, '20260810T000000Z-bbbbbb', { manifest: body });
    seedSet(root, '20260810T000000Z-bbbbbb/sub', {});
    const savedRm = fs.rmSync;
    fs.rmSync = () => { throw new Error('EPERM'); };
    try {
      const r = svc.pruneBackups({ root, keepCount: 1, keepDays: 1, nowMs: NOW });
      assert.equal(r.dropped[0].removed, false);
      assert.equal(r.kept.length, 1);
    } finally {
      fs.rmSync = savedRm;
    }
    assert.equal(fs.existsSync(path.join(root, '20260810T000000Z-bbbbbb')), true);
  });
});

describe('_sha256File 与分隔符归一', () => {
  test('分块哈希与 crypto 一次性哈希一致，读不到返空串', () => {
    newTmpRoot();
    const file = tmpJoin('hash.bin');
    const payload = crypto.randomBytes(1024 * 300);
    fs.writeFileSync(file, payload);
    assert.equal(svc._sha256File(file), crypto.createHash('sha256').update(payload).digest('hex'));
    assert.equal(svc._sha256File(tmpJoin('missing.bin')), '');
    assert.equal(svc._sha256File(tmpJoin()), '', 'a directory is not hashable');
    assert.equal(svc._sha256File(''), '');
    assert.equal(svc._sha256File(null), '');
    assert.equal(svc._sha256File(undefined), '');
    assert.equal(svc._sha256File(42), '');
    const empty = tmpJoin('empty.bin');
    fs.writeFileSync(empty, '');
    assert.equal(svc._sha256File(empty), crypto.createHash('sha256').update('').digest('hex'));
  });

  test('备份集内的相对路径一律 POSIX，反斜杠不留进 manifest', () => {
    newTmpRoot();
    const home = makeHome('h', { 'nested/deep/state.json': '{}' });
    const r = svc.collectHomeFiles(home, 'user', 'core', tmpJoin('root'));
    assert.deepEqual(r.files.map((f) => f.rel), ['nested/deep/state.json']);
    assert.equal(r.files[0].rel.includes(BACKSLASH), false);
    assert.equal(r.files[0].abs.includes(path.sep), true);
  });
});
