'use strict';

/**
 * stepneoCloud/config.test.js — co-located suite for env resolution.
 *
 * IO: none except the one secret-file case, which uses a real temp file because
 * the point of that path is the filesystem behaviour itself.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveStepneoConfig, readAppSecret, GATE_ENV } = require('./config');

// ── defaults ─────────────────────────────────────────────────────────────────

test('an empty env resolves to the production gateway and the default cap', () => {
  const c = resolveStepneoConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.appId, 'ai-engine-prod');
  assert.equal(c.baseUrl, 'https://biz-gw.stepaos.com/stepfun-proxy');
  assert.equal(c.includeUi, true);
  // 助手协同（Amoo 反代）工具组默认不广告：新克隆的 khyos 不带 Amoo。
  assert.equal(c.includeAssistantRelay, false);
  assert.ok(c.maxRounds > 0);
  assert.equal(c.appSecret, '');
  assert.equal(c.token, '');
});

test('env overrides win, including the test-twin gateway', () => {
  // The test twin exists so a signature mistake can be diagnosed against a
  // gateway that is not the production one.
  const c = resolveStepneoConfig({
    STEPNEO_BASE_URL: 'https://biz-gw-in.zyql.com/stepfun-proxy',
    STEPNEO_APP_ID: 'ai-engine-test',
    STEPNEO_MAX_ROUNDS: '7',
    STEPNEO_INCLUDE_UI: '0',
  });
  assert.equal(c.baseUrl, 'https://biz-gw-in.zyql.com/stepfun-proxy');
  assert.equal(c.appId, 'ai-engine-test');
  assert.equal(c.maxRounds, 7);
  assert.equal(c.includeUi, false);
});

test('the assistant relay group is opt-in, off by default', () => {
  // 默认关：一份新克隆的 khyos 不把 amoo 工具交给模型。显式 opt-in 才开。
  assert.equal(resolveStepneoConfig({}).includeAssistantRelay, false);
  assert.equal(resolveStepneoConfig({ STEPNEO_INCLUDE_ASSISTANT_RELAY: '1' }).includeAssistantRelay, true);
  assert.equal(resolveStepneoConfig({ STEPNEO_INCLUDE_ASSISTANT_RELAY: '0' }).includeAssistantRelay, false);
});

test('a nonsense STEPNEO_MAX_ROUNDS falls back instead of becoming NaN', () => {
  // NaN would silently disable the cap, and a model that never stops calling
  // tools would then run until the process died.
  const c = resolveStepneoConfig({ STEPNEO_MAX_ROUNDS: 'abc' });
  assert.ok(Number.isFinite(c.maxRounds));
  assert.ok(c.maxRounds > 0);
  assert.equal(resolveStepneoConfig({ STEPNEO_MAX_ROUNDS: '0' }).maxRounds > 0, true);
  assert.equal(resolveStepneoConfig({ STEPNEO_MAX_ROUNDS: '-5' }).maxRounds > 0, true);
});

test('the gate accepts the usual falsy spellings and defaults open', () => {
  assert.equal(resolveStepneoConfig({}).enabled, true);
  for (const v of ['0', 'false', 'off', 'no', 'disabled', 'FALSE', ' Off ']) {
    assert.equal(resolveStepneoConfig({ [GATE_ENV]: v }).enabled, false, `${v} 应关`);
  }
  for (const v of ['1', 'true', 'on', 'yes']) {
    assert.equal(resolveStepneoConfig({ [GATE_ENV]: v }).enabled, true, `${v} 应开`);
  }
});

test('adb and serial come from the phone bridge config, not a second env var', () => {
  // A second serial env var would be a second answer to "which phone", and the
  // token has to come off the same device the tools act on.
  const c = resolveStepneoConfig({});
  assert.equal(typeof c.adbExecutable, 'string');
  assert.ok(c.adbExecutable.length > 0);
  assert.equal(typeof c.serial, 'string');
  assert.ok(c.localPort > 0);
});

// ── the secret, which is the R2 surface ──────────────────────────────────────

test('an inline secret is returned with its source named', () => {
  const out = readAppSecret({ appSecret: 'sekrit' });
  assert.equal(out.ok, true);
  assert.equal(out.secret, 'sekrit');
  assert.match(out.source, /STEPNEO_APP_SECRET/);
});

test('a secret file is read and trimmed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepneo-sec-'));
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, '  file-secret\n', 'utf8');
  try {
    const out = readAppSecret({ appSecret: '', appSecretFile: file });
    assert.equal(out.ok, true);
    assert.equal(out.secret, 'file-secret');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no secret at all is refused with the env var names in the message', () => {
  // A defaulted secret would produce 401s that read as an expired token and send
  // people to renew the wrong credential.
  const out = readAppSecret({});
  assert.equal(out.ok, false);
  assert.equal(out.code, 'APP_SECRET_REQUIRED');
  assert.match(out.error, /STEPNEO_APP_SECRET/);
  assert.match(out.error, /STEPNEO_APP_SECRET_FILE/);
});

test('an unreadable or empty secret file is its own failure, not a fallback', () => {
  // Falling back to "no secret" would make a typo in the path look like a
  // missing config, which is a different fix.
  const missing = readAppSecret({ appSecretFile: path.join(os.tmpdir(), 'definitely-not-here-xyz') });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'APP_SECRET_FILE_UNREADABLE');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepneo-empty-'));
  const file = path.join(dir, 'empty');
  fs.writeFileSync(file, '   \n', 'utf8');
  try {
    const out = readAppSecret({ appSecretFile: file });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'APP_SECRET_EMPTY_FILE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the inline secret wins over the file, so a stale file cannot shadow it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepneo-both-'));
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, 'from-file', 'utf8');
  try {
    const out = readAppSecret({ appSecret: 'from-env', appSecretFile: file });
    assert.equal(out.secret, 'from-env');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('whitespace around an inline secret is trimmed', () => {
  // A trailing newline from a copy-paste would change the HMAC and 401 every
  // request, with nothing in the error pointing at the cause.
  assert.equal(readAppSecret({ appSecret: '  sec \n' }).secret, 'sec');
});
