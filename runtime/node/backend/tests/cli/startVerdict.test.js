'use strict';

/**
 * startVerdict.test.js — 开工裁决纯叶子的回归锁。
 *
 * 为什么单测这一层：`started_at` 是「开工」从自述变成事实的唯一支点。一旦某条
 * 规则退化（例如把存量 doing 当成 started、或把认领当成开工），`khy hq status`
 * 与 `khy hq close` 会重新变成「谁写了 doing 谁就开工了」—— 而且这种退化不会
 * 让任何现有测试变红。四值裁决的正确性只能靠这里的矩阵守住。
 */

const S = require('../../src/cli/startVerdict');

const T0 = '2026-11-04T09:00:00';
const T1 = '2026-11-04T10:00:00';
const T2 = '2026-11-04T11:00:00';

/** 正常新任务：系统已盖章（开工时备注 1 条）。 */
function stamped(overrides) {
  return Object.assign({
    id: 'T-999',
    status: 'doing',
    started_at: T1,
    started_by: 'machine-a',
    start_note_count: 1,
    notes: ['开工前的一条备注'],
  }, overrides);
}

describe('startBaseline —— 基线优先级与来源', () => {
  test('started_at > claimed_at > updated', () => {
    const b = S.startBaseline({ started_at: T1, claimed_at: T2, updated: '2026-11-04' });
    expect(b).toMatchObject({ at: T1, source: 'stamp' });
    expect(S.startBaseline({ claimed_at: T2, updated: '2026-11-04' })).toMatchObject({ at: T2, source: 'claim' });
    expect(S.startBaseline({ updated: '2026-11-04' })).toMatchObject({ at: '2026-11-04', source: 'updated' });
  });

  test('全都不可解析 → null（不编造基线）', () => {
    expect(S.startBaseline({})).toBeNull();
    expect(S.startBaseline({ started_at: '不是时间', claimed_at: '', updated: null })).toBeNull();
    expect(S.startBaseline(null)).toBeNull();
  });
});

describe('startActivity —— 只认任务自身字段', () => {
  test('备注条数超过开工基线算活动；等于或少于不算', () => {
    const b = S.startBaseline(stamped());
    expect(S.startActivity(stamped(), b)).toEqual([]);
    expect(S.startActivity(stamped({ notes: ['a', 'b'] }), b)).toEqual(['notes']);
  });

  test('没有 start_note_count 的存量条目：旧备注不算开工后活动', () => {
    const legacy = { status: 'doing', updated: '2026-09-23', notes: ['旧备注 1', '旧备注 2'] };
    expect(S.startActivity(legacy, S.startBaseline(legacy))).toEqual([]);
  });

  test('认领/续租晚于基线才算活动；早于基线只是预留', () => {
    const b = S.startBaseline(stamped());
    expect(S.startActivity(stamped({ claimed_at: T2 }), b)).toEqual(['claim']);
    expect(S.startActivity(stamped({ claimed_at: T0 }), b)).toEqual([]);
  });
});

describe('evaluateStart —— 四值矩阵', () => {
  test('todo 一律 not-started；带认领也只算预留', () => {
    expect(S.evaluateStart({ status: 'todo', updated: '2026-11-01' }).verdict).toBe('not-started');
    const claimed = S.evaluateStart({ status: 'todo', claimed_at: T1, claimed_by: 'machine-b' });
    expect(claimed.verdict).toBe('not-started');
    expect(claimed.reasons.join('')).toMatch(/认领是预留/);
  });

  test('done 无需开工戳：状态机不允许跳过 doing', () => {
    const r = S.evaluateStart({ status: 'done', updated: '2026-09-01' });
    expect(r.verdict).toBe('started');
    expect(r.source).toBe('terminal');
  });

  test('盖章后零活动 → declared（只是把状态改成了 doing）', () => {
    const r = S.evaluateStart(stamped());
    expect(r.verdict).toBe('declared');
    expect(r.source).toBe('stamp');
    expect(r.reasons.join('')).toMatch(/零活动记录/);
  });

  test('盖章后有备注 / 有续租 → started', () => {
    expect(S.evaluateStart(stamped({ notes: ['开工前的一条备注', '动了第一个文件'] })).verdict).toBe('started');
    expect(S.evaluateStart(stamped({ claimed_at: T2 })).verdict).toBe('started');
  });

  test('存量 doing：有认领时刻也只能到 declared（封顶）', () => {
    const r = S.evaluateStart({ status: 'doing', claimed_at: T1, notes: ['干了很多'] });
    expect(r.verdict).toBe('declared');
    expect(r.source).toBe('claim');
    expect(r.reasons.join('')).toMatch(/从未由系统盖章/);
  });

  test('存量 doing：只有更新日期 → declared，理由指向 updated', () => {
    const r = S.evaluateStart({ status: 'doing', updated: '2026-09-23' });
    expect(r.verdict).toBe('declared');
    expect(r.source).toBe('updated');
  });

  test('doing/review 什么基线都没有 → unknown', () => {
    expect(S.evaluateStart({ status: 'doing' }).verdict).toBe('unknown');
    expect(S.evaluateStart({ status: 'review' }).verdict).toBe('unknown');
  });

  test('review 与 doing 同一套规则', () => {
    expect(S.evaluateStart(stamped({ status: 'review' })).verdict).toBe('declared');
    expect(S.evaluateStart(stamped({ status: 'review', notes: ['a', 'b'] })).verdict).toBe('started');
    expect(S.evaluateStart({ status: 'review', updated: '2026-09-23' }).verdict).toBe('declared');
  });

  test('状态缺失或非法 → unknown，绝不抛', () => {
    expect(S.evaluateStart({}).verdict).toBe('unknown');
    expect(S.evaluateStart({ status: '已开工' }).verdict).toBe('unknown');
    expect(S.evaluateStart(null).verdict).toBe('unknown');
  });
});

describe('rollupStarts —— 项目面把任务面折成一个判定', () => {
  test('空表 → unknown，counts.total 为 0', () => {
    expect(S.rollupStarts([])).toEqual({
      verdict: 'unknown',
      counts: { started: 0, declared: 0, 'not-started': 0, unknown: 0, total: 0 },
    });
  });

  test('计数按四值落账（接受裁决串与 {start} 行两种入参）', () => {
    const r = S.rollupStarts([
      'started',
      { start: 'started' },
      { start: 'declared' },
      { start: 'not-started' },
    ]);
    expect(r.counts).toEqual({ started: 2, declared: 1, 'not-started': 1, unknown: 0, total: 4 });
    expect(r.verdict).toBe('started');
  });

  test('没有真开工时，自称压过未开工', () => {
    expect(S.rollupStarts(['declared', 'not-started']).verdict).toBe('declared');
    expect(S.rollupStarts(['not-started', 'not-started']).verdict).toBe('not-started');
  });

  test('unknown 压过一切：算不出的项目面不许宣称开工', () => {
    expect(S.rollupStarts(['started', 'unknown']).verdict).toBe('unknown');
    expect(S.rollupStarts([{ start: '乱写的值' }]).counts.unknown).toBe(1);
  });
});
