'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const ce = require('./compressionEngine.js');

const { selectLevel, foldL1, extractL2, compressHistory, LEVELS, THRESHOLDS, RAW_WINDOW_HARD_CAP } = ce;

// chars/4 estimator, injected everywhere so no suite depends on contextWasm loading.
const est = (t) => Math.ceil(String(t || '').length / 4);

const steps = (n) =>
  Array.from({ length: n }, (_, i) => ({
    step: i + 1,
    intent: `第 ${i + 1} 步意图`,
    tool: 'read',
    params: { file: `src/a${i}.js` },
    result: { ok: true, text: 'x'.repeat(40) },
  }));

describe('selectLevel 阈值边界', () => {
  test('0 与 0.49 落在 L0，0.5 恰好越过 L1 线', () => {
    assert.equal(selectLevel(0), LEVELS.L0);
    assert.equal(selectLevel(0.49), LEVELS.L0);
    assert.equal(selectLevel(THRESHOLDS.L1), LEVELS.L1);
    assert.equal(selectLevel(0.74), LEVELS.L1);
    assert.equal(selectLevel(THRESHOLDS.L2), LEVELS.L2);
    assert.equal(selectLevel(0.89), LEVELS.L2);
    assert.equal(selectLevel(THRESHOLDS.L3), LEVELS.L3);
    assert.equal(selectLevel(1), LEVELS.L3);
  });

  test('字符串数字被 Number 收编后照常分级', () => {
    assert.equal(selectLevel('0.6'), LEVELS.L1);
    assert.equal(selectLevel('0.95'), LEVELS.L3);
  });

  test('NaN / Infinity / 负数 / undefined 一律 fail-safe 到最严 L3', () => {
    assert.equal(selectLevel(NaN), LEVELS.L3);
    assert.equal(selectLevel(Infinity), LEVELS.L3);
    assert.equal(selectLevel(-1), LEVELS.L3);
    assert.equal(selectLevel(undefined), LEVELS.L3);
    assert.equal(selectLevel({}), LEVELS.L3);
    assert.equal(selectLevel([]), LEVELS.L0); // Number([]) === 0
  });

  test('KNOWN-DEFECT: null 与空串被折成 0，判成最宽松的 L0 而非文档承诺的 fail-safe L3', () => {
    // compressionEngine.js:50-54 → `Number(null)` / `Number('')` are finite 0, so the
    // `!Number.isFinite(r) || r < 0` fail-safe (documented as "拿不到占用就当满")
    // never fires for the two most common "unknown" spellings: they pick L0.
    assert.equal(selectLevel(null), LEVELS.L0);
    assert.equal(selectLevel(''), LEVELS.L0);
  });
});

describe('foldL1 语义折叠', () => {
  test('产出三元组并丢弃 reasoning/raw，failed 由 result.success 决定', () => {
    const out = foldL1({
      step: 3,
      intent: '读取文件',
      instruction: '不该出现',
      tool: 'read',
      params: { path: 'a.js' },
      result: { success: false, error: 'ENOENT' },
      reasoning: '一大段推理',
      raw: '一大段原文',
    });
    assert.equal(out.step, 3);
    assert.equal(out.level, LEVELS.L1);
    assert.equal(out.intent, '读取文件');
    assert.deepEqual(out.action, { tool: 'read', params: '{"path":"a.js"}' });
    assert.equal(out.failed, true);
    assert.equal('reasoning' in out, false);
    assert.equal('raw' in out, false);
  });

  test('intent 缺省时回退 instruction，两者皆空得空串', () => {
    assert.equal(foldL1({ instruction: '仅指令' }).intent, '仅指令');
    assert.equal(foldL1({}).intent, '');
    assert.equal(foldL1().intent, '');
  });

  test('超长 intent / params / result 被截断并以省略号收尾', () => {
    const out = foldL1({ intent: '啊'.repeat(200), params: 'p'.repeat(200), result: 'r'.repeat(300) });
    assert.equal(out.intent.length, 161); // 160 chars + '…'
    assert.ok(out.intent.endsWith('…'));
    assert.equal(out.action.params.length, 121);
    assert.equal(out.result.length, 201);
  });

  test('failed 识别 error 字段、result.error 与 result.success===false 三种失败形态', () => {
    assert.equal(foldL1({ error: 'boom' }).failed, true);
    assert.equal(foldL1({ result: { error: 'x' } }).failed, true);
    assert.equal(foldL1({ result: { success: false } }).failed, true);
    assert.equal(foldL1({ result: { success: true } }).failed, false);
    assert.equal(foldL1({ result: '纯文本结果' }).failed, false);
  });

  test('KNOWN-DEFECT: result.success 为假值 0 与空串 error 都被判成成功，failed 漏报', () => {
    // compressionEngine.js:84-90 → `_isFailure` only reads `step.result.error` /
    // `step.result.success === false`; a falsy-but-not-false marker (success: 0) or a
    // bare empty-string error is treated as success, so a failed step is folded as ok.
    assert.equal(foldL1({ result: { success: 0 } }).failed, false);
    assert.equal(foldL1({ error: '' }).failed, false);
  });

  test('显式传 null 直接 TypeError（默认参数只兜 undefined）', () => {
    assert.throws(() => foldL1(null), TypeError);
  });
});

describe('extractL2 骨相抽取', () => {
  test('防呆③：entities 与 errorLessons 两个字段恒在，非失败步 errorLessons 为空数组', () => {
    const ok = extractL2({ step: 1, tool: 'grep', result: 'no match' });
    assert.deepEqual(Object.keys(ok).sort(), ['entities', 'errorLessons', 'level', 'step']);
    assert.equal(ok.level, LEVELS.L2);
    assert.deepEqual(ok.errorLessons, []);
    assert.ok(ok.entities.includes('tool:grep'));
  });

  test('失败步生成 stepN: 前缀的教训串', () => {
    const out = extractL2({ step: 7, error: '权限不足 EPERM' });
    assert.deepEqual(out.errorLessons, ['step7: 权限不足 EPERM']);
    assert.ok(out.entities.some((e) => e.startsWith('code:')));
  });

  test('step 缺失时教训前缀退化为 step?', () => {
    assert.deepEqual(extractL2({ error: 'boom' }).errorLessons, ['step?: boom']);
  });

  test('实体抽取覆盖文件路径 / 错误码 / 标识符，去重且上限 12 条', () => {
    const out = extractL2({
      step: 1,
      tool: 'write',
      intent: '修复 src/services/domain/backup/backupService.js 里的 reindexAll 与 sessions.db',
      result: 'EPERM ENOENT reindexAll sessionPersistence offloadStore slugifyToken ensureDirSync simpleTokenEstimate dataHome',
      error: 'ENOENT',
    });
    assert.equal(out.entities.length <= 12, true);
    assert.equal(new Set(out.entities).size, out.entities.length);
    assert.ok(out.entities.some((e) => e.startsWith('file:')));
    assert.ok(out.entities.includes('code:ENOENT'));
    assert.ok(out.entities.some((e) => e.startsWith('sym:reindexAll')));
  });

  test('垃圾输入不抛：空对象/数字/数组/原型键对象都产出合法骨相', () => {
    for (const junk of [{}, { constructor: 1 }, [], 0, -1, NaN, '文本']) {
      const out = extractL2(junk);
      assert.equal(out.level, LEVELS.L2);
      assert.ok(Array.isArray(out.entities));
      assert.ok(Array.isArray(out.errorLessons));
    }
  });

  test('显式 null 抛 TypeError', () => {
    assert.throws(() => extractL2(null), TypeError);
  });
});

describe('compressHistory 整段压缩', () => {
  test('防呆①：任何级别（含 L0）原始步都 ≤2，更早的步被折叠', () => {
    for (const ratio of [0.1, 0.6, 0.8, 0.95]) {
      const res = compressHistory(steps(5), { usageRatio: ratio, estimateTokensFn: est });
      assert.equal(res.rawKept, RAW_WINDOW_HARD_CAP, `ratio=${ratio}`);
      const raws = res.history.filter((h) => h.level === LEVELS.L0);
      assert.equal(raws.length, 2, `ratio=${ratio}`);
      assert.equal(res.history.length, 5, `ratio=${ratio}`);
    }
  });

  test('短历史（1 步）rawKept 等于步数，不产生空占位', () => {
    const res = compressHistory(steps(1), { usageRatio: 0.1, estimateTokensFn: est });
    assert.equal(res.rawKept, 1);
    assert.equal(res.history.length, 1);
    assert.equal(res.history[0].level, LEVELS.L0);
  });

  test('空历史 / 非数组历史返回完整骨架且 retainedRatio=1', () => {
    const empty = compressHistory([], { usageRatio: 0.1, estimateTokensFn: est });
    assert.equal(empty.level, LEVELS.L0);
    assert.equal(empty.rawKept, 0);
    assert.deepEqual(empty.history, []);
    assert.deepEqual(empty.offloadCandidates, []);
    assert.equal(empty.retainedRatio, 1);
    for (const junk of [null, undefined, '文本', {}, 0, -1, NaN]) {
      assert.equal(compressHistory(junk, { estimateTokensFn: est }).history.length, 0);
    }
  });

  test('L2 级别：更早步骤全部转骨相，原始尾部仍是 L0', () => {
    const res = compressHistory(steps(4), { usageRatio: 0.8, estimateTokensFn: est });
    assert.equal(res.level, LEVELS.L2);
    assert.deepEqual(res.offloadCandidates, []);
    assert.deepEqual(
      res.history.map((h) => h.level),
      ['L2', 'L2', 'L0', 'L0']
    );
  });

  test('L1 级别：更早步骤全部转三元组折叠', () => {
    const res = compressHistory(steps(4), { usageRatio: 0.6, estimateTokensFn: est });
    assert.equal(res.level, LEVELS.L1);
    assert.deepEqual(
      res.history.map((h) => h.level),
      ['L1', 'L1', 'L0', 'L0']
    );
  });

  test('L3 级别：最老的一段进 offloadCandidates，上下文只留 offloaded 占位且 ref 为空', () => {
    const res = compressHistory(steps(6), { usageRatio: 0.95, estimateTokensFn: est });
    assert.equal(res.level, LEVELS.L3);
    assert.equal(res.offloadCandidates.length, 2);
    const slots = res.history.filter((h) => h.offloaded);
    assert.equal(slots.length, 2);
    assert.equal(slots[0].ref, null);
    assert.equal(slots[0].level, LEVELS.L3);
    assert.equal(slots[0].offloaded, true);
    // Offloaded records still carry their L2 skeleton, so 防呆③ survives the eviction.
    assert.ok(Array.isArray(slots[0].l2.entities));
  });

  test('lessons 与 entities 跨全部档位汇总，含被卸载记录的骨相', () => {
    const s = steps(6).map((x, i) => (i === 0 ? { ...x, error: 'EACCES 权限不足' } : x));
    const res = compressHistory(s, { usageRatio: 0.95, estimateTokensFn: est });
    assert.equal(res.lessons.length, 1);
    assert.match(res.lessons[0], /^step1: /);
    assert.ok(res.entities.length > 0);
    assert.equal(new Set(res.entities).size, res.entities.length);
  });

  test('尾部原始步只截断超大字符串 result，对象 result 原样保留', () => {
    const big = compressHistory(
      [{ step: 1, result: 'y'.repeat(1300) }, { step: 2, result: { deep: { a: 1 } }, params: {} }],
      { usageRatio: 0.2, estimateTokensFn: est }
    );
    assert.equal(big.history[0].result.length, 1201);
    assert.deepEqual(big.history[1].result, { deep: { a: 1 } });
    assert.deepEqual(big.history[1].params, {});
  });

  test('retainedRatio 用注入的估算器计算，压缩后确实在 [0,1] 内', () => {
    const res = compressHistory(steps(8), { usageRatio: 0.8, estimateTokensFn: est });
    assert.ok(res.retainedRatio > 0 && res.retainedRatio <= 1);
  });

  test('估算器返回 0 时 retainedRatio 退化为 1 而不是除零得 NaN/Infinity', () => {
    const res = compressHistory(steps(3), { usageRatio: 0.8, estimateTokensFn: () => 0 });
    assert.equal(res.retainedRatio, 1);
  });

  test('不可序列化的步骤（循环引用）不会抛穿：JSON 回退到 String', () => {
    const circular = { step: 1, intent: 'x' };
    circular.self = circular;
    const res = compressHistory([circular, circular, circular], { usageRatio: 0.6, estimateTokensFn: est });
    assert.equal(res.history.length, 3);
    assert.equal(Number.isFinite(res.retainedRatio), true);
  });

  test('KNOWN-DEFECT: L3 卸载阈值 i/length 配 0.34，实际卸载比例可达 2/3 而非文档说的「最老一段 ~1/3」', () => {
    // compressionEngine.js:193-194 → `posFromOld = i / Math.max(1, older.length)` and
    // `posFromOld < 0.34`. With 3 older steps, index 1 gives 1/3 = 0.3333 which is still
    // < 0.34, so 2 of 3 (66%) older steps get evicted instead of ~1 of 3.
    const res = compressHistory(steps(5), { usageRatio: 0.95, estimateTokensFn: est });
    assert.equal(res.history.filter((h) => !h.offloaded && h.level === LEVELS.L0).length, 2);
    assert.equal(res.offloadCandidates.length, 2);
    assert.equal(res.offloadCandidates.length / 3, 2 / 3);
  });

  test('KNOWN-DEFECT: 同名 step 号重复时，两条 L3 卸载记录在上下文里彼此不可区分', () => {
    // compressionEngine.js:195-203 → the offload placeholder carries only `step`, so
    // duplicated step numbers produce two identical-looking L3 records; the surviving
    // `l2` skeleton is the only thing telling them apart, and index.js:132 `find` can
    // no longer map a pointer back to its own record.
    const dup = Array.from({ length: 6 }, (_, i) => ({
      step: 1,
      intent: `重复号 ${i}`,
      tool: 'read',
      result: String.fromCharCode(65 + i).repeat(50),
    }));
    const res = compressHistory(dup, { usageRatio: 0.95, estimateTokensFn: est });
    assert.equal(res.offloadCandidates.length, 2);
    assert.deepEqual(res.offloadCandidates.map((c) => c.step), [1, 1]);
    assert.deepEqual(res.history.filter((h) => h.offloaded).map((h) => h.step), [1, 1]);
    assert.equal(res.history.filter((h) => h.offloaded && h.ref === null).length, 2);
  });
});

describe('导出面常量', () => {
  test('THRESHOLDS 与 LEVELS 冻结，调用方改写不传播', () => {
    assert.equal(Object.isFrozen(THRESHOLDS), true);
    assert.equal(Object.isFrozen(LEVELS), true);
    assert.throws(() => {
      THRESHOLDS.L1 = 0.99;
    }, TypeError);
  });

  test('RAW_WINDOW_HARD_CAP 固定为 2（防呆①红线）', () => {
    assert.equal(RAW_WINDOW_HARD_CAP, 2);
  });
});
