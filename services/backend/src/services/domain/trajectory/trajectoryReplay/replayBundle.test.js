'use strict';

/**
 * replayBundle.test.js — 钉死自包含回放包契约：目录推导纯函数、exportBundle 全量落盘
 * （账本原文拷贝 + 内容寻址 blob + env.json + manifest 摘要）、readBundle/verifyBundle 的
 * 篡改检测（账本哈希、blob 哈希/缺失、NETWORK_AI 计入 skipped），全程 total 不抛。
 *
 * 实测钉住的行为（非缺陷修复承诺）：exportBundle 对一个从未录制的 sessionId 返回 ok:true
 * 且 steps 为空——「空包也是合法包」是当前契约（replayBundle.js:91-166），已作为潜在缺陷上报。
 * 数据根经 KHY_PROJECT_DATA_HOME 重定向到临时目录，绝不写真实 .khy。
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-bundle-'));
process.env.KHY_PROJECT_DATA_HOME = path.join(FIX_ROOT, 'data');
process.env.KHY_REPLAY_LEDGER_SYNC = '1'; // 账本同步落盘，令导出可见

const mod = require('./replayBundle');
const artifactHash = require('./artifactHash');
const replayLedger = require('./replayLedger');
const tierRegistry = require('./tierRegistry');

after(() => {
  replayLedger.drainSync();
  fs.rmSync(FIX_ROOT, { recursive: true, force: true });
});

let _n = 0;
function freshSid(tag) {
  _n += 1;
  return `bundle-${tag}-${_n}`;
}

function makeSessionWithBlob(sid) {
  const NEW = 'BUNDLE-CONTENT-' + sid;
  const sha = artifactHash.hashString(NEW);
  replayLedger.recordToolTurn({
    sessionId: sid,
    name: 'WriteFile',
    params: { file_path: 'x.txt', content: NEW },
    result: { success: true },
    writeDiff: { filePath: 'x.txt', beforeContent: '', afterContent: NEW },
  });
  replayLedger.recordToolTurn({
    sessionId: sid,
    name: 'WebSearch',
    params: { query: 'q' },
    result: {},
    seq: 1,
  });
  replayLedger.drainSync();
  return { NEW, sha };
}

test('导出恰为 8 个符号，包常量钉死 v=1 与目录后缀', () => {
  assert.deepStrictEqual(Object.keys(mod).sort(), [
    'BUNDLE_DIR_SUFFIX',
    'BUNDLE_KIND',
    'BUNDLE_VERSION',
    'bundleDirFor',
    'contentPath',
    'exportBundle',
    'readBundle',
    'verifyBundle',
  ]);
  assert.strictEqual(mod.BUNDLE_VERSION, 1);
  assert.strictEqual(mod.BUNDLE_KIND, 'khyos-replay-bundle');
  assert.strictEqual(mod.BUNDLE_DIR_SUFFIX, '.replaybundle');
});

test('bundleDirFor 传 outDir 时是纯路径拼接且数字 sessionId 强转字符串', () => {
  const p = mod.bundleDirFor('sess1', path.join('root', 'out'));
  assert.strictEqual(p, path.join('root', 'out', 'sess1.replaybundle'));
  assert.strictEqual(path.basename(mod.bundleDirFor(42, 'root')), '42.replaybundle');
  assert.strictEqual(fs.existsSync(p), false); // 只推导不建目录
});

test('bundleDirFor 缺省 outDir 时落到（被重定向的）项目数据根 trajectory_replay 下', () => {
  const sid = freshSid('default-dir');
  const p = mod.bundleDirFor(sid);
  assert.strictEqual(
    p,
    path.join(FIX_ROOT, 'data', 'trajectory_replay', sid, `${sid}.replaybundle`),
  );
  assert.strictEqual(path.basename(p), `${sid}.replaybundle`);
});

test('contentPath 拼接 blob 路径', () => {
  assert.strictEqual(mod.contentPath('b', 'sha123'), path.join('b', 'content', 'sha123'));
});

test('readBundle 对缺失目录报 manifest.json 不存在、对坏 JSON 报解析错误，均不抛', () => {
  const miss = mod.readBundle(path.join(FIX_ROOT, 'nope'));
  assert.strictEqual(miss.ok, false);
  assert.strictEqual(miss.error, 'manifest.json 不存在');
  const br = path.join(FIX_ROOT, 'broken');
  fs.mkdirSync(br, { recursive: true });
  fs.writeFileSync(path.join(br, 'manifest.json'), '{oops');
  const bad = mod.readBundle(br);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.error.length > 0); // 携 JSON 解析错误原文
});

test('exportBundle 缺 sessionId 返回结构化错误', () => {
  assert.deepStrictEqual(mod.exportBundle(null), { ok: false, error: 'missing sessionId' });
});

test('exportBundle 对从未录制的会话产出空 steps 的合法空包（当前契约如实钉住，见头部注释）', () => {
  const sid = freshSid('empty');
  const out = path.join(FIX_ROOT, 'out-empty');
  const r = mod.exportBundle(sid, { outDir: out });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.manifest.steps, []);
  assert.strictEqual(r.manifest.summary.total, 0);
  assert.strictEqual(r.manifest.integrity.ledgerHash, artifactHash.hashString('')); // 空账本原文哈希
  assert.deepStrictEqual(r.manifest.integrity.chainStatus, { available: false });
  assert.strictEqual(fs.readFileSync(path.join(r.bundleDir, 'ledger.jsonl'), 'utf-8'), '');
});

test('exportBundle 全量流程：账本原文拷贝、FILE blob 复制、NETWORK_AI 计数、manifest 字段齐备', () => {
  const sid = freshSid('full');
  const { NEW, sha } = makeSessionWithBlob(sid);
  const out = path.join(FIX_ROOT, 'out-full');
  const r = mod.exportBundle(sid, { outDir: out });
  assert.strictEqual(r.ok, true);
  const m = r.manifest;
  assert.strictEqual(m.v, 1);
  assert.strictEqual(m.kind, 'khyos-replay-bundle');
  assert.strictEqual(m.sessionId, sid);
  assert.strictEqual(m.producer, 'khyos');
  assert.strictEqual(typeof m.createdAt, 'number');
  assert.strictEqual(m.steps.length, 2);
  assert.deepStrictEqual(m.summary, { total: 2, byTier: { FILE: 1, SHELL: 0, NETWORK_AI: 1 }, artifacts: 1 });
  assert.deepStrictEqual(m.contentManifest, { [sha]: { bytes: Buffer.byteLength(NEW) } });
  // ledger.jsonl 逐字节等于源账本
  const srcLedger = replayLedger.ledgerPathFor(require('../../../sessionPersistence').jsonlPathFor(sid));
  assert.strictEqual(
    fs.readFileSync(path.join(r.bundleDir, 'ledger.jsonl'), 'utf-8'),
    fs.readFileSync(srcLedger, 'utf-8'),
  );
  assert.strictEqual(m.integrity.ledgerHash, artifactHash.hashString(fs.readFileSync(srcLedger, 'utf-8')));
  // blob 已复制且哈希自洽
  const blob = mod.contentPath(r.bundleDir, sha);
  assert.ok(fs.existsSync(blob));
  assert.strictEqual(artifactHash.hashFile(blob), sha);
  // env.json 是合法指纹对象
  const env = JSON.parse(fs.readFileSync(path.join(r.bundleDir, 'env.json'), 'utf-8'));
  assert.ok(env.os && env.node);
  assert.ok(Object.keys(env).length > 0);
});

test('exportBundle 的 opts.includeContent=false 与 env 门 off 都不复制 blob（manifest 记空 contentManifest）', () => {
  const sid = freshSid('nocontent');
  const { sha } = makeSessionWithBlob(sid);
  const r1 = mod.exportBundle(sid, { outDir: path.join(FIX_ROOT, 'out-nc1'), includeContent: false });
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(r1.manifest.contentManifest, {});
  assert.strictEqual(fs.existsSync(mod.contentPath(r1.bundleDir, sha)), false);
  const r2 = (() => {
    const prev = process.env.KHY_REPLAY_CAPTURE_CONTENT;
    process.env.KHY_REPLAY_CAPTURE_CONTENT = 'off';
    try {
      return mod.exportBundle(sid, { outDir: path.join(FIX_ROOT, 'out-nc2') });
    } finally {
      if (prev === undefined) delete process.env.KHY_REPLAY_CAPTURE_CONTENT;
      else process.env.KHY_REPLAY_CAPTURE_CONTENT = prev;
    }
  })();
  assert.deepStrictEqual(r2.manifest.contentManifest, {});
});

test('verifyBundle 对干净包 ok，blob 被篡改报哈希不符，blob 被删报缺失且无法复现路径', () => {
  const sid = freshSid('verify');
  const { sha } = makeSessionWithBlob(sid);
  const r = mod.exportBundle(sid, { outDir: path.join(FIX_ROOT, 'out-v') });
  const clean = mod.verifyBundle(r.bundleDir);
  assert.strictEqual(clean.ok, true);
  assert.strictEqual(clean.skipped, 1); // NETWORK_AI 步计入 skipped
  assert.strictEqual(clean.verifiedBlobs, 1);
  const blob = mod.contentPath(r.bundleDir, sha);
  fs.writeFileSync(blob, 'CORRUPTED');
  const tampered = mod.verifyBundle(r.bundleDir);
  assert.strictEqual(tampered.ok, false);
  assert.match(tampered.errors.join(), /blob 被篡改/);
  assert.ok(tampered.errors[0].startsWith(`seq 0: `));
  fs.rmSync(blob);
  const missing = mod.verifyBundle(r.bundleDir);
  assert.strictEqual(missing.ok, false);
  assert.match(missing.errors.join(), /缺内容 blob/);
  assert.match(missing.errors.join(), /无法复现 x\.txt/);
});

test('verifyBundle 检测 ledger.jsonl 被改：报账本被篡改', () => {
  const sid = freshSid('ledger-tamper');
  makeSessionWithBlob(sid);
  const r = mod.exportBundle(sid, { outDir: path.join(FIX_ROOT, 'out-lt') });
  fs.appendFileSync(path.join(r.bundleDir, 'ledger.jsonl'), 'extra\n');
  const v = mod.verifyBundle(r.bundleDir);
  assert.strictEqual(v.ok, false);
  assert.match(v.errors.join(), /账本被篡改/);
});

test('verifyBundle 对 schema 违规（版本/类型/steps/账本缺失）逐条报错', () => {
  const dir = path.join(FIX_ROOT, 'bad-schema');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ v: 99, kind: 'other', steps: 'not-array', integrity: {} }),
  );
  const v = mod.verifyBundle(dir);
  assert.strictEqual(v.ok, false);
  assert.match(v.errors.join('\n'), /版本不符：期望 1 实为 99/);
  assert.match(v.errors.join('\n'), /类型不符：期望 khyos-replay-bundle 实为 other/);
  assert.match(v.errors.join('\n'), /manifest\.steps 缺失或非数组/);
  assert.match(v.errors.join('\n'), /ledger\.jsonl 不存在/);
});

test('verifyBundle 对读不出的包直接返回单条错误（错误来自 readBundle）', () => {
  const v = mod.verifyBundle(path.join(FIX_ROOT, 'no-such-bundle-dir'));
  assert.strictEqual(v.ok, false);
  assert.deepStrictEqual(v.errors, ['manifest.json 不存在']);
  assert.strictEqual(v.skipped, 0);
  assert.strictEqual(v.verifiedBlobs, 0);
});

test('verifyBundle 步缺 tier 时按工具名经 tierRegistry 兜底判档（WebSearch→NETWORK_AI 计入 skipped）', () => {
  const dir = path.join(FIX_ROOT, 'infer-tier');
  fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledgerPath, 'anything\n');
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      v: 1,
      kind: 'khyos-replay-bundle',
      steps: [{ seq: 0, name: 'WebSearch' }],
      integrity: { ledgerHash: artifactHash.hashString('anything\n') },
    }),
  );
  const v = mod.verifyBundle(dir);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.skipped, 1);
  assert.strictEqual(tierRegistry.effectiveTier('WebSearch'), 'NETWORK_AI'); // 反查依据
});
