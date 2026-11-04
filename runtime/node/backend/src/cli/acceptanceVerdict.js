'use strict';

/**
 * acceptanceVerdict.js — 任务完成裁决的纯叶子（零 IO、确定性、绝不抛）。
 *
 * 为什么需要它：本仓此前有四个互不等价的「完成」口径 ——
 *   1. 回合：回复里的完成词（散文正则）；
 *   2. 回执：status=completed（等价于「没有工具报错」）；
 *   3. 任务：acceptance.md 里手写的 PASS（自述，`证据:` 允许一句话）；
 *   4. 项目：无定义。
 * 四者都能叫「完成」，但谁也不能被机器复算。本叶子把「任务是否完成」收敛成
 * 一条可复算的判定：**判据可执行 → 系统执行 → 运行记录 → 四值裁决**。
 *
 * 四值刻意不用布尔：
 *   done    全部 required 判据在新鲜记录里 pass
 *   partial 有 pass、无 required fail，但仍有 required 未验证/跳过
 *   failed  任一 required 判据 fail
 *   unknown 没有可机器核对的判据（或全是自述）
 * 「不知道」是合法结论 —— 布尔只有真/假，于是「模型说完成」被迫冒充真。
 *
 * 三条不可妥协的性质（照抄 goalStopGate.js 的叶子契约）：
 *   1. 零 IO：读运行记录、跑命令、算 HEAD 全由调用方做；
 *   2. 绝不抛：坏输入返回 unknown，而不是异常；
 *   3. 纯函数：同一 (task, records, ctx) 永远得到同一裁决。
 *
 * @module cli/acceptanceVerdict
 */

const crypto = require('crypto');

const CRITERION_STATES = ['pass', 'fail', 'skip', 'unknown'];
const ACCEPTANCE_VERDICTS = ['done', 'partial', 'unknown', 'failed'];

/** 运行记录默认保鲜期：24 小时。证据绑不住永远，但必须绑得住「今天」。 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function _str(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * 判据 id：显式 id 优先，否则按位置生成 C1..Cn。
 * id 是运行记录与判据之间唯一的连接键 —— 没有它就无法把「哪次执行」对上「哪条判据」。
 */
function criterionId(raw, index) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return _str(c.id) || `C${index + 1}`;
}

/**
 * 规范化一条判据。未知形状一律降级为 manual（而不是猜成 cmd）：
 * 猜错会把「没跑」记成「跑了且通过」，正是要消灭的失败模式。
 */
function normalizeCriterion(raw, index) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const id = criterionId(c, index);
  const desc = _str(c.desc || c.description || c.title || c.acceptance || '');
  const required = c.required !== false;
  const check = c.check && typeof c.check === 'object' ? c.check : {};
  const kind = check.kind === 'cmd' ? 'cmd' : 'manual';
  const cmd = kind === 'cmd' ? _str(check.cmd || check.command) : '';
  const cwd = _str(check.cwd);
  const rawTimeout = Number(check.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : undefined;
  const expectRaw = check.expect && typeof check.expect === 'object' ? check.expect : {};
  const expectKind = ['exit', 'stdout-match', 'stdout-not-match'].includes(expectRaw.kind)
    ? expectRaw.kind
    : 'exit';
  const expect = { kind: expectKind };
  if (expectKind === 'exit') {
    const n = Number(expectRaw.value);
    expect.value = Number.isInteger(n) ? n : 0;
  } else {
    expect.re = _str(expectRaw.re || expectRaw.pattern);
    if (expectRaw.flags) {
      expect.flags = _str(expectRaw.flags);
    }
  }
  const paths = Array.isArray(c.paths) ? c.paths.map(_str).filter(Boolean) : [];
  return {
    id,
    desc,
    required,
    kind,
    cmd,
    cwd,
    expect,
    timeoutMs,
    paths,
    legacy: !!c.legacy,
    invalid: kind === 'cmd' && !cmd ? 'cmd 判据缺 check.cmd' : null,
  };
}

/**
 * 把任务收敛成判据数组。
 *
 * `structured`：任务自带 `criteria[]`，是唯一可判 done 的形态。
 * `legacy`：只有 `acceptance` 散文 → 每条都当**人工判据**（max partial），
 *           因为散文里的「PASS」由写的人自己声明，机器无法复算。
 * `none`：两者都缺 → unknown。
 *
 * @param {object} task
 * @param {(acceptance: string) => string[]} [splitAcceptance]
 * @returns {{source: 'structured'|'legacy'|'none', criteria: object[]}}
 */
function normalizeTaskCriteria(task, splitAcceptance) {
  const t = task && typeof task === 'object' ? task : {};
  if (Array.isArray(t.criteria) && t.criteria.length) {
    return { source: 'structured', criteria: t.criteria.map(normalizeCriterion) };
  }
  const legacy = typeof splitAcceptance === 'function' ? splitAcceptance(t.acceptance) : [];
  if (Array.isArray(legacy) && legacy.length) {
    return {
      source: 'legacy',
      criteria: legacy.map((desc, i) =>
        normalizeCriterion({ id: `C${i + 1}`, desc, legacy: true, check: { kind: 'manual' } }, i)
      ),
    };
  }
  return { source: 'none', criteria: [] };
}

/**
 * 判据指纹：判据定义一改，旧运行记录就必须失效。
 *
 * 只用执行面字段（不含 desc/required），因为改文案不该让证据作废，
 * 改命令/期望/路径则会 —— 那正是「昨天跑的是另一条命令」的伪装。
 *
 * @param {object} criterion 已规范化的判据
 * @returns {string}
 */
function checkHash(criterion) {
  const c = criterion || {};
  const payload = JSON.stringify({
    id: c.id,
    kind: c.kind,
    cmd: c.cmd || '',
    cwd: c.cwd || '',
    expect: c.expect || { kind: 'exit', value: 0 },
    paths: Array.isArray(c.paths) ? c.paths : [],
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * 运行记录是否仍然新鲜。
 *
 * 三条失效条件，逐条对应一种真实事故：
 *   1. 过期（默认 24h）—— 防止「上周的绿判今天的 done」；
 *   2. HEAD 被改写（非快进）—— 证据所属历史已不存在；
 *   3. 判据覆盖的路径指纹变了 —— 跑过的文件已不是现在这份。
 *
 * 刻意**不**因「HEAD 前进」失效：本仓是共享脏工作树，别的会话一提交就让
 * 所有证据过期，那样门会退化成噪音。判据要用 `paths` 锁定自己覆盖的范围。
 *
 * @param {object} record
 * @param {{now?: number, maxAgeMs?: number, fingerprintFor?: Function}} [ctx]
 * @returns {{fresh: boolean, reason: string}}
 */
function recordFreshness(record, ctx) {
  const r = record && typeof record === 'object' ? record : {};
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const now = Number.isFinite(Number(c.now)) ? Number(c.now) : Date.now();
  const at = Number(r.atMs);
  const maxAge = Number(r.maxAgeMs) > 0
    ? Number(r.maxAgeMs)
    : (Number(c.maxAgeMs) > 0 ? Number(c.maxAgeMs) : DEFAULT_MAX_AGE_MS);
  if (!Number.isFinite(at) || at <= 0) {
    return { fresh: false, reason: 'no-timestamp' };
  }
  if (now - at > maxAge) {
    return { fresh: false, reason: 'expired' };
  }
  if (r.headStillAncestor === false) {
    return { fresh: false, reason: 'head-rewritten' };
  }
  if (typeof c.fingerprintFor === 'function') {
    const current = c.fingerprintFor(r);
    if (r.pathsFingerprint && current && r.pathsFingerprint !== current) {
      return { fresh: false, reason: 'paths-changed' };
    }
  }
  return { fresh: true, reason: '' };
}

/** 给裁决原因一句人话；未知原因原样回显，不吞。 */
function reasonText(reason) {
  const map = {
    'no-run': '没有运行记录（先执行 khy hq accept <ID> --run）',
    expired: '运行记录已过期（超过保鲜期）',
    'head-rewritten': '运行记录所属历史已被改写',
    'paths-changed': '判据覆盖的路径在运行后已改动',
    'check-changed': '判据定义已变，旧记录不适用',
    'unsigned-manual': '人工判据缺签名（--by）',
    timeout: '命令超时，未得出结果',
    'no-timestamp': '运行记录缺时间戳',
  };
  return map[reason] || _str(reason) || '未给出原因';
}

/**
 * 判定单条判据。
 *
 * 记录取「同 id 的最新一条」——旧记录不叠加，避免「昨天过、今天挂」被
 * 昨天那条遮住。
 *
 * @param {object} criterion 已规范化
 * @param {object[]} records 运行记录（append-only JSONL 读出的对象数组）
 * @param {object} [ctx] 见 recordFreshness
 * @returns {object} 判据裁决
 */
function evaluateCriterion(criterion, records, ctx) {
  const c = criterion || {};
  const base = {
    id: c.id,
    desc: c.desc || '',
    required: c.required !== false,
    kind: c.kind || 'manual',
    legacy: !!c.legacy,
  };
  if (c.invalid) {
    return Object.assign({}, base, { state: 'unknown', reason: c.invalid });
  }
  const list = Array.isArray(records) ? records : [];
  let latest = null;
  for (const r of list) {
    if (!r || typeof r !== 'object' || _str(r.id) !== _str(c.id)) {
      continue;
    }
    if (!latest || Number(r.atMs) > Number(latest.atMs)) {
      latest = r;
    }
  }
  if (!latest) {
    return Object.assign({}, base, { state: 'unknown', reason: 'no-run' });
  }
  const expected = checkHash(c);
  if (latest.checkHash && latest.checkHash !== expected) {
    return Object.assign({}, base, { state: 'unknown', reason: 'check-changed', at: latest.at });
  }
  const fresh = recordFreshness(latest, ctx);
  if (!fresh.fresh) {
    return Object.assign({}, base, { state: 'unknown', reason: fresh.reason, at: latest.at });
  }
  if (base.kind === 'manual') {
    if (!_str(latest.signedBy)) {
      return Object.assign({}, base, { state: 'unknown', reason: 'unsigned-manual', at: latest.at });
    }
    if (latest.result === 'pass') {
      return Object.assign({}, base, {
        state: 'pass',
        at: latest.at,
        evidence: _str(latest.note) || `签名: ${_str(latest.signedBy)}`,
        signedBy: _str(latest.signedBy),
      });
    }
    if (latest.result === 'fail') {
      return Object.assign({}, base, {
        state: 'fail',
        at: latest.at,
        reason: _str(latest.note) || 'manual-fail',
      });
    }
    return Object.assign({}, base, {
      state: 'skip',
      at: latest.at,
      reason: _str(latest.note) || 'manual-skip',
    });
  }
  if (latest.timedOut) {
    return Object.assign({}, base, { state: 'unknown', reason: 'timeout', at: latest.at });
  }
  if (latest.result === 'pass') {
    return Object.assign({}, base, { state: 'pass', at: latest.at, evidence: _str(latest.evidence) });
  }
  if (latest.result === 'fail') {
    return Object.assign({}, base, {
      state: 'fail',
      at: latest.at,
      reason: _str(latest.reason) || 'check-failed',
    });
  }
  return Object.assign({}, base, {
    state: 'unknown',
    reason: _str(latest.reason) || 'check-unknown',
    at: latest.at,
  });
}

/**
 * 任务级裁决。
 *
 * @param {object} task
 * @param {object[]} records
 * @param {object} [ctx]
 * @param {(acceptance: string) => string[]} [splitAcceptance]
 * @returns {{verdict: string, source: string, criteria: object[], counts: object,
 *            blockers: string[], warnings: string[]}}
 */
function evaluateAcceptance(task, records, ctx, splitAcceptance) {
  const norm = normalizeTaskCriteria(task, splitAcceptance);
  const criteria = norm.criteria.map((c) => evaluateCriterion(c, records, ctx));
  const required = criteria.filter((c) => c.required);
  const failed = required.filter((c) => c.state === 'fail');
  const passed = required.filter((c) => c.state === 'pass');
  const unresolved = required.filter((c) => c.state !== 'pass' && c.state !== 'fail');

  let verdict = 'unknown';
  if (norm.source === 'none' || !required.length) {
    verdict = 'unknown';
  } else if (failed.length) {
    verdict = 'failed';
  } else if (passed.length === required.length) {
    verdict = 'done';
  } else {
    verdict = 'partial';
  }
  // 自述型判据永远不能单独构成 done：这正是旧 acceptance.md 的失败模式。
  if (norm.source === 'legacy' && verdict === 'done') {
    verdict = 'partial';
  }

  const blockers = [];
  const warnings = [];
  if (norm.source === 'none') {
    blockers.push('任务既无 criteria[] 也无 acceptance —— 没有完成定义就没有完成判定');
  }
  if (norm.source === 'legacy') {
    blockers.push(
      'legacy-markdown-acceptance：判据来自 acceptance 散文，PASS 由写的人自述，机器无法复算。' +
        ' 先补 criteria[]（可执行：khy hq accept <ID> --scaffold），人工项用 kind="manual" 并签名'
    );
  }
  // legacy 已有一条总阻断（缺少可执行判据）。逐条再报「没有运行记录」只是噪音：
  // 补 criteria[] 之前每条必然没有记录，五条判据会变成五条同义句。
  if (norm.source !== 'legacy') {
    for (const c of criteria) {
      const label = `${c.id}${c.desc ? `「${c.desc.slice(0, 60)}」` : ''}`;
      if (c.required && c.state === 'fail') {
        blockers.push(`判据 ${label} FAIL：${_str(c.reason) || '未给出原因'}`);
      } else if (c.required && c.state === 'skip') {
        blockers.push(`判据 ${label} SKIP：${_str(c.reason) || '跳过必须有理由'}`);
      } else if (c.required && c.state === 'unknown') {
        blockers.push(`判据 ${label} 未验证：${reasonText(c.reason)}`);
      } else if (!c.required && (c.state === 'fail' || c.state === 'unknown')) {
        warnings.push(`可选判据 ${label} ${c.state === 'fail' ? 'FAIL' : '未验证'}：${_str(c.reason) || reasonText(c.reason)}`);
      }
    }
  }

  const counts = { total: criteria.length, required: required.length, passed: passed.length, failed: failed.length, unresolved: unresolved.length };
  return { verdict, source: norm.source, criteria, counts, blockers, warnings };
}

/**
 * 任务面 → 项目面裁决。
 *
 * 只看每条任务的 `status` 与 `verdict`，不看证据 —— 证据的复算已在上游完成。
 * 四条规则各自对应一个真实误判：
 *   1. 任一 failed → failed（失败不能被「其他都 done」平均掉）；
 *   2. 还有任务没到 done（含 review）→ partial（这是「阶段性完成」的正确定义）；
 *   3. 全部 done 但有条目 partial → partial（legacy 自述、缺判据）；
 *   4. 全部 done 且全部可复算 → done。
 *
 * review 里的「判据全过」仍记 partial：判据过只说明活干完了，还没过人这一关。
 *
 * @param {{status: string, verdict: string}[]} rows
 * @returns {{verdict: string, counts: object}}
 */
function rollupTasks(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const counts = { done: 0, partial: 0, unknown: 0, failed: 0, open: 0, total: list.length };
  for (const r of list) {
    if (r.status !== 'done' && r.status !== 'review') {
      counts.open += 1;
      continue;
    }
    const v = r.status === 'review' && r.verdict === 'done' ? 'partial' : r.verdict;
    if (Object.prototype.hasOwnProperty.call(counts, v)) {
      counts[v] += 1;
    } else {
      counts.unknown += 1;
    }
  }
  let verdict = 'unknown';
  if (!list.length) {
    verdict = 'unknown';
  } else if (counts.failed) {
    verdict = 'failed';
  } else if (counts.open || counts.partial) {
    verdict = 'partial';
  } else if (counts.unknown) {
    verdict = 'unknown';
  } else if (counts.done === list.length) {
    verdict = 'done';
  }
  return { verdict, counts };
}

/** 把裁决映射回旧的 verdicts 形态，供 `khy hq task set … done` 的呈现层复用。 */
function toLegacyVerdicts(acceptance) {
  const criteria = (acceptance && acceptance.criteria) || [];
  return criteria.map((c) => ({
    title: `${c.id}${c.desc ? ' ' + c.desc : ''}`.trim(),
    result: c.state === 'pass' ? 'PASS' : c.state === 'fail' ? 'FAIL' : 'SKIP',
    evidence: _str(c.evidence),
    reason: _str(c.reason),
  }));
}

module.exports = {
  CRITERION_STATES,
  ACCEPTANCE_VERDICTS,
  DEFAULT_MAX_AGE_MS,
  criterionId,
  normalizeCriterion,
  normalizeTaskCriteria,
  checkHash,
  recordFreshness,
  reasonText,
  evaluateCriterion,
  evaluateAcceptance,
  rollupTasks,
  toLegacyVerdicts,
};
