'use strict';

// Co-located contract tests for candidateDetect.js (credential source probing leaf).
// Every value below is MEASURED (probes .khyos/tmp/probeCandidateDetect.js / probeImporter3.js).
// Strategy: os.homedir is redirected to a fresh mkdtemp BEFORE the module is required, so all
// load-time storage-path constants live inside the temp home; spawnSync and the sqlite adapter
// are stubbed before require. Nothing is ever written to the real home dir, .khy/ or .khyos/.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
// candidateDetect does NOT re-export the placeholder helpers; pull the real leaf itself.
const { _isPlaceholderEmail } = require('./credentialHelpers');

const ENV_KEYS = [
  'KIRO_TOKEN_PATH', 'NIRVANA_TRAE_CACHE', 'NIRVANA_DEFAULT_LOGIN_EMAIL', 'NIRVANA_IMPORT_PATH',
  'KHY_POOL_AUTO_IMPORT_SOURCE', 'KHY_ACCOUNT_POOL_AUTO_IMPORT_SOURCE',
  'KHY_POOL_AUTO_IMPORT_COOLDOWN_MS', 'KHY_ACCOUNT_POOL_AUTO_IMPORT_COOLDOWN_MS',
];

const origHomedir = os.homedir;
const origSpawnSync = cp.spawnSync;
const envBackup = {};

// Fake better-sqlite3-style adapter: 'boom' paths throw (forcing the raw-regex fallback),
// 'empty' yields no rows, everything else answers only the 2nd canonical key.
function FakeDatabase(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.includes('boom')) throw new TypeError('cannot open');
  return {
    prepare: () => ({
      get: (key) => {
        if (dbPath.includes('empty') || key !== 'cursorAuth/accessToken') return undefined;
        if (dbPath.includes('buffer')) return { value: Buffer.from('bufferedtoken1234567890') };
        return { value: 'stringtoken1234567890ab' };
      },
    }),
    close() {},
  };
}

const spawnCalls = [];
let spawnImpl = () => ({ error: null, status: 0 });

// ── bootstrap: runs at module load, BEFORE the module under test is required ──
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cand-home-'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cand-scratch-'));
for (const k of ENV_KEYS) {
  envBackup[k] = process.env[k];
  delete process.env[k];
}
os.homedir = () => fakeHome;
cp.spawnSync = (cmd, args, opts) => {
  spawnCalls.push([cmd, args]);
  return spawnImpl(cmd, args, opts);
};
const adapterId = require.resolve('../../../../config/sqlite-adapter');
require.cache[adapterId] = {
  id: adapterId, filename: adapterId, loaded: true, exports: FakeDatabase, children: [], paths: [],
};
const d = require('./candidateDetect');

// Leak guard: the basenames this suite writes, checked against NEW entries in the real data
// dirs (a full listing snapshot would race with the live app; a name-scoped diff is stable).
const SUITE_FILE_NAMES = [
  'payload.json', 'inner.json', 'creds.zip', 'creds.rar', 'bundle.zip', 'note.txt',
  'a.json', 'c.json', 'b.jsonl', 'garbage.txt', 'src-package.zip',
];
const GUARD_DIRS = [path.join(process.cwd(), '.khy'), path.join(origHomedir(), '.khyquant')];
const guardBaseline = new Set();
for (const dirPath of GUARD_DIRS) {
  if (fs.existsSync(dirPath)) for (const e of fs.readdirSync(dirPath)) guardBaseline.add(e);
}

after(() => {
  os.homedir = origHomedir;
  cp.spawnSync = origSpawnSync;
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  for (const dir of [fakeHome, scratch]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('导出面冻结：26 个符号；存储路径常量全部落在假 home 内', () => {
  assert.deepEqual(Object.keys(d).sort(), [
    'CURSOR_DB_PATHS', 'CURSOR_STORAGE_PATHS', 'KIRO_TOKEN_PATH', 'KNOWN_NIRVANA_PROVIDER_SET',
    'NIRVANA_CALLBACK_FIELDS', 'NIRVANA_DEFAULT_ROOTS', 'NIRVANA_PRESET_LOGIN_EMAIL',
    'NIRVANA_STORAGE_PATHS', 'NIRVANA_TRAE_CACHE_PATHS', 'OBSERVED_AUTO_IMPORT_DEFAULT_COOLDOWN_MS',
    'OBSERVED_AUTO_IMPORT_DEFAULT_SOURCE_PATH', 'WARP_STORAGE_PATHS', '_getKiroTokenCandidatePaths',
    '_scanText', 'cleanupArchiveExtractDirs', 'collectGenericCandidateFromRecord',
    'collectNirvanaCandidatesFromRecord', 'detectNirvanaProvider', 'importGenericCandidatesFromPath',
    'normalizeNirvanaProviderHint', 'readCursorTokenFromVscdb', 'resolveArchiveImportRoot',
    'resolveNirvanaDefaultRoots', 'resolveObservedAutoImportCooldownMs',
    'resolveObservedAutoImportSourcePath', 'walkCandidateFiles',
  ]);
  assert.equal(d.CURSOR_STORAGE_PATHS.length, 3);
  assert.equal(d.CURSOR_DB_PATHS.length, 3);
  assert.equal(d.WARP_STORAGE_PATHS.length, 8);
  assert.equal(d.NIRVANA_STORAGE_PATHS.length, 6);
  assert.equal(d.NIRVANA_TRAE_CACHE_PATHS.length, 3); // env NIRVANA_TRAE_CACHE deleted at load
  assert.equal(d.NIRVANA_DEFAULT_ROOTS.length, 3);
  for (const p of [...d.CURSOR_STORAGE_PATHS, ...d.CURSOR_DB_PATHS, ...d.NIRVANA_TRAE_CACHE_PATHS]) {
    assert.ok(p.startsWith(fakeHome), `constant path ${p} is fake-home scoped`);
  }
  assert.equal(d.KIRO_TOKEN_PATH, path.join(fakeHome, '.aws', 'sso', 'cache', 'kiro-auth-token.json'));
  assert.equal(d.OBSERVED_AUTO_IMPORT_DEFAULT_SOURCE_PATH, path.join(fakeHome, 'Downloads', 'nirvana-source.zip'));
  assert.equal(d.OBSERVED_AUTO_IMPORT_DEFAULT_COOLDOWN_MS, 45000);
  assert.deepEqual(d.NIRVANA_CALLBACK_FIELDS, ['refreshToken', 'refreshExpireAt', 'host', 'userJwt', 'userInfo']);
  assert.equal(d.KNOWN_NIRVANA_PROVIDER_SET.size, 12);
  assert.equal(d.KNOWN_NIRVANA_PROVIDER_SET.has('trae'), true);
  assert.equal(d.KNOWN_NIRVANA_PROVIDER_SET.has('nirvana'), false); // 'nirvana' is only an alias
});

test('KNOWN-DEFECT: NIRVANA_PRESET_LOGIN_EMAIL 把硬编码私人 QQ 邮箱烧进源码', () => {
  // Measured: with NIRVANA_DEFAULT_LOGIN_EMAIL unset the constant is a real personal address,
  // and collectNirvanaCandidatesFromRecord attaches it to any bare-token record (case below).
  // Credential-handling + RUNTIME-001-style hardcode. Do not fix here; pinned as measured.
  assert.equal(d.NIRVANA_PRESET_LOGIN_EMAIL, '2578974124@qq.com');
});

test('normalizeNirvanaProviderHint 折叠别名/子串族，未识别一律 null', () => {
  const map = {
    'claude': 'anthropic', 'Claude Code': 'anthropic', 'chatgpt': 'openai',
    'bytedance': 'trae', 'nirvana': 'trae', 'antigravity': 'trae', 'proxy': 'relay',
    'warp-c': 'warp', 'kirodev': 'kiro', 'GLM': 'glm', '  OpenAI  ': 'openai',
    'zhipu': 'glm', 'ernie': 'wenxin', 'volcengine': 'doubao', 'dashscope': 'qwen',
    'alibaba': 'qwen', 'tongyi': 'qwen', 'baidu': 'wenxin', 'trae': 'trae', 'deepseek': 'deepseek',
    'anthropic': 'anthropic', 'openai': 'openai', 'cursor': 'cursor', 'kiro': 'kiro',
    'warp': 'warp', 'qwen': 'qwen', 'doubao': 'doubao', 'wenxin': 'wenxin', 'relay': 'relay',
  };
  for (const [raw, want] of Object.entries(map)) {
    assert.equal(d.normalizeNirvanaProviderHint(raw), want, `${raw} -> ${want}`);
  }
  for (const junk of ['', '   ', null, undefined, 0, false, {}, [], '0', 'banana', '[object Object]']) {
    assert.equal(d.normalizeNirvanaProviderHint(junk), null, `${String(junk)} -> null`);
  }
  // String(sym) is an EXPLICIT coercion (no throw): 'symbol(x)' matches no rule -> null.
  assert.equal(d.normalizeNirvanaProviderHint(Symbol('x')), null);
  // Substring priority: claude/anthropic is checked before openai.
  assert.equal(d.normalizeNirvanaProviderHint('openai-claude'), 'anthropic');
});

test('KNOWN-DEFECT: normalizeNirvanaProviderHint 原型键安全降级，但泄漏发生在上游 normalizePoolType', () => {
  // Measured: '__proto__'/'constructor' come back null here (the leaked object/function never
  // matches a substring rule), so THIS module fails safe — but only by accident of ordering.
  for (const pk of ['__proto__', 'constructor', 'valueOf', 'hasOwnProperty', 'toString']) {
    assert.equal(d.normalizeNirvanaProviderHint(pk), null, `${pk} degrades to null`);
  }
});

test('detectNirvanaProvider 按 显式字段→host→全文正则→fallback 四层顺序判定', () => {
  assert.equal(d.detectNirvanaProvider(), 'trae');
  assert.equal(d.detectNirvanaProvider({ provider: 'claude' }), 'anthropic');
  assert.equal(d.detectNirvanaProvider({}, { channel: 'chatgpt' }), 'openai');
  assert.equal(d.detectNirvanaProvider({ type: 'kiro' }), 'kiro');
  assert.equal(d.detectNirvanaProvider({ endpoint: 'https://api.deepseek.com' }), 'deepseek');
  assert.equal(d.detectNirvanaProvider({}, {}, 'C:/x/warp.dev/auth.json'), 'warp');
  assert.equal(d.detectNirvanaProvider({}, {}, 'X:/WARP.DEV'), 'warp'); // case-insensitive
  assert.equal(d.detectNirvanaProvider({}, {}, '', 'glm'), 'glm');
  assert.equal(d.detectNirvanaProvider({}, {}, '', 'zzz'), 'trae'); // junk fallback re-normalizes
  // text-rule order beats a later rule matching the same blob
  assert.equal(d.detectNirvanaProvider({ note: 'openai and trae and claude' }), 'trae');
  assert.equal(d.detectNirvanaProvider({}, {}, 'a'), 'trae'); // tiny sourcePath matches nothing
  // non-object record degrades instead of throwing
  assert.equal(d.detectNirvanaProvider('a'), 'trae');
});

test('KNOWN-DEFECT: detectNirvanaProvider 对 null 入参抛 TypeError，默认参数只挡 undefined', () => {
  // Measured: detectNirvanaProvider(null) throws (reading .provider on null), same for a null
  // callback — callers that pass JSON-derived nulls crash the scanner instead of degrading.
  assert.throws(() => d.detectNirvanaProvider(null), TypeError);
  assert.throws(() => d.detectNirvanaProvider({}, null), TypeError);
});

test('_scanText 截断到 maxLen、循环引用与不可序列化值得到空串', () => {
  assert.equal(d._scanText(''), '');
  assert.equal(d._scanText(false), '');
  assert.equal(d._scanText(null), '');
  assert.equal(d._scanText({ a: 1 }), '{"a":1}');
  assert.equal(d._scanText('abc', 0), '');
  assert.equal(d._scanText('x'.repeat(4000)).length, 3200);
  const circ = {};
  circ.self = circ;
  assert.equal(d._scanText(circ), ''); // JSON.stringify throws -> caught
  assert.equal(d._scanText(() => 1), ''); // stringify(fn) === undefined
  assert.equal(d._scanText(Symbol('q')), '');
});

test('resolveObservedAutoImportCooldownMs 夹到 [5000, 600000]，非法值回落 45000', () => {
  const cases = [
    [undefined, 45000], [{}, 45000], [{ cooldownMs: 0 }, 45000], [{ cooldownMs: -5 }, 45000],
    [{ cooldownMs: NaN }, 45000], [{ cooldownMs: Infinity }, 45000], [{ cooldownMs: '' }, 45000],
    [{ cooldownMs: null }, 45000], [{ cooldownMs: false }, 45000], [{ cooldownMs: 'abc' }, 45000],
    [{ cooldownMs: [] }, 45000], [{ cooldownMs: 1 }, 5000], [{ cooldownMs: 4999.9 }, 5000],
    [{ cooldownMs: 12345.9 }, 12345], [{ cooldownMs: '9000' }, 9000], [{ cooldownMs: 1000000 }, 600000],
    // passing a primitive as `options` reads .cooldownMs === undefined -> default
    [true, 45000], [12345, 45000],
  ];
  for (const [opts, want] of cases) {
    assert.equal(d.resolveObservedAutoImportCooldownMs(opts), want, `opts=${JSON.stringify(opts)}`);
  }
  assert.equal(d.resolveObservedAutoImportCooldownMs(), 45000);
  // env fallback chain, options wins over env
  process.env.KHY_POOL_AUTO_IMPORT_COOLDOWN_MS = '8000';
  try {
    assert.equal(d.resolveObservedAutoImportCooldownMs(), 8000);
    assert.equal(d.resolveObservedAutoImportCooldownMs({ cooldownMs: undefined }), 8000);
    assert.equal(d.resolveObservedAutoImportCooldownMs({ cooldownMs: 6000 }), 6000);
  } finally {
    delete process.env.KHY_POOL_AUTO_IMPORT_COOLDOWN_MS;
  }
});

test('resolveObservedAutoImportSourcePath 优先级 options>env>default，且只回退到存在项', () => {
  const existing = path.join(scratch, 'src-package.zip');
  fs.writeFileSync(existing, 'x');
  assert.equal(d.resolveObservedAutoImportSourcePath({ sourcePath: `  ${existing}  ` }), existing); // trimmed
  assert.equal(d.resolveObservedAutoImportSourcePath({ includeDefaultSource: false, includeEnvSource: false }), '');
  assert.equal(
    d.resolveObservedAutoImportSourcePath({ includeDefaultSource: false }),
    '' // env vars sanitized at bootstrap: nothing survives
  );
  // no candidates exist -> the FIRST deduped entry (the default path) is returned unchecked
  assert.equal(
    d.resolveObservedAutoImportSourcePath({}),
    path.normalize(path.join(fakeHome, 'Downloads', 'nirvana-source.zip'))
  );
  process.env.KHY_POOL_AUTO_IMPORT_SOURCE = path.join(scratch, 'missing-a');
  process.env.NIRVANA_IMPORT_PATH = existing;
  try {
    // env precedence: first env slot missing but second env slot exists -> existing one wins
    assert.equal(d.resolveObservedAutoImportSourcePath({ includeDefaultSource: false }), existing);
  } finally {
    delete process.env.KHY_POOL_AUTO_IMPORT_SOURCE;
    delete process.env.NIRVANA_IMPORT_PATH;
  }
});

test('_getKiroTokenCandidatePaths 去重、env 覆盖排在最前', () => {
  const base = d._getKiroTokenCandidatePaths();
  assert.equal(base[0], d.KIRO_TOKEN_PATH);
  assert.equal(new Set(base).size, base.length, 'paths are deduped by normalized form');
  process.env.KIRO_TOKEN_PATH = d.KIRO_TOKEN_PATH;
  try {
    assert.equal(d._getKiroTokenCandidatePaths().length, base.length, 'same-value override dedupes');
  } finally {
    delete process.env.KIRO_TOKEN_PATH;
  }
});

test('KNOWN-DEFECT: 空白 KIRO_TOKEN_PATH 环境变量未裁剪即成为首个扫描候选', () => {
  // Measured: other env gates in this module trim; here `'  '` is truthy and path.normalize
  // keeps it, so the credential scan probes the literal path "  " first.
  const baseLen = d._getKiroTokenCandidatePaths().length;
  process.env.KIRO_TOKEN_PATH = '  ';
  try {
    const paths = d._getKiroTokenCandidatePaths();
    assert.equal(paths[0], '  ', 'literal blank string becomes the FIRST probe path');
    assert.ok(paths.includes(d.KIRO_TOKEN_PATH), 'real candidate list still follows');
    assert.equal(paths.length, baseLen + 1, 'the junk entry is prepended, never deduped away');
  } finally {
    delete process.env.KIRO_TOKEN_PATH;
  }
});

test('resolveArchiveImportRoot 只接受 .zip/.rar 文件，其余全部 null', () => {
  assert.equal(d.resolveArchiveImportRoot(''), null);
  assert.equal(d.resolveArchiveImportRoot('   '), null);
  assert.equal(d.resolveArchiveImportRoot(null), null);
  assert.equal(d.resolveArchiveImportRoot(undefined), null);
  assert.equal(d.resolveArchiveImportRoot(path.join(scratch, 'nope.zip')), null); // statSync fails
  assert.equal(d.resolveArchiveImportRoot(scratch), null); // directory
  const txt = path.join(scratch, 'note.txt');
  fs.writeFileSync(txt, 'x');
  assert.equal(d.resolveArchiveImportRoot(txt), null); // wrong extension
  assert.equal(d.resolveArchiveImportRoot(123), null); // wrong type coerced to ''
});

test('resolveArchiveImportRoot 解压成功返回缓存目录，二次调用不再 spawn', () => {
  const zf = path.join(scratch, 'creds.zip');
  fs.writeFileSync(zf, 'zipbytes');
  spawnCalls.length = 0;
  spawnImpl = (cmd, args) => {
    fs.writeFileSync(path.join(args[4], 'payload.json'), '{}');
    return { error: null, status: 0 };
  };
  const dir = d.resolveArchiveImportRoot(zf);
  assert.match(path.basename(dir), /^khy_pool_import_[0-9a-f]{12}$/);
  assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
  assert.deepEqual(spawnCalls, [['unzip', ['-o', '-qq', zf, '-d', dir]]]);
  assert.deepEqual(fs.readdirSync(dir), ['payload.json']);
  const dir2 = d.resolveArchiveImportRoot(zf);
  assert.equal(dir2, dir, 'same file+mtime hits the cached extraction dir');
  assert.equal(spawnCalls.length, 1, 'no second spawn for a cached dir');
  // .rar routes to unrar with its own arg vector
  const rf = path.join(scratch, 'creds.rar');
  fs.writeFileSync(rf, 'rardata');
  spawnCalls.length = 0;
  const rdir = d.resolveArchiveImportRoot(rf);
  assert.equal(spawnCalls[0][0], 'unrar');
  assert.deepEqual(spawnCalls[0][1], ['x', '-o+', '-inul', rf, rdir]);
  d.cleanupArchiveExtractDirs([dir, rdir]);
});

test('KNOWN-DEFECT: 解压失败即整目录删除并返回 null，但空解压仍算成功', () => {
  const zf = path.join(scratch, 'bad.zip');
  fs.writeFileSync(zf, 'zip');
  spawnImpl = () => ({ error: new Error('ENOENT'), status: null });
  assert.equal(d.resolveArchiveImportRoot(zf), null); // spawn error -> null
  spawnImpl = () => ({ error: null, status: 2 });
  assert.equal(d.resolveArchiveImportRoot(zf), null); // nonzero status -> null
  // status 0 with zero extracted files still returns the (empty) dir as "extracted"
  spawnImpl = () => ({ error: null, status: 0 });
  const emptyDir = d.resolveArchiveImportRoot(zf);
  assert.equal(fs.readdirSync(emptyDir).length, 0);
  d.cleanupArchiveExtractDirs([emptyDir]);
  spawnImpl = () => ({ error: null, status: 0 });
});

test('cleanupArchiveExtractDirs 幂等删除，非可迭代入参安全跳过', () => {
  const dir = path.join(scratch, 'todelete');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'f'), 'x');
  d.cleanupArchiveExtractDirs([dir, '', null, '   ', undefined]);
  assert.equal(fs.existsSync(dir), false);
  assert.doesNotThrow(() => d.cleanupArchiveExtractDirs(42));
  assert.doesNotThrow(() => d.cleanupArchiveExtractDirs({}));
  assert.doesNotThrow(() => d.cleanupArchiveExtractDirs());
  assert.doesNotThrow(() => d.cleanupArchiveExtractDirs(null));
  // a string IS iterable: rmSync runs per single char (force:true swallows ENOENT)
  assert.doesNotThrow(() => d.cleanupArchiveExtractDirs('abc'));
});

test('resolveNirvanaDefaultRoots 含固定三根并按 /^nirvana/i 扫 Downloads', () => {
  const dl = path.join(fakeHome, 'Downloads');
  fs.mkdirSync(path.join(dl, 'nirvana-pack'), { recursive: true });
  fs.mkdirSync(path.join(dl, 'NirvanaUpper'), { recursive: true });
  fs.mkdirSync(path.join(dl, 'other-app'), { recursive: true });
  fs.mkdirSync(path.join(dl, ' nirvana-space'), { recursive: true });
  const savedPf = { pf: process.env.ProgramFiles, pf86: process.env['ProgramFiles(x86)'], pw: process.env.ProgramW6432 };
  process.env.ProgramFiles = scratch;
  delete process.env['ProgramFiles(x86)'];
  delete process.env.ProgramW6432;
  let roots;
  try {
    roots = d.resolveNirvanaDefaultRoots();
  } finally {
    if (savedPf.pf === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = savedPf.pf;
    if (savedPf.pf86 !== undefined) process.env['ProgramFiles(x86)'] = savedPf.pf86;
    if (savedPf.pw !== undefined) process.env.ProgramW6432 = savedPf.pw;
  }
  assert.ok(roots.includes(d.NIRVANA_DEFAULT_ROOTS[0]));
  assert.ok(roots.includes(path.normalize(path.join(dl, 'nirvana-pack'))));
  assert.ok(roots.includes(path.normalize(path.join(dl, 'NirvanaUpper'))));
  assert.ok(!roots.some((r) => r.includes('other-app')));
  assert.ok(roots.includes(path.join(scratch, 'nirvana')), 'win32 ProgramFiles branch appends');
  assert.equal(new Set(roots).size, roots.length, 'output is deduped');
});

test('walkCandidateFiles 只收白名单扩展名、跳过 node_modules/.git/.cache 与超大文件', () => {
  const root = path.join(scratch, 'walk');
  fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.json'), '{}');
  fs.writeFileSync(path.join(root, '.hidden.json'), '{}');
  fs.writeFileSync(path.join(root, 'b.bin'), 'x');
  fs.writeFileSync(path.join(root, 'big.json'), Buffer.alloc(6 * 1024 * 1024, 1));
  fs.writeFileSync(path.join(root, 'sub', 'c.log'), 'x');
  fs.writeFileSync(path.join(root, 'sub', 'deep', 'd.txt'), 'x');
  fs.writeFileSync(path.join(root, 'node_modules', 'skip.json'), 'x');
  fs.writeFileSync(path.join(root, '.git', 'skip2.json'), 'x');
  const rel = (list) => list.map((f) => path.relative(root, f).replace(/\\/g, '/')).sort();
  assert.deepEqual(rel(d.walkCandidateFiles(root)), ['.hidden.json', 'a.json', 'sub/c.log', 'sub/deep/d.txt']);
  // Measured: the gate is `current.d >= maxDepth` on the DIRECTORY node (candidateDetect.js:578),
  // so maxDepth:0 skips even the root listing -> [] (top-level files live one push deeper).
  assert.deepEqual(rel(d.walkCandidateFiles(root, { maxDepth: 0 })), []);
  assert.deepEqual(rel(d.walkCandidateFiles(root, { maxDepth: 1 })), ['.hidden.json', 'a.json']);
  assert.equal(d.walkCandidateFiles(root, { maxFiles: 2 }).length, 2);
  assert.deepEqual(d.walkCandidateFiles(path.join(root, 'a.json')), [path.normalize(path.join(root, 'a.json'))]);
  assert.deepEqual(d.walkCandidateFiles(path.join(root, 'nope')), []);
  assert.deepEqual(d.walkCandidateFiles(null), []);
});

test('KNOWN-DEFECT: walkCandidateFiles 的 maxFiles:null 收 0 个文件，maxFiles:"x" 却回落 400', () => {
  // Measured: Number(null)===0 passes Number.isFinite -> cap 0 -> []; Number('x') is NaN ->
  // default 400 -> everything. A "not set" null silently disables collection.
  const root = path.join(scratch, 'walk');
  assert.deepEqual(d.walkCandidateFiles(root, { maxFiles: null }), []);
  assert.equal(d.walkCandidateFiles(root, { maxFiles: 'x' }).length, 4);
});

test('readCursorTokenFromVscdb 走 sqlite 主路径：字符串/Buffer/无结果', () => {
  assert.equal(d.readCursorTokenFromVscdb(path.join(scratch, 'ok.vscdb')), 'stringtoken1234567890ab');
  assert.equal(d.readCursorTokenFromVscdb(path.join(scratch, 'buffer.vscdb')), 'bufferedtoken1234567890');
  assert.equal(d.readCursorTokenFromVscdb(path.join(scratch, 'empty.vscdb')), null);
  assert.equal(d.readCursorTokenFromVscdb(), null); // undefined path: ctor throws, fallback fails too
});

test('readCursorTokenFromVscdb 打开失败时回退原始字节正则扫描', () => {
  const f1 = path.join(scratch, 'boomA.vscdb');
  fs.writeFileSync(f1, 'prefix cursorAuth.accessToken: eyJabcDEF1234567890_-xyz suffix');
  assert.equal(d.readCursorTokenFromVscdb(f1), 'eyJabcDEF1234567890_-xyz');
  const f2 = path.join(scratch, 'boomB.vscdb');
  fs.writeFileSync(f2, 'cursorAuth/accessToken=abcdefghijklmnop1234');
  assert.equal(d.readCursorTokenFromVscdb(f2), 'abcdefghijklmnop1234');
  const f3 = path.join(scratch, 'boomC.vscdb');
  // Measured threshold: pattern 2 (candidateDetect.js:645) needs eyJ + >=20 chars; an
  // eyJ-token of 22 total chars (eyJ+19) matches nothing and yields null.
  fs.writeFileSync(f3, 'noise accessToken eyJ0123456789012345678 noise');
  assert.equal(d.readCursorTokenFromVscdb(f3), null, 'eyJ+19 is below the {20,} capture floor');
  fs.writeFileSync(f3, 'noise accessToken eyJ01234567890123456789 noise');
  assert.equal(d.readCursorTokenFromVscdb(f3), 'eyJ01234567890123456789');
  const f4 = path.join(scratch, 'boomD.vscdb');
  fs.writeFileSync(f4, 'nothing useful here');
  assert.equal(d.readCursorTokenFromVscdb(f4), null);
  const f5 = path.join(scratch, 'boomE.vscdb');
  fs.writeFileSync(f5, 'accessToken eyJshort'); // below the 20-char capture gate
  assert.equal(d.readCursorTokenFromVscdb(f5), null);
});

test('KNOWN-DEFECT: collectNirvanaCandidatesFromRecord 给裸 token 记录自动挂上硬编码私人邮箱', () => {
  // Measured input {accessToken:'abcdefghijklmnop'} -> output below: email/label/callbackSnapshot
  // all carry 2578974124@qq.com unless usePresetEmail:false is passed explicitly.
  const out = d.collectNirvanaCandidatesFromRecord({ accessToken: 'abcdefghijklmnop' });
  assert.deepEqual(out, {
    provider: 'trae',
    email: '2578974124@qq.com',
    password: null,
    label: 'trae:2578974124@qq.com',
    accessToken: 'abcdefghijklmnop',
    refreshToken: null,
    sourcePath: '',
    authData: {
      source: 'nirvana',
      path: '',
      refreshExpireAt: null,
      host: null,
      userJwt: null,
      userInfo: null,
      callback: { email: '2578974124@qq.com', presetEmail: '2578974124@qq.com' },
      callbackFields: ['refreshToken', 'refreshExpireAt', 'host', 'userJwt', 'userInfo'],
      expiresAt: null,
    },
    accountType: 'LOGIN',
    priority: 11,
    metadata: { source: 'nirvana', provider: 'trae' },
  });
  const optOut = d.collectNirvanaCandidatesFromRecord({ accessToken: 'abcdefghijklmnop' }, 'p', { usePresetEmail: false });
  assert.equal(optOut.email, null);
  assert.equal(optOut.label, 'trae:oauth');
  assert.equal(optOut.sourcePath, 'p');
  assert.deepEqual(optOut.authData.callback, {});
});

test('collectNirvanaCandidatesFromRecord 垃圾入参与非 trae 提供者不套预设邮箱', () => {
  for (const junk of [null, undefined, 'hello', 42, true, []]) {
    if (junk === undefined) {
      assert.equal(d.collectNirvanaCandidatesFromRecord(undefined), null);
      continue;
    }
    assert.equal(d.collectNirvanaCandidatesFromRecord(junk), null, `${String(junk)} -> null`);
  }
  const anthropic = d.collectNirvanaCandidatesFromRecord({ provider: 'claude', accessToken: 'abcdefghijklmnop' });
  assert.equal(anthropic.provider, 'anthropic');
  assert.equal(anthropic.email, null); // preset only applies to provider === 'trae'
  assert.equal(anthropic.label, 'anthropic:oauth');
  // provider filter mismatch drops the record
  assert.equal(d.collectNirvanaCandidatesFromRecord({ accessToken: 'abcdefghijklmnop' }, '', { provider: 'cursor' }), null);
  // password pairs
  assert.equal(d.collectNirvanaCandidatesFromRecord({ email: 'a@b.io', password: 'password' }, '', { usePresetEmail: false }), null);
  const pair = d.collectNirvanaCandidatesFromRecord({ email: 'a@b.io', password: 'p@ssw0rd123x' }, '', { usePresetEmail: false });
  assert.equal(pair.email, 'a@b.io');
  assert.equal(pair.password, 'p@ssw0rd123x');
  assert.equal(pair.accessToken, null);
});

test('collectNirvanaCandidatesFromRecord 令牌形态门槛、回调串与过期时间按实测归一', () => {
  assert.equal(d.collectNirvanaCandidatesFromRecord({ refreshToken: 'short' }, '', { usePresetEmail: false }), null);
  const loose = d.collectNirvanaCandidatesFromRecord({ refreshToken: 'abcdefghijklmnop{' }, '', { usePresetEmail: false });
  assert.equal(loose.refreshToken, 'abcdefghijklmnop{'); // loose charset admits '{'
  assert.equal(loose.accessToken, null); // access uses the STRICT gate only
  const q = d.collectNirvanaCandidatesFromRecord({ callback: 'refreshToken=abcdefghijklmnop&email=a@b.io' }, '', { usePresetEmail: false });
  assert.equal(q.email, 'a@b.io');
  assert.equal(q.refreshToken, 'abcdefghijklmnop');
  assert.equal(d.collectNirvanaCandidatesFromRecord({ accessToken: 'abcdefghijklmnop', refreshExpireAt: '1700000000000' }, '', { usePresetEmail: false }).authData.expiresAt, null); // numeric STRING rejected by formatIso
  assert.equal(d.collectNirvanaCandidatesFromRecord({ accessToken: 'abcdefghijklmnop', refreshExpireAt: 1700000000000 }, '', { usePresetEmail: false }).authData.expiresAt, '2023-11-14T22:13:20.000Z');
  const ui = d.collectNirvanaCandidatesFromRecord({ userInfo: '{"email":"ui@corp.test"}', accessToken: 'abcdefghijklmnop' });
  assert.deepEqual(ui.authData.userInfo, { email: 'ui@corp.test' });
  assert.equal(ui.email, 'ui@corp.test'); // userInfo.email beats the preset
});

test('KNOWN-DEFECT: collectGenericCandidateFromRecord 收下占位邮箱/裸用户名且零凭据', () => {
  // Measured: {email:'admin'} -> a full candidate with a placeholder email and NO credentials;
  // the nirvana collector rejects the same input. The generic collector never validates emails.
  assert.deepEqual(d.collectGenericCandidateFromRecord({ email: 'admin' }), {
    provider: 'trae',
    email: 'admin',
    password: null,
    label: 'trae:admin',
    accessToken: null,
    refreshToken: null,
    sourcePath: '',
    authData: { source: 'generic-import', path: '', endpoint: null, expiresAt: null, callback: null },
    accountType: 'LOGIN',
    priority: 9,
    metadata: { source: 'generic-import', provider: 'trae' },
  });
  assert.equal(d.collectGenericCandidateFromRecord({ username: 'john' }).email, 'john');
  assert.equal(_isPlaceholderEmail('admin'), true, 'the value it accepted IS a placeholder');
  for (const junk of [null, 'x', 5, true]) {
    assert.equal(d.collectGenericCandidateFromRecord(junk), null);
  }
});

test('collectGenericCandidateFromRecord 提供者解析与凭据门槛', () => {
  const cur = d.collectGenericCandidateFromRecord({ apiKey: 'abcdefghijklmnop', email: 'g@corp.test' }, 'sp', 'cursor');
  assert.deepEqual({ p: cur.provider, e: cur.email, t: cur.accessToken, src: cur.sourcePath }, {
    p: 'cursor', e: 'g@corp.test', t: 'abcdefghijklmnop', src: 'sp',
  });
  assert.equal(d.collectGenericCandidateFromRecord({ token: 'abcdefghijklmnop' }, '', 'claude').provider, 'anthropic');
  assert.equal(d.collectGenericCandidateFromRecord({ token: 'abcdefghijklmnop' }, '', 'zzz').provider, 'zzz'); // unknown passthrough
  assert.equal(d.collectGenericCandidateFromRecord({ token: 'abcdefghijklmnop' }, '', '').provider, 'trae');
  assert.equal(d.collectGenericCandidateFromRecord({ accessToken: 'tiny', password: 'x' }, '', ''), null); // below shape gates
  const loose = d.collectGenericCandidateFromRecord({ accessToken: 'abcdefghijklmnop{' }, '', '');
  assert.equal(loose.accessToken, 'abcdefghijklmnop{'); // generic admits loose shapes
  assert.equal(loose.label, 'trae:imported');
  const auth = d.collectGenericCandidateFromRecord({ authData: { accessToken: 'abcdefghijklmnop' }, userInfo: { email: 'u@corp.test' }, expiresAt: 1700000000000 });
  assert.equal(auth.accessToken, 'abcdefghijklmnop');
  assert.equal(auth.email, 'u@corp.test');
  assert.equal(auth.authData.expiresAt, '2023-11-14T22:13:20.000Z');
});

test('importGenericCandidatesFromPath 扫目录去重、跳过 node_modules 与垃圾文本', () => {
  const dir = path.join(scratch, 'gen');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  const T = 'abcdefghijklmnop';
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify([
    { accessToken: T, email: 'g@corp.test' }, { accessToken: T, email: 'g@corp.test' },
  ]));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), `{"accessToken":"${T}x","email":"h@corp.test"}\nnotjson\n{"email":"i@corp.test"}\n`);
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.json'), JSON.stringify({ email: 'skip@corp.test', accessToken: `${T}z` }));
  fs.writeFileSync(path.join(dir, 'garbage.txt'), 'nothing here');
  const out = d.importGenericCandidatesFromPath('trae', dir);
  assert.deepEqual(out.map((c) => c.email).sort(), ['g@corp.test', 'h@corp.test', 'i@corp.test']);
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ accessToken: T, email: 'g@corp.test' }));
  assert.equal(d.importGenericCandidatesFromPath('trae', dir).length, 3, 'cross-file token dedupe');
  assert.equal(d.importGenericCandidatesFromPath('trae', path.join(dir, 'a.json')).length, 1, 'single file root');
  assert.deepEqual(d.importGenericCandidatesFromPath('trae', ''), []);
  assert.deepEqual(d.importGenericCandidatesFromPath('trae', path.join(dir, 'nope')), []);
  assert.equal(d.importGenericCandidatesFromPath('nirvana', dir)[0].provider, 'trae', 'provider alias normalized');
});

test('importGenericCandidatesFromPath 支持 zip 归档并在 finally 清理解包目录', () => {
  const zf = path.join(scratch, 'bundle.zip');
  fs.writeFileSync(zf, 'zipbytes');
  // Pin the deterministic extraction dir (sha256(`${src}:${mtimeMs}`).slice(0,12), candidateDetect.js:279-285)
  // instead of listing the shared os.tmpdir(), which may hold stale khy_pool_import_* dirs.
  const st = fs.statSync(zf);
  const dirHash = crypto.createHash('sha256').update(`${zf}:${st.mtimeMs || 0}`).digest('hex').slice(0, 12);
  const extractDir = path.join(os.tmpdir(), `khy_pool_import_${dirHash}`);
  assert.equal(fs.existsSync(extractDir), false, 'precondition: fresh hash dir name');
  spawnImpl = (cmd, args) => {
    fs.writeFileSync(path.join(args[4], 'inner.json'), JSON.stringify({ accessToken: 'abcdefghijklmnop1234', email: 'pk@corp.test' }));
    return { error: null, status: 0 };
  };
  const out = d.importGenericCandidatesFromPath('trae', zf);
  assert.deepEqual(out.map((c) => c.email), ['pk@corp.test']);
  assert.equal(fs.existsSync(extractDir), false, 'finally cleanupArchiveExtractDirs removed THIS import dir');
  spawnImpl = () => ({ error: null, status: 0 });
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
  assert.ok(d.CURSOR_DB_PATHS.every((p) => p.startsWith(fakeHome)), 'all storage constants fake-home scoped');
  assert.ok(d.CURSOR_STORAGE_PATHS.every((p) => p.startsWith(fakeHome)));
  assert.ok(d.NIRVANA_STORAGE_PATHS.every((p) => p.startsWith(fakeHome)));
  assert.ok(d.WARP_STORAGE_PATHS.every((p) => p.startsWith(fakeHome)));
});
