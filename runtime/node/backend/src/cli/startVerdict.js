'use strict';

/**
 * startVerdict.js — 任务「开工」裁决的纯叶子（零 IO、确定性、绝不抛）。
 *
 * 与 `acceptanceVerdict.js` 对称：那个回答「干完了吗」，这个回答「真的开工了吗」。
 * 此前本仓没有「开始」这回事 —— `todo -> doing` 只是把状态字段改掉：
 *   - 没有开工时刻，只有 `updated`（日期精度，任何状态迁移都会刷）；
 *   - `khy hq next` 写的认领戳会被下一次状态迁移 `clearClaim` 清掉；
 *   - 于是一条 doing 任务是「刚开工」还是「挂了三周没人动」，数据上不可区分。
 *
 * 所以开工收敛成一条可复算的判定：**系统盖章的开工时刻 + 开工后的活动记录**。
 * 四值（不用布尔）：
 *   started      系统在 todo->doing 盖了 `started_at`，且其后至少一条活动记录
 *   declared     状态 doing/review，但只有自述（无开工戳，或盖章后零活动）
 *   not-started  todo（认领是预留，不算开工）
 *   unknown      状态缺失/无法识别，或 doing/review 连基线都没有
 *
 * 与完成裁决同一条教训：**存量数据封顶**。没有 `started_at` 就意味着开工时刻
 * 从未由系统见证，靠 `updated` 反推最多只能判 `declared` —— 正如 legacy 散文
 * 验收最多只能判 partial。
 *
 * 活动记录刻意只用**任务自身字段**（认领时刻、备注条数），不读工作树、不看 HEAD：
 * 本仓是共享脏工作树，别人提交别的东西不能让本任务「看起来开工了」，
 * 而任何调用点（status / close / verify）读到的结论必须一致。
 *
 * @module cli/startVerdict
 */

const START_VERDICTS = ['started', 'declared', 'not-started', 'unknown'];
const START_OPEN_STATES = ['doing', 'review'];

function _str(v) {
  return String(v == null ? '' : v).trim();
}

function _ms(v) {
  const s = _str(v);
  if (!s) {
    return null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * 开工基线：系统盖章 > 认领时刻 > 更新日期。
 *
 * `source` 决定上限 —— 只有 `stamp` 能判 `started`，后两者都是事后反推。
 * 用 `source` 而不是布尔，是为了让报告能说清「差在哪一步」。
 */
function startBaseline(task) {
  const t = task && typeof task === 'object' ? task : {};
  for (const [source, field] of [
    ['stamp', 'started_at'],
    ['claim', 'claimed_at'],
    ['updated', 'updated'],
  ]) {
    const atMs = _ms(t[field]);
    if (atMs !== null) {
      return { at: _str(t[field]), atMs, source };
    }
  }
  return null;
}

/**
 * 开工之后的活动痕迹。只用任务自身字段，零 IO：
 *   claim  续租/认领时刻晚于基线（`hq renew` 会刷新 claimed_at）
 *   notes  备注条数超过开工时记下的 `start_note_count`
 * 没有 `start_note_count` 时（存量数据）备注条数无从比较 —— 返回空，
 * 由 `evaluateStart` 的封顶规则兜住，不会把旧备注误当新活动。
 */
function startActivity(task, baseline) {
  const t = task && typeof task === 'object' ? task : {};
  const out = [];
  if (!baseline) {
    return out;
  }
  const claimMs = _ms(t.claimed_at);
  if (claimMs !== null && claimMs > baseline.atMs) {
    out.push('claim');
  }
  const notes = Array.isArray(t.notes) ? t.notes.length : 0;
  const baseNotes = t.start_note_count;
  const baseCount = baseNotes === undefined || baseNotes === null ? null : Number(baseNotes);
  if (baseCount !== null && Number.isFinite(baseCount) && notes > baseCount) {
    out.push('notes');
  }
  return out;
}

/**
 * 单任务开工裁决。返回 `{verdict, source, baseline, activity, reasons}`。
 * `reasons` 是给人看的一句话，不是判据本身。
 */
function evaluateStart(task) {
  const t = task && typeof task === 'object' ? task : {};
  const status = _str(t.status);
  const baseline = startBaseline(t);
  const activity = startActivity(t, baseline);
  const base = { source: null, baseline, activity, reasons: [] };

  if (!status) {
    return Object.assign({ verdict: 'unknown' }, base, { reasons: ['状态缺失 —— 无法判断是否开工'] });
  }

  // done 必然经过 doing：TASK_TRANSITIONS 里 review 只能由 doing 到达，
  // 所以「已验收」本身就是开工过的机器证据，不依赖开工戳。
  if (status === 'done') {
    return Object.assign({ verdict: 'started' }, base, {
      source: 'terminal',
      reasons: ['已过 review 到 done —— 状态机不允许跳过 doing'],
    });
  }

  if (status === 'todo') {
    const reasons = [];
    if (_str(t.claimed_by)) {
      reasons.push(`已认领（${_str(t.claimed_by)}），但认领是预留、不是开工`);
    }
    return Object.assign({ verdict: 'not-started' }, base, {
      source: 'status',
      reasons: reasons.length ? reasons : ['todo —— 尚未进入 doing'],
    });
  }

  if (!START_OPEN_STATES.includes(status)) {
    return Object.assign({ verdict: 'unknown' }, base, {
      reasons: [`状态 ${status} 不在任务状态机内 —— 无法判断是否开工`],
    });
  }

  if (!baseline) {
    return Object.assign({ verdict: 'unknown' }, base, {
      reasons: ['没有开工时刻，也没有认领/更新日期 —— 无法回算'],
    });
  }

  if (baseline.source !== 'stamp') {
    const why =
      baseline.source === 'claim'
        ? `只有认领时刻 ${baseline.at}，开工时刻从未由系统盖章`
        : `存量条目只有更新日期 ${baseline.at}，开工时刻从未由系统盖章`;
    return Object.assign({ verdict: 'declared' }, base, {
      source: baseline.source,
      reasons: [why],
    });
  }

  if (activity.length) {
    return Object.assign({ verdict: 'started' }, base, {
      source: 'stamp',
      reasons: [`开工于 ${baseline.at}，之后有活动记录（${activity.join(' / ')}）`],
    });
  }

  return Object.assign({ verdict: 'declared' }, base, {
    source: 'stamp',
    reasons: [`开工于 ${baseline.at}，之后零活动记录 —— 只是把状态改成了 doing`],
  });
}

/**
 * 项目面汇总。入参可以是裁决串，也可以是 `{start}` 行（与 close 的 rows 同形）。
 * 取舍同 `rollupTasks`：unknown 压过一切（数据算不出就不宣称开工），
 * 其次是「至少一条真的开工了」，再到自称、未开工。
 */
function rollupStarts(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r != null) : [];
  const counts = { started: 0, declared: 0, 'not-started': 0, unknown: 0, total: list.length };
  for (const r of list) {
    const v = typeof r === 'string' ? r : r.start;
    if (Object.prototype.hasOwnProperty.call(counts, v) && v !== 'total') {
      counts[v] += 1;
    } else {
      counts.unknown += 1;
    }
  }
  let verdict = 'unknown';
  if (!list.length) {
    verdict = 'unknown';
  } else if (counts.unknown) {
    verdict = 'unknown';
  } else if (counts.started) {
    verdict = 'started';
  } else if (counts.declared) {
    verdict = 'declared';
  } else {
    verdict = 'not-started';
  }
  return { verdict, counts };
}

module.exports = {
  START_VERDICTS,
  START_OPEN_STATES,
  startBaseline,
  startActivity,
  evaluateStart,
  rollupStarts,
};
