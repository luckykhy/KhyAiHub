'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const assembler = require('../../src/services/dynamicPromptAssembler');
const pipeline = require('../../src/services/perRequestAdaptationPipeline');

test('A3 adaptation stays fully visible under a single-model context', () => {
  const enabled = assembler.assemblePromptForModel({
    modelId: 'claude-sonnet-4',
    taskType: 'code',
    userText: 'fix the failing test',
    env: { KHY_MODEL_ADAPT: '1', KHY_DYNAMIC_PROMPT: '1' },
  });
  const inert = assembler.assemblePromptForModel({
    modelId: 'claude-sonnet-4',
    taskType: 'code',
    userText: 'fix the failing test',
    env: { KHY_MODEL_ADAPT: '0' },
  });

  assert.ok(Object.prototype.hasOwnProperty.call(enabled, 'matchedBy'));
  assert.ok(Object.prototype.hasOwnProperty.call(enabled, 'finalSystemPrompt'));
  assert.notStrictEqual(enabled.finalSystemPrompt, inert.finalSystemPrompt);
  assert.notStrictEqual(enabled.matchedBy.layers.length, inert.matchedBy.layers.length);
});

test('inert assembly still carries the visibility fields (no schema break)', () => {
  const inert = assembler.assemblePromptForModel({
    modelId: 'unknown-model-x',
    env: { KHY_MODEL_ADAPT: '0' },
  });
  assert.deepStrictEqual(inert.matchedBy, { family: null, layers: [], known: false });
  assert.strictEqual(inert.finalSystemPrompt, '');
});

test('pipeline surfaces matchedBy and finalSystemPrompt at top level', () => {
  const adapted = pipeline.adaptRequest({
    modelId: 'claude-sonnet-4',
    taskType: 'code',
    env: { KHY_MODEL_ADAPT: '1', KHY_DYNAMIC_PROMPT: '1' },
  });
  assert.ok(Object.prototype.hasOwnProperty.call(adapted, 'matchedBy'));
  assert.ok(Object.prototype.hasOwnProperty.call(adapted, 'finalSystemPrompt'));
  assert.strictEqual(adapted.finalSystemPrompt, adapted.adaptation.finalSystemPrompt);
});

test('telemetry decision log has the explain whitelist in source', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'services', 'gateway', 'autoModelRouting.js'),
    'utf8'
  );
  for (const key of ['candidateCount', 'sessionLock', 'capabilityGap', 'fallbackChain']) {
    assert.ok(src.includes(`ctx.explain.${key}`), `missing explain field: ${key}`);
  }
});
