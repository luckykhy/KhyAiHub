'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const wb = require('./workbench.js');

const { partition, measure, assertNoRawLongText, ZONES, ZONE_RATIO, MEMORY_RAW_CHAR_CAP } = wb;

const est = (t) => Math.ceil(String(t || '').length / 4);

describe('partition 三区切分', () => {
  test('1000 token 窗口按 40/20/40 切分，ratio 是副本而非共享引用', () => {
    const p = partition(1000);
    assert.deepEqual(p, {
      window: 1000,
      exec: 400,
      memory: 200,
      buffer: 400,
      ratio: { exec: 0.4, memory: 0.2, buffer: 0.4 },
    });
    p.ratio.exec = 0.99;
    assert.equal(ZONE_RATIO.exec, 0.4);
    assert.notEqual(p.ratio, ZONE_RATIO);
  });

  test('小数窗口向下取整，余数不进任何一区', () => {
    const p = partition(1007.9);
    assert.equal(p.window, 1007);
    assert.equal(p.exec, 402);
    assert.equal(p.memory, 201);
    assert.equal(p.buffer, 402);
    assert.equal(p.exec + p.memory + p.buffer, 1005);
  });

  test('垃圾/越界输入统一收敛到 0 窗口而不是负预算', () => {
    for (const junk of [null, undefined, NaN, -1, -1e9, '', 'abc', {}, []]) {
      const p = partition(junk);
      assert.equal(p.window, 0, String(junk));
      assert.equal(p.exec, 0);
      assert.equal(p.memory, 0);
      assert.equal(p.buffer, 0);
    }
  });

  test('字符串数字被接受，超大窗口保持有限', () => {
    assert.equal(partition('4096').window, 4096);
    assert.equal(partition(1e21).window, 1e21);
    assert.equal(Number.isFinite(partition(1e21).exec), true);
  });

  test('ZONES 常量面冻结，调用方改名不传播', () => {
    assert.deepEqual({ ...ZONES }, { EXEC: 'exec', MEMORY: 'memory', BUFFER: 'buffer' });
    assert.throws(() => {
      ZONES.EXEC = 'other';
    }, TypeError);
  });
});

describe('measure 实际占用与越界', () => {
  test('三区都在预算内：violations 空、withinBounds true、比例逐区可复算', () => {
    const r = measure({ execText: 'a'.repeat(400), memoryText: 'b'.repeat(160), bufferText: 'c'.repeat(400) }, 1000, {
      estimateTokensFn: est,
    });
    assert.deepEqual(r.budget, { exec: 400, memory: 200, buffer: 400 });
    assert.deepEqual(r.used, { exec: 100, memory: 40, buffer: 100, total: 240 });
    assert.deepEqual(r.violations, []);
    assert.equal(r.withinBounds, true);
    assert.equal(r.ratioUsed.exec, 0.25);
    assert.equal(r.ratioUsed.total, 240 / 1000);
  });

  test('单区越界报出 zone/used/budget/overBy 四元组', () => {
    const r = measure({ memoryText: 'x'.repeat(2000) }, 1000, { estimateTokensFn: est });
    assert.equal(r.violations.length, 1);
    assert.deepEqual(r.violations[0], { zone: ZONES.MEMORY, used: 500, budget: 200, overBy: 300 });
    assert.equal(r.withinBounds, false);
    assert.equal(r.ratioUsed.memory, 2.5);
  });

  test('三区同时越界按 EXEC/MEMORY/BUFFER 顺序全部列出', () => {
    const r = measure(
      { execText: 'e'.repeat(8000), memoryText: 'm'.repeat(8000), bufferText: 'b'.repeat(8000) },
      1000,
      { estimateTokensFn: est }
    );
    assert.deepEqual(r.violations.map((v) => v.zone), ['exec', 'memory', 'buffer']);
    assert.equal(r.used.total, 6000);
  });

  test('空入参全 0，分母为 0 的比例退化为 0 而不是 Infinity/NaN', () => {
    const r = measure();
    assert.deepEqual(r.used, { exec: 0, memory: 0, buffer: 0, total: 0 });
    assert.deepEqual(r.ratioUsed, { exec: 0, memory: 0, buffer: 0, total: 0 });
    assert.equal(r.withinBounds, true);
    const empty = measure({}, 1000, { estimateTokensFn: est });
    assert.deepEqual(empty.used, { exec: 0, memory: 0, buffer: 0, total: 0 });
  });

  test('区文本为假值 0 时用估算器度量空串，不用 String(0)', () => {
    // `zonesText.execText || ''` collapses 0 to '' before estimating.
    const r = measure({ execText: 0, memoryText: 0, bufferText: 0 }, 1000, {
      estimateTokensFn: (t) => String(t).length,
    });
    assert.equal(r.used.exec, 0);
    assert.equal(r.used.total, 0);
  });

  test('估算器可注入：按字节计量的估算器改变 used 与 violations', () => {
    const byByte = (t) => Buffer.byteLength(String(t || ''), 'utf8');
    const r = measure({ execText: '中'.repeat(500) }, 1000, { estimateTokensFn: byByte });
    assert.equal(r.used.exec, 1500);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].overBy, 1100);
  });

  test('缺省估算器走 contextWasm 真源，返回正整数 token 数', () => {
    const r = measure({ execText: 'hello world this is a longer sentence for tokens' }, 1000);
    assert.equal(Number.isInteger(r.used.exec), true);
    assert.ok(r.used.exec > 0);
  });

  test('zonesText 传非对象不抛；显式 null 抛 TypeError（默认参数只兜 undefined）', () => {
    for (const junk of [undefined, '文本', 0, -1, NaN, [], 1e21]) {
      const r = measure(junk, 1000, { estimateTokensFn: est });
      assert.equal(r.used.total, 0, String(junk));
    }
    assert.throws(() => measure(null, 1000, { estimateTokensFn: est }), TypeError);
    // Non-string zone content is handed to the estimator untouched: '[object Object]'
    // is 15 chars → ceil(15/4) = 4 tokens.
    assert.equal(measure({ execText: {} }, 1000, { estimateTokensFn: est }).used.exec, 4);
  });

  test('KNOWN-DEFECT: 窗口极小时记忆区预算被 floor 成 0，该区的 b>0 守卫让它永远无法被判越界', () => {
    // workbench.js:81 (`if (b > 0 && used > b)`) + workbench.js:50-52 (floor) →
    // window 3 gives memory budget floor(3*0.2)=1, window 4 gives 0. With 0 budget the
    // memory zone can hold unlimited raw text yet stay "withinBounds", i.e. the §3.1
    // hard rule silently stops applying instead of reporting an over-use.
    const r = measure({ memoryText: 'x'.repeat(100000) }, 4, { estimateTokensFn: est });
    assert.equal(r.budget.memory, 0);
    assert.equal(r.used.memory, 25000);
    assert.deepEqual(r.violations, []);
    assert.equal(r.withinBounds, true);
    assert.equal(r.ratioUsed.memory, 0);
  });

  test('KNOWN-DEFECT: 未给窗口时 measure 报「在界内」，把预算缺失当成预算无限', () => {
    // workbench.js:47 (`Math.max(0, ...)` → window 0) + workbench.js:81 → all three
    // budgets are 0, so no violation can ever be reported: a caller that forgets to
    // pass contextWindowTokens gets withinBounds=true for an arbitrarily large register.
    const r = measure({ execText: 'e'.repeat(4000), bufferText: 'b'.repeat(4000) }, undefined, {
      estimateTokensFn: est,
    });
    assert.equal(r.window, 0);
    assert.equal(r.used.total, 2000);
    assert.equal(r.withinBounds, true);
    assert.deepEqual(r.ratioUsed, { exec: 0, memory: 0, buffer: 0, total: 0 });
  });

  test('KNOWN-DEFECT: 估算器返回 NaN 时 used 参与比较恒为 false，越界被静默放行且 total 是 NaN', () => {
    // workbench.js:81 (`used > b` with used=NaN is false) + workbench.js:77 (sum) →
    // a broken injected estimator yields withinBounds=true while ratioUsed.total is NaN,
    // so the upper layer's circuit breaker never trips.
    const r = measure({ execText: 'x'.repeat(9000) }, 1000, { estimateTokensFn: () => NaN });
    assert.equal(r.used.exec, NaN);
    assert.equal(Number.isNaN(r.used.total), true);
    assert.deepEqual(r.violations, []);
    assert.equal(r.withinBounds, true);
    assert.equal(Number.isNaN(r.ratioUsed.total), true);
  });

  test('KNOWN-DEFECT: ratioUsed.total 用原始 window 作分母，与三区预算之和不口径一致', () => {
    // workbench.js:98 vs workbench.js:48-53 → for window 1005 the budgets sum to 1004
    // (floor remainder), so total usage ratio under-reads against the budget the
    // zones actually share.
    const p = partition(1007);
    assert.equal(p.exec + p.memory + p.buffer, 1005);
    const r = measure({ execText: 'x'.repeat(1608) }, 1007, { estimateTokensFn: est });
    assert.equal(r.used.exec, 402);
    assert.equal(r.ratioUsed.exec, 1);
    assert.ok(r.ratioUsed.total < 1);
    assert.equal(r.withinBounds, true);
  });
});

describe('assertNoRawLongText 记忆区铁律', () => {
  test('默认上限 600 字符，超长条目按 index/chars/cap 报出', () => {
    assert.equal(MEMORY_RAW_CHAR_CAP, 600);
    const out = assertNoRawLongText(['短', 'x'.repeat(601), 'y'.repeat(600)]);
    assert.deepEqual(out, [{ index: 1, chars: 601, cap: 600 }]);
  });

  test('恰好等于上限不算违规（严格大于）', () => {
    assert.deepEqual(assertNoRawLongText(['z'.repeat(600)], 600), []);
    assert.deepEqual(assertNoRawLongText(['z'.repeat(601)], 600), [{ index: 0, chars: 601, cap: 600 }]);
  });

  test('空数组与缺省入参都返回空报告', () => {
    assert.deepEqual(assertNoRawLongText(), []);
    assert.deepEqual(assertNoRawLongText([]), []);
  });

  test('cap 传 0 时任何非空条目都违规；cap 传负数时连空串也违规', () => {
    assert.deepEqual(assertNoRawLongText(['a', ''], 0), [{ index: 0, chars: 1, cap: 0 }]);
    assert.deepEqual(assertNoRawLongText([''], -1), [{ index: 0, chars: 0, cap: -1 }]);
  });

  test('KNOWN-DEFECT: String(item ||) 兜底把数字 0 条目吞成 0 字符，长文本判定对其失效', () => {
    // workbench.js:114 → `String(item || '').length`; the falsy-but-meaningful entries
    // 0 and false are coerced through || to '', so a register holding the number 0 is
    // measured as empty regardless of cap.
    assert.deepEqual(assertNoRawLongText([0, false], 0), []);
    assert.equal(assertNoRawLongText(['0'], 0).length, 1);
  });

  test('KNOWN-DEFECT: 非数组入参直接 TypeError，与同文件 measure 的 fail-soft 口径相反', () => {
    // workbench.js:111-113 → default parameter only covers undefined, and `.forEach`
    // is called without an Array.isArray guard (cf. compressionEngine.js:177).
    assert.throws(() => assertNoRawLongText(null), TypeError);
    assert.throws(() => assertNoRawLongText('abc'), TypeError);
    assert.throws(() => assertNoRawLongText({ 0: 'x', length: 1 }), TypeError);
  });

  test('对象条目按 String(obj) 计长，报出的 chars 是转串后长度', () => {
    const out = assertNoRawLongText([{ toString: () => 'x'.repeat(700) }]);
    assert.deepEqual(out, [{ index: 0, chars: 700, cap: 600 }]);
  });
});
