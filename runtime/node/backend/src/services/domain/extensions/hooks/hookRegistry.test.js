'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep every resolution of the data home inside os.tmpdir() so load() can never
// touch the repo or the real ~/.khy. Set before the first require so dataHome's
// memo caches the sandbox.
const savedAppHome = process.env.KHY_APP_HOME;
const savedDataHome = process.env.KHY_DATA_HOME;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-hookreg-'));
process.env.KHY_APP_HOME = path.join(sandbox, 'apphome');
process.env.KHY_DATA_HOME = path.join(sandbox, 'apphome');

const registryModule = require('./hookRegistry.js');
const { HookRegistry, HOOK_EVENTS } = registryModule;

const noop = async () => ({ action: 'allow' });

function mkProject(dirName, config) {
  const proj = path.join(sandbox, dirName);
  fs.mkdirSync(path.join(proj, 'works', 'data', 'khy'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'works', 'data', 'khy', 'hooks.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return proj;
}

describe('hookRegistry — 注册与查表', () => {
  test('events getter 交的是副本，改它不写穿 HOOK_EVENTS 真源', () => {
    const reg = new HookRegistry();
    const evs = reg.events;
    assert.equal(evs.length, HOOK_EVENTS.length);
    evs.push('Bogus');
    assert.equal(reg.events.includes('Bogus'), false);
    assert.equal(HOOK_EVENTS.includes('Bogus'), false);
  });

  test('每个合法事件都有独立空桶，count 随注册递增', () => {
    const reg = new HookRegistry();
    assert.equal(reg.count, 0);
    reg.registerFunction('PreToolUse', noop, { source: 'a' });
    assert.equal(reg.count, 1);
    assert.equal(reg.getHooks('PostToolUse').length, 0);
    assert.equal(reg.getHooks('PreToolUse').length, 1);
  });

  test('registerFunction 拒非法事件与非函数 handler（抛错并列出合法事件）', () => {
    const reg = new HookRegistry();
    assert.throws(() => reg.registerFunction('Bogus', noop), /Unknown hook event: Bogus\. Valid: /);
    assert.throws(() => reg.registerFunction('PreToolUse', 'not-fn'), /handler must be a function/);
    for (const bad of [null, undefined, 0, NaN, {}, [], '']) {
      assert.throws(() => reg.registerFunction('PreToolUse', bad));
    }
    assert.throws(() => reg.registerFunction(null, noop), /Unknown hook event/);
    assert.equal(reg.count, 0);
  });

  test('registerFunction 缺 opts 时用默认值与 programmatic 标签', () => {
    const reg = new HookRegistry();
    reg.registerFunction('Stop', noop);
    const [h] = reg.getHooks('Stop');
    assert.equal(h.source, 'programmatic');
    assert.equal(h.timeout, 10000);
    assert.equal(h.priority, 100);
    assert.equal(h.type, 'function');
    assert.equal(h.command, null);
    assert.equal(h.pattern, null);
  });

  test('pattern 编译成 RegExp 并按 toolName / prompt 过滤', () => {
    const reg = new HookRegistry();
    reg.registerFunction('PreToolUse', noop, { pattern: '^Bash$', source: 'bashOnly' });
    reg.registerFunction('PreToolUse', noop, { source: 'anyTool' });
    assert.deepEqual(reg.getHooks('PreToolUse', { toolName: 'Bash' }).map((h) => h.source), ['bashOnly', 'anyTool']);
    assert.deepEqual(reg.getHooks('PreToolUse', { toolName: 'Read' }).map((h) => h.source), ['anyTool']);
    // prompt 是 toolName 缺省时的替代目标。
    assert.deepEqual(reg.getHooks('PreToolUse', { prompt: 'Bash' }).map((h) => h.source), ['bashOnly', 'anyTool']);
    assert.deepEqual(reg.getHooks('PreToolUse', { prompt: 'Read' }).map((h) => h.source), ['anyTool']);
    // 两者都缺 → 目标为空串，带 pattern 的 hook 一律不匹配。
    assert.deepEqual(reg.getHooks('PreToolUse').map((h) => h.source), ['anyTool']);
    assert.deepEqual(reg.getHooks('PreToolUse', { toolName: null, prompt: null }).map((h) => h.source), ['anyTool']);
  });

  test('未知事件查表返回空数组（Map 查表不受原型链影响）', () => {
    const reg = new HookRegistry();
    reg.registerFunction('PreToolUse', noop, { source: 'x' });
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 0, null, undefined, {}]) {
      assert.deepEqual(reg.getHooks(k), []);
    }
  });

  test('isHookEnabled 走 Set，原型键不被误判为已禁用', () => {
    const reg = new HookRegistry();
    assert.equal(reg.isHookEnabled('constructor'), true);
    assert.equal(reg.isHookEnabled('__proto__'), true);
    assert.equal(reg.isHookEnabled('toString'), true);
    reg._disabledHooks.add('real:Hook');
    assert.equal(reg.isHookEnabled('real:Hook'), false);
    assert.equal(reg.isHookEnabled(''), true);
  });

  test('getHooks 按 priority 升序排，且不改动注册表内部顺序', () => {
    const reg = new HookRegistry();
    reg.registerFunction('PreToolUse', noop, { source: 'late', priority: 90 });
    reg.registerFunction('PreToolUse', noop, { source: 'early', priority: 10 });
    const sorted = reg.getHooks('PreToolUse').map((h) => h.source);
    assert.deepEqual(sorted, ['early', 'late']);
    // 返回的是新数组（排序不写回桶内顺序），但元素本身仍是活引用 → 见下一条。
    const again = reg.getHooks('PreToolUse');
    assert.equal(again !== reg.getHooks('PreToolUse'), true);
  });

  test('KNOWN-DEFECT: getHooks 把桶内活引用交给调用方，改一个字段就写穿注册表真源（hookRegistry.js:171-182）', () => {
    // `hooks.filter(...)` copies the array but not its elements, so a caller that
    // mutates a returned hook record rewrites the registry state for every later
    // consumer — including swapping a guard's handler.
    const reg = new HookRegistry();
    const originalHandler = async () => ({ action: 'block', reason: 'nope' });
    reg.registerFunction('PreToolUse', originalHandler, { source: 'guard', priority: 50 });
    const view = reg.getHooks('PreToolUse');
    view[0].handler = async () => ({ action: 'allow' });
    view[0].command = 'INJECTED';
    view[0].priority = -999;
    const after = reg.getHooks('PreToolUse')[0];
    assert.notEqual(after.handler, originalHandler, '真源 handler 已被调用方替换');
    assert.equal(after.command, 'INJECTED');
    assert.equal(after.priority, -999);
  });

  test('KNOWN-DEFECT: registerFunction 用 `||` 吞掉合法的 0（hookRegistry.js:162-163）', () => {
    // priority 0 is the strongest preemption the sort supports and timeout 0 means
    // "no grace"; both collapse to the defaults because `opts.priority || 100`.
    const reg = new HookRegistry();
    reg.registerFunction('PreToolUse', noop, { source: 'zero', priority: 0, timeout: 0 });
    const [h] = reg.getHooks('PreToolUse');
    assert.equal(h.priority, 100);
    assert.equal(h.timeout, 10000);
  });

  test('registerFunction 对 opts 垃圾入参全部回落到默认值', () => {
    const reg = new HookRegistry();
    reg.registerFunction('PreToolUse', noop, { priority: '5', timeout: null, pattern: undefined, source: 0 });
    const [h] = reg.getHooks('PreToolUse');
    // 非数字但 truthy 的 priority 原样入库（无类型校验），排序时按字符串参与比较。
    assert.equal(h.priority, '5');
    assert.equal(h.timeout, 10000);
    assert.equal(h.pattern, null);
    assert.equal(h.source, 'programmatic');
    reg.registerFunction('PreToolUse', noop, { priority: -1 });
    assert.equal(reg.getHooks('PreToolUse')[0].priority, -1, '负优先级无人拦截');
    assert.throws(() => reg.registerFunction('PreToolUse', noop, { pattern: '(' }), /Invalid regular expression/);
  });

  test('KNOWN-DEFECT: 没带 source 的函数 hook 完全绕过 disabled 名单（hookRegistry.js:150-153）', () => {
    // The gate reads `opts.source`; a missing label collapses to '' and `hookId &&`
    // short-circuits the check. Such a hook is registered under the label
    // 'programmatic' but disabling that label does nothing, because the gate never
    // looks at the label it just wrote — the disable key and the identity key diverge.
    const reg = new HookRegistry();
    reg._disabledHooks.add('wanted-off');
    reg.registerFunction('PreToolUse', noop, { source: 'wanted-off' });
    assert.equal(reg.count, 0);
    reg._disabledHooks.add('programmatic');
    reg.registerFunction('Stop', noop);
    const stop = reg.getHooks('Stop');
    assert.equal(stop.length, 1, '被禁标签下的 hook 仍然注册');
    assert.equal(stop[0].source, 'programmatic');
  });
});

describe('hookRegistry — load() 读配置文件', () => {
  before(() => {
    fs.mkdirSync(process.env.KHY_APP_HOME, { recursive: true });
  });

  after(() => {
    if (savedAppHome === undefined) {
      delete process.env.KHY_APP_HOME;
    } else {
      process.env.KHY_APP_HOME = savedAppHome;
    }
    if (savedDataHome === undefined) {
      delete process.env.KHY_DATA_HOME;
    } else {
      process.env.KHY_DATA_HOME = savedDataHome;
    }
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('项目级 .khy/hooks.json 里的 command hook 正常入桶并带 provenance 标签', () => {
    const proj = mkProject('p-basic', {
      version: 1,
      hooks: [
        { event: 'PreToolUse', command: 'ls', pattern: '^Bash$', timeout: 1, priority: 2, source: 'mine' },
        { event: 'Stop', command: 'echo bye' },
      ],
    });
    const reg = new HookRegistry();
    reg.load(proj);
    assert.equal(reg.count, 2);
    // The '^Bash$' pattern filters by toolName, so an empty context drops it.
    assert.deepEqual(reg.getHooks('PreToolUse').map((h) => h.source), []);
    const [pre] = reg.getHooks('PreToolUse', { toolName: 'Bash' });
    assert.equal(pre.source, 'mine');
    assert.equal(pre.type, 'command');
    assert.equal(pre.command, 'ls');
    assert.equal(pre.timeout, 1);
    assert.equal(pre.priority, 2);
    assert.ok(pre.pattern instanceof RegExp);
    // 没有自带 source 的条目退回 provenance 'project'。
    assert.equal(reg.getHooks('Stop')[0].source, 'project');
  });

  test('enabled:false 的条目不入桶；未知事件跳过；缺 command 的 command 型跳过', () => {
    const proj = mkProject('p-skip', {
      version: 1,
      hooks: [
        { event: 'Stop', command: 'x', enabled: false, source: 'off' },
        { event: 'BogusEvent', command: 'x', source: 'bogus' },
        { event: 'Stop', source: 'nocmmd' },
        { event: 'Stop', command: 'real', source: 'real' },
      ],
    });
    const reg = new HookRegistry();
    reg.load(proj);
    assert.deepEqual(reg.getHooks('Stop').map((h) => h.source), ['real']);
  });

  test('坏 JSON 文件只报一行错，不影响其他配置源（且不抛）', () => {
    const proj = mkProject('p-badjson', '{ this is not json');
    const reg = new HookRegistry();
    reg.load(proj);
    assert.equal(reg.count, 0);
  });

  test('KNOWN-DEFECT: 一条非法 hook 让同文件里它之后的所有 hook 静默消失（hookRegistry.js:73-88）', () => {
    // _register destructures `hookDef` unconditionally, so a single null element
    // throws inside the file-wide try: the whole file is abandoned with one line of
    // console.error, and the (already registered) earlier hooks stay live.
    const proj = mkProject('p-null', { version: 1, hooks: [{ event: 'Stop', command: 'first', source: 'first' }, null, { event: 'Stop', command: 'third', source: 'third' }] });
    const reg = new HookRegistry();
    reg.load(proj);
    assert.deepEqual(reg.getHooks('Stop').map((h) => h.source), ['first'], 'third 应当仍然注册');
  });

  test('KNOWN-DEFECT: 一条坏 pattern 同样掐断整份文件后续 hook（hookRegistry.js:127）', () => {
    const proj = mkProject('p-badre', { version: 1, hooks: [{ event: 'Stop', command: 'ok' }, { event: 'Stop', command: 'bad', pattern: '(' }] });
    const reg = new HookRegistry();
    reg.load(proj);
    assert.equal(reg.count, 1);
  });

  test('KNOWN-DEFECT: 文档说「项目级覆盖全局」，实际两份都注册（同名事件跑两遍）（hookRegistry.js:13 / 59-89）', () => {
    fs.writeFileSync(path.join(process.env.KHY_APP_HOME, 'hooks.json'), JSON.stringify({ version: 1, hooks: [{ event: 'PreToolUse', command: 'global-cmd', source: 'sameId' }] }));
    const proj = mkProject('p-override', { version: 1, hooks: [{ event: 'PreToolUse', command: 'project-cmd', source: 'sameId' }] });
    const reg = new HookRegistry();
    reg.load(proj);
    assert.deepEqual(reg.getHooks('PreToolUse').map((h) => h.command), ['global-cmd', 'project-cmd']);
    fs.rmSync(path.join(process.env.KHY_APP_HOME, 'hooks.json'), { force: true });
  });

  test('KNOWN-DEFECT: disabled 名单对配置文件里的 command hook 完全无效（hookRegistry.js:91-132）', () => {
    // load() fills _disabledHooks before registering, but _register never consults
    // it — only registerFunction does. The hook the user explicitly disabled is the
    // one that still runs.
    const proj = mkProject('p-disabled', {
      version: 1,
      hooks: [{ event: 'PreToolUse', command: 'rm -rf ./nowhere', source: 'dangerHook' }],
      disabled: ['dangerHook'],
    });
    const reg = new HookRegistry();
    reg.load(proj);
    assert.equal(reg.isHookEnabled('dangerHook'), false, 'disabled 名单确实收到了这个 id');
    assert.deepEqual(reg.getHooks('PreToolUse').map((h) => h.command), ['rm -rf ./nowhere'], '被禁用的 hook 仍然注册');
  });

  test('裸数组形状（无 hooks 包）同样可读；disabled 非数组被忽略', () => {
    const proj = mkProject('p-bare', [{ event: 'PostToolUse', command: 'x', source: 'bare' }]);
    const reg = new HookRegistry();
    reg.load(proj);
    assert.deepEqual(reg.getHooks('PostToolUse').map((h) => h.source), ['bare']);

    const proj2 = mkProject('p-dis-str', { version: 1, hooks: [{ event: 'PostToolUse', command: 'y', source: 'y' }], disabled: 'notAnArray' });
    const reg2 = new HookRegistry();
    reg2.load(proj2);
    assert.equal(reg2.count, 1);
  });

  test('load() 先清空既有 hook（重复 load 不累积）', () => {
    const proj = mkProject('p-clear', { version: 1, hooks: [{ event: 'Stop', command: 'x', source: 's' }] });
    const reg = new HookRegistry();
    reg.registerFunction('Stop', noop, { source: 'programmatic-one' });
    assert.equal(reg.count, 1);
    reg.load(proj);
    assert.deepEqual(reg.getHooks('Stop').map((h) => h.source), ['s']);
    reg.load(proj);
    assert.equal(reg.count, 1);
  });

  test('load() 无参只读全局源，null/undefined/空串项目目录安全跳过', () => {
    const reg = new HookRegistry();
    for (const bad of [undefined, null, 0, '', NaN]) {
      assert.doesNotThrow(() => reg.load(bad));
    }
    assert.equal(reg.count, 0);
  });

  test('KNOWN-DEFECT: load(非字符串 projectDir) 直接抛 TypeError（hookRegistry.js:67）', () => {
    // `if (projectDir)` accepts any truthy value and hands it to path.join, so an
    // object/boolean/number directory argument throws out of load() — and with it
    // out of hookSystem.init(), whose try/catch only wraps the *optional* guard
    // modules, not the registry load call.
    const reg = new HookRegistry();
    assert.throws(() => reg.load({}), /The "path" argument must be of type string/);
    assert.throws(() => reg.load(true), /must be of type string/);
    assert.throws(() => reg.load(42), /must be of type string/);
    assert.throws(() => reg.load(['a']), /must be of type string/);
  });

  test('导出的单例与类共用同一份 HOOK_EVENTS（11 事件）', () => {
    assert.equal(registryModule.HOOK_EVENTS.length, 11);
    assert.equal(typeof HookRegistry, 'function');
    assert.equal(registryModule.getHooks('constructor').length, 0);
    assert.ok(registryModule.getHooks('PreToolUse').length >= 0);
  });
});
