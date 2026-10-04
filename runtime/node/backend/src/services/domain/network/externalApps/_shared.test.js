'use strict';

/**
 * _shared.test.js — 钉死外部 app 适配器公共底座的 12 个导出：home 展开、原子读写、
 * dotenv 解析/合并写、provider 元数据解析、密钥脱敏。
 *
 * 为什么这支套件必须存在：_shared 是全部 15 个文件里唯一「不吞错」的一层——它的
 * readIfExists/atomicWrite 直接把 IO 异常抛给上层，由每个 adapter 的 try/catch 收敛成
 * {success:false,error}。一旦这里的抛/不抛方向漂移，所有 adapter 的 fail-soft 契约一起失真。
 * 同时 resolveApiKey 有「NL 现给优先 / 否则借 khy 池」两条分叉，且必须绝不抛；这两件事只有
 * 隔离数据根才能确定性验证，故逐条钉死。
 *
 * 实测更正（与源码注释/直觉不同处，按真实语义钉死）：
 *   · maskKey 的边界是 `length <= 8`：恰好 8 字符的 key 返回 '****'（不是头尾各 4 的可见脱敏），
 *     只有 ≥9 字符才走 `头4…尾4`；空串返回 ''（既不是 '****' 也不是 undefined）。
 *   · expandHome 在非 Windows 传 HOME 时用 path.join，'~/a' 的分隔符随平台变化——测试只断言
 *     「等于 path.join(home,'a')」而非硬拼字符串，避免把某一平台钉成universal。
 *   · readIfExists 只对 ENOENT 返回 null；读目录（EISDIR）等其它错误如实抛给调用方。
 *   · upsertDotenv 对 null / '' 入参都产出 `KEY=value\n`；对无尾换行的源会自动补一个尾换行。
 *   · removeDotenvKey 无 tombstonePrefix 时「静默删行不留痕」，有则写 `<prefix> <key>`。
 *   · envKeyName('') 回退成 'CUSTOM_API_KEY'（norm 为空串时 `|| 'CUSTOM'`）。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 数据根隔离：_shared.resolveApiKey 的 pool 分支会 lazy require apiKeyPool 并读真实数据根，
// 在 require _shared 之前先把它 pin 到一个空临时目录，绝不误读写真实 .khy。
const ISOLATED = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-shared-'));
process.env.KHY_DATA_HOME = ISOLATED;
process.env.KHY_PROJECT_DATA_HOME = ISOLATED;

const S = require('./_shared');

after(() => {
  try {
    fs.rmSync(ISOLATED, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function tmpSub(name) {
  const dir = path.join(ISOLATED, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 临时改 process.env 并在 finally 还原（含「原本未设置」态）。 */
function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

// ── 导出面 ────────────────────────────────────────────────────────────────

test('_shared 恰导出 12 个符号（公共底座契约面）', () => {
  assert.deepStrictEqual(Object.keys(S).sort(), [
    'atomicWrite',
    'envKeyName',
    'expandHome',
    'maskKey',
    'parseDotenv',
    'presetFor',
    'removeDotenvKey',
    'resolveApiKey',
    'resolveEndpoint',
    'resolveModel',
    'readIfExists',
    'upsertDotenv',
  ].sort());
});

// ── expandHome ──────────────────────────────────────────────────────────────

test('expandHome 对 null / 空串原样返回（falsy 短路，不展开）', () => {
  assert.strictEqual(S.expandHome(null), null);
  assert.strictEqual(S.expandHome(''), '');
  assert.strictEqual(S.expandHome(undefined), undefined);
});

test('expandHome 把 ~ 展开为 env.HOME，~/x 用 path.join(HOME, x)', () => {
  const env = { HOME: '/fakehome' };
  assert.strictEqual(S.expandHome('~', env), '/fakehome');
  assert.strictEqual(S.expandHome('~/a', env), path.join('/fakehome', 'a'));
});

test('expandHome 对非 ~ 前缀路径原样返回（含绝对路径与前缀相近的 ~/x 之外的串）', () => {
  const env = { HOME: '/fakehome' };
  assert.strictEqual(S.expandHome('/etc/x', env), '/etc/x');
  assert.strictEqual(S.expandHome('~foo/bar', env), '~foo/bar');
  assert.strictEqual(S.expandHome('rel/path', env), 'rel/path');
});

test('expandHome 无 env.HOME 时回落 os.homedir()', () => {
  assert.strictEqual(S.expandHome('~'), os.homedir());
});

// ── readIfExists / atomicWrite ────────────────────────────────────────────

test('readIfExists：缺失文件返回 null；存在文件返回原文（输入非空夹具）', () => {
  const dir = tmpSub('rio');
  const missing = path.join(dir, 'nope.txt');
  assert.strictEqual(S.readIfExists(missing), null);
  const present = path.join(dir, 'here.txt');
  fs.writeFileSync(present, 'hello-payload', 'utf8');
  assert.strictEqual(S.readIfExists(present), 'hello-payload');
});

test('readIfExists 对读目录（非 ENOENT）如实抛出——fail-soft 是上层的责任', () => {
  const dir = tmpSub('dir');
  assert.throws(() => S.readIfExists(dir), /EISDIR|EPERM|EACCES/);
});

test('atomicWrite：自动建父目录、落内容、不留 .tmp 残件', () => {
  const dir = tmpSub('aw');
  const target = path.join(dir, 'nested', 'deep', 'cfg.json');
  S.atomicWrite(target, '{"ok":true}');
  assert.strictEqual(S.readIfExists(target), '{"ok":true}');
  const nestedDir = path.dirname(target);
  const leftovers = fs.readdirSync(nestedDir).filter((f) => f.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, [], 'atomicWrite 不得留下 temp 残件');
});

// ── parseDotenv ─────────────────────────────────────────────────────────────

test('parseDotenv：忽略注释/空行/无等号行，容忍 export 前缀与引号，值去引号回传', () => {
  const text = ['# comment', '', 'export X = "quoted" ', "Y='sq'", 'novalue', 'Z=raw'].join('\n');
  const out = S.parseDotenv(text);
  assert.deepStrictEqual(out, { X: 'quoted', Y: 'sq', Z: 'raw' });
});

test('parseDotenv 对 null/空串/纯注释返回空对象（不抛）', () => {
  assert.deepStrictEqual(S.parseDotenv(null), {});
  assert.deepStrictEqual(S.parseDotenv(''), {});
  assert.deepStrictEqual(S.parseDotenv('# only comment\n# more'), {});
});

test('parseDotenv 只认合法键首字符（数字/中划线开头键被忽略）', () => {
  assert.deepStrictEqual(S.parseDotenv('9BAD=1\nA-B=2\nGOOD=3'), { GOOD: '3' });
});

// ── upsertDotenv / removeDotenvKey ────────────────────────────────────────

test('upsertDotenv：null / 空源都产出一条 KEY=value\\n', () => {
  assert.strictEqual(S.upsertDotenv(null, 'K', 'v'), 'K=v\n');
  assert.strictEqual(S.upsertDotenv('', 'K', 'v'), 'K=v\n');
});

test('upsertDotenv：命中原地替换保留其余行；未命中追加末尾并补尾换行', () => {
  assert.strictEqual(S.upsertDotenv('A=1\nB=2\n', 'B', '9'), 'A=1\nB=9\n');
  assert.strictEqual(S.upsertDotenv('A=1', 'K', 'v'), 'A=1\nK=v\n');
  assert.strictEqual(S.upsertDotenv('A=1\n', 'K', 'v'), 'A=1\nK=v\n');
});

test('upsertDotenv：重复键只替换首个命中，后续同名保留', () => {
  const out = S.upsertDotenv('K=1\nK=2\n', 'K', 'X');
  assert.strictEqual(out, 'K=X\nK=2\n');
});

test('removeDotenvKey：命中 removed=true，有 tombstonePrefix 才留痕；无则静默删行', () => {
  const hit = S.removeDotenvKey('A=1\nB=2\n', 'A', '# tomb');
  assert.deepStrictEqual(hit, { text: '# tomb A\nB=2\n', removed: true });
  const silent = S.removeDotenvKey('A=1\nB=2', 'A');
  assert.strictEqual(silent.removed, true);
  assert.strictEqual(silent.text, 'B=2');
  const miss = S.removeDotenvKey('A=1\n', 'Z', '# tomb');
  assert.deepStrictEqual(miss, { text: 'A=1\n', removed: false });
});

// ── envKeyName ──────────────────────────────────────────────────────────────

test('envKeyName：deepseek→DEEPSEEK_API_KEY，自定义 suffix，非法字符折叠为下划线', () => {
  assert.strictEqual(S.envKeyName('deepseek'), 'DEEPSEEK_API_KEY');
  assert.strictEqual(S.envKeyName('deepseek', 'BASE_URL'), 'DEEPSEEK_BASE_URL');
  assert.strictEqual(S.envKeyName('a-b c'), 'A_B_C_API_KEY');
  assert.strictEqual(S.envKeyName('__x__'), 'X_API_KEY');
});

test('envKeyName 空/缺 provider 回退 CUSTOM 前缀', () => {
  assert.strictEqual(S.envKeyName(''), 'CUSTOM_API_KEY');
  assert.strictEqual(S.envKeyName(undefined, 'X'), 'CUSTOM_X');
});

// ── presetFor / resolve* ────────────────────────────────────────────────────

test('presetFor：已知 provider（deepseek）返回带 baseUrl 的预设；未知返回 null；大小写不敏感', () => {
  const hit = S.presetFor('DeepSeek');
  assert.ok(hit && typeof hit === 'object', 'deepseek 应有预设');
  assert.ok(hit.baseUrl, '预设须含 baseUrl');
  assert.strictEqual(S.presetFor('definitely-not-a-provider-xyz'), null);
});

test('resolveEndpoint：显式端点优先；否则取 preset baseUrl；未知厂商返回空串', () => {
  assert.strictEqual(S.resolveEndpoint('deepseek', 'https://explicit'), 'https://explicit');
  const fromPreset = S.resolveEndpoint('deepseek', '');
  assert.ok(/^https?:\/\//.test(fromPreset), '回退应命中 preset baseUrl');
  assert.strictEqual(S.resolveEndpoint('no-such-xyz', ''), '');
});

test('resolveModel：显式模型优先；否则取 preset defaultModel；未知厂商返回空串', () => {
  assert.strictEqual(S.resolveModel('deepseek', 'my-model'), 'my-model');
  const fromPreset = S.resolveModel('deepseek', '');
  assert.ok(typeof fromPreset === 'string' && fromPreset.length > 0, 'preset 应有 defaultModel');
  assert.strictEqual(S.resolveModel('no-such-xyz', ''), '');
});

test('resolveApiKey：显式 key → source=nl；无 key 且隔离空池 → source=none 且不抛', () => {
  assert.deepStrictEqual(S.resolveApiKey('deepseek', 'sk-given'), { key: 'sk-given', source: 'nl' });
  const none = S.resolveApiKey('no-such-xyz-9', '');
  assert.strictEqual(none.source, 'none');
  assert.strictEqual(none.key, '');
});

// ── maskKey 边界 ────────────────────────────────────────────────────────────

test('maskKey：空串→""，长度≤8→"****"，≥9 才走头4…尾4（实测边界钉死）', () => {
  assert.strictEqual(S.maskKey(''), '');
  assert.strictEqual(S.maskKey(null), '');
  assert.strictEqual(S.maskKey('12345678'), '****', '恰好 8 字符走 "****" 而非可见脱敏');
  assert.strictEqual(S.maskKey('123456789'), '1234…6789');
  assert.strictEqual(S.maskKey('sk-secret-key-abcdef'), 'sk-s…cdef');
});

test('withEnv 辅助本身如实还原：临时改一个无关 env 后原样恢复', () => {
  withEnv('KHY_PROBE_UNRELATED', 'x', () => {
    assert.strictEqual(process.env.KHY_PROBE_UNRELATED, 'x');
  });
  assert.strictEqual(process.env.KHY_PROBE_UNRELATED, undefined);
});
