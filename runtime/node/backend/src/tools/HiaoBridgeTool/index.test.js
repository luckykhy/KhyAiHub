'use strict';

/**
 * HiaoBridgeTool/index.test.js — wiring suite for the D1 consumer.
 *
 * Policy lives in the service unit and is tested there; what only this file can
 * prove is the wiring, and the wiring carries the security-relevant contract:
 *
 *   · no on/off switch. The contract ships this profile with NO enable gate —
 *     capability is gated structurally by the pairing token, so the tool must
 *     register under any env (including none) and answer honestly until the
 *     phone is paired.
 *   · the delegation. The tool must reach the service facade, not re-implement
 *     adb/HTTP/policy.
 *   · the confirm gate. The tool passes the model's own confirm through and
 *     never injects confirm:true on its behalf.
 *
 * Registration cases run in a child process so they see the module fresh; the
 * delegation cases run in-process against a stubbed facade client.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TOOL_PATH = path.join(__dirname, 'index.js');

function probeToolShape(env) {
  const script = [
    'const m = require(process.argv[1]);',
    'const hasExec = typeof m.execute === "function";',
    'const hasPrompt = typeof m.prompt === "function";',
    'const hasSchema = !!(m.inputSchema && m.inputSchema.properties);',
    'const isTool = hasExec && hasPrompt && hasSchema;',
    'const Ctor = m.constructor || {};',
    'console.log(JSON.stringify({',
    '  isTool,',
    '  toolName: isTool ? (m.toolName || Ctor.toolName) : null,',
    '  risk: isTool ? (m.risk || Ctor.risk) : null,',
    '  category: isTool ? (m.category || Ctor.category) : null,',
    '  actions: isTool ? m.inputSchema.properties.action.enum : null,',
    '  promptChars: isTool ? m.prompt().length : null,',
    '}));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script, TOOL_PATH], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

/** Source with comments and string literals stripped (matches CODE, not prose). */
function codeOnly(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// ── registration (no on/off switch by design) ───────────────────────────────

test('无 env 也注册真工具：HiaoBridge / system / high / 8 个 action', () => {
  const shape = probeToolShape({});
  assert.equal(shape.isTool, true);
  assert.equal(shape.toolName, 'HiaoBridge');
  assert.equal(shape.risk, 'high');
  assert.equal(shape.category, 'system');
  assert.deepEqual(shape.actions, ['ping', 'status', 'tools', 'call', 'approvals', 'approve', 'audit', 'task']);
});

test('本单元没有任何 on/off 开关读取（契约明令：能力由配对令牌把关）', () => {
  const code = codeOnly(TOOL_PATH);
  assert.doesNotMatch(code, /isFlagEnabled|_gateEnabled|KHY_HIAO_BRIDGE_ENABLED/);
  assert.doesNotMatch(code, /_khyHiaoBridgeDisabled/);
  const config = require('../../services/domain/network/phone/hiaoBridge/hiaoBridgeConfig');
  assert.equal('isHiaoBridgeEnabled' in config, false);
});

test('prompt 三要素且不超过 600 字符', () => {
  const shape = probeToolShape({});
  assert.ok(shape.promptChars <= 600, `prompt ${shape.promptChars} 字符，超 600`);
});

// ── delegation, not re-implementation ────────────────────────────────────────

test('工具经服务门面委托，不自带 adb/HTTP/策略实现', () => {
  const src = fs.readFileSync(TOOL_PATH, 'utf8');
  assert.match(src, /require\('\.\.\/\.\.\/services\/domain\/network\/phone\/hiaoBridge'\)/);
  assert.match(src, /getHiaoBridgeClient/);
  const code = codeOnly(TOOL_PATH);
  assert.doesNotMatch(code, /createHmac|http\.request|child_process/);
  // 零硬编码：回环地址、端口、设备路径都不该在这里出现。
  assert.doesNotMatch(code, /127\.0\.0\.1|:8898|18998|\/sdcard/);
});

test('工具从不代替模型注入 confirm:true', () => {
  const code = codeOnly(TOOL_PATH);
  assert.doesNotMatch(code, /confirm\s*:\s*true/);
  // 它只透传模型自己给的 confirm（严格等于 true 才算数）。
  assert.match(code, /params\.confirm\s*===\s*true/);
});

// ── execute dispatch against a stubbed facade client ────────────────────────

const tool = require('./index');
const bridge = require('../../services/domain/network/phone/hiaoBridge');

function withFakeClient(fake, fn) {
  const original = bridge.getHiaoBridgeClient;
  bridge.getHiaoBridgeClient = () => fake;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      bridge.getHiaoBridgeClient = original;
    });
}

test('未知 action 拒绝并列出可用值', async () => {
  const res = await tool.execute({ action: 'nope' });
  assert.equal(res.success, false);
  assert.match(res.error, /未知 action/);
  assert.match(res.error, /approvals/);
});

test('call 缺 tool 时给下一步（先用 tools 查表）', async () => {
  const res = await withFakeClient({}, () => tool.execute({ action: 'call' }));
  assert.equal(res.success, false);
  assert.match(res.error, /tools/);
});

test('task 缺 prompt 时拒绝', async () => {
  const res = await withFakeClient({}, () => tool.execute({ action: 'task', prompt: '  ' }));
  assert.equal(res.success, false);
  assert.match(res.error, /prompt/);
});

test('写调用不带 confirm：透传 confirm=false 并把计划原样交回', async () => {
  const seen = [];
  const fake = {
    call: async (toolName, args, options) => {
      seen.push({ toolName, args, options });
      return {
        success: false,
        requiresConfirm: true,
        code: 'requires_confirm',
        plan: { tool: toolName, args },
        message: '将在手机上调用 exec（写操作）…600s…',
      };
    },
  };
  const res = await withFakeClient(fake, () => tool.execute({ action: 'call', tool: 'exec', args: { cmd: 'id' } }));
  assert.equal(seen[0].options.confirm, false);
  assert.equal(res.requiresConfirm, true);
  assert.equal(res.code, 'requires_confirm');
  assert.match(res.message, /600s/);
});

test('模型显式 confirm:true 才透传 true', async () => {
  const seen = [];
  const fake = {
    call: async (toolName, args, options) => {
      seen.push(options);
      return { success: true, tool: toolName, verdict: 'allow', channel: 'http', result: { ok: true } };
    },
  };
  const res = await withFakeClient(fake, () => tool.execute({ action: 'call', tool: 'exec', confirm: true }));
  assert.equal(seen[0].confirm, true);
  assert.equal(res.success, true);
  assert.equal(res.verdict, 'allow');
});

test('status 委托门面并附带 state', async () => {
  const fake = {
    status: async () => ({ ok: true, channel: 'http', status: { tools: 48 } }),
    getState: () => ({ enabled: true, tokenReady: false }),
  };
  const res = await withFakeClient(fake, () => tool.execute({ action: 'status' }));
  assert.equal(res.success, true);
  assert.equal(res.hiao.tools, 48);
  assert.equal(res.state.enabled, true);
});

test('task 是 agent_task 的异步薄别名：回 accepted/taskId，不轮询', async () => {
  const seen = [];
  const fake = {
    call: async (toolName, args, options) => {
      seen.push({ toolName, args, options });
      return { success: true, tool: toolName, verdict: null, channel: 'http', result: { ok: true, accepted: true, taskId: 'task_9' } };
    },
  };
  const res = await withFakeClient(fake, () => tool.execute({ action: 'task', prompt: '查电量并写文件' }));
  assert.equal(seen[0].toolName, 'agent_task');
  assert.equal(seen[0].args.wait, false);
  assert.equal(seen[0].args.prompt, '查电量并写文件');
  assert.equal(res.accepted, true);
  assert.equal(res.taskId, 'task_9');
  assert.match(res.hint, /agent_status/);
});

test('approve 把 confirm 一并透传（审批也是状态变更）', async () => {
  const seen = [];
  const fake = {
    approve: async (id, approveVerdict, answer, options) => {
      seen.push({ id, approveVerdict, answer, options });
      return { success: true, channel: 'http', body: { ok: true } };
    },
  };
  const res = await withFakeClient(fake, () => tool.execute({ action: 'approve', id: 'ap-1', answer: 'ok', confirm: true }));
  assert.equal(seen[0].id, 'ap-1');
  assert.equal(seen[0].approveVerdict, true);
  assert.equal(seen[0].options.confirm, true);
  assert.equal(res.success, true);
});
