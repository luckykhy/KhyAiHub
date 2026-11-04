'use strict';

/**
 * acceptanceVerdict.test.js — 完成裁决纯叶子的回归锁。
 *
 * 为什么单测这一层：四值裁决是「任务完成了吗」唯一可复算的判定。它一旦退化
 * （例如把 legacy 散文判成 done、或把过期证据当新鲜），整个 hq 门就会重新
 * 变成自述 —— 而这种退化不会让任何现有测试变红。
 */

const V = require('../../src/cli/acceptanceVerdict');

const HOUR = 60 * 60 * 1000;

function cmdCriterion(id, overrides) {
  return Object.assign({
    id,
    desc: `判据 ${id}`,
    check: { kind: 'cmd', cmd: 'node -e "process.exit(0)"', expect: { kind: 'exit', value: 0 } },
  }, overrides);
}

function recordFor(criterion, overrides) {
  const c = V.normalizeCriterion(criterion, 0);
  return Object.assign({
    id: c.id,
    kind: 'cmd',
    checkHash: V.checkHash(c),
    at: new Date(Date.now() - 60 * 1000).toISOString(),
    atMs: Date.now() - 60 * 1000,
    result: 'pass',
  }, overrides);
}

describe('acceptanceVerdict', () => {
  test('全部 required 通过 → done', () => {
    const task = { criteria: [cmdCriterion('C1'), cmdCriterion('C2')] };
    const records = [recordFor(task.criteria[0]), recordFor(task.criteria[1])];
    const r = V.evaluateAcceptance(task, records, {});
    expect(r.verdict).toBe('done');
    expect(r.source).toBe('structured');
    expect(r.counts.passed).toBe(2);
  });

  test('任一 required fail → failed', () => {
    const task = { criteria: [cmdCriterion('C1'), cmdCriterion('C2')] };
    const records = [
      recordFor(task.criteria[0]),
      recordFor(task.criteria[1], { result: 'fail', reason: 'exit=1' }),
    ];
    const r = V.evaluateAcceptance(task, records, {});
    expect(r.verdict).toBe('failed');
    expect(r.blockers.join('\n')).toContain('C2');
  });

  test('有 required 未执行 → partial，不是 done', () => {
    const task = { criteria: [cmdCriterion('C1'), cmdCriterion('C2')] };
    const r = V.evaluateAcceptance(task, [recordFor(task.criteria[0])], {});
    expect(r.verdict).toBe('partial');
    expect(r.criteria.find((c) => c.id === 'C2').reason).toBe('no-run');
  });

  test('没有判据也没有散文 → unknown', () => {
    const r = V.evaluateAcceptance({ id: 'T-X' }, [], {});
    expect(r.verdict).toBe('unknown');
    expect(r.source).toBe('none');
    expect(r.blockers.join('\n')).toContain('没有完成定义');
  });

  test('legacy 散文永远不能单独构成 done', () => {
    const task = {
      acceptance: '命令跑通；人工看着没问题',
      criteria: undefined,
    };
    const split = (s) => String(s).split('；').filter(Boolean);
    const norm = V.normalizeTaskCriteria(task, split);
    expect(norm.source).toBe('legacy');
    const records = norm.criteria.map((c) => ({
      id: c.id,
      kind: 'manual',
      checkHash: V.checkHash(c),
      at: new Date().toISOString(),
      atMs: Date.now(),
      result: 'pass',
      signedBy: '孔浩原',
    }));
    const r = V.evaluateAcceptance(task, records, {}, split);
    expect(r.verdict).toBe('partial');
    expect(r.blockers.join('\n')).toContain('legacy-markdown-acceptance');
  });

  test('过期记录 → unknown/expired', () => {
    const task = { criteria: [cmdCriterion('C1')] };
    const old = recordFor(task.criteria[0], { atMs: Date.now() - 25 * HOUR, at: new Date(Date.now() - 25 * HOUR).toISOString() });
    const r = V.evaluateAcceptance(task, [old], { maxAgeMs: 24 * HOUR });
    expect(r.criteria[0].state).toBe('unknown');
    expect(r.criteria[0].reason).toBe('expired');
    expect(r.verdict).toBe('partial');
  });

  test('HEAD 被改写 → unknown/head-rewritten', () => {
    const task = { criteria: [cmdCriterion('C1')] };
    const rec = recordFor(task.criteria[0], { headStillAncestor: false });
    const r = V.evaluateAcceptance(task, [rec], {});
    expect(r.criteria[0].reason).toBe('head-rewritten');
  });

  test('判据覆盖的路径变了 → unknown/paths-changed', () => {
    const task = { criteria: [cmdCriterion('C1', { paths: ['a.js'] })] };
    const rec = recordFor(task.criteria[0], { pathsFingerprint: 'old' });
    const r = V.evaluateAcceptance(task, [rec], { fingerprintFor: () => 'new' });
    expect(r.criteria[0].reason).toBe('paths-changed');
  });

  test('改命令会让旧记录失效（check-changed）', () => {
    const task = { criteria: [cmdCriterion('C1')] };
    const rec = recordFor(task.criteria[0]);
    const changed = { criteria: [cmdCriterion('C1', { check: { kind: 'cmd', cmd: 'node -e "process.exit(1)"', expect: { kind: 'exit', value: 0 } } })] };
    const r = V.evaluateAcceptance(changed, [rec], {});
    expect(r.criteria[0].reason).toBe('check-changed');
  });

  test('未知形状降级为 manual，绝不猜成 cmd', () => {
    const c = V.normalizeCriterion({ id: 'C9', desc: '手测', check: { cmd: 'node x.js' } }, 0);
    expect(c.kind).toBe('manual');
    const noCheck = V.normalizeCriterion({ id: 'C10', desc: '手测' }, 0);
    expect(noCheck.kind).toBe('manual');
  });

  test('缺 cmd 的 cmd 判据是 unknown 而不是 pass', () => {
    const task = { criteria: [{ id: 'C1', desc: 'x', check: { kind: 'cmd' } }] };
    const r = V.evaluateAcceptance(task, [], {});
    expect(r.criteria[0].state).toBe('unknown');
    expect(r.verdict).toBe('partial');
  });

  test('人工判据无签名 → unknown/unsigned-manual', () => {
    const task = { criteria: [{ id: 'C1', desc: '手测', check: { kind: 'manual' } }] };
    const c = V.normalizeCriterion(task.criteria[0], 0);
    const rec = { id: 'C1', kind: 'manual', checkHash: V.checkHash(c), atMs: Date.now(), result: 'pass', signedBy: '' };
    const r = V.evaluateAcceptance(task, [rec], {});
    expect(r.criteria[0].reason).toBe('unsigned-manual');
    expect(r.verdict).toBe('partial');
  });

  test('已签名人工判据可以通过', () => {
    const task = { criteria: [{ id: 'C1', desc: '手测', check: { kind: 'manual' } }] };
    const c = V.normalizeCriterion(task.criteria[0], 0);
    const rec = { id: 'C1', kind: 'manual', checkHash: V.checkHash(c), atMs: Date.now(), result: 'pass', signedBy: '孔浩原' };
    const r = V.evaluateAcceptance(task, [rec], {});
    expect(r.verdict).toBe('done');
  });

  test('同 id 取最新记录（昨天的绿遮不住今天的红）', () => {
    const task = { criteria: [cmdCriterion('C1')] };
    const pass = recordFor(task.criteria[0], { atMs: Date.now() - HOUR, at: new Date(Date.now() - HOUR).toISOString() });
    const fail = recordFor(task.criteria[0], { result: 'fail', reason: 'exit=1' });
    const r = V.evaluateAcceptance(task, [pass, fail], {});
    expect(r.verdict).toBe('failed');
  });

  test('toLegacyVerdicts 把四态映射成 PASS/FAIL/SKIP', () => {
    const task = { criteria: [cmdCriterion('C1'), cmdCriterion('C2')] };
    const records = [recordFor(task.criteria[0]), recordFor(task.criteria[1], { result: 'fail' })];
    const rows = V.toLegacyVerdicts(V.evaluateAcceptance(task, records, {}));
    expect(rows.map((x) => x.result)).toEqual(['PASS', 'FAIL']);
    expect(rows[0].title).toContain('C1');
  });
});

describe('rollupTasks —— 项目面把任务面折成一个判定', () => {
  test('空看板 → unknown，而不是 done', () => {
    const r = V.rollupTasks([]);
    expect(r.verdict).toBe('unknown');
    expect(r.counts.total).toBe(0);
  });

  test('还有任务没到 done → partial（阶段性完成）', () => {
    const r = V.rollupTasks([
      { status: 'done', verdict: 'done' },
      { status: 'review', verdict: 'done' },
    ]);
    expect(r.verdict).toBe('partial');
    expect(r.counts.done).toBe(1);
    expect(r.counts.partial).toBe(1);
  });

  test('任一任务 failed → failed，哪怕其余全 done', () => {
    const r = V.rollupTasks([
      { status: 'done', verdict: 'done' },
      { status: 'review', verdict: 'failed' },
    ]);
    expect(r.verdict).toBe('failed');
    expect(r.counts.failed).toBe(1);
  });

  test('全部 done 但证据未验证 → unknown 而不是 done', () => {
    const r = V.rollupTasks([{ status: 'done', verdict: 'unknown' }]);
    expect(r.verdict).toBe('unknown');
  });

  test('全部 done 且有 partial → partial', () => {
    const r = V.rollupTasks([
      { status: 'done', verdict: 'done' },
      { status: 'done', verdict: 'partial' },
    ]);
    expect(r.verdict).toBe('partial');
  });

  test('全部 done 且全部通过判据 → done', () => {
    const r = V.rollupTasks([
      { status: 'done', verdict: 'done' },
      { status: 'done', verdict: 'done' },
    ]);
    expect(r.verdict).toBe('done');
    expect(r.counts).toEqual({ done: 2, partial: 0, unknown: 0, failed: 0, open: 0, total: 2 });
  });

  test('未结任务计入 open，不污染四值', () => {
    const r = V.rollupTasks([
      { status: 'done', verdict: 'done' },
      { status: 'todo', verdict: 'open' },
    ]);
    expect(r.counts.open).toBe(1);
    expect(r.counts.unknown).toBe(0);
    expect(r.verdict).toBe('partial');
  });
});
