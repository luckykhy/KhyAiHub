'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const retired = require('../../src/services/zenRetiredModels');

let _sandbox;

beforeEach(() => {
  _sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-retired-'));
  process.env.KHY_ZEN_RETIRED_FILE = path.join(_sandbox, 'zen_retired_models.json');
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

test('static list retires the ids measured dead on 2026-10-09', () => {
  assert.strictEqual(retired.isRetired('exo-free'), true);
  assert.strictEqual(retired.isRetired('mimo-v2.5-free'), true);
  assert.strictEqual(retired.isRetired('deepseek-v4-flash-free'), true);
  assert.strictEqual(retired.isRetired('muse-spark-1.2-contributor-free'), true);
  assert.strictEqual(retired.isRetired('muse-spark-1.3-contributor-free'), true);
});

test('healthy ids are not retired', () => {
  assert.strictEqual(retired.isRetired('space-bunny-free'), false);
  assert.strictEqual(retired.isRetired('big-pickle'), false);
  assert.strictEqual(retired.isRetired('mimo-v2.6-flash-free'), false);
  assert.strictEqual(retired.isRetired(''), false);
  assert.strictEqual(retired.isRetired(null), false);
});

test('recordFromUpstreamError: recognises 410 ModelDeprecated', () => {
  const hit = retired.recordFromUpstreamError(
    410,
    { error: { type: 'ModelDeprecated', message: 'Model exo-free has been deprecated.' } },
    'some-newly-dead-free'
  );
  assert.strictEqual(hit.id, 'some-newly-dead-free');
  assert.strictEqual(hit.reason, 'deprecated');
  assert.match(hit.detail, /^410 ModelDeprecated Model .* has been deprecated\.$/);
});

test('recordFromUpstreamError: recognises 401 not-supported', () => {
  const hit = retired.recordFromUpstreamError(
    401,
    { error: { type: 'ModelError', message: 'Model foo-free is not supported' } },
    'foo-free'
  );
  assert.strictEqual(hit.reason, 'unsupported');
});

test('recordFromUpstreamError: a bare 410 is NOT enough — body must say so', () => {
  // 网关侧/配额窗口的 410 与「模型下线」状态码相同。状态码只当准入，不参与定性：
  // 只凭 410 就记永久废弃，会把暂时故障焊死成模型永久消失。
  assert.strictEqual(retired.recordFromUpstreamError(410, { error: { type: 'server_error', message: 'quota window closed' } }, 'x-free'), null);
  assert.strictEqual(retired.recordFromUpstreamError(410, {}, 'x-free'), null);
  assert.strictEqual(retired.recordFromUpstreamError(410, 'not-json', 'x-free'), null);
  // 同理：401 只有明文 not supported 才算证据。
  assert.strictEqual(retired.recordFromUpstreamError(401, { error: { type: 'AuthError', message: 'Missing API key.' } }, 'x-free'), null);
});

test('recordFromUpstreamError: ignores 403/429/5xx — not proof of retirement', () => {
  const quota403 = { error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode" } };
  assert.strictEqual(retired.recordFromUpstreamError(403, quota403, 'big-pickle'), null);
  assert.strictEqual(retired.recordFromUpstreamError(429, {}, 'big-pickle'), null);
  assert.strictEqual(retired.recordFromUpstreamError(503, {}, 'big-pickle'), null);
  const region403 = { error: { type: 'RegionError', message: 'This model is not available in your country' } };
  assert.strictEqual(retired.recordFromUpstreamError(403, region403, 'big-pickle'), null);
});

test('recordFromUpstreamError: tolerates junk input without throwing', () => {
  assert.strictEqual(retired.recordFromUpstreamError(410, 'not-json', 'x-free'), null);
  assert.strictEqual(retired.recordFromUpstreamError(410, { error: { type: 'ModelDeprecated', message: 'gone' } }, ''), null);
  assert.strictEqual(retired.recordFromUpstreamError(undefined, undefined, undefined), null);
});

test('call feedback self-heals: marked id disappears from the next list', () => {
  assert.strictEqual(retired.isRetired('late-bloomer-free'), false);
  retired.markRetired('late-bloomer-free', { reason: 'deprecated', detail: '410' });
  assert.strictEqual(retired.isRetired('late-bloomer-free'), true);
});

test('transient retirement expires back into the list', () => {
  retired.markRetired('flaky-free', { reason: 'unavailable', detail: '400' });
  assert.strictEqual(retired.isRetired('flaky-free'), true);
  // Backdate past the TTL — the upstream gets a chance to overturn the verdict.
  const file = retired._file();
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state['flaky-free'].at = Date.now() - retired.TRANSIENT_TTL_MS - 1000;
  fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  retired._reset();
  assert.strictEqual(retired.isRetired('flaky-free'), false);
});

test('permanent retirement never expires', () => {
  retired.markRetired('gone-forever-free', { reason: 'deprecated' });
  const file = retired._file();
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state['gone-forever-free'].at = Date.now() - retired.TRANSIENT_TTL_MS * 10;
  fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  retired._reset();
  assert.strictEqual(retired.isRetired('gone-forever-free'), true);
});

test('pruneExpired drops only transient records', () => {
  retired.markRetired('stay-free', { reason: 'deprecated' });
  retired.markRetired('go-free', { reason: 'region' });
  const file = retired._file();
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state['go-free'].at = Date.now() - retired.TRANSIENT_TTL_MS - 1000;
  fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  retired._reset();

  // 静态名单里的 muse-spark-* 也是 region（临时）项，同样会被 prune —— 故这里只断言落盘账本的行为。

  assert.strictEqual(retired.pruneExpired(), 1);
  assert.strictEqual(retired.isRetired('stay-free'), true);
  assert.strictEqual(retired.isRetired('go-free'), false);
});

test('ledger survives a process restart (same file, cleared memory cache)', () => {
  retired.markRetired('persisted-free', { reason: 'unsupported' });
  retired._reset();
  assert.strictEqual(retired.isRetired('persisted-free'), true);
});

test('malformed ledger file degrades to empty rather than throwing', () => {
  fs.writeFileSync(retired._file(), '{{{ not json', 'utf8');
  retired._reset();
  assert.strictEqual(retired.isRetired('space-bunny-free'), false);
  assert.strictEqual(retired.isRetired('exo-free'), true); // static list still applies
});