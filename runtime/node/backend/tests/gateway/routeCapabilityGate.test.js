'use strict';

/**
 * routeCapabilityGate.test.js — §8-⑦：带图请求绝不会被改道给不识图的候选。
 *
 * 单独一个文件不是排版：候选池 `_pool` 只并集不清空（`refreshPool` 里
 * `next = { ..._pool.adapters }`，注释写明「宁可拿旧数据排序也不清池」）。
 * 回退矩阵那份文件里前面的用例已经把未知渠道 'pool' 塞进池中了，
 * 那份残留会把这里的「全已知不合格 ⇒ 报挡」洗成「有未知渠道留着 ⇒ 不报挡」。
 * node --test 每文件一个进程 ⇒ 这里拿到的是空池。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const h = require('./_ocrGatewayHarness');
const gw = require(BE + '/src/services/gateway/aiGateway');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const autoRouting = require(BE + '/src/services/gateway/autoModelRouting');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-capgate-'));
const LEDGER = path.join(dir, 'auto-route.jsonl');
fs.writeFileSync(LEDGER, '', 'utf8');

const env = h.envSandbox([
  'KHY_ROUTING_MODES',
  'KHY_ROUTE_APPLY',
  'KHY_ROUTE_APPLY_STAGE',
  'KHY_AUTO_MODEL_HEALTH_AWARE',
  'KHY_AUTO_MODEL_OBSERVE',
  'KHY_AUTO_MODEL_OBSERVE_FILE',
  'GATEWAY_ROUTING_MODE',
  'GATEWAY_PREFERRED_ADAPTER',
  'GATEWAY_PREFERRED_MODEL',
  'KHY_TOOL_CAP_PROBE',
]);

const IMGS = [{ base64: 'ZmFrZQ==', mimeType: 'image/png' }];

describe('§8-⑦ 能力门槛：不识图的候选不得被推给带图请求', () => {
  before(() => {
    env.save();
    env.set({
      KHY_AUTO_MODEL_OBSERVE_FILE: LEDGER,
      KHY_AUTO_MODEL_OBSERVE: '1',
      KHY_AUTO_MODEL_HEALTH_AWARE: '1',
      KHY_ROUTING_MODES: '1',
      GATEWAY_ROUTING_MODE: 'auto',
      GATEWAY_PREFERRED_ADAPTER: 'auto',
      GATEWAY_PREFERRED_MODEL: '',
      KHY_TOOL_CAP_PROBE: 'off',
      // 故意开到 S3：这条判据要验的正是「即使允许改道也不许跨能力改道」。
      KHY_ROUTE_APPLY: '1',
      KHY_ROUTE_APPLY_STAGE: 'S3',
    });
    // OCR 依赖打桩：本用例不想在测试里 spawn tesseract。
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => [],
      collectProviderSiblingModels: () => [],
    });
  });

  after(() => env.restore());

  test('池里只有「已知无 vision」的渠道 ⇒ 报挡、点名、且 apply 开着也不改道', async () => {
    const rec = h.makeRecordingAdapter({ content: '⑦ 已作答' });
    // 'vscode' 在能力表里有条目但没有 vision 字段 = 已知不具备；
    // 这与「表里查不到这个渠道」（未知 ⇒ 必须留着）是两件事，见 autoModelRouting.capability.test.js。
    h.wireSingle(rec, { key: 'vscode', activeModel: 'vscode-text-model' });
    gw.listModels = async () => [{ model: 'zzz-sonnet-4' }];
    await autoRouting.refreshPool(gw);

    const statuses = [];
    const res = await gw.generate(`能力门槛探针 ${process.pid}-${Date.now()}`, {
      adapter: 'auto',
      model: 'auto',
      sessionId: 'CAP7',
      images: IMGS,
      onChunk: (c) => {
        if (c && c.type === 'status' && c.text) statuses.push(String(c.text));
      },
    });

    const rows = fs
      .readFileSync(LEDGER, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const sel = rows.filter((r) => r.ev === 'select').pop();
    assert.ok(sel, '应留下 select 样本；没有就说明根本没走到观测点');
    assert.ok(
      sel.demand && sel.demand.capabilityRequired === 'vision',
      `带图请求必须要求 vision，实际 ${JSON.stringify(sel.demand && sel.demand.capabilityRequired)}`
    );
    assert.ok(sel.capability, `capability 读数必须进样本行（键：${JSON.stringify(Object.keys(sel))}）`);
    assert.equal(sel.capability.blocked, 'vision', `已知无 vision 必须报挡：${JSON.stringify(sel.capability)}`);
    assert.equal(sel.capability.kept, 0, '被挡时候选应为 0');
    assert.ok(
      statuses.some((t) => /未按能力改道/.test(t) && /vision/.test(t)),
      `必须点名缺哪个能力，实际=${JSON.stringify(statuses)}`
    );
    // 改道与否的唯一外部可见处，是最终作答把 model 原样 Echo 回来（harness 的
    // makeRecordingAdapter 只在返回值里写 `model: o.model`，**handle 上没有 finalModel 字段**——
    // 上一版断言读的是这个不存在的字段，因而恒真；M17-f 把它照出来了）。
    // 请求进来时 model='auto'，所以「没改道」的可观测事实就是它一路传到适配器仍是 'auto'。
    assert.equal(
      res.model,
      'auto',
      `被挡后必须保持原 model 透传，实际 res.model=${JSON.stringify(res.model)}`
    );
    assert.equal(res.success, true, '被能力门槛挡住也要照常作答（走原通道），不是报错退出');
  });

  // 正对照：同一套 harness、同一个池，只把图去掉 ⇒ 改道必须**看得见**。
  // 没有这一行，上面「res.model 仍是 auto」就只是一句恒真断言（本文件第一版断的是
  // rec.finalModel，而这个字段在 harness 上根本不存在，恒真到 M17-f 才被发现）。
  // 这里证明 res.model 这条观测通道是活的：它确实会随着改道从 'auto' 变成池内头名。
  test('正对照：去掉图后同一套装置必须发生改道（否则上一条的「没改道」不可信）', async () => {
    const rec2 = h.makeRecordingAdapter({ content: '对照组已作答' });
    h.wireSingle(rec2, { key: 'vscode', activeModel: 'vscode-text-model' });
    gw.listModels = async () => [{ model: 'zzz-sonnet-4' }];
    await autoRouting.refreshPool(gw);

    const statuses2 = [];
    const res2 = await gw.generate(`对照探针 ${process.pid}-${Date.now()}`, {
      adapter: 'auto',
      model: 'auto',
      sessionId: 'CAP7-CTRL',
      onChunk: (c) => {
        if (c && c.type === 'status' && c.text) statuses2.push(String(c.text));
      },
    });

    assert.equal(
      res2.model,
      'zzz-sonnet-4',
      `无图时 apply 必须把池内头名改道出去，实际 res.model=${JSON.stringify(res2.model)}｜st=${JSON.stringify(statuses2)}`
    );
    assert.ok(
      !statuses2.some((t) => /未按能力改道/.test(t)),
      `无图请求不该触发能力门槛，实际=${JSON.stringify(statuses2)}`
    );
  });
});
