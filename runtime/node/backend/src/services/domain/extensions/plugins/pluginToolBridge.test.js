'use strict';

/**
 * pluginToolBridge.test.js — 钉死「用户已装插件 → plugin__slug__op 工具面」的适配层：
 * 名称解析、逐用户装配、authConfig 兜底、invoke 结果的三形态映射。
 *
 * @khy/shared/plugins/openapiTools 用真件（tool 名格式 `plugin__<slug>__<op>` 与
 * input_schema 键名是对外契约，stub 就钉不住了）。@khy/shared/models 与 ./pluginInvoker
 * 必须 require.cache 桩：前者背后是 Sequelize/DB（本层全部语义都不需要库），后者是
 * 真 HTTP 出口。stub models 同时把「桥只经 findOne/findAll 两个查询面」固化下来。
 *
 * 实测钉死的怪异行为（非理想行为）：
 *   · userId 判据是 `!= null`（非 truthy）—— userId 0 是合法用户上下文。
 *   · 无 error 键 = 成功形态；非 ok 时 error 文案固定为 `Plugin returned HTTP <status>`，
 *     不回传响应体里的 error 信息。
 *   · invoke 抛错无 statusCode 时兜底 status 500，但 _bindRequest 等内部抛都带码。
 *   · 装载失败（DB 抛错）文案含原始 err.message —— 错误信息会外泄给 agent。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const INV_PATH = require.resolve('./pluginInvoker');
const MODELS_PATH = require.resolve('@khy/shared/models');
const SAVED = [
  [INV_PATH, require.cache[INV_PATH]],
  [MODELS_PATH, require.cache[MODELS_PATH]],
];

// ── 假 invoker ────────────────────────────────────────────────────────
let invokeBehavior = async () => ({ ok: true, status: 200, data: {}, contentType: '' });
const invokeCalls = [];
require.cache[INV_PATH] = {
  id: INV_PATH,
  filename: INV_PATH,
  loaded: true,
  exports: {
    invoke: async (opts) => {
      invokeCalls.push(opts);
      return invokeBehavior(opts);
    },
  },
};

// ── 假 models（Sequelize 形状的最小面）────────────────────────────────
let db = { plugins: [], installs: [], boomFindOne: null };
const queries = [];
require.cache[MODELS_PATH] = {
  id: MODELS_PATH,
  filename: MODELS_PATH,
  loaded: true,
  exports: {
    MarketplacePlugin: {
      findOne: async ({ where }) => {
        queries.push(['MP.findOne', where]);
        if (db.boomFindOne) throw new Error(db.boomFindOne);
        return db.plugins.find((p) => p.slug === where.slug) || null;
      },
      findAll: async ({ where }) => {
        queries.push(['MP.findAll', where]);
        return db.plugins.filter((p) => where.id.includes(p.id));
      },
    },
    UserInstalledPlugin: {
      findOne: async ({ where }) => {
        queries.push(['UIP.findOne', where]);
        return db.installs.find((i) => i.userId === where.userId && i.pluginId === where.pluginId) || null;
      },
      findAll: async ({ where }) => {
        queries.push(['UIP.findAll', where]);
        return db.installs.filter((i) => i.userId === where.userId && i.enabled === true);
      },
    },
  },
};

const B = require('./pluginToolBridge');

after(() => {
  for (const [p, v] of SAVED) {
    if (v) require.cache[p] = v;
    else delete require.cache[p];
  }
});

const OPENAPI = {
  openapi: '3.0.0',
  servers: [{ url: 'https://api.demo.test' }],
  paths: {
    '/ping': {
      get: { operationId: 'ping', parameters: [], responses: { '200': { description: 'ok' } } },
    },
  },
};

function seed(overrides) {
  db = Object.assign(
    {
      plugins: [{ id: 7, slug: 'demo', openapiJson: OPENAPI, manifestJson: { api: {} } }],
      installs: [{ userId: 1, pluginId: 7, enabled: true, authConfigJson: { type: 'bearer', token: 'T' } }],
      boomFindOne: null,
    },
    overrides || {}
  );
  invokeCalls.length = 0;
  queries.length = 0;
  invokeBehavior = async () => ({ ok: true, status: 200, data: { pong: true }, contentType: 'application/json' });
}

test('isPluginTool 是真 openapiTools 的原样转发', () => {
  assert.equal(B.isPluginTool('plugin__demo__ping'), true);
  assert.equal(B.isPluginTool('read'), false);
  assert.equal(B.isPluginTool('plugin__'), false); // slug/op 缺失不算
});

test('listUserPluginTools：userId 为 null 直接空表，models 一行查询都不发', async () => {
  seed();
  assert.deepEqual(await B.listUserPluginTools(null), []);
  assert.deepEqual(await B.listUserPluginTools(undefined), []);
  assert.equal(queries.length, 0);
});

test('listUserPluginTools：enabled 安装 × catalog 联表 → 带 slug 的 tool 描述符；孤儿安装跳过', async () => {
  seed({
    installs: [
      { userId: 1, pluginId: 7, enabled: true },
      { userId: 1, pluginId: 999, enabled: true }, // catalog 无此行 → 跳过
      { userId: 1, pluginId: 7, enabled: false }, // findAll(where.enabled) 不该带回它
    ],
  });
  const tools = await B.listUserPluginTools(1);
  assert.equal(tools.length, 1);
  const t = tools[0];
  assert.equal(t.name, 'plugin__demo__ping');
  assert.equal(t.slug, 'demo');
  assert.equal(t.operationId, 'ping');
  assert.equal(t.input_schema.type, 'object'); // 真 openapiTools 生成的键名是下划线形
  // 装配查询确为两次联表（installs 先、plugins 按 id 集）
  assert.deepEqual(queries.map((q) => q[0]), ['UIP.findAll', 'MP.findAll']);
});

test('_loadUserPluginBySlug：catalog 缺失/未安装/未启用都回 null；authConfigJson 缺省补 none', async () => {
  seed();
  assert.equal(await B._loadUserPluginBySlug(1, 'nosuch'), null);
  assert.equal(await B._loadUserPluginBySlug(2, 'demo'), null); // 该用户没装
  seed({ installs: [{ userId: 1, pluginId: 7, enabled: false }] });
  assert.equal(await B._loadUserPluginBySlug(1, 'demo'), null);
  seed({ installs: [{ userId: 1, pluginId: 7, enabled: true }] });
  const loaded = await B._loadUserPluginBySlug(1, 'demo');
  assert.deepEqual(loaded.authConfig, { type: 'none' });
});

test('executePluginTool：非插件名与无用户上下文各回固定文案，不触 DB', async () => {
  seed();
  assert.deepEqual(await B.executePluginTool('read', {}, { userId: 1 }), {
    success: false,
    error: 'Not a plugin tool: read',
  });
  const noUser = await B.executePluginTool('plugin__demo__ping', {}, {});
  assert.equal(noUser.success, false);
  assert.match(noUser.error, /require a user context/);
  assert.equal(queries.length, 0);
});

test('executePluginTool：userId=0 是合法上下文（!= null 判据）；user_id 蛇形回退可用', async () => {
  seed({ installs: [{ userId: 0, pluginId: 7, enabled: true }] });
  const r0 = await B.executePluginTool('plugin__demo__ping', {}, { userId: 0 });
  assert.equal(r0.success, true);
  const r1 = await B.executePluginTool('plugin__demo__ping', {}, { user_id: 0 });
  assert.equal(r1.success, true);
});

test('executePluginTool 把装载异常原文裹进 error（信息外泄是事实行为）', async () => {
  seed({ boomFindOne: 'connect ECONNREFUSED' });
  const r = await B.executePluginTool('plugin__demo__ping', {}, { userId: 1 });
  assert.equal(r.success, false);
  assert.equal(r.error, 'Failed to load plugin "demo": connect ECONNREFUSED');
});

test('executePluginTool 成功形态无 error 键；invoke 入参逐字段对得上桥的装配', async () => {
  seed();
  const r = await B.executePluginTool('plugin__demo__ping', { x: 1 }, { userId: 1 });
  assert.deepEqual(r, { success: true, status: 200, data: { pong: true } });
  assert.equal(invokeCalls.length, 1);
  const opts = invokeCalls[0];
  assert.equal(opts.openapi, OPENAPI);
  assert.deepEqual(opts.manifest, { api: {} });
  assert.equal(opts.operationId, 'ping');
  assert.deepEqual(opts.args, { x: 1 });
  assert.deepEqual(opts.authConfig, { type: 'bearer', token: 'T' });
});

test('invoke 回非 ok → success:false 且 error 固定为 Plugin returned HTTP <status>（不回传响应体）', async () => {
  seed();
  invokeBehavior = async () => ({ ok: false, status: 502, data: { upstream: '秘密细节' }, contentType: '' });
  const r = await B.executePluginTool('plugin__demo__ping', {}, { userId: 1 });
  assert.deepEqual(r, { success: false, status: 502, data: { upstream: '秘密细节' }, error: 'Plugin returned HTTP 502' });
});

test('invoke 抛错：带 statusCode 原样透传，不带则兜底 500', async () => {
  seed();
  invokeBehavior = async () => {
    const e = new Error('no such op');
    e.statusCode = 404;
    throw e;
  };
  assert.deepEqual(await B.executePluginTool('plugin__demo__ghost', {}, { userId: 1 }), {
    success: false,
    status: 404,
    error: 'no such op',
  });
  invokeBehavior = async () => {
    throw new Error('boom');
  };
  assert.deepEqual(await B.executePluginTool('plugin__demo__ping', {}, { userId: 1 }), {
    success: false,
    status: 500,
    error: 'boom',
  });
});
