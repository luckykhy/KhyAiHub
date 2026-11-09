'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const installedFile = path.join(ROOT, 'installed.json');
const originalInstalled = fs.readFileSync(installedFile, 'utf8');
const tempDirs = [];

after(() => {
  fs.writeFileSync(installedFile, originalInstalled);
  for (const file of require.resolve.paths('../index') || []) void file;
  delete require.cache[require.resolve('../index')];
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureModule(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dsh-compat-'));
  tempDirs.push(dir);
  const entry = path.join(dir, 'fixture.mjs');
  fs.writeFileSync(entry, source);
  return entry;
}

function loadCompat(entry, toolName) {
  fs.writeFileSync(installedFile, JSON.stringify({ plugins: [{
    id: 'fixture', entry, tools: [{
      name: toolName,
      upstreamName: toolName,
      description: 'fixture',
      category: 'custom', risk: 'high',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    }],
  }] }));
  delete require.cache[require.resolve('../index')];
  return require('../index').tools[0];
}

test('exposes a valid object JSON Schema from the imported declaration', () => {
  const tool = loadCompat(fixtureModule('export const tools = [];'), 'SchemaFixture');
  assert.equal(tool.inputSchema.type, 'object');
  assert.equal(typeof tool.inputSchema.properties, 'object');
  assert.deepEqual(tool.inputSchema.required, ['value']);
});

test('passes the khy abort signal to the upstream dsh exec handle', async () => {
  const entry = fixtureModule("export const tools = [{ name: 'SignalFixture', async execute(args, exec) { return { same: exec.signal === args.signal, valid: exec.signal instanceof AbortSignal }; } }];");
  const tool = loadCompat(entry, 'SignalFixture');
  const controller = new AbortController();
  const result = await tool.execute({ value: 'x', signal: controller.signal }, { signal: controller.signal });
  assert.deepEqual(result, { same: true, valid: true });
});

test('synthesizes a valid AbortSignal when khy has no signal', async () => {
  const entry = fixtureModule("export const tools = [{ name: 'DefaultSignalFixture', async execute(args, exec) { return exec.signal instanceof AbortSignal; } }];");
  const tool = loadCompat(entry, 'DefaultSignalFixture');
  assert.equal(await tool.execute({ value: 'x' }, {}), true);
});

test('rejects unsupported services and direct model access', () => {
  const { scanSource } = require('../lib/importPlugin');
  assert.throws(() => scanSource(['export function apply(ctx) {}'], { inject: ['core/llm'] }), /未支持/);
  assert.throws(() => scanSource(['const key = process.env.DEMO_API_KEY'], { inject: ['tools'] }), /模型密钥/);
  assert.throws(() => scanSource(['fetch("https://example.invalid")'], { inject: ['tools'] }), /直接网络访问/);
});

test('reads host inject from the DSH bundle patch, not only package.json', () => {
  const { declaredInject, scanSource } = require('../lib/importPlugin');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dsh-patch-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), [
    '- id: demo',
    '  name: demo',
    '  inject: [systemPrompt, tools]',
    '- id: other',
    '  inject:',
    '    - logger',
  ].join('\n'));
  const pkg = { dsh: { bundle: { patch: './cordis.patch.yml' } } };
  const inject = declaredInject(pkg, dir);
  assert.deepEqual([...inject.host].sort(), ['logger', 'systemPrompt', 'tools']);
  assert.throws(() => scanSource(['export function apply(ctx) {}'], pkg, { root: dir }), /systemPrompt/);
});

test('network access needs an explicit --allow-network approval and is recorded', () => {
  const { scanSource } = require('../lib/importPlugin');
  const pkg = { inject: ['tools'] };
  assert.throws(() => scanSource(['fetch("https://example.invalid")'], pkg), /--allow-network/);
  const scan = scanSource(['fetch("https://example.invalid")'], pkg, { allowNetwork: true });
  assert.equal(scan.network, true);
});

test('model-key access is never waived by --allow-network', () => {
  const { scanSource } = require('../lib/importPlugin');
  assert.throws(
    () => scanSource(['const key = process.env.DEMO_API_KEY'], { inject: ['tools'] }, { allowNetwork: true }),
    /模型密钥/,
  );
});
