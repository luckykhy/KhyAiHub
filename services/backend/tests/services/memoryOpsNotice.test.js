'use strict';

/**
 * Unit tests for memoryOpsNotice.js — the "写记忆 / 召回记忆 明确告知用户" renderer
 * (pure leaf). Uses node:test (run via `node --test`), never jest.
 *
 * Covers:
 *   - formatWriteNotice: disk-persist / in-session(ephemeral) / already-exists(skip)
 *     wording; silent on non-memory kind / non-success / missing name / malformed;
 *     type-label mapping incl. unknown-type fallback.
 *   - formatRecallNotice: Set/Array input, name cap + 「等 N 条」tail, .md stripping,
 *     silent on empty / non-iterable.
 *   - gate KHY_MEMORY_NOTICE: {0,false,off,no} ⇒ both return '' (byte-revert), and
 *     default-on / unrelated values ⇒ enabled.
 *   - never throws on adversarial input.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const NOTICE = require('../../src/services/memoryOpsNotice');

/** Run body with KHY_MEMORY_NOTICE forced to `val` (undefined ⇒ unset), then restore. */
function withGate(val, fn) {
  const prev = process.env.KHY_MEMORY_NOTICE;
  if (val === undefined) delete process.env.KHY_MEMORY_NOTICE;
  else process.env.KHY_MEMORY_NOTICE = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.KHY_MEMORY_NOTICE;
    else process.env.KHY_MEMORY_NOTICE = prev;
  }
}

// ── formatWriteNotice ───────────────────────────────────────────────────────

test('write: disk-persist ⇒ 已落盘 + type label + name', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: 'user-name', type: 'user', action: 'write' });
    assert.match(s, /已写入/);
    assert.match(s, /身份/);       // user → 身份
    assert.match(s, /已落盘/);
    assert.match(s, /user-name/);
  });
});

test('write: ephemeral ⇒ 本会话 (not 已落盘)', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: 'foo', type: 'project', ephemeral: true, action: 'write' });
    assert.match(s, /本会话/);
    assert.ok(!s.includes('已落盘'), 'ephemeral must not claim 已落盘');
    assert.match(s, /项目/);       // project → 项目
  });
});

test('write: skip / skip-duplicate ⇒ 已存在（未重复写入），never claims new write', () => {
  withGate(undefined, () => {
    for (const action of ['skip', 'skip-duplicate']) {
      const s = NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: 'foo', type: 'feedback', action });
      assert.match(s, /已存在/);
      assert.ok(!s.includes('已写入'), `action=${action} must not claim 已写入`);
    }
  });
});

test('write: unknown type ⇒ generic 记忆 label (never throws)', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: 'x', type: 'zzz-unknown', action: 'write' });
    assert.match(s, /记忆/);
    assert.match(s, /x/);
  });
});

test('write: silent (empty) on instruction kind / non-success / missing name / malformed', () => {
  withGate(undefined, () => {
    assert.strictEqual(NOTICE.formatWriteNotice({ kind: 'instruction', success: true, name: 'x' }), '');
    assert.strictEqual(NOTICE.formatWriteNotice({ kind: 'memory', success: false, name: 'x' }), '');
    assert.strictEqual(NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: '   ', type: 'user' }), '');
    assert.strictEqual(NOTICE.formatWriteNotice(null), '');
    assert.strictEqual(NOTICE.formatWriteNotice(true), '');       // bare boolean (legacy)
    assert.strictEqual(NOTICE.formatWriteNotice(undefined), '');
    assert.strictEqual(NOTICE.formatWriteNotice(42), '');
  });
});

// ── formatRecallNotice ──────────────────────────────────────────────────────

test('recall: Set input ⇒ count + names, .md stripped', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatRecallNotice(new Set(['a.md', 'b.md']));
    assert.match(s, /召回 2 条/);
    assert.match(s, /a、b/);
    assert.ok(!s.includes('.md'), '.md extension must be stripped');
  });
});

test('recall: over cap ⇒ first N names + 「等 N 条」tail', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatRecallNotice(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
    assert.match(s, /召回 5 条/);
    assert.match(s, /等 5 条/);
    assert.ok(!s.includes('d'), 'names beyond the cap must not be listed individually');
  });
});

test('recall: silent (empty) on empty / non-iterable / all-blank', () => {
  withGate(undefined, () => {
    assert.strictEqual(NOTICE.formatRecallNotice([]), '');
    assert.strictEqual(NOTICE.formatRecallNotice(new Set()), '');
    assert.strictEqual(NOTICE.formatRecallNotice(null), '');
    assert.strictEqual(NOTICE.formatRecallNotice(42), '');
    assert.strictEqual(NOTICE.formatRecallNotice(['', '  ', '.md']), '');
  });
});

// ── gate KHY_MEMORY_NOTICE ──────────────────────────────────────────────────

test('gate: {0,false,off,no} ⇒ both return empty string (byte-revert to silent)', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    withGate(off, () => {
      assert.strictEqual(NOTICE.formatWriteNotice({ kind: 'memory', success: true, name: 'x', type: 'user', action: 'write' }), '', `write gate ${off}`);
      assert.strictEqual(NOTICE.formatRecallNotice(['a.md']), '', `recall gate ${off}`);
      assert.strictEqual(NOTICE.isNoticeEnabled(), false, `isNoticeEnabled ${off}`);
    });
  }
});

test('gate: default-on (unset) and unrelated values ⇒ enabled', () => {
  withGate(undefined, () => assert.strictEqual(NOTICE.isNoticeEnabled(), true));
  withGate('1', () => assert.strictEqual(NOTICE.isNoticeEnabled(), true));
  withGate('yes', () => assert.strictEqual(NOTICE.isNoticeEnabled(), true));
});

test('never throws on adversarial input', () => {
  const bad = [null, undefined, 42, 'str', {}, [], { name: {} }, { kind: 'memory', success: true, name: 123 }];
  for (const b of bad) {
    assert.doesNotThrow(() => NOTICE.formatWriteNotice(b));
    assert.doesNotThrow(() => NOTICE.formatRecallNotice(b));
  }
});

// ── [DESIGN-MEM-008] deriveIntentClause：「用以完成什么」的确定性派生 ─────────

test('intent: 4 类型各自的子句', () => {
  assert.strictEqual(NOTICE.deriveIntentClause({ types: ['project'] }), '为了对齐项目约定');
  assert.strictEqual(NOTICE.deriveIntentClause({ types: ['reference'] }), '为了查证外部资料');
  assert.strictEqual(NOTICE.deriveIntentClause({ types: ['feedback'] }), '为了遵守你此前给过的协作偏好');
  assert.strictEqual(NOTICE.deriveIntentClause({ types: ['user'] }), '为了沿用你的既有设定');
});

test('intent: 混合取「首个命中型」（不重排、不取最新）', () => {
  assert.strictEqual(NOTICE.deriveIntentClause({ types: ['project', 'user'] }), '为了对齐项目约定');
  assert.strictEqual(NOTICE.deriveIntentClause({ types: ['user', 'project'] }), '为了沿用你的既有设定');
});

test('intent: 前项未知 ⇒ 跳到次项；全未知 / 无 ctx / 非数组 ⇒ 省略（不编造）', () => {
  assert.strictEqual(NOTICE.deriveIntentClause({ types: ['mystery', 'user'] }), '为了沿用你的既有设定');
  assert.strictEqual(NOTICE.deriveIntentClause({ types: ['mystery', ''] }), '');
  assert.strictEqual(NOTICE.deriveIntentClause({ types: [] }), '');
  assert.strictEqual(NOTICE.deriveIntentClause(undefined), '');
  assert.strictEqual(NOTICE.deriveIntentClause(null), '');
  assert.strictEqual(NOTICE.deriveIntentClause({ types: 'not-an-array' }), '');
  assert.strictEqual(NOTICE.deriveIntentClause('nope'), '');
});

test('intent: 大小写与首尾空白归一', () => {
  assert.strictEqual(NOTICE.deriveIntentClause({ types: [' Feedback '] }), '为了遵守你此前给过的协作偏好');
});

// ── [DESIGN-MEM-008] formatRecallNotice(filenames, ctx)：子句只插入、不改字 ──

test('recall+ctx: 子句插在「条相关记忆」与「：」之间', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatRecallNotice(new Set(['a.md', 'b.md']), { types: ['feedback'] });
    assert.strictEqual(s, '🧠 召回 2 条相关记忆（为了遵守你此前给过的协作偏好）：a、b');
  });
});

test('recall+ctx: ctx 缺省 / 全未知 ⇒ 与旧版**逐字节相等**（V4 回退）', () => {
  withGate(undefined, () => {
    // 真值断言：钉住确切的字节，而不是复刻一份实现去对比。
    assert.strictEqual(NOTICE.formatRecallNotice(new Set(['a.md', 'b.md'])), '🧠 召回 2 条相关记忆：a、b');
    assert.strictEqual(
      NOTICE.formatRecallNotice(new Set(['a.md', 'b.md']), { types: ['mystery'] }),
      '🧠 召回 2 条相关记忆：a、b'
    );
    assert.strictEqual(
      NOTICE.formatRecallNotice(new Set(['a.md', 'b.md']), undefined),
      '🧠 召回 2 条相关记忆：a、b'
    );
    // 动词必须是真源原词「召回」——改成「回忆起」会破 V4（实测踩过）。
    assert.ok(!NOTICE.formatRecallNotice(new Set(['a.md']), { types: ['user'] }).includes('回忆起'));
  });
});

test('recall+ctx: 等 N 条 tail 与子句共存', () => {
  withGate(undefined, () => {
    const s = NOTICE.formatRecallNotice(['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], { types: ['project'] });
    assert.strictEqual(s, '🧠 召回 5 条相关记忆（为了对齐项目约定）：a、b、c 等 5 条');
  });
});

// ── [DESIGN-MEM-008] formatRecallNoticePayload：带判别符，供消费点分流 ────────

test('payload: 形状 {kind,text}；kind 恒为 memory-notice', () => {
  withGate(undefined, () => {
    const p = NOTICE.formatRecallNoticePayload(new Set(['a.md']), { types: ['user'] });
    assert.strictEqual(p.kind, 'memory-notice');
    assert.strictEqual(p.text, '🧠 召回 1 条相关记忆（为了沿用你的既有设定）：a');
  });
});

test('payload: 门关 / 空召回 ⇒ null（调用方不 push、不 onStatus）', () => {
  withGate('0', () => {
    assert.strictEqual(NOTICE.formatRecallNoticePayload(new Set(['a.md'])), null);
  });
  withGate(undefined, () => {
    assert.strictEqual(NOTICE.formatRecallNoticePayload(new Set()), null);
    assert.strictEqual(NOTICE.formatRecallNoticePayload(null), null);
  });
});

// ── [DESIGN-MEM-008] §3.2.2 加固：字符串入参按单个文件名处理 ─────────────────

test('hardening: 字符串入参不被逐字符拆开', () => {
  withGate(undefined, () => {
    // 旧行为是 Array.from('bad') ⇒ '召回 3 条：b、a、d'（荒谬输出）。
    assert.strictEqual(NOTICE.formatRecallNotice('bad'), '🧠 召回 1 条相关记忆：bad');
    assert.strictEqual(NOTICE.formatRecallNotice('a.md'), '🧠 召回 1 条相关记忆：a');
  });
});

test('never throws on adversarial ctx (intent derivation is fail-soft)', () => {
  const badCtx = [null, undefined, 42, 'str', {}, [], { types: null }, { types: {} }, { types: [null, {}, 42] }];
  for (const c of badCtx) {
    assert.doesNotThrow(() => NOTICE.deriveIntentClause(c));
    assert.doesNotThrow(() => NOTICE.formatRecallNotice(['a.md'], c));
    assert.doesNotThrow(() => NOTICE.formatRecallNoticePayload(['a.md'], c));
  }
});

// ── [DESIGN-MEM-008] 召回「过程态」：与结果态配对，必须有终止符 ────────────────
// 过程态驱动 spinner 文案「正在回忆相关记忆…」，结果态播报具名文件。二者成对，
// 缺终止符 ⇒ spinner 文案永久留屏（同族教训：compacting 必须配 compacted）。

test('process: starting 载荷形状（phase/stage/message 三字段）', () => {
  withGate(undefined, () => {
    const p = NOTICE.formatRecallProcessPayload('starting');
    assert.ok(p && typeof p === 'object');
    assert.strictEqual(p.phase, 'memory-recall');
    assert.strictEqual(p.stage, 'starting');
    assert.strictEqual(p.message, NOTICE.RECALL_PROCESS_TEXT);
    // 判别符必须是 phase（而非文案前缀）⇒ 文案一改不会静默失效。
    assert.strictEqual(Object.keys(p).sort().join(','), 'message,phase,stage');
  });
});

test('process: done 是终止符（前端据此切回常规 spinner 文案）', () => {
  withGate(undefined, () => {
    const p = NOTICE.formatRecallProcessPayload('done');
    assert.strictEqual(p.stage, 'done');
    assert.strictEqual(p.phase, 'memory-recall');
    assert.strictEqual(p.message, NOTICE.RECALL_PROCESS_TEXT);
  });
});

test('process: stage 归一 —— 缺失 / 未知 / 非字符串一律当 starting（绝不漏发起点）', () => {
  withGate(undefined, () => {
    for (const s of [undefined, null, '', 'STARTING', 'whatever', 42, {}]) {
      assert.strictEqual(NOTICE.formatRecallProcessPayload(s).stage, 'starting');
    }
  });
});

test('process: 门关 ⇒ null（不 onStatus，逐字节回退到静默）', () => {
  withGate('0', () => {
    assert.strictEqual(NOTICE.formatRecallProcessPayload('starting'), null);
    assert.strictEqual(NOTICE.formatRecallProcessPayload('done'), null);
  });
  withGate('OFF', () => {
    assert.strictEqual(NOTICE.formatRecallProcessPayload('starting'), null);
  });
});

test('process: 文案诚实 —— 是进行时、且**不预告条数/文件名**（发出时还不知道会召回什么）', () => {
  const t = NOTICE.RECALL_PROCESS_TEXT;
  assert.strictEqual(typeof t, 'string');
  assert.ok(t.length > 0);
  assert.ok(t.includes('正在'), `过程态应为进行时，实际：${t}`);
  assert.ok(!/\d/.test(t), `过程态不得预告条数，实际：${t}`);
  assert.ok(!t.includes('.md'), `过程态不得预告文件名，实际：${t}`);
  // 两态文案必须可区分，否则前端/测试无法据此判断走到了哪一态。
  assert.notStrictEqual(t, NOTICE.formatRecallNotice(new Set(['a.md'])));
});

test('process: 绝不抛（任何入参）', () => {
  const bad = [undefined, null, 0, 42, '', 'x', {}, [], Symbol('s'), () => {}];
  for (const s of bad) {
    assert.doesNotThrow(() => NOTICE.formatRecallProcessPayload(s));
  }
});
