'use strict';

/**
 * StepneoCloudTool/index.test.js — wiring suite for the D1 consumer.
 *
 * This repo keeps no tests under tools/ — the policy lives in the service unit
 * and is tested there (94 cases). What is NOT covered by those is the wiring,
 * and the wiring is where the security-relevant contract actually sits:
 *
 *   · the gate. "STEPNEO_ENABLED=0" has to mean the tool does not exist, not
 *     "the tool exists and refuses". A tool that still registers can still be
 *     discovered, described and partially invoked.
 *   · the delegation. The tool must reach the service facade and the phone
 *     bridge client, not re-implement either.
 *   · the secret handling. `token` fetches a credential off the phone; returning
 *     it would put an R2-class secret into a tool result and a log line.
 *
 * The gate cases run in a child process because the tool reads process.env at
 * require time — the same reason the module has no other side effects.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const TOOL_PATH = path.join(__dirname, 'index.js');

/** Require the tool in a fresh process with a given env, and report its shape. */
function probeToolShape(env) {
  const script = [
    'const m = require(process.argv[1]);',
    'const disabled = !!(m && m._khyStepneoDisabled);',
    // Each conjunct compared, not &&-chained: a chain ending in `m.inputSchema`
    // yields the schema object, which is truthy but is not `true`.
    'const hasExec = typeof m.execute === "function";',
    'const hasPrompt = typeof m.prompt === "function";',
    'const hasSchema = !!(m.inputSchema && m.inputSchema.properties);',
    'const isTool = !disabled && hasExec && hasPrompt && hasSchema;',
    'console.log(JSON.stringify({',
    '  disabled, isTool,',
    '  toolName: isTool ? (m.toolName || (m.constructor && m.constructor.toolName)) : null,',
    '  risk: isTool ? (m.risk || (m.constructor && m.constructor.risk)) : null,',
    '  actions: isTool ? m.inputSchema.properties.action.enum : null,',
    '}));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script, TOOL_PATH], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = out.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

/**
 * Source with comments and string literals stripped.
 *
 * Assertions like "the tool never passes confirm:true" are about CODE. Matching
 * the raw file also matches the prompt text and the header comment — both of
 * which legitimately mention confirm:true — so the check has to see only code.
 */
function codeOnly(filePath) {
  const src = require('node:fs').readFileSync(filePath, 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // line comments
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")   // single-quoted strings
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')   // double-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');    // template literals
}

// ── the gate ─────────────────────────────────────────────────────────────────

test('gate open (default) registers a real tool', () => {
  const shape = probeToolShape({ STEPNEO_ENABLED: '1' });
  assert.equal(shape.disabled, false);
  assert.equal(shape.isTool, true);
  assert.equal(shape.toolName, 'StepneoCloud');
  assert.equal(shape.risk, 'high');
  assert.deepEqual(shape.actions, ['ask', 'status', 'token', 'tools']);
});

test('an empty env defaults the gate OPEN, matching the phone bridge tool', () => {
  // Defaulting closed would make the tool silently vanish for everyone who did
  // not know to set a variable; defaulting open is safe because nothing happens
  // without the signing key anyway.
  const shape = probeToolShape({ STEPNEO_ENABLED: '' });
  assert.equal(shape.disabled, false);
  assert.equal(shape.isTool, true);
});

test('gate closed exports a benign non-tool object, so discovery skips it', () => {
  // The loaders skip anything without execute/prompt/inputSchema. Exporting a
  // real tool that merely refuses at call time would still be discoverable,
  // describable and partially invokable.
  for (const v of ['0', 'false', 'off', 'no']) {
    const shape = probeToolShape({ STEPNEO_ENABLED: v });
    assert.equal(shape.disabled, true, `${v} 应导出禁用标记`);
    assert.equal(shape.isTool, false, `${v} 不应导出可执行工具`);
  }
});

// ── delegation, not re-implementation ────────────────────────────────────────

test('the tool reaches the service facade and the phone bridge client', () => {
  // If either require path is wrong the tool fails at call time with a stack
  // trace instead of an answer, which is the hardest kind of wiring bug to spot.
  const src = require('node:fs').readFileSync(TOOL_PATH, 'utf8');
  assert.match(src, /require\('\.\.\/\.\.\/services\/domain\/network\/stepneoCloud'\)/);
  assert.match(src, /require\('\.\.\/\.\.\/services\/domain\/network\/phone'\)\.getPhoneBridgeClient/);
  // And it must not invent its own signing or its own policy.
  const code = codeOnly(TOOL_PATH);
  assert.doesNotMatch(code, /createHmac/);
});

test('the tool never passes confirm:true on the model\'s behalf', () => {
  // The one assertion that matters most in this file. The bridge's confirm gate
  // is the only thing between a hallucinated tool call and a changed phone, and
  // a convenience `confirm: true` here would switch it off for every call.
  //
  // Checked against code only: the prompt text and the header comment both say
  // "confirm:true" on purpose, because that is the contract being described.
  const code = codeOnly(TOOL_PATH);
  assert.doesNotMatch(code, /confirm\s*:\s*true/);
  // The schema must not even offer the parameter — there is nothing to pass it to.
  assert.doesNotMatch(code, /confirm\s*:/);
});

test('the token is never returned from the tool', () => {
  const src = require('node:fs').readFileSync(TOOL_PATH, 'utf8');
  // `_token` reports the source package, the observation time and the age, and
  // explicitly does not echo the value.
  assert.match(src, /token 已取到并仅存于本次进程内存，不随工具结果返回/);
  const tokenBranch = src.slice(src.indexOf('async _token'), src.indexOf('async _ask'));
  assert.doesNotMatch(tokenBranch, /return \{[^}]*\btoken:/);
});

// ── the CLI handler manifest ─────────────────────────────────────────────────

test('the CLI handler exports a well-formed manifest', () => {
  const { MANIFEST_EXPORT_KEY } = require('../../cli/commandManifest');
  const handler = require('../../cli/handlers/stepneo');
  assert.equal(typeof handler.handleStepneo, 'function');
  const manifest = handler[MANIFEST_EXPORT_KEY];
  assert.ok(manifest, '必须带 MANIFEST_EXPORT_KEY，否则命令自动发现看不到它');
  assert.equal(manifest.name, 'stepneo');
  assert.equal(typeof manifest.handler, 'function');
  assert.ok(Array.isArray(manifest.subCommands));
  assert.ok(manifest.subCommands.includes('ask'));
  assert.ok(manifest.subCommands.includes('status'));
  assert.match(manifest.usage, /stepneo/);
});

test('the CLI command is discoverable by the auto registry', () => {
  const reg = require('../../cli/commandAutoRegistry');
  reg.init();
  const names = reg.getCommandNames();
  assert.ok(names.includes('stepneo'), 'khy stepneo 必须被发现');
});

test('the CLI handler does not hardcode a host, port or secret', () => {
  // Everything comes from resolveStepneoConfig; a literal here is a second
  // source of truth that drifts. Checked against code only — the header comment
  // names the gateway on purpose, because that is what the file is about.
  const src = codeOnly(path.join(__dirname, '../../cli/handlers/stepneo.js'));
  assert.doesNotMatch(src, /biz-gw\.stepaos\.com/);
  assert.doesNotMatch(src, /127\.0\.0\.1:\d/);
  assert.match(src, /resolveStepneoConfig/);
});

// ── status, which must work with no secret and no network ────────────────────

test('action "status" answers without a secret, a token or a network call', async () => {
  // status is the diagnostic surface. If it needed credentials it would be
  // useless exactly when someone is trying to find out why nothing works.
  const tool = require('./index');
  const res = await tool.execute({ action: 'status' }, {});
  assert.equal(res.success, true);
  assert.equal(res.action, 'status');
  assert.equal(res.credentials.appSecret.present, false);
  assert.ok(res.gateway.baseUrl.length > 0);
  assert.ok(res.hint, '缺密钥时必须说清去哪配');
  assert.doesNotMatch(JSON.stringify(res), /sekrit/);
});

test('action "tools" lists the schemas and matches the service facade', async () => {
  const tool = require('./index');
  const gw = require('../../services/domain/network/stepneoCloud');
  const res = await tool.execute({ action: 'tools' }, {});
  assert.equal(res.success, true);
  assert.equal(res.count, gw.buildToolSchemas({ includeUi: true }).length);
  assert.ok(res.tools.some((t) => t.name === 'phone_exec'));
});

test('action "ask" without a prompt is refused, not sent', async () => {
  const tool = require('./index');
  const res = await tool.execute({ action: 'ask', prompt: '   ' }, {});
  assert.equal(res.success, false);
  assert.match(res.error, /需要 prompt/);
});

test('action "ask" without a signing key is refused with the variable named', async () => {
  // The alternative is a 401 that reads as an expired token.
  const tool = require('./index');
  const res = await tool.execute({ action: 'ask', prompt: 'do something' }, {});
  if (process.env.STEPNEO_APP_SECRET || process.env.STEPNEO_APP_SECRET_FILE) {
    // A developer machine with the key configured: the refusal we care about
    // cannot happen, so assert we got past the secret check instead.
    assert.notEqual(res.code, 'APP_SECRET_REQUIRED');
  } else {
    assert.equal(res.success, false);
    assert.equal(res.code, 'APP_SECRET_REQUIRED');
    assert.match(res.error, /STEPNEO_APP_SECRET/);
  }
});

test('an unknown action is refused with the valid list', async () => {
  const tool = require('./index');
  const res = await tool.execute({ action: 'nope' }, {});
  assert.equal(res.success, false);
  assert.match(res.error, /未知 action/);
});
