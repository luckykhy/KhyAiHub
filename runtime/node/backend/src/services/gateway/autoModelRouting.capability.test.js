'use strict';

/**
 * autoModelRouting.capability.test.js — §8-⑦「能力要求必须参与筛选」的消费方。
 *
 * 单独一个文件不是洁癖：候选池 `_pool` 是**模块级**状态（带 TTL 的进程内缓存），
 * 同一文件里前面的 rank 测用过 'rankprobe' 渠道后，那些桶会留着，
 * 于是这里的「只留 claude」「全不合格时报挡」都会被别人的残留候选污染。
 * node --test 每个文件一个进程，换个文件就是换一次干净的池。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const amr = require('./autoModelRouting');
const rm = require('./routingMode');

const ENV = {
  KHY_AUTO_MODEL_HEALTH_AWARE: '1',
  KHY_ROUTING_MODES: '1',
  GATEWAY_ROUTING_MODE: 'auto',
};

function fakeGw(adapterKeys, modelPrefix) {
  return {
    _adapters: adapterKeys.map((key, i) => ({ key, enabled: true, available: true, priority: i })),
    listModels: async () => [{ model: `${modelPrefix || 'm'}` }],
  };
}

test('§8-⑦ 前置：auto 档解析得出，且能力表按预期区分「无字段 / 有字段 / 不在表里」', () => {
  const mode = rm.resolveMode('auto', { env: ENV });
  assert.ok(mode, '档位卡解析不出 auto');
  const { getCapabilityRegistry } = require('./capabilityRegistry');
  const reg = getCapabilityRegistry({ _adapters: [] });
  assert.ok((Number(reg.getCapabilities('claude').vision) || 0) >= 1, 'claude 应被记为有 vision');
  assert.equal(reg.getCapabilities('vscode').vision, undefined, 'vscode 应「已知不具备 vision」');
  assert.equal(reg.getCapabilities('my-private-endpoint'), null, '不在表里的渠道必须是 null = 未知');
});

test('§8-⑦ 已知不合格被淘汰、未知留着、全不合格才报挡（按池的累积语义排序）', async () => {
  const mode = rm.resolveMode('auto', { env: ENV });
  // ⚠ 候选池 `_pool` 是**只并集不清空**的（`refreshPool` 里 `next = { ..._pool.adapters }`，
  // 注释写明「宁可拿旧数据排序也不清池」）。所以本文件的三段必须按这个语义排：
  // 先测「全已知不合格」（此时池还空），再逐步加渠道 —— 反过来的话前面加进来的
  // 合格渠道会一直留着，「报挡」那个断言永远不可能成立。
  // （这也是本文件单独存在的理由：同文件内共享进程，池会串。）

  // 阶段 1：池里只有一个「已知不具备 vision」的渠道 ⇒ 报挡、不给赢家
  const bad = fakeGw(['vscode'], 'vs-text-model');
  await amr.refreshPool(bad, ENV);
  const r1 = amr.rank(bad, 'conversation', { mode, capabilityRequired: 'vision' }, ENV);
  assert.equal(r1.capability.dropped, 1, `应淘汰 1 个已知不合格的：${JSON.stringify(r1.capability)}`);
  assert.equal(r1.capability.blocked, 'vision', '全已知不合格必须报挡');
  assert.equal(r1.winner, null, '被挡时不许给出一个不识图的赢家');
  assert.equal(r1.ranked.length, 0);

  // 阶段 2：加一个能力表里查不到的自建渠道 ⇒ 未知留着、不再报挡
  const withUnknown = fakeGw(['my-private-endpoint'], 'private-model');
  await amr.refreshPool(withUnknown, ENV);
  const r2 = amr.rank(withUnknown, 'conversation', { mode, capabilityRequired: 'vision' }, ENV);
  assert.equal(r2.capability.blocked, null, '仅因表里没这个渠道就报挡 = 把仪器无知当产品结论');
  assert.ok(r2.capability.unknown >= 1, `未知必须被计数：${JSON.stringify(r2.capability)}`);
  assert.ok(r2.winner, '未知渠道仍可被选');
  assert.ok(
    !r2.ranked.some((x) => x.adapter === 'vscode'),
    '已知不具备能力的渠道不该留在候选里（哪怕它上一轮还在池中）'
  );

  // 阶段 3：再加一个真有 vision 的渠道 ⇒ 合格者留下，vscode 仍被淘汰
  const withGood = fakeGw(['claude'], 'claude-vision-model');
  await amr.refreshPool(withGood, ENV);
  const r3 = amr.rank(withGood, 'conversation', { mode, capabilityRequired: 'vision' }, ENV);
  assert.equal(r3.capability.blocked, null);
  // 不断言头名是谁 —— 两个候选同为 T2 时谁在前由原始下标决定，与本判据无关；
  // 能力筛选要保证的是「合格的不会被剔除」。
  assert.ok(
    r3.ranked.some((x) => x.adapter === 'claude'),
    `合格渠道必须留在候选里：${JSON.stringify(r3.ranked.map((x) => x.adapter))}`
  );
  assert.ok(r3.winner, '有合格候选时必须有赢家');
  assert.ok(
    !r3.ranked.some((x) => x.adapter === 'vscode'),
    '淘汰必须在最终列表上真的生效，而不是只写进 capability.dropped'
  );

  // 没有能力要求 ⇒ 完全不参与，也不产出读数（不新增任何淘汰面）
  const r4 = amr.rank(withGood, 'conversation', { mode }, ENV);
  assert.equal(r4.capability, null, '无 capabilityRequired 时不该产出能力读数');
  assert.ok(
    r4.ranked.some((x) => x.adapter === 'vscode'),
    '不要求能力时已知无 vision 的渠道不该被剔除 —— 筛选只能由要求触发'
  );
});

test('§8-⑦ 能力读数必须进样本行（白名单第三次踩坑的预防）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-cap-'));
  const file = path.join(dir, 'auto-route.jsonl');
  const t = amr.beginTurn({ sessionId: 'CAP' });
  amr.observeSelection(
    {
      turnId: t,
      mode: 'auto',
      capability: { required: 'vision', blocked: 'vision', dropped: 2, unknown: 1, kept: 0 },
      legacy: { adapter: 'api', model: 'a' },
      ranked: [],
      skipped: [],
    },
    { KHY_AUTO_MODEL_OBSERVE_FILE: file, KHY_AUTO_MODEL_OBSERVE: '1' }
  );
  const row = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)[0]);
  assert.equal(row.capability.blocked, 'vision', 'capability 没落盘 ⇒ 报表永远看不见能力挡过几次');
  assert.equal(row.capability.dropped, 2);
  assert.equal(row.capability.unknown, 1, '「多少是仪器不知道」必须与「淘汰几个」同时可见');
});
