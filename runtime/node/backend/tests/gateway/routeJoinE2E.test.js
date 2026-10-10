'use strict';

/**
 * routeJoinE2E.test.js — [DESIGN-ARCH-185] §6.1 的**生产侧**证明。
 *
 * 为什么单独一个文件：此前所有 join 测试都手工构造行、或直接截住 `observeSelection`
 * 在内存里断言（§16.4j 为了不打脏真账本就是这么做的）。两种都没回答一个问题：
 * **真的跑一次 generate()，落盘的两行能不能被 route-replay join 起来？**
 * 现账本给了强提示：24 行全是 v0 无 turnId ⇒ `可 join 0`。这可能只是「P3 接线后没新流量」，
 * 也可能是接线根本没产出 v1 行 —— 前者无所谓，后者意味着 A2/A5/A6/A9/A10 永远算不出来。
 * 本文件把它跑成事实：写手**不截**，落盘**不碰真账本**（env 重定向到临时文件），
 * 最后用**真的 replay 工具**读回来。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BE = path.resolve(__dirname, '..', '..');
const REPLAY = path.resolve(BE, '..', '..', '..', 'scripts', 'ci', 'route-replay.js');
const h = require('./_ocrGatewayHarness');
const gw = require(BE + '/src/services/gateway/aiGateway');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-join-e2e-'));
const LEDGER = path.join(dir, 'auto-route.jsonl');
fs.writeFileSync(LEDGER, '', 'utf8');

const env = h.envSandbox([
  'KHY_AUTO_MODEL_OBSERVE_FILE',
  'KHY_AUTO_MODEL_OBSERVE',
  'KHY_AUTO_MODEL_HEALTH_AWARE',
  'KHY_ROUTING_MODES',
  'GATEWAY_ROUTING_MODE',
  'GATEWAY_PREFERRED_ADAPTER',
  'GATEWAY_PREFERRED_MODEL',
  'KHY_TOOL_CAP_PROBE',
]);

let rec;

function install() {
  rec = h.makeRecordingAdapter({ content: 'join 已作答' });
  h.wireSingle(rec, { key: 'pool', activeModel: 'zzz-sonnet-4' });
  gw.listModels = async () => [{ model: 'zzz-sonnet-4' }, { model: 'zzz-mini' }];
}

describe('§6.1 生产侧 join：真 generate() 落盘的两行必须能被真 replay 连起来', () => {
  before(() => {
    env.save();
    // 重定向落盘位置。不重定向就会把测试样本写进真账本 —— 那是 §16.4j 记过的污染。
    env.set({
      KHY_AUTO_MODEL_OBSERVE_FILE: LEDGER,
      KHY_AUTO_MODEL_OBSERVE: '1',
      KHY_AUTO_MODEL_HEALTH_AWARE: '1',
      KHY_ROUTING_MODES: '1',
      GATEWAY_ROUTING_MODE: 'auto',
      GATEWAY_PREFERRED_ADAPTER: 'auto',
      KHY_TOOL_CAP_PROBE: 'off',
    });
    install();
  });

  after(() => env.restore());

  test('落盘的 select 行是 v1 且带 turnId（v0 就永远不会可 join）', async () => {
    await gw.generate(`生产侧 join 探针 ${process.pid}-${Date.now()}`, {
      adapter: 'auto',
      model: 'auto',
      sessionId: 'JOIN-E2E',
    });

    const rows = fs
      .readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(rows.length > 0, '一次 generate 后账本仍是空的 —— 观测根本没写盘');

    const selects = rows.filter((r) => r.ev === 'select');
    assert.ok(selects.length >= 1, `应有 select 行，实际事件=${JSON.stringify(rows.map((r) => r.ev))}`);
    const s = selects[selects.length - 1];
    assert.strictEqual(s.v, 1, `select 必须是 v1（v0 = 无 turnId 的旧格式，永远 join 不上）：${JSON.stringify(s).slice(0, 160)}`);
    assert.ok(s.turnId && typeof s.turnId === 'string', 'select 必须带 turnId');
    assert.ok(/\d+:.*:\d+/.test(s.turnId), `turnId 应含 pid 前缀以支持跨进程不串号，实际 ${s.turnId}`);
  });

  test('成功路径的 outcome 行带着同一个 turnId', async () => {
    const before = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).length;
    await gw.generate(`生产侧 join 探针2 ${process.pid}-${Date.now()}`, {
      adapter: 'auto',
      model: 'auto',
      sessionId: 'JOIN-E2E',
    });
    const rows = fs
      .readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(before)
      .map((l) => JSON.parse(l));

    const s = rows.find((r) => r.ev === 'select');
    const o = rows.find((r) => r.ev === 'outcome');
    assert.ok(s && o, `一轮应当同时留下 select 与 outcome，实际=${JSON.stringify(rows.map((r) => r.ev))}`);
    assert.strictEqual(
      o.turnId,
      s.turnId,
      `outcome 的 turnId 必须等于本轮 select 的：${s.turnId} vs ${o.turnId}`
    );
    assert.strictEqual(typeof o.ok, 'boolean', 'outcome 必须带成功位，否则 A2 的成功率无从算起');
  });

  test('真的 route-replay 能把这两行 join 上（判据 A2/A5/A6/A9/A10 的前置）', async () => {
    const out = execFileSync(process.execPath, [REPLAY, '--file', LEDGER], {
      encoding: 'utf8',
      cwd: path.dirname(REPLAY),
    });
    const m = out.match(/可 join (\d+)/);
    assert.ok(m, `replay 输出里找不到「可 join」计数行：\n${out.slice(0, 400)}`);
    assert.ok(Number(m[1]) >= 2, `至少两轮可 join，实际 ${m[1]}\n${out.slice(0, 500)}`);
    // 单轮请求没有任何独立执行状态 ⇒ 覆盖度必须诚实地报「只有主诉」，
    // 不能因为 estCtxTokens 是拿主诉估的就冒充「有执行状态」。
    assert.match(out, /执行状态覆盖（仅可 join 轮，分母 \d+）: 有执行状态 0｜只有主诉 \d+｜字段缺席 0/);
    assert.doesNotMatch(out, /§15-2 不可判定/, '字段齐全时不该报不可判定（那是老样本的形态）');
  });
});
