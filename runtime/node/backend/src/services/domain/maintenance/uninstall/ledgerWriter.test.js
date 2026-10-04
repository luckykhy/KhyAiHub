'use strict';

/**
 * ledgerWriter.test.js — 钉死台账唯一写 IO 边界：append-only、fail-soft 绝不抛、
 * 门关 no-op、时间戳注入优先级。
 *
 * 数据家红线：本模块解析路径的优先级是 KHY_DATA_HOME > getDataHome() > ~/.khy，
 * 而 opts.env 是**整体替换** process.env 的 —— 所以每个用例都必须在注入 env 里
 * 显式放 KHY_DATA_HOME 指到临时目录，否则第二档会真实解析进用户数据家。
 * 不 stub utils/dataHome：只要 KHY_DATA_HOME 在，那条 require 分支根本不会执行，
 * 「不碰真身目录」本身就是被钉的行为。
 *
 * 实测钉死的怪异行为（非理想行为）：
 *   · appendSideEffect 用 `{ ...entry }` 浅拷贝后补 ts —— 入参对象不被污染，
 *     但 entry.ts 只要非 null/undefined（含 0、含字符串）就不再注入。
 *   · dir 不存在时 mkdir 失败只 best-effort 吞掉，随后 appendFileSync 抛错被外层
 *     catch 收敛为 false —— 磁盘异常路径全库只留一个布尔。
 *   · 门关时连台账文件所在的目录都不会被创建（no-op 是零侧的）。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const W = require('./ledgerWriter');
const L = require('./installLedger');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-lw-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function home() {
  const dir = path.join(TMP, `h${(seq += 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, env: { KHY_DATA_HOME: dir } };
}

const validEntry = () => ({ kind: 'dir', target: path.join(TMP, 'payload'), action: 'rmdir' });

test('_resolveLedgerFile：KHY_DATA_HOME 直接决定落点（resolve 后拼固定文件名）', () => {
  const { dir, env } = home();
  assert.equal(W._resolveLedgerFile(env), L.ledgerPath(dir));
  assert.ok(W._resolveLedgerFile(env).endsWith('.install-ledger.jsonl'));
  // 相对 dataHome 被锚定为绝对路径
  assert.equal(W._resolveLedgerFile({ KHY_DATA_HOME: 'rel/home' }), path.join(path.resolve('rel/home'), '.install-ledger.jsonl'));
});

test('appendSideEffect 写一条合法记录：返回 true，落盘是含 v/kind/target/action/ts 的 JSON 行', () => {
  const { dir, env } = home();
  const ok = W.appendSideEffect({ kind: 'file', target: path.join(dir, 'x.txt'), action: 'unlink' }, { env, ts: 111 });
  assert.equal(ok, true);
  const lines = fs.readFileSync(L.ledgerPath(dir), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(rec).sort(), ['action', 'kind', 'target', 'ts', 'v']);
  assert.equal(rec.v, 1);
  assert.equal(rec.ts, 111, 'opts.ts 注入优先于 Date.now');
  assert.ok(path.isAbsolute(rec.target));
});

test('append-only：两次追加按发生顺序成两行，第一行不被改写', () => {
  const { dir, env } = home();
  W.appendSideEffect({ kind: 'file', target: path.join(dir, 'a'), action: 'unlink' }, { env, ts: 1 });
  W.appendSideEffect({ kind: 'file', target: path.join(dir, 'b'), action: 'unlink' }, { env, ts: 2 });
  const rows = fs
    .readFileSync(L.ledgerPath(dir), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.ts), [1, 2], '顺序即历史，逆序回滚的前提');
});

test('entry 自带 ts 优先于 opts.ts；0 也是有效时间戳不被覆盖；入参对象零污染', () => {
  const { dir, env } = home();
  const entry = { ...validEntry(), ts: 0 };
  assert.equal(W.appendSideEffect(entry, { env, ts: 999 }), true);
  const rec = JSON.parse(fs.readFileSync(L.ledgerPath(dir), 'utf8'));
  assert.equal(rec.ts, 0, 'ts==null 判据下 0 不再注入（怪异点如实钉死）');
  assert.deepEqual(Object.keys(entry).sort(), ['action', 'kind', 'target', 'ts']);
});

test('门关 → false 且零侧面：台账文件与目录都不出现', () => {
  const dead = path.join(TMP, 'gate-off-home');
  const ok = W.appendSideEffect(validEntry(), { env: { KHY_DATA_HOME: dead, KHY_INSTALL_LEDGER: 'off' } });
  assert.equal(ok, false);
  assert.equal(fs.existsSync(dead), false);
});

test('非法 entry（kind 不在白名单 / entry 为 null）→ false，不写一行', () => {
  const { dir, env } = home();
  assert.equal(W.appendSideEffect({ kind: 'symlink', target: 'x', action: 'unlink' }, { env }), false);
  assert.equal(W.appendSideEffect(null, { env }), false);
  assert.equal(fs.existsSync(L.ledgerPath(dir)), false);
});

test('磁盘异常路径收敛为 false 绝不抛：dataHome 的父位被文件占住', () => {
  const blocker = path.join(TMP, 'blocker');
  fs.writeFileSync(blocker, 'i am a file, not a directory');
  const env = { KHY_DATA_HOME: path.join(blocker, 'sub') };
  assert.equal(W.appendSideEffect(validEntry(), { env }), false, 'ENOTDIR 必须被 catch 吞成 false');
});
