'use strict';

// KhySelf 对齐契约测试 —— 见 docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-153] khy 自知面对齐规范.md
//
// 本文件锁死「一份分面 SSOT,两个消费面」的四条不变量:
//   ① 锚点漂移可机检 —— selfAuditRegistry 的每个 evidenceAnchors.modules 都必须解析到真实文件
//   ② 两个面不可再分叉 —— KhySelf action enum / commandSchema self 子命令 / SELF_FACETS 三者一致
//   ③ D2 矛盾消失 —— 只读 profile 族都能看到 KhySelf(系统提示却在指挥模型调它)
//   ④ 每个分面都真的能取到值,且绝不抛
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const SERVICES_DIR = path.join(BACKEND_ROOT, 'src', 'services');

const KhySelfTool = require('../../src/tools/KhySelfTool');
const selfProfile = require('../../src/services/selfProfile');
const commandSchema = require('../../src/constants/commandSchema');
const sar = require('../../src/services/selfAuditRegistry');
const verifier = require('../../src/services/selfAuditVerifier');

const FACETS = selfProfile.SELF_FACETS;
const FACET_KEYS = FACETS.map((f) => f.key);

// ── ⑦ (design §4.2) SELF_FACETS 自身契约 ─────────────────────────────────────
test('SELF_FACETS:冻结、key 唯一、每个分面带 aliases/summary', () => {
  assert.ok(Array.isArray(FACETS) && FACETS.length === 8, '8 个分面');
  assert.ok(Object.isFrozen(FACETS), '外层冻结');
  const seen = new Set();
  for (const f of FACETS) {
    assert.ok(Object.isFrozen(f), `${f.key} 冻结`);
    assert.strictEqual(typeof f.key, 'string');
    assert.ok(f.key.length > 0);
    assert.ok(!seen.has(f.key), `${f.key} 唯一`);
    seen.add(f.key);
    assert.ok(Array.isArray(f.aliases), `${f.key} aliases 是数组`);
    assert.strictEqual(typeof f.summary, 'string');
    assert.ok(f.summary.length > 0, `${f.key} 有 summary`);
  }
  // 8 个 canonical key 是这 8 个(设计 §1.3 的并集)
  assert.deepStrictEqual(FACET_KEYS.slice().sort(), [
    'boundaries',
    'capabilities',
    'commands',
    'identity',
    'location',
    'runtime',
    'self_audit',
    'self_audit_verify',
  ]);
});

// ── ① (design §4.1) 锚点漂移永久可机检 ───────────────────────────────────────
test('D1:每条 selfAudit evidenceAnchors.modules 都解析到真实文件(锚点不可过期)', () => {
  const items = sar.getSelfAuditItems();
  assert.ok(items.length >= 5, '至少 5 条自审项');
  for (const item of items) {
    const anchors = item.evidenceAnchors || {};
    for (const name of anchors.modules || []) {
      // 与 selfAuditVerifier._verifyItem 同一解析规则:以 services/ 为基,允许 '../tools/x'
      const abs = path.join(SERVICES_DIR, String(name) + '.js');
      assert.ok(
        fs.existsSync(abs),
        `${item.id} 的锚点 '${name}' 解析到 ${path.relative(BACKEND_ROOT, abs)} 但文件不存在 —— 模块搬家后锚点必须同步(见 [DESIGN-ARCH-153] D1)`
      );
    }
  }
});

test('D1:verifyAll 对全部 5 条追踪项核验通过(#7 不再假报核验失败)', () => {
  const res = verifier.verifyAll({ env: {} });
  assert.ok(res && res.results, 'verifier 返回结果');
  for (const [id, r] of Object.entries(res.results)) {
    assert.strictEqual(r.verified, true, `${id} 应核验通过,实际 reason=${r.reason}`);
  }
});

test('D1:实跑系统提示不再出现 ·核验失败(自报事实与事实一致)', () => {
  const block = selfProfile.formatForSystemPrompt(selfProfile.getFullProfile({ cwd: process.cwd() }));
  assert.ok(block.includes('## khyos 自我认知'), '自审块仍在注入');
  assert.ok(!/·核验失败/.test(block), '系统提示不应再出现 ·核验失败 徽标');
  assert.ok(/·已核验/.test(block), '应有 ·已核验 徽标');
});

// ── ② (design §4.2) 两个面不可再分叉 ─────────────────────────────────────────
test('parity:KhySelf action enum 覆盖全部分面 + all', () => {
  const schema = new KhySelfTool().inputSchema;
  const enumValues = schema.properties.action.enum;
  for (const key of FACET_KEYS) {
    assert.ok(enumValues.includes(key), `action enum 缺分面 '${key}'`);
  }
  assert.ok(enumValues.includes('all'), 'action enum 含 all');
});

test('parity:commandSchema 的 self 子命令表 == SELF_FACETS canonical keys', () => {
  const sub = commandSchema.getRouterSubCommands();
  assert.ok(Array.isArray(sub.self), '/self 有子命令表');
  assert.deepStrictEqual(
    sub.self.slice().sort(),
    FACET_KEYS.slice().sort(),
    '/self 子命令表与 SELF_FACETS 漂移了 —— 两侧必须由 parity 测试锁死([DESIGN-ARCH-153] §4.2)'
  );
});

test('parity:resolveFacetKey 自反 + 别名解析 + 未知 fail-closed', () => {
  for (const f of FACETS) {
    assert.strictEqual(selfProfile.resolveFacetKey(f.key), f.key, `${f.key} 自反`);
    for (const a of f.aliases) {
      assert.strictEqual(selfProfile.resolveFacetKey(a), f.key, `别名 ${a} → ${f.key}`);
    }
  }
  // 大小写 / 连字符容忍
  assert.strictEqual(selfProfile.resolveFacetKey('  Self-Audit '), 'self_audit');
  assert.strictEqual(selfProfile.resolveFacetKey('CAPABILITIES'), 'capabilities');
  // fail-closed:未知不落到默认值
  assert.strictEqual(selfProfile.resolveFacetKey('bogus'), null);
  assert.strictEqual(selfProfile.resolveFacetKey(''), null);
  assert.strictEqual(selfProfile.resolveFacetKey(null), null);
  assert.strictEqual(selfProfile.resolveFacetKey(42), null);
});

test('parity:/self CLI 面由 SELF_FACETS 驱动(源码契约,不手维护第二份枚举)', () => {
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src', 'cli', 'routerDispatchTail.js'),
    'utf8'
  );
  assert.ok(
    /SELF_FACETS|getSelfFacet|resolveFacetKey/.test(src),
    "case 'self' 必须消费 SELF_FACETS/getSelfFacet —— 否则 CLI 面又变成手维护的第二份枚举"
  );
});

// ── ③ (design §4.3) D2 矛盾消失 ──────────────────────────────────────────────
test('D2:五个只读/受限 profile 都能看到 KhySelf(提示词与工具清单不再矛盾)', () => {
  const { getProfileTools } = require('../../src/tools/toolProfile');
  for (const p of ['minimal', 'coding', 'analysis', 'verification', 'explore']) {
    const tools = getProfileTools(p) || [];
    assert.ok(tools.includes('KhySelf'), `profile '${p}' 缺 KhySelf`);
  }
});

test('D2:assembleToolPool(undefined,"coding") 实际含 KhySelf', () => {
  const registry = require('../../src/tools/index');
  registry.loadTools();
  const pool = registry.assembleToolPool(undefined, 'coding');
  assert.ok([...pool.keys()].includes('KhySelf'), 'coding 池必须含 KhySelf');
});

// ── ④ (design §4.4) 每个分面都真的能取到值 ───────────────────────────────────
test('getSelfFacet:8 个分面逐个 ok:true、data 非空、绝不抛', () => {
  for (const key of FACET_KEYS) {
    let r;
    assert.doesNotThrow(() => {
      r = selfProfile.getSelfFacet(key, { cwd: process.cwd(), env: {} });
    }, `${key} 不得抛`);
    assert.strictEqual(r.ok, true, `${key} 应 ok:true,实际 reason=${r.reason}`);
    assert.strictEqual(r.facet, key);
    assert.ok(r.data !== null && r.data !== undefined, `${key} data 非空`);
    if (Array.isArray(r.data)) {
      assert.ok(r.data.length > 0, `${key} 数组非空`);
    } else if (typeof r.data === 'object') {
      assert.ok(Object.keys(r.data).length > 0, `${key} 对象非空`);
    }
  }
});

test('getSelfFacet:未知分面 → ok:false + 诚实 reason(不伪造、不静默空白)', () => {
  const r = selfProfile.getSelfFacet('bogus', { env: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.facet, null);
  assert.match(r.reason, /unknown facet/i);
  assert.doesNotThrow(() => selfProfile.getSelfFacet(null, null));
});

test('getSelfFacet(self_audit_verify):5 项证据全 verified', () => {
  const r = selfProfile.getSelfFacet('self_audit_verify', { env: {} });
  assert.strictEqual(r.ok, true);
  const items = r.data.items;
  assert.ok(Array.isArray(items) && items.length === 5, '5 条追踪项');
  for (const it of items) {
    assert.strictEqual(it.verified, true, `${it.id} 未通过核验:${it.reason}`);
  }
  assert.strictEqual(typeof r.data.selfSourceDir, 'string');
});

test('getSelfFacet(commands) 尊重 query 过滤且 matched<=total', () => {
  const all = selfProfile.getSelfFacet('commands', { env: {} });
  assert.strictEqual(all.ok, true);
  assert.ok(all.data.total > 0);
  const filtered = selfProfile.getSelfFacet('commands', { env: {}, query: 'gateway' });
  assert.ok(filtered.data.matched >= 1);
  assert.ok(filtered.data.matched <= filtered.data.total);
});

// ── agent 面:新分面经工具真的可达 ────────────────────────────────────────────
test('KhySelf 工具暴露 identity/capabilities/boundaries/runtime 四个新分面', async () => {
  const t = new KhySelfTool();
  const caps = await t.execute({ action: 'capabilities' });
  assert.strictEqual(caps.success, true);
  assert.strictEqual(caps.action, 'capabilities');
  assert.ok(caps.facet && caps.facet.ok, 'facet envelope present');

  const b = await t.execute({ action: 'boundaries' });
  assert.strictEqual(b.success, true);
  assert.ok(Array.isArray(b.facet.data) && b.facet.data.length > 0);

  const rt = await t.execute({ action: 'runtime' });
  assert.strictEqual(rt.success, true);
  assert.ok(rt.facet.data && rt.facet.data.runtime, 'runtime 分面含 runtime 子块');

  const id = await t.execute({ action: 'identity' });
  assert.strictEqual(id.success, true);
  assert.strictEqual(id.facet.data.name, 'khy OS');
});

test('KhySelf 工具:别名可作 action(where/cap/audit 等)', async () => {
  const t = new KhySelfTool();
  const where = await t.execute({ action: 'where' });
  assert.strictEqual(where.action, 'location');
  assert.ok(where.location, '别名 where → location');
});

test('KhySelf 工具:既有 action 行为不回归(location/commands/all)', async () => {
  const t = new KhySelfTool();
  const loc = await t.execute({ action: 'location' });
  assert.strictEqual(loc.success, true);
  assert.match(loc.location.selfSourceDir, /services[\/\\]backend[\/\\]src$/);
  assert.strictEqual(loc.commands, undefined, 'location-only 不带 commands');

  const cmds = await t.execute({ action: 'commands' });
  assert.strictEqual(cmds.success, true);
  assert.ok(cmds.commands.total > 0);
  assert.strictEqual(cmds.location, undefined, 'commands-only 不带 location');

  const all = await t.execute({});
  assert.strictEqual(all.action, 'all');
  assert.ok(all.location && all.commands, 'all 含 location + commands');
});

test('KhySelf 工具:未知 action 归一到 all(默认值只在调用方)', async () => {
  const r = await new KhySelfTool().execute({ action: 'bogus' });
  assert.strictEqual(r.action, 'all');
});

// ── D5:PlanTool 不再是死件 ───────────────────────────────────────────────────
test('D5:PlanTool 可加载、在注册表中、store 访问器仍可消费', () => {
  let tool;
  assert.doesNotThrow(() => {
    tool = require('../../src/tools/PlanTool.js');
  }, 'PlanTool 必须能 require(此前冻结对象赋值抛 TypeError)');
  assert.strictEqual(tool.name, 'PlanTool');
  assert.strictEqual(typeof tool._getPlan, 'function', '_getPlan 仍导出(消费方 API 不变)');
  assert.strictEqual(typeof tool._clearPlan, 'function', '_clearPlan 仍导出');
  assert.ok(Object.isFrozen(tool), '仍是冻结工具定义');

  const registry = require('../../src/tools/index');
  registry.loadTools();
  assert.ok(registry.get('PlanTool'), 'PlanTool 必须出现在工具注册表里');
});