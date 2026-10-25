'use strict';

/**
 * stepneoCloud/toolSchemas.test.js — co-located suite for the schema conversion.
 *
 * IO: none. The catalog is a static table, so the whole conversion is assertable
 * offline. What matters is that the model is told the truth about the bridge —
 * same names, same bounds, same required-ness.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  argSpecToJsonSchema, toolToFunctionSchema, buildToolSchemas, createToolNameResolver,
} = require('./toolSchemas');
const { getPhoneBridgeTools, findPhoneBridgeTool, getPhoneBridgeUiTools } = require('../phone/phoneBridgeCatalog');

// ── arg conversion ───────────────────────────────────────────────────────────

test('bounds and description survive the conversion', () => {
  const schema = argSpecToJsonSchema({
    type: 'integer', minimum: 1, maximum: 120, description: '超时秒数',
  });
  assert.deepEqual(schema, {
    type: 'integer', description: '超时秒数', minimum: 1, maximum: 120,
  });
});

test('a string arg carries its maxLength so the model does not overflow it', () => {
  const schema = argSpecToJsonSchema({ type: 'string', maxLength: 4000, description: 'cmd' });
  assert.equal(schema.maxLength, 4000);
});

test('an arg with no description gets an empty string, not undefined', () => {
  // undefined would be dropped by JSON.stringify and the model would see a
  // property with no explanation at all.
  assert.equal(argSpecToJsonSchema({ type: 'string' }).description, '');
});

// ── one tool ─────────────────────────────────────────────────────────────────

test('exec becomes a function schema with the bridge arg names intact', () => {
  const fn = toolToFunctionSchema(findPhoneBridgeTool('exec')).function;
  // `confirm` is present because exec runs shell commands — it is ACCESS_ACTUATE,
  // not a read-only probe. Assuming otherwise is how a schema ends up advertising
  // a tool the model can never actually get approved.
  assert.deepEqual(Object.keys(fn.parameters.properties).sort(), ['cmd', 'confirm', 'timeout']);
  assert.deepEqual(fn.parameters.required, ['cmd']);
  assert.equal(fn.parameters.properties.cmd.type, 'string');
  assert.equal(fn.parameters.additionalProperties, false);
  assert.ok(fn.description.length > 0);
});

test('the confirm arg is never listed as required', () => {
  // Required would force the model to approve before it has seen the plan, which
  // is exactly the "confirm everything by reflex" outcome the gate exists to
  // prevent. planBridgeCall() is what turns it into a real decision point.
  for (const schema of buildToolSchemas()) {
    assert.ok(!(schema.function.parameters.required || []).includes('confirm'));
  }
});

test('an actuating tool gets a confirm arg; a read-only one does not', () => {
  // confirm is the bridge's own approval channel. Without it in the schema the
  // model has no way to say "yes, do it" and every actuation is refused.
  const writeFn = toolToFunctionSchema(findPhoneBridgeTool('write')).function;
  assert.ok('confirm' in writeFn.parameters.properties);
  const lsFn = toolToFunctionSchema(findPhoneBridgeTool('ls')).function;
  assert.ok(!('confirm' in lsFn.parameters.properties));
});

test('the schema name is khyName, which is what the model will emit', () => {
  const fn = toolToFunctionSchema(findPhoneBridgeTool('exec')).function;
  assert.equal(fn.name, 'phone_exec');
});

// ── the whole list ───────────────────────────────────────────────────────────

test('every non-UI bridge tool is advertised', () => {
  const schemas = buildToolSchemas({ includeUi: false });
  assert.equal(schemas.length, getPhoneBridgeTools().length);
});

test('UI tools are included on request and excluded otherwise', () => {
  assert.equal(buildToolSchemas({ includeUi: true }).length,
    getPhoneBridgeTools().length + getPhoneBridgeUiTools().length);
  assert.equal(buildToolSchemas({ includeUi: false }).length,
    getPhoneBridgeTools().length);
});

test('no two schemas share a name', () => {
  // A duplicate name makes the tool call ambiguous and the model's choice
  // effectively random.
  const names = buildToolSchemas().map((s) => s.function.name);
  assert.equal(new Set(names).size, names.length);
});

test('every schema is well formed enough for an OpenAI tools array', () => {
  for (const schema of buildToolSchemas()) {
    assert.equal(schema.type, 'function');
    assert.equal(typeof schema.function.name, 'string');
    assert.ok(schema.function.name.length > 0);
    assert.equal(schema.function.parameters.type, 'object');
    assert.equal(typeof schema.function.parameters.properties, 'object');
  }
});

// ── name resolution ──────────────────────────────────────────────────────────

test('the resolver maps a schema name back to the bridge name', () => {
  const resolver = createToolNameResolver();
  assert.equal(resolver.resolve('phone_exec'), 'exec');
  assert.equal(resolver.resolve('phone_ls'), 'ls');
});

test('aliases resolve too', () => {
  const resolver = createToolNameResolver();
  const exec = findPhoneBridgeTool('exec');
  for (const alias of exec.aliases || []) {
    assert.equal(resolver.resolve(alias), 'exec');
  }
});

test('an invented name resolves to null rather than being guessed at', () => {
  // Guessing would send a malformed call to the bridge; null lets the agent
  // loop report the real registered names instead.
  const resolver = createToolNameResolver();
  assert.equal(resolver.resolve('phone_delete_everything'), null);
  assert.equal(resolver.has('phone_delete_everything'), false);
});

// ── the UI tool transcription, which is the easy part to get silently wrong ──

test('every UI tool gets a schema with a non-empty description', () => {
  // getPhoneBridgeUiTools() returns NAMES, not objects. An earlier draft spread
  // each string as if it were an entry and produced 11 nameless schemas.
  const uiNames = getPhoneBridgeUiTools();
  const schemas = buildToolSchemas({ includeUi: true }).slice(-uiNames.length);
  assert.equal(schemas.length, uiNames.length);
  for (const [i, name] of uiNames.entries()) {
    assert.equal(schemas[i].function.name, name);
    assert.ok(schemas[i].function.description.length > 0, `${name} 缺描述`);
    assert.equal(schemas[i].function.parameters.type, 'object');
  }
});

test('ui_tap requires x and y and takes no ms', () => {
  // `ms` belongs to ui_longpress. Advertising it on tap would have the model
  // pass a duration the bridge never reads.
  const schemas = buildToolSchemas();
  const tap = schemas.find((s) => s.function.name === 'ui_tap').function;
  assert.deepEqual(tap.parameters.required, ['x', 'y']);
  assert.ok(!('ms' in tap.parameters.properties));
});

test('ui_swipe is the only UI tool with two coordinate pairs', () => {
  const schemas = buildToolSchemas();
  const swipe = schemas.find((s) => s.function.name === 'ui_swipe').function;
  assert.deepEqual(swipe.parameters.required, ['x1', 'y1', 'x2', 'y2']);
  const others = schemas.filter((s) => s.function.name.startsWith('ui_')
    && s.function.name !== 'ui_swipe');
  for (const other of others) {
    assert.ok(!('x1' in other.function.parameters.properties), `${other.function.name} 不该有 x1`);
  }
});

test('ui_type requires text; ui_back takes nothing', () => {
  const schemas = buildToolSchemas();
  const type = schemas.find((s) => s.function.name === 'ui_type').function;
  assert.deepEqual(type.parameters.required, ['text']);
  const back = schemas.find((s) => s.function.name === 'ui_back').function;
  assert.deepEqual(back.parameters.properties, { confirm: back.parameters.properties.confirm });
  assert.deepEqual(back.parameters.required, []);
});

test('a read-only UI tool gets no confirm arg, an actuating one does', () => {
  const schemas = buildToolSchemas();
  assert.ok(!('confirm' in schemas.find((s) => s.function.name === 'ui_dump').function.parameters.properties));
  assert.ok('confirm' in schemas.find((s) => s.function.name === 'ui_tap').function.parameters.properties);
});

test('every UI tool name in the catalog has a transcribed arg spec', () => {
  // A missing entry would silently degrade to "no arguments", so the model
  // could never address anything. Fail loudly instead.
  for (const name of getPhoneBridgeUiTools()) {
    const schemas = buildToolSchemas();
    const found = schemas.find((s) => s.function.name === name);
    assert.ok(found, `${name} 没有生成 schema`);
    const argCount = Object.keys(found.function.parameters.properties)
      .filter((k) => k !== 'confirm').length;
    if (['ui_back', 'ui_home', 'ui_recents'].includes(name)) {
      assert.equal(argCount, 0, `${name} 不该有参数`);
    } else {
      assert.ok(argCount > 0, `${name} 应该有参数却没转录到`);
    }
  }
});
