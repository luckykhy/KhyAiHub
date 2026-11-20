'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveModelRoute } = require('../../src/services/gateway/modelRouter');

const ROUTING_JSON = path.join(__dirname, '..', '..', 'config', 'models', 'routing.json');
const ROUTER_JS = path.join(__dirname, '..', '..', 'src', 'services', 'gateway', 'modelRouter.js');

// 迁移前硬编码表（modelRouter.js:239-245）——逐条等价的对照基准。
const PRE_MIGRATION = {
  'sensenova-6.7-flash-lite': { adapter: 'api', model: 'sensenova:sensenova-6.7-flash-lite', strict: true },
  'sensenova-u1-fast': { adapter: 'api', model: 'sensenova:sensenova-u1-fast', strict: true },
  'deepseek-v4-flash': { adapter: 'api', model: 'sensenova:deepseek-v4-flash', strict: true },
  'agnes-2.5-flash': { adapter: 'api', model: 'agnes:agnes-2.5-flash', strict: false },
  'agnes-2.0-flash': { adapter: 'api', model: 'agnes:agnes-2.0-flash', strict: true },
};

test('builtin route map lives in config/models/routing.json', () => {
  const cfg = JSON.parse(fs.readFileSync(ROUTING_JSON, 'utf8'));
  assert.deepStrictEqual(Object.keys(cfg.builtinRouteMap).sort(), Object.keys(PRE_MIGRATION).sort());
});

test('no model names remain hardcoded in modelRouter.js', () => {
  const src = fs.readFileSync(ROUTER_JS, 'utf8');
  for (const name of Object.keys(PRE_MIGRATION)) {
    assert.ok(!src.includes(name), `hardcoded model still in source: ${name}`);
  }
});

test('all five builtin routes are byte-equivalent to the pre-migration table', () => {
  for (const [model, expected] of Object.entries(PRE_MIGRATION)) {
    const route = resolveModelRoute({ model, defaultPreferredAdapter: 'localLLM' });
    assert.strictEqual(route.adapterKey, expected.adapter, model);
    assert.strictEqual(route.modelId, expected.model, model);
    assert.strictEqual(route.strictPreferred, expected.strict, model);
    assert.strictEqual(route.metadata.source, 'route-map', model);
    assert.strictEqual(route.metadata.matchedRule, model, model);
  }
});

test('user routeMap still overrides the builtin config entry', () => {
  const route = resolveModelRoute({
    model: 'sensenova-u1-fast',
    routeMap: { 'sensenova-u1-fast': 'kiro/claude-sonnet-4' },
    defaultPreferredAdapter: 'localLLM',
  });
  assert.strictEqual(route.adapterKey, 'kiro');
  assert.strictEqual(route.modelId, 'claude-sonnet-4');
  assert.strictEqual(route.metadata.source, 'route-map');
});
