'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox the data homes BEFORE the first require so hookSystem.init() can never
// read the real ~/.khy hooks or write inside the repo.
const savedEnv = {
  APP: process.env.KHY_APP_HOME,
  DATA: process.env.KHY_DATA_HOME,
  TP: process.env.KHY_HOOK_TOOL_PERMISSION,
  PS: process.env.KHY_HOOK_PROMPT_SECTION,
};
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b46-seams-'));
process.env.KHY_APP_HOME = path.join(sandbox, 'apphome');
process.env.KHY_DATA_HOME = path.join(sandbox, 'apphome');
fs.mkdirSync(process.env.KHY_APP_HOME, { recursive: true });

const seams = require('./hookContribSeams.js');
const hookSystem = require('./hookSystem.js');
const registry = require('./hookRegistry.js');
const runner = require('./hookRunner.js');

// The three optional collaborators of init() are stubbed: this unit is about the
// two contribution seams, not about pulling the real tool guards into a test run.
function cacheKey(rel) {
  return require.resolve(path.join(__dirname, rel));
}
const stubs = {};
function installStub(rel, exportsValue) {
  const key = cacheKey(rel);
  if (!stubs[key]) stubs[key] = require.cache[key] === undefined ? null : require.cache[key];
  require.cache[key] = { id: key, filename: key, loaded: true, exports: exportsValue };
}
installStub('../../../toolGuards', { registerBuiltinGuards() {} });
installStub('../../../changeWatchService', { isWatchEnabled: () => false, makePrePromptInjector: () => async () => ({}) });
installStub('../../../agentFeedbackService', { isEnabled: () => false, makePrePromptInjector: () => async () => ({}) });

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

// init() clears every bucket, so "reinit + register" gives each test an isolated table.
function reinit() {
  captureLog(() => hookSystem.init(undefined));
}
function resetWith(event, entries) {
  reinit();
  for (const [handler, opts] of entries) registry.registerFunction(event, handler, opts);
  return registry.getHooks(event).length;
}

function clearGates() {
  delete process.env.KHY_HOOK_TOOL_PERMISSION;
  delete process.env.KHY_HOOK_PROMPT_SECTION;
}

after(() => {
  for (const key of Object.keys(stubs)) {
    if (stubs[key]) require.cache[key] = stubs[key];
    else delete require.cache[key];
  }
  for (const [k, v] of [['KHY_APP_HOME', savedEnv.APP], ['KHY_DATA_HOME', savedEnv.DATA], ['KHY_HOOK_TOOL_PERMISSION', savedEnv.TP], ['KHY_HOOK_PROMPT_SECTION', savedEnv.PS]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('hookContribSeams — tighten 格与两个注册点', () => {
  test('未 init 时两个接缝都是纯短路：返回基线 / 空串，一个字节的 hook 都不跑', async () => {
    clearGates();
    assert.equal(hookSystem.isInitialized(), false);
    let ran = 0;
    registry.registerFunction('ToolPermission', async () => { ran += 1; return { action: 'block' }; }, { source: 'not-yet' });
    assert.equal(registry.getHooks('ToolPermission').length, 1, 'hook 确实在桶里');
    assert.equal(await seams.applyToolPermissionHooks('auto', { toolName: 'Bash' }), 'auto');
    assert.equal(await seams.applyToolPermissionHooks('confirm', { toolName: 'Bash' }), 'confirm');
    assert.equal(await seams.collectPromptSections({ prompt: 'hi' }), '');
    assert.equal(ran, 0, '未 init 时 handler 一次都不该跑');
    captureLog(() => hookSystem.init(undefined));
  });

  test('tighten 取格上更严者：四个方向都严格，且幂等', () => {
    assert.equal(seams.tighten('auto', 'confirm'), 'confirm');
    assert.equal(seams.tighten('confirm', 'auto'), 'confirm');
    assert.equal(seams.tighten('auto', 'deny'), 'deny');
    assert.equal(seams.tighten('deny', 'auto'), 'deny');
    assert.equal(seams.tighten('confirm', 'deny'), 'deny');
    assert.equal(seams.tighten('deny', 'confirm'), 'deny');
    for (const s of ['auto', 'confirm', 'deny']) {
      assert.equal(seams.tighten(s, s), s);
      assert.equal(seams.tighten(s, undefined), s);
    }
  });

  test('tighten 对未知提议不表态：null / 空串 / 数字 / 对象 / 原型键 / 大小写全部回落基线', () => {
    const junk = [undefined, null, '', 0, -1, NaN, 42, true, false, {}, [], () => {}, 'constructor', '__proto__', 'toString', 'AUTO', 'Deny', ' deny', 'deny ', 'hasOwnProperty'];
    for (const j of junk) {
      assert.equal(seams.tighten('confirm', j), 'confirm', `提议 ${String(j)} 不该改变基线`);
    }
    // 未知基线 + 未知提议 → 原样返回基线（两侧都不认识时不凭空造裁决）
    assert.equal(seams.tighten('bogus', 'alsobogus'), 'bogus');
    assert.equal(seams.tighten(undefined, {}), undefined);
    // 对象提议会走 indexOf 引用比较，带 toString 伪装的字符串仍算未知
    assert.equal(seams.tighten('auto', { toString: () => 'deny' }), 'auto');
  });

  test('KNOWN-DEFECT: 基线裁决不被格认识时 tighten 反向放松，handler 能把 Deny 降成 auto（hookContribSeams.js:67-69）', async () => {
    // Doc contract: "handler 永远无法把裁决放松". The `bi < 0` branch returns the
    // proposed value whenever the BASELINE is unrecognized, so a typo'd / third-party
    // policy string ("Deny", "ask", "prompt") is silently downgraded to the guard's
    // own proposal. A hook that says 'auto' therefore beats an unknown-but-stricter
    // baseline — authorization relaxation.
    assert.equal(seams.tighten('Deny', 'auto'), 'auto', '大写 D 的基线被降到 auto');
    assert.equal(seams.tighten('ask', 'auto'), 'auto');
    assert.equal(seams.tighten(undefined, 'auto'), 'auto');
    assert.equal(seams.tighten('prompt', 'confirm'), 'confirm');
    clearGates();
    resetWith('ToolPermission', [
      [async () => ({ action: 'modify', decision: 'auto' }), { source: 'relaxer', priority: 1 }],
    ]);
    assert.equal(await seams.applyToolPermissionHooks('Deny', { toolName: 'Bash' }), 'auto', '真链路同样被放松');
  });

  test('门控：四个 CANON 关词（含大小写 / 空白）逐一短路，返回基线且 handler 零执行', async () => {
    clearGates();
    resetWith('ToolPermission', [
      [async () => ({ action: 'block' }), { source: 'guard', priority: 1 }],
    ]);
    for (const word of ['0', 'false', 'off', 'no', 'OFF', 'False', ' off ']) {
      process.env.KHY_HOOK_TOOL_PERMISSION = word;
      assert.equal(await seams.applyToolPermissionHooks('confirm', { toolName: 'Bash' }), 'confirm', `关词 ${word} 应短路`);
    }
    delete process.env.KHY_HOOK_TOOL_PERMISSION;
    // Sanity: with the gate on the very same hook does tighten the answer.
    assert.equal(await seams.applyToolPermissionHooks('confirm', { toolName: 'Bash' }), 'deny');
  });

  test('门控：垃圾值 / 空串 / 未设一律按默认开继续触发（default-on 语义）', async () => {
    clearGates();
    resetWith('ToolPermission', [
      [async () => ({ action: 'block' }), { source: 'guard', priority: 1 }],
    ]);
    for (const v of ['nope', '', '1', 'true', 'yes', 'disable']) {
      process.env.KHY_HOOK_TOOL_PERMISSION = v;
      assert.equal(await seams.applyToolPermissionHooks('auto', { toolName: 'Bash' }), 'deny', `${v} 不算关词，接缝应继续生效`);
    }
    delete process.env.KHY_HOOK_TOOL_PERMISSION;
  });

  test('handler block → 收紧到格上最严者，基线已更严时不变', async () => {
    clearGates();
    for (const base of ['auto', 'confirm', 'deny']) {
      resetWith('ToolPermission', [[async () => ({ action: 'block', reason: 'nope' }), { source: 'blk', priority: 1 }]]);
      assert.equal(await seams.applyToolPermissionHooks(base, { toolName: 'Bash' }), 'deny');
    }
  });

  test('handler modify decision 参与收紧：只能升不能降', async () => {
    clearGates();
    const cases = [
      ['auto', 'confirm', 'confirm'],
      ['auto', 'deny', 'deny'],
      ['confirm', 'deny', 'deny'],
      ['confirm', 'auto', 'confirm'],
      ['deny', 'auto', 'deny'],
      ['deny', 'confirm', 'deny'],
    ];
    for (const [base, proposed, expected] of cases) {
      resetWith('ToolPermission', [
        [async () => ({ action: 'modify', decision: proposed }), { source: 'prop', priority: 1 }],
      ]);
      assert.equal(await seams.applyToolPermissionHooks(base, { toolName: 'Bash' }), expected, `${base} + ${proposed}`);
    }
  });

  test('多个 handler 的净结果与顺序无关，永远是最严者', async () => {
    clearGates();
    resetWith('ToolPermission', [
      [async () => ({ action: 'modify', decision: 'auto' }), { source: 'lenient', priority: 1 }],
      [async () => ({ action: 'block' }), { source: 'strict', priority: 2 }],
      [async () => ({ action: 'modify', decision: 'confirm' }), { source: 'mid', priority: 3 }],
    ]);
    assert.equal(await seams.applyToolPermissionHooks('auto', { toolName: 'Bash' }), 'deny');
    // block 会短路后续 handler：把 block 放最前，后面的 confirm 提议不再有机会（仍是 deny）
    resetWith('ToolPermission', [
      [async () => ({ action: 'block' }), { source: 'strict', priority: 1 }],
      [async () => ({ action: 'modify', decision: 'auto' }), { source: 'lenient', priority: 2 }],
    ]);
    assert.equal(await seams.applyToolPermissionHooks('confirm', { toolName: 'Bash' }), 'deny');
  });

  test('handler 返回垃圾（undefined / 字符串 / 数组 / 非字符串 decision）→ 基线原样', async () => {
    clearGates();
    const junkReturns = [undefined, null, 'deny', 42, [], ['deny'], {}, { action: 'deny' }, { action: 'modify' }, { action: 'modify', decision: 42 }, { action: 'modify', decision: { toString: () => 'deny' } }, { action: 'modify', decision: '' }, { action: 'modify', decision: 'constructor' }, { action: 'modify', decision: '__proto__' }];
    for (const ret of junkReturns) {
      resetWith('ToolPermission', [[async () => ret, { source: 'junk', priority: 1 }]]);
      assert.equal(await seams.applyToolPermissionHooks('confirm', { toolName: 'Bash' }), 'confirm', `${JSON.stringify(ret)} 不该改变裁决`);
    }
  });

  test('触发上下文原样交给 handler，ToolPermission 与 PromptSection 两桶互不串味', async () => {
    clearGates();
    let seen = null;
    reinit();
    registry.registerFunction('ToolPermission', async (ctx) => { seen = ctx; return; }, { source: 'spy', priority: 1 });
    registry.registerFunction('PromptSection', async () => ({ action: 'modify', section: '来自插件的一段' }), { source: 'ps', priority: 1 });
    assert.equal(registry.getHooks('ToolPermission').map((h) => h.source).join(','), 'spy');
    assert.equal(registry.getHooks('PromptSection').map((h) => h.source).join(','), 'ps');
    const base = { toolName: 'write_file', params: { p: 1 }, category: 'fs', isReadOnly: false };
    await seams.applyToolPermissionHooks('auto', base);
    assert.equal(seen.toolName, 'write_file');
    assert.equal(seen.category, 'fs');
    assert.deepEqual(seen.params, { p: 1 });
    assert.equal(seen.decision, undefined, '基线裁决不进 context（seam 只在返回值上用）');
    assert.equal(await seams.collectPromptSections({ prompt: 'q' }), '来自插件的一段');
  });

  test('collectPromptSections：sections 数组按空行拼接，trim 后丢空串与非字符串', async () => {
    clearGates();
    resetWith('PromptSection', [
      [async () => ({ action: 'modify', sections: ['  第一段  ', '', '   ', '第二段', null, 42, {}, ['嵌套'], 'constructor', '__proto__', 'toString' ] }), { source: 'multi', priority: 1 }],
    ]);
    assert.equal(await seams.collectPromptSections({}), '第一段\n\n第二段\n\nconstructor\n\n__proto__\n\ntoString');
    resetWith('PromptSection', [[async () => ({ action: 'modify', sections: [] }), { source: 'empty', priority: 1 }]]);
    assert.equal(await seams.collectPromptSections({}), '');
    resetWith('PromptSection', [[async () => ({ action: 'modify', sections: ['   ', ''] }), { source: 'blank', priority: 1 }]]);
    assert.equal(await seams.collectPromptSections({}), '', '全空白 → 空串而不是换行分隔符');
  });

  test('collectPromptSections：单数 section 也收；sections 与 section 同时给时只取 sections', async () => {
    clearGates();
    resetWith('PromptSection', [[async () => ({ action: 'modify', section: '  只有一段  ' }), { source: 'one', priority: 1 }]]);
    assert.equal(await seams.collectPromptSections({}), '只有一段');
    resetWith('PromptSection', [[async () => ({ action: 'modify', section: 0 }), { source: 'zero', priority: 1 }]]);
    assert.equal(await seams.collectPromptSections({}), '', 'section=0 非字符串，丢弃');
    resetWith('PromptSection', [[async () => ({ action: 'modify', sections: ['A'], section: 'B' }), { source: 'both', priority: 1 }]]);
    assert.equal(await seams.collectPromptSections({}), 'A', 'section 被 sections 覆盖');
    resetWith('PromptSection', [[async () => ({ action: 'block' }), { source: 'blk', priority: 1 }]]);
    assert.equal(await seams.collectPromptSections({}), '', 'block 不带 section → 空串');
  });

  test('KNOWN-DEFECT: sections 给成字符串时整段提示词静默丢失（hookContribSeams.js:152-156）', async () => {
    // `Array.isArray(ctx.sections) ? ... : ctx.section !== undefined ? [ctx.section] : []`
    // — a handler that contributes a string under the plural key is dropped entirely
    // (it is not `section`, and a string is not an array), and the caller cannot tell
    // "插件贡献了内容" from "插件什么都没贡献".
    clearGates();
    resetWith('PromptSection', [[async () => ({ action: 'modify', sections: '重要安全提示：不要删库' }), { source: 'str-sections', priority: 1 }]]);
    assert.equal(await seams.collectPromptSections({ prompt: 'q' }), '', '实际行为：整段文本消失');
    assert.equal(registry.getHooks('PromptSection').length, 1, 'hook 确实注册且被执行过');
  });

  test('KNOWN-DEFECT: handler 崩溃时接缝返回基线，失败信号既不到调用方也不进遥测（hookContribSeams.js:125-128 / hookRunner.js:146 / 285-290）', async () => {
    // RUNTIME-010 forbids fail-open in authorization parsing. Here the permission
    // guard throws, _runFunctionHook converts that into `allow` + an error string,
    // safeRunHook records only `action` (the error text is dropped), the seam sees no
    // decision and returns the baseline 'auto' — identical, byte for byte, to "no
    // guard was registered". Nothing anywhere tells the caller a guard exploded.
    clearGates();
    runner._hookMetrics.length = 0;
    resetWith('ToolPermission', [
      [async () => { throw new Error('guard exploded'); }, { source: 'crasher', priority: 1 }],
    ]);
    assert.equal(await seams.applyToolPermissionHooks('auto', { toolName: 'Bash' }), 'auto', '崩溃的守卫等于没有守卫');
    const metrics = runner.getHookMetrics();
    const rec = metrics[metrics.length - 1];
    assert.equal(rec.hookSource, 'crasher');
    assert.equal(rec.event, 'ToolPermission');
    assert.equal(rec.action, 'allow', '遥测把崩溃记成一次正常 allow');
    assert.equal('error' in rec, false, '崩溃文本连遥测都没进');
    // The error string does exist one layer down — proof that the information was
    // available and thrown away rather than unknowable.
    const direct = await runner.safeRunHook({
      type: 'function',
      event: 'ToolPermission',
      source: 'probe',
      handler: async () => { throw new Error('guard exploded'); },
    }, { toolName: 'Bash' });
    assert.equal(direct.action, 'allow');
    assert.equal(direct.error, 'guard exploded');
    const rec2 = runner.getHookMetrics()[runner.getHookMetrics().length - 1];
    assert.equal('error' in rec2, false, '同一份 error 在 metric 里再次消失');
  });

  test('PromptSection handler 崩溃 / 抛 Promise.reject 同样静默返回空串，且 handler 崩不改写 context', async () => {
    clearGates();
    runner._hookMetrics.length = 0;
    resetWith('PromptSection', [
      [async () => { throw new Error('boom'); }, { source: 'crash-ps', priority: 1 }],
      [async () => ({ action: 'modify', section: '后半段仍会追加' }), { source: 'ok-ps', priority: 2 }],
    ]);
    assert.equal(await seams.collectPromptSections({ prompt: 'orig' }), '后半段仍会追加');
    const ok = runner.getHookMetrics().some((m) => m.hookSource === 'crash-ps' && m.action === 'allow');
    assert.equal(ok, true, '崩溃记录只存在于遥测');
  });

  test('垃圾入参一律不抛：null / undefined / 数字基线，以及 null context 的真实走向', async () => {
    clearGates();
    resetWith('ToolPermission', []);
    assert.equal(await seams.applyToolPermissionHooks(undefined, undefined), undefined);
    assert.equal(await seams.applyToolPermissionHooks(null, {}), null);
    assert.equal(await seams.applyToolPermissionHooks(42, { toolName: 'Bash' }), 42);
    assert.equal(await seams.applyToolPermissionHooks('auto'), 'auto');
    assert.equal(await seams.applyToolPermissionHooks('auto', null), 'auto');
    // null context survives getHooks while the hook has no pattern, and reaches
    // runHooks where `{...null}` silently erases it — the handler sees an empty object.
    let saw = 'unset';
    resetWith('PromptSection', [[async (ctx) => { saw = ctx; return { action: 'modify', section: 'S' }; }, { source: 's', priority: 1 }]]);
    assert.equal(await seams.collectPromptSections(null), 'S');
    assert.deepEqual(saw, {}, 'null context 在 runner 里被摊成 {}，调用方的字段全丢');
    assert.equal(await seams.collectPromptSections(), 'S');
    assert.equal(await seams.collectPromptSections(0), 'S');
    // With a pattern hook the same null context blows up on `context.toolName`
    // (hookRegistry.js:178) and the seam swallows it to an empty string.
    resetWith('PromptSection', [[async () => ({ action: 'modify', section: 'S2' }), { source: 'pat', pattern: 'Bash', priority: 1 }]]);
    assert.equal(await seams.collectPromptSections({ toolName: 'Bash' }), 'S2');
    assert.equal(await seams.collectPromptSections(null), '', 'pattern hook 遇 null context 抛 TypeError，被接缝静默吞成空串');
    assert.equal(await seams.collectPromptSections(0), '', '数字 context 匹配不上 pattern，内容静默丢失');
  });

  test('两个接缝的事件名与门控名都是导出常量，且真源注册表认得这两个事件', () => {
    assert.equal(seams.EVENT_TOOL_PERMISSION, 'ToolPermission');
    assert.equal(seams.EVENT_PROMPT_SECTION, 'PromptSection');
    assert.equal(seams.GATE_TOOL_PERMISSION, 'KHY_HOOK_TOOL_PERMISSION');
    assert.equal(seams.GATE_PROMPT_SECTION, 'KHY_HOOK_PROMPT_SECTION');
    assert.equal(typeof seams.applyToolPermissionHooks, 'function');
    assert.equal(typeof seams.collectPromptSections, 'function');
    assert.deepEqual(registry.events.filter((e) => e === 'ToolPermission' || e === 'PromptSection'), ['ToolPermission', 'PromptSection']);
  });
});
