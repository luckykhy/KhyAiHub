'use strict';

/**
 * khyTrace.test.js — 钉死 `_khyTrace` 信封单一真源的防呆契约：
 * 枚举冻结、normalizeProducer 的 fail-safe-to-ours 方向与 producerId 优先级、
 * _normalizeTrust「外部绝不默认 verified」、isTrace 的实际判据（只看 producer+trust，
 * 不看 kind/v——当前行为如实钉住，不修正）、traceOf 的非纯函数性（每次缺失都新建信封，
 * 与模块头「纯函数、零 IO」的宣称不符）、isRelayed 对未知 producer 判 false，
 * 与 quarantinePolicy._isRelayedForExec 的 fail-CLOSED（未知→中转）刻意相反——两读并钉。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./khyTrace.js');
const quarantinePolicy = require('./quarantinePolicy.js');

const { PRODUCER, TRUST, KIND, TRACE_VERSION, makeTrace, stamp, isTrace, traceOf, isRelayed, normalizeProducer } = mod;

describe('枚举与版本常量', () => {
  test('PRODUCER/TRUST/KIND 冻结且值恰为契约枚举', () => {
    // 反空转：枚举本身非空才有「冻结」可谈
    assert.ok(Object.keys(PRODUCER).length > 0);
    assert.ok(Object.keys(TRUST).length > 0);
    assert.ok(Object.keys(KIND).length > 0);
    assert.deepStrictEqual({ ...PRODUCER }, {
      KHY_LOCAL: 'khy-local',
      CODEX: 'codex',
      CLAUDE_CODE: 'claude-code',
      RELAY: 'relay',
    });
    assert.deepStrictEqual({ ...TRUST }, {
      VERIFIED: 'verified',
      CLAIMED: 'claimed',
      QUARANTINED: 'quarantined',
    });
    assert.deepStrictEqual({ ...KIND }, {
      TEXT: 'text',
      THINKING: 'thinking',
      TOOL_CALL: 'tool_call',
      TOOL_RESULT: 'tool_result',
    });
    for (const e of [PRODUCER, TRUST, KIND]) {
      assert.ok(Object.isFrozen(e));
    }
  });

  test('严格模式下改写/新增冻结枚举成员抛 TypeError 且原值不动', () => {
    assert.throws(() => { PRODUCER.KHY_LOCAL = 'evil'; }, TypeError);
    assert.throws(() => { PRODUCER.NEW_KEY = 'x'; }, TypeError);
    assert.throws(() => { delete TRUST.VERIFIED; }, TypeError);
    assert.strictEqual(PRODUCER.KHY_LOCAL, 'khy-local');
    assert.strictEqual(TRUST.VERIFIED, 'verified');
  });

  test('TRACE_VERSION 恰为 1', () => {
    assert.strictEqual(TRACE_VERSION, 1);
  });
});

describe('normalizeProducer：fail-safe-to-ours 方向', () => {
  test('已知四枚举原样透传，producerId 缺省为 null、给值则 String 化', () => {
    for (const p of ['khy-local', 'codex', 'claude-code', 'relay']) {
      assert.deepStrictEqual(normalizeProducer(p), { producer: p, producerId: null });
    }
    assert.deepStrictEqual(normalizeProducer('codex', 'session-42'), { producer: 'codex', producerId: 'session-42' });
    // 数字 producerId 被 String 化——非字符串也强转，只要 producer 已知
    assert.deepStrictEqual(normalizeProducer('relay', 42), { producer: 'relay', producerId: '42' });
  });

  test('null/空串/undefined 一律收敛 khy-local + producerId:null，且忽略传入 producerId', () => {
    assert.deepStrictEqual(normalizeProducer(null), { producer: 'khy-local', producerId: null });
    assert.deepStrictEqual(normalizeProducer(''), { producer: 'khy-local', producerId: null });
    assert.deepStrictEqual(normalizeProducer(undefined), { producer: 'khy-local', producerId: null });
    // fail-safe 分支在 producerId 强转之前返回——即便给了 id 也一并丢弃
    assert.deepStrictEqual(normalizeProducer('', 'x'), { producer: 'khy-local', producerId: null });
    assert.deepStrictEqual(normalizeProducer(null, 'x'), { producer: 'khy-local', producerId: null });
  });

  test('未知非空 producer 坍缩 relay，producerId=raw；显式 producerId 优先于 raw 串', () => {
    assert.deepStrictEqual(normalizeProducer('mystery-agent'), { producer: 'relay', producerId: 'mystery-agent' });
    assert.deepStrictEqual(normalizeProducer('mystery-agent', 'real-id'), { producer: 'relay', producerId: 'real-id' });
    // 非字符串非空值同样走坍缩分支（typeof 检查在前，== null 检查在后）
    assert.deepStrictEqual(normalizeProducer(123), { producer: 'relay', producerId: '123' });
  });
});

describe('makeTrace：trust / kind / v / contradictions / seal / at 归一', () => {
  test('khy-local 缺/垃圾 trust → verified；任何外部 producer 缺/垃圾 trust → claimed', () => {
    assert.strictEqual(makeTrace({ producer: 'khy-local' }).trust, 'verified');
    assert.strictEqual(makeTrace({ producer: 'khy-local', trust: 'garbage' }).trust, 'verified');
    for (const p of ['codex', 'claude-code', 'relay', 'unknown-collapsed']) {
      const t = makeTrace({ producer: p });
      assert.strictEqual(t.trust, 'claimed', `外部 ${p} 缺 trust 必须 claimed`);
      assert.strictEqual(makeTrace({ producer: p, trust: '???' }).trust, 'claimed', `外部 ${p} 垃圾 trust 必须 claimed`);
    }
  });

  test('合法 trust 枚举原样透传（含外部标 verified——枚举合法即不拦，归调用方负责）', () => {
    for (const tr of Object.values(TRUST)) {
      assert.strictEqual(makeTrace({ producer: 'codex', trust: tr }).trust, tr);
    }
  });

  test('未知/非字符串 kind → text；合法 kind 透传', () => {
    assert.strictEqual(makeTrace({ kind: 'nonsense' }).kind, 'text');
    assert.strictEqual(makeTrace({ kind: 42 }).kind, 'text');
    assert.strictEqual(makeTrace({}).kind, 'text');
    for (const k of Object.values(KIND)) {
      assert.strictEqual(makeTrace({ kind: k }).kind, k);
    }
  });

  test('v 恒等于 TRACE_VERSION；contradictions 非数组一律 []、数组按引用透传', () => {
    assert.strictEqual(makeTrace({}).v, TRACE_VERSION);
    assert.deepStrictEqual(makeTrace({ contradictions: 'str' }).contradictions, []);
    assert.deepStrictEqual(makeTrace({ contradictions: null }).contradictions, []);
    assert.deepStrictEqual(makeTrace({ contradictions: { a: 1 } }).contradictions, []);
    const arr = [{ p4: 'x' }];
    // 引用透传：信封与调用方共享同一数组，可变性由上游自担（当前行为如实钉住）
    assert.strictEqual(makeTrace({ contradictions: arr }).contradictions, arr);
  });

  test('seal 仅字符串透传，其余（数字/null/缺省）→ null', () => {
    assert.strictEqual(makeTrace({ seal: 'sha256:abc' }).seal, 'sha256:abc');
    assert.strictEqual(makeTrace({ seal: 123 }).seal, null);
    assert.strictEqual(makeTrace({}).seal, null);
    assert.strictEqual(makeTrace({ seal: null }).seal, null);
  });

  test('makeTrace({}) 的 at 取自时钟：有限数且落在调用前后 Date.now 窗口内', () => {
    const before = Date.now();
    const t = makeTrace({});
    const after = Date.now();
    assert.ok(Number.isFinite(t.at), 'at 必须是有限数');
    assert.ok(t.at >= before && t.at <= after, `at=${t.at} 应落在 [${before}, ${after}]`);
  });

  test('显式有限 at 透传；NaN/Infinity/字符串 at 回落时钟', () => {
    assert.strictEqual(makeTrace({ at: 12345 }).at, 12345);
    assert.strictEqual(makeTrace({ at: 0 }).at, 0); // 0 是有限数，不是缺省
    for (const bad of [NaN, Infinity, '123', null, undefined]) {
      const t = makeTrace({ at: bad });
      assert.ok(Number.isFinite(t.at) && t.at >= Date.now() - 1000, `垃圾 at=${String(bad)} 应回落时钟`);
    }
  });

  test('producerId 经 normalizeProducer 落到信封（未知→relay+raw）', () => {
    const t = makeTrace({ producer: 'mystery', producerId: 'mid' });
    assert.strictEqual(t.producer, 'relay');
    assert.strictEqual(t.producerId, 'mid');
  });
});

describe('stamp：不可变盖戳', () => {
  test('返回浅拷贝：原对象不被改写、拷贝保留原字段、_khyTrace 结构合法', () => {
    const src = { role: 'assistant', content: 'hi' };
    const out = stamp(src, { producer: 'codex', kind: KIND.TEXT });
    assert.strictEqual(src._khyTrace, undefined);
    assert.deepStrictEqual(src, { role: 'assistant', content: 'hi' });
    assert.strictEqual(out.role, 'assistant');
    assert.strictEqual(out.content, 'hi');
    assert.ok(isTrace(out));
    assert.strictEqual(out._khyTrace.producer, 'codex');
    // opts 全量透传给 makeTrace
    const out2 = stamp({}, { producer: 'claude-code', trust: TRUST.QUARANTINED, seal: 's1' });
    assert.strictEqual(out2._khyTrace.trust, 'quarantined');
    assert.strictEqual(out2._khyTrace.seal, 's1');
  });

  test('stamp(null)/stamp("x")/stamp(42) 一律产出带合法信封的对象（fail-safe 不抛）', () => {
    for (const bad of [null, undefined, 'x', 42, true]) {
      const out = stamp(bad);
      assert.ok(isTrace(out), `stamp(${String(bad)}) 必须产出合法信封`);
      assert.strictEqual(out._khyTrace.producer, 'khy-local');
      assert.strictEqual(out._khyTrace.trust, 'verified');
      // 非对象 base 被替换为 {}：除信封外不带垃圾展开字段
      assert.deepStrictEqual(Object.keys(out), ['_khyTrace']);
    }
  });

  test('stamp(数组) 把下标展开为数字键（浅拷贝按 spread 语义，当前行为钉住）', () => {
    const out = stamp([1, 2]);
    assert.strictEqual(out[0], 1);
    assert.strictEqual(out[1], 2);
    assert.ok(isTrace(out));
  });
});

describe('isTrace：判据只看 producer+trust（当前行为如实钉住）', () => {
  test('producer+trust 合法即通过——即便 kind/v 是垃圾', () => {
    // 已知偏差：isTrace 不校验 kind 与 v，结构残缺但标签正确的信封会被判「合法」。
    // 本测试钉的是现状而非理想态；若未来加校验，此断言须同步翻转。
    const loose = { _khyTrace: { producer: 'codex', trust: 'claimed', kind: 'garbage', v: 99 } };
    assert.ok(Object.keys(loose._khyTrace).length > 2);
    assert.strictEqual(isTrace(loose), true);
  });

  test('负例齐备：null/非对象/缺信封/信封非对象/producer 或 trust 非法 → false', () => {
    assert.strictEqual(isTrace(null), false);
    assert.strictEqual(isTrace(undefined), false);
    assert.strictEqual(isTrace('string'), false);
    assert.strictEqual(isTrace({}), false);
    assert.strictEqual(isTrace({ _khyTrace: null }), false);
    assert.strictEqual(isTrace({ _khyTrace: 'not-object' }), false);
    assert.strictEqual(isTrace({ _khyTrace: { producer: 'mystery', trust: 'claimed' } }), false);
    assert.strictEqual(isTrace({ _khyTrace: { producer: 'codex', trust: 'made-up' } }), false);
    assert.strictEqual(isTrace({ _khyTrace: {} }), false);
  });
});

describe('traceOf：永不返回 null，但也不是纯函数', () => {
  test('合法条目返回同一信封引用（不复制）', () => {
    const entry = stamp({}, { producer: 'relay', producerId: 'rid' });
    assert.strictEqual(traceOf(entry), entry._khyTrace);
  });

  test('缺失/非法信封 → 全新 khy-local/verified 默认；两次调用返回不同对象（非纯性钉住）', () => {
    const a = traceOf({});
    const b = traceOf({});
    assert.strictEqual(a.producer, 'khy-local');
    assert.strictEqual(a.trust, 'verified');
    assert.deepStrictEqual(b.contradictions, []);
    assert.strictEqual(b.seal, null);
    // 模块头宣称「纯函数、零 IO」，但缺省分支每次 makeTrace 都读时钟新建对象——
    // 同输入不同输出，钉住这一不纯性防「把它当 memo 键/相等比较」的下游误用。
    assert.notStrictEqual(a, b);
    assert.ok(Number.isFinite(a.at) && Number.isFinite(b.at));
    // 非法信封同样走缺省分支而非返回原始垃圾
    assert.strictEqual(traceOf({ _khyTrace: { producer: 'junk' } }).producer, 'khy-local');
    assert.notStrictEqual(traceOf(null), traceOf(null));
  });
});

describe('isRelayed 与 quarantinePolicy 的刻意反向', () => {
  test('isRelayed：khy-local→false，三外部→true，未知字符串→false（集合门控）', () => {
    assert.strictEqual(isRelayed('khy-local'), false);
    assert.strictEqual(isRelayed('codex'), true);
    assert.strictEqual(isRelayed('claude-code'), true);
    assert.strictEqual(isRelayed('relay'), true);
    // 未知非空串不在 _PRODUCERS 集合内 → false。标签侧「未知不当外部」，
    // 与 normalizeProducer 的「未知坍缩 relay」组合后才闭合——单独看这里是漏判面。
    assert.strictEqual(isRelayed('totally-unknown'), false);
    assert.strictEqual(isRelayed(null), false);
    assert.strictEqual(isRelayed(undefined), false);
    assert.strictEqual(isRelayed(123), false);
  });

  test('同一未知 producer，执行侧 _isRelayedForExec 判中转（fail-CLOSED→quarantine）——两读并钉', () => {
    const unknownProducer = 'totally-unknown';
    assert.strictEqual(isRelayed(unknownProducer), false, '标签侧：未知不算中转');
    const verdict = quarantinePolicy.decide({
      producer: unknownProducer,
      interactive: false,
      preApproved: false,
      gateEnabled: true,
    });
    // 执行侧：未知 producer 也不放行，直接隔离。见 quarantinePolicy.js:35
    assert.strictEqual(verdict.action, 'quarantine');
    assert.strictEqual(verdict.trust, 'quarantined');
    // khy-local 两侧一致（都不算中转）
    assert.strictEqual(isRelayed('khy-local'), false);
    assert.strictEqual(
      quarantinePolicy.decide({ producer: 'khy-local', gateEnabled: true }).action,
      'allow',
    );
  });
});
