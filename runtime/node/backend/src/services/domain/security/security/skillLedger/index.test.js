'use strict';

/**
 * index.test.js — 钉死 skill ledger 的 Ed25519 认证闭环：密钥初始化幂等、
 * 签署/验签三态失败路径、manifest 篡改必拒、审计轨迹的尾部截取与坏行跳过。
 *
 * 为什么这支套件必须存在：这是「技能执行前完整性校验」的唯一正门。verifySkill
 * 的任何一格误放行（比如篡改 manifest 后仍 valid:true）等于整条签名链作废；
 * 而误拒绝（正常轮报 content_modified）会让所有已认证技能集体罢工。两侧都得钉。
 *
 * 隔离方式：本模块所有落盘经 _ledgerDir() → utils/dataHome.getAppDataDir，
 * 用 require.cache 桩把 dataHome 换成「返回测试临时目录」，逐用例重开新目录，
 * 绝不触碰 ~/.khyquant / ~/.khy。测后 rm 临时目录并还原 cache。
 *
 * 实测更正（与直觉不同处，按真实语义钉死）：
 *   · certifySkill 未初始化密钥直接 **throw**；verifySkill 未初始化却返回
 *     {valid:false, reason:'ledger_not_initialized'}——一个炸一个软，不对称。
 *   · 签名 payload 里带 Date.now() 时间戳，同一技能重复 certify 签名必不同
 *     （manifest 条目整体覆盖，只保留最后一次）。
 *   · 签名被换成**另一技能的真签名**、或长度非法的 base64，crypto.verify 在本
 *     Node/OpenSSL 下都只返回 false → reason 'invalid_signature'（不抛）。reason
 *     为 'signature_error: ...' 的 catch 分支实际触发条件是 verify 调用本身 throw
 *     （如公钥 PEM 损坏），测用坏公钥构造。
 *   · revokeSkill 对不存在的技能是静默 no-op，不追加审计行。
 *   · getAuditTrail(limit) 是**先按原始行切尾、再过滤坏行**——非法 JSON 行照样
 *     消耗 limit 名额，返回条数可能少于 limit。
 *   · hashSkillDirectory 以 path.relative 为键排序后逐个喂 (相对路径, 内容)，
 *     故内容相同、根目录不同的两棵树哈希一致；文件**内容**变更才会变。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── dataHome 桩：把 ledger 目录钉进临时区 ────────────────────────────────

const DATA_HOME_PATH = require.resolve('../../../../../utils/dataHome');
const ORIGINAL = require.cache[DATA_HOME_PATH];

let LEDGER_ROOT = null; // 逐用例重开，指向当前临时目录

require.cache[DATA_HOME_PATH] = {
  id: DATA_HOME_PATH,
  filename: DATA_HOME_PATH,
  loaded: true,
  exports: {
    getAppDataDir: (...segments) => path.join(LEDGER_ROOT, ...segments),
  },
  children: [],
  paths: [],
};

const ledger = require('./index');

function freshHome() {
  LEDGER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-skillledger-'));
}

after(() => {
  if (ORIGINAL) require.cache[DATA_HOME_PATH] = ORIGINAL;
  else delete require.cache[DATA_HOME_PATH];
  if (LEDGER_ROOT) fs.rmSync(LEDGER_ROOT, { recursive: true, force: true });
});

// ── 用例 ─────────────────────────────────────────────────────────────────

test('initKeys：生成 Ed25519 密钥对落盘，二次调用幂等复用', () => {
  freshHome();
  const first = ledger.initKeys();
  assert.equal(first.created, true);
  assert.match(first.publicKey, /^-----BEGIN PUBLIC KEY-----/);
  const kpFile = path.join(LEDGER_ROOT, 'skill-ledger', 'keypair.json');
  assert.ok(fs.existsSync(kpFile));
  const onDisk = JSON.parse(fs.readFileSync(kpFile, 'utf-8'));
  assert.equal(onDisk.algorithm, 'Ed25519');
  assert.ok(onDisk.privateKey.includes('PRIVATE KEY')); // 明文私钥落盘（现状如实钉死）
  const second = ledger.initKeys();
  assert.equal(second.created, false);
  assert.equal(second.publicKey, first.publicKey);
  // 审计留下 init_keys 且带 16 位公钥哈希前缀
  const trail = ledger.getAuditTrail();
  assert.equal(trail[0].action, 'init_keys');
  assert.match(trail[0].publicKeyHash, /^[0-9a-f]{16}$/);
});

test('getPublicKey：未初始化返回 null，initKeys 后返回同一公钥', () => {
  freshHome();
  assert.equal(ledger.getPublicKey(), null);
  const { publicKey } = ledger.initKeys();
  assert.equal(ledger.getPublicKey(), publicKey);
});

test('hashSkillContent / hashSkillDirectory：确定性与目录聚合语义', () => {
  const h = ledger.hashSkillContent('abc');
  assert.equal(h, crypto.createHash('sha256').update('abc', 'utf-8').digest('hex'));
  assert.equal(ledger.hashSkillContent('abc'), h); // 纯函数
  assert.notEqual(ledger.hashSkillContent('abd'), h);

  freshHome();
  const treeA = path.join(LEDGER_ROOT, 'a');
  const treeB = path.join(LEDGER_ROOT, 'b');
  for (const root of [treeA, treeB]) {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skill.md'), 'x');
    fs.writeFileSync(path.join(root, 'sub', 'impl.js'), 'y');
  }
  const hashA = ledger.hashSkillDirectory(treeA);
  assert.equal(ledger.hashSkillDirectory(treeB), hashA); // 根不同、相对结构相同 → 同哈希
  fs.writeFileSync(path.join(treeA, 'skill.md'), 'z'); // 改内容
  assert.notEqual(ledger.hashSkillDirectory(treeA), hashA);
});

test('certifySkill 未初始化即抛；verifySkill 未初始化软失败（不对称现状）', () => {
  freshHome();
  assert.throws(() => ledger.certifySkill('s', 'hash'), /not initialized/);
  const v = ledger.verifySkill('s', 'hash');
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'ledger_not_initialized');
  assert.equal(v.certifiedAt, null);
});

test('certify → verify 正向闭环；哈希不符报 content_modified 并落审计', () => {
  freshHome();
  ledger.initKeys();
  const hash = ledger.hashSkillContent('skill body');
  const { signature, certifiedAt } = ledger.certifySkill('demo', hash, { author: 'me' });
  assert.ok(Buffer.from(signature, 'base64').length > 0);
  const ok = ledger.verifySkill('demo', hash);
  assert.equal(ok.valid, true);
  assert.equal(ok.reason, 'ok');
  assert.equal(ok.certifiedAt, certifiedAt);

  const stale = ledger.verifySkill('demo', 'deadbeef');
  assert.deepEqual(
    { valid: stale.valid, reason: stale.reason },
    { valid: false, reason: 'content_modified' }
  );
  assert.equal(stale.certifiedAt, certifiedAt); // 失败也带回认证时间
  const uncertified = ledger.verifySkill('ghost', hash);
  assert.equal(uncertified.reason, 'skill_not_certified');
  const trail = ledger.getAuditTrail();
  // jsonl 为追加序（旧→新），逐事件如实入账
  assert.deepEqual(
    trail.map((e) => e.action),
    ['init_keys', 'certify', 'verify_ok', 'verify_failed']
  );
});

test('manifest 篡改必拒：换他技能真签名→invalid_signature，换坏长度→signature_error', () => {
  freshHome();
  ledger.initKeys();
  const hashA = ledger.hashSkillContent('A');
  const hashB = ledger.hashSkillContent('B');
  ledger.certifySkill('skillA', hashA);
  ledger.certifySkill('skillB', hashB);

  const mf = path.join(LEDGER_ROOT, 'skill-ledger', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf-8'));
  // 把 A 的真签名搬到 B（合法 64 字节但对不上 payload）→ crypto.verify 返回 false
  manifest.skillB.signature = manifest.skillA.signature;
  fs.writeFileSync(mf, JSON.stringify(manifest));
  const cross = ledger.verifySkill('skillB', hashB);
  assert.equal(cross.valid, false);
  assert.equal(cross.reason, 'invalid_signature');

  // 实测更正：换成**非法长度**的 base64 时，本 Node/OpenSSL 下 crypto.verify
  // 不抛、返回 false → 仍走 'invalid_signature' 分支（并非 signature_error）。
  manifest.skillB.signature = Buffer.from('short').toString('base64');
  fs.writeFileSync(mf, JSON.stringify(manifest));
  const broken = ledger.verifySkill('skillB', hashB);
  assert.equal(broken.valid, false);
  assert.equal(broken.reason, 'invalid_signature');

  // signature_error 分支的真触发条件是 crypto.verify **抛错**——用损坏的公钥
  // PEM 构造（key 对象解析失败会 throw）。
  const kpFile = path.join(LEDGER_ROOT, 'skill-ledger', 'keypair.json');
  const kp = JSON.parse(fs.readFileSync(kpFile, 'utf-8'));
  kp.publicKey = 'not-a-pem';
  fs.writeFileSync(kpFile, JSON.stringify(kp));
  const errBranch = ledger.verifySkill('skillB', hashB);
  assert.equal(errBranch.valid, false);
  assert.match(errBranch.reason, /^signature_error: /);
  assert.equal(errBranch.certifiedAt, manifest.skillB.certifiedAt);
});

test('listCertifiedSkills / revokeSkill：清单映射与撤销后不可验', () => {
  freshHome();
  ledger.initKeys();
  ledger.certifySkill('s1', 'h1', { tag: 'x' });
  ledger.certifySkill('s2', 'h2');
  const list = ledger.listCertifiedSkills();
  assert.deepEqual(list.map((e) => e.skillId).sort(), ['s1', 's2']);
  const s1 = list.find((e) => e.skillId === 's1');
  assert.deepEqual(s1.metadata, { tag: 'x' });
  assert.deepEqual(list.find((e) => e.skillId === 's2').metadata, {}); // 缺省补空对象

  const auditBefore = ledger.getAuditTrail().length;
  ledger.revokeSkill('nope'); // no-op 不留审计
  assert.equal(ledger.getAuditTrail().length, auditBefore);

  ledger.revokeSkill('s1');
  assert.equal(ledger.verifySkill('s1', 'h1').reason, 'skill_not_certified');
  assert.deepEqual(ledger.listCertifiedSkills().map((e) => e.skillId), ['s2']);
});

test('getAuditTrail：无文件回空、limit 取尾部、坏 JSON 行静默跳过', () => {
  freshHome();
  assert.deepEqual(ledger.getAuditTrail(), []);
  ledger.initKeys(); // 产生 1 行 audit
  const auditFile = path.join(LEDGER_ROOT, 'skill-ledger', 'audit.jsonl');
  fs.appendFileSync(auditFile, 'not-json\n');
  fs.appendFileSync(auditFile, JSON.stringify({ action: 'tail_evt' }) + '\n');
  const trail = ledger.getAuditTrail();
  assert.equal(trail[trail.length - 1].action, 'tail_evt');
  assert.ok(!trail.some((e) => e.action === undefined)); // 坏行没混进来
  // 实测更正：limit 先切原始行再过滤——'not-json' 行占掉一个名额，只剩 1 条
  const last2 = ledger.getAuditTrail(2);
  assert.equal(last2.length, 1);
  assert.equal(last2[0].action, 'tail_evt');
});
