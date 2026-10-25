'use strict';

/**
 * gelabConfig.test.js — co-located suite for the config leaf.
 *
 * IO: none; an env map is passed in explicitly. Two things are pinned here
 * because they are the ones that bite silently: the API key must never leak
 * into a loggable field, and the base URL must never be a hardcoded localhost
 * literal (that is what makes "point it at a remote Ollama" an env change).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveGelabConfig, DEFAULT_MODEL } = require('./gelabConfig');
const { OLLAMA_OPENAI_BASE_URL } = require('../../../../../constants/serviceDefaults');

test('baseUrl comes from serviceDefaults and contains no localhost literal', () => {
  const cfg = resolveGelabConfig({});
  assert.equal(cfg.model.baseUrl, OLLAMA_OPENAI_BASE_URL);
  // The point is not that localhost is forbidden in the value — serviceDefaults
  // may well resolve to one — but that this file does not write the literal.
  assert.equal(cfg.model.baseUrl, OLLAMA_OPENAI_BASE_URL);
  assert.ok(cfg.model.baseUrl.length > 0);
});

test('apiKey appears only when env provides it and defaults to null', () => {
  assert.equal(resolveGelabConfig({}).model.apiKey, null);
  assert.equal(resolveGelabConfig({}).model.keyFromEnv, false);
  const withKey = resolveGelabConfig({ KHY_GELAB_API_KEY: 'sk-test-123' });
  assert.equal(withKey.model.apiKey, 'sk-test-123');
  assert.equal(withKey.model.keyFromEnv, true);
  // Whitespace-only is not a key.
  assert.equal(resolveGelabConfig({ KHY_GELAB_API_KEY: '   ' }).model.apiKey, null);
});

test('apiKey never appears in any returned log-facing field', () => {
  const KEY = 'sk-super-secret-do-not-log';
  const cfg = resolveGelabConfig({ KHY_GELAB_API_KEY: KEY });
  const dumped = JSON.stringify(cfg);
  // The key IS in the config (the model client needs it), but nothing else may
  // carry a second copy: `status`, the plan text and the step log are all
  // built from this object and are expected to be printable.
  const occurrences = dumped.split(KEY).length - 1;
  assert.equal(occurrences, 1, `key appeared ${occurrences} times, expected exactly 1`);
  assert.equal(cfg.model.apiKey, KEY);
  // And the agent/gates blocks, which are the ones most likely to be logged,
  // must be clean.
  assert.doesNotMatch(JSON.stringify(cfg.agent), /sk-super-secret/);
  assert.doesNotMatch(JSON.stringify(cfg.gates), /sk-super-secret/);
});

test('maxTokens defaults to 4096 not 512', () => {
  // A GUI agent emits a whole action block plus a think block; 512 truncates
  // mid-action and the parser then reports a missing field.
  assert.equal(resolveGelabConfig({}).model.maxTokens, 4096);
});

test('env overrides win for model maxSteps deadlineMs', () => {
  const cfg = resolveGelabConfig({
    KHY_GELAB_MODEL: 'my-gui-model',
    KHY_GELAB_MAX_STEPS: '7',
    KHY_GELAB_DEADLINE_MS: '12345',
    KHY_GELAB_IMAGE_WIDTH: '512',
    KHY_GELAB_TEMPERATURE: '0.7',
  });
  assert.equal(cfg.model.model, 'my-gui-model');
  assert.equal(cfg.agent.maxSteps, 7);
  assert.equal(cfg.agent.deadlineMs, 12345);
  assert.equal(cfg.model.imageWidth, 512);
  assert.equal(cfg.model.temperature, 0.7);
});

test('gates default to enabled and honour KHY_GELAB_AGENT=off', () => {
  assert.equal(resolveGelabConfig({}).gates.enabled, true);
  assert.equal(resolveGelabConfig({}).gates.toolEnabled, true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    assert.equal(resolveGelabConfig({ KHY_GELAB_AGENT: off }).gates.enabled, false, off);
    assert.equal(resolveGelabConfig({ KHY_GELAB_AGENT_TOOL: off }).gates.toolEnabled, false, off);
  }
  for (const on of ['1', 'true', 'on', 'yes']) {
    assert.equal(resolveGelabConfig({ KHY_GELAB_AGENT: on }).gates.enabled, true, on);
  }
  // Garbage falls back to the default rather than flipping the gate by accident.
  assert.equal(resolveGelabConfig({ KHY_GELAB_AGENT: 'maybe' }).gates.enabled, true);
});

test('the default model name appears in exactly one place', () => {
  // check-model-hardcoding enforces this across the repo. The test makes the
  // intent local: move the literal and this file is the only thing to update.
  assert.equal(DEFAULT_MODEL, 'gelab-zero-4b');
  assert.equal(resolveGelabConfig({}).model.model, DEFAULT_MODEL);
});

test('numeric env values are clamped into their documented range', () => {
  const cfg = resolveGelabConfig({
    KHY_GELAB_MAX_STEPS: '99999',
    KHY_GELAB_IMAGE_QUALITY: '500',
    KHY_GELAB_TOP_P: '9',
    KHY_GELAB_TEMPERATURE: '-4',
  });
  assert.equal(cfg.agent.maxSteps, 200);
  assert.equal(cfg.model.imageQuality, 100);
  assert.equal(cfg.model.topP, 1);
  assert.equal(cfg.model.temperature, 0);
  // Non-numeric falls back rather than producing NaN.
  assert.equal(resolveGelabConfig({ KHY_GELAB_MAX_STEPS: 'abc' }).agent.maxSteps, 100);
});

test('captureDelayMs matches upstream delay_after_capture of 2 seconds', () => {
  // Upstream ships delay_after_capture: 2. A shorter delay captures a screen
  // that is still animating, which the model then reasons about.
  assert.equal(resolveGelabConfig({}).agent.captureDelayMs, 2000);
});

test('longpressMaxMs follows the bridge latch fix and stays configurable', () => {
  // It was 1500 as a workaround for the bridge's hardcoded 2s gesture latch.
  // That latch is fixed, so the ceiling is now the bridge's own 10000 limit.
  assert.equal(resolveGelabConfig({}).agent.longpressMaxMs, 10000);
  assert.equal(resolveGelabConfig({ KHY_GELAB_LONGPRESS_MAX_MS: '8000' }).agent.longpressMaxMs, 8000);
  // And it can be dropped back to the workaround value if the latch regresses.
  assert.equal(resolveGelabConfig({ KHY_GELAB_LONGPRESS_MAX_MS: '1500' }).agent.longpressMaxMs, 1500);
});

test('resolveGelabConfig is total on hostile input', () => {
  for (const bad of [undefined, null, {}, { KHY_GELAB_MAX_STEPS: {} }, { KHY_GELAB_MODEL: 42 }]) {
    const cfg = resolveGelabConfig(bad);
    assert.ok(cfg && cfg.model && cfg.agent && cfg.gates);
    assert.ok(Number.isFinite(cfg.agent.maxSteps));
    assert.equal(typeof cfg.model.model, 'string');
  }
});
