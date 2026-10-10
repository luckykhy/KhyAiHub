'use strict';

/**
 * routeRollbackMatrix.test.js — §8 兼容/回退矩阵的**可执行版**。
 *
 * §8 那七行是「出事时系统会怎样」的承诺，此前一句都没整体验过（零散验过 3 行）。
 * 回退矩阵是本方案唯一的安全网：智能路由做错决定时可以整体关掉，而它一旦不成立，
 * 就没有任何东西保证「新机制坏了不带走旧机制」。
 *
 * 都驱动**真实** generate()，落盘重定向到临时账本，断言的是外部可观察的东西
 * （样本行、状态行、送去适配器的 model），不是内部布尔。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const h = require('./_ocrGatewayHarness');
const gw = require(BE + '/src/services/gateway/aiGateway');
const rm = require(BE + '/src/services/gateway/routingMode');
const autoRouting = require(BE + '/src/services/gateway/autoModelRouting');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const IMGS = [{ base64: 'ZmFrZQ==', mimeType: 'image/png' }];


const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-rollback-'));
const LEDGER = path.join(dir, 'auto-route.jsonl');

const env = h.envSandbox([
  'KHY_ROUTING_MODES',
  'KHY_ROUTE_APPLY',
  'KHY_ROUTE_DEMAND',
  'KHY_AUTO_MODEL_HEALTH_AWARE',
  'KHY_AUTO_MODEL_OBSERVE',
  'KHY_AUTO_MODEL_OBSERVE_FILE',
  'KHY_ROUTING_MODES_JSON',
  'GATEWAY_ROUTING_MODE',
  'GATEWAY_PREFERRED_ADAPTER',
  'GATEWAY_PREFERRED_MODEL',
  'KHY_TOOL_CAP_PROBE',
  'KHY_ROUTE_APPLY',
  'KHY_ROUTE_APPLY_STAGE',
]);

function freshLedger() {
  fs.writeFileSync(LEDGER, '', 'utf8');
}
function readLedger() {
  return fs
    .readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
function wire() {
  const rec = h.makeRecordingAdapter({ content: '回退矩阵已作答' });
  h.wireSingle(rec, { key: 'pool', activeModel: 'zzz-sonnet-4' });
  gw.listModels = async () => [{ model: 'zzz-sonnet-4' }, { model: 'zzz-mini' }];
  return rec;
}
async function turn(tag, extra) {
  const statuses = [];
  const res = await gw.generate(`回退矩阵探针 ${tag} ${process.pid}-${Date.now()}`, Object.assign({
    adapter: 'auto',
    model: 'auto',
    sessionId: 'RB',
    onChunk: (c) => {
      if (c && c.type === 'status' && c.text) statuses.push(String(c.text));
    },
  }, extra || {}));
  return { res, statuses };
}

const BASE = {
  KHY_AUTO_MODEL_HEALTH_AWARE: '1',
  KHY_AUTO_MODEL_OBSERVE: '1',
  KHY_AUTO_MODEL_OBSERVE_FILE: LEDGER,
  KHY_TOOL_CAP_PROBE: 'off',
  GATEWAY_PREFERRED_ADAPTER: 'auto',
  GATEWAY_PREFERRED_MODEL: '',
  KHY_ROUTE_APPLY: '0',
};

describe('§8 回退矩阵（真实 generate）', () => {
  before(() => env.save());
  after(() => env.restore());

  test('场景① KHY_ROUTING_MODES=0 ⇒ 模式轴完全不参与：无档名、无路由状态行、旧路径照常作答', async () => {
    freshLedger();
    wire();
    env.set({ ...BASE, KHY_ROUTING_MODES: '0', GATEWAY_ROUTING_MODE: 'economy' });
    const { res, statuses } = await turn('modes-off');

    assert.equal(res.success, true, '关掉模式轴必须仍然正常完成生成（新机制不得带走旧机制）');
    const selects = readLedger().filter((r) => r.ev === 'select');
    assert.ok(selects.length >= 1, '162 的观测与模式轴无关，应照写（否则回退顺手关掉了别的观测）');
    assert.strictEqual(selects[selects.length - 1].mode, null, '总闸关了就不该有档名');
    assert.ok(
      !statuses.some((t) => /路由|档位|降级/.test(t)),
      `不该发任何模式轴状态行，实际=${JSON.stringify(statuses)}`
    );
  });

  test('场景② 内联档位卡 JSON 坏 ⇒ 照常作答 + 点名「无可用兜底档」，不假装落到 perf', async () => {
    // 叶子层先把事实钉住：坏 JSON 时 resolveMode 为 null，而 fallbackMode 住在**同一张卡**里，
    // 所以它也必须为 null —— 这里最容易被顺手写成「保底落 perf」，那是凭空造一个档。
    const brokenEnv = {
      KHY_ROUTING_MODES: '1',
      KHY_ROUTING_MODES_JSON: '{ this is not json',
      GATEWAY_ROUTING_MODE: 'economy',
    };
    assert.strictEqual(rm.resolveMode('economy', { env: brokenEnv }), null, '坏卡必须解析成 null');
    assert.strictEqual(
      rm.fallbackModeName(brokenEnv),
      null,
      '卡不可读时兜底档名也必须不可得（不许硬编码 perf 当保底）'
    );

    freshLedger();
    wire();
    env.set({ ...BASE, ...brokenEnv });
    const { res, statuses } = await turn('card-broken');

    assert.equal(res.success, true, '卡坏了也必须照常作答（新机制不得带走旧机制）');
    const sel = readLedger().filter((r) => r.ev === 'select').pop();
    assert.ok(sel, '应仍有 select 样本');
    assert.strictEqual(sel.mode, null, '卡坏了不该有一个档在生效');
    assert.match(
      String(sel.softFail || ''),
      /档位卡解析失败/,
      `必须点名故障本身，实际 softFail=${JSON.stringify(sel.softFail)}`
    );
    assert.match(
      String(sel.softFail || ''),
      /无可用兜底档/,
      `必须承认兜底档也拿不到，实际 softFail=${JSON.stringify(sel.softFail)}`
    );
    assert.ok(
      statuses.some((t) => /路由降级/.test(t)),
      `软失败必须发状态行（§8 的「不静默」），实际=${JSON.stringify(statuses)}`
    );
  });

  test('场景②b 卡整体不可解析 ⇒ 点名「无可用兜底档」，不假装落到 perf', async () => {
    // 这一条走的是叶子层能确定构造的形态：档名不认识且 defaultMode 也解析不出来。
    const broken = { KHY_ROUTING_MODES: '1', KHY_ROUTING_MODES_JSON: '{"modes":{}}' };
    assert.strictEqual(
      rm.resolveMode('economy', { env: broken }),
      null,
      '卡里一个档都没有时应返回 null（调用方据此发「无可用兜底档」）'
    );
    assert.strictEqual(
      rm.fallbackModeName(broken),
      null,
      'fallbackMode 也住在同一张卡里 —— 卡没了它也必须诚实返回 null，不许编一个 perf'
    );
  });

  test('场景⑤ 钉选 ⇒ 模式轴连观测都不写（一条 select 都不该有）', async () => {
    freshLedger();
    wire();
    env.set({
      ...BASE,
      KHY_ROUTING_MODES: '1',
      GATEWAY_ROUTING_MODE: 'economy',
      GATEWAY_PREFERRED_ADAPTER: 'pool', // 钉到真的装着候选的那个渠道（'pool' 是本 harness 的 key）
    });
    // 关键：**不传 options.adapter='auto'** —— 上一版这里传了，等于自己把钉选覆盖掉，
    // 测的就不是「钉选时旁路」而是「显式 auto」。
    const { res, statuses } = await turn('pinned', { adapter: 'pool', model: 'zzz-sonnet-4' });
    assert.equal(res.success, true);
    const rows = readLedger();
    assert.strictEqual(
      rows.filter((r) => r.ev === 'select').length,
      0,
      `钉选时模式轴连观测都不写（§8 的承诺）：实际写了 ${JSON.stringify(rows.map((r) => r.ev))}`
    );
    // 代理条件收紧过：上一版用「任何含 路由/档位 的状态行都不许出现」来表达「模式轴没生效」，
    // 结果把**说明「没生效」的那一行**也一起禁了 —— 用户在钉选下看到的就只剩一片沉默（§16.4ar）。
    // 真正要禁的是「声称做过路由决定」的行；解释行反过来必须存在。
    assert.ok(
      !statuses.some((t) => /路由\(|路由降级|路由档名未识别|档位卡解析失败|本阶段只观测未改道/.test(t)),
      `钉选不许发「声称做过路由决定」的状态行，实际=${JSON.stringify(statuses)}`
    );
    assert.ok(
      statuses.some((t) => /模式轴未参与/.test(t)),
      `钉选必须解释为什么模式轴没参与（RUNTIME-002），实际=${JSON.stringify(statuses)}`
    );
  });

  test('场景⑥ 162 的 HEALTH_AWARE=0 ⇒ 候选池不建，本方案整体缺席且不影响生成', async () => {
    freshLedger();
    wire();
    env.set({
      ...BASE,
      KHY_AUTO_MODEL_HEALTH_AWARE: '0',
      KHY_ROUTING_MODES: '1',
      GATEWAY_ROUTING_MODE: 'economy',
    });
    const { res, statuses } = await turn('health-off');
    assert.equal(res.success, true, '关掉 162 的门也必须照常作答');
    assert.strictEqual(
      readLedger().filter((r) => r.ev === 'select').length,
      0,
      '池不建则 rank 不可用，不该出现 select 样本'
    );
    assert.ok(
      !statuses.some((t) => /路由|档位/.test(t)),
      `162 关掉时模式轴不得自己冒出来，实际=${JSON.stringify(statuses)}`
    );
  });
});