'use strict';

/**
 * semanticProjection 契约层单测（DESIGN-ARCH-176 §11 ③）。
 *
 * ★ 本层在 2026-10-02 被降级为「契约定义」——桌面端已有完整状态真源
 *   （`renderer/state/toolExecutionSlice.ts` 5 态 + history，`renderer/App.tsx:400-457`
 *   已接线），聚合能力会构成**第二份状态真源**，已删除。
 *
 * 保留并重点钉住的四件事：
 *  1. ★ 两端 `onToolResult` 参数顺序不同（TUI `(name,result,params)` vs
 *     host `(name,params,result,...)`）—— 猜错就数据错位
 *  2. ★ `id` 缺失必须是 `null`，**不能回落 name** —— 并行同名工具会张冠李戴
 *     （依据 `App.tsx:398-399` 的既有判断）
 *  3. 状态/角色用**值集合**校验，不是拿值查键
 *  4. 纯叶子铁律：不改入参、不抛、零 env
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sp = require('../src/services/semanticProjection.js');

// ── 契约边界：不该再有聚合层 ─────────────────────────────────────

test('★ 契约层不导出聚合函数（避免第二份状态真源）', () => {
  for (const gone of ['createProjection', 'appendMessage', 'upsertToolCall', 'withUsage']) {
    assert.ok(!(gone in sp), `不该导出 ${gone}（桌面端 toolExecutionSlice 已是状态真源）`);
  }
  // 保留的是「形状 + 转换 + 校验」
  for (const keep of ['toolCall', 'toolResultFromTui', 'toolResultFromHost', 'message', 'usage', 'approval']) {
    assert.ok(keep in sp, `应保留 ${keep}`);
  }
});

// ── ★ id 配对：防张冠李戴 ───────────────────────────────────────

test('★ id 缺失必须是 null，绝不回落 name（并行同名工具会错配）', () => {
  // 依据 apps/khyos-desktop/src/renderer/App.tsx:398-399：
  //   「callId 由 host 侧按同名 FIFO 配对…不按工具名找 —— 并行同名工具会张冠李戴」
  assert.strictEqual(sp.toolCall({ name: 'Bash' }).id, null, 'id 缺失应为 null');
  assert.strictEqual(sp.toolCall({ name: 'Bash', id: '' }).id, null, '空串 id 应为 null');
  assert.strictEqual(sp.toolCall({ name: 'Bash', id: null }).id, null);
  assert.strictEqual(sp.toolCall({ name: 'Bash', id: 'call_1' }).id, 'call_1', '给了就用');
  // name 仍作标签保留（只是不能当身份）
  assert.strictEqual(sp.toolCall({ name: 'Bash' }).name, 'Bash');
});

test('★ 两个同名调用不会因缺 id 而被混同', () => {
  const a = sp.toolCall({ name: 'Bash' });
  const b = sp.toolCall({ name: 'Bash' });
  // 两者都「未配对」——消费方能据此识别出「需要等 callId」，
  // 而不会误以为它们是同一个调用。
  assert.strictEqual(a.id, null);
  assert.strictEqual(b.id, null);
  // 给了 callId 之后就能区分
  const a2 = sp.toolCall({ id: 'call_1', name: 'Bash' });
  const b2 = sp.toolCall({ id: 'call_2', name: 'Bash' });
  assert.notStrictEqual(a2.id, b2.id);
});

// ── ★ 两端参数顺序：核心防线 ─────────────────────────────────────

test('★ host 形态 (name, params, result, iter, elapsed)：input/result 不串位', () => {
  // 依据 apps/khyos-desktop/src/host/index.ts:430
  const node = sp.toolResultFromHost('Bash', { cmd: 'ls' }, { stdout: 'a.txt' }, 2, 1500, { id: 'c1' });
  assert.strictEqual(node.id, 'c1');
  assert.deepStrictEqual(node.input, { cmd: 'ls' }, 'input 应是第 2 参 params');
  assert.deepStrictEqual(node.output, { stdout: 'a.txt' }, 'output 应是第 3 参 toolResult');
  assert.strictEqual(node.iteration, 2);
  assert.strictEqual(node.elapsedMs, 1500);
});

test('★ TUI 形态 (name, result, params)：input/result 不串位', () => {
  // 依据 services/backend/src/cli/replSession.js:11137 —— ⚠ 第 2 参是 **result**
  const node = sp.toolResultFromTui('Bash', { success: true, stdout: 'x' }, { cmd: 'pwd' }, { id: 'c1' });
  assert.deepStrictEqual(node.output, { success: true, stdout: 'x' }, 'output 应是第 2 参 result');
  assert.deepStrictEqual(node.input, { cmd: 'pwd' }, 'input 应是第 3 参 params');
});

test('★ 两端对同一逻辑调用产出「语义相同」的节点（仅字段齐全度不同）', () => {
  const h = sp.toolResultFromHost('Bash', { cmd: 'ls' }, { ok: true }, 1, 900, { id: 'c1' });
  const t = sp.toolResultFromTui('Bash', { ok: true }, { cmd: 'ls' }, { id: 'c1' });
  assert.strictEqual(h.id, t.id);
  assert.strictEqual(h.name, t.name);
  assert.strictEqual(h.status, t.status);
  assert.deepStrictEqual(h.input, t.input);
  assert.deepStrictEqual(h.output, t.output);
  // TUI 侧不传 iteration/elapsed ⇒ 保持 null（不臆造 0）
  assert.strictEqual(t.iteration, null);
  assert.strictEqual(t.elapsedMs, null);
});

test('两端入口在 id 缺失时都返 null id（不留隐患）', () => {
  assert.strictEqual(sp.toolResultFromHost('Bash', {}, {}).id, null);
  assert.strictEqual(sp.toolResultFromTui('Bash', {}, {}).id, null);
});

// ── 状态判定：保守 ───────────────────────────────────────────────

test('结果失败的三种信号都判为 error（denied / success:false / error 字段）', () => {
  assert.strictEqual(sp.toolResultFromHost('Bash', {}, { denied: true }).status, sp.CALL_STATUS.ERROR);
  assert.strictEqual(sp.toolResultFromHost('Bash', {}, { success: false }).status, sp.CALL_STATUS.ERROR);
  assert.strictEqual(sp.toolResultFromHost('Bash', {}, { error: 'boom' }).status, sp.CALL_STATUS.ERROR);
  assert.strictEqual(sp.toolResultFromHost('Bash', {}, { ok: false }).status, sp.CALL_STATUS.ERROR);
});

test('正常结果判为 ok；缺字段不判失败（不臆造）', () => {
  assert.strictEqual(sp.toolResultFromHost('Bash', {}, { stdout: 'x' }).status, sp.CALL_STATUS.OK);
  assert.strictEqual(sp.toolResultFromHost('Bash', {}, undefined).status, sp.CALL_STATUS.OK);
  assert.strictEqual(sp.toolResultFromHost('Bash', {}, null).status, sp.CALL_STATUS.OK);
});

test('★ 回归：状态/角色用「值集合」校验，不是拿值查键', () => {
  // E1 实施时由单测抓出：hasOwnProperty(CALL_STATUS, 'running') 恒 false
  // （键是 RUNNING，值才是 running）⇒ 合法状态全被误判 unknown。
  for (const s of ['running', 'ok', 'error', 'unknown']) {
    assert.strictEqual(sp.toolCall({ name: 'x', status: s }).status, s, `合法状态 ${s} 被误判`);
  }
  for (const s of ['weird', null, undefined, 0, '']) {
    assert.strictEqual(sp.toolCall({ name: 'x', status: s }).status, 'unknown', `${String(s)} 应归 unknown`);
  }
  for (const r of ['user', 'assistant', 'system', 'tool']) {
    assert.strictEqual(sp.message({ role: r }).role, r, `合法角色 ${r} 被误判`);
  }
  for (const r of ['robot', '', null, 'USER']) {
    const got = sp.message({ role: r }).role;
    assert.ok(sp.ROLE_VALUES.indexOf(got) >= 0, `${String(r)} 归类越界: ${got}`);
  }
  assert.deepStrictEqual([...sp.CALL_STATUS_VALUES].sort(),
    Object.values(sp.CALL_STATUS).sort(), 'CALL_STATUS_VALUES 与值不一致');
  assert.deepStrictEqual([...sp.ROLE_VALUES].sort(),
    Object.values(sp.ROLE).sort(), 'ROLE_VALUES 与值不一致');
});

// ── 不可用数值给 null 而非 0 ─────────────────────────────────────

test('★ 不可用数值给 null（「没测到」≠「真的是 0」）', () => {
  const n = sp.toolCall({ name: 'x' });
  assert.strictEqual(n.iteration, null);
  assert.strictEqual(n.elapsedMs, null);
  const u = sp.usage({});
  for (const k of ['inputTokens', 'outputTokens', 'contextUsed', 'contextTotal', 'cost']) {
    assert.strictEqual(u[k], null, `${k} 不可用应为 null`);
  }
  // 真正的 0 必须保住
  const z = sp.usage({ inputTokens: 0, outputTokens: 0 });
  assert.strictEqual(z.inputTokens, 0, '真的是 0 就该是 0');
});

test('usage 不自算百分比（除零/未知是渲染决策，不塞进数据层）', () => {
  const u = sp.usage({ inputTokens: 10, contextUsed: 0, contextTotal: 0 });
  assert.ok(!('contextPercent' in u), '不该有自算的百分比字段');
});

// ── 消息 / 审批 ──────────────────────────────────────────────────

test('消息：角色保守归类，缺 text 不抛', () => {
  assert.strictEqual(sp.message({ role: 'USER', text: 'x' }).role, 'user', '大小写归一');
  assert.strictEqual(sp.message({ role: 'assistant' }).text, '');
  assert.deepStrictEqual([...sp.message({}).toolCallIds], []);
});

test('审批节点：options 拷贝不共享引用', () => {
  const input = ['allow', 'deny'];
  const a = sp.approval({ id: 'r1', toolName: 'Bash', reason: '需授权', options: input });
  input.push('extra');
  assert.strictEqual(a.options.length, 2, '外部改动不该影响已冻结节点');
  assert.ok(Object.isFrozen(a));
});

// ── 铁律 ─────────────────────────────────────────────────────────

test('铁律：任何畸形入参都不抛', () => {
  for (const bad of [null, undefined, 0, '', [], NaN, Symbol.iterator, {}]) {
    assert.doesNotThrow(() => sp.toolCall(bad), `toolCall(${String(bad)})`);
    assert.doesNotThrow(() => sp.message(bad), `message(${String(bad)})`);
    assert.doesNotThrow(() => sp.approval(bad), `approval(${String(bad)})`);
    assert.doesNotThrow(() => sp.usage(bad), `usage(${String(bad)})`);
    assert.doesNotThrow(() => sp.toolResultFromHost(bad, bad, bad, bad, bad), 'toolResultFromHost');
    assert.doesNotThrow(() => sp.toolResultFromTui(bad, bad, bad), 'toolResultFromTui');
  }
});

test('★ 回归：数值字段喂 Symbol 不抛（Number(symbol) 会 TypeError）', () => {
  // E1 实施时由单测抓出。同一个坑在 ccThemeBg.js 也踩过一次 ——
  // 「纯叶子绝不抛」是**每个叶子各自**要守的纪律，不是一次修完就全局生效。
  assert.doesNotThrow(() => sp.toolCall({ iteration: Symbol.iterator }));
  assert.doesNotThrow(() => sp.toolCall({ elapsedMs: Symbol.iterator }));
  assert.doesNotThrow(() => sp.message({ ts: Symbol.iterator }));
  assert.doesNotThrow(() => sp.usage({ inputTokens: Symbol.iterator }));
  assert.doesNotThrow(() => sp.toolResultFromHost('B', {}, {}, Symbol.iterator, Symbol.iterator));
  assert.strictEqual(sp.toolCall({ iteration: Symbol.iterator }).iteration, null);
  assert.strictEqual(sp.usage({ inputTokens: Symbol.iterator }).inputTokens, null);
});

test('铁律：不改入参（input/output 原样透传）', () => {
  const input = { cmd: 'ls', nested: { a: 1 } };
  const output = { stdout: 'x' };
  const sIn = JSON.stringify(input);
  const sOut = JSON.stringify(output);
  const n = sp.toolResultFromHost('Bash', input, output);
  assert.strictEqual(JSON.stringify(input), sIn, 'input 被改了');
  assert.strictEqual(JSON.stringify(output), sOut, 'output 被改了');
  assert.strictEqual(n.input, input, 'input 应引用透传而非深拷贝');
});

test('铁律：节点被冻结（消费方改不动）', () => {
  for (const n of [sp.toolCall({ name: 'x' }), sp.message({}), sp.approval({}), sp.usage({})]) {
    assert.ok(Object.isFrozen(n), '节点应被冻结');
  }
});

test('铁律：源码零 process.env / 零 IO', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/services/semanticProjection.js'), 'utf8');
  assert.strictEqual((src.match(/process\.env/g) || []).length, 0, '不该读 env');
  for (const forbidden of ["require('fs')", 'require("fs")', "require('net')", "require('child_process')"]) {
    assert.ok(!src.includes(forbidden), `纯叶子不该 ${forbidden}`);
  }
});

test('★ 模型不含输入框/光标/viewport（输入框问题从定义上消失）', () => {
  // 176 §6.3 的核心设计约束：这些是两端 UI 的差异，塞进数据层会固化成契约。
  //
  // ⚠ 注意区分：**`input` 作为「工具入参」是核心数据，必须有**；
  //   要禁的是「输入框 UI 状态」—— prompt / cursor / viewport / composerValue 之类。
  //   把两者混为一谈会写出错误的守卫（本次实施时踩到）。
  const UI_ONLY = ['prompt', 'cursor', 'viewport', 'scroll', 'columns', 'rows',
    'focus', 'composerValue', 'selection', 'inputValue', 'draft'];
  const m = sp.message({ role: 'user', text: 'hi' });
  const c = sp.toolCall({ id: 'x', name: 'Bash' });
  const u = sp.usage({});
  const a = sp.approval({});
  for (const forbidden of UI_ONLY) {
    assert.ok(!(forbidden in m), `message 不该含 ${forbidden}`);
    assert.ok(!(forbidden in c), `toolCall 不该含 ${forbidden}`);
    assert.ok(!(forbidden in u), `usage 不该含 ${forbidden}`);
    assert.ok(!(forbidden in a), `approval 不该含 ${forbidden}`);
  }
  // 正向确认：工具入参（数据）确实在
  assert.ok('input' in c, 'toolCall 应含 input（工具入参是核心数据，不是 UI 状态）');
});
