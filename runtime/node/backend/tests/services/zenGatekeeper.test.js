'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const {
  isZenEndpoint,
  isFreeZenModelId,
  filterFreeZenModels,
  buildZenHeaders,
  requiresStream,
  getSessionId,
  newSessionId,
  newRequestId,
  applyZenBodyGate,
  ZEN_GATE_TOOLS,
  _reset,
  ZEN_BASE_URL,
} = require('../../src/services/zenGatekeeper');

const retired = require('../../src/services/zenRetiredModels');

let _sandbox;

beforeEach(() => {
  delete process.env.OPENCODE_CLIENT;
  delete process.env.KHY_ZEN_SESSION_ID;
  delete process.env.KHY_OPENCODE_USER_AGENT;
  // 隔离废弃账本：本组断言依赖账本为空，否则会读到开发机真实数据文件里的条目。
  _sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-gate-'));
  process.env.KHY_ZEN_RETIRED_FILE = path.join(_sandbox, 'zen_retired_models.json');
  _reset();
  retired._reset();
});

afterEach(() => {
  delete process.env.KHY_ZEN_RETIRED_FILE;
  retired._reset();
  try {
    fs.rmSync(_sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('isZenEndpoint: matches SSOT, tolerates /v1 and trailing slash', () => {
  assert.strictEqual(isZenEndpoint(ZEN_BASE_URL), true);
  assert.strictEqual(isZenEndpoint(`${ZEN_BASE_URL}/`), true);
  assert.strictEqual(isZenEndpoint(ZEN_BASE_URL.replace(/\/v1$/, '')), true);
  assert.strictEqual(isZenEndpoint('https://api.openai.com/v1'), false);
  assert.strictEqual(isZenEndpoint(''), false);
  assert.strictEqual(isZenEndpoint('not-a-url'), false);
});

test('requiresStream only for Zen endpoints', () => {
  assert.strictEqual(requiresStream(ZEN_BASE_URL), true);
  assert.strictEqual(requiresStream('https://api.openai.com'), false);
});

test('isFreeZenModelId: only *-free suffix is free-tier usable', () => {
  assert.strictEqual(isFreeZenModelId('mimo-v2.6-flash-free'), true);
  assert.strictEqual(isFreeZenModelId('claude-fable-5'), false);
  assert.strictEqual(isFreeZenModelId('gpt-6-astra'), false);
  assert.strictEqual(isFreeZenModelId(''), false);
  assert.strictEqual(isFreeZenModelId(null), false);
});

test('filterFreeZenModels: drops paid catalog names, keeps free, never throws', () => {
  const kept = filterFreeZenModels([
    'mimo-v2.6-flash-free',
    'claude-fable-5',
    { id: 'jev-1.13-free' },
    { id: 'gemini-3-flash' },
    null,
    'gpt-6-astra',
  ]);
  assert.deepStrictEqual(kept, [
    'mimo-v2.6-flash-free',
    { id: 'jev-1.13-free' },
  ]);
  assert.deepStrictEqual(filterFreeZenModels(null), []);
  assert.deepStrictEqual(filterFreeZenModels(undefined), []);
  assert.deepStrictEqual(filterFreeZenModels('not-array'), []);
});

test('filterFreeZenModels: drops retired ids the upstream catalog still lists', () => {
  // 实测 2026-10-09：/v1/models 仍返回 exo-free，但调用返回 410 ModelDeprecated。
  // 只判 -free 后缀会把它送到选型器，故废弃判定必须在同一出口生效。
  const kept = filterFreeZenModels([
    'exo-free',
    'mimo-v2.5-free',
    { id: 'deepseek-v4-flash-free' },
    { id: 'muse-spark-1.3-contributor-free' },
    'space-bunny-free',
  ]);
  assert.deepStrictEqual(kept, ['space-bunny-free']);
});

test('filterFreeZenModels: suffix rule alone would still admit exo-free', () => {
  // 守住本改动的存在意义：若哪天有人放宽后缀判据，废弃过滤必须仍然拦得住 exo-free。
  assert.strictEqual(isFreeZenModelId('exo-free'), true);
  assert.strictEqual(filterFreeZenModels(['exo-free']).length, 0);
});

test('buildZenHeaders: opencode fingerprint + public bearer', () => {
  const h = buildZenHeaders();
  assert.match(h['User-Agent'], /^opencode\//);
  assert.strictEqual(h['x-opencode-client'], 'cli');
  assert.match(h['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(h['x-opencode-request'], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.strictEqual(h['x-session-id'], h['x-opencode-session']);
  assert.strictEqual(h.Authorization, 'Bearer public');
  assert.ok(h['x-opencode-project']);
});

test('session id is process-stable; request id is fresh each call', () => {
  const a = getSessionId();
  const b = getSessionId();
  assert.strictEqual(a, b);
  const r1 = buildZenHeaders()['x-opencode-request'];
  const r2 = buildZenHeaders()['x-opencode-request'];
  assert.notStrictEqual(r1, r2);
});

test('OPENCODE_CLIENT env overrides client header', () => {
  process.env.OPENCODE_CLIENT = 'desktop';
  assert.strictEqual(buildZenHeaders()['x-opencode-client'], 'desktop');
});

test('id generators: OpenCode format (12 hex ts + 14 base62), never empty', () => {
  // Free-tier gate requires leading 12 hex chars (Identifier.create in id/id.ts).
  assert.match(newSessionId(), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(newRequestId(), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.notStrictEqual(newSessionId(), newSessionId());
});

test('custom bearer override for non-default key', () => {
  const h = buildZenHeaders({ bearer: '' });
  assert.strictEqual(h.Authorization, 'Bearer ');
});

test('ZEN_GATE_TOOLS exposes both bash and read (case-sensitive body gate)', () => {
  const names = ZEN_GATE_TOOLS.map((t) => t.function.name);
  assert.deepStrictEqual(names, ['bash', 'read']);
});

test('applyZenBodyGate: forces stream + injects bash/read + tool_choice none when no caller tools', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const out = applyZenBodyGate(body);
  assert.strictEqual(out.stream, true);
  const names = out.tools.map((t) => t.function.name);
  assert.ok(names.includes('bash'));
  assert.ok(names.includes('read'));
  assert.strictEqual(out.tool_choice, 'none');
});

test('applyZenBodyGate: preserves caller tools and does not force tool_choice', () => {
  const body = {
    model: 'm',
    messages: [],
    tools: [
      { type: 'function', function: { name: 'webfetch', description: 'x', parameters: { type: 'object', properties: {} } } },
    ],
    tool_choice: 'auto',
  };
  applyZenBodyGate(body, { hadCallerTools: true });
  const names = body.tools.map((t) => t.function.name);
  assert.ok(names.includes('webfetch'));
  assert.ok(names.includes('bash'));
  assert.ok(names.includes('read'));
  assert.strictEqual(body.tool_choice, 'auto');
  assert.strictEqual(body.stream, true);
});

test('applyZenBodyGate: idempotent when bash/read already present', () => {
  const body = {
    model: 'm',
    messages: [],
    tools: ZEN_GATE_TOOLS.map((t) => ({ ...t })),
    tool_choice: 'none',
  };
  applyZenBodyGate(body);
  assert.strictEqual(body.tools.length, 2);
  assert.strictEqual(body.tool_choice, 'none');
});

test('applyZenBodyGate: never throws on bad input', () => {
  assert.strictEqual(applyZenBodyGate(null), null);
  assert.strictEqual(applyZenBodyGate('x'), 'x');
  assert.doesNotThrow(() => applyZenBodyGate({}));
});
