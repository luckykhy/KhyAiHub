'use strict';

/**
 * installLedger.test.js — 钉死安装台账纯叶子：门控、记录归一化、密钥丢弃、
 * 逆序去重回滚计划。零 IO，所以零桩 —— 门用真 flagRegistry（实测：未知 flag
 * 默认开、CANON off 词关闭），不注入 env 就传 {}，绝不碰 process.env。
 *
 * 为什么必须钉死这层：台账是卸载干净性的唯一真源（allowlist 只是兜底猜测），
 * 而它的「绝不抛」契约意味着任何回归都只会静默改变卸载行为。
 *
 * 实测钉死的怪异行为（非理想行为）：
 *   · recordSideEffect 不校验 action 是否在已知白名单——未知 action 照记，
 *     由 computeRollback 端兜底标 skipped（记与读的门不在同一侧）。
 *   · file/dir/runtime 的 target 走 path.resolve（相对路径被锚定到 cwd）；
 *     registration/process 的 target 只做 trim，原样透传。
 *   · computeRollback 的去重 seen 登记在 unknown-action 判定「之前」——
 *     未知 action 的记录会消耗该 target 名额，同 target 的更早合法记录被
 *     静默丢弃（连 skipped 都不进）。
 *   · meta 白名单外的键、非字符串/数字/布尔的值、命中密钥形态的值一律丢弃；
 *     ts 只收有限数字。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const L = require('./installLedger');

const ON = {}; // 无 KHY_INSTALL_LEDGER → 默认开
const OFF = { KHY_INSTALL_LEDGER: 'off' };

// ── 门控与路径 ────────────────────────────────────────────────────────

test('isLedgerEnabled：默认开；CANON off 词全关；其余值（含乱串）视为开', () => {
  assert.equal(L.isLedgerEnabled(ON), true);
  for (const w of ['0', 'false', 'off', 'no']) {
    assert.equal(L.isLedgerEnabled({ KHY_INSTALL_LEDGER: w }), false, w);
  }
  assert.equal(L.isLedgerEnabled({ KHY_INSTALL_LEDGER: 'yes' }), true);
  assert.equal(L.isLedgerEnabled({ KHY_INSTALL_LEDGER: ' DISABLED ' }), true, '不 trim → 大写带空格不算关词');
});

test('ledgerPath：合法 dataHome → resolve 后拼固定文件名；非字符串 → null', () => {
  assert.equal(L.ledgerPath(''), null);
  assert.equal(L.ledgerPath(null), null);
  assert.equal(L.ledgerPath(123), null);
  assert.equal(L.ledgerPath('data/home'), path.resolve('data/home') + path.sep + '.install-ledger.jsonl');
  assert.equal(L.LEDGER_FILENAME, '.install-ledger.jsonl');
  assert.equal(L.LEDGER_VERSION, 1);
});

// ── recordSideEffect ─────────────────────────────────────────────────

test('recordSideEffect：合法 file 记录含 v/kind/归一 target/action；ts 只收有限数字', () => {
  const rec = L.recordSideEffect(
    { kind: ' file ', target: 'rel/a.txt', action: 'unlink', checksum: ' abc ', ts: 42 },
    { env: ON }
  );
  assert.equal(rec.v, 1);
  assert.equal(rec.kind, 'file');
  assert.equal(rec.target, path.resolve('rel/a.txt'), '相对路径被锚定到 cwd（实测行为）');
  assert.equal(rec.checksum, 'abc');
  assert.equal(rec.ts, 42);
  const noTs = L.recordSideEffect({ kind: 'file', target: 'x', action: 'unlink', ts: NaN }, { env: ON });
  assert.equal('ts' in noTs, false);
  assert.equal(L.recordSideEffect({ kind: 'file', target: 'x', action: 'unlink' }, { env: OFF }), null, '门关 → 不记');
});

test('recordSideEffect 拒收面：非法 kind / 缺 target / 缺 action / 非对象 / 门关 → null', () => {
  assert.equal(L.recordSideEffect({ kind: 'symlink', target: 'x', action: 'unlink' }, { env: ON }), null);
  assert.equal(L.recordSideEffect({ kind: 'file', action: 'unlink' }, { env: ON }), null);
  assert.equal(L.recordSideEffect({ kind: 'file', target: 'x' }, { env: ON }), null);
  assert.equal(L.recordSideEffect('not-object', { env: ON }), null);
  assert.equal(L.recordSideEffect(null, { env: ON }), null);
});

test('target 归一按 kind 分档：file/dir/runtime 走 resolve；registration/process 只 trim', () => {
  const reg = L.recordSideEffect({ kind: 'registration', target: '  HKCU\\Run\\khy  ', action: 'unregister-md-editor' }, { env: ON });
  assert.equal(reg.target, 'HKCU\\Run\\khy', '注册表键不是文件路径，原样透传');
  assert.equal(reg.action, 'unregister-md-editor');
  const proc = L.recordSideEffect({ kind: 'process', target: 4321, action: 'stop-process' }, { env: ON });
  assert.equal(proc, null, 'process target 非字符串 → null（不 Number 化）');
  const rt = L.recordSideEffect({ kind: 'runtime', target: 'node', action: 'remove-runtime' }, { env: ON });
  assert.equal(rt.target, path.resolve('node'), 'runtime 归路径档');
  // 未知 action 照记不误——写侧不校验，读侧才兜底（怪异点钉死）
  const weird = L.recordSideEffect({ kind: 'file', target: 'x', action: 'teleport' }, { env: ON });
  assert.equal(weird.action, 'teleport');
});

test('meta 清洗：白名单标量留下；越界键/非标量/疑似密钥值全部蒸发', () => {
  const rec = L.recordSideEffect(
    {
      kind: 'dir',
      target: 'd',
      action: 'rmdir',
      meta: {
        scope: 'global',
        package: 'khy-os@1.2.3',
        label: '便携 Node',
        reason: 'a'.repeat(33), // 32+ alnum 形态 → 疑似密钥
        platform: { os: 'win' }, // 非标量
        api_key: 'sk-live-xxx', // 白名单外 + 密钥形态，双杀
        password: 'p@ss', // 白名单外
      },
    },
    { env: ON }
  );
  assert.deepEqual(rec.meta, { scope: 'global', package: 'khy-os@1.2.3', label: '便携 Node' });
  const bare = L.recordSideEffect({ kind: 'file', target: 'f', action: 'unlink' }, { env: ON });
  assert.equal('meta' in bare, false, '空 meta 不挂键');
});

// ── computeRollback ──────────────────────────────────────────────────

test('computeRollback：逆序 + kind 定序（撤注册/停进程先于删文件），同级保持逆序相对次序', () => {
  const { steps, skipped } = L.computeRollback(
    [
      { kind: 'file', target: 'C:/khy/a.txt', action: 'unlink' },
      { kind: 'dir', target: 'C:/khy/portable', action: 'rmdir' },
      { kind: 'registration', target: 'autostart', action: 'unregister-autostart' },
      { kind: 'runtime', target: 'C:/khy/node', action: 'remove-runtime' },
      { kind: 'process', target: 'pid:123', action: 'stop-process' },
      { kind: 'file', target: 'C:/khy/b.txt', action: 'unlink' },
    ],
    { env: ON }
  );
  assert.equal(skipped.length, 0);
  assert.deepEqual(
    steps.map((s) => [s.kind, s.target]),
    [
      ['registration', 'autostart'],
      ['process', 'pid:123'],
      ['runtime', 'C:/khy/node'],
      ['dir', 'C:/khy/portable'],
      ['file', 'C:/khy/b.txt'], // b 后创建 → 先删（逆序保留）
      ['file', 'C:/khy/a.txt'],
    ]
  );
});

test('computeRollback 去重：同 target 只回滚一次且保留最后一条记录（含其 checksum）', () => {
  const { steps } = L.computeRollback(
    [
      { kind: 'file', target: 'C:/x/app.ini', action: 'unlink', checksum: 'old' },
      { kind: 'file', target: 'C:/other', action: 'unlink' },
      { kind: 'file', target: 'C:/x/app.ini', action: 'unlink', checksum: 'new' },
    ],
    { env: ON }
  );
  assert.equal(steps.length, 2);
  assert.equal(steps.find((s) => s.target === 'C:/x/app.ini').checksum, 'new');
});

test('怪异点钉死：unknown-action 记录消耗 target 去重名额，同 target 更早的合法记录被静默吞掉', () => {
  const { steps, skipped } = L.computeRollback(
    [
      { kind: 'file', target: 'C:/t', action: 'unlink' }, // 合法但已被后面的占坑者消耗
      { kind: 'file', target: 'C:/t', action: 'teleport' }, // 未知 action → skipped 且占坑
    ],
    { env: ON }
  );
  assert.equal(steps.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'unknown-action');
});

test('computeRollback 的 skipped 分类：非对象 invalid、缺三元组 malformed；非法输入回空', () => {
  const r = L.computeRollback([null, 42, { kind: 'file', target: '', action: 'unlink' }, { kind: 'zzz', target: 't', action: 'unlink' }], { env: ON });
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['malformed', 'malformed', 'invalid', 'invalid']);
  assert.deepEqual(L.computeRollback('not-array', { env: ON }), { steps: [], skipped: [] });
  assert.deepEqual(L.computeRollback([{ kind: 'file', target: 'x', action: 'unlink' }], { env: OFF }), { steps: [], skipped: [] }, '门关 → 不回滚');
});

test('describeInstallLedger 自描述与常量对得上（文档/CLI 消费面）', () => {
  const d = L.describeInstallLedger();
  assert.equal(d.gate, 'KHY_INSTALL_LEDGER');
  assert.equal(d.defaultOn, true);
  assert.deepEqual(d.kinds, ['file', 'dir', 'registration', 'process', 'runtime']);
  assert.ok(d.actions.includes('unregister-autostart') && d.actions.includes('remove-runtime'));
  assert.deepEqual(Object.values(L.KIND), d.kinds);
});
