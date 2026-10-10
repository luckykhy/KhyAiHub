'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// index.evaluate reads the policy off disk via config (lazy dataHome require).
// Point dataHome at a temp dir and write real policy JSON there.
const dataHomePath = require.resolve('../../../../utils/dataHome');
const originalDataHome = require.cache[dataHomePath];

let TMP;
let perm;
const savedEnv = {};

function writePolicy(obj) {
  fs.writeFileSync(path.join(TMP, 'permissions.json'), JSON.stringify(obj));
}

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-permidx-'));
  require.cache[dataHomePath] = {
    id: dataHomePath,
    filename: dataHomePath,
    loaded: true,
    exports: { getDataHome: () => TMP },
    paths: [],
  };
  savedEnv.KHY_PERMISSION_POLICY = process.env.KHY_PERMISSION_POLICY;
  perm = require('./index');
});

after(() => {
  delete require.cache[require.resolve('./index')];
  delete require.cache[require.resolve('./config')];
  delete require.cache[require.resolve('./matchers')];
  if (originalDataHome) require.cache[dataHomePath] = originalDataHome;
  else delete require.cache[dataHomePath];
  if (savedEnv.KHY_PERMISSION_POLICY === undefined) delete process.env.KHY_PERMISSION_POLICY;
  else process.env.KHY_PERMISSION_POLICY = savedEnv.KHY_PERMISSION_POLICY;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  delete process.env.KHY_PERMISSION_POLICY;
  for (const f of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, f), { recursive: true, force: true });
});

describe('index — isEnabled / kill switch', () => {
  test('默认开；仅 KHY_PERMISSION_POLICY=off（大小写无关）关闭', () => {
    assert.equal(perm.isEnabled(), true);
    process.env.KHY_PERMISSION_POLICY = 'OFF';
    assert.equal(perm.isEnabled(), false);
    process.env.KHY_PERMISSION_POLICY = 'on';
    assert.equal(perm.isEnabled(), true);
  });
  test('off 时 evaluate 返回 null（回落既有流程）', () => {
    writePolicy({ defaultPolicy: 'deny' });
    process.env.KHY_PERMISSION_POLICY = 'off';
    assert.equal(perm.evaluate('Bash', { command: 'ls' }), null);
  });
});

describe('index — evaluate 无策略即 no-op', () => {
  test('无文件 → null', () => {
    assert.equal(perm.evaluate('Read', { file_path: '/x' }), null);
  });
  test('文件损坏 → null（fail-closed，不放松任何保护）', () => {
    fs.writeFileSync(path.join(TMP, 'permissions.json'), '{ broken');
    assert.equal(perm.evaluate('Read', { file_path: '/x' }), null);
  });
});

describe('index — 判定顺序：deny 优先于 sensitive-confirm', () => {
  test('显式 deny 覆盖敏感操作（不回落到 confirm）', () => {
    writePolicy({ defaultPolicy: 'auto', tools: { Bash: 'deny' } });
    const r = perm.evaluate('Bash', { command: 'git push origin main' });
    assert.equal(r.decision, 'deny');
    assert.equal(r.matched, 'strategy');
  });
  test('auto 基线遇敏感操作 → 升格 confirm', () => {
    writePolicy({ defaultPolicy: 'auto' });
    const r = perm.evaluate('Bash', { command: 'sudo rm -rf /' });
    assert.equal(r.decision, 'confirm');
    assert.equal(r.matched, 'sensitiveOperations');
  });
  test('confirm 基线 + 敏感 → confirm（不降级为 auto）', () => {
    writePolicy({ defaultPolicy: 'confirm' });
    assert.equal(perm.evaluate('Bash', { command: 'git push' }).decision, 'confirm');
  });
  test('非敏感 + auto shell → auto 放行', () => {
    writePolicy({ defaultPolicy: 'auto' });
    assert.equal(perm.evaluate('Bash', { command: 'ls -la' }).decision, 'auto');
  });
});

describe('index — 工具覆盖解析', () => {
  test('精确名命中；无 hasOwnProperty 守卫问题（constructor 不误命中）', () => {
    writePolicy({ defaultPolicy: 'confirm', tools: { Read: 'auto' } });
    assert.equal(perm.evaluate('Read', { file_path: '/x' }).decision, 'auto');
    // 'constructor' is not an own key of tools → must not resolve to a strategy.
    assert.equal(perm.evaluate('constructor', { file_path: '/x' }).decision, 'confirm');
  });
  test('规范化模糊匹配（大小写/空格/下划线/连字符）', () => {
    writePolicy({ defaultPolicy: 'deny', tools: { 'Shell_Command': 'auto' } });
    // toolName 'shellcommand' normalizes equal to key 'Shell_Command' → auto.
    const r = perm.evaluate('shellCommand', { command: 'ls' });
    assert.equal(r.decision, 'auto');
  });
  test('KNOWN-DEFECT: 非法工具覆盖串静默降级到 defaultPolicy（fail-open 到 auto）', () => {
    // A deny-intent override misspelled as 'denytypo' is dropped by
    // normalizeStrategy (index.js:47/54 returns null), so baseStrategy falls
    // through to defaultPolicy='auto' and the tool gets auto-ALLOWED.
    // permissionPolicy/index.js:78 — `_toolOverride(...) || normalizeStrategy(default)`.
    writePolicy({ defaultPolicy: 'auto', tools: { Bash: 'denytypo' } });
    const r = perm.evaluate('Bash', { command: 'rm file' });
    assert.equal(r.decision, 'auto');
  });
});

describe('index — codeExec 语言闸与限额', () => {
  test('语言不在允许列表 → deny', () => {
    writePolicy({ defaultPolicy: 'auto', codeExecution: { allowedLanguages: ['python'], limits: { cpuSeconds: 5 } } });
    const r = perm.evaluate('executeCode', { code: 'x', language: 'RUBY' });
    assert.equal(r.decision, 'deny');
    assert.equal(r.matched, 'codeExecution.allowedLanguages');
    assert.equal(r.limits.cpuSeconds, 5);
  });
  test('语言允许 → 依基线策略并附限额', () => {
    writePolicy({ defaultPolicy: 'auto', codeExecution: { allowedLanguages: ['python'], limits: { memoryMb: 128, timeoutMs: -1 } } });
    const r = perm.evaluate('executeCode', { code: 'x', language: 'python' });
    assert.equal(r.decision, 'auto');
    assert.equal(r.limits.memoryMb, 128);
    assert.equal(r.limits.timeoutMs, 0); // 负数收敛为 0
  });
  test('空允许列表不拦；无语言也不拦', () => {
    writePolicy({ defaultPolicy: 'auto', codeExecution: { allowedLanguages: [] } });
    assert.equal(perm.evaluate('executeCode', { code: 'x', language: 'ruby' }).decision, 'auto');
  });
});

describe('index — 文件系统白名单', () => {
  test('auto 模式：白名单内放行，外拒绝，无目标拒绝', () => {
    writePolicy({ defaultPolicy: 'auto', filesystem: { writeWhitelist: ['/allowed/*'] } });
    assert.equal(perm.evaluate('Write', { file_path: '/allowed/x.txt' }).decision, 'auto');
    assert.equal(perm.evaluate('Write', { file_path: '/etc/passwd' }).decision, 'deny');
    assert.equal(perm.evaluate('Write', {}).decision, 'deny'); // 无 target → 不放行
  });
  test('无白名单配置时 auto 不加限制（放行）', () => {
    writePolicy({ defaultPolicy: 'auto' });
    assert.equal(perm.evaluate('Read', { file_path: '/anything' }).decision, 'auto');
  });
  test('confirm 模式无论是否白名单都 confirm', () => {
    writePolicy({ defaultPolicy: 'confirm', filesystem: { readWhitelist: ['/a/*'] } });
    assert.equal(perm.evaluate('Read', { file_path: '/a/b' }).decision, 'confirm');
  });
  test('delete 走 deleteWhitelist', () => {
    writePolicy({ defaultPolicy: 'auto', filesystem: { deleteWhitelist: ['/tmp/*'] } });
    assert.equal(perm.evaluate('rm', { file_path: '/tmp/a' }).decision, 'auto');
    assert.equal(perm.evaluate('rm', { file_path: '/etc/a' }).decision, 'deny');
  });
});

describe('index — 网络白名单', () => {
  test('auto：URL 命中放行，未命中拒绝，无 URL 拒绝', () => {
    writePolicy({ defaultPolicy: 'auto', network: { urlWhitelist: ['*.github.com'] } });
    assert.equal(perm.evaluate('WebFetch', { url: 'https://api.github.com/x' }).decision, 'auto');
    assert.equal(perm.evaluate('WebFetch', { url: 'https://evil.com/x' }).decision, 'deny');
    assert.equal(perm.evaluate('WebFetch', {}).decision, 'deny');
  });
});

describe('index — getCodeExecutionLimits', () => {
  test('无策略/关闭 → 全 0', () => {
    assert.deepStrictEqual(perm.getCodeExecutionLimits(), { cpuSeconds: 0, memoryMb: 0, timeoutMs: 0 });
    writePolicy({ codeExecution: { limits: { cpuSeconds: 30, memoryMb: 512, timeoutMs: 'abc' } } });
    assert.deepStrictEqual(perm.getCodeExecutionLimits(), { cpuSeconds: 30, memoryMb: 512, timeoutMs: 0 });
    process.env.KHY_PERMISSION_POLICY = 'off';
    assert.deepStrictEqual(perm.getCodeExecutionLimits(), { cpuSeconds: 0, memoryMb: 0, timeoutMs: 0 });
  });
});

describe('index — 管理助手', () => {
  test('setDefaultStrategy 非法拒绝，合法落盘', () => {
    assert.equal(perm.setDefaultStrategy('nope').success, false);
    assert.equal(perm.setDefaultStrategy('deny').success, true);
    assert.equal(perm.config.loadPolicy().defaultPolicy, 'deny');
  });
  test('setToolStrategy 缺工具名/非法策略拒绝', () => {
    assert.equal(perm.setToolStrategy('', 'auto').success, false);
    assert.equal(perm.setToolStrategy('Bash', 'bad').success, false);
    assert.equal(perm.setToolStrategy('Bash', 'auto').success, true);
  });
  test('addPathRule/addUrlRule 去重追加，空参拒绝', () => {
    perm.setDefaultStrategy('auto');
    assert.equal(perm.addPathRule('', 'read').success, false);
    assert.equal(perm.addUrlRule('').success, false);
    perm.addPathRule('/a/*', 'read');
    perm.addPathRule('/a/*', 'read');
    const p = perm.config.loadPolicy();
    assert.deepStrictEqual(p.filesystem.readWhitelist, ['/a/*']);
  });
  test('clearToolStrategy 正常清除已有覆盖', () => {
    perm.setToolStrategy('Bash', 'deny');
    assert.equal(perm.clearToolStrategy('Bash').success, true);
    assert.equal(perm.clearToolStrategy('Bash').success, false);
  });
  test('KNOWN-DEFECT: clearToolStrategy 用 `in` 查覆盖，原型键被误判存在而假成功', () => {
    // index.js:258 `!(toolName in policy.tools)` uses the `in` operator, which
    // walks the prototype chain. 'constructor'/'toString' are always "in" any
    // object, so the guard passes, the delete is a no-op, and savePolicy reports
    // success for a rule that never existed.
    perm.setDefaultStrategy('auto');
    const r = perm.clearToolStrategy('constructor');
    assert.equal(r.success, true);
    const tools = perm.config.loadPolicy().tools;
    assert.equal(Object.prototype.hasOwnProperty.call(tools, 'constructor'), false);
    assert.equal(Object.keys(tools).includes('constructor'), false);
  });
  test('setToolStrategy("__proto__") 假成功但写入无效（__proto__ 赋值不成 own 属性）', () => {
    perm.setDefaultStrategy('auto');
    const r = perm.setToolStrategy('__proto__', 'deny');
    assert.equal(r.success, true);
    assert.equal(perm.config.loadPolicy().defaultPolicy, 'auto');
    // The bogus key does not take effect as an override.
    assert.equal(perm.evaluate('Bash', { command: 'ls' }).decision, 'auto');
  });
});

describe('index — summarize', () => {
  test('反映 enabled/exists/path/policy', () => {
    writePolicy({ defaultPolicy: 'deny' });
    const s = perm.summarize();
    assert.equal(s.enabled, true);
    assert.equal(s.exists, true);
    assert.equal(s.path, path.join(TMP, 'permissions.json'));
    assert.equal(s.policy.defaultPolicy, 'deny');
  });
  test('无文件时 policy 为 null 但仍给出路径', () => {
    const s = perm.summarize();
    assert.equal(s.exists, false);
    assert.equal(s.policy, null);
  });
});
