'use strict';
// 契约(轮二十六):`gateway status` 探测前的两个 await(switch-center 同步 +
// 网关初始化)实测静默 ~40s——用户无法区分「在推进」与「卡死」。每个 await 之前
// 必须打「步骤 n/3」(Rule 2/2.6),探测表头标注 3/3,--json 路径零步骤行。
// 接缝:aiGateway 经 require.cache 注入 fake(异步边界可观测),printInfo/
// console.log 打桩收集事件序列;表头之后的深渲染路径与排序断言无关,吞错。
// 注意:本文件必须跑在 node --test 下——jest 用自己的模块注册表，
// require.cache 注入对其无效(实测会拉起真网关探测，89s + 真外呼)。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// require.cache 的键是含 .js 的完整路径——漏扩展名会让注入与删除全部落空
// (真实教训:第一版正是因此拉起了真网关探测,单测 50s+)。
const LEAF_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'cli', 'handlers', 'gatewayStatusView.js');
const FORMATTERS_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'cli', 'formatters.js');
const GATEWAY_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'services', 'gateway', 'aiGateway.js');


// node --test 下 chalk 因非 TTY 自动禁色，无需剥 ANSI。
function freshLeafWithFakes(events, opts) {
  const initialized = !!(opts && opts.initialized);
  delete require.cache[LEAF_PATH];
  delete require.cache[GATEWAY_PATH];
  const formatters = require(FORMATTERS_PATH);
  const origPrintInfo = formatters.printInfo;
  formatters.printInfo = (...a) => {
    events.push('info:' + a.map(String).join(' '));
  };
  require.cache[GATEWAY_PATH] = {
    id: GATEWAY_PATH,
    filename: GATEWAY_PATH,
    loaded: true,
    exports: {
      isInitialized: () => initialized,
      init: async () => { events.push('init-started'); },
      getStatus: () => [],
      testAdapter: async () => null,
      refreshAdapters: async () => {},
      getDefaultRouteRecommendation: () => null,
    },
  };
  const leaf = require(LEAF_PATH);
  // 只需装配「探测前路径」会调到的 deps；表头之后的深路径抛错由 run() 吞掉。
  leaf.setGatewayStatusViewDeps({
    _parseProviderFilterFromOptions: () => [],
    maybeAutoSyncSwitchCenterForGateway: async () => {
      events.push('autosync-started');
      return null;
    },
  });
  const origLog = console.log;
  console.log = (...a) => {
    const s = a.map(String).join(' ');
    if (s.includes('步骤') || s.includes('并行探测')) events.push('log:' + s);
  };
  return async function run(options) {
    try {
      await leaf.handleGatewayStatus(options);
    } catch {
      /* 深渲染路径与探测前排序断言无关 */
    } finally {
      console.log = origLog;
      formatters.printInfo = origPrintInfo;
    }
  };
}

const idx = (events, needle) => events.findIndex((e) => e.includes(needle));

test('步骤 1/3 打印于 autosync await 之前，步骤 2/3 打印于 init 之前', async () => {
  const events = [];
  const run = freshLeafWithFakes(events);
  await run({});
  assert.ok(idx(events, '步骤 1/3') >= 0, 'events: ' + JSON.stringify(events));
  assert.ok(idx(events, '步骤 1/3') < idx(events, 'autosync-started'));
  assert.ok(idx(events, 'autosync-started') < idx(events, '步骤 2/3'));
  assert.ok(idx(events, '步骤 2/3') < idx(events, 'init-started'));
});

test('探测表头标注 步骤 3/3 且晚于 init', async () => {
  const events = [];
  const run = freshLeafWithFakes(events);
  await run({});
  assert.ok(idx(events, '步骤 3/3') > idx(events, 'init-started'), 'events: ' + JSON.stringify(events));
});

test('网关已初始化时不打步骤 2/3（跳过即不说）', async () => {
  const events = [];
  const run = freshLeafWithFakes(events, { initialized: true });
  await run({});
  assert.ok(idx(events, '步骤 1/3') >= 0);
  assert.strictEqual(idx(events, '步骤 2/3'), -1);
  assert.strictEqual(idx(events, 'init-started'), -1);
});

test('--json 路径零步骤行（机器输出不加噪声）', async () => {
  const events = [];
  const run = freshLeafWithFakes(events);
  await run({ json: true });
  assert.deepStrictEqual(events.filter((e) => e.includes('步骤')), []);
});
