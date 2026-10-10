'use strict';

/**
 * Colocated contract tests for usageScan.js (ccSwitch 字节游标增量会话扫描).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * Isolation: the only file this module WRITES is the cursor state file, whose
 * path comes from utils/dataHome.getAppHome() (lazily required, memoised on the
 * first call) and is written through the real utils/atomicWriteJson leaf. Both
 * seams are pinned into a fs.mkdtempSync(os.tmpdir()) tree:
 *   - src/utils/dataHome.js is stubbed in require.cache keyed by its FULL
 *     resolved path BEFORE the module under test is loaded.
 *   - os.homedir() is monkey-patched for the whole file (and restored in
 *     `after`) because _cursorFile()'s fail-soft branch and every `~/...`
 *     session-dir resolver go through it — this is what keeps ~/.khyquant,
 *     ~/.claude and ~/.codex out of reach.
 * Session sources are temp JSONL files; src/services/tokenUsageService.js and
 * src/services/tokenPricing.js are stubbed by resolved path so no real usage
 * ledger or pricing lookup happens.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../../..');
const DATAHOME_ID = require.resolve(path.join(SRC, 'utils/dataHome.js'));
const TOKEN_USAGE_ID = require.resolve(path.join(SRC, 'services/tokenUsageService.js'));
const TOKEN_PRICING_ID = require.resolve(path.join(SRC, 'services/tokenPricing.js'));
const USAGE_SCAN_ID = require.resolve(path.join(__dirname, 'usageScan.js'));

// One temp root for the whole file: the cursor path is memoised at first use.
const BOOT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ccswitch-scan-'));
const APP_HOME = path.join(BOOT_ROOT, 'app');
fs.mkdirSync(APP_HOME, { recursive: true });
const CURSOR_FILE = path.join(APP_HOME, 'cc_switch_scan_cursors.json');

let HOME_DIR = APP_HOME;
let throwOnAppHome = false;
let pricingImpl = () => 0.42;
const recorded = [];

const savedCache = new Map();
function cacheStub(id, exports) {
  if (!savedCache.has(id)) savedCache.set(id, require.cache[id]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

cacheStub(DATAHOME_ID, {
  getDataHome: () => {
    if (throwOnAppHome) throw new Error('data home blew up');
    return HOME_DIR;
  },
  getLegacyDataHome: () => HOME_DIR,
  getAppHome: () => {
    if (throwOnAppHome) throw new Error('app home blew up');
    return HOME_DIR;
  },
});
cacheStub(TOKEN_USAGE_ID, {
  recordUsage: (...args) => recorded.push(args),
});
cacheStub(TOKEN_PRICING_ID, {
  estimateCost: (...args) => pricingImpl(...args),
});

// os.homedir() is the only seam for the `~`-expanding resolvers and for the
// cursor fail-soft branch → lock it to the temp root for the whole suite.
const realHomeDir = os.homedir;
os.homedir = () => BOOT_ROOT;

const us = require('./usageScan');
const { APPS } = require('./constants');

const tmpDirs = [];

test.after(() => {
  os.homedir = realHomeDir;
  for (const [id, entry] of savedCache) {
    if (entry) require.cache[id] = entry;
    else delete require.cache[id];
  }
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(BOOT_ROOT, { recursive: true, force: true });
});

/** Fresh temp dir (never the repo tree, never the real home). */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `khy-ccswitch-scan-${prefix}-`));
  assert.ok(dir.startsWith(os.tmpdir()), 'session dir must live under os.tmpdir()');
  tmpDirs.push(dir);
  return dir;
}

function resetCursors(doc = { files: {} }) {
  fs.mkdirSync(path.dirname(CURSOR_FILE), { recursive: true });
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(doc));
  recorded.length = 0;
}

function writeJsonl(file, lines) {
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

const EMPTY_TAIL_FP = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ─────────────────────────── scanFileIncrement ──────────────────────────────

test('scanFileIncrement：冷扫把游标推到文件末尾，指纹取末 64 字节', () => {
  const dir = tempDir('cold');
  const file = writeJsonl(path.join(dir, 'a.jsonl'), [
    { usage: { input_tokens: 1, output_tokens: 1 } },
    { usage: { input_tokens: 2, output_tokens: 2 } },
  ]);
  const res = us.scanFileIncrement(file, { offset: 0, fingerprint: '', size: 0 });
  assert.deepEqual(res.records, [
    { usage: { input_tokens: 1, output_tokens: 1 } },
    { usage: { input_tokens: 2, output_tokens: 2 } },
  ]);
  const bytes = fs.statSync(file).size;
  assert.equal(res.nextCursor.offset, bytes);
  assert.equal(res.nextCursor.size, bytes);
  assert.equal(res.nextCursor.fingerprint, us._tailFingerprint(fs.readFileSync(file)));
  assert.equal(res.error, undefined);
  assert.equal(res.skipped, undefined);
  // 游标缺省（undefined / 垃圾形状）都按 0 起点处理。
  assert.equal(us.scanFileIncrement(file).nextCursor.offset, bytes);
  assert.equal(us.scanFileIncrement(file, null).nextCursor.offset, bytes);
  assert.equal(us.scanFileIncrement(file, { offset: 'abc', size: 'def' }).nextCursor.offset, bytes);
});

test('scanFileIncrement：同尺寸 + 同指纹视为无新增，游标原样回传', () => {
  const dir = tempDir('nogrow');
  const file = writeJsonl(path.join(dir, 'a.jsonl'), [{ usage: { input_tokens: 1, output_tokens: 1 } }]);
  const first = us.scanFileIncrement(file, { offset: 0, fingerprint: '', size: 0 });
  const again = us.scanFileIncrement(file, first.nextCursor);
  assert.deepEqual(again.records, []);
  assert.deepEqual(again.nextCursor, first.nextCursor);
  assert.equal(again.skipped, undefined);
  assert.equal(again.held, undefined);
});

test('scanFileIncrement：只读后缀；末行不完整时整轮保留游标（held）', () => {
  const dir = tempDir('partial');
  const file = path.join(dir, 'a.jsonl');
  writeJsonl(file, [{ usage: { input_tokens: 1, output_tokens: 1 } }]);
  let cursor = us.scanFileIncrement(file, { offset: 0, fingerprint: '', size: 0 }).nextCursor;

  fs.appendFileSync(file, '{"usage":{"input_tokens":9,"output_tokens":9}}');
  const held = us.scanFileIncrement(file, cursor);
  assert.deepEqual(held, { records: [], nextCursor: cursor, held: true }, '半行不得推进游标');

  fs.appendFileSync(file, '\n');
  const done = us.scanFileIncrement(file, cursor);
  assert.deepEqual(done.records, [{ usage: { input_tokens: 9, output_tokens: 9 } }]);
  assert.equal(done.nextCursor.offset, fs.statSync(file).size);
  assert.ok(done.nextCursor.offset > cursor.offset);
  // 后缀里没有换行以外的空行也要处理：纯追加空白不产记录但推进游标。
  const blank = us.scanFileIncrement(file, done.nextCursor);
  assert.deepEqual(blank.records, []);
});

test('scanFileIncrement：文件截断则跳过并重钉（不重放历史）', () => {
  const dir = tempDir('trunc');
  const file = path.join(dir, 'a.jsonl');
  writeJsonl(file, [
    { usage: { input_tokens: 1, output_tokens: 1 } },
    { usage: { input_tokens: 2, output_tokens: 2 } },
  ]);
  const cursor = us.scanFileIncrement(file, { offset: 0, fingerprint: '', size: 0 }).nextCursor;
  const oldSize = cursor.offset;
  fs.writeFileSync(file, '{"usage":{"input_tokens":7,"output_tokens":7}}\n');
  const res = us.scanFileIncrement(file, cursor);
  const newSize = fs.statSync(file).size;
  assert.deepEqual(res.records, [], '截断区间绝不重放');
  assert.equal(res.skipped, `截断: ${oldSize} → ${newSize} 字节，跳过并重钉游标`);
  assert.deepEqual(res.nextCursor, { offset: newSize, fingerprint: EMPTY_TAIL_FP, size: newSize });
});

test('KNOWN-DEFECT scanFileIncrement：截断重钉后每轮都误报「同尺寸改写」，且同尺寸改写也永不收敛', () => {
  const dir = tempDir('rewrite');
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, '{"usage":{"input_tokens":1,"output_tokens":1}}\n');
  let cursor = us.scanFileIncrement(file, { offset: 0, fingerprint: '', size: 0 }).nextCursor;
  // Same-size external rewrite.
  fs.writeFileSync(file, '{"usage":{"input_tokens":2,"output_tokens":2}}\n');
  const first = us.scanFileIncrement(file, cursor);
  assert.equal(first.skipped, '同尺寸改写（指纹不匹配），跳过并重钉游标');
  assert.equal(first.nextCursor.fingerprint, EMPTY_TAIL_FP);
  // The re-pin stores the hash of an EMPTY buffer instead of the file's tail →
  // every later round re-reports the same skip even though nothing changed.
  const second = us.scanFileIncrement(file, first.nextCursor);
  assert.equal(second.skipped, '同尺寸改写（指纹不匹配），跳过并重钉游标');
  const third = us.scanFileIncrement(file, second.nextCursor);
  assert.equal(third.skipped, '同尺寸改写（指纹不匹配），跳过并重钉游标');
});

test('KNOWN-DEFECT scanFileIncrement：短后缀（<64B）写入的指纹口径与下轮比对不一致 → 追加后误判改写', () => {
  const dir = tempDir('tailfp');
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, 'x'.repeat(200) + '\n'); // 非 JSON，只用来撑大小
  let cursor = us.scanFileIncrement(file, { offset: 0, fingerprint: '', size: 0 }).nextCursor;
  assert.equal(cursor.fingerprint, us._tailFingerprint(fs.readFileSync(file)));
  fs.appendFileSync(file, 'y'.repeat(10) + '\n');
  cursor = us.scanFileIncrement(file, cursor).nextCursor; // 后缀 11 字节
  assert.equal(cursor.offset, fs.statSync(file).size, '追加本身正常推进');
  const again = us.scanFileIncrement(file, cursor);
  // Measured: the stored fingerprint is hash(last-64-of-the-SUFFIX) while the
  // comparison re-hashes the file's last 64 bytes → guaranteed mismatch.
  assert.equal(again.skipped, '同尺寸改写（指纹不匹配），跳过并重钉游标');
  assert.equal(again.nextCursor.fingerprint, EMPTY_TAIL_FP);
});

test('scanFileIncrement：损坏行静默跳过，但任何合法 JSON 都算记录（含标量/数组）', () => {
  const dir = tempDir('malformed');
  const file = path.join(dir, 'a.jsonl');
  writeJsonl(file, ['{not json', '[1,2]', '"bare-string"', '42', '', '  ', { usage: { input_tokens: 5, output_tokens: 5 } }]);
  const res = us.scanFileIncrement(file, { offset: 0, fingerprint: '', size: 0 });
  assert.deepEqual(res.records, [[1, 2], 'bare-string', 42, { usage: { input_tokens: 5, output_tokens: 5 } }]);
  assert.equal(res.error, undefined);
});

test('scanFileIncrement：文件不存在给 error 字符串；对目录不抛错也不推进', () => {
  const dir = tempDir('missing');
  const res = us.scanFileIncrement(path.join(dir, 'nope.jsonl'), { offset: 0, fingerprint: '', size: 0 });
  assert.deepEqual(res.nextCursor, { offset: 0, fingerprint: '', size: 0 });
  assert.match(res.error, /ENOENT/);
  const asDir = us.scanFileIncrement(dir, { offset: 0, fingerprint: '', size: 0 });
  assert.deepEqual(asDir.records, []);
  assert.equal(asDir.error, undefined, 'measured: 本平台上目录可 open，落到「无新增字节」分支');
});

// ───────────────────────────── extractors ───────────────────────────────────

test('抽取器：claude 把两类缓存 token 并入 inputTokens，全零/垃圾入参返回 null', () => {
  const extract = us.RECORD_EXTRACTORS[APPS.CLAUDE_CODE];
  assert.deepEqual(extract({ message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25, output_tokens: 10 }, model: 'claude-x' } }), {
    inputTokens: 175,
    outputTokens: 10,
    model: 'claude-x',
    provider: 'claude',
  });
  assert.equal(extract(null), null);
  assert.equal(extract({}), null);
  assert.equal(extract({ message: {} }), null);
  assert.equal(extract({ message: { usage: 'str' } }), null);
  assert.equal(extract({ message: { usage: [] } }), null);
  assert.deepEqual(extract({ message: { usage: { input_tokens: 0, output_tokens: 0 } } }), null, '全零视为无用量');
  assert.deepEqual(extract({ message: { usage: { input_tokens: '12abc' } } }), null, 'NaN 归零后全零 → null');
  assert.deepEqual(extract({ message: { usage: { input_tokens: '1e3', output_tokens: -5 } } }), {
    inputTokens: 1000,
    outputTokens: -5,
    model: '',
    provider: 'claude',
  }, '负数不是假值 → ||0 兜不住，负用量原样进账');
  assert.equal(extract({ message: { usage: { output_tokens: 3 }, modelName: 'fallback-model' } }).model, 'fallback-model');
});

test('抽取器字段拼写：codex 认 modelSlug 不认 modelName，generic 反之', () => {
  const codex = us.RECORD_EXTRACTORS[APPS.CODEX];
  const generic = us.RECORD_EXTRACTORS[APPS.GEMINI];
  assert.deepEqual(codex({ usage: { input_tokens: 1, output_tokens: 2 }, modelName: 'named' }), {
    inputTokens: 1,
    outputTokens: 2,
    model: '',
    provider: 'codex',
  }, 'codex 只看 model / modelSlug');
  assert.deepEqual(codex({ usage: { inputTokens: 7, outputTokens: 8 }, modelSlug: 'slug' }), {
    inputTokens: 7,
    outputTokens: 8,
    model: 'slug',
    provider: 'codex',
  }, '驼峰拼写只在 codex/generic 生效');
  assert.deepEqual(generic({ usage: { input_tokens: 1, output_tokens: 2 }, modelSlug: 'slug' }), {
    inputTokens: 1,
    outputTokens: 2,
    model: '',
    provider: 'external',
  }, 'generic 只看 model / modelName');
  // 下标为 0 时驼峰兜底（0 || fallback 的假值语义）。
  assert.deepEqual(codex({ usage: { input_tokens: 0, output_tokens: 1, inputTokens: 5 } }), {
    inputTokens: 5,
    outputTokens: 1,
    model: '',
    provider: 'codex',
  });
  assert.equal(codex({ usage: { input_tokens: 0, output_tokens: 0 } }), null);
  assert.equal(generic({ usage: { input_tokens: -0, output_tokens: 0 } }), null);
});

test('KNOWN-DEFECT 抽取器：负数 token 不是假值，||0 兜不住 → 负用量直接进账', () => {
  const claude = us.RECORD_EXTRACTORS[APPS.CLAUDE_CODE];
  const codex = us.RECORD_EXTRACTORS[APPS.CODEX];
  assert.deepEqual(claude({ message: { usage: { input_tokens: -3 } } }), {
    inputTokens: -3,
    outputTokens: 0,
    model: '',
    provider: 'claude',
  });
  assert.deepEqual(codex({ usage: { input_tokens: -1, output_tokens: -2 } }), {
    inputTokens: -1,
    outputTokens: -2,
    model: '',
    provider: 'codex',
  }, '全负数同样通过「非零」门');
  // 对称口径：Infinity / 小数 / null 都按 Number() 原样保留。
  assert.deepEqual(codex({ usage: { input_tokens: 1.5, output_tokens: null } }), {
    inputTokens: 1.5,
    outputTokens: 0,
    model: '',
    provider: 'codex',
  });
});

test('RECORD_EXTRACTORS 覆盖 6 个应用；其余 6 个在册应用无抽取器（scanSessions 只计数不导入）', async () => {
  assert.deepEqual(Object.keys(us.RECORD_EXTRACTORS).sort(), [
    'claude-code',
    'codex',
    'command-code',
    'gemini',
    'opencode',
    'ycode',
  ]);
  const dir = tempDir('noextract');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  writeJsonl(path.join(dir, 'sessions', 's.jsonl'), [{ usage: { input_tokens: 1, output_tokens: 1 } }]);
  resetCursors();
  const res = await us.scanSessions({ apps: [APPS.TRAE, APPS.REASONIX], env: {} });
  assert.deepEqual(res, {
    imported: 0,
    files: 0,
    errors: [],
    byApp: { trae: { files: 0, imported: 0 }, reasonix: { files: 0, imported: 0 } },
  });
  // ycode 有抽取器：走 YCODE_CACHE_DIR 绝对路径。
  const cache = tempDir('ycode');
  fs.mkdirSync(path.join(cache, 'ycode', 'ws'), { recursive: true });
  writeJsonl(path.join(cache, 'ycode', 'ws', 'u.jsonl'), [{ usage: { input_tokens: 4, output_tokens: 6 }, modelName: 'y-1' }]);
  resetCursors();
  const res2 = await us.scanSessions({ apps: [APPS.YCODE], env: { YCODE_CACHE_DIR: cache } });
  assert.deepEqual(res2.byApp, { ycode: { files: 1, imported: 1 } });
  assert.deepEqual(recorded, [['external', 'y-1', 4, 6, 0.42]]);
});

// ─────────────────────────── collectSessionFiles ────────────────────────────

test('collectSessionFiles：env 绝对目录生效，嵌套 project 目录与 .json 一并收录，.txt 与非目录跳过', () => {
  const root = tempDir('collect');
  const projects = path.join(root, 'projects');
  fs.mkdirSync(path.join(projects, 'proj-a'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'proj-a', 'one.jsonl'), '{}\n');
  fs.writeFileSync(path.join(projects, 'proj-a', 'two.json'), '{}');
  fs.writeFileSync(path.join(projects, 'proj-a', 'skip.txt'), 'x');
  fs.writeFileSync(path.join(projects, 'loose.jsonl'), '{}\n');
  const files = us.collectSessionFiles(APPS.CLAUDE_CODE, { CLAUDE_CONFIG_DIR: root }).map((f) => f.file);
  assert.deepEqual(files.sort(), [
    path.join(projects, 'loose.jsonl'),
    path.join(projects, 'proj-a', 'one.jsonl'),
    path.join(projects, 'proj-a', 'two.json'),
  ].sort());
  assert.ok(files.every((f) => f.startsWith(root)), '收集到的文件必须全在临时目录内');
  // 目录不存在 → 空数组（fail-soft）。
  assert.deepEqual(us.collectSessionFiles(APPS.CLAUDE_CODE, { CLAUDE_CONFIG_DIR: path.join(root, 'nope') }), []);
  // env 给的是空串 → 回落 `~/.claude`（此处 ~ 已被锁到临时根）。
  assert.deepEqual(us.collectSessionFiles(APPS.CLAUDE_CODE, { CLAUDE_CONFIG_DIR: '' }), []);
  // 未知应用 / 无解析器 → []。
  assert.deepEqual(us.collectSessionFiles('nope', {}), []);
  assert.deepEqual(us.collectSessionFiles(APPS.TRAE, {}), []);
  // env 缺省对象也不抛（走 ~ 展开分支）。
  assert.deepEqual(us.collectSessionFiles(APPS.CLAUDE_CODE, {}), []);
});

test('collectSessionFiles：~ 前缀按 os.homedir 展开，gemini 扫 sessions/history/data 三处', () => {
  const home = path.join(BOOT_ROOT, 'tilde-home');
  const real = os.homedir;
  os.homedir = () => home;
  try {
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'projects', 'p.jsonl'), '{}\n');
    fs.mkdirSync(path.join(home, '.gemini', 'history'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'history', 'h.jsonl'), '{}\n');
    fs.mkdirSync(path.join(home, '.gemini', 'data'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'data', 'd.json'), '{}');
    const claudeFiles = us.collectSessionFiles(APPS.CLAUDE_CODE, { CLAUDE_CONFIG_DIR: '~/.claude' });
    assert.deepEqual(claudeFiles, [{ app: APPS.CLAUDE_CODE, file: path.join(home, '.claude', 'projects', 'p.jsonl') }]);
    const geminiFiles = us.collectSessionFiles(APPS.GEMINI, { GEMINI_CONFIG_DIR: '~/.gemini' }).map((f) => f.file);
    assert.deepEqual(geminiFiles.sort(), [
      path.join(home, '.gemini', 'data', 'd.json'),
      path.join(home, '.gemini', 'history', 'h.jsonl'),
    ].sort());
    // command-code 同形；opencode 默认值走 homedir 而非 ~ 前缀。
    fs.mkdirSync(path.join(home, '.commandcode', 'projects', 'q'), { recursive: true });
    fs.writeFileSync(path.join(home, '.commandcode', 'projects', 'q', 'x.jsonl'), '{}\n');
    assert.deepEqual(us.collectSessionFiles(APPS.COMMAND_CODE, { COMMAND_CODE_HOME: '~/.commandcode' }), [
      { app: APPS.COMMAND_CODE, file: path.join(home, '.commandcode', 'projects', 'q', 'x.jsonl') },
    ]);
    fs.mkdirSync(path.join(home, '.config', 'opencode', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'sessions', 'o.jsonl'), '{}\n');
    assert.deepEqual(us.collectSessionFiles(APPS.OPENCODE, {}), [
      { app: APPS.OPENCODE, file: path.join(home, '.config', 'opencode', 'sessions', 'o.jsonl') },
    ]);
    // ycode 默认走平台缓存目录（win: homedir/AppData/Local，其他: ~/.cache）。
    const expectedBase = process.platform === 'win32' ? path.join(home, 'AppData', 'Local') : path.join(home, '.cache');
    fs.mkdirSync(path.join(expectedBase, 'ycode'), { recursive: true });
    fs.writeFileSync(path.join(expectedBase, 'ycode', 'y.jsonl'), '{}\n');
    assert.deepEqual(us.collectSessionFiles(APPS.YCODE, {}), [
      { app: APPS.YCODE, file: path.join(expectedBase, 'ycode', 'y.jsonl') },
    ]);
  } finally {
    os.homedir = real;
  }
});

test('KNOWN-DEFECT collectSessionFiles：codex 目录完全忽略 env 覆盖（唯一无 override 的解析器）', () => {
  const root = tempDir('codexdir');
  fs.mkdirSync(path.join(root, 'sessions', 'd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', 'd', 's.jsonl'), '{}\n');
  const real = os.homedir;
  os.homedir = () => BOOT_ROOT;
  try {
    // 各种官方 override 名称都被无视。
    for (const env of [
      { CODEX_HOME: root },
      { CODEX_SESSION_DIR: root },
      { CODEX_CONFIG_DIR: root },
      { OPENAI_CODEX_HOME: root },
    ]) {
      assert.deepEqual(us.collectSessionFiles(APPS.CODEX, env).filter((f) => f.file.startsWith(root)), [], JSON.stringify(env));
    }
    // 只认 os.homedir()/.codex/sessions（此处已被锁到临时根）。
    fs.mkdirSync(path.join(BOOT_ROOT, '.codex', 'sessions', 'real'), { recursive: true });
    fs.writeFileSync(path.join(BOOT_ROOT, '.codex', 'sessions', 'real', 'r.jsonl'), '{}\n');
    assert.deepEqual(us.collectSessionFiles(APPS.CODEX, { CODEX_HOME: root }), [
      { app: APPS.CODEX, file: path.join(BOOT_ROOT, '.codex', 'sessions', 'real', 'r.jsonl') },
    ]);
  } finally {
    os.homedir = real;
  }
});

// ────────────────────────────── scanSessions ────────────────────────────────

test('scanSessions：首轮导入并交 (provider, model, in, out, cost) 给 recordUsage，二轮零重复', async () => {
  const root = tempDir('scan');
  const projects = path.join(root, 'projects', 'p');
  fs.mkdirSync(projects, { recursive: true });
  const file = writeJsonl(path.join(projects, 'a.jsonl'), [
    { message: { usage: { input_tokens: 7, output_tokens: 8 }, model: 'claude-x' } },
    { message: { usage: 'garbage' } },
    'not-json',
  ]);
  resetCursors();
  const env = { CLAUDE_CONFIG_DIR: root };
  const r1 = await us.scanSessions({ apps: [APPS.CLAUDE_CODE], env });
  assert.deepEqual(r1, { imported: 1, files: 1, errors: [], byApp: { 'claude-code': { files: 1, imported: 1 } } });
  assert.deepEqual(recorded, [['claude', 'claude-x', 7, 8, 0.42]]);
  const saved = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf-8'));
  assert.deepEqual(Object.keys(saved.files), [`claude-code:${file}`]);
  assert.equal(saved.files[`claude-code:${file}`].offset, fs.statSync(file).size);

  const r2 = await us.scanSessions({ apps: [APPS.CLAUDE_CODE], env });
  assert.equal(r2.imported, 0);
  assert.equal(r2.files, 1);
  assert.deepEqual(recorded.length, 1, '二轮不得重复记账');

  fs.appendFileSync(file, JSON.stringify({ message: { usage: { input_tokens: 1, output_tokens: 2 }, model: 'claude-x' } }) + '\n');
  const r3 = await us.scanSessions({ apps: [APPS.CLAUDE_CODE], env });
  assert.equal(r3.imported, 1, '增量只吃新追加的整行');
  assert.equal(recorded.length, 2);
});

test('KNOWN-DEFECT scanSessions：recordUsage 抛错被逐条吞掉，但游标照样推进 → 该批用量永久丢失', async () => {
  const root = tempDir('throw');
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  const file = writeJsonl(path.join(root, 'projects', 'b.jsonl'), [
    { message: { usage: { input_tokens: 3, output_tokens: 4 }, model: 'm' } },
  ]);
  resetCursors();
  const env = { CLAUDE_CONFIG_DIR: root };
  const realRecord = require.cache[TOKEN_USAGE_ID].exports.recordUsage;
  require.cache[TOKEN_USAGE_ID].exports.recordUsage = () => {
    throw new Error('ledger down');
  };
  try {
    const res = await us.scanSessions({ apps: [APPS.CLAUDE_CODE], env });
    assert.deepEqual(res, { imported: 0, files: 1, errors: [], byApp: { 'claude-code': { files: 1, imported: 0 } } });
    assert.deepEqual(res.errors, [], '失败既不计入 errors，也不上报');
  } finally {
    require.cache[TOKEN_USAGE_ID].exports.recordUsage = realRecord;
  }
  const saved = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf-8'));
  assert.equal(saved.files[`claude-code:${file}`].offset, fs.statSync(file).size, '游标仍被推到文件末尾');
  const retry = await us.scanSessions({ apps: [APPS.CLAUDE_CODE], env });
  assert.deepEqual(retry.byApp, { 'claude-code': { files: 1, imported: 0 } }, '下一轮不会再补记');
  assert.deepEqual(recorded, [], '账上始终没有这条用量');
});

test('KNOWN-DEFECT scanSessions：apps 重复时 byApp 桶被重置（与全局计数矛盾）；空 apps 回落全量 12 应用', async () => {
  const root = tempDir('dup');
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  writeJsonl(path.join(root, 'projects', 'a.jsonl'), [{ message: { usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' } }]);
  resetCursors();
  const env = { CLAUDE_CONFIG_DIR: root };
  const dup = await us.scanSessions({ apps: [APPS.CLAUDE_CODE, APPS.CLAUDE_CODE], env });
  assert.equal(dup.files, 2);
  assert.equal(dup.imported, 1, 'measured: 游标在内存里即时写回，重复 apps 不重复记账');
  // 但按应用汇总的桶被第二个 app 重置成「本轮无导入」→ 全局计数与 byApp 相互矛盾。
  assert.deepEqual(dup.byApp, { 'claude-code': { files: 1, imported: 0 } });
  assert.equal(dup.byApp[APPS.CLAUDE_CODE].imported + dup.byApp[APPS.CLAUDE_CODE].files, 1);
  assert.equal(dup.imported, 1);
  // apps 缺省 / 空数组 / 非数组都落到全集 12 应用；env 给空对象时所有解析器
  // 都走 os.homedir()，而家目录已被锁到临时根 → 不会读到真实 ~/.claude。
  resetCursors();
  for (const apps of [undefined, [], 'nope', {}]) {
    const all = await us.scanSessions({ apps, env: {} });
    assert.deepEqual(Object.keys(all.byApp).sort(), Object.values(APPS).sort(), JSON.stringify(apps));
    assert.equal(all.imported, 0, JSON.stringify(apps));
  }
  for (const app of Object.values(APPS)) {
    for (const f of us.collectSessionFiles(app, {})) {
      assert.ok(f.file.startsWith(BOOT_ROOT), `全量扫描不得越出临时根: ${f.file}`);
    }
  }
  resetCursors();
});

test('KNOWN-DEFECT scanSessions：游标文件形状不对时整轮抛 TypeError（fail-soft 契约破口）', async () => {
  const root = tempDir('badcursor');
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  writeJsonl(path.join(root, 'projects', 'a.jsonl'), [{ message: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
  const env = { CLAUDE_CONFIG_DIR: root };
  const cases = [
    ['{}', /Cannot set properties of undefined/],
    ['[]', /Cannot set properties of undefined/],
    ['"str"', /Cannot set properties of undefined/],
    ['null', /Cannot read properties of null/],
    ['42', /Cannot set properties of undefined/],
  ];
  const deltas = [];
  for (const [doc, pattern] of cases) {
    const before = recorded.length;
    fs.writeFileSync(CURSOR_FILE, doc);
    await assert.rejects(
      () => us.scanSessions({ apps: [APPS.CLAUDE_CODE], env }),
      (e) => {
        assert.ok(e instanceof TypeError, `${doc} → ${e.constructor.name}`);
        assert.match(e.message, pattern, doc);
        return true;
      },
      `${doc} 应抛 TypeError`
    );
    deltas.push(recorded.length - before);
  }
  // 抛点不对称：null 在读游标时就崩（没记账），其余四种都是「先入账再崩」——
  // 于是每次重跑都重复记一次用量。
  assert.deepEqual(deltas, [1, 1, 1, 0, 1]);
  // 而 files 是数组时不抛：游标被写成数组的具名属性，JSON 序列化时静默丢失。
  recorded.length = 0;
  fs.writeFileSync(CURSOR_FILE, '{"files":[]}');
  const arrayBucket = await us.scanSessions({ apps: [APPS.CLAUDE_CODE], env });
  assert.equal(arrayBucket.imported, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf-8')), { files: [] }, '落盘里没有该文件的游标');
  const replay = await us.scanSessions({ apps: [APPS.CLAUDE_CODE], env });
  assert.equal(replay.imported, 1, '下一轮当作首次扫描重放同一条用量');
  assert.equal(recorded.length, 2);
  resetCursors();
});

test('KNOWN-DEFECT scanSessions：游标文件损坏 → 静默当作首次扫描并全量重放（文档承诺 abort the round）', async () => {
  const root = tempDir('corrupt');
  fs.mkdirSync(path.join(root, 'projects', 'p'), { recursive: true });
  const file = writeJsonl(path.join(root, 'projects', 'p', 'a.jsonl'), [
    { message: { usage: { input_tokens: 7, output_tokens: 8 }, model: 'm' } },
  ]);
  resetCursors();
  const env = { CLAUDE_CONFIG_DIR: root };
  const first = await us.scanSessions({ apps: [APPS.CLAUDE_CODE], env });
  assert.equal(first.imported, 1);
  assert.equal(recorded.length, 1);
  // A valid cursor doc already at EOF imports nothing.
  const noop = await us.scanSessions({ apps: [APPS.CLAUDE_CODE], env });
  assert.equal(noop.imported, 0);
  // Now corrupt it: docstring says "aborts the round", measured says full replay.
  fs.writeFileSync(CURSOR_FILE, '{"files": {"claude-');
  const replay = await us.scanSessions({ apps: [APPS.CLAUDE_CODE], env });
  assert.deepEqual(replay, { imported: 1, files: 1, errors: [], byApp: { 'claude-code': { files: 1, imported: 1 } } });
  assert.equal(recorded.length, 2, '同一条历史用量被记了第二次');
  assert.equal(replay.errors.length, 0, '重放不产生任何 error 记录');
  const healed = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf-8'));
  assert.equal(healed.files[`claude-code:${file}`].offset, fs.statSync(file).size);
});

test('estimateCostUSD：定价叶子命中即用，非有限/负数/抛错都回退 $2.5+$10 每百万', () => {
  pricingImpl = (i, o, m) => {
    assert.deepEqual([i, o, m], [1000, 2000, 'claude-x']);
    return 0.42;
  };
  assert.equal(us.estimateCostUSD(1000, 2000, 'claude-x'), 0.42);
  // model 缺省时按 'default' 送进定价叶子。
  pricingImpl = (i, o, m) => {
    assert.equal(m, 'default');
    return 1;
  };
  assert.equal(us.estimateCostUSD(1, 1), 1);
  pricingImpl = () => NaN;
  assert.equal(us.estimateCostUSD(1e6, 1e6), 12.5, 'NaN → 回退公式');
  pricingImpl = () => -1;
  assert.equal(us.estimateCostUSD(1e6, 1e6), 12.5, '负数 → 回退公式（0 是合法值）');
  pricingImpl = () => 0;
  assert.equal(us.estimateCostUSD(1e6, 1e6), 0);
  pricingImpl = () => {
    throw new Error('pricing down');
  };
  assert.equal(us.estimateCostUSD(1000, 1000), 0.0125);
  // 叶子没有 estimateCost 时也回退。
  const saved = require.cache[TOKEN_PRICING_ID].exports;
  require.cache[TOKEN_PRICING_ID].exports = {};
  try {
    assert.equal(us.estimateCostUSD(1e6, 0), 2.5);
  } finally {
    require.cache[TOKEN_PRICING_ID].exports = saved;
  }
});

test('_cursorFile 兜底：getAppHome 抛错时落到 os.homedir()/.khyquant（家目录已被锁到临时根）', () => {
  const savedUsageScan = require.cache[USAGE_SCAN_ID];
  throwOnAppHome = true;
  try {
    delete require.cache[USAGE_SCAN_ID];
    const fresh = require('./usageScan');
    assert.deepEqual(fresh.getCursorState(), { files: {} }, '缺文件即首次扫描形状');
    fresh.__test__._saveCursors({ files: { probe: { offset: 1 } } });
    const fallback = path.join(BOOT_ROOT, '.khyquant', 'cc_switch_scan_cursors.json');
    assert.ok(fallback.startsWith(BOOT_ROOT), '兜底路径必须仍在临时根内');
    assert.deepEqual(JSON.parse(fs.readFileSync(fallback, 'utf-8')), { files: { probe: { offset: 1 } } });
    assert.deepEqual(fresh.getCursorState(), { files: { probe: { offset: 1 } } });
  } finally {
    throwOnAppHome = false;
    delete require.cache[USAGE_SCAN_ID];
    if (savedUsageScan) require.cache[USAGE_SCAN_ID] = savedUsageScan;
    fs.rmSync(path.join(BOOT_ROOT, '.khyquant'), { recursive: true, force: true });
  }
  assert.ok(fs.existsSync(CURSOR_FILE), '原实例的游标路径仍锁定在 stubbed app home');
});

test('getCursorState：无游标文件返回 {files:{}}，损坏 JSON 同样返回该形状', () => {
  fs.rmSync(CURSOR_FILE, { force: true });
  assert.deepEqual(us.getCursorState(), { files: {} });
  fs.writeFileSync(CURSOR_FILE, 'not json at all');
  assert.deepEqual(us.getCursorState(), { files: {} });
  fs.writeFileSync(CURSOR_FILE, '[1,2,3]');
  assert.deepEqual(us.getCursorState(), [1, 2, 3], '合法 JSON 原样返回（不校验形状）');
  assert.deepEqual(us.__test__._loadCursors(), [1, 2, 3]);
  us.__test__._saveCursors({ files: { a: { offset: 3, fingerprint: 'f', size: 3 } } });
  assert.deepEqual(us.getCursorState(), { files: { a: { offset: 3, fingerprint: 'f', size: 3 } } });
  // 游标文件写在 stubbed app home（临时根）里，绝不在仓库树。
  assert.ok(CURSOR_FILE.startsWith(BOOT_ROOT));
  assert.equal(path.basename(CURSOR_FILE), 'cc_switch_scan_cursors.json');
});
