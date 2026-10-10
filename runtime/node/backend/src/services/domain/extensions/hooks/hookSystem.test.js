'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox the data homes BEFORE the first require so registry.load() can never
// read the real ~/.khy or write inside the repo.
const saved = {
  APP: process.env.KHY_APP_HOME,
  DATA: process.env.KHY_DATA_HOME,
  TUI: process.env.KHY_INK_TUI_ACTIVE,
};
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-hooksys-'));
process.env.KHY_APP_HOME = path.join(sandbox, 'apphome');
process.env.KHY_DATA_HOME = path.join(sandbox, 'apphome');
fs.mkdirSync(process.env.KHY_APP_HOME, { recursive: true });

const hookSystem = require('./hookSystem.js');
const registry = require('./hookRegistry.js');

// The three optional collaborators are stubbed in require.cache: init() must not
// pull the real tool guards / change-watch / feedback services into a unit test.
function cacheKey(rel) {
  return require.resolve(path.join(__dirname, rel));
}
const stubs = {};
function installStub(rel, exportsValue) {
  const key = cacheKey(rel);
  if (!stubs[key]) {
    stubs[key] = require.cache[key] === undefined ? null : require.cache[key];
  }
  require.cache[key] = { id: key, filename: key, loaded: true, exports: exportsValue };
  return key;
}

let guardCalls = 0;
let guardRegistry = null;
let changeWatchEnabled = false;
let feedbackEnabled = false;
let injectorTag = 'cw';

const KEYS = {};

before(() => {
  KEYS.guards = installStub('../../../toolGuards', {
    registerBuiltinGuards(hs) {
      guardCalls += 1;
      guardRegistry = hs;
      hs.registerFunction('PreToolUse', async () => ({ action: 'allow' }), { source: 'builtin:StubGuard', priority: 5 });
    },
  });
  KEYS.changeWatch = installStub('../../../changeWatchService', {
    isWatchEnabled: () => changeWatchEnabled,
    makePrePromptInjector: () => async () => ({ action: 'modify', additionalContext: `cw:${injectorTag}` }),
  });
  KEYS.feedback = installStub('../../../agentFeedbackService', {
    isEnabled: () => feedbackEnabled,
    makePrePromptInjector: () => async () => ({ action: 'modify', additionalContext: `fb:${injectorTag}` }),
  });
});

after(() => {
  for (const key of Object.keys(stubs)) {
    if (stubs[key]) {
      require.cache[key] = stubs[key];
    } else {
      delete require.cache[key];
    }
  }
  for (const [name, val] of [['APP', saved.APP], ['DATA', saved.DATA], ['TUI', saved.TUI]]) {
    const envName = name === 'APP' ? 'KHY_APP_HOME' : name === 'DATA' ? 'KHY_DATA_HOME' : 'KHY_INK_TUI_ACTIVE';
    if (val === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = val;
    }
  }
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function captureLog(fn) {
  const lines = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = real;
  }
  return lines.join('');
}

describe('hookSystem — 门面与初始化', () => {
  test('trigger 在未 init 前一律放行，且连已注册的 hook 都不查', async () => {
    assert.equal(hookSystem.isInitialized(), false);
    hookSystem.registerFunction('PreToolUse', async () => ({ action: 'block', reason: '应当拦住' }), { source: 'pre-init' });
    assert.equal(registry.getHooks('PreToolUse').length, 1);
    const res = await hookSystem.trigger('PreToolUse', { toolName: 'Bash' });
    assert.deepEqual(res, { blocked: false, context: { toolName: 'Bash' } });
  });

  test('KNOWN-DEFECT: init() 里的 registry.load() 把 init 之前注册的 hook 静默清空（hookSystem.js:24 / hookRegistry.js:60）', () => {
    // The previous test left 'pre-init' registered. init() calls load(), which
    // _clearAll()s every bucket: a programmatic hook registered during module
    // wiring (the documented plugin-seam usage) is gone with no warning, and the
    // count line does not mention it.
    const before = registry.getHooks('PreToolUse').map((h) => h.source);
    assert.deepEqual(before, ['pre-init']);
    const out = captureLog(() => hookSystem.init(undefined));
    assert.equal(registry.getHooks('PreToolUse').map((h) => h.source).includes('pre-init'), false, 'pre-init 应当仍在');
    assert.match(out, /\[Hooks\] Loaded \d+ hook\(s\)/);
    assert.equal(hookSystem.isInitialized(), true);
  });

  test('init 注册内置守卫；changeWatch / agentFeedback 只在各自门控开时挂 PrePrompt', () => {
    guardCalls = 0;
    changeWatchEnabled = false;
    feedbackEnabled = false;
    captureLog(() => hookSystem.init(undefined));
    assert.equal(guardCalls, 1);
    assert.equal(guardRegistry, hookSystem, '守卫拿到的是 hookSystem 门面本身');
    assert.equal(registry.getHooks('PrePrompt').map((h) => h.source).includes('builtin:ChangeWatchInjector'), false);
    assert.equal(registry.getHooks('PrePrompt').map((h) => h.source).includes('builtin:AgentFeedbackInjector'), false);

    changeWatchEnabled = true;
    feedbackEnabled = true;
    captureLog(() => hookSystem.init(undefined));
    const pre = registry.getHooks('PrePrompt').map((h) => h.source);
    assert.ok(pre.includes('builtin:ChangeWatchInjector'));
    assert.ok(pre.includes('builtin:AgentFeedbackInjector'));
    const cw = registry.getHooks('PrePrompt').find((h) => h.source === 'builtin:ChangeWatchInjector');
    assert.equal(cw.priority, 20);
    const fb = registry.getHooks('PrePrompt').find((h) => h.source === 'builtin:AgentFeedbackInjector');
    assert.equal(fb.priority, 30);
  });

  test('门控开的注入器真的把 additionalContext 注入到 trigger 结果里', async () => {
    changeWatchEnabled = true;
    feedbackEnabled = false;
    injectorTag = 'run1';
    captureLog(() => hookSystem.init(undefined));
    const res = await hookSystem.trigger('PrePrompt', { prompt: 'orig' });
    assert.equal(res.blocked, false);
    assert.equal(res.context.additionalContext, 'cw:run1');
    assert.equal(res.context.prompt, 'orig');
  });

  test('trigger 把 hook 的 block 原样上报，并带上 reason / source / approvable', async () => {
    changeWatchEnabled = false;
    captureLog(() => hookSystem.init(undefined));
    registry.registerFunction('PreToolUse', async () => ({ action: 'block', reason: '危险操作', approvable: true, source: 'guardX' }), { source: 'guardX', priority: 1 });
    const res = await hookSystem.trigger('PreToolUse', { toolName: 'Bash' });
    assert.equal(res.blocked, true);
    assert.equal(res.reason, '危险操作');
    assert.equal(res.approvable, true);
    assert.equal(res.source, 'guardX');
  });

  test('trigger 未知事件 / 空桶事件直接放行，不进 runner', async () => {
    captureLog(() => hookSystem.init(undefined));
    const unknown = await hookSystem.trigger('NoSuchEvent', { a: 1 });
    assert.deepEqual(unknown, { blocked: false, context: { a: 1 } });
    const empty = await hookSystem.trigger('SubAgentStart');
    assert.deepEqual(empty, { blocked: false, context: {} });
  });

  test('registerFunction 参数校验透传自注册表（坏事件/坏 handler 都抛）', () => {
    assert.throws(() => hookSystem.registerFunction('Bogus', async () => {}), /Unknown hook event/);
    assert.throws(() => hookSystem.registerFunction('Stop', 'nope'), /must be a function/);
    assert.equal(registry.getHooks('Stop').length, 0);
  });

  test('init 读项目级 .khy/hooks.json，command hook 入桶但不执行', () => {
    const proj = path.join(sandbox, 'proj-json');
    fs.mkdirSync(path.join(proj, 'works', 'data', 'khy'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, 'works', 'data', 'khy', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: [{ event: 'PreToolUse', command: 'echo never-run', source: 'fileHook' }] })
    );
    changeWatchEnabled = false;
    feedbackEnabled = false;
    captureLog(() => hookSystem.init(proj));
    const file = registry.getHooks('PreToolUse').find((h) => h.source === 'fileHook');
    assert.ok(file);
    assert.equal(file.type, 'command');
    assert.equal(file.command, 'echo never-run');
  });

  test('KHY_INK_TUI_ACTIVE=1 时抑制加载行，classic REPL 仍打印', () => {
    process.env.KHY_INK_TUI_ACTIVE = '1';
    let out = captureLog(() => hookSystem.init(undefined));
    assert.equal(out.includes('[Hooks] Loaded'), false);
    assert.equal(hookSystem.isInitialized(), true);
    delete process.env.KHY_INK_TUI_ACTIVE;
    out = captureLog(() => hookSystem.init(undefined));
    assert.match(out, /\[Hooks\] Loaded \d+ hook\(s\)/);
  });

  test('reload() 等价于再 init 一次（同样清空重注册，无增量语义）', async () => {
    changeWatchEnabled = false;
    feedbackEnabled = false;
    captureLog(() => hookSystem.init(undefined));
    registry.registerFunction('Stop', async () => ({ action: 'allow' }), { source: 'mine' });
    assert.ok(registry.getHooks('Stop').some((h) => h.source === 'mine'));
    const guardsBefore = guardCalls;
    captureLog(() => hookSystem.reload(undefined));
    assert.equal(registry.getHooks('Stop').some((h) => h.source === 'mine'), false, 'reload 后自定义 hook 已丢失');
    assert.equal(guardCalls, guardsBefore + 1, 'reload 重新跑了一遍守卫注册');
    assert.equal(registry.getHooks('PreToolUse').filter((h) => h.source === 'builtin:StubGuard').length, 1);
  });

  test('KNOWN-DEFECT: 守卫模块自身抛错时 init 静默当成「模块不存在」，零守卫继续跑（hookSystem.js:26-31）', () => {
    // The catch is not scoped to MODULE_NOT_FOUND: any error thrown while loading
    // or running registerBuiltinGuards is swallowed, init still marks itself
    // initialized and prints the normal "Loaded N hook(s)" line.
    const key = KEYS.guards;
    const savedEntry = require.cache[key];
    // A project config keeps registry.count > 0 so the load report branch runs.
    const proj = path.join(sandbox, 'proj-guard-explode');
    fs.mkdirSync(path.join(proj, 'works', 'data', 'khy'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, 'works', 'data', 'khy', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: [{ event: 'PreToolUse', command: 'echo never-run', source: 'fileHook' }] })
    );
    const before = registry.getHooks('PreToolUse').filter((h) => h.source === 'builtin:StubGuard').length;
    require.cache[key] = {
      id: key,
      filename: key,
      loaded: true,
      get exports() {
        throw new Error('guard module exploded');
      },
    };
    let warned = '';
    const realWarn = console.warn;
    const realErr = console.error;
    console.warn = (...a) => { warned += a.join(' '); };
    console.error = (...a) => { warned += a.join(' '); };
    try {
      const out = captureLog(() => hookSystem.init(proj));
      assert.equal(hookSystem.isInitialized(), true);
      assert.equal(warned, '', '这里本该有告警——断言实际是零告警');
      assert.match(out, /\[Hooks\] Loaded \d+ hook\(s\)/, '照常报告加载成功');
      assert.equal(registry.getHooks('PreToolUse').filter((h) => h.source === 'builtin:StubGuard').length, 0);
      assert.equal(registry.getHooks('PreToolUse').filter((h) => h.source === 'fileHook').length, 1);
      assert.ok(before >= 1, '上一个用例确实挂过守卫');
    } finally {
      console.warn = realWarn;
      console.error = realErr;
      require.cache[key] = savedEntry;
    }
  });

  test('门面把注册表单例本身交了出去（外部可直接改写注册表真源）', async () => {
    assert.equal(hookSystem.registry, registry);
    const n = registry.getHooks('PostToolUse').length;
    registry._hooks.set('PostToolUse', [{ event: 'PostToolUse', type: 'function', handler: async () => ({ action: 'block', reason: 'injected' }), priority: 1, source: 'injected' }]);
    const res = await hookSystem.trigger('PostToolUse', {});
    assert.equal(res.blocked, true);
    registry._hooks.set('PostToolUse', []);
    assert.equal(registry.getHooks('PostToolUse').length, 0);
    assert.equal(n, 0);
  });
});
