/**
 * healGuard.test.js — 自愈声明闸（[DESIGN-ARCH-141] §5-D2）的行为测试。
 *
 * 覆盖三层：
 *   ① 纯叶子 checkHealClaim   —— save 侧：自愈声明是否可溯源（判据）
 *   ② 纯叶子 computeHealVerdict —— run 侧：自愈闭环三态裁决（只报不滚）
 *   ③ flowRegistry.save 集成  —— 闸真的拦在写盘之前（事务性）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert');
const { test, after } = require('node:test');

// ⚠ dataHome 在**模块加载时**缓存解析结果 ⇒ 必须在 require flowRegistry 之前把
// KHY_DATA_HOME 指到隔离 tmpdir，否则测试会写到用户真实数据家（~/.khy）。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-heal-guard-'));
process.env.KHY_DATA_HOME = TMP_HOME;

const {
  checkHealClaim,
  computeHealVerdict,
  DEFAULT_MAX_HEAL_DEPTH,
} = require('../src/services/domain/project/workflow/healGuard.js');
const registry = require('../src/services/domain/project/workflow/flowRegistry.js');

after(() => {
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* ok */
  }
});

// ── 夹具 ────────────────────────────────────────────────────────────────────

const PREV_GRAPH = {
  nodes: [
    { id: 's', type: 'start', data: {} },
    { id: 'n_broken', type: 'prompt', data: { prompt: 'broken' } },
    { id: 'e', type: 'end', data: {} },
  ],
  connections: [],
};

const mkGraph = (promptText) => ({
  nodes: [
    { id: 's', type: 'start', data: {} },
    { id: 'n_broken', type: 'prompt', data: { prompt: promptText } },
    { id: 'e', type: 'end', data: {} },
  ],
  connections: [
    { from: 's', fromPort: 'default', to: 'n_broken', toPort: 'input' },
    { from: 'n_broken', fromPort: 'default', to: 'e', toPort: 'input' },
  ],
});

const flowFile = (name) =>
  path.join(TMP_HOME, 'workflows', `${name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.json`);

const readMeta = (name) => JSON.parse(fs.readFileSync(flowFile(name), 'utf8'))._meta;

// ═══════════════════════════════════════════════════════════════════════════
// ① 纯叶子：checkHealClaim
// ═══════════════════════════════════════════════════════════════════════════

test('checkHealClaim：healedFrom 必须是非空字符串', () => {
  for (const bad of ['', '   ', undefined, null, 42, {}]) {
    const r = checkHealClaim({ healedFrom: bad, prevGraph: PREV_GRAPH, prevMeta: {} });
    assert.strictEqual(r.ok, false, `healedFrom=${JSON.stringify(bad)} 应被拒`);
  }
  assert.match(
    checkHealClaim({ healedFrom: '' }).errors[0],
    /非空字符串/,
    '错误串必须点明是 healedFrom 本身的问题'
  );
});

test('checkHealClaim：无上一版 ⇒ 声称自愈是幻觉', () => {
  const r = checkHealClaim({ healedFrom: 'n_broken', prevGraph: null, prevMeta: null });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors[0], /不可溯源/);
  // 上一版存在但没有节点，等价于无上一版
  const r2 = checkHealClaim({
    healedFrom: 'n_broken',
    prevGraph: { nodes: [], connections: [] },
    prevMeta: {},
  });
  assert.strictEqual(r2.ok, false, '上一版无节点也应判为不可溯源');
});

test('checkHealClaim：根因节点必须存在于上一版图中', () => {
  const miss = checkHealClaim({
    healedFrom: 'n_ghost',
    prevGraph: PREV_GRAPH,
    prevMeta: {},
  });
  assert.strictEqual(miss.ok, false, '凭空捏造的节点 id 必须被拒');
  assert.match(miss.errors[0], /不在上一版流程中/);

  const hit = checkHealClaim({
    healedFrom: 'n_broken',
    prevGraph: PREV_GRAPH,
    prevMeta: {},
  });
  assert.deepStrictEqual(hit, { ok: true, depth: 1 }, '真溯源应放行且深度从 1 起算');
});

test('checkHealClaim：自愈链深度累加与上限', () => {
  assert.strictEqual(DEFAULT_MAX_HEAL_DEPTH, 5, '默认上限应为 5');
  const at = (prev) =>
    checkHealClaim({ healedFrom: 'n_broken', prevGraph: PREV_GRAPH, prevMeta: prev });
  assert.deepStrictEqual(at({ healDepth: 4 }), { ok: true, depth: 5 }, 'prev 4 ⇒ 5 应放行');
  assert.strictEqual(at({ healDepth: 5 }).ok, false, 'prev 5 ⇒ 6 应超限被拒');
  assert.match(at({ healDepth: 5 }).errors[0], /超过上限 5/);
  // 未声明 healDepth ⇒ 链在上一版处断开，重新从 1 起算
  assert.deepStrictEqual(at({}), { ok: true, depth: 1 });
  assert.deepStrictEqual(at({ healDepth: undefined }), { ok: true, depth: 1 });
});

test('checkHealClaim：healDepth 损坏 ⇒ fail-closed（不静默当 0）', () => {
  for (const bad of ['x', -1, 1.5, {}]) {
    const r = checkHealClaim({
      healedFrom: 'n_broken',
      prevGraph: PREV_GRAPH,
      prevMeta: { healDepth: bad },
    });
    assert.strictEqual(r.ok, false, `healDepth=${JSON.stringify(bad)} 应被拒`);
  }
});

test('checkHealClaim：maxDepth 可覆盖，且绝不抛', () => {
  assert.strictEqual(
    checkHealClaim({
      healedFrom: 'n_broken',
      prevGraph: PREV_GRAPH,
      prevMeta: { healDepth: 1 },
      maxDepth: 1,
    }).ok,
    false
  );
  for (const bad of [undefined, null, {}, 'str', 42, [], { healedFrom: 'x', prevGraph: { nodes: 'no' } }]) {
    assert.doesNotThrow(() => checkHealClaim(bad), `畸形入参 ${JSON.stringify(bad)} 不得抛`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 纯叶子：computeHealVerdict（三态必须可区分）
// ═══════════════════════════════════════════════════════════════════════════

const HEALED_META = (extra) => ({
  healedFrom: 'n_broken',
  healDepth: 2,
  previousVersion: 4,
  ...extra,
});
const CONTRACT = [{ type: 'fileExists', path: '/tmp/x' }];

test('computeHealVerdict：非自愈流程返回 null（不出裁决）', () => {
  assert.strictEqual(computeHealVerdict({ meta: {}, succeeded: true }), null);
  assert.strictEqual(computeHealVerdict(), null);
  assert.strictEqual(computeHealVerdict(null), null);
  assert.strictEqual(computeHealVerdict({ meta: { healedFrom: 42 } }), null);
});

test('computeHealVerdict：契约全绿 ⇒ healVerified', () => {
  const v = computeHealVerdict({
    meta: HEALED_META({ contract: CONTRACT }),
    succeeded: true,
    contractFailed: false,
    flowName: 'demo',
  });
  assert.strictEqual(v.healVerified, true);
  assert.strictEqual(v.healRejected, undefined, '三态互斥');
  assert.strictEqual(v.healUnverified, undefined, '三态互斥');
  assert.deepStrictEqual(v.rollbackTarget, { name: 'demo', version: 4 });
  assert.strictEqual(v.healDepth, 2);
});

test('computeHealVerdict：契约未全绿 ⇒ healRejected（含 run 失败）', () => {
  const contractFail = computeHealVerdict({
    meta: HEALED_META({ contract: CONTRACT }),
    succeeded: true,
    contractFailed: true,
    flowName: 'demo',
  });
  assert.strictEqual(contractFail.healRejected, true);
  assert.strictEqual(contractFail.healRejectReason, 'contract-failed');
  assert.strictEqual(contractFail.healVerified, undefined, '不得同时算 verified');

  const runFail = computeHealVerdict({
    meta: HEALED_META({ contract: CONTRACT }),
    succeeded: false,
    contractFailed: false,
    flowName: 'demo',
  });
  assert.strictEqual(runFail.healRejected, true);
  assert.strictEqual(runFail.healRejectReason, 'run-failed');
  assert.notStrictEqual(
    runFail.healRejectReason,
    contractFail.healRejectReason,
    '两种成因必须可区分（fail-closed ≠ 错误报对）'
  );
});

test('computeHealVerdict：无法判定 ⇒ healUnverified（不得静默算 verified）', () => {
  // ① 未声明 contract：无断言可判 ⇒ 闸空转
  const noContract = computeHealVerdict({
    meta: HEALED_META({}),
    succeeded: true,
    contractFailed: false,
    flowName: 'demo',
  });
  assert.strictEqual(noContract.healUnverified, true);
  assert.strictEqual(noContract.healVerified, undefined, '无断言不得算 verified');
  assert.match(noContract.healUnverifiedReason, /未声明 contract/);

  // 空数组等价于未声明
  assert.strictEqual(
    computeHealVerdict({
      meta: HEALED_META({ contract: [] }),
      succeeded: true,
      flowName: 'demo',
    }).healUnverified,
    true
  );

  // ② 契约校验环节自身异常：原代码 fail-soft 按通过处理 ⇒ 裁决必须诚实说「未验证」
  const checkerBoom = computeHealVerdict({
    meta: HEALED_META({ contract: CONTRACT }),
    succeeded: true,
    contractFailed: false,
    contractCheckError: 'checker exploded',
    flowName: 'demo',
  });
  assert.strictEqual(checkerBoom.healUnverified, true);
  assert.strictEqual(checkerBoom.healVerified, undefined, '校验坏了不得算 verified');
  assert.match(checkerBoom.healUnverifiedReason, /checker exploded/);
});

test('computeHealVerdict：rollbackTarget 缺失时不编造', () => {
  for (const meta of [
    { healedFrom: 'n_broken', contract: CONTRACT },
    { healedFrom: 'n_broken', previousVersion: 0, contract: CONTRACT },
    { healedFrom: 'n_broken', previousVersion: 'x', contract: CONTRACT },
  ]) {
    const v = computeHealVerdict({ meta, succeeded: true, flowName: 'demo' });
    assert.strictEqual(v.rollbackTarget, null, '无有效 previousVersion ⇒ 目标为 null');
    assert.strictEqual(v.healDepth, null, 'healDepth 缺失 ⇒ null（不编 0）');
  }
});

test('computeHealVerdict：绝不抛', () => {
  for (const bad of ['str', 42, [], { meta: 'notobj', succeeded: true }, { meta: { healedFrom: {} } }]) {
    assert.doesNotThrow(() => computeHealVerdict(bad), `畸形入参 ${JSON.stringify(bad)} 不得抛`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 集成：闸真的拦在写盘之前
// ═══════════════════════════════════════════════════════════════════════════

test('save：首次保存带 healedFrom ⇒ 拒（无上一版可溯源），且不留文件', () => {
  const name = 'heal-first';
  const r = registry.save(name, mkGraph('v1'), { intent: 'probe', healedFrom: 'n_broken' });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors[0], /不可溯源/);
  assert.strictEqual(fs.existsSync(flowFile(name)), false, '被拒的 save 不得落盘');
});

test('save：幻觉 healedFrom 被拒，且文件逐字节未变（事务性）', () => {
  const name = 'heal-ghost';
  assert.strictEqual(registry.save(name, mkGraph('v1'), { intent: 'probe' }).ok, true);
  const before = fs.readFileSync(flowFile(name), 'utf8');

  const r = registry.save(name, mkGraph('v2'), { intent: 'probe', healedFrom: 'n_ghost' });
  assert.strictEqual(r.ok, false, '根因节点不在上一版 ⇒ 必须拒');
  assert.match(r.errors[0], /不在上一版流程中/);
  assert.strictEqual(fs.readFileSync(flowFile(name), 'utf8'), before, '原图必须逐字节未变');
  assert.strictEqual(readMeta(name).version, 1, '版本号不得推进');
  assert.strictEqual(readMeta(name).healedFrom, undefined, '不得写入幻觉 healedFrom');
});

test('save：同图 + healedFrom 被拒（原先会被静默丢弃）', () => {
  const name = 'heal-unchanged';
  assert.strictEqual(registry.save(name, mkGraph('v1'), { intent: 'probe' }).ok, true);
  const r = registry.save(name, mkGraph('v1'), { intent: 'probe', healedFrom: 'n_broken' });
  assert.strictEqual(r.ok, false, '图未变 ⇒ 不构成自愈，必须拒而不是静默 ok');
  assert.match(r.errors[0], /逐字节相同/);
  assert.strictEqual(
    readMeta(name).healedFrom,
    undefined,
    '★ 不得像原先那样返回 ok:true 却静默丢弃 healedFrom'
  );
});

test('save：真溯源通过，落盘 healedFrom + healDepth', () => {
  const name = 'heal-ok';
  assert.strictEqual(registry.save(name, mkGraph('v1'), { intent: 'probe' }).ok, true);
  const r = registry.save(name, mkGraph('v2'), { intent: 'probe', healedFrom: 'n_broken' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, 2);
  const meta = readMeta(name);
  assert.strictEqual(meta.healedFrom, 'n_broken');
  assert.strictEqual(meta.healDepth, 1, '首次自愈深度应为 1');
  assert.strictEqual(meta.previousVersion, 1, '回退目标所需字段必须在');
});

test('save：自愈链累加到上限 5，第 6 次被拒', () => {
  const name = 'heal-chain';
  assert.strictEqual(registry.save(name, mkGraph('v1'), { intent: 'probe' }).ok, true);
  for (let i = 2; i <= 6; i++) {
    const r = registry.save(name, mkGraph('v' + i), { intent: 'probe', healedFrom: 'n_broken' });
    assert.strictEqual(r.ok, true, `第 ${i - 1} 次自愈应放行`);
    assert.strictEqual(readMeta(name).healDepth, i - 1, `深度应为 ${i - 1}`);
  }
  const over = registry.save(name, mkGraph('v7'), { intent: 'probe', healedFrom: 'n_broken' });
  assert.strictEqual(over.ok, false, '第 6 次自愈（深度 6）必须被拒');
  assert.match(over.errors[0], /超过上限 5/);
  assert.strictEqual(readMeta(name).version, 6, '被拒不得推进版本');
});

test('save：非自愈保存断开自愈链，再次自愈深度回到 1', () => {
  const name = 'heal-break';
  assert.strictEqual(registry.save(name, mkGraph('v1'), { intent: 'probe' }).ok, true);
  assert.strictEqual(
    registry.save(name, mkGraph('v2'), { intent: 'probe', healedFrom: 'n_broken' }).ok,
    true
  );
  assert.strictEqual(readMeta(name).healDepth, 1);

  assert.strictEqual(registry.save(name, mkGraph('v3-clean'), { intent: 'probe' }).ok, true);
  assert.strictEqual(
    'healDepth' in readMeta(name),
    false,
    '非自愈保存必须清掉 healDepth（链断开）'
  );

  assert.strictEqual(
    registry.save(name, mkGraph('v4'), { intent: 'probe', healedFrom: 'n_broken' }).ok,
    true
  );
  assert.strictEqual(readMeta(name).healDepth, 1, '链断开后重新从 1 起算');
});

test('save：healedFrom 首尾空白被 trim 后落盘', () => {
  const name = 'heal-trim';
  assert.strictEqual(registry.save(name, mkGraph('v1'), { intent: 'probe' }).ok, true);
  const r = registry.save(name, mkGraph('v2'), { intent: 'probe', healedFrom: '  n_broken  ' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(readMeta(name).healedFrom, 'n_broken');
});

test('list：摘要暴露 healedFrom 与 healDepth', () => {
  const name = 'heal-listed';
  assert.strictEqual(registry.save(name, mkGraph('v1'), { intent: 'probe' }).ok, true);
  assert.strictEqual(
    registry.save(name, mkGraph('v2'), { intent: 'probe', healedFrom: 'n_broken' }).ok,
    true
  );
  const item = registry.list().flows.find((f) => f.name === name);
  assert.ok(item, 'list 应含该流程');
  assert.strictEqual(item._meta.healedFrom, 'n_broken');
  assert.strictEqual(item._meta.healDepth, 1);
});
