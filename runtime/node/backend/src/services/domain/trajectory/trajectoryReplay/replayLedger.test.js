'use strict';

/**
 * replayLedger.test.js — 钉死回放账本契约：seq 单调、JSONL 边车路径推导、延迟写队列
 * （pendingCount/read 并轨/flush/drainSync）、writeDiff→artifacts 的 op 推导与内容库落盘、
 * result 摘要形状、verifyLedger 连续性判级，以及 recordToolTurn 永不抛（防呆①）。
 *
 * 测试在 require 之前把 KHY_PROJECT_DATA_HOME 指到 mkdtemp 临时根，账本/内容库全部落在
 * 临时目录内，绝不触碰真实 .khy 或用户主目录。
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// —— 必须在 require 被测模块前就位：把所有项目级数据落点重定向到本测试专属临时根 ——
const FIX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-ledger-'));
process.env.KHY_PROJECT_DATA_HOME = path.join(FIX_ROOT, 'data');

const mod = require('./replayLedger');
const artifactHash = require('./artifactHash');
const sp = require('../../../sessionPersistence');

after(() => {
  mod.drainSync(); // 排空残留队列，避免退出钩子往将删目录里写
  fs.rmSync(FIX_ROOT, { recursive: true, force: true });
});

let _sidSeq = 0;
function freshSid(tag) {
  _sidSeq += 1;
  return `unit-${tag}-${_sidSeq}`;
}

function ledgerPathOf(sid) {
  return mod.ledgerPathFor(sp.jsonlPathFor(sid));
}

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[name] = prev;
    } else {
      delete process.env[name];
    }
  }
}

function recordSync(arg) {
  return withEnv('KHY_REPLAY_LEDGER_SYNC', '1', () => {
    const r = mod.recordToolTurn(arg);
    mod.drainSync();
    return r;
  });
}

test('导出恰为 12 个符号，版本与边车扩展名常量钉死', () => {
  assert.deepStrictEqual(Object.keys(mod).sort(), [
    'LEDGER_EXT',
    'LEDGER_VERSION',
    '_contentStoreDir',
    '_resetSeq',
    'drainSync',
    'flush',
    'ledgerPathFor',
    'nextSeq',
    'pendingCount',
    'read',
    'recordToolTurn',
    'verifyLedger',
  ]);
  assert.strictEqual(mod.LEDGER_VERSION, 1);
  assert.strictEqual(mod.LEDGER_EXT, '.replay-ledger.jsonl');
});

test('ledgerPathFor 把 .jsonl 结尾替换为账本边车名，大小写后缀同样剥掉', () => {
  const p = mod.ledgerPathFor(path.join('a', 'b', 's.jsonl'));
  assert.strictEqual(path.basename(p), 's.replay-ledger.jsonl');
  assert.strictEqual(path.dirname(p), path.join('a', 'b'));
  assert.strictEqual(path.basename(mod.ledgerPathFor(path.join('x', 'A.JSONL'))), 'A.replay-ledger.jsonl');
});

test('ledgerPathFor 对非 .jsonl 后缀直接追加边车扩展名', () => {
  assert.strictEqual(path.basename(mod.ledgerPathFor(path.join('x', 'a.txt'))), 'a.txt.replay-ledger.jsonl');
});

test('read 对不存在路径与目录都返回空数组不抛', () => {
  assert.deepStrictEqual(mod.read(path.join(FIX_ROOT, 'nope.jsonl')), []);
  assert.deepStrictEqual(mod.read(path.join(FIX_ROOT, 'data')), []); // data 目录由 env 重定向时建出
});

test('read 跳过空行与坏 JSON 行，仅返回可解析条目', () => {
  const f = path.join(FIX_ROOT, 'mixed.jsonl');
  fs.writeFileSync(f, '{"seq":0,"name":"a","tier":"SHELL"}\n\nnot-json\n{bad\n{"seq":1,"name":"b","tier":"FILE"}\n');
  const entries = mod.read(f);
  assert.strictEqual(entries.length, 2);
  assert.deepStrictEqual(entries.map((e) => e.seq), [0, 1]);
});

test('recordToolTurn 缺 sessionId 或 name 返回结构化错误而非抛', () => {
  assert.deepStrictEqual(mod.recordToolTurn(), { ok: false, error: 'missing sessionId/name' });
  assert.deepStrictEqual(mod.recordToolTurn({}), { ok: false, error: 'missing sessionId/name' });
  assert.deepStrictEqual(mod.recordToolTurn({ sessionId: 's', name: null }), {
    ok: false,
    error: 'missing sessionId/name',
  });
});

test('同步模式 recordToolTurn 落盘条目钉死：v/seq/name/normName/tier/params 兜底与 paramsHash', () => {
  const sid = freshSid('shape');
  const r = recordSync({
    sessionId: sid,
    name: 'WriteFile',
    params: null,
    result: null,
    writeDiff: null,
  });
  assert.deepStrictEqual(r, { ok: true, seq: 0 });
  const e = mod.read(ledgerPathOf(sid))[0];
  assert.strictEqual(e.v, 1);
  assert.strictEqual(e.seq, 0);
  assert.strictEqual(e.name, 'WriteFile');
  assert.strictEqual(e.normName, 'writefile');
  assert.strictEqual(e.tier, 'FILE');
  assert.deepStrictEqual(e.params, {}); // null params 兜底为空对象
  assert.strictEqual(e.paramsHash, artifactHash.hashCanonical({}));
  // 注意：null result 时 _summarizeResult 走「非对象」分支，success/exitCode 均为 undefined，
  // 经 JSON 往返后键整体消失，盘上只剩 outputHash/denied（实测契约，非注释宣称的四键形状）
  assert.deepStrictEqual(e.result, { outputHash: null, denied: false });
  assert.strictEqual(e.writeDiff, null);
  assert.deepStrictEqual(e.artifacts, []);
});

test('result 摘要：success 严格 true 判定、exitCode 仅收数字、output 三键回退并哈希规范 JSON', () => {
  const sid = freshSid('result');
  recordSync({
    sessionId: sid,
    name: 'Shell',
    params: {},
    result: { success: 'truthy', exitCode: 2, content: { a: 1 } },
  });
  recordSync({ sessionId: sid, name: 'x', params: {}, result: 'plain-string', seq: 1 });
  const [a, b] = mod.read(ledgerPathOf(sid));
  assert.strictEqual(a.result.success, false); // 'truthy' !== true
  assert.strictEqual(a.result.exitCode, 2);
  assert.strictEqual(a.result.outputHash, artifactHash.hashCanonical({ a: 1 })); // content 键回退命中
  assert.strictEqual(a.result.denied, false);
  // 非对象 result 的摘要中 success/exitCode 为 undefined，JSON 往返后键整体消失（实测契约）
  assert.deepStrictEqual(b.result, { outputHash: null, denied: false });
});

test('output 键优先级 output > content > stdout，stdout 兜底也可用', () => {
  const sid = freshSid('outprio');
  recordSync({ sessionId: sid, name: 'x', params: {}, result: { stdout: 'OUT' } });
  const e = mod.read(ledgerPathOf(sid))[0];
  assert.strictEqual(e.result.outputHash, artifactHash.hashCanonical('OUT'));
});

test('denied 为 true 时摘要必须保留拒绝标记', () => {
  const sid = freshSid('denied');
  recordSync({ sessionId: sid, name: 'x', params: {}, result: { denied: true } });
  assert.strictEqual(mod.read(ledgerPathOf(sid))[0].result.denied, true);
});

test('writeDiff 三态：空 before=create、空 after=delete、双非空=modify 且各哈希就位', () => {
  const sid = freshSid('ops');
  const NEW = 'NEW-' + sid;
  const OLD = 'OLD-' + sid;
  recordSync({
    sessionId: sid, name: 'Edit', params: {}, result: {}, seq: 0,
    writeDiff: { filePath: 'n.txt', beforeContent: '', afterContent: NEW },
  });
  recordSync({
    sessionId: sid, name: 'Edit', params: {}, result: {}, seq: 1,
    writeDiff: { filePath: 'd.txt', beforeContent: OLD, afterContent: '' },
  });
  recordSync({
    sessionId: sid, name: 'Edit', params: {}, result: {}, seq: 2,
    writeDiff: { filePath: 'm.txt', beforeContent: OLD, afterContent: NEW },
  });
  const [c, d, m] = mod.read(ledgerPathOf(sid));
  assert.strictEqual(c.artifacts[0].op, 'create');
  assert.strictEqual(c.writeDiff.beforeHash, null);
  assert.strictEqual(c.artifacts[0].sha256, artifactHash.hashString(NEW));
  assert.strictEqual(d.artifacts[0].op, 'delete');
  assert.strictEqual(d.artifacts[0].sha256, null);
  assert.strictEqual(d.writeDiff.afterHash, null);
  assert.strictEqual(m.artifacts[0].op, 'modify');
  assert.strictEqual(m.writeDiff.beforeHash, artifactHash.hashString(OLD));
});

test('writeDiff 退化形态：非字符串 before 视作空=create；双空串仍判 create 且终态哈希为 null；缺 filePath 整体为 null', () => {
  const sid = freshSid('degen');
  recordSync({ sessionId: sid, name: 'Edit', params: {}, result: {}, seq: 0, writeDiff: { filePath: 'q.txt', beforeContent: 123, afterContent: 'QQ' } });
  recordSync({ sessionId: sid, name: 'Edit', params: {}, result: {}, seq: 1, writeDiff: { filePath: 'e.txt', beforeContent: '', afterContent: '' } });
  recordSync({ sessionId: sid, name: 'Edit', params: {}, result: {}, seq: 2, writeDiff: { beforeContent: 'a' } });
  const entries = mod.read(ledgerPathOf(sid));
  assert.strictEqual(entries[0].artifacts[0].op, 'create'); // 非字符串 before → 视为 ''
  assert.strictEqual(entries[1].artifacts[0].op, 'create');
  assert.strictEqual(entries[1].artifacts[0].sha256, null);
  assert.strictEqual(entries[2].writeDiff, null);
  assert.deepStrictEqual(entries[2].artifacts, []);
});

test('内容库按 sha256 存 after 字节；delete（after 空）不新增 blob', () => {
  const sid = freshSid('store');
  const NEW = 'STORE-ME-' + sid;
  recordSync({
    sessionId: sid, name: 'Edit', params: {}, result: {},
    writeDiff: { filePath: 'x.txt', beforeContent: '', afterContent: NEW },
  });
  const sha = artifactHash.hashString(NEW);
  const blob = path.join(mod._contentStoreDir(sid), sha);
  assert.ok(fs.existsSync(blob));
  assert.strictEqual(fs.readFileSync(blob, 'utf-8'), NEW);
  const before = fs.readdirSync(mod._contentStoreDir(sid)).length;
  recordSync({
    sessionId: sid, name: 'Edit', params: {}, result: {}, seq: 1,
    writeDiff: { filePath: 'x.txt', beforeContent: NEW, afterContent: '' },
  });
  assert.strictEqual(fs.readdirSync(mod._contentStoreDir(sid)).length, before); // delete 不新增
});

test('KHY_REPLAY_CAPTURE_CONTENT=off 时内容库不落 blob（哈希仍入账）', () => {
  const sid = freshSid('off');
  const NEW = 'NO-STORE-' + sid;
  withEnv('KHY_REPLAY_CAPTURE_CONTENT', 'off', () => {
    recordSync({
      sessionId: sid, name: 'Edit', params: {}, result: {},
      writeDiff: { filePath: 'y.txt', beforeContent: '', afterContent: NEW },
    });
  });
  const e = mod.read(ledgerPathOf(sid))[0];
  assert.strictEqual(e.artifacts[0].sha256, artifactHash.hashString(NEW));
  assert.strictEqual(fs.existsSync(path.join(mod._contentStoreDir(sid), artifactHash.hashString(NEW))), false);
});

test('seq 自动单调 0→1，显式 seq 原样采用且不推进计数器', () => {
  const sid = freshSid('seq');
  assert.deepStrictEqual(mod.recordToolTurn({ sessionId: sid, name: 'a', params: {}, result: {} }), { ok: true, seq: 0 });
  assert.deepStrictEqual(mod.recordToolTurn({ sessionId: sid, name: 'b', params: {}, result: {} }), { ok: true, seq: 1 });
  assert.deepStrictEqual(mod.recordToolTurn({ sessionId: sid, name: 'c', params: {}, result: {}, seq: 99 }), { ok: true, seq: 99 });
  assert.deepStrictEqual(mod.recordToolTurn({ sessionId: sid, name: 'd', params: {}, result: {} }), { ok: true, seq: 2 });
  mod.drainSync();
});

test('verifyLedger 对连续序列 ok，空文件 ok 且 length 0，断号与缺 tier 分别给出首个坏下标', () => {
  const ok = path.join(FIX_ROOT, 'v-ok.jsonl');
  fs.writeFileSync(ok, [[0, 'a', 'SHELL'], [1, 'b', 'FILE']].map((x) => JSON.stringify({ seq: x[0], name: x[1], tier: x[2] }) + '\n').join(''));
  assert.deepStrictEqual(mod.verifyLedger(ok), { ok: true, length: 2, badAt: null, reason: null });
  const empty = path.join(FIX_ROOT, 'v-empty.jsonl');
  fs.writeFileSync(empty, '');
  assert.deepStrictEqual(mod.verifyLedger(empty), { ok: true, length: 0, badAt: null, reason: null });
  const gap = path.join(FIX_ROOT, 'v-gap.jsonl');
  fs.writeFileSync(gap, [0, 1, 3].map((s) => JSON.stringify({ seq: s, name: 'x', tier: 'FILE' }) + '\n').join(''));
  const g = mod.verifyLedger(gap);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.badAt, 2);
  assert.strictEqual(g.reason, 'seq 不连续：期望 2 实为 3');
  const shape = path.join(FIX_ROOT, 'v-shape.jsonl');
  fs.writeFileSync(shape, JSON.stringify({ seq: 0, name: 'x', tier: '' }) + '\n');
  const s = mod.verifyLedger(shape);
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.reason, '条目 #0 缺 name/tier');
});

test('异步默认模式：record 只入队，read 并轨未刷条目，flush() 后落盘且队列清零', async () => {
  const sid = freshSid('async');
  const lp = ledgerPathOf(sid);
  await withEnv('KHY_REPLAY_LEDGER_SYNC', undefined, async () => {
    const r = mod.recordToolTurn({ sessionId: sid, name: 'a', params: {}, result: {} });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(mod.pendingCount(), 1);
    assert.strictEqual(fs.existsSync(lp), false);
    assert.strictEqual(mod.read(lp).length, 1); // 读并轨：record 后立即可读
    await mod.flush();
    assert.strictEqual(mod.pendingCount(), 0);
    assert.ok(fs.existsSync(lp));
    assert.strictEqual(mod.read(lp).length, 1);
  });
});

test('drainSync 同步排空队列到磁盘（供导出与进程退出消费者）', () => {
  const sid = freshSid('drain');
  const lp = ledgerPathOf(sid);
  withEnv('KHY_REPLAY_LEDGER_SYNC', undefined, () => {
    mod.recordToolTurn({ sessionId: sid, name: 'a', params: {}, result: {} });
    assert.strictEqual(mod.pendingCount(), 1);
    mod.drainSync();
    assert.strictEqual(mod.pendingCount(), 0);
    assert.ok(fs.existsSync(lp));
  });
});

test('_resetSeq 清单会话计数后按盘上账本长度重播种；缺参清空全部', () => {
  const sid = freshSid('reset');
  recordSync({ sessionId: sid, name: 'a', params: {}, result: {} });
  recordSync({ sessionId: sid, name: 'b', params: {}, result: {} });
  assert.strictEqual(mod.nextSeq(sid), 2); // 计数器已有 2
  mod._resetSeq(sid);
  assert.strictEqual(mod.nextSeq(sid), 2); // 重播种自盘上 2 条 → 仍是 2
  mod._resetSeq();
  assert.strictEqual(mod.nextSeq(sid), 2); // 清空后同样从盘播种，不倒退也不前跳
});
